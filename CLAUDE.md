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
- Build order is settled and strict: Build 1 (the physics toy) → Build 2 (the loop: K, stall
  queue, Curator) → Build 3 (dancing, unresolved). Discord voice until Build 3.

## Hard platform requirements

- Browser game, one URL, no install, runs on integrated graphics.
- Exactly 3 players, co-op.
- Proximity voice chat as the core system eventually (music-volume attenuation per room);
  Discord stands in for Builds 1–2.

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
  behind. Voice = Discord (per handoff; in-game proximity voice is Build 3+).
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
  `getupBoost`). One shove ≈ 90% of threshold; two quick hits floor you.
- Character colliders: near-zero friction + `CoefficientCombineRule.Min` (real floor friction =
  permanent 49° lean, discovered the hard way). The controller brakes; shoved bodies slide.
- Hard-won Rapier lessons: `addForce` PERSISTS — reset forces/torques at the top of every step.
  Never tilt-check a body that's mid-get-up (it's horizontal by definition).

## Controls (Build 1)

WASD camera-relative move (body yaw-servos to face travel), mouse = free orbit camera,
LMB shove, hold RMB grab (soft spring, no joints — struggle looks organic), Space hop.
Peak scheme — the Den of Thieves tank-control ruling was fox-specific and does NOT apply here.

## Standing rules

- After each feature: run the game, check console, screenshot. Debug API: `window.__game`
  (getState / teleport / boom) — host only.
- Pin dependency versions (three 0.185, rapier3d-compat 0.19, peerjs 1.5).
- Commit per feature with a short message.
- The map arrives later via the Minecraft Java Edition export pipeline in the handoff doc —
  Build 1's room is hand-placed and disposable.
