pub mod engine;

#[cfg(target_arch = "wasm32")]
mod audio {
    use super::engine::{Engine, Operator};
    use std::cell::RefCell;

    // JS reads three u32 words followed by 128 interleaved rows of six f32s.
    #[repr(C)]
    struct ScopeBlock {
        id: u32, note: u32, algorithm: u32,
        taps: [[f32; 6]; 128],
    }
    struct Audio { engine: Engine, block: [f32; 128], scope: ScopeBlock }
    thread_local! { static AUDIO: RefCell<Option<Audio>> = const { RefCell::new(None) }; }

    fn with_engine(f: impl FnOnce(&mut Engine)) {
        AUDIO.with(|cell| { if let Some(a) = cell.borrow_mut().as_mut() { f(&mut a.engine); } });
    }

    #[no_mangle]
    pub extern "C" fn init(rate: f32) {
        let scope = ScopeBlock { id: 0, note: 0, algorithm: 0, taps: [[0.0; 6]; 128] };
        AUDIO.with(|cell| *cell.borrow_mut() = Some(Audio { engine: Engine::new(rate), block: [0.0; 128], scope }));
    }
    #[no_mangle]
    pub extern "C" fn patch(algorithm: u32, feedback: f32) {
        with_engine(|e| { e.patch.algorithm = algorithm; e.patch.feedback = feedback.clamp(0.0, 1.0); });
    }
    #[no_mangle]
    pub extern "C" fn operator(i: usize, ratio: f32, level: f32, attack: f32, decay: f32, sustain: f32, release: f32) {
        with_engine(|e| {
            if let Some(op) = e.patch.operators.get_mut(i) {
                *op = Operator { ratio, level, attack, decay, sustain, release };
            }
        });
    }
    #[no_mangle]
    pub extern "C" fn note_on(id: u32, note: u32, velocity: f32) { with_engine(|e| e.on(id, note, velocity)); }
    #[no_mangle]
    pub extern "C" fn note_off(id: u32) { with_engine(|e| e.off(id)); }
    #[no_mangle]
    pub extern "C" fn silence() { with_engine(|e| e.silence()); }
    #[no_mangle]
    pub extern "C" fn scope_ptr() -> *const u32 {
        AUDIO.with(|cell| &cell.borrow().as_ref().expect("call init before scope_ptr").scope.id as *const u32)
    }
    #[no_mangle]
    pub extern "C" fn render(n: usize, monitor: u32) -> *const f32 {
        AUDIO.with(|cell| {
            let mut audio = cell.borrow_mut();
            let audio = audio.as_mut().expect("call init before render");
            let size = n.min(audio.block.len());
            if monitor != 0 {
                let scope = &mut audio.scope;
                let voice = audio.engine.render_with_scope(&mut audio.block[..size], &mut scope.taps[..size]);
                (scope.id, scope.note, scope.algorithm) = voice.map_or((0, 0, 0), |v| (v.id, v.note, v.algorithm));
            } else {
                audio.engine.render(&mut audio.block[..size]);
            }
            audio.block.as_ptr()
        })
    }
}
