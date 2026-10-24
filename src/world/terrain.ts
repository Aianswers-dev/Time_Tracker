/**
 * Terrain: the inner 10 m height grid (with roads carved/clamped into it) and
 * the outer 60 m horizon grid, meshed in chunks with distance LOD and skirts.
 *
 * `TerrainField.ren` starts as the natural ground and is lowered by road and
 * rail corridors (so the ground never covers a carriageway), and cells under
 * deep cuttings are removed (`hole`) so open cuttings are really open; the
 * corridor builder covers the hole edges with walls and cap strips.
 */
import * as THREE from 'three';
import { AreaKind, type MapData } from '../types';
import type { Ctx } from './ctx';
import { NOISE_GLSL, patch } from './shaders';
import { yieldFrame } from './util';

export class TerrainField {
  readonly x0: number;
  readonly y0: number;
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  readonly nat: Float32Array;
  readonly ren: Float32Array;
  /** Per cell ((nx-1) x (ny-1)): 1 = no ground here (open cutting). */
  readonly hole: Uint8Array;
  /** Per vertex: lowest height any road clamp allows (ground must stay under roads). */
  readonly cap: Float32Array;
  /** Per vertex: top of a structure buried below (tunnel roofs); ground and skirts stay above it. */
  readonly floor: Float32Array;
  readonly ox0: number;
  readonly oy0: number;
  readonly ocell: number;
  readonly onx: number;
  readonly ony: number;
  readonly oh: Float32Array;
  readonly waterLevel: number;

  constructor(data: MapData) {
    const t = data.terrain;
    const inner = t.grids.find((g) => g.name === 'inner') ?? t.grids[0];
    const outer = t.grids.find((g) => g.name === 'outer') ?? t.grids[t.grids.length - 1];
    this.x0 = inner.x0;
    this.y0 = inner.y0;
    this.cell = inner.cell;
    this.nx = inner.nx;
    this.ny = inner.ny;
    this.nat = inner.h;
    this.ren = Float32Array.from(inner.h);
    this.hole = new Uint8Array((this.nx - 1) * (this.ny - 1));
    this.cap = new Float32Array(this.nx * this.ny).fill(Infinity);
    this.floor = new Float32Array(this.nx * this.ny).fill(-Infinity);
    this.ox0 = outer.x0;
    this.oy0 = outer.y0;
    this.ocell = outer.cell;
    this.onx = outer.nx;
    this.ony = outer.ny;
    this.oh = outer.h;
    this.waterLevel = t.waterLevel;
  }

  /** Inner grid extent [x0, y0, x1, y1]. */
  get extent(): [number, number, number, number] {
    return [this.x0, this.y0, this.x0 + (this.nx - 1) * this.cell, this.y0 + (this.ny - 1) * this.cell];
  }

  inInner(x: number, y: number): boolean {
    const fx = (x - this.x0) / this.cell;
    const fy = (y - this.y0) / this.cell;
    return fx >= 0 && fy >= 0 && fx <= this.nx - 1 && fy <= this.ny - 1;
  }

