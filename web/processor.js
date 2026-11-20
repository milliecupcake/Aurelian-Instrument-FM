// Reference engine used by the ready-to-play edition. The Rust edition routes
// the same messages into Wasm and does its entire sample loop in src/engine.rs.
const tables = {
  1:  { source: [1,-1,3,4,5,-1], carriers: [0,2] },
  5:  { source: [1,-1,3,-1,5,-1], carriers: [0,2,4] },
  32: { source: [-1,-1,-1,-1,-1,-1], carriers: [0,1,2,3,4,5] }
};
const tau = 2 * Math.PI;
const sine = Float32Array.from({length:2049}, (_, i) => Math.sin(tau * i / 2048));

class PreviewEngine {
  constructor(rate) {
    this.rate = rate;
    this.slots = Array(16).fill(null);
    this.serial = 0;
    this.taps = new Float32Array(128 * 6);
  }
  setPatch(patch) { this.patch = patch; }
  on(id, note, velocity) {
    if (velocity <= 0) { this.off(id); return; }
    let i = this.slots.findIndex(v => v && v.id === id);
    if (i < 0) i = this.slots.indexOf(null);
    if (i < 0) {
      i = 0;
      for (let k = 1; k < 16; k++) {
        const v = this.slots[k], old = this.slots[i];
        if ((v.released && !old.released) || (v.released === old.released && v.serial < old.serial)) i = k;
      }
    }
    const hz = 440 * 2 ** ((note - 69) / 12);
    const {feedback, operators, algorithm} = this.patch;
    this.slots[i] = {
      id, note, algorithm, serial: ++this.serial, released:false, velocity, feedback, route:tables[algorithm],
      recent:0, older:0, values:new Float64Array(6),
      ops:operators.map(([ratio, level, a, d, s, r]) => ({
        p:0, step:(hz * ratio / this.rate) % 1, level, env:0, stage:0,
        attack:1 / Math.max(1, a * this.rate), decay:(1-s) / Math.max(1, d * this.rate),
        sustain:s, releaseSamples:Math.max(1, r * this.rate), release:0
      }))
    };
  }
  off(id) {
    for (const v of this.slots) {
      if (!v || v.id !== id || v.released) continue;
      v.released = true;
      for (const op of v.ops) { op.stage=3; op.release=op.env / op.releaseSamples; }
    }
  }
  silence() { this.slots.fill(null); }
  render(out, monitor) {
    out.fill(0);
    let focus = null;
    if (monitor) {
      for (const v of this.slots) {
        if (v && (!focus || (!v.released && focus.released) ||
            (v.released === focus.released && v.serial > focus.serial))) focus = v;
      }
      this.focusId = focus?.id ?? 0;
      this.focusNote = focus?.note ?? 0;
      this.focusAlgorithm = focus?.algorithm ?? 0;
      if (!focus) this.taps.fill(0);
    }
    for (let slot=0; slot<this.slots.length; slot++) {
      const v=this.slots[slot];
      if (!v) continue;
      const {ops,values,route}=v;
      for(let n=0;n<out.length;n++) {
        for(let i=5;i>=0;i--) {
          const o=ops[i];
          if(o.stage===0) {
            o.env+=o.attack;
            if(o.env>=1){o.env=1; o.stage=1;}
          } else if(o.stage===1) {
            o.env-=o.decay;
            if(o.env<=o.sustain){o.env=o.sustain; o.stage=2;}
          } else if(o.stage===3) {
            o.env-=o.release;
            if(o.env<=0.000001){o.env=0; o.stage=4;}
          }
          const src=route.source[i];
          let turns=o.p + (src===-1 ? 0 : values[src] * 6/tau);
          if(i===5) turns+=(v.recent+v.older)*v.feedback*2/tau;
          const position=(turns-Math.floor(turns))*2048, k=Math.floor(position);
          values[i]=(sine[k]+(sine[k+1]-sine[k])*(position-k))*o.env*o.level*v.velocity;
          o.p+=o.step;
          if(o.p>=1) o.p-=1;
        }
        v.older=v.recent; v.recent=values[5];
        if (v === focus) this.taps.set(values, n * 6);
        for(let k=0;k<route.carriers.length;k++) out[n]+=values[route.carriers[k]];
      }
      if(v.released && route.carriers.every(i=>ops[i].stage===4)) this.slots[slot]=null;
    }
    for(let i=0;i<out.length;i++) {
      const x=out[i]*0.26;
      out[i]=x/(1+Math.abs(x));
    }
  }
}

