/**
 * All-synthesised bus audio (Web Audio, no samples).
 *
 * Continuous voices: diesel engine (firing-order harmonics, combustion
 * clatter, intake roar, turbo whistle, transmission whine) or the Metro's
 * traction motors (motor whine, inverter tone, HVAC fans); tyre roar, road
 * rumble, wind, tyre squeal, scrape; horn; reverse beeper.
 *
 * One-shots are driven by the driving subsystem's events (see hub.ts), so the
 * game only needs to call start(), update(), horn() and impact() - plus ding()
 * for the stop-request bell.
 */
import type { BusType } from '../types';
import { onSimEvent, telemetry } from './hub';

type Ctx = AudioContext;

interface Envelope {
  gain: number;
  attack?: number;
  hold?: number;
  release: number;
  dest?: AudioNode;
}

interface ToneShot extends Envelope {
  type?: OscillatorType;
  freq?: number;
  freqEnd?: number;
}

interface OneShot extends Envelope {
  type?: BiquadFilterType;
  freq?: number;
  freqEnd?: number;
  q?: number;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Stereo impulse response of a concrete bus tunnel: early slap-back reflections and a ~1.6 s tail. */
function tunnelIR(ctx: Ctx): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 1.8);
  const buf = ctx.createBuffer(2, len, sr);
  let seed = 4242;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // Diffuse tail, darker as it decays (one-pole smoothing grows with time).
      d[i] = rnd() * Math.exp(-t / 0.45) * 0.6;
    }
    let y = 0;
    for (let i = 0; i < len; i++) {
      const a = Math.min(0.92, 0.25 + (i / len) * 0.9);
      y = y * a + d[i] * (1 - a);
      d[i] = y * 2.2;
    }
    // Early reflections off the side walls and ceiling (slightly different per ear).
    for (const [ms, g] of [
      [11 + c * 3, 0.55],
      [23 + c * 2, 0.4],
      [37 - c * 4, 0.3],
      [58 + c * 5, 0.22],
      [83 - c * 3, 0.16],
    ]) {
      const k = Math.floor((ms / 1000) * sr);
      if (k < len) d[k] += g * (c ? -1 : 1);
    }
  }
  return buf;
}

function makeNoise(ctx: Ctx, seconds = 2.5): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = 22222;
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    d[i] = (s / 0x3fffffff - 1) * 0.9;
  }
  return buf;
}

/** Firing-frequency waveform for a 6-cylinder diesel: strong low orders, lumpy upper ones. */
function dieselWave(ctx: Ctx): PeriodicWave {
  const amps = [0, 1, 0.62, 0.55, 0.34, 0.26, 0.31, 0.14, 0.16, 0.1, 0.09, 0.06, 0.07, 0.04, 0.035, 0.03, 0.025];
  const real = new Float32Array(amps.length);
  const imag = new Float32Array(amps.length);
  for (let i = 1; i < amps.length; i++) {
    const ph = (i * 2.399) % (Math.PI * 2);
    real[i] = amps[i] * Math.cos(ph);
    imag[i] = amps[i] * Math.sin(ph);
  }
  return ctx.createPeriodicWave(real, imag);
}

/** Narrow pulse train (combustion events) used to amplitude-modulate the clatter noise. */
function pulseWave(ctx: Ctx): PeriodicWave {
  const n = 24;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 1; i < n; i++) real[i] = Math.exp(-i * 0.12);
  return ctx.createPeriodicWave(real, imag);
}

interface Voice {
  out: GainNode;
  set(now: number, s: VoiceState): void;
  stop(now: number): void;
}

interface VoiceState {
  rpm: number;
  load: number;
  boost: number;
  speed: number;
  retarder: number;
  shifting: boolean;
  cab: boolean;
}

class DieselVoice implements Voice {
  out: GainNode;
  private tone: OscillatorNode;
  private toneLp: BiquadFilterNode;
  private toneGain: GainNode;
  private lfo: OscillatorNode;
  private lfoGain: GainNode;
  private clatBp: BiquadFilterNode;
  private clatGain: GainNode;
  private am: OscillatorNode;
  private amGain: GainNode;
  private roarLp: BiquadFilterNode;
  private roarGain: GainNode;
  private turbo: OscillatorNode;
  private turboGain: GainNode;
  private turboBp: BiquadFilterNode;
  private turboNoiseGain: GainNode;
  private whine: OscillatorNode;
  private whineGain: GainNode;
  private srcs: AudioScheduledSourceNode[] = [];

