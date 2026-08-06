// In-game proximity voice. Lethal Company is the polish bar: friends fade
// with distance, the dancefloor drowns them, the stall muffles them through
// the wall and rings tinny from inside, and whatever they're on comes out of
// their mouth (see fx.ts).
//
// Topology: every player opens a SECOND PeerJS peer whose id is derived from
// the room code + their player number, so the voice mesh needs no roster
// messages and no game-protocol changes — who's in the room is read straight
// off the snapshot every frame, and the lower player number calls the higher.
// Everyone streams their RAW mic; each receiver spatializes + drug-warps
// every incoming voice locally from snapshot state (positions, K level).

import { Peer, type MediaConnection } from 'peerjs';
import { CONFIG } from '../config';
import { peerOpts, ROOM_PREFIX } from '../net/protocol';
import type { RenderFrame } from '../sim/types';
import type { ClubAudio } from '../audio';
import {
  clamp01,
  distanceAtten,
  duckFromMusic,
  musicEnvAt,
  occlusionBetween,
  tinnyAmount,
} from './acoustics';
import { makeImpulse, SOBER, SpeakerFx, type DrugState } from './fx';

const V = CONFIG.voice;

function voicePeerId(code: string, pid: string): string {
  return `${ROOM_PREFIX}${code}-vc-${pid}`;
}

function pidFromVoicePeer(peerId: string): string | null {
  const i = peerId.lastIndexOf('-vc-');
  return i >= 0 ? peerId.slice(i + 4) : null;
}

/** One incoming voice: drug FX → occlusion/masking lowpass → tinny split →
 *  distance → duck → HRTF panner, plus sends into the shared reverbs. */
class SpeakerPipe {
  readonly fx: SpeakerFx;
  private pathLp: BiquadFilterNode;
  private dryG: GainNode;
  private tinnyG: GainNode;
  private distGain: GainNode;
  private duckGain: GainNode;
  private panner: PannerNode;
  private clubSend: GainNode;
  private stallSend: GainNode;

  constructor(ctx: AudioContext, bus: GainNode, clubVerb: ConvolverNode, stallVerb: ConvolverNode) {
    this.fx = new SpeakerFx(ctx);
    this.pathLp = ctx.createBiquadFilter();
    this.pathLp.type = 'lowpass';
    this.pathLp.frequency.value = 20000;
    this.dryG = ctx.createGain();
    const tinnyBp = ctx.createBiquadFilter();
    tinnyBp.type = 'bandpass';
    tinnyBp.frequency.value = V.tinny.bp;
    tinnyBp.Q.value = V.tinny.q;
    this.tinnyG = ctx.createGain();
    this.tinnyG.gain.value = 0;
    this.distGain = ctx.createGain();
    this.duckGain = ctx.createGain();
    this.panner = ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'linear';
    this.panner.rolloffFactor = 0; // distance is OURS — the panner only aims
    this.clubSend = ctx.createGain();
    this.stallSend = ctx.createGain();
    this.stallSend.gain.value = 0;

    this.fx.output.connect(this.pathLp);
    this.pathLp.connect(this.dryG).connect(this.distGain);
    this.pathLp.connect(tinnyBp).connect(this.tinnyG).connect(this.distGain);
    this.distGain.connect(this.duckGain).connect(this.panner).connect(bus);
    this.duckGain.connect(this.clubSend).connect(clubVerb);
    this.duckGain.connect(this.stallSend).connect(stallVerb);
  }