  outerAt(x: number, y: number): number {
    const fx = Math.max(0, Math.min(this.onx - 1.001, (x - this.ox0) / this.ocell));
    const fy = Math.max(0, Math.min(this.ony - 1.001, (y - this.oy0) / this.ocell));
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const k = j * this.onx + i;
    const h = this.oh;
    return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - ty) + (h[k + this.onx] * (1 - tx) + h[k + this.onx + 1] * tx) * ty;
  }

  /** Natural ground (bilinear, as Heights.ground). */
  natAt(x: number, y: number): number {
    const fx = (x - this.x0) / this.cell;
    const fy = (y - this.y0) / this.cell;
    if (fx < 0 || fy < 0 || fx > this.nx - 1 || fy > this.ny - 1) return this.outerAt(x, y);
    const i = Math.min(this.nx - 2, Math.floor(fx));
    const j = Math.min(this.ny - 2, Math.floor(fy));
    const tx = fx - i;
    const ty = fy - j;
    const k = j * this.nx + i;
    const h = this.nat;
    return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - ty) + (h[k + this.nx] * (1 - tx) + h[k + this.nx + 1] * tx) * ty;
  }

  /** Rendered ground height, exactly matching the mesh triangulation (diagonal a-c). */
  renAt(x: number, y: number): number {
    const fx = (x - this.x0) / this.cell;
    const fy = (y - this.y0) / this.cell;
    if (fx < 0 || fy < 0 || fx > this.nx - 1 || fy > this.ny - 1) return this.outerAt(x, y);
    const i = Math.min(this.nx - 2, Math.floor(fx));
    const j = Math.min(this.ny - 2, Math.floor(fy));
    const tx = fx - i;
    const ty = fy - j;
    const k = j * this.nx + i;
    const h = this.ren;
    const a = h[k];
    const b = h[k + 1];
    const c = h[k + this.nx + 1];
    const d = h[k + this.nx];
    // triangles (a, b, c) where tx >= ty, else (a, c, d)
    if (tx >= ty) return a + (b - a) * tx + (c - b) * ty;
    return a + (c - d) * tx + (d - a) * ty;
  }

  /**
   * The ground as settle() will leave it, given the clamps and buried roofs
   * recorded so far (later clamps can only lower it): never below the
   * natural ground except where a road clamp holds it down.
   */
  settledAt(x: number, y: number): number {
    const fx = (x - this.x0) / this.cell;
    const fy = (y - this.y0) / this.cell;
    if (fx < 0 || fy < 0 || fx > this.nx - 1 || fy > this.ny - 1) return this.outerAt(x, y);
    const i = Math.min(this.nx - 2, Math.floor(fx));
    const j = Math.min(this.ny - 2, Math.floor(fy));
    const tx = fx - i;
    const ty = fy - j;
    const k = j * this.nx + i;
    const v = (q: number) => {
      const r = this.ren[q];
      const f = this.floor[q] + 0.3;
      return f > r ? Math.max(r, Math.min(f, this.cap[q])) : r;
    };
    const a = v(k);
    const b = v(k + 1);
    const c = v(k + this.nx + 1);
    const d = v(k + this.nx);
    if (tx >= ty) return a + (b - a) * tx + (c - b) * ty;
    return a + (c - d) * tx + (d - a) * ty;
  }

  /** True if (x, y) falls in a carved-out cell. */
  isHole(x: number, y: number): boolean {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((y - this.y0) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx - 1 || j >= this.ny - 1) return false;
    return this.hole[j * (this.nx - 1) + i] === 1;
  }

  /**
   * Lower rendered ground vertices that fall inside the convex quad (corners
   * in order, each [x, y, z]) to below the quad surface by `margin`.
   */
  clampQuad(q: number[], margin: number): void {
    const xs = [q[0], q[3], q[6], q[9]];
    const ys = [q[1], q[4], q[7], q[10]];
    const i0 = Math.max(0, Math.ceil((Math.min(...xs) - this.x0) / this.cell));
    const i1 = Math.min(this.nx - 1, Math.floor((Math.max(...xs) - this.x0) / this.cell));
    const j0 = Math.max(0, Math.ceil((Math.min(...ys) - this.y0) / this.cell));
    const j1 = Math.min(this.ny - 1, Math.floor((Math.max(...ys) - this.y0) / this.cell));
    if (i1 < i0 || j1 < j0) return;
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + j * this.cell;
      for (let i = i0; i <= i1; i++) {
        const x = this.x0 + i * this.cell;
        let z = triZ(q, 0, 3, 6, x, y);
        if (z === null) z = triZ(q, 0, 6, 9, x, y);
        if (z === null) continue;
        const k = j * this.nx + i;
        const v = z - margin;
        if (v < this.ren[k]) this.ren[k] = v;
        if (v < this.cap[k]) this.cap[k] = v;
      }
    }
  }

  /**
   * Mark a buried structure (a tunnel roof segment, convex quad of x,y,z corners):
   * vertices within `expand` metres keep the ground, and terrain skirts, above
   * its highest corner.
   */
  protectQuad(q: number[], expand: number): void {
    const xs = [q[0], q[3], q[6], q[9]];
    const ys = [q[1], q[4], q[7], q[10]];
    const top = Math.max(q[2], q[5], q[8], q[11]);
    const i0 = Math.max(0, Math.ceil((Math.min(...xs) - expand - this.x0) / this.cell));
    const i1 = Math.min(this.nx - 1, Math.floor((Math.max(...xs) + expand - this.x0) / this.cell));
    const j0 = Math.max(0, Math.ceil((Math.min(...ys) - expand - this.y0) / this.cell));
    const j1 = Math.min(this.ny - 1, Math.floor((Math.max(...ys) + expand - this.y0) / this.cell));
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + j * this.cell;
      for (let i = i0; i <= i1; i++) {
        const x = this.x0 + i * this.cell;
        const k = j * this.nx + i;
        if (top > this.floor[k] && quadDist(q, x, y) <= expand) this.floor[k] = top;
      }
    }
  }

  /** Highest buried roof (tunnel) recorded at the four grid vertices around (x, y), or -Infinity. */
  floorAt(x: number, y: number): number {
    const fx = (x - this.x0) / this.cell;
    const fy = (y - this.y0) / this.cell;
    if (fx < 0 || fy < 0 || fx >= this.nx - 1 || fy >= this.ny - 1) return -Infinity;
    const k = Math.floor(fy) * this.nx + Math.floor(fx);
    const f = this.floor;
    return Math.max(f[k], f[k + 1], f[k + this.nx], f[k + this.nx + 1]);
  }

  /** After all earthworks: lift ground that sags into a shallow tunnel roof (never above a road clamp). */
  settle(): void {
    const { ren, floor, cap } = this;
    for (let k = 0; k < ren.length; k++) {
      if (floor[k] + 0.3 > ren[k]) ren[k] = Math.max(ren[k], Math.min(floor[k] + 0.3, cap[k]));
    }
  }

  /**
   * Carve the ground out of the convex quad q (corners in order, each [x, y, z]),
   * grown by `expand` metres. The cut is exact: cells it touches are marked in
   * `hole` and keep their ground outside the quad (see chunkGeometry), with an
   * earth face hanging from the cut edge down to the quad's floor. The floor
   * height is taken along the quad's first edge (corners 0 -> 1, the road
   * centreline for cuttings). `roof`: a structure covers this cut (a tunnel
   * box roof), so it is not open to the sky. `endExpand`: the margin across the
   * quad's ends (edges 3-0 and 1-2), where the next sample's cut or surface
   * takes over exactly.
   */
  holeQuad(q: number[], expand: number, roof = false, endExpand = expand): void {
    const cut = makeCut(q, expand, roof, endExpand);
    if (!cut) return;
    this.cutList.push(cut);
    const xs = [q[0], q[3], q[6], q[9]];
    const ys = [q[1], q[4], q[7], q[10]];
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - expand - this.x0) / c));
    const i1 = Math.min(this.nx - 2, Math.floor((Math.max(...xs) + expand - this.x0) / c));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - expand - this.y0) / c));
    const j1 = Math.min(this.ny - 2, Math.floor((Math.max(...ys) + expand - this.y0) / c));
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + (j + 0.5) * c;
      for (let i = i0; i <= i1; i++) {
        const x = this.x0 + (i + 0.5) * c;
        if (!squareMeetsQuad(q, x, y, c / 2, expand)) continue;
        const k = j * (this.nx - 1) + i;
        this.hole[k] = 1;
        let l = this.cuts.get(k);
        if (!l) this.cuts.set(k, (l = []));
        l.push(cut);
      }
    }
  }

  /** Carved regions per cell (index j * (nx - 1) + i). */
  readonly cuts = new Map<number, Cut[]>();
  /** Every carved region, in order. */
  readonly cutList: Cut[] = [];

  /** The carved regions over (x, y): open cuttings only, unless `roofed` too. */
  cutsAt(x: number, y: number, roofed = false): Cut[] {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((y - this.y0) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx - 1 || j >= this.ny - 1) return [];
    const l = this.cuts.get(j * (this.nx - 1) + i);
    if (!l) return [];
    return l.filter((c) => (roofed || !c.roof) && cutHas(c, x, y));
  }

  /** Every cut (open or roofed) recorded in the cells overlapping the box. */
  cutsNear(x0: number, y0: number, x1: number, y1: number): Cut[] {
    const i0 = Math.max(0, Math.floor((x0 - this.x0) / this.cell));
    const i1 = Math.min(this.nx - 2, Math.floor((x1 - this.x0) / this.cell));
    const j0 = Math.max(0, Math.floor((y0 - this.y0) / this.cell));
    const j1 = Math.min(this.ny - 2, Math.floor((y1 - this.y0) / this.cell));
    const out: Cut[] = [];
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) for (const c of this.cuts.get(j * (this.nx - 1) + i) ?? []) if (!out.includes(c)) out.push(c);
    return out;
  }

  /** True if (x, y) lies inside an open cutting (no ground over it, open to the sky). */
  inCut(x: number, y: number): boolean {
    return this.cutsAt(x, y).length > 0;
  }
}

/**
 * A carved region: a convex polygon as half-planes hx * x + hy * y <= hd
 * (already grown by the expand margin), with the floor height along the
 * quad's first edge (a -> b).
 */
