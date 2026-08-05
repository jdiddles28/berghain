// Client session: connects to a host by room code, streams inputs up,
// interpolates the snapshot buffer ~125 ms behind the newest snapshot.

import { Peer, type DataConnection } from 'peerjs';
import { CONFIG } from '../config';
import type { GameEvent, PlayerInput, RenderFrame, SimSnapshot } from '../sim/types';
import { lerpSnapshot } from '../sim/types';
import {
  decodeSnapshot,
  INTERP_DELAY_SNAPS,
  PEER_OPTS,
  PROTOCOL_VERSION,
  ROOM_PREFIX,
  SNAP_EVERY,
  type CtlMsg,
  type FastMsg,
} from './protocol';
import type { Session } from './session';

interface BufferedSnap {
  index: number;
  snap: SimSnapshot;
}

export class ClientSession implements Session {
  readonly role = 'client';
  localId = '?';

  private peer: Peer;
  private fast: DataConnection | null = null;
  private state = 'connecting…';
  /** a terminal state (joined/refused/error) has been reached — the
   *  can't-open-a-path timeout must not overwrite it */
  private settled = false;

  private buffer: BufferedSnap[] = [];
  private latestIndex = -1;
  private latestArrival = 0;
  private pendingEvents: GameEvent[] = [];

  constructor(code: string) {
    const hostId = ROOM_PREFIX + code.toUpperCase();
    this.peer = new Peer(PEER_OPTS);
    this.peer.on('open', () => {
      this.state = `joining ${code.toUpperCase()} — opening a connection…`;
      const ctl = this.peer.connect(hostId, { label: 'ctl', reliable: true });
      // the classic silent failure: signaling reaches the host (their count
      // goes up) but strict NATs block the actual data path, and the joiner
      // stares at "connecting" forever. Name the problem + the workarounds.
      setTimeout(() => {
        if (!this.settled) {
          this.state =
            'found the room, but the connection won\'t open —\n' +
            'a strict network (school/office wifi) is probably blocking it.\n' +
            'try: phone hotspot, or swap who hosts. then re-join.';
        }
      }, 15000);
      ctl.on('open', () => {
        this.state = 'connected — checking version…';
        ctl.send({ t: 'hello', v: PROTOCOL_VERSION } satisfies CtlMsg);
      });
      ctl.on('data', (raw) => {
        const msg = raw as CtlMsg;
        if (msg.t === 'init') {
          this.settled = true;
          if (msg.v !== PROTOCOL_VERSION) {
            // old host, new client: their build predates the version handshake
            this.state = 'the HOST is on an old version — they must refresh, then re-host';
            ctl.close();
            return;
          }
          this.localId = msg.playerId;
          this.state = '';
          this.openFast(hostId);
        } else if (msg.t === 'stale') {
          this.settled = true;
          this.state = 'game updated! REFRESH this page (Ctrl+R), then rejoin';
        } else if (msg.t === 'full') {
          this.settled = true;
          this.state = 'room is full!';
        } else if (msg.t === 'ev') {
          this.pendingEvents.push(...msg.evs);
        }
      });
      ctl.on('close', () => {
        if (!this.state) this.state = 'disconnected from host';
      });
      ctl.on('error', () => {
        this.settled = true;
        this.state = 'connection failed — check the code?';
      });
    });
    this.peer.on('error', (err: Error & { type?: string }) => {
      this.settled = true;
      if (err.type === 'peer-unavailable') this.state = `no room "${code.toUpperCase()}" found`;
      else this.state = `network error (${err.type ?? 'unknown'})`;
    });
  }

  private openFast(hostId: string): void {
    const fast = this.peer.connect(hostId, { label: 'fast', reliable: false });
    this.fast = fast;
    fast.on('data', (raw) => {
      const msg = raw as FastMsg;
      if (msg.t !== 'snap') return;
      const index = msg.seq / SNAP_EVERY;
      if (index <= this.latestIndex - 30) return;
      this.buffer.push({ index, snap: decodeSnapshot(msg, CONFIG.music.bpm) });
      this.buffer.sort((a, b) => a.index - b.index);
      if (this.buffer.length > 40) this.buffer.splice(0, this.buffer.length - 40);
      if (index > this.latestIndex) {
        this.latestIndex = index;
        this.latestArrival = performance.now();
      }
    });
  }

  status(): string {
    if (this.state) return this.state;
    // joined but nothing streamed yet: label the black screen instead of
    // leaving people staring at the void wondering if it broke
    if (this.buffer.length === 0) return 'joined — streaming the club in…';
    return `In as player ${this.localId.slice(1)} · b${PROTOCOL_VERSION}`;
  }

  drainEvents(): GameEvent[] {
    const evs = this.pendingEvents;
    this.pendingEvents = [];
    return evs;
  }

  frame(_frameDt: number, localInput: PlayerInput): void {
    if (this.fast?.open) {
      this.fast.send({
        t: 'in',
        mx: Math.round(localInput.moveX * 1000) / 1000,
        mz: Math.round(localInput.moveZ * 1000) / 1000,
        fy: Math.round(localInput.faceYaw * 1000) / 1000,
        fp: Math.round(localInput.facePitch * 1000) / 1000,
        sp: localInput.sprint ? 1 : 0,
        h: localInput.hop ? 1 : 0,
        s: localInput.shove ? 1 : 0,
        g: localInput.grab ? 1 : 0,
      } satisfies FastMsg);
    }
  }

  renderFrame(): RenderFrame | null {
    if (this.buffer.length === 0) return null;
    const intervalMs = CONFIG.sim.dt * SNAP_EVERY * 1000;
    const ph = Math.min(
      this.latestIndex - INTERP_DELAY_SNAPS + (performance.now() - this.latestArrival) / intervalMs,
      this.latestIndex,
    );
    let a = this.buffer[0];
    let b = this.buffer[this.buffer.length - 1];
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i].index <= ph) a = this.buffer[i];
      if (this.buffer[i].index > ph) {
        b = this.buffer[i];
        break;
      }
    }
    if (a.index === b.index) return lerpSnapshot(a.snap, b.snap, 0);
    const t = clamp((ph - a.index) / (b.index - a.index), 0, 1);
    return lerpSnapshot(a.snap, b.snap, t);
  }

  destroy(): void {
    this.peer.destroy();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
