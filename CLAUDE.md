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
V toggles the voice-chat mic mute. E = dance TOGGLE (b15): a beat-locked side-to-side
step with big alternating overhead arm pumps — deliberately unlike the crowd's vertical
every-2-beats bounce so you can pick yourself out mid-pack. Moving/hopping/grabbing/dosing
cancels it. Still no gameplay purpose by design.
RMB = grab: items first (Peak-style look-highlight pickup, incl. snatching from hands),
else the universal body/wall grip (soft spring, no joints). LMB = USE what's held (hold to
bump from the K bag). Q = tap to drop, hold to charge a throw. No shove — John cut it (b10);
sprint body checks are the violence now. John ruled grab stays on RMB ("left click seems so
select focused, the action to grab should feel more intentional").

## b15 systems (the current build)

- **THE LINE SYSTEM is modular** (John: "lines will be a foundational part of the feel of
  this game… get the foundations right now"): `src/sim/linePath.ts` lays out a train of
  invisible standing squares from a service point — each square must be STANDABLE (a
  clearance probe vs static geometry), and a blocked continuation makes the line BEND,
  preferring its previous turn direction so it wraps corners. The bathroom queue is the
  first instance; membership etiquette (join at the BACK only, hold your slot, leave the
  train or get floored = lose your place, only the front moves on the door, ONE claimant
  at a time, front waits for stall-empty + door-closed) is line-agnostic. Full flow +
  fallback table: `docs/bathroom-etiquette.md` — keep it in sync with the sim.
- **Raver-alert machine** (walker mode 6 + minion mode 5): pissed-off clubgoer stares
  (angry brows) → walks to the nearest free bouncer → "problem understood. Now following"
  → raver LEADS the bouncer back to the incident → bouncer knocks power-2 (much louder)
  and runs the removal protocol on whoever is in the stall NOW. Triggers: walking in on a
  stall occupant for > `annoyAt` (their business PAUSES while you stand there), and the
  camper ladder's first minion (the barger fetches embodied; timers backstop everything).
  Resisting a removal accrues `protocolHeat` — leave promptly and nothing sticks.
- **Minion aggro**: per-minion slow-cooling fury (`aggro`/`aggroTarget`) fed by being
  grabbed/beaned/flooring-them/running removals. A hot free minion stops dead and STARES
  at the offender; head redness = max(job, aggro) so it fades GRADUALLY, brows past
  `browsAt`. Never snaps back to white (John).
- **Honest hands**: no NPC grip connects through solid geometry (`handsCanReach` ray) —
  fixed the b14 through-wall barger grab. NPCs never grab the door; they push in with a
  hand-torque (`doorPush`, minions harder) + body — a player's grip or planted body still
  bars the door. doorW 0.72: at 0.8 the free edge sat INSIDE the innerX wall collider and
  the door was geometrically latched (NPCs stalled ~10 s per swing).
- **Stamina economy**: drain is CONSTANT; the night shrinks the CEILING
  (`maxStamina(nightT)`: maxStart→maxEnd, HUD dead-zone eats the bar's right edge). Bump =
  fixed absolute refill clamped to the ceiling; felt K level slows drain (kDrainSlowPerLevel,
  floor kDrainFloor) — the late game is riding level 3-4 with 30 s onset making your true
  level illegible. standAtFrac is relative to the current ceiling.
- **K hallucination staircase**: audio tiers (quiet rare at ~2 / clearly-audible at ~3 /
  frequent + unease drone at 4+; whispers, ghost replays, PHANTOM KNOCKS) and superlinear
  visuals (kv=k²/4): motion trails (no-clear frame feedback, preserveDrawingBuffer),
  breathing scale pulse, tunnel vignette (#kvig), desaturation, hue drift at 4.
- **Sleep**: collapse tips the body over + keel-torque fallback — ALWAYS horizontal fetal.
  Sleepers get NOTICED: the minion view cone is waived for a body on the floor (LOS still
  honest) — sleeping in the open draws the walk of shame; the stall stays the safe nap.
- Knock SFX: 3 tiers (power 0/1/2) with a woody door-resonance layer; power 2 is the
  bouncer's arrival BANG with a frame boom. Clock hands run CLOCKWISE (sign flip).
- Walker spawn de-overlap (random circuit spawns seeded t=0 knockdown avalanches) + flow
  walkers steer around the queue's occupied squares.

## b14 systems

- **Kick asymmetry**: the check victim eats the full kick impulse; a GROUNDED attacker takes
  `attackerGroundShare` (staggers, stays up), an airborne one (sprint-jump) takes it all and
  goes down too. NPC-NPC pairs use `kick.minCloseNpc` (higher) — at 50 bodies the crowd kept
  accidentally kicking itself over at the player threshold.
- **Minions are BIG** (`curator.body`): heavier + stronger motor, and EXEMPT from the
  grab holder penalties — that exemption is the drag tug-of-war (one minion out-pulls a
  walking player; a sprinting player barely holds ground; any minion that SEES a colleague
  dragging joins in). Minion grips cap at `gripMaxForce`, not grab.maxForce.
- **Heat sources** beyond observation: holding a grip on a minion (`heatGrabbed`/s), flooring
  one (instant grounds — no witness needed), beaning one with a thrown item (`heatThrowHit` +
  they snap around toward the thrower), being seen on the DJ stand (`heatBooth` + a mode-3
  "shoo": drag you to the floor, not the exit). Hunters FORGET a target after `losForget`
  seconds of fully broken line of sight (heat falls to `losCooldownHeat`).
- **Bathroom is a real system**: a global need scheduler (`bathroom.needEvery`) keeps a 3-4
  person line; queue slots are tracked data; NPCs route via doorway waypoints (`routeTo` —
  straight-line seeking walked them into the stall walls forever). STALL PRESSURE escalates
  against campers: knock at 30 s, LOUD knock at 45 s, barge-and-drag at 60 s (walkerMode 5 —
  for their turn, not an ejection), minions fetched from 120 s, one more per minute. Cutting
  the line skips straight to the barge. Applies to NPC campers too — the club runs itself.
- **Angry brows** (flags bit3): slanted eyebrows appear on anyone pissed off (minion on the
  job, barger, knocker) — John's tell for WHO is mad at you. Minion head-redness scales with
  the watched player's heat and burns solid during pursuit. Faces otherwise stay blank.
- **Fetal sleep** (flags bit2): stamina collapse renders as a curled-up fetal ball, not a
  ragdoll flop. Restart button on the end screen (host-only) rebuilds the Sim in place —
  same lobby, same peers; `__game.sim` is a GETTER because restart swaps host.sim.
- Crowd: 30 dancers (sunflower spawn — random spawns overlapped and seeded knockdown
  avalanches) facing the DJ in front of the stage, 16 walkers on a U circuit that never
  crosses the stage/dancefloor strip (`flow.uTurnSin`). Clock runs midnight → noon (12 min).
- 3 K bags: DJ stand, behind the toilet, in dancer #4's hand (item holder 'n<idx>' on the
  wire = 128+idx; players are <128; 255 loose).

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
