// Headless simulation. Rapier only — no three.js (must run in Node for tests).
//
// The whole Build-1 bet: every character is a DYNAMIC capsule held upright by a
// limited-strength PD spring. Movement is force-based, so crowd bumps genuinely
// displace you; a hard enough hit (or too much tilt) overwhelms the spring and
// you ragdoll, flop for a while, then wobble back to your feet.
//
// There is deliberately NO shove verb (John cut it: fun but purposeless — it
// only tempted you into trouble). Bodies are still weapons: sprint-jump into
// someone and the momentum exchange floors them (and often you) emergently.

import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import {
  targetItemIndex,
  ZERO_INPUT,
  type BodySnap,
  type BodyState,
  type GameEvent,
  type ItemKind,
  type ItemSnap,
  type PlayerInput,
  type SimSnapshot,
} from './types';

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

interface CharCfg {
  radius: number;
  halfHeight: number;
  mass: number;
  uprightKp: number;
  uprightKd: number;
  maxTorque: number;
  moveSpeed: number;
  accelGain: number;
  maxAccel: number;
}

export interface Item {
  kind: ItemKind;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  holder: Character | null;
  holderId: string | null;
  doses: number;
}

export class Character {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  pid = ''; // player id ('' for NPCs) — item snapshots name their holder
  state: BodyState = 0;
  stateT = 0; // time in current state
  hitAccum = 0; // recent received impulse (decays) — knockdown trigger
  staggerT = 0; // motor control cut after real impacts — makes knockback READ
  wantGrab = false; // player holding grab — arms reach out even on a whiff
  hopCd = 0;
  /** universal grip: any solid body, stuck at the exact contact point */
  grip: { body: RAPIER.RigidBody; local: { x: number; y: number; z: number } } | null = null;
  // items in hand
  holding: Item | null = null;
  prevGrab = false; // pickup fires on the RMB edge, not every held frame
  prevDrop = false;
  dropT = 0; // how long Q has been held — tap drops, a hold charges a throw
  useT = 0; // progress through the committed bump animation
  prevUse = false; // bumps fire on the LMB EDGE — holding does nothing
  dosing = false;
  // ketamine (players only)
  kLevel = 0; // true level 0..5
  kFelt = 0; // eased level the effects run off — arrives/fades smoothly
  kPending: number[] = []; // sim-times at which taken bumps HIT (onset delay)
  kLastChange = 0;
  kDriftPhase = Math.random() * Math.PI * 2;
  kInX = 0; // smoothed move input while high — the "kept walking" overshoot
  kInZ = 0;
  swayPhase = Math.random() * Math.PI * 2;
  prevVx = 0; // last step's horizontal velocity — impact detection
  prevVz = 0;
  // THE NIGHT (players)
  stamina = 1;
  staminaDown = false; // bar hit empty — folded up, sleeping it off
  out = false; // ejected. it's over.
  heat = 0; // Curator suspicion 0..1
  heatObs = false; // observed doing something ejectable this step
  watchSignal = 0; // players: how watched · minions: how hard they're watching
  checkedBy: Character | null = null; // who body-checked us last (blame)
  checkedAt = -10;
  // NPC brain
  home: { x: number; z: number };
  dancePhase = 0; // which beat this NPC hits
  isDJ = false; // mans the booth: no wandering, no hopping, walks back if moved
  isMinion = false; // the Curator's: silent, black-clad, watching
  minionMode: 0 | 1 | 2 = 0; // patrol · scanning pause · hunting
  scanYaw: number | null = null;
  scanT = 0;
  huntTarget: Character | null = null;
  // walker flow: position on the lap circuit
  loopAng = 0;
  loopDir = 1;
  lingerT = 0;
  flowT = 0;
  // walker bathroom need
  walkerMode: 0 | 1 | 2 | 3 | 4 = 0; // flow · queueing · entering · in stall · leaving
  needT = 0;
  stallT = 0;

  constructor(
    world: RAPIER.World,
    public cfg: CharCfg,
    x: number,
    z: number,
    public isPlayer: boolean,
    danceSlot = 0,
  ) {
    const y = cfg.halfHeight + cfg.radius + 0.05;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setLinearDamping(CONFIG.body.linearDamping)
      .setAngularDamping(CONFIG.body.angularDamping)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(desc);
    const col = RAPIER.ColliderDesc.capsule(cfg.halfHeight, cfg.radius)
      .setFriction(CONFIG.body.friction)
      // Min, not the default Average: otherwise the floor's 0.5 drags our 0.03
      // up to ~0.27 and the friction torque tips runners into a permanent lean
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setRestitution(CONFIG.body.restitution)
      .setDensity(0);
    this.collider = world.createCollider(col, this.body);
    this.collider.setMass(cfg.mass);
    this.home = { x, z };
    this.dancePhase = danceSlot;
  }

  pos(): RAPIER.Vector3 {
    return this.body.translation();
  }
}

export class Sim {
  world!: RAPIER.World;
  time = 0;
  nightT = 0; // seconds into the compressed Klubnacht
  phase: 0 | 1 = 0; // 1 = closing time — survivors made it
  players = new Map<string, Character>();
  npcs: Character[] = [];
  items: Item[] = [];
  doorBody!: RAPIER.RigidBody; // the stall door — a real hinged body
  /** the bathroom line, NPCs and players alike, front first */
  queue: Character[] = [];
  /** live center of the dancing mass — dancers lump toward each other */
  private packCenter: { x: number; z: number } = {
    x: CONFIG.crowd.danceZone.x,
    z: CONFIG.crowd.danceZone.z,
  };
  lastEvents: GameEvent[] = [];
  private eventQueue: GameEvent[] = [];

