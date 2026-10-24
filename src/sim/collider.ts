/**
 * Static collision against building footprints, plus the map queries the
 * driving subsystem needs (river detection, nearest road for resets, line of
 * sight for cameras).
 *
 * Building exclusions so every real route stays drivable:
 *  - any footprint a road centreline (or a bus route polyline) passes through
 *    is dropped: awnings, over-road structures, buildings over busway tunnels
 *    (Queen Street, King George Square, Cultural Centre) and under flyovers;
 *  - building parts that float above bus height (min_height > 3.5 m);
 *  - roofs/canopies (on posts) and raised car parks.
 *
 * Contact model: each section is an oriented rectangle. Contacts are (a) bus
 * corners inside a footprint, pushed to the nearest edge, and (b) footprint
 * vertices inside the bus rectangle, pushed out through the nearest face. The
 * deepest contact is resolved first, a few iterations per frame.
 */
import type { BusPose, BusSpec, Collider, MapData } from '../types';
import { BuildingKind, RoadKind } from '../types';

export interface RoadSnap {
  x: number;
  y: number;
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
  /** The bus has driven into the river (front axle over water, not on any road or bridge). */
  water?: boolean;
  /** Push-out normal of the deepest contact (map coords). */
  nx?: number;
  ny?: number;
  depth?: number;
}

export interface SimCollider extends Collider {
  readonly sim: true;
  resolve(pose: BusPose, spec: BusSpec): ResolveResult;
  /** True if (x, y) is inside a solid building footprint. */
  pointInBuilding(x: number, y: number, minHeight?: number): boolean;
  /** Fraction 0..1 along the segment to the first solid building at least `minHeight` tall (1 = clear). */
  raycast(x0: number, y0: number, x1: number, y1: number, minHeight?: number): number;
  nearestRoad(x: number, y: number, heading?: number, maxDist?: number): RoadSnap | null;
  /** Distance from (x, y) to the nearest road edge is below `margin` (any road, including bridges). */
  onRoad(x: number, y: number, margin?: number): boolean;
  inWater(x: number, y: number): boolean;
  readonly stats: { buildings: number; solid: number; excludedByRoads: number; buildMs: number };
}

export function isSimCollider(c: Collider): c is SimCollider {
  return (c as Partial<SimCollider>).sim === true;
}

