// Headless sim tests — the physics contract Build 1 depends on.

import { beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { initRapier, Sim } from '../src/sim/sim';
import { ZERO_INPUT, type PlayerInput } from '../src/sim/types';

beforeAll(async () => {
  await initRapier();
});

function run(sim: Sim, steps: number, input: Partial<PlayerInput> = {}, id = 'p0'): void {
  for (let i = 0; i < steps; i++) {
    const inputs = new Map<string, PlayerInput>();
    inputs.set(id, { ...ZERO_INPUT, ...input });
    sim.step(inputs);
  }
}

describe('wobbly body physics', () => {
  it('a standing player stays upright and does not drift far', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    const start = sim.snapshot().players['p0'].pos;
    run(sim, 60 * 5); // 5 seconds idle
    const b = sim.snapshot().players['p0'];
    expect(b.st).toBe(0);
    // up-axis stays close to world up
    const up = upY(b.rot);
    expect(up).toBeGreaterThan(0.93);
    // idle sway exists but shouldn't walk you across the room
    expect(Math.hypot(b.pos.x - start.x, b.pos.z - start.z)).toBeLessThan(1.0);
  });

  it('movement input accelerates toward moveSpeed and stops on release', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    // park the crowd by the stage so the lane along the +z wall is actually open
    // (running full speed INTO a packed crowd is supposed to be slow)
    sim.npcs.forEach((npc, i) => {
      const x = -6 + (i % 10) * 1.3;
      const z = -4.3 + Math.floor(i / 10) * 0.9;
      npc.body.setTranslation({ x, y: 1.0, z }, true);
      npc.home = { x, z };
    });
    run(sim, 90, { moveX: 1 }); // brief run along the open lane
    const moving = sim.snapshot().players['p0'];
    const speed = Math.hypot(moving.vel.x, moving.vel.z);
    expect(speed).toBeGreaterThan(CONFIG.body.moveSpeed * 0.6);
    run(sim, 120);
    const stopped = sim.snapshot().players['p0'];
    expect(Math.hypot(stopped.vel.x, stopped.vel.z)).toBeLessThan(0.7);
  });

  it('a big impulse knocks a player down and they get back up', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    run(sim, 30);
    const ch = sim.players.get('p0')!;
    ch.body.applyImpulse({ x: 420, y: 60, z: 0 }, true);
    ch.body.applyTorqueImpulse({ x: 0, y: 0, z: -180 }, true);
    run(sim, 45);
    expect(sim.snapshot().players['p0'].st).toBe(1); // down
    // downTime + getupRamp + slack
    run(sim, Math.ceil(60 * (CONFIG.balance.downTime + CONFIG.balance.getupRamp + 2.5)));
    const after = sim.snapshot().players['p0'];
    expect(after.st).toBe(0);
    expect(upY(after.rot)).toBeGreaterThan(0.9); // actually standing again
  });

  it('shove imparts real velocity to a target in front', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    sim.addPlayer('p1');
    const a = sim.players.get('p0')!;
    const b = sim.players.get('p1')!;
    // park the crowd by the stage — the dance pack now owns the mid-floor and
    // would jostle the test pair out of position during the settle
    sim.npcs.forEach((npc, i) => {
      const x = -7 + (i % 10) * 1.4;
      const z = -4.9 + Math.floor(i / 10) * 0.8;
      npc.body.setTranslation({ x, y: 1.0, z }, true);
      npc.home = { x, z };
    });
    // mid-floor with open space in the +z knockback path (not against a wall)
    a.body.setTranslation({ x: 0, y: 0.85, z: -1.2 }, true);
    b.body.setTranslation({ x: 0, y: 0.85, z: -0.4 }, true);
    run(sim, 10); // settle
    const before = sim.snapshot().players['p1'].vel;
    const inputs = new Map<string, PlayerInput>();
    inputs.set('p0', { ...ZERO_INPUT, shove: true });
    inputs.set('p1', { ...ZERO_INPUT });
    sim.step(inputs);
    const snap = sim.snapshot();
    const after = snap.players['p1'].vel;
    const dv = Math.hypot(after.x - before.x, after.z - before.z);
    expect(dv).toBeGreaterThan(1.0);
    expect(sim.lastEvents.some((e) => e.t === 'shove' && e.hit)).toBe(true);
    // the shover shows the arms-out pose; a CLEAN shove knocks the victim down
    expect(snap.players['p0'].act).toBe(1);
    expect(snap.players['p1'].st).toBe(1);
    const start = snap.players['p1'].pos;
    run(sim, 30);
    const carried = sim.snapshot().players['p1'].pos;
    expect(Math.hypot(carried.x - start.x, carried.z - start.z)).toBeGreaterThan(0.45);
  });

  it('crowd NPCs exist, stay in the room, and mostly stay standing', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    run(sim, 60 * 10); // 10 seconds of dancing
    const snap = sim.snapshot();
    expect(snap.npcs.length).toBe(CONFIG.crowd.count);
    const R = CONFIG.room;
    for (const npc of snap.npcs) {
      expect(Math.abs(npc.pos.x)).toBeLessThan(R.w / 2 + 0.5);
      expect(Math.abs(npc.pos.z)).toBeLessThan(R.d / 2 + 0.5);
      expect(npc.pos.y).toBeGreaterThan(-0.5); // nobody fell through the floor
    }
    const standing = snap.npcs.filter((n) => n.st === 0).length;
    expect(standing).toBeGreaterThan(CONFIG.crowd.count * 0.6);
  });

  it('grabbing needs physical contact and sticks to walls too', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    const a = sim.players.get('p0')!;
    const R = CONFIG.room;
    // face the +z wall from just inside reach
    a.body.setTranslation({ x: 0, y: 0.85, z: R.d / 2 - 0.9 }, true);
    run(sim, 10);
    run(sim, 5, { grab: true }); // faceYaw 0 → reaching +z at the wall
    const holding = sim.snapshot().players['p0'];
    expect(holding.gripPoint).not.toBeNull();
    expect(holding.gripPoint!.z).toBeGreaterThan(R.d / 2 - 0.4); // anchored ON the wall
    // out of reach: hands don't connect, no grab
    const sim2 = new Sim();
    sim2.addPlayer('p0');
    sim2.players.get('p0')!.body.setTranslation({ x: 0, y: 0.85, z: 0 }, true);
    sim2.npcs.forEach((npc, i) => {
      const x = -7 + (i % 10) * 1.4;
      const z = -4.9 + Math.floor(i / 10) * 0.8;
      npc.body.setTranslation({ x, y: 1.0, z }, true);
      npc.home = { x, z };
    });
    run(sim2, 10);
    run(sim2, 5, { grab: true }); // nothing within 1.1 m in front
    expect(sim2.snapshot().players['p0'].gripPoint).toBeNull();
  });

  it('grab pulls the target toward the holder', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    sim.addPlayer('p1');
    const a = sim.players.get('p0')!;
    const b = sim.players.get('p1')!;
    const ap = a.body.translation();
    b.body.setTranslation({ x: ap.x, y: ap.y, z: ap.z + 0.85 }, true);
    run(sim, 10);
    const d0 = dist(sim, 'p0', 'p1');
    // hold grab and back away
    for (let i = 0; i < 90; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT, grab: true, moveZ: -1 });
      inputs.set('p1', { ...ZERO_INPUT });
      sim.step(inputs);
    }
    const d1 = dist(sim, 'p0', 'p1');
    // holder retreated ~2m+; the spring must have dragged the target along
    expect(d1).toBeLessThan(CONFIG.grab.breakDist + 0.2);
    const bMoved = Math.abs(sim.snapshot().players['p1'].pos.z - (ap.z + 0.85));
    expect(bMoved).toBeGreaterThan(0.6);
    expect(d1).toBeGreaterThan(0); // sanity
    expect(d0).toBeLessThan(1.2);
  });
});

function dist(sim: Sim, a: string, b: string): number {
  const s = sim.snapshot();
  const pa = s.players[a].pos;
  const pb = s.players[b].pos;
  return Math.hypot(pa.x - pb.x, pa.z - pb.z);
}

function upY(q: { x: number; y: number; z: number; w: number }): number {
  // world-y of the body's up axis
  return 1 - 2 * (q.x * q.x + q.z * q.z);
}
