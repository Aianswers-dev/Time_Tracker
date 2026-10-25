// Busway station platforms from data.platforms: outlines, kerb chains and
// bays, and the matching of GTFS stops to platforms so a bus can serve the
// stop at any bay. The 3D station models are in stations.ts.
import * as THREE from 'three';
import { RoadKind, type MapData, type Platform, type Route } from '../types';
import { pointAlong } from '../data/coords';
import { roadIndexFor } from './roadIndex';
import { LEVEL_GAP, heightAt, heightsOf } from './height';
import { buildStations } from './stations';

export const PLATFORM_HEIGHT = 0.3;
const BAY_LENGTH = 16;

/** One kerb (the edge buses pull up to), oriented along the direction of travel. */
export interface KerbChain {
  /** Polyline [x, y, ...] along the platform edge, in bus travel direction. */
  pts: Float32Array;
  cum: Float32Array;
  len: number;
  /** Unit vector from the kerb into the road (left of travel is the platform). */
  outX: number;
  outY: number;
  /** Bay labels, front (downstream) first: "2A", "2B"... */
  bays: string[];
}

export interface PlatformGeom {
  index: number;
  name: string;
  /** Platform number if known ("1", "2", ...). */
  num: string;
  covered: boolean;
  underground: boolean;
  /** Outline ring [x, y, ...] (not closed) of the slab. */
  outline: Float32Array;
  kerbs: KerbChain[];
  /** Back edges (not facing a busway) for canopy posts: [x0, y0, x1, y1, ...]. */
  back: number[];
  /**
   * Height plane of the platform's road edge: z = z0 + slope * ((x, y) - (px, py)) . (tx, ty),
   * fitted to the busway beside the main kerb (platforms carry no heights of their own;
   * King George Square and Queen Street come out underground).
   */
  plane: { px: number; py: number; tx: number; ty: number; z0: number; slope: number };
  /** Bounding box for quick tests. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function signedArea(p: ArrayLike<number>): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
  }
  return a / 2;
}

function platformNumber(p: Platform): string {
  const m = /platform\s*(\d+[a-z]?)/i.exec(p.name);
  if (m) return m[1].toUpperCase();
  if (/^\d{1,2}[a-z]?$/i.test(p.ref)) return p.ref.toUpperCase();
  return '';
}

/** Normalised station name for matching ("Cultural Centre station, platform 1" -> "cultural centre"). */
export function stationKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/,.*$/, '')
    .replace(/\b(platform|busway|bus|station|stop)\b.*$/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const geomCache = new WeakMap<MapData, PlatformGeom[]>();

/** Platform outlines, kerbs and bays (cached per map). */
export function platformGeoms(data: MapData): PlatformGeom[] {
  const cached = geomCache.get(data);
  if (cached) return cached;
  heightsOf(data);
  const idx = roadIndexFor(data);
  const isBus = (r: { bus: boolean; kind: RoadKind }) => r.bus || r.kind === RoadKind.Busway;
  const busTunnel = (r: { bus: boolean; kind: RoadKind; tunnel: boolean }) => isBus(r) && r.tunnel;
  const out: PlatformGeom[] = [];
  (data.platforms ?? []).forEach((pl, index) => {
    const p = pl.pts;
    const n = p.length / 2;
    if (n < 2) return;
    let outline: Float32Array;
    const kerbSegs: { ax: number; ay: number; bx: number; by: number; ox: number; oy: number }[] = [];
    const back: number[] = [];
    if (pl.area && n >= 3) {
      outline = p;
      const ccw = signedArea(p) > 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = p[2 * i];
        const ay = p[2 * i + 1];
        const bx = p[2 * j];
        const by = p[2 * j + 1];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 0.5) continue;
        const ex = (bx - ax) / len;
        const ey = (by - ay) / len;
        // Outward normal: right of the edge for a counter-clockwise ring.
        const ox = ccw ? ey : -ey;
        const oy = ccw ? -ex : ex;
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const hit = len >= 2 ? idx.nearest(mx, my, 16, undefined, 0, isBus) : null;
        let kerb = false;
        if (hit) {
          const align = Math.abs(hit.dx * ex + hit.dy * ey);
          const facing = (hit.px - mx) * ox + (hit.py - my) * oy;
          kerb = align > 0.85 && facing > -0.5;
        }
        if (kerb) kerbSegs.push({ ax, ay, bx, by, ox, oy });
        else if (len > 3) back.push(ax, ay, bx, by);
      }
    } else {
      // A line: the platform edge. The body extends away from the busway.
      const hit = idx.nearest((p[0] + p[2 * n - 2]) / 2, (p[1] + p[2 * n - 1]) / 2, 20, undefined, 0, isBus);
      const ring: number[] = [];
      const backPts: number[] = [];
      for (let i = 0; i + 1 < n; i++) {
        const ax = p[2 * i];
        const ay = p[2 * i + 1];
        const bx = p[2 * i + 2];
        const by = p[2 * i + 3];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 0.3) continue;
        let ox = (by - ay) / len;
        let oy = -(bx - ax) / len;
        if (hit && (hit.px - ax) * ox + (hit.py - ay) * oy < 0) {
          ox = -ox;
          oy = -oy;
        }
        kerbSegs.push({ ax, ay, bx, by, ox, oy });
        backPts.push(ax - ox * 3.5, ay - oy * 3.5, bx - ox * 3.5, by - oy * 3.5);
      }
      for (const s of kerbSegs) ring.push(s.ax, s.ay);
      const last = kerbSegs[kerbSegs.length - 1];
      if (!last) return;
      ring.push(last.bx, last.by);
      for (let i = backPts.length - 2; i >= 0; i -= 2) ring.push(backPts[i], backPts[i + 1]);
      outline = new Float32Array(ring);
      for (let i = 0; i + 3 < backPts.length; i += 4) back.push(backPts[i], backPts[i + 1], backPts[i + 2], backPts[i + 3]);
    }
    // Join kerb segments into chains and orient them along the travel direction
    // (platform on the left, as buses drive on the left).
    const chains: KerbChain[] = [];
    const used = new Array<boolean>(kerbSegs.length).fill(false);
    const num = platformNumber(pl);
    for (let k = 0; k < kerbSegs.length; k++) {
      if (used[k]) continue;
      used[k] = true;
      const pts: number[] = [kerbSegs[k].ax, kerbSegs[k].ay, kerbSegs[k].bx, kerbSegs[k].by];
      let ox = kerbSegs[k].ox;
      let oy = kerbSegs[k].oy;
      let grew = true;
      while (grew) {
        grew = false;
        for (let m = 0; m < kerbSegs.length; m++) {
          if (used[m]) continue;
          const s = kerbSegs[m];
          const ex = pts[pts.length - 2];
          const ey = pts[pts.length - 1];
          if (Math.hypot(s.ax - ex, s.ay - ey) < 0.05) {
            pts.push(s.bx, s.by);
            ox += s.ox;
            oy += s.oy;
            used[m] = true;
            grew = true;
          } else if (Math.hypot(s.bx - pts[0], s.by - pts[1]) < 0.05) {
            pts.unshift(s.ax, s.ay);
            ox += s.ox;
            oy += s.oy;
            used[m] = true;
            grew = true;
          }
        }
      }
      const ol = Math.hypot(ox, oy) || 1;
      ox /= ol;
      oy /= ol;
      // Travel direction t has the platform on its left: left(t) = -out.
      const tx = -oy;
      const ty = ox;
      const dirX = pts[pts.length - 2] - pts[0];
      const dirY = pts[pts.length - 1] - pts[1];
      if (dirX * tx + dirY * ty < 0) {
        const rev: number[] = [];
        for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i], pts[i + 1]);
        pts.length = 0;
        pts.push(...rev);
      }
      const arr = new Float32Array(pts);
      const cum = new Float32Array(arr.length / 2);
      for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + Math.hypot(arr[2 * i] - arr[2 * i - 2], arr[2 * i + 1] - arr[2 * i - 1]);
      const len = cum[cum.length - 1];
      if (len < 8) continue;
      const nb = Math.max(1, Math.round(len / BAY_LENGTH));
      const bays: string[] = [];
      for (let b = 0; b < nb; b++) bays.push(`${num}${String.fromCharCode(65 + b)}`);
      chains.push({ pts: arr, cum, len, outX: ox, outY: oy, bays });
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < outline.length; i += 2) {
      x0 = Math.min(x0, outline[i]);
      x1 = Math.max(x1, outline[i]);
      y0 = Math.min(y0, outline[i + 1]);
      y1 = Math.max(y1, outline[i + 1]);
    }
    // Height: fit a line to the busway height beside the longest kerb. With no bus road beside it, the
    // ground along its longest side: a stop on a sloping drive follows the slope rather than lying level
    // at its middle's height and buried at its high end (the School Bus Stop off College Drive).
    let plane = { px: (x0 + x1) / 2, py: (y0 + y1) / 2, tx: 1, ty: 0, z0: heightAt((x0 + x1) / 2, (y0 + y1) / 2), slope: 0 };
    {
      const m = outline.length / 2;
      let ex = 1;
      let ey = 0;
      let best = 0;
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        const dx = outline[2 * j] - outline[2 * i];
        const dy = outline[2 * j + 1] - outline[2 * i + 1];
        const l = Math.hypot(dx, dy);
        if (l > best) [best, ex, ey] = [l, dx / l, dy / l];
      }
      let d0 = Infinity;
      let d1 = -Infinity;
      for (let i = 0; i < m; i++) {
        const d = (outline[2 * i] - plane.px) * ex + (outline[2 * i + 1] - plane.py) * ey;
        d0 = Math.min(d0, d);
        d1 = Math.max(d1, d);
      }
      if (d1 - d0 > 8) {
        const za = heightAt(plane.px + ex * (d0 + 1), plane.py + ey * (d0 + 1));
        const zb = heightAt(plane.px + ex * (d1 - 1), plane.py + ey * (d1 - 1));
        const slope = Math.max(-0.12, Math.min(0.12, (zb - za) / (d1 - d0 - 2)));
        plane = { px: plane.px, py: plane.py, tx: ex, ty: ey, z0: (za + zb) / 2 - (slope * (d0 + d1)) / 2, slope };
      }
    }
    const main = chains.reduce<KerbChain | null>((a, c) => (!a || c.len > a.len ? c : a), null);
    if (main) {
      const ds: number[] = [];
      const zs: number[] = [];
      // Underground platforms take the tunnel busway's height (falling back to any busway).
      for (const accept of pl.underground ? [busTunnel, isBus] : [isBus]) {
        for (let k = 0; k <= 6; k++) {
          const d = (main.len * k) / 6;
          const q = chainAt(main, d);
          const hit = idx.nearest(q.x + main.outX * 2, q.y + main.outY * 2, 25, undefined, 0, accept);
          if (!hit) continue;
          ds.push(d);
          zs.push(hit.z);
        }
        if (zs.length) break;
      }
      if (zs.length) {
        const n2 = zs.length;
        const md = ds.reduce((a, b) => a + b, 0) / n2;
        const mz = zs.reduce((a, b) => a + b, 0) / n2;
        let num2 = 0;
        let den = 0;
        for (let k = 0; k < n2; k++) {
          num2 += (ds[k] - md) * (zs[k] - mz);
          den += (ds[k] - md) ** 2;
        }
        const slope = den > 1e-6 ? Math.max(-0.12, Math.min(0.12, num2 / den)) : 0;
        const p0 = chainAt(main, 0);
        const tl = Math.hypot(main.pts[main.pts.length - 2] - main.pts[0], main.pts[main.pts.length - 1] - main.pts[1]) || 1;
        plane = {
          px: p0.x,
          py: p0.y,
          tx: (main.pts[main.pts.length - 2] - main.pts[0]) / tl,
          ty: (main.pts[main.pts.length - 1] - main.pts[1]) / tl,
          z0: mz - slope * md,
          slope,
        };
      }
    }
    out.push({ index, name: pl.name, num, covered: pl.covered, underground: pl.underground, outline, kerbs: chains, back, plane, x0, y0, x1, y1 });
  });
  geomCache.set(data, out);
  return out;
}

