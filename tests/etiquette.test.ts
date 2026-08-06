// b15: the bathroom etiquette system (docs/bathroom-etiquette.md) + the
// stamina-ceiling economy. These encode John's rules directly:
// straight line in front of the door, one claimant at a time, no grabbing
// through walls, walking in on someone → stare → fetch a bouncer, sleepers
// in the open get noticed, and the night eats the stamina bar's ceiling.

import { beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { initRapier, Sim, type Character } from '../src/sim/sim';
import { LinePath } from '../src/sim/linePath';
import { maxStamina, ZERO_INPUT, type PlayerInput } from '../src/sim/types';

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

function parkCrowdFar(sim: Sim, except?: Character[]): void {
  sim.npcs.forEach((npc, i) => {
    if (except?.includes(npc)) return;
    const x = 2.2 + (i % 8) * 0.72;
    const z = -0.5 + Math.floor(i / 8) * 0.75;
    npc.body.setTranslation({ x, y: 1.0, z }, true);
    npc.home = { x, z };
    npc.lingerT = 1e9; // pinned — no marching through the scene
  });
  (sim as unknown as { needTimer: number }).needTimer = 1e9;
}

function minions(sim: Sim): Character[] {
  return sim.npcs.filter((n) => n.isMinion);
}

function blindMinions(sim: Sim): void {
  for (const m of minions(sim)) {
    m.body.setTranslation({ x: 7.3, y: 1.0, z: -5.2 }, true);
    m.minionMode = 1;
    m.lingerT = 9999;
    m.scanYaw = 0;
  }
}

function aWalker(sim: Sim, n = 0): Character {
  return sim.npcs.filter((c) => !c.isMinion && !c.isDJ && !c.isDancer)[n];
}

/** silence the global need scheduler where a test needs a stable line */
function stopScheduler(sim: Sim): void {
  (sim as unknown as { needTimer: number }).needTimer = 1e9;
}

/** stop the rest of the club moving — geometry tests measure SLOT positions,
 *  and a live 50-body crowd occasionally bowls a queuer over mid-assert */
function freezeCrowd(sim: Sim, except: Character[]): void {
  for (const npc of sim.npcs) {
    if (except.includes(npc) || npc.isDJ || npc.isDancer) continue;
    if (npc.isMinion) {
      npc.minionMode = 1;
      npc.lingerT = 1e9;
      npc.scanYaw = 0;
    } else {
      npc.lingerT = 1e9; // a lingering walker stands still
    }
  }
}

/** park an NPC mid-business in the stall so nobody can claim the door */
function occupyStall(sim: Sim, n: number): Character {
  const w = aWalker(sim, n);
  w.body.setTranslation({ x: -7.3, y: 1.0, z: 5.1 }, true);
  w.walkerMode = 3;
  w.stallT = 600;
  return w;
}

describe('queue geometry + discipline', () => {
  it('the line is straight, directly in front of the door', () => {
    const B = CONFIG.bathroom;
    const sim = new Sim();
    sim.addPlayer('p0');
    stopScheduler(sim);
    const occ = occupyStall(sim, 5); // door busy → the line HOLDS instead of advancing
    // seed a 3-person line NEAR the door (the cross-room march is not under
    // test — and it occasionally floors a queuer) and let them settle in
    const line: Character[] = [occ];
    for (let i = 0; i < 3; i++) {
      const w = aWalker(sim, i);
      w.body.setTranslation({ x: -5.4 + i * 0.4, y: 1.0, z: 1.6 }, true);
      sim.queue.push(w);
      w.walkerMode = 1;
      line.push(w);
    }
    freezeCrowd(sim, line);
    run(sim, 60 * 25);
    expect(sim.queue.length).toBe(3);
    // every queuer stands ON their invisible square (b16, John: "a straight
    // line...but not a totally straight line" — near-enough-plus-glide left
    // everyone half a spacing off-center). Tight: centered on the door's
    // x-line, centimeters from the slot.
    let prevZ: number = B.innerZ;
    sim.queue.forEach((w, i) => {
      const p = w.pos();
      const s = (sim as unknown as { slotPos(i: number): { x: number; z: number } }).slotPos(i);
      expect(Math.abs(p.x - B.doorMidX)).toBeLessThan(0.2);
      expect(Math.hypot(p.x - s.x, p.z - s.z)).toBeLessThan(0.25);
      expect(p.z).toBeLessThan(prevZ);
      prevZ = p.z;
    });
  }, 60000);

  it('one claimant at a time: a freed stall never causes a pile-in', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    blindMinions(sim);
    for (let i = 0; i < 4; i++) {
      const w = aWalker(sim, i);
      sim.queue.push(w);
      w.walkerMode = 1;
    }
    // cycle the system for a while; at no instant may two bodies be
    // entering/inside the stall at once
    let worstInside = 0;
    for (let i = 0; i < 60 * 90; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      const entering = sim.npcs.filter(
        (n) => n.walkerMode === 2 || n.walkerMode === 3,
      ).length;
      worstInside = Math.max(worstInside, entering);
    }
    expect(worstInside).toBeLessThanOrEqual(1);
  }, 120000);

  it('a player joins only at the BACK and loses their place by leaving', () => {
    const B = CONFIG.bathroom;
    const sim = new Sim();
    sim.addPlayer('p0');
    stopScheduler(sim);
    const occ = occupyStall(sim, 5); // door busy → slots 0 and 1 stay put
    const p = sim.players.get('p0')!;
    const w0 = aWalker(sim, 0);
    const w1 = aWalker(sim, 1);
    for (const w of [w0, w1]) {
      sim.queue.push(w);
      w.walkerMode = 1;
    }
    freezeCrowd(sim, [occ, w0, w1]);
    run(sim, 60 * 12); // let them occupy slots 0 and 1
    // standing beside the FRONT of the line does nothing
    const s0 = { x: B.doorMidX, z: B.innerZ - B.queueGap0 };
    p.body.setTranslation({ x: s0.x + 0.5, y: 0.85, z: s0.z }, true);
    run(sim, 40);
    expect(sim.queue.includes(p)).toBe(false);
    // standing at the TAIL slot joins
    const tail = { x: B.doorMidX, z: B.innerZ - B.queueGap0 - 2 * B.queueDx };
    p.body.setTranslation({ x: tail.x, y: 0.85, z: tail.z }, true);
    run(sim, 40);
    expect(sim.queue.indexOf(p)).toBe(2);
    // walking off loses the place
    p.body.setTranslation({ x: 2, y: 0.85, z: 0 }, true);
    run(sim, 40);
    expect(sim.queue.includes(p)).toBe(false);
  }, 60000);
});

