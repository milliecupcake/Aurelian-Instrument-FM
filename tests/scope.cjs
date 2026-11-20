// Run with: node tests/scope.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..", "web");
const bank = JSON.parse(fs.readFileSync(path.join(root, "presets.json"), "utf8"));
let Processor;

class WorkletHost {
  constructor() {
    this.messages = [];
    this.port = {postMessage: (message, transfer=[]) => {
      this.messages.push(structuredClone(message, {transfer}));
    }};
  }
}
vm.runInNewContext(fs.readFileSync(path.join(root, "processor.js"), "utf8"), {
  sampleRate:48000,
  AudioWorkletProcessor:WorkletHost,
  registerProcessor:(_, implementation) => { Processor=implementation; }
});

function send(proc, message) { proc.port.onmessage({data:message}); }
function start(proc, id, note) { send(proc, {type:"on", id, note, velocity:0.8}); }
function request(proc, count) { send(proc, {type:"scope", buffer:new ArrayBuffer(count * 7 * 4)}); }
function render(proc, count, volume) {
  const out = new Float32Array(count);
  proc.process([], [[out]], {volume});
  return out;
}
function readFrame(proc) {
  const frame = proc.messages.pop();
  assert.equal(frame.type, "scope");
  return {...frame, samples:new Float32Array(frame.buffer)};
}
function channel(samples, index) {
  return samples.filter((_, i) => i % 7 === index);
}
function peak(samples) { return samples.reduce((p, s) => Math.max(p, Math.abs(s)), 0); }
const full = new Float32Array([1]);
const mute = new Float32Array([0]);
function instrument(patch) { return new Processor({processorOptions:{patch}}); }

for (const [algorithm, carriers] of [[1,[0,2]], [5,[0,2,4]], [32,[0,1,2,3,4,5]]]) {
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
  assert.deepEqual(channel(samples, 6), new Float32Array([...first,...second]));
  for (let i=0; i<length; i++) {
    const sum = carriers.reduce((total, op) => total + samples[i*7+op], 0);
    const x = sum*0.26;
    const gain = i<53 ? 1 : volume[i-53];
    assert(Math.abs(samples[i*7+6] - gain*x/(1+Math.abs(x))) < 1e-6);
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
for (let op=0; op<6; op++) {
  assert.deepEqual(channel(chord.samples, op), channel(one.samples, op));
}
assert.notDeepEqual(channel(chord.samples, 6), channel(one.samples, 6));

// Switching the editor does not relabel a note that is still sounding.
send(poly, {type:"patch", patch:bank[2]});
request(poly, 256);
render(poly, 128, full);
send(poly, {type:"off", id:2});
const afterRelease = render(poly, 128, full);
const changed = readFrame(poly);
assert.equal(changed.note, 60);
assert.equal(changed.algorithm, 5);
for (let op=0; op<6; op++) assert.equal(peak(channel(changed.samples, op).slice(0,128)), 0);
assert(peak(channel(changed.samples, 6).slice(0,128))>0);
assert.deepEqual(channel(changed.samples, 6).slice(128), afterRelease);

// Release tails still have operator traces when the master is muted.
send(poly, {type:"off", id:1});
request(poly, 384);
render(poly, 384, mute);
const tail = readFrame(poly);
assert.equal(tail.note, 67);
assert(peak(channel(tail.samples, 0))>0);
assert.equal(peak(channel(tail.samples, 6)), 0);
send(poly, {type:"silence"});
request(poly, 128);
render(poly, 128, full);
const idle = readFrame(poly);
assert.equal(idle.algorithm, 0);
assert.equal(peak(idle.samples), 0);

// Muted operators must stay flat, including on display-buffer reuse.
send(poly, {type:"patch", patch:bank[3]});
start(poly, 3, 60);
send(poly, {type:"scope", buffer:tail.buffer});
render(poly, 384, full);
const init = readFrame(poly);
assert(peak(channel(init.samples, 0))>0);
for (let op=1; op<6; op++) assert.equal(peak(channel(init.samples, op)), 0);
console.log("Seven-channel scope checks passed.");
