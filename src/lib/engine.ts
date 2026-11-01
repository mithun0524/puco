// Puco shared types, palette, helpers, and the three telemetry visualisers.
// The visualisers draw at LED-matrix resolution (1 unit = 1 LED) and are lit by LedLayer.

export type Proc = { pid: number; name: string; cpu: number; mem: number; exe: string | null };
export type Sample = {
  cpu: number;
  memUsed: number;
  memTotal: number;
  temp: number | null;
  battery: { pct: number; charging: boolean } | null;
  topCpu: Proc[];
  topMem: Proc[];
};
export type Mood = 'chill' | 'workout' | 'meltdown';
export interface Layer {
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, dt: number): void;
}

/** Studio theme: white vinyl, black glass, LED light. */
export const C = { accent: '#2F7BFF', pink: '#FF4FA3', sunny: '#FFD23F', coral: '#FF8A3D', red: '#FF3B5C', ink: '#1B2333' };
/** LED colours on black glass, cool → hot. */
export const LED = { cool: '#5EC8FF', teal: '#3EF0C8', amber: '#FFC233', red: '#FF3B5C', dim: 'rgba(158,220,255,0.28)' };
const HEAT = [LED.cool, LED.teal, LED.amber, LED.red];
/** Mood thresholds (load %, °C). Tune here. */
export const T = { workout: 45, meltdown: 75, hotC: 80 };

export const memPct = (s: Sample) => (s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0);

export function moodOf(s: Sample): Mood {
  const load = Math.max(s.cpu, memPct(s));
  if (load > T.meltdown || (s.temp ?? 0) > T.hotC) return 'meltdown';
  return load >= T.workout ? 'workout' : 'chill';
}

