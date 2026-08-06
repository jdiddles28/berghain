// Binary snapshot codec roundtrip — one bad byte offset here is a black
// screen and a "multiplayer is broken" playtest, so the whole layout gets
// exercised: players with/without grips, NPCs, held and loose items.

import { describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot, snapshotSeq } from '../src/net/protocol';
import type { BodySnap, SimSnapshot } from '../src/sim/types';

function body(n: number, grip: boolean): BodySnap {
  return {
    pos: { x: -7.5 + n, y: 0.83 + n * 0.01, z: 5.9 - n },
    rot: { x: 0.1, y: -0.2, z: 0.05, w: 0.973 },
    vel: { x: 1.234, y: -0.5, z: 3.1 },
    st: (n % 3) as BodySnap['st'],
    act: ((n + 1) % 4) as BodySnap['act'],
    k: n === 0 ? 3.7 : 0,
    gripPoint: grip ? { x: 1.111, y: 2.222, z: -3.333 } : null,
  };
}

describe('binary snapshot codec', () => {
  it('roundtrips players, npcs, and items within quantization error', () => {
    const snap: SimSnapshot = {
      time: 123.456,
      beat: 0,
      players: { p0: body(0, true), p2: body(2, false) },
      npcs: [body(1, false), body(3, true), body(4, false)],
      items: [
        {
          kind: 0,
          pos: { x: -0.3, y: 1.325, z: -4.13 },
          rot: { x: 0, y: 0.707, z: 0, w: 0.707 },
          holder: 'p2',
          doses: 17,
        },
        {
          kind: 0,
          pos: { x: 2, y: 0.05, z: 3 },
          rot: { x: 0, y: 0, z: 0, w: 1 },
          holder: null,
          doses: 0,
        },
      ],
    };
    const buf = encodeSnapshot(4242, snap);
    const out = decodeSnapshot(buf, 128);
    expect(snapshotSeq(out)).toBe(4242);
    expect(out.time).toBeCloseTo(123.456, 2);
    expect(out.beat).toBeCloseTo((out.time * 128) / 60, 5);
    expect(Object.keys(out.players).sort()).toEqual(['p0', 'p2']);
    expect(out.npcs.length).toBe(3);
    expect(out.items.length).toBe(2);

    const p0 = out.players['p0'];
    expect(p0.pos.x).toBeCloseTo(-7.5, 2);
    expect(p0.vel.z).toBeCloseTo(3.1, 2);
    expect(p0.rot.w).toBeCloseTo(0.973, 3);
    expect(p0.st).toBe(0);
    expect(p0.act).toBe(1);
    expect(p0.k).toBeCloseTo(3.7, 1);
    expect(p0.gripPoint!.y).toBeCloseTo(2.222, 2);
    expect(out.players['p2'].gripPoint).toBeNull();
    expect(out.players['p2'].k).toBe(0);

    expect(out.npcs[1].gripPoint!.z).toBeCloseTo(-3.333, 2);
    expect(out.items[0].holder).toBe('p2');
    expect(out.items[0].doses).toBe(17);
    expect(out.items[0].pos.z).toBeCloseTo(-4.13, 2);
    expect(out.items[1].holder).toBeNull();
    // a Uint8Array view (how some transports hand it over) decodes identically
    const viaView = decodeSnapshot(new Uint8Array(buf), 128);
    expect(viaView.items[0].doses).toBe(17);
    expect(snapshotSeq(viaView)).toBe(4242);
  });
});
