// Body shell geometry: horizontal rounded-rectangle rings stacked from the
// skirt to the roof (rake, tumblehome and roof shoulder vary with height),
// split into front / right / rear / left strips that map onto regions of a
// livery atlas canvas. One mesh, one material, one draw call per section.
import * as THREE from 'three';
import type { BodyLayout, SectionLayout } from './spec';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasLayout {
  cw: number;
  ch: number;
  left: Rect;
  right: Rect;
  front: Rect | null;
  rear: Rect | null;
  /** UV used for the roof cap (top row of the left strip is roof colour). */
  roof: [number, number];
  /** UV used for faces hidden inside bellows. */
  dark: [number, number];
}

/** Atlas layout for a section. scale 1 = 2048 px wide. */
export function atlasLayout(L: BodyLayout, sec: SectionLayout, scale: number): AtlasLayout {
  const cw = Math.round(2048 * scale);
  const sh = Math.round(512 * scale);
  const ends = sec.isFront || sec.isRear;
  const ch = ends ? cw : sh * 2;
  const sq = Math.round(1024 * scale);
  const left = { x: 0, y: 0, w: cw, h: sh };
  const right = { x: 0, y: sh, w: cw, h: sh };
  const front = sec.isFront ? { x: 0, y: sh * 2, w: sq, h: sq } : null;
  const rear = sec.isRear ? { x: sq, y: sh * 2, w: sq, h: sq } : null;
  const roof: [number, number] = [0.5, 1 - 1.5 / ch];
  // middle of the window band of the left strip
  const vWin = (L.yTop - (L.sill + L.winTop) / 2) / (L.yTop - L.y0);
  const dark: [number, number] = [0.5, 1 - (left.y + vWin * left.h) / ch];
  return { cw, ch, left, right, front, rear, roof, dark };
}

interface Ring {
  hw: number;
  zf: number;
  zr: number;
  rf: number;
  rr: number;
}

function shoulderInset(L: BodyLayout, y: number): number {
  const r = L.shoulder;
  const c = L.yTop - r;
  if (y <= c) return 0;
  const d = Math.min(r, y - c);
  return r - Math.sqrt(Math.max(0, r * r - d * d));
}

export function ringAt(L: BodyLayout, sec: SectionLayout, y: number): Ring {
  const sh = shoulderInset(L, y);
  const tuck = y < 0.36 ? (0.36 - y) * 0.6 : 0;
  const hw = L.hw - L.sideInset(y) - sh;
  const zf = sec.bodyFront + (sec.isFront ? L.frontInset(y) : tuck) + sh;
  const zr = sec.bodyRear - (sec.isRear ? L.rearInset(y) : tuck) - sh;
  // articulated ends get generous corner radii so bodies clear each other at ~40 deg
  const rf = Math.max(0.02, (sec.isFront ? L.frontRadius : 0.26) - sh * 0.85);
  const rr = Math.max(0.02, (sec.isRear ? L.rearRadius : 0.26) - sh * 0.85);
  return { hw, zf, zr, rf, rr };
}

/** One ring sample: plan position (x, z') and outward plan normal. */
type SampleFn = (r: Ring) => [number, number, number, number];

function arc(corner: 'FR' | 'RR' | 'RL' | 'FL', theta: number): SampleFn {
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  return (r) => {
    let cx: number, cz: number, rad: number;
    if (corner === 'FR') [cx, cz, rad] = [r.hw - r.rf, r.zf + r.rf, r.rf];
    else if (corner === 'RR') [cx, cz, rad] = [r.hw - r.rr, r.zr - r.rr, r.rr];
    else if (corner === 'RL') [cx, cz, rad] = [-(r.hw - r.rr), r.zr - r.rr, r.rr];
    else [cx, cz, rad] = [-(r.hw - r.rf), r.zf + r.rf, r.rf];
    return [cx + rad * s, cz - rad * c, s, -c];
  };
}

function strips(nc: number, nf: number, ns: number): SampleFn[][] {
  const D = Math.PI / 180;
  const arcRange = (corner: 'FR' | 'RR' | 'RL' | 'FL', a0: number, a1: number): SampleFn[] => {
    const out: SampleFn[] = [];
    for (let k = 0; k <= nc; k++) out.push(arc(corner, (a0 + ((a1 - a0) * k) / nc) * D));
    return out;
  };
  const front: SampleFn[] = [...arcRange('FL', 315, 360)];
  for (let k = 1; k < nf; k++) front.push((r) => [-(r.hw - r.rf) + (2 * (r.hw - r.rf) * k) / nf, r.zf, 0, -1]);
  front.push(...arcRange('FR', 0, 45));
  const right: SampleFn[] = [...arcRange('FR', 45, 90)];
  for (let k = 1; k < ns; k++) right.push((r) => [r.hw, r.zf + r.rf + ((r.zr - r.rr - r.zf - r.rf) * k) / ns, 1, 0]);
  right.push(...arcRange('RR', 90, 135));
  const rear: SampleFn[] = [...arcRange('RR', 135, 180)];
  for (let k = 1; k < nf; k++) rear.push((r) => [r.hw - r.rr - (2 * (r.hw - r.rr) * k) / nf, r.zr, 0, 1]);
  rear.push(...arcRange('RL', 180, 225));
  const left: SampleFn[] = [...arcRange('RL', 225, 270)];
  for (let k = 1; k < ns; k++) left.push((r) => [-r.hw, r.zr - r.rr - ((r.zr - r.rr - r.zf - r.rf) * k) / ns, -1, 0]);
  left.push(...arcRange('FL', 270, 315));
  return [front, right, rear, left];
}

