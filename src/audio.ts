// All audio synthesized with Web Audio — no sound files.
// A four-on-the-floor techno loop phase-locked to the RENDERED sim beat
// (so the crowd you see bouncing is bouncing on the kick you hear),
// plus one-shot SFX for shoves/impacts/falls.

import { CONFIG } from './config';
import type { GameEvent } from './sim/types';

export class ClubAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private comp!: DynamicsCompressorNode;
  private nextBeatToSchedule = 0; // integer beat index
  private beatZeroCtxTime = 0; // ctx.currentTime at which beat 0 plays
  private anchored = false;

  /** Must be called from a user gesture. */
  start(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 6;
    this.master = this.ctx.createGain();
    this.master.gain.value = CONFIG.music.master;
    this.master.connect(this.comp).connect(this.ctx.destination);
  }

  /** Call every render frame with the interpolated sim beat (frame.beat). */
  update(renderBeat: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const beatLen = 60 / CONFIG.music.bpm;

    if (!this.anchored) {
      // map render-beat → ctx time once, then re-anchor slowly if drift grows
      this.beatZeroCtxTime = ctx.currentTime - renderBeat * beatLen;
      this.nextBeatToSchedule = Math.ceil(renderBeat + 0.05);
      this.anchored = true;
    } else {
      const expected = ctx.currentTime - renderBeat * beatLen;
      const drift = expected - this.beatZeroCtxTime;
      if (Math.abs(drift) > 0.09) this.beatZeroCtxTime += drift * 0.1; // gentle re-anchor
    }

    // schedule everything up to ~0.35 s ahead
    const horizon = ctx.currentTime + 0.35;
    while (this.beatZeroCtxTime + this.nextBeatToSchedule * beatLen < horizon) {
      const b = this.nextBeatToSchedule;
      const t = this.beatZeroCtxTime + b * beatLen;
      if (t > ctx.currentTime - 0.05) this.scheduleBeat(b, t, beatLen);
      this.nextBeatToSchedule++;
    }
  }

  private scheduleBeat(beat: number, t: number, beatLen: number): void {
    this.kick(t);
    this.bassNote(t + beatLen / 2, beat); // offbeat bass
    this.hat(t + beatLen / 2);
    if (beat % 2 === 1) this.clap(t);
    if (beat % 16 === 0) this.sweep(t, beatLen * 8);
  }

  // ---------- instruments ----------

  private kick(t: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    g.gain.setValueAtTime(CONFIG.music.kick, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.26);
    // click transient
    const n = this.noiseBurst(t, 0.012, 0.5);
    n.connect(this.master);
  }

  private bassNote(t: number, beat: number): void {
    const ctx = this.ctx!;
    const seq = [41.2, 41.2, 49, 36.7]; // E1 E1 G1 D1 — dark and simple
    const f = seq[Math.floor(beat / 4) % seq.length];
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(320, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(CONFIG.music.bass, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(lp).connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.22);
  }

  private hat(t: number): void {
    const g = this.noiseBurst(t, 0.03, CONFIG.music.hat, 7000);
    g.connect(this.master);
  }

  private clap(t: number): void {
    const g = this.noiseBurst(t, 0.09, CONFIG.music.clap, 1800);
    g.connect(this.master);
  }

  private sweep(t: number, dur: number): void {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (i / len) * 0.5;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(200, t);
    bp.frequency.exponentialRampToValueAtTime(6000, t + dur);
    const g = ctx.createGain();
    g.gain.value = 0.12;
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
  }

  private noiseBurst(t: number, dur: number, vol: number, hp = 3000): GainNode {
    const ctx = this.ctx!;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g);
    src.start(t);
    return g;
  }

  // ---------- SFX from game events ----------

  handleEvents(evs: GameEvent[]): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const ev of evs) {
      if (ev.t === 'fall') this.thud(t, 1);
      else if (ev.t === 'impact') this.thud(t, Math.min(1, ev.mag));
      else if (ev.t === 'grab' && ev.on) this.thud(t, 0.25);
      else if (ev.t === 'pickup') this.thud(t, 0.2);
      else if (ev.t === 'throw') this.whoosh(t);
      else if (ev.t === 'dose') this.sniff(t);
    }
  }

  private whoosh(t: number): void {
    const g = this.noiseBurst(t, 0.12, 0.3, 900);
    g.connect(this.master);
  }

  /** two quick high noise pulls — unmistakably a sniff */
  private sniff(t: number): void {
    this.noiseBurst(t, 0.09, 0.35, 1600).connect(this.master);
    this.noiseBurst(t + 0.14, 0.12, 0.3, 1400).connect(this.master);
  }

  private thud(t: number, mag: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * mag, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.15);
  }
}
