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
  peerOpts,
  PROTOCOL_VERSION,
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
  // poured/snorted grams are QUANTITIES, not held states: they accumulate
  // across packets and are consumed by exactly one sim step (b17)
  pourAcc: number;
  snortAcc: number;
  lastInputAt: number;
  admitted: boolean; // hello received + version matched — actually IN the game
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
  private localPourAcc = 0;
  private localSnortAcc = 0;
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
    const peer = new Peer(ROOM_PREFIX + code, peerOpts());
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
      let admittedCount = 0;
      for (const r of this.remotes.values()) if (r.admitted) admittedCount++;
      if (admittedCount >= MAX_PLAYERS - 1) {
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
        pourAcc: 0,
        snortAcc: 0,
        lastInputAt: performance.now(),
        admitted: false,
      };
      this.remotes.set(key, remote);
      // reap zombies: a connection that never manages to open + hello (strict
      // NAT, dead tab) must not squat a player slot forever
      setTimeout(() => {
        if (this.remotes.get(key) === remote && !remote.admitted) {
          this.remotes.delete(key);
          try {
            conn.close();
          } catch {
            /* already dead */
          }
        }
      }, 15000);
      // wait for the hello so we can version-check before admitting them —
      // mismatched builds produce garbage snapshots and a black screen
      conn.on('data', (raw) => {
        const msg = raw as CtlMsg;
        if (msg.t === 'hello' && !remote.admitted) {
          if (msg.v !== PROTOCOL_VERSION) {
            conn.send({ t: 'stale' } satisfies CtlMsg);
            setTimeout(() => conn.close(), 800);
            this.remotes.delete(key);
            return;
          }
          remote.admitted = true;
          this.sim.addPlayer(playerId);
          conn.send({ t: 'init', playerId, v: PROTOCOL_VERSION } satisfies CtlMsg);
        }
      });
      const drop = () => {
        if (remote.admitted) this.sim.removePlayer(playerId);
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
        if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return; // clients don't send buffers
        const msg = raw as FastMsg;
        if (msg.t === 'in') {
          remote.input = {
            moveX: msg.mx,
            moveZ: msg.mz,
            faceYaw: msg.fy,
            facePitch: msg.fp,
            sprint: msg.sp === 1,
            hop: false,
            grab: msg.g === 1,
            use: msg.u === 1,
            drop: msg.d === 1,
            dance: msg.dn === 1,
            slot: msg.sl ?? 0,
            cutPhase: msg.cp ?? 0,
            pour: 0, // quantities ride the accumulators, not the held state
            snort: 0,
          };
          remote.pourAcc += msg.pr ?? 0;
          remote.snortAcc += msg.sn ?? 0;
          if (msg.h === 1) remote.hopLatch = true;
          remote.lastInputAt = performance.now();
        } else if (msg.t === 'pi') {
          // latency probe — echo straight back on the same channel
          if (conn.open) conn.send({ t: 'po', n: msg.n } satisfies FastMsg);
        }
      });
    }
  }

  status(): string {
    if (this.roomCode) {
      // count only ADMITTED players — half-open connections used to bump the
      // count to 2/3 while the joiner sat on "connecting" forever, telling
      // the host a join worked when it hadn't
      let n = 1;
      let pending = 0;
      for (const r of this.remotes.values()) r.admitted ? n++ : pending++;
      const pend = pending > 0 ? ` (+${pending} connecting)` : '';
      return `Room ${this.roomCode} · ${n}/3 in${pend} · b${PROTOCOL_VERSION}`;
    }
    return this.netState;
  }

  frame(frameDt: number, localInput: PlayerInput): void {
    this.lastFrameAt = performance.now();
    this.accumulator += Math.min(frameDt, 0.5);
    this.localHop ||= localInput.hop;
    // grams are quantities: a frame can run 0 or several sim steps, so they
    // buffer here and exactly ONE step consumes them (b17)
    this.localPourAcc += localInput.pour;
    this.localSnortAcc += localInput.snort;
    const dt = CONFIG.sim.dt;
    const now = performance.now();

    while (this.accumulator >= dt) {
      const inputs = new Map<string, PlayerInput>();
      inputs.set(this.localId, {
        ...localInput,
        hop: this.localHop,
        pour: this.localPourAcc,
        snort: this.localSnortAcc,
      });
      this.localHop = false;
      this.localPourAcc = 0;
      this.localSnortAcc = 0;
      for (const r of this.remotes.values()) {
        const stale = now - r.lastInputAt > 500;
        inputs.set(
          r.playerId,
          stale
            ? { ...ZERO_INPUT }
            : { ...r.input, hop: r.hopLatch, pour: r.pourAcc, snort: r.snortAcc },
        );
        r.hopLatch = false;
        r.pourAcc = 0;
        r.snortAcc = 0;
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

  /** same lobby, same people, fresh club (John: the game-over screen needs a
   *  restart). The peer connections never blink — only the sim is rebuilt. */
  restart(): void {
    this.sim = new Sim();
    this.sim.addPlayer(this.localId);
    for (const r of this.remotes.values()) {
      if (r.admitted) this.sim.addPlayer(r.playerId);
    }
    this.prevSnap = this.sim.snapshot();
    this.currSnap = this.prevSnap;
    this.pendingEvents = [];
    const msg: CtlMsg = { t: 'restart' };
    for (const r of this.remotes.values()) {
      if (r.ctl.open) r.ctl.send(msg);
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