export interface ShellOptions {
  detail: 'high' | 'low';
}

/**
 * Build the shell in the section's local frame (origin at the rear axle,
 * forward -Z): local z = z' - axleFromFront.
 */
export function buildShell(L: BodyLayout, sec: SectionLayout, atlas: AtlasLayout, opts: ShellOptions): THREE.BufferGeometry {
  const high = opts.detail === 'high';
  const levels = high ? L.levels : pickLevels(L);
  const S = strips(high ? 8 : 2, high ? 8 : 2, high ? 6 : 1);
  const zOff = -sec.axleFromFront;
  const W = L.hw * 2;
  const Lb = sec.bodyRear - sec.bodyFront;
  const span = L.yTop - L.y0;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const rings = levels.map((y) => ringAt(L, sec, y));
  const eps = 0.004;

  const toUV = (rect: Rect, u: number, v: number): [number, number] => [
    (rect.x + u * rect.w) / atlas.cw,
    1 - (rect.y + v * rect.h) / atlas.ch,
  ];

  S.forEach((samples, si) => {
    // articulated joint faces are left open (bellows + an exterior-only cap cover them)
    if ((si === 0 && !sec.isFront) || (si === 2 && !sec.isRear)) return;
    const base = pos.length / 3;
    const ns = samples.length;
    for (let j = 0; j < levels.length; j++) {
      const y = levels[j];
      const r = rings[j];
      const yA = Math.max(L.y0, y - eps);
      const yB = Math.min(L.yTop, y + eps);
      const rA = ringAt(L, sec, yA);
      const rB = ringAt(L, sec, yB);
      const v = (L.yTop - y) / span;
      for (const f of samples) {
        const [x, z, nx, nz] = f(r);
        const [xa, za] = f(rA);
        const [xb, zb] = f(rB);
        const d = ((xb - xa) * nx + (zb - za) * nz) / Math.max(1e-6, yB - yA);
        let ny = -d;
        let mx = nx, mz = nz;
        const l = Math.hypot(mx, ny, mz) || 1;
        mx /= l; ny /= l; mz /= l;
        pos.push(x, y, z + zOff);
        nor.push(mx, ny, mz);
        let t: [number, number];
        if (si === 0) t = atlas.front ? toUV(atlas.front, (W / 2 - x) / W, v) : atlas.dark;
        else if (si === 2) t = atlas.rear ? toUV(atlas.rear, (x + W / 2) / W, v) : atlas.dark;
        else if (si === 1) t = toUV(atlas.right, (sec.bodyRear - z) / Lb, v);
        else t = toUV(atlas.left, (z - sec.bodyFront) / Lb, v);
        uv.push(t[0], t[1]);
      }
    }
    for (let j = 0; j < levels.length - 1; j++) {
      for (let i = 0; i < ns - 1; i++) {
        const a = base + j * ns + i;
        const b = a + 1;
        const d = a + ns;
        const c = d + 1;
        idx.push(a, d, c, a, c, b);
      }
    }
  });

  // roof cap
  const top = rings[rings.length - 1];
  const yT = levels[levels.length - 1];
  const center = pos.length / 3;
  pos.push(0, yT, (top.zf + top.zr) / 2 + zOff);
  nor.push(0, 1, 0);
  uv.push(atlas.roof[0], atlas.roof[1]);
  const ringStart = pos.length / 3;
  let count = 0;
  for (const samples of S) {
    for (const f of samples) {
      const [x, z] = f(top);
      pos.push(x, yT, z + zOff);
      nor.push(0, 1, 0);
      uv.push(atlas.roof[0], atlas.roof[1]);
      count++;
    }
  }
  for (let i = 0; i < count; i++) {
    const a = ringStart + i;
    const b = ringStart + ((i + 1) % count);
    idx.push(center, b, a);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

function pickLevels(L: BodyLayout): number[] {
  // a cheaper set of rings: keep the skirt tuck, the window line, rake points and 2 shoulder rings
  const want = [L.y0, L.y0 + 0.07, L.sill, L.winTop, L.yTop - L.shoulder * 0.6, L.yTop - L.shoulder * 0.12, L.yTop];
  return [...new Set(want.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
}

/** z' of the outer surface at height y on the front face centre line. */
export function frontZ(L: BodyLayout, sec: SectionLayout, y: number): number {
  return ringAt(L, sec, y).zf;
}

/** z' of the rear face at height y. */
export function rearZ(L: BodyLayout, sec: SectionLayout, y: number): number {
  return ringAt(L, sec, y).zr;
}

/** Half width of the side surface at height y. */
export function sideX(L: BodyLayout, sec: SectionLayout, y: number): number {
  return ringAt(L, sec, y).hw;
}
