// three.js view layer. Reads RenderFrames, never mutates sim.
// Dark club: near-black fog, beat-driven colored light rig, no shadow maps
// (integrated-GPU budget; the darkness IS the look).

import * as THREE from 'three';
import { CONFIG } from '../config';
import type { RenderFrame } from '../sim/types';
import { ClubberView } from './clubberView';

export class View {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;

  private players = new Map<string, ClubberView>();
  private npcs: ClubberView[] = [];
  private beams: { light: THREE.PointLight; baseColor: THREE.Color; phase: number }[] = [];
  private strobe: THREE.PointLight;
  private lastTime = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x030308);
    this.scene.fog = new THREE.Fog(0x030308, 6, 26);

    this.camera = new THREE.PerspectiveCamera(
      CONFIG.camera.fov,
      window.innerWidth / window.innerHeight,
      0.1,
      60,
    );
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    this.buildRoom();

    // light rig: dim-but-readable base + colored moving points + a rare strobe
    // pop. dark club ≠ murky: you must always read bodies and the room.
    this.scene.add(new THREE.AmbientLight(0x241d33, 2.4));
    this.scene.add(new THREE.HemisphereLight(0x2a2438, 0x0c0a12, 1.1));
    const rigColors = [0xff2244, 0x2244ff, 0x22ddcc];
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(rigColors[i], 30, 20, 1.4);
      light.position.set(0, 3.4, 0);
      this.scene.add(light);
      this.beams.push({ light, baseColor: new THREE.Color(rigColors[i]), phase: (i / 3) * Math.PI * 2 });
    }
    this.strobe = new THREE.PointLight(0xffffff, 0, 20, 1.2);
    this.strobe.position.set(0, CONFIG.room.wallH - 0.4, 0);
    this.scene.add(this.strobe);
  }

  private buildRoom(): void {
    const R = CONFIG.room;
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x17151a, flatShading: true });
    const floorMat = new THREE.MeshLambertMaterial({ color: 0x101014, flatShading: true });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x0c0b10, flatShading: true });

    const floor = new THREE.Mesh(new THREE.BoxGeometry(R.w + 2, 1, R.d + 2), floorMat);
    floor.position.y = -0.5;
    this.scene.add(floor);

    // worn concrete patches — motion parallax so running actually LOOKS fast
    const patchShades = [0x15151a, 0x0d0d11, 0x18181d];
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(0.5 + ((i * 29) % 10) * 0.14, 5 + (i % 3)),
        new THREE.MeshLambertMaterial({ color: patchShades[i % 3], flatShading: true }),
      );
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = i * 1.7;
      m.position.set(
        (((i * 53) % 100) / 100 - 0.5) * (R.w - 2),
        0.005 + (i % 2) * 0.002,
        (((i * 31) % 100) / 100 - 0.5) * (R.d - 2),
      );
      this.scene.add(m);
    }

    const mkWall = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, R.wallH, d), wallMat);
      m.position.set(x, R.wallH / 2, z);
      this.scene.add(m);
    };
    mkWall(R.w, 0.3, 0, -R.d / 2);
    mkWall(R.w, 0.3, 0, R.d / 2);
    mkWall(0.3, R.d, -R.w / 2, 0);
    mkWall(0.3, R.d, R.w / 2, 0);

    for (const p of R.pillars) {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(R.pillarR, R.pillarR, R.wallH, 7),
        wallMat,
      );
      m.position.set(p.x, R.wallH / 2, p.z);
      this.scene.add(m);
    }

    // stage + speaker stacks on it (visual only above the collider box)
    const s = R.stage;
    const stage = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.d), darkMat);
    stage.position.set(s.x, s.h / 2, s.z);
    this.scene.add(stage);
    for (const sx of [-s.w / 2 + 0.7, s.w / 2 - 0.7]) {
      const stack = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.2, 1.0), darkMat);
      stack.position.set(s.x + sx, s.h + 1.1, s.z - 0.3);
      this.scene.add(stack);
      const cone = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.42, 0.16, 8),
        new THREE.MeshLambertMaterial({ color: 0x2a2a30, flatShading: true }),
      );
      cone.rotation.x = Math.PI / 2;
      cone.position.set(s.x + sx, s.h + 1.4, s.z + 0.22);
      this.scene.add(cone);
    }
  }

  ensurePlayer(id: string, slot: number): void {
    if (this.players.has(id)) return;
    const colors = CONFIG.colors;
    const cv = new ClubberView(
      colors.players[slot % colors.players.length],
      colors.skin[slot % colors.skin.length],
    );
    this.players.set(id, cv);
    this.scene.add(cv.group);
  }

  removePlayer(id: string): void {
    const cv = this.players.get(id);
    if (cv) {
      this.scene.remove(cv.group);
      this.players.delete(id);
    }
  }

  render(frame: RenderFrame, camYaw: number, camPitch: number, localId: string): void {
    const dt = Math.min(0.1, Math.max(0.0001, frame.time - this.lastTime));
    this.lastTime = frame.time;

    // players
    let slot = 0;
    for (const id of Object.keys(frame.players)) {
      this.ensurePlayer(id, slot++);
    }
    for (const [id, cv] of this.players) {
      const b = frame.players[id];
      if (b) cv.update(b, dt, frame.beat);
    }
    // crowd
    const colors = CONFIG.colors;
    while (this.npcs.length < frame.npcs.length) {
      const i = this.npcs.length;
      const cv = new ClubberView(
        colors.crowd[i % colors.crowd.length],
        colors.skin[(i * 2 + 1) % colors.skin.length],
        0.94 + ((i * 37) % 13) * 0.011, // slight size variety
      );
      this.npcs.push(cv);
      this.scene.add(cv.group);
    }
    for (let i = 0; i < frame.npcs.length; i++) this.npcs[i].update(frame.npcs[i], dt, frame.beat);

    // light rig rides the beat
    const beatFrac = frame.beat - Math.floor(frame.beat);
    const pulse = Math.max(0, 1 - beatFrac * 3.2); // sharp attack on each kick
    for (const b of this.beams) {
      const t = frame.time * 0.5 + b.phase;
      b.light.position.set(Math.cos(t) * 5.2, 3.1 + Math.sin(t * 1.7) * 0.6, Math.sin(t * 0.8) * 3.6);
      b.light.intensity = 28 + pulse * 42;
    }
    // strobe: two quick white pops at the top of every 16-beat phrase
    const phrase = frame.beat % 16;
    this.strobe.intensity = phrase < 0.5 || (phrase > 1 && phrase < 1.3) ? 55 : 0;

    // camera: orbit the local player, clamped inside the room
    const me = frame.players[localId];
    if (me) {
      const C = CONFIG.camera;
      const target = new THREE.Vector3(me.pos.x, me.pos.y + 0.5, me.pos.z);
      const off = new THREE.Vector3(
        Math.sin(camYaw) * Math.cos(camPitch),
        -Math.sin(camPitch),
        Math.cos(camYaw) * Math.cos(camPitch),
      ).multiplyScalar(C.dist);
      const pos = target.clone().add(off);
      pos.y = Math.max(0.25, pos.y + C.height - 0.5);
      const R = CONFIG.room;
      pos.x = THREE.MathUtils.clamp(pos.x, -R.w / 2 + 0.4, R.w / 2 - 0.4);
      pos.z = THREE.MathUtils.clamp(pos.z, -R.d / 2 + 0.4, R.d / 2 - 0.4);
      pos.y = Math.min(pos.y, R.wallH - 0.3);
      this.camera.position.copy(pos);
      this.camera.lookAt(target);
    }

    this.renderer.render(this.scene, this.camera);
  }
}