  update(
    dt: number,
    now: number,
    sp: { x: number; y: number; z: number },
    drugs: DrugState,
    eye: { x: number; y: number; z: number },
    doorAngle: number,
    duck: { gain: number; lowpass: number },
  ): void {
    this.fx.update(dt, drugs, now);
    const mouth = { x: sp.x, y: sp.y + 0.45, z: sp.z };
    const d = Math.hypot(mouth.x - eye.x, mouth.y - eye.y, mouth.z - eye.z);

    // coke carries; molly is in your ear no matter how far
    const effMax = V.maxDist * (1 + (V.fx.coke.rangeMult - 1) * drugs.coke);
    let att = distanceAtten(d, effMax);
    att = Math.max(att, V.fx.mdma.floor * drugs.mdma);

    const occl = occlusionBetween({ x: eye.x, z: eye.z }, { x: sp.x, z: sp.z }, doorAngle);
    const tin = tinnyAmount({ x: sp.x, z: sp.z }, { x: eye.x, z: eye.z });

    this.distGain.gain.setTargetAtTime(att * occl.gain, now, 0.08);
    this.pathLp.frequency.setTargetAtTime(Math.min(occl.lowpass, duck.lowpass), now, 0.12);
    this.duckGain.gain.setTargetAtTime(duck.gain, now, 0.12);
    this.dryG.gain.setTargetAtTime(1 - tin * V.tinny.mix, now, 0.1);
    this.tinnyG.gain.setTargetAtTime(tin * V.tinny.mix, now, 0.1);
    this.clubSend.gain.setTargetAtTime(
      (V.reverb.clubBase + V.reverb.clubDistExtra * clamp01(d / V.maxDist)) *
        (1 + V.fx.mdma.verbExtra * drugs.mdma) *
        (1 - tin * 0.7),
      now,
      0.15,
    );
    this.stallSend.gain.setTargetAtTime(tin * V.tinny.verb, now, 0.1);
    setParam(this.panner.positionX, mouth.x, now);
    setParam(this.panner.positionY, mouth.y, now);
    setParam(this.panner.positionZ, mouth.z, now);
  }

  connectSource(node: AudioNode): void {
    node.connect(this.fx.input);
  }
}

interface Link {
  call: MediaConnection | null;
  pipe: SpeakerPipe | null;
  el: HTMLAudioElement | null; // Chrome quirk: remote tracks are silent in
  src: MediaStreamAudioSourceNode | null; // WebAudio without a muted <audio>
  retryAt: number;
  deadline: number; // call placed but no stream by then → tear down, retry
}

type MicState = 'pending' | 'live' | 'denied' | 'unsupported';

export class VoiceChat {
  private club: ClubAudio;
  private code = '';
  private localId = '';
  private peer: Peer | null = null;
  private peerReady = false;
  private peerRetries = 0;
  private mic: MediaStream | null = null;
  private micState: MicState = 'pending';
  private micRequested = false;
  private silent: MediaStream | null = null;
  private muted = false;
  private links = new Map<string, Link>();
  private failed = '';

  // audio graph (lazy — needs the ClubAudio ctx, which exists after start())
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private listenerLp: BiquadFilterNode | null = null;
  private clubVerb: ConvolverNode | null = null;
  private stallVerb: ConvolverNode | null = null;

  // solo-testing loopback: your own mic, delayed, from a phantom position
  private loopPipe: SpeakerPipe | null = null;
  private loopPos: { x: number; y: number; z: number } | null = null;

  /** local drug overrides for tuning: __voice.dose('p1'|'loop', 'coke', 1) */
  private overrides = new Map<string, Partial<DrugState>>();

