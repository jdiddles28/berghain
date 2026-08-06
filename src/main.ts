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

const app = document.getElementById('app')!;
const hud = document.getElementById('hud')!;
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
  menu.style.display = 'none';

  if (session instanceof HostSession) {
    installDebug(session);
  }

  let last = performance.now();
  const loop = () => {
    if (!session || !view || !input) return;
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;

    const localInput = input.sample();
    session.frame(dt, localInput);
    audio.handleEvents(session.drainEvents());

    const frame = session.renderFrame();
    let itemLine = '';
    if (frame) {
      audio.update(frame.beat, frame.players[session.localId]?.k ?? 0);
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

    hud.textContent =
      session.status() +
      itemLine +
      (input.locked ? '' : '\nclick to grab the mouse · or hold a button + drag to look');
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
