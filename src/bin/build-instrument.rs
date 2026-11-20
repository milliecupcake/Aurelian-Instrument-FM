use std::{env, fs, io, path::Path, process::{Command, ExitCode}};

fn base64(bytes: &[u8]) -> String {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for part in bytes.chunks(3) {
        let n = (part[0] as u32) << 16 | (part.get(1).copied().unwrap_or(0) as u32) << 8
            | part.get(2).copied().unwrap_or(0) as u32;
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            out.push(if i > part.len() { '=' } else { alphabet[((n >> shift) & 63) as usize] as char });
        }
    }
    out
}

fn build() -> io::Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let out = root.join("target").join("instrument-build");
    let status = Command::new(env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .current_dir(root)
        .args(["build", "--release", "--lib", "--target", "wasm32-unknown-unknown", "--target-dir"])
        .arg(&out).status()?;
    if !status.success() {
        return Err(io::Error::other("Install the target with: rustup target add wasm32-unknown-unknown"));
    }
    let wasm = fs::read(out.join("wasm32-unknown-unknown/release/aurelian_fm8.wasm"))?;
    // The page and the worklet read the same routing table as src/algorithms.rs.
    let table: Vec<String> = include_str!("../../web/algorithms.txt").lines()
        .map(|line| format!("\"{line}\"")).collect();
    let page = include_str!("../../web/instrument.html")
        .replace("__WORKLET__", include_str!("../../web/processor.js"))
        .replace("__SHARED_LIB__", &[include_str!("../../web/algorithms.js"), include_str!("../../web/combination.js")].join("\n"))
        .replace("__ALGORITHMS__", &format!("[{}]", table.join(",")))
        .replace("__PATCHES__", include_str!("../../web/presets.json"))
        .replace("__PHRASES__", include_str!("../../web/phrases.json"))
        .replace("__COMBINATIONS__", include_str!("../../web/combinations.json"))
        .replace("__MIDI_LIB__", include_str!("../../web/midi.js"));
    // Play-FM8.html runs the JavaScript reference engine and needs no build tools to open.
    fs::write(root.join("Play-FM8.html"), page.replace("__WASM_BASE64__", ""))?;
    let dest = root.join("Aurelian-FM8.html");
    fs::write(&dest, page.replace("__WASM_BASE64__", &base64(&wasm)))?;
    println!("Open {} in a desktop browser.", dest.display());
    Ok(())
}

fn main() -> ExitCode {
    match build() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => { eprintln!("{e}"); ExitCode::FAILURE }
    }
}