describe('the modular line system (LinePath)', () => {
  it('open floor: the invisible squares run straight from the anchor', () => {
    const sim = new Sim();
    const line = new LinePath(
      sim.world,
      { x: 0, z: 3.0 },
      { x: 0, z: -1 },
      { spacing: 0.7, count: 6, clearance: 0.4 },
    );
    for (let i = 0; i < 6; i++) {
      expect(line.slot(i).x).toBeCloseTo(0, 3);
      expect(line.slot(i).z).toBeCloseTo(3.0 - i * 0.7, 3);
    }
  });

  it('a line aimed at a wall BENDS instead of burying squares in it', () => {
    const sim = new Sim();
    // aim straight at the west wall from two spacings away
    const line = new LinePath(
      sim.world,
      { x: -6.4, z: 0 },
      { x: -1, z: 0 },
      { spacing: 0.7, count: 6, clearance: 0.4 },
    );
    for (let i = 0; i < 6; i++) {
      const s = line.slot(i);
      // every square stays on standable floor, inside the room
      expect(Math.abs(s.x)).toBeLessThan(7.5);
      expect(Math.abs(s.z)).toBeLessThan(5.6);
      if (i > 0) {
        // …and the train never stacks: neighbours keep their spacing
        const prev = line.slot(i - 1);
        expect(Math.hypot(s.x - prev.x, s.z - prev.z)).toBeGreaterThan(0.5);
      }
    }
    // it genuinely turned: the tail is nowhere near the straight-line target
    const tail = line.slot(5);
    expect(tail.x).toBeGreaterThan(-8 + 0.4);
  });
});

