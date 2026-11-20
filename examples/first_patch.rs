//! A native Rust listening exercise. Compare a sine wave with one modulated by OP2.
use aurelian_fm8::engine::Engine;
use std::{fs::File, io::{self, BufWriter, Write}};

fn write_wave(path: &str, samples: &[(f32, f32)], rate: u32) -> io::Result<()> {
    let mut file = BufWriter::new(File::create(path)?);
    // Stereo, 16-bit: four bytes per frame.
    let length = samples.len() as u32 * 2 * 2;
    file.write_all(b"RIFF")?;
    file.write_all(&(36 + length).to_le_bytes())?;
    file.write_all(b"WAVEfmt ")?;
    file.write_all(&16u32.to_le_bytes())?; // PCM format chunk length
    file.write_all(&1u16.to_le_bytes())?;  // linear PCM
    file.write_all(&2u16.to_le_bytes())?;  // stereo
    file.write_all(&rate.to_le_bytes())?;
    file.write_all(&(rate * 4).to_le_bytes())?;
    file.write_all(&4u16.to_le_bytes())?;
    file.write_all(&16u16.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&length.to_le_bytes())?;
    for &(left, right) in samples {
        for sample in [left, right] {
            file.write_all(&((sample * i16::MAX as f32).round() as i16).to_le_bytes())?;
        }
    }
    file.flush()
}

fn main() -> io::Result<()> {
    let rate = 48000usize;
    let mut engine = Engine::new(rate as f32);
    // Program mode: timbre 1 plays engine.program().
    let patch = engine.program();
    for op in &mut patch.operators { op.level = 0.0; }

    // The default algorithm 72 routes OP2 into OP1. OP1 is the only audible carrier here.
    patch.operators[0].level = 0.9;
    patch.operators[0].sustain = 0.65;
    patch.operators[1].ratio = 2.0;
    patch.operators[1].decay = 0.32;
    patch.operators[1].sustain = 0.03;
    let mut left = vec![0.0; rate * 4];
    let mut right = vec![0.0; rate * 4];
    for (take, depth) in [0.0, 0.8].into_iter().enumerate() {
        engine.program().operators[1].level = depth;
        let start = take * 2 * rate;
        engine.on(1, 57, 0.8);
        engine.render(&mut left[start..start + rate], &mut right[start..start + rate]);
        engine.off(1);
        engine.render(&mut left[start + rate..start + 2 * rate], &mut right[start + rate..start + 2 * rate]);
    }
    let samples: Vec<_> = left.into_iter().zip(right).collect();
    write_wave("first-patch.wav", &samples, rate as u32)?;
    println!("Wrote first-patch.wav (0s: sine, 2s: phase modulation).");
    Ok(())
}
