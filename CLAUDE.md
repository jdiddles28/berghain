# Berghain — dev notes for Claude

3-player co-op friendslop game set in a recreation of Berghain: last the full 32-hour Klubnacht
without getting ejected by the Curator. Browser-based, built by Claude (Fable); John (non-coder)
designs and playtests. Status: **pre-prototype — nothing has been built yet.**

## The two source documents (read before doing design or build work)

- `docs/fable-context.md` — the FULL handoff: John's design conversation with Claude (Opus 5),
  transcribed from screenshots in `handoff-screenshots/`. Contains the state summary (settled /
  open / rejected / parked), the map pipeline, the substance system, and the three-build MVP plan.
- `docs/friendslop.md` — the genre definition and hard platform requirements ported from
  Den of Thieves (the only things carried over from that project).

## Ground rules

- **John's words are the authority; Opus's words are proposals.** The handoff doc deliberately
  preserves both. Opus made claims John never agreed to — when they clash, John's verbatim
  quotes win, and Fable's own judgment outranks Opus's analysis where John hasn't ruled.
- Design decisions come from John. Rejected ideas (door-as-deduction-puzzle, dancefloor-as-
  hangout, extraction-as-frame) stay rejected; don't re-propose them.
- Dancing is the big unsolved design problem. Do not build Build 3 or paper over this.
- Hard constraint on any proposal: **Peak has one bar.** Every new meter must earn its place.
- **DIEGETIC UI (John's requirement, 2026-08-06):** UI should as much as possible be real objects
  in the world — rules on a holdable flyer, the phone as a physical item, minigames as physical
  interactions (Lethal Company's terminal is the reference). The Build-2 stamina bar is John's
  own sanctioned HUD exception. Default diegetic; justify any overlay.
- Build order is settled and strict: Build 1 (the physics toy) → Build 2 (the loop: K, stall
  queue, Curator) → Build 3 (dancing, unresolved). (In-game voice was pulled forward from the
  original "Discord until Build 3" plan by John, 2026-08-06 — it shipped as b13.)

## Hard platform requirements

- Browser game, one URL, no install, runs on integrated graphics.
- Exactly 3 players, co-op.
- Proximity voice chat as the core system — SHIPPED (b13, John's call 2026-08-06, overriding
  the handoff's "Discord until Build 3"): src/voice/, music-attenuation + stall acoustics +
  per-drug voice FX. See the src/voice/ section below.

## Commands

- `npm run dev` — Vite dev server on port 5174 (Browser pane: launch.json "berghain-dev" at the
  Friendslop root)
- `npm run build` — typecheck + production build
- `npm test` — vitest (headless sim tests)

## Architecture (Build 1, keep these boundaries)

- `src/sim/` — headless Rapier simulation. **Never import three.js here**; runs in Node for tests.
- `src/render/` — three.js view layer, reads snapshots only. No shadow maps; darkness is the look
  but bodies must always be readable (dim ambient + hemisphere + beat-pulsed colored points).
- `src/net/` — PeerJS star, host-authoritative, 20 Hz snapshots, client interpolates ~125 ms
  behind. Snapshots are QUANTIZED BINARY ArrayBuffers (protocol.ts — BinaryPack sends JS
  numbers as 8 bytes each; the old object snapshots were ~90 KB/s, brutal through a TURN
  relay). Client input is throttled to 30 Hz with hop latched across the throttle; clients
  ping every 2 s and show RTT in the HUD.
- `src/voice/` — in-game proximity voice (b13). Fully separate from the game wire: each player
  opens a SECOND PeerJS peer with a deterministic id (room code + player number) and the mesh
  reads who's in the room straight off the snapshot — no roster messages, no protocol coupling.
  Everyone streams their RAW mic; each RECEIVER spatializes + drug-warps every incoming voice
  (acoustics.ts = pure headless-tested math: music field/duck/occlusion/tinny · fx.ts = the
  per-drug Web Audio chains · voice.ts = mesh + per-speaker pipelines). Music also reacts to
  position via ClubAudio.setSpace (stall = thump through the wall). Drug voice designs: coke =
  blown-open mic that CARRIES; K = warble + waves of word-dropout; alcohol = sliding random-walk
  pitch + swells (distinct from K: no rhythm, no dropouts); MDMA = close-talker warmth that
  ignores distance (NOT chipmunk); 4-MMC = pitch-up + slapback double-talk; G = near-nothing +
  nod-off dips. Only K is fed by the sim today; the rest wait on Build 2+ drug states and are
  audible NOW via `__voice.dose('p1','coke',1)` / `__voice.loopback()` (solo mic test). Tuning
  lives in CONFIG.voice. V = mute.
- `src/config.ts` — ALL tuning constants. The physics FEEL lives in `body`/`balance`/`shove`/`grab`.
- `src/audio.ts` — synthesized 128 BPM techno + SFX, Web Audio, no sound files. Phase-locked to
  the rendered sim beat so the crowd bounces on the kick you hear.
- Fixed 60 Hz timestep with accumulator; render interpolates. Never tie sim steps to rAF delta.

## Physics model (Peak/Gang Beasts — NOT Den of Thieves)

**Never reuse Den of Thieves gameplay/physics code** (John: its kinematic-capsule physics is
"abysmal" for this — no wobble potential). Berghain characters are DYNAMIC rigid capsules:
- Movement = force toward desired velocity; crowd bumps genuinely displace you.
- Balance = limited PD spring toward upright (`uprightKp`/`maxTorque`); strong enough that
  running never tips you, weak enough that real hits do.
- Knockdown = accumulated sudden horizontal Δv (mass·Δv in `balance.impulseWindow`) past
  `impulseFall`, or extreme tilt → full ragdoll → timed wobbly get-up (spring ramps back with
  `getupBoost`). SHOVE IS CUT (b10, John: fun but purposeless). Bodies are the weapon now:
  `balance.kick` gives char-char contacts closing faster than ~2 m/s a restitution impulse
  (Rapier resolves capsule-capsule contact too softly to ever read as a hit) — a sprint or
  sprint-jump body check floors the victim and usually the attacker; walking contact jostles.
- Downed bodies get `downFriction`/`downLinearDamping` (restored on rise) — without it they
  toboggan across the room on the frictionless character capsule.
- Impacts also STAGGER (motor control cut ~staggerMax) — without this the victim's own
  movement controller cancels knockback within 3 frames and shoves don't read.
- Balance spring kd near critical damping — underdamped bodies oscillate, which reads as
  BOUNCING in first person (John playtest). Standing still must be planted (~0.2° sway).
- GRAB is universal + physical (REPO reference, John's ruling): hand-ray along the look
  direction, reach ~1.1 m; whatever solid it hits — person, wall, pillar, prop — you stick to
  the exact contact point (anchor stored target-local) and pull on each other via a stiff
  spring at the points. No contact = no grab. Snapshots carry `gripPoint` for arm-reach visuals.
- First person is HEAD-STABILIZED like Peak: eye follows body position (yaw-only offset),
  small roll blend upright, full weld+roll only when ragdolled. Never bolt the camera to the
  raw body transform.
- Character colliders: near-zero friction + `CoefficientCombineRule.Min` (real floor friction =
  permanent 49° lean, discovered the hard way). The controller brakes; shoved bodies slide.
- Hard-won Rapier lessons: `addForce` PERSISTS — reset forces/torques at the top of every step.
  Never tilt-check a body that's mid-get-up (it's horizontal by definition).

## Controls (Build 1)

WASD camera-relative move (body yaw-servos to face travel), mouse look (FP), Space hop.
V toggles the voice-chat mic mute.
RMB = grab: items first (Peak-style look-highlight pickup, incl. snatching from hands),
else the universal body/wall grip (soft spring, no joints). LMB = USE what's held (hold to
bump from the K bag). Q = tap to drop, hold to charge a throw. No shove — John cut it (b10);
sprint body checks are the violence now. John ruled grab stays on RMB ("left click seems so
select focused, the action to grab should feel more intentional").

## Items + ketamine (b10 scaffolding for Build 2)

- `sim.items`: small carryables. Held = kinematic, rides `items.holdLocal` (visible in FP);
  loose = tiny dynamic body. One K bag spawns on the DJ stand (20 bumps).
- K pipeline per player: bump → +1 level `ketamine.onsetDelay` (30 s) later → decay 1 level
  per `decayEvery` (60 s TEST value). Felt level eases (`easeRate`) and drives everything:
  speed penalty, upright-target wobble, input overshoot/drift (press W briefly → you carry on
  further and skew sideways), client-side blur/darken/camera-sway. Level 5 = k-hole: forced
  ragdoll until decay to 4. NO meters — effects are the feedback (Peak one-bar rule).

## Standing rules

- After each feature: run the game, check console, screenshot. Debug API: `window.__game`
  (getState / teleport / boom) — host only.
- Pin dependency versions (three 0.185, rapier3d-compat 0.19, peerjs 1.5).
- Commit per feature with a short message.
- The map arrives later via the Minecraft Java Edition export pipeline in the handoff doc —
  Build 1's room is hand-placed and disposable.