  constructor(ctx: Ctx, noise: AudioBuffer, dest: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
    const noiseSrc = (offset: number) => {
      const n = ctx.createBufferSource();
      n.buffer = noise;
      n.loop = true;
      n.start(0, offset);
      this.srcs.push(n);
      return n;
    };

    // Firing harmonics with a crank-order throb.
    this.tone = ctx.createOscillator();
    this.tone.setPeriodicWave(dieselWave(ctx));
    this.toneLp = ctx.createBiquadFilter();
    this.toneLp.type = 'lowpass';
    this.toneLp.Q.value = 0.9;
    this.toneGain = ctx.createGain();
    this.toneGain.gain.value = 0.5;
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 0.12;
    this.lfo.connect(this.lfoGain).connect(this.toneGain.gain);
    this.tone.connect(this.toneLp).connect(this.toneGain).connect(this.out);

    // Combustion clatter: band-passed noise gated by a pulse train at the firing frequency.
    const cn = noiseSrc(0.3);
    this.clatBp = ctx.createBiquadFilter();
    this.clatBp.type = 'bandpass';
    this.clatBp.Q.value = 1.1;
    this.clatGain = ctx.createGain();
    this.clatGain.gain.value = 0;
    this.am = ctx.createOscillator();
    this.am.setPeriodicWave(pulseWave(ctx));
    this.amGain = ctx.createGain();
    this.amGain.gain.value = 0.02;
    this.am.connect(this.amGain).connect(this.clatGain.gain);
    cn.connect(this.clatBp).connect(this.clatGain).connect(this.out);

    // Intake / exhaust roar.
    const rn = noiseSrc(1.1);
    this.roarLp = ctx.createBiquadFilter();
    this.roarLp.type = 'lowpass';
    this.roarLp.Q.value = 0.7;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    rn.connect(this.roarLp).connect(this.roarGain).connect(this.out);

    // Turbo whistle and whoosh.
    this.turbo = ctx.createOscillator();
    this.turbo.type = 'sine';
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turbo.connect(this.turboGain).connect(this.out);
    const tn = noiseSrc(1.7);
    this.turboBp = ctx.createBiquadFilter();
    this.turboBp.type = 'bandpass';
    this.turboBp.Q.value = 7;
    this.turboNoiseGain = ctx.createGain();
    this.turboNoiseGain.gain.value = 0;
    tn.connect(this.turboBp).connect(this.turboNoiseGain).connect(this.out);

    // Transmission / diff whine with road speed.
    this.whine = ctx.createOscillator();
    this.whine.type = 'triangle';
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(this.whineGain).connect(this.out);

    for (const o of [this.tone, this.lfo, this.am, this.turbo, this.whine]) {
      o.start();
      this.srcs.push(o);
    }
  }

  set(now: number, s: VoiceState): void {
    const k = 0.05;
    const f0 = (s.rpm / 60) * 3; // six cylinders, four stroke
    const load = s.load;
    this.tone.frequency.setTargetAtTime(f0, now, 0.03);
    this.lfo.frequency.setTargetAtTime(s.rpm / 60, now, 0.05);
    this.am.frequency.setTargetAtTime(f0, now, 0.03);
    this.toneLp.frequency.setTargetAtTime(160 + s.rpm * 0.22 + load * 650, now, k);
    this.toneGain.gain.setTargetAtTime(0.42 + load * 0.38, now, k);
    this.clatBp.frequency.setTargetAtTime(850 + s.rpm * 0.55, now, k);
    this.amGain.gain.setTargetAtTime(0.03 + load * 0.035 + (s.rpm < 800 ? 0.015 : 0), now, k);
    this.roarLp.frequency.setTargetAtTime(110 + s.rpm * 0.12 + load * 380, now, k);
    this.roarGain.gain.setTargetAtTime(0.05 + load * 0.22 * (s.rpm / 2000), now, k);
    const b = s.boost;
    const tf = 1400 + b * 5200;
    this.turbo.frequency.setTargetAtTime(tf, now, 0.08);
    this.turboGain.gain.setTargetAtTime(b * b * 0.006, now, 0.1);
    this.turboBp.frequency.setTargetAtTime(tf * 0.7, now, 0.08);
    this.turboNoiseGain.gain.setTargetAtTime(b * 0.05, now, 0.1);
    const v = Math.abs(s.speed);
    this.whine.frequency.setTargetAtTime(40 + v * 31, now, 0.05);
    this.whineGain.gain.setTargetAtTime(Math.min(1, v / 12) * (0.004 + load * 0.004), now, 0.1);
    const dip = s.shifting ? 0.75 : 1;
    this.out.gain.setTargetAtTime((s.cab ? 0.5 : 0.85) * dip, now, s.shifting ? 0.04 : 0.12);
  }

