pub mod algorithms;
pub mod engine;

#[cfg(target_arch = "wasm32")]
mod audio {
    use super::engine::{Engine, Operator, Timbre, OPS, TIMBRES};
    use std::cell::RefCell;

    // JS reads four u32 words followed by 128 interleaved rows of eight f32s.
    #[repr(C)]
    struct ScopeBlock {
        voice: u32, note: u32, algorithm: u32, timbre: u32,
        taps: [[f32; OPS]; 128],
    }
    // JS reads 128 left samples followed by 128 right samples.
    #[repr(C)]
    struct Stereo { left: [f32; 128], right: [f32; 128] }
    struct Audio { engine: Engine, block: Stereo, scope: ScopeBlock }
    thread_local! { static AUDIO: RefCell<Option<Audio>> = const { RefCell::new(None) }; }

    fn with_engine(f: impl FnOnce(&mut Engine)) {
        AUDIO.with(|cell| { if let Some(a) = cell.borrow_mut().as_mut() { f(&mut a.engine); } });
    }

    #[no_mangle]
    pub extern "C" fn init(rate: f32) {
        let scope = ScopeBlock { voice: 0, note: 0, algorithm: 0, timbre: 0, taps: [[0.0; OPS]; 128] };
        let block = Stereo { left: [0.0; 128], right: [0.0; 128] };
        AUDIO.with(|cell| *cell.borrow_mut() = Some(Audio { engine: Engine::new(rate), block, scope }));
    }
    #[no_mangle]
    pub extern "C" fn patch(timbre: usize, algorithm: u32, feedback: f32) {
        with_engine(|e| {
            if let Some(p) = e.programs.get_mut(timbre) { p.algorithm = algorithm; p.feedback = feedback.clamp(0.0, 1.0); }
        });
    }
    #[no_mangle]
    pub extern "C" fn operator(timbre: usize, i: usize, ratio: f32, level: f32, attack: f32, decay: f32, sustain: f32, release: f32) {
        with_engine(|e| {
            if let Some(op) = e.programs.get_mut(timbre).and_then(|p| p.operators.get_mut(i)) {
                *op = Operator { ratio, level, attack, decay, sustain, release };
            }
        });
    }
    #[no_mangle]
    #[allow(clippy::too_many_arguments)]
    pub extern "C" fn timbre(index: usize, on: u32, volume: f32, pan: f32, transpose: i32, detune: f32,
                             key_low: u32, key_high: u32, velocity_low: u32, velocity_high: u32) {
        with_engine(|e| {
            if let Some(t) = e.timbres.get_mut(index) {
                *t = Timbre { on: on != 0, volume, pan, transpose, detune, key_low, key_high, velocity_low, velocity_high };
            }
        });
    }
    #[no_mangle]
    pub extern "C" fn focus(timbre: usize) { with_engine(|e| e.scope_timbre = timbre.min(TIMBRES - 1)); }
    #[no_mangle]
    pub extern "C" fn note_on(id: u32, note: u32, velocity: f32) { with_engine(|e| e.on(id, note, velocity)); }
    #[no_mangle]
    pub extern "C" fn note_off(id: u32) { with_engine(|e| e.off(id)); }
    #[no_mangle]
    pub extern "C" fn silence() { with_engine(|e| e.silence()); }
    #[no_mangle]
    pub extern "C" fn scope_ptr() -> *const u32 {
        AUDIO.with(|cell| &cell.borrow().as_ref().expect("call init before scope_ptr").scope.voice as *const u32)
    }
    #[no_mangle]
    pub extern "C" fn render(n: usize, monitor: u32) -> *const f32 {
        AUDIO.with(|cell| {
            let mut audio = cell.borrow_mut();
            let audio = audio.as_mut().expect("call init before render");
            let size = n.min(128);
            let Stereo { left, right } = &mut audio.block;
            if monitor != 0 {
                let scope = &mut audio.scope;
                let voice = audio.engine.render_with_scope(&mut left[..size], &mut right[..size], &mut scope.taps[..size]);
                (scope.voice, scope.note, scope.algorithm, scope.timbre) =
                    voice.map_or((0, 0, 0, 0), |v| (v.serial as u32, v.note, v.algorithm, v.timbre as u32));
            } else {
                audio.engine.render(&mut left[..size], &mut right[..size]);
            }
            audio.block.left.as_ptr()
        })
    }
}
