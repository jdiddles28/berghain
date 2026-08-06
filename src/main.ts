// Entry point: menu → session (host or client) → fixed-timestep loop.

import { ClubAudio } from './audio';
import { CONFIG } from './config';
import { Input } from './input';
import { targetItemIndex } from './sim/types';
import { ClientSession } from './net/client';
import { HostSession } from './net/host';
import type { Session } from './net/session';
import { View } from './render/view';
import { initRapier } from './sim/sim';
import { installDebug } from './debug';
import { VoiceChat } from './voice/voice';

const app = document.getElementById('app')!;
const hud = document.getElementById('hud')!;
const stambox = document.getElementById('stambox')!;
const stamfill = document.getElementById('stamfill')!;
const bigmsg = document.getElementById('bigmsg')!;
const bigmsgText = document.getElementById('bigmsgText')!;
const btnRestart = document.getElementById('btnRestart') as HTMLButtonElement;
const restartHint = document.getElementById('restartHint')!;
const menu = document.getElementById('menu')!;
const btnHost = document.getElementById('btnHost') as HTMLButtonElement;
const btnJoin = document.getElementById('btnJoin') as HTMLButtonElement;
const inpCode = document.getElementById('inpCode') as HTMLInputElement;

let session: Session | null = null;
let view: View | null = null;
let input: Input | null = null;
const audio = new ClubAudio();

btnHost.addEventListener('click', () => start('host'));
btnJoin.addEventListener('click', () => start('join'));
inpCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') start('join');
});

async function start(mode: 'host' | 'join'): Promise<void> {
  const code = inpCode.value.trim().toUpperCase();
  if (mode === 'join' && code.length !== 4) {
    inpCode.focus();
    return;
  }
  btnHost.disabled = btnJoin.disabled = true;
  audio.start(); // user gesture — safe to create AudioContext
  await initRapier();

  session = mode === 'host' ? new HostSession() : new ClientSession(code);
  view = new View(app);
  input = new Input(view.renderer.domElement);
  const voice = new VoiceChat(audio);
  menu.style.display = 'none';

  if (session instanceof HostSession) {
    installDebug(session);
  }
  // the end screen restarts the night — same lobby code, same people (John).
  // Only the host holds the keys; clients see who to nag.
  btnRestart.style.display = session instanceof HostSession ? 'block' : 'none';
  restartHint.textContent =
    session instanceof HostSession ? '' : 'the host can restart the night';
  btnRestart.onclick = () => {
    if (session instanceof HostSession) session.restart();
  };

  let last = performance.now();
  const loop = () => {
    if (!session || !view || !input) return;
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;

    const localInput = input.sample();
    session.frame(dt, localInput);
    audio.handleEvents(session.drainEvents());

    // proximity voice: starts once the room code + player id both exist
    const roomCode = session instanceof HostSession ? session.roomCode : code;
    voice.setIdentity(roomCode, session.localId);

    const frame = session.renderFrame();
    let itemLine = '';
    if (frame) {
      const meSnap = frame.players[session.localId];
      audio.update(frame.beat, meSnap?.k ?? 0, meSnap?.watch ?? 0);
      if (meSnap) voice.update(dt, frame, input.camYaw, input.camPitch, session.localId);
      // THE bar + the night's endings
      if (meSnap) {
        stambox.style.display = 'block';
        stamfill.style.width = `${Math.round(meSnap.stam * 100)}%`;
        stamfill.style.background = meSnap.stam < 0.25 ? '#e0484f' : '#cfd2dc';
        if (meSnap.out) {
          bigmsg.style.display = 'flex';
          bigmsgText.textContent = 'ESCORTED OUT\nthe Curator has seen enough';
        } else if (frame.phase === 1) {
          bigmsg.style.display = 'flex';
          bigmsgText.textContent = 'CLOSING TIME\nyou lasted the Klubnacht';
        } else {
          bigmsg.style.display = 'none';
        }
      }
      // Peak-style pickup flow: what you're looking at highlights, the HUD
      // says what RMB would do, and holding shows the bag's state
      let targeted = -1;
      const me = frame.players[session.localId];
      if (me) {
        const holding = frame.items.find((it) => it.holder === session!.localId);
        targeted = targetItemIndex(
          { x: me.pos.x, y: me.pos.y + CONFIG.camera.eyeHeight, z: me.pos.z },
          input.camYaw + Math.PI, // camera-orbit yaw → facing yaw (input.ts convention)
          input.camPitch,
          frame.items,
          session.localId,
          !!holding,
        );
        if (holding) {
          itemLine = `\nbag of K · ${holding.doses}/${CONFIG.ketamine.dosesPerBag} bumps · LMB: do a bump · Q: drop (hold: throw)`;
        } else if (targeted >= 0) {
          itemLine = frame.items[targeted].holder
            ? '\nright click: snatch the bag'
            : '\nright click: pick up the bag';
        }
      }
      view.render(frame, input.camYaw, input.camPitch, session.localId, targeted);
    }

    const voiceLine = voice.status();
    hud.textContent =
      session.status() +
      (voiceLine ? `\n${voiceLine}` : '') +
      itemLine +
      (input.locked ? '' : '\nclick to grab the mouse · or hold a button + drag to look');
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
