/**
 * Height queries shared by the world, physics and traffic.
 *
 * - `ground(x, y)`: natural terrain (at-grade roads are burned into it); inside a walled station
 *   cutting's outline, its floor (src/data/cuts.ts).
 * - `surfaceAt(x, y, hintZ)`: the road surface a vehicle at (x, y) is on.
 *   Where roads stack (viaduct over a street, street over a tunnel) the hint
 *   (the vehicle's current height) picks the level, so a bus in the King
 *   George Square tunnel stays underground and one on the South East Busway
 *   viaduct stays up. Off any road it falls back to the ground.
 * - `routeZ(route, s)`: height along a route polyline (exact, for AI buses).
 *
 * All heights are metres AHD; three.js y = height.
 */
import type { MapData, Road, Route, TerrainGrids } from '../types';
import { type CutIndex, cutIndexFor } from './cuts';

export interface Surface {
  z: number;
  /** Index into MapData.roads, or -1 when on open ground. */
  road: number;
  /** Signed distance from the road edge (negative = inside the carriageway). */
  edge: number;
}

const CELL = 24;
/** How far beyond the carriageway edge a road still counts (kerbs, verges). */
const EDGE_MARGIN = 1.5;

export class Heights {
  readonly waterLevel: number;
  private readonly t: TerrainGrids;
  private readonly roads: Road[];
  private readonly x0: number;
  private readonly y0: number;
  private readonly nx: number;
  private readonly ny: number;
  /** Per cell: start offset into `segs`; segment entries are (road << 12 | vertex). */
  private readonly start: Uint32Array;
  private readonly segs: Uint32Array;
  /** Walled station cuttings: the floor inside their outlines. */
  readonly cuts: CutIndex;

  constructor(data: MapData) {
    this.t = data.terrain;
    this.cuts = cutIndexFor(data.terrain);
    this.waterLevel = data.terrain.waterLevel;
    this.roads = data.roads;
    const [bx0, by0, bx1, by1] = data.bounds;
    this.x0 = bx0 - 200;
    this.y0 = by0 - 200;
    this.nx = Math.ceil((bx1 - bx0 + 400) / CELL);
    this.ny = Math.ceil((by1 - by0 + 400) / CELL);
    const counts = new Uint32Array(this.nx * this.ny + 1);
    const visit = (fn: (cell: number, entry: number) => void) => {
      this.roads.forEach((r, ri) => {
        const p = r.pts;
        const pad = r.width / 2 + EDGE_MARGIN;
        for (let v = 0; v + 3 < p.length; v += 2) {
          const ix0 = this.cx(Math.min(p[v], p[v + 2]) - pad);
          const ix1 = this.cx(Math.max(p[v], p[v + 2]) + pad);
          const iy0 = this.cy(Math.min(p[v + 1], p[v + 3]) - pad);
          const iy1 = this.cy(Math.max(p[v + 1], p[v + 3]) + pad);
          for (let j = iy0; j <= iy1; j++) for (let i = ix0; i <= ix1; i++) fn(j * this.nx + i, (ri << 12) | (v >> 1));
        }
      });
    };
    visit((c) => counts[c + 1]++);
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    this.start = counts;
    this.segs = new Uint32Array(counts[counts.length - 1]);
    const fill = counts.slice(0, -1);
    visit((c, e) => {
      this.segs[fill[c]++] = e;
    });
  }