// ---------- helpers ----------
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);
type RGB = [number, number, number];
const rgbCache = new Map<string, RGB>();
export function rgb(hex: string): RGB {
  let v = rgbCache.get(hex);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    rgbCache.set(hex, (v = [n >> 16, (n >> 8) & 255, n & 255]));
  }
  return v;
}
/** Sample a palette ramp at t∈[0,1]. */
export function ramp(stops: string[], t: number): RGB {
  const x = clamp(t, 0, 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const a = rgb(stops[i]), b = rgb(stops[i + 1]), f = x - i;
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}
export const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const toWhite = (c: RGB, k: number): RGB => [lerp(c[0], 255, k), lerp(c[1], 255, k), lerp(c[2], 255, k)];
/** Colour for a 0–100 load value. */
export const heatColor = (pct: number) => css(ramp(HEAT, pct / 100));

/** Size a canvas to its CSS box at device pixel ratio. */
export function fit(cv: HTMLCanvasElement) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const { width: w, height: h } = cv.getBoundingClientRect();
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// ======================================================================
// Liquid Inertia Gyroscope — CPU as light-liquid sloshing in a flask
// ======================================================================
export class Flask implements Layer {
  private readonly N = 32;
  private hh = new Float32Array(this.N);
  private hv = new Float32Array(this.N);
  private lap = new Float32Array(this.N);
  private level = 0;
  private levelV = 0;
  private target = 0;
  private cpu = 0;
  private acc = 0;
  private pendingDrops = 0;
  private bubbles: { x: number; y: number; v: number }[] = [];
  private drops: { x: number; y: number; vx: number; vy: number }[] = [];

  set(cpu: number) {
    const f = clamp(cpu / 100, 0, 1), jump = f - this.target;
    if (Math.abs(jump) > 0.1) {
      // spike → splash
      for (let k = 0; k < 4; k++) this.hv[(Math.random() * this.N) | 0] += rnd(-1, 1) * 70 * Math.abs(jump);
      this.pendingDrops += Math.min(10, Math.abs(jump) * 30) | 0;
    }
    this.target = f;
    this.cpu = cpu;
  }

  private step(h: number) {
    // under-damped spring on the level → visible inertia
    this.levelV += ((this.target - this.level) * 26 - this.levelV * 5.5) * h;
    this.level += this.levelV * h;
    const { N, hh, hv, lap } = this;
    for (let i = 0; i < N; i++) lap[i] = hh[Math.max(0, i - 1)] + hh[Math.min(N - 1, i + 1)] - 2 * hh[i];
    for (let i = 0; i < N; i++) {
      hv[i] += (900 * lap[i] - 40 * hh[i] - 2.4 * hv[i]) * h;
      hh[i] += hv[i] * h;
    }
    if (Math.random() < 0.5) hv[(Math.random() * N) | 0] += rnd(-1, 1) * (1.2 + this.cpu * 0.08);
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, t: number, dt: number) {
    for (this.acc += dt; this.acc >= 1 / 120; this.acc -= 1 / 120) this.step(1 / 120);
    const r = Math.min(w * 0.44, (h - 2) * 0.4), cx = w / 2, cy = h - r - 1;
    const nw = r * 0.36, a = Math.asin(nw / r), full = cy - r * Math.cos(a), bottom = cy + r;
    const path = new Path2D();
    path.moveTo(cx + nw, Math.max(0.5, cy - r * 1.75));
    path.lineTo(cx + nw, full);
    path.arc(cx, cy, r, -Math.PI / 2 + a, (3 * Math.PI) / 2 - a);
    path.lineTo(cx - nw, Math.max(0.5, cy - r * 1.75));
    path.closePath();

    const col = ramp(HEAT, this.level);
    const y0 = bottom - clamp(this.level, -0.02, 1.06) * (bottom - full);
    const tilt = clamp(this.levelV * 0.9, -0.35, 0.35) + Math.sin(t * 1.3) * 0.03;
    const x0 = cx - r, stepX = (2 * r) / (this.N - 1);
    const surf = (i: number, extra = 0) => y0 + this.hh[i] + tilt * (x0 + i * stepX - cx) + extra;
    const fluid = (extra: (i: number) => number) => {
      g.beginPath();
      g.moveTo(x0, bottom + 1);
      for (let i = 0; i < this.N; i++) g.lineTo(x0 + i * stepX, surf(i, extra(i)));
      g.lineTo(x0 + 2 * r, bottom + 1);
      g.closePath();
    };

    g.save();
    g.clip(path);
    fluid((i) => Math.sin(t * 2.1 + i * 0.45) * 0.7 - 0.8);
    g.fillStyle = css(col, 0.3);
    g.fill();
    fluid(() => 0);
    const fg = g.createLinearGradient(0, y0, 0, bottom);
    fg.addColorStop(0, css(col, 0.95));
    fg.addColorStop(1, css(col, 0.45));
    g.fillStyle = fg;
    g.fill();
    // bright surface
    g.beginPath();
    for (let i = 0; i < this.N; i++) g.lineTo(x0 + i * stepX, surf(i));
    g.strokeStyle = css(toWhite(col, 0.55));
    g.lineWidth = 1;
    g.stroke();
    // bubbles + splash droplets as single bright LEDs
    if (Math.random() < dt * (0.8 + this.cpu * 0.05)) this.bubbles.push({ x: cx + rnd(-0.6, 0.6) * r, y: bottom - 1, v: rnd(5, 12) });
    g.fillStyle = 'rgba(255,255,255,0.85)';
    this.bubbles = this.bubbles.filter((b) => {
      b.y -= b.v * dt;
      if (b.y < y0) return false;
      g.fillRect(Math.round(b.x + Math.sin(t * 5 + b.y)), Math.round(b.y), 1, 1);
      return true;
    });
    for (; this.pendingDrops > 0; this.pendingDrops--) this.drops.push({ x: cx + rnd(-0.6, 0.6) * r, y: y0, vx: rnd(-10, 10), vy: rnd(-36, -15) });
    g.fillStyle = css(toWhite(col, 0.4));
    this.drops = this.drops.filter((d) => {
      d.vy += 105 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.vy > 0 && d.y > y0) return false;
      g.fillRect(Math.round(d.x), Math.round(d.y), 1, 1);
      return true;
    });
    g.restore();
    g.strokeStyle = LED.dim;
    g.lineWidth = 1;
    g.stroke(path);
  }
}