class RustEngine {
  constructor(module, rate) {
    this.wasm = new WebAssembly.Instance(module).exports;
    this.wasm.init(rate);
    this.scopePtr = this.wasm.scope_ptr();
  }
  setPatch(patch) {
    this.wasm.patch(patch.algorithm, patch.feedback);
    patch.operators.forEach((op,i) => this.wasm.operator(i,...op));
  }
  on(id,n,v) { this.wasm.note_on(id,n,v); }
  off(id) { this.wasm.note_off(id); }
  silence() { this.wasm.silence(); }
  render(out, monitor) {
    const ptr = this.wasm.render(out.length, monitor ? 1 : 0);
    const memory = this.wasm.memory.buffer;
    if (!this.view || this.view.buffer !== memory || this.view.byteOffset !== ptr) {
      this.view = new Float32Array(memory, ptr, 128);
      this.meta = new Uint32Array(memory, this.scopePtr, 3);
      this.taps = new Float32Array(memory, this.scopePtr + 12, 128 * 6);
    }
    if (out.length === 128) out.set(this.view);
    else for (let i = 0; i < out.length; i++) out[i] = this.view[i];
    if (monitor) {
      this.focusId = this.meta[0];
      this.focusNote = this.meta[1];
      this.focusAlgorithm = this.meta[2];
    }
  }
}

class FMProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{name:"volume", defaultValue:1, minValue:0, maxValue:1, automationRate:"a-rate"}];
  }
  constructor(options) {
    super();
    const {module, patch} = options.processorOptions;
    this.engine = module ? new RustEngine(module,sampleRate) : new PreviewEngine(sampleRate);
    this.engine.setPatch(patch);
    this.port.onmessage = ({data:m}) => {
      if(m.type==="patch") this.engine.setPatch(m.patch);
      if(m.type==="on") this.engine.on(m.id,m.note,m.velocity);
      if(m.type==="off") this.engine.off(m.id);
      if(m.type==="silence") this.engine.silence();
      if(m.type==="scope" && !this.frame) {
        this.frame = new Float32Array(m.buffer);
        this.written = 0;
        this.frameId = null;
        this.frameAlgorithm = 0;
      }
    };
    this.port.postMessage("ready");
  }
  capture(block) {
    const {taps, focusId, focusNote, focusAlgorithm} = this.engine;
    const frame = this.frame;
    if (this.frameId !== focusId || this.frameAlgorithm !== focusAlgorithm) {
      // Never identify samples from two different voices as one OP trace.
      // Keep the master history continuous through note changes.
      for (let n = 0; n < this.written; n++) frame.fill(0, n * 7, n * 7 + 6);
      this.frameId = focusId;
      this.frameAlgorithm = focusAlgorithm;
    }
    const count = Math.min(block.length, frame.length / 7 - this.written);
    for (let n = 0; n < count; n++) {
      const base = (this.written + n) * 7;
      for (let op = 0; op < 6; op++) frame[base + op] = taps[n * 6 + op];
      frame[base + 6] = block[n];
    }
    this.written += count;
    if (this.written * 7 === frame.length) {
      this.port.postMessage({type:"scope", note:focusNote, algorithm:focusAlgorithm, buffer:frame.buffer}, [frame.buffer]);
      this.frame = null;
    }
  }
  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    const volume = parameters?.volume;
    for (let offset = 0; offset < out.length; offset += 128) {
      const block = out.length <= 128 ? out : out.subarray(offset, offset + 128);
      this.engine.render(block, !!this.frame);
      if (volume?.length > 1) {
        for (let i = 0; i < block.length; i++) block[i] *= volume[offset + i];
      } else if (volume?.length === 1 && volume[0] !== 1) {
        for (let i = 0; i < block.length; i++) block[i] *= volume[0];
      }
      if (this.frame) this.capture(block);
    }
    return true;
  }
}
registerProcessor("aurelian-fm6",FMProcessor);
