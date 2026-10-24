// A route resampled into a drivable left-lane path with kerb distances, a
// curvature/limit speed profile and the traffic signals along it. Shared by
// the player's RouteGuide and the AI traffic.
import { RoadKind, type MapData, type Road, type Route } from '../types';
import { pointAlong, wrapAngle } from '../data/coords';
import { drivable, roadIndexFor, speedLimitOf } from './roadIndex';
import { isStationStop } from './routeMeta';
import { matchStopPlatform, type PlatformZone } from './platforms';
import { LEVEL_GAP, heightsOf } from './height';
import type { Heights } from '../data/height';

export const TRACK_STEP = 4;

export interface TrackSample {
  x: number;
  y: number;
  /** Unit tangent (direction of travel). */
  hx: number;
  hy: number;
  heading: number;
}

export interface TrackStop {
  /** Index into route.stops. */
  index: number;
  s: number;
  station: boolean;
  /** Distance from the lane centre to the kerb at the stop (left, metres). */
  kerb: number;
  /** Busway platform the stop is served from: any bay along [s0, s1] will do. */
  zone: PlatformZone | null;
}

/** Lane centre this far from a platform edge puts the bus side ~0.35 m off it. */
const PLATFORM_LANE = 1.6;
/**
 * Where a road has walls (tunnel walls, viaduct parapets, cutting retaining
 * walls; see sim/collider.ts) the lane centre stays this far inside them:
 * half a bus plus a margin for the body swinging out on bends.
 */
const WALL_CLEAR = 2.1;
/** Sideways metres per metre the lane may move away from a walled stretch. */
const WALL_SLOPE = 0.35;
/** Samples either side whose wall bounds a lane sample also keeps to. */
const WALL_SPREAD = 1;

export interface TrackSignal {
  /** Stop line distance along the route. */
  s: number;
  x: number;
  y: number;
}

function smooth01(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function median7(src: Float32Array): Float32Array {
  const n = src.length;
  const out = new Float32Array(n);
  const w: number[] = [];
  for (let i = 0; i < n; i++) {
    w.length = 0;
    for (let k = -3; k <= 3; k++) w.push(src[Math.max(0, Math.min(n - 1, i + k))]);
    w.sort((a, b) => a - b);
    out[i] = w[3];
  }
  return out;
}

function boxSmooth(src: Float32Array, half: number): Float32Array {
  const n = src.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let c = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      sum += src[j];
      c++;
    }
    out[i] = sum / c;
  }
  return out;
}

const ALONG_0 = [0];
const ALONG_3 = [-2, 0, 2];

const cuttings = new WeakMap<Road, boolean>();
/** Does the road dip below the ground beside it anywhere (so it can have retaining walls)? As sim/collider.ts. */
function inCutting(r: Road, H: Heights): boolean {
  let cut = cuttings.get(r);
  if (cut !== undefined) return cut;
  cut = false;
  const p = r.pts;
  const z = r.z;
  const n = p.length / 2;
  const off = Math.max(r.width / 2 + 0.6, 2.6) + 2.5;
  for (let v = 0; v < n && !cut; v++) if (H.ground(p[2 * v], p[2 * v + 1]) - z[v] > 1.2) cut = true;
  for (let v = 0; v + 1 < n && !cut; v++) {
    const mx = (p[2 * v] + p[2 * v + 2]) / 2;
    const my = (p[2 * v + 1] + p[2 * v + 3]) / 2;
    const dx = p[2 * v + 2] - p[2 * v];
    const dy = p[2 * v + 3] - p[2 * v + 1];
    const L = Math.hypot(dx, dy) || 1;
    const zm = (z[v] + z[v + 1]) / 2;
    for (const sd of [-1, 1]) if (H.ground(mx + (sd * dy * off) / L, my - (sd * dx * off) / L) - zm > 1.5) cut = true;
  }
  cuttings.set(r, cut);
  return cut;
}

