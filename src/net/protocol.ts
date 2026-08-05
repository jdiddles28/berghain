// Wire protocol. Two PeerJS DataConnections per client:
//  - label "ctl"  (reliable/ordered): handshake + game events
//  - label "fast" (unreliable): input + snapshot streams, latest-wins
// Voice is Discord for Build 1 (per the handoff) — no voice channel here.

import type { BodySnap, GameEvent, SimSnapshot } from '../sim/types';

export const ROOM_PREFIX = 'fslop-bhn-'; // + 4-letter room code = host PeerJS id
export const SNAP_EVERY = 3; // 60/3 = 20 Hz snapshots
export const INTERP_DELAY_SNAPS = 2.5;

export type CtlMsg =
  | { t: 'hello'; name?: string }
  | { t: 'init'; playerId: string }
  | { t: 'full' }
  | { t: 'ev'; evs: GameEvent[] };

// body: [x,y,z, qx,qy,qz,qw, vx,vy,vz, state, grip]
export type BodyWire = [
  number, number, number,
  number, number, number, number,
  number, number, number,
  number, number,
];

export type FastMsg =
  | { t: 'in'; mx: number; mz: number; h: 0 | 1; s: 0 | 1; g: 0 | 1 }
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
    b.st, b.grip,
  ];
}

function dec(w: BodyWire): BodySnap {
  return {
    pos: { x: w[0], y: w[1], z: w[2] },
    rot: { x: w[3], y: w[4], z: w[5], w: w[6] },
    vel: { x: w[7], y: w[8], z: w[9] },
    st: w[10] as BodySnap['st'],
    grip: w[11],
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