export interface Cut {
  hx: number[];
  hy: number[];
  hd: number[];
  ax: number;
  ay: number;
  bx: number;
  by: number;
  za: number;
  zb: number;
  roof: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The quad as given (x, y, z per corner). */
  q: number[];
}

function makeCut(q: number[], expand: number, roof: boolean, endExpand: number): Cut | null {
  // convex hull of the four corners (a sharp bend can fold a sample quad into a bow tie)
  const pts: [number, number, number][] = [
    [q[0], q[1], 0],
    [q[3], q[4], 1],
    [q[6], q[7], 2],
    [q[9], q[10], 3],
  ];
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-9) lower.pop();
    lower.push(p);
  }
  const upper: [number, number, number][] = [];
  for (let k = pts.length - 1; k >= 0; k--) {
    const p = pts[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-9) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1)); // counter-clockwise
  const hx: number[] = [];
  const hy: number[] = [];
  const hd: number[] = [];
  const add = (nx: number, ny: number, px: number, py: number, e = expand) => {
    hx.push(nx);
    hy.push(ny);
    hd.push(nx * px + ny * py + e);
  };
  if (hull.length >= 3) {
    for (let k = 0; k < hull.length; k++) {
      const a = hull[k];
      const b = hull[(k + 1) % hull.length];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const l = Math.hypot(ex, ey);
      if (l < 1e-6) continue;
      const lo = Math.min(a[2], b[2]);
      const hi = Math.max(a[2], b[2]);
      const end = (lo === 0 && hi === 3) || (lo === 1 && hi === 2);
      add(ey / l, -ex / l, a[0], a[1], end ? endExpand : expand);
    }
  } else {
    // degenerate (a line): a thin slab around the segment
    const a = pts[0];
    const b = pts[pts.length - 1];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const l = Math.hypot(ex, ey);
    if (l < 1e-6) return null;
    add(ey / l, -ex / l, a[0], a[1]);
    add(-ey / l, ex / l, a[0], a[1]);
    add(ex / l, ey / l, b[0], b[1]);
    add(-ex / l, -ey / l, a[0], a[1]);
  }
  const xs = [q[0], q[3], q[6], q[9]];
  const ys = [q[1], q[4], q[7], q[10]];
  const m = expand * 1.5 + 0.01;
  return {
    hx,
    hy,
    hd,
    ax: q[0],
    ay: q[1],
    bx: q[3],
    by: q[4],
    za: q[2],
    zb: q[5],
    roof,
    x0: Math.min(...xs) - m,
    y0: Math.min(...ys) - m,
    x1: Math.max(...xs) + m,
    y1: Math.max(...ys) + m,
    q: q.slice(0, 12),
  };
}

function cutHas(c: Cut, x: number, y: number): boolean {
  if (x < c.x0 || x > c.x1 || y < c.y0 || y > c.y1) return false;
  for (let k = 0; k < c.hx.length; k++) if (c.hx[k] * x + c.hy[k] * y > c.hd[k]) return false;
  return true;
}

/** Floor height of a cut at (x, y): along its first edge. */
function cutFloor(c: Cut, x: number, y: number): number {
  const dx = c.bx - c.ax;
  const dy = c.by - c.ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-9 ? ((x - c.ax) * dx + (y - c.ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return c.za + (c.zb - c.za) * t;
}

/** Keep the part of convex polygon p (flat x, y) inside (n . v <= d) or outside (>= d). */
function clipHalf(p: number[], nx: number, ny: number, d: number, inside: boolean): number[] {
  const out: number[] = [];
  const n = p.length >> 1;
  for (let k = 0; k < n; k++) {
    const cx = p[2 * k];
    const cy = p[2 * k + 1];
    const k2 = (k + 1) % n;
    const qx = p[2 * k2];
    const qy = p[2 * k2 + 1];
    let sc = nx * cx + ny * cy - d;
    let sn = nx * qx + ny * qy - d;
    if (!inside) {
      sc = -sc;
      sn = -sn;
    }
    if (sc <= 0) out.push(cx, cy);
    if (sc <= 0 !== sn <= 0) {
      const t = sc / (sc - sn);
      out.push(cx + (qx - cx) * t, cy + (qy - cy) * t);
    }
  }
  return out;
}

function polyArea(p: number[]): number {
  let a = 0;
  const n = p.length >> 1;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    a += p[2 * k] * p[2 * k2 + 1] - p[2 * k2] * p[2 * k + 1];
  }
  return a / 2;
}

/** Convex polygon p minus a cut: up to one convex piece per half-plane. */
function subtractCut(p: number[], c: Cut): number[][] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < p.length; k += 2) {
    x0 = Math.min(x0, p[k]);
    x1 = Math.max(x1, p[k]);
    y0 = Math.min(y0, p[k + 1]);
    y1 = Math.max(y1, p[k + 1]);
  }
  if (x1 < c.x0 || x0 > c.x1 || y1 < c.y0 || y0 > c.y1) return null;
  const out: number[][] = [];
  let rem = p;
  for (let k = 0; k < c.hx.length; k++) {
    const o = clipHalf(rem, c.hx[k], c.hy[k], c.hd[k], false);
    if (o.length >= 6 && Math.abs(polyArea(o)) > 1e-4) out.push(o);
    rem = clipHalf(rem, c.hx[k], c.hy[k], c.hd[k], true);
    if (rem.length < 6 || Math.abs(polyArea(rem)) < 1e-6) {
      // nothing of p lies inside the cut
      return out.length === 1 && rem.length < 6 ? null : out;
    }
  }
  return out;
}

/** Separating-axis test: does the axis-aligned square (centre, half size) overlap the convex quad grown by `margin`? */
function squareMeetsQuad(q: number[], cx: number, cy: number, half: number, margin: number): boolean {
  const axes: [number, number][] = [
    [1, 0],
    [0, 1],
  ];
  for (let k = 0; k < 4; k++) {
    const a = k * 3;
    const b = ((k + 1) % 4) * 3;
    const ex = q[b] - q[a];
    const ey = q[b + 1] - q[a + 1];
    const l = Math.hypot(ex, ey);
    if (l > 1e-6) axes.push([-ey / l, ex / l]);
  }
  for (const [ax, ay] of axes) {
    const c = cx * ax + cy * ay;
    const r = half * (Math.abs(ax) + Math.abs(ay));
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 12; k += 3) {
      const p = q[k] * ax + q[k + 1] * ay;
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
    if (c + r < lo - margin || c - r > hi + margin) return false;
  }
  return true;
}

