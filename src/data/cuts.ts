/**
 * Walled station cuttings (MapData.terrain.cuts, from tools/data/stations.py station_cuts): Buranda and
 * Mater Hill busway stations stand between vertical walls, in cuttings a 10 m terrain grid can't hold.
 * Inside an outline the ground is the cutting's floor (a plane); outside it the grid, which keeps the
 * streets' level up to the walls.
 *
 * `CutIndex.at(x, y)` is O(1): a coarse 64 m cell table names the cuttings near (x, y) (one, in
 * practice), and each cutting's own 2 m cells are outside, inside, or on its outline, where only the
 * few convex pieces of the outline that overlap the cell are tested (a handful of half-planes each).
 */
import type { StationCut, TerrainGrids } from '../types';

/** A convex piece of a cutting's outline: corners counter-clockwise, as half-planes hx x + hy y <= hd. */
export interface CutPiece {
  /** Index into CutIndex.cuts. */
  cut: number;
  /** Corners, flat [x, y, ...] counter-clockwise. */
  pts: number[];
  hx: number[];
  hy: number[];
  hd: number[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const COARSE = 64;
const CELL = 2;
/** Fine cell states. */
const OUT = 0;
const IN = 1;
const EDGE = 2;

interface FineGrid {
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  state: Uint8Array;
  /** Per cell: start offset into `items` (pieces overlapping an EDGE cell). */
  start: Uint32Array;
  items: Uint16Array;
}

export class CutIndex {
  readonly cuts: StationCut[];
  readonly pieces: CutPiece[] = [];
  private readonly fine: FineGrid[] = [];
  private readonly bx0: number = Infinity;
  private readonly by0: number = Infinity;
  private readonly bx1: number = -Infinity;
  private readonly by1: number = -Infinity;
  private readonly cnx: number = 0;
  private readonly cStart: Uint32Array = new Uint32Array(1);
  private readonly cItems: Uint16Array = new Uint16Array(0);

  constructor(cuts: StationCut[] = []) {
    this.cuts = cuts;
    if (!cuts.length) return;
    cuts.forEach((c, k) => {
      for (const poly of convexPieces(c.pts)) this.pieces.push(makePiece(k, poly));
    });
    for (let k = 0; k < cuts.length; k++) {
      const p = cuts[k].pts;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) {
        x0 = Math.min(x0, p[i]);
        x1 = Math.max(x1, p[i]);
        y0 = Math.min(y0, p[i + 1]);
        y1 = Math.max(y1, p[i + 1]);
      }
      this.bx0 = Math.min(this.bx0, x0);
      this.by0 = Math.min(this.by0, y0);
      this.bx1 = Math.max(this.bx1, x1);
      this.by1 = Math.max(this.by1, y1);
      this.fine.push(this.buildFine(k, Math.floor(x0 / CELL) * CELL - CELL, Math.floor(y0 / CELL) * CELL - CELL, x1, y1));
    }
    // coarse table over the cuttings' joint box: which cuttings' boxes reach each cell
    this.cnx = Math.floor((this.bx1 - this.bx0) / COARSE) + 1;
    const cny = Math.floor((this.by1 - this.by0) / COARSE) + 1;
    const lists: number[][] = Array.from({ length: this.cnx * cny }, () => []);
    this.fine.forEach((g, k) => {
      const i0 = Math.max(0, Math.floor((g.x0 - this.bx0) / COARSE));
      const i1 = Math.min(this.cnx - 1, Math.floor((g.x0 + g.nx * CELL - this.bx0) / COARSE));
      const j0 = Math.max(0, Math.floor((g.y0 - this.by0) / COARSE));
      const j1 = Math.min(cny - 1, Math.floor((g.y0 + g.ny * CELL - this.by0) / COARSE));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) lists[j * this.cnx + i].push(k);
    });
    this.cStart = new Uint32Array(lists.length + 1);
    for (let c = 0; c < lists.length; c++) this.cStart[c + 1] = this.cStart[c] + lists[c].length;
    this.cItems = Uint16Array.from(lists.flat());
  }

