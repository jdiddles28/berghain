// One clubber: faceted low-poly body driven by the sim's rigid body transform,
// with cheap procedural limbs (walk swing, dance bob, shove thrust, stagger
// flail, ragdoll dangle, grab-reach). Flat shading — papercraft, not Roblox.

import * as THREE from 'three';
import type { BodySnap } from '../sim/types';

const DOWN_ARM = new THREE.Vector3(0, -1, 0);
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

export interface ClubberFrameOpts {
  /** world point the holder's hands should reach toward (they're gripping) */
  grabTarget?: THREE.Vector3 | null;
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
  private shoulderY: number;

  constructor(outfit: number, skin: number, scale = 1) {
    const outfitMat = new THREE.MeshLambertMaterial({ color: outfit, flatShading: true });
    const skinMat = new THREE.MeshLambertMaterial({ color: skin, flatShading: true });

    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24 * scale, 0.52 * scale, 2, 6), outfitMat);
    this.head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.155 * scale, 0), skinMat);
    this.head.position.y = 0.62 * scale;

    const armGeo = new THREE.CapsuleGeometry(0.06 * scale, 0.42 * scale, 1, 5);
    const legGeo = new THREE.CapsuleGeometry(0.075 * scale, 0.4 * scale, 1, 5);

    this.shoulderY = 0.32 * scale;
    this.armL = this.limb(armGeo, outfitMat, -0.31 * scale, this.shoulderY);
    this.armR = this.limb(armGeo, outfitMat, 0.31 * scale, this.shoulderY);
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

  update(b: BodySnap, dt: number, beat: number, opts?: ClubberFrameOpts): void {
    this.group.position.set(b.pos.x, b.pos.y, b.pos.z);
    this.group.quaternion.set(b.rot.x, b.rot.y, b.rot.z, b.rot.w);

    const speed = Math.hypot(b.vel.x, b.vel.z);
    this.walkPhase += speed * dt * 5.2;

    // grabbing: both arms reach for the thing being gripped — hands-on drag
    if (opts?.grabTarget && b.st !== 1) {
      this.group.updateMatrixWorld();
      this.aimArm(this.armL, opts.grabTarget);
      this.aimArm(this.armR, opts.grabTarget);
      this.legsWalk(speed);
      return;
    }

    if (b.act === 1) {
      // mid-shove: both arms thrust straight forward, palms out
      this.armL.rotation.set(-1.62, 0, 0.06);
      this.armR.rotation.set(-1.62, 0, -0.06);
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
    } else {
      // idle groove: subtle bob + arm pump synced to the beat
      const g = Math.sin((beat + this.dancePhase) * Math.PI * 2);
      const h = Math.sin((beat + this.dancePhase) * Math.PI);
      this.armL.rotation.set(-0.12 + g * 0.16, 0, 0.16 + h * 0.05);
      this.armR.rotation.set(-0.12 - g * 0.16, 0, -0.16 - h * 0.05);
      this.legL.rotation.set(g * 0.06, 0, 0.05);
      this.legR.rotation.set(-g * 0.06, 0, -0.05);
      this.torso.position.y = Math.abs(g) * -0.035;
      this.head.rotation.x = g * 0.06;
    }
  }

  private legsWalk(speed: number): void {
    const s = speed > 0.4 ? Math.sin(this.walkPhase) : 0;
    this.legL.rotation.set(-s * 0.8, 0, 0.03);
    this.legR.rotation.set(s * 0.8, 0, -0.03);
  }

  /** rotate an arm pivot so the arm (which hangs along -Y) points at a world target */
  private aimArm(arm: THREE.Object3D, worldTarget: THREE.Vector3): void {
    tmpV.copy(worldTarget);
    this.group.worldToLocal(tmpV);
    tmpV.sub(arm.position).normalize();
    tmpQ.setFromUnitVectors(DOWN_ARM, tmpV);
    arm.quaternion.copy(tmpQ);
  }
}