/** z of point (x, y) on triangle (corners at q[a], q[b], q[c] as x,y,z triples) or null if outside. */
function triZ(q: number[], a: number, b: number, c: number, x: number, y: number): number | null {
  const ax = q[a];
  const ay = q[a + 1];
  const bx = q[b];
  const by = q[b + 1];
  const cx = q[c];
  const cy = q[c + 1];
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-9) return null;
  const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
  const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
  const l3 = 1 - l1 - l2;
  const e = -1e-6;
  if (l1 < e || l2 < e || l3 < e) return null;
  return l1 * q[a + 2] + l2 * q[b + 2] + l3 * q[c + 2];
}

function segD(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
}

/** Distance from point to convex quad (0 inside). Corners as x,y,z triples. */
function quadDist(q: number[], x: number, y: number): number {
  let inside = true;
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const a = k * 3;
    const b = ((k + 1) % 4) * 3;
    const cr = (q[b] - q[a]) * (y - q[a + 1]) - (q[b + 1] - q[a + 1]) * (x - q[a]);
    const s = Math.sign(cr);
    if (s !== 0) {
      if (sign === 0) sign = s;
      else if (s !== sign) inside = false;
    }
  }
  if (inside) return 0;
  let d = Infinity;
  for (let k = 0; k < 4; k++) {
    const a = k * 3;
    const b = ((k + 1) % 4) * 3;
    d = Math.min(d, segD(x, y, q[a], q[a + 1], q[b], q[b + 1]));
  }
  return d;
}

// ---------------------------------------------------------------------------
// Land cover texture (park, wood, sport, plaza weights) at 5 m

