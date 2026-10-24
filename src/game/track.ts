// A route resampled into a drivable left-lane path with kerb distances, a
// curvature/limit speed profile and the traffic signals along it. Shared by
// the player's RouteGuide and the AI traffic.
import { RoadKind, type MapData, type Road, type Route } from '../types';
import { pointAlong, wrapAngle } from '../data/coords';
import { drivable, roadIndexFor, speedLimitOf } from './roadIndex';
import { isStationStop } from './routeMeta';
import { matchStopPlatform, type PlatformZone } from './platforms';
import { LEVEL_GAP, heightsOf } from './height';
import { activeCollider } from '../sim/collider';

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
 * The lane centre stays this far from walls (tunnel tubes, viaduct parapets,
 * cutting retaining walls; sim/collider.ts): half a bus plus a margin for the
 * body swinging out on bends.
 */
const WALL_CLEAR = 2.1;
/** The bus's vertical span above the road (m): walls outside it are not in the way. */
const BUS_LO = -0.2;
const BUS_HI = 3.4;
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

const ALONG_3 = [-2, 0, 2];

/**
 * The walls the lane keeps clear of, and where a bus may drive: the driving
 * collider (sim/collider.ts SimCollider) fits.
 */
export interface TrackWalls {
  readonly walls: {
    readonly ax: Float32Array;
    readonly ay: Float32Array;
    readonly bx: Float32Array;
    readonly by: Float32Array;
    readonly lo: Float32Array;
    readonly hi: Float32Array;
    readonly count: number;
  };
  /** (x, y) is inside a carriageway or station bay at about level z. */
  drivable(x: number, y: number, z: number): boolean;
  /** The map road with this index (to tell which map the walls belong to). */
  road?(index: number): Road | undefined;
}

const registered = new WeakMap<MapData, TrackWalls>();

/**
 * Use these walls for every track of this map (the player's guide passes the
 * driving collider). Tracks built before are rebuilt on their next use.
 */
export function useTrackWalls(data: MapData, walls: TrackWalls): void {
  registered.set(data, walls);
}

/** The walls for this map: registered ones, else the driving collider if it was built for it. */
function wallsFor(data: MapData): TrackWalls | null {
  const w = registered.get(data);
  if (w) return w;
  const c = activeCollider;
  return c && c.road(0) === data.roads[0] ? c : null;
}

