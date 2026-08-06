// THE LINE SYSTEM (b15, John): "lines will be a foundational part of the feel
// of this game — the bathroom, the entrance, the garderobe, the bar. Don't
// design a system that only works in this one situation."
//
// A LinePath is John's "invisible squares" idea made literal: given a service
// point (a door, a bar, a booth) and the direction a line should head, it lays
// out a train of invisible standing spots, one per queue position. Each spot
// must be STANDABLE — a clearance ball at chest height may touch no static
// geometry — and when the straight continuation would bury a spot in a wall,
// the train turns: it tries gentle bends first (preferring to keep bending the
// same way, so lines wrap smoothly around corners instead of zigzagging).
// The result: straight lines where there's room, lines that snake along walls
// and wrap corners where there isn't.
//
// What lives here is the GEOMETRY of a line. Membership etiquette (join at
// the back, only the front advances, leave the train = lose your place) is
// enforced by the sim on the member array, and is already line-agnostic; the
// only per-line code is what happens when you reach the front (use the stall,
// order a drink…). A future club maps each service to its own LinePath.
//
// Headless: Rapier only, no three.js. Slots are computed once per Sim build —
// the room is static; a dynamic room would just recompute.

import RAPIER from '@dimforge/rapier3d-compat';

export interface LineOpts {
  /** distance between neighbouring spots */
  spacing: number;
  /** how many spots the line can hold */
  count: number;
  /** radius of the invisible square: a spot needs this much clear floor */
  clearance: number;
}

export class LinePath {
  /** the invisible squares, front first */
  readonly slots: { x: number; z: number }[] = [];

  constructor(
    world: RAPIER.World,
    anchor: { x: number; z: number },
    dir: { x: number; z: number },
    opts: LineOpts,
  ) {
    // NOTE: scene queries see nothing until the world has stepped at least
    // once (rapier builds its query pipeline in step()) — the Sim primes the
    // world with one static-only step before laying out any line
    const norm = Math.hypot(dir.x, dir.z) || 1;
    let dx = dir.x / norm;
    let dz = dir.z / norm;
    let px = anchor.x;
    let pz = anchor.z;
    this.slots.push({ x: px, z: pz });
    // bend preference: once the line turns one way it keeps favouring that
    // side — that's what makes it WRAP a corner instead of ping-ponging
    let bendSign = 1;
    for (let i = 1; i < opts.count; i++) {
      let placed = false;
      // straight first, then ever-sharper bends, preferred side first
      for (const mag of [0, 0.6, 1.2, 1.8, 2.4]) {
        for (const side of mag === 0 ? [1] : [bendSign, -bendSign]) {
          const a = mag * side;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const ndx = dx * ca - dz * sa;
          const ndz = dx * sa + dz * ca;
          const nx = px + ndx * opts.spacing;
          const nz = pz + ndz * opts.spacing;
          if (!standable(world, nx, nz, opts.clearance)) continue;
          if (mag !== 0) bendSign = side;
          px = nx;
          pz = nz;
          dx = ndx;
          dz = ndz;
          this.slots.push({ x: px, z: pz });
          placed = true;
          break;
        }
        if (placed) break;
      }
      if (!placed) {
        // fully boxed in (shouldn't happen in a sane room): the tail of the
        // line compresses onto the last good spot rather than clipping walls
        this.slots.push({ x: px, z: pz });
      }
    }
  }

  slot(i: number): { x: number; z: number } {
    return this.slots[Math.min(i, this.slots.length - 1)];
  }
}

/** an invisible square only occupies STANDABLE area: a clearance ball at
 *  chest height may intersect no static collider (walls, pillars, stage,
 *  the toilet). Dynamic things — people, the swinging door, thrown bags —
 *  don't disqualify a spot; they move. Exported: the crowd's roam sampler
 *  uses the same notion of "somewhere a person can stand". */
export function standable(world: RAPIER.World, x: number, z: number, clearance: number): boolean {
  let blocked = false;
  world.intersectionsWithShape(
    { x, y: 0.9, z },
    { x: 0, y: 0, z: 0, w: 1 },
    new RAPIER.Ball(clearance),
    (col) => {
      const parent = col.parent();
      if (parent && parent.isFixed() && !col.isSensor()) {
        blocked = true;
        return false; // stop the search
      }
      return true;
    },
  );
  return !blocked;
}
