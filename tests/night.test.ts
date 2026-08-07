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

/** park everyone far from the action in the +x half — PINNED (a scheduler-
 *  summoned walker used to march through live scenes and floor the subjects) */
function parkCrowdFar(sim: Sim, except?: Character): void {
  sim.npcs.forEach((npc, i) => {
    if (npc === except) return;
    const x = 2.2 + (i % 8) * 0.72;
    const z = -0.5 + Math.floor(i / 8) * 0.75;
    npc.body.setTranslation({ x, y: 1.0, z }, true);
    npc.home = { x, z };
    npc.lingerT = 1e9;
  });
  (sim as unknown as { needTimer: number }).needTimer = 1e9;
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
    // sleep is HORIZONTAL (John): never a balanced-upright "standing sleeper"
    run(sim, 90);
    const upY = (q: { x: number; y: number; z: number; w: number }) =>
      1 - 2 * (q.x * q.x + q.z * q.z);
    expect(upY(sim.snapshot().players['p0'].rot)).toBeLessThan(0.6);
    // sleeping it off: the bar creeps back and you eventually stand
    run(sim, Math.ceil(60 * (CONFIG.night.standAtFrac / CONFIG.night.collapseRegen + 8)));
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
    // conjure a line: four walkers suddenly need to go (the global scheduler
    // normally spaces this out — the routing is what's under test)
    const walkers = sim.npcs.filter((n) => !n.isMinion && !n.isDJ && !n.isDancer).slice(0, 4);
    for (const w of walkers) {
      sim.queue.push(w);
      w.walkerMode = 1;
    }
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

  it('the line self-populates: the club runs with zero player involvement', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    let everQueued = 0;
    let everUsed = false;
    for (let i = 0; i < 60 * 130 && !(everUsed && everQueued > 0); i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      everQueued = Math.max(everQueued, sim.queue.length);
      for (const npc of sim.npcs) if (npc.walkerMode === 3) everUsed = true;
    }
    expect(everQueued).toBeGreaterThan(0); // the scheduler sent people
    expect(everUsed).toBe(true); // and the system cycled someone through
  }, 150000);

  it('a stall camper gets knocked at, then barged out by the front of the line', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    blindMinions(sim);
    const p = sim.players.get('p0')!;
    // camp the stall — with NO line yet, so this is a fair occupancy (the
    // line-cut fast path is a separate behavior)
    p.body.setTranslation({ x: -7.2, y: 0.85, z: 5.0 }, true);
    run(sim, 15);
    // now a walker arrives and waits at the front slot (straight out from
    // the door: b15 queue geometry)
    const w = sim.npcs.filter((n) => !n.isMinion && !n.isDJ && !n.isDancer)[0];
    w.body.setTranslation({ x: -6.35, y: 1.0, z: 2.55 }, true);
    sim.queue.push(w);
    w.walkerMode = 1;
    let knocks = 0;
    let barged = false;
    // hold still inside for 70+ pressure-seconds
    for (let i = 0; i < 60 * 75 && !barged; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      for (const ev of sim.lastEvents) if (ev.t === 'knock') knocks++;
      if ((w.walkerMode as number) === 5) barged = true; // sim.step mutates it — TS can't see that
    }
    expect(knocks).toBeGreaterThanOrEqual(2); // 30 s knock + 45 s LOUD knock
    expect(barged).toBe(true); // 60 s: they come in after their turn
  }, 90000);

  it('cutting the line skips the polite phase — the barge starts immediately', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    blindMinions(sim);
    // the line exists FIRST
    const w = sim.npcs.filter((n) => !n.isMinion && !n.isDJ && !n.isDancer)[0];
    w.body.setTranslation({ x: -6.35, y: 1.0, z: 2.55 }, true);
    sim.queue.push(w);
    w.walkerMode = 1;
    // the player waltzes straight past them into the stall
    const p = sim.players.get('p0')!;
    p.body.setTranslation({ x: -7.2, y: 0.85, z: 5.0 }, true);
    let barged = false;
    for (let i = 0; i < 60 * 8 && !barged; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      if ((w.walkerMode as number) === 5) barged = true;
    }
    expect(barged).toBe(true); // zero patience for queue cutters
  }, 30000);

  it('grabbing a minion fills the bar fast; flooring one is instant grounds', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    const m = aMinion(sim);
    parkCrowdFar(sim, m);
    const p = sim.players.get('p0')!;
    p.body.setTranslation({ x: -2, y: 0.85, z: 2.0 }, true);
    m.body.setTranslation({ x: -2, y: 1.0, z: 2.9 }, true);
    m.minionMode = 1;
    m.lingerT = 9999;
    m.scanYaw = Math.PI;
    run(sim, 10);
    // hold a grab on them for 2 s — suspicion should be climbing hard
    run(sim, 120, { grab: true, faceYaw: 0 });
    expect(p.heat).toBeGreaterThan(0.4);
    expect(p.heat).toBeLessThan(CONFIG.curator.ejectAt); // quick grab ≠ instant ejection
    // flooring one is different: instant grounds for expulsion
    const sim2 = new Sim();
    sim2.addPlayer('p0');
    const m2 = aMinion(sim2);
    parkCrowdFar(sim2, m2);
    const p2 = sim2.players.get('p0')!;
    p2.checkedAt = 0;
    m2.checkedBy = p2;
    m2.checkedAt = sim2.time;
    (sim2 as unknown as { knockDown(c: Character): void }).knockDown(m2);
    expect(p2.heat).toBeGreaterThanOrEqual(CONFIG.curator.ejectAt);
  }, 30000);

  it('a booth-shoo lets GO the moment you are off the stand (b17)', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    const m = aMinion(sim);
    parkCrowdFar(sim, m);
    const p = sim.players.get('p0')!;
    // player parked ON the DJ stand; the minion is put straight on the shoo
    const s = CONFIG.room.stage;
    p.body.setTranslation({ x: 1.2, y: s.h + 0.85, z: -4.3 }, true);
    m.body.setTranslation({ x: 1.2, y: 1.0, z: -2.6 }, true);
    m.minionMode = 3;
    m.huntTarget = p;
    let everGripped = false;
    let released = false;
    for (let i = 0; i < 60 * 45 && !released; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      p.heat = 0; // heat/ejection is a different system — the RELEASE is under test
      if (m.grip) everGripped = true;
      if (everGripped && !m.grip && (m.minionMode as number) === 0) released = true; // sim.step mutates it — TS can't see that
    }
    expect(everGripped).toBe(true); // they did come and drag you
    expect(released).toBe(true); // and LET GO once you were off the stand
    expect(p.out).toBe(false); // a shoo is not an ejection
    const pp = p.pos();
    // dumped on the floor, off the restricted area
    expect(pp.y).toBeLessThan(1.05);
  }, 60000);

  it('a walker heading for the line joins BEHIND whoever got there first (b17)', () => {
    const B = CONFIG.bathroom;
    const sim = new Sim();
    sim.addPlayer('p0');
    (sim as unknown as { needTimer: number }).needTimer = 1e9;
    blindMinions(sim);
    // stall busy so the line holds still
    const campers = sim.npcs.filter((n) => !n.isMinion && !n.isDJ && !n.isDancer);
    const occ = campers[5];
    occ.body.setTranslation({ x: -7.3, y: 1.0, z: 5.1 }, true);
    occ.walkerMode = 3;
    occ.stallT = 600;
    // the player is ALREADY standing at the back slot (slot 0 — empty line)
    const p = sim.players.get('p0')!;
    const s0 = { x: B.doorMidX, z: B.innerZ - B.queueGap0 };
    p.body.setTranslation({ x: s0.x, y: 0.85, z: s0.z }, true);
    // a walker far across the room gets the tap at the same moment
    const w = campers[0];
    w.body.setTranslation({ x: 5.5, y: 1.0, z: 1.0 }, true);
    w.walkerMode = 1;
    let joined = false;
    for (let i = 0; i < 60 * 30 && !joined; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      // hold the player planted on the slot (idle sway drifts)
      if (i % 60 === 0) {
        p.body.setTranslation({ x: s0.x, y: 0.85, z: s0.z }, true);
        p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
      if (sim.queue.includes(w)) joined = true;
    }
    expect(joined).toBe(true);
    // "I was here first": the walker filed in BEHIND the player
    expect(sim.queue.indexOf(p)).toBe(0);
    expect(sim.queue.indexOf(w)).toBe(1);
  }, 60000);

  it('standing still while wrecked draws far less heat than stumbling around (b17)', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    const m = aMinion(sim);
    parkCrowdFar(sim, m);
    const p = sim.players.get('p0')!;
    p.kLevel = 4;
    p.kFelt = 4;
    p.kLastChange = 1e9;
    // watcher square in front, eyes PINNED on them (mode-1 scanning sweeps
    // the gaze — hold it steady so the comparison measures the rates)
    p.body.setTranslation({ x: -2, y: 0.85, z: 1.0 }, true);
    plantWatcher(m, -2, 3.0, Math.PI);
    // the yaw servo turns a planted 100 kg body SLOWLY — start it facing them
    m.body.setRotation({ x: 0, y: Math.sin(Math.PI / 2), z: 0, w: Math.cos(Math.PI / 2) }, true);
    const stare = (steps: number, input: Partial<PlayerInput> = {}) => {
      for (let i = 0; i < steps; i++) {
        m.scanYaw = Math.PI;
        const inputs = new Map<string, PlayerInput>();
        inputs.set('p0', { ...ZERO_INPUT, ...input });
        sim.step(inputs);
      }
    };
    stare(20);
    p.heat = 0;
    stare(60 * 3); // standing dead still
    const stillHeat = p.heat;
    p.heat = 0;
    p.body.setTranslation({ x: -2, y: 0.85, z: 0.2 }, true);
    stare(60 * 3, { moveZ: 1 }); // lurching toward the watcher
    const movingHeat = p.heat;
    expect(stillHeat).toBeGreaterThan(0); // still watched, faintly
    expect(movingHeat).toBeGreaterThan(stillHeat * 2.5); // moving is the giveaway
  }, 30000);

  it('nobody strolls through the dancefloor as ordinary walking (b17)', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    const Z = CONFIG.crowd.danceZone;
    let inside = 0;
    let samples = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      if (i % 20 !== 0) continue;
      for (const n of sim.npcs) {
        if (n.isDancer || n.isDJ) continue;
        if (n.state !== 0) continue;
        samples++;
        const p = n.pos();
        if (Math.hypot(p.x - Z.x, p.z - Z.z) < Z.r) inside++;
      }
    }
    // walkers + patrolling minions skirt the floor now — a stray shove-in is
    // fine, a steady stream of through-traffic is not
    expect(inside / samples).toBeLessThan(0.05);
  }, 120000);

  it('a hunter that fully loses line of sight gives up the pursuit', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    const m = aMinion(sim);
    parkCrowdFar(sim, m);
    const p = sim.players.get('p0')!;
    // hide in the stall (LOS-proof) with the hunter far away mid-room
    p.body.setTranslation({ x: -7.2, y: 0.85, z: 5.2 }, true);
    m.body.setTranslation({ x: 6.5, y: 1.0, z: -4.5 }, true);
    p.heat = 1.0;
    m.minionMode = 2;
    m.huntTarget = p;
    run(sim, Math.ceil(60 * (CONFIG.curator.losForget + 1.5)));
    expect(m.minionMode).not.toBe(2); // forgot us
    expect(p.heat).toBeLessThanOrEqual(CONFIG.curator.losCooldownHeat + 0.01);
    expect(p.out).toBe(false);
  }, 30000);
});

