// The Daemon — a glossy vinyl screen-face robot (Three.js).
// Head/ears/hands are smooth physical materials (cheap and premium-looking); all expression
// lives on the black glass screen: a 64×48 LED dot-matrix face drawn to a canvas and used as
// the screen's emissive map. Overlay particles stay on the 2D canvas above.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { C, clamp, css, memPct, moodOf, ramp, rgb, rnd, type Layer, type Mood, type Sample } from './engine';
import { Led } from './led';

/** Sphere pushed toward a rounded box (e < 1 = boxier). Seam welded so it shades cleanly. */
function squircle(sx: number, sy: number, sz: number, e: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.SphereGeometry(1, 96, 64, -Math.PI / 2);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.attributes.position, f = (v: number) => Math.sign(v) * Math.abs(v) ** e;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, f(p.getX(i)) * sx, f(p.getY(i)) * sy, f(p.getZ(i)) * sz);
  g.computeVertexNormals();
  return g;
}

// LED face resolution and the on-screen colour per mood
const FW = 64, FH = 48;
const FACE_COL: Record<Mood, string> = { chill: '#9EDCFF', workout: '#FFE27A', meltdown: '#FF3B5C' };

/** The screen: an LED matrix lit onto a canvas that is the screen's emissive map. */
class FaceScreen {
  readonly tex: THREE.CanvasTexture;
  private led = new Led(FW, FH);
  private out = document.createElement('canvas');
  private ox: CanvasRenderingContext2D;

