// Shared by the page and the AudioWorklet, after algorithms.js.
// A Combination holds 16 timbres. Each timbre carries a full Program (an FM–8
// patch) and the settings below. Program mode is timbre 1 on its own.
const TIMBRES = 16;
const POLYPHONY = 64;
const TIMBRE_DEFAULTS = {on:false, volume:1, pan:0, transpose:0, detune:0, keyLow:0, keyHigh:127, velocityLow:1, velocityHigh:127};
// [minimum, maximum, whole numbers only]
const TIMBRE_RANGES = {
  volume:[0,1,false], pan:[-1,1,false], transpose:[-24,24,true], detune:[-100,100,false],
  keyLow:[0,127,true], keyHigh:[0,127,true], velocityLow:[1,127,true], velocityHigh:[1,127,true]
};
// Velocity zones use the 1–127 MIDI scale. The engine works with 0–1.
function velocity127(velocity) { return Math.min(127, Math.max(1, Math.round(velocity * 127))); }
function timbreAccepts(t, key, velocity) {
  const v = velocity127(velocity);
  return t.on && key >= t.keyLow && key <= t.keyHigh && v >= t.velocityLow && v <= t.velocityHigh;
}
// Balance law: the far channel fades out while the near one stays at the timbre volume.
function timbreGains(t) {
  const pan = Math.min(1, Math.max(-1, t.pan)), volume = Math.min(1, Math.max(0, t.volume));
  return [volume * Math.min(1, 1 - pan), volume * Math.min(1, 1 + pan)];
}
function programSetup(program) {
  return Array.from({length:TIMBRES}, (_, i) => ({...TIMBRE_DEFAULTS, on:i === 0, program}));
}