/** The most recently built collider (cameras use it for line-of-sight). */
export let activeCollider: SimCollider | null = null;

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
  /** Fill from per-item bounding boxes (flat minx,miny,maxx,maxy). */
  fill(count: number, bbox: (i: number) => [number, number, number, number] | null): void {
    const n = this.nx * this.ny;
    const counts = new Int32Array(n + 1);
    const boxes = new Int32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const b = bbox(i);
      if (!b) {
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
  height: Float32Array;
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

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qy = ay + dy * t - py;
  return qx * qx + qy * qy;
}

export function buildCollider(data: MapData): SimCollider {
  const t0 = performance.now();
  const [bx0, by0, bx1, by1] = data.bounds;
  const pad = 400;
  const gx0 = bx0 - pad;
  const gy0 = by0 - pad;
  const gx1 = bx1 + pad;
  const gy1 = by1 + pad;

  // --- 1. Candidate solid buildings -------------------------------------------
  const cand: number[] = [];
  for (let i = 0; i < data.buildings.length; i++) {
    const b = data.buildings[i];
    if (b.minHeight > 3.5) continue;
    if (b.kind === BuildingKind.Roof) continue;
    if (b.kind === BuildingKind.Parking && b.minHeight > 0) continue;
    if (b.height < 1.2 || b.pts.length < 6) continue;
    cand.push(i);
  }
  const polys = packPolys(cand.map((i) => data.buildings[i].pts), cand.map((i) => data.buildings[i].height));

  // Coarse grid for the exclusion pass.
  const exGrid = new Grid(gx0, gy0, gx1, gy1, 32);
  exGrid.fill(polys.count, (i) => [polys.bb[i * 4], polys.bb[i * 4 + 1], polys.bb[i * 4 + 2], polys.bb[i * 4 + 3]]);

  // --- 2. Drop footprints that a road / route passes through ---------------------
  const excluded = new Uint8Array(polys.count);
  let excludedCount = 0;
  const seen = new Set<number>();
  const sampleLine = (pts: Float32Array, offsets: readonly number[], dedupe = false) => {
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
      const len = Math.hypot(dx, dy);
      // Right-hand normal of this segment (the previous one for the last vertex).
      const pdx = last && i > 0 ? ax - pts[2 * i - 2] : dx;
      const pdy = last && i > 0 ? ay - pts[2 * i - 1] : dy;
      const pl = Math.hypot(pdx, pdy) || 1;
      const nx = pdy / pl;
      const ny = -pdx / pl;
      const steps = last ? 1 : Math.max(1, Math.ceil(len / 2.5));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        for (const off of offsets) {
          const x = ax + dx * t + nx * off;
          const y = ay + dy * t + ny * off;
          const c = exGrid.cy(y) * exGrid.nx + exGrid.cx(x);
          for (let q = exGrid.start[c], e = exGrid.start[c + 1]; q < e; q++) {
            const b = exGrid.items[q];
            if (excluded[b]) continue;
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
    if (r.tunnel) {
      // Long road tunnels (Clem7, Legacy Way, Airport Link) only matter where a bus route uses them (below).
      if (!r.bus && r.kind !== RoadKind.Busway && polyLength(r.pts) > 350) continue;
      // The whole carriageway is underground: clear anything above it.
      const h = r.width / 2;
      sampleLine(r.pts, [-h, -h / 2, 0, h / 2, h]);
    } else sampleLine(r.pts, CENTRE);
  }
  // Bus routes: the bus itself is ~2.5 m wide and GTFS shapes wander a little off the mapped centreline
  // (and run through tunnels under houses), so keep a 2 m corridor either side of every route clear.
  for (const rt of data.routes) sampleLine(rt.pts, [-2, 0, 2], true);

  // --- 3. Final solid set and query grid ----------------------------------------------
  const keep: number[] = [];
  for (let i = 0; i < polys.count; i++) if (!excluded[i]) keep.push(i);
  const solid = subsetPolys(polys, keep);
  const grid = new Grid(gx0, gy0, gx1, gy1, 20);
  grid.fill(solid.count, (i) => [solid.bb[i * 4], solid.bb[i * 4 + 1], solid.bb[i * 4 + 2], solid.bb[i * 4 + 3]]);
  const stamp = new Int32Array(solid.count);
  let stampId = 1;

  // --- 4. Roads (segments) for snapping and the river test -------------------------
  // Bus route polylines are added as extra "lines" (never snapped to) so routes through
  // under-river tunnels such as Clem7 don't count as driving into the river.
  interface Line {
    pts: Float32Array;
    width: number;
    kind: RoadKind;
    oneway: boolean;
    tunnel: boolean;
    link: boolean;
    route: boolean;
  }
  const lines: Line[] = data.roads.map((r) => ({ pts: r.pts, width: r.width, kind: r.kind, oneway: r.oneway, tunnel: r.tunnel, link: r.link, route: false }));
  for (const rt of data.routes)
    lines.push({ pts: rt.pts, width: 10, kind: RoadKind.Busway, oneway: true, tunnel: false, link: false, route: true });
  const segRoad: number[] = [];
  const segIdx: number[] = [];
  for (let r = 0; r < lines.length; r++) {
    const n = lines[r].pts.length / 2;
    for (let i = 0; i + 1 < n; i++) {
      segRoad.push(r);
      segIdx.push(i);
    }
  }
  const sRoad = Int32Array.from(segRoad);
  const sIdx = Int32Array.from(segIdx);
  const roadGrid = new Grid(gx0, gy0, gx1, gy1, 40);
  roadGrid.fill(sRoad.length, (s) => {
    const r = lines[sRoad[s]];
    const p = r.pts;
    const i = sIdx[s] * 2;
    const m = r.width / 2;
    return [Math.min(p[i], p[i + 2]) - m, Math.min(p[i + 1], p[i + 3]) - m, Math.max(p[i], p[i + 2]) + m, Math.max(p[i + 1], p[i + 3]) + m];
  });

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

  const pointInBuilding = (x: number, y: number, minHeight = 0): boolean => {
    const cell = grid.cy(y) * grid.nx + grid.cx(x);
    for (let q = grid.start[cell], e = grid.start[cell + 1]; q < e; q++) {
      const i = grid.items[q];
      const o = i * 4;
      if (x < solid.bb[o] || y < solid.bb[o + 1] || x > solid.bb[o + 2] || y > solid.bb[o + 3]) continue;
      if (solid.height[i] < minHeight) continue;
      if (pip(solid.v, solid.off[i], solid.off[i + 1], x, y)) return true;
    }
    return false;
  };

  const raycast = (x0: number, y0: number, x1: number, y1: number, minHeight = 0): number => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-6) return 1;
    gather(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1));
    let best = 1;
    const dx = x1 - x0;
    const dy = y1 - y0;
    for (const i of candidates) {
      if (solid.height[i] < minHeight) continue;
      const v = solid.v;
      const a = solid.off[i];
      const b = solid.off[i + 1];
      for (let k = a, j = b - 2; k < b; j = k, k += 2) {
        const ex = v[k] - v[j];
        const ey = v[k + 1] - v[j + 1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const wx = v[j] - x0;
        const wy = v[j + 1] - y0;
        const t = (wx * ey - wy * ex) / den;
        const u = (wx * dy - wy * dx) / den;
        if (t >= 0 && t < best && u >= 0 && u <= 1) best = t;
      }
    }
    return best;
  };

  const forEachSegmentNear = (x: number, y: number, radius: number, fn: (s: number, d2: number) => void) => {
    const a = roadGrid.cx(x - radius);
    const b = roadGrid.cy(y - radius);
    const c = roadGrid.cx(x + radius);
    const d = roadGrid.cy(y + radius);
    for (let gy = b; gy <= d; gy++) {
      for (let gx = a; gx <= c; gx++) {
        const cell = gy * roadGrid.nx + gx;
        for (let q = roadGrid.start[cell], e = roadGrid.start[cell + 1]; q < e; q++) {
          const s = roadGrid.items[q];
          const p = lines[sRoad[s]].pts;
          const i = sIdx[s] * 2;
          fn(s, segDist2(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]));
        }
      }
    }
  };

  const onRoad = (x: number, y: number, margin = 2): boolean => {
    let found = false;
    forEachSegmentNear(x, y, 30, (s, d2) => {
      if (found) return;
      const w = lines[sRoad[s]].width / 2 + margin;
      if (d2 <= w * w) found = true;
    });
    return found;
  };

  const nearestRoad = (x: number, y: number, heading = 0, maxDist = 200): RoadSnap | null => {
    let bestS = -1;
    let bestScore = Infinity;
    for (let radius = 40; radius <= maxDist + 40; radius *= 2) {
      forEachSegmentNear(x, y, radius, (s, d2) => {
        const r = lines[sRoad[s]];
        if (r.route || r.kind === RoadKind.Pedestrian) return;
        const d = Math.sqrt(d2);
        if (d > maxDist) return;
        const p = r.pts;
        const i = sIdx[s] * 2;
        const segH = Math.atan2(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
        let dh = Math.abs(wrap(segH - heading));
        if (!r.oneway) dh = Math.min(dh, Math.PI - dh);
        const score =
          d +
          (r.kind === RoadKind.Service ? 4 : 0) +
          (r.tunnel ? 25 : 0) +
          (r.kind === RoadKind.Motorway && !r.link ? 6 : 0) +
          dh * 3;
        if (score < bestScore) {
          bestScore = score;
          bestS = s;
        }
      });
      if (bestS >= 0) break;
    }
    if (bestS < 0) return null;
    const r = lines[sRoad[bestS]];
    const p = r.pts;
    const i = sIdx[bestS] * 2;
    const ax = p[i];
    const ay = p[i + 1];
    const dx = p[i + 2] - ax;
    const dy = p[i + 3] - ay;
    const l2 = dx * dx + dy * dy || 1e-9;
    let t = ((x - ax) * dx + (y - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    let h = Math.atan2(dx, dy);
    if (!r.oneway && Math.abs(wrap(h - heading)) > Math.PI / 2) h = wrap(h + Math.PI);
    const sx = ax + dx * t;
    const sy = ay + dy * t;
    return { x: sx, y: sy, heading: h, width: r.width, oneway: r.oneway, road: sRoad[bestS], dist: Math.hypot(sx - x, sy - y) };
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
  let waterX = NaN;
  let waterY = NaN;
  let waterHit = false;

  interface Contact {
    depth: number;
    px: number;
    py: number;
    sec: number;
  }
  const best: Contact = { depth: 0, px: 0, py: 0, sec: 0 };

  const sectionBox = (pose: BusPose, spec: BusSpec, s: number) => {
    const sp = pose.sections[s] ?? pose;
    const ss = spec.sections[s];
    const fx = Math.sin(sp.heading);
    const fy = Math.cos(sp.heading);
    // right = (fy, -fx)
    const co = ss.axleFromFront - ss.length / 2;
    const cx = sp.x + fx * co;
    const cy = sp.y + fy * co;
    // Trailing sections overlap the bellows slightly; trim so joints don't self-collide with kerb-side walls early.
    const hl = ss.length / 2 - (s > 0 ? 0.15 : 0);
    const hw = spec.width / 2;
    return { fx, fy, cx, cy, hl, hw };
  };

  const findContact = (pose: BusPose, spec: BusSpec): boolean => {
    best.depth = 0;
    for (let s = 0; s < spec.sections.length; s++) {
      const { fx, fy, cx, cy, hl, hw } = sectionBox(pose, spec, s);
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
      const list = secCands[s];
      for (let ci = 0; ci < list.length; ci++) {
        const i = list[ci];
        const a = solid.off[i];
        const b = solid.off[i + 1];
        const v = solid.v;
        const o = i * 4;
        // (a) bus corners inside the footprint
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
            best.sec = s;
          }
        }
        // (b) footprint vertices inside the bus rectangle
        for (let k = a; k < b; k += 2) {
          const dx = v[k] - cx;
          const dy = v[k + 1] - cy;
          const u = dx * fx + dy * fy;
          if (u >= hl || u <= -hl) continue;
          const w = dx * rx + dy * ry;
          if (w >= hw || w <= -hw) continue;
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
            best.sec = s;
          }
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
      secCands[s] = (secCands[s] ?? []);
      secCands[s].length = 0;
      for (const c of candidates) secCands[s].push(c);
    }
    for (let iter = 0; iter < 4; iter++) {
      if (!findContact(pose, spec)) break;
      out.hit = true;
      const d = best.depth;
      const nx = best.px / d;
      const ny = best.py / d;
      const push = d + 0.002;
      pose.x += nx * push;
      pose.y += ny * push;
      for (const sp of pose.sections) {
        sp.x += nx * push;
        sp.y += ny * push;
      }
      if (iter === 0) {
        out.nx = nx;
        out.ny = ny;
        out.depth = d;
      }
      // Velocity: remove the into-wall component (small bounce on hard hits), add scrape friction.
      const sh = (pose.sections[best.sec] ?? pose).heading;
      const fdx = Math.sin(sh);
      const fdy = Math.cos(sh);
      const fn = fdx * nx + fdy * ny;
      const vn = pose.speed * fn;
      if (vn < 0) {
        const impact = -vn;
        out.impact = Math.max(out.impact, impact);
        const e = impact > 2 ? 0.12 : 0;
        let v = pose.speed - (1 + e) * vn * fn;
        const fr = Math.min(Math.abs(v), 0.3 * impact + 0.02);
        v -= Math.sign(v) * fr;
        pose.speed = v;
      }
    }
    // River: front axle over water and nowhere near a road (bridges are roads).
    const fx = Math.sin(pose.heading);
    const fy = Math.cos(pose.heading);
    const wx = pose.x + fx * spec.wheelbase;
    const wy = pose.y + fy * spec.wheelbase;
    if (!(Math.abs(wx - waterX) < 0.75 && Math.abs(wy - waterY) < 0.75)) {
      waterX = wx;
      waterY = wy;
      waterHit = inWater(wx, wy) && !onRoad(wx, wy, spec.width / 2 + 2);
    }
    if (waterHit) out.water = true;
    return out;
  };

  const collider: SimCollider = {
    sim: true,
    resolve,
    pointInBuilding,
    raycast,
    nearestRoad,
    onRoad,
    inWater,
    stats: { buildings: data.buildings.length, solid: solid.count, excludedByRoads: excludedCount, buildMs: performance.now() - t0 },
  };
  activeCollider = collider;
  return collider;
}

function wrap(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

function polyLength(p: Float32Array): number {
  let l = 0;
  for (let i = 2; i < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return l;
}

function packPolys(rings: Float32Array[], heights: number[]): PolySet {
  let total = 0;
  for (const r of rings) total += r.length;
  const v = new Float32Array(total);
  const off = new Int32Array(rings.length + 1);
  const bb = new Float32Array(rings.length * 4);
  const height = Float32Array.from(heights);
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
  return { v, off, bb, height, count: rings.length };
}

function subsetPolys(p: PolySet, keep: number[]): PolySet {
  const rings: Float32Array[] = [];
  const heights: number[] = [];
  for (const i of keep) {
    rings.push(p.v.subarray(p.off[i], p.off[i + 1]));
    heights.push(p.height[i]);
  }
  return packPolys(rings, heights);
}