describe('honest hands', () => {
  it('a barger cannot grab the occupant through the wall or closed door', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    blindMinions(sim);
    const p = sim.players.get('p0')!;
    p.body.setTranslation({ x: -7.2, y: 0.85, z: 5.0 }, true);
    run(sim, 10);
    // a walker in barge mode parked right against the OUTSIDE of the stall
    // wall, within old-grab range of the occupant through the partition
    const w = aWalker(sim, 0);
    w.body.setTranslation({ x: -6.9, y: 1.0, z: 3.6 }, true);
    run(sim, 5); // the pressure system registers the occupant itself
    w.walkerMode = 5;
    const B = CONFIG.bathroom;
    const inStall = (pos: { x: number; z: number }) =>
      pos.x < B.innerX - 0.1 && pos.z > B.innerZ + 0.1;
    let hadGrip = false;
    for (let i = 0; i < 60 * 10; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      // the moment a grip STARTS the walker must be inside the stall — never
      // through the wall it started behind. (Once gripped, dragging the
      // occupant OUT is the whole point, so only the start frame is checked.)
      if (w.grip && !hadGrip) expect(inStall(w.pos())).toBe(true);
      hadGrip = !!w.grip;
    }
  }, 30000);
});

describe('walking in on someone', () => {
  it('the occupant stares, gets angry brows, then fetches a bouncer', () => {
    const B = CONFIG.bathroom;
    const sim = new Sim();
    sim.addPlayer('p0');
    stopScheduler(sim); // no queue forming mid-scene — the intrusion is the test
    const ms = minions(sim);
    parkCrowdFar(sim, [...ms, aWalker(sim, 0)]);
    // a free minion STANDING mid-room (a patroller can wander far enough
    // that the 25 s fetch give-up fires — that fallback is not under test)
    ms[0].body.setTranslation({ x: -3.5, y: 1.0, z: 1.5 }, true);
    ms[0].minionMode = 1;
    ms[0].lingerT = 9999;
    ms[0].scanYaw = 0;
    for (const m of [ms[1], ms[2]]) {
      m.body.setTranslation({ x: 7.3, y: 1.0, z: -5.2 }, true);
      m.minionMode = 1;
      m.lingerT = 9999;
      m.scanYaw = 0;
    }
    // an NPC mid-business in the stall
    const w = aWalker(sim, 0);
    w.body.setTranslation({ x: -7.3, y: 1.0, z: 5.1 }, true);
    w.walkerMode = 3;
    w.stallT = 60; // long visit so the clock doesn't end the scene
    // the player barges in and STAYS
    const p = sim.players.get('p0')!;
    p.body.setTranslation({ x: -6.6, y: 0.85, z: 4.6 }, true);
    let annoyed = false;
    let fetched = false;
    let handoff = false;
    for (let i = 0; i < 60 * 60 && !handoff; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      // hold the player in place (the drag would otherwise move them)
      if (i % 30 === 0 && !handoff) {
        p.body.setTranslation({ x: -6.6, y: 0.85, z: 4.6 }, true);
        p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
      if (w.annoyT > 1) annoyed = true;
      if ((w.walkerMode as number) === 6) fetched = true; // sim.step mutates it — TS can't see that
      if (ms.some((m) => m.minionMode === 4)) handoff = true;
    }
    expect(annoyed).toBe(true); // the stare built up
    expect(fetched).toBe(true); // they left to get the muscle
    expect(handoff).toBe(true); // "problem type understood" → stall protocol
    expect(B.annoyAt).toBeGreaterThan(1); // leaving quickly must stay survivable
  }, 90000);
});

describe('sleepers get noticed', () => {
  it('falling asleep in the open draws a minion', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    const ms = minions(sim);
    parkCrowdFar(sim, ms);
    const p = sim.players.get('p0')!;
    // asleep mid-floor; a patrolling minion passes within viewRange but
    // FACING AWAY — the cone is waived for a body on the floor
    p.body.setTranslation({ x: -1.5, y: 0.85, z: 2.0 }, true);
    ms[0].body.setTranslation({ x: -1.5, y: 1.0, z: 4.5 }, true);
    ms[0].minionMode = 1;
    ms[0].lingerT = 9999;
    ms[0].scanYaw = Math.PI; // staring at the far wall, away from the sleeper
    ms[1].body.setTranslation({ x: 7.3, y: 1.0, z: -5.2 }, true);
    ms[2].body.setTranslation({ x: 7.3, y: 1.0, z: -4.4 }, true);
    run(sim, 10);
    p.stamina = 0.005;
    let hunted = false;
    for (let i = 0; i < 60 * 30 && !hunted; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      if (ms.some((m) => m.minionMode === 2 && m.huntTarget === p)) hunted = true;
    }
    expect(p.staminaDown).toBe(true);
    expect(hunted).toBe(true);
  }, 60000);
});

