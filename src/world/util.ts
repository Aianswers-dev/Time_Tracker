/** Small shared helpers for the world builder: buffers, grids, polygons, randomness. */

export const yieldFrame = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Deterministic randomness

/** Integer hash -> [0, 1). */
export function hash1(n: number): number {
  let h = Math.imul(n | 0, 0x27d4eb2d) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Hash of a 2D position (metres) -> [0, 1). */
export function hash2(x: number, y: number, salt = 0): number {
  return hash1(Math.imul(Math.round(x * 4), 73856093) ^ Math.imul(Math.round(y * 4), 19349663) ^ Math.imul(salt, 83492791));
}

/** Mulberry32 PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Growable typed arrays

type TypedCtor<T> = { new (n: number): T };
interface TypedLike {
  length: number;
  set(a: ArrayLike<number>, offset?: number): void;
  subarray(a: number, b: number): this;
  [i: number]: number;
}

export class Buf<T extends TypedLike> {
  arr: T;
  len = 0;
  constructor(
    private readonly ctor: TypedCtor<T>,
    cap = 1024,
  ) {
    this.arr = new ctor(cap);
  }
  private grow(need: number): void {
    let cap = this.arr.length;
    while (cap < need) cap *= 2;
    const n = new this.ctor(cap);
    n.set(this.arr);
    this.arr = n;
  }
  push(a: number): void {
    if (this.len + 1 > this.arr.length) this.grow(this.len + 1);
    this.arr[this.len++] = a;
  }
  push2(a: number, b: number): void {
    if (this.len + 2 > this.arr.length) this.grow(this.len + 2);
    const r = this.arr;
    r[this.len] = a;
    r[this.len + 1] = b;
    this.len += 2;
  }
  push3(a: number, b: number, c: number): void {
    if (this.len + 3 > this.arr.length) this.grow(this.len + 3);
    const r = this.arr;
    r[this.len] = a;
    r[this.len + 1] = b;
    r[this.len + 2] = c;
    this.len += 3;
  }
  push4(a: number, b: number, c: number, d: number): void {
    if (this.len + 4 > this.arr.length) this.grow(this.len + 4);
    const r = this.arr;
    r[this.len] = a;
    r[this.len + 1] = b;
    r[this.len + 2] = c;
    r[this.len + 3] = d;
    this.len += 4;
  }
  /** Copy of the used part. */
  take(): T {
    const out = new this.ctor(this.len);
    out.set(this.arr.subarray(0, this.len));
    return out;
  }
  clear(): void {
    this.len = 0;
  }
}

export const f32 = (cap = 1024): Buf<Float32Array> => new Buf(Float32Array, cap);
export const u8 = (cap = 1024): Buf<Uint8Array> => new Buf(Uint8Array, cap);
export const u32 = (cap = 1024): Buf<Uint32Array> => new Buf(Uint32Array, cap);
export const i8 = (cap = 1024): Buf<Int8Array> => new Buf(Int8Array, cap);

// ---------------------------------------------------------------------------
// Bucket grid of integer ids (build once, query many)