// ======================================================================
// Hexagonal Neural Lattice — RAM as glowing honeycomb cells
// ======================================================================
export class Hex implements Layer {
  private cells: { x: number; y: number; b: number; f: number }[] = [];
  private r = 2;
  private front = 0;
  private target = 0;
  private built = '';

  set(pct: number) {
    this.target = clamp(pct / 100, 0, 1);
  }

  private build(w: number, h: number) {
    const r = (this.r = Math.max(1.8, Math.min(w, h) / 8.5));
    const dx = r * Math.sqrt(3), dy = r * 1.5, cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 0.5;
    const cells: Hex['cells'] = [];
    for (let row = -12; row <= 12; row++)
      for (let col = -12; col <= 12; col++) {
        const x = cx + col * dx + (row & 1 ? dx / 2 : 0), y = cy + row * dy;
        if (Math.hypot(x - cx, y - cy) <= R - r * 0.6) cells.push({ x, y, b: 0, f: 0 });
      }
    cells.sort((a, b) => b.y - a.y || Math.abs(a.x - cx) - Math.abs(b.x - cx)); // fill bottom-up, centre-out
    this.cells = cells;
    this.built = `${w}x${h}`;
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, t: number, dt: number) {
    if (this.built !== `${w}x${h}`) this.build(w, h);
    const cells = this.cells, N = cells.length;
    const d = this.target * N - this.front;
    this.front += Math.sign(d) * Math.min(Math.abs(d), dt * 18); // cascade one cell at a time
    if (Math.random() < dt * 2.5 && this.front >= 1) cells[(Math.random() * Math.floor(this.front)) | 0].f = 1; // synapse flash
    const r = this.r * 0.8;
    for (let i = 0; i < N; i++) {
      const c = cells[i], on = clamp(this.front - i, 0, 1);
      c.b += (on - c.b) * Math.min(1, dt * 7);
      c.f = Math.max(0, c.f - dt * 1.6);
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3 + Math.PI / 6;
        g.lineTo(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
      }
      g.closePath();
      if (c.b > 0.08) {
        const pulse = 0.75 + 0.25 * Math.sin(t * 2.6 - i * 0.4);
        g.fillStyle = css(toWhite(ramp(HEAT, i / N), c.f * 0.7), Math.min(1, c.b * pulse + c.f * 0.3));
      } else g.fillStyle = 'rgba(158,220,255,0.1)';
      g.fill();
    }
  }
}

// ======================================================================
// Thermal Heartbeat — oscilloscope trace (falls back to CPU load)
// ======================================================================
export class Spark implements Layer {
  private buf: number[] = [];
  private at = 0;
  private readonly cap = 60;
  temp = true;

  push(v: number, isTemp: boolean) {
    if (isTemp !== this.temp) this.buf = [];
    this.temp = isTemp;
    this.buf.push(v);
    if (this.buf.length > this.cap) this.buf.shift();
    this.at = performance.now();
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, t: number) {
    const [lo, hi, thr] = this.temp ? [30, 100, T.hotC] : [0, 100, 85];
    const Y = (v: number) => h - 1.5 - clamp((v - lo) / (hi - lo), 0, 1) * (h - 3);
    g.setLineDash([1, 2]);
    g.strokeStyle = 'rgba(255,59,92,0.5)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, Math.round(Y(thr)) + 0.5);
    g.lineTo(w, Math.round(Y(thr)) + 0.5);
    g.stroke();
    g.setLineDash([]);

    const b = this.buf, n = b.length;
    if (n < 2) return;
    const step = (w - 3) / (this.cap - 2);
    const frac = clamp((performance.now() - this.at) / 1000, 0, 1);
    const X = (i: number) => w - 2 - (n - 1 - i + frac) * step;
    const norm = clamp((b[n - 1] - (thr - 40)) / 45, 0, 1);
    const col = ramp([LED.cool, LED.amber, LED.red], norm);

    g.beginPath();
    for (let i = 0; i < n; i++) g.lineTo(X(i), Y(b[i]));
    g.lineTo(X(n - 1), h);
    g.lineTo(X(0), h);
    g.fillStyle = css(col, 0.18);
    g.fill();
    g.beginPath();
    for (let i = 0; i < n; i++) g.lineTo(X(i), Y(b[i]));
    g.strokeStyle = css(col);
    g.stroke();
    g.fillStyle = LED.red;
    for (let i = 0; i < n; i++) if (b[i] > thr) g.fillRect(Math.round(X(i)), Math.round(Y(b[i])) - 1, 1, 1);
    // heartbeat head, beats faster when hotter
    const beat = Math.exp(-((t * (0.9 + norm * 1.8)) % 1) * 5);
    const hx = X(n - 1), hy = Y(b[n - 1]);
    g.fillStyle = css(toWhite(col, 0.6));
    g.fillRect(Math.round(hx) - 1, Math.round(hy) - 1, 2, 2);
    g.strokeStyle = css(col, beat);
    g.beginPath();
    g.arc(hx, hy, 1.5 + (1 - beat) * 3, 0, Math.PI * 2);
    g.stroke();
  }
}

