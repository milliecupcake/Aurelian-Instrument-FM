// Reference engine used by the ready-to-play edition. The Rust edition routes
// the same messages into Wasm and does its entire sample loop in src/engine.rs.
__SHARED_LIB__
const tau = 2 * Math.PI;
const sine = Float32Array.from({length:2049}, (_, i) => Math.sin(tau * i / 2048));
// Mod wheel at full depth: ±VIBRATO_DEPTH semitones at VIBRATO_HZ. Wheel moves glide over about 4 ms.
const VIBRATO_DEPTH = 0.5, VIBRATO_HZ = 5.5, GLIDE_SECONDS = 0.004;

class PreviewEngine {
  constructor(rate) {
    this.rate = rate;
    this.slots = Array(POLYPHONY).fill(null);
    this.serial = 0;
    this.focusTimbre = 0;
    this.taps = new Float32Array(128 * OPS);
    this.bend = 0; this.vibrato = 0; this.bendNow = 0; this.vibratoNow = 0; this.lfo = 0;
    this.glide = 1 - Math.exp(-1 / Math.max(1, GLIDE_SECONDS * rate));
    this.pitch = new Float64Array(128);
  }
  // Pitch bend in semitones and mod wheel depth (0–1), shared by every voice.
  setBend(semitones) { this.bend = Number.isFinite(semitones) ? Math.min(24, Math.max(-24, semitones)) : 0; }
  setVibrato(amount) { this.vibrato = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0; }
  advancePitch(length) {
    const out = this.pitch.subarray(0, length);
    if (!this.bend && !this.vibrato && !this.bendNow && !this.vibratoNow) return out.fill(1);
    for (let n = 0; n < length; n++) {
      this.bendNow += (this.bend - this.bendNow) * this.glide;
      this.vibratoNow += (this.vibrato - this.vibratoNow) * this.glide;
      if (Math.abs(this.bend - this.bendNow) < 1e-5) this.bendNow = this.bend;
      if (Math.abs(this.vibrato - this.vibratoNow) < 1e-5) this.vibratoNow = this.vibrato;
      const semitones = this.bendNow + this.vibratoNow * VIBRATO_DEPTH * Math.sin(tau * this.lfo);
      this.lfo += VIBRATO_HZ / this.rate;
      if (this.lfo >= 1) this.lfo -= 1;
      out[n] = 2 ** (semitones / 12);
    }
    return out;
  }
  // setup: 16 timbres, each with its settings and a full Program.
  setup(timbres) { this.timbres = timbres; }
  focus(timbre) { this.focusTimbre = timbre; }
  allocate() {
    let i = this.slots.indexOf(null);
    if (i >= 0) return i;
    // Prefer the oldest released voice, then the oldest held voice.
    i = 0;
    for (let k = 1; k < this.slots.length; k++) {
      const v = this.slots[k], old = this.slots[i];
      if ((v.released && !old.released) || (v.released === old.released && v.serial < old.serial)) i = k;
    }
    return i;
  }
  on(id, key, velocity) {
    if (velocity <= 0) { this.off(id); return; }
    // A repeated key ID restarts that key on every timbre.
    for (let k = 0; k < this.slots.length; k++) if (this.slots[k]?.id === id) this.slots[k] = null;
    key = Math.min(127, key);
    velocity = Math.min(1, velocity);
    this.timbres.forEach((t, timbre) => {
      if (!timbreAccepts(t, key, velocity)) return;
      const note = Math.min(127, Math.max(0, key + t.transpose));
      const cents = Math.min(100, Math.max(-100, t.detune));
      const hz = 440 * 2 ** ((note - 69) / 12 + cents / 1200);
      const {feedback, operators} = t.program;
      const algorithm = Math.min(ALGORITHMS.length, Math.max(1, t.program.algorithm));
      this.slots[this.allocate()] = {
        id, note, algorithm, timbre, serial: ++this.serial, released:false, velocity, feedback,
        route:route(algorithm), gains:timbreGains(t), recent:0, older:0, values:new Float64Array(OPS),
        ops:operators.map(([ratio, level, a, d, s, r]) => ({
          p:0, step:(hz * ratio / this.rate) % 1, level, env:0, stage:0,
          attack:1 / Math.max(1, a * this.rate), decay:(1-s) / Math.max(1, d * this.rate),
          sustain:s, releaseSamples:Math.max(1, r * this.rate), release:0
        }))
      };
    });
  }
  off(id) {
    for (const v of this.slots) {
      if (!v || v.id !== id || v.released) continue;
      v.released = true;
      for (const op of v.ops) { op.stage=3; op.release=op.env / op.releaseSamples; }
    }
  }
  silence() { this.slots.fill(null); }
  newest(timbre) {
    let focus = null;
    for (const v of this.slots) {
      if (!v || (timbre !== undefined && v.timbre !== timbre)) continue;
      if (!focus || (!v.released && focus.released) || (v.released === focus.released && v.serial > focus.serial)) focus = v;
    }
    return focus;
  }
  render(left, right, monitor) {
    left.fill(0);
    right.fill(0);
    let focus = null;
    if (monitor) {
      // Follow the timbre being edited. Fall back to the newest voice of any timbre.
      focus = this.newest(this.focusTimbre) ?? this.newest();
      this.focusId = focus?.serial ?? 0;
      this.focusNote = focus?.note ?? 0;
      this.focusAlgorithm = focus?.algorithm ?? 0;
      this.focusTimbreShown = focus?.timbre ?? 0;
      if (!focus) this.taps.fill(0);
    }
    const pitch = this.advancePitch(left.length);
    for (let slot=0; slot<this.slots.length; slot++) {
      const v=this.slots[slot];
      if (!v) continue;
      const {ops,values,route}=v, [gl,gr]=v.gains;
      for(let n=0;n<left.length;n++) {
        let mixed=0;
        for(let i=OPS-1;i>=0;i--) {
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
          // Several modulators add up. One full-scale modulator shifts the phase by up to 6 radians.
          const sources=route.modulators[i];
          let input=0;
          for(let k=0;k<sources.length;k++) input+=values[sources[k]];
          let turns=o.p + input * 6/tau;
          if(i===OPS-1) turns+=(v.recent+v.older)*v.feedback*2/tau;
          const position=(turns-Math.floor(turns))*2048, k=Math.floor(position);
          values[i]=(sine[k]+(sine[k+1]-sine[k])*(position-k))*o.env*o.level*v.velocity;
          o.p+=o.step*pitch[n];
          if(o.p>=1) o.p-=Math.floor(o.p);
        }
        v.older=v.recent; v.recent=values[OPS-1];
        if (v === focus) this.taps.set(values, n * OPS);
        for(let k=0;k<route.carriers.length;k++) mixed+=values[route.carriers[k]];
        left[n]+=mixed*gl;
        right[n]+=mixed*gr;
      }
      if(v.released && route.carriers.every(i=>ops[i].stage===4)) this.slots[slot]=null;
    }
    // Fixed headroom for chords, followed by a bounded soft limiter on each channel.
    for (const out of [left, right]) {
      for(let i=0;i<out.length;i++) {
        const x=out[i]*0.26;
        out[i]=x/(1+Math.abs(x));
      }
    }
  }
}