  stop(now: number): void {
    this.out.gain.setTargetAtTime(0, now, 0.15);
    for (const s of this.srcs) s.stop(now + 1);
  }
}

class ElectricVoice implements Voice {
  out: GainNode;
  private m1: OscillatorNode;
  private m2: OscillatorNode;
  private mGain: GainNode;
  private inv: OscillatorNode;
  private invBp: BiquadFilterNode;
  private invGain: GainNode;
  private hvacGain: GainNode;
  private srcs: AudioScheduledSourceNode[] = [];

  constructor(ctx: Ctx, noise: AudioBuffer, dest: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
    this.m1 = ctx.createOscillator();
    this.m1.type = 'sine';
    this.m2 = ctx.createOscillator();
    this.m2.type = 'triangle';
    this.mGain = ctx.createGain();
    this.mGain.gain.value = 0;
    const m2g = ctx.createGain();
    m2g.gain.value = 0.35;
    this.m1.connect(this.mGain);
    this.m2.connect(m2g).connect(this.mGain);
    this.mGain.connect(this.out);

    this.inv = ctx.createOscillator();
    this.inv.type = 'square';
    this.invBp = ctx.createBiquadFilter();
    this.invBp.type = 'bandpass';
    this.invBp.Q.value = 5;
    this.invGain = ctx.createGain();
    this.invGain.gain.value = 0;
    this.inv.connect(this.invBp).connect(this.invGain).connect(this.out);

    const n = ctx.createBufferSource();
    n.buffer = noise;
    n.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 650;
    const hiss = ctx.createBiquadFilter();
    hiss.type = 'bandpass';
    hiss.frequency.value = 2400;
    hiss.Q.value = 1.5;
    this.hvacGain = ctx.createGain();
    this.hvacGain.gain.value = 0.06;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0.012;
    n.connect(lp).connect(this.hvacGain).connect(this.out);
    n.connect(hiss).connect(hissGain).connect(this.out);
    n.start(0, 0.7);
    for (const o of [this.m1, this.m2, this.inv]) o.start();
    this.srcs.push(this.m1, this.m2, this.inv, n);
  }

  set(now: number, s: VoiceState): void {
    const v = Math.abs(s.speed);
    const f = 30 + v * 52;
    this.m1.frequency.setTargetAtTime(f, now, 0.04);
    this.m2.frequency.setTargetAtTime(f * 2.02, now, 0.04);
    const torque = Math.max(s.load, s.retarder * 0.7);
    this.mGain.gain.setTargetAtTime(Math.min(1, v / 3) * (0.025 + torque * 0.06) + torque * 0.01, now, 0.06);
    // Inverter carrier steps up through a little scale at low speed, then holds.
    const steps = [523, 587, 659, 698, 784, 880, 988];
    const carrier = v < 7 ? steps[Math.min(steps.length - 1, Math.floor(v))] : 1046 + (v - 7) * 9;
    this.inv.frequency.setTargetAtTime(carrier, now, 0.01);
    this.invBp.frequency.setTargetAtTime(carrier, now, 0.01);
    this.invGain.gain.setTargetAtTime(torque * 0.012 * (v < 12 ? 1 : 0.5), now, 0.05);
    this.hvacGain.gain.setTargetAtTime(0.05, now, 0.5);
    this.out.gain.setTargetAtTime(s.cab ? 0.75 : 0.9, now, 0.2);
  }

  stop(now: number): void {
    this.out.gain.setTargetAtTime(0, now, 0.15);
    for (const s of this.srcs) s.stop(now + 1);
  }
}