describe('minion aggro', () => {
  it('a grabbed minion turns to face you and cools off GRADUALLY', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    const ms = minions(sim);
    parkCrowdFar(sim, ms);
    blindMinions(sim);
    const m = ms[0];
    m.body.setTranslation({ x: -2, y: 1.0, z: 2.9 }, true);
    m.minionMode = 0;
    m.lingerT = 0;
    m.scanYaw = null;
    const p = sim.players.get('p0')!;
    p.body.setTranslation({ x: -2, y: 0.85, z: 2.0 }, true);
    run(sim, 10);
    run(sim, 90, { grab: true, faceYaw: 0 }); // hold them for 1.5 s
    expect(m.aggro).toBeGreaterThan(0.5);
    expect(m.aggroTarget).toBe(p);
    expect(sim.snapshot().npcs[sim.npcs.indexOf(m)].watch).toBeGreaterThan(0.5);
    // release: the glare fades slowly, never snapping to zero
    run(sim, 60 * 2);
    const after2s = m.aggro;
    expect(after2s).toBeGreaterThan(0.3); // still visibly hot 2 s later
    run(sim, 60 * 6);
    expect(m.aggro).toBeLessThan(after2s); // …and genuinely cooling
  }, 30000);
});

describe('the stamina economy (b15)', () => {
  it('the ceiling shrinks across the night and clamps the bar', () => {
    expect(maxStamina(0)).toBeCloseTo(CONFIG.night.maxStart, 5);
    expect(maxStamina(CONFIG.night.length)).toBeCloseTo(CONFIG.night.maxEnd, 5);
    const sim = new Sim();
    sim.addPlayer('p0');
    parkCrowdFar(sim);
    blindMinions(sim);
    const p = sim.players.get('p0')!;
    sim.nightT = CONFIG.night.length * 0.9;
    p.stamina = 1;
    run(sim, 5);
    expect(p.stamina).toBeLessThanOrEqual(maxStamina(sim.nightT) + 0.001);
  });

  it('being high on K slows the drain — the late-night survival mechanism', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    parkCrowdFar(sim);
    blindMinions(sim);
    const p = sim.players.get('p0')!;
    p.body.setTranslation({ x: -6.5, y: 0.85, z: -1.0 }, true);
    run(sim, 10);
    p.stamina = 0.3;
    p.kFelt = 0;
    p.kLevel = 0;
    run(sim, 60 * 5);
    const soberDrain = 0.3 - p.stamina;
    p.stamina = 0.3;
    p.kFelt = 4;
    p.kLevel = 4;
    p.kLastChange = 1e9; // hold the level steady for the measurement
    run(sim, 60 * 5);
    const highDrain = 0.3 - p.stamina;
    expect(highDrain).toBeLessThan(soberDrain * 0.5);
  }, 30000);

  it('design guardrails: sober play carries the early night, cannot carry the end', () => {
    const N = CONFIG.night;
    // early: a full sober bar lasts several minutes — drugs are optional
    expect(N.maxStart / N.drain).toBeGreaterThan(200);
    // late: a full sober mini-bar dies in under two minutes — you MUST ride
    expect(N.maxEnd / N.drain).toBeLessThan(120);
    // riding deep (felt 4) more than triples the late bar's life
    const rideMult = 1 / Math.max(N.kDrainFloor, 1 - N.kDrainSlowPerLevel * 4);
    expect(rideMult).toBeGreaterThan(3);
    // one bump is a real chunk of the late-night bar but a minor top-up early
    expect(N.bumpRefill / N.maxEnd).toBeGreaterThan(0.5);
    expect(N.bumpRefill / N.maxStart).toBeLessThan(0.3);
  });
});

