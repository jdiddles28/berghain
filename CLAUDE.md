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

## Housekeeping

- This is a fresh project — no code yet. When the stack materializes, expect three.js + Rapier +
  WebRTC (same family as Den of Thieves, whose repo lives in the sibling `Den of Thieves/` folder).
- The map arrives via the Minecraft Java Edition export pipeline described in the handoff doc.
- Commit per feature with a short message.