  constructor() {
    this.out.width = FW * 8;
    this.out.height = FH * 8;
    this.ox = this.out.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.out);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
  }

  render(color: string, glitch: number, paint: (g: CanvasRenderingContext2D) => void) {
    const g = this.led.g;
    g.clearRect(0, 0, FW, FH);
    g.fillStyle = g.strokeStyle = color;
    g.lineCap = g.lineJoin = 'round';
    paint(g);
    if (glitch > 0) {
      // slice-shift a few rows + static
      for (let k = 0; k < 3; k++) {
        const y = (Math.random() * FH) | 0, h = 1 + ((Math.random() * 4) | 0);
        g.drawImage(this.led.low, 0, y, FW, h, ((Math.random() - 0.5) * 10 * glitch) | 0, y, FW, h);
      }
      for (let k = 0; k < 20 * glitch; k++) g.fillRect((Math.random() * FW) | 0, (Math.random() * FH) | 0, 1, 1);
    }
    this.ox.fillStyle = '#000';
    this.ox.fillRect(0, 0, this.out.width, this.out.height);
    this.led.present(this.ox, this.out.width, this.out.height, 0.9);
    this.tex.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Behaviour: everything the bot does beyond its mood baseline is an Act —
// a short, self-contained performance (face + pose + colour + particles).
// ---------------------------------------------------------------------------
type Eyes = 'open' | 'big' | 'sleepy' | 'shut' | 'happy' | 'x' | 'heart' | 'spiral' | 'ring' | 'angry' | 'star';
type Mouth = 'smile' | 'grin' | 'flat' | 'o' | 'yawn' | 'wavy' | 'tongue' | 'whistle' | 'frown';
type Hand = [x: number, y: number, z: number, rz: number];
type Pose = { rx?: number; ry?: number; rz?: number; lift?: number; hands?: [Hand | null, Hand | null] };
export type Act =
  | 'giggle' | 'love' | 'surprise' | 'shy' | 'stat' | 'tongue' | 'starstruck' | 'wave' | 'spin'
  | 'dizzy' | 'grumpy' | 'flip' | 'pet' | 'curious' | 'startle'
  | 'yawn' | 'look' | 'hum' | 'stretch' | 'doze';
type ActDef = { dur: number; eyes: Eyes | [Eyes, Eyes]; mouth: Mouth; color?: string; pose?: (p: number, t: number) => Pose; burst?: 'hearts' | 'stars' };

const env = (p: number) => Math.sin(Math.PI * clamp(p, 0, 1)); // 0 → 1 → 0
const inOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const HAPPY = '#BFF1FF';

const ACTS: Record<Act, ActDef> = {
  // poke reactions
  giggle: { dur: 1.4, eyes: 'happy', mouth: 'grin', color: HAPPY, pose: (p, t) => ({ lift: Math.abs(Math.sin(t * 14)) * 0.12 * env(p), rz: Math.sin(t * 16) * 0.07 * env(p) }) },
  love: { dur: 2, eyes: 'heart', mouth: 'smile', color: '#FF9BD2', burst: 'hearts', pose: (p) => ({ lift: 0.1 * env(p), rz: 0.12 * env(p) }) },
  surprise: { dur: 1.2, eyes: 'ring', mouth: 'o', color: '#E8F6FF', pose: (p) => ({ lift: 0.25 * env(p * 1.6), hands: [[-1.75, 0.55, 0.3, 0.4], [1.75, 0.55, 0.3, -0.4]] }) },
  shy: { dur: 2, eyes: 'happy', mouth: 'smile', color: '#FFB8DA', pose: (p) => ({ rx: 0.16 * env(p), hands: [[-0.42, 0.02, 1.0, 0.15], [0.42, 0.02, 1.0, -0.15]] }) },
  stat: { dur: 2.4, eyes: 'happy', mouth: 'smile', color: HAPPY },
  tongue: { dur: 1.4, eyes: ['shut', 'open'], mouth: 'tongue', color: HAPPY, pose: (p) => ({ rz: -0.12 * env(p) }) },
  starstruck: { dur: 1.6, eyes: 'star', mouth: 'grin', color: '#FFE27A', burst: 'stars', pose: (p) => ({ lift: 0.15 * env(p) }) },
  wave: { dur: 1.8, eyes: 'happy', mouth: 'smile', color: HAPPY, pose: (_p, t) => ({ hands: [null, [1.8, 0.6, 0.3, -0.35 + Math.sin(t * 14) * 0.45]] }) },
  spin: { dur: 1.3, eyes: 'happy', mouth: 'grin', color: HAPPY, pose: (p) => ({ ry: Math.PI * 2 * inOut(p), lift: 0.15 * env(p) }) },
  // escalation + gestures
  dizzy: { dur: 2.6, eyes: 'spiral', mouth: 'wavy', color: '#C9B2FF', pose: (p, t) => ({ rz: Math.sin(t * 5) * 0.22 * env(p), ry: Math.sin(t * 3.4) * 0.3 * env(p) }) },
  grumpy: { dur: 2.4, eyes: 'angry', mouth: 'frown', color: '#FFB020', pose: (p) => ({ ry: 0.7 * env(p), hands: [[-0.5, -0.8, 0.75, 1.15], [0.5, -0.8, 0.75, -1.15]] }) },
  flip: { dur: 1.1, eyes: 'happy', mouth: 'grin', color: HAPPY, pose: (p) => ({ rx: -Math.PI * 2 * inOut(p), lift: 0.45 * env(p) }) },
  pet: { dur: 1.3, eyes: 'happy', mouth: 'smile', color: '#FF9BD2', burst: 'hearts', pose: (_p, t) => ({ rz: Math.sin(t * 6) * 0.06 }) },
  curious: { dur: 2, eyes: 'big', mouth: 'smile', pose: (p) => ({ rz: 0.2 * env(p) }) },
  startle: { dur: 1, eyes: 'ring', mouth: 'o', color: '#E8F6FF', pose: (p) => ({ lift: 0.3 * env(p * 1.5), hands: [[-1.75, 0.6, 0.3, 0.4], [1.75, 0.6, 0.3, -0.4]] }) },
  // idle life
  yawn: { dur: 2.4, eyes: 'shut', mouth: 'yawn', pose: (p) => ({ rx: -0.15 * env(p), hands: [[-1.6, 0.7, 0.2, 0.6], [1.6, 0.7, 0.2, -0.6]] }) },
  look: { dur: 2.8, eyes: 'open', mouth: 'flat', pose: (p) => ({ ry: Math.sin(p * Math.PI * 2) * 0.65 }) },
  hum: { dur: 3.2, eyes: 'happy', mouth: 'whistle', pose: (p, t) => ({ rz: Math.sin(t * 4) * 0.09 * env(p) }) },
  stretch: { dur: 2.2, eyes: 'shut', mouth: 'o', pose: (p) => ({ rx: -0.22 * env(p), lift: 0.12 * env(p), hands: [[-1.3, 1.05, 0.1, 0.9], [1.3, 1.05, 0.1, -0.9]] }) },
  doze: { dur: 4, eyes: 'shut', mouth: 'flat', pose: (p) => ({ rx: 0.28 * Math.min(1, p * 3) * (p > 0.85 ? (1 - p) / 0.15 : 1), lift: -0.08 * env(p) }) },
};
const POKE_POOL: Act[] = ['giggle', 'love', 'surprise', 'shy', 'stat', 'tongue', 'starstruck', 'wave', 'spin'];
const IDLE_POOL: Record<Mood, Act[]> = {
  chill: ['yawn', 'look', 'hum', 'stretch', 'doze', 'wave', 'spin', 'tongue'],
  workout: ['look', 'stretch', 'spin', 'hum', 'giggle'],
  meltdown: [],
};
/** Acts the user caused outrank idle ones; idle acts never interrupt anything. */
const USER_ACTS = new Set<Act>([...POKE_POOL, 'dizzy', 'grumpy', 'flip', 'pet']);

export class Bot implements Layer {
  mood: Mood = 'chill';
  private cand: Mood = 'chill';
  private candN = 0;
  private sample: Sample | null = null;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 2, 0.1, 50);
  private root = new THREE.Group(); // float / hop / jitter
  private head = new THREE.Group(); // tilt + squash
  private ears: THREE.Mesh[] = [];
  private hands: THREE.Mesh[] = [];
  private shadow: THREE.Mesh;
  private face = new FaceScreen();
  private size = { w: 0, h: 0 };
  private look = new THREE.Vector2();
  private aim: { x: number; y: number } | null = null;
  private blink = 0;
  private nextBlink = 2;
  private wink = 0;
  private squash = 0;
  private squashV = 0;
  private screen = { x: 0, y: 0, r: 40 };
  private fx = new Fx();
  /** Called whenever a reaction actually starts (sounds, haptics). */
  onAct?: (kind: Act, byUser: boolean) => void;
  // behaviour state
  private act: { kind: Act; t: number } | null = null;
  private lastAct: Act | null = null;
  private idleIn = 6;
  private pokes: number[] = [];
  private statIdx = 0;
  private petDist = 0;
  private petAt = 0;
  private hoverSince = 0;
  private hoverPos = { x: 0, y: 0 };

  constructor(canvas: HTMLCanvasElement) {
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' }));
    r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    r.toneMapping = THREE.NeutralToneMapping;
    r.setClearColor(0x000000, 0);
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this.camera.position.set(0, 0.2, 7.6);
    this.camera.lookAt(0, -0.05, 0);
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(-3, 4, 5);
    const fill = new THREE.DirectionalLight(0xdbe8ff, 0.35);
    fill.position.set(4, 1, 3);
    const rim = new THREE.DirectionalLight(0xffffff, 1.2);
    rim.position.set(0, 2, -5);
    this.scene.add(key, fill, rim, new THREE.HemisphereLight(0xffffff, 0xaab4c6, 0.55));

    const vinyl = new THREE.MeshPhysicalMaterial({ color: '#ECEFF4', roughness: 0.42, clearcoat: 0.4, clearcoatRoughness: 0.3 });

    // head
    this.head.add(new THREE.Mesh(squircle(1.25, 1.02, 0.95, 0.6), vinyl));
    // black glass screen with the LED face as emissive map
    const scr = squircle(1.0, 0.76, 0.3, 0.42);
    const sp = scr.attributes.position, uv: number[] = [];
    for (let i = 0; i < sp.count; i++) uv.push(sp.getX(i) / 2 + 0.5, sp.getY(i) / 1.52 + 0.5); // planar front projection
    scr.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const screen = new THREE.Mesh(scr, new THREE.MeshPhysicalMaterial({
      color: '#05070B', roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.04,
      emissive: '#ffffff', emissiveMap: this.face.tex, emissiveIntensity: 1.5,
    }));
    screen.position.z = 0.7;
    this.head.add(screen);
    // cat-ear nubs: lathe of a soft rounded cone
    const prof = [[0, 0.34], [0.07, 0.33], [0.15, 0.27], [0.22, 0.16], [0.27, 0.05], [0.29, -0.06], [0, -0.06]].map(([x, y]) => new THREE.Vector2(x, y));
    const earGeo = new THREE.LatheGeometry(prof, 40);
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(earGeo, vinyl);
      ear.position.set(s * 0.74, 0.86, -0.05);
      ear.rotation.z = -s * 0.42;
      this.head.add(ear);
      this.ears.push(ear);
    }
    this.root.add(this.head);
    // floating paddle hands
    const handGeo = new THREE.CapsuleGeometry(0.17, 0.34, 10, 28).scale(1, 1, 0.72);
    for (let i = 0; i < 2; i++) {
      const hand = new THREE.Mesh(handGeo, vinyl);
      this.root.add(hand);
      this.hands.push(hand);
    }
    this.scene.add(this.root);

    // soft floor shadow
    const sc = document.createElement('canvas');
    sc.width = sc.height = 128;
    const sx = sc.getContext('2d')!, sg = sx.createRadialGradient(64, 64, 0, 64, 64, 64);
    sg.addColorStop(0, 'rgba(30,40,70,0.38)');
    sg.addColorStop(1, 'rgba(30,40,70,0)');
    sx.fillStyle = sg;
    sx.fillRect(0, 0, 128, 128);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.8), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = -1.7;
    this.scene.add(this.shadow);
  }

  // ---------- inputs ----------
  setSample(s: Sample) {
    const prev = this.sample;
    this.sample = s;
    const m = moodOf(s);
    this.candN = m === this.cand ? this.candN + 1 : 1;
    this.cand = m;
    if (this.candN >= 2) this.mood = m;
    if (prev && s.cpu - prev.cpu > 30) this.start('startle'); // sudden spike
  }

  pointer(p: { x: number; y: number } | null) {
    this.aim = p;
    const now = performance.now();
    if (!p || !this.hit(p.x, p.y)) {
      this.hoverSince = 0;
      this.petDist = 0;
      return;
    }
    // petting: brisk back-and-forth strokes over the bot
    if (now - this.petAt > 400) this.petDist = 0;
    this.petDist += Math.hypot(p.x - this.hoverPos.x, p.y - this.hoverPos.y);
    this.petAt = now;
    if (this.petDist > 280) {
      this.petDist = 0;
      this.start('pet', true);
    }
    // curiosity: cursor resting on the bot
    if (!this.hoverSince || Math.hypot(p.x - this.hoverPos.x, p.y - this.hoverPos.y) > 8) this.hoverSince = now;
    this.hoverPos = { x: p.x, y: p.y };
  }

  hit(x: number, y: number) {
    return Math.hypot(x - this.screen.x, y - this.screen.y) < this.screen.r * 1.3;
  }

  /** Poke: a varied reaction, escalating to dizzy then grumpy when poked rapidly. Returns what it did. */
  poke(): Act {
    const now = performance.now();
    this.pokes = this.pokes.filter((p) => now - p < 2500).concat(now);
    this.squashV += 7;
    const n = this.pokes.length;
    const kind: Act = n >= 7 ? 'grumpy' : n >= 4 ? 'dizzy' : this.pick(POKE_POOL);
    if (kind === 'stat') this.statIdx++;
    this.start(kind, true);
    return kind;
  }

  flip() {
    this.squashV += 4;
    this.start('flip', true);
  }

  // ---------- behaviour ----------
  private pick(pool: Act[]): Act {
    const options = pool.filter((a) => a !== this.lastAct);
    return options[(Math.random() * options.length) | 0] ?? pool[0];
  }

  private start(kind: Act, byUser = false) {
    const cur = this.act;
    if (cur && !byUser && USER_ACTS.has(cur.kind)) return; // never interrupt the user's moment
    this.act = { kind, t: 0 };
    this.lastAct = kind;
    this.onAct?.(kind, byUser);
    this.idleIn = rnd(7, 15);
    const burst = ACTS[kind].burst;
    if (burst === 'hearts') this.fx.hearts(this.screen.x, this.screen.y - this.screen.r * 0.7);
    if (burst === 'stars') this.fx.stars(this.screen.x, this.screen.y);
  }

  private tick(dt: number) {
    if (this.act && (this.act.t += dt) >= ACTS[this.act.kind].dur) this.act = null;
    if (this.act) return;
    if (this.hoverSince && performance.now() - this.hoverSince > 1400) {
      this.hoverSince = 0;
      this.start('curious');
      return;
    }
    if ((this.idleIn -= dt) > 0) return;
    const night = new Date().getHours() >= 23 || new Date().getHours() < 6;
    const pool = night && this.mood === 'chill' ? (['doze', 'yawn', 'doze', 'hum'] as Act[]) : IDLE_POOL[this.mood];
    if (pool.length) this.start(this.pick(pool));
    else this.idleIn = rnd(7, 15);
  }

  private stat(): [string, string] {
    const s = this.sample;
    if (!s) return ['HI', ':)'];
    const opts: [string, string][] = [['CPU', `${s.cpu.toFixed(0)}%`], ['RAM', `${memPct(s).toFixed(0)}%`]];
    if (s.temp != null) opts.push(['TEMP', `${s.temp.toFixed(0)}°`]);
    return opts[this.statIdx % opts.length];
  }

  // ---------- face ----------
  private eye(g: CanvasRenderingContext2D, kind: Eyes, x: number, y: number, t: number, side: number) {
    g.lineWidth = 2.6;
    g.beginPath();
    switch (kind) {
      case 'open': {
        const bob = this.mood === 'workout' && !this.act ? Math.abs(Math.sin(t * 4.6)) * -1.5 : 0;
        g.roundRect(x - 5, y - 6 + bob, 10, 11, 3);
        g.fill();
        break;
      }
      case 'big':
        g.roundRect(x - 6, y - 7, 12, 14, 4);
        g.fill();
        g.clearRect(x - 3, y - 5, 3, 3); // sparkle highlight
        break;
      case 'sleepy':
        g.roundRect(x - 6, y + 1, 12, 3.5, 1.5);
        g.fill();
        break;
      case 'shut':
        g.moveTo(x - 5, y + 2);
        g.lineTo(x + 5, y + 2);
        g.stroke();
        break;
      case 'happy':
        g.moveTo(x - 6, y + 3);
        g.lineTo(x, y - 3);
        g.lineTo(x + 6, y + 3);
        g.stroke();
        break;
      case 'x':
        g.moveTo(x - 5, y - 5);
        g.lineTo(x + 5, y + 5);
        g.moveTo(x + 5, y - 5);
        g.lineTo(x - 5, y + 5);
        g.stroke();
        break;
      case 'heart': {
        const s = 1 + 0.15 * Math.sin(t * 10);
        g.moveTo(x, y + 5 * s);
        g.bezierCurveTo(x - 8 * s, y - 1 * s, x - 4 * s, y - 8 * s, x, y - 3 * s);
        g.bezierCurveTo(x + 4 * s, y - 8 * s, x + 8 * s, y - 1 * s, x, y + 5 * s);
        g.fill();
        break;
      }
      case 'spiral':
        g.lineWidth = 1.6;
        for (let a = 0; a < Math.PI * 4; a += 0.3) {
          const r = 0.8 + a * 0.5, aa = a + t * 8 * side;
          g.lineTo(x + Math.cos(aa) * r, y + Math.sin(aa) * r);
        }
        g.stroke();
        break;
      case 'ring':
        g.lineWidth = 2.4;
        g.arc(x, y, 5.5, 0, Math.PI * 2);
        g.stroke();
        g.fillRect(x - 1, y - 1, 2, 2);
        break;
      case 'angry':
        // brow slants down toward the middle
        g.moveTo(x - 5, side < 0 ? y - 5 : y - 1);
        g.lineTo(x + 5, side < 0 ? y - 1 : y - 5);
        g.lineTo(x + 5, y + 5);
        g.lineTo(x - 5, y + 5);
        g.fill();
        break;
      case 'star':
        for (let k = 0; k < 8; k++) {
          const a = t * 3 + (k * Math.PI) / 4, r = k % 2 ? 2.6 : 7;
          g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        }
        g.fill();
        break;
    }
  }

  private mouth(g: CanvasRenderingContext2D, kind: Mouth, x: number, y: number, t: number, p: number) {
    g.lineWidth = 2.4;
    g.beginPath();
    switch (kind) {
      case 'smile':
        g.arc(x, y - 5, 5.5, 0.25 * Math.PI, 0.75 * Math.PI);
        g.stroke();
        break;
      case 'grin':
        g.moveTo(x - 8, y - 2);
        g.lineTo(x + 8, y - 2);
        g.quadraticCurveTo(x, y + 6 + Math.sin(t * 9) * 1.2, x - 8, y - 2);
        g.fill();
        break;
      case 'flat':
        g.moveTo(x - 5, y);
        g.lineTo(x + 5, y);
        g.stroke();
        break;
      case 'o':
        g.lineWidth = 2;
        g.arc(x, y, 3, 0, Math.PI * 2);
        g.stroke();
        break;
      case 'yawn':
        g.ellipse(x, y, 3 + 2.5 * env(p), 2 + 4.5 * env(p), 0, 0, Math.PI * 2);
        g.fill();
        break;
      case 'wavy':
        for (let i = 0; i <= 6; i++) g.lineTo(x - 9 + i * 3, y + (i % 2 ? -2 : 2) * (0.7 + 0.3 * Math.sin(t * 20 + i)));
        g.stroke();
        break;
      case 'tongue':
        g.arc(x, y - 5, 5.5, 0.25 * Math.PI, 0.75 * Math.PI);
        g.stroke();
        g.beginPath();
        g.roundRect(x + 0.5, y - 0.5, 4, 4.5, 2);
        g.fill();
        break;
      case 'whistle': {
        g.lineWidth = 1.8;
        g.arc(x + 2, y - 1, 2, 0, Math.PI * 2);
        g.stroke();
        // floating ♪ notes
        for (const [nx, off] of [[48, 0], [54, 0.5]]) {
          const ny = 16 - (((t * 0.7 + off) % 1) * 12);
          g.fillRect(nx, ny, 3, 2);
          g.fillRect(nx + 2, ny - 6, 1, 6);
          g.fillRect(nx + 2, ny - 6, 3, 1);
        }
        break;
      }
      case 'frown':
        g.arc(x, y + 4, 5.5, 1.25 * Math.PI, 1.75 * Math.PI);
        g.stroke();
        break;
    }
  }

  private paintFace(g: CanvasRenderingContext2D, t: number) {
    const m = this.mood, a = this.act, def = a ? ACTS[a.kind] : null, p = a && def ? a.t / def.dur : 0;
    const lx = this.look.x * 4, ly = -this.look.y * 2.5, cx = FW / 2, ey = 20 + ly;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (a?.kind === 'stat' && a.t > 0.45) {
      const [k, v] = this.stat();
      g.font = 'bold 11px ui-monospace, Menlo, monospace';
      g.fillText(k, cx, 15);
      g.font = 'bold 17px ui-monospace, Menlo, monospace';
      g.fillText(v, cx, 32);
      return;
    }
    let eyes: [Eyes, Eyes], mouth: Mouth;
    if (def) {
      eyes = Array.isArray(def.eyes) ? def.eyes : [def.eyes, def.eyes];
      mouth = def.mouth;
    } else {
      const base: Eyes = m === 'meltdown' ? 'x' : m === 'chill' ? 'sleepy' : 'open';
      eyes = [base, base];
      mouth = m === 'meltdown' ? 'wavy' : m === 'chill' ? 'smile' : 'grin';
    }
    // blinks and winks only on open-style eyes
    const blinkable = (e: Eyes) => e === 'open' || e === 'sleepy' || e === 'big';
    if (this.blink > 0) eyes = eyes.map((e) => (blinkable(e) ? 'shut' : e)) as [Eyes, Eyes];
    else if (this.wink > 0 && eyes[1] === 'open') eyes[1] = 'shut';
    this.eye(g, eyes[0], cx - 13 + lx, ey, t, -1);
    this.eye(g, eyes[1], cx + 13 + lx, ey, t, 1);
    this.mouth(g, mouth, cx + lx * 0.5, 35 + ly * 0.5, t, p);

    // little extras
    g.font = 'bold 8px ui-monospace, monospace';
    if (a?.kind === 'curious') g.fillText('?', 54, 10);
    else if (a?.kind === 'doze' || (!a && m === 'chill' && Math.sin(t * 0.9) > 0.2)) g.fillText('z', 52, 12 - ((t * 4) % 6));
    else if (!a && m === 'workout') {
      const sy = 8 + ((t * 10) % 8); // sweat drop
      g.beginPath();
      g.arc(53, sy, 1.6, 0, Math.PI);
      g.lineTo(53, sy - 3);
      g.fill();
    }
  }

  // ---------- frame ----------
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, dt: number) {
    dt = clamp(dt, 0, 0.05); // rAF timestamps can precede the previous performance.now()
    if (w !== this.size.w || h !== this.size.h) {
      this.size = { w, h };
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.tick(dt);
    const m = this.mood, a = this.act, def = a ? ACTS[a.kind] : null;
    const pose: Pose = a && def?.pose ? def.pose(a.t / def.dur, t) : {};

    // body motion: mood baseline + act pose on top
    const beat = Math.abs(Math.sin(t * 4.6));
    const lift = (m === 'chill' ? Math.sin(t * 1.3) * 0.08 : m === 'workout' && !a ? beat * 0.2 : 0) + (pose.lift ?? 0);
    const jit = m === 'meltdown' && !a ? 0.035 : 0;
    this.root.position.set(rnd(-jit, jit), lift + rnd(-jit, jit), 0);
    this.squashV += (-140 * this.squash - 9 * this.squashV) * dt;
    this.squash += this.squashV * dt;
    const land = m === 'workout' && !a ? Math.pow(1 - beat, 6) * 0.06 : 0;
    this.head.scale.set(1 + this.squash * 0.22 + land, 1 - this.squash * 0.2 - land, 1 + this.squash * 0.22 + land);

    // look at cursor
    const tx = this.aim ? clamp((this.aim.x / w) * 2 - 1, -1, 1) : Math.sin(t * 0.4) * 0.35;
    const ty = this.aim ? clamp(1 - (this.aim.y / h) * 2, -1, 1) : Math.sin(t * 0.27) * 0.2;
    this.look.lerp(new THREE.Vector2(tx, ty), Math.min(1, dt * 7));
    const baseRz = m === 'chill' ? Math.sin(t * 0.9) * 0.05 : m === 'meltdown' && !a ? rnd(-0.04, 0.04) : 0;
    this.head.rotation.set(-this.look.y * 0.18 + (pose.rx ?? 0), this.look.x * 0.42 + (pose.ry ?? 0), baseRz + (pose.rz ?? 0));
    this.ears.forEach((e, i) => (e.rotation.z = (i ? -0.42 : 0.42) + (m === 'meltdown' || a?.kind === 'dizzy' ? Math.sin(t * 30 + i) * 0.12 : 0)));

    // hands: mood baseline unless the act places them
    this.hands.forEach((hd, i) => {
      const s = i ? 1 : -1;
      let target: Hand = [s * 1.9, -0.2, 0.3, s * 0.22];
      if (m === 'chill') target[1] += Math.sin(t * 1.3 + i * 1.2) * 0.1;
      else if (m === 'workout') (target[1] += Math.sin(t * 9.2 + i * Math.PI) * 0.32), (target[3] += Math.sin(t * 9.2 + i * Math.PI) * 0.3);
      else target = [s * 1.9 + Math.sin(t * 13 + i) * 0.1, 0.5 + Math.sin(t * 16 + i * 2) * 0.18, 0.3, s * -0.5 + Math.sin(t * 17 + i) * 0.4];
      const over = pose.hands?.[i];
      if (over) target = over;
      const k = Math.min(1, dt * 12);
      hd.position.lerp(new THREE.Vector3(target[0], target[1], target[2]), k);
      hd.rotation.z += (target[3] - hd.rotation.z) * k;
    });

    // face timers
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) {
      if (m !== 'meltdown' && Math.random() < 0.18) this.wink = 0.5;
      else this.blink = 0.12;
      this.nextBlink = rnd(2, 5);
    }
    this.blink -= dt;
    this.wink -= dt;
    const color = def?.color ?? FACE_COL[m];
    this.face.render(color, m === 'meltdown' && !a ? 0.6 + Math.random() * 0.4 : a?.kind === 'dizzy' ? 0.3 : 0, (g) => this.paintFace(g, t));

    this.shadow.scale.setScalar(1 - Math.max(0, lift) * 0.9);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 1 - Math.max(0, lift) * 1.5;
    this.renderer.render(this.scene, this.camera);

    const c = new THREE.Vector3().applyMatrix4(this.root.matrixWorld).project(this.camera);
    const e = new THREE.Vector3(1.25, 0, 0).applyMatrix4(this.root.matrixWorld).project(this.camera);
    this.screen = { x: (c.x * 0.5 + 0.5) * w, y: (-c.y * 0.5 + 0.5) * h, r: Math.abs(e.x - c.x) * 0.5 * w };
    this.fx.draw(ctx, m, this.screen.x, this.screen.y, this.screen.r, dt);
  }
}

