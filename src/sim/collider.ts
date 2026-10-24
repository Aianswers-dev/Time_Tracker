/**
 * Static collision in 3D, plus the map queries the driving subsystem needs
 * (road surface and level, river, nearest road for resets, line of sight for
 * cameras).
 *
 * Layers: a building only collides when its vertical span (lowest ground under
 * its footprint, or its min_height, up to its roof) overlaps the bus's span, so
 * buses pass under buildings in the Queen Street / King George Square tunnels
 * and over them on viaducts.
 *
 * Edge walls (generated from the road network):
 *  - tunnel walls along both edges of tunnel roads (to ~4.6 m above the road),
 *  - parapets along both edges of bridges and viaducts (to 1.1 m above the deck),
 *  - retaining walls where a road runs in a cutting more than 1.5 m below the
 *    ground beside it (to 1 m above that ground, so it also fences the top).
 * A wall piece is left out wherever the space beyond it is another carriageway
 * at the same level (junction mouths, merges, slip lanes, adjacent bays) or a
 * bus route crosses it, so real routes stay drivable.
 *
 * Buildings a road centreline (or a bus route corridor) passes through at the
 * same level are dropped: awnings, over-road structures, footprints mapped
 * across a carriageway.
 *
 * Contacts: each section is an oriented rectangle with a vertical span. Bus
 * corners inside a footprint are pushed to its nearest edge; footprint and
 * wall-end vertices inside the rectangle push out through the nearest face;
 * corners across a wall line are pushed back to the side the bus came from.
 * Deepest first, a few iterations per frame.
 */
import type { BusPose, BusSpec, Collider, MapData, Road } from '../types';
import { BuildingKind, RoadKind } from '../types';
import { heightsFor, type Heights, type Surface } from '../data/height';

export interface RoadSnap {
  x: number;
  y: number;
  /** Road surface height at the snapped point (m AHD). */
  z: number;
  /** Heading along the road, chosen to match the requested heading (legal direction for one-way roads). */
  heading: number;
  width: number;
  oneway: boolean;
  road: number;
  dist: number;
}

export interface ResolveResult {
  hit: boolean;
  impact: number;
  /** The front of the bus is in the river at or below the water surface (not on a road, bridge or tunnel). */
  water?: boolean;
  /** Push-out normal of the deepest contact (map coords). */
  nx?: number;
  ny?: number;
  depth?: number;
  /** The deepest contact was a tunnel wall, parapet or retaining wall (its index in `walls`). */
  wall?: boolean;
  wallIndex?: number;
}

export const enum WallKind {
  Tunnel = 0,
  Parapet = 1,
  Retaining = 2,
}

export interface SimCollider extends Collider {
  readonly sim: true;
  readonly heights: Heights;
  readonly waterLevel: number;
  resolve(pose: BusPose, spec: BusSpec): ResolveResult;
  /** Road surface under (x, y) at the level closest to `hintZ` (see Heights.surfaceAt). */
  surface(x: number, y: number, hintZ?: number, maxStep?: number): Surface;
  ground(x: number, y: number): number;
  road(index: number): Road | undefined;
  /** True if (x, y) is inside a solid building footprint (at height z when given). */
  pointInBuilding(x: number, y: number, z?: number): boolean;
  /**
   * Fraction 0..1 along the 3D segment to the first building, wall or solid
   * ground (1 = clear). Tunnel tubes, cuttings and station bays count as open
   * space, as does anything within `openNear` metres of the start (the bus itself).
   */
  lineOfSight(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, openNear?: number): number;
  /** Nearest drivable road; with `z` the road closest to that level wins. */
  nearestRoad(x: number, y: number, heading?: number, maxDist?: number, z?: number): RoadSnap | null;
  /** (x, y) is inside a carriageway or station bay at about level z. */
  drivable(x: number, y: number, z: number): boolean;
  /** (x, y) is within `margin` of a road edge or a bus route (any level, or within 6 m of `z` when given). */
  onRoad(x: number, y: number, margin?: number, z?: number): boolean;
  inWater(x: number, y: number): boolean;
  /** Wall pieces for debugging / visualisation: flat [ax, ay, bx, by] with spans [lo, hi]. */
  readonly walls: {
    ax: Float32Array;
    ay: Float32Array;
    bx: Float32Array;
    by: Float32Array;
    lo: Float32Array;
    hi: Float32Array;
    kind: Uint8Array;
    /** Road each piece belongs to. */
    road: Int32Array;
    count: number;
  };
  readonly stats: {
    buildings: number;
    solid: number;
    excludedByRoads: number;
    walls: number;
    tunnelWalls: number;
    parapets: number;
    retainingWalls: number;
    bays: number;
    buildMs: number;
    /** Build time per phase (ms). */
    phases: Record<string, number>;
  };
}

export function isSimCollider(c: Collider): c is SimCollider {
  return (c as Partial<SimCollider>).sim === true;
}

/** The most recently built collider (cameras use it for line-of-sight). */
export let activeCollider: SimCollider | null = null;

export interface ColliderOptions {
  /** Height queries to use (defaults to the shared `heightsFor(data)`). */
  heights?: Heights;
}

// ---------------------------------------------------------------------------

/** Uniform grid in CSR form: items of cell c are items[start[c] .. start[c+1]). */
class Grid {
  readonly nx: number;
  readonly ny: number;
  start: Int32Array = new Int32Array(1);
  items: Int32Array = new Int32Array(0);
  constructor(
    readonly x0: number,
    readonly y0: number,
    x1: number,
    y1: number,
    readonly cell: number,
  ) {
    this.nx = Math.max(1, Math.ceil((x1 - x0) / cell));
    this.ny = Math.max(1, Math.ceil((y1 - y0) / cell));
  }
  cx(x: number): number {
    const c = Math.floor((x - this.x0) / this.cell);
    return c < 0 ? 0 : c >= this.nx ? this.nx - 1 : c;
  }
  cy(y: number): number {
    const c = Math.floor((y - this.y0) / this.cell);
    return c < 0 ? 0 : c >= this.ny ? this.ny - 1 : c;
  }
  /** Fill from per-item bounding boxes. */
  fill(count: number, bbox: (i: number, out: Float64Array) => boolean): void {
    const n = this.nx * this.ny;
    const counts = new Int32Array(n + 1);
    const boxes = new Int32Array(count * 4);
    const b = new Float64Array(4);
    for (let i = 0; i < count; i++) {
      if (!bbox(i, b)) {
        boxes[i * 4] = -1;
        continue;
      }
      const a = this.cx(b[0]);
      const c = this.cy(b[1]);
      const d = this.cx(b[2]);
      const e = this.cy(b[3]);
      boxes[i * 4] = a;
      boxes[i * 4 + 1] = c;
      boxes[i * 4 + 2] = d;
      boxes[i * 4 + 3] = e;
      for (let y = c; y <= e; y++) for (let x = a; x <= d; x++) counts[y * this.nx + x + 1]++;
    }
    for (let i = 0; i < n; i++) counts[i + 1] += counts[i];
    const items = new Int32Array(counts[n]);
    const fillp = counts.slice(0, n);
    for (let i = 0; i < count; i++) {
      const a = boxes[i * 4];
      if (a < 0) continue;
      const c = boxes[i * 4 + 1];
      const d = boxes[i * 4 + 2];
      const e = boxes[i * 4 + 3];
      for (let y = c; y <= e; y++) for (let x = a; x <= d; x++) items[fillp[y * this.nx + x]++] = i;
    }
    this.start = counts;
    this.items = items;
  }
}

interface PolySet {
  v: Float32Array;
  off: Int32Array;
  bb: Float32Array;
  /** Vertical span (m AHD). */
  lo: Float32Array;
  hi: Float32Array;
  count: number;
}

