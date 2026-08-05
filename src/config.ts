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
    // strong enough that RUNNING never tips you: knockdowns come from the
    // impulse accumulator (balance.impulseFall), not from friction torque.
    uprightKp: 640,
    uprightKd: 60,
    maxTorque: 560,

    // movement: force toward desired velocity. being pushed genuinely displaces you.
    moveSpeed: 3.7, // m/s target
    accelGain: 7.5, // (vDesired - v) * mass * gain, clamped below
    maxAccel: 26, // m/s² cap → max force = mass * this
    airControl: 0.25,
    hopVel: 3.4, // Space — small hop, enough for the 0.45 m stage
    hopCooldown: 0.45,

    // lean into acceleration (Peak-ish anticipation wobble) — subtle; big lean
    // plus floor friction is exactly how you faceplant from jogging
    leanIntoAccel: 0.02, // rad per m/s² (clamped)
    leanMax: 0.09,
    // idle sway noise so nobody ever stands perfectly still in a club
    swayAmp: 0.035,
    swayHz: 0.6,
  },

  // knockdown/get-up — the comedy threshold
  balance: {
    tiltFallDeg: 58, // past this tilt you're gone
    impulseFall: 260, // N·s of accumulated hit in a short window → gone even if upright
    impulseWindow: 0.35, // s
    // stagger: real impacts cut the victim's motor control so knockback READS.
    // without this the movement controller cancels a shove within 3 frames.
    staggerPerImpulse: 1 / 300, // s of stagger per N·s of impact
    staggerMax: 0.9, // s
    staggerMoveMult: 0.12, // movement force while staggered
    staggerSpringMult: 0.4, // upright spring while staggered — they flail
    // impacts are detected as sudden HORIZONTAL velocity change (mass × Δv).
    // vertical is excluded so hopping/landing never floors you.
    // one clean shove ≈ 150+40 = 90% of threshold: two quick hits floor you.
    impactMin: 90, // N·s below this: not an impact (own movement maxes ~33)
    impactEvent: 140, // N·s above this: audible thud event
    downTime: 1.9, // ragdoll on the floor before trying to rise
    getupRamp: 0.85, // s over which the upright spring fades back in (the wobbly rise)
    getupBoost: 3.0, // spring strength multiplier while rising (gravity is strong, cheat a little)
    getupNudge: 1.6, // small upward velocity at start of rise so you unstick from the floor
    downAngularDamping: 1.1, // floppier while down
  },

  shove: {
    range: 1.25,
    halfAngleDeg: 55,
    impulse: 185, // N·s at the target's chest, horizontal — one shove staggers hard, two floor
    upImpulse: 48, // a bit of lift makes shoves read
    selfLunge: 55, // recoil/lunge on the shover
    windupTime: 0.3, // arms-out animation window broadcast to views
    cooldown: 0.55,
    // small bonus on top of the physical impulse (which the impact detector
    // already counts) — shoves are slightly meaner than raw physics
    balanceDamage: 40,
  },

  grab: {
    reach: 1.15,
    // soft spring "hand" — no hard joints, so struggling looks organic.
    // anchored HAND-to-BODY: holder's hand point to the target's near shoulder,
    // so dragged bodies twist and get hauled by the arm, not towed by the navel.
    handLocal: { x: 0, y: 0.22, z: 0.4 }, // holder hand in body space
    targetHeight: 0.3, // attach on target this far above their center
    springK: 1400,
    springDamp: 90,
    restLen: 0.32,
    breakDist: 2.4,
    maxForce: 900,
    holderSpeedMult: 0.62, // dragging is slow
    holderKpMult: 0.75, // and destabilizing
  },

  crowd: {
    count: 20,
    radius: 0.27,
    halfHeight: 0.48,
    mass: 70,
    uprightKp: 460, // weaker than players — the crowd stumbles more easily
    uprightKd: 48,
    maxTorque: 380,
    moveSpeed: 1.1,
    accelGain: 5,
    maxAccel: 12,
    // dancing: horizontal impulse bursts on the beat (per-NPC phase offset)
    danceImpulse: [14, 34] as const, // min..max N·s
    danceEveryBeats: 2, // each NPC hits every N beats, staggered
    bounceVel: 0.7, // small vertical pop on their beat
    // wandering: pick a new spot on the floor every so often
    wanderEvery: [7, 18] as const, // s
    // NPCs shrug you off: gentle constant separation push when overlapping
    personalSpace: 0.62,
    separationForce: 260,
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
    // FIRST PERSON (Peak): eye rides the physics body, so the wobble is felt.
    eyeLocal: { x: 0, y: 0.56, z: 0.09 }, // eye in body space (just above torso top)
    pitchMin: -1.25,
    pitchMax: 1.15,
    fov: 78,
    bodyRollBlend: 0.45, // how much of the body's tilt bleeds into the view (1 when down)
  },

  colors: {
    // players read bright in the dark; the crowd wears black (it's Berghain)
    players: [0x39d7e6, 0xf25ca2, 0xf2a13b],
    crowd: [0x17171b, 0x1d1a20, 0x232028, 0x141418, 0x1a1d22],
    skin: [0xc8a186, 0x8a6247, 0x5e4230, 0xe4b9a0, 0x3a2a1e],
  },
} as const;
