// Mirror glass without a second render pass. The wing mirrors (Optimus), the
// Metro's camera-monitor screens and the driver's interior convex mirror all
// sample one shared canvas holding painted "reflections": the bus's own flank
// in its livery receding to the rear (perspective-correct, from the mirror's
// position), the road with lane dashes that stream past with the distance
// driven, sky or night, and the lit saloon for the interior mirror. The cab
// repaints it a dozen times a second while moving (cab.ts); the glass quads
// are one draw call on the bus and one in the cab.
import * as THREE from 'three';
import type { BusType, Route } from '../types';
import type { BodyLayout, SectionLayout } from './spec';
import { C, liveryFor, type LiveryId } from './livery';
import { mirrorFrame, mirrorHeads } from './parts';
import { GeoBuilder, canvasTexture, makeCanvas, rgb } from './util';

type Reg = { x: number; y: number; w: number; h: number };
type Ctx = CanvasRenderingContext2D;

export const MIR = { w: 512, h: 256 };
/** Kerb-side wing mirror / left camera screen. */
export const M_LEFT: Reg = { x: 0, y: 0, w: 128, h: 256 };
/** Driver's-side wing mirror / right camera screen. */
export const M_RIGHT: Reg = { x: 128, y: 0, w: 128, h: 256 };
/** Interior convex mirror (saloon). */
export const M_INT: Reg = { x: 256, y: 0, w: 256, h: 112 };

export function mirrorUV(r: Reg): [number, number, number, number] {
  return [r.x / MIR.w, 1 - (r.y + r.h) / MIR.h, (r.x + r.w) / MIR.w, 1 - r.y / MIR.h];
}

interface Flank {
  /** Colour bands from the skirt up: [height above the road at the top of the band, colour]. */
  bands: [number, string][];
  /** Window band (sill, top) and window glass colour. */
  win: [number, number];
  length: number;
  /** Bellows (Metro) as [start, end] metres behind the nose. */
  joints: [number, number][];
  axles: number[];
  dots?: string;
}

function flankFor(type: BusType, id: LiveryId): Flank {
  if (type === 'metro')
    return {
      bands: [[0.6, '#e9ebee'], [0.72, C.metroBlue], [2.82, C.metroBody], [2.88, C.metroGold], [3.12, '#e9ebee']],
      win: [0.85, 2.75],
      length: 24.7,
      joints: [[9.9, 10.5], [17.1, 17.7]],
      axles: [2.65, 8.6, 15.9, 21.8],
      dots: C.metroGold,
    };
  const opt = (bands: [number, string][]): Flank => ({ bands, win: [1.12, 2.55], length: 12.5, joints: [], axles: [2.7, 8.8] });
  switch (id) {
    case 'glider-blue':
      return opt([[0.75, C.gliderDeep], [1.1, C.gliderSky], [2.55, C.gliderSilver], [3.02, C.gliderDeep]]);
    case 'glider-maroon':
      return opt([[0.55, '#f5f5f7'], [2.55, C.maroon], [3.02, C.maroonDark]]);
    case 'cityloop':
      return opt([[0.4, '#2a50cf'], [3.02, C.loopPurple]]);
    case 'contract':
      return opt([[2.55, C.contractBlue], [3.02, '#f1f3f5']]);
    default:
      return opt([[0.82, C.btBlue], [3.02, C.white]]);
  }
}

let shared: { ctx: Ctx; tex: THREE.CanvasTexture } | null = null;

/** The shared reflection texture (module-level, never dispose). */
export function mirrorTexture(): THREE.CanvasTexture {
  if (!shared) {
    const { canvas, ctx } = makeCanvas(MIR.w, MIR.h);
    shared = { ctx, tex: canvasTexture(canvas, true, false) };
    paintMirrors({ type: 'rigid', route: '', dist: 0, night: false });
  }
  return shared.tex;
}

export interface MirrorView {
  type: BusType;
  route: string;
  /** Metres driven (moves the lane dashes). */
  dist: number;
  night: boolean;
}

export function paintMirrors(v: MirrorView): void {
  if (!shared) {
    mirrorTexture();
    if (!shared) return;
  }
  const c = shared.ctx;
  const id = liveryFor(v.type, v.route ? ({ id: v.route } as Route) : undefined);
  const fl = flankFor(v.type, id);
  wing(c, M_LEFT, -1, fl, v);
  wing(c, M_RIGHT, 1, fl, v);
  saloon(c, M_INT, v);
  shared.tex.needsUpdate = true;
}

function poly(c: Ctx, pts: [number, number][], fill: string | CanvasGradient): void {
  c.beginPath();
  pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
  c.fillStyle = fill;
  c.fill();
}

