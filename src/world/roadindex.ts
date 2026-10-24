/** Spatial index of road centreline segments with carriageway half-widths. */
import { RoadKind, type Road } from '../types';
import { IdGrid } from './util';

export interface Nearest {
  road: number;
  seg: number;
  dist: number;
  /** Unit direction of the segment (map coords, along the way). */
  dx: number;
  dy: number;
  /** Closest point and the road height there. */
  px: number;
  py: number;
  z: number;
}

export class RoadIndex {
  readonly seg: Float32Array;
  /** Height at both ends of each segment. */
  readonly segZ: Float32Array;
  readonly segRoad: Int32Array;
  readonly segHW: Float32Array;
  readonly grid: IdGrid;
  private stamp: Uint32Array;
  private gen = 1;
  readonly maxHW: number;

  constructor(
    readonly roads: Road[],
    bounds: [number, number, number, number],
    include: (r: Road) => boolean = (r) => !r.tunnel,
  ) {
    let n = 0;
    for (const r of roads) if (include(r)) n += (r.pts.length >> 1) - 1;
    this.seg = new Float32Array(n * 4);
    this.segZ = new Float32Array(n * 2);
    this.segRoad = new Int32Array(n);
    this.segHW = new Float32Array(n);
    this.stamp = new Uint32Array(n);
    this.grid = new IdGrid(bounds[0] - 200, bounds[1] - 200, bounds[2] + 200, bounds[3] + 200, 32);
    let k = 0;
    let maxHW = 0;
    roads.forEach((r, ri) => {
      if (!include(r)) return;
      const hw = r.width / 2;
      if (hw > maxHW) maxHW = hw;
      for (let i = 0; i + 3 < r.pts.length; i += 2) {
        const ax = r.pts[i];
        const ay = r.pts[i + 1];
        const bx = r.pts[i + 2];
        const by = r.pts[i + 3];
        this.seg.set([ax, ay, bx, by], k * 4);
        this.segZ[2 * k] = r.z[i >> 1];
        this.segZ[2 * k + 1] = r.z[(i >> 1) + 1];
        this.segRoad[k] = ri;
        this.segHW[k] = hw;
        this.grid.addBox(k, Math.min(ax, bx) - hw, Math.min(ay, by) - hw, Math.max(ax, bx) + hw, Math.max(ay, by) + hw);
        k++;
      }
    });
    this.maxHW = maxHW;
  }

  private segDist(k: number, x: number, y: number): number {
    const s = this.seg;
    const ax = s[4 * k];
    const ay = s[4 * k + 1];
    const dx = s[4 * k + 2] - ax;
    const dy = s[4 * k + 3] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + dx * t - x;
    const ey = ay + dy * t - y;
    return Math.sqrt(ex * ex + ey * ey);
  }

  /**
   * Largest (halfWidth - distance) over carriageways near (x, y), ignoring
   * road `skip`. Positive means the point is on another road's surface.
   */
  penetration(x: number, y: number, skip = -1, filter?: (road: number) => boolean): number {
    let best = -Infinity;
    const g = ++this.gen;
    this.grid.query(x, y, x, y, (k) => {
      if (this.stamp[k] === g) return;
      this.stamp[k] = g;
      const ri = this.segRoad[k];
      if (ri === skip || (filter && !filter(ri))) return;
      const v = this.segHW[k] - this.segDist(k, x, y);
      if (v > best) best = v;
    });
    return best;
  }

  /** Height of segment k at the projection of (x, y). */
  private segZAt(k: number, x: number, y: number): number {
    const s = this.seg;
    const ax = s[4 * k];
    const ay = s[4 * k + 1];
    const dx = s[4 * k + 2] - ax;
    const dy = s[4 * k + 3] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return this.segZ[2 * k] + (this.segZ[2 * k + 1] - this.segZ[2 * k]) * t;
  }

  /** As penetration(), but only roads whose surface there is within dz of z. */
  penetrationZ(x: number, y: number, z: number, dz: number, skip = -1, filter?: (road: number) => boolean): number {
    let best = -Infinity;
    const g = ++this.gen;
    this.grid.query(x, y, x, y, (k) => {
      if (this.stamp[k] === g) return;
      this.stamp[k] = g;
      const ri = this.segRoad[k];
      if (ri === skip || (filter && !filter(ri))) return;
      const v = this.segHW[k] - this.segDist(k, x, y);
      if (v <= best) return;
      if (Math.abs(this.segZAt(k, x, y) - z) > dz) return;
      best = v;
    });
    return best;
  }

  /** Distance from (x, y) to the nearest carriageway edge (negative inside). */
  clearance(x: number, y: number, radius: number, filter?: (road: number) => boolean): number {
    let best = Infinity;
    const g = ++this.gen;
    this.grid.query(x - radius, y - radius, x + radius, y + radius, (k) => {
      if (this.stamp[k] === g) return;
      this.stamp[k] = g;
      if (filter && !filter(this.segRoad[k])) return;
      const v = this.segDist(k, x, y) - this.segHW[k];
      if (v < best) best = v;
    });
    return best;
  }

  nearest(x: number, y: number, radius: number, filter?: (road: number) => boolean): Nearest | null {
    let best: Nearest | null = null;
    const g = ++this.gen;
    this.grid.query(x - radius, y - radius, x + radius, y + radius, (k) => {
      if (this.stamp[k] === g) return;
      this.stamp[k] = g;
      const ri = this.segRoad[k];
      if (filter && !filter(ri)) return;
      const d = this.segDist(k, x, y);
      if (d <= radius && (!best || d < best.dist)) {
        const s = this.seg;
        const ax = s[4 * k];
        const ay = s[4 * k + 1];
        const dx = s[4 * k + 2] - ax;
        const dy = s[4 * k + 3] - ay;
        const l = Math.hypot(dx, dy) || 1;
        let t = ((x - ax) * dx + (y - ay) * dy) / (l * l);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        best = { road: ri, seg: k, dist: d, dx: dx / l, dy: dy / l, px: ax + dx * t, py: ay + dy * t, z: this.segZ[2 * k] + (this.segZ[2 * k + 1] - this.segZ[2 * k]) * t };
      }
    });
    return best;
  }

  /** Visit every road id with a segment within radius of (x, y). */
  roadsNear(x: number, y: number, radius: number, fn: (road: number, seg: number, dist: number) => void): void {
    const g = ++this.gen;
    this.grid.query(x - radius, y - radius, x + radius, y + radius, (k) => {
      if (this.stamp[k] === g) return;
      this.stamp[k] = g;
      const d = this.segDist(k, x, y);
      if (d <= radius) fn(this.segRoad[k], k, d);
    });
  }
}

/** Rank used for draw height (higher ranks draw on top at junctions). */
export function roadRank(r: Road): number {
  switch (r.kind) {
    case RoadKind.Pedestrian:
      return 0;
    case RoadKind.Service:
      return r.bus ? 7 : 1;
    case RoadKind.Residential:
      return 2;
    case RoadKind.Tertiary:
      return 3;
    case RoadKind.Secondary:
      return 4;
    case RoadKind.Primary:
      return 5;
    case RoadKind.Trunk:
      return 6;
    case RoadKind.Busway:
      // station bays draw under the busway they widen (its lane lines stay on top)
      return r.bay ? 6 : 7;
    case RoadKind.Motorway:
      return 8;
  }
  return 1;
}

/** Height of a road's surface above ground. */
export function roadHeight(r: Road): number {
  return 0.02 + roadRank(r) * 0.005;
}
