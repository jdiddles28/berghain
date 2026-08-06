// One clubber: faceted low-poly body driven by the sim's rigid body transform,
// with cheap procedural limbs. Flat shading — papercraft, not Roblox.
//
// Art direction (John): Peak × Schedule 1 — simple, readable, human-shaped.
// No more massive pill with stick legs: shoulders taper to a waist and hips,
// and the legs are thick TWO-SEGMENT steppers (thigh + shin with a knee) that
// visibly walk. Faces come later; heads stay blank on purpose.
//
// Motion language (per John's playtests):
// - NOBODY bobs to the music visually. Dancers bounce FOR REAL in the sim
//   (whole body airborne); walkers and idle players stand planted.
// - Grab held = arms reach out along the aim even when there's nothing there;
//   connected = arms track the actual grip point.
// - Holding an item = the near arm holds it out in front (Peak carry).

import * as THREE from 'three';
import type { BodySnap } from '../sim/types';

const DOWN_ARM = new THREE.Vector3(0, -1, 0);
const tmpV = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

export interface ClubberFrameOpts {
  /** world point the hands are gripping (connected grab) */
  grabTarget?: THREE.Vector3 | null;
  /** world position of the item in this clubber's hand (right arm holds it) */
  holdTarget?: THREE.Vector3 | null;
  /** this NPC is in the dancing pack (adds a light arm groove, no bob) */
  dancer?: boolean;
  /** the DJ: hands work the decks, one goes up at the top of each phrase */
  mixing?: boolean;
  /** minions only: how hard they're watching someone, 0..1 — the eyes catch
   *  a faint red light. THE feeling-of-being-observed tell. */
  watching?: number;
  /** local player's camera pitch so FP arm thrust/reach follows the look */
  aimPitch?: number;
}

export class ClubberView {
  group = new THREE.Group();
  private chest: THREE.Mesh;
  private waist: THREE.Mesh;
  private hips: THREE.Mesh;
  private head: THREE.Mesh;
  private armL: THREE.Object3D;
  private armR: THREE.Object3D;
  private legL: THREE.Object3D; // hip pivot (thigh)
  private legR: THREE.Object3D;
  private kneeL: THREE.Object3D; // knee pivot (shin), child of the thigh
  private kneeR: THREE.Object3D;
  private walkPhase = 0;
  private dancePhase = Math.random() * Math.PI * 2;
  private scale: number;
  private headMat: THREE.MeshLambertMaterial;
  private browL!: THREE.Mesh;
  private browR!: THREE.Mesh;

