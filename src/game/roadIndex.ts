// Uniform grid over every road segment for fast "which road am I on" queries.
import { RoadKind, type MapData, type Road } from '../types';

export interface RoadHit {
  road: number;
  seg: number;
  dist: number;
  /** Projection of the query point onto the segment. */
  px: number;
  py: number;
  /** Unit direction of the segment (in the road's drawing direction). */
  dx: number;
  dy: number;
  /** +1 if the query point is left of the segment direction, -1 if right. */
  side: number;
  /** Road surface height at the projection (m AHD). */
  z: number;
}

/** Posted limit in km/h: OSM tag or a Brisbane-ish default for the road class. */
export function speedLimitOf(road: Road): number {
  if (road.maxspeed && road.maxspeed >= 10) return road.maxspeed;
  switch (road.kind) {
    case RoadKind.Motorway:
      return road.link ? 60 : 80;
    case RoadKind.Trunk:
      return road.link ? 50 : 70;
    case RoadKind.Primary:
    case RoadKind.Secondary:
      return 60;
    case RoadKind.Tertiary:
    case RoadKind.Residential:
      return 50;
    case RoadKind.Service:
      return 40;
    case RoadKind.Busway:
      return road.tunnel ? 60 : 80;
    case RoadKind.Pedestrian:
      return 10;
    default:
      return 50;
  }
}

const CELL = 32;

export class RoadIndex {
  readonly sx0: Float32Array;
  readonly sy0: Float32Array;
  readonly sx1: Float32Array;
  readonly sy1: Float32Array;
  readonly sroad: Int32Array;
  readonly sseg: Int32Array;
  private readonly ox: number;
  private readonly oy: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;
  private readonly stamp: Uint32Array;
  private stampId = 1;
  private readonly hit: RoadHit = { road: -1, seg: -1, dist: 0, px: 0, py: 0, dx: 0, dy: 0, side: 1, z: 0 };

  constructor(readonly data: MapData) {
    let n = 0;
    for (const r of data.roads) n += r.pts.length / 2 - 1;
    this.sx0 = new Float32Array(n);
    this.sy0 = new Float32Array(n);
    this.sx1 = new Float32Array(n);
    this.sy1 = new Float32Array(n);
    this.sroad = new Int32Array(n);
    this.sseg = new Int32Array(n);
    let k = 0;
    data.roads.forEach((r, ri) => {
      const p = r.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        this.sx0[k] = p[i];
        this.sy0[k] = p[i + 1];
        this.sx1[k] = p[i + 2];
        this.sy1[k] = p[i + 3];
        this.sroad[k] = ri;
        this.sseg[k] = i / 2;
        k++;
      }
    });
    const [bx0, by0, bx1, by1] = data.bounds;
    this.ox = bx0 - 200;
    this.oy = by0 - 200;
    this.nx = Math.ceil((bx1 - bx0 + 400) / CELL);
    this.ny = Math.ceil((by1 - by0 + 400) / CELL);
    const cells = this.nx * this.ny;
    const counts = new Int32Array(cells + 1);
    const visit = (s: number, fn: (c: number) => void) => {
      const cx0 = this.cx(Math.min(this.sx0[s], this.sx1[s]));
      const cx1 = this.cx(Math.max(this.sx0[s], this.sx1[s]));
      const cy0 = this.cy(Math.min(this.sy0[s], this.sy1[s]));
      const cy1 = this.cy(Math.max(this.sy0[s], this.sy1[s]));
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) fn(cy * this.nx + cx);
    };
    for (let s = 0; s < n; s++) visit(s, (c) => counts[c + 1]++);
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    this.cellItems = new Int32Array(counts[cells]);
    const fill = counts.slice(0, cells);
    for (let s = 0; s < n; s++) visit(s, (c) => (this.cellItems[fill[c]++] = s));
    this.stamp = new Uint32Array(n);
  }

  private cx(x: number): number {
    return Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.ox) / CELL)));
  }
  private cy(y: number): number {
    return Math.max(0, Math.min(this.ny - 1, Math.floor((y - this.oy) / CELL)));
  }

  /**
   * Nearest road segment within `maxDist`. When `heading` is given, only
   * segments whose direction is within acos(minCos) of it are accepted
   * (two-way roads in either direction, one-way roads only forwards).
   * With `zRef`, roads more than `maxDz` above or below it are ignored (a
   * street under a viaduct is not "the road" for a bus on the viaduct).
   * The returned object is reused between calls.
   */
  nearest(
    x: number,
    y: number,
    maxDist: number,
    heading?: number,
    minCos = 0.8,
    accept?: (road: Road) => boolean,
    zRef?: number,
    maxDz = 2.5,
  ): RoadHit | null {
    const roads = this.data.roads;
    const hx = heading !== undefined ? Math.sin(heading) : 0;
    const hy = heading !== undefined ? Math.cos(heading) : 0;
    const cx0 = this.cx(x - maxDist);
    const cx1 = this.cx(x + maxDist);
    const cy0 = this.cy(y - maxDist);
    const cy1 = this.cy(y + maxDist);
    const id = ++this.stampId;
    if (id === 0xffffffff) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    let best = maxDist;
    let bestSeg = -1;
    let bpx = 0;
    let bpy = 0;
    let bdx = 0;
    let bdy = 0;
    let bside = 1;
    let bz = 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * this.nx + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const s = this.cellItems[k];
          if (this.stamp[s] === id) continue;
          this.stamp[s] = id;
          const ax = this.sx0[s];
          const ay = this.sy0[s];
          const dx = this.sx1[s] - ax;
          const dy = this.sy1[s] - ay;
          const len = Math.hypot(dx, dy);
          if (len < 1e-3) continue;
          const ux = dx / len;
          const uy = dy / len;
          let t = (x - ax) * ux + (y - ay) * uy;
          t = t < 0 ? 0 : t > len ? len : t;
          const px = ax + ux * t;
          const py = ay + uy * t;
          const d = Math.hypot(x - px, y - py);
          if (d >= best) continue;
          const road = roads[this.sroad[s]];
          if (heading !== undefined) {
            const dot = ux * hx + uy * hy;
            if (road.oneway ? dot < minCos : Math.abs(dot) < minCos) continue;
          }
          if (accept && !accept(road)) continue;
          const v = this.sseg[s];
          const zz = road.z ? road.z[v] + (road.z[v + 1] - road.z[v]) * (t / len) : 0;
          if (zRef !== undefined && Math.abs(zz - zRef) > maxDz) continue;
          best = d;
          bz = zz;
          bestSeg = s;
          bpx = px;
          bpy = py;
          bdx = ux;
          bdy = uy;
          bside = ux * (y - ay) - uy * (x - ax) >= 0 ? 1 : -1;
        }
      }
    }
    if (bestSeg < 0) return null;
    const h = this.hit;
    h.road = this.sroad[bestSeg];
    h.seg = this.sseg[bestSeg];
    h.dist = best;
    h.px = bpx;
    h.py = bpy;
    h.dx = bdx;
    h.dy = bdy;
    h.side = bside;
    h.z = bz;
    return h;
  }
}

const cache = new WeakMap<MapData, RoadIndex>();
export function roadIndexFor(data: MapData): RoadIndex {
  let idx = cache.get(data);
  if (!idx) {
    idx = new RoadIndex(data);
    cache.set(data, idx);
  }
  return idx;
}

/** Roads a vehicle can be "on" (not footpaths). */
export const drivable = (r: Road): boolean => r.kind !== RoadKind.Pedestrian;
