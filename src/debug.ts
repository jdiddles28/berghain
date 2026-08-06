// window.__game — playtest/debug API (host only). Mirrors the Den of Thieves habit.

import type { HostSession } from './net/host';

export function installDebug(host: HostSession): void {
  const g = {
    /** raw sim access for staging playtest situations from the console.
     *  A getter: restart() swaps host.sim, a captured reference goes stale. */
    get sim() {
      return host.sim;
    },
    getState: () => host.sim.snapshot(),
    /** teleport the LOCAL player (host). __game.teleport(x, z) — y is derived. */
    teleport: (x: number, z: number) => {
      const ch = host.sim.players.get(host.localId);
      if (!ch) return;
      ch.body.setTranslation({ x, y: 1.2, z }, true);
      ch.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    },
    /** shove everyone away from the local player, for chaos testing */
    boom: (mag = 300) => {
      const me = host.sim.players.get(host.localId);
      if (!me) return;
      const p = me.body.translation();
      for (const npc of host.sim.npcs) {
        const np = npc.body.translation();
        const dx = np.x - p.x;
        const dz = np.z - p.z;
        const d = Math.hypot(dx, dz) || 1;
        npc.body.applyImpulse({ x: (dx / d) * mag, y: mag * 0.25, z: (dz / d) * mag }, true);
      }
    },
  };
  (window as unknown as { __game: typeof g }).__game = g;
}
