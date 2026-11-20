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
// Waveforms: band-limited tables, table choice by pitch, and old six-number operators still play a sine.
{
  const tables = vm.runInContext("tables", worklet), tableOffset = vm.runInContext("tableOffset", worklet);
  const waveOf = vm.runInContext("waveOf", worklet), widthOf = vm.runInContext("widthOf", worklet), ROW = 2049, LEVELS = 11;
  // Saw, square and triangle tables. A pulse reads the saw tables.
  assert.equal(tables.length, (1 + 3 * LEVELS) * ROW);
  const table = (set, level) => Array.from(tables.subarray((1 + set * LEVELS + level) * ROW, (2 + set * LEVELS + level) * ROW));
  for (let set = 0; set < 3; set++) for (let level = 0; level < LEVELS; level++) {
    const t = table(set, level);
    assert(Math.abs(Math.max(...t.map(Math.abs)) - 1) < 1e-6);
    assert.equal(t[2048], t[0]);
  }
  assert.equal(tableOffset(1, 20 / 48000), ROW);
  assert.equal(tableOffset(1, 110 / 48000), 4 * ROW);
  assert.equal(tableOffset(3, 110 / 48000), 4 * ROW, "pulse uses the saw tables");
  assert.equal(tableOffset(2, 3000 / 48000), (1 + LEVELS + 7) * ROW);
  assert.equal(tableOffset(4, 20 / 48000), (1 + 2 * LEVELS) * ROW);
  assert.equal(tableOffset(0, 0.3), 0);
  assert.deepEqual([waveOf([1,1,0,0,1,0]), waveOf([1,1,0,0,1,0,3]), waveOf([1,1,0,0,1,0,9])], [0, 3, 0]);
  assert.deepEqual([widthOf([1,1,0,0,1,0,3]), widthOf([1,1,0,0,1,0,3,0.6]), widthOf([1,1,0,0,1,0,3,0]), widthOf([1,1,0,0,1,0,3,2])], [0.25, 0.6, 0.05, 0.95]);

  const crossings = x => x.slice(1).filter((s, i) => x[i] <= 0 && s > 0).length;
  const play = (operator, note = 69) => {
    const patch = {...sine, operators:sine.operators.map((op, i) => i === 0 ? operator(op) : op)};
    const synth = combination([part(patch, {}), ...Array.from({length:15}, () => off(sine))]);
    start(synth, 1, note);
    return renderStereo(synth, 9600)[0].slice(4800);
  };
  const plain = play(op => op.slice(0, 6));
  assert.deepEqual(play(op => [...op.slice(0, 6), 0]), plain, "wave 0 is the same sine");
  for (const wave of [1, 2, 3, 4]) {
    const shaped = play(op => [...op.slice(0, 6), wave]);
    assert.notDeepEqual(shaped, plain);
    assert(Math.abs(crossings(shaped) - crossings(plain)) <= 1, "same pitch");
  }
  // Pulse width: the share of time spent high follows the width, with no DC offset.
  // A file without a width plays a quarter-cycle pulse; other waves ignore the width.
  for (const width of [0.05, 0.1, 0.25, 0.5, 0.75, 0.95]) {
    const pulse = play(op => [...op.slice(0, 6), 3, width], 45);
    const high = pulse.filter(v => v > 0).length / pulse.length;
    assert(Math.abs(high - width) < 0.03, "width " + width + ": high " + high);
    assert(Math.abs(pulse.reduce((a, b) => a + b, 0) / pulse.length) < 0.01, "width " + width);
  }
  assert.deepEqual(play(op => [...op.slice(0, 6), 3], 45), play(op => [...op.slice(0, 6), 3, 0.25], 45));
  assert.deepEqual(play(op => [...op.slice(0, 6), 1, 0.1]), play(op => [...op.slice(0, 6), 1, 0.9]));
}
// Pitch bend and mod wheel: centred wheels change nothing, a bend moves sounding notes, vibrato keeps the average pitch.
{
  const crossings = x => x.slice(1).filter((s, i) => x[i] <= 0 && s > 0).length;
  const a4 = (...messages) => {
    const synth = combination([part(sine, {}), ...Array.from({length:15}, () => off(sine))]);
    messages.forEach(m => send(synth, m));
    start(synth, 1, 69);
    return renderStereo(synth, 48000)[0];
  };
  const plain = a4();
  assert.deepEqual(a4({type:"bend", semitones:0}, {type:"modulation", amount:0}), plain);
  assert(Math.abs(crossings(a4({type:"bend", semitones:2})) - 493.88) <= 2, "two semitones up");
  assert(Math.abs(crossings(a4({type:"bend", semitones:-12})) - 220) <= 1, "an octave down");
  const wobbly = a4({type:"modulation", amount:1});
  assert(Math.abs(crossings(wobbly) - 440) <= 2);
  assert.notDeepEqual(wobbly, plain);
  const held = combination([part(sine, {}), ...Array.from({length:15}, () => off(sine))]);
  start(held, 1, 69);
  renderStereo(held, 4800);
  send(held, {type:"bend", semitones:12});
  assert(Math.abs(crossings(renderStereo(held, 48000)[0]) - 880) <= 3, "the sounding note follows the bend");
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
// Every Program, including those inside Combinations, stays within the editor's ranges:
// ratio, level, attack, decay, sustain, release, and the optional wave (0–4) and pulse width.
const limits = [[0.25,16],[0,1],[0.002,4],[0.01,5],[0,1],[0.01,4],[0,4],[0.05,0.95]];
for (const p of [...bank, ...combis.flatMap(c => c.timbres.map(t => t.program))]) {
  assert(p.feedback >= 0 && p.feedback <= 1, p.name);
  p.operators.forEach(op => {
    assert(op.length === 6 || (op.length >= 7 && op.length <= 8 && Number.isInteger(op[6])), p.name);
    op.forEach((v, j) => assert(v >= limits[j][0] && v <= limits[j][1], p.name + " " + v));
  });
}
// Programs 24–30 show off the new waveforms: every one uses at least one non-sine carrier,
// and the whole set uses all four new waves.
{
  const waved = bank.slice(23, 30);
  assert.deepEqual(waved.map(p => p.name), ["Saw Lead", "Square Bass", "Chip Pulse", "Saw Ensemble", "Triangle Flute", "Saw Brass", "Hollow Reed"]);
  for (const p of waved) assert(route(p.algorithm).carriers.some(i => (p.operators[i][6] ?? 0) > 0 && p.operators[i][1] > 0), p.name);
  assert.deepEqual([...new Set(waved.flatMap(p => p.operators.map(op => op[6] ?? 0)))].sort(), [0, 1, 2, 3, 4]);
  // Each new Program and the Synth Lead / Bass Combination has a phrase.
  for (const name of [...waved.map(p => p.name), "Synth Lead / Bass"]) assert(phrases.some(f => f.suits.includes(name)), name);
}

// Drum Kit: each key plays exactly one drum, at that drum's own pitch.
{
  const kit = combis.find(c => c.name === "Drum Kit");
  const synth = combination(kit.timbres);
  const expected = {60:["Kick",36], 61:["Rim",72], 62:["Snare",54], 63:["Clap",60], 65:["Tom",45],
                    66:["Closed Hat",84], 67:["Tom",50], 69:["Tom",55], 70:["Open Hat",84], 72:["Crash",79]};
  for (const [key, [name, note]] of Object.entries(expected)) {
    send(synth, {type:"silence"});
    start(synth, 1, Number(key));
    const [v, ...rest] = voices(synth);
    assert.equal(rest.length, 0, "key " + key);
    assert.deepEqual([kit.timbres[v.timbre].program.name, v.note], [name, note]);
  }
  send(synth, {type:"silence"});
  start(synth, 1, 64);
  assert.equal(voices(synth).length, 0, "E4 has no drum");
}
// ---- MIDI input: message parsing, channel filter, sustain pedal and controllers.
{
  const page = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, "midi.js"), "utf8") + ";this.parseMidi=parseMidi;this.MidiRouter=MidiRouter;", page);
  const parse = data => JSON.parse(JSON.stringify(page.parseMidi(data)));
  assert.deepEqual(parse([0x90, 60, 100]), {type:"on", channel:1, note:60, velocity:100});
  assert.deepEqual(parse([0x9f, 60, 0]), {type:"off", channel:16, note:60});
  assert.deepEqual(parse([0x82, 61, 40]), {type:"off", channel:3, note:61});
  assert.deepEqual(parse([0xb0, 64, 127]), {type:"cc", channel:1, controller:64, value:127});
  assert.deepEqual(parse([0xc4, 5]), {type:"program", channel:5, program:5});
  assert.equal(page.parseMidi([0xf8]), null, "clock");
  assert.deepEqual(parse([0xe0, 0, 64]), {type:"bend", channel:1, bend:0});
  assert.deepEqual(parse([0xe2, 127, 127]), {type:"bend", channel:3, bend:1});
  assert.deepEqual(parse([0xe0, 0, 0]), {type:"bend", channel:1, bend:-1});
  assert.deepEqual(parse([0xe0, 0, 96]), {type:"bend", channel:1, bend:4096 / 8191});

  const log = [];
  const router = new page.MidiRouter({
    strike:(t, n, v) => log.push(["strike", t, n, Math.round(v * 127)]), lift:t => log.push(["lift", t]),
    silence:() => log.push(["silence"]), program:n => log.push(["program", n]),
    bend:x => log.push(["bend", x]), modulation:x => log.push(["modulation", x])
  });
  const take = () => JSON.parse(JSON.stringify(log.splice(0)));
  router.receive([0x90, 60, 90], "kbd");
  router.receive([0x80, 60, 0], "kbd");
  assert.deepEqual(take(), [["strike", "midi:kbd:1:60", 60, 90], ["lift", "midi:kbd:1:60"]]);

  // Sustain holds released keys until the pedal comes up. Restriking a held key restarts it.
  router.receive([0xb0, 64, 127], "kbd");
  router.receive([0x90, 64, 80], "kbd");
  router.receive([0x90, 67, 80], "kbd");
  router.receive([0x80, 64, 0], "kbd");
  router.receive([0x90, 64, 0], "kbd");   // a repeated note-off changes nothing
  assert.deepEqual(take().map(e => e[0]), ["strike", "strike"]);
  router.receive([0x90, 64, 70], "kbd");
  assert.deepEqual(take(), [["lift", "midi:kbd:1:64"], ["strike", "midi:kbd:1:64", 64, 70]]);
  router.receive([0x80, 64, 0], "kbd");
  router.receive([0xb0, 64, 0], "kbd");
  assert.deepEqual(take(), [["lift", "midi:kbd:1:64"]], "67 is still held down");
  router.receive([0x80, 67, 0], "kbd");
  assert.deepEqual(take(), [["lift", "midi:kbd:1:67"]]);

  // Channel filter, two inputs, a disconnected input, All Notes Off, All Sound Off, Program Change.
  router.channel = 2;
  router.receive([0x90, 50, 100], "kbd");
  assert.deepEqual(take(), [], "channel 1 is filtered out");
  router.receive([0x91, 50, 100], "kbd");
  router.receive([0x91, 50, 100], "pad");
  router.receive([0x91, 52, 100], "pad");
  take();
  router.releaseAll("pad");
  assert.deepEqual(take().map(e => e[1]).sort(), ["midi:pad:2:50", "midi:pad:2:52"]);
  router.receive([0xb1, 123, 0], "kbd");
  assert.deepEqual(take(), [["lift", "midi:kbd:2:50"]]);
  router.receive([0x91, 55, 100], "kbd");
  take();
  router.receive([0xb1, 120, 0], "kbd");
  router.receive([0x81, 55, 0], "kbd");
  assert.deepEqual(take(), [["silence"]], "after All Sound Off the late note-off is ignored");
  router.receive([0xc1, 3], "kbd");
  assert.deepEqual(take(), [["program", 3]]);

  // Pitch bend, mod wheel and Reset All Controllers, which also lifts the pedal.
  router.receive([0xe0, 0, 0], "kbd");
  assert.deepEqual(take(), [], "bend on channel 1 is filtered out");
  router.receive([0xe1, 0, 0], "kbd");
  router.receive([0xb1, 1, 127], "kbd");
  assert.deepEqual(take(), [["bend", -1], ["modulation", 1]]);
  router.receive([0xb1, 64, 127], "kbd");
  router.receive([0x91, 60, 100], "kbd");
  router.receive([0x81, 60, 0], "kbd");
  take();
  router.receive([0xb1, 121, 0], "kbd");
  assert.deepEqual(take(), [["bend", 0], ["modulation", 0], ["lift", "midi:kbd:2:60"]]);
}
console.log("Nine-channel scope, algorithm, phrase, combination, MIDI, pitch wheel, waveform and pulse width checks passed.");
