// Run with: node tests/scope.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..", "web");
const bank = JSON.parse(fs.readFileSync(path.join(root, "presets.json"), "utf8"));
const table = fs.readFileSync(path.join(root, "algorithms.txt"), "utf8").trim().split("\n");
const combis = JSON.parse(fs.readFileSync(path.join(root, "combinations.json"), "utf8"));
const library = ["algorithms.js", "combination.js"].map(f => fs.readFileSync(path.join(root, f), "utf8")).join("\n")
  .replace("__ALGORITHMS__", JSON.stringify(table));
const OPS = 8, STRIDE = OPS + 1;
let Processor;

class WorkletHost {
  constructor() {
    this.messages = [];
    this.port = {postMessage: (message, transfer=[]) => {
      this.messages.push(structuredClone(message, {transfer}));
    }};
  }
}
// The builder pastes algorithms.js and combination.js into the worklet in the same way.
const worklet = vm.createContext({
  sampleRate:48000,
  AudioWorkletProcessor:WorkletHost,
  registerProcessor:(_, implementation) => { Processor=implementation; }
});
vm.runInContext(fs.readFileSync(path.join(root, "processor.js"), "utf8").replace("__SHARED_LIB__", library), worklet);
// Copy results out of the worklet's realm so deepEqual compares values only.
const workletRoute = vm.runInContext("route", worklet), upgradePatch = vm.runInContext("upgradePatch", worklet);
const programSetup = vm.runInContext("programSetup", worklet);
const route = n => JSON.parse(JSON.stringify(workletRoute(n)));
assert.equal(table.length, 88);
assert.deepEqual(route(1).carriers, [0]);
assert.deepEqual(route(1).modulators[0].sort(), [1,2]);
assert.deepEqual(route(87).modulators.slice(0,7), Array(7).fill([7]));
assert.deepEqual(route(88).carriers, [0,1,2,3,4,5,6,7]);
for (const p of bank) {
  assert(Number.isInteger(p.algorithm) && p.algorithm >= 1 && p.algorithm <= 88, p.name);
  assert.equal(p.operators.length, OPS, p.name);
}

function send(proc, message) { proc.port.onmessage({data:message}); }
function start(proc, id, note) { send(proc, {type:"on", id, note, velocity:0.8}); }
function request(proc, count) { send(proc, {type:"scope", buffer:new ArrayBuffer(count * STRIDE * 4)}); }
// Program mode is centred, so both channels must match. Returns the left channel.
function render(proc, count, volume) {
  const [left, right] = renderStereo(proc, count, volume);
  assert.deepEqual(left, right);
  return left;
}
function renderStereo(proc, count, volume=full) {
  const left = new Float32Array(count), right = new Float32Array(count);
  proc.process([], [[left, right]], {volume});
  return [left, right];
}
function readFrame(proc) {
  const frame = proc.messages.pop();
  assert.equal(frame.type, "scope");
  return {...frame, samples:new Float32Array(frame.buffer)};
}
function channel(samples, index) {
  return samples.filter((_, i) => i % STRIDE === index);
}
const full = new Float32Array([1]);
const mute = new Float32Array([0]);
function peak(samples) { return samples.reduce((p, s) => Math.max(p, Math.abs(s)), 0); }
function instrument(patch) { return new Processor({processorOptions:{timbres:programSetup(patch)}}); }

for (const algorithm of [1, 10, 42, 72, 87, 88]) {
  const {carriers} = route(algorithm);
  const patch = {...bank[0], algorithm, feedback:0.4};
  const measured = instrument(patch);
  const plain = instrument(patch);
  for (const synth of [measured, plain]) start(synth, 1, 69);

  // Capture across a short and a >128-sample quantum. Automate the gain within a block.
  const length = 352;
  const volume = Float32Array.from({length:299}, (_, i) => i/298);
  request(measured, length);
  const first = render(measured, 53, full);
  const second = render(measured, 299, volume);
  assert.deepEqual(first, render(plain, 53, full));
  assert.deepEqual(second, render(plain, 299, volume));
  const {samples, note, algorithm:tag} = readFrame(measured);
  assert.equal(note, 69);
  assert.equal(tag, algorithm);
  assert.deepEqual(channel(samples, OPS), new Float32Array([...first,...second]));
  for (let i=0; i<length; i++) {
    const sum = carriers.reduce((total, op) => total + samples[i*STRIDE+op], 0);
    const x = sum*0.26;
    const gain = i<53 ? 1 : volume[i-53];
    assert(Math.abs(samples[i*STRIDE+OPS] - gain*x/(1+Math.abs(x))) < 1e-6);
  }
}