  constructor(club: ClubAudio) {
    this.club = club;
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyV' && !e.repeat) this.setMuted(!this.muted);
    });
    this.installDebug();
  }

  /** Idempotent: call every frame; starts once room code + player id exist. */
  setIdentity(code: string, localId: string): void {
    if (this.peer || !code || !localId || localId === '?') return;
    this.code = code.toUpperCase();
    this.localId = localId;
    this.openPeer();
    this.requestMic();
    console.info(
      '[voice] up. debug: __voice.loopback() hear yourself from where you stand · ' +
        "__voice.dose('p1','coke',1) coke|k|mdma|mcat|g|alcohol · __voice.clear()",
    );
  }

  private ensureGraph(): boolean {
    if (this.ctx) return true;
    const ctx = this.club.context;
    if (!ctx) return false;
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.listenerLp = ctx.createBiquadFilter();
    this.listenerLp.type = 'lowpass';
    this.listenerLp.frequency.value = 19000;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 8;
    this.clubVerb = ctx.createConvolver();
    this.clubVerb.buffer = makeImpulse(ctx, V.reverb.clubSec, false);
    this.stallVerb = ctx.createConvolver();
    this.stallVerb.buffer = makeImpulse(ctx, V.reverb.stallSec, true);
    this.clubVerb.connect(this.bus);
    this.stallVerb.connect(this.bus);
    this.bus.connect(this.listenerLp).connect(comp).connect(ctx.destination);
    return true;
  }

  private openPeer(): void {
    const peer = new Peer(voicePeerId(this.code, this.localId), peerOpts());
    this.peer = peer;
    peer.on('open', () => {
      this.peerReady = true;
    });
    peer.on('disconnected', () => {
      // lost the signaling server — reconnect keeps existing calls alive
      try {
        peer.reconnect();
      } catch {
        /* destroyed */
      }
    });
    peer.on('error', (err: Error & { type?: string }) => {
      if (err.type === 'unavailable-id' && this.peerRetries < 3) {
        // a stale tab from a previous session can squat the id briefly
        this.peerRetries++;
        this.peerReady = false;
        peer.destroy();
        this.peer = null;
        setTimeout(() => {
          if (!this.peer) this.openPeer();
        }, 2500);
      } else if (err.type === 'peer-unavailable') {
        // callee not up yet — the retry loop covers it
      } else if (!this.peerReady) {
        this.failed = `voice network error (${err.type ?? 'unknown'})`;
        console.warn('[voice] peer error:', err.type, err.message);
      }
    });
    peer.on('call', (call) => {
      const pid = pidFromVoicePeer(call.peer);
      if (!pid || !call.peer.startsWith(ROOM_PREFIX + this.code)) {
        call.close();
        return;
      }
      call.answer(this.outStream() ?? undefined);
      this.adopt(pid, call);
    });
  }

  private requestMic(): void {
    if (this.micRequested) return;
    this.micRequested = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.micState = 'unsupported';
      return;
    }
    navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      .then((stream) => {
        this.mic = stream;
        this.micState = 'live';
        stream.getAudioTracks()[0]?.addEventListener('ended', () => {
          this.micState = 'denied'; // device yanked / permission revoked
          this.mic = null;
        });
        if (this.muted) this.applyMute();
        // calls placed before the mic resolved went out silent — redo them
        // so friends actually hear us
        for (const [pid, link] of this.links) {
          if (link.call) {
            link.call.close();
            this.clearLink(pid, 0);
          }
        }
      })
      .catch((err) => {
        this.micState = 'denied';
        console.warn('[voice] mic denied:', err);
      });
  }

  /** What we transmit: the mic, or a silent stream so calls still connect
   *  receive-only while the mic is blocked. */
  private outStream(): MediaStream | null {
    if (this.mic) return this.mic;
    if (!this.ctx) return null;
    if (!this.silent) this.silent = this.ctx.createMediaStreamDestination().stream;
    return this.silent;
  }

  private setMuted(m: boolean): void {
    this.muted = m;
    this.applyMute();
  }

  private applyMute(): void {
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !this.muted;
  }

  // ---------- the mesh ----------

  private adopt(pid: string, call: MediaConnection): void {
    const old = this.links.get(pid);
    if (old?.call && old.call !== call) old.call.close();
    const link: Link = {
      call,
      pipe: old?.pipe ?? null,
      el: old?.el ?? null,
      src: old?.src ?? null,
      retryAt: 0,
      deadline: performance.now() + 8000,
    };
    this.links.set(pid, link);
    call.on('stream', (stream) => {
      link.deadline = Infinity;
      this.attachStream(link, stream);
    });
    const drop = () => {
      if (this.links.get(pid) === link) this.clearLink(pid, 4000);
    };
    call.on('close', drop);
    call.on('error', drop);
  }

  private attachStream(link: Link, stream: MediaStream): void {
    if (!this.ensureGraph()) return;
    const ctx = this.ctx!;
    // Chrome: a remote WebRTC track produces silence in WebAudio unless it's
    // also sunk into a media element — mute the element, keep the graph
    link.el?.remove();
    const el = new Audio();
    el.srcObject = stream;
    el.muted = true;
    void el.play().catch(() => {});
    link.el = el;
    link.src?.disconnect();
    link.src = ctx.createMediaStreamSource(stream);
    if (!link.pipe) {
      link.pipe = new SpeakerPipe(ctx, this.bus!, this.clubVerb!, this.stallVerb!);
    }
    link.pipe.connectSource(link.src);
  }

  private clearLink(pid: string, retryInMs: number): void {
    const link = this.links.get(pid);
    if (!link) return;
    link.el?.remove();
    link.src?.disconnect();
    link.call = null;
    link.el = null;
    link.src = null;
    link.retryAt = performance.now() + retryInMs;
    link.deadline = Infinity;
  }

  private placeCall(pid: string): void {
    if (!this.peer || !this.peerReady) return;
    const out = this.outStream();
    if (!out) return;
    const call = this.peer.call(voicePeerId(this.code, pid), out);
    if (call) this.adopt(pid, call);
  }

  // ---------- per-frame ----------

  update(dt: number, frame: RenderFrame, camYaw: number, camPitch: number, localId: string): void {
    if (!this.ensureGraph()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const me = frame.players[localId];
    if (!me) return;
    const eye = { x: me.pos.x, y: me.pos.y + CONFIG.camera.eyeHeight, z: me.pos.z };

    // the listener: where your head is, where it points
    const fy = camYaw + Math.PI; // camera-orbit yaw → facing yaw (input.ts)
    const cp = Math.cos(camPitch);
    const fwd = { x: Math.sin(fy) * cp, y: Math.sin(camPitch), z: Math.cos(fy) * cp };
    const L = ctx.listener;
    if ('positionX' in L && L.positionX) {
      setParam(L.positionX, eye.x, now);
      setParam(L.positionY, eye.y, now);
      setParam(L.positionZ, eye.z, now);
      setParam(L.forwardX, fwd.x, now);
      setParam(L.forwardY, fwd.y, now);
      setParam(L.forwardZ, fwd.z, now);
      setParam(L.upX, 0, now);
      setParam(L.upY, 1, now);
      setParam(L.upZ, 0, now);
    } else {
      L.setPosition(eye.x, eye.y, eye.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }

    // the room around your ears: music level here, muffle here, duck here.
    // This also drives the MUSIC — step into the stall and shut the door and
    // the track collapses to a thump through the wall.
    const env = musicEnvAt({ x: eye.x, z: eye.z }, frame.doorAngle);
    this.club.setSpace(env.level, env.lowpass);
    const duck = duckFromMusic(env.level);

    // your own K muffles everything you hear, friends included
    this.listenerLp!.frequency.setTargetAtTime(19000 * Math.exp(-0.55 * me.k), now, 0.4);

    // mesh upkeep: roster comes straight off the snapshot
    const myNum = Number(localId.slice(1));
    const pnow = performance.now();
    for (const pid of Object.keys(frame.players)) {
      if (pid === localId) continue;
      const link = this.links.get(pid);
      if (link?.call && pnow > link.deadline) this.clearLink(pid, 0); // rang out
      const fresh = this.links.get(pid);
      if (Number(pid.slice(1)) > myNum && !fresh?.call && pnow >= (fresh?.retryAt ?? 0)) {
        this.placeCall(pid);
      }
    }

    // spatialize every connected voice from its snapshot state
    for (const [pid, link] of this.links) {
      const snap = frame.players[pid];
      if (!link.pipe) continue;
      if (!snap) {
        // player left the game — silence them until the call dies
        link.pipe.update(dt, now, { x: 0, y: -50, z: 0 }, SOBER, eye, frame.doorAngle, duck);
        continue;
      }
      link.pipe.update(
        dt,
        now,
        snap.pos,
        this.drugsFor(pid, snap.k),
        eye,
        frame.doorAngle,
        duck,
      );
    }

    // loopback phantom
    if (this.loopPipe && this.loopPos) {
      this.loopPipe.update(
        dt,
        now,
        this.loopPos,
        this.drugsFor('loop', this.overrides.get('loop')?.k ?? 0),
        eye,
        frame.doorAngle,
        duck,
      );
    }
  }

  private drugsFor(pid: string, k: number): DrugState {
    const o = this.overrides.get(pid);
    return o ? { ...SOBER, k, ...o } : { ...SOBER, k };
  }

  status(): string {
    if (this.failed) return this.failed;
    if (!this.peer) return '';
    let n = 0;
    for (const l of this.links.values()) if (l.call && l.src) n++;
    const parts = [`voice: ${n} connected`];
    if (this.micState === 'denied') {
      return 'voice: MIC BLOCKED — click the camera/lock icon by the address bar,\nallow the microphone, then refresh';
    }
    if (this.micState === 'unsupported') return 'voice: no mic on this browser';
    if (this.micState === 'pending') parts.push('mic…');
    if (this.muted) parts.push('MUTED');
    parts.push(this.muted ? 'V to unmute' : 'V to mute');
    if (this.loopPipe) parts.push('LOOPBACK');
    return parts.join(' · ');
  }

  // ---------- debug / tuning ----------

  private installDebug(): void {
    const api = {
      /** hear your own mic, delayed 1.4 s, from wherever you're standing when
       *  you flip it on — walk away and listen to the falloff. Headphones on. */
      loopback: (on = true): string => {
        if (!on) {
          this.loopPipe = null;
          this.loopPos = null;
          return 'loopback off';
        }
        if (!this.ensureGraph() || !this.mic) return 'no mic / audio yet';
        const ctx = this.ctx!;
        const src = ctx.createMediaStreamSource(this.mic);
        const delay = ctx.createDelay(3);
        delay.delayTime.value = 1.4;
        this.loopPipe = new SpeakerPipe(ctx, this.bus!, this.clubVerb!, this.stallVerb!);
        src.connect(delay);
        this.loopPipe.connectSource(delay);
        this.loopPos = { x: 0, y: 1, z: 0 };
        return "loopback ON from mid-floor — __voice.dose('loop','k',4) to hear the drugs";
      },
      /** locally warp how PID sounds to YOU: dose('p1','coke',1). k is 0..5,
       *  the rest 0..1. 'loop' doses the loopback phantom. */
      dose: (pid: string, drug: keyof DrugState, amount: number): string => {
        const o = this.overrides.get(pid) ?? {};
        o[drug] = amount;
        this.overrides.set(pid, o);
        return `${pid} ${drug}=${amount}`;
      },
      clear: (): string => {
        this.overrides.clear();
        return 'all overrides cleared';
      },
      state: () => ({
        code: this.code,
        me: this.localId,
        mic: this.micState,
        muted: this.muted,
        links: [...this.links.entries()].map(([pid, l]) => ({
          pid,
          call: !!l.call,
          audio: !!l.src,
        })),
      }),
    };
    (window as unknown as { __voice: typeof api }).__voice = api;
  }

  destroy(): void {
    this.peer?.destroy();
    for (const pid of this.links.keys()) this.clearLink(pid, Infinity);
    for (const t of this.mic?.getTracks() ?? []) t.stop();
  }
}

/** setTargetAtTime with a short lag — positions and gains glide, never zipper */
function setParam(p: AudioParam, v: number, now: number): void {
  p.setTargetAtTime(v, now, 0.05);
}