  private buildFine(k: number, x0: number, y0: number, xMax: number, yMax: number): FineGrid {
    const ring = this.cuts[k].pts;
    const nx = Math.ceil((xMax - x0) / CELL) + 2;
    const ny = Math.ceil((yMax - y0) / CELL) + 2;
    const state = new Uint8Array(nx * ny);
    const lists: number[][] = [];
    const n = ring.length / 2;
    const mine = this.pieces.map((p, i) => [p, i] as const).filter(([p]) => p.cut === k);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const cx0 = x0 + i * CELL;
        const cy0 = y0 + j * CELL;
        let edge = false;
        for (let e = 0, f = n - 1; e < n && !edge; f = e++) edge = segMeetsBox(ring[2 * f], ring[2 * f + 1], ring[2 * e], ring[2 * e + 1], cx0, cy0, cx0 + CELL, cy0 + CELL);
        const c = j * nx + i;
        if (edge) {
          state[c] = EDGE;
          const l: number[] = [];
          for (const [p, pi] of mine) if (p.x0 <= cx0 + CELL && p.x1 >= cx0 && p.y0 <= cy0 + CELL && p.y1 >= cy0) l.push(pi);
          lists[c] = l;
        } else state[c] = pointInRing(ring, cx0 + CELL / 2, cy0 + CELL / 2) ? IN : OUT;
      }
    }
    const start = new Uint32Array(nx * ny + 1);
    for (let c = 0; c < nx * ny; c++) start[c + 1] = start[c] + (lists[c]?.length ?? 0);
    const items = new Uint16Array(start[nx * ny]);
    for (let c = 0; c < nx * ny; c++) if (lists[c]) items.set(lists[c], start[c]);
    return { x0, y0, nx, ny, state, start, items };
  }

  /** Index (into `cuts`) of the cutting whose outline holds (x, y), or -1. */
  at(x: number, y: number): number {
    if (x < this.bx0 || x > this.bx1 || y < this.by0 || y > this.by1) return -1;
    const c = Math.floor((y - this.by0) / COARSE) * this.cnx + Math.floor((x - this.bx0) / COARSE);
    for (let q = this.cStart[c]; q < this.cStart[c + 1]; q++) {
      const k = this.cItems[q];
      const g = this.fine[k];
      const i = Math.floor((x - g.x0) / CELL);
      const j = Math.floor((y - g.y0) / CELL);
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
      const cell = j * g.nx + i;
      const s = g.state[cell];
      if (s === IN) return k;
      if (s === OUT) continue;
      for (let t = g.start[cell]; t < g.start[cell + 1]; t++) if (pieceHas(this.pieces[g.items[t]], x, y)) return k;
    }
    return -1;
  }

  /** True if (x, y) lies inside a cutting's outline. */
  has(x: number, y: number): boolean {
    return this.at(x, y) >= 0;
  }

  /** Floor of cutting k at (x, y) (m AHD). */
  floor(k: number, x: number, y: number): number {
    const f = this.cuts[k].floor;
    return f[0] + f[1] * x + f[2] * y;
  }

  /** The floor at (x, y) if it lies inside a cutting's outline, else NaN. */
  floorAt(x: number, y: number): number {
    if (x < this.bx0 || x > this.bx1 || y < this.by0 || y > this.by1) return NaN;
    const k = this.at(x, y);
    return k < 0 ? NaN : this.floor(k, x, y);
  }

  /** Whether any cutting's box meets the box [x0, x1] x [y0, y1]. */
  near(x0: number, y0: number, x1: number, y1: number): boolean {
    return x1 >= this.bx0 && x0 <= this.bx1 && y1 >= this.by0 && y0 <= this.by1;
  }
}

const shared = new WeakMap<TerrainGrids, CutIndex>();

/** One shared index per map (Heights and the world's TerrainField read the same one). */
export function cutIndexFor(terrain: TerrainGrids): CutIndex {
  let c = shared.get(terrain);
  if (!c) shared.set(terrain, (c = new CutIndex(terrain.cuts ?? [])));
  return c;
}

export function pieceHas(p: CutPiece, x: number, y: number): boolean {
  if (x < p.x0 || x > p.x1 || y < p.y0 || y > p.y1) return false;
  for (let h = 0; h < p.hx.length; h++) if (p.hx[h] * x + p.hy[h] * y > p.hd[h] + 1e-9) return false;
  return true;
}

