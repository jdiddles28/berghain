// One clubber: faceted low-poly body driven by the sim's rigid body transform,
// with cheap procedural limbs. Flat shading — papercraft, not Roblox.
//
// Motion language (per John's playtests):
// - NOBODY bobs to the music visually. Dancers bounce FOR REAL in the sim
//   (whole body airborne); walkers and idle players stand planted.
// - Shove = both arms THRUST forward along the aim, not a swing-up.
// - Grab held = arms reach out along the aim even when there's nothing there;
//   connected = arms track the actual grip point.

import * as THREE from 'three';
import type { BodySnap } from '../sim/types';

const DOWN_ARM = new THREE.Vector3(0, -1, 0);
const tmpV = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

export interface ClubberFrameOpts {
  /** world point the hands are gripping (connected grab) */
  grabTarget?: THREE.Vector3 | null;
  /** this NPC is in the dancing pack (adds a light arm groove, no bob) */
  dancer?: boolean;
  /** the DJ: hands work the decks, one goes up at the top of each phrase */
  mixing?: boolean;
  /** local player's camera pitch so FP arm thrust/reach follows the look */
  aimPitch?: number;
}

export class ClubberView {
  group = new THREE.Group();
  private torso: THREE.Mesh;
  private head: THREE.Mesh;
  private armL: THREE.Object3D;
  private armR: THREE.Object3D;
  private legL: THREE.Object3D;
  private legR: THREE.Object3D;
  private walkPhase = 0;
  private dancePhase = Math.random() * Math.PI * 2;
  private scale: number;

  constructor(outfit: number, skin: number, scale = 1) {
    this.scale = scale;
    const outfitMat = new THREE.MeshLambertMaterial({ color: outfit, flatShading: true });
    const skinMat = new THREE.MeshLambertMaterial({ color: skin, flatShading: true });

    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24 * scale, 0.52 * scale, 2, 6), outfitMat);
    this.head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.155 * scale, 0), skinMat);
    this.head.position.y = 0.62 * scale;

    const armGeo = new THREE.CapsuleGeometry(0.06 * scale, 0.42 * scale, 1, 5);
    const legGeo = new THREE.CapsuleGeometry(0.075 * scale, 0.4 * scale, 1, 5);

    this.armL = this.limb(armGeo, outfitMat, -0.31 * scale, 0.32 * scale);
    this.armR = this.limb(armGeo, outfitMat, 0.31 * scale, 0.32 * scale);
    this.legL = this.limb(legGeo, outfitMat, -0.13 * scale, -0.38 * scale);
    this.legR = this.limb(legGeo, outfitMat, 0.13 * scale, -0.38 * scale);

    this.group.add(this.torso, this.head, this.armL, this.armR, this.legL, this.legR);
  }

  /** pivot at the top of the limb so rotation swings it */
  private limb(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number): THREE.Object3D {
    const pivot = new THREE.Object3D();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = -0.24;
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
    this.torso.visible = v;
    this.legL.visible = v;
    this.legR.visible = v;
  }

  update(b: BodySnap, dt: number, beat: number, opts?: ClubberFrameOpts): void {
    this.group.position.set(b.pos.x, b.pos.y, b.pos.z);
    this.group.quaternion.set(b.rot.x, b.rot.y, b.rot.z, b.rot.w);
    this.group.updateMatrixWorld();

    const speed = Math.hypot(b.vel.x, b.vel.z);
    this.walkPhase += speed * dt * 5.2;

    // connected grab: arms track the actual grip point
    if (opts?.grabTarget && b.st !== 1) {
      this.aimArm(this.armL, opts.grabTarget);
      this.aimArm(this.armR, opts.grabTarget);
      this.legsWalk(speed);
      return;
    }

    // mid-shove: both arms THRUST forward along the aim
    if (b.act === 1) {
      this.aimForward(opts?.aimPitch ?? 0, 0.05);
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
      // down: limbs dangle loose
      const flop = Math.sin(beat * Math.PI) * 0.25;
      this.armL.rotation.set(2.4 + flop, 0, 0.5);
      this.armR.rotation.set(2.2 - flop, 0, -0.5);
      this.legL.rotation.set(0.4 + flop * 0.5, 0, 0.25);
      this.legR.rotation.set(0.5 - flop * 0.5, 0, -0.25);
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
      this.armL.rotation.set(s * 0.7, 0, 0.12);
      this.armR.rotation.set(-s * 0.7, 0, -0.12);
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
      this.legL.rotation.set(0, 0, 0.04);
      this.legR.rotation.set(0, 0, -0.04);
      return;
    }
    if (opts?.dancer) {
      const g = Math.sin((beat + this.dancePhase) * Math.PI * 2);
      this.armL.rotation.set(-0.25 + g * 0.22, 0, 0.2);
      this.armR.rotation.set(-0.25 - g * 0.22, 0, -0.2);
    } else {
      this.armL.rotation.set(0, 0, 0.06);
      this.armR.rotation.set(0, 0, -0.06);
    }
    this.legL.rotation.set(0, 0, 0.04);
    this.legR.rotation.set(0, 0, -0.04);
  }

  private legsWalk(speed: number): void {
    const s = speed > 0.4 ? Math.sin(this.walkPhase) : 0;
    this.legL.rotation.set(-s * 0.8, 0, 0.03);
    this.legR.rotation.set(s * 0.8, 0, -0.03);
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
