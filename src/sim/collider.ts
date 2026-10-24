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
  /** Seconds covered by the next resolve() (the physics frame), for frame-rate independent contact response. */
  setStepTime(dt: number): void;
  /**
   * Road surface under (x, y) at the level closest to `hintZ` (see Heights.surfaceAt; `heading` prefers
   * the road running that way). Station bays beside the through-lanes are surfaces too (at the busway's
   * height beside them, `road` = that busway), so wherever `drivable` is true there is a surface.
   */
  surface(x: number, y: number, hintZ?: number, maxStep?: number, heading?: number): Surface;
  ground(x: number, y: number): number;
  road(index: number): Road | undefined;
  /** True if (x, y) is inside a solid building footprint (at height z when given). */
  pointInBuilding(x: number, y: number, z?: number): boolean;
  /**
   * Fraction 0..1 along the 3D segment to the first building, wall or solid
   * ground (1 = clear), for cameras: also what the world draws over roads that
   * buses pass under (buildings lifted over a road, canopies, car-park decks)
   * and tube ceilings. Tunnel tubes, cuttings and station bays count as open
   * space, as does anything within `openNear` metres of the start (the bus itself).
   */
  lineOfSight(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, openNear?: number): number;
  /**
   * The lowest ceiling over (x, y) above height z (a covered tube's, a bridge deck's soffit, the underside
   * of a building or canopy), or Infinity under open sky. For cameras.
   */
  ceilingAt(x: number, y: number, z: number): number;
  /** A camera at (x, y, z) would be inside something drawn (building, canopy, ground or rock, deck). */
  viewBlocked(x: number, y: number, z: number): boolean;
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
    /** Camera-only: covered tube stretches (ceilings) and drawn-but-not-solid occluders. */
    ceilings: number;
    viewOccluders: number;
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
  /** For a bay strip: the road it leads to. */
  road?: number;
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
  /** Height of the nearest busway within `r` of (x, y), or null. */
  const buswayZNear = (x: number, y: number, r: number): number | null => {
    let best = r * r;
    let z: number | null = null;
    forEachRoadSegmentNear(x, y, r, (sg) => {
      const l = lines[sLine[sg]];
      if (l.kind !== RoadKind.Busway) return;
      project(l, sIdx[sg], x, y);
      if (PROJ.d2 < best) {
        best = PROJ.d2;
        z = PROJ.z;
      }
    });
    return z;
  };
  const addBay = (px: number, py: number, underground: boolean, poly: Float32Array | null, platformZ: number | null): void => {
    // Long platforms sit on a grade (Roma Street climbs 6 m along its platforms), so the level comes from
    // the busway beside this sample when there is one, else the platform's overall level.
    const levelZ = platformZ === null ? null : (buswayZNear(px, py, 20) ?? platformZ);
    let bestD = 16 * 16;
    let bestScore = Infinity;
    let qx = 0;
    let qy = 0;
    let qz = 0;
    let qr = -1;
    let qhw = 0;
    forEachRoadSegmentNear(px, py, 16, (sg) => {
      const l = lines[sLine[sg]];
      if (l.kind === RoadKind.Pedestrian) return;
      project(l, sIdx[sg], px, py);
      if (PROJ.d2 >= 16 * 16) return;
      // The road at the platform's own level (from its stop) wins: PA Hospital's platforms sit on the
      // busway viaduct above a street. Without a level, underground platforms belong to tunnel roads and
      // others usually not (covered busways are tagged tunnel).
      if (levelZ !== null && Math.abs(PROJ.z - levelZ) > 3) return;
      const score =
        Math.sqrt(PROJ.d2) + (levelZ !== null ? Math.abs(PROJ.z - levelZ) * 2 : l.tunnel === underground ? 0 : underground ? 8 : 3);
      if (score < bestScore) {
        bestScore = score;
        bestD = PROJ.d2;
        const v = sIdx[sg];
        qx = l.pts[2 * v] + (l.pts[2 * v + 2] - l.pts[2 * v]) * PROJ.t;
        qy = l.pts[2 * v + 1] + (l.pts[2 * v + 3] - l.pts[2 * v + 1]) * PROJ.t;
        qz = PROJ.z;
        qr = sLine[sg];
        qhw = l.width / 2;
      }
    });
    const d = Math.sqrt(bestD);
    // Nothing to fill where the carriageway already reaches the platform edge (wide busways, and the
    // station bay carriageways the map data may carry as roads of their own).
    if (d >= 16 || d < Math.max(0.5, qhw - 0.2)) return;
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
      road: qr,
    });
  };
  /**
   * Height of a platform: a busway within 20 m of one of its corners (platforms serve busways; PA
   * Hospital's sit on the busway viaduct with a street stop below), else the road height at the nearest
   * stop within 40 m. Bays refine it per sample from the busway beside them.
   */
  const platformLevel = (p: Float32Array): number | null => {
    for (let i = 0; i < p.length; i += 2) {
      const zb = buswayZNear(p[i], p[i + 1], 20);
      if (zb !== null) return zb;
    }
    let best = 40 * 40;
    let z: number | null = null;
    for (const st of data.stops ?? []) {
      for (let i = 0; i < p.length; i += 2) {
        const d2 = (st.x - p[i]) ** 2 + (st.y - p[i + 1]) ** 2;
        if (d2 < best) {
          best = d2;
          z = st.z ?? null;
        }
      }
    }
    return z;
  };
  for (const pl of data.platforms ?? []) {
    const p = pl.pts;
    const n = p.length / 2;
    if (n < 2) continue;
    const poly = pl.area ? p : null;
    const level = platformLevel(p);
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
      for (let k = 0; k <= steps; k++) addBay(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps, pl.underground, poly, level);
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
      addBay(p[2 * iLo] - ldx * k, p[2 * iLo + 1] - ldy * k, pl.underground, poly, level);
      addBay(p[2 * iHi] + ldx * k, p[2 * iHi + 1] + ldy * k, pl.underground, poly, level);
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

  /**
   * Station bay surface under (x, y) within `maxStep` of level z: the strips' busway heights, blended by
   * how far inside each strip the point is (smooth along the platform, where the strips overlap).
   */
  const bayAt = (x: number, y: number, z: number, maxStep: number): Surface | null => {
    let wSum = 0;
    let zSum = 0;
    let edge = Infinity;
    let road = -1;
    let bestW = 0;
    forEachBayNear(x, y, 3, (li) => {
      const l = lines[li];
      project(l, 0, x, y);
      const hw = l.width / 2;
      if (PROJ.d2 >= hw * hw || Math.abs(PROJ.z - z) > maxStep) return;
      const d = Math.sqrt(PROJ.d2);
      const w = hw - d;
      wSum += w;
      zSum += w * PROJ.z;
      edge = Math.min(edge, -w);
      if (w > bestW) {
        bestW = w;
        road = l.road ?? -1;
      }
    });
    if (wSum <= 0 || road < 0) return null;
    return { z: zSum / wSum, road, edge };
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
  /** Highest road / route through each excluded footprint (the world lifts the building over it). */
  const exZ = new Float32Array(polys.count).fill(-Infinity);
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
            if (excluded[b] && z <= exZ[b]) continue;
            // Only if a bus on this road would actually be inside the building's height band.
            if (z + BUS_ENVELOPE <= polys.lo[b] || z >= polys.hi[b]) continue;
            const o = b * 4;
            if (x < polys.bb[o] || y < polys.bb[o + 1] || x > polys.bb[o + 2] || y > polys.bb[o + 3]) continue;
            if (pip(polys.v, polys.off[b], polys.off[b + 1], x, y)) {
              if (!excluded[b]) excludedCount++;
              excluded[b] = 1;
              exZ[b] = z;
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

  // What the world draws over the roads but a bus never touches, for cameras: buildings a road runs
  // through, lifted to 5.2 m over it (src/world/buildings.ts clearanceOver), canopies (roof slabs
  // 0.6 m thick at the top of their height) and car-park decks over a road.
  const viewRings: Float32Array[] = [];
  const viewLo: number[] = [];
  const viewHi: number[] = [];
  for (let i = 0; i < polys.count; i++) {
    if (!excluded[i]) continue;
    const lo = Math.max(polys.lo[i], exZ[i] + 5.0);
    if (polys.hi[i] - lo < 0.3) continue;
    viewRings.push(polys.v.subarray(polys.off[i], polys.off[i + 1]));
    viewLo.push(lo);
    viewHi.push(polys.hi[i]);
  }
  for (const b of data.buildings) {
    if (b.pts.length < 6 || b.height < 0.5) continue;
    const bz = b.z ?? 0;
    const top = bz + b.height;
    if (b.kind === BuildingKind.Roof) {
      viewRings.push(b.pts);
      viewLo.push(Math.max(bz + b.minHeight, top - 0.6) - 0.1);
      viewHi.push(top + 0.1);
    } else if (b.kind === BuildingKind.Parking && b.minHeight > 0) {
      viewRings.push(b.pts);
      viewLo.push(bz + b.minHeight);
      viewHi.push(top);
    }
  }
  const view = packPolys(viewRings, viewLo, viewHi);
  const viewGrid = new Grid(gx0, gy0, gx1, gy1, 32);
  viewGrid.fill(view.count, (i, o) => {
    o[0] = view.bb[i * 4];
    o[1] = view.bb[i * 4 + 1];
    o[2] = view.bb[i * 4 + 2];
    o[3] = view.bb[i * 4 + 3];
    return true;
  });
  const viewStamp = new Int32Array(view.count);
  let viewStampId = 1;

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
  /** 1 for tunnel tube walls (they stand where the world draws them; routes never open them). */
  const wTube: number[] = [];
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

  /**
   * Height a retaining wall piece a-b, beside a road at level z, may reach: just under the deck of any
   * road (a bridge, a busway viaduct) passing over it, else `hi`. The ground line's wall stops at the
   * deck's soffit; left at the ground beside + 1 m it would stand on the deck above.
   */
  const capUnderDeck = (ax: number, ay: number, bx: number, by: number, z: number, hi: number): number => {
    let cap = hi;
    for (let k = 0; k <= 2; k++) {
      const x = ax + ((bx - ax) * k) / 2;
      const y = ay + ((by - ay) * k) / 2;
      forEachRoadSegmentNear(x, y, 10, (sg) => {
        const li = sLine[sg];
        const l = lines[li];
        if (l.kind === RoadKind.Pedestrian) return;
        project(l, sIdx[sg], x, y);
        // The deck, its parapets and a little beyond (the wall meets the abutment there).
        const r = l.width / 2 + 1.0;
        if (PROJ.d2 >= r * r || PROJ.z <= z + 3) return;
        // Under the deck's soffit (src/world/roads.ts buildBridge: 1.9 m deep for main roads and busways).
        const rd = data.roads[li];
        const heavy = l.kind <= RoadKind.Trunk || l.kind === RoadKind.Busway || !!rd?.bus;
        cap = Math.min(cap, PROJ.z - (heavy ? 1.9 : 1.3));
      });
    }
    return cap;
  };
  const pushWall = (ax: number, ay: number, bx: number, by: number, za: number, zb: number, onx: number, ony: number, ri: number) => {
    const r = data.roads[ri];
    const zm = (za + zb) / 2;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    let kind: WallKind;
    let lo = Math.min(za, zb) - 0.4;
    let hi: number;
    if (r.bridge) {
      kind = WallKind.Parapet;
      hi = Math.max(za, zb) + 1.1;
    } else {
      const g = H.ground(mx + onx * 2.5, my + ony * 2.5);
      if (g - zm < 1.5) return;
      kind = WallKind.Retaining;
      hi = capUnderDeck(ax, ay, bx, by, zm, g + 1.0);
      if (hi < zm + 1.0) return;
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
    // Retaining walls give way (the ground still stops a bus: see BusPhysics); parapets only
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
    wTube.push(0);
  };

  // Tunnel tubes, exactly where src/world/roads.ts (buildTube) draws them: walls hw + 0.9 out, between
  // samples every 4 m; open toward any other carriageway at this level (shared halls with a flush
  // floor), with a short nose wall where an open side closes again; pushed out past the far edge of
  // an underground platform beside the road (none at all at an island platform with another
  // carriageway just beyond it: one shared hall); and where there is no ground over the tube (portal
  // approaches) an open cutting whose wall stands at the same line, up to just above the ground.
  // The world's tubes are 5.8 m high inside (6.4 m for motorways); the walls only need to reach above a
  // bus, and must stay below roads that cross a shallow tube closer than that.
  const TUBE_WALL_H = 4.6;
  // The world's road index buckets segments in 32 m cells from bounds - 200 and only sees a segment
  // from a point in a cell its box (grown by the half-width) touches; mirrored so the openings agree.
  const wx0 = data.bounds[0] - 200;
  const wy0 = data.bounds[1] - 200;
  const wnx = Math.max(1, Math.ceil((data.bounds[2] + 200 - wx0) / 32));
  const wny = Math.max(1, Math.ceil((data.bounds[3] + 200 - wy0) / 32));
  const wcx = (x: number) => Math.min(wnx - 1, Math.max(0, Math.floor((x - wx0) / 32)));
  const wcy = (y: number) => Math.min(wny - 1, Math.max(0, Math.floor((y - wy0) / 32)));
  /**
   * As the world's tubeNb: largest (half-width - distance) of another road at this level: a tunnel
   * whose surface is within 3 m of z, or another road from 3 m below to 0.5 m above z (not a street
   * crossing over a shallow tube) where the ground is not far below the tube's top.
   */
  const tubeNb = (x: number, y: number, z: number, self: number): number => {
    let best = -Infinity;
    const level = H.ground(x, y) - (z + (data.roads[self].kind === RoadKind.Motorway ? 6.4 : 5.8)) > -1.8;
    const ci = wcx(x);
    const cj = wcy(y);
    forEachRoadSegmentNear(x, y, 0, (sg) => {
      const ri = sLine[sg];
      if (ri === self) return;
      const l = lines[ri];
      const v = sIdx[sg];
      const p = l.pts;
      const hw = l.width / 2;
      const ax = p[2 * v];
      const ay = p[2 * v + 1];
      const bx = p[2 * v + 2];
      const by = p[2 * v + 3];
      if (ci < wcx(Math.min(ax, bx) - hw) || ci > wcx(Math.max(ax, bx) + hw) || cj < wcy(Math.min(ay, by) - hw) || cj > wcy(Math.max(ay, by) + hw)) return;
      project(l, v, x, y);
      const pen = hw - Math.sqrt(PROJ.d2);
      const dz = PROJ.z - z;
      if (pen <= best || (l.tunnel ? Math.abs(dz) > 3 : !level || dz > 0.5 || dz < -3)) return;
      best = pen;
    });
    return best;
  };
  const tubePlatforms = (data.platforms ?? []).filter((pf) => pf.area && (pf.underground || pf.layer < 0) && pf.pts.length >= 6);
  const tubePlatBox = tubePlatforms.map((pf) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < pf.pts.length; i += 2) {
      x0 = Math.min(x0, pf.pts[i]);
      y0 = Math.min(y0, pf.pts[i + 1]);
      x1 = Math.max(x1, pf.pts[i]);
      y1 = Math.max(y1, pf.pts[i + 1]);
    }
    return [x0, y0, x1, y1];
  });
  const inTubePlatform = (x: number, y: number): boolean => {
    for (let i = 0; i < tubePlatforms.length; i++) {
      const b = tubePlatBox[i];
      if (x < b[0] || y < b[1] || x > b[2] || y > b[3]) continue;
      const pts = tubePlatforms[i].pts;
      if (pip(pts, 0, pts.length, x, y)) return true;
    }
    return false;
  };
  interface TubeAt {
    x: number;
    y: number;
    z: number;
    nx: number;
    ny: number;
  }
  const pushTube = (ax: number, ay: number, bx: number, by: number, lo: number, hi: number, kind: WallKind, ri: number) => {
    wAx.push(ax);
    wAy.push(ay);
    wBx.push(bx);
    wBy.push(by);
    wLo.push(lo);
    wHi.push(hi);
    wKind.push(kind);
    wRoad.push(ri);
    wTube.push(1);
  };
  // Tunnel vertex counts per node (every road, footways too): a tube whose end meets another tunnel
  // road runs on 2.5 m past it, so the two overlap on the outside of the bend.
  const tunNodes = new Map<number, number>();
  for (const r of data.roads) {
    if (!r.tunnel) continue;
    for (let v = 0; v < r.pts.length / 2; v++) {
      const k = nodeKey(r.pts[2 * v], r.pts[2 * v + 1]);
      tunNodes.set(k, (tunNodes.get(k) ?? 0) + 1);
    }
  }
  const TUBE_EXT = 2.5;
  /** Covered tube stretches: ax, ay, bx, by, road za, zb, reach left and right (to the walls), inside height. */
  const ceil: number[] = [];
  const tubeWalls = (ri: number) => {
    const r = data.roads[ri];
    const p = r.pts;
    const zs = lines[ri].z;
    const n = p.length / 2;
    if (n < 2) return;
    const cum = new Float64Array(n);
    for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(p[2 * k] - p[2 * k - 2], p[2 * k + 1] - p[2 * k - 1]);
    const len = cum[n - 1];
    if (len < 0.5) return;
    // Point, height and left normal at distance s (the world's roadAt).
    const at = (s: number): TubeAt => {
      let k = 0;
      let hi = n - 1;
      if (s >= len) k = n - 2;
      else if (s > 0) {
        while (hi - k > 1) {
          const m = (k + hi) >> 1;
          if (cum[m] <= s) k = m;
          else hi = m;
        }
      }
      k = Math.min(n - 2, Math.max(0, k));
      const segL = cum[k + 1] - cum[k] || 1e-6;
      const t = Math.min(1, Math.max(0, (s - cum[k]) / segL));
      const ax = p[2 * k];
      const ay = p[2 * k + 1];
      const dx = p[2 * k + 2] - ax;
      const dy = p[2 * k + 3] - ay;
      const l = Math.hypot(dx, dy) || 1;
      return { x: ax + dx * t, y: ay + dy * t, z: zs[k] + (zs[k + 1] - zs[k]) * t, nx: -dy / l, ny: dx / l };
    };
    const hw = r.width / 2;
    const wallOff = hw + 0.9;
    const TH = r.kind === RoadKind.Motorway ? 6.4 : 5.8;
    const ss: number[] = [];
    for (let s = 0; s <= len + 0.01; s += 4) ss.push(Math.min(s, len));
    if (ss[ss.length - 1] < len - 0.5) ss.push(len);
    const P0 = ss.map(at);
    const cov = P0.map((c) => H.ground(c.x, c.y) - (c.z + TH) > -1.2);
    const nP = P0.length;
    /** Per side (left, right) and sample: how far out the tube's hall reaches (past an underground platform). */
    const reach: number[][] = [[], []];
    const joinStart = (tunNodes.get(nodeKey(p[0], p[1])) ?? 0) > 1;
    const joinEnd = (tunNodes.get(nodeKey(p[2 * n - 2], p[2 * n - 1])) ?? 0) > 1;
    const unit = (a: TubeAt, b: TubeAt): [number, number] => {
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return [(b.x - a.x) / l, (b.y - a.y) / l];
    };
    const dirS = unit(P0[0], P0[Math.min(1, nP - 1)]);
    const dirE = unit(P0[Math.max(0, nP - 2)], P0[nP - 1]);
    for (const side of [1, -1]) {
      const nbAt = (c: TubeAt) => {
        const o = (d: number) => tubeNb(c.x + c.nx * side * d, c.y + c.ny * side * d, c.z, ri);
        return o(wallOff) > -0.5 || o(wallOff + 0.4) > -0.6 || o(wallOff + 3) > -0.6;
      };
      const open = P0.map(nbAt);
      const segOpen = ss.slice(1).map((s1, k) => open[k] || open[k + 1] || nbAt(at((ss[k] + s1) / 2)));
      // Underground platform beside the road: the wall stands past its far edge, unless another
      // carriageway lies just beyond it (an island platform), where the two share one hall.
      const platEdge = P0.map((c) => {
        let last = -1;
        for (let o = hw + 0.3; o < hw + 26; o += 0.5) {
          if (inTubePlatform(c.x + c.nx * side * o, c.y + c.ny * side * o)) last = o;
          else if (last >= 0 || o > hw + 8) break;
        }
        return last;
      });
      reach[side > 0 ? 0 : 1] = platEdge.map((e) => Math.max(wallOff, e >= 0 ? e + 0.9 : 0));
      const shared = P0.map((c, k) => {
        const last = platEdge[k];
        if (last < 0) return false;
        // Search 22 m past the platform: Queen St platform 2's far carriageway is ~13.5 m beyond its kerb.
        // Keep in step with the matching search in src/world/roads.ts.
        for (let o = last + 0.5; o <= last + 22; o += 0.5) if (tubeNb(c.x + c.nx * side * o, c.y + c.ny * side * o, c.z, ri) > -0.5) return true;
        return false;
      });
      const wo = platEdge.map((last, k) => (last >= 0 && !shared[k] ? Math.max(wallOff, last + 1.2) : wallOff));
      const P = (c: TubeAt, o: number): [number, number] => [c.x + c.nx * side * o, c.y + c.ny * side * o];
      for (let k = 0; k + 1 < ss.length; k++) {
        let A = P0[k];
        let B = P0[k + 1];
        // Shared segments are open like those toward a neighbouring carriageway.
        const isOpen = segOpen[k] || shared[k] || shared[k + 1];
        if (k > 0 && (segOpen[k - 1] || shared[k - 1] || shared[k]) !== isOpen && cov[k]) {
          // Nose wall sealing the wedge between two tubes where an open side closes.
          for (let o = wallOff + 0.5; o <= wallOff + 12; o += 0.5) {
            const [qx, qy] = P(A, o);
            if (tubeNb(qx, qy, A.z, ri) > -1.0) {
              const [sx, sy] = P(A, wallOff);
              pushTube(sx, sy, qx, qy, A.z - 0.4, A.z + TUBE_WALL_H, WallKind.Tunnel, ri);
              break;
            }
          }
        }
        if (isOpen) continue;
        if (!cov[k] && !cov[k + 1]) {
          // Open cutting: retaining wall at the same line, up to 0.9 m above the ground behind it.
          const [ax, ay] = P(A, hw + 0.9);
          const [bx, by] = P(B, hw + 0.9);
          const [gax, gay] = P(A, hw + 1.4);
          const [gbx, gby] = P(B, hw + 1.4);
          const top = Math.max(H.ground(gax, gay) + 0.9, A.z + 1.18, H.ground(gbx, gby) + 0.9, B.z + 1.18);
          const zm = (A.z + B.z) / 2;
          pushTube(ax, ay, bx, by, Math.min(A.z, B.z) - 0.4, Math.max(zm + 1.18, capUnderDeck(ax, ay, bx, by, zm, top)), WallKind.Retaining, ri);
          continue;
        }
        if (k === 0 && joinStart) A = { ...A, x: A.x - dirS[0] * TUBE_EXT, y: A.y - dirS[1] * TUBE_EXT };
        if (k + 2 === ss.length && joinEnd) B = { ...B, x: B.x + dirE[0] * TUBE_EXT, y: B.y + dirE[1] * TUBE_EXT };
        const [ax, ay] = P(A, wo[k]);
        const [bx, by] = P(B, wo[k + 1]);
        pushTube(ax, ay, bx, by, Math.min(A.z, B.z) - 0.4, Math.max(A.z, B.z) + TUBE_WALL_H, WallKind.Tunnel, ri);
      }
    }
    // The tube's ceiling (for cameras), between covered samples, over the platforms beside it too.
    for (let k = 0; k + 1 < nP; k++) {
      if (!cov[k] || !cov[k + 1]) continue;
      const rl = Math.max(reach[0][k], reach[0][k + 1]);
      const rr = Math.max(reach[1][k], reach[1][k + 1]);
      ceil.push(P0[k].x, P0[k].y, P0[k + 1].x, P0[k + 1].y, P0[k].z, P0[k + 1].z, rl, rr, TH);
    }
  };

  for (let ri = 0; ri < data.roads.length; ri++) {
    const r = data.roads[ri];
    if (r.tunnel) {
      tubeWalls(ri);
      continue;
    }
    if (r.kind === RoadKind.Pedestrian) continue;
    // A station stopping bay (map data, see Road.bay) runs between the busway and the platform kerb:
    // no wall on either side (the deck edge beyond the platform still stops a bus, see BusPhysics).
    if ((r as { bay?: boolean }).bay) continue;
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
  const CEIL = 9;
  const nCeil = ceil.length / CEIL;
  const ceilGrid = new Grid(gx0, gy0, gx1, gy1, 24);
  ceilGrid.fill(nCeil, (i, o) => {
    const c = i * CEIL;
    const r = Math.max(ceil[c + 6], ceil[c + 7]);
    o[0] = Math.min(ceil[c], ceil[c + 2]) - r;
    o[1] = Math.min(ceil[c + 1], ceil[c + 3]) - r;
    o[2] = Math.max(ceil[c], ceil[c + 2]) + r;
    o[3] = Math.max(ceil[c + 1], ceil[c + 3]) + r;
    return true;
  });
  // Bus routes crossing a wall at its level open a gap there (with a few metres either side).
  const crossings: number[] = [];
  for (let w = 0; w < wAx.length; w++) {
    if (wTube[w]) continue;
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
    const list = wTube[w] ? undefined : crossGrid.get(ck(mx, my));
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

  /**
   * The covered tube around (x, y) at height z (between its floor and its ceiling): its ceiling height,
   * else NaN. `roof` also counts the roof slab above the ceiling (3 m) as part of the tube.
   */
  const tubeCeiling = (x: number, y: number, z: number, roof = 0): number => {
    const cell = ceilGrid.cy(y) * ceilGrid.nx + ceilGrid.cx(x);
    let best = NaN;
    for (let q = ceilGrid.start[cell], e = ceilGrid.start[cell + 1]; q < e; q++) {
      const c = ceilGrid.items[q] * CEIL;
      const ax = ceil[c];
      const ay = ceil[c + 1];
      const ex = ceil[c + 2] - ax;
      const ey = ceil[c + 3] - ay;
      const l2 = ex * ex + ey * ey || 1e-9;
      let t = ((x - ax) * ex + (y - ay) * ey) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = x - ax - ex * t;
      const py = y - ay - ey * t;
      // Left of the road's direction (its normal -ey, ex) or right.
      const r = px * -ey + py * ex >= 0 ? ceil[c + 6] : ceil[c + 7];
      if (px * px + py * py > r * r) continue;
      const zr = ceil[c + 4] + (ceil[c + 5] - ceil[c + 4]) * t;
      const top = zr + ceil[c + 8];
      if (z < zr - 0.5 || z > top + roof) continue;
      if (!(best <= top)) best = top;
    }
    return best;
  };

  /** Inside a road corridor's air space (tunnel tube, cutting, under a bridge deck) at height z. */
  const inCorridor = (x: number, y: number, z: number): boolean => {
    // In a covered tube: only inside it (below the ceiling, between the walls).
    const tc = tubeCeiling(x, y, z, 3);
    if (tc === tc) return z < tc;
    let found = false;
    forEachRoadSegmentNear(x, y, 3, (s) => {
      const l = lines[sLine[s]];
      project(l, sIdx[s], x, y);
      // A tunnel's cutting or tube ends at its walls (hw + 0.9); other roads' verges and embankments
      // run a little wider.
      const w = l.width / 2 + (l.tunnel ? 1.0 : 2.5);
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
  /**
   * First hit of segment 0-1 with polygon i of set P (its walls, its underside and its top), as a
   * fraction of the segment, if below `best`.
   */
  const polyHit = (P: PolySet, i: number, x0: number, y0: number, z0: number, dx: number, dy: number, dz: number, best: number): number => {
    const v = P.v;
    const a = P.off[i];
    const b = P.off[i + 1];
    const lo = P.lo[i];
    const hi = P.hi[i];
    for (let k = a, j = b - 2; k < b; j = k, k += 2) {
      const t = segHit(x0, y0, x0 + dx, y0 + dy, v[j], v[j + 1], v[k], v[k + 1]);
      if (t < 0 || t >= best) continue;
      const z = z0 + dz * t;
      if (z >= lo && z <= hi) best = t;
    }
    if (Math.abs(dz) > 1e-6) {
      for (const zf of [lo, hi]) {
        const t = (zf - z0) / dz;
        if (t <= 0 || t >= best) continue;
        if (pip(v, a, b, x0 + dx * t, y0 + dy * t)) best = t;
      }
    }
    return best;
  };
  /** Ceiling over (x, y) above height z: a covered tube's, a deck's soffit, or a building's (or canopy's) underside. */
  const ceilingAt = (x: number, y: number, z: number): number => {
    let best = Infinity;
    const tc = tubeCeiling(x, y, z);
    if (tc === tc) best = tc;
    forEachRoadSegmentNear(x, y, 2, (s) => {
      const li = sLine[s];
      const l = lines[li];
      if (!l.bridge) return;
      project(l, sIdx[s], x, y);
      const w = l.width / 2 + 0.45;
      if (PROJ.d2 >= w * w) return;
      const heavy = l.kind <= RoadKind.Trunk || l.kind === RoadKind.Busway || !!data.roads[li]?.bus;
      const soffit = PROJ.z - (heavy ? 1.9 : 1.3);
      if (soffit > z && soffit < best) best = soffit;
    });
    const scanSet = (P: PolySet, G: Grid) => {
      const cell = G.cy(y) * G.nx + G.cx(x);
      for (let q = G.start[cell], e = G.start[cell + 1]; q < e; q++) {
        const i = G.items[q];
        const o = i * 4;
        if (P.lo[i] <= z || P.lo[i] >= best) continue;
        if (x < P.bb[o] || y < P.bb[o + 1] || x > P.bb[o + 2] || y > P.bb[o + 3]) continue;
        if (pip(P.v, P.off[i], P.off[i + 1], x, y)) best = P.lo[i];
      }
    };
    scanSet(solid, grid);
    scanSet(view, viewGrid);
    return best;
  };
  /** Is a camera at (x, y, z) inside something drawn: a building, a canopy, the ground or rock, a deck? */
  const viewBlocked = (x: number, y: number, z: number): boolean => {
    if (pointInBuilding(x, y, z)) return true;
    const cell = viewGrid.cy(y) * viewGrid.nx + viewGrid.cx(x);
    for (let q = viewGrid.start[cell], e = viewGrid.start[cell + 1]; q < e; q++) {
      const i = viewGrid.items[q];
      const o = i * 4;
      if (z < view.lo[i] || z > view.hi[i]) continue;
      if (x < view.bb[o] || y < view.bb[o + 1] || x > view.bb[o + 2] || y > view.bb[o + 3]) continue;
      if (pip(view.v, view.off[i], view.off[i + 1], x, y)) return true;
    }
    return (z < H.ground(x, y) - 0.4 && !inCorridor(x, y, z)) || underDeck(x, y, z);
  };
  const lineOfSight = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, openNear = 0): number => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dy);
    let best = 1;
    if (len > 1e-6) {
      gather(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1));
      for (const i of candidates) best = polyHit(solid, i, x0, y0, z0, dx, dy, dz, best);
      // Buildings lifted over roads, canopies and car-park decks (drawn, but not solid to buses).
      viewStampId++;
      const a = viewGrid.cx(Math.min(x0, x1));
      const b = viewGrid.cy(Math.min(y0, y1));
      const c = viewGrid.cx(Math.max(x0, x1));
      const d = viewGrid.cy(Math.max(y0, y1));
      for (let gy = b; gy <= d; gy++)
        for (let gx = a; gx <= c; gx++) {
          const cell = gy * viewGrid.nx + gx;
          for (let q = viewGrid.start[cell], e = viewGrid.start[cell + 1]; q < e; q++) {
            const i = viewGrid.items[q];
            if (viewStamp[i] === viewStampId) continue;
            viewStamp[i] = viewStampId;
            const o = i * 4;
            if (view.bb[o] > Math.max(x0, x1) || view.bb[o + 2] < Math.min(x0, x1) || view.bb[o + 1] > Math.max(y0, y1) || view.bb[o + 3] < Math.min(y0, y1)) continue;
            if (view.lo[i] > Math.max(z0, z1) || view.hi[i] < Math.min(z0, z1)) continue;
            best = polyHit(view, i, x0, y0, z0, dx, dy, dz, best);
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
      // Up through a tube's ceiling (where the rock above may still be under the natural ground line).
      const tc = tubeCeiling(x, y, z, 3);
      if (tc === tc && z > tc) {
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
          ((data.roads[sLine[s]] as { bay?: boolean } | undefined)?.bay ? 3 : 0) +
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
  let stepTime = 1 / 60;
  let hadContact = false;

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
      // Walls: exact segment-vs-box overlap (separating axes: the box's two axes and the wall normal).
      // Across the wall line the push always goes back to the side the section's centre is on.
      const wl = secWalls[s];
      for (let wi = 0; wi < wl.length; wi++) {
        const w = wl[wi];
        if (walls.lo[w] >= hi || walls.hi[w] <= lo) continue;
        const ax = walls.ax[w];
        const ay = walls.ay[w];
        const bx = walls.bx[w];
        const by = walls.by[w];
        const ex = bx - ax;
        const ey = by - ay;
        const L = Math.hypot(ex, ey);
        if (L < 1e-4) continue;
        // Segment in the box frame (u forward, v right), centred on the box.
        const ua = (ax - cx) * fx + (ay - cy) * fy;
        const va = (ax - cx) * rx + (ay - cy) * ry;
        const ub = (bx - cx) * fx + (by - cy) * fy;
        const vb = (bx - cx) * rx + (by - cy) * ry;
        // Box axes.
        const uMin = Math.min(ua, ub);
        const uMax = Math.max(ua, ub);
        if (uMax <= -hl || uMin >= hl) continue;
        const vMin = Math.min(va, vb);
        const vMax = Math.max(va, vb);
        if (vMax <= -hw || vMin >= hw) continue;
        // Wall normal.
        const nx = -ey / L;
        const ny = ex / L;
        const cn = (cx - ax) * nx + (cy - ay) * ny; // centre's signed distance from the wall line
        const en = hl * Math.abs(fx * nx + fy * ny) + hw * Math.abs(rx * nx + ry * ny);
        if (Math.abs(cn) >= en) continue;
        const side = cn >= 0 ? 1 : -1;
        // Clip the segment to the box: the part of the wall inside the bus (for the contact point).
        let t0 = 0;
        let t1 = 1;
        const du = ub - ua;
        const dv = vb - va;
        const clip = (pp: number, qq: number): boolean => {
          if (Math.abs(pp) < 1e-9) return qq >= 0;
          const r = qq / pp;
          if (pp < 0) {
            if (r > t1) return false;
            if (r > t0) t0 = r;
          } else {
            if (r < t0) return false;
            if (r < t1) t1 = r;
          }
          return true;
        };
        if (!(clip(-du, ua + hl) && clip(du, hl - ua) && clip(-dv, va + hw) && clip(dv, hw - va) && t0 <= t1)) continue;
        const tm = (t0 + t1) / 2;
        // Penetration along each axis; the shallowest is the way out.
        const dN = en - Math.abs(cn); // how far the box reaches across the wall line
        const dUf = uMax + hl; // move the bus forward to clear the piece
        const dUb = hl - uMin; // ... or back
        const dVr = vMax + hw; // move it right
        const dVl = hw - vMin; // ... or left
        let d = dN;
        let px = nx * side * dN;
        let py = ny * side * dN;
        // Contact point: where the wall cuts into the box.
        let qx = ax + ex * tm;
        let qy = ay + ey * tm;
        if (dUf < d) {
          d = dUf;
          px = fx * dUf;
          py = fy * dUf;
          const k = ua > ub ? 1 : 0; // the end furthest forward
          qx = k ? ax + ex * t0 : ax + ex * t1;
          qy = k ? ay + ey * t0 : ay + ey * t1;
        }
        if (dUb < d) {
          d = dUb;
          px = -fx * dUb;
          py = -fy * dUb;
          const k = ua < ub ? 1 : 0;
          qx = k ? ax + ex * t0 : ax + ex * t1;
          qy = k ? ay + ey * t0 : ay + ey * t1;
        }
        if (dVr < d) {
          d = dVr;
          px = rx * dVr;
          py = ry * dVr;
          const k = va > vb ? 1 : 0;
          qx = k ? ax + ex * t0 : ax + ex * t1;
          qy = k ? ay + ey * t0 : ay + ey * t1;
        }
        if (dVl < d) {
          d = dVl;
          px = -rx * dVl;
          py = -ry * dVl;
          const k = va < vb ? 1 : 0;
          qx = k ? ax + ex * t0 : ax + ex * t1;
          qy = k ? ay + ey * t0 : ay + ey * t1;
        }
        if (d > best.depth) {
          best.depth = d;
          best.px = px;
          best.py = py;
          best.qx = qx;
          best.qy = qy;
          best.sec = s;
          best.wall = true;
          best.wallIndex = w;
        }
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
    const f0x = Math.sin(pose.heading);
    const f0y = Math.cos(pose.heading);
    const v0 = pose.speed;
    let tAlong = 0; // translation along the heading (m): negative = pushed back
    let tLat = 0; // sideways translation (m)
    let turned = 0; // heading change imposed by the contact (rad, all sections)
    let firstVn = 0;
    for (let iter = 0; iter < 4; iter++) {
      if (!findContact(pose, spec)) break;
      out.hit = true;
      const depth = best.depth + 0.002;
      const nx = best.px / best.depth;
      const ny = best.py / best.depth;
      if (iter === 0) {
        out.nx = nx;
        out.ny = ny;
        out.depth = best.depth;
        out.wall = best.wall;
        if (best.wall) out.wallIndex = best.wallIndex;
      }
      // Resolve a glancing contact by turning the section about its pivot - the rear axle for the front
      // section, the hitch for a trailer - so a bus pressed against a wall swings parallel and slides along
      // it. Head-on contacts and contacts near the pivot are pushed straight out instead.
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
      const rn = sfy * nx - sfx * ny; // right . n
      const fn = sfx * nx + sfy * ny; // forward . n
      // A turn by dpsi moves the contact point by dpsi * (qa * right - qw * forward).
      const den = qa * rn - qw * fn;
      const lever = Math.min(1, Math.max(0, (Math.abs(qa) - 1.5) / 2.5));
      const lateral = Math.min(1, Math.max(0, (Math.abs(rn) - 0.3) / 0.4));
      const wRot = lever * lateral * (Math.abs(den) > 0.5 ? 1 : 0);
      let dpsi = wRot > 0 ? (wRot * depth) / den : 0;
      dpsi = dpsi > 0.12 ? 0.12 : dpsi < -0.12 ? -0.12 : dpsi;
      if (dpsi !== 0) {
        const h2 = sec.heading + dpsi;
        if (trailer) {
          sec.x = pivX - Math.sin(h2) * dH;
          sec.y = pivY - Math.cos(h2) * dH;
          sec.heading = h2;
        } else {
          pose.heading = h2;
          sec.heading = h2;
        }
        turned += Math.abs(dpsi);
      }
      // Whatever the turn didn't take out, push straight out along the normal.
      const rest = depth - dpsi * den;
      const tX = nx * rest;
      const tY = ny * rest;
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
      tAlong += tX * f0x + tY * f0y;
      tLat += Math.abs(tX * f0y - tY * f0x);
      if (iter === 0) firstVn = Math.max(0, -v0 * fn);
    }
    if (out.hit) {
      // Speed: lose what was actually blocked along the heading this frame (head-on: all of it; sliding
      // along a wall: none), then scrape friction in proportion to how hard the wall turns or shoves the bus.
      const dt = stepTime;
      const reach = Math.max(1e-4, Math.abs(v0) * dt);
      const blocked = v0 > 0 ? Math.max(0, -tAlong) / reach : v0 < 0 ? Math.max(0, tAlong) / reach : 0;
      let v = v0 * Math.max(0, 1 - Math.min(1, blocked));
      const fr = 0.35 * (turned * Math.abs(v0) + (0.3 * tLat) / dt);
      v = Math.sign(v) * Math.max(0, Math.abs(v) - fr);
      const lost = Math.abs(v0) - Math.abs(v);
      // A fresh hit: report the speed into the obstacle (thump); a small bounce off a hard head-on hit.
      if (!hadContact) out.impact = Math.max(firstVn, lost);
      else out.impact = lost;
      if (!hadContact && blocked > 0.8 && Math.abs(v0) > 2) v = -0.12 * v0;
      pose.speed = v;
    }
    hadContact = out.hit;
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
    setStepTime: (dt) => {
      stepTime = Math.max(1e-3, Math.min(0.1, dt));
    },
    surface: (x, y, hintZ, maxStep, heading) => {
      const s = H.surfaceAt(x, y, hintZ, maxStep, heading);
      // Inside a carriageway at this level: that's it. On a verge or off every road: a station bay?
      if (hintZ === undefined || bayLines.length === 0 || (s.road >= 0 && s.edge <= 0)) return s;
      return bayAt(x, y, hintZ, maxStep ?? 2.5) ?? s;
    },
    ground: (x, y) => H.ground(x, y),
    road: (i) => data.roads[i],
    pointInBuilding,
    drivable: (x, y, z) => drivableAt(x, y, z, 2.5),
    lineOfSight,
    ceilingAt,
    viewBlocked,
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
      ceilings: nCeil,
      viewOccluders: view.count,
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