function pip(v: Float32Array, a: number, b: number, x: number, y: number): boolean {
  let inside = false;
  for (let i = a, j = b - 2; i < b; j = i, i += 2) {
    const yi = v[i + 1];
    const yj = v[j + 1];
    if (yi > y !== yj > y) {
      const xi = v[i];
      const xj = v[j];
      if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// Scratch for nearest-boundary queries.
const NEAR = { x: 0, y: 0, d2: 0 };
function nearestOnRing(v: Float32Array, a: number, b: number, x: number, y: number): void {
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (let i = a, j = b - 2; i < b; j = i, i += 2) {
    const ax = v[j];
    const ay = v[j + 1];
    const dx = v[i] - ax;
    const dy = v[i + 1] - ay;
    const l2 = dx * dx + dy * dy || 1e-9;
    let t = ((x - ax) * dx + (y - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t;
    const py = ay + dy * t;
    const d2 = (px - x) * (px - x) + (py - y) * (py - y);
    if (d2 < best) {
      best = d2;
      bx = px;
      by = py;
    }
  }
  NEAR.x = bx;
  NEAR.y = by;
  NEAR.d2 = best;
}

/** Segment-segment intersection: returns t along (p0->p1) or -1. */
function segHit(p0x: number, p0y: number, p1x: number, p1y: number, q0x: number, q0y: number, q1x: number, q1y: number): number {
  const dx = p1x - p0x;
  const dy = p1y - p0y;
  const ex = q1x - q0x;
  const ey = q1y - q0y;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-9) return -1;
  const wx = q0x - p0x;
  const wy = q0y - p0y;
  const t = (wx * ey - wy * ex) / den;
  const u = (wx * dy - wy * dx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

interface Line {
  pts: Float32Array;
  z: Float32Array;
  width: number;
  kind: RoadKind;
  oneway: boolean;
  tunnel: boolean;
  bridge: boolean;
  link: boolean;
  /** A bus route polyline (never snapped to; used for exemptions). */
  route: boolean;
  /** A station bay strip from a platform edge to its road (drivable, never snapped to). */
  bay?: boolean;
}

/** Projection scratch. */
const PROJ = { t: 0, d2: 0, z: 0 };
function project(l: Line, v: number, x: number, y: number): void {
  const p = l.pts;
  const ax = p[2 * v];
  const ay = p[2 * v + 1];
  const dx = p[2 * v + 2] - ax;
  const dy = p[2 * v + 3] - ay;
  const l2 = dx * dx + dy * dy || 1e-9;
  let t = ((x - ax) * dx + (y - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - x;
  const qy = ay + dy * t - y;
  PROJ.t = t;
  PROJ.d2 = qx * qx + qy * qy;
  PROJ.z = l.z[v] + (l.z[v + 1] - l.z[v]) * t;
}

/** Bus body height used for clearance tests when no spec is at hand. */
const BUS_ENVELOPE = 3.6;

export function buildCollider(data: MapData, opts: ColliderOptions = {}): SimCollider {
  const t0 = performance.now();
  const phases: Record<string, number> = {};
  let tp = t0;
  const lap = (name: string) => {
    const now = performance.now();
    phases[name] = Math.round(now - tp);
    tp = now;
  };
  const H = opts.heights ?? heightsFor(data);
  lap('heights');
  const waterLevel = data.terrain?.waterLevel ?? 0;
  const [bx0, by0, bx1, by1] = data.bounds;
  const pad = 400;
  const gx0 = bx0 - pad;
  const gy0 = by0 - pad;
  const gx1 = bx1 + pad;
  const gy1 = by1 + pad;

  // --- 1. Candidate solid buildings with vertical spans ---------------------------
  const cand: number[] = [];
  for (let i = 0; i < data.buildings.length; i++) {
    const b = data.buildings[i];
    if (b.kind === BuildingKind.Roof) continue; // canopies on posts
    if (b.kind === BuildingKind.Parking && b.minHeight > 0) continue;
    if (b.height < 1.2 || b.pts.length < 6) continue;
    cand.push(i);
  }
  const spanLo: number[] = [];
  const spanHi: number[] = [];
  for (const i of cand) {
    const b = data.buildings[i];
    const bz = b.z ?? 0;
    if (b.minHeight > 0) spanLo.push(bz + b.minHeight);
    else {
      // Foundations reach the lowest ground under the footprint (sloping sites).
      let mn = bz;
      for (let k = 0; k < b.pts.length; k += 2) mn = Math.min(mn, H.ground(b.pts[k], b.pts[k + 1]));
      spanLo.push(mn - 0.3);
    }
    spanHi.push(bz + b.height);
  }
  const polys = packPolys(
    cand.map((i) => data.buildings[i].pts),
    spanLo,
    spanHi,
  );

  lap('buildings');
  // --- 2. Roads and bus routes as "lines" (segments with heights) --------------------
  const lines: Line[] = data.roads.map((r) => ({
    pts: r.pts,
    z: r.z ?? new Float32Array(r.pts.length / 2),
    width: r.width,
    kind: r.kind,
    oneway: r.oneway,
    tunnel: r.tunnel,
    bridge: r.bridge,
    link: r.link,
    route: false,
  }));
  for (const rt of data.routes)
    lines.push({
      pts: rt.pts,
      z: rt.z ?? new Float32Array(rt.pts.length / 2),
      width: 10,
      kind: RoadKind.Busway,
      oneway: true,
      tunnel: false,
      bridge: false,
      link: false,
      route: true,
    });
  // Segments: roads first, then route segments (deduplicated: many routes share a corridor).
  const segLine: number[] = [];
  const segIdx: number[] = [];
  for (let r = 0; r < data.roads.length; r++) {
    const n = lines[r].pts.length / 2;
    for (let i = 0; i + 1 < n; i++) {
      segLine.push(r);
      segIdx.push(i);
    }
  }
  const nRoadSegs = segLine.length;
  const routeSeen = new Set<number>();
  for (let r = data.roads.length; r < lines.length; r++) {
    const p = lines[r].pts;
    const n = p.length / 2;
    for (let i = 0; i + 1 < n; i++) {
      const key =
        (Math.round(p[2 * i] * 2) * 73856093) ^ (Math.round(p[2 * i + 1] * 2) * 19349663) ^ (Math.round(p[2 * i + 2] * 2) * 83492791) ^ (Math.round(p[2 * i + 3] * 2) * 50331653);
      if (routeSeen.has(key)) continue;
      routeSeen.add(key);
      segLine.push(r);
      segIdx.push(i);
    }
  }
  const sLine = Int32Array.from(segLine);
  const sIdx = Int32Array.from(segIdx);
  const segBox = (s: number, o: Float64Array) => {
    const l = lines[sLine[s]];
    const p = l.pts;
    const i = sIdx[s] * 2;
    const m = l.width / 2 + 1;
    o[0] = Math.min(p[i], p[i + 2]) - m;
    o[1] = Math.min(p[i + 1], p[i + 3]) - m;
    o[2] = Math.max(p[i], p[i + 2]) + m;
    o[3] = Math.max(p[i + 1], p[i + 3]) + m;
    return true;
  };
  const roadGrid = new Grid(gx0, gy0, gx1, gy1, 32);
  roadGrid.fill(nRoadSegs, segBox);
  const routeGrid = new Grid(gx0, gy0, gx1, gy1, 32);
  routeGrid.fill(sLine.length - nRoadSegs, (s, o) => segBox(s + nRoadSegs, o));
  const segStamp = new Int32Array(sLine.length);
  let segStampId = 1;
  const scan = (grid: Grid, base: number, x: number, y: number, radius: number, fn: (s: number) => boolean | void): boolean => {
    const a = grid.cx(x - radius);
    const b = grid.cy(y - radius);
    const c = grid.cx(x + radius);
    const d = grid.cy(y + radius);
    for (let gy = b; gy <= d; gy++) {
      for (let gx = a; gx <= c; gx++) {
        const cell = gy * grid.nx + gx;
        for (let q = grid.start[cell], e = grid.start[cell + 1]; q < e; q++) {
          const s = grid.items[q] + base;
          if (segStamp[s] === segStampId) continue;
          segStamp[s] = segStampId;
          if (fn(s) === true) return true;
        }
      }
    }
    return false;
  };
  /** Road segments near (x, y). */
  const forEachRoadSegmentNear = (x: number, y: number, radius: number, fn: (s: number) => boolean | void): void => {
    segStampId++;
    scan(roadGrid, 0, x, y, radius, fn);
  };
  /** Bus route segments near (x, y). */
  const forEachRouteSegmentNear = (x: number, y: number, radius: number, fn: (s: number) => boolean | void): void => {
    segStampId++;
    scan(routeGrid, nRoadSegs, x, y, radius, fn);
  };
  /** Roads, then routes. */
  const forEachSegmentNear = (x: number, y: number, radius: number, fn: (s: number) => boolean | void): void => {
    segStampId++;
    if (scan(roadGrid, 0, x, y, radius, fn)) return;
    scan(routeGrid, nRoadSegs, x, y, radius, fn);
  };

  // Station bays: OSM maps the busway through-lanes, but buses pull out of them to stop at the platforms.
  // From every ~2 m of platform edge facing a road, a 5 m wide strip back to that road (at its level)
  // counts as carriageway.
  const bayLines: Line[] = [];
  const addBay = (px: number, py: number, underground: boolean, poly: Float32Array | null): void => {
    let bestD = 16 * 16;
    let bestScore = Infinity;
    let qx = 0;
    let qy = 0;
    let qz = 0;
    forEachRoadSegmentNear(px, py, 16, (sg) => {
      const l = lines[sLine[sg]];
      if (l.kind === RoadKind.Pedestrian) return;
      project(l, sIdx[sg], px, py);
      if (PROJ.d2 >= 16 * 16) return;
      // Underground platforms belong to tunnel roads; others usually not (covered busways are tagged tunnel).
      const score = Math.sqrt(PROJ.d2) + (l.tunnel === underground ? 0 : underground ? 8 : 3);
      if (score < bestScore) {
        bestScore = score;
        bestD = PROJ.d2;
        const v = sIdx[sg];
        qx = l.pts[2 * v] + (l.pts[2 * v + 2] - l.pts[2 * v]) * PROJ.t;
        qy = l.pts[2 * v + 1] + (l.pts[2 * v + 3] - l.pts[2 * v + 1]) * PROJ.t;
        qz = PROJ.z;
      }
    });
    const d = Math.sqrt(bestD);
    if (d >= 16 || d < 0.5) return;
    // Only edges facing the road: the strip must not run across the platform itself.
    if (poly && pip(poly, 0, poly.length, px + ((qx - px) / d) * 0.6, py + ((qy - py) / d) * 0.6)) return;
    bayLines.push({
      pts: new Float32Array([px, py, qx, qy]),
      z: new Float32Array([qz, qz]),
      width: 5,
      kind: RoadKind.Busway,
      oneway: false,
      tunnel: underground,
      bridge: false,
      link: false,
      route: false,
      bay: true,
    });
  };
  for (const pl of data.platforms ?? []) {
    const p = pl.pts;
    const n = p.length / 2;
    if (n < 2) continue;
    const poly = pl.area ? p : null;
    const edges = pl.area ? n : n - 1;
    let ldx = 0;
    let ldy = 0;
    let lbest = 0;
    for (let e = 0; e < edges; e++) {
      const ax = p[2 * e];
      const ay = p[2 * e + 1];
      const bx = p[2 * ((e + 1) % n)];
      const by = p[2 * ((e + 1) % n) + 1];
      const L = Math.hypot(bx - ax, by - ay);
      if (L > lbest) {
        lbest = L;
        ldx = (bx - ax) / (L || 1);
        ldy = (by - ay) / (L || 1);
      }
      const steps = Math.max(1, Math.ceil(L / 2));
      for (let k = 0; k <= steps; k++) addBay(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps, pl.underground, poly);
    }
    // The bays taper in and out beyond the platform ends (buses ease across well before the platform).
    let lo = Infinity;
    let hi = -Infinity;
    let iLo = 0;
    let iHi = 0;
    for (let i = 0; i < n; i++) {
      const u = p[2 * i] * ldx + p[2 * i + 1] * ldy;
      if (u < lo) {
        lo = u;
        iLo = i;
      }
      if (u > hi) {
        hi = u;
        iHi = i;
      }
    }
    for (let k = 2; k <= 36; k += 2) {
      addBay(p[2 * iLo] - ldx * k, p[2 * iLo + 1] - ldy * k, pl.underground, poly);
      addBay(p[2 * iHi] + ldx * k, p[2 * iHi + 1] + ldy * k, pl.underground, poly);
    }
  }
  const bayBase = lines.length;
  for (const b of bayLines) lines.push(b);
  const bayGrid = new Grid(gx0, gy0, gx1, gy1, 32);
  const bayStamp = new Int32Array(bayLines.length);
  let bayStampId = 1;
  bayGrid.fill(bayLines.length, (i, o) => {
    const p = bayLines[i].pts;
    o[0] = Math.min(p[0], p[2]) - 3;
    o[1] = Math.min(p[1], p[3]) - 3;
    o[2] = Math.max(p[0], p[2]) + 3;
    o[3] = Math.max(p[1], p[3]) + 3;
    return true;
  });
  /** Station bay strips near (x, y): line index (into `lines`). */
  const forEachBayNear = (x: number, y: number, radius: number, fn: (li: number) => boolean | void): void => {
    bayStampId++;
    const a = bayGrid.cx(x - radius);
    const b = bayGrid.cy(y - radius);
    const c = bayGrid.cx(x + radius);
    const d = bayGrid.cy(y + radius);
    for (let gy = b; gy <= d; gy++)
      for (let gx = a; gx <= c; gx++) {
        const cell = gy * bayGrid.nx + gx;
        for (let q = bayGrid.start[cell], e = bayGrid.start[cell + 1]; q < e; q++) {
          const i = bayGrid.items[q];
          if (bayStamp[i] === bayStampId) continue;
          bayStamp[i] = bayStampId;
          if (fn(bayBase + i) === true) return;
        }
      }
  };
  /** Inside another carriageway at about this level? */
  const drivableAt = (x: number, y: number, z: number, tol: number): boolean => {
    let found = false;
    forEachRoadSegmentNear(x, y, 2, (s) => {
      const l = lines[sLine[s]];
      if (l.kind === RoadKind.Pedestrian) return;
      project(l, sIdx[s], x, y);
      const w = l.width / 2 - 0.2;
      if (PROJ.d2 < w * w && Math.abs(PROJ.z - z) < tol) {
        found = true;
        return true;
      }
    });
    if (!found)
      forEachBayNear(x, y, 3, (li) => {
        const l = lines[li];
        project(l, 0, x, y);
        if (PROJ.d2 < (l.width / 2) * (l.width / 2) && Math.abs(PROJ.z - z) < tol) {
          found = true;
          return true;
        }
      });
    return found;
  };

  lap('roads+bays');
  // --- 3. Drop footprints that a road / route passes through at the same level --------
  const exGrid = new Grid(gx0, gy0, gx1, gy1, 32);
  exGrid.fill(polys.count, (i, o) => {
    o[0] = polys.bb[i * 4];
    o[1] = polys.bb[i * 4 + 1];
    o[2] = polys.bb[i * 4 + 2];
    o[3] = polys.bb[i * 4 + 3];
    return true;
  });
  const excluded = new Uint8Array(polys.count);
  let excludedCount = 0;
  const seen = new Set<number>();
  const sampleLine = (pts: Float32Array, zs: Float32Array, offsets: readonly number[], dedupe: boolean) => {
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = pts[2 * i];
      const ay = pts[2 * i + 1];
      const last = i + 1 >= n;
      if (dedupe && !last) {
        // Many routes share a corridor (and its exact shape vertices): sample each segment once.
        const key =
          (Math.round(ax * 2) * 73856093) ^ (Math.round(ay * 2) * 19349663) ^ (Math.round(pts[2 * i + 2] * 2) * 83492791) ^ (Math.round(pts[2 * i + 3] * 2) * 50331653);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const dx = last ? 0 : pts[2 * i + 2] - ax;
      const dy = last ? 0 : pts[2 * i + 3] - ay;
      const za = zs[i];
      const dz = last ? 0 : zs[i + 1] - za;
      const len = Math.hypot(dx, dy);
      const pdx = last && i > 0 ? ax - pts[2 * i - 2] : dx;
      const pdy = last && i > 0 ? ay - pts[2 * i - 1] : dy;
      const pl = Math.hypot(pdx, pdy) || 1;
      const nx = pdy / pl;
      const ny = -pdx / pl;
      const steps = last ? 1 : Math.max(1, Math.ceil(len / 2.5));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        const z = za + dz * t;
        for (const off of offsets) {
          const x = ax + dx * t + nx * off;
          const y = ay + dy * t + ny * off;
          const c = exGrid.cy(y) * exGrid.nx + exGrid.cx(x);
          for (let q = exGrid.start[c], e = exGrid.start[c + 1]; q < e; q++) {
            const b = exGrid.items[q];
            if (excluded[b]) continue;
            // Only if a bus on this road would actually be inside the building's height band.
            if (z + BUS_ENVELOPE <= polys.lo[b] || z >= polys.hi[b]) continue;
            const o = b * 4;
            if (x < polys.bb[o] || y < polys.bb[o + 1] || x > polys.bb[o + 2] || y > polys.bb[o + 3]) continue;
            if (pip(polys.v, polys.off[b], polys.off[b + 1], x, y)) {
              excluded[b] = 1;
              excludedCount++;
            }
          }
        }
      }
    }
  };
  const CENTRE = [0] as const;
  for (const r of data.roads) {
    if (r.kind === RoadKind.Pedestrian) continue;
    sampleLine(r.pts, r.z ?? new Float32Array(r.pts.length / 2), CENTRE, false);
  }
  // Bus routes: keep a 2 m corridor either side clear (GTFS shapes wander off the mapped centreline).
  for (const rt of data.routes) sampleLine(rt.pts, rt.z ?? new Float32Array(rt.pts.length / 2), [-2, 0, 2], true);
  // Station bays: keep the strip from the through-lanes to the platform edge clear.
  for (const b of bayLines) sampleLine(b.pts, b.z, [-2, 0, 2], false);

  const keep: number[] = [];
  for (let i = 0; i < polys.count; i++) if (!excluded[i]) keep.push(i);
  const solid = subsetPolys(polys, keep);
  const grid = new Grid(gx0, gy0, gx1, gy1, 20);
  grid.fill(solid.count, (i, o) => {
    o[0] = solid.bb[i * 4];
    o[1] = solid.bb[i * 4 + 1];
    o[2] = solid.bb[i * 4 + 2];
    o[3] = solid.bb[i * 4 + 3];
    return true;
  });
  const stamp = new Int32Array(solid.count);
  let stampId = 1;

  lap('exclusions');
  // --- 4. Edge walls -------------------------------------------------------------------
  const wAx: number[] = [];
  const wAy: number[] = [];
  const wBx: number[] = [];
  const wBy: number[] = [];
  const wLo: number[] = [];
  const wHi: number[] = [];
  const wKind: number[] = [];
  const wRoad: number[] = [];
  const PIECE = 4;
  const BUS_HALF_CLEAR = 2.3; // half a bus plus clearance, from a route line to a wall (when parallel)

  // Junction nodes: vertices shared by roads at the same level (not plain way splits). Walls open
  // around them so buses can turn in and out (kerb radii are wider than the joining carriageway).
  const nodes = new Map<number, number[]>();
  const nodeKey = (x: number, y: number) => (Math.round(x * 10) + 80000) * 200000 + (Math.round(y * 10) + 80000);
  for (let ri = 0; ri < data.roads.length; ri++) {
    const r = data.roads[ri];
    if (r.kind === RoadKind.Pedestrian) continue;
    const n = r.pts.length / 2;
    for (let v = 0; v < n; v++) {
      const k = nodeKey(r.pts[2 * v], r.pts[2 * v + 1]);
      let list = nodes.get(k);
      if (!list) nodes.set(k, (list = []));
      list.push(ri, v);
    }
  }
  const mouths: number[] = []; // x, y, z, radius
  const dirAt = (ri: number, v: number): [number, number] => {
    const p = data.roads[ri].pts;
    const n = p.length / 2;
    const a = v === n - 1 ? v - 1 : v;
    const dx = p[2 * a + 2] - p[2 * a];
    const dy = p[2 * a + 3] - p[2 * a + 1];
    const L = Math.hypot(dx, dy) || 1;
    return [dx / L, dy / L];
  };
  for (const list of nodes.values()) {
    if (list.length < 4) continue;
    const ri0 = list[0];
    const v0 = list[1];
    const z0 = lines[ri0].z[v0];
    let distinct = 0;
    let maxW = 0;
    let ends = 0;
    for (let i = 0; i < list.length; i += 2) {
      const ri = list[i];
      const v = list[i + 1];
      if (Math.abs(lines[ri].z[v] - z0) > 1.5) continue;
      distinct++;
      maxW = Math.max(maxW, data.roads[ri].width);
      if (v === 0 || v === data.roads[ri].pts.length / 2 - 1) ends++;
    }
    if (distinct < 2) continue;
    if (distinct === 2 && ends === 2 && list.length === 4) {
      // Two ways meeting end to end: a split (bridge starts, name changes), not a junction, if straight on.
      const [ax, ay] = dirAt(list[0], list[1]);
      const [bx, by] = dirAt(list[2], list[3]);
      if (Math.abs(ax * bx + ay * by) > 0.85) continue;
    }
    const p = data.roads[ri0].pts;
    mouths.push(p[2 * v0], p[2 * v0 + 1], z0, maxW / 2 + 9);
  }
  const mouthGrid = new Map<number, number[]>();
  const mk = (x: number, y: number) => Math.floor((x - gx0) / 25) * 100003 + Math.floor((y - gy0) / 25);
  for (let i = 0; i < mouths.length; i += 4) {
    const cxm = Math.floor((mouths[i] - gx0) / 25);
    const cym = Math.floor((mouths[i + 1] - gy0) / 25);
    for (let a2 = -1; a2 <= 1; a2++)
      for (let b2 = -1; b2 <= 1; b2++) {
        const k = (cxm + a2) * 100003 + cym + b2;
        let list = mouthGrid.get(k);
        if (!list) mouthGrid.set(k, (list = []));
        list.push(i);
      }
  }
  const inMouth = (x: number, y: number, z: number): boolean => {
    const list = mouthGrid.get(mk(x, y));
    if (!list) return false;
    for (const i of list) {
      if (Math.abs(mouths[i + 2] - z) < 2 && Math.hypot(mouths[i] - x, mouths[i + 1] - y) < mouths[i + 3]) return true;
    }
    return false;
  };
  /** Nearest road (index) to (x, y) at about level z, or -1. */
  const nearestRoadAt = (x: number, y: number, z: number, radius: number): number => {
    let best = -1;
    let bd = radius * radius;
    forEachRoadSegmentNear(x, y, radius, (s) => {
      const l = lines[sLine[s]];
      if (l.kind === RoadKind.Pedestrian) return;
      project(l, sIdx[s], x, y);
      if (PROJ.d2 < bd && Math.abs(PROJ.z - z) < 2.5) {
        bd = PROJ.d2;
        best = sLine[s];
      }
    });
    return best;
  };
  const ROUTE_REACH = 12;
  /**
   * Where a wall beside centreline point (x, y) of road `ri` must stand (distance out along n) to leave a
   * bus following a route along this road room: the route's lateral offset plus clearance, more when the
   * route runs at an angle to the road (a long bus angled across the wall line). -Infinity if no route.
   */
  const routeNeed = (ri: number, x: number, y: number, z: number, dx: number, dy: number, nx: number, ny: number): number => {
    const found: number[] = [];
    forEachRouteSegmentNear(x, y, ROUTE_REACH, (s) => {
      const l = lines[sLine[s]];
      const v = sIdx[s];
      const p = l.pts;
      const ex = p[2 * v + 2] - p[2 * v];
      const ey = p[2 * v + 3] - p[2 * v + 1];
      const L = Math.hypot(ex, ey);
      if (L < 0.1 || Math.abs((ex * dx + ey * dy) / L) < 0.3) return;
      project(l, v, x, y);
      if (PROJ.d2 > ROUTE_REACH * ROUTE_REACH || Math.abs(PROJ.z - z) > 2.5) return;
      const rx = p[2 * v] + ex * PROJ.t;
      const ry = p[2 * v + 1] + ey * PROJ.t;
      const lat = (rx - x) * nx + (ry - y) * ny;
      const cos = Math.abs((ex * dx + ey * dy) / L);
      const need = lat + BUS_HALF_CLEAR / cos + (1 - cos) * 4;
      if (need > 0) found.push(rx, ry, PROJ.z, need);
    });
    // Largest need first; the first stretch of route that is following this road (not a neighbouring
    // carriageway) decides.
    const order: number[] = [];
    for (let i = 0; i < found.length; i += 4) order.push(i);
    order.sort((a, b) => found[b + 3] - found[a + 3]);
    let last = NaN;
    for (const i of order) {
      if (found[i + 3] === last) continue;
      last = found[i + 3];
      if (nearestRoadAt(found[i], found[i + 1], found[i + 2], ROUTE_REACH + 4) === ri) return found[i + 3];
    }
    return -Infinity;
  };

  /** Is a bus route (at a height inside [lo, hi]) within `dist` of segment a-b? */
  const routeNear = (ax: number, ay: number, bx: number, by: number, lo: number, hi: number, dist: number): boolean => {
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    let hit = false;
    forEachRouteSegmentNear(mx, my, PIECE / 2 + dist, (s) => {
      const l = lines[sLine[s]];
      const v = sIdx[s];
      const p = l.pts;
      const qx0 = p[2 * v];
      const qy0 = p[2 * v + 1];
      const qx1 = p[2 * v + 2];
      const qy1 = p[2 * v + 3];
      // segment-segment distance (2D)
      let d2 = Infinity;
      let zq = l.z[v];
      if (segHit(ax, ay, bx, by, qx0, qy0, qx1, qy1) >= 0) d2 = 0;
      for (const [x, y] of [
        [ax, ay],
        [bx, by],
      ]) {
        project(l, v, x, y);
        if (PROJ.d2 < d2) {
          d2 = PROJ.d2;
          zq = PROJ.z;
        }
      }
      for (const [x, y, z] of [
        [qx0, qy0, l.z[v]],
        [qx1, qy1, l.z[v + 1]],
      ]) {
        const ex = bx - ax;
        const ey = by - ay;
        const l2 = ex * ex + ey * ey || 1e-9;
        let t = ((x - ax) * ex + (y - ay) * ey) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dd = (ax + ex * t - x) ** 2 + (ay + ey * t - y) ** 2;
        if (dd < d2) {
          d2 = dd;
          zq = z;
        }
      }
      if (d2 < dist * dist && zq + BUS_ENVELOPE > lo && zq < hi) {
        hit = true;
        return true;
      }
    });
    return hit;
  };

  const pushWall = (ax: number, ay: number, bx: number, by: number, za: number, zb: number, onx: number, ony: number, ri: number) => {
    const r = data.roads[ri];
    const zm = (za + zb) / 2;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    let kind: WallKind;
    let lo = Math.min(za, zb) - 0.4;
    let hi: number;
    if (r.tunnel) {
      kind = WallKind.Tunnel;
      hi = Math.max(za, zb) + 4.6;
    } else if (r.bridge) {
      kind = WallKind.Parapet;
      hi = Math.max(za, zb) + 1.1;
    } else {
      const g = H.ground(mx + onx * 2.5, my + ony * 2.5);
      if (g - zm < 1.5) return;
      kind = WallKind.Retaining;
      hi = g + 1.0;
    }
    // Openings: junction mouths, and wherever the space beyond is another carriageway at this level.
    if (inMouth(mx, my, zm)) return;
    const o = 0.9;
    if (
      drivableAt(ax + onx * o, ay + ony * o, za, 1.8) ||
      drivableAt(bx + onx * o, by + ony * o, zb, 1.8) ||
      drivableAt(mx + onx * o, my + ony * o, zm, 1.8)
    )
      return;
    if (lo > hi) lo = hi - 1;
    // A bus route runs (almost) along this wall line at its level: the GTFS shape says buses pass here.
    // Tunnel and retaining walls give way (rock and ground still stop a bus: see BusPhysics); parapets only
    // where the route runs right over them, so nobody can drive off a viaduct.
    if (routeNear(ax, ay, bx, by, lo, hi, kind === WallKind.Parapet ? 1.6 : 2.6)) return;
    // A parapet between two decks at the same level (no drop behind it) also yields to a route beside it.
    if (kind === WallKind.Parapet && routeNear(ax, ay, bx, by, lo, hi, 2.6)) {
      for (const d of [2, 4, 6]) if (drivableAt(mx + onx * d, my + ony * d, zm, 1.8)) return;
    }
    wAx.push(ax);
    wAy.push(ay);
    wBx.push(bx);
    wBy.push(by);
    wLo.push(lo);
    wHi.push(hi);
    wKind.push(kind);
    wRoad.push(ri);
  };

  for (let ri = 0; ri < data.roads.length; ri++) {
    const r = data.roads[ri];
    if (r.kind === RoadKind.Pedestrian) continue;
    const p = r.pts;
    const zs = lines[ri].z;
    const n = p.length / 2;
    if (n < 2) continue;
    // Walls stand a little outside the marked carriageway (shoulders, kerbs) and never closer than 2.6 m.
    const baseOff = Math.max(r.width / 2 + 0.6, 2.6);
    // Only roads that can have walls: tunnels, bridges, or roads that dip below the ground beside them.
    if (!r.tunnel && !r.bridge) {
      let cut = false;
      for (let v = 0; v < n && !cut; v++) if (H.ground(p[2 * v], p[2 * v + 1]) - zs[v] > 1.2) cut = true;
      for (let v = 0; v + 1 < n && !cut; v++) {
        const mxv = (p[2 * v] + p[2 * v + 2]) / 2;
        const myv = (p[2 * v + 1] + p[2 * v + 3]) / 2;
        const dx = p[2 * v + 2] - p[2 * v];
        const dy = p[2 * v + 3] - p[2 * v + 1];
        const L = Math.hypot(dx, dy) || 1;
        const zm = (zs[v] + zs[v + 1]) / 2;
        for (const sd of [-1, 1]) if (H.ground(mxv + (sd * dy * (baseOff + 2.5)) / L, myv - (sd * dx * (baseOff + 2.5)) / L) - zm > 1.5) cut = true;
      }
      if (!cut) continue;
    }
    for (const side of [-1, 1]) {
      let prevX = NaN;
      let prevY = NaN;
      let prevZ = 0;
      for (let v = 0; v + 1 < n; v++) {
        const sx = p[2 * v + 2] - p[2 * v];
        const sy = p[2 * v + 3] - p[2 * v + 1];
        const segL = Math.hypot(sx, sy);
        if (segL < 0.05) continue;
        const dx = sx / segL;
        const dy = sy / segL;
        const onx = side * dy; // outward normal on this side
        const ony = side * -dx;
        const pieces = Math.max(1, Math.ceil(segL / PIECE));
        let lastX = NaN;
        let lastY = NaN;
        let lastZ = 0;
        for (let k = 0; k <= pieces; k++) {
          const t = k / pieces;
          const cx = p[2 * v] + sx * t;
          const cy = p[2 * v + 1] + sy * t;
          const cz = zs[v] + (zs[v + 1] - zs[v]) * t;
          // Make room for a bus following the route line where GTFS shapes hug one side.
          let off = baseOff;
          const need = routeNeed(ri, cx, cy, cz, dx, dy, onx, ony);
          if (need > off) off = Math.min(baseOff + 12, need);
          const px = cx + onx * off;
          const py = cy + ony * off;
          if (k === 0 && v > 0 && Number.isFinite(prevX) && Math.hypot(px - prevX, py - prevY) > 0.1) {
            // Close the gap on the outside of a bend.
            pushWall(prevX, prevY, px, py, prevZ, cz, onx, ony, ri);
          }
          if (k > 0) pushWall(lastX, lastY, px, py, lastZ, cz, onx, ony, ri);
          lastX = px;
          lastY = py;
          lastZ = cz;
        }
        prevX = lastX;
        prevY = lastY;
        prevZ = lastZ;
      }
    }
  }
  lap('walls');
  // Bus routes crossing a wall at its level open a gap there (with a few metres either side).
  const crossings: number[] = [];
  for (let w = 0; w < wAx.length; w++) {
    const mx = (wAx[w] + wBx[w]) / 2;
    const my = (wAy[w] + wBy[w]) / 2;
    forEachRouteSegmentNear(mx, my, PIECE, (s) => {
      const l = lines[sLine[s]];
      const v = sIdx[s];
      const p = l.pts;
      const tw = segHit(wAx[w], wAy[w], wBx[w], wBy[w], p[2 * v], p[2 * v + 1], p[2 * v + 2], p[2 * v + 3]);
      if (tw < 0) return;
      const cx = wAx[w] + (wBx[w] - wAx[w]) * tw;
      const cy = wAy[w] + (wBy[w] - wAy[w]) * tw;
      project(l, v, cx, cy);
      // A shallow crossing keeps the bus near the wall line for longer: open a longer gap.
      const ex = wBx[w] - wAx[w];
      const ey = wBy[w] - wAy[w];
      const rx = p[2 * v + 2] - p[2 * v];
      const ry = p[2 * v + 3] - p[2 * v + 1];
      const sin = Math.abs(ex * ry - ey * rx) / ((Math.hypot(ex, ey) || 1) * (Math.hypot(rx, ry) || 1));
      const radius = Math.min(20, 4 + 3 / Math.max(0.15, sin));
      if (PROJ.z + BUS_ENVELOPE > wLo[w] && PROJ.z < wHi[w]) crossings.push(cx, cy, PROJ.z, radius);
    });
  }
  const crossGrid = new Map<number, number[]>();
  const ck = (x: number, y: number) => Math.floor((x - gx0) / 10) * 100003 + Math.floor((y - gy0) / 10);
  for (let i = 0; i < crossings.length; i += 4) {
    const cxi = Math.floor((crossings[i] - gx0) / 10);
    const cyi = Math.floor((crossings[i + 1] - gy0) / 10);
    const reach = Math.ceil(crossings[i + 3] / 10);
    for (let a = -reach; a <= reach; a++)
      for (let b = -reach; b <= reach; b++) {
        const k = (cxi + a) * 100003 + cyi + b;
        let list = crossGrid.get(k);
        if (!list) crossGrid.set(k, (list = []));
        list.push(i);
      }
  }
  const wallKeep: number[] = [];
  for (let w = 0; w < wAx.length; w++) {
    const mx = (wAx[w] + wBx[w]) / 2;
    const my = (wAy[w] + wBy[w]) / 2;
    let open = false;
    const list = crossGrid.get(ck(mx, my));
    if (list)
      for (const i of list) {
        const z = crossings[i + 2];
        if (Math.hypot(crossings[i] - mx, crossings[i + 1] - my) < crossings[i + 3] && z + BUS_ENVELOPE > wLo[w] && z < wHi[w]) {
          open = true;
          break;
        }
      }
    if (!open) wallKeep.push(w);
  }
  const nW = wallKeep.length;
  const walls = {
    ax: new Float32Array(nW),
    ay: new Float32Array(nW),
    bx: new Float32Array(nW),
    by: new Float32Array(nW),
    lo: new Float32Array(nW),
    hi: new Float32Array(nW),
    kind: new Uint8Array(nW),
    road: new Int32Array(nW),
    count: nW,
  };
  const kindCount = [0, 0, 0];
  wallKeep.forEach((w, i) => {
    walls.ax[i] = wAx[w];
    walls.ay[i] = wAy[w];
    walls.bx[i] = wBx[w];
    walls.by[i] = wBy[w];
    walls.lo[i] = wLo[w];
    walls.hi[i] = wHi[w];
    walls.kind[i] = wKind[w];
    walls.road[i] = wRoad[w];
    kindCount[wKind[w]]++;
  });
  const wallGrid = new Grid(gx0, gy0, gx1, gy1, 20);
  wallGrid.fill(nW, (i, o) => {
    o[0] = Math.min(walls.ax[i], walls.bx[i]);
    o[1] = Math.min(walls.ay[i], walls.by[i]);
    o[2] = Math.max(walls.ax[i], walls.bx[i]);
    o[3] = Math.max(walls.ay[i], walls.by[i]);
    return true;
  });
  const wallStamp = new Int32Array(nW);
  let wallStampId = 1;

  lap('crossings');
  // --- 5. Water ---------------------------------------------------------------------
  const water = data.water.map((a) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < a.pts.length; i += 2) {
      x0 = Math.min(x0, a.pts[i]);
      x1 = Math.max(x1, a.pts[i]);
      y0 = Math.min(y0, a.pts[i + 1]);
      y1 = Math.max(y1, a.pts[i + 1]);
    }
    return { pts: a.pts, holes: a.holes, x0, y0, x1, y1 };
  });

  // --- Queries ---------------------------------------------------------------------
  const candidates: number[] = [];
  const gather = (minx: number, miny: number, maxx: number, maxy: number) => {
    candidates.length = 0;
    stampId++;
    const a = grid.cx(minx);
    const b = grid.cy(miny);
    const c = grid.cx(maxx);
    const d = grid.cy(maxy);
    for (let y = b; y <= d; y++) {
      for (let x = a; x <= c; x++) {
        const cell = y * grid.nx + x;
        for (let q = grid.start[cell], e = grid.start[cell + 1]; q < e; q++) {
          const i = grid.items[q];
          if (stamp[i] === stampId) continue;
          stamp[i] = stampId;
          const o = i * 4;
          if (solid.bb[o] > maxx || solid.bb[o + 2] < minx || solid.bb[o + 1] > maxy || solid.bb[o + 3] < miny) continue;
          candidates.push(i);
        }
      }
    }
  };
  const wallCands: number[] = [];
  const gatherWalls = (minx: number, miny: number, maxx: number, maxy: number) => {
    wallCands.length = 0;
    wallStampId++;
    const a = wallGrid.cx(minx);
    const b = wallGrid.cy(miny);
    const c = wallGrid.cx(maxx);
    const d = wallGrid.cy(maxy);
    for (let y = b; y <= d; y++) {
      for (let x = a; x <= c; x++) {
        const cell = y * wallGrid.nx + x;
        for (let q = wallGrid.start[cell], e = wallGrid.start[cell + 1]; q < e; q++) {
          const i = wallGrid.items[q];
          if (wallStamp[i] === wallStampId) continue;
          wallStamp[i] = wallStampId;
          wallCands.push(i);
        }
      }
    }
  };

  const pointInBuilding = (x: number, y: number, z?: number): boolean => {
    const cell = grid.cy(y) * grid.nx + grid.cx(x);
    for (let q = grid.start[cell], e = grid.start[cell + 1]; q < e; q++) {
      const i = grid.items[q];
      const o = i * 4;
      if (x < solid.bb[o] || y < solid.bb[o + 1] || x > solid.bb[o + 2] || y > solid.bb[o + 3]) continue;
      if (z !== undefined && (z < solid.lo[i] || z > solid.hi[i])) continue;
      if (pip(solid.v, solid.off[i], solid.off[i + 1], x, y)) return true;
    }
    return false;
  };

  /** Inside a road corridor's air space (tunnel tube, cutting, under a bridge deck) at height z. */
  const inCorridor = (x: number, y: number, z: number): boolean => {
    let found = false;
    forEachRoadSegmentNear(x, y, 3, (s) => {
      const l = lines[sLine[s]];
      project(l, sIdx[s], x, y);
      const w = l.width / 2 + 2.5;
      if (PROJ.d2 < w * w && z > PROJ.z - 0.5 && z < PROJ.z + 6) {
        found = true;
        return true;
      }
    });
    if (!found)
      forEachBayNear(x, y, 3, (li) => {
        const l = lines[li];
        project(l, 0, x, y);
        if (PROJ.d2 < (l.width / 2 + 1) ** 2 && z > PROJ.z - 0.5 && z < PROJ.z + 6) {
          found = true;
          return true;
        }
      });
    return found;
  };

  /** Inside the structure of a bridge deck (just under its surface, within its width)? */
  const underDeck = (x: number, y: number, z: number): boolean => {
    let found = false;
    forEachRoadSegmentNear(x, y, 2, (s) => {
      const l = lines[sLine[s]];
      if (!l.bridge) return;
      project(l, sIdx[s], x, y);
      const w = l.width / 2 + 0.5;
      if (PROJ.d2 < w * w && z < PROJ.z - 0.15 && z > PROJ.z - 1.8) {
        found = true;
        return true;
      }
    });
    return found;
  };
  const lineOfSight = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, openNear = 0): number => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dy);
    let best = 1;
    if (len > 1e-6) {
      gather(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1));
      for (const i of candidates) {
        const v = solid.v;
        const a = solid.off[i];
        const b = solid.off[i + 1];
        for (let k = a, j = b - 2; k < b; j = k, k += 2) {
          const t = segHit(x0, y0, x1, y1, v[j], v[j + 1], v[k], v[k + 1]);
          if (t < 0 || t >= best) continue;
          const z = z0 + dz * t;
          if (z >= solid.lo[i] && z <= solid.hi[i]) best = t;
        }
      }
      gatherWalls(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1));
      for (const w of wallCands) {
        const t = segHit(x0, y0, x1, y1, walls.ax[w], walls.ay[w], walls.bx[w], walls.by[w]);
        if (t < 0 || t >= best) continue;
        const z = z0 + dz * t;
        if (z >= walls.lo[w] && z <= walls.hi[w]) best = t;
      }
    }
    // Solid ground (outside tunnel tubes, cuttings and bays), and bridge decks seen from below.
    const total = Math.hypot(len, dz);
    const slope = Math.abs(dz) / Math.max(len, 1e-3);
    const step = Math.min(3, 1.6 / Math.max(slope, 0.05));
    const steps = Math.max(2, Math.ceil(total / step));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      if (t >= best) break;
      if (t * total < openNear) continue;
      const x = x0 + dx * t;
      const y = y0 + dy * t;
      const z = z0 + dz * t;
      if ((z < H.ground(x, y) - 0.4 && !inCorridor(x, y, z)) || underDeck(x, y, z)) {
        best = Math.max(0, t - 1 / steps);
        break;
      }
    }
    return best;
  };

  const onRoad = (x: number, y: number, margin = 2, z?: number): boolean => {
    let found = false;
    forEachSegmentNear(x, y, 30, (s) => {
      const l = lines[sLine[s]];
      project(l, sIdx[s], x, y);
      const w = l.width / 2 + margin;
      if (PROJ.d2 <= w * w && (z === undefined || Math.abs(PROJ.z - z) < 6)) {
        found = true;
        return true;
      }
    });
    return found;
  };

  const nearestRoad = (x: number, y: number, heading = 0, maxDist = 200, z?: number): RoadSnap | null => {
    let bestS = -1;
    let bestScore = Infinity;
    for (let radius = 40; radius <= maxDist + 40; radius *= 2) {
      forEachRoadSegmentNear(x, y, radius, (s) => {
        const l = lines[sLine[s]];
        if (l.kind === RoadKind.Pedestrian) return;
        const v = sIdx[s];
        project(l, v, x, y);
        const d = Math.sqrt(PROJ.d2);
        if (d > maxDist) return;
        const p = l.pts;
        const segH = Math.atan2(p[2 * v + 2] - p[2 * v], p[2 * v + 3] - p[2 * v + 1]);
        let dh = Math.abs(wrap(segH - heading));
        if (!l.oneway) dh = Math.min(dh, Math.PI - dh);
        const score =
          d +
          (l.kind === RoadKind.Service ? 4 : 0) +
          (z === undefined && l.tunnel ? 25 : 0) +
          (l.kind === RoadKind.Motorway && !l.link ? 6 : 0) +
          dh * 3 +
          (z !== undefined ? Math.abs(PROJ.z - z) * 3 : 0);
        if (score < bestScore) {
          bestScore = score;
          bestS = s;
        }
      });
      if (bestS >= 0) break;
    }
    if (bestS < 0) return null;
    const l = lines[sLine[bestS]];
    const v = sIdx[bestS];
    project(l, v, x, y);
    const p = l.pts;
    const ax = p[2 * v];
    const ay = p[2 * v + 1];
    const dx = p[2 * v + 2] - ax;
    const dy = p[2 * v + 3] - ay;
    let h = Math.atan2(dx, dy);
    if (!l.oneway && Math.abs(wrap(h - heading)) > Math.PI / 2) h = wrap(h + Math.PI);
    const sx = ax + dx * PROJ.t;
    const sy = ay + dy * PROJ.t;
    return { x: sx, y: sy, z: PROJ.z, heading: h, width: l.width, oneway: l.oneway, road: sLine[bestS], dist: Math.hypot(sx - x, sy - y) };
  };

  const inWater = (x: number, y: number): boolean => {
    for (const w of water) {
      if (x < w.x0 || x > w.x1 || y < w.y0 || y > w.y1) continue;
      if (!pip(w.pts, 0, w.pts.length, x, y)) continue;
      let inHole = false;
      for (const hole of w.holes) if (pip(hole, 0, hole.length, x, y)) inHole = true;
      if (!inHole) return true;
    }
    return false;
  };

  // --- Resolve -------------------------------------------------------------------------
  const corners = new Float64Array(8);
  const secCands: number[][] = [];
  const secWalls: number[][] = [];
  let waterX = NaN;
  let waterY = NaN;
  let waterXY = false;

  interface Contact {
    depth: number;
    /** Push-out vector for the bus. */
    px: number;
    py: number;
    /** Where on the bus the contact is (map coords). */
    qx: number;
    qy: number;
    sec: number;
    wall: boolean;
    wallIndex: number;
  }
  const best: Contact = { depth: 0, px: 0, py: 0, qx: 0, qy: 0, sec: 0, wall: false, wallIndex: -1 };

  const sectionBox = (pose: BusPose, spec: BusSpec, s: number) => {
    const sp = pose.sections[s] ?? pose;
    const ss = spec.sections[s];
    const fx = Math.sin(sp.heading);
    const fy = Math.cos(sp.heading);
    const co = ss.axleFromFront - ss.length / 2;
    const cx = sp.x + fx * co;
    const cy = sp.y + fy * co;
    // Trailing sections overlap the bellows slightly.
    const hl = ss.length / 2 - (s > 0 ? 0.15 : 0);
    const hw = spec.width / 2;
    // Vertical span: road height at the axle, tilted by the grade, plus the body height.
    const z = sp.z ?? pose.z ?? 0;
    const tp = Math.tan(sp.pitch ?? 0);
    const zf = z + tp * ss.axleFromFront;
    const zr = z - tp * (ss.length - ss.axleFromFront);
    const lo = Math.min(zf, zr) + 0.25;
    const hi = Math.max(zf, zr) + spec.height;
    return { fx, fy, cx, cy, hl, hw, lo, hi };
  };

  const vertexContact = (vx: number, vy: number, cx: number, cy: number, fx: number, fy: number, rx: number, ry: number, hl: number, hw: number, s: number, wall: boolean) => {
    const dx = vx - cx;
    const dy = vy - cy;
    const u = dx * fx + dy * fy;
    if (u >= hl || u <= -hl) return;
    const w = dx * rx + dy * ry;
    if (w >= hw || w <= -hw) return;
    const front = hl - u;
    const back = hl + u;
    const right = hw - w;
    const left = hw + w;
    let d = front;
    let px = -fx * front;
    let py = -fy * front;
    if (back < d) {
      d = back;
      px = fx * back;
      py = fy * back;
    }
    if (right < d) {
      d = right;
      px = -rx * right;
      py = -ry * right;
    }
    if (left < d) {
      d = left;
      px = rx * left;
      py = ry * left;
    }
    if (d > best.depth) {
      best.depth = d;
      best.px = px;
      best.py = py;
      best.qx = vx;
      best.qy = vy;
      best.sec = s;
      best.wall = wall;
    }
  };

  const findContact = (pose: BusPose, spec: BusSpec): boolean => {
    best.depth = 0;
    for (let s = 0; s < spec.sections.length; s++) {
      const { fx, fy, cx, cy, hl, hw, lo, hi } = sectionBox(pose, spec, s);
      const rx = fy;
      const ry = -fx;
      corners[0] = cx + fx * hl + rx * hw;
      corners[1] = cy + fy * hl + ry * hw;
      corners[2] = cx + fx * hl - rx * hw;
      corners[3] = cy + fy * hl - ry * hw;
      corners[4] = cx - fx * hl - rx * hw;
      corners[5] = cy - fy * hl - ry * hw;
      corners[6] = cx - fx * hl + rx * hw;
      corners[7] = cy - fy * hl + ry * hw;
      // Buildings
      const list = secCands[s];
      for (let ci = 0; ci < list.length; ci++) {
        const i = list[ci];
        if (solid.lo[i] >= hi || solid.hi[i] <= lo) continue;
        const a = solid.off[i];
        const b = solid.off[i + 1];
        const v = solid.v;
        const o = i * 4;
        for (let k = 0; k < 8; k += 2) {
          const x = corners[k];
          const y = corners[k + 1];
          if (x < solid.bb[o] || y < solid.bb[o + 1] || x > solid.bb[o + 2] || y > solid.bb[o + 3]) continue;
          if (!pip(v, a, b, x, y)) continue;
          nearestOnRing(v, a, b, x, y);
          const d = Math.sqrt(NEAR.d2);
          if (d > best.depth) {
            best.depth = d;
            best.px = NEAR.x - x;
            best.py = NEAR.y - y;
            best.qx = x;
            best.qy = y;
            best.sec = s;
            best.wall = false;
          }
        }
        for (let k = a; k < b; k += 2) vertexContact(v[k], v[k + 1], cx, cy, fx, fy, rx, ry, hl, hw, s, false);
      }
      // Walls: keep every corner on the side of the wall the section's centre is on.
      const wl = secWalls[s];
      for (let wi = 0; wi < wl.length; wi++) {
        const w = wl[wi];
        if (walls.lo[w] >= hi || walls.hi[w] <= lo) continue;
        const ax = walls.ax[w];
        const ay = walls.ay[w];
        const ex = walls.bx[w] - ax;
        const ey = walls.by[w] - ay;
        const L = Math.hypot(ex, ey);
        if (L < 1e-4) continue;
        const dxu = ex / L;
        const dyu = ey / L;
        const nx = -dyu;
        const ny = dxu;
        const sc = (cx - ax) * nx + (cy - ay) * ny;
        const side = sc >= 0 ? 1 : -1;
        for (let k = 0; k < 8; k += 2) {
          const qx = corners[k] - ax;
          const qy = corners[k + 1] - ay;
          const u = qx * dxu + qy * dyu;
          if (u < 0 || u > L) continue;
          const d = -(qx * nx + qy * ny) * side;
          if (d > 0 && d < 3 && d > best.depth) {
            best.depth = d;
            best.px = nx * side * d;
            best.py = ny * side * d;
            best.qx = corners[k];
            best.qy = corners[k + 1];
            best.sec = s;
            best.wall = true;
            best.wallIndex = w;
          }
        }
        const before = best.depth;
        vertexContact(ax, ay, cx, cy, fx, fy, rx, ry, hl, hw, s, true);
        vertexContact(walls.bx[w], walls.by[w], cx, cy, fx, fy, rx, ry, hl, hw, s, true);
        if (best.depth > before) best.wallIndex = w;
      }
    }
    return best.depth > 1e-4;
  };

  const resolve = (pose: BusPose, spec: BusSpec): ResolveResult => {
    const out: ResolveResult = { hit: false, impact: 0 };
    // Gather candidates once per section, with a margin for the push-outs.
    for (let s = 0; s < spec.sections.length; s++) {
      const { fx, fy, cx, cy, hl, hw } = sectionBox(pose, spec, s);
      const ex = Math.abs(fx) * hl + Math.abs(fy) * hw + 0.6;
      const ey = Math.abs(fy) * hl + Math.abs(fx) * hw + 0.6;
      gather(cx - ex, cy - ey, cx + ex, cy + ey);
      secCands[s] = secCands[s] ?? [];
      secCands[s].length = 0;
      for (const c of candidates) secCands[s].push(c);
      gatherWalls(cx - ex, cy - ey, cx + ex, cy + ey);
      secWalls[s] = secWalls[s] ?? [];
      secWalls[s].length = 0;
      for (const c of wallCands) secWalls[s].push(c);
    }
    for (let iter = 0; iter < 4; iter++) {
      if (!findContact(pose, spec)) break;
      out.hit = true;
      const d = best.depth;
      const nx = best.px / d;
      const ny = best.py / d;
      const push = d + 0.002;
      // Split the push into a turn and a shift. A contact well ahead of (or behind) the pivot is
      // resolved mostly by turning the section about it - its rear axle for the front section, its hitch
      // for a trailer - so a bus pressed against a wall swings parallel to it and scrapes along instead of
      // being pinned; what the turn doesn't fix (and contacts near the pivot) moves the whole bus.
      const sec = pose.sections[best.sec] ?? pose;
      const ssec = spec.sections[best.sec];
      const sfx = Math.sin(sec.heading);
      const sfy = Math.cos(sec.heading);
      const trailer = best.sec > 0;
      const dH = trailer ? Math.max(0.5, ssec.axleFromFront - ssec.hitchFromFront) : 0;
      const pivX = sec.x + sfx * dH;
      const pivY = sec.y + sfy * dH;
      const qa = (best.qx - pivX) * sfx + (best.qy - pivY) * sfy; // along the section from the pivot
      const qw = (best.qx - pivX) * sfy - (best.qy - pivY) * sfx; // to its right
      const pX = nx * push;
      const pY = ny * push;
      const dLat = pX * sfy - pY * sfx;
      const reach = Math.abs(qa);
      const wr = reach < 1.5 ? 0 : reach > 4 ? 1 : ((reach - 1.5) / 2.5) ** 2 * (3 - (2 * (reach - 1.5)) / 2.5);
      let dpsi = wr > 0 ? (wr * dLat) / qa : 0;
      dpsi = dpsi > 0.1 ? 0.1 : dpsi < -0.1 ? -0.1 : dpsi;
      // Displacement of the contact point by that turn: dpsi * (a * right - w * forward).
      const rotX = dpsi * (qa * sfy - qw * sfx);
      const rotY = dpsi * (qa * -sfx - qw * sfy);
      if (dpsi !== 0) {
        const h2 = sec.heading + dpsi;
        if (trailer) {
          // Swing the trailer about its hitch.
          sec.x = pivX - Math.sin(h2) * dH;
          sec.y = pivY - Math.cos(h2) * dH;
          sec.heading = h2;
        } else {
          pose.heading = h2;
          sec.heading = h2;
        }
      }
      const tX = pX - rotX;
      const tY = pY - rotY;
      pose.x += tX;
      pose.y += tY;
      for (const sp of pose.sections) {
        if (sp === pose) continue;
        sp.x += tX;
        sp.y += tY;
      }
      if (pose.sections[0]) {
        pose.sections[0].x = pose.x;
        pose.sections[0].y = pose.y;
        pose.sections[0].heading = pose.heading;
      }
      if (iter === 0) {
        out.nx = nx;
        out.ny = ny;
        out.depth = d;
        out.wall = best.wall;
        if (best.wall) out.wallIndex = best.wallIndex;
      }
      // Velocity: the into-obstacle component goes (a small bounce on hard hits); a glancing contact that
      // the turn takes up costs less speed. Scrape friction is proportional to the hit (Coulomb), so a
      // bus sliding along a wall keeps going.
      const fn = sfx * nx + sfy * ny;
      const vn = pose.speed * fn;
      if (vn < 0) {
        const impact = -vn;
        out.impact = Math.max(out.impact, impact);
        const e = impact > 2 ? 0.12 : 0;
        let v = pose.speed - (1 + e) * vn * fn * (1 - 0.6 * wr);
        const fr = Math.min(Math.abs(v), 0.35 * impact * Math.sqrt(Math.max(0, 1 - fn * fn)));
        v -= Math.sign(v) * fr;
        pose.speed = v;
      }
    }
    // River: front axle over water, at or below the water surface, and not on any road, bridge or route.
    const s0 = pose.sections[0] ?? pose;
    const fx = Math.sin(pose.heading);
    const fy = Math.cos(pose.heading);
    const wx = pose.x + fx * spec.wheelbase;
    const wy = pose.y + fy * spec.wheelbase;
    const wz = (s0.z ?? pose.z ?? 0) + Math.tan(s0.pitch ?? 0) * spec.wheelbase;
    if (!(Math.abs(wx - waterX) < 0.75 && Math.abs(wy - waterY) < 0.75)) {
      waterX = wx;
      waterY = wy;
      waterXY = inWater(wx, wy) && !onRoad(wx, wy, spec.width / 2 + 2);
    }
    if (waterXY && wz <= waterLevel + 0.3) out.water = true;
    return out;
  };

  const collider: SimCollider = {
    sim: true,
    heights: H,
    waterLevel,
    resolve,
    surface: (x, y, hintZ, maxStep) => H.surfaceAt(x, y, hintZ, maxStep),
    ground: (x, y) => H.ground(x, y),
    road: (i) => data.roads[i],
    pointInBuilding,
    drivable: (x, y, z) => drivableAt(x, y, z, 2.5),
    lineOfSight,
    nearestRoad,
    onRoad,
    inWater,
    walls,
    stats: {
      buildings: data.buildings.length,
      solid: solid.count,
      excludedByRoads: excludedCount,
      walls: nW,
      tunnelWalls: kindCount[WallKind.Tunnel],
      parapets: kindCount[WallKind.Parapet],
      retainingWalls: kindCount[WallKind.Retaining],
      bays: bayLines.length,
      buildMs: performance.now() - t0,
      phases,
    },
  };
  activeCollider = collider;
  return collider;
}

function wrap(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

function packPolys(rings: Float32Array[], lo: ArrayLike<number>, hi: ArrayLike<number>): PolySet {
  let total = 0;
  for (const r of rings) total += r.length;
  const v = new Float32Array(total);
  const off = new Int32Array(rings.length + 1);
  const bb = new Float32Array(rings.length * 4);
  let o = 0;
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    off[i] = o;
    v.set(r, o);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < r.length; k += 2) {
      const x = r[k];
      const y = r[k + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    bb[i * 4] = x0;
    bb[i * 4 + 1] = y0;
    bb[i * 4 + 2] = x1;
    bb[i * 4 + 3] = y1;
    o += r.length;
  }
  off[rings.length] = o;
  return { v, off, bb, lo: Float32Array.from(lo), hi: Float32Array.from(hi), count: rings.length };
}

function subsetPolys(p: PolySet, keep: number[]): PolySet {
  const rings: Float32Array[] = [];
  const lo: number[] = [];
  const hi: number[] = [];
  for (const i of keep) {
    rings.push(p.v.subarray(p.off[i], p.off[i + 1]));
    lo.push(p.lo[i]);
    hi.push(p.hi[i]);
  }
  return packPolys(rings, lo, hi);
}
