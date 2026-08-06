// Client session: connects to a host by room code, streams inputs up,
// interpolates the snapshot buffer ~125 ms behind the newest snapshot.

import { Peer, type DataConnection } from 'peerjs';
import { CONFIG } from '../config';
import type { GameEvent, PlayerInput, RenderFrame, SimSnapshot } from '../sim/types';
import { lerpSnapshot } from '../sim/types';
import {
  decodeSnapshot,
  INTERP_DELAY_SNAPS,
  peerOpts,
  PROTOCOL_VERSION,
  relayAvailable,
  ROOM_PREFIX,
  SNAP_EVERY,
  snapshotSeq,
  turnServer,
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
  // input goes up at ~30 Hz, not once per rendered frame — a 144 Hz monitor
  // was pushing 144 packets/s through the relay for no gameplay benefit
  private lastInputSend = 0;
  private hopLatch = false;
  // latency probe: ping every couple of seconds, show the RTT in the HUD so
  // "it's super laggy" comes with a number attached next time
  private lastPingAt = 0;
  private pingSeq = 0;
  private pingSentAt = new Map<number, number>();
  rttMs: number | null = null;

  constructor(code: string) {
    const hostId = ROOM_PREFIX + code.toUpperCase();
    this.peer = new Peer(peerOpts());
    this.peer.on('open', () => {
      this.state = `joining ${code.toUpperCase()} — opening a connection…`;
      const ctl = this.peer.connect(hostId, { label: 'ctl', reliable: true });
      // the classic silent failure: signaling reaches the host (their count
      // goes up) but hard NATs block the actual data path, and the joiner
      // stares at "connecting" forever. Diagnose instead of guessing.
      setTimeout(async () => {
        if (this.settled) return;
        if (!turnServer()) {
          // no relay configured at all — these two networks simply need one
          this.state =
            "these two networks can't connect DIRECTLY (phone hotspots\n" +
            'and strict wifi need a relay) — and no relay is set up yet.\n' +
            'tell John: the game needs its relay credentials. meanwhile,\n' +
            'try swapping who hosts — blocks are often one-directional.';
          return;
        }
        this.state = "connection won't open — checking the relay…";
        const relayOk = await relayAvailable();
        if (this.settled) return;
        this.state = relayOk
          ? "relay is up but the host is still unreachable — likely the\nhost's network. swap who hosts, or the host re-hosts a new room."
          : 'the relay is configured but NOT reachable — its credentials\nmay have expired. tell John. (swapping who hosts may still work.)';
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
      if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
        // binary snapshot
        const snap = decodeSnapshot(raw, CONFIG.music.bpm);
        const index = snapshotSeq(snap) / SNAP_EVERY;
        if (index <= this.latestIndex - 30) return;
        this.buffer.push({ index, snap });
        this.buffer.sort((a, b) => a.index - b.index);
        if (this.buffer.length > 40) this.buffer.splice(0, this.buffer.length - 40);
        if (index > this.latestIndex) {
          this.latestIndex = index;
          this.latestArrival = performance.now();
        }
        return;
      }
      const msg = raw as FastMsg;
      if (msg.t === 'po') {
        const sent = this.pingSentAt.get(msg.n);
        if (sent !== undefined) {
          this.pingSentAt.delete(msg.n);
          const rtt = performance.now() - sent;
          this.rttMs = this.rttMs === null ? rtt : this.rttMs * 0.6 + rtt * 0.4;
        }
      }
    });
  }

  status(): string {
    if (this.state) return this.state;
    // joined but nothing streamed yet: label the black screen instead of
    // leaving people staring at the void wondering if it broke
    if (this.buffer.length === 0) return 'joined — streaming the club in…';
    const ping = this.rttMs === null ? '' : ` · ${Math.round(this.rttMs)}ms`;
    return `In as player ${this.localId.slice(1)} · b${PROTOCOL_VERSION}${ping}`;
  }

  drainEvents(): GameEvent[] {
    const evs = this.pendingEvents;
    this.pendingEvents = [];
    return evs;
  }

  frame(_frameDt: number, localInput: PlayerInput): void {
    if (!this.fast?.open) return;
    this.hopLatch ||= localInput.hop; // edge-triggers survive the throttle
    const now = performance.now();
    if (now - this.lastInputSend >= 33) {
      this.lastInputSend = now;
      this.fast.send({
        t: 'in',
        mx: Math.round(localInput.moveX * 1000) / 1000,
        mz: Math.round(localInput.moveZ * 1000) / 1000,
        fy: Math.round(localInput.faceYaw * 1000) / 1000,
        fp: Math.round(localInput.facePitch * 1000) / 1000,
        sp: localInput.sprint ? 1 : 0,
        h: this.hopLatch ? 1 : 0,
        g: localInput.grab ? 1 : 0,
        u: localInput.use ? 1 : 0,
        d: localInput.drop ? 1 : 0,
      } satisfies FastMsg);
      this.hopLatch = false;
    }
    if (now - this.lastPingAt >= 2000) {
      this.lastPingAt = now;
      const n = this.pingSeq++;
      this.pingSentAt.set(n, now);
      if (this.pingSentAt.size > 8) {
        // relay hiccup ate some pongs — let the map breathe
        const oldest = this.pingSentAt.keys().next().value!;
        this.pingSentAt.delete(oldest);
      }
      this.fast.send({ t: 'pi', n } satisfies FastMsg);
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
