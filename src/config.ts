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
    doorW: 0.8,
    doorH: 2.0,
    doorSpring: 6, // N·m toward closed — stall doors swing shut
    doorDamp: 4,
    // the queue forms along the innerZ wall, heading +x away from the door
    queueStart: { x: -5.3, z: 4.7 },
    queueDx: 0.75,
    queueSlots: 6,
    joinRadius: 0.9, // stand this close to the tail slot and you're IN line
    npcUseTime: [9, 16] as const, // s an NPC spends in the stall
    npcNeedEvery: [25, 60] as const, // s between a given walker needing to go
  },

  // THE NIGHT — the whole MVP loop. One bar (stamina), a clock, a way to
  // lose (ejected) and a way to win (closing time).
  night: {
    length: 720, // s of real time for the full Klubnacht (test compression)
    hours: 32, // midnight Sat → 8am Mon
    // stamina is a 0..1 bar. Drain RAMPS across the night: early you barely
    // need anything, by the end you're redosing constantly and riding the
    // k-hole edge — that escalation is the central conflict.
    drainStart: 0.004, // fraction/s at open (~4 min a bar)
    drainEnd: 0.02, // fraction/s at close (~50 s a bar)
    sprintDrainMult: 3.5, // sprinting burns the bar — you can't run forever
    danceDrainMult: 1.0, // (dancing economy is Build 3)
    bumpRefill: 0.38, // one bump of K puts this much back in the bar
    kDrainSlowPerLevel: 0.09, // being high slows the drain — the long ride
    collapseAt: 0.0, // bar empty → you fold up where you stand
    collapseRegen: 0.012, // fraction/s while collapsed — sleeping it off
    standAt: 0.3, // enough in the bar to get back on your feet
  },

  // the Curator's minions: silent, black-clad, patrolling the edges. They
  // only care about what they can SEE (real line of sight, bodies block).
  curator: {
    minions: 3,
    viewRange: 6.5,
    viewHalfAngleDeg: 60,
    // heat: per-player suspicion 0..1. Only accumulates while a minion has
    // eyes on you DOING something ejectable; slowly forgotten otherwise.
    heatDosing: 0.4, // per s observed mid-bump
    heatDown: 0.3, // per s observed collapsed/k-holed on the floor
    heatWrecked: 0.22, // per s observed moving at kFelt ≥ wreckedAt
    wreckedAt: 3.3,
    heatKnockdown: 0.55, // instantly, for flooring someone in view
    heatDecay: 0.035, // per s unobserved
    ejectAt: 1.0,
    // the walk of shame: a minion hunts you, grips you, drags you to the
    // exit. Friends can body-check the minion to tear the grip — a rescue.
    hunterSpeed: 2.4, // m/s — faster than your walk, slower than your sprint
    catchDist: 0.95,
    dragSpeed: 1.5, // m/s hauling you to the door
    ejectDist: 1.3, // this close to the exit with you in tow = you're out
    scanEvery: [4, 9] as const, // patrol: pause and sweep the room
    scanFor: [1.5, 3.5] as const,
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
    kick: { minClose: 2.0, perClose: 120, max: 260 },
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
    kbag: { w: 0.11, h: 0.05, d: 0.14, mass: 0.25 },
  },

  // the K economy, Build-2 scaffolding. One bag = 20 bumps. Effects arrive on
  // a delay, stack per level, and ease in/out — no hard steps.
  ketamine: {
    dosesPerBag: 20,
    // a bump is a SET animation (John): press LMB → the bag comes up, you
    // sniff, it comes back down. One bump per press — holding does nothing;
    // release and press again for another.
    doseAnimTime: 2.6, // s, committed once started
    doseSniffAt: 0.55, // fraction through the animation when the sniff lands
    doseRaiseTime: 0.7, // s for the bag to travel hand→face (and face→hand)
    onsetDelay: 30, // s from the bump to the level actually hitting
    decayEvery: 60, // s per level coming back down (TEST value — real game much longer)
    maxLevel: 5, // hitting 5 = k-hole: full ragdoll until you decay back to 4
    easeRate: 0.5, // levels/s the FELT level eases toward the true level
    // movement, per felt-level (0..5):
    speedPenalty: 0.115, // speed × (1 − this·k) → ~54% at level 4
    wobbleAmp: 0.028, // rad of upright-target sway per level — the sea legs
    wobbleHz: 0.5,
    inputAttack: 0.1, // s — smoothing on move input while high (barely felt sober)
    inputReleasePerLevel: 0.24, // s of extra momentum AFTER you release a key
    driftAngPerLevel: 0.11, // rad the move direction slowly skews sideways per level
    driftHz: 0.21,
    // visuals, per felt-level (client-side, own player only):
    blurPerLevel: 0.75, // px
    darkenPerLevel: 0.065,
    viewSway: 0.013, // rad of slow camera sway per level
    kholeBlur: 7, // px — the world smears out when you go down
  },

  crowd: {
    // 22 dancers + 13 walkers + 3 minions + the DJ (always the LAST index).
    // role by index: [0,dancers) dance · [dancers,dancers+walkers) walk ·
    // then minions · last is the DJ.
    count: 39,
    walkers: 13,
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
    dancers: 22, // NPC index < dancers ⇒ dancer; the rest are walkers
    danceZone: { x: 0, z: -0.8, r: 2.2 }, // spawn seed + soft mid-floor bias
    // dancers lump toward the live centroid of the pack, not a fixed spot
    // (John: "not necessarily 1 defined place, but they like to lump together").
    packRadius: 1.7, // further than this from the mass → shuffle back in
    bounceVel: 1.25, // vertical hop velocity on their beat — actually airborne
    danceJitter: [6, 16] as const, // small horizontal shuffle N·s — stays in place
    danceEveryBeats: 2, // each dancer hits every N beats, staggered
    // walkers lap the room in streams — the "flow of people" you can get
    // swept up in (John). Not wandering: continuous circulation with pauses.
    flow: {
      margin: 1.8, // circuit distance in from the walls
      stepAng: 0.42, // rad the lap target advances once the current one is reached
      reachDist: 1.1, // close enough → advance the target
      speedMult: 0.85, // amble, don't march
      ccwShare: 0.7, // most of the room flows one way; the rest push upstream
      lingerEvery: [9, 24] as const, // s between stopping for a breather
      lingerFor: [2.5, 6] as const, // s standing still before rejoining the flow
    },
    // soft anti-stack nudge ONLY at near-overlap. weight comes from real
    // capsule-vs-capsule contact — a big invisible push field made people
    // glide away before you touched them, which read as weightless.
    personalSpace: 0.5,
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