  private cx(x: number): number {
    return Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.x0) / CELL)));
  }
  private cy(y: number): number {
    return Math.max(0, Math.min(this.ny - 1, Math.floor((y - this.y0) / CELL)));
  }

  /** Terrain height (m AHD), bilinear; fine grid inside the map, coarse horizon grid outside; a walled station cutting's floor inside its outline. */
  ground(x: number, y: number): number {
    const f = this.cuts.floorAt(x, y);
    if (f === f) return f;
    for (const g of this.t.grids) {
      const fx = (x - g.x0) / g.cell;
      const fy = (y - g.y0) / g.cell;
      if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) continue;
      const i = Math.min(g.nx - 2, Math.floor(fx));
      const j = Math.min(g.ny - 2, Math.floor(fy));
      const tx = fx - i;
      const ty = fy - j;
      const k = j * g.nx + i;
      const h = g.h;
      return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - ty) + (h[k + g.nx] * (1 - tx) + h[k + g.nx + 1] * tx) * ty;
    }
    return this.waterLevel;
  }

  /**
   * Road surface under (x, y). With `hintZ` (the vehicle's current height) the
   * level closest to it wins, and levels more than `maxStep` away are ignored
   * (you can't jump onto a viaduct from the street below). Without a hint the
   * road closest to the ground wins. With `heading` (the vehicle's, compass
   * radians) a road running the vehicle's way wins over one crossing it at
   * about the same level, so a side street's mouth doesn't capture the height
   * of the road the vehicle drives along.
   */
  surfaceAt(x: number, y: number, hintZ?: number, maxStep = 2.5, heading?: number): Surface {
    const c = this.cy(y) * this.nx + this.cx(x);
    let best: Surface | null = null;
    let bestScore = Infinity;
    const ref = hintZ ?? this.ground(x, y);
    const hx = heading === undefined ? 0 : Math.sin(heading);
    const hy = heading === undefined ? 0 : Math.cos(heading);
    for (let k = this.start[c]; k < this.start[c + 1]; k++) {
      const e = this.segs[k];
      const ri = e >>> 12;
      const v = e & 0xfff;
      const r = this.roads[ri];
      const p = r.pts;
      const ax = p[2 * v];
      const ay = p[2 * v + 1];
      const dx = p[2 * v + 2] - ax;
      const dy = p[2 * v + 3] - ay;
      const len2 = dx * dx + dy * dy || 1e-9;
      const tr = ((x - ax) * dx + (y - ay) * dy) / len2;
      const t = tr < 0 ? 0 : tr > 1 ? 1 : tr;
      const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
      const edge = d - r.width / 2;
      if (edge > EDGE_MARGIN) continue;
      const z = r.z[v] + (r.z[v + 1] - r.z[v]) * t;
      const dz = Math.abs(z - ref);
      if (hintZ !== undefined && dz > maxStep) continue;
      // Prefer the right level first, then being inside the carriageway. Past the end of a segment the
      // clamped end is flat at the vertex height: the next segment of the road (or a road beyond its end)
      // is the surface there, else a grade turns into a step a few metres on.
      const len = Math.sqrt(len2);
      const past = (tr < 0 ? -tr : tr > 1 ? tr - 1 : 0) * len;
      let score = dz * 4 + Math.max(0, edge) + past * 2;
      if (heading !== undefined) score += (1 - Math.abs((dx * hx + dy * hy) / len)) * 4;
      if (score < bestScore) {
        bestScore = score;
        best = { z, road: ri, edge };
      }
    }
    if (best) return best;
    return { z: this.ground(x, y), road: -1, edge: Infinity };
  }

  /** Height along a route polyline at distance s (exact; for AI buses and route graphics). */
  routeZ(route: Route, s: number): number {
    const cum = route.cum;
    const n = cum.length;
    if (s <= 0) return route.z[0];
    if (s >= cum[n - 1]) return route.z[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const t = (s - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
    return route.z[lo] + (route.z[hi] - route.z[lo]) * t;
  }

  /** Height along a road polyline at vertex segment v, fraction t. */
  roadZ(road: Road, v: number, t: number): number {
    const z = road.z;
    if (v >= z.length - 1) return z[z.length - 1];
    return z[v] + (z[v + 1] - z[v]) * t;
  }
}

let shared: Heights | null = null;

/** One shared instance per map (the spatial index takes ~100 ms to build). */
export function heightsFor(data: MapData): Heights {
  if (!shared) shared = new Heights(data);
  return shared;
}
