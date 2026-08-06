// THE NIGHT — the MVP loop: stamina, the Curator's minions, the stall, the
// clock. These are the win/lose mechanics John's group will actually play.

import { beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { initRapier, Sim, type Character } from '../src/sim/sim';
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

/** park everyone far from the action in the +x half */
function parkCrowdFar(sim: Sim, except?: Character): void {
  sim.npcs.forEach((npc, i) => {
    if (npc === except) return;
    const x = 2.2 + (i % 8) * 0.72;
    const z = -0.5 + Math.floor(i / 8) * 0.75;
    npc.body.setTranslation({ x, y: 1.0, z }, true);
    npc.home = { x, z };
  });
}

function aMinion(sim: Sim): Character {
  const idx = CONFIG.crowd.dancers + CONFIG.crowd.walkers;
  const m = sim.npcs[idx];
  expect(m.isMinion).toBe(true);
  return m;
}

/** plant a minion at (x,z), staring down the given yaw, and keep it there */
function plantWatcher(m: Character, x: number, z: number, yaw: number): void {
  m.body.setTranslation({ x, y: 1.0, z }, true);
  m.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  m.minionMode = 1;
  m.lingerT = 9999;
  m.scanYaw = yaw;
}

/** stamina tests aren't Curator tests: freeze all minions far out of
 *  viewRange so a collapsed test subject doesn't get (correctly!) ejected */
function blindMinions(sim: Sim): void {
  for (const m of sim.npcs) if (m.isMinion) plantWatcher(m, 7.3, -5.2, 0);
}

describe('the night', () => {
  it('the clock runs and closing time ends the night', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    run(sim, 30);
    expect(sim.snapshot().phase).toBe(0);
    expect(sim.snapshot().nightT).toBeGreaterThan(0.4);
    sim.nightT = CONFIG.night.length - 0.2;
    run(sim, 30);
    expect(sim.snapshot().phase).toBe(1);
  });

  it('stamina drains, empties into a collapse, and sleep brings you back', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    parkCrowdFar(sim);
    blindMinions(sim); // a watched collapse = ejection (that test is separate)
    const ch = sim.players.get('p0')!;
    ch.body.setTranslation({ x: -6.5, y: 0.85, z: -1.0 }, true);
    run(sim, 60);
    expect(ch.stamina).toBeLessThan(1); // it drains from the first minute
    ch.stamina = 0.01;
    run(sim, 60 * 3);
    expect(ch.staminaDown).toBe(true);
    expect(sim.snapshot().players['p0'].st).toBe(1); // folded up on the spot
    // sleeping it off: the bar creeps back and you eventually stand
    run(sim, Math.ceil(60 * (CONFIG.night.standAt / CONFIG.night.collapseRegen + 8)));
    expect(ch.staminaDown).toBe(false);
    expect(sim.snapshot().players['p0'].st).toBe(0);
  });

  it('sprinting burns the bar much faster than walking', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    parkCrowdFar(sim);
    blindMinions(sim);
    const ch = sim.players.get('p0')!;
    // clear straight lane both times — sprinting into furniture ends the
    // measurement on the floor (learned the fun way)
    ch.body.setTranslation({ x: -7, y: 0.85, z: 3.6 }, true);
    run(sim, 10);
    ch.stamina = 1;
    run(sim, 60 * 3, { moveX: 1 });
    const walkCost = 1 - ch.stamina;
    ch.body.setTranslation({ x: -7, y: 0.85, z: 3.6 }, true);
    ch.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    run(sim, 10);
    ch.stamina = 1;
    run(sim, 60 * 3, { moveX: 1, sprint: true });
    const sprintCost = 1 - ch.stamina;
    expect(sprintCost).toBeGreaterThan(walkCost * 2);
  });

  it('a k-holed body in a minion’s line of sight gets walked out', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    const m = aMinion(sim);
    parkCrowdFar(sim, m);
    const p = sim.players.get('p0')!;
    p.body.setTranslation({ x: -2, y: 0.85, z: 3.5 }, true);
    plantWatcher(m, -2, 1.5, 0); // two metres away, facing them square
    run(sim, 20);
    p.kLevel = CONFIG.ketamine.maxLevel; // k-holes them on the next step
    p.kFelt = CONFIG.ketamine.maxLevel;
    p.kLastChange = 1e9;
    let sawEject = false;
    for (let i = 0; i < 60 * 40 && !sawEject; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      for (const ev of sim.lastEvents) if (ev.t === 'eject') sawEject = true;
    }
    expect(sawEject).toBe(true);
    expect(p.out).toBe(true);
    expect(sim.snapshot().players['p0'].out).toBe(true);
    // dumped outside the exit, beyond the wall
    expect(sim.snapshot().players['p0'].pos.z).toBeGreaterThan(CONFIG.room.d / 2);
  });

  it('the stall blocks every line of sight — dosing in there is safe', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    const m = aMinion(sim);
    parkCrowdFar(sim, m);
    const p = sim.players.get('p0')!;
    // k-holed INSIDE the stall, minion parked right outside staring at it
    p.body.setTranslation({ x: -7.2, y: 0.85, z: 5.0 }, true);
    plantWatcher(m, -6.0, 2.6, Math.atan2(-1.2, 2.4));
    run(sim, 20);
    p.kLevel = CONFIG.ketamine.maxLevel;
    p.kFelt = CONFIG.ketamine.maxLevel;
    p.kLastChange = 1e9;
    run(sim, 60 * 10);
    expect(p.heat).toBe(0); // never seen
    expect(p.out).toBe(false);
  });

  it('walkers queue for the stall and take their turn', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    // speed up the need so the test doesn't idle: everyone needs to go NOW
    for (const npc of sim.npcs) if (!npc.isMinion && !npc.isDJ) npc.needT = Math.random() * 3;
    let reachedStall = false;
    let queued = 0;
    for (let i = 0; i < 60 * 100 && !reachedStall; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      queued = Math.max(queued, sim.queue.length);
      for (const npc of sim.npcs) if (npc.walkerMode === 3) reachedStall = true;
    }
    expect(queued).toBeGreaterThan(1); // an actual line formed
    expect(reachedStall).toBe(true); // and the front of it got through the door
  }, 60000);
});