// b16: the roaming crowd — walkers FILL the club (the lap ellipse clustered
// everyone near the exit and never touched the corners), and everyone not in
// a line keeps clear of its invisible squares.
describe('crowd roaming', () => {
  type SimInternals = {
    pickRoamSpot(
      others: { x: number; z: number }[],
      self: Character | null,
    ): { x: number; z: number };
    slotPos(i: number): { x: number; z: number };
  };

  it('roam destinations cover the whole floor — stage-side corners included', () => {
    const sim = new Sim();
    const R = CONFIG.room;
    const S = R.stage;
    const picks: { x: number; z: number }[] = [];
    for (let i = 0; i < 200; i++) {
      picks.push((sim as unknown as SimInternals).pickRoamSpot([], null));
    }
    for (const p of picks) {
      // never in the stall, never on the stage
      expect(p.x < CONFIG.bathroom.innerX - 0.1 && p.z > CONFIG.bathroom.innerZ + 0.1).toBe(false);
      expect(
        Math.abs(p.x - S.x) < S.w / 2 + 0.55 && Math.abs(p.z - S.z) < S.d / 2 + 0.55,
      ).toBe(false);
    }
    // all four quadrants get destinations — and specifically the deep
    // stage-side corners John never saw anyone in
    expect(picks.some((p) => p.x < -2 && p.z < -2)).toBe(true);
    expect(picks.some((p) => p.x > 2 && p.z < -2)).toBe(true);
    expect(picks.some((p) => p.x < -2 && p.z > 2)).toBe(true);
    expect(picks.some((p) => p.x > 2 && p.z > 2)).toBe(true);
    expect(picks.some((p) => p.x < -4.2 && p.z < -3)).toBe(true);
    expect(picks.some((p) => p.x > 4.2 && p.z < -3)).toBe(true);
  });

  it('roam destinations never park against an occupied line', () => {
    const sim = new Sim();
    stopScheduler(sim);
    occupyStall(sim, 5);
    for (let i = 0; i < 3; i++) {
      const w = aWalker(sim, i);
      sim.queue.push(w);
      w.walkerMode = 1;
    }
    const internals = sim as unknown as SimInternals;
    for (let i = 0; i < 120; i++) {
      const p = internals.pickRoamSpot([], null);
      let nd = Infinity;
      for (let s = 0; s < sim.queue.length; s++) {
        const sp = internals.slotPos(s);
        nd = Math.min(nd, Math.hypot(p.x - sp.x, p.z - sp.z));
      }
      expect(nd).toBeGreaterThanOrEqual(CONFIG.crowd.roam.lineAvoid);
    }
  });

  it('walkers actually visit the stage-side corners over time', () => {
    const sim = new Sim();
    sim.addPlayer('p0');
    let left = 0;
    let right = 0;
    for (let i = 0; i < 60 * 75; i++) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set('p0', { ...ZERO_INPUT });
      sim.step(inputs);
      if (i % 30 !== 0) continue;
      for (const n of sim.npcs) {
        if (n.isDancer || n.isDJ || n.isMinion) continue;
        const p = n.pos();
        if (p.z < -2.6 && p.x < -4) left++;
        if (p.z < -2.6 && p.x > 4) right++;
      }
    }
    expect(left).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(0);
  }, 120000);
});