// b17: the dance economy — the boogie meter only dancing refills, dancing
// costs energy (less on K), and dancing in the pack hides how wrecked you are
describe('the boogie meter (b17)', () => {
  it('drains while standing around and fills while dancing', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    parkCrowdFar(sim);
    blindMinions(sim);
    const p = sim.players.get('p0')!;
    run(sim, 60 * 6);
    const drained = p.boogie;
    expect(drained).toBeLessThan(1);
    expect(drained).toBeGreaterThan(0.9); // ~3 min full-to-empty, not seconds
    run(sim, 60 * 6, { dance: true }); // E toggles ON at the first press
    expect(p.dancingNow).toBe(true);
    expect(p.boogie).toBeGreaterThan(drained); // dancing refills it
  }, 30000);

  it('zero boogie = out of the club, with its own reason on the wire', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    parkCrowdFar(sim);
    blindMinions(sim);
    const p = sim.players.get('p0')!;
    p.boogie = 0.001;
    run(sim, 60 * 2);
    expect(p.out).toBe(true);
    expect(p.outWhy).toBe(1);
    expect(sim.snapshot().players['p0'].outWhy).toBe(1);
    expect(sim.snapshot().players['p0'].pos.z).toBeGreaterThan(CONFIG.room.d / 2);
  });

  it('dancing burns the bar faster than standing — and K discounts the difference', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    parkCrowdFar(sim);
    blindMinions(sim);
    const p = sim.players.get('p0')!;
    run(sim, 10);
    p.stamina = 0.9;
    run(sim, 60 * 4, { dance: true });
    const danceCost = 0.9 - p.stamina;
    p.danceOn = false;
    run(sim, 5);
    p.stamina = 0.9;
    run(sim, 60 * 4);
    const idleCost = 0.9 - p.stamina;
    expect(danceCost).toBeGreaterThan(idleCost * 1.8); // dancing costs real energy
    // the same dance, deep on K, costs way less — that trade IS the loop
    p.kLevel = 4;
    p.kFelt = 4;
    p.kLastChange = 1e9;
    p.stamina = 0.9;
    run(sim, 60 * 4, { dance: true });
    const kDanceCost = 0.9 - p.stamina;
    expect(kDanceCost).toBeLessThan(danceCost * 0.5);
  }, 60000);

  it('dancing in the pack hides how wrecked you are (b17)', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    const m = aMinion(sim);
    parkCrowdFar(sim, m); // the parked dancers put the pack center in the +x grid
    const p = sim.players.get('p0')!;
    p.kLevel = 4;
    p.kFelt = 4;
    p.kLastChange = 1e9;
    // stand at the edge of the parked pack, watcher square-on with clear LOS
    // and its gaze PINNED (mode-1 scanning would sweep it away mid-measure)
    p.body.setTranslation({ x: 1.6, y: 0.85, z: 0.9 }, true);
    plantWatcher(m, -0.8, 0.9, Math.PI / 2);
    // start the heavy body already facing them (the yaw servo is slow)
    m.body.setRotation({ x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) }, true);
    const stare = (steps: number, input: Partial<PlayerInput> = {}) => {
      for (let i = 0; i < steps; i++) {
        m.scanYaw = Math.PI / 2;
        const inputs = new Map<string, PlayerInput>();
        inputs.set('p0', { ...ZERO_INPUT, ...input });
        sim.step(inputs);
      }
    };
    stare(20);
    stare(4, { dance: true });
    expect(p.dancingNow).toBe(true);
    p.heat = 0;
    stare(60 * 3, { dance: true });
    const dancingHeat = p.heat;
    p.danceOn = false;
    stare(5);
    p.heat = 0;
    stare(60 * 3);
    const standingHeat = p.heat;
    expect(dancingHeat).toBeLessThan(0.02); // bouncers don't bat an eye
    expect(standingHeat).toBeGreaterThan(dancingHeat); // undanced wreckage still reads
  }, 30000);
});