const poly = instrument(bank[0]);
const solo = instrument(bank[0]);
start(poly, 1, 60);
render(poly, 128, full);
for (const synth of [poly, solo]) { start(synth, 2, 67); request(synth, 384); }
render(poly, 384, full);
render(solo, 384, full);
const chord = readFrame(poly), one = readFrame(solo);
for (let op=0; op<OPS; op++) {
  assert.deepEqual(channel(chord.samples, op), channel(one.samples, op));
}
assert.notDeepEqual(channel(chord.samples, OPS), channel(one.samples, OPS));

// Switching the editor does not relabel a note that is still sounding.
send(poly, {type:"setup", timbres:programSetup(bank[2])});
request(poly, 256);
render(poly, 128, full);
send(poly, {type:"off", id:2});
const afterRelease = render(poly, 128, full);
const changed = readFrame(poly);
assert.equal(changed.note, 60);
assert.equal(changed.algorithm, bank[0].algorithm);
for (let op=0; op<OPS; op++) assert.equal(peak(channel(changed.samples, op).slice(0,128)), 0);
assert(peak(channel(changed.samples, OPS).slice(0,128))>0);
assert.deepEqual(channel(changed.samples, OPS).slice(128), afterRelease);

// Release tails still have operator traces when the master is muted.
send(poly, {type:"off", id:1});
request(poly, 384);
render(poly, 384, mute);
const tail = readFrame(poly);
assert.equal(tail.note, 67);
assert(peak(channel(tail.samples, 0))>0);
assert.equal(peak(channel(tail.samples, OPS)), 0);
send(poly, {type:"silence"});
request(poly, 128);
render(poly, 128, full);
const idle = readFrame(poly);
assert.equal(idle.algorithm, 0);
assert.equal(peak(idle.samples), 0);

// Muted operators must stay flat, including on display-buffer reuse.
const initSine = bank.find(p => p.name === "Init Sine");
send(poly, {type:"setup", timbres:programSetup(initSine)});
start(poly, 3, 60);
send(poly, {type:"scope", buffer:tail.buffer});
render(poly, 384, full);
const init = readFrame(poly);
assert(peak(channel(init.samples, 0))>0);
for (let op=1; op<OPS; op++) assert.equal(peak(channel(init.samples, op)), 0);

// FM–6 files keep their sound: each old operator lands on an FM–8 operator with the
// same wiring, and the two extra operators are silent.
const legacy = {name:"Old", feedback:0.3, operators:[
  [1,0.9,0.003,0.5,0.4,0.2],[2,0.6,0.002,0.3,0.1,0.2],[1,0.7,0.004,0.6,0.5,0.2],
  [3,0.5,0.002,0.4,0.2,0.2],[1.5,0.4,0.003,0.3,0.2,0.2],[4,0.5,0.002,0.2,0.1,0.2]]};
const oldWiring = {1:[[1,0],[5,4],[4,3],[3,2]], 5:[[1,0],[3,2],[5,4]], 32:[]};
for (const [old, edges] of Object.entries(oldWiring)) {
  const upgraded = upgradePatch({...legacy, algorithm:Number(old)});
  assert.equal(upgraded.operators.length, OPS);
  const r = route(upgraded.algorithm);
  const place = [0,1,2,3,4,5].map(i => upgraded.operators.indexOf(legacy.operators[i]));
  assert.equal(place[5], OPS - 1, "old OP6 feedback moves to OP8");
  const used = new Set(place);
  const wired = [];
  r.modulators.forEach((sources, target) => sources.forEach(source => {
    if (used.has(source) && used.has(target)) wired.push([place.indexOf(source), place.indexOf(target)]);
  }));
  assert.deepEqual(wired.sort(), edges.slice().sort(), "algorithm " + old);
  const oldCarriers = [0,1,2,3,4,5].filter(i => !edges.some(([s]) => s === i));
  for (const c of oldCarriers) assert(r.carriers.includes(place[c]));
  upgraded.operators.forEach((op, i) => { if (!used.has(i)) assert.equal(op[1], 0); });
}
assert.equal(upgradePatch(bank[0]), bank[0], "FM–8 patches pass through unchanged");
// Demo phrases: playable notes, and one phrase written for every preset and Combination.
const phrases = JSON.parse(fs.readFileSync(path.join(root, "phrases.json"), "utf8"));
for (const p of phrases) {
  assert(typeof p.name === "string" && p.name && p.beat > 0 && p.notes.length > 0, p.name);
  for (const [start, note, duration, velocity] of p.notes) {
    assert(start >= 0 && duration > 0 && Number.isInteger(note) && note >= 0 && note <= 127, p.name);
    assert(velocity > 0 && velocity <= 1, p.name);
  }
  for (const name of p.suits) assert(bank.some(q => q.name === name) || combis.some(c => c.name === name), p.name + " → " + name);
}
for (const q of [...bank, ...combis]) assert(phrases.some(p => p.suits.includes(q.name)), "no phrase for " + q.name);

