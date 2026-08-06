# The Bathroom — flow, etiquette, and escalation (b15)

John (2026-08-06): "we're trying to build out a whole flow and etiquette system with the
bathroom here, it's very important that we write all this down and verbalize the flow, in a
way that you can understand, that makes sense, and that won't lead to things breaking —
there should always be a fallback to have the system right itself."

This file is that write-up. The sim implements it literally; if the code and this file
disagree, one of them is a bug.

## The pieces

- **The stall**: the -x/+z corner room. One way in or out: the door gap on the z=3.9 wall.
- **The door**: a real hinged physics panel with a weak closing spring. It has NO latch and
  NO handle-logic: players can grab it (universal grab), NPCs NEVER grab it — they simply
  walk into it and shoulder through. That is the rule that makes door-barring work: you hold
  the door shut by putting force (your body, your grip) against it, and whoever's outside
  pushes with theirs.
- **The line**: a straight queue directly in FRONT of the door, heading away from it into
  the room. Slot i stands at `(doorMidX, innerZ − 0.85 − i·0.7)`. The line is REAL data
  (`sim.queue`, front first) — never vibes.

## Queue etiquette (all of this applies to NPCs and players alike)

1. **Join at the back or not at all.** A player joins by standing at the TAIL slot
   (within `joinRadius`). Standing beside the middle of the line does nothing.
2. **Hold your spot.** Everyone in line targets their own slot; when the line advances,
   you shuffle forward one slot. Wander more than `leaveDist` from your slot → you're out
   of the line and the people behind you move up. (NPCs that get shoved stumble back to
   their slot; a player who walks away has left.)
3. **Only the front moves on the door.** Exactly one claimant at a time. The front may
   step to the door only when ALL of:
   - they are standing at slot 0,
   - the stall is EMPTY (previous occupant fully out),
   - the door has swung closed (|angle| < `doorClosedAt`),
   - nobody else is mid-entry, mid-barge, or mid-removal (no walker in mode 2/5, no
     minion running the stall protocol).
4. **Using the stall** takes ~`npcUseTime` (≈20 s). A new clubber needs to go roughly
   every `needEvery` (≈20 s), so the line self-balances at 3–4 — and balloons when the
   stall is camped. The whole system runs with zero players in the club.

## Walking in on someone (the intrusion rule)

Stall occupied by an NPC doing their business + a player walks in:

- The occupant TURNS and faces the intruder. Angry brows on. Their business is paused —
  they will not finish with you standing there.
- Leave within `annoyAt` (5 s): no harm done. Brows fade, they resume.
- Stay past `annoyAt`: the occupant walks out and **goes to get a bouncer** (see the
  raver-alert flow below). When the removal is done they rejoin at the FRONT of the line —
  it's still their turn.

## Camping the stall (the pressure ladder)

There is no lock, so camping is legal — but never free. Pressure accrues only while
someone is actually waiting (front NPC at slot 0, or a barger already owed a turn).
The occupant changing resets the ladder.

| pressure time | what happens |
|---|---|
| `knockAt` (30 s) | front of the line raps on the door (audible, arm animation) |
| `knock2At` (45 s) | LOUDER knock |
| `bargeAt` (60 s) | the front NPC stops waiting: pushes in, grips the camper, drags them out to `dragOutPoint`, then takes the turn that was owed. Not an ejection — just their turn. |
| `minionAt` (120 s) | still blocked → the barger gives up wrestling and **fetches a bouncer** (embodied: they walk to one, lead it back — see below) |
| +`minionEvery` per minute | one more minion joins the removal |

**Line-cutting**: entering the stall NOT from the front of the line while people are
waiting skips the whole polite phase — pressure starts at `bargeAt`, the barge begins
immediately.

## The raver-alert flow (generalized "clubgoer tells on you" state machine)

John: "This should be a defined state … once the pissed-off threshold is met, the raver
finds the nearest bouncer, once they're right next to each other a state in the bouncer
confirms 'problem type understood. Now following', then the raver navigates back to where
the incident was, and the bouncer initiates whatever protocol the problem calls for."
Today the only problem type is HOGGING THE BATHROOM; the machine is written to take more.

- **Walker mode 6 (alerting)**, phase 1 — *seeking*: the raver walks to the nearest free
  minion. Within `fetchFindDist` the minion enters **mode 5 (following)**.
- Phase 2 — *leading*: the raver walks back to the incident spot (outside the stall
  door); the minion follows the raver, not the spot — in a bigger club you will SEE
  someone going to tell on you and have time to leave the scene.
- **Handoff**: raver at the spot + bouncer beside them → the bouncer takes over:
  - a much louder, more aggressive knock than any raver's (power-2 bang),
  - then the stall protocol: push in through the door, grip whoever is inside, drag
    them out. The bouncer resolves the CURRENT occupant, not a remembered name — if the
    stall emptied while they walked over, the problem is gone and the bouncer shrugs
    back to patrol.
  - the raver rejoins at the front of the line (their turn was stolen).
- **The bouncer's mood**: running a removal makes a bouncer pissed (aggro, see below),
  and a player who keeps resisting while the protocol runs accrues heat the whole time —
  leave promptly and nothing sticks; wrestle for a minute and the removal becomes an
  ejection.

## Fallbacks (the system always rights itself)

- Raver can't find a free bouncer, or the trip takes > `fetchGiveUp` (25 s) → give up,
  back to normal life. The stall-pressure timer is still running and will direct-assign
  a minion as a backstop (`minionAt` + 60 s).
- The followed bouncer gets floored / poached for an ejection → the raver drops back to
  phase 1 and finds another.
- A mode-2 enterer finds the stall occupied (someone slipped in) → back to the FRONT of
  the queue, not a pile-up.
- Any NPC in the queue that leaves queue-mode for any reason is pruned from the line.
- Occupant leaves mid-ladder → ladder resets; owed bargers rejoin the FRONT of the line
  and normal claiming resumes (exactly ONE person goes for the freed door).
- Stall empties before a handoff/barge lands → everyone stands down.

## Physical honesty rules

- **Nobody's hands connect through solid geometry.** Every NPC grip (barger, bouncer)
  requires a clear straight path chest-to-chest — a wall or a closed door between you
  means no grab. (b14 bug, John: "the raver just grabbed me through the wall".)
- NPCs never pull the door open like a player can — they push in with their body. You
  bar the door by out-pushing them.
