// Tiny synthesised voice for Puco: no audio files, just short enveloped tones.
// Off until the user turns it on; the choice lives in localStorage, which both windows share.

const KEY = 'puco-sound';
const VOLUME = 0.12;

export const soundOn = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};
export const setSoundOn = (on: boolean) => {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {}
};

let ctx: AudioContext | null = null;
let out: GainNode | null = null;

function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    out = ctx.createGain();
    out.gain.value = VOLUME;
    out.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

type Tone = { f: number; to?: number; at?: number; dur: number; type?: OscillatorType; gain?: number; wobble?: number };

/** One note: frequency glide f → to, soft attack, exponential decay. */
function tone(c: AudioContext, { f, to = f, at = 0, dur, type = 'sine', gain = 1, wobble = 0 }: Tone) {
  const t0 = c.currentTime + at;
  const osc = c.createOscillator(), amp = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t0);
  osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  if (wobble) {
    const lfo = c.createOscillator(), depth = c.createGain();
    lfo.frequency.value = wobble;
    depth.gain.value = f * 0.06;
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(t0);
    lfo.stop(t0 + dur);
  }
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(amp).connect(out!);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

const N = { C5: 523, E5: 659, G5: 784, A5: 880, C6: 1047, E6: 1319, G6: 1568, A6: 1760, C7: 2093 };

const SOUNDS: Record<string, Tone[]> = {
  giggle: [0, 1, 2, 3].map((i) => ({ f: 720 + i * 60, to: 900 + i * 60, at: i * 0.075, dur: 0.07, type: 'triangle', gain: 0.8 })),
  love: [{ f: N.C6, at: 0, dur: 0.22, type: 'triangle' }, { f: N.E6, at: 0.12, dur: 0.4, type: 'triangle' }],
  surprise: [{ f: 380, to: 1100, dur: 0.18, type: 'triangle' }],
  startle: [{ f: 420, to: 1200, dur: 0.14, type: 'triangle', gain: 0.8 }],
  shy: [{ f: N.E6, at: 0, dur: 0.16, gain: 0.6 }, { f: N.C6, at: 0.12, dur: 0.28, gain: 0.5 }],
  stat: [{ f: N.A5, at: 0, dur: 0.07, type: 'square', gain: 0.25 }, { f: N.E6, at: 0.09, dur: 0.09, type: 'square', gain: 0.25 }],
  tongue: [{ f: 260, to: 520, dur: 0.12, type: 'triangle' }],
  starstruck: [N.C6, N.E6, N.G6, N.C7].map((f, i) => ({ f, at: i * 0.06, dur: 0.3, gain: 0.6 })),
  wave: [{ f: N.G5, at: 0, dur: 0.12, type: 'triangle' }, { f: N.C6, at: 0.1, dur: 0.22, type: 'triangle' }],
  spin: [{ f: 300, to: 900, dur: 0.35, gain: 0.7 }, { f: 900, to: 400, at: 0.33, dur: 0.3, gain: 0.5 }],
  dizzy: [{ f: 900, to: 380, dur: 0.9, type: 'triangle', gain: 0.6, wobble: 9 }],
  grumpy: [{ f: 196, to: 170, at: 0, dur: 0.14, type: 'sawtooth', gain: 0.22 }, { f: 160, to: 130, at: 0.16, dur: 0.22, type: 'sawtooth', gain: 0.22 }],
  flip: [{ f: 220, to: 760, dur: 0.32, type: 'triangle', wobble: 22 }],
  pet: [{ f: 95, to: 88, dur: 0.6, type: 'triangle', gain: 0.9, wobble: 24 }],
  curious: [{ f: 420, to: 640, dur: 0.24, type: 'triangle', gain: 0.7 }],
  // notch island heads-up: a soft two-note bell
  chime: [{ f: N.E6, at: 0, dur: 0.5, gain: 0.7 }, { f: N.A6, at: 0.14, dur: 0.8, gain: 0.6 }],
};

/** Play a named sound if sound is on. Unknown names stay silent. */
export function play(name: string) {
  const notes = SOUNDS[name];
  if (!notes || !soundOn()) return;
  const c = audio();
  for (const n of notes) tone(c, n);
}
