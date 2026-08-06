// How each substance comes out of your friend's mouth. One SpeakerFx chain
// per incoming voice, driven every frame by that speaker's drug state from
// the snapshot (K is real today; the rest arrive with Build 2+ and are
// audible now via __voice.dose for tuning).
//
// Everything is native Web Audio nodes — no worklets, no files. The chain is
// ALWAYS inline (no bypass routing); every stage is transparent at state 0,
// so a sober voice passes through untouched and effects fade in smoothly.

import { CONFIG } from '../config';
import { clamp01 } from './acoustics';

export interface DrugState {
  /** ketamine, 0..5 (the sim's felt level) */
  k: number;
  /** the rest are 0..1 */
  coke: number;
  mdma: number;
  mcat: number;
  g: number;
  alcohol: number;
}

export const SOBER: DrugState = { k: 0, coke: 0, mdma: 0, mcat: 0, g: 0, alcohol: 0 };

const FX = CONFIG.voice.fx;

/** Classic two-tap doppler pitch shifter: two delay lines swept by looping
 *  ramp buffers, crossfaded by sin² windows (which sum to exactly 1). Slightly
 *  grainy — for drug voices the artifacts are flavor, not a bug. Transparent
 *  (constant small latency) at shift 0. */
export class PitchShifter {
  readonly input: GainNode;
  readonly output: GainNode;
  private rampGains: [GainNode, GainNode];
  private period: number;

  constructor(ctx: AudioContext, period = 0.09, baseDelay = 0.06) {
    this.period = period;
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    const n = Math.max(2, Math.round(period * ctx.sampleRate));
    const ramp = ctx.createBuffer(1, n, ctx.sampleRate);
    const win = ctx.createBuffer(1, n, ctx.sampleRate);
    const rd = ramp.getChannelData(0);
    const wd = win.getChannelData(0);
    for (let i = 0; i < n; i++) {
      rd[i] = i / n;
      const s = Math.sin((Math.PI * i) / n);
      wd[i] = s * s;
    }

    const mkTap = (offset: number): GainNode => {
      const delay = ctx.createDelay(0.5);
      delay.delayTime.value = baseDelay;
      const rampSrc = ctx.createBufferSource();
      rampSrc.buffer = ramp;
      rampSrc.loop = true;
      const rampGain = ctx.createGain();
      rampGain.gain.value = 0; // (1 - ratio) * period — 0 at shift 0
      rampSrc.connect(rampGain).connect(delay.delayTime);
      rampSrc.start(0, offset);
      const winSrc = ctx.createBufferSource();
      winSrc.buffer = win;
      winSrc.loop = true;
      const tapGain = ctx.createGain();
      tapGain.gain.value = 0; // driven entirely by the window signal
      winSrc.connect(tapGain.gain);
      winSrc.start(0, offset);
      this.input.connect(delay).connect(tapGain).connect(this.output);
      return rampGain;
    };
    this.rampGains = [mkTap(0), mkTap(period / 2)];
  }

  setShift(semitones: number, now: number): void {
    const ratio = Math.pow(2, semitones / 12);
    const depth = (1 - ratio) * this.period;
    for (const g of this.rampGains) g.gain.setTargetAtTime(depth, now, 0.1);
  }
}

export class SpeakerFx {
  readonly input: GainNode;
  readonly output: GainNode;

  // coke: the blown-open mic
  private boost: GainNode;
  private hp: BiquadFilterNode;
  private trimCoke: GainNode;
  // mcat / g: constant pitch shift
  private shifter: PitchShifter;
  private shiftDry: GainNode;
  private shiftWet: GainNode;
  // k / alcohol: the warble delay (always inline; modulation is the effect)
  private warble: DelayNode;
  private warbAmt: GainNode;
  // mdma: ensemble chorus + warm shelf
  private chorusWet: GainNode;
  private shelf: BiquadFilterNode;
  // mcat / alcohol: slapback double-talk
  private slapWet: GainNode;
  // muffle (k / alcohol / g)
  private mud: BiquadFilterNode;
  // k: the wave-of-words dropout gate
  private gate: GainNode;
  // alcohol swells + G nod-off droop
  private trimWalk: GainNode;

