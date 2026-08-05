// Host session: runs the authoritative sim, accepts PeerJS clients, broadcasts
// snapshots. Fully playable offline — networking is best-effort on top.

import { Peer, type DataConnection } from 'peerjs';
import { CONFIG } from '../config';
import { Sim } from '../sim/sim';
import {
  lerpSnapshot,
  ZERO_INPUT,
  type GameEvent,
  type PlayerInput,
  type RenderFrame,
  type SimSnapshot,
} from '../sim/types';
import {
  encodeSnapshot,
  makeRoomCode,
  ROOM_PREFIX,
  SNAP_EVERY,
  type CtlMsg,
  type FastMsg,
} from './protocol';
import type { Session } from './session';

const MAX_PLAYERS = 3;

interface Remote {
  playerId: string;
  ctl: DataConnection;
  fast: DataConnection | null;
  input: PlayerInput;
  hopLatch: boolean;
  shoveLatch: boolean;
  lastInputAt: number;
}

export class HostSession implements Session {
  readonly role = 'host';
  readonly localId = 'p0';

  sim: Sim;
  private prevSnap: SimSnapshot;
  private currSnap: SimSnapshot;
  private accumulator = 0;
  private seq = 0;
  private localHop = false;
  private localShove = false;
  private pendingEvents: GameEvent[] = [];

  private peer: Peer | null = null;
  roomCode = '';
  private netState = 'starting network…';
  private remotes = new Map<string, Remote>();
  private nextPlayerNum = 1;
  private lastFrameAt = performance.now();
  private bgTick: ReturnType<typeof setInterval>;

  constructor() {
    this.sim = new Sim();
    this.sim.addPlayer(this.localId);
    this.prevSnap = this.sim.snapshot();
    this.currSnap = this.prevSnap;
    this.openPeer(0);
    // keep the world alive for clients when the host tab loses focus (rAF throttles)
    this.bgTick = setInterval(() => {
      const now = performance.now();
      if (now - this.lastFrameAt > 250) {
        this.frame((now - this.lastFrameAt) / 1000, ZERO_INPUT);
      }
    }, 120);
  }

  private openPeer(attempt: number): void {
    if (attempt >= 4) {
      this.netState = 'offline — solo play only';
      return;
    }
    const code = makeRoomCode();
    const peer = new Peer(ROOM_PREFIX + code);
    peer.on('open', () => {
      this.peer = peer;
      this.roomCode = code;
      this.netState = '';
    });
    peer.on('error', (err: Error & { type?: string }) => {
      if (err.type === 'unavailable-id') {
        peer.destroy();
        this.openPeer(attempt + 1);
      } else if (!this.roomCode) {
        this.netState = 'offline — solo play only';
        console.warn('[net] host peer error:', err.type, err.message);
      } else {
        console.warn('[net] peer error:', err.type, err.message);
      }
    });
    peer.on('connection', (conn) => this.onConnection(conn));
  }

  private onConnection(conn: DataConnection): void {
    const key = conn.peer;
    if (conn.label === 'ctl') {
      if (this.remotes.size >= MAX_PLAYERS - 1) {
        conn.on('open', () => {
          conn.send({ t: 'full' } satisfies CtlMsg);
          setTimeout(() => conn.close(), 500);
        });
        return;
      }
      const playerId = `p${this.nextPlayerNum++}`;
      const remote: Remote = {
        playerId,
        ctl: conn,
        fast: null,
        input: { ...ZERO_INPUT },
        hopLatch: false,
        shoveLatch: false,
        lastInputAt: performance.now(),
      };
      this.remotes.set(key, remote);
      conn.on('open', () => {
        this.sim.addPlayer(playerId);
        conn.send({ t: 'init', playerId } satisfies CtlMsg);
      });
      const drop = () => {
        this.sim.removePlayer(playerId);
        this.remotes.delete(key);
      };
      conn.on('close', drop);
      conn.on('error', drop);
    } else if (conn.label === 'fast') {
      const remote = this.remotes.get(key);
      if (!remote) {
        conn.close();
        return;
      }
      remote.fast = conn;
      conn.on('data', (raw) => {
        const msg = raw as FastMsg;
        if (msg.t === 'in') {
          remote.input = {
            moveX: msg.mx,
            moveZ: msg.mz,
            faceYaw: msg.fy,
            hop: false,
            shove: false,
            grab: msg.g === 1,
          };
          if (msg.h === 1) remote.hopLatch = true;
          if (msg.s === 1) remote.shoveLatch = true;
          remote.lastInputAt = performance.now();
        }
      });
    }
  }

  status(): string {
    if (this.roomCode) {
      const n = 1 + this.remotes.size;
      return `Room ${this.roomCode} · ${n}/3 in`;
    }
    return this.netState;
  }

  frame(frameDt: number, localInput: PlayerInput): void {
    this.lastFrameAt = performance.now();
    this.accumulator += Math.min(frameDt, 0.5);
    this.localHop ||= localInput.hop;
    this.localShove ||= localInput.shove;
    const dt = CONFIG.sim.dt;
    const now = performance.now();

    while (this.accumulator >= dt) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set(this.localId, { ...localInput, hop: this.localHop, shove: this.localShove });
      this.localHop = false;
      this.localShove = false;
      for (const r of this.remotes.values()) {
        const stale = now - r.lastInputAt > 500;
        inputs.set(
          r.playerId,
          stale ? { ...ZERO_INPUT } : { ...r.input, hop: r.hopLatch, shove: r.shoveLatch },
        );
        r.hopLatch = false;
        r.shoveLatch = false;
      }

      this.prevSnap = this.currSnap;
      this.sim.step(inputs);
      this.seq++;
      this.currSnap = this.sim.snapshot();
      this.accumulator -= dt;

      if (this.sim.lastEvents.length > 0) {
        this.pendingEvents.push(...this.sim.lastEvents);
        const msg: CtlMsg = { t: 'ev', evs: this.sim.lastEvents };
        for (const r of this.remotes.values()) {
          if (r.ctl.open) r.ctl.send(msg);
        }
      }

      if (this.seq % SNAP_EVERY === 0 && this.remotes.size > 0) {
        const msg = encodeSnapshot(this.seq, this.currSnap);
        for (const r of this.remotes.values()) {
          if (r.fast?.open) r.fast.send(msg);
        }
      }
    }
  }

  renderFrame(): RenderFrame {
    return lerpSnapshot(this.prevSnap, this.currSnap, this.accumulator / CONFIG.sim.dt);
  }

  drainEvents(): GameEvent[] {
    const evs = this.pendingEvents;
    this.pendingEvents = [];
    return evs;
  }

  destroy(): void {
    clearInterval(this.bgTick);
    this.peer?.destroy();
    this.peer = null;
    this.remotes.clear();
  }
}
