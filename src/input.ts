// Pointer-lock mouse camera + camera-relative WASD (Peak scheme).
// The sim receives a world-space desired move direction; the body's yaw servo
// turns to face it. Mouse only ever moves the camera — EXCEPT mid-ritual
// (b17): while the cutting minigame is open the mouse is your HAND, and the
// camera holds still.

import { CONFIG } from './config';
import type { Cutting } from './cutting';
import type { PlayerInput } from './sim/types';

export class Input {
  camYaw = 0;
  camPitch = 0; // first person: level gaze by default
  /** selected inventory slot 0-2 — mouse wheel (b17) */
  slot = 0;
  /** an end-screen menu is up: stop feeding the game, stop grabbing the mouse */
  uiOpen = false;
  /** wired by main.ts — when active, mouse goes to the hand, not the camera */
  cutting: Cutting | null = null;
  private keys = new Set<string>();
  private hopQueued = false;
  private grabHeld = false;
  private useHeld = false;
  locked = false;

  constructor(private el: HTMLElement) {
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
    // the inventory (b17): wheel cycles the 3 slots
    window.addEventListener(
      'wheel',
      (e) => {
        if (this.uiOpen) return;
        const d = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
        this.slot = ((this.slot + d) % 3 + 3) % 3;
      },
      { passive: true },
    );

    el.addEventListener('mousedown', (e) => {
      if (this.uiOpen) return; // menus own the mouse
      if (!this.locked) this.tryLock();
      // actions fire whether or not the lock took — pointer lock is flaky on
      // some machines (Maja's playtest) and the game must stay playable without it
      if (e.button === 0) {
        this.useHeld = true; // LMB: use what's in your hand
        this.cutting?.click(); // mid-ritual: advance pour → cut → snort
      }
      if (e.button === 2) {
        if (this.cutting?.active) this.cutting.stop(); // RMB: put it all AWAY
        else this.grabHeld = true; // RMB: pick up / grip
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        this.useHeld = false;
        this.cutting?.release(); // a snort stroke commits on release
      }
      if (e.button === 2) this.grabHeld = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
      if (!this.locked) this.keys.clear();
    });
    window.addEventListener('mousemove', (e) => {
      if (this.uiOpen) return;
      // mid-ritual the mouse is the HAND over the phone (b17)
      if (this.cutting?.active) {
        this.cutting.onMouse(e.movementX, e.movementY);
        return;
      }
      // locked: normal mouselook. unlocked: drag-look with any button held —
      // the works-everywhere fallback when a browser won't hold the lock
      if (!this.locked && e.buttons === 0) return;
      this.camYaw -= e.movementX * 0.0024;
      this.camPitch = Math.max(
        CONFIG.camera.pitchMin,
        Math.min(CONFIG.camera.pitchMax, this.camPitch - e.movementY * 0.0022),
      );
    });
  }

  /** Pointer lock with raw (unaccelerated) input where supported. Chrome
   *  returns a promise that REJECTS both when unadjustedMovement is
   *  unsupported and when Esc was pressed too recently — fall back to a plain
   *  request instead of failing silently. */
  private tryLock(): void {
    let p: unknown;
    try {
      p = (
        this.el.requestPointerLock as unknown as (o?: { unadjustedMovement: boolean }) => unknown
      ).call(this.el, { unadjustedMovement: true });
    } catch {
      p = this.el.requestPointerLock();
    }
    if (p instanceof Promise) {
      p.catch(() => {
        try {
          this.el.requestPointerLock();
        } catch {
          /* no pointer lock on this browser — drag-look covers it */
        }
      });
    }
  }

  /** the end screens are MENUS (b17, John): free the mouse, mute the game */
  setUiOpen(open: boolean): void {
    if (open === this.uiOpen) return;
    this.uiOpen = open;
    if (open) {
      this.keys.clear();
      this.grabHeld = false;
      this.useHeld = false;
      this.cutting?.stop();
      if (document.pointerLockElement === this.el) document.exitPointerLock();
    }
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
    const cut = this.cutting;
    const cutFlow = cut?.active ? cut.take() : { pour: 0, snort: 0 };
    const ui = this.uiOpen;
    const out: PlayerInput = {
      moveX: ui ? 0 : moveX,
      moveZ: ui ? 0 : moveZ,
      faceYaw,
      facePitch: this.camPitch,
      sprint: !ui && (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')),
      hop: !ui && this.hopQueued,
      grab: !ui && this.grabHeld,
      use: !ui && this.useHeld,
      drop: !ui && this.keys.has('KeyQ'), // tap: drop · hold: charge a throw
      dance: !ui && this.keys.has('KeyE'), // the sim toggles the dance state on the press edge
      slot: this.slot,
      cutPhase: cut?.active ? cut.phase : 0,
      pour: cutFlow.pour,
      snort: cutFlow.snort,
    };
    this.hopQueued = false;
    return out;
  }
}
