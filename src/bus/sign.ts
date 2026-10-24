// LED dot-matrix destination signs. Text is rasterised at LED resolution,
// then every LED is drawn as a dot (lit / half-lit / unlit). One canvas holds
// the front, side and rear displays; textures are cached per sign text.
import * as THREE from 'three';
import type { DestinationSign } from '../types';
import { canvasTexture, makeCanvas } from './util';

const PITCH = 5;
const CW = 1024;
const CH = 256;

interface Panel {
  x: number;
  y: number;
  cols: number;
  rows: number;
}

const FRONT: Panel = { x: 12, y: 4, cols: 200, rows: 24 };
const SIDE: Panel = { x: 24, y: 132, cols: 144, rows: 24 };
const REAR: Panel = { x: 776, y: 132, cols: 48, rows: 24 };

function uvOf(p: Panel): [number, number, number, number] {
  const x0 = p.x, x1 = p.x + p.cols * PITCH;
  const y0 = p.y, y1 = p.y + p.rows * PITCH;
  return [x0 / CW, 1 - y1 / CH, x1 / CW, 1 - y0 / CH];
}

/** [u0, v0, u1, v1] for each display (v0 = bottom). */
export const SIGN_UV = { front: uvOf(FRONT), side: uvOf(SIDE), rear: uvOf(REAR) };

const FONT_LED = 'Arial, Helvetica, sans-serif';

function splitHeadsign(h: string): [string, string] | null {
  const via = h.search(/\s+via\s+/i);
  if (via > 0) return [h.slice(0, via), h.slice(via).trim()];
  const comma = h.indexOf(', ');
  if (comma > 0) return [h.slice(0, comma), h.slice(comma + 2)];
  const words = h.split(' ');
  if (words.length < 2) return null;
  let best = 1;
  let bestD = Infinity;
  for (let i = 1; i < words.length; i++) {
    const d = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

/** Rasterise a panel's text at LED resolution, returning per-LED brightness 0..1. */
function rasterise(panel: Panel, draw: (c: CanvasRenderingContext2D, cols: number, rows: number) => void): Float32Array {
  const { ctx } = makeCanvas(panel.cols, panel.rows);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, panel.cols, panel.rows);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  draw(ctx, panel.cols, panel.rows);
  const img = ctx.getImageData(0, 0, panel.cols, panel.rows).data;
  const out = new Float32Array(panel.cols * panel.rows);
  for (let i = 0; i < out.length; i++) out[i] = img[i * 4] / 255;
  return out;
}

/** Fit text into a box: condense horizontally if needed. Returns drawn width. */
function fitText(c: CanvasRenderingContext2D, text: string, x: number, baseline: number, size: number, maxW: number, align: 'left' | 'right' | 'center'): number {
  c.font = `bold ${size}px ${FONT_LED}`;
  const w = c.measureText(text).width;
  const k = Math.min(1, maxW / Math.max(1, w));
  c.save();
  const drawW = w * k;
  const x0 = align === 'left' ? x : align === 'right' ? x - drawW : x - drawW / 2;
  c.translate(x0, baseline);
  c.scale(k, 1);
  c.fillText(text, 0, 0);
  c.restore();
  return drawW;
}

function routeWidth(c: CanvasRenderingContext2D, route: string, size: number): number {
  c.font = `bold ${size}px ${FONT_LED}`;
  return c.measureText(route).width;
}

function drawDestination(c: CanvasRenderingContext2D, cols: number, rows: number, sign: DestinationSign, routeRight: boolean): void {
  const rSize = 23;
  const rw = Math.min(cols * 0.32, routeWidth(c, sign.route, rSize)) + 2;
  const textX0 = routeRight ? 2 : rw + 6;
  const textX1 = routeRight ? cols - rw - 6 : cols - 2;
  fitText(c, sign.route, routeRight ? cols - 1 : 1, rows - 2, rSize, cols * 0.32, routeRight ? 'right' : 'left');
  const avail = textX1 - textX0;
  const head = sign.headsign;
  c.font = `bold 16px ${FONT_LED}`;
  const single = c.measureText(head).width;
  const two = splitHeadsign(head);
  if (single <= avail * 1.05 || !two) {
    fitText(c, head, (textX0 + textX1) / 2, rows - 6, 16, avail, 'center');
  } else {
    fitText(c, two[0], (textX0 + textX1) / 2, 10, 11, avail, 'center');
    fitText(c, two[1], (textX0 + textX1) / 2, rows - 1, 11, avail, 'center');
  }
}

function paintLeds(ctx: CanvasRenderingContext2D, panel: Panel, b: Float32Array, on: string, half: string): void {
  const r = PITCH * 0.42;
  ctx.fillStyle = '#060606';
  ctx.fillRect(panel.x - 2, panel.y - 2, panel.cols * PITCH + 4, panel.rows * PITCH + 4);
  const byColor: [string, number][] = [['#181818', 0], [half, 1], [on, 2]];
  for (const [col, lvl] of byColor) {
    ctx.fillStyle = col;
    ctx.beginPath();
    for (let j = 0; j < panel.rows; j++) {
      for (let i = 0; i < panel.cols; i++) {
        const v = b[j * panel.cols + i];
        const l = v > 0.48 ? 2 : v > 0.2 ? 1 : 0;
        if (l !== lvl) continue;
        const x = panel.x + (i + 0.5) * PITCH;
        const y = panel.y + (j + 0.5) * PITCH;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }
}

export function renderSignCanvas(sign: DestinationSign, color: 'white' | 'amber'): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(CW, CH);
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, CW, CH);
  const on = color === 'amber' ? '#ffb000' : '#f4f7ff';
  const half = color === 'amber' ? '#7a5200' : '#70757f';
  paintLeds(ctx, FRONT, rasterise(FRONT, (c, w, h) => drawDestination(c, w, h, sign, true)), on, half);
  paintLeds(ctx, SIDE, rasterise(SIDE, (c, w, h) => drawDestination(c, w, h, sign, false)), on, half);
  paintLeds(
    ctx,
    REAR,
    rasterise(REAR, (c, w, h) => fitText(c, sign.route, w / 2, h - 2, 23, w - 2, 'center')),
    on,
    half,
  );
  return canvas;
}

const cache = new Map<string, THREE.MeshBasicMaterial>();

/** Shared, cached sign material (never dispose these). */
export function signMaterial(sign: DestinationSign, color: 'white' | 'amber'): THREE.MeshBasicMaterial {
  const key = `${color}|${sign.route}|${sign.headsign}`;
  let m = cache.get(key);
  if (!m) {
    const tex = canvasTexture(renderSignCanvas(sign, color));
    m = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    m.name = `sign:${key}`;
    cache.set(key, m);
  }
  return m;
}

const blank = new Map<string, THREE.MeshBasicMaterial>();

export function blankSignMaterial(color: 'white' | 'amber'): THREE.MeshBasicMaterial {
  let m = blank.get(color);
  if (!m) {
    m = signMaterial({ route: '', headsign: 'Not In Service' }, color);
    blank.set(color, m);
  }
  return m;
}
