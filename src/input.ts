// Pointer-lock mouse camera + camera-relative WASD (Peak scheme).
// The sim receives a world-space desired move direction; the body's yaw servo
// turns to face it. Mouse only ever moves the camera.

import { CONFIG } from './config';
import type { PlayerInput } from './sim/types';

export class Input {
  camYaw = 0;
  camPitch = 0; // first person: level gaze by default
  private keys = new Set<string>();
  private shoveQueued = false;
  private hopQueued = false;
  private grabHeld = false;
  locked = false;

  constructor(el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') {
        this.hopQueued = true;
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    el.addEventListener('mousedown', (e) => {
      if (!this.locked) {
        el.requestPointerLock();
        return;
      }
      if (e.button === 0) this.shoveQueued = true;
      if (e.button === 2) this.grabHeld = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.grabHeld = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
      if (!this.locked) this.keys.clear();
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.camYaw -= e.movementX * 0.0024;
      this.camPitch = Math.max(
        CONFIG.camera.pitchMin,
        Math.min(CONFIG.camera.pitchMax, this.camPitch - e.movementY * 0.0022),
      );
    });
  }

  /** Sample and clear edge-triggered actions. */
  sample(): PlayerInput {
    let ix = 0;
    let iz = 0;
    if (this.keys.has('KeyW')) iz += 1;
    if (this.keys.has('KeyS')) iz -= 1;
    if (this.keys.has('KeyA')) ix -= 1;
    if (this.keys.has('KeyD')) ix += 1;
    // rotate stick by camera yaw into world XZ. camera looks along -Z at yaw 0
    // (three.js orbit convention used in view.ts); forward = away from camera.
    let moveX = 0;
    let moveZ = 0;
    const mag = Math.hypot(ix, iz);
    if (mag > 0) {
      ix /= mag;
      iz /= mag;
      const sin = Math.sin(this.camYaw);
      const cos = Math.cos(this.camYaw);
      moveX = ix * cos - iz * sin;
      moveZ = -ix * sin - iz * cos;
    }
    // first person: the body faces where the camera looks.
    // camera sits at -Z of the view direction, so facing = camYaw + π.
    let faceYaw = this.camYaw + Math.PI;
    while (faceYaw > Math.PI) faceYaw -= Math.PI * 2;
    while (faceYaw < -Math.PI) faceYaw += Math.PI * 2;
    const out: PlayerInput = {
      moveX,
      moveZ,
      faceYaw,
      hop: this.hopQueued,
      shove: this.shoveQueued,
      grab: this.grabHeld,
    };
    this.hopQueued = false;
    this.shoveQueued = false;
    return out;
  }
}
