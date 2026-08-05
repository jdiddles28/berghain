// A Session hides whether we're the authoritative host or a thin client.
// Main loop: sample input → session.frame() → session.renderFrame() → view.

import type { GameEvent, PlayerInput, RenderFrame } from '../sim/types';

export interface Session {
  readonly role: 'host' | 'client';
  readonly localId: string;
  status(): string;
  frame(frameDt: number, localInput: PlayerInput): void;
  renderFrame(): RenderFrame | null;
  drainEvents(): GameEvent[];
  destroy(): void;
}