  constructor(outfit: number, skin: number, scale = 1, minion = false) {
    this.scale = scale;
    const s = scale;
    const outfitMat = new THREE.MeshLambertMaterial({ color: outfit, flatShading: true });
    const pants = new THREE.Color(outfit).multiplyScalar(minion ? 1 : 0.55);
    const pantsMat = new THREE.MeshLambertMaterial({ color: pants, flatShading: true });
    const skinMat = new THREE.MeshLambertMaterial({ color: skin, flatShading: true });
    this.headMat = skinMat;

    // torso: chest tapering through a waist into hips — a person, not a pill
    this.chest = new THREE.Mesh(new THREE.BoxGeometry(0.42 * s, 0.32 * s, 0.24 * s), outfitMat);
    this.chest.position.y = 0.3 * s;
    this.waist = new THREE.Mesh(new THREE.BoxGeometry(0.34 * s, 0.24 * s, 0.21 * s), outfitMat);
    this.waist.position.y = 0.03 * s;
    this.hips = new THREE.Mesh(new THREE.BoxGeometry(0.35 * s, 0.16 * s, 0.22 * s), pantsMat);
    this.hips.position.y = -0.16 * s;

    this.head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15 * s, 1), skinMat);
    this.head.position.y = 0.61 * s;
    // faces stay blank (John) — EXCEPT the angry brows: slanted dark bars
    // that appear when this body is pissed off at someone, so you can tell
    // who is mad at you at a glance. Hidden the rest of the time.
    const browMat = new THREE.MeshBasicMaterial({ color: 0x0a0507 });
    const browGeo = new THREE.BoxGeometry(0.085 * s, 0.022 * s, 0.02 * s);
    this.browL = new THREE.Mesh(browGeo, browMat);
    this.browL.position.set(-0.055 * s, 0.045 * s, 0.125 * s);
    this.browL.rotation.z = -0.55; // inner end down — the angry slant
    this.browR = new THREE.Mesh(browGeo, browMat);
    this.browR.position.set(0.055 * s, 0.045 * s, 0.125 * s);
    this.browR.rotation.z = 0.55;
    this.browL.visible = false;
    this.browR.visible = false;
    this.head.add(this.browL, this.browR);
    if (minion) {
      // the one thing that gives them away up close: the earpiece
      const ear = new THREE.Mesh(
        new THREE.BoxGeometry(0.035 * s, 0.045 * s, 0.03 * s),
        new THREE.MeshLambertMaterial({ color: 0xd8dbe4, flatShading: true }),
      );
      ear.position.set(-0.14 * s, 0.0, 0.02 * s);
      this.head.add(ear);
    }

    const armGeo = new THREE.CapsuleGeometry(0.068 * s, 0.36 * s, 1, 5);
    this.armL = this.limb(armGeo, outfitMat, -0.28 * s, 0.4 * s, -0.22 * s);
    this.armR = this.limb(armGeo, outfitMat, 0.28 * s, 0.4 * s, -0.22 * s);

    // two-segment legs: thigh from the hip, shin from the knee. thick enough
    // to read as legs, and the knee is what makes walking look like STEPPING
    const thighGeo = new THREE.CapsuleGeometry(0.09 * s, 0.18 * s, 1, 5);
    const shinGeo = new THREE.CapsuleGeometry(0.075 * s, 0.17 * s, 1, 5);
    this.legL = this.limb(thighGeo, pantsMat, -0.11 * s, -0.22 * s, -0.13 * s);
    this.legR = this.limb(thighGeo, pantsMat, 0.11 * s, -0.22 * s, -0.13 * s);
    this.kneeL = this.limb(shinGeo, pantsMat, 0, -0.28 * s, -0.13 * s);
    this.kneeR = this.limb(shinGeo, pantsMat, 0, -0.28 * s, -0.13 * s);
    this.legL.add(this.kneeL);
    this.legR.add(this.kneeR);

    this.group.add(
      this.chest,
      this.waist,
      this.hips,
      this.head,
      this.armL,
      this.armR,
      this.legL,
      this.legR,
    );
  }

  /** pivot at the top of the limb so rotation swings it */
  private limb(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    meshY: number,
  ): THREE.Object3D {
    const pivot = new THREE.Object3D();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = meshY;
    pivot.add(mesh);
    return pivot;
  }

  setHeadVisible(v: boolean): void {
    this.head.visible = v;
  }

  setArmsVisible(v: boolean): void {
    this.armL.visible = v;
    this.armR.visible = v;
  }

  /** first person: the camera lives inside this capsule — looking down showed
   *  the INSIDE of your own torso. Local player renders arms only. */
  setBodyVisible(v: boolean): void {
    this.chest.visible = v;
    this.waist.visible = v;
    this.hips.visible = v;
    this.legL.visible = v;
    this.legR.visible = v;
  }

  /** local player: hide the chest/waist the camera sits inside, but KEEP the
   *  hips and legs — look down and you see your own legs stepping (John) */
  setFirstPersonBody(): void {
    this.chest.visible = false;
    this.waist.visible = false;
    this.hips.visible = true;
    this.legL.visible = true;
    this.legR.visible = true;
  }

  update(b: BodySnap, dt: number, beat: number, opts?: ClubberFrameOpts): void {
    this.group.position.set(b.pos.x, b.pos.y, b.pos.z);
    this.group.quaternion.set(b.rot.x, b.rot.y, b.rot.z, b.rot.w);
    this.group.updateMatrixWorld();

    // watching = the head catches red light. Builds GRADUALLY with suspicion
    // (John liked this exact read) and burns full red in pursuit — strong
    // enough now that it can't be mistaken for the club lights.
    const w = opts?.watching ?? 0;
    this.headMat.emissive.setRGB(w * w * 0.95, w * w * 0.04, w * w * 0.05);
    this.browL.visible = b.angry;
    this.browR.visible = b.angry;

    const speed = Math.hypot(b.vel.x, b.vel.z);
    this.walkPhase += speed * dt * 5.2;

    // dosing: the bag comes up to the face — the carrying arm tracks it.
    // NOTE on handedness: the arm at -x ("armL" here) RENDERS as the
    // character's right hand (+x draws screen-left in FP) — and John wants
    // items carried in the right hand, so the -x arm does the carrying.
    if (b.act === 1 && b.st !== 1) {
      if (opts?.holdTarget) this.aimArm(this.armL, opts.holdTarget);
      else this.armL.rotation.set(-2.5, 0, 0.3);
      this.armR.rotation.set(-0.2, 0, -0.15);
      this.legsWalk(speed);
      return;
    }

    // connected grab: arms track the actual grip point
    if (opts?.grabTarget && b.st !== 1) {
      this.aimArm(this.armL, opts.grabTarget);
      this.aimArm(this.armR, opts.grabTarget);
      this.legsWalk(speed);
      return;
    }

    // carrying something: the RIGHT hand (-x arm, see note above) holds it
    // out; the other arm stays natural
    if (opts?.holdTarget && b.st !== 1) {
      this.aimArm(this.armL, opts.holdTarget);
      if (speed > 0.4) {
        const s = Math.sin(this.walkPhase);
        this.armR.rotation.set(s * 0.5, 0, -0.12);
      } else {
        this.armR.rotation.set(0, 0, -0.08);
      }
      this.legsWalk(speed);
      return;
    }

    // reaching (grab held, nothing caught yet): arms out, grasping at air
    if (b.act === 3) {
      this.aimForward(opts?.aimPitch ?? 0, 0.14);
      this.legsWalk(speed);
      return;
    }

    if (b.st === 1) {
      if (b.asleep) {
        // out of gas: not a ragdoll flop — a fetal curl, sleeping it off
        // (John: "you actually lie down and curl up in a little fetal position")
        const breathe = Math.sin(beat * Math.PI * 0.5) * 0.05;
        this.armL.rotation.set(-1.9 + breathe, 0.35, 0.55);
        this.armR.rotation.set(-1.8 - breathe, -0.35, -0.55);
        this.legL.rotation.set(-1.85, 0, 0.16);
        this.legR.rotation.set(-1.75, 0, -0.16);
        this.kneeL.rotation.x = 2.15;
        this.kneeR.rotation.x = 2.05;
        return;
      }
      // down: limbs dangle loose
      const flop = Math.sin(beat * Math.PI) * 0.25;
      this.armL.rotation.set(2.4 + flop, 0, 0.5);
      this.armR.rotation.set(2.2 - flop, 0, -0.5);
      this.legL.rotation.set(0.35 + flop * 0.5, 0, 0.22);
      this.legR.rotation.set(0.45 - flop * 0.5, 0, -0.22);
      this.kneeL.rotation.x = 0.5 + flop * 0.3;
      this.kneeR.rotation.x = 0.4 - flop * 0.3;
      return;
    }

    if (b.act === 5) {
      // knocking on the stall door: sharp raps from the near arm — you can
      // HEAR it, and it's very clear what they want (John)
      const rap = Math.max(0, Math.sin(beat * Math.PI * 6));
      this.armL.rotation.set(-1.5 - rap * 0.45, 0, 0.15);
      this.armR.rotation.set(-0.1, 0, -0.1);
      this.legsIdle();
      return;
    }

    if (b.act === 2) {
      // staggered: arms windmill for balance
      const w = Math.sin(beat * Math.PI * 7 + this.dancePhase);
      this.armL.rotation.set(-0.7 + w * 0.9, 0, 0.85);
      this.armR.rotation.set(-0.7 - w * 0.9, 0, -0.85);
      this.legsWalk(speed);
      return;
    }

    if (speed > 0.4) {
      const s = Math.sin(this.walkPhase);
      this.armL.rotation.set(s * 0.6, 0, 0.12);
      this.armR.rotation.set(-s * 0.6, 0, -0.12);
      this.legsWalk(speed);
      return;
    }

    // standing: PLANTED. dancers get a light arm groove (their bounce is real
    // physics); everyone else keeps still arms and a still torso.
    if (opts?.mixing) {
      // forearms over the board nudging the decks on the beat; a hand goes up
      // for the last two beats of every 16-beat phrase. torso stays planted.
      const nudge = Math.sin(beat * Math.PI * 2) * 0.1;
      if (beat % 16 >= 14) {
        this.armR.rotation.set(-2.75, 0, -0.25); // hand in the air
        this.armL.rotation.set(-1.05 - nudge, 0, 0.18);
      } else {
        this.armL.rotation.set(-1.05 + nudge, 0, 0.18);
        this.armR.rotation.set(-1.05 - nudge, 0, -0.18);
      }
      this.legsIdle();
      return;
    }
    if (opts?.dancer || b.act === 4) {
      // NPC dancers and players holding the dance button share the groove
      const g = Math.sin((beat + this.dancePhase) * Math.PI * 2);
      this.armL.rotation.set(-0.25 + g * 0.22, 0, 0.2);
      this.armR.rotation.set(-0.25 - g * 0.22, 0, -0.2);
    } else {
      this.armL.rotation.set(0, 0, 0.06);
      this.armR.rotation.set(0, 0, -0.06);
    }
    this.legsIdle();
  }

  /** the walk cycle: thighs scissor, each knee flexes as its leg swings
   *  through — the "actually stepping" look John asked for */
  private legsWalk(speed: number): void {
    if (speed <= 0.4) {
      this.legsIdle();
      return;
    }
    const s = Math.sin(this.walkPhase);
    this.legL.rotation.set(-s * 0.62, 0, 0.03);
    this.legR.rotation.set(s * 0.62, 0, -0.03);
    // knee bends while that leg recovers (swings forward), extends to plant
    this.kneeL.rotation.x = Math.max(0, Math.sin(this.walkPhase + 1.1)) * 0.85;
    this.kneeR.rotation.x = Math.max(0, Math.sin(this.walkPhase + 1.1 + Math.PI)) * 0.85;
  }

  private legsIdle(): void {
    this.legL.rotation.set(0, 0, 0.035);
    this.legR.rotation.set(0, 0, -0.035);
    this.kneeL.rotation.x = 0.04;
    this.kneeR.rotation.x = 0.04;
  }

  /** thrust/reach both arms straight ahead along the body's facing ± pitch */
  private aimForward(pitch: number, spread: number): void {
    const reach = 1.0 * this.scale;
    // local-space target in front of the chest; convert to world for aimArm
    tmpTarget.set(0, 0.32 * this.scale + Math.sin(pitch) * reach, Math.cos(pitch) * reach);
    this.group.localToWorld(tmpTarget);
    this.aimArmSpread(this.armL, tmpTarget, -spread);
    this.aimArmSpread(this.armR, tmpTarget, spread);
  }

  /** rotate an arm pivot so the arm (which hangs along -Y) points at a world target */
  private aimArm(arm: THREE.Object3D, worldTarget: THREE.Vector3): void {
    tmpV.copy(worldTarget);
    this.group.worldToLocal(tmpV);
    tmpV.sub(arm.position).normalize();
    tmpQ.setFromUnitVectors(DOWN_ARM, tmpV);
    arm.quaternion.copy(tmpQ);
  }

  private aimArmSpread(arm: THREE.Object3D, worldTarget: THREE.Vector3, rollAfter: number): void {
    this.aimArm(arm, worldTarget);
    if (rollAfter !== 0) arm.rotateZ(rollAfter);
  }
}