/** Does road b simply carry on from road a (a way split end to end, not a junction)? */
function continues(a: Road, b: Road): boolean {
  const pa = a.pts;
  const pb = b.pts;
  const na = pa.length;
  const nb = pb.length;
  const ends = [
    [pa[na - 2], pa[na - 1], pb[0], pb[1]],
    [pb[nb - 2], pb[nb - 1], pa[0], pa[1]],
    [pa[0], pa[1], pb[0], pb[1]],
    [pa[na - 2], pa[na - 1], pb[nb - 2], pb[nb - 1]],
  ];
  return ends.some(([x0, y0, x1, y1]) => Math.hypot(x0 - x1, y0 - y1) < 1);
}

/** Roads that can have walls along them (tunnels and viaducts). */
const walledRoad = (r: Road): boolean => drivable(r) && (r.tunnel || r.bridge);

/** Signals spatial hash shared by all tracks. */
const signalGrids = new WeakMap<MapData, Map<number, number[]>>();
function signalGrid(data: MapData): Map<number, number[]> {
  let g = signalGrids.get(data);
  if (!g) {
    g = new Map();
    const s = data.signals;
    for (let i = 0; i < s.length; i += 2) {
      const key = (Math.floor(s[i] / 40) + 1000) * 4096 + Math.floor(s[i + 1] / 40) + 1000;
      let a = g.get(key);
      if (!a) g.set(key, (a = []));
      a.push(i / 2);
    }
    signalGrids.set(data, g);
  }
  return g;
}

export class RouteTrack {
  readonly n: number;
  readonly length: number;
  /** Lane centre. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Unit tangent. */
  readonly tx: Float32Array;
  readonly ty: Float32Array;
  /** Lane centre -> left kerb distance. */
  readonly kerb: Float32Array;
  /** Lateral offset of the lane from the GTFS line (+ = left). */
  readonly offset: Float32Array;
  /** Comfortable AI speed (m/s) including braking for curves ahead. */
  readonly vmax: Float32Array;
  /** Posted limit km/h at each sample. */
  readonly limit: Uint8Array;
  /** Index of the road under each sample, or -1. */
  readonly road: Int32Array;
  /** Road surface height (m AHD) at each sample, from the route's own heights (tunnels, viaducts). */
  readonly z: Float32Array;
  /** Lane-offset bounds that keep the bus off walls (-/+Infinity where unwalled); diagnostics. */
  readonly bandLo: Float32Array;
  readonly bandHi: Float32Array;
  readonly stops: TrackStop[];
  readonly signals: TrackSignal[];
  /** Every 40 m: [s, x, y] triples, for quick "is this route near me" tests. */
  readonly coarse: Float32Array;

