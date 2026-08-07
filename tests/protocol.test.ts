// Binary snapshot codec roundtrip — one bad byte offset here is a black
// screen and a "multiplayer is broken" playtest, so the whole layout gets
// exercised: players with/without grips, NPCs, held / stowed / loose items.

import { describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot, snapshotSeq } from '../src/net/protocol';
import type { BodySnap, SimSnapshot } from '../src/sim/types';

function body(n: number, grip: boolean): BodySnap {
  return {
    pos: { x: -7.5 + n, y: 0.83 + n * 0.01, z: 5.9 - n },
    rot: { x: 0.1, y: -0.2, z: 0.05, w: 0.973 },
    vel: { x: 1.234, y: -0.5, z: 3.1 },
    st: (n % 3) as BodySnap['st'],
    act: ((n + 1) % 7) as BodySnap['act'],
    k: n === 0 ? 3.7 : 0,
    stam: n === 0 ? 0.42 : 1,
    boogie: n === 0 ? 0.66 : 1,
    watch: n === 2 ? 0.8 : 0,
    out: n === 2,
    outWhy: n === 2 ? 1 : 0,
    asleep: n === 3,
    angry: n === 1 || n === 4,
    gripPoint: grip ? { x: 1.111, y: 2.222, z: -3.333 } : null,
  };
}

describe('binary snapshot codec', () => {
  it('roundtrips players, npcs, and items within quantization error', () => {
    const snap: SimSnapshot = {
      time: 123.456,
      beat: 0,
      nightT: 456.78,
      phase: 1,
      doorAngle: -1.234,
      players: { p0: body(0, true), p2: body(2, false) },
      npcs: [body(1, false), body(3, true), body(4, false)],
      items: [
        {
          kind: 0,
          pos: { x: -0.3, y: 1.325, z: -4.13 },
          rot: { x: 0, y: 0.707, z: 0, w: 0.707 },
          holder: 'p2',
          grams: 0.85,
          stowed: false,
          slot: 0,
        },
        {
          kind: 1,
          pos: { x: 2, y: 0.05, z: 3 },
          rot: { x: 0, y: 0, z: 0, w: 1 },
          holder: 'p2',
          grams: 0,
          stowed: true, // pocketed card — the flag must survive the wire
          slot: 1,
        },
        {
          kind: 2,
          pos: { x: 0.4, y: 1.1, z: -1.9 },
          rot: { x: 0, y: 0, z: 0, w: 1 },
          holder: 'n2', // held by NPC index 2 — the dancer who arrived holding
          grams: 0,
          stowed: false,
          slot: 2,
        },
        {
          kind: 0,
          pos: { x: -7.6, y: 0.1, z: 5.7 },
          rot: { x: 0, y: 0, z: 0, w: 1 },
          holder: null,
          grams: 1.0,
          stowed: false,
          slot: 0,
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
    expect(out.items.length).toBe(4);

    const p0 = out.players['p0'];
    expect(p0.pos.x).toBeCloseTo(-7.5, 2);
    expect(p0.vel.z).toBeCloseTo(3.1, 2);
    expect(p0.rot.w).toBeCloseTo(0.973, 3);
    expect(p0.st).toBe(0);
    expect(p0.act).toBe(1);
    expect(p0.k).toBeCloseTo(3.7, 1);
    expect(p0.stam).toBeCloseTo(0.42, 2);
    expect(p0.boogie).toBeCloseTo(0.66, 2);
    expect(p0.out).toBe(false);
    expect(p0.outWhy).toBe(0);
    expect(p0.gripPoint!.y).toBeCloseTo(2.222, 2);
    expect(out.players['p2'].gripPoint).toBeNull();
    expect(out.players['p2'].k).toBe(0);
    expect(out.players['p2'].watch).toBeCloseTo(0.8, 2);
    expect(out.players['p2'].out).toBe(true);
    // BOOGIED OUT vs escorted — the reason bit survives (b17)
    expect(out.players['p2'].outWhy).toBe(1);
    expect(out.nightT).toBeCloseTo(456.78, 1);
    expect(out.phase).toBe(1);
    expect(out.doorAngle).toBeCloseTo(-1.234, 2);

    expect(out.npcs[1].gripPoint!.z).toBeCloseTo(-3.333, 2);
    // the b14 flag bits: fetal sleep + angry brows survive the wire
    expect(out.npcs[1].asleep).toBe(true);
    expect(out.npcs[1].angry).toBe(false);
    expect(out.npcs[0].angry).toBe(true);
    expect(out.npcs[2].angry).toBe(true);
    expect(out.players['p0'].asleep).toBe(false);
    // items: kinds, grams, pockets (b17)
    expect(out.items[0].holder).toBe('p2');
    expect(out.items[0].kind).toBe(0);
    expect(out.items[0].grams).toBeCloseTo(0.85, 2);
    expect(out.items[0].stowed).toBe(false);
    expect(out.items[0].pos.z).toBeCloseTo(-4.13, 2);
    expect(out.items[1].kind).toBe(1);
    expect(out.items[1].stowed).toBe(true);
    expect(out.items[1].slot).toBe(1);
    expect(out.items[2].holder).toBe('n2');
    expect(out.items[2].kind).toBe(2);
    expect(out.items[2].slot).toBe(2);
    expect(out.items[3].holder).toBeNull();
    expect(out.items[3].grams).toBeCloseTo(1.0, 2);
    // a Uint8Array view (how some transports hand it over) decodes identically
    const viaView = decodeSnapshot(new Uint8Array(buf), 128);
    expect(viaView.items[0].grams).toBeCloseTo(0.85, 2);
    expect(snapshotSeq(viaView)).toBe(4242);
  });
});
