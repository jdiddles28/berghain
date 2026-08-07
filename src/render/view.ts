// three.js view layer. Reads RenderFrames, never mutates sim.
// Dark club: near-black fog, beat-driven colored light rig, no shadow maps
// (integrated-GPU budget; the darkness IS the look).

import * as THREE from 'three';
import { CONFIG } from '../config';
import type { Cutting } from '../cutting';
import type { ItemKind, RenderFrame } from '../sim/types';
import { ClubberView } from './clubberView';

export class View {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;

  private players = new Map<string, ClubberView>();
  private npcs: ClubberView[] = [];
  private itemViews: (
    | {
        group: THREE.Group;
        mats: THREE.MeshLambertMaterial[];
        outline: THREE.Mesh;
        outlineMat: THREE.MeshBasicMaterial;
        fill: THREE.Mesh | null; // bags: the visible powder level
      }
    | null
  )[] = [];
  // the cutting ritual, first person (b17): a phone in front of the camera,
  // the powder canvas mapped onto its glass, the phase's tool riding the hand
  private cutRig!: THREE.Group;
  private cutScreenTex!: THREE.CanvasTexture;
  private cutProps!: { bag: THREE.Group; card: THREE.Mesh; bill: THREE.Mesh };
  private fog: THREE.Fog;
  private beams: { light: THREE.PointLight; baseColor: THREE.Color; phase: number }[] = [];
  private strobe: THREE.PointLight;
  private lastTime = 0;
  private lastFilter = '';
  private lastTransform = '';
  private fadeScene = new THREE.Scene();
  private fadeCam!: THREE.OrthographicCamera;
  private fadeMat!: THREE.MeshBasicMaterial;
  private sceneBg: THREE.Color | null = null;
  private vignette = document.getElementById('kvig');
  private lastVigOpacity = '';
  private doorPivot!: THREE.Group;
  private clockHour!: THREE.Mesh;
  private clockMin!: THREE.Mesh;

  constructor(container: HTMLElement) {
    // preserveDrawingBuffer: the K motion-trail effect works by NOT clearing
    // the previous frame and fading it instead — the classic dissociative
    // ghosting/tracer look, nearly free on the GPU
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'low-power',
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x030308);
    // the fog is DYNAMIC (b17): sober it sits at the sober range; the higher
    // you are, the closer the dark closes in (view-side, own player only)
    this.fog = new THREE.Fog(0x030308, CONFIG.ketamine.fog.nearSober, CONFIG.ketamine.fog.farSober);
    this.scene.fog = this.fog;

    // the fade quad that eats old frames when trails are on
    this.fadeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fadeMat = new THREE.MeshBasicMaterial({
      color: 0x030308,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    this.fadeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fadeMat));

    this.camera = new THREE.PerspectiveCamera(
      CONFIG.camera.fov,
      window.innerWidth / window.innerHeight,
      0.1,
      60,
    );
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    this.buildRoom();