/** Point at distance d along a chain (clamped). */
function chainAt(c: KerbChain, d: number): { x: number; y: number; tx: number; ty: number } {
  const n = c.cum.length;
  const s = Math.max(0, Math.min(c.len, d));
  let i = 0;
  while (i < n - 2 && c.cum[i + 1] < s) i++;
  const ax = c.pts[2 * i];
  const ay = c.pts[2 * i + 1];
  const bx = c.pts[2 * i + 2];
  const by = c.pts[2 * i + 3];
  const l = Math.max(1e-6, c.cum[i + 1] - c.cum[i]);
  const t = (s - c.cum[i]) / l;
  return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, tx: (bx - ax) / l, ty: (by - ay) / l };
}

// ---------------------------------------------------------------------------
// Matching GTFS stops to platforms

export interface PlatformZone {
  platform: number;
  /** Route distances alongside the platform kerb. */
  s0: number;
  s1: number;
  /** Lateral distance (left) from the route line to the platform edge at s, sampled every `step` m from s0. */
  edge: Float32Array;
  step: number;
}

/** Distance along the ray (x, y) + t (dx, dy), t in [0, maxT], to the platform outline, or Infinity. */
function rayHit(g: PlatformGeom, x: number, y: number, dx: number, dy: number, maxT: number): number {
  const p = g.outline;
  const n = p.length / 2;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[2 * i];
    const ay = p[2 * i + 1];
    const ex = p[2 * j] - ax;
    const ey = p[2 * j + 1] - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - x) * ey - (ay - y) * ex) / den;
    const u = ((ax - x) * dy - (ay - y) * dx) / den;
    if (t >= 0 && t <= maxT && u >= 0 && u <= 1 && t < best) best = t;
  }
  return best;
}

