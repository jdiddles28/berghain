// The line-cutting minigame — CLIENT side (b17, John's design).
//
// Hold LMB on the bag → the phone comes out (left hand), the bag rides the
// right, and the MOUSE IS YOUR HAND. Phase 1: shake gently over the screen
// and powder pours out. Click → the card: plow the powder around like damp
// sand and split it into lines. Click → the rolled bill: hold LMB and drag
// along a line and it hoovers up exactly what you pass over. RMB at any
// point = everything vanishes into your pockets fast (the panic button).
//
// The powder is the promised "videogame trickery": a 2D height-grid over the
// phone screen, drawn into a canvas texture that view.ts maps onto a 3D
// phone under real 3D props. It FEELS like sand; it costs nothing.
//
// Authority: this module only produces FEEL and reports numbers. The host
// clamps every reported gram against the real bag/phone, and quantizes doses
// to the secret 0.025 g bucket (sim.updateCutting). If the sim says no (bag
// snatched, you got floored), the next snapshot says so and we fold.

import { CONFIG } from './config';

const CT = CONFIG.cutting;

export class Cutting {
  active = false;
  phase: 0 | 1 | 2 | 3 = 0;
  /** hand position in screen space, 0..1 across the phone glass */
  handX = 0.5;
  handY = 0.35;
  /** grams reported to the sim this frame (drained by take()) */
  pourOut = 0;
  snortOut = 0;
  /** the current snort stroke, committed (bucketed by the host) on release */
  private strokeG = 0;
  private sucking = false;
  /** recent shake energy — gentle jiggling pours, stillness doesn't */
  private shake = 0;
  private prevHX = 0.5;
  private prevHY = 0.35;