    // light rig: dim-but-readable base + colored moving points + a rare strobe
    // pop. dark club ≠ murky: you must always read bodies and the room.
    this.scene.add(new THREE.AmbientLight(0x241d33, 2.4));
    this.scene.add(new THREE.HemisphereLight(0x2a2438, 0x0c0a12, 1.1));
    const rigColors = [0xff2244, 0x2244ff, 0x22ddcc];
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(rigColors[i], 30, 20, 1.4);
      light.position.set(0, 3.4, 0);
      this.scene.add(light);
      this.beams.push({ light, baseColor: new THREE.Color(rigColors[i]), phase: (i / 3) * Math.PI * 2 });
    }
    this.strobe = new THREE.PointLight(0xffffff, 0, 20, 1.2);
    this.strobe.position.set(0, CONFIG.room.wallH - 0.4, 0);
    this.scene.add(this.strobe);

    // the camera joins the scene graph so the cutting rig can ride it
    this.scene.add(this.camera);
    this.buildCutRig();
  }

  /** the first-person cutting rig (b17): phone in the left hand filling the
   *  bottom of the frame, powder canvas on its glass, the phase's tool
   *  hovering wherever the mouse-hand is. Only visible mid-ritual. */
  private buildCutRig(): void {
    const CT = CONFIG.cutting;
    this.cutRig = new THREE.Group();
    this.cutRig.position.set(0.0, -0.1, -0.26);
    // rotate the glass normal from straight-up TOWARD the camera (+z): the
    // screen fills the lower frame like a phone actually held under your face
    this.cutRig.rotation.x = 0.62;
    this.camera.add(this.cutRig);
    this.cutRig.visible = false;

    // the phone: dark slab, glass on top (+y in rig space)
    const phone = new THREE.Mesh(
      new THREE.BoxGeometry(CT.screenW + 0.012, 0.009, CT.screenH + 0.02),
      new THREE.MeshLambertMaterial({ color: 0x0a0a0e, flatShading: true }),
    );
    this.cutRig.add(phone);
    const canvas = document.createElement('canvas'); // real one wired in render()
    canvas.width = canvas.height = 8;
    this.cutScreenTex = new THREE.CanvasTexture(canvas);
    // color textures must be tagged sRGB or the near-black glass gamma-lifts
    // to mid-grey (the renderer outputs sRGB and assumed the map was linear)
    this.cutScreenTex.colorSpace = THREE.SRGBColorSpace;
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(CT.screenW, CT.screenH),
      new THREE.MeshBasicMaterial({ map: this.cutScreenTex }),
    );
    glass.rotation.x = -Math.PI / 2; // lie on the phone, facing +y
    glass.position.y = 0.0052;
    this.cutRig.add(glass);
    // a thumb-ish holder edge so it reads as HELD, not floating
    const thumb = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.011, 0.05, 1, 5),
      new THREE.MeshLambertMaterial({ color: 0xc8a186, flatShading: true }),
    );
    thumb.rotation.z = 1.2;
    thumb.position.set(-CT.screenW / 2 - 0.012, 0.004, 0.02);
    this.cutRig.add(thumb);

    // the tools, one visible at a time, riding the mouse-hand
    const I = CONFIG.items;
    const bag = this.buildBaggy(1);
    bag.rotation.z = 0.55; // tilted to the left, mouth over the glass (John)
    bag.rotation.x = 0.35;
    const card = new THREE.Mesh(
      new THREE.BoxGeometry(I.card.w, I.card.h + 0.002, I.card.d),
      new THREE.MeshLambertMaterial({ color: 0x9fb4c8, flatShading: true }),
    );
    card.rotation.y = Math.PI / 2;
    card.rotation.z = -0.25; // edge biting the glass
    const bill = new THREE.Mesh(
      new THREE.CylinderGeometry(I.bill.r, I.bill.r, I.bill.len, 8),
      new THREE.MeshLambertMaterial({ color: 0x9aa876, flatShading: true }),
    );
    bill.rotation.x = 0.75; // held like a straw, top toward your face
    for (const m of [bag, card, bill]) {
      m.visible = false;
      this.cutRig.add(m);
    }
    this.cutProps = { bag, card, bill };
  }

  /** the ziplock baggy (b17, John: the old bag read as a cigarette pack):
   *  translucent plastic pouch, opaque white powder filling it from the
   *  bottom — the fill level IS the remaining grams, never a number */
  private buildBaggy(fillFrac: number): THREE.Group {
    const I = CONFIG.items.kbag;
    const g = new THREE.Group();
    const plastic = new THREE.Mesh(
      new THREE.BoxGeometry(I.w, I.h, I.d),
      new THREE.MeshLambertMaterial({
        color: 0xdfe4ee,
        transparent: true,
        opacity: 0.3,
        flatShading: true,
      }),
    );
    const zip = new THREE.Mesh(
      new THREE.BoxGeometry(I.w + 0.002, 0.012, I.d + 0.002),
      new THREE.MeshLambertMaterial({ color: 0x8f94a8, flatShading: true }),
    );
    zip.position.y = I.h / 2 - 0.006;
    const fill = new THREE.Mesh(
      new THREE.BoxGeometry(I.w - 0.012, I.h - 0.02, I.d - 0.008),
      new THREE.MeshLambertMaterial({ color: 0xf2f2f5, flatShading: true }),
    );
    fill.name = 'fill';
    setBaggyFill(fill, fillFrac);
    g.add(plastic, zip, fill);
    return g;
  }

  private buildRoom(): void {
    const R = CONFIG.room;
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x17151a, flatShading: true });
    const floorMat = new THREE.MeshLambertMaterial({ color: 0x101014, flatShading: true });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x0c0b10, flatShading: true });

    const floor = new THREE.Mesh(new THREE.BoxGeometry(R.w + 2, 1, R.d + 2), floorMat);
    floor.position.y = -0.5;
    this.scene.add(floor);

    // worn concrete patches — motion parallax so running actually LOOKS fast
    const patchShades = [0x15151a, 0x0d0d11, 0x18181d];
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(0.5 + ((i * 29) % 10) * 0.14, 5 + (i % 3)),
        new THREE.MeshLambertMaterial({ color: patchShades[i % 3], flatShading: true }),
      );
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = i * 1.7;
      m.position.set(
        (((i * 53) % 100) / 100 - 0.5) * (R.w - 2),
        0.005 + (i % 2) * 0.002,
        (((i * 31) % 100) / 100 - 0.5) * (R.d - 2),
      );
      this.scene.add(m);
    }

    const mkWall = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, R.wallH, d), wallMat);
      m.position.set(x, R.wallH / 2, z);
      this.scene.add(m);
    };
    mkWall(R.w, 0.3, 0, -R.d / 2);
    mkWall(R.w, 0.3, 0, R.d / 2);
    mkWall(0.3, R.d, -R.w / 2, 0);
    mkWall(0.3, R.d, R.w / 2, 0);

    for (const p of R.pillars) {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(R.pillarR, R.pillarR, R.wallH, 7),
        wallMat,
      );
      m.position.set(p.x, R.wallH / 2, p.z);
      this.scene.add(m);
    }

    // stage + speaker stacks on it (visual only above the collider box)
    const s = R.stage;
    const stage = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.d), darkMat);
    stage.position.set(s.x, s.h / 2, s.z);
    this.scene.add(stage);
    for (const sx of [-s.w / 2 + 0.7, s.w / 2 - 0.7]) {
      const stack = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.2, 1.0), darkMat);
      stack.position.set(s.x + sx, s.h + 1.1, s.z - 0.3);
      this.scene.add(stack);
      const cone = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.42, 0.16, 8),
        new THREE.MeshLambertMaterial({ color: 0x2a2a30, flatShading: true }),
      );
      cone.rotation.x = Math.PI / 2;
      cone.position.set(s.x + sx, s.h + 1.4, s.z + 0.22);
      this.scene.add(cone);
    }

    // DJ booth: board table between the speaker stacks, decks + mixer on top
    const dj = R.dj;
    const boothMat = new THREE.MeshLambertMaterial({ color: 0x141318, flatShading: true });
    const board = new THREE.Mesh(new THREE.BoxGeometry(dj.boardW, dj.boardH, dj.boardD), boothMat);
    board.position.set(dj.x, s.h + dj.boardH / 2, dj.boardZ);
    this.scene.add(board);
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(dj.boardW + 0.12, 0.05, dj.boardD + 0.12),
      new THREE.MeshLambertMaterial({ color: 0x232228, flatShading: true }),
    );
    top.position.set(dj.x, s.h + dj.boardH + 0.025, dj.boardZ);
    this.scene.add(top);
    // bathroom stall in the -x/+z corner + its swinging door
    const B = CONFIG.bathroom;
    const stallMat = new THREE.MeshLambertMaterial({ color: 0x1c191f, flatShading: true });
    const wallLen = B.doorHingeX - -R.w / 2;
    const stallA = new THREE.Mesh(new THREE.BoxGeometry(wallLen, 2.3, 0.12), stallMat);
    stallA.position.set(-R.w / 2 + wallLen / 2, 1.15, B.innerZ);
    const stallB = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 2.3, R.d / 2 - B.innerZ),
      stallMat,
    );
    stallB.position.set(B.innerX, 1.15, B.innerZ + (R.d / 2 - B.innerZ) / 2);
    this.scene.add(stallA, stallB);
    // the toilet: base + bowl + seat + tank — reads as a TOILET now (John),
    // still standable (the physics collider box underneath is unchanged)
    const porcelain = new THREE.MeshLambertMaterial({ color: 0xc9cdd6, flatShading: true });
    const porcelainDim = new THREE.MeshLambertMaterial({ color: 0xa9adb8, flatShading: true });
    const tBase = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 0.3, 8), porcelainDim);
    tBase.position.set(-7.4, 0.15, 5.45);
    const tBowl = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.16, 10), porcelain);
    tBowl.position.set(-7.4, 0.36, 5.45);
    const tSeat = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.035, 6, 12), porcelain);
    tSeat.rotation.x = -Math.PI / 2;
    tSeat.position.set(-7.4, 0.45, 5.45);
    const tTank = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.34, 0.14), porcelain);
    tTank.position.set(-7.4, 0.55, 5.75);
    this.scene.add(tBase, tBowl, tSeat, tTank);
    this.doorPivot = new THREE.Group();
    this.doorPivot.position.set(B.doorHingeX, 0, B.innerZ);
    const doorPanel = new THREE.Mesh(
      new THREE.BoxGeometry(B.doorW, B.doorH, 0.06),
      new THREE.MeshLambertMaterial({ color: 0x2b2530, flatShading: true }),
    );
    doorPanel.position.set(B.doorW / 2, B.doorH / 2, 0);
    this.doorPivot.add(doorPanel);
    this.scene.add(this.doorPivot);

    // the exit on the +z wall — a black doorway the minions haul people to —
    // and the wall clock above it: the only clock in the building
    const E = CONFIG.room.exit;
    const exitHole = new THREE.Mesh(
      new THREE.BoxGeometry(E.w, 2.5, 0.18),
      new THREE.MeshBasicMaterial({ color: 0x000000 }),
    );
    exitHole.position.set(E.x, 1.25, R.d / 2 - 0.1);
    this.scene.add(exitHole);
    const exitLip = new THREE.Mesh(
      new THREE.BoxGeometry(E.w + 0.3, 0.12, 0.24),
      new THREE.MeshBasicMaterial({ color: 0x8f2222 }),
    );
    exitLip.position.set(E.x, 2.56, R.d / 2 - 0.1);
    this.scene.add(exitLip);
    const clockFace = new THREE.Mesh(
      new THREE.CircleGeometry(0.4, 24),
      new THREE.MeshLambertMaterial({ color: 0xd9dae2, flatShading: true }),
    );
    clockFace.position.set(E.x, 3.3, R.d / 2 - 0.16);
    clockFace.rotation.y = Math.PI;
    this.scene.add(clockFace);
    const handMat = new THREE.MeshBasicMaterial({ color: 0x14141a });
    this.clockHour = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.2, 0.02), handMat);
    this.clockMin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.32, 0.02), handMat);
    for (const [hand, len] of [
      [this.clockHour, 0.09],
      [this.clockMin, 0.15],
    ] as const) {
      hand.geometry.translate(0, len, 0); // rotate around the clock center
      hand.position.set(E.x, 3.3, R.d / 2 - 0.18);
      this.scene.add(hand);
    }

    const deckMat = new THREE.MeshLambertMaterial({ color: 0x0a0a0d, flatShading: true });
    const ledMat = new THREE.MeshBasicMaterial({ color: 0xff5522 });
    for (const ox of [-0.55, 0, 0.55]) {
      const deck = new THREE.Mesh(
        new THREE.BoxGeometry(ox === 0 ? 0.3 : 0.42, 0.06, 0.34),
        deckMat,
      );
      deck.position.set(dj.x + ox, s.h + dj.boardH + 0.08, dj.boardZ);
      this.scene.add(deck);
      // dim LED strips so the gear reads as gear in the dark
      const led = new THREE.Mesh(new THREE.BoxGeometry(ox === 0 ? 0.18 : 0.28, 0.012, 0.02), ledMat);
      led.position.set(dj.x + ox, s.h + dj.boardH + 0.115, dj.boardZ + 0.14);
      this.scene.add(led);
    }
  }

  /** items are tiny and the room is dark — they read bright on purpose.
   *  Built lazily per KIND (b17): baggy of powder / credit card / rolled bill. */
  private ensureItem(i: number, kind: ItemKind): NonNullable<View['itemViews'][number]> {
    while (this.itemViews.length <= i) this.itemViews.push(null);
    const existing = this.itemViews[i];
    if (existing) return existing;
    const I = CONFIG.items;
    const group = new THREE.Group();
    const mats: THREE.MeshLambertMaterial[] = [];
    let fill: THREE.Mesh | null = null;
    let outlineGeo: THREE.BufferGeometry;
    if (kind === 0) {
      const baggy = this.buildBaggy(1);
      baggy.traverse((o) => {
        if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshLambertMaterial)
          mats.push(o.material);
      });
      fill = baggy.getObjectByName('fill') as THREE.Mesh;
      group.add(baggy);
      outlineGeo = new THREE.BoxGeometry(I.kbag.w, I.kbag.h, I.kbag.d);
    } else if (kind === 1) {
      const mat = new THREE.MeshLambertMaterial({ color: 0x9fb4c8, flatShading: true });
      const stripe = new THREE.MeshLambertMaterial({ color: 0x2b2f45, flatShading: true });
      mats.push(mat, stripe);
      const card = new THREE.Mesh(new THREE.BoxGeometry(I.card.w, I.card.h + 0.002, I.card.d), mat);
      const band = new THREE.Mesh(new THREE.BoxGeometry(I.card.w, I.card.h + 0.003, 0.012), stripe);
      band.position.z = -I.card.d / 2 + 0.014;
      group.add(card, band);
      outlineGeo = new THREE.BoxGeometry(I.card.w, 0.012, I.card.d);
    } else {
      const mat = new THREE.MeshLambertMaterial({ color: 0x9aa876, flatShading: true });
      mats.push(mat);
      const bill = new THREE.Mesh(new THREE.CylinderGeometry(I.bill.r, I.bill.r, I.bill.len, 8), mat);
      bill.rotation.x = Math.PI / 2;
      group.add(bill);
      outlineGeo = new THREE.BoxGeometry(I.bill.r * 2.6, I.bill.r * 2.6, I.bill.len);
    }
    // pickup highlight: an inflated backface shell — reads as a clean
    // colored outline around the object at any angle in the dark (John:
    // the emissive-only glow didn't read at all)
    const outlineMat = new THREE.MeshBasicMaterial({
      color: 0xffd54a,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.95,
    });
    const outline = new THREE.Mesh(outlineGeo, outlineMat);
    outline.scale.setScalar(1.45);
    outline.visible = false;
    group.add(outline);
    this.scene.add(group);
    const iv = { group, mats, outline, outlineMat, fill };
    this.itemViews[i] = iv;
    return iv;
  }

  ensurePlayer(id: string, slot: number): void {
    if (this.players.has(id)) return;
    const colors = CONFIG.colors;
    const cv = new ClubberView(
      colors.players[slot % colors.players.length],
      colors.skin[slot % colors.skin.length],
    );
    this.players.set(id, cv);
    this.scene.add(cv.group);
  }

  removePlayer(id: string): void {
    const cv = this.players.get(id);
    if (cv) {
      this.scene.remove(cv.group);
      this.players.delete(id);
    }
  }

  render(
    frame: RenderFrame,
    camYaw: number,
    camPitch: number,
    localId: string,
    targetedItem = -1,
    cut: Cutting | null = null,
  ): void {
    const dt = Math.min(0.1, Math.max(0.0001, frame.time - this.lastTime));
    this.lastTime = frame.time;
    const cutting = !!cut?.active;

    // items (before bodies: held items are arm-aim targets)
    const heldBy = new Map<string, THREE.Vector3>();
    for (let i = 0; i < frame.items.length; i++) {
      const it = frame.items[i];
      const iv = this.ensureItem(i, it.kind);
      iv.group.position.set(it.pos.x, it.pos.y, it.pos.z);
      iv.group.quaternion.set(it.rot.x, it.rot.y, it.rot.z, it.rot.w);
      // pocketed items don't render (b17); the local in-hand item also hides
      // mid-ritual — the FP rig draws its own copy over the phone
      iv.group.visible = !it.stowed && !(cutting && it.holder === localId);
      if (it.holder && !it.stowed) heldBy.set(it.holder, iv.group.position);
      // the baggy tells you how much is left by LOOKING at it (never a number)
      if (iv.fill) setBaggyFill(iv.fill, it.grams / CONFIG.ketamine.bagGrams);
      // Peak-style pickup highlight: outline shell + a little inner glow
      const on = i === targetedItem;
      iv.outline.visible = on;
      if (on) iv.outlineMat.opacity = 0.75 + 0.25 * Math.sin(frame.time * 6);
      const glow = on ? 0.3 : 0;
      for (const m of iv.mats) m.emissive.setRGB(glow, glow, glow * 0.6);
    }

    // the cutting rig rides the camera (b17)
    this.cutRig.visible = cutting;
    if (cut && cutting) {
      cut.draw();
      if (this.cutScreenTex.image !== cut.canvas) this.cutScreenTex.image = cut.canvas;
      this.cutScreenTex.needsUpdate = true;
      const CT = CONFIG.cutting;
      const px = (cut.handX - 0.5) * CT.screenW;
      const pz = (cut.handY - 0.5) * CT.screenH;
      this.cutProps.bag.visible = cut.phase === 1;
      this.cutProps.card.visible = cut.phase === 2;
      this.cutProps.bill.visible = cut.phase === 3;
      this.cutProps.bag.position.set(px, 0.05, pz);
      this.cutProps.card.position.set(px, 0.008, pz);
      this.cutProps.bill.position.set(px, 0.03, pz);
      // the rig's baggy shows the REAL remaining grams while you pour
      const myBag = frame.items.find((it) => it.holder === localId && it.kind === 0);
      const bf = this.cutProps.bag.getObjectByName('fill') as THREE.Mesh | null;
      if (bf && myBag) setBaggyFill(bf, myBag.grams / CONFIG.ketamine.bagGrams);
    }

    // players
    let slot = 0;
    for (const id of Object.keys(frame.players)) {
      this.ensurePlayer(id, slot++);
    }
    const gripTarget = (b: { gripPoint: { x: number; y: number; z: number } | null }) =>
      b.gripPoint ? new THREE.Vector3(b.gripPoint.x, b.gripPoint.y, b.gripPoint.z) : null;
    for (const [id, cv] of this.players) {
      const b = frame.players[id];
      if (b) {
        const holding = heldBy.get(id) ?? null;
        cv.update(b, dt, frame.beat, {
          grabTarget: gripTarget(b),
          holdTarget: holding,
          aimPitch: id === localId ? camPitch : 0,
        });
        cv.setHeadVisible(id !== localId); // first person: don't render your own head
        // own body: chest/waist hidden (the camera lives in there), but hips
        // and legs SHOW — look down and your legs are stepping (John)
        if (id === localId) cv.setFirstPersonBody();
        else cv.setBodyVisible(true);
        // own arms only appear when they're DOING something (hold/reach/grip/
        // dance — your own hands pump at the edges of the frame)
        cv.setArmsVisible(
          id !== localId ||
            b.act === 1 ||
            b.act === 3 ||
            b.act === 4 ||
            b.gripPoint !== null ||
            holding !== null,
        );
      }
    }
    // crowd
    const colors = CONFIG.colors;
    const minionFrom = CONFIG.crowd.dancers + CONFIG.crowd.walkers;
    while (this.npcs.length < frame.npcs.length) {
      const i = this.npcs.length;
      const isMinion = i >= minionFrom && i < CONFIG.crowd.count - 1;
      const cv = new ClubberView(
        // minions wear TRUE black — darker than anyone — with an earpiece,
        // and they're all the SAME height, clearly bigger than any clubgoer,
        // in very white skin: big meaty germans (John)
        isMinion ? 0x08080b : colors.crowd[i % colors.crowd.length],
        isMinion ? 0xf2e8e0 : colors.skin[(i * 2 + 1) % colors.skin.length],
        // taller than the player (1.0), with variety — you look UP at the crowd
        isMinion ? 1.28 : 1.06 + ((i * 37) % 13) * 0.012,
        isMinion,
      );
      this.npcs.push(cv);
      this.scene.add(cv.group);
    }
    for (let i = 0; i < frame.npcs.length; i++)
      this.npcs[i].update(frame.npcs[i], dt, frame.beat, {
        grabTarget: gripTarget(frame.npcs[i]),
        holdTarget: heldBy.get(`n${i}`) ?? null, // a dancer arrives holding a bag
        dancer: i < CONFIG.crowd.dancers,
        mixing: i === CONFIG.crowd.count - 1, // the DJ works the decks
        watching: i >= minionFrom && i < CONFIG.crowd.count - 1 ? frame.npcs[i].watch : 0,
      });

    // the stall door + the wall clock ride the snapshot
    this.doorPivot.rotation.y = frame.doorAngle;
    const N = CONFIG.night;
    const hoursIn = (frame.nightT / N.length) * N.hours; // opened at midnight Sat
    // positive rotation.z: seen from inside the room (looking at the +z wall)
    // that sweeps CLOCKWISE — the negative sign ran the night backwards (John)
    this.clockHour.rotation.z = ((hoursIn % 12) / 12) * Math.PI * 2;
    this.clockMin.rotation.z = (hoursIn % 1) * Math.PI * 2;

    // light rig rides the beat
    const beatFrac = frame.beat - Math.floor(frame.beat);
    const pulse = Math.max(0, 1 - beatFrac * 3.2); // sharp attack on each kick
    for (const b of this.beams) {
      const t = frame.time * 0.5 + b.phase;
      b.light.position.set(Math.cos(t) * 5.2, 3.1 + Math.sin(t * 1.7) * 0.6, Math.sin(t * 0.8) * 3.6);
      b.light.intensity = 28 + pulse * 42;
    }
    // strobe: two quick white pops at the top of every 16-beat phrase
    const phrase = frame.beat % 16;
    this.strobe.intensity = phrase < 0.5 || (phrase > 1 && phrase < 1.3) ? 55 : 0;

    // FIRST-PERSON camera, head-stabilized (Peak): the eye follows the body's
    // POSITION but not its tilt jitter — an underdamped capsule welded to the
    // camera is a paint shaker. Upright: yaw-only offset, hint of roll.
    // Ragdolled: the camera goes down with the body and rolls fully.
    const me = frame.players[localId];
    if (me) {
      const C = CONFIG.camera;
      const K = CONFIG.ketamine;
      const k = me.k;
      // the world starts to move: slow multi-axis sway scaled by the felt level
      let swayYaw = 0;
      let swayPitch = 0;
      let swayRoll = 0;
      if (k > 0.03) {
        const t = frame.time;
        swayYaw = Math.sin(t * 2.1) * K.viewSway * k;
        swayPitch = Math.sin(t * 1.63 + 1.3) * K.viewSway * 0.7 * k;
        swayRoll = Math.sin(t * 1.31 + 2.6) * K.viewSway * 0.9 * k;
      }
      const cy = camYaw + swayYaw;
      const cp = camPitch + swayPitch;
      const bodyQ = new THREE.Quaternion(me.rot.x, me.rot.y, me.rot.z, me.rot.w);
      const eye = new THREE.Vector3(me.pos.x, me.pos.y, me.pos.z);
      if (me.st === 1) {
        // down: eye welded to the tumbling body
        eye.add(new THREE.Vector3(0, C.eyeHeight, C.eyeFwd).applyQuaternion(bodyQ));
      } else {
        eye.y += C.eyeHeight;
        eye.x += -Math.sin(cy) * C.eyeFwd; // forward of the face, yaw-only
        eye.z += -Math.cos(cy) * C.eyeFwd;
      }
      this.camera.position.copy(eye);

      this.camera.quaternion.setFromEuler(new THREE.Euler(cp, cy, 0, 'YXZ'));
      // roll from body tilt: project the body's up onto the camera's right axis
      const bodyUp = new THREE.Vector3(0, 1, 0).applyQuaternion(bodyQ);
      const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const rollAmt = Math.asin(THREE.MathUtils.clamp(bodyUp.dot(camRight), -1, 1));
      const blend = me.st === 1 ? 1 : C.bodyRollBlend;
      this.camera.quaternion.multiply(
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 0, 1),
          rollAmt * blend + swayRoll,
        ),
      );

      // CSS-side K phenomenology (all compositor-cheap). The intensity curve
      // is SUPERLINEAR (kv = k²/4): level 2 restrained, 3 unmistakable, 4 a
      // good bit (John's staircase). Real-K looks: washed-out color, darkened
      // tunnel vision (the #kvig radial overlay), the room BREATHING (a slow
      // scale pulse), a hue drift deep in it.
      const kv = (k * k) / 4;
      const inHole = me.st === 1 && k >= K.maxLevel - 0.8;
      // the dark closes IN, not just down (b17, John): real distance fog
      // per level — deep in it you can't see across the room at all
      const fogT = Math.min(1, kv / 5);
      this.fog.near = K.fog.nearSober + (K.fog.nearHigh - K.fog.nearSober) * fogT;
      this.fog.far = K.fog.farSober + (K.fog.farHigh - K.fog.farSober) * fogT;
      const blur = inHole ? K.kholeBlur : kv * K.blurPerLevel;
      const bright = Math.max(0.45, 1 - K.darkenPerLevel * kv - (inHole ? 0.2 : 0));
      const sat = Math.max(0.55, 1 - 0.07 * kv);
      const hue =
        k > 3.6 ? ` hue-rotate(${Math.round(Math.sin(frame.time * 0.23) * 13 * (k - 3.6))}deg)` : '';
      const filter =
        k > 0.06
          ? `blur(${blur.toFixed(1)}px) brightness(${bright.toFixed(2)}) saturate(${sat.toFixed(2)})${hue}`
          : '';
      if (filter !== this.lastFilter) {
        this.lastFilter = filter;
        this.renderer.domElement.style.filter = filter;
      }
      const breathe =
        k > K.breatheFrom
          ? 1 + 0.007 * Math.sin(frame.time * 1.9) * Math.min(1, (k - K.breatheFrom) / 1.6)
          : 0;
      const transform = breathe > 0 ? `scale(${breathe.toFixed(4)})` : '';
      if (transform !== this.lastTransform) {
        this.lastTransform = transform;
        this.renderer.domElement.style.transform = transform;
      }
      if (this.vignette) {
        // mid-ritual all you can really see is the stuff in front of you
        // (John) — the tunnel doubles as the cutting focus
        const kVig = Math.min(1, Math.max(0, (k - K.vignetteFrom) / 2.4)) * 0.75;
        const vig = Math.max(kVig, cutting ? 0.55 : 0);
        const vigStr = vig.toFixed(2);
        if (vigStr !== this.lastVigOpacity) {
          this.lastVigOpacity = vigStr;
          (this.vignette as HTMLElement).style.opacity = vigStr;
        }
      }

      // motion trails: keep a fraction of the previous frame (ghosting /
      // tracers — THE ketamine visual). scene.background must not repaint
      // over the old frame, so it's parked while trails run.
      const trail =
        Math.min(1, Math.max(0, (k - K.trailFrom) / (5 - K.trailFrom))) * K.trailMax;
      if (trail > 0.02) {
        if (!this.sceneBg) {
          this.sceneBg = this.scene.background as THREE.Color;
          this.scene.background = null;
        }
        this.renderer.autoClear = false;
        this.fadeMat.opacity = 1 - trail;
        this.renderer.clearDepth();
        this.renderer.render(this.fadeScene, this.fadeCam);
        this.renderer.render(this.scene, this.camera);
        return;
      }
      if (this.sceneBg) {
        this.scene.background = this.sceneBg;
        this.sceneBg = null;
      }
      this.renderer.autoClear = true;
    }

    this.renderer.render(this.scene, this.camera);
  }
}

/** scale the baggy's powder block to the remaining fraction, anchored at the
 *  bottom of the pouch — how full it LOOKS is all the knowledge you get */
function setBaggyFill(fill: THREE.Mesh, frac: number): void {
  const h = CONFIG.items.kbag.h - 0.02;
  const f = Math.max(0.03, Math.min(1, frac));
  fill.scale.y = f;
  fill.position.y = (-h + h * f) / 2;
  fill.visible = frac > 0.005;
}
