# Design ideas parking lot

John (2026-08-06): "Store all of those ideas somewhere, they'll come back
later." This file is that somewhere. Nothing in here is committed design —
it's the raw material future builds get argued from. When an idea ships, note
the build and leave the entry (the reasoning stays useful).

## The resource-management core (the big maybe)

John's hunch: "at its core this game being a resource management game where
you're constantly trying to refill your bars could be fun, it could, I just
don't know."

- **Bars under consideration**: energy/stamina (shipped b12, ceiling-shrink
  b15), fun/boogie (shipped b17 as the experiment), hunger and thirst later.
- **The Peak trick**: one bar for ALL afflictions instead of a dashboard —
  "the less bars the better." If boogie + energy + hunger + thirst ever feel
  like homework, collapse them Peak-style.
- **The loop as sketched**: dance to fill the fun bar → dancing torches your
  energy (primarily thirst + exertion in the full version) → recover by NOT
  dancing/sprinting/jumping, or chemically → repeat until noon.
- **Thirst** wants to be the real reason dancing drains you — and the bar
  (selling water!) becomes a location that matters, with its own LinePath.

## Drugs × the economy

- **K** (shipped): slows energy drain per felt level — dancing on K is
  cheaper than dancing sober. A line also refills a chunk of energy (b17:
  scaled by grams).
- **Other drugs should cost MORE energy to dance on** ("for other drugs later
  on, it'll definitely take more energy to dance on drugs") — K is the odd
  one out on purpose.
- **Stimulants** (coke, mcat…): refill/extend the energy bar harder — the
  late-night alternative to riding the k-hole line, with their own tells
  (the voice FX for both are already wired in src/voice/fx.ts).
- Maybe K also boosts fun directly, maybe fun stays dance-only — unresolved.

## The shooter / bumper (a really really good item)

A little sniffer capsule with premeasured bumps you can rip really easily —
which means you can dose ON the dancefloor without the phone-card-bill
ritual. That's the whole value: the ritual needs privacy, the shooter doesn't.
Rare/valuable item. NOT in b17 — the ritual had to exist first so the shooter
has something to be better than.

## Passing the loaded phone (multiplayer ritual)

b17 ships the solo ritual. The full version: when you're finished cutting you
hand the phone + bill to a friend (or they grab it out of your hand), and
they snort whatever you cut for them. One person preps, three dose — faster,
social, and the prepper controls everyone's dose (comedy and betrayal both).
Requires: the phone as a transferable carrier of the powder grid. Deferred.

## Scenes John wants to exist

- "One person is cutting lines, and the other two are barging the door
  screaming at them to hurry before they go and get the bouncer." The
  systems for every beat of that shipped across b15-b17 — it should already
  be able to HAPPEN. Protect it in future tuning.
