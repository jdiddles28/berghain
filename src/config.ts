// ALL tuning constants. Feel changes = one-line edits here.
// Build 1 is entirely about how these numbers feel — expect to churn them.

export const CONFIG = {
  sim: {
    dt: 1 / 60,
  },

  room: {
    // one dark crowded room. 1 unit = 1 m.
    w: 16, // x extent
    d: 12, // z extent
    wallH: 4.2,
    pillarR: 0.42,
    // two structural pillars on the floor — obstacles make crowd flow interesting
    pillars: [
      { x: -3.2, z: -1.6 },
      { x: 3.2, z: 1.6 },
    ],
    // low stage/plinth along the -z wall (speaker wall). climbable with a hop.
    stage: { x: 0, z: -4.9, w: 7, d: 2.2, h: 0.45 },
    // DJ booth ON the stage: the board is a solid table (grabbable, climbable
    // like everything), the DJ stands behind it facing the floor
    dj: { x: 0, z: -4.95, boardZ: -4.15, boardW: 1.7, boardD: 0.5, boardH: 0.8 },
    // the way out — where the minions drag you, under the wall clock
    exit: { x: 0, z: 5.85, w: 1.5 },
  },

  // the bathroom stall in the -x/+z corner: real walls, a real hinged door
  // (universal grab opens it; NPCs shoulder through; a weak spring swings it
  // shut). Inside with the door closed = out of every line of sight.
  bathroom: {
    // stall footprint: corner walls at x=-8 and z=+6 exist; we add two more
    innerX: -5.9, // stall wall parallel to the x wall
    innerZ: 3.9, // stall wall parallel to the z wall (the door lives here)
    doorHingeX: -6.75, // door hangs off this end of the innerZ wall
    // 0.8 buried the free edge 1 cm INSIDE the innerX wall collider — the
    // door was geometrically latched shut and every swing had to pop free of
    // the wall (NPCs stalled at it for ~10 s). 0.72 leaves a real jamb gap.
    doorW: 0.72,
    doorH: 2.0,
    doorSpring: 6, // N·m toward closed — stall doors swing shut
    doorDamp: 4,
    // NPCs push the door open with a HAND when they're at the gap — a capsule
    // jittering against the thin panel took 10+ s to beat the closing spring.
    // Small enough that a player's grip or planted body still bars the door
    // (John: "that's how you can keep the door barred"); minions push harder.
    doorPush: 26, // N·m
    doorPushMinion: 60,
    // the queue is a STRAIGHT line directly in front of the door, heading away
    // from it into the room (John: "wherever the door faces, they should form
    // a straight line in front of it"). Slot i: (doorMidX, innerZ − gap0 − i·dx).
    // gap0 clears the door's outward SWING ARC — slot 0 at 0.85 m put the
    // front queuer's body against the opening door, pinning it shut and
    // deadlocking the stall (the leaver could never get out)
    queueGap0: 1.35,
    queueDx: 0.7,
    queueSlots: 6,
    joinRadius: 0.9, // stand this close to the TAIL slot and you're IN line
    leaveDist: 1.6, // stray this far from your slot and you've left the line
    doorClosedAt: 0.35, // rad — the front waits for the door to swing shut
    npcUseTime: [18, 22] as const, // s an NPC spends in the stall (~20, John's test value)
    // GLOBAL arrival rate: one walker decides to go roughly every stall-visit
    // (John's math: 20 s service + 20 s arrivals = a steady 3-4 person line
    // that only balloons when players camp the stall — which is funny)
    needEvery: [14, 26] as const,
    // waypoints for getting in and out: the door gap is around the corner from
    // the line, so straight-line seeking walked NPCs into the stall wall
    doorMidX: -6.35, // center of the door gap on the innerZ wall
    outsidePoint: { x: -6.35, z: 3.25 }, // in front of the door, outside
    insidePoint: { x: -7.3, z: 5.1 }, // by the toilet
    // STALL PRESSURE (John): no lock on the door, so camping is legal — but
    // the front of the line escalates. Knock, knock LOUDER, barge in and drag
    // you out for their turn, and eventually they fetch the Curator's muscle.
    knockAt: 30, // s the front waiter waits before knocking
    knock2At: 45, // the louder knock
    bargeAt: 60, // front NPC forces the door and drags the occupant out
    minionAt: 120, // still blocked → the barger goes and FETCHES a bouncer
    minionEvery: 60, // each further minute, one more minion joins
    dragOutPoint: { x: -4.5, z: 2.2 }, // where the occupant gets dumped (clear of the line)
    // walking in on an NPC using the stall (John): they turn, angry brows; stay
    // this long and they leave to fetch a bouncer to drag you out
    annoyAt: 5,
    fetchFindDist: 1.3, // this close to a free bouncer = "problem understood"
    fetchGiveUp: 25, // s an alert-raver spends before giving up (self-righting)
    protocolHeat: 0.1, // per s a bouncer spends failing to remove you (resisting)
  },

  // THE NIGHT — the whole MVP loop. One bar (stamina), a clock, a way to
  // lose (ejected) and a way to win (closing time).
  night: {
    length: 720, // s of real time for the full Klubnacht (test compression)
    // midnight → noon (John): one full lap of the hour hand, easy to read.
    // 12 in-game hours over 720 s = 12 real minutes, 1 minute per hour.
    hours: 12,
    // THE BAR, b15 redesign (John asked for the full think-through; the
    // reasoning lives in the b15 report + CLAUDE.md). The night doesn't drain
    // you faster — it SHRINKS YOUR CEILING. maxStamina slides from maxStart to
    // maxEnd across the night and the bar's right edge visibly creeps in.
    // Drain is CONSTANT (readable); a bump refills a fixed absolute chunk
    // (clamped to the ceiling); being high on K slows the drain. The result:
    // early, sober play dominates (the refill is small next to a huge bar and
    // being visibly high draws heat) — late, the only thing that keeps a tiny
    // bar alive is the drain-slow, which needs felt level 3-4, which needs
    // redosing every level-decay, which — with the 30 s onset making your true
    // level illegible — is how you end up riding the k-hole line to noon.
    drain: 0.0038, // fraction/s, constant (~4.4 min a FULL early bar)
    maxStart: 1.0,
    maxEnd: 0.34, // by noon the whole bar is a third of what you opened with
    sprintDrainMult: 3.5, // sprinting burns the bar — you can't run forever
    // the dance economy (b17, John's experiment): dancing costs real energy —
    // and because K's drain-slow applies to the whole drain, dancing ON k
    // costs less than dancing sober. That trade IS the loop.
    danceDrainMult: 2.6,
    bumpRefill: 0.24, // 0.05 g snorted: fixed ABSOLUTE refill, clamped to the ceiling
    // THE BOOGIE METER (b17, John): a second bar that only DANCING refills.
    // Full-to-empty in ~3 min of standing around; empty-to-full in ~1 min of
    // dancing on the floor. Zero boogie = you lose — you were not here to
    // party, and the night moved on without you.
    boogie: {
      fill: 1 / 60, // fraction/s while dancing ON the dancefloor
      fillOffFloor: 0.4, // × fill when dancing alone in a corner (it's sad)
      drain: 1 / 180, // fraction/s while not dancing
    },
    kDrainSlowPerLevel: 0.19, // the real late-game value of K: drain × (1 − this·felt)
    kDrainFloor: 0.2, // deep in it the body still burns a little
    collapseAt: 0.0, // bar empty → you fold up where you stand
    collapseRegen: 0.016, // fraction/s while collapsed — sleeping it off
    standAtFrac: 0.5, // stand back up at this fraction OF THE CURRENT CEILING
  },

  // the Curator's minions: silent, black-clad, patrolling the edges. They
  // only care about what they can SEE (real line of sight, bodies block).
  curator: {
    minions: 3,
    viewRange: 6.5,
    viewHalfAngleDeg: 60,
    // the minions are BIG (John: "big meaty germans" — clearly larger than
    // even the clubgoers, same height as each other, not giants). The bulk is
    // load-bearing: their motor strength is what wins the drag tug-of-war.
    body: {
      radius: 0.3,
      halfHeight: 0.62,
      mass: 100,
      // kp beats this taller/heavier capsule's toppling leverage
      // (m·g·halfHeight ≈ 608 N·m) by the same ~1.8× margin as everyone else
      uprightKp: 1100,
      uprightKd: 300,
      maxTorque: 820,
      moveSpeed: 1.1,
      accelGain: 12,
      maxAccel: 20,
    },
    // heat: per-player suspicion 0..1. Only accumulates while a minion has
    // eyes on you DOING something ejectable; slowly forgotten otherwise
    // (John: suspicion rises AND falls gradually, never snaps back).
    heatDosing: 0.4, // per s observed anywhere in the line-cutting ritual
    heatDown: 0.3, // per s observed collapsed/k-holed on the floor
    // being VISIBLY high (b17, John): trying to WALK while wrecked is the
    // giveaway — standing still while wrecked draws far less attention, and
    // dancing on the dancefloor draws none at all (everyone dances weird)
    heatWrecked: 0.22, // per s observed MOVING at kFelt ≥ wreckedAt
    heatWreckedStill: 0.05, // per s observed standing still at kFelt ≥ wreckedAt
    wreckedAt: 3.3,
    // dancing in the pack hides your state entirely (John: "bouncers won't
    // bat an eye, even if you're about to khole, bc you're dancing")
    danceHideRadius: 3.4, // this close to the pack's live center counts as "in the crowd"
    // where a booth-shoo dumps you: OFF the stand and OFF the dancefloor
    // (the old spot was inside the dance zone — and the release condition
    // could never fire for an upright body, so the drag never ended: b17 fix)
    shooDropSpot: { x: 2.6, z: -0.2 },
    heatKnockdown: 0.55, // instantly, for flooring someone in view
    heatGrabbed: 0.3, // per s you HOLD a minion — they do not like being dragged
    heatThrowHit: 0.3, // instantly, for beaning a minion with a thrown object
    heatBooth: 0.3, // per s observed ON the DJ stand — it is off limits
    heatDecay: 0.035, // per s unobserved
    ejectAt: 1.0,
    // the walk of shame: a minion hunts you, grips you, drags you to the
    // exit. Friends can body-check the minion to tear the grip — a rescue
    // (everyone drops every grip when floored). TUG OF WAR (John): one
    // minion out-pulls a walking player, a SPRINTING player barely out-pulls
    // one minion (near standstill, and sprint burns the bar) — and any minion
    // that SEES a colleague dragging someone comes to help. Two win.
    hunterSpeed: 2.4, // m/s — faster than your walk, slower than your sprint
    catchDist: 0.95,
    dragSpeed: 1.6, // m/s target hauling you to the door
    gripMaxForce: 3400, // a bouncer's grip transmits real force (grab.maxForce is 1600)
    ejectDist: 1.3, // this close to the exit with you in tow = you're out
    losForget: 2.5, // s of fully broken line of sight before a hunter gives up
    losCooldownHeat: 0.55, // heat falls to this when they lose you (no instant re-hunt)
    scanEvery: [4, 9] as const, // patrol: pause and sweep the room
    scanFor: [1.5, 3.5] as const,
    hopVel: 3.9, // minions jump a little higher than players (stage is no refuge)
    // AGGRO (John): piss one off and they LOOK STRAIGHT AT YOU — and keep
    // staring while the red fades gradually, never snapping back to white
    aggroDecay: 0.05, // per s — a full glare takes ~20 s to cool
    aggroGrabRate: 1.2, // per s of being held — near-instant fury
    aggroThrowHit: 0.75, // instantly, for beaning them
    aggroTaskRate: 0.12, // per s spent running a removal protocol
    aggroStareAt: 0.08, // above this a free minion stops and stares at you
    browsAt: 0.3, // above this the angry brows come out
    followDist: 1.1, // mode-5 escort: how close they heel to the alerting raver
  },

  // Peak-style wobbly body: a DYNAMIC capsule held upright by a limited spring.
  // Everything that matters about the feel lives in this block.
  body: {
    radius: 0.28,
    halfHeight: 0.5, // capsule segment half-length → ~1.56 m tall total
    mass: 75,
    linearDamping: 0.35,
    angularDamping: 2.2,
    // near-zero: the movement controller brakes for you. Real friction on a
    // sliding capsule = constant tip-over torque (49° lean discovered in testing)
    // and shoved bodies stopping dead. Slidey characters are also just funnier.
    friction: 0.03,
    restitution: 0.0,

    // upright PD controller. kp limited by maxTorque — big hits overwhelm it.
    // kd near critical damping (~207 for this kp/inertia): an underdamped body
    // visibly oscillates after every nudge, which reads as BOUNCING in FP.
    uprightKp: 640,
    uprightKd: 170,
    maxTorque: 560,
    // yaw servo: the body tracks the look direction almost 1:1 — a lagging
    // body under a fast head is uncanny valley
    yawGain: 300,
    yawDamp: 30,
    yawMaxTorque: 400,

    // movement: force toward desired velocity. being pushed genuinely displaces you.
    // SLOW and deliberate (John: walking and running were way too fast) — club
    // pace, and pushing through the crowd should cost real effort.
    moveSpeed: 1.9, // m/s target
    sprintMult: 1.85, // hold SHIFT — ~3.5 m/s; sprint collisions hit harder for free
    // high gain + accel cap = snappy starts and PLANTED stops. low gain was
    // the "gliding not walking" feel: half a second of drift after every input.
    accelGain: 12,
    maxAccel: 30, // m/s² cap → max force = mass * this
    airControl: 0.25,
    hopVel: 3.4, // Space — small hop, enough for the 0.45 m stage
    hopCooldown: 0.45,

    // the dance (b15, John): E TOGGLES a dance state — a beat-locked
    // side-to-side step, deliberately DIFFERENT from the crowd's vertical
    // every-2-beats bounce, so you can pick yourself out mid-floor. Fun and
    // funny to watch is the design goal; it still has no gameplay purpose.
    dance: { sideVel: 0.6, upVel: 1.0 },

    // lean into acceleration (Peak-ish anticipation wobble) — subtle; big lean
    // plus floor friction is exactly how you faceplant from jogging
    leanIntoAccel: 0.02, // rad per m/s² (clamped)
    leanMax: 0.09,
    // idle sway: barely-there. planted on two feet, not a metronome.
    swayAmp: 0.008,
    swayHz: 0.6,
  },

  // knockdown/get-up — the comedy threshold
  balance: {
    tiltFallDeg: 58, // past this tilt you're gone
    // accumulated hit (N·s of sudden horizontal Δv) in a short window → down.
    // walking face-first into a wall (~142 N·s of self-stop) STAGGERS but
    // stays under the bar; sprinting into one sails over it — comedy.
    impulseFall: 165,
    // capsule-on-capsule contacts resolve softly over several solver steps, so
    // raw momentum exchange between two people never spikes hard enough to
    // read as a HIT (bodies are squish, walls are not). This term is the
    // elasticity of a body check: pairs closing faster than minClose get a
    // symmetric restitution kick along the contact normal. Outcomes stay
    // emergent — a sprint-JUMP check reliably floors the victim (and usually
    // the attacker, who is lighter), while walking-pace crowd contact
    // (closing < minClose) never triggers it.
    // ASYMMETRY (John): the kick used to be symmetric — every sprint contact
    // floored both or neither. Now the victim takes the full impulse; a
    // GROUNDED attacker takes a reduced share (staggers, usually stays up),
    // an AIRBORNE attacker (sprint-jump) takes it all and goes down too.
    // minClose 2.2: two NPCs ambling head-on close at ~1.9-2.1 — at 2.0 the
    // 50-person crowd kept accidentally kicking itself over. Player sprint
    // contact closes at 3+, so the body-check feel is untouched.
    // minCloseNpc: NPC-NPC pairs need a higher bar — two clubbers ambling
    // head-on close at ~2.0-2.4 and the 50-person crowd kept accidentally
    // kicking itself over. Player-involved contact keeps the tuned 2.0.
    kick: { minClose: 2.0, minCloseNpc: 2.7, perClose: 120, max: 260, attackerGroundShare: 0.45 },
    impulseWindow: 0.35, // s
    // stagger: real impacts cut the victim's motor control so knockback READS.
    // without this the movement controller cancels the hit within 3 frames.
    staggerPerImpulse: 1 / 300, // s of stagger per N·s of impact
    staggerMax: 0.9, // s
    staggerMoveMult: 0.12, // movement force while staggered
    staggerSpringMult: 0.4, // upright spring while staggered — they flail
    // impacts are detected as sudden HORIZONTAL velocity change (mass × Δv).
    // vertical is excluded so hopping/landing never floors you.
    // 75: above the ~41 N·s the motor can self-inflict per step, low enough
    // that the FIRST chunk of a soft multi-step body-check contact staggers —
    // the stagger cuts the victim's motor, which lets the rest of the
    // momentum actually land instead of being braked away.
    impactMin: 75, // N·s below this: not an impact
    impactEvent: 140, // N·s above this: audible thud event
    downTime: 1.9, // ragdoll on the floor before trying to rise
    getupRamp: 0.85, // s over which the upright spring fades back in (the wobbly rise)
    getupMaxTime: 2.4, // still not upright after this long rising = wedged; flop and retry
    getupBoost: 3.0, // spring strength multiplier while rising (gravity is strong, cheat a little)
    getupNudge: 1.6, // small upward velocity at start of rise so you unstick from the floor
    downAngularDamping: 1.1, // floppier while down
    // downed bodies used to toboggan across the room on the frictionless
    // character capsule (John: "they slide for way too long"). While ragdolled
    // the body gets real friction + drag; both restored when they start rising.
    downLinearDamping: 2.4,
    downFriction: 0.55,
  },

  // REPO-style universal grip: a physical reach-ray from the hands. Whatever
  // solid thing it TOUCHES — person, wall, pillar, stage, prop — you stick to
  // at the exact contact point and pull on each other. No contact, no grab.
  grab: {
    reach: 1.1, // hand-ray length. beyond arm's length, hands don't connect
    handLocal: { x: 0, y: 0.28, z: 0.32 }, // hand origin in body space (chest height)
    springK: 2600, // stiff spring "grip" at the anchor points
    springDamp: 120,
    restLen: 0.22,
    breakDist: 2.1, // yanked further apart than this = grip torn off
    maxForce: 1600,
    holderSpeedMult: 0.62, // hauling a load is slow
    holderKpMult: 0.75, // and destabilizing
  },

  // small carryables, Peak-style: look at one → it highlights → RMB picks it
  // up into your hand (no ragdoll-object simulation for pocket-size things).
  items: {
    pickupRange: 1.9, // from the eye, along the look direction
    pickupCos: 0.95, // how tight the look-cone is (~18°)
    stealRange: 1.6, // grabbing something out of another player's hand
    // held out in front AND high enough to sit in the bottom of the FP frame —
    // you should SEE what you're carrying (Peak carry). NOTE x is NEGATIVE:
    // -x is the character's RIGHT hand as rendered (verified in FP — +x draws
    // on the left of the frame), and John wants items in the right hand.
    holdLocal: { x: -0.18, y: 0.26, z: 0.46 },
    doseLocal: { x: -0.06, y: 0.44, z: 0.26 }, // the bag comes up to the face mid-bump
    dropSpeed: 1.1, // tap Q: just let it go
    throwChargeMin: 0.28, // held shorter than this = a drop, not a throw
    throwChargeMax: 1.0, // full windup
    throwSpeed: [5.5, 13] as const, // m/s at min..max charge
    throwUpBias: 0.2, // arc it a little
    // the bag is a little ZIPLOCK BAGGY of white powder (John: the old one
    // read as a cigarette pack) — flat pouch, fill level visible through it
    kbag: { w: 0.085, h: 0.11, d: 0.02, mass: 0.03 },
    card: { w: 0.086, h: 0.002, d: 0.054, mass: 0.01 }, // a credit card
    bill: { r: 0.007, len: 0.072, mass: 0.005 }, // a rolled bill
  },

  // the K economy, b17: GRAMS, not "bumps". A bag holds 1 g; you dose
  // yourself by cutting lines (see `cutting`), and what you snorted rounds
  // to a secret 0.025 g bucket — lines that LOOK slightly different can hit
  // identically (John: part of the fun is not knowing exactly what you did).
  // Internal level scale is unchanged (k-hole = 5.0) but levels now move in
  // 0.5 steps: 0.025 g = half a level, 0.25 g = the hole. Overdose stacks
  // PAST the hole (0.5 g = level 10 internally) and decays granularly — take
  // double and you wait down through every extra step before you surface.
  ketamine: {
    bagGrams: 1.0, // a full bag
    bucketG: 0.025, // the secret dose quantum (half an internal level)
    levelPerGram: 20, // 0.05 g = 1.0 internal level → 0.25 g = the k-hole
    levelCap: 10, // 0.5 g at once is as gone as the sim will model
    onsetDelay: 30, // s from the sniff to the level actually hitting
    decayEvery: 60, // s per FULL level coming back down (stepped by decayStep)
    decayStep: 0.5, // levels per decay tick — granular surfacing (b17)
    maxLevel: 5, // reaching 5 = k-hole: full ragdoll until you decay below it
    easeRate: 0.5, // levels/s the FELT level eases toward the true level
    // movement, per felt-level (0..5):
    speedPenalty: 0.115, // speed × (1 − this·k) → ~54% at level 4
    wobbleAmp: 0.028, // rad of upright-target sway per level — the sea legs
    wobbleHz: 0.5,
    inputAttack: 0.1, // s — smoothing on move input while high (barely felt sober)
    inputReleasePerLevel: 0.24, // s of extra momentum AFTER you release a key
    driftAngPerLevel: 0.11, // rad the move direction slowly skews sideways per level
    driftHz: 0.21,
    // visuals, per felt-level (client-side, own player only). The intensity
    // CURVE is superlinear (kv = k²/4): level 2 is very restrained, 3 is
    // "wait, is the room moving?", 4 is a good bit (John's hallucination
    // staircase). The looks are real K phenomenology: motion trails/ghosting,
    // breathing walls, tunnel vision, washed-out color.
    // b17 (John): "make the screen darker, and have the world get dark and
    // foggy at a further distance... that's better than just pure blur. The
    // blur is still good, its j that's all there is" — blur dialed way down,
    // darkness up, and real DISTANCE FOG closes in per level (see view.ts).
    blurPerLevel: 0.3, // px (× the curved level) — a hint, not the whole effect
    darkenPerLevel: 0.11,
    fog: { nearSober: 6, farSober: 26, nearHigh: 2.0, farHigh: 7.5 }, // lerped by the curved level
    viewSway: 0.013, // rad of slow camera sway per felt level
    kholeBlur: 4, // px — the world smears out when you go down
    trailFrom: 2.2, // felt level where motion trails (frame feedback) begin
    trailMax: 0.5, // fraction of the previous frame kept at level 5
    breatheFrom: 2.4, // the room starts gently swelling/shrinking
    vignetteFrom: 2.6, // tunnel vision creeps in
  },

  // THE LINE-CUTTING MINIGAME (b17, John): doing drugs is a PROCESS. Hold LMB
  // on the bag → phone comes out (left hand), bag in the right; shake gently
  // to pour onto the black screen; click → card, plow the powder into lines;
  // click → rolled bill, hold LMB and drag along a line to hoover it up.
  // RMB puts it all away fast (the panic button). The whole ritual runs about
  // a minute — which is exactly why the bathroom matters.
  // The powder is a 2D height-grid on the phone screen (client-side, drawn to
  // a canvas texture under 3D props — the "videogame trickery"); the host
  // stays authoritative over every gram via pour/snort amounts in the input.
  cutting: {
    grid: { w: 44, h: 24 }, // powder cells across the phone screen
    screenW: 0.07, // m — the phone's glass, where everything happens
    screenH: 0.15,
    pourRate: 0.02, // g/s at full gentle shake (a 3-line pour ≈ 10-15 s)
    pourMax: 0.35, // g the screen can sensibly hold — past this it's a mound
    cardHalfLen: 0.24, // card edge half-length in screen-height units
    cardPush: 0.85, // fraction of swept powder displaced per pass
    snortRate: 0.03, // g/s the bill hoovers when held over powder
    snortRadius: 0.09, // suction radius in screen-height units
    holdToStart: 0.25, // s of LMB on the bag before the ritual opens
    // detection: bouncers treat the WHOLE ritual like open dosing (curator.
    // heatDosing). On the dancefloor the RAVERS care too (big faux pas):
    noticeRadius: 3.0, // dancers this close clock what you're doing
    tattleAfter: 15, // s of being watched mid-ritual before one fetches a bouncer
  },

  crowd: {
    // 30 dancers + 16 walkers + 3 minions + the DJ (always the LAST index).
    // role by index: [0,dancers) dance · [dancers,dancers+walkers) walk ·
    // then minions · last is the DJ. (John: more dancers, more walkers.)
    count: 50,
    walkers: 16,
    radius: 0.27,
    halfHeight: 0.55, // NPCs are TALLER than the player — you look up at the crowd
    mass: 82, // people are HEAVY — bodying through a human should cost you
    // scaled for the TALLER, HEAVIER body (halfHeight .55 / mass 82): kp must
    // beat the capsule's toppling leverage (m·g·halfHeight ≈ 442 N·m) by the
    // same ~1.8× margin the player enjoys, or walking settles into a visible
    // 10-15° lean and every stumble past ~35° is an unrecoverable faceplant.
    uprightKp: 800,
    uprightKd: 225, // near critical for this kp/inertia — no metronome sway
    maxTorque: 600,
    moveSpeed: 1.1,
    // the crowd pushes BACK: their motor has enough authority that a body in
    // motion shoulders you aside instead of stopping dead when you touch it —
    // getting through a moving crowd should take real shoving (John).
    accelGain: 6.5,
    maxAccel: 15,
    // the crowd splits: a pack DANCING mid-floor (genuinely hopping, whole
    // body, staying roughly in place near each other) and non-dancers
    // CIRCULATING the room — Berghain is a building full of people in motion.
    dancers: 30, // NPC index < dancers ⇒ dancer; the rest are walkers
    // the floor forms right in FRONT of the DJ and spreads out (John) — and
    // every dancer FACES the decks
    danceZone: { x: 0, z: -1.8, r: 2.4 }, // spawn seed + soft bias, in front of the stage
    danceZoneMinZ: -2.9, // the pack stays OFF the stage lip (they tripped on it)
    // dancers lump toward the live centroid of the pack, not a fixed spot
    // (John: "not necessarily 1 defined place, but they like to lump together").
    // scaled up with the 30-dancer floor: the old 1.7 packed them so tight the
    // contact solver spiked bodies over the knockdown threshold — the pack
    // was flooring itself once a minute with nobody touching it
    packRadius: 2.8, // further than this from the mass → shuffle back in
    bounceVel: 1.25, // vertical hop velocity on their beat — actually airborne
    danceJitter: [4, 10] as const, // small horizontal shuffle N·s — stays in place
    danceEveryBeats: 2, // each dancer hits every N beats, staggered
    // walkers ROAM to fill the whole club (b16, John: "they cluster around the
    // exit and the bathroom line... the corners are almost always empty").
    // The old lap circuit was an ellipse inside the walls — an ellipse never
    // reaches the corners of a rectangle, so the corners were empty BY
    // CONSTRUCTION. Now each walker picks a destination by best-of-K
    // sampling: K random standable points, scored by distance to everyone
    // else's position and destination — the winner lands where the club is
    // emptiest, so the floor fills evenly, corners included. Walk there,
    // hang out a while, pick the next spot. Not everyone moves at once.
    roam: {
      margin: 1.1, // keep destinations off the walls
      candidates: 8, // best-of-K — higher = more even spread
      speedMult: 0.85, // amble, don't march
      arrive: 0.5, // this close to the destination → stop and hang out
      lingerFor: [4, 11] as const, // s hanging out before wandering on
      // everyone not IN a line keeps clear of its occupied squares (John):
      // destinations never land within this of the line, and en-route
      // steering shoulders around the line's END rather than cutting through
      lineAvoid: 1.3,
      stuckAfter: 2.5, // s of pushing without progress → pick a new spot
    },
    // NOBODY walks through the dancefloor as part of ordinary life (b17,
    // John): the floor is for dancing. Walkers and patrolling bouncers steer
    // around the pack's circle; only a bouncer chasing someone who fled INTO
    // the crowd follows them in.
    danceAvoidPad: 0.5, // avoid radius = danceZone.r + this
    // soft anti-stack nudge ONLY at near-overlap. weight comes from real
    // capsule-vs-capsule contact — a big invisible push field made people
    // glide away before you touched them, which read as weightless.
    personalSpace: 0.5,
    // NPC pairs keep a little more room: 30 dancers landing hops on top of
    // each other spiked the contact solver hard enough to floor people
    personalSpaceNpc: 0.55,
    separationForce: 120,
  },

  music: {
    bpm: 128,
    // audio synthesis levels
    master: 0.5,
    kick: 0.9,
    bass: 0.4,
    hat: 0.16,
    clap: 0.25,
    // dancefloor is LOUD — build 1 has one room, so one level
  },

  // In-game proximity voice (b13). All processing happens on the RECEIVER —
  // everyone streams their raw mic, and each listener spatializes + drug-warps
  // every incoming voice from snapshot state. src/voice/ owns all of it.
  voice: {
    // distance falloff: full volume inside refDist, silent past maxDist
    refDist: 1.4,
    maxDist: 15,
    rolloffPow: 1.5,

    // the music FIELD: how loud the club is where you're standing. Drives
    // both what you hear of the track and how drowned the voices are.
    music: {
      src: { x: 0, z: -4.0 }, // the speaker stack: front of the stage
      loudRadius: 3.0, // this close to the stack it's max loud
      falloff: 18, // m over which it drops toward minLevel
      minLevel: 0.35, // even the far corner of the room is not quiet
      stallClosed: 0.18, // stall with the door shut: thump-thump through the wall
      stallOpen: 0.55,
      stallLpClosed: 700, // Hz — the classic muffled-through-a-wall sound
      stallLpOpen: 2600,
      outsideLevel: 0.12, // (future map) past the exit
      outsideLp: 420,
    },

    // the dancefloor is a comms dead zone: music level ducks voices to near
    // nothing at the stack, and masks what little survives
    duck: { start: 0.5, floor: 0.05, pow: 1.5, lpFull: 1100 },

    // solid things between mouths and ears
    occlusion: {
      wallGain: 0.22,
      wallLp: 850,
      doorGain: 0.45, // a closed stall door blocks less than a wall
      doorLp: 1400,
      doorOpenAt: 1.1, // rad of swing at which the door stops blocking
      outGain: 0.15, // through the building shell (future map)
      outLp: 500,
    },

    // the metal box: voices FROM the stall ring tinny
    tinny: { bp: 1700, q: 2.2, mix: 0.75, verb: 0.5 },

    // synthesized impulse responses — the big dark room and the metal box
    reverb: { clubSec: 1.5, clubBase: 0.12, clubDistExtra: 0.45, stallSec: 0.16 },

    // how each substance comes out of your friend's mouth (receiver-side).
    // Only K is real in the sim today; the rest are wired and waiting, and
    // audible now via __voice.dose(...) for tuning.
    fx: {
      // mic blown wide open: you talk normally, everyone gets SHOUTED at —
      // and it carries much further than a sober voice
      coke: { boost: 6, post: 1.9, hp: 300, rangeMult: 1.8 },
      // rhythmic warble/slur + muffle + slow WAVES of dropout: only some
      // words get through and they all sound k-ed out
      k: {
        warbleHz: 3.3,
        warbleDepth: 0.008, // s of delay swing at level 5 — the slur
        lpAt5: 1500,
        gate: { from: 1.6, rateHz: 0.16, minDuty: 0.35 },
      },
      // NOT chipmunk. The loved-up close-talker: warm, breathy, chorused,
      // and it ignores distance — right in your ear from across the club
      mdma: { shelfDb: 6, chorus: 0.55, verbExtra: 0.35, floor: 0.3 },
      // motormouth: slight pitch-up + machine-gun slapback double-talk
      mcat: { pitchSt: 0.75, slap: 0.5 },
      // barely anything (John: your voice doesn't change much on G) — until
      // the nod-off: a slow droop, dipping away mid-sentence
      g: { pitchSt: -0.7, lp: 2100, dipMin: 0.5 },
      // distinct from K: no dropouts, no rhythm — drunken SLIDING pitch
      // (random walk), mushy consonants, too-loud-then-trailing-off swells
      alcohol: { walkDepth: 0.011, lp: 3600, swell: 0.3, slap: 0.2 },
    },
  },

  camera: {
    // FIRST PERSON, head-stabilized like Peak: the eye FOLLOWS the body's
    // position but does not inherit its tilt jitter — you see the wobble on
    // your body and the world, you don't ride a paint shaker. Ragdolled = the
    // camera goes down with you and rolls fully.
    eyeHeight: 0.56, // above body center
    eyeFwd: 0.12, // forward of body center (out of your own torso)
    pitchMin: -1.25,
    pitchMax: 1.15,
    fov: 78,
    bodyRollBlend: 0.12, // upright: a hint of lean in the view, not the whole ride
  },

  colors: {
    // players read bright in the dark; the crowd wears black (it's Berghain)
    players: [0x39d7e6, 0xf25ca2, 0xf2a13b],
    crowd: [0x17171b, 0x1d1a20, 0x232028, 0x141418, 0x1a1d22],
    skin: [0xc8a186, 0x8a6247, 0x5e4230, 0xe4b9a0, 0x3a2a1e],
  },
} as const;
