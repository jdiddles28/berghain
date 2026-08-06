// Headless sim tests — the physics contract Build 1 depends on.

import RAPIER from '@dimforge/rapier3d-compat';
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

function run2(
  sim: Sim,
  steps: number,
  in0: Partial<PlayerInput>,
  in1: Partial<PlayerInput>,
): void {
  for (let i = 0; i < steps; i++) {
    const inputs = new Map<string, PlayerInput>();
    inputs.set('p0', { ...ZERO_INPUT, ...in0 });
    inputs.set('p1', { ...ZERO_INPUT, ...in1 });
    sim.step(inputs);
  }
}

/** park the crowd in a grid by the stage so tests own the floor */
function parkCrowd(sim: Sim): void {
  sim.npcs.forEach((npc, i) => {
    const x = -7 + (i % 12) * 1.25;
    const z = -4.9 + Math.floor(i / 12) * 0.8;
    npc.body.setTranslation({ x, y: 1.0, z }, true);
    npc.home = { x, z };
  });
}

/** teleport p0 in front of the booth and take the bag off the stand */
function pickUpBag(sim: Sim): void {
  const a = sim.players.get('p0')!;
  // on the floor right in front of the stage — eye ends up almost level with
  // the bag on the booth top, so the look-pitch is nearly flat
  a.body.setTranslation({ x: -0.3, y: 0.85, z: -3.4 }, true);
  a.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  run(sim, 20, { faceYaw: Math.PI }); // player + bag settle
  run(sim, 3, { grab: true, faceYaw: Math.PI, facePitch: -0.09 });
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
    parkCrowd(sim);
    run(sim, 90, { moveX: 1 }); // brief run along the open lane
    const moving = sim.snapshot().players['p0'];
    const speed = Math.hypot(moving.vel.x, moving.vel.z);
    expect(speed).toBeGreaterThan(CONFIG.body.moveSpeed * 0.6);
    // deliberate pace, not a jog (John: way too fast)
    expect(speed).toBeLessThan(2.4);
    run(sim, 90);
    const stopped = sim.snapshot().players['p0'];
    // planted stop — gliding to a halt over a second read as ice skating
    expect(Math.hypot(stopped.vel.x, stopped.vel.z)).toBeLessThan(0.5);
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

  it('downed bodies stop sliding instead of tobogganing across the room', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    parkCrowd(sim);
    run(sim, 30);
    const ch = sim.players.get('p0')!;
    ch.body.applyImpulse({ x: 420, y: 60, z: 0 }, true);
    ch.body.applyTorqueImpulse({ x: 0, y: 0, z: -180 }, true);
    run(sim, 60); // 1 s after the hit: down, and already parked
    expect(sim.snapshot().players['p0'].st).toBe(1);
    const v = sim.snapshot().players['p0'].vel;
    expect(Math.hypot(v.x, v.z)).toBeLessThan(0.6);
  });

  it('a sprint-jump body check floors the victim', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    sim.addPlayer('p1');
    parkCrowd(sim);
    const a = sim.players.get('p0')!;
    const b = sim.players.get('p1')!;
    a.body.setTranslation({ x: 0, y: 0.85, z: 2.4 }, true);
    b.body.setTranslation({ x: 0, y: 0.85, z: 0 }, true);
    run2(sim, 10, {}, {});
    // sprint at them, leave the ground just before contact
    const charge: Partial<PlayerInput> = { moveZ: -1, sprint: true, faceYaw: Math.PI };
    run2(sim, 25, charge, {});
    run2(sim, 1, { ...charge, hop: true }, {});
    run2(sim, 70, charge, {});
    expect(sim.snapshot().players['p1'].st).toBe(1); // flattened
  });

  it('everything in the booth that looks solid IS solid', () => {
    const sim = new Sim();
    run(sim, 2); // ray queries need at least one step to build the query pipeline
    const s = CONFIG.room.stage;
    const dj = CONFIG.room.dj;
    const down = { x: 0, y: -1, z: 0 };
    const topAt = (x: number, z: number) => {
      const hit = sim.world.castRay(new RAPIER.Ray({ x, y: 4, z }, down), 6, true);
      return hit ? 4 - hit.timeOfImpact : -1;
    };
    // deck on the board top (was a ghost — you could wave through it)
    expect(topAt(dj.x + 0.55, dj.boardZ)).toBeGreaterThan(s.h + dj.boardH + 0.05);
    // booth top slab overhang
    expect(topAt(dj.x + dj.boardW / 2 + 0.04, dj.boardZ)).toBeGreaterThan(s.h + dj.boardH - 0.05);
    // speaker stacks
    expect(topAt(s.x - s.w / 2 + 0.7, s.z - 0.3)).toBeGreaterThan(s.h + 2.0);
    expect(topAt(s.x + s.w / 2 - 0.7, s.z - 0.3)).toBeGreaterThan(s.h + 2.0);
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
    parkCrowd(sim2);
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
    // hold grab and back away (the deliberate walk pace needs a beat longer)
    for (let i = 0; i < 130; i++) {
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

describe('items — the bag of K', () => {
  it('spawns on the DJ stand and can be picked up, carried, and dropped', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    run(sim, 30);
    let bag = sim.snapshot().items[0];
    expect(bag.holder).toBeNull();
    expect(bag.doses).toBe(CONFIG.ketamine.dosesPerBag);
    // resting ON the booth top, not inside it or on the floor
    expect(bag.pos.y).toBeGreaterThan(CONFIG.room.stage.h + CONFIG.room.dj.boardH - 0.05);

    pickUpBag(sim);
    bag = sim.snapshot().items[0];
    expect(bag.holder).toBe('p0');
    // held out in front: rides the hand, near the body
    run(sim, 30, { faceYaw: Math.PI });
    bag = sim.snapshot().items[0];
    const p = sim.snapshot().players['p0'].pos;
    expect(Math.hypot(bag.pos.x - p.x, bag.pos.y - p.y, bag.pos.z - p.z)).toBeLessThan(0.8);

    // tap Q: a gentle drop at your feet, not a launch
    run(sim, 4, { drop: true, faceYaw: Math.PI });
    run(sim, 30, { faceYaw: Math.PI });
    bag = sim.snapshot().items[0];
    expect(bag.holder).toBeNull();
    const p2 = sim.snapshot().players['p0'].pos;
    expect(Math.hypot(bag.pos.x - p2.x, bag.pos.z - p2.z)).toBeLessThan(1.6);
  });

  it('holding Q charges a real throw', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    // clear the flight path — the first run of this test threw the bag
    // straight into a dancer's face at 12 m/s (physics working as intended)
    sim.npcs.forEach((npc, i) => {
      const x = 2.2 + (i % 8) * 0.72;
      const z = 1.2 + Math.floor(i / 8) * 0.78;
      npc.body.setTranslation({ x, y: 1.0, z }, true);
      npc.home = { x, z };
    });
    run(sim, 30);
    pickUpBag(sim);
    expect(sim.snapshot().items[0].holder).toBe('p0');
    // face the open floor (+z), charge all the way, release
    run(sim, 20, { faceYaw: 0 });
    const from = sim.snapshot().items[0].pos;
    run(sim, Math.ceil(60 * (CONFIG.items.throwChargeMax + 0.15)), { drop: true, faceYaw: 0 });
    run(sim, 45, { faceYaw: 0 }); // release → it flies
    const bag = sim.snapshot().items[0];
    expect(bag.holder).toBeNull();
    expect(bag.pos.z - from.z).toBeGreaterThan(2.0); // actually thrown, not dribbled
  });

  it('a bag can be snatched straight out of another player’s hand', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    sim.addPlayer('p1');
    run2(sim, 30, {}, {});
    pickUpBag(sim); // p0 holds it (p1 idles at spawn)
    expect(sim.snapshot().items[0].holder).toBe('p0');
    // p0 faces the floor (+z) so the bag is held toward p1; p1 walks up and takes it
    const b = sim.players.get('p1')!;
    b.body.setTranslation({ x: -0.1, y: 0.83, z: -1.9 }, true);
    b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    run2(sim, 25, { faceYaw: 0 }, { faceYaw: Math.PI });
    run2(sim, 3, { faceYaw: 0 }, { grab: true, faceYaw: Math.PI, facePitch: -0.35 });
    expect(sim.snapshot().items[0].holder).toBe('p1');
    expect(sim.players.get('p0')!.holding).toBeNull();
  });
});