export class IdGrid {
  readonly nx: number;
  readonly ny: number;
  private cells: number[][];
  constructor(
    readonly x0: number,
    readonly y0: number,
    x1: number,
    y1: number,
    readonly cell: number,
  ) {
    this.nx = Math.max(1, Math.ceil((x1 - x0) / cell));
    this.ny = Math.max(1, Math.ceil((y1 - y0) / cell));
    this.cells = new Array<number[]>(this.nx * this.ny);
  }
  private cx(x: number): number {
    return clamp(Math.floor((x - this.x0) / this.cell), 0, this.nx - 1);
  }
  private cy(y: number): number {
    return clamp(Math.floor((y - this.y0) / this.cell), 0, this.ny - 1);
  }
  addBox(id: number, ax: number, ay: number, bx: number, by: number): void {
    const i0 = this.cx(Math.min(ax, bx));
    const i1 = this.cx(Math.max(ax, bx));
    const j0 = this.cy(Math.min(ay, by));
    const j1 = this.cy(Math.max(ay, by));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.nx + i;
        (this.cells[k] ??= []).push(id);
      }
    }
  }
  addPoint(id: number, x: number, y: number): void {
    const k = this.cy(y) * this.nx + this.cx(x);
    (this.cells[k] ??= []).push(id);
  }
  /** Calls fn for every id in cells overlapping the box (ids may repeat across cells). */
  query(ax: number, ay: number, bx: number, by: number, fn: (id: number) => void): void {
    const i0 = this.cx(ax);
    const i1 = this.cx(bx);
    const j0 = this.cy(ay);
    const j1 = this.cy(by);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = this.cells[j * this.nx + i];
        if (c) for (let n = 0; n < c.length; n++) fn(c[n]);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Raster mask over the map (bit flags per cell)

export const MASK_WATER = 1;
export const MASK_GREEN = 2;
export const MASK_BUILDING = 4;
export const MASK_POOL = 8;
export const MASK_SPORT = 16;
export const MASK_RAIL = 32;
export const MASK_PLAZA = 64;

export class Mask {
  readonly nx: number;
  readonly ny: number;
  readonly bits: Uint8Array;
  constructor(
    readonly x0: number,
    readonly y0: number,
    x1: number,
    y1: number,
    readonly cell: number,
  ) {
    this.nx = Math.ceil((x1 - x0) / cell);
    this.ny = Math.ceil((y1 - y0) / cell);
    this.bits = new Uint8Array(this.nx * this.ny);
  }
  get(x: number, y: number): number {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((y - this.y0) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return 0;
    return this.bits[j * this.nx + i];
  }
  has(x: number, y: number, flag: number): boolean {
    return (this.get(x, y) & flag) !== 0;
  }
  /** True if any cell within radius r (box) has the flag. */
  near(x: number, y: number, r: number, flag: number): boolean {
    const i0 = Math.max(0, Math.floor((x - r - this.x0) / this.cell));
    const i1 = Math.min(this.nx - 1, Math.floor((x + r - this.x0) / this.cell));
    const j0 = Math.max(0, Math.floor((y - r - this.y0) / this.cell));
    const j1 = Math.min(this.ny - 1, Math.floor((y + r - this.y0) / this.cell));
    for (let j = j0; j <= j1; j++) {
      const row = j * this.nx;
      for (let i = i0; i <= i1; i++) if (this.bits[row + i] & flag) return true;
    }
    return false;
  }
  /** Scanline fill of polygon rings (even-odd rule) with a flag. Rings are flat [x,y,...]. */
  fillRings(rings: ArrayLike<number>[], flag: number): void {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const r of rings) {
      for (let i = 1; i < r.length; i += 2) {
        if (r[i] < minY) minY = r[i];
        if (r[i] > maxY) maxY = r[i];
      }
    }
    const j0 = Math.max(0, Math.floor((minY - this.y0) / this.cell));
    const j1 = Math.min(this.ny - 1, Math.floor((maxY - this.y0) / this.cell));
    const xs: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + (j + 0.5) * this.cell;
      xs.length = 0;
      for (const r of rings) {
        const n = r.length >> 1;
        for (let a = 0, b = n - 1; a < n; b = a++) {
          const ay = r[2 * a + 1];
          const by = r[2 * b + 1];
          if (ay > y !== by > y) {
            const ax = r[2 * a];
            const bx = r[2 * b];
            xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
          }
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      const row = j * this.nx;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - this.x0) / this.cell - 0.5));
        const i1 = Math.min(this.nx - 1, Math.floor((xs[k + 1] - this.x0) / this.cell - 0.5));
        for (let i = i0; i <= i1; i++) this.bits[row + i] |= flag;
      }
    }
  }
  /** Stamp a thick polyline. */
  fillLine(pts: ArrayLike<number>, halfWidth: number, flag: number): void {
    const step = this.cell * 0.5;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i];
      const ay = pts[i + 1];
      const dx = pts[i + 2] - ax;
      const dy = pts[i + 3] - ay;
      const len = Math.hypot(dx, dy);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k <= n; k++) {
        const x = ax + (dx * k) / n;
        const y = ay + (dy * k) / n;
        const i0 = Math.max(0, Math.floor((x - halfWidth - this.x0) / this.cell));
        const i1 = Math.min(this.nx - 1, Math.floor((x + halfWidth - this.x0) / this.cell));
        const j0 = Math.max(0, Math.floor((y - halfWidth - this.y0) / this.cell));
        const j1 = Math.min(this.ny - 1, Math.floor((y + halfWidth - this.y0) / this.cell));
        for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) this.bits[j * this.nx + ii] |= flag;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Polygons (flat [x, y, ...] rings, not closed)

export function signedArea(r: ArrayLike<number>): number {
  let a = 0;
  const n = r.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) a += (r[2 * j] - r[2 * i]) * (r[2 * j + 1] + r[2 * i + 1]);
  return a * 0.5;
}