  readonly W = CT.grid.w;
  readonly H = CT.grid.h;
  /** grams per cell */
  grid = new Float32Array(this.W * this.H);
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  dirty = true;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W * 6;
    this.canvas.height = this.H * 6;
    this.ctx = this.canvas.getContext('2d')!;
    this.draw();
  }

  /** total grams currently sitting on the glass (client view of it) */
  onGlass(): number {
    let s = 0;
    for (let i = 0; i < this.grid.length; i++) s += this.grid[i];
    return s;
  }

  start(): void {
    this.active = true;
    this.phase = 1;
    this.handX = 0.5;
    this.handY = 0.35;
    this.shake = 0;
    this.strokeG = 0;
    this.sucking = false;
    this.dirty = true;
  }

  /** put it all away (RMB, or the sim ended the ritual for us). Whatever is
   *  on the glass STAYS on the glass — the phone goes into your pocket dirty
   *  and the pile is waiting when you next pull it out. */
  stop(): void {
    if (this.sucking) this.commitStroke();
    this.active = false;
    this.phase = 0;
  }

  /** LMB press edge: advance the ritual (pour → cut → snort). In phase 3 the
   *  press starts a suction stroke instead — release commits it. */
  click(): void {
    if (!this.active) return;
    if (this.phase === 1) this.phase = 2;
    else if (this.phase === 2) this.phase = 3;
    else if (this.phase === 3) this.sucking = true;
  }

  release(): void {
    if (this.phase === 3 && this.sucking) {
      this.sucking = false;
      this.commitStroke();
    }
  }

  /** a finished stroke is ONE line snorted — the host rounds it to the
   *  nearest secret 0.025 g bucket (John: they register the same) */
  private commitStroke(): void {
    if (this.strokeG > 0.001) this.snortOut += this.strokeG;
    this.strokeG = 0;
  }

  /** mouse deltas drive the hand while the ritual is open */
  onMouse(dx: number, dy: number): void {
    if (!this.active) return;
    this.handX = Math.min(1, Math.max(0, this.handX + dx * 0.0035));
    this.handY = Math.min(1, Math.max(0, this.handY + dy * 0.0035));
    this.shake = Math.min(1.6, this.shake + Math.hypot(dx, dy) * 0.02);
  }

  /** per-frame powder sim. bagG = what the last snapshot says the bag still
   *  holds (minus what we've poured and not heard back about). */
  update(dt: number, bagG: number): void {
    if (!this.active) return;
    this.shake = Math.max(0, this.shake - dt * 3.2);

    if (this.phase === 1) {
      // gentle taps pour; the glass can only hold so much before it's silly
      const room = Math.max(0, CT.pourMax - this.onGlass());
      const g = Math.min(CT.pourRate * Math.min(1, this.shake) * dt, bagG, room);
      if (g > 0) {
        this.sprinkle(this.handX, this.handY, g);
        this.pourOut += g;
      }
    } else if (this.phase === 2) {
      this.plow();
    } else if (this.phase === 3 && this.sucking) {
      const g = this.suck(dt);
      this.strokeG += g;
    }
    this.prevHX = this.handX;
    this.prevHY = this.handY;
  }

  /** drain the reported quantities (main.ts feeds them into PlayerInput) */
  take(): { pour: number; snort: number } {
    const out = { pour: this.pourOut, snort: this.snortOut };
    this.pourOut = 0;
    this.snortOut = 0;
    return out;
  }

  /** the sim knocked us down: everything on the glass is on the FLOOR now */
  spill(): void {
    this.grid.fill(0);
    this.strokeG = 0;
    this.sucking = false;
    this.dirty = true;
    this.stop();
  }

  /** rebuild the glass from the host's scalar (rejoining a dirty phone) */
  seed(grams: number): void {
    this.grid.fill(0);
    if (grams > 0.001) this.sprinkle(0.5, 0.4, grams);
    this.dirty = true;
  }

  // ---------- powder physics (the trickery) ----------

  private cell(x: number, y: number): number {
    return Math.min(this.H - 1, Math.max(0, y)) * this.W + Math.min(this.W - 1, Math.max(0, x));
  }

  /** powder falls in a loose little heap under the bag's corner */
  private sprinkle(hx: number, hy: number, g: number): void {
    const cx = hx * (this.W - 1);
    const cy = hy * (this.H - 1);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 2.2;
      const x = Math.round(cx + Math.cos(a) * r);
      const y = Math.round(cy + Math.sin(a) * r * 0.7);
      this.grid[this.cell(x, y)] += g / n;
    }
    this.dirty = true;
  }

  /** the card: a short edge perpendicular to its motion that pushes whatever
   *  it sweeps over into the cells just ahead — damp sand, effectively. Slow
   *  careful strokes build ridges (lines); fast slashes scatter. */
  private plow(): void {
    const mx = this.handX - this.prevHX;
    const my = this.handY - this.prevHY;
    const dist = Math.hypot(mx, my);
    if (dist < 0.002) return;
    const dirX = mx / dist;
    const dirY = my / dist;
    // the card edge is perpendicular to the motion
    const px = -dirY;
    const py = dirX;
    const steps = Math.max(1, Math.ceil(dist * this.W));
    const half = CT.cardHalfLen; // in screen units
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const cx = (this.prevHX + mx * t) * (this.W - 1);
      const cy = (this.prevHY + my * t) * (this.H - 1);
      const halfCells = half * this.H;
      for (let e = -halfCells; e <= halfCells; e += 0.8) {
        const x = Math.round(cx + px * e * (this.W / this.H));
        const y = Math.round(cy + py * e);
        if (x < 0 || x >= this.W || y < 0 || y >= this.H) continue;
        const i = y * this.W + x;
        const carry = this.grid[i] * CT.cardPush;
        if (carry <= 1e-6) continue;
        this.grid[i] -= carry;
        // deposit just ahead of the edge, slightly spread
        const ax = Math.round(x + dirX * 1.6 * (this.W / this.H));
        const ay = Math.round(y + dirY * 1.6);
        this.grid[this.cell(ax, ay)] += carry * 0.75;
        this.grid[this.cell(ax + Math.sign(px), ay + Math.sign(py))] += carry * 0.125;
        this.grid[this.cell(ax - Math.sign(px), ay - Math.sign(py))] += carry * 0.125;
      }
    }
    this.dirty = true;
  }

  /** the bill: a vacuum nozzle — only what you actually pass over goes up */
  private suck(dt: number): number {
    const cx = this.handX * (this.W - 1);
    const cy = this.handY * (this.H - 1);
    const r = CT.snortRadius * this.H;
    let want = CT.snortRate * dt;
    let got = 0;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x < 0 || x >= this.W || y < 0 || y >= this.H) continue;
        if (Math.hypot(x - cx, y - cy) > r) continue;
        const i = y * this.W + x;
        if (this.grid[i] <= 0) continue;
        const g = Math.min(this.grid[i], want * 0.5);
        this.grid[i] -= g;
        got += g;
        want -= g;
        if (want <= 0) break;
      }
      if (want <= 0) break;
    }
    if (got > 0) this.dirty = true;
    return got;
  }

  // ---------- the glass, drawn ----------

  /** black glass, white powder shaded by height — looks 3D enough under the
   *  real 3D card/bill because the light does the work */
  draw(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const c = this.ctx;
    const s = 6; // px per cell
    // the screen: near-black with a faint sheen
    c.fillStyle = '#07070b';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    c.fillStyle = '#101018';
    c.fillRect(0, 0, this.canvas.width, 8);
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        const g = this.grid[y * this.W + x];
        if (g <= 1e-5) continue;
        // brightness by depth; neighbors' difference fakes edge shading
        const left = x > 0 ? this.grid[y * this.W + x - 1] : 0;
        const shade = Math.min(1, g * 900);
        const lit = Math.min(1, Math.max(0, 0.62 + (g - left) * 380));
        const v = Math.round(150 + 105 * shade * lit);
        c.fillStyle = `rgb(${v},${v},${Math.round(v * 0.97)})`;
        const h = Math.min(1, 0.35 + g * 700);
        c.fillRect(x * s, y * s + (1 - h) * s * 0.5, s, s * h);
      }
    }
  }
}