/**
 * Rear view along one side of the bus, as the glass shows it to the driver
 * (bus side toward the middle of the windscreen). X: metres from the mirror
 * toward the bus, y: height above the road, z: metres behind the mirror.
 */
function wing(c: Ctx, r: Reg, side: 1 | -1, fl: Flank, v: MirrorView): void {
  const W = r.w, H = r.h;
  const inner = side < 0 ? 1 : -1;
  const camH = v.type === 'metro' ? 2.8 : side < 0 ? 2.22 : 1.62;
  const f = W * 2.2;
  const vx = W / 2 + inner * W * 0.24;
  const vy = H * (v.type === 'metro' ? 0.4 : 0.45);
  const P = (X: number, y: number, z: number): [number, number] => [vx + (inner * f * X) / z, vy - (f * (y - camH)) / z];
  const night = v.night;
  c.save();
  c.translate(r.x, r.y);
  c.beginPath();
  c.rect(0, 0, W, H);
  c.clip();
  // sky
  const sky = c.createLinearGradient(0, 0, 0, vy);
  sky.addColorStop(0, night ? '#04060b' : '#5d8fcf');
  sky.addColorStop(1, night ? '#161b27' : '#c9dcec');
  c.fillStyle = sky;
  c.fillRect(0, 0, W, vy + 1);
  // skyline / trees on the outer side
  let k = side < 0 ? 11 : 29;
  for (let x = 0; x < W; ) {
    k = (k * 9301 + 49297) % 233280;
    const w = 4 + (k % 9);
    const h = 3 + ((k >> 4) % 14);
    const tree = k % 3 === 0;
    c.fillStyle = night ? (k % 5 === 0 ? '#5a5030' : '#0d1018') : tree ? '#5f7650' : `rgb(${150 + (k % 40)},${158 + (k % 30)},${168 + (k % 24)})`;
    c.fillRect(x, vy - h, w, h + 1);
    x += w;
  }
  // road and verge
  const road = c.createLinearGradient(0, vy, 0, H);
  road.addColorStop(0, night ? '#15161a' : '#7a7d82');
  road.addColorStop(1, night ? '#0b0c0e' : '#46494e');
  c.fillStyle = road;
  c.fillRect(0, vy, W, H - vy);
  const zs = [1.2, 120];
  if (side < 0) {
    // kerb, then footpath and grass beyond
    const kerb = -0.5;
    poly(c, [P(kerb, 0, zs[0]), P(kerb, 0, zs[1]), P(-30, 0, zs[1]), P(-30, 0, zs[0])], night ? '#1a1b1c' : '#a5a198');
    poly(c, [P(kerb - 2.4, 0, zs[0]), P(kerb - 2.4, 0, zs[1]), P(-40, 0, zs[1]), P(-40, 0, zs[0])], night ? '#0f130e' : '#6f8a4e');
    poly(c, [P(kerb, 0, zs[0]), P(kerb, 0, zs[1]), P(kerb - 0.15, 0.15, zs[1]), P(kerb - 0.15, 0.15, zs[0])], night ? '#2a2b2c' : '#d2cec4');
  } else {
    // dashed lane line streaming past, then the next lane's edge line
    const lx = -0.85;
    const ph = ((v.dist % 12) + 12) % 12;
    const paint = night ? '#6b6e72' : '#eceef0';
    for (let z0 = -ph; z0 < 120; z0 += 12) {
      const a = Math.max(zs[0], z0), b = Math.max(zs[0], z0 + 3);
      if (b <= a) continue;
      poly(c, [P(lx + 0.06, 0, a), P(lx + 0.06, 0, b), P(lx - 0.06, 0, b), P(lx - 0.06, 0, a)], paint);
    }
    poly(c, [P(lx - 3.4, 0, zs[0]), P(lx - 3.4, 0, zs[1]), P(lx - 3.55, 0, zs[1]), P(lx - 3.55, 0, zs[0])], night ? '#55585c' : '#e8eaec');
  }
  // our own bus: flank, windows, bellows, wheels
  const X = 0.19;
  const z0 = 0.35, z1 = fl.length + 0.1;
  let y0 = 0.3;
  for (const [y1, col] of fl.bands) {
    poly(c, [P(X, y0, z0), P(X, y0, z1), P(X, y1, z1), P(X, y1, z0)], night ? shade(col, 0.22) : col);
    y0 = y1;
  }
  const [ws, wt] = fl.win;
  const glass = c.createLinearGradient(0, 0, 0, H);
  glass.addColorStop(0, night ? '#c7b98f' : '#3d4a5a');
  glass.addColorStop(1, night ? '#8f8466' : '#0d1219');
  poly(c, [P(X + 0.004, ws, z0 + 1.2), P(X + 0.004, ws, z1 - 0.4), P(X + 0.004, wt, z1 - 0.4), P(X + 0.004, wt, z0 + 1.2)], glass);
  c.strokeStyle = night ? '#2a2620' : '#0b0d10';
  for (let z = z0 + 1.2; z < z1 - 0.4; z += 1.9) {
    const [ax, ay] = P(X + 0.006, ws, z);
    const [bx, by] = P(X + 0.006, wt, z);
    c.lineWidth = Math.max(0.6, (f * 0.07) / z);
    c.beginPath();
    c.moveTo(ax, ay);
    c.lineTo(bx, by);
    c.stroke();
  }
  if (fl.dots) {
    c.fillStyle = fl.dots;
    for (let z = z0 + 0.6; z < z1; z += 0.18) {
      const [px, py] = P(X + 0.008, 1.78 + 0.42 * Math.sin((z / 2.7) * Math.PI * 2), z);
      const rr = Math.max(0.35, (f * 0.022) / z);
      c.fillRect(px - rr, py - rr, rr * 2, rr * 2);
    }
  }
  for (const [a, b] of fl.joints) {
    poly(c, [P(X - 0.05, 0.34, a), P(X - 0.05, 0.34, b), P(X - 0.05, 3.0, b), P(X - 0.05, 3.0, a)], night ? '#2b2c2e' : '#a8adb3');
    c.strokeStyle = night ? '#18191b' : '#6c7178';
    c.lineWidth = 0.7;
    for (let z = a; z < b; z += 0.1) {
      const [ax, ay] = P(X - 0.04, 0.4, z);
      const [bx, by] = P(X - 0.04, 2.95, z);
      c.beginPath();
      c.moveTo(ax, ay);
      c.lineTo(bx, by);
      c.stroke();
    }
  }
  for (const az of fl.axles) {
    const arch: [number, number][] = [];
    for (let i = 0; i <= 10; i++) {
      const t = (i / 10) * Math.PI;
      arch.push(P(X + 0.002, 0.5 + 0.62 * Math.sin(t), az + 0.66 * Math.cos(t)));
    }
    poly(c, arch, night ? '#050506' : '#121315');
    const tyre: [number, number][] = [];
    const hub: [number, number][] = [];
    for (let i = 0; i < 14; i++) {
      const t = (i / 14) * Math.PI * 2;
      tyre.push(P(X - 0.02, 0.5 + 0.5 * Math.sin(t), az + 0.5 * Math.cos(t)));
      hub.push(P(X - 0.03, 0.5 + 0.27 * Math.sin(t), az + 0.27 * Math.cos(t)));
    }
    poly(c, tyre, '#0c0c0d');
    poly(c, hub, night ? '#2a2c30' : '#8d939a');
  }
  // glass sheen, dark edge
  const sheen = c.createLinearGradient(0, 0, W, H);
  sheen.addColorStop(0, 'rgba(255,255,255,0.10)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.12)');
  c.fillStyle = sheen;
  c.fillRect(0, 0, W, H);
  if (v.type === 'metro') {
    // camera monitor overlay: distance guide marks on the bus side, side tag
    const gx = (z: number) => P(X - 0.25, 0, z);
    for (const [z, col] of [[4, '#e0362b'], [9, '#f2c200'], [16, '#3cc35a']] as [number, string][]) {
      const [x, y] = gx(z);
      c.fillStyle = col;
      c.fillRect(Math.min(x, x - inner * 18), y - 1, 18, 2);
    }
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(side < 0 ? 4 : W - 22, 4, 18, 13);
    c.fillStyle = '#e8edf3';
    c.font = 'bold 10px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(side < 0 ? 'L' : 'R', side < 0 ? 13 : W - 13, 11);
  } else {
    c.strokeStyle = 'rgba(0,0,0,0.6)';
    c.lineWidth = 3;
    c.strokeRect(0, 0, W, H);
  }
  c.restore();
}