/** Returns a copy oriented counter-clockwise (positive area) or clockwise. */
export function oriented(r: ArrayLike<number>, ccw: boolean): Float32Array {
  const out = Float32Array.from(r);
  if (signedArea(r) > 0 !== ccw) {
    const n = out.length >> 1;
    for (let i = 0; i < n >> 1; i++) {
      const j = n - 1 - i;
      const tx = out[2 * i];
      const ty = out[2 * i + 1];
      out[2 * i] = out[2 * j];
      out[2 * i + 1] = out[2 * j + 1];
      out[2 * j] = tx;
      out[2 * j + 1] = ty;
    }
  }
  return out;
}

export function pointInRing(x: number, y: number, r: ArrayLike<number>): boolean {
  let inside = false;
  const n = r.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = r[2 * i + 1];
    const yj = r[2 * j + 1];
    if (yi > y !== yj > y && x < ((r[2 * j] - r[2 * i]) * (y - yi)) / (yj - yi) + r[2 * i]) inside = !inside;
  }
  return inside;
}

export function ringBounds(r: ArrayLike<number>): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < x0) x0 = r[i];
    if (r[i] > x1) x1 = r[i];
    if (r[i + 1] < y0) y0 = r[i + 1];
    if (r[i + 1] > y1) y1 = r[i + 1];
  }
  return [x0, y0, x1, y1];
}

export function centroid(r: ArrayLike<number>): [number, number] {
  let x = 0;
  let y = 0;
  const n = r.length >> 1;
  for (let i = 0; i < n; i++) {
    x += r[2 * i];
    y += r[2 * i + 1];
  }
  return [x / n, y / n];
}

/** Oriented bounding box via the longest edge direction: centre, axis (unit), half extents. */
export function obb(r: ArrayLike<number>): { cx: number; cy: number; ux: number; uy: number; hl: number; hw: number; fill: number } {
  const n = r.length >> 1;
  let best = 0;
  let ux = 1;
  let uy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = r[2 * j] - r[2 * i];
    const dy = r[2 * j + 1] - r[2 * i + 1];
    const l = dx * dx + dy * dy;
    if (l > best) {
      best = l;
      const s = Math.sqrt(l);
      ux = dx / s;
      uy = dy / s;
    }
  }
  let a0 = Infinity;
  let a1 = -Infinity;
  let b0 = Infinity;
  let b1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = r[2 * i];
    const y = r[2 * i + 1];
    const a = x * ux + y * uy;
    const b = -x * uy + y * ux;
    if (a < a0) a0 = a;
    if (a > a1) a1 = a;
    if (b < b0) b0 = b;
    if (b > b1) b1 = b;
  }
  const ca = (a0 + a1) / 2;
  const cb = (b0 + b1) / 2;
  let hl = (a1 - a0) / 2;
  let hw = (b1 - b0) / 2;
  const area = Math.abs(signedArea(r));
  const fill = area / Math.max(1e-6, 4 * hl * hw);
  const cx = ca * ux - cb * uy;
  const cy = ca * uy + cb * ux;
  if (hw > hl) {
    // keep u along the long side
    const t = hl;
    hl = hw;
    hw = t;
    const nux = -uy;
    const nuy = ux;
    ux = nux;
    uy = nuy;
  }
  return { cx, cy, ux, uy, hl, hw, fill };
}

/** Distance from point to segment, and the parameter t. */
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + dx * t - px;
  const y = ay + dy * t - py;
  return Math.sqrt(x * x + y * y);
}

/** Polyline length. */
export function polyLength(p: ArrayLike<number>): number {
  let l = 0;
  for (let i = 2; i < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return l;
}

/** Resample a polyline: calls fn(x, y, dirX, dirY, s) every `step` metres (and at the end). */
export function walk(p: ArrayLike<number>, step: number, fn: (x: number, y: number, dx: number, dy: number, s: number) => void, offset = 0): void {
  let s = 0;
  let next = offset;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i];
    const ay = p[i + 1];
    const dx = p[i + 2] - ax;
    const dy = p[i + 3] - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uy = dy / len;
    while (next <= s + len) {
      const t = next - s;
      fn(ax + ux * t, ay + uy * t, ux, uy, next);
      next += step;
    }
    s += len;
  }
}

/** Convert a hex colour string to [r, g, b] 0..255. */
export function hexRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
