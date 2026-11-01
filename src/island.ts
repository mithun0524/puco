// Notch island. Two channels:
//  • glances  — good news / state changes: compact only (face + icon/value beside the camera), ~2.5 s.
//  • heads-ups — real problems: expand with the cause, then stay as a live compact indicator until the
//    problem clears; hover re-expands with one fix (quit the culprit) and Dismiss. Silence otherwise.
// The window is click-through except while the cursor is over the visible pill.

import '@fontsource-variable/recursive/full.css';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, cursorPosition } from '@tauri-apps/api/window';
import { Led, ledText } from './lib/led';
import { LED, fit, memPct, moodOf, type Mood, type Sample } from './lib/engine';

type Level = 'hot' | 'warn' | 'info';
type Kind = 'load' | 'mem' | 'battery' | 'intro';
type Glance = { level: Level; icon: string; value: () => string };
type HeadsUp = { kind: Kind; level: Level; title: () => string; body: () => string; fix?: () => { pid: number; name: string } | null };

const log = (msg: string) => invoke('island_log', { msg }).catch(() => {});
addEventListener('error', (e) => log(`error: ${e.message}`));
addEventListener('unhandledrejection', (e) => log(`rejection: ${e.reason}`));

const $ = (id: string) => document.getElementById(id)!;
const island = $('island'), titleEl = $('title'), bodyEl = $('body'), actions = $('actions');
const face = fit($('face') as HTMLCanvasElement), val = fit($('value') as HTMLCanvasElement);
const faceLed = new Led(16, 12), valLed = new Led(20, 7);
const TONE: Record<Level, string> = { hot: LED.red, warn: LED.amber, info: LED.cool };
const win = getCurrentWindow();
const short = (n: string) => (n.length > 18 ? n.slice(0, 17) + '…' : n);
const pct = (v: number) => `${Math.round(v)}%`;

let last: Sample | null = null;

// ---------- notch geometry ----------
invoke<{ width: number; height: number }>('notch')
  .then(({ width, height }) => {
    if (!width) return document.documentElement.classList.add('no-notch');
    const root = document.documentElement.style;
    root.setProperty('--nw', `${width}px`);
    root.setProperty('--nh', `${height}px`);
  })
  .catch(() => document.documentElement.classList.add('no-notch'));

// ---------- state ----------
const PRIORITY: Kind[] = ['load', 'mem', 'battery', 'intro'];
const stickies = new Map<Kind, HeadsUp>();
const dismissed = new Set<Kind>();
const glances: Glance[] = [];
let glance: Glance | null = null, glanceUntil = 0;
let openUntil = 0, hovering = false, armedPid: number | null = null, testUntil = 0;

const topSticky = () => PRIORITY.map((k) => stickies.get(k)).find(Boolean) ?? null;

function raise(h: HeadsUp) {
  if (dismissed.has(h.kind) || stickies.has(h.kind)) return;
  stickies.set(h.kind, h);
  if (topSticky() === h) openUntil = performance.now() + 6000; // announce, then settle into the live indicator
  invoke('island_front').catch(() => {}); // re-pin above full-screen apps / after display changes
}

/** Problem resolved: drop it and flash a quick ✓. */
function clear(kind: Kind) {
  dismissed.delete(kind);
  if (!stickies.delete(kind)) return;
  if (kind !== 'intro') glances.push({ level: 'info', icon: '✓', value: () => '' });
}

function addGlance(g: Glance) {
  glances.push(g);
  invoke('island_front').catch(() => {});
}

