// Headless simulation. Rapier only — no three.js (must run in Node for tests).
//
// The whole Build-1 bet: every character is a DYNAMIC capsule held upright by a
// limited-strength PD spring. Movement is force-based, so crowd bumps genuinely
// displace you; a hard enough hit (or too much tilt) overwhelms the spring and
// you ragdoll, flop for a while, then wobble back to your feet.

import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import {
  ZERO_INPUT,
  type BodySnap,
  type BodyState,
  type GameEvent,
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

class Character {
  body: RAPIER.RigidBody;
  state: BodyState = 0;
  stateT = 0; // time in current state
  hitAccum = 0; // recent received impulse (decays) — knockdown trigger
  staggerT = 0; // motor control cut after real impacts — makes knockback READ
  shoveT = 0; // arms-out shove animation window (broadcast via act)
  hopCd = 0;
  shoveCd = 0;
  /** universal grip: any solid body, stuck at the exact contact point */
  grip: { body: RAPIER.RigidBody; local: { x: number; y: number; z: number } } | null = null;
  swayPhase = Math.random() * Math.PI * 2;
  prevVx = 0; // last step's horizontal velocity — impact detection
  prevVz = 0;
  // NPC brain
  home: { x: number; z: number };
  wanderT = 0;
  dancePhase = 0; // which beat this NPC hits

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
    const collider = world.createCollider(col, this.body);
    collider.setMass(cfg.mass);
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
  players = new Map<string, Character>();
  npcs: Character[] = [];
  lastEvents: GameEvent[] = [];
  private eventQueue: GameEvent[] = [];

  /** Call after initRapier() resolves. */
  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = CONFIG.sim.dt;
    this.buildRoom();
    this.spawnCrowd();
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
  }

  private spawnCrowd(): void {
    const C = CONFIG.crowd;
    const R = CONFIG.room;
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
      // scatter across the floor, clear of the stage
      const x = (Math.random() - 0.5) * (R.w - 2.5);
      const z = (Math.random() - 0.5) * (R.d - 2.5);
      const npc = new Character(this.world, cfg, x, Math.max(z, -R.d / 2 + 3), false, i % 4);
      npc.wanderT = randRange(...C.wanderEvery);
      this.npcs.push(npc);
    }
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
    this.players.set(id, p);
  }

  removePlayer(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    for (const other of this.allChars()) {
      if (other.grip?.body === p.body) this.releaseGrip(other);
    }
    this.releaseGrip(p);
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

    // Rapier forces/torques PERSIST until reset — clear last step's before re-adding
    for (const ch of this.allChars()) {
      ch.body.resetForces(true);
      ch.body.resetTorques(true);
    }

    for (const [id, ch] of this.players) {
      this.updateCharacter(ch, inputs.get(id) ?? ZERO_INPUT, dt);
    }
    for (const npc of this.npcs) {
      this.updateNpcBrain(npc, dt);
    }
    this.applyCrowdSeparation(dt);
    this.updateGrips();

    this.world.step();

    // post-step: knockdown checks from tilt (velocity/impulse checks live in updateCharacter)
    for (const ch of this.allChars()) this.postStep(ch, dt);

    this.lastEvents = this.eventQueue;
  }

  // ---------- character control ----------

  private updateCharacter(ch: Character, input: PlayerInput, dt: number): void {
    ch.stateT += dt;
    ch.hopCd = Math.max(0, ch.hopCd - dt);
    ch.shoveCd = Math.max(0, ch.shoveCd - dt);
    ch.shoveT = Math.max(0, ch.shoveT - dt);
    ch.staggerT = Math.max(0, ch.staggerT - dt);
    ch.hitAccum = Math.max(0, ch.hitAccum - (CONFIG.balance.impulseFall / CONFIG.balance.impulseWindow) * dt);

    if (ch.state === 1) {
      // down: floppy. get-up timer.
      if (ch.stateT >= CONFIG.balance.downTime) {
        ch.state = 2;
        ch.stateT = 0;
        ch.body.setAngularDamping(CONFIG.body.angularDamping);
        const v = ch.body.linvel();
        ch.body.setLinvel({ x: v.x, y: v.y + CONFIG.balance.getupNudge, z: v.z }, true);
        this.emit({ t: 'getup', ...vec(ch.pos()) });
      }
      return; // no control while down
    }
    if (ch.state === 2 && ch.stateT >= CONFIG.balance.getupRamp) {
      ch.state = 0;
      ch.stateT = 0;
    }

    // upright spring (ramped during get-up so the rise is a wobble, not a snap;
    // cut while staggered so hits produce a visible flail)
    const staggered = ch.staggerT > 0;
    const springScale =
      (ch.state === 2 ? Math.min(1, ch.stateT / CONFIG.balance.getupRamp) : 1) *
      (ch.grip ? CONFIG.grab.holderKpMult : 1) *
      (staggered ? CONFIG.balance.staggerSpringMult : 1);
    this.applyUprightSpring(ch, springScale, input, dt);

    // movement force toward desired velocity — staggered bodies lose their
    // motor control, which is what lets a shove actually SHOVE
    const grounded = this.isGrounded(ch);
    const wantX = input.moveX;
    const wantZ = input.moveZ;
    const speedMult = ch.grip ? CONFIG.grab.holderSpeedMult : 1;
    const targetVx = wantX * ch.cfg.moveSpeed * speedMult;
    const targetVz = wantZ * ch.cfg.moveSpeed * speedMult;
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

    // shove
    if (input.shove && ch.shoveCd <= 0 && !staggered) {
      this.doShove(ch);
      ch.shoveCd = CONFIG.shove.cooldown;
      ch.shoveT = CONFIG.shove.windupTime;
    }

    // grab (players only — hold to grip, release to drop)
    if (ch.isPlayer) {
      if (input.grab && !ch.grip) this.tryGrab(ch, input);
      else if (!input.grab && ch.grip) this.releaseGrip(ch);
    }
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
    // something). own movement force can only produce ~33 N·s per step.
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
    this.releaseGrip(ch); // you drop what YOU hold; grips ON you keep dragging — that's the toy
    this.emit({ t: 'fall', ...vec(ch.pos()) });
  }

  private isGrounded(ch: Character): boolean {
    const p = ch.pos();
    const ray = new RAPIER.Ray({ x: p.x, y: p.y, z: p.z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, ch.cfg.halfHeight + ch.cfg.radius + 0.12, true, undefined, undefined, undefined, ch.body);
    return hit !== null;
  }

  // ---------- verbs ----------

  private doShove(ch: Character): void {
    const p = ch.pos();
    const rot = ch.body.rotation();
    const fwd = rotateVec(rot, { x: 0, y: 0, z: 1 });
    const fxz = norm2(fwd.x, fwd.z);
    let hit = false;
    const cosHalf = Math.cos((CONFIG.shove.halfAngleDeg * Math.PI) / 180);
    for (const other of this.allChars()) {
      if (other === ch) continue;
      const op = other.pos();
      const dx = op.x - p.x;
      const dz = op.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > CONFIG.shove.range || dist < 1e-4) continue;
      const dot = (dx / dist) * fxz.x + (dz / dist) * fxz.z;
      if (dot < cosHalf) continue;
      other.body.applyImpulse(
        {
          x: (dx / dist) * CONFIG.shove.impulse,
          y: CONFIG.shove.upImpulse,
          z: (dz / dist) * CONFIG.shove.impulse,
        },
        true,
      );
      other.hitAccum += CONFIG.shove.balanceDamage;
      hit = true;
    }
    // lunge — shoving is committal, whiffing overbalances YOU a little
    ch.body.applyImpulse({ x: fxz.x * CONFIG.shove.selfLunge, y: 0, z: fxz.z * CONFIG.shove.selfLunge }, true);
    ch.hitAccum += hit ? 0 : CONFIG.shove.balanceDamage * 0.35;
    this.emit({ t: 'shove', ...vec(p), hit });
  }

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

  private updateNpcBrain(npc: Character, dt: number): void {
    const C = CONFIG.crowd;
    // beat clock: continuous beats since t=0
    const beatLen = 60 / CONFIG.music.bpm;
    const beatNum = Math.floor(this.time / beatLen);
    const prevBeatNum = Math.floor((this.time - dt) / beatLen);

    const input: PlayerInput = { ...ZERO_INPUT };
    if (npc.state === 0) {
      // dance bounce on this NPC's beat slot
      if (beatNum !== prevBeatNum && beatNum % C.danceEveryBeats === npc.dancePhase % C.danceEveryBeats) {
        const ang = Math.random() * Math.PI * 2;
        const mag = randRange(...C.danceImpulse);
        npc.body.applyImpulse(
          { x: Math.cos(ang) * mag, y: C.bounceVel * npc.cfg.mass * 0.12, z: Math.sin(ang) * mag },
          true,
        );
      }
      // wander: drift toward home; re-pick home occasionally
      npc.wanderT -= dt;
      if (npc.wanderT <= 0) {
        npc.wanderT = randRange(...C.wanderEvery);
        const R = CONFIG.room;
        npc.home = {
          x: (Math.random() - 0.5) * (R.w - 2.5),
          z: Math.max((Math.random() - 0.5) * (R.d - 2.5), -R.d / 2 + 2.6),
        };
      }
      const p = npc.pos();
      const hx = npc.home.x - p.x;
      const hz = npc.home.z - p.z;
      const hd = Math.hypot(hx, hz);
      if (hd > 0.8) {
        input.moveX = hx / hd;
        input.moveZ = hz / hd;
      }
    }
    this.updateCharacter(npc, input, dt);
  }

  /** crowd shrugs — soft constant separation so the pack churns instead of stacking */
  private applyCrowdSeparation(_dt: number): void {
    const C = CONFIG.crowd;
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
        if (d > C.personalSpace || d < 1e-4) continue;
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
      players,
      npcs: this.npcs.map((n) => this.snapBody(n)),
    };
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
      act: ch.shoveT > 0 ? 1 : ch.staggerT > 0 ? 2 : 0,
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

function norm2(x: number, z: number) {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
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
