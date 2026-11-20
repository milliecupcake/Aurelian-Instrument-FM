// MIDI input for the page. Nothing here touches Web MIDI or audio, so it can run in Node tests.
// The page passes each message's bytes to MidiRouter.receive with the input it came from.

// Returns {type, channel (1–16), ...} for the messages FM–8 uses, or null for anything else.
function parseMidi(data) {
  const [status, a = 0, b = 0] = data;
  if (status < 0x80 || status >= 0xf0) return null;   // running status bytes and system messages
  const type = status >> 4, channel = (status & 15) + 1;
  if (type === 0x9 && b > 0) return {type:"on", channel, note:a, velocity:b};
  if (type === 0x8 || type === 0x9) return {type:"off", channel, note:a};   // note on with velocity 0 is a note off
  if (type === 0xb) return {type:"cc", channel, controller:a, value:b};
  if (type === 0xc) return {type:"program", channel, program:a};
  return null;
}

// Tracks which MIDI keys are down and the sustain pedal, and calls the page:
// strike(token, note, velocity 0–1), lift(token), silence() and program(number).
// A token names one key on one channel of one input, so two keyboards never collide.
class MidiRouter {
  constructor(page) {
    this.page = page;
    this.channel = 0;            // 0 receives every channel
    this.pedal = false;
    this.sounding = new Set();   // tokens struck and not yet lifted
    this.sustained = new Set();  // released keys the pedal is holding
  }
  receive(data, source = "midi") {
    const m = parseMidi(data);
    if (!m || (this.channel && m.channel !== this.channel)) return null;
    const token = "midi:" + source + ":" + m.channel + ":" + m.note;
    if (m.type === "on") {
      // Striking a key the pedal is holding starts a fresh note.
      if (this.sounding.has(token)) this.lift(token);
      this.sounding.add(token);
      this.page.strike(token, m.note, m.velocity / 127);
    } else if (m.type === "off") {
      if (!this.sounding.has(token)) return m;
      if (this.pedal) this.sustained.add(token); else this.lift(token);
    } else if (m.type === "cc" && m.controller === 64) {
      this.pedal = m.value >= 64;
      if (!this.pedal) for (const t of [...this.sustained]) this.lift(t);
    } else if (m.type === "cc" && m.controller === 120) {
      // All Sound Off: stop at once, release tails included.
      this.sounding.clear();
      this.sustained.clear();
      this.page.silence();
    } else if (m.type === "cc" && m.controller === 123) {
      // All Notes Off: release every key, as if all were lifted with the pedal up.
      this.releaseAll();
    } else if (m.type === "program") {
      this.page.program(m.program);
    }
    return m;
  }
  lift(token) {
    this.sounding.delete(token);
    this.sustained.delete(token);
    this.page.lift(token);
  }
  // Forgets every key without calling the page, after the page has silenced everything itself.
  reset() {
    this.sounding.clear();
    this.sustained.clear();
  }
  // Releases every key, or only those from one input (for a disconnected device).
  releaseAll(source) {
    const prefix = source === undefined ? "midi:" : "midi:" + source + ":";
    for (const t of [...this.sounding]) if (t.startsWith(prefix)) this.lift(t);
  }
}