// ---------- render loop ----------
let shownKey = '';
function frame(now: number) {
  requestAnimationFrame(frame);
  if (glance && now > glanceUntil) glance = null;
  if (!glance && glances.length) (glance = glances.shift()!), (glanceUntil = now + 2600);
  const sticky = topSticky();
  const level: Level = glance?.level ?? sticky?.level ?? 'info';
  const visible = !!(glance || sticky);
  const open = !glance && !!sticky && (now < openUntil || hovering);

  // quick cross-fade whenever what we show changes
  const key = glance ? `g${glanceUntil}` : sticky ? `s${sticky.kind}` : '';
  if (key !== shownKey) {
    shownKey = key;
    island.classList.add('swap');
    setTimeout(() => island.classList.remove('swap'), 180);
  }
  island.style.setProperty('--tone', TONE[level]);
  island.classList.toggle('compact', visible);
  island.classList.toggle('open', open);
  island.classList.toggle('has-actions', open && !!sticky && sticky.kind !== 'intro');
  if (sticky && open) renderMessage(sticky);
  if (!visible) return;

  const t = now / 1000;
  faceLed.g.clearRect(0, 0, 16, 12);
  paintFace(faceLed.g, level, t);
  face.ctx.clearRect(0, 0, face.w, face.h);
  faceLed.present(face.ctx, face.w, face.h, 0.9);
  const text = glance ? glance.icon + glance.value() : liveValue(sticky!.kind);
  valLed.g.clearRect(0, 0, 20, 7);
  ledText(valLed.g, text, Math.max(0, 20 - (text.length * 4 - 1)), 1, TONE[level]);
  val.ctx.clearRect(0, 0, val.w, val.h);
  valLed.present(val.ctx, val.w, val.h, 0.9);
}
requestAnimationFrame(frame);

function liveValue(kind: Kind): string {
  if (!last) return '';
  if (kind === 'load') return last.temp != null && last.temp > 80 ? `${Math.round(last.temp)}°` : pct(last.cpu);
  if (kind === 'mem') return pct(memPct(last));
  if (kind === 'battery') return last.battery ? pct(last.battery.pct) : '';
  return '✓';
}

/** Mini robot face on a 16×12 LED grid. */
function paintFace(g: CanvasRenderingContext2D, level: Level, t: number) {
  g.fillStyle = TONE[level];
  const px = (x: number, y: number) => g.fillRect(x, y, 1, 1);
  const blink = t % 3.2 < 0.12;
  for (const ex of [4, 11]) {
    if (blink) for (let i = -1; i <= 1; i++) px(ex + i, 4);
    else if (level === 'hot') for (let i = -1; i <= 1; i++) px(ex + i, 4 + i), px(ex + i, 4 - i); // ✕
    else if (level === 'warn') g.fillRect(ex - 1, 3, 2, 3); // wide eyes
    else px(ex - 1, 5), px(ex, 4), px(ex + 1, 5); // ^
  }
  if (level === 'hot') for (let x = 5; x <= 10; x++) px(x, 9 - ((x + Math.floor(t * 8)) % 2));
  else if (level === 'warn') g.fillRect(6, 9, 4, 1);
  else px(5, 8), g.fillRect(6, 9, 4, 1), px(10, 8);
}

// ---------- message + actions (rebuilt only when the content changes) ----------
let msgKey = '';
function renderMessage(h: HeadsUp) {
  const fix = h.fix?.() ?? null;
  const key = `${h.title()}|${h.body()}|${fix?.pid}|${armedPid}`;
  if (key === msgKey) return;
  msgKey = key;
  titleEl.textContent = h.title();
  bodyEl.textContent = h.body();
  actions.replaceChildren();
  if (h.kind === 'intro') return;
  if (fix) {
    const b = button(armedPid === fix.pid ? 'Click again to quit' : `Quit ${short(fix.name)}`, 'primary', () => quit(fix));
    b.classList.toggle('armed', armedPid === fix.pid);
    actions.append(b);
  }
  actions.append(
    button('Dismiss', '', () => {
      dismissed.add(h.kind);
      stickies.delete(h.kind);
      hovering = false;
    }),
  );
}