// ======================================================================
// Comic-bubble quips
// ======================================================================
/** Lines for reactions that have something to say about themselves. */
const ACT_LINES: Record<string, string[]> = {
  dizzy: ['Whoa… the room is spinning.', 'Too… many… pokes…'],
  grumpy: ['Okay, okay! I get it.', 'Personal space, please.', 'Hmph.'],
  love: ['Aww, you like me?', 'Right back at you!'],
  shy: ['Hehe, stop it…', "Don't look at me like that!"],
  flip: ['Wheee!', 'Ten out of ten landing.'],
  tongue: ['Bleh!', 'Gotcha!'],
  starstruck: ['Ooh, shiny!', 'You poked a star.'],
  surprise: ['Eep!', 'Oh! Hi!'],
};

/** What the bot says after an interaction; empty when its screen already says it (stat card). */
export function quip(s: Sample | null, mood: Mood, act?: string): string {
  const pick = (a: string[]) => a[(Math.random() * a.length) | 0];
  if (act === 'stat') return '';
  if (act && ACT_LINES[act] && Math.random() < 0.8) return pick(ACT_LINES[act]);
  if (!s) return 'Booting my sensors… gimme a sec.';
  const mp = memPct(s), hc = s.topCpu[0], hm = s.topMem[0];
  const short = (n: string) => (n.length > 18 ? n.slice(0, 17) + '…' : n);
  const browser = hm && /chrome|firefox|edge|brave|safari|opera|vivaldi|arc/i.exec(hm.name);
  const hot: string[] = [];
  if (s.temp != null && s.temp > T.hotC) hot.push(`${s.temp.toFixed(0)}°C in here. I am literally melting.`);
  if (hc && hc.cpu > 40) hot.push(`${short(hc.name)} is chewing ${hc.cpu.toFixed(0)}% of my brain cells!`);
  if (browser && mp > 60) hot.push(`${browser[0][0].toUpperCase() + browser[0].slice(1).toLowerCase()} is eating all your memory again!`);
  if (mp > 90) hot.push(`RAM at ${mp.toFixed(0)}%. I can't remember things anymore…`);
  if (s.battery && !s.battery.charging && s.battery.pct < 20) hot.push(`Battery ${s.battery.pct.toFixed(0)}%… feed me a charger.`);
  if (hot.length) return pick(hot);
  const cpu = s.cpu.toFixed(0);
  return pick(
    {
      chill: [`CPU at ${cpu}%? I'm basically on vacation.`, 'All quiet. Mind if I nap?', 'Hey! That tickles.', `Zzz… ${mp.toFixed(0)}% RAM… zzz…`],
      workout: [`Feeling the burn! ${cpu}% and climbing.`, 'Reps! Reps! Reps!', hm ? `${short(hm.name)} is my heaviest lift today.` : 'Lifting bits, crushing bytes.'],
      meltdown: ['EVERYTHING IS FINE. (it is not.)', `${cpu}% CPU! Who turned up the heat?!`, 'Venting steam! Close something, please!'],
    }[mood],
  );
}