class RustEngine {
  constructor(module, rate) {
    this.wasm = new WebAssembly.Instance(module).exports;
    this.wasm.init(rate);
    this.scopePtr = this.wasm.scope_ptr();
  }
  setup(timbres) {
    timbres.forEach((t, i) => {
      this.wasm.timbre(i, t.on ? 1 : 0, t.volume, t.pan, t.transpose, t.detune, t.keyLow, t.keyHigh, t.velocityLow, t.velocityHigh);
      this.wasm.patch(i, t.program.algorithm, t.program.feedback);
      t.program.operators.forEach((op, k) => this.wasm.operator(i, k, ...op));
    });
  }
  focus(timbre) { this.wasm.focus(timbre); }
  on(id,n,v) { this.wasm.note_on(id,n,v); }
  off(id) { this.wasm.note_off(id); }
  silence() { this.wasm.silence(); }
  setBend(semitones) { this.wasm.pitch_bend(semitones); }
  setVibrato(amount) { this.wasm.modulation(amount); }
  render(left, right, monitor) {
    const ptr = this.wasm.render(left.length, monitor ? 1 : 0);
    const memory = this.wasm.memory.buffer;
    if (!this.view || this.view.buffer !== memory || this.view.byteOffset !== ptr) {
      // 128 left samples, then 128 right samples.
      this.view = new Float32Array(memory, ptr, 256);
      this.meta = new Uint32Array(memory, this.scopePtr, 4);
      this.taps = new Float32Array(memory, this.scopePtr + 16, 128 * OPS);
    }
    for (let i = 0; i < left.length; i++) { left[i] = this.view[i]; right[i] = this.view[128 + i]; }
    if (monitor) {
      this.focusId = this.meta[0];
      this.focusNote = this.meta[1];
      this.focusAlgorithm = this.meta[2];
      this.focusTimbreShown = this.meta[3];
    }
  }
}

class FMProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{name:"volume", defaultValue:1, minValue:0, maxValue:1, automationRate:"a-rate"}];
  }
  constructor(options) {
    super();
    const {module, timbres} = options.processorOptions;
    this.engine = module ? new RustEngine(module,sampleRate) : new PreviewEngine(sampleRate);
    this.engine.setup(timbres);
    this.left = new Float32Array(128);
    this.right = new Float32Array(128);
    this.port.onmessage = ({data:m}) => {
      if(m.type==="setup") this.engine.setup(m.timbres);
      if(m.type==="focus") this.engine.focus(m.timbre);
      if(m.type==="on") this.engine.on(m.id,m.note,m.velocity);
      if(m.type==="off") this.engine.off(m.id);
      if(m.type==="silence") this.engine.silence();
      if(m.type==="bend") this.engine.setBend(m.semitones);
      if(m.type==="modulation") this.engine.setVibrato(m.amount);
      if(m.type==="scope" && !this.frame) {
        this.frame = new Float32Array(m.buffer);
        this.written = 0;
        this.frameId = null;
        this.frameAlgorithm = 0;
      }
    };
    this.port.postMessage("ready");
  }
  // The master trace is the average of the two output channels.
  capture(left, right) {
    const {taps, focusId, focusNote, focusAlgorithm, focusTimbreShown} = this.engine;
    const frame = this.frame;
    if (this.frameId !== focusId || this.frameAlgorithm !== focusAlgorithm) {
      // Never identify samples from two different voices as one OP trace.
      // Keep the master history continuous through note changes.
      for (let n = 0; n < this.written; n++) frame.fill(0, n * (OPS + 1), n * (OPS + 1) + OPS);
      this.frameId = focusId;
      this.frameAlgorithm = focusAlgorithm;
    }
    // Each sample row holds OP1–OP8 and then the master output.
    const stride = OPS + 1;
    const count = Math.min(left.length, frame.length / stride - this.written);
    for (let n = 0; n < count; n++) {
      const base = (this.written + n) * stride;
      for (let op = 0; op < OPS; op++) frame[base + op] = taps[n * OPS + op];
      frame[base + OPS] = (left[n] + right[n]) / 2;
    }
    this.written += count;
    if (this.written * stride === frame.length) {
      this.port.postMessage({type:"scope", note:focusNote, algorithm:focusAlgorithm, timbre:focusTimbreShown, buffer:frame.buffer}, [frame.buffer]);
      this.frame = null;
    }
  }
  process(inputs, outputs, parameters) {
    const [outLeft, outRight] = outputs[0];
    if (!outLeft) return true;
    const volume = parameters?.volume;
    for (let offset = 0; offset < outLeft.length; offset += 128) {
      const size = Math.min(128, outLeft.length - offset);
      const left = this.left.subarray(0, size), right = this.right.subarray(0, size);
      this.engine.render(left, right, !!this.frame);
      for (const out of [left, right]) {
        if (volume?.length > 1) {
          for (let i = 0; i < size; i++) out[i] *= volume[offset + i];
        } else if (volume?.length === 1 && volume[0] !== 1) {
          for (let i = 0; i < size; i++) out[i] *= volume[0];
        }
      }
      outLeft.set(left, offset);
      // A mono destination receives the left channel; a centred Program sounds the same on both.
      if (outRight) outRight.set(right, offset);
      if (this.frame) this.capture(left, right);
    }
    return true;
  }
}
registerProcessor("aurelian-fm8",FMProcessor);