  // JS-driven modulator state
  private gatePhase = Math.random() * 20;
  private walkT = 0;
  private swellT = 0;
  private swellTarget = 1;
  private dipT = 4 + Math.random() * 5;
  private dipUntil = 0;

  constructor(ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    // ---- coke stage: boost → soft clip → comp → presence highpass ----
    this.boost = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(2.5 * x);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    const shaperComp = ctx.createGain();
    shaperComp.gain.value = Math.tanh(2.5) / 2.5; // undo the curve's ~2.5× small-signal slope
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 40;
    this.input.connect(this.boost).connect(shaper).connect(shaperComp).connect(this.hp);

    // ---- pitch shift (mcat up / g down), wet-dry ----
    this.shifter = new PitchShifter(ctx);
    this.shiftDry = ctx.createGain();
    this.shiftWet = ctx.createGain();
    this.shiftWet.gain.value = 0;
    const sum1 = ctx.createGain();
    this.hp.connect(this.shiftDry).connect(sum1);
    this.hp.connect(this.shifter.input);
    this.shifter.output.connect(this.shiftWet).connect(sum1);

    // ---- the warble delay ----
    this.warble = ctx.createDelay(0.25);
    this.warble.delayTime.value = 0.045;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = FX.k.warbleHz;
    this.warbAmt = ctx.createGain();
    this.warbAmt.gain.value = 0;
    lfo.connect(this.warbAmt).connect(this.warble.delayTime);
    lfo.start();
    sum1.connect(this.warble);

    // ---- chorus (parallel, adds on top) ----
    const sum2 = ctx.createGain();
    this.warble.connect(sum2);
    this.chorusWet = ctx.createGain();
    this.chorusWet.gain.value = 0;
    const chSpecs: Array<[number, number, number]> = [
      [0.013, 0.6, 0.0018],
      [0.019, 0.83, 0.0022],
    ];
    for (const [base, rate, depth] of chSpecs) {
      const d = ctx.createDelay(0.1);
      d.delayTime.value = base;
      const o = ctx.createOscillator();
      o.frequency.value = rate;
      const oa = ctx.createGain();
      oa.gain.value = depth;
      o.connect(oa).connect(d.delayTime);
      o.start();
      this.warble.connect(d).connect(this.chorusWet);
    }
    this.chorusWet.connect(sum2);

    // ---- slapback (parallel) ----
    const sum3 = ctx.createGain();
    sum2.connect(sum3);
    const slap = ctx.createDelay(0.5);
    slap.delayTime.value = 0.12;
    const slapFb = ctx.createGain();
    slapFb.gain.value = 0.32;
    this.slapWet = ctx.createGain();
    this.slapWet.gain.value = 0;
    sum2.connect(slap);
    slap.connect(slapFb).connect(slap);
    slap.connect(this.slapWet).connect(sum3);

    // ---- warmth, muffle, gate, trims ----
    this.shelf = ctx.createBiquadFilter();
    this.shelf.type = 'lowshelf';
    this.shelf.frequency.value = 250;
    this.shelf.gain.value = 0;
    this.mud = ctx.createBiquadFilter();
    this.mud.type = 'lowpass';
    this.mud.frequency.value = 19000;
    this.gate = ctx.createGain();
    this.trimCoke = ctx.createGain();
    this.trimWalk = ctx.createGain();
    sum3
      .connect(this.shelf)
      .connect(this.mud)
      .connect(this.gate)
      .connect(this.trimCoke)
      .connect(this.trimWalk)
      .connect(this.output);
  }

