// Plain-data types crossing the sim boundary. No three.js in here, ever.

import { CONFIG } from '../config';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface PlayerInput {
  /** camera-relative desired move direction, unit or zero, in world XZ */
  moveX: number;
  moveZ: number;
  /** world yaw the body should face (first person: where the camera looks) */
  faceYaw: number;
  /** camera pitch — grabs reach along the actual look direction */
  facePitch: number;
  sprint: boolean; // held (Shift)
  hop: boolean; // edge-triggered (latched by host)
  grab: boolean; // held (RMB) — items first, then the universal body-grab
  use: boolean; // held (LMB) — using what's in your hand (bumping the bag)
  drop: boolean; // held (Q) — tap: drop. hold: charge a throw, release to loose it
  dance: boolean; // E held — the sim TOGGLES the dance state on the press edge
}

export const ZERO_INPUT: PlayerInput = {
  moveX: 0,
  moveZ: 0,
  faceYaw: 0,
  facePitch: 0,
  sprint: false,
  hop: false,
  grab: false,
  use: false,
  drop: false,
  dance: false,
};

// 0 upright · 1 down (ragdolled) · 2 getting up
export type BodyState = 0 | 1 | 2;

export interface BodySnap {
  pos: Vec3;
  rot: Quat;
  vel: Vec3;
  st: BodyState;
  /** world point this body's hands are gripping (any solid), or null */
  gripPoint: Vec3 | null;
  /** action flag for the view: 0 none · 1 dosing (bag to face) · 2 staggered ·
   *  3 reaching (grab attempt) · 4 dancing (beat bounce) · 5 knocking on the door */
  act: 0 | 1 | 2 | 3 | 4 | 5;
  /** stamina hit empty — asleep on the floor (fetal curl, not a ragdoll flop) */
  asleep: boolean;
  /** this body is PISSED OFF (barging the stall, knocking, hunting you) —
   *  renders as angry slanted eyebrows (John: tells you who is mad at you) */
  angry: boolean;
  /** FELT ketamine level 0..5 (players only; 0 for NPCs) — drives effects */
  k: number;
  /** stamina 0..1 (players; 1 for NPCs) — THE bar */
  stam: number;
  /** how hard the Curator's minions are watching this body right now, 0..1 */
  watch: number;
  /** ejected from the club — out of the game */
  out: boolean;
}

export type ItemKind = 0; // 0 = bag of K (more later)

export interface ItemSnap {
  kind: ItemKind;
  pos: Vec3;
  rot: Quat;
  /** player id holding it, or null when loose in the world */
  holder: string | null;
  /** for the K bag: bumps left */
  doses: number;
}

export interface SimSnapshot {
  time: number;
  beat: number; // continuous beat counter (time * bpm / 60) — drives lights + audio phase
  /** seconds into the compressed Klubnacht */
  nightT: number;
  /** 0 = the night is on · 1 = closing time (survivors win) */
  phase: 0 | 1;
  /** stall door swing angle, radians (0 = closed) */
  doorAngle: number;
  players: Record<string, BodySnap>;
  npcs: BodySnap[];
  items: ItemSnap[];
}

export type GameEvent =
  | { t: 'impact'; x: number; y: number; z: number; mag: number } // hard body/world hits
  | { t: 'fall'; x: number; y: number; z: number }
  | { t: 'getup'; x: number; y: number; z: number }
  | { t: 'grab'; x: number; y: number; z: number; on: boolean }
  | { t: 'pickup'; x: number; y: number; z: number } // item into a hand (incl. steals)
  | { t: 'throw'; x: number; y: number; z: number }
  | { t: 'dose'; x: number; y: number; z: number } // sniff
  | { t: 'eject'; x: number; y: number; z: number } // someone got walked out
  // the front of the line wants IN. power 0: a polite rap · 1: LOUDER ·
  // 2: a bouncer's fist — much louder and more aggressive than any raver's
  | { t: 'knock'; x: number; y: number; z: number; power: 0 | 1 | 2 };

