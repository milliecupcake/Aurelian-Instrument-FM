//! Eight-operator phase modulation. Operators are numbered from the output upwards.
//!
//! One `Patch` is a Program. The engine plays up to 16 Programs at once as the
//! timbres of a Combination: each timbre has its own key and velocity zone, level,
//! pan, transpose and detune. Program mode is simply timbre 1 on its own.
use crate::algorithms::{route, Route};
use std::f32::consts::TAU;

pub const OPS: usize = 8;
pub const POLYPHONY: usize = 64;
pub const TIMBRES: usize = 16;
const TABLE: usize = 2048;
/// The mod wheel at full depth swings the pitch this many semitones either way.
pub const VIBRATO_DEPTH: f32 = 0.5;
pub const VIBRATO_HZ: f32 = 5.5;
/// Bend and mod wheel moves glide over about this many seconds, so stepped MIDI values do not click.
const GLIDE_SECONDS: f32 = 0.004;
/// Pitch is computed once per sample for blocks of this size.
const CHUNK: usize = 128;

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

/// One part of a Combination. A key press sounds on every timbre that is on and
/// whose key zone and velocity zone both contain it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Timbre {
    pub on: bool,
    /// 0 to 1.
    pub volume: f32,
    /// −1 (left) to 1 (right). The centre leaves both channels at full level.
    pub pan: f32,
    /// Semitones added to the played key.
    pub transpose: i32,
    /// Cents, −100 to 100.
    pub detune: f32,
    pub key_low: u32,
    pub key_high: u32,
    /// Zones use the 1–127 MIDI velocity scale.
    pub velocity_low: u32,
    pub velocity_high: u32,
}

impl Default for Timbre {
    fn default() -> Self {
        Self { on: false, volume: 1.0, pan: 0.0, transpose: 0, detune: 0.0,
               key_low: 0, key_high: 127, velocity_low: 1, velocity_high: 127 }
    }
}

/// Converts a 0–1 velocity to the 1–127 scale used by velocity zones.
pub fn velocity_127(velocity: f32) -> u32 { (velocity * 127.0).round().clamp(1.0, 127.0) as u32 }

impl Timbre {
    pub fn accepts(&self, key: u32, velocity: f32) -> bool {
        let v = velocity_127(velocity);
        self.on && (self.key_low..=self.key_high).contains(&key) && (self.velocity_low..=self.velocity_high).contains(&v)
    }

    /// Balance law: the far channel fades out while the near one stays at the timbre volume.
    fn gains(&self) -> [f32; 2] {
        let pan = self.pan.clamp(-1.0, 1.0);
        let volume = self.volume.clamp(0.0, 1.0);
        [volume * (1.0 - pan).min(1.0), volume * (1.0 + pan).min(1.0)]
    }
}

struct Voice {
    id: u32, note: u32, algorithm: u32, timbre: usize, velocity: f32, released: bool, serial: u64,
    ops: [Oscillator; OPS], route: Route, gains: [f32; 2],
    feedback: f32, history: [f32; 2],
}

impl Voice {
    fn new(patch: Patch, timbre: (usize, &Timbre), rate: f32, id: u32, key: u32, velocity: f32, serial: u64) -> Self {
        let (index, part) = timbre;
        let note = (key as i32 + part.transpose).clamp(0, 127) as u32;
        let cents = part.detune.clamp(-100.0, 100.0);
        let hz = 440.0 * 2.0_f32.powf((note as f32 - 69.0) / 12.0 + cents / 1200.0);
        let algorithm = patch.algorithm.clamp(1, crate::algorithms::COUNT);
        Self {
            id, note, algorithm, timbre: index, velocity, released: false, serial, route: route(algorithm),
            ops: patch.operators.map(|op| Oscillator::new(op, hz, rate)), gains: part.gains(),
            feedback: patch.feedback, history: [0.0; 2],
        }
    }