/** Uniform grid over wall pieces (CSR), cached per wall set. */
interface WallGrid {
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  start: Int32Array;
  items: Int32Array;
}
const WALL_CELL = 16;
const wallGrids = new WeakMap<object, WallGrid>();
function wallGrid(w: TrackWalls['walls']): WallGrid {
  let g = wallGrids.get(w);
  if (g) return g;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < w.count; i++) {
    x0 = Math.min(x0, w.ax[i], w.bx[i]);
    y0 = Math.min(y0, w.ay[i], w.by[i]);
    x1 = Math.max(x1, w.ax[i], w.bx[i]);
    y1 = Math.max(y1, w.ay[i], w.by[i]);
  }
  if (!w.count) x0 = y0 = x1 = y1 = 0;
  const nx = Math.max(1, Math.ceil((x1 - x0) / WALL_CELL) + 1);
  const ny = Math.max(1, Math.ceil((y1 - y0) / WALL_CELL) + 1);
  const start = new Int32Array(nx * ny + 1);
  const each = (i: number, fn: (c: number) => void) => {
    const cx0 = Math.floor((Math.min(w.ax[i], w.bx[i]) - x0) / WALL_CELL);
    const cx1 = Math.floor((Math.max(w.ax[i], w.bx[i]) - x0) / WALL_CELL);
    const cy0 = Math.floor((Math.min(w.ay[i], w.by[i]) - y0) / WALL_CELL);
    const cy1 = Math.floor((Math.max(w.ay[i], w.by[i]) - y0) / WALL_CELL);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) fn(cy * nx + cx);
  };
  for (let i = 0; i < w.count; i++) each(i, (c) => start[c + 1]++);
  for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
  const items = new Int32Array(start[nx * ny]);
  const fill = start.slice(0, nx * ny);
  for (let i = 0; i < w.count; i++) each(i, (c) => (items[fill[c]++] = i));
  g = { x0, y0, nx, ny, start, items };
  wallGrids.set(w, g);
  return g;
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
  /** The walls this track was fitted to (null: none were available). */
  readonly walls: TrackWalls | null;
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
    /** Lateral position of the matched road's centreline (along each sample's normal). */
    const roadC = new Float32Array(n);
    const kerbBase = new Float32Array(n);
    const known = new Uint8Array(n);
    // Walls beside each sample (lateral positions along its normal, + = left), for keeping the lane off them.
    const TW = wallsFor(data);
    this.walls = TW;
    const W = TW?.walls;
    const WG = W ? wallGrid(W) : null;
    const wallStart = new Int32Array(n + 1);
    const wallPos: number[] = [];
    const wallSeen = W ? new Int32Array(W.count) : new Int32Array(0);
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
        // Where our normal crosses the road's centreline (not just the nearest point's sideways part:
        // the road can run at an angle to the GTFS shape, through a junction hall or a turnaround).
        const rnx = -hit.dy;
        const rny = hit.dx;
        const cosN = rnx * nx[i] + rny * ny[i];
        const dC = Math.abs(cosN) > 0.5 ? ((hit.px - p.x) * rnx + (hit.py - p.y) * rny) / cosN : (hit.px - p.x) * nx[i] + (hit.py - p.y) * ny[i];
        const w = Math.max(3.2, road.width);
        const fromCentre = road.oneway ? Math.max(0, w / 2 - 1.75) : Math.min(6, Math.max(1.6, w / 2 - 1.75));
        target[i] = dC + fromCentre;
        roadC[i] = dC;
        kerbBase[i] = dC + (road.oneway ? w / 2 : Math.max(w / 2, 3.2));
        known[i] = 1;
        this.limit[i] = speedLimitOf(road);
        this.road[i] = hit.road;
      }
      // The collider's walls crossing this sample's normal (and halfway to its neighbours, so walls at
      // an angle cannot slip between samples), where they stand in the bus's way at this height.
      wallStart[i] = wallPos.length;
      if (W && WG) {
        const reach = Math.max(20, Math.abs(target[i]) + 10);
        const cx0 = Math.max(0, Math.floor((p.x - reach - WG.x0) / WALL_CELL));
        const cx1 = Math.min(WG.nx - 1, Math.floor((p.x + reach - WG.x0) / WALL_CELL));
        const cy0 = Math.max(0, Math.floor((p.y - reach - WG.y0) / WALL_CELL));
        const cy1 = Math.min(WG.ny - 1, Math.floor((p.y + reach - WG.y0) / WALL_CELL));
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            const c = cy * WG.nx + cx;
            for (let q = WG.start[c]; q < WG.start[c + 1]; q++) {
              const w = WG.items[q];
              if (wallSeen[w] === i + 1) continue;
              wallSeen[w] = i + 1;
              if (W.hi[w] <= zr + BUS_LO || W.lo[w] >= zr + BUS_HI) continue;
              const ax = W.ax[w];
              const ay = W.ay[w];
              const ex = W.bx[w] - ax;
              const ey = W.by[w] - ay;
              const den = ex * ny[i] - ey * nx[i];
              if (Math.abs(den) < 1e-6) continue;
              for (const along of ALONG_3) {
                const qx = p.x + dx * along - ax;
                const qy = p.y + dy * along - ay;
                const u = (qx * ny[i] - qy * nx[i]) / den;
                if (u < 0 || u > 1) continue;
                const t = (qx * ey - qy * ex) / den;
                if (Math.abs(t) <= reach) wallPos.push(t);
              }
            }
          }
        }
      }
    }
    wallStart[n] = wallPos.length;
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
    }
    // The gap between walls the lane runs in: the one around its road lane where a bus fits and can
    // drive (a carriageway or station bay: platform bays are open in the collider), else the nearest
    // such gap, staying on the side chosen just before; where none fits (a junction hall, a tight
    // turnaround), the middle of the gap the carriageway is in.
    const ws: number[] = [];
    let prev = NaN;
    for (let i = 0; i < n; i++) {
      const h = home[i];
      ws.length = 0;
      for (let k = wallStart[i]; k < wallStart[i + 1]; k++) ws.push(wallPos[k]);
      if (!ws.length || !TW) {
        prev = NaN;
        continue;
      }
      ws.sort((p1, p2) => p1 - p2);
      const z = this.z[i];
      const at = (t: number) => TW.drivable(bx[i] + nx[i] * t, by[i] + ny[i] * t, z);
      const gapLo = (g: number) => (g > 0 ? ws[g - 1] + WALL_CLEAR : -Infinity);
      const gapHi = (g: number) => (g < ws.length ? ws[g] - WALL_CLEAR : Infinity);
      const fits = (g: number, ref: number) => {
        const a = gapLo(g);
        const b = gapHi(g);
        return a <= b && at(Math.max(a, Math.min(b, ref)));
      };
      let gi = 0;
      while (gi < ws.length && ws[gi] < h) gi++;
      let pick = -1;
      if (fits(gi, h)) pick = gi;
      else {
        const ref = Number.isNaN(prev) ? h : prev;
        let best = Infinity;
        for (let g = 0; g <= ws.length; g++) {
          if (g === gi || !fits(g, ref)) continue;
          const a = gapLo(g);
          const b = gapHi(g);
          const d = ref < a ? a - ref : ref > b ? ref - b : 0;
          if (d < best && d < 12) {
            best = d;
            pick = g;
          }
        }
      }
      if (pick >= 0) {
        lo[i] = gapLo(pick);
        hi[i] = gapHi(pick);
      } else {
        // No gap a bus fits with room to spare: the middle of the drivable gap nearest the road lane.
        let g = gi;
        for (let d = 0; d <= ws.length; d++) {
          const cand = [gi - d, gi + d].find((k) => k >= 0 && k <= ws.length && k > 0 && k < ws.length && at((ws[k - 1] + ws[k]) / 2));
          if (cand !== undefined) {
            g = cand;
            break;
          }
        }
        const a = g > 0 ? ws[g - 1] : h - 3;
        const b = g < ws.length ? ws[g] : h + 3;
        const m = Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2 : h;
        const half = Math.max(0, (b - a) / 2 - WALL_CLEAR);
        lo[i] = m - half;
        hi[i] = m + half;
      }
      prev = Math.max(lo[i], Math.min(hi[i], h));
    }
    this.keepInside(lo, hi, home);
    this.bandLo = lo;
    this.bandHi = hi;
    for (let i = 0; i < n; i++) {
      this.x[i] = bx[i] + nx[i] * this.offset[i];
      this.y[i] = by[i] + ny[i] * this.offset[i];
    }
    if (TW && WG) this.fitToRoads(TW, WG, bx, by, nx, ny, roadC);
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
        // Bounds that cannot both be met (neighbours' walls, the slope limit): midway.
        if (lo[i] > hi[i]) off[i] = (lo[i] + hi[i]) / 2;
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

  /** Distance from (x, y) to the nearest wall in a bus's way at road height z (Infinity if none within r). */
  private wallDist(W: TrackWalls['walls'], G: WallGrid, x: number, y: number, z: number, r = 4): number {
    let best = Infinity;
    const cx0 = Math.max(0, Math.floor((x - r - G.x0) / WALL_CELL));
    const cx1 = Math.min(G.nx - 1, Math.floor((x + r - G.x0) / WALL_CELL));
    const cy0 = Math.max(0, Math.floor((y - r - G.y0) / WALL_CELL));
    const cy1 = Math.min(G.ny - 1, Math.floor((y + r - G.y0) / WALL_CELL));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * G.nx + cx;
        for (let q = G.start[c]; q < G.start[c + 1]; q++) {
          const w = G.items[q];
          if (W.hi[w] <= z + BUS_LO || W.lo[w] >= z + BUS_HI) continue;
          const ax = W.ax[w];
          const ay = W.ay[w];
          const ex = W.bx[w] - ax;
          const ey = W.by[w] - ay;
          const l2 = ex * ex + ey * ey || 1e-9;
          const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2));
          best = Math.min(best, Math.hypot(x - ax - ex * t, y - ay - ey * t));
        }
      }
    }
    return best;
  }

  /**
   * Where the lane still ends up off the carriageway or against a wall (tight
   * turnarounds and junction halls underground, where offsets from the GTFS
   * shape cannot describe the road), follow the road itself: map-match that
   * stretch onto the roads at this level (staying on connected roads) and put
   * the lane on the matched carriageway.
   */
  private fitToRoads(TW: TrackWalls, G: WallGrid, bx: Float32Array, by: Float32Array, nx: Float32Array, ny: Float32Array, roadC: Float32Array): void {
    const n = this.n;
    const data = this.data;
    const W = TW.walls;
    const idx = roadIndexFor(data);
    const bad = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      const z = this.z[i];
      if (!TW.drivable(this.x[i], this.y[i], z) || this.wallDist(W, G, this.x[i], this.y[i], z) < WALL_CLEAR - 0.6) {
        bad[i] = 1;
        any = true;
      }
    }
    if (!any) return;
    const M = 3;
    const runs: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      if (!bad[i]) continue;
      const a = Math.max(0, i - M);
      let b = i;
      while (b + 1 < n && (bad[b + 1] || (b + M + 1 < n && bad.subarray(b + 1, b + M + 2).includes(1)))) b++;
      b = Math.min(n - 1, b + M);
      const last = runs[runs.length - 1];
      if (last && a <= last[1] + 1) last[1] = b;
      else runs.push([a, b]);
      i = b;
    }
    const lane = (r: Road) => {
      const w = Math.max(3.2, r.width);
      return r.oneway ? Math.max(0, w / 2 - 1.75) : Math.min(6, Math.max(1.6, w / 2 - 1.75));
    };
    // Roads sharing a node (end to end or a junction on a vertex).
    const linked = new Map<number, boolean>();
    const connected = (a: number, b: number): boolean => {
      if (a === b) return true;
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      let v = linked.get(key);
      if (v === undefined) {
        v = false;
        const pa = data.roads[a].pts;
        const pb = data.roads[b].pts;
        const ends = (p: Float32Array) => [p[0], p[1], p[p.length - 2], p[p.length - 1]];
        for (const [P, Q] of [
          [ends(pa), pb],
          [ends(pb), pa],
        ] as const) {
          for (let e = 0; e < 4 && !v; e += 2) for (let k = 0; k < Q.length && !v; k += 2) if (Math.hypot(P[e] - Q[k], P[e + 1] - Q[k + 1]) < 1.5) v = true;
        }
        linked.set(key, v);
      }
      return v;
    };
    interface Cand {
      road: number;
      px: number;
      py: number;
      dx: number;
      dy: number;
      cost: number;
    }
    for (const [a, b] of runs) {
      // Candidates: carriageways at this level near the route (and the lane at the run's ends).
      const cands: Cand[][] = [];
      for (let i = a; i <= b; i++) {
        const z = this.z[i];
        // The route's general direction here (GTFS shapes wobble round junction halls: a bus carrying
        // straight on does not tour the turnaround beside it).
        const sa = pointAlong(this.route.pts, this.route.cum, i * TRACK_STEP - 16);
        const sb = pointAlong(this.route.pts, this.route.cum, i * TRACK_STEP + 16);
        const sl = Math.hypot(sb.x - sa.x, sb.y - sa.y) || 1;
        const tdx = (sb.x - sa.x) / sl;
        const tdy = (sb.y - sa.y) / sl;
        const qx = i === a || i === b ? this.x[i] : bx[i];
        const qy = i === a || i === b ? this.y[i] : by[i];
        const list: Cand[] = [];
        idx.forEachNear(qx, qy, 16, (ri, ax, ay, sdx, sdy, slen, d, zz) => {
          const r = data.roads[ri];
          if (r.kind === RoadKind.Pedestrian || Math.abs(zz - z) > LEVEL_GAP) return;
          const dot = sdx * tdx + sdy * tdy;
          const ldot = sdx * ny[i] - sdy * nx[i];
          if (r.oneway ? Math.max(dot, ldot) < 0.2 : Math.max(Math.abs(dot), Math.abs(ldot)) < 0.2) return;
          const t = Math.max(0, Math.min(slen, (qx - ax) * sdx + (qy - ay) * sdy));
          const sg = (Math.abs(dot) > Math.abs(ldot) ? dot : ldot) < 0 ? -1 : 1;
          const cost = d * 0.5 + (1 - Math.abs(dot)) * 30;
          const old = list.find((c) => c.road === ri);
          if (old && old.cost <= cost) return;
          const c = { road: ri, px: ax + sdx * t, py: ay + sdy * t, dx: sdx * sg, dy: sdy * sg, cost };
          if (old) Object.assign(old, c);
          else list.push(c);
        });
        cands.push(list);
      }
      // Viterbi over the stretch.
      const m = b - a + 1;
      const score: number[][] = [];
      const back: number[][] = [];
      for (let k = 0; k < m; k++) {
        const L = cands[k];
        score.push(L.map(() => Infinity));
        back.push(L.map(() => -1));
        for (let j = 0; j < L.length; j++) {
          if (k === 0) {
            score[k][j] = L[j].cost;
            continue;
          }
          const P = cands[k - 1];
          for (let q = 0; q < P.length; q++) {
            // Staying on a road is free, carrying straight on to a connected one cheap, turning off costs.
            const turn = 1 - (P[q].dx * L[j].dx + P[q].dy * L[j].dy);
            const tr = P[q].road === L[j].road ? 0 : connected(P[q].road, L[j].road) ? 1 + turn * 15 : 40;
            const v = score[k - 1][q] + tr + L[j].cost;
            if (v < score[k][j]) {
              score[k][j] = v;
              back[k][j] = q;
            }
          }
        }
      }
      let j = -1;
      let best = Infinity;
      score[m - 1].forEach((v, q) => {
        if (v < best) {
          best = v;
          j = q;
        }
      });
      if (j < 0) continue;
      const pick: (Cand | null)[] = new Array(m).fill(null);
      for (let k = m - 1; k >= 0 && j >= 0; k--) {
        pick[k] = cands[k][j] ?? null;
        j = back[k][j];
      }
      const DBG = (globalThis as { TRACK_DEBUG?: string }).TRACK_DEBUG;
      if (DBG === `${this.route.id}/${this.route.dir}`)
        for (let k = 0; k < m; k++)
          console.log(`run ${a}-${b} s ${(a + k) * TRACK_STEP} bad ${bad[a + k]} pick ${pick[k]?.road} cands ${cands[k].map((c) => `${c.road}:${c.cost.toFixed(1)}`).join(' ')}`);
      // Lane points on the matched carriageways (keeping a platform shift on the same road), eased in
      // and out over the run's margins.
      const px = new Float32Array(m);
      const py = new Float32Array(m);
      for (let k = 0; k < m; k++) {
        const i = a + k;
        const c = pick[k];
        if (!c) {
          px[k] = this.x[i];
          py[k] = this.y[i];
          continue;
        }
        const r = data.roads[c.road];
        const lat = c.road === this.road[i] ? Math.max(-r.width / 2, Math.min(r.width / 2, this.offset[i] - roadC[i])) : lane(r);
        px[k] = c.px - c.dy * lat;
        py[k] = c.py + c.dx * lat;
      }
      for (let k = 0; k < m; k++) {
        const i = a + k;
        const w = Math.min(1, (k + 1) / (M + 1), (m - k) / (M + 1));
        this.x[i] += (px[k] - this.x[i]) * w;
        this.y[i] += (py[k] - this.y[i]) * w;
      }
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
  // (Rebuilt when walls became available after it was built.)
  if (!t || t.walls !== wallsFor(data)) {
    t = new RouteTrack(route, data);
    tracks.set(route, t);
  }
  return t;
}
export function hasTrack(route: Route): boolean {
  return tracks.has(route);
}