// ======================================================================
// Overlay particles (2D) — tuned for a light backdrop
// ======================================================================
type Part = { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; rot: number; kind: 'bubble' | 'star' | 'sweat' | 'heart' | 'steam' | 'fire' };

class Fx {
  private ps: Part[] = [];
  private acc = 0;
  private add(kind: Part['kind'], x: number, y: number, vx: number, vy: number, max: number, size: number) {
    this.ps.push({ x, y, vx, vy, life: 0, max, size, rot: rnd(0, 6.28), kind });
  }
  hearts(x: number, y: number) {
    for (let i = 0; i < 7; i++) {
      const a = rnd(-2.6, -0.5), sp = rnd(50, 110);
      this.add('heart', x, y, Math.cos(a) * sp, Math.sin(a) * sp, rnd(0.8, 1.3), rnd(4, 7));
    }
  }
  stars(x: number, y: number) {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2, sp = rnd(70, 120);
      this.add('star', x, y, Math.cos(a) * sp, Math.sin(a) * sp, rnd(0.5, 0.8), rnd(4, 7));
    }
  }
  private spawn(m: Mood, cx: number, cy: number, R: number) {
    if (m === 'chill') this.add('bubble', cx + rnd(-1.6, 1.6) * R, cy + R * 0.7, rnd(-4, 4), rnd(-18, -9), rnd(2.5, 4), rnd(2, 4));
    else if (m === 'workout') {
      if (Math.random() < 0.2) {
        const s = Math.random() < 0.5 ? -1 : 1;
        this.add('sweat', cx + s * R * 0.9, cy - R * 0.7, s * rnd(30, 70), rnd(-90, -50), 0.9, rnd(3, 4.5));
      } else {
        const a = rnd(0, Math.PI * 2), sp = rnd(60, 130);
        this.add('star', cx + Math.cos(a) * R * 1.3, cy + Math.sin(a) * R * 1.1, Math.cos(a) * sp, Math.sin(a) * sp, rnd(0.35, 0.6), rnd(3, 6));
      }
    } else {
      // steam vents from the ears, sparks from the top
      const s = Math.random() < 0.5 ? -1 : 1, fire = Math.random() < 0.35;
      this.add(fire ? 'fire' : 'steam', cx + s * R * 0.6, cy - R * 0.85, s * rnd(10, 40), fire ? rnd(-110, -60) : rnd(-50, -25), fire ? rnd(0.4, 0.7) : rnd(1.2, 2), fire ? rnd(3, 6) : rnd(5, 8));
    }
  }
  draw(ctx: CanvasRenderingContext2D, m: Mood, cx: number, cy: number, R: number, dt: number) {
    this.acc += (m === 'chill' ? 1.2 : m === 'workout' ? 12 : 30) * dt;
    for (; this.acc >= 1; this.acc--) this.spawn(m, cx, cy, R);
    const ps = this.ps;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life += dt;
      if (p.life >= p.max) {
        ps[i] = ps[ps.length - 1];
        ps.pop();
        continue;
      }
      if (p.kind === 'sweat' || p.kind === 'heart') p.vy += (p.kind === 'sweat' ? 260 : 60) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += dt * 4;
      const k = 1 - p.life / p.max;
      ctx.beginPath();
      switch (p.kind) {
        case 'bubble':
          ctx.strokeStyle = `rgba(47,123,255,${0.45 * k})`;
          ctx.lineWidth = 1.2;
          ctx.arc(p.x + Math.sin(p.life * 3) * 3, p.y, p.size, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'star':
          ctx.fillStyle = css(rgb(C.sunny), k);
          for (let j = 0; j < 8; j++) {
            const a = p.rot + (j * Math.PI) / 4, rr = (j % 2 ? 0.38 : 1) * p.size * (0.5 + k * 0.5);
            ctx.lineTo(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr);
          }
          ctx.fill();
          break;
        case 'sweat':
          ctx.fillStyle = `rgba(80,160,255,${0.85 * k})`;
          ctx.arc(p.x, p.y, p.size, 0, Math.PI);
          ctx.lineTo(p.x, p.y - p.size * 2.2);
          ctx.fill();
          break;
        case 'heart': {
          const s = p.size, x = p.x, y = p.y;
          ctx.fillStyle = css(rgb(C.pink), Math.min(1, k * 1.5));
          ctx.moveTo(x, y + s * 0.35);
          ctx.bezierCurveTo(x - s * 1.1, y - s * 0.35, x - s * 0.45, y - s * 1.05, x, y - s * 0.45);
          ctx.bezierCurveTo(x + s * 0.45, y - s * 1.05, x + s * 1.1, y - s * 0.35, x, y + s * 0.35);
          ctx.fill();
          break;
        }
        case 'fire': {
          const r = p.size * (0.5 + 0.7 * k), fg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
          fg.addColorStop(0, css(ramp([C.red, C.coral, C.sunny], k), Math.min(1, k * 1.4)));
          fg.addColorStop(1, css(rgb(C.red), 0));
          ctx.fillStyle = fg;
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'steam': {
          p.vx *= 0.98;
          p.size += dt * 10;
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
          g.addColorStop(0, `rgba(120,132,155,${0.32 * k})`);
          g.addColorStop(1, 'rgba(120,132,155,0)');
          ctx.fillStyle = g;
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
}
