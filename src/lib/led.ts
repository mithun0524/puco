// LED dot-matrix renderer — the visual language of the bot's screen, reused by the
// glass gauges and the island. Paint at matrix resolution on `g`, then `present`
// lights each cell as a pill-shaped LED with a soft bloom.

import type { Layer } from './engine';

/** 3×5 pixel font: 5 rows of 3 bits per glyph. */
const FONT: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [7, 1, 7, 4, 7], '3': [7, 1, 7, 1, 7], '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7], '6': [7, 4, 7, 5, 7], '7': [7, 1, 1, 1, 1], '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 7],
  '%': [5, 1, 2, 4, 5], '°': [7, 5, 7, 0, 0], '-': [0, 0, 7, 0, 0], '.': [0, 0, 0, 0, 2], ' ': [0, 0, 0, 0, 0],
  '⚡': [1, 2, 7, 2, 4], '✓': [0, 1, 1, 5, 2],
};

/** Draw text in the pixel font; returns its width in cells. */
export function ledText(g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, scale = 1) {
  g.fillStyle = color;
  let cx = x;
  for (const ch of text) {
    const rows = FONT[ch] ?? FONT[' '];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if ((rows[r] >> (2 - c)) & 1) g.fillRect(cx + c * scale, y + r * scale, scale, scale);
    cx += 4 * scale;
  }
  return cx - x - scale;
}

export class Led {
  readonly low = document.createElement('canvas');
  readonly g: CanvasRenderingContext2D;

  constructor(public cols: number, public rows: number) {
    this.low.width = cols;
    this.low.height = rows;
    this.g = this.low.getContext('2d', { willReadFrequently: true })!;
  }

  resize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;
    this.low.width = this.cols = cols;
    this.low.height = this.rows = rows;
  }

  /** Light the matrix onto `out` (w×h CSS px). Transparent cells show as faint unlit LEDs. */
  present(out: CanvasRenderingContext2D, w: number, h: number, bloom = 0.75) {
    const { cols, rows } = this, cw = w / cols, ch = h / rows;
    const px = this.g.getImageData(0, 0, cols, rows).data;
    if (bloom) {
      out.save();
      out.globalCompositeOperation = 'lighter';
      out.globalAlpha = bloom;
      out.filter = `blur(${(cw * 1.5).toFixed(1)}px)`;
      out.drawImage(this.low, 0, 0, w, h);
      out.restore();
    }
    const dw = cw * 0.76, dh = ch * 0.62, ox = (cw - dw) / 2, oy = (ch - dh) / 2;
    out.beginPath();
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 4, a = px[i + 3] / 255;
        if (a < 0.06) {
          out.rect(x * cw + ox, y * ch + oy, dw, dh);
          continue;
        }
        // hot white core, tinted edge
        out.fillStyle = `rgba(${(px[i] + 64) >> 0},${(px[i + 1] + 64) >> 0},${(px[i + 2] + 64) >> 0},${a})`;
        out.fillRect(x * cw + ox, y * ch + oy, dw, dh);
      }
    out.fillStyle = 'rgba(150,185,235,0.07)';
    out.fill();
  }
}

/** Runs any Layer at LED resolution and lights it. `split` reserves a left fraction for `overlay` (e.g. digits). */
export class LedLayer implements Layer {
  private led = new Led(1, 1);
  overlay?: (g: CanvasRenderingContext2D, cols: number, rows: number) => void;

  constructor(private inner: Layer, private cell = 4, private split = 0) {}

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, dt: number) {
    const cols = Math.floor(w / this.cell), rows = Math.floor(h / this.cell), g = this.led.g;
    this.led.resize(cols, rows);
    g.clearRect(0, 0, cols, rows);
    const off = Math.round(cols * this.split);
    g.save();
    g.translate(off, 0);
    this.inner.draw(g, cols - off, rows, t, dt);
    g.restore();
    this.overlay?.(g, cols, rows);
    this.led.present(ctx, w, h);
  }
}