/** Looking back down the lit saloon (convex: wide angle). */
function saloon(c: Ctx, r: Reg, v: MirrorView): void {
  const W = r.w, H = r.h;
  const metro = v.type === 'metro';
  const len = metro ? 22 : 11.5;
  const f = 70;
  const vx = W / 2, vy = H * 0.42;
  const camY = 2.3;
  const P = (X: number, y: number, z: number): [number, number] => [vx + (f * X) / z, vy - (f * (y - camY)) / z];
  const hw = 1.17, fl = 0.36, ce = metro ? 2.8 : 2.7;
  const zn = 0.7;
  c.save();
  c.translate(r.x, r.y);
  c.beginPath();
  c.rect(0, 0, W, H);
  c.clip();
  // rear wall and window
  c.fillStyle = '#c3c7cc';
  c.fillRect(0, 0, W, H);
  poly(c, [P(-0.9, 1.95, len), P(0.9, 1.95, len), P(0.9, 2.65, len), P(-0.9, 2.65, len)], v.night ? '#0a0d13' : '#cfe2f2');
  // ceiling, floor
  poly(c, [P(-hw, ce, zn), P(hw, ce, zn), P(hw, ce, len), P(-hw, ce, len)], v.night ? '#eef1f4' : '#dfe3e7');
  poly(c, [P(-hw, fl, zn), P(hw, fl, zn), P(hw, fl, len), P(-hw, fl, len)], '#3a3d42');
  poly(c, [P(-0.05, fl + 0.002, zn), P(0.05, fl + 0.002, zn), P(0.05, fl + 0.002, len), P(-0.05, fl + 0.002, len)], '#e2b400');
  for (const s of [-1, 1]) {
    // wall, window band, LED strip
    poly(c, [P(s * hw, fl, zn), P(s * hw, fl, len), P(s * hw, ce, len), P(s * hw, ce, zn)], '#aeb3b9');
    poly(c, [P(s * hw, 1.12, zn), P(s * hw, 1.12, len), P(s * hw, 2.55, len), P(s * hw, 2.55, zn)], v.night ? '#0d1118' : '#9fc0dc');
    poly(c, [P(s * 0.8, ce - 0.01, zn), P(s * 0.86, ce - 0.01, zn), P(s * 0.86, ce - 0.01, len), P(s * 0.8, ce - 0.01, len)], '#ffffff');
  }
  // seats from the back forward (painter's order), poles, a few heads
  let k = 5;
  for (let z = len - 0.8; z > 1.6; z -= 0.78) {
    for (const s of [-1, 1]) {
      const [ax, ay] = P(s * 0.3, 1.38, z);
      const [bx, by] = P(s * 1.1, 0.75, z);
      c.fillStyle = '#21409a';
      c.fillRect(Math.min(ax, bx), ay, Math.abs(bx - ax), by - ay);
      c.fillStyle = '#4f86d8';
      c.fillRect(Math.min(ax, bx), ay + (by - ay) * 0.35, Math.abs(bx - ax), Math.max(0.5, (by - ay) * 0.08));
      k = (k * 9301 + 49297) % 233280;
      if (k % 4 === 0) {
        const [hx, hy] = P(s * (0.5 + (k % 3) * 0.2), 1.55, z + 0.3);
        c.fillStyle = k % 8 === 0 ? '#c8a07a' : '#2a2018';
        c.beginPath();
        c.arc(hx, hy, Math.max(0.8, (f * 0.11) / z), 0, Math.PI * 2);
        c.fill();
      }
    }
    if (Math.round(z / 0.78) % 2 === 0)
      for (const s of [-1, 1]) {
        const [ax, ay] = P(s * 0.25, fl, z);
        const [, by] = P(s * 0.25, ce, z);
        c.strokeStyle = '#f2c300';
        c.lineWidth = Math.max(0.7, (f * 0.04) / z);
        c.beginPath();
        c.moveTo(ax, ay);
        c.lineTo(ax, by);
        c.stroke();
      }
  }
  const sheen = c.createLinearGradient(0, 0, 0, H);
  sheen.addColorStop(0, 'rgba(255,255,255,0.12)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.18)');
  c.fillStyle = sheen;
  c.fillRect(0, 0, W, H);
  c.restore();
}

function shade(hex: string, k: number): string {
  const col = new THREE.Color(hex);
  col.multiplyScalar(k);
  return `#${col.getHexString()}`;
}

/** Glass quads for the wing mirrors (section-local; Metro has none). */
export function mirrorGlassGeometry(B: BodyLayout, sec: SectionLayout): THREE.BufferGeometry | null {
  const gb = new GeoBuilder();
  const white = rgb('#ffffff');
  for (const m of mirrorHeads(B, sec)) {
    if (m.kind !== 'wing') continue;
    const F = mirrorFrame(m);
    const hx = m.w / 2, hy = m.h / 2, z = m.d / 2 + 0.003;
    const p = [new THREE.Vector3(-hx, -hy, z), new THREE.Vector3(hx, -hy, z), new THREE.Vector3(hx, hy, z), new THREE.Vector3(-hx, hy, z)].map((q) => q.applyMatrix4(F));
    gb.quad(p[0], p[1], p[2], p[3], white, mirrorUV(m.side < 0 ? M_LEFT : M_RIGHT));
  }
  return gb.count ? gb.build() : null;
}