export function makeLandcover(data: MapData, R: [number, number, number, number]): { tex: THREE.Texture; rect: THREE.Vector4 } {
  const cell = 5;
  const w = Math.ceil((R[2] - R[0]) / cell);
  const h = Math.ceil((R[3] - R[1]) / cell);
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.globalCompositeOperation = 'lighter';
    return { c, g };
  };
  const A = mk();
  const B = mk();
  const path = (g: CanvasRenderingContext2D, rings: ArrayLike<number>[]) => {
    g.beginPath();
    for (const r of rings) {
      for (let i = 0; i < r.length; i += 2) {
        const px = (r[i] - R[0]) / cell;
        const py = (R[3] - r[i + 1]) / cell;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.closePath();
    }
    g.fill('evenodd');
  };
  for (const a of data.areas) {
    const rings = [a.pts, ...a.holes];
    switch (a.kind) {
      case AreaKind.Park:
        A.g.fillStyle = '#ff0000';
        path(A.g, rings);
        break;
      case AreaKind.Wood:
        A.g.fillStyle = '#00ff00';
        path(A.g, rings);
        break;
      case AreaKind.Sport:
        A.g.fillStyle = '#0000ff';
        path(A.g, rings);
        break;
      case AreaKind.Cemetery:
        A.g.fillStyle = '#ff0000';
        path(A.g, rings);
        break;
      case AreaKind.Plaza:
      case AreaKind.Sand:
        B.g.fillStyle = '#ff0000';
        path(B.g, rings);
        break;
    }
  }
  const da = A.g.getImageData(0, 0, w, h).data;
  const db = B.g.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  // flip rows so v = 0 is the south edge
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    const dst = y * w * 4;
    for (let x = 0; x < w; x++) {
      const s = src + x * 4;
      const d = dst + x * 4;
      out[d] = da[s];
      out[d + 1] = da[s + 1];
      out[d + 2] = da[s + 2];
      out[d + 3] = db[s];
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return { tex, rect: new THREE.Vector4(R[0], R[1], 1 / (w * cell), 1 / (h * cell)) };
}

// ---------------------------------------------------------------------------
// Material

const TERRAIN_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uDensity;
uniform vec4 uDensityRect;
uniform sampler2D uLand;
uniform vec4 uLandRect;
uniform sampler2D uOuter;
uniform vec4 uOuterRect;
uniform float uWaterLevel;
varying vec3 vGPos;
varying vec3 vGNrm;
${NOISE_GLSL}
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float w_aa(float v, float w, float fwv) { float f = max(fwv, 1e-3); return 1.0 - w_ss(w - f, w + f, v); }
vec3 lawnCol(vec4 n1, vec4 n2, vec4 n3) {
  vec3 green = vec3(0.35, 0.43, 0.24);
  vec3 dry = vec3(0.52, 0.50, 0.36);
  vec3 c = mix(green, dry, smoothstep(0.48, 0.8, n2.g + (n1.r - 0.5) * 0.35));
  c = mix(c, vec3(0.20, 0.27, 0.14), smoothstep(0.62, 0.72, n1.g) * 0.75);
  c = mix(c, vec3(0.28, 0.35, 0.19), smoothstep(0.6, 0.9, n2.b) * 0.6);
  return c * (0.86 + 0.28 * n3.r);
}
vec3 terrainAlbedo() {
  vec2 p = vec2(vGPos.x, -vGPos.z);
  vec4 n1 = texture2D(uNoise, p / 23.0);
  vec4 n2 = texture2D(uNoise, p / 190.0);
  vec4 n3 = texture2D(uNoise, p / 4.3);
  vec2 FWP = fwidth(p);
  vec3 lawn = lawnCol(n1, n2, n3);
  vec3 c;
#ifdef W_OUTER
  vec4 o = texture2D(uOuter, (p - uOuterRect.xy) * uOuterRect.zw);
  vec2 lot = p / vec2(17.0, 21.0);
  vec2 li = floor(lot);
  vec2 lf = fract(lot);
  float hsh = w_hash(li);
  float roof = step(0.18, lf.x) * step(lf.x, 0.78) * step(0.22, lf.y) * step(lf.y, 0.75) * step(hsh, 0.25 + o.r * 1.8 + 0.25);
  vec3 roofCol = hsh < 0.3 ? vec3(0.62, 0.62, 0.62) : hsh < 0.55 ? vec3(0.55, 0.30, 0.24) : hsh < 0.75 ? vec3(0.80, 0.80, 0.78) : vec3(0.40, 0.42, 0.44);
  float tree = smoothstep(0.55, 0.7, n1.g + n3.r * 0.3);
  vec3 sub = mix(lawn, roofCol, roof);
  sub = mix(sub, vec3(0.20, 0.30, 0.15), tree * 0.7);
  float far = smoothstep(2.0, 6.0, length(FWP));
  vec3 subAvg = mix(lawn, vec3(0.45, 0.42, 0.38), 0.35 + o.r * 0.4) * 0.85;
  sub = mix(sub, subAvg, far);
  vec3 forest = mix(vec3(0.17, 0.25, 0.12), vec3(0.24, 0.32, 0.16), n2.g) * (0.85 + 0.3 * n1.r);
  c = mix(sub, forest, smoothstep(0.3, 0.8, o.g));
  c = mix(c, vec3(0.32, 0.32, 0.33), smoothstep(0.5, 0.9, o.b) * 0.4);
#else
  vec4 lc = texture2D(uLand, (p - uLandRect.xy) * uLandRect.zw);
  float dens = texture2D(uDensity, (p - uDensityRect.xy) * uDensityRect.zw).r;
  vec3 conc = vec3(0.60, 0.59, 0.55) * (0.88 + 0.2 * n3.r) * (0.9 + 0.2 * n1.g);
  vec3 lotc = vec3(0.30, 0.30, 0.31) * (0.9 + 0.2 * n3.r);
  vec3 paved = mix(conc, lotc, smoothstep(0.55, 0.7, n2.r));
  c = mix(lawn, paved, smoothstep(0.10, 0.34, dens + (n2.g - 0.5) * 0.12));
  vec3 park = lawn * vec3(0.95, 1.06, 0.92);
  vec3 wood = mix(vec3(0.26, 0.31, 0.17), vec3(0.36, 0.30, 0.20), smoothstep(0.4, 0.7, n1.g)) * (0.8 + 0.35 * n3.r);
  float stripe = step(0.5, fract(p.x / 7.0 + p.y / 41.0));
  vec3 sport = vec3(0.33, 0.52, 0.22) * (0.92 + 0.1 * stripe) * (0.92 + 0.12 * n3.r);
  vec2 q = fract(p / 0.6);
  float joint = max(w_aa(0.5 - abs(q.x - 0.5), 0.03, FWP.x / 0.6), w_aa(0.5 - abs(q.y - 0.5), 0.03, FWP.y / 0.6));
  vec3 plaza = mix(vec3(0.70, 0.66, 0.60), vec3(0.58, 0.55, 0.50), n1.g * 0.6) * (0.94 + 0.12 * n3.r) * (1.0 - joint * 0.18);
  c = mix(c, park, smoothstep(0.2, 0.8, lc.r));
  c = mix(c, wood, smoothstep(0.2, 0.8, lc.g));
  c = mix(c, sport, smoothstep(0.2, 0.8, lc.b));
  c = mix(c, plaza, smoothstep(0.2, 0.8, lc.a));
#endif
  // steep banks and cuttings: bare earth; river margins: mud. A face steep in itself (cut faces, the
  // earth faces at cutting edges) is bare earth whatever its vertex normals say, textured in its own
  // plane (plan mapping would smear it into vertical streaks), with faint strata.
  vec3 fn = normalize(cross(dFdx(vGPos), dFdy(vGPos)));
  float steepF = 1.0 - smoothstep(0.5, 0.8, abs(fn.y));
  float steep = max(1.0 - smoothstep(0.72, 0.9, normalize(vGNrm).y), steepF);
  vec2 ep = steepF > 0.5 ? (abs(fn.x) > abs(fn.z) ? vec2(-vGPos.z, vGPos.y) : vec2(vGPos.x, vGPos.y)) : p;
  vec4 e1 = texture2D(uNoise, ep / 23.0);
  vec4 e3 = texture2D(uNoise, ep / vec2(4.3, 2.2));
  vec3 earth = mix(vec3(0.42, 0.36, 0.27), vec3(0.33, 0.30, 0.25), e1.r) * (0.85 + 0.3 * e3.g);
  earth *= 1.0 - 0.07 * steepF * smoothstep(0.3, 0.7, fract(vGPos.y * 1.3 + e1.g * 1.7));
  c = mix(c, earth, max(steep * 0.75, steepF));
  float bank = 1.0 - smoothstep(uWaterLevel + 0.3, uWaterLevel + 1.6, vGPos.y + (n1.g - 0.5) * 0.6);
  vec3 mud = mix(vec3(0.33, 0.29, 0.22), vec3(0.20, 0.18, 0.15), smoothstep(uWaterLevel + 0.2, uWaterLevel - 1.5, vGPos.y));
  c = mix(c, mud, bank);
  if (!gl_FrontFacing) c = vec3(0.16, 0.14, 0.12) * (0.8 + 0.4 * n3.r);
  return c;
}
`;

export function makeTerrainMaterial(ctx: Ctx, land: { tex: THREE.Texture; rect: THREE.Vector4 }, outer: boolean, depthBias = 0): THREE.MeshLambertMaterial {
  const d = ctx.density;
  const ex = ctx.extras;
  const outerRect = new THREE.Vector4(0, 0, 1, 1);
  if (ex) {
    const r = ex.raster;
    const yb = r.y1 - r.h * r.cell;
    outerRect.set(r.x0, yb, 1 / (r.w * r.cell), 1 / (r.h * r.cell));
  }
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: depthBias ? THREE.FrontSide : THREE.DoubleSide });
  return patch(mat, {
    key: outer ? 'terrain-outer' : depthBias ? 'terrain-strip' : 'terrain',
    depthBias,
    uniforms: {
      uNoise: { value: ctx.tex.noise },
      uDensity: { value: d.tex },
      uDensityRect: { value: new THREE.Vector4(d.x0, d.y0, 1 / (d.nx * d.cell), 1 / (d.ny * d.cell)) },
      uLand: { value: land.tex },
      uLandRect: { value: land.rect },
      uOuter: { value: ctx.outerTex ?? ctx.tex.noise },
      uOuterRect: { value: outerRect },
      uWaterLevel: { value: ctx.data.terrain.waterLevel },
    },
    defines: outer ? { W_OUTER: '' } : {},
    vertexPars: 'varying vec3 vGPos;\nvarying vec3 vGNrm;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvGNrm = objectNormal;']],
    fragmentPars: TERRAIN_FRAG,
    fragment: [['vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( srgb(terrainAlbedo()), opacity );']],
  });
}

// ---------------------------------------------------------------------------
// Meshing

const CH = 192;
const SKIRT = 8;

interface LodChunk {
  meshes: THREE.Mesh[];
  /** Bounds in map coords. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Mesh one terrain chunk at grid step `s`. Carved cells are clipped exactly
 * against the cuts recorded in them (the ground outside a cutting stays), and
 * every cut edge gets an earth face down to the cutting's floor, so there is
 * never a see-through gap at the edge of a cutting. At a coarse LOD, blocks
 * holding a carved cell are meshed at full resolution, with their edge
 * vertices on the coarse neighbours' straight edges so the seam stays closed.
 */
export function chunkGeometry(f: TerrainField, ci0: number, cj0: number, ci1: number, cj1: number, s: number): THREE.BufferGeometry | null {
  const xsI: number[] = [];
  for (let i = ci0; i < ci1; i += s) xsI.push(i);
  xsI.push(ci1);
  const ysJ: number[] = [];
  for (let j = cj0; j < cj1; j += s) ysJ.push(j);
  ysJ.push(cj1);
  const w = xsI.length;
  const h = ysJ.length;
  const nx = f.nx;
  const ny = f.ny;
  const H = f.ren;
  const hw = nx - 1;
  const P: number[] = [];
  const N: number[] = [];
  const idx: number[] = [];
  const put = (x: number, z: number, y: number, n0: number, n1: number, n2: number): number => {
    const l = Math.hypot(n0, n1, n2) || 1;
    P.push(x, z, -y);
    N.push(n0 / l, n1 / l, n2 / l);
    return P.length / 3 - 1;
  };
  const gradN = (i: number, j: number, st: number): [number, number, number] => {
    const il = Math.max(0, i - st);
    const ir = Math.min(nx - 1, i + st);
    const jd = Math.max(0, j - st);
    const ju = Math.min(ny - 1, j + st);
    const gx = (H[j * nx + ir] - H[j * nx + il]) / ((ir - il) * f.cell);
    const gy = (H[ju * nx + i] - H[jd * nx + i]) / ((ju - jd) * f.cell);
    // normal of z = h(x, y): (-gx, 1, gy) in three space (z = -y)
    return [-gx, 1, gy];
  };
  const X = (i: number) => f.x0 + i * f.cell;
  const Y = (j: number) => f.y0 + j * f.cell;
  const grid = new Int32Array(w * h);
  for (let b = 0; b < h; b++) {
    for (let a = 0; a < w; a++) {
      const i = xsI[a];
      const j = ysJ[b];
      grid[b * w + a] = put(X(i), H[j * nx + i], Y(j), ...gradN(i, j, s));
    }
  }
  /** Triangle a-b-c (vertex indices) facing (fx, fy, fz) in three space. */
  const tri = (a: number, b: number, c: number, fx: number, fy: number, fz: number) => {
    const ux = P[3 * b] - P[3 * a];
    const uy = P[3 * b + 1] - P[3 * a + 1];
    const uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a];
    const vy = P[3 * c + 1] - P[3 * a + 1];
    const vz = P[3 * c + 2] - P[3 * a + 2];
    const d = (uy * vz - uz * vy) * fx + (uz * vx - ux * vz) * fy + (ux * vy - uy * vx) * fz;
    if (d >= 0) idx.push(a, b, c);
    else idx.push(a, c, b);
  };
  const colOf = (i: number) => (i === ci1 ? w - 1 : (i - ci0) % s === 0 ? (i - ci0) / s : -1);
  const rowOf = (j: number) => (j === cj1 ? h - 1 : (j - cj0) % s === 0 ? (j - cj0) / s : -1);
  const fine = new Map<number, number>();
  /** Vertex (i, j) of a block [ia, ib] x [ja, jb] meshed at full resolution. */
  const fineVert = (i: number, j: number, ia: number, ja: number, ib: number, jb: number): number => {
    const a = colOf(i);
    const b = rowOf(j);
    if (a >= 0 && b >= 0) return grid[b * w + a];
    const key = j * nx + i;
    const got = fine.get(key);
    if (got !== undefined) return got;
    let z = H[key];
    // on the block's edge: on the coarse neighbour's straight edge
    if (i === ia || i === ib) z = H[ja * nx + i] + ((H[jb * nx + i] - H[ja * nx + i]) * (j - ja)) / (jb - ja);
    else if (j === ja || j === jb) z = H[j * nx + ia] + ((H[j * nx + ib] - H[j * nx + ia]) * (i - ia)) / (ib - ia);
    const v = put(X(i), z, Y(j), ...gradN(i, j, 1));
    fine.set(key, v);
    return v;
  };
  const isCarved = (i: number, j: number) => i >= 0 && j >= 0 && i < hw && j < ny - 1 && f.hole[j * hw + i] === 1;

  /** Ground triangle a-b-c minus the cuts, with earth faces along the cut edges. */
  const clipTri = (va: number, vb: number, vc: number, cuts: Cut[]) => {
    const ax = P[3 * va];
    const ay = -P[3 * va + 2];
    const bx = P[3 * vb];
    const by = -P[3 * vb + 2];
    const cx = P[3 * vc];
    const cy = -P[3 * vc + 2];
    let pieces: number[][] = [[ax, ay, bx, by, cx, cy]];
    let touched = false;
    for (const c of cuts) {
      const next: number[][] = [];
      for (const p of pieces) {
        const r = subtractCut(p, c);
        if (r === null) next.push(p);
        else {
          touched = true;
          for (const q of r) next.push(q);
        }
      }
      pieces = next;
      if (!pieces.length) break;
    }
    if (!touched) {
      idx.push(va, vb, vc);
      return;
    }
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-9) return;
    const bary = (x: number, y: number): [number, number, number] => {
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
      const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
      return [l1, l2, 1 - l1 - l2];
    };
    const V = [va, vb, vc];
    for (const p of pieces) {
      const area = polyArea(p);
      if (Math.abs(area) < 1e-3) continue;
      const n = p.length >> 1;
      const vs: number[] = [];
      const zs: number[] = [];
      for (let k = 0; k < n; k++) {
        const x = p[2 * k];
        const y = p[2 * k + 1];
        const l = bary(x, y);
        let z = 0;
        let n0 = 0;
        let n1 = 0;
        let n2 = 0;
        for (let m = 0; m < 3; m++) {
          const v = V[m];
          z += l[m] * P[3 * v + 1];
          n0 += l[m] * N[3 * v];
          n1 += l[m] * N[3 * v + 1];
          n2 += l[m] * N[3 * v + 2];
        }
        vs.push(put(x, z, y, n0, n1, n2));
        zs.push(z);
      }
      for (let k = 1; k + 1 < n; k++) {
        if (area > 0) idx.push(vs[0], vs[k], vs[k + 1]);
        else idx.push(vs[0], vs[k + 1], vs[k]);
      }
      // earth faces down the cut edges
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        const x1 = p[2 * k];
        const y1 = p[2 * k + 1];
        const x2 = p[2 * k2];
        const y2 = p[2 * k2 + 1];
        const el = Math.hypot(x2 - x1, y2 - y1);
        if (el < 0.02) continue;
        let ox = (y2 - y1) / el;
        let oy = -(x2 - x1) / el;
        if (area < 0) {
          ox = -ox;
          oy = -oy;
        }
        // the stretches of this edge with a cut just beyond it (the point beyond may lie in the next cell
        // when the edge is the triangle's own side; one piece edge can run on past the cut's end)
        const e = 0.03;
        const bx0 = x1 + ox * e;
        const by0 = y1 + oy * e;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const spans: [number, number, Cut][] = [];
        for (const c of f.cutsNear(Math.min(x1, x2) + ox * e, Math.min(y1, y2) + oy * e, Math.max(x1, x2) + ox * e, Math.max(y1, y2) + oy * e)) {
          let lo = 0;
          let hi = 1;
          for (let h = 0; h < c.hx.length && lo < hi; h++) {
            const a0 = c.hx[h] * bx0 + c.hy[h] * by0 - c.hd[h];
            const b0 = c.hx[h] * dx + c.hy[h] * dy;
            if (Math.abs(b0) < 1e-12) {
              if (a0 > 0) hi = -1;
            } else if (b0 > 0) hi = Math.min(hi, -a0 / b0);
            else lo = Math.max(lo, -a0 / b0);
          }
          if ((hi - lo) * el > 0.01) spans.push([lo, hi, c]);
        }
        if (!spans.length) continue; // ground lies beyond
        const ts = [0, 1];
        for (const [lo, hi] of spans) ts.push(lo, hi);
        ts.sort((u, v) => u - v);
        const z1 = zs[k];
        const z2 = zs[k2];
        for (let q = 0; q + 1 < ts.length; q++) {
          const ta = ts[q];
          const tb = ts[q + 1];
          if ((tb - ta) * el < 0.01) continue;
          const tm = (ta + tb) / 2;
          let fa = -Infinity;
          let fb = -Infinity;
          const ax2 = x1 + dx * ta;
          const ay2 = y1 + dy * ta;
          const bx2 = x1 + dx * tb;
          const by2 = y1 + dy * tb;
          for (const [lo, hi, c] of spans) {
            if (tm < lo || tm > hi) continue;
            fa = Math.max(fa, cutFloor(c, ax2, ay2));
            fb = Math.max(fb, cutFloor(c, bx2, by2));
          }
          if (fa === -Infinity) continue;
          const za = z1 + (z2 - z1) * ta;
          const zb = z1 + (z2 - z1) * tb;
          if (Math.max(za, zb) < Math.max(fa, fb) + 0.05) continue;
          const t1 = put(ax2, za, ay2, ox, 0, -oy);
          const t2 = put(bx2, zb, by2, ox, 0, -oy);
          const u2 = put(bx2, Math.min(zb - 0.02, fb - 0.25), by2, ox, 0, -oy);
          const u1 = put(ax2, Math.min(za - 0.02, fa - 0.25), ay2, ox, 0, -oy);
          tri(t1, t2, u2, ox, 0, -oy);
          tri(t1, u2, u1, ox, 0, -oy);
        }
      }
    }
  };

  for (let b = 0; b + 1 < h; b++) {
    for (let a = 0; a + 1 < w; a++) {
      const ia = xsI[a];
      const ib = xsI[a + 1];
      const ja = ysJ[b];
      const jb = ysJ[b + 1];
      let carved = false;
      for (let j = ja; j < jb && !carved; j++) for (let i = ia; i < ib; i++) if (isCarved(i, j)) carved = true;
      if (!carved) {
        // diagonal p00-p11 (matches renAt), counter-clockwise from above
        const p00 = grid[b * w + a];
        const p10 = grid[b * w + a + 1];
        const p01 = grid[(b + 1) * w + a];
        const p11 = grid[(b + 1) * w + a + 1];
        idx.push(p00, p10, p11, p00, p11, p01);
        continue;
      }
      for (let j = ja; j < jb; j++) {
        for (let i = ia; i < ib; i++) {
          const v00 = fineVert(i, j, ia, ja, ib, jb);
          const v10 = fineVert(i + 1, j, ia, ja, ib, jb);
          const v11 = fineVert(i + 1, j + 1, ia, ja, ib, jb);
          const v01 = fineVert(i, j + 1, ia, ja, ib, jb);
          if (!isCarved(i, j)) {
            idx.push(v00, v10, v11, v00, v11, v01);
            continue;
          }
          const cuts = f.cuts.get(j * hw + i);
          if (!cuts || !cuts.length) continue;
          clipTri(v00, v10, v11, cuts);
          clipTri(v00, v11, v01, cuts);
        }
      }
    }
  }
  if (!idx.length) return null;
  // Skirts along the four edges hide cracks against neighbours at another LOD.
  // They hang only as deep as such a crack can be (twice the profile's
  // deviation from 4-cell chords), never into a tunnel roof, and not where a
  // cutting meets the chunk edge (on either side); the inner grid's outer
  // boundary keeps the full depth to cover the seam with the horizon grid.
  const chordDev = (k0: number, step: number, n: number): number => {
    const a0 = H[k0];
    const b0 = H[k0 + n * step];
    let m = 0;
    for (let t = 1; t < n; t++) m = Math.max(m, Math.abs(H[k0 + t * step] - (a0 + ((b0 - a0) * t) / n)));
    return m;
  };
  const skirtDepth = (i: number, j: number, alongX: boolean, boundary: boolean): number => {
    if (boundary) return SKIRT;
    const u = alongX ? i : j;
    const NN = alongX ? nx - 1 : ny - 1;
    const step = alongX ? 1 : nx;
    const rowK = alongX ? j * nx : i;
    let m = 0;
    const w0 = Math.floor(u / 4) * 4;
    for (const s0 of u % 4 === 0 ? [w0 - 4, w0] : [w0]) {
      const a0 = Math.max(0, s0);
      const b0 = Math.min(NN, s0 + 4);
      if (b0 - a0 >= 2) m = Math.max(m, chordDev(rowK + a0 * step, step, b0 - a0));
    }
    return Math.min(SKIRT, 2 * m + 0.3);
  };
  const edge = (list: [number, number, number][], alongX: boolean, boundary: boolean) => {
    const drop = list.map(([vi, i, j]) => {
      const k = j * nx + i;
      const bottom = Math.max(H[k] - skirtDepth(i, j, alongX, boundary), Math.min(H[k], f.floor[k]));
      return P[vi * 3 + 1] - bottom;
    });
    for (let e = 0; e + 1 < list.length; e++) {
      const [a, ia, ja] = list[e];
      const [b, ib, jb] = list[e + 1];
      // no skirt where a cutting meets the chunk edge (it would hang into the cutting)
      let carved = false;
      if (alongX) for (let i = Math.min(ia, ib); i < Math.max(ia, ib) && !carved; i++) carved = isCarved(i, ja) || isCarved(i, ja - 1);
      else for (let j = Math.min(ja, jb); j < Math.max(ja, jb) && !carved; j++) carved = isCarved(ia, j) || isCarved(ia - 1, j);
      if (carved) continue;
      if (drop[e] < 0.05 && drop[e + 1] < 0.05) continue;
      const a2 = put(P[a * 3], P[a * 3 + 1] - drop[e], -P[a * 3 + 2], N[a * 3], N[a * 3 + 1], N[a * 3 + 2]);
      const b2 = put(P[b * 3], P[b * 3 + 1] - drop[e + 1], -P[b * 3 + 2], N[b * 3], N[b * 3 + 1], N[b * 3 + 2]);
      idx.push(a, b, b2, a, b2, a2);
    }
  };
  const iLast = xsI[w - 1];
  const jLast = ysJ[h - 1];
  edge(
    xsI.map((i, a) => [grid[a], i, ysJ[0]]),
    true,
    ysJ[0] === 0,
  );
  edge(
    xsI.map((i, a) => [grid[(h - 1) * w + a], i, jLast]),
    true,
    jLast === ny - 1,
  );
  edge(
    ysJ.map((j, b) => [grid[b * w], xsI[0], j]),
    false,
    xsI[0] === 0,
  );
  edge(
    ysJ.map((j, b) => [grid[b * w + w - 1], iLast, j]),
    false,
    iLast === nx - 1,
  );
  const nv = P.length / 3;
  const nrm = new Int8Array(N.length);
  for (let k = 0; k < N.length; k++) nrm[k] = Math.round(Math.max(-1, Math.min(1, N[k])) * 127);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
  g.setIndex(nv < 65535 ? new THREE.BufferAttribute(Uint16Array.from(idx), 1) : new THREE.BufferAttribute(Uint32Array.from(idx), 1));
  g.computeBoundingSphere();
  return g;
}

export async function buildTerrain(ctx: Ctx, f: TerrainField, mat: THREE.Material, outerMat: THREE.Material): Promise<void> {
  const chunks: LodChunk[] = [];
  for (let cj = 0; cj < f.ny - 1; cj += CH) {
    for (let ci = 0; ci < f.nx - 1; ci += CH) {
      const ci1 = Math.min(f.nx - 1, ci + CH);
      const cj1 = Math.min(f.ny - 1, cj + CH);
      const meshes: THREE.Mesh[] = [];
      for (const s of [1, 2, 4]) {
        const g = chunkGeometry(f, ci, cj, ci1, cj1, s);
        if (!g) continue;
        const m = new THREE.Mesh(g, mat);
        m.receiveShadow = true;
        m.castShadow = s === 1;
        m.name = `terrain-${ci}-${cj}-${s}`;
        m.visible = false;
        ctx.root.add(m);
        meshes.push(m);
      }
      chunks.push({ meshes, x0: f.x0 + ci * f.cell, y0: f.y0 + cj * f.cell, x1: f.x0 + ci1 * f.cell, y1: f.y0 + cj1 * f.cell });
    }
    await yieldFrame();
  }
  ctx.tick.push((_dt, camera) => {
    const px = camera.position.x;
    const py = -camera.position.z;
    const ph = Math.max(0, camera.position.y);
    for (const c of chunks) {
      const dx = Math.max(c.x0 - px, 0, px - c.x1);
      const dy = Math.max(c.y0 - py, 0, py - c.y1);
      const d = Math.hypot(dx, dy) + ph * 0.5;
      const lod = d < 700 ? 0 : d < 2200 ? 1 : 2;
      c.meshes.forEach((m, i) => (m.visible = i === Math.min(lod, c.meshes.length - 1)));
    }
  });

  // ---- outer horizon grid, with the inner area cut out (inner skirts cover the seam)
  const [ex0, ey0, ex1, ey1] = f.extent;
  const OC = 144;
  for (let cj = 0; cj < f.ony - 1; cj += OC) {
    for (let ci = 0; ci < f.onx - 1; ci += OC) {
      const ci1 = Math.min(f.onx - 1, ci + OC);
      const cj1 = Math.min(f.ony - 1, cj + OC);
      // chunks well away from the inner grid use every other sample
      const bx = Math.max(ex0 - (f.ox0 + ci1 * f.ocell), 0, f.ox0 + ci * f.ocell - ex1);
      const by = Math.max(ey0 - (f.oy0 + cj1 * f.ocell), 0, f.oy0 + cj * f.ocell - ey1);
      const st = Math.hypot(bx, by) > 2500 ? 2 : 1;
      const range = (a0: number, a1: number) => {
        const out: number[] = [];
        for (let a = a0; a < a1; a += st) out.push(a);
        out.push(a1);
        return out;
      };
      const is = range(ci, ci1);
      const js = range(cj, cj1);
      const w = is.length;
      const pos: number[] = [];
      const nrm: number[] = [];
      const idx: number[] = [];
      for (const j of js) {
        for (const i of is) {
          const x = f.ox0 + i * f.ocell;
          const y = f.oy0 + j * f.ocell;
          let z = f.oh[j * f.onx + i];
          const inside = x > ex0 + 1 && x < ex1 - 1 && y > ey0 + 1 && y < ey1 - 1;
          if (inside) z -= 6;
          pos.push(x, z, -y);
          const il = Math.max(0, i - 1);
          const ir = Math.min(f.onx - 1, i + 1);
          const jd = Math.max(0, j - 1);
          const ju = Math.min(f.ony - 1, j + 1);
          const gx = (f.oh[j * f.onx + ir] - f.oh[j * f.onx + il]) / ((ir - il) * f.ocell);
          const gy = (f.oh[ju * f.onx + i] - f.oh[jd * f.onx + i]) / ((ju - jd) * f.ocell);
          const l = Math.hypot(gx, 1, gy);
          nrm.push(-gx / l, 1 / l, gy / l);
        }
      }
      for (let jj = 0; jj + 1 < js.length; jj++) {
        for (let ii = 0; ii + 1 < is.length; ii++) {
          const x0 = f.ox0 + is[ii] * f.ocell;
          const y0 = f.oy0 + js[jj] * f.ocell;
          const x1 = f.ox0 + is[ii + 1] * f.ocell;
          const y1 = f.oy0 + js[jj + 1] * f.ocell;
          // skip cells fully inside the inner grid
          if (x0 > ex0 + f.ocell && x1 < ex1 - f.ocell && y0 > ey0 + f.ocell && y1 < ey1 - f.ocell) continue;
          const a = jj * w + ii;
          idx.push(a, a + 1, a + w + 1, a, a + w + 1, a + w);
        }
      }
      if (!idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, outerMat);
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.name = `terrain-outer-${ci}-${cj}`;
      ctx.root.add(m);
    }
  }
}