function button(label: string, cls: string, onClick: () => void) {
  const b = document.createElement('button');
  b.className = `act ${cls}`;
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

async function quit(fix: { pid: number; name: string }) {
  if (armedPid !== fix.pid) {
    armedPid = fix.pid; // two-step confirm, same as the widget
    setTimeout(() => armedPid === fix.pid && (armedPid = null), 3000);
    return;
  }
  armedPid = null;
  try {
    await invoke('kill_process', { pid: fix.pid });
    bodyEl.textContent = `Quit ${fix.name}`;
  } catch (e) {
    bodyEl.textContent = `Couldn't quit ${fix.name}: ${e}`;
  }
}

// ---------- hit-testing: clickable only while the cursor is over the visible pill ----------
let ignoring = true, leftAt = 0;
setInterval(async () => {
  if (!island.classList.contains('compact')) {
    if (!ignoring) await win.setIgnoreCursorEvents((ignoring = true));
    hovering = false;
    return;
  }
  try {
    const [c, pos, scale] = await Promise.all([cursorPosition(), win.outerPosition(), win.scaleFactor()]);
    const r = island.getBoundingClientRect();
    const x = (c.x - pos.x) / scale, y = (c.y - pos.y) / scale;
    const inside = x >= r.left - 4 && x <= r.right + 4 && y >= r.top && y <= r.bottom + 4;
    if (inside === ignoring) await win.setIgnoreCursorEvents((ignoring = !inside));
    if (inside) (hovering = true), (leftAt = 0);
    else if (hovering && !leftAt) leftAt = performance.now();
    else if (hovering && performance.now() - leftAt > 500) hovering = false; // short grace before folding
  } catch (e) {
    log(`hit-test: ${e}`);
  }
}, 90);

// ---------- sources ----------
const LOAD: HeadsUp = {
  kind: 'load',
  level: 'hot',
  title: () => (last?.temp != null && last.temp > 80 ? 'Your Mac is running hot' : 'CPU has been maxed out'),
  body: () => (last?.topCpu[0] ? `${last.topCpu[0].name} is using ${pct(last.topCpu[0].cpu)}` : 'Something is working very hard'),
  fix: () => (last?.topCpu[0] ? { pid: last.topCpu[0].pid, name: last.topCpu[0].name } : null),
};
const MEM: HeadsUp = {
  kind: 'mem',
  level: 'hot',
  title: () => 'Memory is almost full',
  body: () => (last?.topMem[0] ? `${last.topMem[0].name} is using ${(last.topMem[0].mem / 1024 ** 3).toFixed(1)} GB` : 'Close something you are not using'),
  fix: () => (last?.topMem[0] ? { pid: last.topMem[0].pid, name: last.topMem[0].name } : null),
};
const BATTERY: HeadsUp = {
  kind: 'battery',
  level: 'warn',
  title: () => 'Battery is low',
  body: () => (last?.battery ? `${pct(last.battery.pct)} left. Plug in soon.` : 'Plug in soon.'),
};

// Rust alerts: problems become heads-ups; good news (fully charged) becomes a glance.
listen<{ kind: 'cpu' | 'mem' | 'battery'; level: Level }>('alert', ({ payload: a }) => {
  if (a.level === 'info') return addGlance({ level: 'info', icon: '✓', value: () => liveValue('battery') });
  raise(a.kind === 'cpu' ? LOAD : a.kind === 'mem' ? MEM : BATTERY);
});

// Telemetry: a sustained meltdown raises the load heads-up early; recovery clears problems.
let cand: Mood = 'chill', candN = 0, mood: Mood = 'chill', charging: boolean | null = null;
listen<Sample>('telemetry', ({ payload: s }) => {
  last = s;
  const m = moodOf(s);
  candN = m === cand ? candN + 1 : 1;
  cand = m;
  if (candN === 3 && m !== mood) {
    mood = m;
    if (m === 'meltdown' && s.cpu > 75) raise(LOAD);
  }
  if (stickies.has('load') && s.cpu < 70 && mood !== 'meltdown' && performance.now() > testUntil) clear('load');
  if (stickies.has('mem') && memPct(s) < 85) clear('mem');
  if (stickies.has('battery') && s.battery && (s.battery.charging || s.battery.pct > 25)) clear('battery');
  if (!stickies.has('load') && s.cpu < 70) dismissed.delete('load'); // re-arm after recovery
  if (!stickies.has('mem') && memPct(s) < 85) dismissed.delete('mem');

  const c = s.battery?.charging ?? null;
  if (charging !== null && c !== null && c !== charging)
    addGlance(c ? { level: 'info', icon: '⚡', value: () => liveValue('battery') } : { level: 'warn', icon: '', value: () => liveValue('battery') });
  charging = c;
});

// First run only: introduce the island once, then stay quiet until there's news.
try {
  if (!localStorage.getItem('puco-island-intro')) {
    localStorage.setItem('puco-island-intro', '1');
    raise({ kind: 'intro', level: 'info', title: () => 'Puco lives in your notch', body: () => 'It only speaks up when something needs you' });
    setTimeout(() => clear('intro'), 6500);
  }
} catch {}

// Tray → "Test the notch island": a realistic heads-up that clears itself.
listen('island-test', () => {
  dismissed.delete('load');
  testUntil = performance.now() + 14000;
  raise(LOAD);
  setTimeout(() => clear('load'), 14000);
});
