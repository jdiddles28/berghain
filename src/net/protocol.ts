// Wire protocol. Two PeerJS DataConnections per client:
//  - label "ctl"  (reliable/ordered): handshake + game events
//  - label "fast" (unreliable): input + snapshot streams, latest-wins
// Voice is Discord for Build 1 (per the handoff) — no voice channel here.

import type { BodySnap, GameEvent, SimSnapshot } from '../sim/types';

export const ROOM_PREFIX = 'fslop-bhn-'; // + 4-letter room code = host PeerJS id
export const SNAP_EVERY = 3; // 60/3 = 20 Hz snapshots
export const INTERP_DELAY_SNAPS = 2.5;

// Bump whenever the wire format changes. The site auto-deploys, so one player
// on a stale tab + one freshly refreshed = garbage snapshots and a black
// screen (Maja/John, 2026-08-05). The handshake catches it with a clear
// "refresh your page" instead.
// Also fine to bump when a fix simply MUST reach everyone (b4: crowd balance +
// the pointer-lock fallback; b5: walker lean + own-body clipping) — the
// handshake doubles as a build-freshness gate.
export const PROTOCOL_VERSION = 8;

// ICE: STUN discovers a direct path between machines; TURN *relays* traffic
// when hard NATs (phone-hotspot carrier CGNAT, strict office wifi) refuse
// direct paths — that failure looks like "host sees you join, you sit at
// connecting forever".
//
// Every free no-account TURN relay is DEAD (probed live 2026-08-05: openrelay,
// staticauth.openrelay, expressturn — zero relay candidates from all of them;
// they all require accounts now). When John creates the free metered.ca
// Open Relay account (20 GB/mo), paste its credentials into TURN below and
// hotspot/strict-NAT pairs will connect through the relay.
const TURN: RTCIceServer | null = null; // ← {urls: [...], username, credential}

/** testing hatch: paste relay credentials into localStorage key "bhn-turn"
 *  (same JSON shape) to try a relay on the DEPLOYED game without a redeploy */
function storedTurn(): RTCIceServer | null {
  try {
    const raw = localStorage.getItem('bhn-turn');
    return raw ? (JSON.parse(raw) as RTCIceServer) : null;
  } catch {
    return null;
  }
}

export function turnServer(): RTCIceServer | null {
  return TURN ?? storedTurn();
}

export function peerOpts(): { config: RTCConfiguration } {
  const iceServers: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  const turn = turnServer();
  if (turn) iceServers.push(turn);
  return { config: { iceServers } };
}

/** can we actually obtain a relayed path right now? (used by the join-failure
 *  doctor to tell "no relay configured/working" apart from "relay fine,
 *  something else is wrong") */
export function relayAvailable(): Promise<boolean> {
  const turn = turnServer();
  if (!turn) return Promise.resolve(false);
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers: [turn], iceTransportPolicy: 'relay' });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      pc.close();
      resolve(ok);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && e.candidate.candidate.includes('relay')) finish(true);
    };
    pc.createDataChannel('probe');
    pc.createOffer().then((o) => pc.setLocalDescription(o));
    setTimeout(() => finish(false), 6000);
  });
}

export type CtlMsg =
  | { t: 'hello'; v?: number; name?: string }
  | { t: 'init'; playerId: string; v?: number }
  | { t: 'stale' } // host is NEWER than you — refresh your page
  | { t: 'full' }
  | { t: 'ev'; evs: GameEvent[] };

// body: [x,y,z, qx,qy,qz,qw, vx,vy,vz, state, act, hasGrip, gx,gy,gz]
export type BodyWire = [
  number, number, number,
  number, number, number, number,
  number, number, number,
  number, number, number, number, number, number,
];

export type FastMsg =
  | { t: 'in'; mx: number; mz: number; fy: number; fp: number; sp: 0 | 1; h: 0 | 1; s: 0 | 1; g: 0 | 1 }
  | { t: 'snap'; seq: number; time: number; players: Record<string, BodyWire>; npcs: BodyWire[] };

export function encodeSnapshot(seq: number, snap: SimSnapshot): FastMsg {
  const players: Record<string, BodyWire> = {};
  for (const [id, b] of Object.entries(snap.players)) players[id] = enc(b);
  return {
    t: 'snap',
    seq,
    time: Math.round(snap.time * 1000) / 1000,
    players,
    npcs: snap.npcs.map(enc),
  };
}

export function decodeSnapshot(msg: Extract<FastMsg, { t: 'snap' }>, bpm: number): SimSnapshot {
  const players: SimSnapshot['players'] = {};
  for (const [id, w] of Object.entries(msg.players)) players[id] = dec(w);
  return {
    time: msg.time,
    beat: (msg.time * bpm) / 60,
    players,
    npcs: msg.npcs.map(dec),
  };
}

function enc(b: BodySnap): BodyWire {
  return [
    r3(b.pos.x), r3(b.pos.y), r3(b.pos.z),
    r3(b.rot.x), r3(b.rot.y), r3(b.rot.z), r3(b.rot.w),
    r3(b.vel.x), r3(b.vel.y), r3(b.vel.z),
    b.st, b.act,
    b.gripPoint ? 1 : 0,
    r3(b.gripPoint?.x ?? 0), r3(b.gripPoint?.y ?? 0), r3(b.gripPoint?.z ?? 0),
  ];
}

function dec(w: BodyWire): BodySnap {
  return {
    pos: { x: w[0], y: w[1], z: w[2] },
    rot: { x: w[3], y: w[4], z: w[5], w: w[6] },
    vel: { x: w[7], y: w[8], z: w[9] },
    st: w[10] as BodySnap['st'],
    act: w[11] as BodySnap['act'],
    gripPoint: w[12] === 1 ? { x: w[13], y: w[14], z: w[15] } : null,
  };
}

export function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
