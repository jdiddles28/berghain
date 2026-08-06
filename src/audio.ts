// All audio synthesized with Web Audio — no sound files.
// A 160-bar (~5 min at 128) minimal techno ARRANGEMENT phase-locked to the
// rendered sim beat, looping seamlessly: elements enter and leave in 8/16-bar
// phrases, one breakdown, fills every 16 bars, deterministic humanization
// (hash of the beat index, so the "performance" is the same every night).
//
// Ketamine layer (scales with the local player's felt level):
// - the mix muffles (lowpass walks down) and quiets slightly
// - a warbling feedback delay smears past sounds into new ones
// - at higher levels you HALLUCINATE: half-heard whispers off to one side,
//   ghost replays of sounds that happened a while ago. They aren't there.

import { CONFIG } from './config';
import type { GameEvent } from './sim/types';

export class ClubAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private comp!: DynamicsCompressorNode;
  private kFilter!: BiquadFilterNode;
  // where-you-stand acoustics, driven by src/voice/: quieter far from the
  // stack, a muffled thump through the stall wall
  private spaceGain!: GainNode;
  private spaceFilter!: BiquadFilterNode;
  private wet!: GainNode;
  private delay!: DelayNode;
  private nextBeatToSchedule = 0; // integer beat index
  private beatZeroCtxTime = 0; // ctx.currentTime at which beat 0 plays
  private anchored = false;
  private k = 0; // felt ketamine level 0..5 (local player)
  private parGain!: GainNode;
  private nextGhostAt = 0; // ctx time of the next hallucination
  private recentEvents: GameEvent['t'][] = [];

  /** Must be called from a user gesture. */
  start(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 6;
    this.comp.connect(this.ctx.destination);
    // muffle stage: everything passes through here; K walks the cutoff down
    this.kFilter = this.ctx.createBiquadFilter();
    this.kFilter.type = 'lowpass';
    this.kFilter.frequency.value = 18000;
    this.kFilter.connect(this.comp);
    // master → space (position in the club) → kFilter (K in your head) → comp
    this.spaceFilter = this.ctx.createBiquadFilter();
    this.spaceFilter.type = 'lowpass';
    this.spaceFilter.frequency.value = 20000;
    this.spaceGain = this.ctx.createGain();
    this.spaceFilter.connect(this.spaceGain).connect(this.kFilter);
    this.master = this.ctx.createGain();
    this.master.gain.value = CONFIG.music.master;
    this.master.connect(this.spaceFilter);
    // the K echo: a warbling feedback delay fed from the whole mix. dry when
    // sober; high, it smears everything you hear into things you didn't.
    this.wet = this.ctx.createGain();
    this.wet.gain.value = 0;
    this.master.connect(this.wet);
    this.delay = this.ctx.createDelay(2);
    this.delay.delayTime.value = 0.46;
    const dColor = this.ctx.createBiquadFilter();
    dColor.type = 'bandpass';
    dColor.frequency.value = 1100;
    dColor.Q.value = 0.7;
    const fb = this.ctx.createGain();
    fb.gain.value = 0.5;
    this.wet.connect(this.delay);
    this.delay.connect(dColor);
    dColor.connect(this.kFilter);
    dColor.connect(fb);
    fb.connect(this.delay);
    // slow warble on the delay time — echoes drift in pitch like bad tape
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoAmt = this.ctx.createGain();
    lfoAmt.gain.value = 0.016;
    lfo.connect(lfoAmt);
    lfoAmt.connect(this.delay.delayTime);
    lfo.start();
    // paranoia: a low throb that swells when the minions have eyes on you
    this.parGain = this.ctx.createGain();
    this.parGain.gain.value = 0;
    const par = this.ctx.createOscillator();
    par.frequency.value = 46;
    par.connect(this.parGain);
    this.parGain.connect(this.kFilter);
    par.start();
  }

  /** The shared AudioContext — the voice module builds its graph on it. */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** How the club sounds from where the player is standing: level 0..1 and a
   *  lowpass ceiling. src/voice/acoustics.ts computes it; called every frame.
   *  (The K echo + hallucinations bypass this on purpose — they're in your
   *  head, and the stall wall can't muffle those.) */
  setSpace(level: number, lowpassHz: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.spaceGain.gain.setTargetAtTime(level, now, 0.25);
    this.spaceFilter.frequency.setTargetAtTime(lowpassHz, now, 0.25);
  }

  /** Call every render frame with the interpolated sim beat, the local
   *  player's felt K level, and how watched they are. */
  update(renderBeat: number, k = 0, watched = 0): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const beatLen = 60 / CONFIG.music.bpm;
    this.k = k;

    // K sound state — smooth walks, no zipper noise
    const now = ctx.currentTime;
    this.parGain.gain.setTargetAtTime(
      watched * (0.045 + 0.04 * Math.abs(Math.sin(now * 2.7))),
      now,
      0.15,
    );
    const cutoff = Math.max(440, 18000 * Math.exp(-0.72 * k));
    this.kFilter.frequency.setTargetAtTime(cutoff, now, 0.4);
    this.wet.gain.setTargetAtTime((k / 5) * 0.55, now, 0.5);
    this.master.gain.setTargetAtTime(CONFIG.music.master * (1 - 0.16 * (k / 5)), now, 0.5);
    // hallucinations arrive from level ~2.5, more often the deeper you go
    if (k >= 2.5) {
      if (this.nextGhostAt === 0) this.nextGhostAt = now + 4;
      if (now >= this.nextGhostAt) {
        this.nextGhostAt = now + (5 + Math.random() * 9) * Math.max(0.3, (5.5 - k) / 3);
        if (Math.random() < 0.65 || this.recentEvents.length === 0) this.whisper(now + 0.05);
        else this.ghostReplay(now + 0.05);
      }
    } else {
      this.nextGhostAt = 0;
    }

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

  // ---------- the arrangement ----------

  /** deterministic 0..1 "humanizer" — same groove every loop */
  private hash(n: number): number {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return s - Math.floor(s);
  }

  private scheduleBeat(beat: number, t: number, beatLen: number): void {
    const bar = Math.floor(beat / 4) % 160; // 160 bars ≈ 5 minutes, then loop
    const bi = ((beat % 4) + 4) % 4;
    const brk = bar >= 80 && bar < 88; // the breakdown — kick out, pad in
    const strip = bar >= 128 && bar < 136; // late strip-back: no bass
    const h = (n: number) => this.hash(beat * 7 + n);

    // kick: four on the floor, out for the breakdown, softer in the intro
    if (!brk) this.kick(t, bar < 16 ? 0.8 : 1);

    // claps on 2 and 4 once the track is moving
    if (bar >= 16 && !brk && bi % 2 === 1) this.clap(t);

    // hats: offbeat closed from bar 8; ghost 16ths from 32; open hat accents
    if (bar >= 8) {
      this.hat(t + beatLen / 2, CONFIG.music.hat * (0.75 + h(1) * 0.5));
      if (bar >= 32 && !brk) {
        if (h(2) > 0.55) this.hat(t + beatLen * 0.25, CONFIG.music.hat * 0.35);
        if (h(3) > 0.72) this.hat(t + beatLen * 0.75, CONFIG.music.hat * 0.3);
      }
      if (bar >= 48 && !brk && bi === 2) this.openHat(t + beatLen / 2);
    }

    // rim ticks — the minimal-techno syncopation, deterministic pattern
    if (bar >= 24 && !brk) {
      if (bi === 1 && h(4) > 0.35) this.rim(t + beatLen * 0.75);
      if (bi === 3 && h(5) > 0.62) this.rim(t + beatLen * 0.25);
    }

    // bass: offbeat stabs, two alternating patterns, phrase-walked filter
    if (bar >= 16 && !brk && !strip) {
      const useB = (bar >= 64 && bar < 80) || (bar >= 112 && bar < 128);
      const seqA = [41.2, 41.2, 49, 36.7]; // E E G D
      const seqB = [41.2, 30.87, 55, 49]; // E B, A G — the "second idea"
      const f = (useB ? seqB : seqA)[Math.floor(beat / 4) % 4];
      const cutoff = 260 + 140 * Math.sin(Math.floor(bar / 8) * 0.9);
      this.bassNote(t + beatLen / 2, f, cutoff);
      if (useB && bi === 3) this.bassNote(t + beatLen * 0.75, f * 1.5, cutoff + 90, 0.55);
    }

    // dubby chord stab every other bar once the groove is established
    if (bar >= 48 && !brk && !strip && bar % 2 === 1 && bi === 1) {
      this.stab(t + beatLen * 0.75, Math.floor(bar / 8) % 2 === 0);
    }

    // breakdown furniture + the drop back in
    if (bi === 0) {
      if (bar === 80) this.pad(t, beatLen * 32, 0.13);
      if (bar === 84) this.riser(t, beatLen * 16);
      if (bar === 88) this.subDrop(t);
      if (bar === 144) this.pad(t, beatLen * 56, 0.06); // faint outro colour
      if (bar % 16 === 0 && !brk && bar !== 88) this.sweep(t, beatLen * 8);
    }

    // little tom fill at the end of every 16-bar phrase
    if (bar % 16 === 15) {
      this.tom(t + beatLen * 2.5, 210);
      this.tom(t + beatLen * 3, 165);
      if (h(6) > 0.4) this.tom(t + beatLen * 3.5, 125);
    }
  }

  // ---------- instruments ----------

  private kick(t: number, mult = 1): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    g.gain.setValueAtTime(CONFIG.music.kick * mult, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.26);
    // click transient
    const n = this.noiseBurst(t, 0.012, 0.5 * mult);
    n.connect(this.master);
  }

  private bassNote(t: number, f: number, cutoff = 320, mult = 1): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cutoff, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.38), t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(CONFIG.music.bass * mult, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(lp).connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.22);
  }

  // hats are BANDPASSED with the sizzle shaved off the top and a smooth
  // exponential decay — raw highpassed white noise read as "a clipping mic",
  // scratchy and grating (John). Metallic tick, not static.
  private hat(t: number, vol: number = CONFIG.music.hat): void {
    this.hatBurst(t, 0.035, vol * 0.85);
  }

  private openHat(t: number): void {
    this.hatBurst(t, 0.12, CONFIG.music.hat * 0.9);
  }

  private hatBurst(t: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-5.5 * i) / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 7600;
    bp.Q.value = 1.3;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 9800; // shave the scratchy top end
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(bp).connect(lp).connect(g).connect(this.master);
    src.start(t);
  }

  private rim(t: number): void {
    const g = this.noiseBurst(t, 0.022, 0.22, 1900);
    g.connect(this.master);
  }

  private clap(t: number): void {
    const g = this.noiseBurst(t, 0.09, CONFIG.music.clap, 1800);
    g.connect(this.master);
  }

  /** dubby minor chord through a dark filter — THE minimal techno stab */
  private stab(t: number, alt: boolean): void {
    const ctx = this.ctx!;
    const notes = alt ? [164.8, 196, 246.9] : [164.8, 220, 246.9]; // Em / Eadd
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1150, t);
    lp.frequency.exponentialRampToValueAtTime(320, t + 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    lp.connect(g).connect(this.master);
    for (const f of notes) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f * (1 + (this.hash(f + t) - 0.5) * 0.004); // faint detune
      o.connect(lp);
      o.start(t);
      o.stop(t + 0.34);
    }
  }

  /** slow swell for the breakdown — triangle fifths, very dark */
  private pad(t: number, dur: number, vol = 0.12): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 620;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g).connect(this.master);
    for (const f of [82.4, 123.5, 164.8]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.1);
    }
  }

  private riser(t: number, dur: number): void {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(i / len, 2) * 0.6;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(7500, t + dur);
    const g = ctx.createGain();
    g.gain.value = 0.16;
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
  }

  private subDrop(t: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(64, t);
    o.frequency.exponentialRampToValueAtTime(29, t + 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.85);
  }

  private tom(t: number, f: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.28, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.16);
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
    g.gain.value = 0.1;
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

  // ---------- hallucinations (they are not there) ----------

  /** a half-heard whisper off to one side: syllabic band-passed breath. turn
   *  around and there's nothing. */
  private whisper(t: number): void {
    const ctx = this.ctx!;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() < 0.5 ? -(0.6 + Math.random() * 0.35) : 0.6 + Math.random() * 0.35;
    const out = ctx.createGain();
    out.gain.value = 0.07 + 0.035 * this.k;
    out.connect(pan);
    pan.connect(this.kFilter);
    const syllables = 2 + Math.floor(Math.random() * 4);
    let st = t;
    for (let i = 0; i < syllables; i++) {
      const dur = 0.07 + Math.random() * 0.13;
      const len = Math.floor(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let j = 0; j < len; j++) {
        const env = Math.sin((j / len) * Math.PI); // syllable-shaped
        d[j] = (Math.random() * 2 - 1) * env;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 700 + Math.random() * 1800; // vowel-ish wander
      bp.Q.value = 5;
      src.connect(bp).connect(out);
      src.start(st);
      st += dur + 0.02 + Math.random() * 0.07;
    }
  }

  /** a sound you heard a while ago comes back wrong: pitched down, quiet,
   *  straight into the echo chain so it smears */
  private ghostReplay(t: number): void {
    const ev = this.recentEvents[Math.floor(Math.random() * this.recentEvents.length)];
    const ctx = this.ctx!;
    if (ev === 'dose') {
      // a sniff that nobody took
      const g = this.noiseBurst(t, 0.22, 0.18, 900);
      g.connect(this.wet);
      g.connect(this.kFilter);
    } else {
      // a low wrong-sounding thud
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(55, t);
      o.frequency.exponentialRampToValueAtTime(24, t + 0.3);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.3, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      o.connect(g);
      g.connect(this.wet);
      g.connect(this.kFilter);
      o.start(t);
      o.stop(t + 0.5);
    }
  }

  // ---------- SFX from game events ----------

  handleEvents(evs: GameEvent[]): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const ev of evs) {
      this.recentEvents.push(ev.t);
      if (this.recentEvents.length > 12) this.recentEvents.shift();
      if (ev.t === 'fall') this.thud(t, 1);
      else if (ev.t === 'impact') this.thud(t, Math.min(1, ev.mag));
      else if (ev.t === 'grab' && ev.on) this.thud(t, 0.25);
      else if (ev.t === 'pickup') this.thud(t, 0.2);
      else if (ev.t === 'throw') this.whoosh(t);
      else if (ev.t === 'dose') this.sniff(t);
      else if (ev.t === 'knock') this.knock(t, ev.loud);
      else if (ev.t === 'eject') {
        // the door hits the frame behind somebody
        this.thud(t, 1);
        this.noiseBurst(t, 0.2, 0.4, 500).connect(this.master);
        this.subDrop(t + 0.05);
      }
    }
  }

  private whoosh(t: number): void {
    const g = this.noiseBurst(t, 0.12, 0.3, 900);
    g.connect(this.master);
  }

  /** knuckles on the stall door: hollow woody raps — unmistakably a knock.
   *  The loud version is more raps, harder. */
  private knock(t: number, loud: boolean): void {
    const ctx = this.ctx!;
    const raps = loud ? 4 : 2;
    for (let i = 0; i < raps; i++) {
      const rt = t + i * 0.16;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(520, rt);
      o.frequency.exponentialRampToValueAtTime(180, rt + 0.04);
      const g = ctx.createGain();
      g.gain.setValueAtTime(loud ? 0.5 : 0.32, rt);
      g.gain.exponentialRampToValueAtTime(0.001, rt + 0.09);
      o.connect(g).connect(this.master);
      o.start(rt);
      o.stop(rt + 0.1);
      const n = this.noiseBurst(rt, 0.02, loud ? 0.3 : 0.18, 900);
      n.connect(this.master);
    }
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