export class BusAudio {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private scope: Float32Array<ArrayBuffer> | null = null;
  private mix: GainNode | null = null;
  private engineBus: BiquadFilterNode | null = null;
  private noise: AudioBuffer | null = null;
  private engine: Voice | null = null;
  private type: BusType = 'rigid';
  private muted = false;
  private volume = 0.5;

  // continuous nodes
  private tyreLp: BiquadFilterNode | null = null;
  private tyreGain: GainNode | null = null;
  private rumbleGain: GainNode | null = null;
  private windBp: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private squealOsc: OscillatorNode | null = null;
  private squealGain: GainNode | null = null;
  private scrapeGain: GainNode | null = null;
  private brakeSqOsc: OscillatorNode | null = null;
  private brakeSqGain: GainNode | null = null;
  private hornGain: GainNode | null = null;
  private reverbSend: GainNode | null = null;

  private hornOn = false;
  private beepPhase = 0;
  private scrape = 0;
  private lastImpact = -10;
  private travel = 0;
  private nextThump = 14;
  private flare = 0;
  private squealThisStop = false;
  private lastT = 0;
  private wasBraking = false;

  constructor() {
    const dbg = (globalThis as { __busSim?: object }).__busSim;
    if (dbg) Object.assign(dbg, { audio: this });
    const resume = () => {
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
    };
    for (const ev of ['keydown', 'pointerdown', 'touchend', 'mousedown'] as const) addEventListener(ev, resume, { passive: true });
    onSimEvent((e) => {
      switch (e.type) {
        case 'shift':
          this.clunk(0.05);
          break;
        case 'scrape':
          this.scrape = Math.max(this.scrape, clamp(e.strength, 0.25, 1));
          break;
        case 'splash':
          this.splash();
          break;
        case 'airHiss':
          this.hiss(0.6 + e.strength * 0.5, 0.75);
          break;
        case 'purge':
          this.purge();
          break;
        case 'parkBrake':
          if (e.on) this.hiss(0.55, 0.35);
          else this.hiss(1.1, 1.0);
          break;
        case 'door':
          this.door(e.opening);
          break;
        case 'doorWarning':
          this.doorBeeps();
          break;
        case 'doorShut':
          this.clunk(0.12, 95);
          break;
        case 'kneel':
          this.kneelHiss(e.down);
          break;
        case 'indicator':
          this.indicatorTick(e.on);
          break;
        case 'gearSelect':
          this.click(0.05, 1800);
          break;
        case 'refused':
          this.bonk();
          break;
        case 'jackknife':
          this.alarm();
          break;
        default:
          break;
      }
    });
  }