  constructor(
    readonly route: Route,
    readonly data: MapData,
  ) {
    const idx = roadIndexFor(data);
    const H = heightsOf(data);
    const L = route.length;
    const n = Math.max(2, Math.floor(L / TRACK_STEP) + 2);
    this.n = n;
    this.length = L;
    const bx = new Float32Array(n);
    const by = new Float32Array(n);
    const nx = new Float32Array(n);
    const ny = new Float32Array(n);
    const target = new Float32Array(n);
    const kerbBase = new Float32Array(n);
    const known = new Uint8Array(n);
    // Walls beside each sample (lateral positions, + = left), for keeping the lane off them.
    const wallStart = new Int32Array(n + 1);
    const wallPos: number[] = [];
    // Where carriageways at this level cross each sample's normal (a lane only runs in a gap with one).
    const roadStart = new Int32Array(n + 1);
    const roadPos: number[] = [0];
    const nearRoads: number[] = [];
    this.limit = new Uint8Array(n);
    this.road = new Int32Array(n).fill(-1);
    this.z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.min(L, i * TRACK_STEP);
      const p = pointAlong(route.pts, route.cum, s);
      const a = pointAlong(route.pts, route.cum, s - 5);
      const b = pointAlong(route.pts, route.cum, s + 5);
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      bx[i] = p.x;
      by[i] = p.y;
      // Left normal of travel direction (dx, dy) is (-dy, dx).
      nx[i] = -dy;
      ny[i] = dx;
      const heading = Math.atan2(dx, dy);
      const zr = H.routeZ(route, s);
      this.z[i] = zr;
      // Only roads at the route's level count (not the street under a viaduct). In tunnels and on
      // viaducts the GTFS shape can stray 20+ m off the mapped carriageway: look further for those.
      const hit = idx.nearest(p.x, p.y, 14, heading, 0.8, drivable, zr) ?? idx.nearest(p.x, p.y, 32, heading, 0.8, walledRoad, zr);
      if (hit) {
        const road = data.roads[hit.road];
        const dC = (hit.px - p.x) * nx[i] + (hit.py - p.y) * ny[i];
        const w = Math.max(3.2, road.width);
        const fromCentre = road.oneway ? Math.max(0, w / 2 - 1.75) : Math.min(6, Math.max(1.6, w / 2 - 1.75));
        target[i] = dC + fromCentre;
        kerbBase[i] = dC + (road.oneway ? w / 2 : Math.max(w / 2, 3.2));
        known[i] = 1;
        this.limit[i] = speedLimitOf(road);
        this.road[i] = hit.road;
      }
      // Walls along the roads here at this level (see sim/collider.ts): just outside each carriageway
      // (never closer than 2.6 m to its centreline) of tunnels and viaducts, and of cuttings where the
      // ground beside is well above the road; none where another carriageway continues beyond.
      wallStart[i] = wallPos.length;
      roadStart[i] = roadPos.length;
      roadPos.push(0); // the GTFS line itself
      nearRoads.length = 0;
      const reach = Math.max(18, (hit ? Math.abs((hit.px - p.x) * nx[i] + (hit.py - p.y) * ny[i]) : 0) + 9);
      idx.forEachNear(p.x, p.y, reach, (ri, ax, ay, sdx, sdy, slen, _d, zz) => {
        if (!drivable(data.roads[ri]) || Math.abs(zz - zr) > LEVEL_GAP) return;
        nearRoads.push(ri, ax, ay, sdx, sdy, slen, zz);
      });
      // Where each wall line crosses this sample's normal (roads at an angle too; not ones crossing
      // our path, whose walls the collider opens where routes cross).
      for (let k = 0; k < nearRoads.length; k += 7) {
        const r = data.roads[nearRoads[k]];
        const ax = nearRoads[k + 1];
        const ay = nearRoads[k + 2];
        const sdx = nearRoads[k + 3];
        const sdy = nearRoads[k + 4];
        const slen = nearRoads[k + 5];
        const zk = nearRoads[k + 6];
        // Road's left normal; cos of the angle between it and ours.
        const rnx = -sdy;
        const rny = sdx;
        const cos = rnx * nx[i] + rny * ny[i];
        if (Math.abs(cos) < 0.4) continue;
        const baseAt = Math.max(r.width / 2 + 0.6, 2.6);
        const tc = -((p.x - ax) * rnx + (p.y - ay) * rny) / cos;
        const cu = (p.x + nx[i] * tc - ax) * sdx + (p.y + ny[i] * tc - ay) * sdy;
        if (cu >= -1 && cu <= slen + 1) roadPos.push(tc);
        // On this sample's normal and halfway to its neighbours (walls at an angle can slip between).
        for (const along of Math.abs(cos) > 0.97 ? ALONG_0 : ALONG_3) for (const side of [1, -1]) {
          const qx0 = p.x + dx * along;
          const qy0 = p.y + dy * along;
          const dist = (qx0 - ax) * rnx + (qy0 - ay) * rny;
          // The collider moves a wall out to leave a bus on the route line room (route within 12 m,
          // running along this road), and leaves out walls the route line runs right beside.
          let wallAt = baseAt;
          const need = side * dist + 2.3 / Math.abs(cos) + (1 - Math.abs(cos)) * 4;
          if (Math.abs(dist) < 12 && Math.abs(cos) > 0.3 && need > wallAt) wallAt = Math.min(baseAt + 12, need);
          const t = (side * wallAt - dist) / cos;
          if (Math.abs(t) * Math.abs(cos) < (r.bridge && !r.tunnel ? 1.6 : 2.6)) continue;
          const wx = qx0 + nx[i] * t;
          const wy = qy0 + ny[i] * t;
          const u = (wx - ax) * sdx + (wy - ay) * sdy;
          if (u < -1 || u > slen + 1 || Math.abs(t) > reach) continue;
          const walled = r.tunnel || r.bridge || (inCutting(r, H) && H.ground(wx + rnx * side * 2.5, wy + rny * side * 2.5) - zk >= 1.5);
          if (!walled) continue;
          // An opening where another carriageway at the wall's level continues beyond it.
          const ox = wx + rnx * side * 0.9;
          const oy = wy + rny * side * 0.9;
          let open = false;
          for (let q = 0; q < nearRoads.length && !open; q += 7) {
            if (nearRoads[q] === nearRoads[k] || Math.abs(nearRoads[q + 6] - zk) > 1.6) continue;
            const qx = ox - nearRoads[q + 1];
            const qy = oy - nearRoads[q + 2];
            const qu = qx * nearRoads[q + 3] + qy * nearRoads[q + 4];
            if (qu < -3 || qu > nearRoads[q + 5] + 3) continue;
            if (Math.abs(qx * -nearRoads[q + 4] + qy * nearRoads[q + 3]) < data.roads[nearRoads[q]].width / 2 - 0.2) open = true;
          }
          if (!open) wallPos.push(t);
        }
      }
    }
    wallStart[n] = wallPos.length;
    roadStart[n] = roadPos.length;
    // Fill unknown samples by interpolating between known neighbours.
    let lastKnown = -1;
    for (let i = 0; i <= n; i++) {
      if (i < n && !known[i]) continue;
      const a = lastKnown;
      const b = i < n ? i : -1;
      const ta = a >= 0 ? target[a] : b >= 0 ? target[b] : 1.75;
      const tb = b >= 0 ? target[b] : ta;
      const ka = a >= 0 ? kerbBase[a] : b >= 0 ? kerbBase[b] : 3.6;
      const kb = b >= 0 ? kerbBase[b] : ka;
      const la = a >= 0 ? this.limit[a] : b >= 0 ? this.limit[b] : 50;
      for (let j = a + 1; j < (b >= 0 ? b : n); j++) {
        const f = b > a ? (j - a) / (b - a) : 0;
        target[j] = ta + (tb - ta) * f;
        kerbBase[j] = ka + (kb - ka) * f;
        this.limit[j] = la;
      }
      lastKnown = i;
    }
    const tMed = median7(target);
    const tS = boxSmooth(tMed, 4);
    const kS = boxSmooth(median7(kerbBase), 3);
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.offset = new Float32Array(n);
    this.kerb = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // (GTFS shapes can run well off a mapped tunnel or viaduct, e.g. 12 m off a busway tunnel:
      // follow the road there.)
      const rd = this.road[i] >= 0 ? data.roads[this.road[i]] : null;
      const wide = !!rd && (rd.tunnel || rd.bridge);
      const off = wide ? Math.max(-24, Math.min(24, tS[i])) : Math.max(-3, Math.min(8, tS[i]));
      this.offset[i] = off;
      this.kerb[i] = Math.max(1.3, Math.min(6, kS[i] - off));
    }
    // The lane's own carriageway (unsmoothed, so it stays on the road where the GTFS shape kinks away
    // from it; before platform lead-ins): the walls either side of it bound the lane.
    const home = Float32Array.from(tMed, (v, i) => Math.max(-24, Math.min(24, v, this.offset[i] + 6), this.offset[i] - 6));
    const lo = new Float32Array(n).fill(-Infinity);
    const hi = new Float32Array(n).fill(Infinity);
    const bayTo = new Float32Array(n).fill(-Infinity);
    // Busway platforms: the lane hugs the platform edge so buses pull right alongside.
    const zones = route.stops.map((_, k) => matchStopPlatform(data, route, k));
    for (const z of zones) {
      if (!z) continue;
      const edgeAt = (s: number) => z.edge[Math.max(0, Math.min(z.edge.length - 1, Math.round((s - z.s0) / z.step)))];
      // Ease in and out over a distance that keeps the swerve gentle (~1 m sideways per 5 m).
      const shift = Math.abs(edgeAt(z.s0) - PLATFORM_LANE - this.offset[Math.max(0, Math.min(n - 1, Math.round(z.s0 / TRACK_STEP)))]);
      const lead = Math.max(30, shift * 5);
      const tail = Math.max(25, shift * 4);
      const i0 = Math.max(0, Math.floor((z.s0 - lead - 5) / TRACK_STEP));
      const i1 = Math.min(n - 1, Math.ceil((z.s1 + tail) / TRACK_STEP));
      for (let i = i0; i <= i1; i++) {
        const s = i * TRACK_STEP;
        const w = s < z.s0 ? smooth01((s - (z.s0 - lead - 5)) / lead) : s > z.s1 ? 1 - smooth01((s - z.s1) / tail) : 1;
        if (w <= 0) continue;
        const want = edgeAt(s) - PLATFORM_LANE;
        const kerbNow = this.kerb[i] + this.offset[i];
        this.offset[i] += (want - this.offset[i]) * w;
        this.kerb[i] += (Math.max(PLATFORM_LANE, kerbNow - this.offset[i]) - this.kerb[i]) * w;
        if (s >= z.s0 && s <= z.s1) this.kerb[i] = PLATFORM_LANE;
      }
      // Alongside the platform the space up to its edge is bay, not wall, where the platform
      // belongs to this level's road (the nearest road to its edge, as sim/collider.ts decides).
      const under = data.platforms[z.platform]?.underground ?? false;
      for (let i = Math.max(0, Math.floor((z.s0 - 2) / TRACK_STEP)); i <= Math.min(n - 1, Math.ceil((z.s1 + 2) / TRACK_STEP)); i++) {
        const e = edgeAt(i * TRACK_STEP);
        const ex = bx[i] + nx[i] * e;
        const ey = by[i] + ny[i] * e;
        const near = idx.nearest(ex, ey, 16, undefined, 0, (r) => drivable(r) && r.tunnel === under) ?? idx.nearest(ex, ey, 16, undefined, 0, drivable);
        if (near && Math.abs(near.z - this.z[i]) < 1.8) bayTo[i] = e + 0.5;
      }
    }
    // The gap between walls the lane runs in: the one around its road lane, or where that is too
    // narrow for a bus (a wall standing in the carriageway), the nearest one that fits, staying
    // on the side chosen just before.
    const ws: number[] = [];
    let prev = NaN;
    for (let i = 0; i < n; i++) {
      const h = home[i];
      ws.length = 0;
      for (let k = wallStart[i]; k < wallStart[i + 1]; k++) {
        const wp = wallPos[k];
        if (!(wp > h && wp <= bayTo[i])) ws.push(wp);
      }
      if (!ws.length) {
        prev = NaN;
        continue;
      }
      ws.sort((p1, p2) => p1 - p2);
      let gi = 0;
      while (gi < ws.length && ws[gi] < h) gi++;
      // Gap g spans (ws[g - 1], ws[g]) with -/+Infinity at the ends.
      const gapLo = (g: number) => (g > 0 ? ws[g - 1] + WALL_CLEAR : -Infinity);
      const gapHi = (g: number) => (g < ws.length ? ws[g] - WALL_CLEAR : Infinity);
      // Only gaps with a carriageway in them (not the drop beyond a parapet).
      const hasRoad = (g: number) => {
        const a = g > 0 ? ws[g - 1] : -Infinity;
        const b = g < ws.length ? ws[g] : Infinity;
        for (let k = roadStart[i]; k < roadStart[i + 1]; k++) if (roadPos[k] > a && roadPos[k] < b) return true;
        return false;
      };
      let pick = gi;
      if (gapLo(gi) > gapHi(gi)) {
        const ref = Number.isNaN(prev) ? h : prev;
        let best = Infinity;
        let widest = -Infinity;
        let wide = gi;
        pick = -1;
        for (let g = 0; g <= ws.length; g++) {
          const a = gapLo(g);
          const b = gapHi(g);
          if (b - a > widest && (g === gi || hasRoad(g))) {
            widest = b - a;
            wide = g;
          }
          if (a > b || !hasRoad(g)) continue;
          const d = ref < a ? a - ref : ref > b ? ref - b : 0;
          if (d < best) {
            best = d;
            pick = g;
          }
        }
        if (pick < 0) pick = wide;
      }
      lo[i] = gapLo(pick);
      hi[i] = gapHi(pick);
      // Nowhere a bus fits between the walls we know of, with the route line close by (ramps meeting
      // in a tunnel junction): the route line, along which the collider leaves the way open.
      if (lo[i] > hi[i] && Math.abs(h) < 4) {
        lo[i] = -0.4;
        hi[i] = 0.4;
      }
      prev = Math.max(lo[i], Math.min(hi[i], h));
    }
    // Where the lane changes from one tunnel or viaduct road to another (ramps meeting underground,
    // the King George Square loop), keep to the route line if it is close: the collider opens the
    // walls where routes cross them, along the route line.
    for (let i = 1; i < n; i++) {
      const a = this.road[i - 1];
      const b = this.road[i];
      if (a < 0 || b < 0 || a === b) continue;
      const ra = data.roads[a];
      const rb = data.roads[b];
      if (!(ra.tunnel || ra.bridge) || !(rb.tunnel || rb.bridge) || continues(ra, rb)) continue;
      for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 2); j++) {
        if (Math.abs(home[j]) >= 4 || bayTo[j] > -Infinity) continue;
        lo[j] = -0.4;
        hi[j] = 0.4;
      }
    }
    this.keepInside(lo, hi, home);
    this.bandLo = lo;
    this.bandHi = hi;
    for (let i = 0; i < n; i++) {
      this.x[i] = bx[i] + nx[i] * this.offset[i];
      this.y[i] = by[i] + ny[i] * this.offset[i];
    }
    // Tangents from the lane itself.
    this.tx = new Float32Array(n);
    this.ty = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let dx = this.x[b] - this.x[a];
      let dy = this.y[b] - this.y[a];
      const len = Math.hypot(dx, dy);
      if (len < 1e-4) {
        dx = -ny[i];
        dy = nx[i];
      } else {
        dx /= len;
        dy /= len;
      }
      this.tx[i] = dx;
      this.ty[i] = dy;
    }
    // Speed profile: curvature, posted limits, then braking pass.
    const kappa = new Float32Array(n);
    for (let i = 2; i < n - 2; i++) {
      const h0 = Math.atan2(this.tx[i - 2], this.ty[i - 2]);
      const h1 = Math.atan2(this.tx[i + 2], this.ty[i + 2]);
      kappa[i] = Math.abs(wrapAngle(h1 - h0)) / (4 * TRACK_STEP);
    }
    const kSm = boxSmooth(kappa, 1);
    this.vmax = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const vCurve = Math.sqrt(1.7 / Math.max(kSm[i], 1e-4));
      const road = this.road[i] >= 0 ? data.roads[this.road[i]] : undefined;
      const vLim = (this.limit[i] || 50) / 3.6 - (road && road.kind === RoadKind.Busway ? 0.5 : 1.0);
      this.vmax[i] = Math.max(2.5, Math.min(vCurve, vLim, 22));
    }
    for (let i = n - 2; i >= 0; i--) {
      this.vmax[i] = Math.min(this.vmax[i], Math.sqrt(this.vmax[i + 1] ** 2 + 2 * 1.1 * TRACK_STEP));
    }
    const nc = Math.max(1, Math.floor((L - 70) / 40));
    this.coarse = new Float32Array(nc * 3);
    for (let k = 0; k < nc; k++) {
      const s = 10 + k * 40;
      const i = Math.min(n - 1, Math.round(s / TRACK_STEP));
      this.coarse[k * 3] = s;
      this.coarse[k * 3 + 1] = this.x[i];
      this.coarse[k * 3 + 2] = this.y[i];
    }
    // Stops.
    this.stops = route.stops.map((st, index) => {
      const i = Math.max(0, Math.min(n - 1, Math.round(st.s / TRACK_STEP)));
      const zone = zones[index];
      return { index, s: st.s, station: !!zone || isStationStop(data.stops[st.stop].name), kerb: this.kerb[i], zone };
    });
    // Signals near the GTFS line, deduped per intersection.
    const grid = signalGrid(data);
    const found: { s: number; x: number; y: number }[] = [];
    const seen = new Set<number>();
    const sig = data.signals;
    for (let i = 0; i < n; i++) {
      const gx = Math.floor(bx[i] / 40) + 1000;
      const gy = Math.floor(by[i] / 40) + 1000;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const list = grid.get((gx + ox) * 4096 + gy + oy);
          if (!list) continue;
          for (const k of list) {
            if (seen.has(k)) continue;
            const d = Math.hypot(sig[2 * k] - bx[i], sig[2 * k + 1] - by[i]);
            if (d > 9) continue;
            // Along-track position of the signal: refine with the local tangent.
            // Tangent is (ny, -nx).
            const along = (sig[2 * k] - bx[i]) * ny[i] - (sig[2 * k + 1] - by[i]) * nx[i];
            const sAlong = i * TRACK_STEP + along;
            if (Math.abs(along) > TRACK_STEP * 0.75) continue;
            // Signals are on the streets: ignore them from a tunnel or viaduct.
            if (Math.abs(H.surfaceAt(sig[2 * k], sig[2 * k + 1]).z - this.z[i]) > LEVEL_GAP) continue;
            seen.add(k);
            found.push({ s: sAlong, x: sig[2 * k], y: sig[2 * k + 1] });
          }
        }
      }
    }
    found.sort((a, b) => a.s - b.s);
    this.signals = [];
    for (const f of found) {
      const last = this.signals[this.signals.length - 1];
      if (last && f.s - (last.s + 7) < 30) continue;
      if (f.s < 12) continue;
      this.signals.push({ s: f.s - 7, x: f.x, y: f.y });
    }
  }

  /** Interpolated lane sample at distance s, optionally shifted left. */
  sample(s: number, out: TrackSample, extraLeft = 0): TrackSample {
    const f = Math.max(0, Math.min(this.n - 1.0001, s / TRACK_STEP));
    const i = Math.floor(f);
    const t = f - i;
    const tx = this.tx[i] + (this.tx[i + 1] - this.tx[i]) * t;
    const ty = this.ty[i] + (this.ty[i + 1] - this.ty[i]) * t;
    const len = Math.hypot(tx, ty) || 1;
    out.hx = tx / len;
    out.hy = ty / len;
    out.x = this.x[i] + (this.x[i + 1] - this.x[i]) * t - out.hy * extraLeft;
    out.y = this.y[i] + (this.y[i + 1] - this.y[i]) * t + out.hx * extraLeft;
    out.heading = Math.atan2(out.hx, out.hy);
    // Extrapolate past the ends so vehicles never stack at the last vertex.
    if (s > this.length) {
      out.x += out.hx * (s - this.length);
      out.y += out.hy * (s - this.length);
    } else if (s < 0) {
      out.x += out.hx * s;
      out.y += out.hy * s;
    }
    return out;
  }

  /** Road height (m AHD) at route distance s. */
  /**
   * Clamp the lane offsets into [lo, hi] (walled stretches), smoothing the
   * steps that creates without leaving the bounds; kerb distances follow.
   */
  private keepInside(lo: Float32Array, hi: Float32Array, home: Float32Array): void {
    const n = this.n;
    const off = this.offset;
    let any = false;
    for (let i = 0; i < n; i++) if (lo[i] > -Infinity || hi[i] < Infinity) any = true;
    if (!any) return;
    const before = Float32Array.from(off);
    // A bus is long: the lane must keep clear of a wall for a few metres either side of where it
    // stands (the body is a chord across a swerve), so each sample takes its neighbours' bounds.
    const D = WALL_SPREAD;
    const lo0 = Float32Array.from(lo);
    const hi0 = Float32Array.from(hi);
    for (let i = 0; i < n; i++) {
      for (let j = Math.max(0, i - D); j <= Math.min(n - 1, i + D); j++) {
        // In the lane's own road frame (home), like the slope below.
        lo[i] = Math.max(lo[i], lo0[j] - home[j] + home[i]);
        hi[i] = Math.min(hi[i], hi0[j] - home[j] + home[i]);
      }
    }
    // Approach and leave a walled stretch gently: relative to the lane's own road
    // (`home`), the bounds widen by at most WALL_SLOPE per metre away from it
    // (platform lead-ins swerve inside the platform's own length, not across a
    // parapet or a tunnel portal).
    const step = WALL_SLOPE * TRACK_STEP;
    for (let i = 1; i < n; i++) {
      hi[i] = Math.min(hi[i], hi[i - 1] - home[i - 1] + home[i] + step);
      lo[i] = Math.max(lo[i], lo[i - 1] - home[i - 1] + home[i] - step);
    }
    for (let i = n - 2; i >= 0; i--) {
      hi[i] = Math.min(hi[i], hi[i + 1] - home[i + 1] + home[i] + step);
      lo[i] = Math.max(lo[i], lo[i + 1] - home[i + 1] + home[i] - step);
    }
    const clamp = () => {
      for (let i = 0; i < n; i++) {
        // No room between the walls we know of: the route line if it is close (the collider keeps
        // the way open along it), else midway.
        if (lo[i] > hi[i]) off[i] = Math.abs(home[i]) < 4 ? 0 : (lo[i] + hi[i]) / 2;
        else off[i] = Math.max(lo[i], Math.min(hi[i], off[i]));
      }
    };
    clamp();
    // Ease the steps the clamp made (only around them), without leaving the bounds.
    const near = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (Math.abs(off[i] - before[i]) < 0.01) continue;
      for (let j = Math.max(0, i - 6); j <= Math.min(n - 1, i + 6); j++) near[j] = 1;
    }
    for (let k = 0; k < 4; k++) {
      const sm = boxSmooth(off, 2);
      for (let i = 0; i < n; i++) if (near[i]) off[i] = sm[i];
      clamp();
    }
    for (let i = 0; i < n; i++) {
      const d = off[i] - before[i];
      if (d !== 0) this.kerb[i] = Math.max(1.3, Math.min(6, this.kerb[i] - d));
    }
  }

  zAt(s: number): number {
    const f = Math.max(0, Math.min(this.n - 1.0001, s / TRACK_STEP));
    const i = Math.floor(f);
    return this.z[i] + (this.z[i + 1] - this.z[i]) * (f - i);
  }

  /** Grade (rise over run) at route distance s, over +-`half` metres. */
  gradeAt(s: number, half = 8): number {
    return (this.zAt(s + half) - this.zAt(s - half)) / (2 * half);
  }

  vmaxAt(s: number): number {
    const i = Math.max(0, Math.min(this.n - 1, Math.round(s / TRACK_STEP)));
    return this.vmax[i];
  }

  kerbAt(s: number): number {
    const i = Math.max(0, Math.min(this.n - 1, Math.round(s / TRACK_STEP)));
    return this.kerb[i];
  }

  limitAt(s: number): number {
    const i = Math.max(0, Math.min(this.n - 1, Math.round(s / TRACK_STEP)));
    return this.limit[i] || 50;
  }
}

const tracks = new WeakMap<Route, RouteTrack>();
export function trackFor(route: Route, data: MapData): RouteTrack {
  let t = tracks.get(route);
  if (!t) {
    t = new RouteTrack(route, data);
    tracks.set(route, t);
  }
  return t;
}
export function hasTrack(route: Route): boolean {
  return tracks.has(route);
}