    /// `pitch` multiplies every operator's frequency for this sample (bend and vibrato).
    fn next(&mut self, sine: &[f32; TABLE + 1], pitch: f32) -> (f32, [f32; OPS]) {
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
            op.phase += op.step * pitch;
            if op.phase >= 1.0 { op.phase -= op.phase.floor(); }
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
    /// The Program each timbre plays.
    pub programs: [Patch; TIMBRES],
    pub timbres: [Timbre; TIMBRES],
    /// The scope follows the newest voice of this timbre, or the newest voice of any timbre.
    pub scope_timbre: usize,
    /// Pitch bend in semitones and mod wheel depth (0–1), shared by every voice.
    bend: f32, vibrato: f32,
    /// The values actually sounding, gliding towards `bend` and `vibrato`, and the vibrato phase in turns.
    bend_now: f32, vibrato_now: f32, lfo: f32, glide: f32,
    rate: f32, serial: u64, sine: [f32; TABLE + 1], voices: [Option<Voice>; POLYPHONY],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScopeVoice {
    /// Unique per sounding voice. Layered timbres share a key ID but not this number.
    pub serial: u64,
    pub id: u32,
    /// The sounding note after transpose.
    pub note: u32,
    pub algorithm: u32,
    pub timbre: usize,
}

impl Engine {
    /// Starts in Program mode: timbre 1 is on with full zones and the rest are off.
    pub fn new(rate: f32) -> Self {
        let mut timbres = [Timbre::default(); TIMBRES];
        timbres[0].on = true;
        Self {
            programs: [Patch::default(); TIMBRES], timbres, scope_timbre: 0, rate, serial: 0,
            bend: 0.0, vibrato: 0.0, bend_now: 0.0, vibrato_now: 0.0, lfo: 0.0,
            glide: 1.0 - (-1.0 / (GLIDE_SECONDS * rate).max(1.0)).exp(),
            sine: std::array::from_fn(|i| (TAU * i as f32 / TABLE as f32).sin()),
            voices: std::array::from_fn(|_| None),
        }
    }

    /// Program mode convenience: the Program of timbre 1.
    pub fn program(&mut self) -> &mut Patch { &mut self.programs[0] }

    pub fn on(&mut self, id: u32, key: u32, velocity: f32) {
        if !velocity.is_finite() || velocity <= 0.0 { self.off(id); return; }
        // A repeated key ID restarts that key on every timbre.
        for slot in &mut self.voices {
            if slot.as_ref().is_some_and(|v| v.id == id) { *slot = None; }
        }
        let key = key.min(127);
        let velocity = velocity.min(1.0);
        for t in 0..TIMBRES {
            if !self.timbres[t].accepts(key, velocity) { continue; }
            // Prefer silence, then the oldest released voice, then the oldest held voice.
            let slot = self.voices.iter().position(Option::is_none)
                .unwrap_or_else(|| self.voices.iter().enumerate()
                    .min_by_key(|(_, slot)| { let v = slot.as_ref().unwrap(); (!v.released, v.serial) })
                    .unwrap().0);
            self.serial += 1;
            self.voices[slot] = Some(Voice::new(self.programs[t], (t, &self.timbres[t]), self.rate, id, key, velocity, self.serial));
        }
    }

    pub fn off(&mut self, id: u32) {
        for voice in self.voices.iter_mut().flatten().filter(|v| v.id == id) {
            voice.released = true;
            for op in &mut voice.ops { op.release(); }
        }
    }

    pub fn silence(&mut self) { self.voices.fill_with(|| None); }

    /// Bends every voice, sounding and future, by this many semitones (±24).
    pub fn set_bend(&mut self, semitones: f32) {
        self.bend = if semitones.is_finite() { semitones.clamp(-24.0, 24.0) } else { 0.0 };
    }

    /// Mod wheel: vibrato depth from 0 (none) to 1 (±`VIBRATO_DEPTH` semitones).
    pub fn set_vibrato(&mut self, amount: f32) {
        self.vibrato = if amount.is_finite() { amount.clamp(0.0, 1.0) } else { 0.0 };
    }

    /// Fills `out` with the frequency multiplier for each coming sample.
    fn advance_pitch(&mut self, out: &mut [f32]) {
        if self.bend == 0.0 && self.vibrato == 0.0 && self.bend_now == 0.0 && self.vibrato_now == 0.0 {
            out.fill(1.0);
            return;
        }
        let step = VIBRATO_HZ / self.rate;
        for ratio in out {
            self.bend_now += (self.bend - self.bend_now) * self.glide;
            self.vibrato_now += (self.vibrato - self.vibrato_now) * self.glide;
            if (self.bend - self.bend_now).abs() < 1e-5 { self.bend_now = self.bend; }
            if (self.vibrato - self.vibrato_now).abs() < 1e-5 { self.vibrato_now = self.vibrato; }
            let semitones = self.bend_now + self.vibrato_now * VIBRATO_DEPTH * (TAU * self.lfo).sin();
            self.lfo += step;
            if self.lfo >= 1.0 { self.lfo -= 1.0; }
            *ratio = (semitones / 12.0).exp2();
        }
    }

    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.render_block(left, right, None);
    }

    /// Eight post-envelope operator outputs per sample for one voice.
    /// The audio output always contains the full polyphonic mix of every timbre.
    pub fn render_with_scope(&mut self, left: &mut [f32], right: &mut [f32], taps: &mut [[f32; OPS]]) -> Option<ScopeVoice> {
        assert_eq!(left.len(), taps.len());
        self.render_block(left, right, Some(taps))
    }

    fn render_block(&mut self, left: &mut [f32], right: &mut [f32], mut taps: Option<&mut [[f32; OPS]]>) -> Option<ScopeVoice> {
        assert_eq!(left.len(), right.len());
        let newest = |voices: &mut dyn Iterator<Item = &Voice>| voices.max_by_key(|v| (!v.released, v.serial))
            .map(|v| ScopeVoice { serial: v.serial, id: v.id, note: v.note, algorithm: v.algorithm, timbre: v.timbre });
        let focus = taps.as_ref().and_then(|_| {
            let wanted = self.scope_timbre;
            newest(&mut self.voices.iter().flatten().filter(|v| v.timbre == wanted))
                .or_else(|| newest(&mut self.voices.iter().flatten()))
        });
        if let Some(rows) = taps.as_deref_mut() { rows.fill([0.0; OPS]); }
        left.fill(0.0);
        right.fill(0.0);
        let mut pitch = [1.0; CHUNK];
        for start in (0..left.len()).step_by(CHUNK) {
            let end = (start + CHUNK).min(left.len());
            let pitch = &mut pitch[..end - start];
            self.advance_pitch(pitch);
            for slot in &mut self.voices {
                if let Some(voice) = slot {
                    let [gl, gr] = voice.gains;
                    let mut rows = taps.as_deref_mut().filter(|_| focus.is_some_and(|f| f.serial == voice.serial));
                    for n in start..end {
                        let (mixed, operators) = voice.next(&self.sine, pitch[n - start]);
                        left[n] += mixed * gl;
                        right[n] += mixed * gr;
                        if let Some(rows) = rows.as_deref_mut() { rows[n] = operators; }
                    }
                    if voice.ended() { *slot = None; }
                }
            }
        }
        // Fixed headroom for chords, followed by a bounded soft limiter on each channel.
        for sample in left.iter_mut().chain(right.iter_mut()) {
            let x = *sample * 0.26;
            *sample = x / (1.0 + x.abs());
        }
        focus
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(n: usize) -> (Vec<f32>, Vec<f32>) { (vec![0.0; n], vec![0.0; n]) }
    fn sounding(e: &Engine) -> usize { e.voices.iter().flatten().count() }

    #[test]
    fn polyphony_is_shared_by_all_timbres() {
        let mut e = Engine::new(48000.0);
        for i in 0..65 { e.on(i, 30 + i, 0.8); }
        assert_eq!(sounding(&e), POLYPHONY);
        assert!(e.voices.iter().flatten().all(|v| v.id != 0), "the oldest held voice is stolen");
        e.off(8);
        e.on(65, 60, 0.8);
        assert!(e.voices.iter().flatten().all(|v| v.id != 8), "a released voice goes first");

        // Four layered timbres: sixteen keys fill every voice.
        let mut layered = Engine::new(48000.0);
        for t in 0..4 { layered.timbres[t].on = true; }
        for i in 0..16 { layered.on(i, 40 + i, 0.8); }
        assert_eq!(sounding(&layered), POLYPHONY);
        layered.on(3, 70, 0.8);
        assert_eq!(layered.voices.iter().flatten().filter(|v| v.id == 3).count(), 4, "a repeated ID restarts every layer");
    }

    #[test]
    fn zones_select_timbres() {
        let mut e = Engine::new(48000.0);
        e.timbres[0] = Timbre { on: true, key_high: 59, ..Timbre::default() };
        e.timbres[1] = Timbre { on: true, key_low: 60, ..Timbre::default() };
        e.timbres[2] = Timbre { on: true, key_low: 60, velocity_low: 100, ..Timbre::default() };
        e.on(1, 48, 0.72);
        e.on(2, 64, 0.72);
        e.on(3, 67, 0.98);
        let parts = |id| { let mut t: Vec<_> = e.voices.iter().flatten().filter(|v| v.id == id).map(|v| v.timbre).collect(); t.sort(); t };
        assert_eq!(parts(1), [0]);
        assert_eq!(parts(2), [1]);
        assert_eq!(parts(3), [1, 2]);
        assert_eq!((velocity_127(0.72), velocity_127(0.98), velocity_127(0.001)), (91, 124, 1));
    }

    fn crossings(samples: &[f32]) -> usize { samples.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count() }

    fn pure(e: &mut Engine, t: usize) {
        e.programs[t].algorithm = 88;
        for (i, p) in e.programs[t].operators.iter_mut().enumerate() {
            p.level = if i == 0 { 1.0 } else { 0.0 };
            p.sustain = 1.0;
            p.release = 0.01;
        }
    }

    #[test]
    fn pure_a4_and_release() {
        let mut e = Engine::new(48000.0);
        pure(&mut e, 0);
        e.on(1, 69, 1.0);
        let (mut l, mut r) = block(48000);
        e.render(&mut l, &mut r);
        assert!((439..=441).contains(&crossings(&l)));
        assert_eq!(l, r, "Program mode is centred");
        e.off(1);
        e.render(&mut l, &mut r);
        assert!(l[600..].iter().all(|s| *s == 0.0));
        assert!(e.voices.iter().all(Option::is_none));
    }

    #[test]
    fn transpose_detune_and_pan() {
        let mut e = Engine::new(48000.0);
        pure(&mut e, 0);
        e.timbres[0].transpose = 12;
        e.timbres[0].pan = -1.0;
        e.on(1, 57, 1.0); // A3 played, A4 sounds
        let (mut l, mut r) = block(48000);
        e.render(&mut l, &mut r);
        assert!((439..=441).contains(&crossings(&l)));
        assert!(r.iter().all(|s| *s == 0.0), "hard left");

        let mut d = Engine::new(48000.0);
        pure(&mut d, 0);
        d.timbres[0].detune = 100.0; // one semitone up: 466.16 Hz
        d.timbres[0].volume = 0.5;
        d.timbres[0].pan = 0.5;
        d.on(1, 69, 1.0);
        d.render(&mut l, &mut r);
        assert!((465..=467).contains(&crossings(&r)));
        let peak = |s: &[f32]| s.iter().fold(0.0f32, |p, x| p.max(x.abs()));
        assert!(peak(&l) < peak(&r), "panned right");
    }

    #[test]
    fn scope_follows_the_chosen_timbre_without_changing_the_mix() {
        let setup = |e: &mut Engine| {
            e.timbres[1].on = true;
            e.programs[1].algorithm = 87;
            e.on(1, 60, 0.8);
            e.programs[0].algorithm = 1;
            e.on(2, 67, 0.7);
        };
        let mut plain = Engine::new(48000.0);
        let mut scoped = Engine::new(48000.0);
        setup(&mut plain);
        setup(&mut scoped);
        let (mut a, mut ar) = block(128);
        let (mut b, mut br) = block(128);
        let mut taps = [[0.0; OPS]; 128];
        plain.render(&mut a, &mut ar);
        scoped.scope_timbre = 1;
        let focus = scoped.render_with_scope(&mut b, &mut br, &mut taps).unwrap();
        assert_eq!((focus.note, focus.algorithm, focus.timbre), (67, 87, 1));
        assert_eq!((a, ar), (b.clone(), br.clone()));
        assert!(taps.iter().any(|row| row[OPS - 1].abs() > 0.01));

        scoped.scope_timbre = 5; // nothing on timbre 6: fall back to the newest voice
        let fallback = scoped.render_with_scope(&mut b, &mut br, &mut taps).unwrap();
        assert_eq!((fallback.id, fallback.timbre), (2, 1));
        scoped.silence();
        assert!(scoped.render_with_scope(&mut b, &mut br, &mut taps).is_none());
        assert_eq!(taps, [[0.0; OPS]; 128]);
    }

    #[test]
    fn pitch_bend_and_vibrato() {
        let a4 = |setup: &dyn Fn(&mut Engine)| {
            let mut e = Engine::new(48000.0);
            pure(&mut e, 0);
            setup(&mut e);
            e.on(1, 69, 1.0);
            let (mut l, mut r) = block(48000);
            e.render(&mut l, &mut r);
            (crossings(&l), l)
        };
        let (plain, reference) = a4(&|_| {});
        let (centred, same) = a4(&|e| { e.set_bend(0.0); e.set_vibrato(0.0); });
        assert_eq!((plain, &reference), (centred, &same), "centred wheels change nothing");
        // Two semitones up is 493.88 Hz; twelve down is 220 Hz. The glide takes a few milliseconds.
        assert!((492..=495).contains(&a4(&|e| e.set_bend(2.0)).0));
        assert!((219..=221).contains(&a4(&|e| e.set_bend(-12.0)).0));
        // Bending a sounding note moves it too.
        let mut e = Engine::new(48000.0);
        pure(&mut e, 0);
        e.on(1, 69, 1.0);
        let (mut l, mut r) = block(48000);
        e.render(&mut l, &mut r);
        e.set_bend(12.0);
        e.render(&mut l, &mut r);
        assert!((877..=881).contains(&crossings(&l)), "the glide costs a cycle or two");
        // Vibrato keeps the average pitch but changes the waveform.
        let (wobbly, vibrato) = a4(&|e| e.set_vibrato(1.0));
        assert!((438..=442).contains(&wobbly));
        assert_ne!(vibrato, reference);
        e.set_bend(f32::NAN);
        e.set_vibrato(f32::INFINITY);
        assert_eq!((e.bend, e.vibrato), (0.0, 0.0), "bad values centre the wheels");
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
            e.program().algorithm = 87;
            for (i, op) in e.program().operators.iter_mut().enumerate() {
                op.level = if i == 7 { depth } else if i == 0 { 1.0 } else { 0.0 };
                op.sustain = 1.0;
            }
            e.on(1, 69, 1.0);
            let mut taps = [[0.0; OPS]; 512];
            let (mut l, mut r) = block(512);
            e.render_with_scope(&mut l, &mut r, &mut taps);
            (l, taps)
        };
        let (plain, _) = render(0.0);
        let (modulated, taps) = render(0.9);
        assert_ne!(plain, modulated);
        assert!(taps.iter().any(|row| row[7].abs() > 0.1));
        assert!(taps.iter().all(|row| row[1..7].iter().all(|&s| s == 0.0)), "silent carriers stay silent");
    }
}