  /** Create / resume the AudioContext. Call from a user gesture when possible. */
  start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC: typeof AudioContext | undefined =
      typeof AudioContext !== 'undefined' ? AudioContext : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.noise = makeNoise(ctx);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.2;
    comp.connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    comp.connect(this.analyser);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(comp);
    this.mix = ctx.createGain();
    this.mix.connect(this.master);
    // Tunnel acoustics: a send from the whole mix into a synthetic concrete-tube reverb.
    const verb = ctx.createConvolver();
    verb.buffer = tunnelIR(ctx);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0;
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.9;
    this.mix.connect(this.reverbSend).connect(verb).connect(verbOut).connect(this.master);
    this.engineBus = ctx.createBiquadFilter();
    this.engineBus.type = 'lowpass';
    this.engineBus.frequency.value = 2500;
    this.engineBus.connect(this.mix);
    this.buildRoad(ctx);
    this.buildHorn(ctx);
    this.type = telemetry.busType;
    this.engine = this.makeEngine();
    // Play the start-up (starter motor / Metro power-on) once the context actually runs; with the
    // ?route= shortcut that is the first key press.
    if (ctx.state === 'running') this.startup();
    else {
      const go = () => {
        if (ctx.state !== 'running') return;
        ctx.removeEventListener('statechange', go);
        this.startup();
      };
      ctx.addEventListener('statechange', go);
      void ctx.resume();
    }
  }

  /** Switch between diesel and electric sound (normally automatic from the player's bus). */
  setType(type: BusType): void {
    if (type === this.type && this.engine) return;
    this.type = type;
    if (!this.ctx) return;
    this.engine?.stop(this.ctx.currentTime);
    this.engine = this.makeEngine();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Output level of the last ~43 ms in dBFS (for meters and automated checks). */
  levels(): { rms: number; peak: number; state: string } {
    const a = this.analyser;
    if (!a || !this.ctx) return { rms: -Infinity, peak: -Infinity, state: 'none' };
    this.scope ??= new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(this.scope);
    let sum = 0;
    let peak = 0;
    for (const v of this.scope) {
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
    return { rms: db(Math.sqrt(sum / this.scope.length)), peak: db(peak), state: this.ctx.state };
  }

  /** Master volume 0..1 (default 0.5). */
  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    this.setMuted(this.muted);
  }

  update(s: { rpm: number; throttle: number; speed: number; brake: number }): void {
    const ctx = this.ctx;
    if (!ctx || !this.engine || ctx.state !== 'running') return;
    if (telemetry.busType !== this.type) this.setType(telemetry.busType);
    const now = ctx.currentTime;
    const dt = clamp(now - this.lastT, 0, 0.1);
    this.lastT = now;
    const t = telemetry;
    const cab = t.view === 'cab';
    const v = Math.abs(s.speed);
    this.flare = Math.max(0, this.flare - dt * 420);
    this.engine.set(now, {
      rpm: s.rpm + this.flare,
      load: t.load,
      boost: t.boost,
      speed: s.speed,
      retarder: t.retarder,
      shifting: t.shifting,
      cab,
    });
    // Rear engine: from the cab it is ten metres behind a bulkhead.
    this.engineBus?.frequency.setTargetAtTime(cab ? 1400 : 5200, now, 0.2);
    // In a tunnel the engine and tyres bounce back off the walls.
    this.reverbSend?.gain.setTargetAtTime(t.inTunnel ? 0.9 : 0, now, t.inTunnel ? 0.35 : 0.6);

    // Road.
    const vn = v / 22;
    this.tyreLp?.frequency.setTargetAtTime(220 + v * 32, now, 0.1);
    this.tyreGain?.gain.setTargetAtTime(0.13 * Math.pow(vn, 1.25) * (cab ? 0.8 : 1), now, 0.1);
    this.rumbleGain?.gain.setTargetAtTime(0.22 * Math.min(1, vn * 1.4), now, 0.1);
    this.windBp?.frequency.setTargetAtTime(600 + v * 45, now, 0.2);
    this.windGain?.gain.setTargetAtTime(0.05 * Math.pow(vn, 2.4), now, 0.2);
    this.squealOsc?.frequency.setTargetAtTime(950 + t.slip * 250, now, 0.05);
    this.squealGain?.gain.setTargetAtTime(v > 3 ? clamp(t.slip, 0, 1) * 0.045 : 0, now, 0.06);
    this.scrape = Math.max(0, this.scrape - dt * 2.5);
    this.scrapeGain?.gain.setTargetAtTime(this.scrape * 0.22, now, 0.04);

    // Brake squeal as the bus comes to a stand (not every stop).
    const braking = s.brake > 0.15;
    if (braking && !this.wasBraking) this.squealThisStop = Math.random() < 0.45;
    this.wasBraking = braking;
    const squeal = braking && this.squealThisStop && v > 0.25 && v < 3.2 ? 1 : 0;
    this.brakeSqGain?.gain.setTargetAtTime(squeal * 0.016 * clamp(s.brake, 0.3, 1), now, squeal ? 0.15 : 0.05);
    this.brakeSqOsc?.frequency.setTargetAtTime(2900 + v * 80, now, 0.1);

    // Expansion-joint thumps.
    this.travel += v * dt;
    if (this.travel > this.nextThump && v > 4) {
      this.travel = 0;
      this.nextThump = 9 + Math.random() * 30;
      this.thump(0.05 + vn * 0.08);
    }

    // Reverse beeper.
    if (t.reverse) {
      const before = this.beepPhase;
      this.beepPhase = (this.beepPhase + dt) % 0.9;
      if (before > this.beepPhase || before === 0) this.tone(now, 0.42, { type: 'sine', freq: 1220, gain: cab ? 0.03 : 0.06, attack: 0.01, release: 0.03, hold: 0.36 });
    } else this.beepPhase = 0;
  }

  horn(on: boolean): void {
    if (on === this.hornOn || !this.ctx || !this.hornGain) return;
    this.hornOn = on;
    const now = this.ctx.currentTime;
    this.hornGain.gain.cancelScheduledValues(now);
    this.hornGain.gain.setTargetAtTime(on ? 0.3 : 0, now, on ? 0.012 : 0.05);
  }

  /** Pneumatic door hiss (opening) or closing hiss. Driven automatically by BusControls. */
  door(opening: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.noiseShot(now, 0.9, { type: 'bandpass', freq: 3200, freqEnd: 2200, q: 0.8, gain: 0.12, attack: 0.02, hold: 0.25, release: 0.45 });
    this.noiseShot(now, 0.6, { type: 'highpass', freq: 5000, q: 0.5, gain: 0.05, attack: 0.01, release: 0.4 });
    if (opening) this.clunk(0.08, 120, now + 1.35);
  }

  /** Indicator relay: tick on lamp-on, tock on lamp-off. Driven automatically by BusControls. */
  indicatorTick(on = true): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const f = on ? 2600 : 1900;
    this.noiseShot(now, 0.03, { type: 'bandpass', freq: f, q: 4, gain: on ? 0.16 : 0.11, attack: 0.001, release: 0.02 });
    this.tone(now, 0.025, { type: 'square', freq: on ? 1250 : 980, gain: 0.02, attack: 0.001, release: 0.02 });
  }

  impact(strength: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - this.lastImpact < 0.18) return;
    this.lastImpact = now;
    const g = clamp(strength / 8, 0.15, 1);
    this.tone(now, 0.5, { type: 'sine', freq: 95, freqEnd: 38, gain: 0.5 * g, attack: 0.003, release: 0.45 });
    this.noiseShot(now, 0.35, { type: 'lowpass', freq: 900, freqEnd: 300, q: 0.7, gain: 0.45 * g, attack: 0.002, release: 0.3 });
    this.noiseShot(now, 0.6, { type: 'bandpass', freq: 1300, q: 9, gain: 0.25 * g, attack: 0.002, release: 0.55 });
    this.noiseShot(now + 0.03, 0.25, { type: 'highpass', freq: 3500, q: 0.6, gain: 0.12 * g, attack: 0.002, release: 0.2 });
    this.scrape = Math.max(this.scrape, 0.6 * g);
  }

  /** Stop-request bell. */
  ding(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const f = 1568;
    this.tone(now, 1.4, { type: 'sine', freq: f, gain: 0.11, attack: 0.002, release: 1.3 });
    this.tone(now, 0.7, { type: 'sine', freq: f * 2.01, gain: 0.035, attack: 0.002, release: 0.6 });
    this.tone(now, 0.35, { type: 'sine', freq: f * 2.76, gain: 0.02, attack: 0.002, release: 0.3 });
  }

  /** Air-brake "pssht". */
  hiss(strength = 1, length = 0.7): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const g = 0.16 * strength;
    this.noiseShot(now, length + 0.1, { type: 'highpass', freq: 2600, q: 0.6, gain: g, attack: 0.008, hold: length * 0.25, release: length * 0.7 });
    this.noiseShot(now, length, { type: 'bandpass', freq: 5200, freqEnd: 3600, q: 1.2, gain: g * 0.6, attack: 0.005, hold: length * 0.15, release: length * 0.7 });
  }

  /** Air dryer purge: a sharp, loud blast under the floor. */
  purge(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.tone(now, 0.12, { type: 'sine', freq: 140, freqEnd: 60, gain: 0.12, attack: 0.002, release: 0.1 });
    this.noiseShot(now, 1.3, { type: 'highpass', freq: 1800, q: 0.5, gain: 0.2, attack: 0.004, hold: 0.15, release: 1.0 });
    this.noiseShot(now, 0.9, { type: 'bandpass', freq: 4200, q: 1.5, gain: 0.1, attack: 0.004, release: 0.8 });
  }

  splash(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.noiseShot(now, 2.2, { type: 'lowpass', freq: 2400, freqEnd: 300, q: 0.6, gain: 0.6, attack: 0.01, hold: 0.1, release: 2.0 });
    this.tone(now, 0.6, { type: 'sine', freq: 70, freqEnd: 30, gain: 0.4, attack: 0.005, release: 0.55 });
    for (let i = 0; i < 9; i++) {
      const t0 = now + 0.3 + i * 0.13 + Math.random() * 0.1;
      this.tone(t0, 0.09, { type: 'sine', freq: 300 + Math.random() * 500, freqEnd: 900 + Math.random() * 700, gain: 0.04, attack: 0.005, release: 0.08 });
    }
  }

  // ---------------------------------------------------------------------------

  private makeEngine(): Voice | null {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.engineBus) return null;
    return this.type === 'metro' ? new ElectricVoice(ctx, this.noise, this.engineBus) : new DieselVoice(ctx, this.noise, this.engineBus);
  }

  private startup(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (this.type === 'metro') {
      // Power-up chime and the HVAC spinning up.
      this.tone(now + 0.1, 0.5, { type: 'sine', freq: 659, gain: 0.05, attack: 0.01, release: 0.4 });
      this.tone(now + 0.32, 0.8, { type: 'sine', freq: 988, gain: 0.05, attack: 0.01, release: 0.7 });
      return;
    }
    // Starter motor cranking, then the engine catches with a flare.
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.linearRampToValueAtTime(240, now + 0.9);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.05, now + 0.05);
    g.gain.setValueAtTime(0.05, now + 0.85);
    g.gain.linearRampToValueAtTime(0, now + 1.0);
    const chug = ctx.createOscillator();
    chug.frequency.value = 7;
    const chugG = ctx.createGain();
    chugG.gain.value = 0.025;
    chug.connect(chugG).connect(g.gain);
    osc.connect(lp).connect(g).connect(this.mix ?? ctx.destination);
    osc.start(now);
    chug.start(now);
    osc.stop(now + 1.05);
    chug.stop(now + 1.05);
    this.flare = 0;
    window.setTimeout(() => {
      this.flare = 520;
    }, 950);
  }

  private buildRoad(ctx: Ctx): void {
    const noise = this.noise as AudioBuffer;
    const src = (offset: number) => {
      const n = ctx.createBufferSource();
      n.buffer = noise;
      n.loop = true;
      n.start(0, offset);
      return n;
    };
    const mix = this.mix as GainNode;
    // Tyre roar
    this.tyreLp = ctx.createBiquadFilter();
    this.tyreLp.type = 'lowpass';
    this.tyreLp.Q.value = 0.8;
    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0;
    src(0.2).connect(this.tyreLp).connect(this.tyreGain).connect(mix);
    // Low road rumble
    const rl = ctx.createBiquadFilter();
    rl.type = 'lowpass';
    rl.frequency.value = 85;
    rl.Q.value = 1.2;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    src(0.9).connect(rl).connect(this.rumbleGain).connect(mix);
    // Wind
    this.windBp = ctx.createBiquadFilter();
    this.windBp.type = 'bandpass';
    this.windBp.Q.value = 0.5;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src(1.4).connect(this.windBp).connect(this.windGain).connect(mix);
    // Tyre squeal
    this.squealOsc = ctx.createOscillator();
    this.squealOsc.type = 'sawtooth';
    const sqBp = ctx.createBiquadFilter();
    sqBp.type = 'bandpass';
    sqBp.frequency.value = 1100;
    sqBp.Q.value = 6;
    const vib = ctx.createOscillator();
    vib.frequency.value = 9;
    const vibG = ctx.createGain();
    vibG.gain.value = 35;
    vib.connect(vibG).connect(this.squealOsc.frequency);
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealOsc.connect(sqBp).connect(this.squealGain).connect(mix);
    this.squealOsc.start();
    vib.start();
    // Scrape
    const scBp = ctx.createBiquadFilter();
    scBp.type = 'bandpass';
    scBp.frequency.value = 1700;
    scBp.Q.value = 1.6;
    this.scrapeGain = ctx.createGain();
    this.scrapeGain.gain.value = 0;
    const scLfo = ctx.createOscillator();
    scLfo.frequency.value = 13;
    const scLfoG = ctx.createGain();
    scLfoG.gain.value = 600;
    scLfo.connect(scLfoG).connect(scBp.frequency);
    scLfo.start();
    src(2.0).connect(scBp).connect(this.scrapeGain).connect(mix);
    // Brake squeal
    this.brakeSqOsc = ctx.createOscillator();
    this.brakeSqOsc.type = 'sine';
    const bsq2 = ctx.createOscillator();
    bsq2.type = 'sine';
    bsq2.frequency.value = 6;
    const bsq2g = ctx.createGain();
    bsq2g.gain.value = 22;
    bsq2.connect(bsq2g).connect(this.brakeSqOsc.frequency);
    this.brakeSqGain = ctx.createGain();
    this.brakeSqGain.gain.value = 0;
    this.brakeSqOsc.connect(this.brakeSqGain).connect(mix);
    this.brakeSqOsc.start();
    bsq2.start();
  }

  private buildHorn(ctx: Ctx): void {
    const mix = this.mix as GainNode;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    shaper.curve = curve;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 720;
    bp.Q.value = 0.7;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 220;
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    const pre = ctx.createGain();
    pre.gain.value = 0.5;
    for (const f of [349, 440]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = Math.random() * 6 - 3;
      o.connect(pre);
      o.start();
    }
    pre.connect(shaper).connect(hp).connect(bp).connect(this.hornGain).connect(mix);
  }

  private doorBeeps(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (let i = 0; i < 3; i++) this.tone(now + i * 0.22, 0.14, { type: 'sine', freq: 2093, gain: 0.05, attack: 0.005, hold: 0.1, release: 0.03 });
  }

  private kneelHiss(down: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const len = down ? 2.0 : 2.6;
    this.noiseShot(now, len, { type: 'lowpass', freq: down ? 4200 : 3000, q: 0.5, gain: 0.07, attack: 0.05, hold: len * 0.6, release: len * 0.35 });
    this.noiseShot(now, 0.4, { type: 'highpass', freq: 3500, q: 0.5, gain: 0.07, attack: 0.005, release: 0.35 });
  }

  private clunk(gain: number, freq = 70, at?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = at ?? ctx.currentTime;
    this.tone(t0, 0.12, { type: 'sine', freq, freqEnd: freq * 0.6, gain, attack: 0.002, release: 0.1 });
    this.noiseShot(t0, 0.06, { type: 'lowpass', freq: 600, q: 0.7, gain: gain * 0.6, attack: 0.001, release: 0.05 });
  }

  private click(gain: number, freq: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.noiseShot(ctx.currentTime, 0.03, { type: 'bandpass', freq, q: 3, gain, attack: 0.001, release: 0.025 });
  }

  private thump(gain: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.tone(now, 0.1, { type: 'sine', freq: 55, freqEnd: 40, gain, attack: 0.003, release: 0.09 });
    this.tone(now + 0.11, 0.1, { type: 'sine', freq: 55, freqEnd: 40, gain: gain * 0.7, attack: 0.003, release: 0.09 });
  }

  private bonk(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.tone(now, 0.12, { type: 'triangle', freq: 440, gain: 0.05, attack: 0.005, release: 0.1 });
    this.tone(now + 0.13, 0.16, { type: 'triangle', freq: 330, gain: 0.05, attack: 0.005, release: 0.14 });
  }

  private alarm(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (let i = 0; i < 4; i++) this.tone(now + i * 0.25, 0.15, { type: 'square', freq: 880, gain: 0.025, attack: 0.005, hold: 0.12, release: 0.02 });
  }

  private tone(t0: number, dur: number, o: ToneShot): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq ?? 440, t0);
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t0 + dur);
    const g = ctx.createGain();
    this.envelope(g.gain, t0, o);
    osc.connect(g).connect(o.dest ?? (this.mix as GainNode));
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noiseShot(t0: number, dur: number, o: OneShot): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || ctx.state !== 'running') return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'bandpass';
    f.frequency.setValueAtTime(o.freq ?? 1000, t0);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t0 + dur);
    f.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    this.envelope(g.gain, t0, o);
    src.connect(f).connect(g).connect(o.dest ?? (this.mix as GainNode));
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur + 0.05);
  }

  private envelope(p: AudioParam, t0: number, o: Envelope): void {
    const a = o.attack ?? 0.01;
    const hold = o.hold ?? 0;
    p.setValueAtTime(0.0001, t0);
    p.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t0 + a);
    p.setValueAtTime(Math.max(0.0002, o.gain), t0 + a + hold);
    p.exponentialRampToValueAtTime(0.0001, t0 + a + hold + o.release);
  }
}