  /** Call after initRapier() resolves. */
  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = CONFIG.sim.dt;
    this.buildRoom();
    this.spawnCrowd();
    this.spawnItems();
  }

  private buildRoom(): void {
    const R = CONFIG.room;
    const fixed = (x: number, y: number, z: number) =>
      this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    // floor
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(R.w / 2 + 1, 0.5, R.d / 2 + 1),
      fixed(0, -0.5, 0),
    );
    // walls (visible in render — physics honesty, colliders match visuals)
    const wh = R.wallH / 2;
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(R.w / 2, wh, 0.15), fixed(0, wh, -R.d / 2));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(R.w / 2, wh, 0.15), fixed(0, wh, R.d / 2));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.15, wh, R.d / 2), fixed(-R.w / 2, wh, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.15, wh, R.d / 2), fixed(R.w / 2, wh, 0));
    // pillars
    for (const p of R.pillars) {
      this.world.createCollider(
        RAPIER.ColliderDesc.cylinder(wh, R.pillarR),
        fixed(p.x, wh, p.z),
      );
    }
    // stage
    const s = R.stage;
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(s.w / 2, s.h / 2, s.d / 2),
      fixed(s.x, s.h / 2, s.z),
    );
    // DJ board on the stage — solid like everything else: grabbable, vaultable
    const dj = R.dj;
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(dj.boardW / 2, dj.boardH / 2, dj.boardD / 2),
      fixed(dj.x, s.h + dj.boardH / 2, dj.boardZ),
    );
    // everything that LOOKS solid IS solid (John caught ghost booth gear):
    // the board's top slab, the decks/mixer sitting on it, the speaker stacks
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid((dj.boardW + 0.12) / 2, 0.025, (dj.boardD + 0.12) / 2),
      fixed(dj.x, s.h + dj.boardH + 0.025, dj.boardZ),
    );
    for (const ox of [-0.55, 0, 0.55]) {
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(ox === 0 ? 0.15 : 0.21, 0.03, 0.17),
        fixed(dj.x + ox, s.h + dj.boardH + 0.08, dj.boardZ),
      );
    }
    for (const sx of [-s.w / 2 + 0.7, s.w / 2 - 0.7]) {
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.55, 1.1, 0.5),
        fixed(s.x + sx, s.h + 1.1, s.z - 0.3),
      );
    }
    // bathroom stall in the -x/+z corner: two partition walls (tall enough to
    // kill every line of sight), a toilet, and a REAL hinged door
    const B = CONFIG.bathroom;
    const wallLen = B.doorHingeX - -R.w / 2;
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(wallLen / 2, 1.15, 0.06),
      fixed(-R.w / 2 + wallLen / 2, 1.15, B.innerZ),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.06, 1.15, (R.d / 2 - B.innerZ) / 2),
      fixed(B.innerX, 1.15, B.innerZ + (R.d / 2 - B.innerZ) / 2),
    );
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.22, 0.25, 0.22), fixed(-7.4, 0.25, 5.45));
    // the door: dynamic panel on a revolute hinge with a weak return spring
    // (applied each step). Grab it, shoulder it, hold it shut on someone.
    const hinge = fixed(B.doorHingeX, B.doorH / 2, B.innerZ);
    this.doorBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(B.doorHingeX + B.doorW / 2, B.doorH / 2, B.innerZ)
        .setAngularDamping(1.6)
        .setCcdEnabled(true),
    );
    const doorCol = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(B.doorW / 2, B.doorH / 2, 0.03).setFriction(0.25).setDensity(0),
      this.doorBody,
    );
    doorCol.setMass(7);
    const jd = RAPIER.JointData.revolute(
      { x: 0, y: 0, z: 0 },
      { x: -B.doorW / 2, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    );
    jd.limitsEnabled = true;
    jd.limits = [-1.9, 1.9];
    this.world.createImpulseJoint(jd, hinge, this.doorBody, true);
  }

  /** current door swing, radians off closed */
  doorAngle(): number {
    return yawOf(this.doorBody.rotation());
  }

  /** inside the stall footprint (walls + door do the physical enforcement) */
  private inStall(p: { x: number; z: number }): boolean {
    return p.x < CONFIG.bathroom.innerX - 0.1 && p.z > CONFIG.bathroom.innerZ + 0.1;
  }

  private slotPos(i: number): { x: number; z: number } {
    const B = CONFIG.bathroom;
    return { x: B.queueStart.x + i * B.queueDx, z: B.queueStart.z };
  }

  private stallOccupied(): boolean {
    for (const ch of this.allChars()) {
      if (!ch.out && this.inStall(ch.pos())) return true;
    }
    return false;
  }

  private spawnCrowd(): void {
    const C = CONFIG.crowd;
    const cfg: CharCfg = {
      radius: C.radius,
      halfHeight: C.halfHeight,
      mass: C.mass,
      uprightKp: C.uprightKp,
      uprightKd: C.uprightKd,
      maxTorque: C.maxTorque,
      moveSpeed: C.moveSpeed,
      accelGain: C.accelGain,
      maxAccel: C.maxAccel,
    };
    for (let i = 0; i < C.count; i++) {
      // dancers spawn packed in the dance zone, walkers on the lap circuit,
      // and the LAST index is the DJ behind the board
      const isDJ = i === C.count - 1;
      const walkerAng = Math.random() * Math.PI * 2;
      const spot = isDJ
        ? { x: CONFIG.room.dj.x, z: CONFIG.room.dj.z }
        : i < C.dancers
          ? this.danceSpot()
          : this.flowSpot(walkerAng);
      const npc = new Character(this.world, cfg, spot.x, spot.z, false, i % C.danceEveryBeats);
      if (isDJ) {
        npc.isDJ = true;
        // the booth is up on the stage
        const p = npc.body.translation();
        npc.body.setTranslation({ x: p.x, y: p.y + CONFIG.room.stage.h, z: p.z }, true);
      } else if (i >= C.dancers) {
        npc.loopAng = walkerAng;
        npc.loopDir = Math.random() < C.flow.ccwShare ? 1 : -1;
        npc.flowT = randRange(...C.flow.lingerEvery);
        if (i >= C.dancers + C.walkers) {
          // the Curator's minions patrol the edges, silent, in black
          npc.isMinion = true;
          npc.scanT = randRange(...CONFIG.curator.scanEvery);
        } else {
          npc.needT = randRange(...CONFIG.bathroom.npcNeedEvery);
        }
      }
      this.npcs.push(npc);
    }
  }

  private spawnItems(): void {
    // the first object in the game: a small bag of K on the DJ stand
    const I = CONFIG.items;
    const dj = CONFIG.room.dj;
    const s = CONFIG.room.stage;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(dj.x - 0.3, s.h + dj.boardH + 0.12, dj.boardZ + 0.02)
        .setLinearDamping(0.4)
        .setAngularDamping(1.2)
        .setCcdEnabled(true),
    );
    const col = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(I.kbag.w / 2, I.kbag.h / 2, I.kbag.d / 2)
        .setFriction(0.6)
        .setRestitution(0.1)
        .setDensity(0),
      body,
    );
    col.setMass(I.kbag.mass);
    this.items.push({
      kind: 0,
      body,
      collider: col,
      holder: null,
      holderId: null,
      doses: CONFIG.ketamine.dosesPerBag,
    });
  }

  private danceSpot(): { x: number; z: number } {
    const Z = CONFIG.crowd.danceZone;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * Z.r;
    return { x: Z.x + Math.cos(a) * r, z: Z.z + Math.sin(a) * r };
  }

  /** a point on the walkers' lap circuit: an ellipse inside the walls, pushed
   *  off the stage front so the stream doesn't march into the plinth */
  private flowSpot(a: number): { x: number; z: number } {
    const R = CONFIG.room;
    const m = CONFIG.crowd.flow.margin;
    const x = Math.cos(a) * (R.w / 2 - m);
    let z = Math.sin(a) * (R.d / 2 - m);
    if (z < -3.1 && Math.abs(x) < R.stage.w / 2 + 0.7) z = -3.1;
    return { x, z };
  }

  addPlayer(id: string): void {
    if (this.players.has(id)) return;
    const B = CONFIG.body;
    const cfg: CharCfg = {
      radius: B.radius,
      halfHeight: B.halfHeight,
      mass: B.mass,
      uprightKp: B.uprightKp,
      uprightKd: B.uprightKd,
      maxTorque: B.maxTorque,
      moveSpeed: B.moveSpeed,
      accelGain: B.accelGain,
      maxAccel: B.maxAccel,
    };
    const n = this.players.size;
    const p = new Character(this.world, cfg, -2 + n * 2, CONFIG.room.d / 2 - 1.6, true);
    p.pid = id;
    this.players.set(id, p);
  }

  removePlayer(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    for (const other of this.allChars()) {
      if (other.grip?.body === p.body) this.releaseGrip(other);
    }
    this.releaseGrip(p);
    if (p.holding) this.releaseItem(p, 0, null);
    this.world.removeRigidBody(p.body);
    this.players.delete(id);
  }

  private allChars(): Character[] {
    return [...this.players.values(), ...this.npcs];
  }

  step(inputs: Map<string, PlayerInput>): void {
    const dt = CONFIG.sim.dt;
    this.time += dt;
    this.eventQueue = [];

    // the night rolls on
    if (this.phase === 0) {
      this.nightT += dt;
      if (this.nightT >= CONFIG.night.length) this.phase = 1; // closing time
    }

    // Rapier forces/torques PERSIST until reset — clear last step's before re-adding
    for (const ch of this.allChars()) {
      ch.body.resetForces(true);
      ch.body.resetTorques(true);
    }
    this.doorBody.resetForces(true);
    this.doorBody.resetTorques(true);
    // stall door swings itself shut
    const B = CONFIG.bathroom;
    const dAng = this.doorAngle();
    this.doorBody.addTorque(
      { x: 0, y: -dAng * B.doorSpring - this.doorBody.angvel().y * B.doorDamp, z: 0 },
      true,
    );

    for (const [id, ch] of this.players) {
      this.updateCharacter(ch, inputs.get(id) ?? ZERO_INPUT, dt);
    }
    this.updatePackCenter();
    this.updateQueue();
    for (const npc of this.npcs) {
      this.updateNpcBrain(npc, dt);
    }
    this.updateCurator(dt);
    this.applyCrowdSeparation(dt);
    this.updateGrips();
    this.updateHeldItems();

    this.world.step();

    // post-step: knockdown checks from tilt (velocity/impulse checks live in updateCharacter)
    for (const ch of this.allChars()) this.postStep(ch, dt);

    this.lastEvents = this.eventQueue;
  }

  // ---------- character control ----------

  private updateCharacter(ch: Character, input: PlayerInput, dt: number): void {
    if (ch.out) input = ZERO_INPUT; // ejected: nobody home
    ch.stateT += dt;
    ch.hopCd = Math.max(0, ch.hopCd - dt);
    ch.staggerT = Math.max(0, ch.staggerT - dt);
    ch.hitAccum = Math.max(0, ch.hitAccum - (CONFIG.balance.impulseFall / CONFIG.balance.impulseWindow) * dt);

    if (ch.isPlayer) this.updateKetamine(ch, input, dt);
    if (ch.isPlayer && !ch.out) this.updateStamina(ch, input, dt);

    if (ch.state === 1) {
      // down: floppy. get-up timer — unless you're in the k-hole (down until
      // the level decays) or your bar is empty (asleep until it refills).
      if (
        ch.stateT >= CONFIG.balance.downTime &&
        ch.kLevel < CONFIG.ketamine.maxLevel &&
        !ch.staminaDown
      ) {
        ch.state = 2;
        ch.stateT = 0;
        ch.body.setAngularDamping(CONFIG.body.angularDamping);
        // restore the slidey character capsule — the down-state friction/drag
        // that stops toboggan slides would fight the wobbly rise
        ch.body.setLinearDamping(CONFIG.body.linearDamping);
        ch.collider.setFriction(CONFIG.body.friction);
        const v = ch.body.linvel();
        ch.body.setLinvel({ x: v.x, y: v.y + CONFIG.balance.getupNudge, z: v.z }, true);
        this.emit({ t: 'getup', ...vec(ch.pos()) });
      }
      return; // no control while down
    }
    if (ch.state === 2 && ch.stateT >= CONFIG.balance.getupRamp) {
      // hand control back only once ACTUALLY upright — a timer-only transition
      // re-floored anyone whose rise ran a beat long (tall NPCs: infinite
      // knockdown loop, "flopping around on the floor" in John's playtest)
      const upNow = rotateVec(ch.body.rotation(), { x: 0, y: 1, z: 0 }).y;
      const standCos = Math.cos((CONFIG.balance.tiltFallDeg * 0.7 * Math.PI) / 180);
      if (upNow > standCos) {
        ch.state = 0;
        ch.stateT = 0;
      } else if (ch.stateT >= CONFIG.balance.getupMaxTime) {
        // wedged (under a pile, against a wall) — flop back down, retry later
        this.knockDown(ch);
      }
    }

    // ketamine input distortion: a small press carries further than intended
    // and skews sideways — the intent filter, not a canned animation
    let mvX = input.moveX;
    let mvZ = input.moveZ;
    if (ch.isPlayer && ch.kFelt > 0.02) {
      const K = CONFIG.ketamine;
      const pressing =
        Math.hypot(input.moveX, input.moveZ) >= Math.hypot(ch.kInX, ch.kInZ) - 1e-3;
      const tau = K.inputAttack + (pressing ? 0 : K.inputReleasePerLevel * ch.kFelt);
      const alpha = 1 - Math.exp(-dt / Math.max(tau, 1e-3));
      ch.kInX += (input.moveX - ch.kInX) * alpha;
      ch.kInZ += (input.moveZ - ch.kInZ) * alpha;
      const w = Math.min(1, ch.kFelt);
      const ex = input.moveX * (1 - w) + ch.kInX * w;
      const ez = input.moveZ * (1 - w) + ch.kInZ * w;
      const ang =
        Math.sin(this.time * Math.PI * 2 * K.driftHz + ch.kDriftPhase) *
        K.driftAngPerLevel *
        ch.kFelt;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      mvX = ex * ca - ez * sa;
      mvZ = ex * sa + ez * ca;
    } else {
      ch.kInX = input.moveX;
      ch.kInZ = input.moveZ;
    }
    const eff: PlayerInput = mvX === input.moveX && mvZ === input.moveZ
      ? input
      : { ...input, moveX: mvX, moveZ: mvZ };

    // upright spring (ramped during get-up so the rise is a wobble, not a snap;
    // cut while staggered so hits produce a visible flail)
    const staggered = ch.staggerT > 0;
    const springScale =
      (ch.state === 2 ? Math.min(1, ch.stateT / CONFIG.balance.getupRamp) : 1) *
      (ch.grip ? CONFIG.grab.holderKpMult : 1) *
      (staggered ? CONFIG.balance.staggerSpringMult : 1);
    this.applyUprightSpring(ch, springScale, eff, dt);

    // movement force toward desired velocity — staggered bodies lose their
    // motor control, which is what lets a body check actually LAND
    const grounded = this.isGrounded(ch);
    const speedMult =
      (ch.grip ? CONFIG.grab.holderSpeedMult : 1) *
      (input.sprint && ch.isPlayer && !ch.grip ? CONFIG.body.sprintMult : 1) *
      (ch.isPlayer ? Math.max(0.3, 1 - CONFIG.ketamine.speedPenalty * ch.kFelt) : 1);
    const targetVx = mvX * ch.cfg.moveSpeed * speedMult;
    const targetVz = mvZ * ch.cfg.moveSpeed * speedMult;
    const v = ch.body.linvel();
    let fx = (targetVx - v.x) * ch.cfg.mass * ch.cfg.accelGain;
    let fz = (targetVz - v.z) * ch.cfg.mass * ch.cfg.accelGain;
    const maxF =
      ch.cfg.mass *
      ch.cfg.maxAccel *
      (grounded ? 1 : CONFIG.body.airControl) *
      (staggered ? CONFIG.balance.staggerMoveMult : 1);
    const fmag = Math.hypot(fx, fz);
    if (fmag > maxF) {
      fx = (fx / fmag) * maxF;
      fz = (fz / fmag) * maxF;
    }
    ch.body.addForce({ x: fx, y: 0, z: fz }, true);

    // hop
    if (input.hop && grounded && ch.hopCd <= 0 && !staggered) {
      const lv = ch.body.linvel();
      ch.body.setLinvel({ x: lv.x, y: CONFIG.body.hopVel, z: lv.z }, true);
      ch.hopCd = CONFIG.body.hopCooldown;
    }

    if (ch.isPlayer) this.updateItemVerbs(ch, input, dt);
  }

  /** RMB: items first (Peak-style pickup, incl. stealing from hands), then the
   *  universal body-grab. Q: tap to drop, hold to charge a throw. LMB: use
   *  what's in your hand — for the K bag, hold to take a bump. */
  private updateItemVerbs(ch: Character, input: PlayerInput, dt: number): void {
    // pickup on the RMB edge only — held RMB must not vacuum the bag back
    // into your hand the instant you drop it
    const grabEdge = input.grab && !ch.prevGrab;
    if (grabEdge && !ch.holding && ch.state === 0) {
      const idx = this.targetItemFor(ch, input);
      if (idx >= 0) this.pickupItem(ch, this.items[idx]);
    }
    // universal grip only with a free hand
    ch.wantGrab = input.grab && !ch.holding;
    if (input.grab && !ch.grip && !ch.holding) this.tryGrab(ch, input);
    else if ((!input.grab || ch.holding) && ch.grip) this.releaseGrip(ch);
    ch.prevGrab = input.grab;

    // drop / charged throw
    if (ch.holding) {
      if (input.drop) {
        ch.dropT = Math.min(ch.dropT + dt, CONFIG.items.throwChargeMax);
      } else if (ch.prevDrop) {
        const I = CONFIG.items;
        if (ch.dropT < I.throwChargeMin) {
          this.releaseItem(ch, 0, input);
        } else {
          const c = Math.min(
            1,
            (ch.dropT - I.throwChargeMin) / (I.throwChargeMax - I.throwChargeMin),
          );
          this.releaseItem(ch, I.throwSpeed[0] + (I.throwSpeed[1] - I.throwSpeed[0]) * c, input, true);
        }
        ch.dropT = 0;
      }
    } else {
      ch.dropT = 0;
    }
    ch.prevDrop = input.drop;

    // a bump is a COMMITTED one-shot (John): the LMB edge starts the set
    // animation — bag up, sniff mid-way, bag back down, dose applies at the
    // end. Holding longer does nothing; release and press again for another.
    const KT = CONFIG.ketamine;
    const useEdge = input.use && !ch.prevUse;
    if (
      !ch.dosing &&
      useEdge &&
      ch.holding &&
      ch.holding.kind === 0 &&
      ch.holding.doses > 0 &&
      ch.state === 0
    ) {
      ch.dosing = true;
      ch.useT = 0;
    }
    if (ch.dosing) {
      if (!ch.holding || ch.state !== 0) {
        ch.dosing = false; // floored, or the bag got snatched mid-bump: no dose
        ch.useT = 0;
      } else {
        const prev = ch.useT;
        ch.useT += dt;
        const sniffT = KT.doseAnimTime * KT.doseSniffAt;
        if (prev < sniffT && ch.useT >= sniffT) this.emit({ t: 'dose', ...vec(ch.pos()) });
        if (ch.useT >= KT.doseAnimTime) {
          ch.dosing = false;
          ch.useT = 0;
          ch.holding.doses--;
          ch.kPending.push(this.time + KT.onsetDelay);
          // the POINT of the bump: the bar comes back
          ch.stamina = Math.min(1, ch.stamina + CONFIG.night.bumpRefill);
        }
      }
    }
    ch.prevUse = input.use;
  }

  /** THE bar. Drain ramps across the night (the central conflict: early you
   *  barely need anything, by the end you're redosing constantly). Sprinting
   *  burns it. Being high slows it. Empty = you fold up and sleep where you
   *  stand — eject bait — until it creeps back over the stand threshold. */
  private updateStamina(ch: Character, input: PlayerInput, dt: number): void {
    const N = CONFIG.night;
    if (ch.state === 1) {
      if (ch.staminaDown) {
        ch.stamina = Math.min(1, ch.stamina + N.collapseRegen * dt);
        if (ch.stamina >= N.standAt) ch.staminaDown = false;
      }
      return; // ragdolls don't burn the bar
    }
    if (this.phase === 1) return;
    const prog = Math.min(1, this.nightT / N.length);
    let drain =
      (N.drainStart + (N.drainEnd - N.drainStart) * prog) *
      Math.max(0.35, 1 - N.kDrainSlowPerLevel * ch.kFelt);
    if (input.sprint && Math.hypot(input.moveX, input.moveZ) > 0.1) drain *= N.sprintDrainMult;
    ch.stamina = Math.max(0, ch.stamina - drain * dt);
    if (ch.stamina <= N.collapseAt && !ch.staminaDown) {
      ch.staminaDown = true;
      this.knockDown(ch);
    }
  }

  /** level bookkeeping: bumps hit on a delay, levels decay on a timer, the
   *  FELT level eases between them, and level 5 is the k-hole. */
  private updateKetamine(ch: Character, _input: PlayerInput, dt: number): void {
    const K = CONFIG.ketamine;
    while (ch.kPending.length > 0 && this.time >= ch.kPending[0]) {
      ch.kPending.shift();
      if (ch.kLevel < K.maxLevel) ch.kLevel++;
      ch.kLastChange = this.time;
    }
    if (ch.kPending.length === 0 && ch.kLevel > 0 && this.time - ch.kLastChange >= K.decayEvery) {
      ch.kLevel--;
      ch.kLastChange = this.time;
    }
    const de = ch.kLevel - ch.kFelt;
    const stepMax = K.easeRate * dt;
    ch.kFelt += Math.abs(de) < stepMax ? de : Math.sign(de) * stepMax;
    // the k-hole: you're simply GONE until you surface back to level 4
    if (ch.kLevel >= K.maxLevel && ch.state !== 1) this.knockDown(ch);
  }

  /** PD spring toward world-up + lean into acceleration + idle sway. */
  private applyUprightSpring(ch: Character, scale: number, input: PlayerInput, _dt: number): void {
    const rot = ch.body.rotation();
    // current body-up in world space
    const up = rotateVec(rot, { x: 0, y: 1, z: 0 });

    // desired up: world up, tilted slightly toward the move direction (lean) + sway noise
    const lean = Math.min(
      CONFIG.body.leanMax,
      Math.hypot(input.moveX, input.moveZ) * ch.cfg.moveSpeed * CONFIG.body.leanIntoAccel,
    );
    const sway = CONFIG.body.swayAmp;
    const swx = Math.sin(this.time * Math.PI * 2 * CONFIG.body.swayHz + ch.swayPhase) * sway;
    const swz = Math.cos(this.time * Math.PI * 2 * CONFIG.body.swayHz * 0.83 + ch.swayPhase * 1.7) * sway;
    let dx = input.moveX * lean + swx;
    let dz = input.moveZ * lean + swz;
    if (ch.kFelt > 0.02) {
      // sea legs: the target itself wobbles, so the whole body weaves
      const K = CONFIG.ketamine;
      const amp = K.wobbleAmp * ch.kFelt;
      dx += Math.sin(this.time * Math.PI * 2 * K.wobbleHz + ch.kDriftPhase) * amp;
      dz += Math.cos(this.time * Math.PI * 2 * K.wobbleHz * 0.77 + ch.kDriftPhase * 1.9) * amp;
    }
    const desired = norm3({ x: dx, y: 1, z: dz });

    // torque = kp * (up × desired) - kd * angvel  (yaw axis left free-ish)
    const cross = {
      x: up.y * desired.z - up.z * desired.y,
      y: up.z * desired.x - up.x * desired.z,
      z: up.x * desired.y - up.y * desired.x,
    };
    // rising off the floor needs more authority than staying balanced does
    const boost = ch.state === 2 ? CONFIG.balance.getupBoost : 1;
    const av = ch.body.angvel();
    let tx = cross.x * ch.cfg.uprightKp * scale * boost - av.x * ch.cfg.uprightKd * boost;
    let ty = -av.y * ch.cfg.uprightKd * 0.6; // damp spin, don't drive yaw (yaw is servo'd below)
    let tz = cross.z * ch.cfg.uprightKp * scale * boost - av.z * ch.cfg.uprightKd * boost;
    const tmag = Math.hypot(tx, ty, tz);
    const maxT = ch.cfg.maxTorque * Math.max(scale, 0.15) * boost;
    if (tmag > maxT) {
      tx = (tx / tmag) * maxT;
      ty = (ty / tmag) * maxT;
      tz = (tz / tmag) * maxT;
    }
    ch.body.addTorque({ x: tx, y: ty, z: tz }, true);

    // yaw servo. players (first person): track the look direction near-1:1 —
    // a body that lags the head is uncanny. NPCs: amble toward their heading.
    let targetYaw: number | null = null;
    if (ch.isPlayer) targetYaw = input.faceYaw;
    else if (Math.hypot(input.moveX, input.moveZ) > 0.1)
      targetYaw = Math.atan2(input.moveX, input.moveZ);
    else if (ch.isMinion && ch.scanYaw !== null) targetYaw = ch.scanYaw; // sweeping the room
    else if (ch.isDJ) targetYaw = 0; // behind the decks, facing the floor (+z)
    if (targetYaw !== null) {
      const gain = ch.isPlayer ? CONFIG.body.yawGain : 60;
      const damp = ch.isPlayer ? CONFIG.body.yawDamp : 12;
      const maxYawT = ch.isPlayer ? CONFIG.body.yawMaxTorque : 90;
      const currYaw = yawOf(rot);
      let dyaw = targetYaw - currYaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const yawTorque = clampN(dyaw * gain - av.y * damp, maxYawT) * scale;
      ch.body.addTorque({ x: 0, y: yawTorque, z: 0 }, true);
    }
  }

  private postStep(ch: Character, _dt: number): void {
    // impact detection: sudden horizontal Δv means something hit us (or we hit
    // something). own movement force can only produce a fraction of this.
    const v = ch.body.linvel();
    const imp = Math.hypot(v.x - ch.prevVx, v.z - ch.prevVz) * ch.cfg.mass;
    ch.prevVx = v.x;
    ch.prevVz = v.z;
    if (ch.state !== 1 && imp > CONFIG.balance.impactMin) {
      ch.hitAccum += imp;
      ch.staggerT = Math.max(
        ch.staggerT,
        Math.min(CONFIG.balance.staggerMax, imp * CONFIG.balance.staggerPerImpulse),
      );
      if (imp > CONFIG.balance.impactEvent) {
        const p = ch.pos();
        this.emit({ t: 'impact', ...vec(p), mag: Math.min(1, imp / 420) });
      }
    }

    if (ch.state === 1) return;
    // while getting up the body starts horizontal by definition — only the
    // impulse trigger applies until the spring has ramped back in
    const up = rotateVec(ch.body.rotation(), { x: 0, y: 1, z: 0 });
    const tilt = Math.acos(Math.max(-1, Math.min(1, up.y)));
    const tilted = ch.state === 0 && tilt > (CONFIG.balance.tiltFallDeg * Math.PI) / 180;
    if (tilted || ch.hitAccum >= CONFIG.balance.impulseFall) this.knockDown(ch);
  }

  private knockDown(ch: Character): void {
    if (ch.state === 1) return;
    ch.state = 1;
    ch.stateT = 0;
    ch.hitAccum = 0;
    ch.body.setAngularDamping(CONFIG.balance.downAngularDamping);
    // downed bodies get real friction + drag: no more tobogganing across the
    // room on the frictionless character capsule (restored when they rise)
    ch.body.setLinearDamping(CONFIG.balance.downLinearDamping);
    ch.collider.setFriction(CONFIG.balance.downFriction);
    this.releaseGrip(ch); // you drop what YOU hold; grips ON you keep dragging — that's the toy
    if (ch.holding) this.releaseItem(ch, 0, null);
    // flooring someone with a minion watching = an instant chunk of heat
    if (ch.checkedBy && this.time - ch.checkedAt < 1.5 && this.phase === 0) {
      for (const m of this.npcs) {
        if (m.isMinion && m.state === 0 && this.minionSees(m, ch)) {
          ch.checkedBy.heat = Math.min(1.2, ch.checkedBy.heat + CONFIG.curator.heatKnockdown);
          break;
        }
      }
      ch.checkedBy = null;
    }
    this.emit({ t: 'fall', ...vec(ch.pos()) });
  }

  private isGrounded(ch: Character): boolean {
    const p = ch.pos();
    const ray = new RAPIER.Ray({ x: p.x, y: p.y, z: p.z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, ch.cfg.halfHeight + ch.cfg.radius + 0.12, true, undefined, undefined, undefined, ch.body);
    return hit !== null;
  }

  // ---------- items ----------

  private targetItemFor(ch: Character, input: PlayerInput): number {
    const p = ch.pos();
    const eye = { x: p.x, y: p.y + CONFIG.camera.eyeHeight, z: p.z };
    return targetItemIndex(
      eye,
      input.faceYaw,
      input.facePitch,
      this.snapItems(),
      ch.pid,
      !!ch.holding,
    );
  }

  private pickupItem(ch: Character, it: Item): void {
    if (it.holder) {
      // straight out of their hand — mid-bump included
      it.holder.holding = null;
      it.holder.dosing = false;
      it.holder.useT = 0;
    }
    it.holder = ch;
    it.holderId = ch.pid;
    ch.holding = it;
    it.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    it.collider.setSensor(true);
    this.emit({ t: 'pickup', ...vec(it.body.translation()) });
  }

  private releaseItem(
    ch: Character,
    speed: number,
    input: PlayerInput | null,
    isThrow = false,
  ): void {
    const it = ch.holding;
    if (!it) return;
    ch.holding = null;
    ch.dosing = false;
    it.holder = null;
    it.holderId = null;
    it.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    it.collider.setSensor(false);
    const hp = this.handWorld(ch);
    it.body.setTranslation(hp, true);
    const v = ch.body.linvel();
    let dir = { x: 0, y: 0, z: 0 };
    if (input) {
      if (isThrow) {
        const cp = Math.cos(input.facePitch);
        dir = {
          x: Math.sin(input.faceYaw) * cp,
          y: Math.sin(input.facePitch) + CONFIG.items.throwUpBias,
          z: Math.cos(input.faceYaw) * cp,
        };
        const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
        dir = { x: dir.x / l, y: dir.y / l, z: dir.z / l };
        this.emit({ t: 'throw', ...hp });
      } else {
        // tap: a soft underhand release, not a launch
        dir = { x: Math.sin(input.faceYaw), y: -0.15, z: Math.cos(input.faceYaw) };
        speed = CONFIG.items.dropSpeed;
      }
    }
    it.body.setLinvel({ x: v.x + dir.x * speed, y: v.y + dir.y * speed, z: v.z + dir.z * speed }, true);
    it.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** where a held item sits: out in front of the chest, travelling smoothly
   *  up to the face and back down over the bump animation */
  private handWorld(ch: Character): { x: number; y: number; z: number } {
    const I = CONFIG.items;
    let f = 0; // 0 = carry position, 1 = at the face
    if (ch.dosing) {
      const KT = CONFIG.ketamine;
      f = Math.min(1, ch.useT / KT.doseRaiseTime, Math.max(0, (KT.doseAnimTime - ch.useT) / KT.doseRaiseTime));
    }
    const local = {
      x: I.holdLocal.x + (I.doseLocal.x - I.holdLocal.x) * f,
      y: I.holdLocal.y + (I.doseLocal.y - I.holdLocal.y) * f,
      z: I.holdLocal.z + (I.doseLocal.z - I.holdLocal.z) * f,
    };
    const p = ch.pos();
    const o = rotateVec(ch.body.rotation(), local);
    return { x: p.x + o.x, y: p.y + o.y, z: p.z + o.z };
  }

  /** held items ride the holder's hand as kinematic bodies — pocket-size
   *  things don't need (or want) the full ragdoll treatment while carried */
  private updateHeldItems(): void {
    for (const it of this.items) {
      if (!it.holder) continue;
      it.body.setNextKinematicTranslation(this.handWorld(it.holder));
      it.body.setNextKinematicRotation(it.holder.body.rotation());
    }
  }

  // ---------- grip ----------

  /** REPO-style: cast the hand along the LOOK direction. Whatever solid it
   *  touches — person, wall, pillar, stage — stick to the exact contact point.
   *  No contact within arm's reach, no grab. */
  private tryGrab(ch: Character, input: PlayerInput): void {
    const origin = this.grabHandPoint(ch);
    const cp = Math.cos(input.facePitch);
    const dir = {
      x: Math.sin(input.faceYaw) * cp,
      y: Math.sin(input.facePitch),
      z: Math.cos(input.faceYaw) * cp,
    };
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRay(
      ray,
      CONFIG.grab.reach,
      true,
      undefined,
      undefined,
      undefined,
      ch.body,
    );
    if (!hit) return;
    const target = hit.collider.parent();
    if (!target) return;
    const point = {
      x: origin.x + dir.x * hit.timeOfImpact,
      y: origin.y + dir.y * hit.timeOfImpact,
      z: origin.z + dir.z * hit.timeOfImpact,
    };
    // store the anchor in the target body's local frame so it rides along
    const tp = target.translation();
    const local = rotateVecInv(target.rotation(), {
      x: point.x - tp.x,
      y: point.y - tp.y,
      z: point.z - tp.z,
    });
    ch.grip = { body: target, local };
    this.emit({ t: 'grab', ...point, on: true });
  }

  private releaseGrip(ch: Character): void {
    if (!ch.grip) return;
    ch.grip = null;
    this.emit({ t: 'grab', ...vec(ch.pos()), on: false });
  }

  /** world position of a character's current grip anchor, or null */
  gripAnchorWorld(ch: Character): { x: number; y: number; z: number } | null {
    if (!ch.grip) return null;
    const tp = ch.grip.body.translation();
    const w = rotateVec(ch.grip.body.rotation(), ch.grip.local);
    return { x: tp.x + w.x, y: tp.y + w.y, z: tp.z + w.z };
  }

  /** stiff spring "grip" between the hand and the anchor point — both bodies
   *  pull on each other (Newton). Fixed bodies (walls) simply don't move, so
   *  you can anchor yourself against them. Torn apart past breakDist. */
  private updateGrips(): void {
    const G = CONFIG.grab;
    for (const ch of this.allChars()) {
      if (!ch.grip) continue;
      const hand = this.grabHandPoint(ch);
      const attach = this.gripAnchorWorld(ch)!;
      const dx = attach.x - hand.x;
      const dy = attach.y - hand.y;
      const dz = attach.z - hand.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > G.breakDist || ch.state === 1) {
        this.releaseGrip(ch);
        continue;
      }
      const dir = { x: dx / (dist || 1), y: dy / (dist || 1), z: dz / (dist || 1) };
      const va = ch.body.linvel();
      const vb = ch.grip.body.linvel();
      const relV = (vb.x - va.x) * dir.x + (vb.y - va.y) * dir.y + (vb.z - va.z) * dir.z;
      let f = (dist - G.restLen) * G.springK + relV * G.springDamp;
      f = clampN(f, G.maxForce);
      ch.grip.body.addForceAtPoint(
        { x: -dir.x * f, y: -dir.y * f * 0.35, z: -dir.z * f },
        attach,
        true,
      );
      ch.body.addForceAtPoint(
        { x: dir.x * f * 0.7, y: dir.y * f * 0.25, z: dir.z * f * 0.7 },
        hand,
        true,
      );
    }
  }

  /** holder's hand in world space */
  grabHandPoint(ch: Character): { x: number; y: number; z: number } {
    const p = ch.pos();
    const h = rotateVec(ch.body.rotation(), CONFIG.grab.handLocal);
    return { x: p.x + h.x, y: p.y + h.y, z: p.z + h.z };
  }

  // ---------- crowd ----------

  /** Where the dancing mass currently is: centroid of upright dancers with a
   *  soft pull toward mid-floor so the lump doesn't migrate into a wall. Not a
   *  fixed spot — knock the pack around and it reforms wherever it lands. */
  private updatePackCenter(): void {
    const C = CONFIG.crowd;
    let x = 0;
    let z = 0;
    let n = 0;
    const dancerCount = Math.min(C.dancers, this.npcs.length);
    for (let i = 0; i < dancerCount; i++) {
      const npc = this.npcs[i];
      if (npc.state !== 0) continue;
      const p = npc.pos();
      x += p.x;
      z += p.z;
      n++;
    }
    if (n === 0) {
      // the whole pack is on the floor — regroup mid-room once they're up
      this.packCenter = { x: C.danceZone.x, z: C.danceZone.z };
      return;
    }
    const bias = 0.12;
    this.packCenter = {
      x: (x / n) * (1 - bias) + C.danceZone.x * bias,
      z: (z / n) * (1 - bias) + C.danceZone.z * bias,
    };
  }

  private updateNpcBrain(npc: Character, dt: number): void {
    const C = CONFIG.crowd;
    const isDancer = this.npcs.indexOf(npc) < C.dancers;
    const beatLen = 60 / CONFIG.music.bpm;
    const beatNum = Math.floor(this.time / beatLen);
    const prevBeatNum = Math.floor((this.time - dt) / beatLen);

    const input: PlayerInput = { ...ZERO_INPUT };
    if (npc.state === 0) {
      const p = npc.pos();
      if (npc.isDJ) {
        // mans the booth. push him anywhere and he trudges back to his decks.
        const hx = npc.home.x - p.x;
        const hz = npc.home.z - p.z;
        const hd = Math.hypot(hx, hz);
        if (hd > 0.45) {
          // navigate around the board: until he's behind its plane, aim past
          // its nearer END (near-zero friction slides him along the front if
          // he cuts the corner). Straight-lining walks him into the furniture.
          const B = CONFIG.room.dj;
          let tx = hx;
          let tz = hz;
          if (p.z > B.boardZ - 0.45) {
            const side = p.x >= 0 ? 1 : -1;
            tx = side * (B.boardW / 2 + 0.5) - p.x;
            tz = B.boardZ - 0.75 - p.z;
          }
          const td = Math.hypot(tx, tz) || 1;
          input.moveX = tx / td;
          input.moveZ = tz / td;
          // blocked (stage lip, bodies in the way) → little hop to get over
          const v = npc.body.linvel();
          if (npc.hopCd <= 0 && Math.hypot(v.x, v.z) < 0.35 && this.isGrounded(npc)) {
            npc.body.setLinvel({ x: v.x, y: CONFIG.body.hopVel, z: v.z }, true);
            npc.hopCd = CONFIG.body.hopCooldown * 2;
          }
        }
      } else if (isDancer) {
        // GENUINE full-body hop on their beat slot (grounded only, so energy
        // can't stack) + a small shuffle. They dance in place, in the pack.
        if (
          beatNum !== prevBeatNum &&
          beatNum % C.danceEveryBeats === npc.dancePhase % C.danceEveryBeats &&
          this.isGrounded(npc)
        ) {
          const v = npc.body.linvel();
          npc.body.setLinvel({ x: v.x, y: Math.max(v.y, C.bounceVel), z: v.z }, true);
          const ang = Math.random() * Math.PI * 2;
          const mag = randRange(...C.danceJitter);
          npc.body.applyImpulse({ x: Math.cos(ang) * mag, y: 0, z: Math.sin(ang) * mag }, true);
        }
        // lump toward the mass: shoved out (or freshly back on their feet),
        // they walk back to wherever the pack IS now
        const hx = this.packCenter.x - p.x;
        const hz = this.packCenter.z - p.z;
        const hd = Math.hypot(hx, hz);
        if (hd > C.packRadius) {
          input.moveX = hx / hd;
          input.moveZ = hz / hd;
        }
      } else if (npc.isMinion) {
        this.minionBrain(npc, input, p, dt);
      } else {
        this.walkerBrain(npc, input, p, dt);
      }
    }
    this.updateCharacter(npc, input, dt);
  }

  /** walk the flow circuit: continuous laps of the room in streams — the
   *  moving crowd you push through and get swept along by */
  private flowWalk(npc: Character, input: PlayerInput, p: RAPIER.Vector3, mult: number): void {
    const F = CONFIG.crowd.flow;
    let tgt = this.flowSpot(npc.loopAng);
    let hx = tgt.x - p.x;
    let hz = tgt.z - p.z;
    let hd = Math.hypot(hx, hz);
    if (hd < F.reachDist) {
      npc.loopAng += F.stepAng * npc.loopDir;
      tgt = this.flowSpot(npc.loopAng);
      hx = tgt.x - p.x;
      hz = tgt.z - p.z;
      hd = Math.hypot(hx, hz) || 1;
    }
    input.moveX = (hx / hd) * mult;
    input.moveZ = (hz / hd) * mult;
  }

  private seekInput(
    input: PlayerInput,
    p: RAPIER.Vector3,
    tx: number,
    tz: number,
    mult: number,
    arrive = 0.35,
  ): number {
    const dx = tx - p.x;
    const dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    if (d > arrive) {
      input.moveX = (dx / d) * mult;
      input.moveZ = (dz / d) * mult;
    }
    return d;
  }

  /** walkers: lap the room, pause sometimes — and every so often they need
   *  the stall: join the line, hold their place (yours too), push through the
   *  door, take their time, come back out */
  private walkerBrain(npc: Character, input: PlayerInput, p: RAPIER.Vector3, dt: number): void {
    const C = CONFIG.crowd;
    const B = CONFIG.bathroom;
    switch (npc.walkerMode) {
      case 0: {
        npc.needT -= dt;
        if (npc.needT <= 0 && this.queue.length < B.queueSlots) {
          this.queue.push(npc);
          npc.walkerMode = 1;
          break;
        }
        const F = C.flow;
        if (npc.lingerT > 0) {
          npc.lingerT -= dt;
        } else {
          npc.flowT -= dt;
          if (npc.flowT <= 0) {
            npc.lingerT = randRange(...F.lingerFor);
            npc.flowT = randRange(...F.lingerEvery);
          } else {
            this.flowWalk(npc, input, p, F.speedMult);
          }
        }
        break;
      }
      case 1: {
        // hold your spot in the line (players occupy real slots too)
        const idx = this.queue.indexOf(npc);
        if (idx === -1) {
          npc.walkerMode = 0;
          npc.needT = 8;
          break;
        }
        const slot = this.slotPos(idx);
        const d = this.seekInput(input, p, slot.x, slot.z, 0.8);
        // your turn only once you're actually STANDING at the front
        if (idx === 0 && d < 0.7 && !this.stallOccupied()) {
          this.queue.splice(idx, 1);
          npc.walkerMode = 2;
        }
        break;
      }
      case 2: {
        // in through the door — it's just a body, shoulder it open. If
        // someone slipped in ahead (a queue-cutting player…), back to the
        // front of the line instead of piling in.
        if (this.stallOccupied() && !this.inStall(p)) {
          this.queue.unshift(npc);
          npc.walkerMode = 1;
          break;
        }
        const d = this.seekInput(input, p, -7.1, 4.95, 0.8, 0.3);
        if (this.inStall(p) && d < 0.7) {
          npc.walkerMode = 3;
          npc.stallT = randRange(...B.npcUseTime);
        }
        break;
      }
      case 3: {
        npc.stallT -= dt;
        this.seekInput(input, p, -7.3, 5.3, 0.6, 0.45);
        if (npc.stallT <= 0) npc.walkerMode = 4;
        break;
      }
      case 4: {
        this.seekInput(input, p, -6.2, 3.0, 0.8, 0.3);
        if (p.z < B.innerZ - 0.5) {
          npc.walkerMode = 0;
          npc.needT = randRange(...B.npcNeedEvery);
        }
        break;
      }
    }
  }

  /** the Curator's minions: patrol the edges with scanning pauses; given a
   *  target, hunt them down, grip them, and walk them to the exit. The grip
   *  is the ordinary physical grip — tear the minion off your friend by
   *  flooring them (that IS the rescue mechanic, and it's also a strike). */
  private minionBrain(npc: Character, input: PlayerInput, p: RAPIER.Vector3, dt: number): void {
    const CU = CONFIG.curator;
    const C = CONFIG.crowd;
    if (npc.minionMode === 2) {
      const t = npc.huntTarget;
      if (!t || t.out || this.phase === 1) {
        npc.minionMode = 0;
        npc.huntTarget = null;
        npc.grip = null;
        npc.scanT = randRange(...CU.scanEvery);
        return;
      }
      const tp = t.pos();
      if (npc.grip && npc.grip.body === t.body) {
        // the walk of shame
        const E = CONFIG.room.exit;
        this.seekInput(input, p, E.x, E.z - 0.35, CU.dragSpeed / C.moveSpeed, 0.25);
        if (Math.hypot(tp.x - E.x, tp.z - E.z) < CU.ejectDist) this.ejectPlayer(t, npc);
      } else {
        npc.grip = null; // torn off (or we got floored) — after them again
        const d = Math.hypot(tp.x - p.x, tp.z - p.z);
        if (d < CU.catchDist) {
          npc.grip = { body: t.body, local: { x: 0, y: 0.2, z: 0 } };
          this.emit({ t: 'grab', x: tp.x, y: tp.y, z: tp.z, on: true });
        } else {
          this.seekInput(input, p, tp.x, tp.z, CU.hunterSpeed / C.moveSpeed, 0.2);
        }
      }
      return;
    }
    // patrol with scanning pauses — the still, watching figure IS the tell
    if (npc.minionMode === 1) {
      npc.lingerT -= dt;
      npc.scanYaw = (npc.scanYaw ?? 0) + 0.9 * dt;
      if (npc.lingerT <= 0) {
        npc.minionMode = 0;
        npc.scanYaw = null;
        npc.scanT = randRange(...CU.scanEvery);
      }
      return;
    }
    npc.scanT -= dt;
    if (npc.scanT <= 0) {
      npc.minionMode = 1;
      npc.lingerT = randRange(...CU.scanFor);
      npc.scanYaw = yawOf(npc.body.rotation());
      return;
    }
    this.flowWalk(npc, input, p, 0.72);
  }

  // ---------- the Curator ----------

  /** players and NPCs hold their places in the bathroom line. A player joins
   *  by standing at the tail slot, and loses the place by wandering off. */
  private updateQueue(): void {
    const B = CONFIG.bathroom;
    for (const p of this.players.values()) {
      const idx = this.queue.indexOf(p);
      const pp = p.pos();
      if (idx === -1) {
        if (!p.out && this.queue.length < B.queueSlots && !this.inStall(pp)) {
          const tail = this.slotPos(this.queue.length);
          if (Math.hypot(pp.x - tail.x, pp.z - tail.z) < B.joinRadius) this.queue.push(p);
        }
      } else {
        const slot = this.slotPos(idx);
        if (Math.hypot(pp.x - slot.x, pp.z - slot.z) > 1.8 || this.inStall(pp)) {
          this.queue.splice(idx, 1);
        }
      }
    }
    // an NPC that got shoved out of queue-mode shouldn't wedge the line
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const ch = this.queue[i];
      if (!ch.isPlayer && ch.walkerMode !== 1) this.queue.splice(i, 1);
    }
  }

  /** REAL line of sight: a ray from the minion's eyes that must reach the
   *  target's chest. Walls, the stall, the door, and every BODY in between
   *  block it — which is why the dancefloor is safe-ish and why friends
   *  huddling around you works without a single line of special code. */
  private minionSees(m: Character, t: Character): boolean {
    const CU = CONFIG.curator;
    const mp = m.pos();
    const tp = t.pos();
    const dx = tp.x - mp.x;
    const dz = tp.z - mp.z;
    const dist = Math.hypot(dx, dz);
    if (dist > CU.viewRange || dist < 1e-3) return false;
    if (m.huntTarget !== t) {
      let dyaw = Math.atan2(dx, dz) - yawOf(m.body.rotation());
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      if (Math.abs(dyaw) > (CU.viewHalfAngleDeg * Math.PI) / 180) return false;
    }
    const origin = { x: mp.x, y: mp.y + 0.42, z: mp.z };
    const target = { x: tp.x, y: tp.y + 0.15, z: tp.z };
    const vx = target.x - origin.x;
    const vy = target.y - origin.y;
    const vz = target.z - origin.z;
    const len = Math.hypot(vx, vy, vz) || 1;
    const hit = this.world.castRay(
      new RAPIER.Ray(origin, { x: vx / len, y: vy / len, z: vz / len }),
      len + 0.1,
      true,
      undefined,
      undefined,
      undefined,
      m.body,
    );
    return hit !== null && hit.collider.parent() === t.body;
  }

  private updateCurator(dt: number): void {
    const CU = CONFIG.curator;
    const watchNow = new Map<Character, number>();
    for (const p of this.players.values()) {
      p.heatObs = false;
      watchNow.set(p, 0);
    }
    if (this.phase === 0) {
      for (const m of this.npcs) {
        if (!m.isMinion) continue;
        m.watchSignal = 0;
        if (m.state !== 0) continue;
        for (const p of this.players.values()) {
          if (p.out || !this.minionSees(m, p)) continue;
          const mp = m.pos();
          const pp = p.pos();
          const gaze = 1 - Math.hypot(pp.x - mp.x, pp.z - mp.z) / CU.viewRange;
          watchNow.set(p, Math.max(watchNow.get(p)!, gaze));
          // are they DOING something? heat only accumulates for behavior.
          let rate = 0;
          if (p.dosing) rate = CU.heatDosing;
          else if (
            p.state === 1 &&
            (p.kLevel >= CONFIG.ketamine.maxLevel || p.staminaDown || p.stateT > 4)
          )
            rate = CU.heatDown;
          else if (p.state === 0 && p.kFelt >= CU.wreckedAt) rate = CU.heatWrecked;
          m.watchSignal = Math.max(m.watchSignal, rate > 0 ? gaze : gaze * 0.45);
          if (rate > 0) {
            p.heat = Math.min(1.2, p.heat + rate * (0.6 + 0.4 * gaze) * dt);
            p.heatObs = true;
          }
        }
      }
    }
    for (const p of this.players.values()) {
      if (!p.heatObs) p.heat = Math.max(0, p.heat - CU.heatDecay * dt);
      const w = watchNow.get(p) ?? 0;
      p.watchSignal += (w - p.watchSignal) * Math.min(1, dt * 6);
      // over the line: the nearest free minion comes for them
      if (p.heat >= CU.ejectAt && !p.out && this.phase === 0) {
        let hunter: Character | null = null;
        let best = Infinity;
        let already = false;
        for (const m of this.npcs) {
          if (!m.isMinion) continue;
          if (m.huntTarget === p) {
            already = true;
            break;
          }
          if (m.minionMode === 2) continue;
          const mp = m.pos();
          const pp = p.pos();
          const d = Math.hypot(mp.x - pp.x, mp.z - pp.z);
          if (d < best) {
            best = d;
            hunter = m;
          }
        }
        if (!already && hunter) {
          hunter.minionMode = 2;
          hunter.huntTarget = p;
          hunter.scanYaw = null;
        }
      }
    }
  }

  private ejectPlayer(p: Character, m: Character): void {
    this.releaseGrip(m);
    if (p.holding) this.releaseItem(p, 0, null);
    p.out = true;
    p.heat = 0;
    const E = CONFIG.room.exit;
    p.body.setTranslation({ x: E.x, y: 1.0, z: 6.55 }, true);
    p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    m.minionMode = 0;
    m.huntTarget = null;
    m.scanT = randRange(...CONFIG.curator.scanEvery);
    this.emit({ t: 'eject', x: E.x, y: 1, z: E.z });
  }

  /** crowd shrugs — soft constant separation so the pack churns instead of
   *  stacking — plus the body-check kick: Rapier resolves capsule-on-capsule
   *  contact softly over several steps, so raw momentum exchange between two
   *  PEOPLE never spikes like a real hit. Pairs closing fast get a symmetric
   *  restitution impulse along the contact line; a sprint-jump check launches
   *  both parties, walking-pace contact never triggers it. */
  private applyCrowdSeparation(_dt: number): void {
    const C = CONFIG.crowd;
    const K = CONFIG.balance.kick;
    const chars = this.allChars();
    for (let i = 0; i < chars.length; i++) {
      const a = chars[i];
      if (a.state === 1) continue;
      const ap = a.pos();
      for (let j = i + 1; j < chars.length; j++) {
        const b = chars[j];
        if (b.state === 1) continue;
        const bp = b.pos();
        const dx = bp.x - ap.x;
        const dz = bp.z - ap.z;
        const d = Math.hypot(dx, dz);
        if (d < 1e-4) continue;
        // body-check kick at (or just before) contact
        const touchDist = a.cfg.radius + b.cfg.radius + 0.08;
        if (d < touchDist) {
          const nx = dx / d;
          const nz = dz / d;
          const va = a.body.linvel();
          const vb = b.body.linvel();
          const closing = (va.x - vb.x) * nx + (va.z - vb.z) * nz;
          if (closing > K.minClose) {
            const jmag = Math.min(K.max, (closing - K.minClose) * K.perClose);
            a.body.applyImpulse({ x: -nx * jmag, y: 0, z: -nz * jmag }, true);
            b.body.applyImpulse({ x: nx * jmag, y: jmag * 0.12, z: nz * jmag }, true);
            // blame: whoever carried more speed into the contact threw it —
            // if the victim goes down in view of a minion, that's a strike
            const vaN = va.x * nx + va.z * nz;
            const vbN = -(vb.x * nx + vb.z * nz);
            const attacker = vaN >= vbN ? a : b;
            const victim = attacker === a ? b : a;
            if (attacker.isPlayer && !attacker.out) {
              victim.checkedBy = attacker;
              victim.checkedAt = this.time;
            }
          }
        }
        if (d > C.personalSpace) continue;
        const f = (1 - d / C.personalSpace) * C.separationForce;
        const fx = (dx / d) * f;
        const fz = (dz / d) * f;
        a.body.addForce({ x: -fx, y: 0, z: -fz }, true);
        b.body.addForce({ x: fx, y: 0, z: fz }, true);
      }
    }
  }

  // ---------- snapshots ----------

  snapshot(): SimSnapshot {
    const players: Record<string, BodySnap> = {};
    for (const [id, ch] of this.players) players[id] = this.snapBody(ch);
    return {
      time: this.time,
      beat: (this.time * CONFIG.music.bpm) / 60,
      nightT: this.nightT,
      phase: this.phase,
      doorAngle: this.doorAngle(),
      players,
      npcs: this.npcs.map((n) => this.snapBody(n)),
      items: this.snapItems(),
    };
  }

  private snapItems(): ItemSnap[] {
    return this.items.map((it) => {
      const p = it.body.translation();
      const r = it.body.rotation();
      return {
        kind: it.kind,
        pos: { x: p.x, y: p.y, z: p.z },
        rot: { x: r.x, y: r.y, z: r.z, w: r.w },
        holder: it.holderId,
        doses: it.doses,
      };
    });
  }

  private snapBody(ch: Character): BodySnap {
    const p = ch.pos();
    const r = ch.body.rotation();
    const v = ch.body.linvel();
    return {
      pos: { x: p.x, y: p.y, z: p.z },
      rot: { x: r.x, y: r.y, z: r.z, w: r.w },
      vel: { x: v.x, y: v.y, z: v.z },
      st: ch.state,
      gripPoint: this.gripAnchorWorld(ch),
      act: ch.dosing ? 1 : ch.wantGrab && !ch.grip ? 3 : ch.staggerT > 0 ? 2 : 0,
      k: ch.kFelt,
      stam: ch.isPlayer ? ch.stamina : 1,
      watch: ch.watchSignal,
      out: ch.out,
    };
  }

  private emit(ev: GameEvent): void {
    this.eventQueue.push(ev);
  }
}

// ---------- math helpers (plain, no deps) ----------

function rotateVec(q: { x: number; y: number; z: number; w: number }, v: { x: number; y: number; z: number }) {
  // v' = q * v * q⁻¹
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}

function rotateVecInv(
  q: { x: number; y: number; z: number; w: number },
  v: { x: number; y: number; z: number },
) {
  return rotateVec({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);
}

function yawOf(q: { x: number; y: number; z: number; w: number }): number {
  const fwd = rotateVec(q, { x: 0, y: 0, z: 1 });
  return Math.atan2(fwd.x, fwd.z);
}

function norm3(v: { x: number; y: number; z: number }) {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function clampN(v: number, m: number): number {
  return Math.max(-m, Math.min(m, v));
}

function randRange(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function vec(p: RAPIER.Vector3): { x: number; y: number; z: number } {
  return { x: p.x, y: p.y, z: p.z };
}
