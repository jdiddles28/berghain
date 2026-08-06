// Wire protocol. Two PeerJS DataConnections per client:
//  - label "ctl"  (reliable/ordered): handshake + game events
//  - label "fast" (unreliable): input + snapshot streams, latest-wins
// Voice does NOT ride these connections: src/voice/ opens its own PeerJS
// peers (ids derived from the room code + player number) and streams media
// peer-to-peer — zero coupling to this wire format.

import type { BodySnap, GameEvent, ItemSnap, SimSnapshot } from '../sim/types';

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
// b10: shove removed, items + K, BINARY snapshots (see encodeSnapshot).
// b11: committed bump animation, right-hand carry, outline highlight, the
// 5-minute arrangement + K audio (freshness gate — no wire change).
// b12: THE NIGHT — stamina/watch/out per body, clock+phase+door in the header.
// b13: in-game proximity voice (freshness gate — no wire change, but a stale
// tab would silently have no voice peer and "Alex can't hear us").
export const PROTOCOL_VERSION = 13;

// ICE: STUN discovers a direct path between machines; TURN *relays* traffic
// when hard NATs (phone-hotspot carrier CGNAT, strict office wifi) refuse
// direct paths — that failure looks like "host sees you join, you sit at
// connecting forever".
//
// John's free metered.ca Open Relay account (20 GB relay traffic/mo).
// Verified live 2026-08-06: standard.relay.metered.ca mints relay candidates
// with these credentials. Port 80/443 + tcp/turns variants punch through
// restrictive firewalls; hotspot CGNAT pairs connect through the relay.
const TURN: RTCIceServer | null = {
  urls: [
    'turn:standard.relay.metered.ca:80',
    'turn:standard.relay.metered.ca:80?transport=tcp',
    'turn:standard.relay.metered.ca:443',
    'turns:standard.relay.metered.ca:443?transport=tcp',
  ],
  username: '87abdb26f94804b99f8686bb',
  credential: 'cyCNyyZv3mFhn4fh',
};

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

// input + tiny ping/pong ride the fast channel as JSON-ish objects; snapshots
// are raw ArrayBuffers (see below) — the receiver tells them apart by type
export type FastMsg =
  | {
      t: 'in';
      mx: number;
      mz: number;
      fy: number;
      fp: number;
      sp: 0 | 1;
      h: 0 | 1;
      g: 0 | 1;
      u: 0 | 1;
      d: 0 | 1;
    }
  | { t: 'pi'; n: number }
  | { t: 'po'; n: number };

// ---------- binary snapshots ----------
// John+Maja's first relay session was "super super laggy": BinaryPack encodes
// every JS number as 8 bytes, so the old object snapshots were ~4.5 KB × 20 Hz
// ≈ 90 KB/s — brutal through a TURN relay on a phone hotspot. Quantized i16s
// cut that ~4×. Positions in mm, quats ×32000, velocities in mm/s.
//
// Layout (little-endian):
//   u32 seq · f32 time · f32 nightT · u8 phase · i16 doorAngle(mrad) ·
//   u8 nPlayers · u8 nNpcs · u8 nItems
//   per player: u8 playerNum, body
//   per npc:    body
//   body: u8 st · u8 act · u8 k(×51) · u8 stam(×255) · u8 watch(×255) ·
//         u8 flags(bit0 out · bit1 hasGrip) ·
//         i16 pos xyz (mm) · i16 quat xyzw (×32000) · i16 vel xyz (mm/s) ·
//         [i16 grip xyz (mm) if hasGrip]
//   per item: u8 kind · u8 holderNum (255 = loose) · u8 doses ·
//             i16 pos xyz (mm) · i16 quat xyzw (×32000)

const QP = 1000; // position → mm
const QQ = 32000; // quaternion
const QV = 1000; // velocity → mm/s

export function encodeSnapshot(seq: number, snap: SimSnapshot): ArrayBuffer {
  const ids = Object.keys(snap.players);
  let size = 4 + 4 + 4 + 1 + 2 + 3;
  for (const id of ids) size += 1 + bodySize(snap.players[id]);
  for (const b of snap.npcs) size += bodySize(b);
  size += snap.items.length * 17;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint32(o, seq, true);
  o += 4;
  dv.setFloat32(o, snap.time, true);
  o += 4;
  dv.setFloat32(o, snap.nightT, true);
  o += 4;
  dv.setUint8(o++, snap.phase);
  dv.setInt16(o, clampI16(snap.doorAngle * 1000), true);
  o += 2;
  dv.setUint8(o++, ids.length);
  dv.setUint8(o++, snap.npcs.length);
  dv.setUint8(o++, snap.items.length);
  for (const id of ids) {
    dv.setUint8(o++, Number(id.slice(1)));
    o = writeBody(dv, o, snap.players[id]);
  }
  for (const b of snap.npcs) o = writeBody(dv, o, b);
  for (const it of snap.items) {
    dv.setUint8(o++, it.kind);
    dv.setUint8(o++, it.holder ? Number(it.holder.slice(1)) : 255);
    dv.setUint8(o++, it.doses);
    o = writeI16x3(dv, o, it.pos.x * QP, it.pos.y * QP, it.pos.z * QP);
    o = writeQuat(dv, o, it.rot);
  }
  return buf;
}

