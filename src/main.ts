// Entry point: menu → session (host or client) → fixed-timestep loop.

import { ClubAudio } from './audio';
import { CONFIG } from './config';
import { Cutting } from './cutting';
import { Input } from './input';
import { maxStamina, targetItemIndex } from './sim/types';
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
const stamcap = document.getElementById('stamcap')!;
const boogiebox = document.getElementById('boogiebox')!;
const boogiefill = document.getElementById('boogiefill')!;
const inv = document.getElementById('inv')!;
const invSlots = [
  document.getElementById('inv0')!,
  document.getElementById('inv1')!,
  document.getElementById('inv2')!,
];
const bigmsg = document.getElementById('bigmsg')!;
const bigmsgText = document.getElementById('bigmsgText')!;
const btnRestart = document.getElementById('btnRestart') as HTMLButtonElement;
const restartHint = document.getElementById('restartHint')!;
const menu = document.getElementById('menu')!;
const btnHost = document.getElementById('btnHost') as HTMLButtonElement;
const btnJoin = document.getElementById('btnJoin') as HTMLButtonElement;
const inpCode = document.getElementById('inpCode') as HTMLInputElement;

const KIND_NAME = ['bag of K', 'card', 'bill'] as const;

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
  const cutting = new Cutting();
  input.cutting = cutting;
  const voice = new VoiceChat(audio);
  menu.style.display = 'none';

  if (session instanceof HostSession) {
    installDebug(session);
  }
  // playtest/debug: poke the client-side input + ritual state from the console
  (window as unknown as { __ui: object }).__ui = { input, cutting };
  // the end screen restarts the night — same lobby code, same people (John).
  // Only the host holds the keys; clients see who to nag.
  btnRestart.style.display = session instanceof HostSession ? 'block' : 'none';
  restartHint.textContent =
    session instanceof HostSession ? '' : 'the host can restart the night';
  btnRestart.onclick = () => {
    if (session instanceof HostSession) session.restart();
  };

  let last = performance.now();
  let lmbHeldT = 0; // hold LMB on the bag this long → the ritual opens (b17)
  let wasDown = false;
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

      const myItems = frame.items.filter((it) => it.holder === session!.localId);
      const myBag = myItems.find((it) => it.kind === 0);
      const selected = myItems.find((it) => it.slot === input!.slot) ?? null;

      // ---- the cutting ritual, client side (b17) ----
      if (meSnap) {
        // opening: hold LMB on the bag (in hand, upright, night still on)
        if (
          !cutting.active &&
          localInput.use &&
          selected?.kind === 0 &&
          meSnap.st === 0 &&
          !meSnap.out &&
          frame.phase === 0 &&
          !input.uiOpen
        ) {
          lmbHeldT += dt;
          if (lmbHeldT >= CONFIG.cutting.holdToStart) cutting.start();
        } else if (!localInput.use) {
          lmbHeldT = 0;
        }
        // the sim gets the last word: floored mid-ritual = the phone SPILLS
        if (meSnap.st !== 0 && cutting.active) cutting.spill();
        if (meSnap.st !== 0 && !wasDown) cutting.seed(0); // whatever it was, it's on the floor
        wasDown = meSnap.st !== 0;
        // tools vanished mid-phase (bag/card/bill snatched, dropped, thrown)?
        if (cutting.active) {
          const kinds = new Set(myItems.map((it) => it.kind));
          if (
            !kinds.has(0) ||
            (cutting.phase >= 2 && !kinds.has(1)) ||
            (cutting.phase >= 3 && !kinds.has(2))
          ) {
            cutting.stop();
          }
        }
        cutting.update(dt, myBag?.grams ?? 0);
      }

      // THE bars + the night's endings
      if (meSnap) {
        // THE bar (b15): the fill is absolute, and the night eats the bar's
        // right edge — by noon a "full tank" is a third of what it was
        const stamMax = maxStamina(frame.nightT);
        stambox.style.display = 'block';
        stamfill.style.width = `${Math.round(meSnap.stam * 100)}%`;
        stamcap.style.width = `${Math.round((1 - stamMax) * 100)}%`;
        stamfill.style.background = meSnap.stam < 0.3 * stamMax ? '#e0484f' : '#cfd2dc';
        // the boogie meter (b17): only dancing refills it — empty = out
        boogiebox.style.display = 'block';
        boogiefill.style.width = `${Math.round(meSnap.boogie * 100)}%`;
        boogiefill.style.background = meSnap.boogie < 0.25 ? '#e0484f' : '#e0a34f';

        // the endings are MENUS now (b17, John): mouse freed, body ignored
        if (meSnap.out) {
          bigmsg.style.display = 'flex';
          bigmsgText.textContent =
            meSnap.outWhy === 1
              ? 'BOOGIED OUT\nyou stopped dancing and the night moved on without you'
              : 'ESCORTED OUT\nthe Curator has seen enough';
          input.setUiOpen(true);
        } else if (frame.phase === 1) {
          bigmsg.style.display = 'flex';
          bigmsgText.textContent = 'YOU LASTED THE KLUBNACHT\nclosing time. daylight. tinnitus.';
          input.setUiOpen(true);
        } else {
          bigmsg.style.display = 'none';
          input.setUiOpen(false);
        }
      }

      // the inventory (b17): three slots, wheel to select
      inv.style.display = meSnap && !meSnap.out ? 'flex' : 'none';
      for (let s = 0; s < 3; s++) {
        const it = myItems.find((i) => i.slot === s);
        invSlots[s].textContent = it ? KIND_NAME[it.kind] : '·';
        invSlots[s].classList.toggle('sel', input.slot === s);
      }

      // Peak-style pickup flow: what you're looking at highlights, the HUD
      // says what RMB would do, and the bottom line explains the hand
      let targeted = -1;
      const me = frame.players[session.localId];
      if (me && !input.uiOpen) {
        targeted = targetItemIndex(
          { x: me.pos.x, y: me.pos.y + CONFIG.camera.eyeHeight, z: me.pos.z },
          input.camYaw + Math.PI, // camera-orbit yaw → facing yaw (input.ts convention)
          input.camPitch,
          frame.items,
          session.localId,
          myItems.length >= 3,
        );
        if (cutting.active) {
          itemLine =
            cutting.phase === 1
              ? '\nshake the bag gently over the phone · click: take out the card'
              : cutting.phase === 2
                ? '\npush the powder into lines with the card · click: take out the bill'
                : '\nhold LMB on a line and drag along it to snort · RMB: put it all away';
        } else if (selected) {
          itemLine =
            selected.kind === 0
              ? '\nbag of K · hold LMB: cut up some lines · Q: drop (hold: throw)'
              : selected.kind === 1
                ? '\na credit card · for cutting lines · Q: drop (hold: throw)'
                : '\na rolled bill · LMB: sniff · Q: drop (hold: throw)';
        } else if (targeted >= 0) {
          const t = frame.items[targeted];
          itemLine = t.holder
            ? `\nright click: snatch the ${KIND_NAME[t.kind]} out of their hand`
            : `\nright click: pick up the ${KIND_NAME[t.kind]}`;
        }
      }
      view.render(frame, input.camYaw, input.camPitch, session.localId, targeted, cutting);
    }

    const voiceLine = voice.status();
    hud.textContent =
      session.status() +
      (voiceLine ? `\n${voiceLine}` : '') +
      itemLine +
      (input.locked || input.uiOpen ? '' : '\nclick to grab the mouse · or hold a button + drag to look');
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