/**
 * How far left of (x, y), across (lx, ly) (unit), the edge of platform `index` is (negative a little
 * way inside its slab), or Infinity if it is not within `maxT`.
 */
export function platformEdgeAt(data: MapData, index: number, x: number, y: number, lx: number, ly: number, maxT = 18): number {
  const g = platformGeoms(data).find((q) => q.index === index);
  if (!g) return Infinity;
  return rayHit(g, x - lx * 1.5, y - ly * 1.5, lx, ly, maxT + 1.5) - 1.5;
}

/** Point and heading at route distance s, carried straight on past either end (a platform can reach past a terminus). */
function routeAt(route: Route, s: number): { x: number; y: number; heading: number } {
  if (s >= 0 && s <= route.length) return pointAlong(route.pts, route.cum, s);
  const end = s < 0 ? 0 : route.length;
  const q = pointAlong(route.pts, route.cum, end);
  return { x: q.x + Math.sin(q.heading) * (s - end), y: q.y + Math.cos(q.heading) * (s - end), heading: q.heading };
}

/**
 * The platform (if any) a route stop is served from, and the stretch of the
 * route alongside its kerb. Name and platform number are preferred; geometry
 * (a platform edge just left of the route) is required.
 */
export function matchStopPlatform(data: MapData, route: Route, stopIndex: number): PlatformZone | null {
  const geoms = platformGeoms(data);
  if (!geoms.length) return null;
  const rs = route.stops[stopIndex];
  const stop = data.stops[rs.stop];
  const key = stationKey(stop.name);
  const numM = /platform\s*(\d+)/i.exec(stop.name) ?? /,\s*(\d+)[a-z]?$/i.exec(stop.name);
  const num = numM ? numM[1] : '';
  let best: PlatformZone | null = null;
  let bestScore = Infinity;
  const step = 2;
  const zr = heightsOf(data).routeZ(route, rs.s);
  for (const g of geoms) {
    if (stop.x < g.x0 - 70 || stop.x > g.x1 + 70 || stop.y < g.y0 - 70 || stop.y > g.y1 + 70) continue;
    // Same level only (an underground station under a street stop is not it).
    const pl = g.plane;
    if (Math.abs(pl.z0 + pl.slope * ((stop.x - pl.px) * pl.tx + (stop.y - pl.py) * pl.ty) - zr) > LEVEL_GAP) continue;
    // Walk the route around the stop and cast to the left.
    // (Past the route's ends too: at a terminus the platform can start behind the first stop.)
    const from = Math.max(-60, rs.s - 110);
    const to = Math.min(route.length + 60, rs.s + 110);
    const hits: { s: number; h: number }[] = [];
    for (let s = from; s <= to; s += step) {
      const q = routeAt(route, s);
      const lx = -Math.cos(q.heading);
      const ly = Math.sin(q.heading);
      const h = rayHit(g, q.x - lx * 1.5, q.y - ly * 1.5, lx, ly, 18);
      if (h < Infinity) hits.push({ s, h: h - 1.5 });
    }
    if (hits.length < 3) continue;
    // The run of hits closest to the stop.
    const runs: { s: number; h: number }[][] = [];
    for (const hpt of hits) {
      const run = runs[runs.length - 1];
      if (run && hpt.s - run[run.length - 1].s <= step * 3) run.push(hpt);
      else runs.push([hpt]);
    }
    let run = runs[0];
    let rd = Infinity;
    for (const r of runs) {
      const d = rs.s < r[0].s ? r[0].s - rs.s : rs.s > r[r.length - 1].s ? rs.s - r[r.length - 1].s : 0;
      if (d < rd) {
        rd = d;
        run = r;
      }
    }
    const s0 = run[0].s;
    const s1 = run[run.length - 1].s;
    if (s1 - s0 < 8 || rd > 40) continue;
    const gKey = stationKey(g.name);
    const nameOk = !!gKey && !!key && (gKey.includes(key) || key.includes(gKey));
    const numOk = !!num && num === g.num.replace(/[A-Z]$/, '');
    const score = rd - (nameOk ? 30 : 0) - (numOk ? 20 : 0);
    if (score < bestScore) {
      bestScore = score;
      const edge = new Float32Array(Math.floor((s1 - s0) / step) + 1);
      for (const hpt of run) {
        const i = Math.round((hpt.s - s0) / step);
        if (i >= 0 && i < edge.length) edge[i] = hpt.h;
      }
      // Fill any gaps.
      for (let i = 1; i < edge.length; i++) if (!edge[i]) edge[i] = edge[i - 1];
      best = { platform: g.index, s0, s1, edge, step };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Scene: the station models (platform kit, canopies, signs, landmarks) are
// built in stations.ts.

const built = new WeakSet<THREE.Scene>();

/** Add every station to the scene (once per scene). */
export function buildPlatforms(scene: THREE.Scene, data: MapData): void {
  if (built.has(scene)) return;
  built.add(scene);
  buildStations(scene, data, platformGeoms(data));
}