function makePiece(cut: number, pts: number[]): CutPiece {
  const hx: number[] = [];
  const hy: number[] = [];
  const hd: number[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const n = pts.length / 2;
  for (let k = 0; k < n; k++) {
    const ax = pts[2 * k];
    const ay = pts[2 * k + 1];
    const ex = pts[(2 * k + 2) % pts.length] - ax;
    const ey = pts[(2 * k + 3) % pts.length] - ay;
    const l = Math.hypot(ex, ey);
    x0 = Math.min(x0, ax);
    x1 = Math.max(x1, ax);
    y0 = Math.min(y0, ay);
    y1 = Math.max(y1, ay);
    if (l < 1e-6) continue;
    // interior on the left of a counter-clockwise edge: the outward normal is (ey, -ex)
    hx.push(ey / l);
    hy.push(-ex / l);
    hd.push((ey * ax - ex * ay) / l);
  }
  return { cut, pts, hx, hy, hd, x0, y0, x1, y1 };
}

/** Crossing-number test (construction only). */
function pointInRing(p: ArrayLike<number>, x: number, y: number): boolean {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = p[2 * j];
    const ay = p[2 * j + 1];
    const bx = p[2 * i];
    const by = p[2 * i + 1];
    if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
  }
  return inside;
}

/** Does segment a-b meet the box [x0, x1] x [y0, y1]? (Liang-Barsky clip.) */
function segMeetsBox(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dy, ay - y0) && clip(dy, y1 - ay) && t0 <= t1;
}

/**
 * A counter-clockwise simple polygon (flat x, y) as convex pieces: ear-clipped into triangles, then
 * neighbouring pieces merged while the union stays convex (Hertel-Mehlhorn).
 */
export function convexPieces(ring: ArrayLike<number>): number[][] {
  const n = ring.length / 2;
  const X = (i: number) => ring[2 * i];
  const Y = (i: number) => ring[2 * i + 1];
  const cross = (a: number, b: number, c: number) => (X(b) - X(a)) * (Y(c) - Y(a)) - (Y(b) - Y(a)) * (X(c) - X(a));
  const inTri = (q: number, a: number, b: number, c: number) => cross(a, b, q) >= -1e-9 && cross(b, c, q) >= -1e-9 && cross(c, a, q) >= -1e-9;
  const idx = Array.from({ length: n }, (_, i) => i);
  const polys: number[][] = [];
  while (idx.length > 3) {
    let cut = -1;
    for (let i = 0; i < idx.length && cut < 0; i++) {
      const a = idx[(i + idx.length - 1) % idx.length];
      const b = idx[i];
      const c = idx[(i + 1) % idx.length];
      if (cross(a, b, c) <= 1e-9) continue; // reflex or straight
      let ok = true;
      for (const q of idx) if (q !== a && q !== b && q !== c && inTri(q, a, b, c)) ok = false;
      if (ok) {
        polys.push([a, b, c]);
        cut = i;
      }
    }
    if (cut < 0) {
      // only straight corners left: drop one and go on
      const s = idx.findIndex((b, i) => Math.abs(cross(idx[(i + idx.length - 1) % idx.length], b, idx[(i + 1) % idx.length])) <= 1e-9);
      if (s < 0) break;
      idx.splice(s, 1);
      continue;
    }
    idx.splice(cut, 1);
  }
  if (idx.length === 3 && cross(idx[0], idx[1], idx[2]) > 1e-9) polys.push(idx.slice());
  const convex = (p: number[]) => p.every((b, i) => cross(p[(i + p.length - 1) % p.length], b, p[(i + 1) % p.length]) >= -1e-9);
  // A: ... u v ...  and  B: ... v u ...  joined along u-v
  const join = (A: number[], B: number[]): number[] | null => {
    for (let a = 0; a < A.length; a++) {
      const u = A[a];
      const v = A[(a + 1) % A.length];
      const b = B.indexOf(v);
      if (b < 0 || B[(b + 1) % B.length] !== u) continue;
      const out: number[] = [];
      for (let k = 0; k < A.length; k++) out.push(A[(a + 1 + k) % A.length]);
      for (let k = 2; k < B.length; k++) out.push(B[(b + k) % B.length]);
      return out;
    }
    return null;
  };
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < polys.length && !merged; i++) {
      for (let j = i + 1; j < polys.length && !merged; j++) {
        const m = join(polys[i], polys[j]);
        if (m && convex(m)) {
          polys[i] = m;
          polys.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  return polys.map((p) => p.flatMap((i) => [X(i), Y(i)]));
}
