// Crowd balance regression tests. John's playtest (2026-08-05): NPCs were
// "tripping over themselves, walking at a 45 degree angle, flopping around on
// the floor" — the crowd got taller and heavier in feel pass 3 but their
// upright spring wasn't rescaled, so gravity torque beat maxTorque past ~35°
// of tilt and every stumble became a slow-motion faceplant. The crowd should
// only go down when a PLAYER puts them down.

import { beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { initRapier, Sim } from '../src/sim/sim';
import { ZERO_INPUT, type PlayerInput } from '../src/sim/types';

beforeAll(async () => {
  await initRapier();
});

function stepN(sim: Sim, steps: number): void {
  for (let i = 0; i < steps; i++) {
    const inputs = new Map<string, PlayerInput>();
    inputs.set('p0', { ...ZERO_INPUT });
    sim.step(inputs);
  }
}

function upY(q: { x: number; y: number; z: number; w: number }): number {
  return 1 - 2 * (q.x * q.x + q.z * q.z);
}

describe('crowd stays on its feet', () => {
  it('45 s of dancing and walking: nobody falls over on their own', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    let falls = 0;
    let worstUp = 1;
    for (let i = 0; i < 60 * 45; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      for (const ev of sim.lastEvents) if (ev.t === 'fall') falls++;
      if (i % 30 === 0) {
        for (const npc of sim.snapshot().npcs) worstUp = Math.min(worstUp, upY(npc.rot));
      }
    }
    // the player is idle at spawn — any fall is the crowd tripping over itself
    expect(falls).toBe(0);
    // and nobody spends time deeply leaned either (45° lean has upY ≈ 0.71)
    expect(worstUp).toBeGreaterThan(0.8);
  });

  it('after a blast wave, every NPC gets back up and stays up', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    stepN(sim, 30);
    for (const npc of sim.npcs) {
      const p = npc.body.translation();
      const a = Math.atan2(p.x, p.z + 0.001);
      npc.body.applyImpulse({ x: Math.sin(a) * 450, y: 70, z: Math.cos(a) * 450 }, true);
    }
    stepN(sim, 45);
    const downNow = sim.snapshot().npcs.filter((n) => n.st !== 0).length;
    expect(downNow).toBeGreaterThan(CONFIG.crowd.count * 0.7); // the blast worked
    // downTime + getupRamp + generous slack for the pile to untangle
    stepN(sim, Math.ceil(60 * (CONFIG.balance.downTime + CONFIG.balance.getupRamp + 4)));
    const snap = sim.snapshot();
    const standing = snap.npcs.filter((n) => n.st === 0 && upY(n.rot) > 0.85).length;
    expect(standing).toBe(CONFIG.crowd.count);
    // ...and they don't immediately fall again
    let falls = 0;
    for (let i = 0; i < 60 * 8; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      for (const ev of sim.lastEvents) if (ev.t === 'fall') falls++;
    }
    expect(falls).toBe(0);
  });

  it('a dancer knocked far from the pack walks back to the mass', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    stepN(sim, 60 * 2); // let the pack settle into its lump
    // yeet dancer 0 toward the far corner
    const d = sim.npcs[0];
    d.body.setTranslation({ x: 6.8, y: 1.0, z: 4.6 }, true);
    d.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    stepN(sim, 60 * 12);
    // he should have rejoined the mass: distance to the dancer centroid small
    let cx = 0;
    let cz = 0;
    const n = CONFIG.crowd.dancers;
    for (let i = 0; i < n; i++) {
      const p = sim.npcs[i].body.translation();
      cx += p.x / n;
      cz += p.z / n;
    }
    const p0 = d.body.translation();
    expect(Math.hypot(p0.x - cx, p0.z - cz)).toBeLessThan(CONFIG.crowd.packRadius + 1.0);
  });
});