// ---- Combinations
const ranges = vm.runInContext("TIMBRE_RANGES", worklet);
for (const c of combis) {
  assert.equal(c.timbres.length, 16, c.name);
  for (const t of c.timbres) {
    assert.equal(typeof t.on, "boolean");
    for (const [key, [min, max, whole]] of Object.entries(ranges)) {
      assert(t[key] >= min && t[key] <= max && (!whole || Number.isInteger(t[key])), c.name + " " + key);
    }
    assert(t.program.algorithm >= 1 && t.program.algorithm <= 88 && t.program.operators.length === OPS, c.name);
  }
}
const combination = timbres => new Processor({processorOptions:{timbres}});
const part = (program, settings) => ({...programSetup(program)[0], ...settings});
const off = program => ({...programSetup(program)[1]});
const sine = bank.find(p => p.name === "Init Sine");
// Plain copies of the sounding voices, outside the worklet's realm.
function voices(proc) { return Array.from(proc.engine.slots).filter(Boolean).map(v => ({id:v.id, note:v.note, timbre:v.timbre})); }

// Layers: one key sounds on every timbre that is on. A repeated key ID restarts all of them.
{
  const synth = combination([part(bank[0], {}), part(bank[1], {}), part(sine, {}), ...Array.from({length:13}, () => off(sine))]);
  start(synth, 1, 60);
  assert.deepEqual(voices(synth).map(v => v.timbre).sort(), [0,1,2]);
  start(synth, 1, 62);
  assert.equal(voices(synth).length, 3);
  for (let id = 2; id <= 30; id++) start(synth, id, 40 + id);
  assert.equal(voices(synth).length, 64, "64 voices shared by every timbre");
}
// Zones and transpose: a split with a velocity-switched layer.
{
  const synth = combination([
    part(bank[2], {keyHigh:59, transpose:-12}), part(bank[0], {keyLow:60}),
    part(bank[1], {keyLow:60, velocityLow:100}), ...Array.from({length:13}, () => off(sine))]);
  send(synth, {type:"on", id:1, note:48, velocity:0.72});
  send(synth, {type:"on", id:2, note:64, velocity:0.72});
  send(synth, {type:"on", id:3, note:67, velocity:0.98});
  const layers = id => voices(synth).filter(v => v.id === id).map(v => [v.timbre, v.note]).sort();
  assert.deepEqual(layers(1), [[0, 36]]);
  assert.deepEqual(layers(2), [[1, 64]]);
  assert.deepEqual(layers(3), [[1, 67], [2, 67]]);
}
// Pan, volume and detune: hard left leaves the right channel silent; 100 cents is one semitone.
{
  const synth = combination([part(sine, {pan:-1}), part(sine, {pan:1, volume:0.5, detune:100}), ...Array.from({length:14}, () => off(sine))]);
  start(synth, 1, 69);
  const [left, right] = renderStereo(synth, 4800);
  assert(peak(left) > 0 && peak(right) > 0);
  const solo = combination([part(sine, {pan:-1}), ...Array.from({length:15}, () => off(sine))]);
  start(solo, 1, 69);
  const [soloLeft, soloRight] = renderStereo(solo, 4800);
  assert.deepEqual(left, soloLeft, "the right-panned layer adds nothing on the left");
  assert.equal(peak(soloRight), 0);
  const crossings = x => x.slice(1).filter((s, i) => x[i] <= 0 && s > 0).length;
  assert.equal(crossings(soloLeft), 44, "A4 for 0.1 s");
  assert.equal(Math.round(crossings(right) / 4800 * 48000 / 10), Math.round(466.16 / 10), "detuned a semitone up");
}
// The scope follows the timbre being edited and reports it.
{
  const synth = combination([part(bank[0], {}), part(bank[4], {}), ...Array.from({length:14}, () => off(sine))]);
  send(synth, {type:"focus", timbre:1});
  start(synth, 1, 60);
  request(synth, 128);
  renderStereo(synth, 128);
  const frame = readFrame(synth);
  assert.equal(frame.timbre, 1);
  assert.equal(frame.algorithm, bank[4].algorithm);
}
console.log("Nine-channel scope, algorithm, phrase and combination checks passed.");
