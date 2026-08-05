// One clubber: faceted low-poly body driven by the sim's rigid body transform,
// with cheap procedural limbs (walk swing, dance bob, ragdoll dangle).
// Flat shading everywhere — papercraft, not Roblox.

import * as THREE from 'three';
import type { BodySnap } from '../sim/types';

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

  constructor(outfit: number, skin: number, scale = 1) {
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

  update(b: BodySnap, dt: number, beat: number): void {
    this.group.position.set(b.pos.x, b.pos.y, b.pos.z);
    this.group.quaternion.set(b.rot.x, b.rot.y, b.rot.z, b.rot.w);

    const speed = Math.hypot(b.vel.x, b.vel.z);
    this.walkPhase += speed * dt * 5.2;

    if (b.st === 1) {
      // down: limbs dangle loose
      const flop = Math.sin(beat * Math.PI) * 0.25;
      this.armL.rotation.set(2.4 + flop, 0, 0.5);
      this.armR.rotation.set(2.2 - flop, 0, -0.5);
      this.legL.rotation.set(0.4 + flop * 0.5, 0, 0.25);
      this.legR.rotation.set(0.5 - flop * 0.5, 0, -0.25);
      return;
    }

    if (speed > 0.4) {
      // walk swing
      const s = Math.sin(this.walkPhase);
      this.armL.rotation.set(s * 0.7, 0, 0.12);
      this.armR.rotation.set(-s * 0.7, 0, -0.12);
      this.legL.rotation.set(-s * 0.8, 0, 0.03);
      this.legR.rotation.set(s * 0.8, 0, -0.03);
    } else {
      // idle groove: subtle bob + arm pump synced to the beat — arms mostly
      // DOWN (raised splayed arms read penguin, not raver)
      const g = Math.sin((beat + this.dancePhase) * Math.PI * 2);
      const h = Math.sin((beat + this.dancePhase) * Math.PI); // half-time
      this.armL.rotation.set(-0.12 + g * 0.16, 0, 0.16 + h * 0.05);
      this.armR.rotation.set(-0.12 - g * 0.16, 0, -0.16 - h * 0.05);
      this.legL.rotation.set(g * 0.06, 0, 0.05);
      this.legR.rotation.set(-g * 0.06, 0, -0.05);
      this.torso.position.y = Math.abs(g) * -0.035;
      this.head.rotation.x = g * 0.06; // nod, don't headbang sideways
    }
  }
}
