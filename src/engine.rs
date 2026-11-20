//! Eight-operator phase modulation. Operators are numbered from the output upwards.
use crate::algorithms::{route, Route};
use std::f32::consts::TAU;

pub const OPS: usize = 8;
const POLYPHONY: usize = 16;
const TABLE: usize = 2048;

#[derive(Clone, Copy)]
pub struct Operator {
    pub ratio: f32,
    pub level: f32,
    pub attack: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32,
}

impl Default for Operator {
    fn default() -> Self {
        Self { ratio: 1.0, level: 0.8, attack: 0.006, decay: 0.7, sustain: 0.45, release: 0.3 }
    }
}

#[derive(Clone, Copy)]
pub struct Patch {
    pub algorithm: u32,
    pub feedback: f32,
    pub operators: [Operator; OPS],
}

impl Default for Patch {
    fn default() -> Self {
        // Algorithm 72 pairs the operators: 2→1, 4→3, 6→5 and 8→7.
        Self { algorithm: 72, feedback: 0.0, operators: [Operator::default(); OPS] }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Stage { Attack, Decay, Sustain, Release, End }

#[derive(Clone, Copy)]
struct Oscillator {
    phase: f32, step: f32, level: f32, envelope: f32, stage: Stage,
    attack_step: f32, decay_step: f32, sustain: f32, release_samples: f32, release_step: f32,
}

impl Oscillator {
    fn new(op: Operator, hz: f32, rate: f32) -> Self {
        Self {
            phase: 0.0, step: (hz * op.ratio / rate).fract(), level: op.level,
            envelope: 0.0, stage: Stage::Attack,
            attack_step: 1.0 / (op.attack * rate).max(1.0),
            decay_step: (1.0 - op.sustain) / (op.decay * rate).max(1.0),
            sustain: op.sustain, release_samples: (op.release * rate).max(1.0), release_step: 0.0,
        }
    }

    fn release(&mut self) {
        if self.stage != Stage::Release && self.stage != Stage::End {
            self.release_step = self.envelope / self.release_samples;
            self.stage = Stage::Release;
        }
    }

    fn advance_envelope(&mut self) {
        match self.stage {
            Stage::Attack => {
                self.envelope += self.attack_step;
                if self.envelope >= 1.0 { self.envelope = 1.0; self.stage = Stage::Decay; }
            }
            Stage::Decay => {
                self.envelope -= self.decay_step;
                if self.envelope <= self.sustain { self.envelope = self.sustain; self.stage = Stage::Sustain; }
            }
            Stage::Release => {
                self.envelope -= self.release_step;
                if self.envelope <= 0.000001 { self.envelope = 0.0; self.stage = Stage::End; }
            }
            Stage::Sustain | Stage::End => {}
        }
    }
}

struct Voice {
    id: u32, note: u32, algorithm: u32, velocity: f32, released: bool, serial: u64,
    ops: [Oscillator; OPS], route: Route,
    feedback: f32, history: [f32; 2],
}

impl Voice {
    fn new(patch: Patch, rate: f32, id: u32, note: u32, velocity: f32, serial: u64) -> Self {
        let hz = 440.0 * 2.0_f32.powf((note as f32 - 69.0) / 12.0);
        let algorithm = patch.algorithm.clamp(1, crate::algorithms::COUNT);
        Self {
            id, note, algorithm, velocity, released: false, serial, route: route(algorithm),
            ops: patch.operators.map(|op| Oscillator::new(op, hz, rate)),
            feedback: patch.feedback, history: [0.0; 2],
        }
    }

    fn next(&mut self, sine: &[f32; TABLE + 1]) -> (f32, [f32; OPS]) {
        let mut values = [0.0; OPS];
        let mut mixed = 0.0;
        for i in (0..OPS).rev() {
            let op = &mut self.ops[i];
            op.advance_envelope();
            // One full-scale modulator shifts the phase by up to 6 radians. Several modulators add up.
            let mut input = 0.0;
            let mut sources = self.route.modulators[i];
            while sources != 0 {
                let j = sources.trailing_zeros() as usize;
                input += values[j];
                sources &= sources - 1;
            }
            let mut offset = input * (6.0 / TAU);
            if i == OPS - 1 { offset += (self.history[0] + self.history[1]) * self.feedback * (2.0 / TAU); }
            let turns = op.phase + offset;
            let position = (turns - turns.floor()) * TABLE as f32;
            let whole = position as usize;
            let index = whole % TABLE;
            let sample = sine[index] + (sine[index + 1] - sine[index]) * (position - whole as f32);
            values[i] = sample * op.envelope * op.level * self.velocity;
            op.phase += op.step;
            if op.phase >= 1.0 { op.phase -= 1.0; }
            if self.route.carriers >> i & 1 == 1 { mixed += values[i]; }
        }
        self.history = [values[OPS - 1], self.history[0]];
        (mixed, values)
    }

    fn ended(&self) -> bool {
        self.released && self.ops.iter().enumerate()
            .all(|(i, op)| self.route.carriers >> i & 1 == 0 || op.stage == Stage::End)
    }
}

pub struct Engine {
    pub patch: Patch,
    rate: f32, serial: u64, sine: [f32; TABLE + 1], voices: [Option<Voice>; POLYPHONY],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScopeVoice {
    pub id: u32,
    pub note: u32,
    pub algorithm: u32,
}

impl Engine {
    pub fn new(rate: f32) -> Self {
        Self {
            patch: Patch::default(), rate, serial: 0,
            sine: std::array::from_fn(|i| (TAU * i as f32 / TABLE as f32).sin()),
            voices: std::array::from_fn(|_| None),
        }
    }

    pub fn on(&mut self, id: u32, note: u32, velocity: f32) {
        if !velocity.is_finite() || velocity <= 0.0 { self.off(id); return; }
        // Reuse the same event ID if present. Otherwise prefer silence, then a released voice.
        let slot = self.voices.iter().position(|v| v.as_ref().is_some_and(|v| v.id == id))
            .or_else(|| self.voices.iter().position(Option::is_none))
            .unwrap_or_else(|| self.voices.iter().enumerate()
                .min_by_key(|(_, slot)| { let v = slot.as_ref().unwrap(); (!v.released, v.serial) })
                .unwrap().0);
        self.serial += 1;
        self.voices[slot] = Some(Voice::new(self.patch, self.rate, id, note.min(127), velocity.min(1.0), self.serial));
    }

    pub fn off(&mut self, id: u32) {
        for voice in self.voices.iter_mut().flatten().filter(|v| v.id == id) {
            voice.released = true;
            for op in &mut voice.ops { op.release(); }
        }
    }

    pub fn silence(&mut self) { self.voices.fill_with(|| None); }

    pub fn render(&mut self, output: &mut [f32]) {
        self.render_block(output, None);
    }

    /// Eight post-envelope operator outputs per sample for one voice.
    /// The audio output always contains the full polyphonic mix.
    pub fn render_with_scope(&mut self, output: &mut [f32], taps: &mut [[f32; OPS]]) -> Option<ScopeVoice> {
        assert_eq!(output.len(), taps.len());
        self.render_block(output, Some(taps))
    }

    fn render_block(&mut self, output: &mut [f32], mut taps: Option<&mut [[f32; OPS]]>) -> Option<ScopeVoice> {
        let focus = taps.as_ref().and_then(|_| self.voices.iter().flatten()
            .max_by_key(|v| (!v.released, v.serial))
            .map(|v| ScopeVoice { id: v.id, note: v.note, algorithm: v.algorithm }));
        if focus.is_none() {
            if let Some(rows) = taps.as_deref_mut() { rows.fill([0.0; OPS]); }
        }
        output.fill(0.0);
        for slot in &mut self.voices {
            if let Some(voice) = slot {
                if let Some(rows) = taps.as_deref_mut().filter(|_| focus.is_some_and(|f| f.id == voice.id)) {
                    for (sample, row) in output.iter_mut().zip(rows) {
                        let (mixed, operators) = voice.next(&self.sine);
                        *sample += mixed;
                        *row = operators;
                    }
                } else {
                    for sample in output.iter_mut() { *sample += voice.next(&self.sine).0; }
                }
                if voice.ended() { *slot = None; }
            }
        }
        // Fixed headroom for chords, followed by a bounded soft limiter.
        for sample in output {
            let x = *sample * 0.26;
            *sample = x / (1.0 + x.abs());
        }
        focus
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mappings_and_polyphony() {
        let mut e = Engine::new(48000.0);
        for i in 0..17 { e.on(i, 60 + i, 0.8); }
        assert_eq!(e.voices.iter().flatten().count(), 16);
        assert!(e.voices.iter().flatten().all(|v| v.id != 0));
        e.off(8);
        e.on(17, 60, 0.8);
        assert!(e.voices.iter().flatten().all(|v| v.id != 8));
    }

    #[test]
    fn pure_a4_and_release() {
        let mut e = Engine::new(48000.0);
        e.patch.algorithm = 88;
        for (i, p) in e.patch.operators.iter_mut().enumerate() {
            p.level = if i == 0 { 1.0 } else { 0.0 };
            p.sustain = 1.0;
            p.release = 0.01;
        }
        e.on(1, 69, 1.0);
        let mut block = vec![0.0; 48000];
        e.render(&mut block);
        let crossings = block.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        assert!((439..=441).contains(&crossings));
        e.off(1);
        e.render(&mut block);
        assert!(block[600..].iter().all(|s| *s == 0.0));
        assert!(e.voices.iter().all(Option::is_none));
    }

    #[test]
    fn scope_matches_the_voice_without_changing_the_mix() {
        let mut plain = Engine::new(48000.0);
        let mut scoped = Engine::new(48000.0);
        for engine in [&mut plain, &mut scoped] {
            engine.on(1, 60, 0.8);
            engine.patch.algorithm = 88;
            engine.on(2, 67, 0.7);
            engine.patch.algorithm = 1;
        }
        let mut a = [0.0; 128];
        let mut b = [0.0; 128];
        let mut taps = [[0.0; OPS]; 128];
        let mut solo = Engine::new(48000.0);
        solo.patch.algorithm = 88;
        solo.on(2, 67, 0.7);
        let mut solo_out = [0.0; 128];
        let mut solo_taps = taps;
        solo.render_with_scope(&mut solo_out, &mut solo_taps);
        plain.render(&mut a);
        let focus = scoped.render_with_scope(&mut b, &mut taps).unwrap();
        assert_eq!((focus.note, focus.algorithm), (67, 88));
        assert_eq!(a, b);
        assert_eq!(taps, solo_taps);
        assert!(taps.iter().any(|row| row[OPS - 1].abs() > 0.01));
        scoped.off(2);
        assert_eq!(scoped.render_with_scope(&mut b, &mut taps).unwrap().id, 1);
        scoped.silence();
        assert!(scoped.render_with_scope(&mut b, &mut taps).is_none());
        assert_eq!(taps, [[0.0; OPS]; 128]);
    }

    #[test]
    fn shared_and_merged_modulators() {
        // Algorithm 87: OP8 modulates OP1–OP7. Algorithm 1: OP5 and OP1 each receive two modulators.
        let shared = route(87);
        assert_eq!(shared.carriers, 0b0111_1111);
        assert!(shared.modulators[..7].iter().all(|&m| m == 0b1000_0000));
        let merged = route(1);
        assert_eq!(merged.modulators[4], 0b1100_0000);
        assert_eq!(merged.modulators[0], 0b0000_0110);

        // With OP8 silent, algorithm 87 is an unmodulated sine on OP1. Raising OP8 changes it.
        let render = |depth: f32| {
            let mut e = Engine::new(48000.0);
            e.patch.algorithm = 87;
            for (i, op) in e.patch.operators.iter_mut().enumerate() {
                op.level = if i == 7 { depth } else if i == 0 { 1.0 } else { 0.0 };
                op.sustain = 1.0;
            }
            e.on(1, 69, 1.0);
            let mut taps = [[0.0; OPS]; 512];
            let mut out = [0.0; 512];
            e.render_with_scope(&mut out, &mut taps);
            (out, taps)
        };
        let (plain, _) = render(0.0);
        let (modulated, taps) = render(0.9);
        assert_ne!(plain, modulated);
        assert!(taps.iter().any(|row| row[7].abs() > 0.1));
        assert!(taps.iter().all(|row| row[1..7].iter().all(|&s| s == 0.0)), "silent carriers stay silent");
    }
}