export interface RenderFrame {
  time: number;
  beat: number;
  nightT: number;
  phase: 0 | 1;
  doorAngle: number;
  players: Record<string, BodySnap>;
  npcs: BodySnap[];
  items: ItemSnap[];
}

/** THE bar's ceiling (b15): the night doesn't drain you faster — it shrinks
 *  what a full tank even IS. Shared by the sim (clamping) and the HUD (the
 *  bar's right edge visibly creeps in), computed from nightT so it needs no
 *  wire field. */
export function maxStamina(nightT: number): number {
  const N = CONFIG.night;
  const prog = Math.min(1, Math.max(0, nightT / N.length));
  return N.maxStart + (N.maxEnd - N.maxStart) * prog;
}

/** Peak-style pickup targeting: which item is under the look ray? Shared by
 *  the sim (actual pickup) and the client (highlight + HUD hint) so what
 *  lights up is exactly what RMB will take. Items in another player's hand
 *  can be targeted too (stealing) — at shorter range, and never while the
 *  would-be thief is already holding something. */
export function targetItemIndex(
  eye: Vec3,
  yaw: number,
  pitch: number,
  items: ItemSnap[],
  selfId: string,
  selfHolding: boolean,
): number {
  if (selfHolding) return -1;
  const cp = Math.cos(pitch);
  const dir = { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
  let best = -1;
  let bestDot: number = CONFIG.items.pickupCos;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.holder === selfId) continue;
    const range = it.holder ? CONFIG.items.stealRange : CONFIG.items.pickupRange;
    const dx = it.pos.x - eye.x;
    const dy = it.pos.y - eye.y;
    const dz = it.pos.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > range || d < 1e-4) continue;
    const dot = (dx * dir.x + dy * dir.y + dz * dir.z) / d;
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  }
  return best;
}

export function lerpSnapshot(a: SimSnapshot, b: SimSnapshot, t: number): RenderFrame {
  const players: Record<string, BodySnap> = {};
  for (const [id, pb] of Object.entries(b.players)) {
    const pa = a.players[id] ?? pb;
    players[id] = lerpBody(pa, pb, t);
  }
  const npcs: BodySnap[] = b.npcs.map((nb, i) => lerpBody(a.npcs[i] ?? nb, nb, t));
  const items: ItemSnap[] = b.items.map((ib, i) => {
    const ia = a.items[i] ?? ib;
    return {
      kind: ib.kind,
      pos: lerpV(ia.pos, ib.pos, t),
      rot: slerp(ia.rot, ib.rot, t),
      holder: ib.holder,
      doses: ib.doses,
    };
  });
  return {
    time: a.time + (b.time - a.time) * t,
    beat: a.beat + (b.beat - a.beat) * t,
    nightT: a.nightT + (b.nightT - a.nightT) * t,
    phase: b.phase,
    doorAngle: a.doorAngle + (b.doorAngle - a.doorAngle) * t,
    players,
    npcs,
    items,
  };
}

function lerpBody(a: BodySnap, b: BodySnap, t: number): BodySnap {
  return {
    pos: lerpV(a.pos, b.pos, t),
    rot: slerp(a.rot, b.rot, t),
    vel: lerpV(a.vel, b.vel, t),
    st: b.st,
    gripPoint: a.gripPoint && b.gripPoint ? lerpV(a.gripPoint, b.gripPoint, t) : b.gripPoint,
    act: b.act,
    asleep: b.asleep,
    angry: b.angry,
    k: a.k + (b.k - a.k) * t,
    stam: a.stam + (b.stam - a.stam) * t,
    watch: a.watch + (b.watch - a.watch) * t,
    out: b.out,
  };
}

function lerpV(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

// minimal quat slerp (nlerp with sign fix — fine for small inter-snapshot steps)
function slerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const s = dot < 0 ? -1 : 1;
  dot *= s;
  const x = a.x + (b.x * s - a.x) * t;
  const y = a.y + (b.y * s - a.y) * t;
  const z = a.z + (b.z * s - a.z) * t;
  const w = a.w + (b.w * s - a.w) * t;
  const len = Math.hypot(x, y, z, w) || 1;
  return { x: x / len, y: y / len, z: z / len, w: w / len };
}
