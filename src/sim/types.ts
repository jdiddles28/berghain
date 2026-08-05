// Plain-data types crossing the sim boundary. No three.js in here, ever.

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
  hop: boolean; // edge-triggered (latched by host)
  shove: boolean; // edge-triggered
  grab: boolean; // held
}

export const ZERO_INPUT: PlayerInput = { moveX: 0, moveZ: 0, hop: false, shove: false, grab: false };

// 0 upright · 1 down (ragdolled) · 2 getting up
export type BodyState = 0 | 1 | 2;

export interface BodySnap {
  pos: Vec3;
  rot: Quat;
  vel: Vec3;
  st: BodyState;
  /** who this body is gripping: player index 0..2, or 100+npcIndex, or -1 */
  grip: number;
}

export interface SimSnapshot {
  time: number;
  beat: number; // continuous beat counter (time * bpm / 60) — drives lights + audio phase
  players: Record<string, BodySnap>;
  npcs: BodySnap[];
}

export type GameEvent =
  | { t: 'shove'; x: number; y: number; z: number; hit: boolean }
  | { t: 'impact'; x: number; y: number; z: number; mag: number } // hard body/world hits
  | { t: 'fall'; x: number; y: number; z: number }
  | { t: 'getup'; x: number; y: number; z: number }
  | { t: 'grab'; x: number; y: number; z: number; on: boolean };

export interface RenderFrame {
  time: number;
  beat: number;
  players: Record<string, BodySnap>;
  npcs: BodySnap[];
}

export function lerpSnapshot(a: SimSnapshot, b: SimSnapshot, t: number): RenderFrame {
  const players: Record<string, BodySnap> = {};
  for (const [id, pb] of Object.entries(b.players)) {
    const pa = a.players[id] ?? pb;
    players[id] = lerpBody(pa, pb, t);
  }
  const npcs: BodySnap[] = b.npcs.map((nb, i) => lerpBody(a.npcs[i] ?? nb, nb, t));
  return {
    time: a.time + (b.time - a.time) * t,
    beat: a.beat + (b.beat - a.beat) * t,
    players,
    npcs,
  };
}

function lerpBody(a: BodySnap, b: BodySnap, t: number): BodySnap {
  return {
    pos: lerpV(a.pos, b.pos, t),
    rot: slerp(a.rot, b.rot, t),
    vel: lerpV(a.vel, b.vel, t),
    st: b.st,
    grip: b.grip,
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