  update(dt: number, s: DrugState, now: number): void {
    const k01 = clamp01(s.k / 5);

    // coke — talk normally, arrive SHOUTING
    this.boost.gain.setTargetAtTime(1 + (FX.coke.boost - 1) * s.coke, now, 0.15);
    this.hp.frequency.setTargetAtTime(lerp(40, FX.coke.hp, s.coke), now, 0.15);
    this.trimCoke.gain.setTargetAtTime(1 + (FX.coke.post - 1) * s.coke, now, 0.15);

    // pitch: mcat chirps up, G sags down
    const shiftWet = clamp01(s.mcat + s.g);
    this.shiftWet.gain.setTargetAtTime(shiftWet, now, 0.2);
    this.shiftDry.gain.setTargetAtTime(1 - shiftWet, now, 0.2);
    this.shifter.setShift(FX.mcat.pitchSt * s.mcat + FX.g.pitchSt * s.g, now);

    // K warble: rhythmic pitch slur, deeper with the level
    this.warbAmt.gain.setTargetAtTime(FX.k.warbleDepth * Math.pow(k01, 1.2), now, 0.2);

    // drunk pitch: a slow RANDOM WALK — sliding, not rhythmic (that's K's)
    this.walkT -= dt;
    if (this.walkT <= 0) {
      this.walkT = 0.6 + Math.random() * 0.8;
      const depth = FX.alcohol.walkDepth * s.alcohol + 0.004 * k01;
      this.warble.delayTime.setTargetAtTime(0.045 + (Math.random() * 2 - 1) * depth, now, 0.35);
    }

    // molly warmth: chorus shimmer + low shelf — everything sounds sincere
    this.chorusWet.gain.setTargetAtTime(FX.mdma.chorus * s.mdma, now, 0.3);
    this.shelf.gain.setTargetAtTime(FX.mdma.shelfDb * s.mdma, now, 0.3);

    // double-talk slapback: heavy on mcat, a sloppy touch on alcohol
    this.slapWet.gain.setTargetAtTime(
      FX.mcat.slap * s.mcat + FX.alcohol.slap * s.alcohol,
      now,
      0.2,
    );

    // muffle: whichever substance muddies hardest wins
    const mudHz = Math.min(
      logLerp(19000, FX.k.lpAt5, k01),
      logLerp(19000, FX.alcohol.lp, s.alcohol),
      logLerp(19000, FX.g.lp, s.g),
    );
    this.mud.frequency.setTargetAtTime(mudHz, now, 0.25);

    // K dropout: slow irregular waves — whole words just don't arrive
    const gk = clamp01((s.k - FX.k.gate.from) / (5 - FX.k.gate.from));
    this.gatePhase += dt * 2 * Math.PI * FX.k.gate.rateHz;
    const wave = Math.sin(this.gatePhase) + 0.5 * Math.sin(this.gatePhase * 0.53 + 1.3);
    const thr = lerp(-1.8, 0.55, gk);
    const open = clamp01((wave - thr) / 0.5);
    this.gate.gain.setTargetAtTime(lerp(1, open, gk), now, 0.06);

    // alcohol swells (too loud, then trailing off) + the G nod-off droop
    this.swellT -= dt;
    if (this.swellT <= 0) {
      this.swellT = 1.1 + Math.random() * 1.2;
      this.swellTarget = 1 + (Math.random() * 2 - 1) * FX.alcohol.swell * s.alcohol;
    }
    let dip = 1;
    if (s.g > 0.05) {
      this.dipT -= dt;
      if (this.dipT <= 0) {
        this.dipT = 3 + Math.random() * 6;
        this.dipUntil = now + 1.2 + Math.random() * 1.3;
      }
      if (now < this.dipUntil) dip = lerp(1, FX.g.dipMin, s.g);
    }
    this.trimWalk.gain.setTargetAtTime(this.swellTarget * dip, now, 0.4);
  }
}

/** Synthesized impulse response: exponentially decaying noise; the metallic
 *  variant adds ringing modes — the inside of the stall. No sound files. */
export function makeImpulse(ctx: BaseAudioContext, seconds: number, metallic: boolean): AudioBuffer {
  const len = Math.max(2, Math.ceil(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const phase = ch * 1.7;
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.exp((-5.5 * t) / seconds);
      let v = (Math.random() * 2 - 1) * env * 0.5;
      if (metallic) {
        for (const f of [1180, 2260, 3450]) {
          v += Math.sin(2 * Math.PI * f * t + phase) * Math.exp((-9 * t) / seconds) * 0.12;
        }
      }
      d[i] = v;
    }
  }
  return buf;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function logLerp(a: number, b: number, t: number): number {
  return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * clamp01(t));
}