export function decodeSnapshot(raw: ArrayBuffer | ArrayBufferView, bpm: number): SimSnapshot {
  const dv = ArrayBuffer.isView(raw)
    ? new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    : new DataView(raw);
  let o = 0;
  const seq = dv.getUint32(o, true);
  o += 4;
  const time = dv.getFloat32(o, true);
  o += 4;
  const nightT = dv.getFloat32(o, true);
  o += 4;
  const phase = dv.getUint8(o++) as SimSnapshot['phase'];
  const doorAngle = dv.getInt16(o, true) / 1000;
  o += 2;
  const nPlayers = dv.getUint8(o++);
  const nNpcs = dv.getUint8(o++);
  const nItems = dv.getUint8(o++);
  const players: SimSnapshot['players'] = {};
  for (let i = 0; i < nPlayers; i++) {
    const num = dv.getUint8(o++);
    const [body, o2] = readBody(dv, o);
    o = o2;
    players[`p${num}`] = body;
  }
  const npcs: BodySnap[] = [];
  for (let i = 0; i < nNpcs; i++) {
    const [body, o2] = readBody(dv, o);
    o = o2;
    npcs.push(body);
  }
  const items: ItemSnap[] = [];
  for (let i = 0; i < nItems; i++) {
    const kind = dv.getUint8(o++) as ItemSnap['kind'];
    const holderNum = dv.getUint8(o++);
    const doses = dv.getUint8(o++);
    const pos = { x: dv.getInt16(o, true) / QP, y: dv.getInt16(o + 2, true) / QP, z: dv.getInt16(o + 4, true) / QP };
    o += 6;
    const rot = readQuat(dv, o);
    o += 8;
    items.push({ kind, pos, rot, holder: holderNum === 255 ? null : `p${holderNum}`, doses });
  }
  const snap: SimSnapshot = {
    time,
    beat: (time * bpm) / 60,
    nightT,
    phase,
    doorAngle,
    players,
    npcs,
    items,
  };
  return Object.assign(snap, { seq }) as SimSnapshot & { seq: number };
}

/** the seq is smuggled onto the decoded snapshot — fish it back out */
export function snapshotSeq(snap: SimSnapshot): number {
  return (snap as SimSnapshot & { seq: number }).seq;
}

function bodySize(b: BodySnap): number {
  return 26 + (b.gripPoint ? 6 : 0);
}

function writeBody(dv: DataView, o: number, b: BodySnap): number {
  dv.setUint8(o++, b.st);
  dv.setUint8(o++, b.act);
  dv.setUint8(o++, Math.max(0, Math.min(255, Math.round(b.k * 51))));
  dv.setUint8(o++, Math.max(0, Math.min(255, Math.round(b.stam * 255))));
  dv.setUint8(o++, Math.max(0, Math.min(255, Math.round(b.watch * 255))));
  dv.setUint8(o++, (b.out ? 1 : 0) | (b.gripPoint ? 2 : 0));
  o = writeI16x3(dv, o, b.pos.x * QP, b.pos.y * QP, b.pos.z * QP);
  o = writeQuat(dv, o, b.rot);
  o = writeI16x3(dv, o, b.vel.x * QV, b.vel.y * QV, b.vel.z * QV);
  if (b.gripPoint) {
    o = writeI16x3(dv, o, b.gripPoint.x * QP, b.gripPoint.y * QP, b.gripPoint.z * QP);
  }
  return o;
}

function readBody(dv: DataView, o: number): [BodySnap, number] {
  const st = dv.getUint8(o++) as BodySnap['st'];
  const act = dv.getUint8(o++) as BodySnap['act'];
  const k = dv.getUint8(o++) / 51;
  const stam = dv.getUint8(o++) / 255;
  const watch = dv.getUint8(o++) / 255;
  const flags = dv.getUint8(o++);
  const hasGrip = (flags & 2) !== 0;
  const pos = { x: dv.getInt16(o, true) / QP, y: dv.getInt16(o + 2, true) / QP, z: dv.getInt16(o + 4, true) / QP };
  o += 6;
  const rot = readQuat(dv, o);
  o += 8;
  const vel = { x: dv.getInt16(o, true) / QV, y: dv.getInt16(o + 2, true) / QV, z: dv.getInt16(o + 4, true) / QV };
  o += 6;
  let gripPoint: BodySnap['gripPoint'] = null;
  if (hasGrip) {
    gripPoint = { x: dv.getInt16(o, true) / QP, y: dv.getInt16(o + 2, true) / QP, z: dv.getInt16(o + 4, true) / QP };
    o += 6;
  }
  return [{ pos, rot, vel, st, act, k, stam, watch, out: (flags & 1) !== 0, gripPoint }, o];
}

function writeI16x3(dv: DataView, o: number, a: number, b: number, c: number): number {
  dv.setInt16(o, clampI16(a), true);
  dv.setInt16(o + 2, clampI16(b), true);
  dv.setInt16(o + 4, clampI16(c), true);
  return o + 6;
}

function writeQuat(dv: DataView, o: number, q: { x: number; y: number; z: number; w: number }): number {
  dv.setInt16(o, clampI16(q.x * QQ), true);
  dv.setInt16(o + 2, clampI16(q.y * QQ), true);
  dv.setInt16(o + 4, clampI16(q.z * QQ), true);
  dv.setInt16(o + 6, clampI16(q.w * QQ), true);
  return o + 8;
}

function readQuat(dv: DataView, o: number): { x: number; y: number; z: number; w: number } {
  return {
    x: dv.getInt16(o, true) / QQ,
    y: dv.getInt16(o + 2, true) / QQ,
    z: dv.getInt16(o + 4, true) / QQ,
    w: dv.getInt16(o + 6, true) / QQ,
  };
}

function clampI16(v: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(v)));
}

export function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}
