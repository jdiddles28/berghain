// The club's acoustic geography, verified headless: the dancefloor drowns
// voices, the stall muffles through the wall and opens up with the door,
// distance falloff behaves, and the occlusion raycast knows a wall from air.

import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import {
  distanceAtten,
  doorOpenness,
  duckFromMusic,
  musicEnvAt,
  occlusionBetween,
  tinnyAmount,
  zoneAt,
} from '../src/voice/acoustics';

const V = CONFIG.voice;
const BX = CONFIG.bathroom;

// handy spots (room is 16×12, stage on the -z wall, stall in the -x/+z corner)
const AT_STACK = { x: 0, z: -4 }; // right at the speakers
const MID_FLOOR = { x: 0, z: 0 };
const FAR_CORNER = { x: 7, z: 5 }; // opposite the stage, outside the stall
const IN_STALL = { x: -7, z: 5 };
const BY_STALL_DOOR = { x: -6.3, z: 3.2 }; // outside, just past the door wall

describe('zones', () => {
  it('classifies the stall corner, the floor, and past-the-exit', () => {
    expect(zoneAt(IN_STALL)).toBe('stall');
    expect(zoneAt(MID_FLOOR)).toBe('club');
    expect(zoneAt(AT_STACK)).toBe('club');
    expect(zoneAt({ x: 0, z: 7 })).toBe('outside');
  });

  it('stall boundary walls are where CONFIG says they are', () => {
    expect(zoneAt({ x: BX.innerX - 0.1, z: BX.innerZ + 0.1 })).toBe('stall');
    expect(zoneAt({ x: BX.innerX + 0.1, z: BX.innerZ + 0.1 })).toBe('club');
    expect(zoneAt({ x: BX.innerX - 0.1, z: BX.innerZ - 0.1 })).toBe('club');
  });
});

describe('the music field', () => {
  it('is loudest at the stack and quieter across the room, never silent', () => {
    const stack = musicEnvAt(AT_STACK, 0).level;
    const mid = musicEnvAt(MID_FLOOR, 0).level;
    const far = musicEnvAt(FAR_CORNER, 0).level;
    expect(stack).toBe(1);
    expect(mid).toBeLessThan(stack);
    expect(far).toBeLessThan(mid);
    expect(far).toBeGreaterThanOrEqual(V.music.minLevel);
  });

  it('collapses to a muffled thump inside the stall with the door shut', () => {
    const shut = musicEnvAt(IN_STALL, 0);
    const outside = musicEnvAt(BY_STALL_DOOR, 0);
    expect(shut.level).toBeLessThan(outside.level * 0.4);
    expect(shut.lowpass).toBe(V.music.stallLpClosed);
  });

  it('door swinging open lets the club back in', () => {
    const shut = musicEnvAt(IN_STALL, 0);
    const open = musicEnvAt(IN_STALL, 1.2);
    expect(open.level).toBeGreaterThan(shut.level);
    expect(open.lowpass).toBeGreaterThan(shut.lowpass);
    expect(doorOpenness(0)).toBe(0);
    expect(doorOpenness(-1.3)).toBe(1); // swings both ways
  });
});

describe('ducking (the dancefloor is a comms dead zone)', () => {
  it('leaves quiet spots alone and drowns the stack', () => {
    expect(duckFromMusic(V.duck.start - 0.05).gain).toBe(1);
    const full = duckFromMusic(1);
    expect(full.gain).toBeCloseTo(V.duck.floor, 5);
    expect(full.lowpass).toBeCloseTo(V.duck.lpFull, 0);
  });

  it('is monotonic in between', () => {
    let prev = duckFromMusic(0.5).gain;
    for (let lvl = 0.55; lvl <= 1.0; lvl += 0.05) {
      const g = duckFromMusic(lvl).gain;
      expect(g).toBeLessThanOrEqual(prev);
      prev = g;
    }
  });
});

describe('distance falloff', () => {
  it('full inside refDist, silent past maxDist, monotonic between', () => {
    expect(distanceAtten(0.5)).toBe(1);
    expect(distanceAtten(V.refDist)).toBe(1);
    expect(distanceAtten(V.maxDist)).toBe(0);
    expect(distanceAtten(99)).toBe(0);
    let prev = 1;
    for (let d = 1; d < 16; d += 0.5) {
      const a = distanceAtten(d);
      expect(a).toBeLessThanOrEqual(prev);
      prev = a;
    }
  });

  it('a coke-extended range carries further at the same distance', () => {
    const d = 12;
    expect(distanceAtten(d, V.maxDist * V.fx.coke.rangeMult)).toBeGreaterThan(distanceAtten(d));
  });
});

describe('occlusion', () => {
  it('open floor between two dancers: nothing in the way', () => {
    const o = occlusionBetween(MID_FLOOR, AT_STACK, 0);
    expect(o.gain).toBe(1);
    expect(o.lowpass).toBe(20000);
  });

  it('stall wall muffles a voice from inside to the floor', () => {
    const o = occlusionBetween(MID_FLOOR, { x: -7.5, z: 5.5 }, 0);
    expect(o.gain).toBeLessThanOrEqual(V.occlusion.wallGain);
    expect(o.lowpass).toBeLessThanOrEqual(V.occlusion.wallLp);
  });

  it('the closed door blocks the doorway; swung open it does not', () => {
    // a line straight through the doorway gap (hinge..innerX at z=innerZ)
    const inside = { x: -6.3, z: 4.4 };
    const outside = { x: -6.3, z: 3.2 };
    const shut = occlusionBetween(outside, inside, 0);
    expect(shut.gain).toBeLessThan(1);
    const open = occlusionBetween(outside, inside, Math.PI / 2); // door swung into the stall
    expect(open.gain).toBeGreaterThan(shut.gain);
  });

  it('talking to someone who got walked out goes through the shell', () => {
    const o = occlusionBetween({ x: 0, z: 5 }, { x: 0, z: 7 }, 0);
    expect(o.gain).toBeLessThanOrEqual(V.occlusion.outGain);
  });
});

describe('the metal box', () => {
  it('voices FROM the stall ring tinny; the floor does not', () => {
    expect(tinnyAmount(IN_STALL, MID_FLOOR)).toBe(1);
    expect(tinnyAmount(MID_FLOOR, IN_STALL)).toBeGreaterThan(0);
    expect(tinnyAmount(MID_FLOOR, FAR_CORNER)).toBe(0);
  });
});
