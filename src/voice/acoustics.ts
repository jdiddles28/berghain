// The club's acoustic geography, as pure math: how loud is the music where
// you stand, what solid things sit between a mouth and an ear, how far a
// voice carries. No Web Audio in here — this file runs headless in tests.
//
// Build 1 has one room + the stall, but everything routes through zoneAt()
// so the future Minecraft-exported map only has to extend the zone table
// (outdoor garden, Panorama Bar, dark rooms) — the voice pipeline on top
// doesn't change.

import { CONFIG } from '../config';

export interface Pt {
  x: number;
  z: number;
}

export type Zone = 'club' | 'stall' | 'outside';

export interface MusicEnv {
  /** 0..1 — how loud the track is at this spot */
  level: number;
  /** lowpass Hz for the track at this spot (walls muffle it) */
  lowpass: number;
}

const V = CONFIG.voice;
const BX = CONFIG.bathroom;
const ROOM = CONFIG.room;

export function zoneAt(p: Pt): Zone {
  if (p.z > ROOM.d / 2) return 'outside';
  if (p.x <= BX.innerX && p.z >= BX.innerZ) return 'stall';
  return 'club';
}

/** 0 = door shut · 1 = swung clear */
export function doorOpenness(doorAngle: number): number {
  return clamp01(Math.abs(doorAngle) / V.occlusion.doorOpenAt);
}

/** How loud + how muffled the MUSIC is at a position. Drives both what the
 *  player hears of the track and how drowned the voices are. */
export function musicEnvAt(p: Pt, doorAngle: number): MusicEnv {
  const zone = zoneAt(p);
  if (zone === 'outside') {
    return { level: V.music.outsideLevel, lowpass: V.music.outsideLp };
  }
  const d = Math.hypot(p.x - V.music.src.x, p.z - V.music.src.z);
  const open = clamp01(1 - Math.max(0, d - V.music.loudRadius) / V.music.falloff);
  const base = V.music.minLevel + (1 - V.music.minLevel) * open;
  if (zone === 'stall') {
    const o = doorOpenness(doorAngle);
    return {
      level: base * lerp(V.music.stallClosed, V.music.stallOpen, o),
      lowpass: lerp(V.music.stallLpClosed, V.music.stallLpOpen, o),
    };
  }
  return { level: base, lowpass: 20000 };
}

/** The dancefloor is a comms dead zone: how much of a voice survives the
 *  music at the LISTENER's spot, and how masked (lowpassed) the rest is. */
export function duckFromMusic(level: number): { gain: number; lowpass: number } {
  const t = Math.pow(clamp01((level - V.duck.start) / (1 - V.duck.start)), V.duck.pow);
  return {
    gain: 1 - (1 - V.duck.floor) * t,
    // exponential blend — linear Hz blends sound wrong
    lowpass: Math.exp(lerp(Math.log(20000), Math.log(V.duck.lpFull), t)),
  };
}

/** Plain distance falloff: 1 inside refDist, 0 past maxDist. */
export function distanceAtten(d: number, maxDist: number = V.maxDist): number {
  if (d <= V.refDist) return 1;
  if (d >= maxDist) return 0;
  return Math.pow(1 - (d - V.refDist) / (maxDist - V.refDist), V.rolloffPow);
}

/** What the solid world does to a voice travelling a→b: gain multiplier and
 *  a lowpass ceiling. Checks the stall walls, the stall door (scaled by how
 *  far it's swung), and the building shell. */
export function occlusionBetween(a: Pt, b: Pt, doorAngle: number): { gain: number; lowpass: number } {
  let gain = 1;
  let lowpass = 20000;

  // stall wall along x = innerX, spanning innerZ..back wall
  if (segsCross(a, b, { x: BX.innerX, z: BX.innerZ }, { x: BX.innerX, z: ROOM.d / 2 })) {
    gain *= V.occlusion.wallGain;
    lowpass = Math.min(lowpass, V.occlusion.wallLp);
  }
  // stall wall along z = innerZ, from the room wall to the door hinge
  if (segsCross(a, b, { x: -ROOM.w / 2, z: BX.innerZ }, { x: BX.doorHingeX, z: BX.innerZ })) {
    gain *= V.occlusion.wallGain;
    lowpass = Math.min(lowpass, V.occlusion.wallLp);
  }
  // the door: hinged at doorHingeX, swings off z = innerZ
  const doorTip = {
    x: BX.doorHingeX + BX.doorW * Math.cos(doorAngle),
    z: BX.innerZ + BX.doorW * Math.sin(doorAngle),
  };
  if (segsCross(a, b, { x: BX.doorHingeX, z: BX.innerZ }, doorTip)) {
    const closed = 1 - doorOpenness(doorAngle);
    gain *= lerp(1, V.occlusion.doorGain, closed);
    lowpass = Math.min(lowpass, lerp(20000, V.occlusion.doorLp, closed));
  }
  // the building shell (future map: talking to someone who got ejected)
  const za = zoneAt(a);
  const zb = zoneAt(b);
  if ((za === 'outside') !== (zb === 'outside')) {
    gain *= V.occlusion.outGain;
    lowpass = Math.min(lowpass, V.occlusion.outLp);
  }
  return { gain, lowpass };
}

/** The metal box: how tinny this voice should ring. Full strength when the
 *  SPEAKER is in the stall; a listener inside hears everyone slightly boxed. */
export function tinnyAmount(speaker: Pt, listener: Pt): number {
  if (zoneAt(speaker) === 'stall') return 1;
  if (zoneAt(listener) === 'stall') return 0.6;
  return 0;
}

// ---------- small math ----------

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 2D segment intersection (proper crossings; touching endpoints count). */
function segsCross(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0);
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
}