describe('ketamine', () => {
  it(
    'bumps hit after the onset delay, k-hole at 5, and you surface again',
    () => {
      const sim = new Sim();
      sim.addPlayer('p0');
      run(sim, 30);
      pickUpBag(sim);
      const ch = sim.players.get('p0')!;
      const K = CONFIG.ketamine;
      // 5 bumps = 5 separate presses. Each press is a committed animation and
      // OVER-holding past the end must not retrigger (John's ruling) — every
      // cycle below over-holds by a full second and still burns exactly 1.
      for (let i = 0; i < 5; i++) {
        run(sim, Math.ceil(60 * (K.doseAnimTime + 1.0)), { use: true, faceYaw: Math.PI });
        run(sim, 6, { faceYaw: Math.PI }); // release before the next press
      }
      expect(sim.snapshot().items[0].doses).toBe(K.dosesPerBag - 5);
      expect(ch.kLevel).toBe(0); // nothing has HIT yet — onset delay
      // onset: all five arrive → level 5 → k-hole (down, and STAYS down)
      run(sim, Math.ceil(60 * (K.onsetDelay + 2)));
      expect(ch.kLevel).toBe(K.maxLevel);
      expect(sim.snapshot().players['p0'].st).toBe(1);
      expect(sim.snapshot().items[0].holder).toBeNull(); // the bag hit the floor with you
      run(sim, 60 * 5);
      expect(sim.snapshot().players['p0'].st).toBe(1); // still gone
      expect(sim.snapshot().players['p0'].k).toBeGreaterThan(2); // felt level caught up
      // decay to level 4 → allowed to get back up, wobblier and slower
      run(sim, Math.ceil(60 * (K.decayEvery + CONFIG.balance.downTime + 8)));
      expect(ch.kLevel).toBeLessThan(K.maxLevel);
      expect(sim.snapshot().players['p0'].st).toBe(0);
    },
    120000,
  );

  it(
    'being high slows your walk',
    () => {
      const sim = new Sim();
      sim.addPlayer('p0');
      parkCrowd(sim);
      const ch = sim.players.get('p0')!;
      // straight to level 4 (no bag needed — set the state, measure the physics)
      ch.kLevel = 4;
      ch.kFelt = 4;
      ch.kLastChange = 1e9; // hold the level there for the whole test
      run(sim, 120, { moveX: 1 });
      const v = sim.snapshot().players['p0'];
      const speed = Math.hypot(v.vel.x, v.vel.z);
      expect(speed).toBeLessThan(CONFIG.body.moveSpeed * 0.75);
      expect(speed).toBeGreaterThan(0.3); // slowed, not frozen
    },
    30000,
  );
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
