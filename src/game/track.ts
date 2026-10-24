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
import { specFor } from '../bus/spec';

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
/** The same while pulling in to or out of a platform. */
const PULL_SLOPE = 0.6;
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

/** Half the length of route (m) each lane sample keeps clear of walls: a little over half a sample step. */
const STRIP = 2.6;

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

/** A road the route might be on at a sample: closest point, unit direction along travel, and a cost. */
interface RoadCand {
  road: number;
  px: number;
  py: number;
  dx: number;
  dy: number;
  cost: number;
}

/**
 * Roads at level z within `radius` of (qx, qy) that run with the route
 * (one-way roads forwards only). (gdx, gdy) is the route's general direction
 * over ~60 m, (ldx, ldy) its local one: GTFS shapes wobble round junction
 * halls, and a bus carrying straight on does not tour the turnaround beside it.
 */
function roadCands(
  data: MapData,
  qx: number,
  qy: number,
  z: number,
  gdx: number,
  gdy: number,
  ldx: number,
  ldy: number,
  radius: number,
  minDot: number,
  accept: (r: Road) => boolean,
): RoadCand[] {
  const list: RoadCand[] = [];
  roadIndexFor(data).forEachNear(qx, qy, radius, (ri, ax, ay, sdx, sdy, slen, d, zz) => {
    const r = data.roads[ri];
    if (!accept(r) || Math.abs(zz - z) > LEVEL_GAP) return;
    const dot = sdx * gdx + sdy * gdy;
    const ldot = sdx * ldx + sdy * ldy;
    const best = Math.abs(dot) > Math.abs(ldot) ? dot : ldot;
    if (r.oneway ? best < minDot : Math.abs(best) < minDot) return;
    const t = Math.max(0, Math.min(slen, (qx - ax) * sdx + (qy - ay) * sdy));
    const sg = best < 0 ? -1 : 1;
    // (Main carriageways over narrow ramps and turnaround loops beside them.)
    const cost = d * 0.5 + (1 - Math.abs(dot)) * 30 + (r.width < 5 ? 4 : 0);
    const old = list.find((c) => c.road === ri);
    if (old && old.cost <= cost) return;
    const c = { road: ri, px: ax + sdx * t, py: ay + sdy * t, dx: sdx * sg, dy: sdy * sg, cost };
    if (old) Object.assign(old, c);
    else list.push(c);
  });
  return list;
}

const links = new WeakMap<MapData, Map<number, readonly [number, number] | null>>();
/** Where roads a and b join (an end of one on a vertex of the other), or null if they do not. */
function joinAt(data: MapData, a: number, b: number): readonly [number, number] | null {
  let m = links.get(data);
  if (!m) links.set(data, (m = new Map()));
  const key = a < b ? a * 65536 + b : b * 65536 + a;
  let v = m.get(key);
  if (v === undefined) {
    v = null;
    const pa = data.roads[a].pts;
    const pb = data.roads[b].pts;
    const ends = (q: Float32Array) => [q[0], q[1], q[q.length - 2], q[q.length - 1]];
    for (const [P, Q] of [
      [ends(pa), pb],
      [ends(pb), pa],
    ] as const) {
      for (let e = 0; e < 4 && !v; e += 2) for (let k = 0; k < Q.length && !v; k += 2) if (Math.hypot(P[e] - Q[k], P[e + 1] - Q[k + 1]) < 1.5) v = [P[e], P[e + 1]];
    }
    m.set(key, v);
  }
  return v;
}
/** Do two roads share a node (end to end, or one ending on a vertex of the other)? */
function connected(data: MapData, a: number, b: number): boolean {
  return a === b || joinAt(data, a, b) !== null;
}

/**
 * The most likely road at each sample (Viterbi): close to the route, running
 * its way, and staying on connected roads (carrying straight on is cheap,
 * turning off costs). Samples without candidates break the chain.
 */
function matchRoads(data: MapData, cands: RoadCand[][]): (RoadCand | null)[] {
  const m = cands.length;
  const out: (RoadCand | null)[] = new Array(m).fill(null);
  let k0 = 0;
  while (k0 < m) {
    while (k0 < m && !cands[k0].length) k0++;
    let k1 = k0;
    while (k1 + 1 < m && cands[k1 + 1].length) k1++;
    if (k0 >= m) break;
    const score: Float64Array[] = [];
    const back: Int32Array[] = [];
    for (let k = k0; k <= k1; k++) {
      const L = cands[k];
      const sc = new Float64Array(L.length).fill(Infinity);
      const bk = new Int32Array(L.length).fill(-1);
      for (let j = 0; j < L.length; j++) {
        if (k === k0) {
          sc[j] = L[j].cost;
          continue;
        }
        const P = cands[k - 1];
        const ps = score[k - 1 - k0];
        for (let q = 0; q < P.length; q++) {
          const turn = 1 - (P[q].dx * L[j].dx + P[q].dy * L[j].dy);
          // (Onto a connected road only through where they join, driving forwards: the join ahead on the
          // road left and behind on the road taken, not across to a parallel ramp that meets it further on.)
          let tr = 0;
          if (P[q].road !== L[j].road) {
            const at = joinAt(data, P[q].road, L[j].road);
            const via =
              at &&
              (at[0] - P[q].px) * P[q].dx + (at[1] - P[q].py) * P[q].dy > -3 &&
              (L[j].px - at[0]) * L[j].dx + (L[j].py - at[1]) * L[j].dy > -3 &&
              Math.hypot(P[q].px - at[0], P[q].py - at[1]) + Math.hypot(L[j].px - at[0], L[j].py - at[1]) < 40;
            tr = via ? 1 + turn * 15 : 80;
          }
          const v = ps[q] + tr + L[j].cost;
          if (v < sc[j]) {
            sc[j] = v;
            bk[j] = q;
          }
        }
      }
      score.push(sc);
      back.push(bk);
    }
    let j = -1;
    let best = Infinity;
    score[k1 - k0].forEach((v, q) => {
      if (v < best) {
        best = v;
        j = q;
      }
    });
    for (let k = k1; k >= k0 && j >= 0; k--) {
      out[k] = cands[k][j];
      j = back[k - k0][j];
    }
    k0 = k1 + 1;
  }
  return out;
}

/** Arc-length position of (x, y) projected onto a road's polyline, and the cumulative lengths. */
function roadCum(r: Road): Float32Array {
  const p = r.pts;
  const c = new Float32Array(p.length / 2);
  for (let k = 1; k < c.length; k++) c[k] = c[k - 1] + Math.hypot(p[2 * k] - p[2 * k - 2], p[2 * k + 1] - p[2 * k - 1]);
  return c;
}
function projectOnRoad(r: Road, cum: Float32Array, x: number, y: number): number {
  const p = r.pts;
  let best = Infinity;
  let bu = 0;
  for (let k = 0; k + 1 < cum.length; k++) {
    const ax = p[2 * k];
    const ay = p[2 * k + 1];
    const ex = p[2 * k + 2] - ax;
    const ey = p[2 * k + 3] - ay;
    const l2 = ex * ex + ey * ey || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2));
    const d = Math.hypot(x - ax - ex * t, y - ay - ey * t);
    if (d < best) {
      best = d;
      bu = cum[k] + t * Math.sqrt(l2);
    }
  }
  return bu;
}
/** Point and unit drawing direction at arc length u along a road. */
function roadAt(r: Road, cum: Float32Array, u: number): [number, number, number, number] {
  const p = r.pts;
  let k = 0;
  while (k + 2 < cum.length && cum[k + 1] < u) k++;
  const L = cum[k + 1] - cum[k] || 1e-6;
  const t = Math.max(0, Math.min(1, (u - cum[k]) / L));
  const ex = p[2 * k + 2] - p[2 * k];
  const ey = p[2 * k + 3] - p[2 * k + 1];
  const l = Math.hypot(ex, ey) || 1;
  return [p[2 * k] + ex * t, p[2 * k + 1] + ey * t, ex / l, ey / l];
}

/**
 * The lane along a sequence of matched roads from (x0, y0) to (x1, y1): each
 * road from where the last one joined it to where the next one leaves, as one
 * centreline, offset to each road's lane with mitred corners (so a lane on the
 * inside of a sharp junction corner does not double back); null if the roads
 * do not chain up.
 */
function roadPath(
  data: MapData,
  pick: (RoadCand | null)[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  lane: (r: Road) => number,
): number[] | null {
  const seq: RoadCand[] = [];
  for (const c of pick) {
    if (!c) return null;
    if (!seq.length || seq[seq.length - 1].road !== c.road) seq.push(c);
  }
  if (!seq.length || seq.length > 8) return null;
  for (let k = 1; k < seq.length; k++) if (!connected(data, seq[k - 1].road, seq[k].road)) return null;
  // The centreline (with each point's lane offset), in travel order.
  const cx: number[] = [];
  const cy: number[] = [];
  const cl: number[] = [];
  const add = (x: number, y: number, l: number) => {
    const m = cx.length - 1;
    if (m >= 0 && Math.hypot(x - cx[m], y - cy[m]) < 0.3) {
      cl[m] = (cl[m] + l) / 2;
      return;
    }
    cx.push(x);
    cy.push(y);
    cl.push(l);
  };
  let uIn = NaN;
  for (let k = 0; k < seq.length; k++) {
    const r = data.roads[seq[k].road];
    const cum = roadCum(r);
    const total = cum[cum.length - 1];
    // Travel along or against the drawing direction?
    const u0 = projectOnRoad(r, cum, seq[k].px, seq[k].py);
    const [, , ddx, ddy] = roadAt(r, cum, u0);
    const sg = ddx * seq[k].dx + ddy * seq[k].dy >= 0 ? 1 : -1;
    const from = k === 0 ? projectOnRoad(r, cum, x0, y0) : uIn;
    let to: number;
    if (k === seq.length - 1) to = projectOnRoad(r, cum, x1, y1);
    else {
      // Where the next road joins: the closest pair of vertices.
      const q = data.roads[seq[k + 1].road].pts;
      const pr = r.pts;
      let bd = Infinity;
      to = from;
      let next = 0;
      const qc = roadCum(data.roads[seq[k + 1].road]);
      for (let v = 0; v < pr.length; v += 2) {
        for (let w = 0; w < q.length; w += 2) {
          const d = Math.hypot(pr[v] - q[w], pr[v + 1] - q[w + 1]);
          if (d < bd) {
            bd = d;
            to = cum[v / 2];
            next = qc[w / 2];
          }
        }
      }
      uIn = next;
    }
    if ((to - from) * sg < -0.5 || !Number.isFinite(from)) return null;
    const lo = Math.max(0, Math.min(from, to));
    const hi = Math.min(total, Math.max(from, to));
    const us = [from, to];
    for (let v = 0; v < cum.length; v++) if (cum[v] > lo + 0.3 && cum[v] < hi - 0.3) us.push(cum[v]);
    us.sort((p, q) => (p - q) * sg);
    for (const u of us) {
      const [px, py] = roadAt(r, cum, Math.max(0, Math.min(total, u)));
      // (The centreline runs in travel order, so its left is the lane's side.)
      add(px, py, lane(r));
    }
  }
  const n = cx.length;
  if (n < 2) return null;
  // Offset with mitred joins (the miter at most twice the lane offset).
  const ox: number[] = [];
  const oy: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 1);
    const b = Math.min(n - 1, k + 1);
    const ix = cx[k] - cx[a] || cx[b] - cx[k];
    const iy = cy[k] - cy[a] || cy[b] - cy[k];
    const jx = cx[b] - cx[k] || ix;
    const jy = cy[b] - cy[k] || iy;
    const il = Math.hypot(ix, iy) || 1;
    const jl = Math.hypot(jx, jy) || 1;
    // Left normals of the segments in and out.
    const nix = -iy / il;
    const niy = ix / il;
    const njx = -jy / jl;
    const njy = jx / jl;
    let mx = nix + njx;
    let my = niy + njy;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      mx = nix;
      my = niy;
    } else {
      mx /= ml;
      my /= ml;
    }
    const d = cl[k] / Math.max(0.5, mx * nix + my * niy);
    ox.push(cx[k] + mx * d);
    oy.push(cy[k] + my * d);
  }
  // Drop offset points that would run backwards along the centreline (inside a corner tighter than
  // the offset).
  const out: number[] = [ox[0], oy[0]];
  let lastC = 0;
  for (let k = 1; k < n; k++) {
    const m = out.length - 2;
    const dx = ox[k] - out[m];
    const dy = oy[k] - out[m + 1];
    const tx = cx[k] - cx[lastC];
    const ty = cy[k] - cy[lastC];
    if (k < n - 1 && dx * tx + dy * ty <= 0) continue;
    out.push(ox[k], oy[k]);
    lastC = k;
  }
  return out.length >= 4 ? out : null;
}

/** Resample a polyline evenly into the given arrays (first and last points kept). */
function resample(path: number[], ox: Float32Array, oy: Float32Array): void {
  const n = path.length / 2;
  const cum = new Float32Array(n);
  for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(path[2 * k] - path[2 * k - 2], path[2 * k + 1] - path[2 * k - 1]);
  const total = cum[n - 1];
  const m = ox.length;
  let k = 0;
  for (let j = 0; j < m; j++) {
    const u = m > 1 ? (total * j) / (m - 1) : 0;
    while (k + 2 < n && cum[k + 1] < u) k++;
    const L = cum[k + 1] - cum[k] || 1e-6;
    const t = Math.max(0, Math.min(1, (u - cum[k]) / L));
    ox[j] = path[2 * k] + (path[2 * k + 2] - path[2 * k]) * t;
    oy[j] = path[2 * k + 1] + (path[2 * k + 3] - path[2 * k + 1]) * t;
  }
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
    /**
     * Per sample (bits): 1 = the GTFS shape runs at an angle to the matched road here (place the lane
     * from the road itself); 2 = beside a platform (its sideways shift is meant); 4 = alongside the
     * platform; 8 = easing in to or out of it.
     */
    const skew = new Uint8Array(n);
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
    const cands: RoadCand[][] = [];
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
      const zr = H.routeZ(route, s);
      this.z[i] = zr;
      // Roads the route may be on here, at its level only (not the street under a viaduct). In tunnels
      // and on viaducts the GTFS shape can stray 20+ m off the mapped carriageway: look further there.
      const sa = pointAlong(route.pts, route.cum, s - 30);
      const sb = pointAlong(route.pts, route.cum, s + 30);
      const sl = Math.hypot(sb.x - sa.x, sb.y - sa.y) || 1;
      const gdx = (sb.x - sa.x) / sl;
      const gdy = (sb.y - sa.y) / sl;
      let list = roadCands(data, p.x, p.y, zr, gdx, gdy, dx, dy, 14, 0.5, drivable);
      if (!list.length) list = roadCands(data, p.x, p.y, zr, gdx, gdy, dx, dy, 32, 0.6, walledRoad);
      cands.push(list);
      // The collider's walls crossing this sample's normal (and halfway to its neighbours, so walls at
      // an angle cannot slip between samples), where they stand in the bus's way at this height.
      wallStart[i] = wallPos.length;
      // (Only the grid cells along the strip, a piece at a time.)
      for (let piece = 0; W && WG && piece < 4; piece++) {
        const reach = 30;
        const ta = -reach + piece * 15;
        const xa = p.x + nx[i] * ta;
        const ya = p.y + ny[i] * ta;
        const xb = xa + nx[i] * 15;
        const yb = ya + ny[i] * 15;
        const cx0 = Math.max(0, Math.floor((Math.min(xa, xb) - STRIP - WG.x0) / WALL_CELL));
        const cx1 = Math.min(WG.nx - 1, Math.floor((Math.max(xa, xb) + STRIP - WG.x0) / WALL_CELL));
        const cy0 = Math.max(0, Math.floor((Math.min(ya, yb) - STRIP - WG.y0) / WALL_CELL));
        const cy1 = Math.min(WG.ny - 1, Math.floor((Math.max(ya, yb) + STRIP - WG.y0) / WALL_CELL));
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            const c = cy * WG.nx + cx;
            for (let q = WG.start[c]; q < WG.start[c + 1]; q++) {
              const w = WG.items[q];
              if (wallSeen[w] === i + 1) continue;
              wallSeen[w] = i + 1;
              if (W.hi[w] <= zr + BUS_LO || W.lo[w] >= zr + BUS_HI) continue;
              // The piece in this sample's frame (along the route, sideways), clipped to the strip
              // the sample stands for: the sideways span it blocks there.
              const a0 = (W.ax[w] - p.x) * dx + (W.ay[w] - p.y) * dy;
              const a1 = (W.bx[w] - p.x) * dx + (W.by[w] - p.y) * dy;
              const l0 = (W.ax[w] - p.x) * nx[i] + (W.ay[w] - p.y) * ny[i];
              const l1 = (W.bx[w] - p.x) * nx[i] + (W.by[w] - p.y) * ny[i];
              let u0 = 0;
              let u1 = 1;
              const da = a1 - a0;
              if (Math.abs(da) < 1e-6) {
                if (Math.abs(a0) > STRIP) continue;
              } else {
                const ua = (-STRIP - a0) / da;
                const ub = (STRIP - a0) / da;
                u0 = Math.max(u0, Math.min(ua, ub));
                u1 = Math.min(u1, Math.max(ua, ub));
                if (u0 > u1) continue;
              }
              const la = l0 + (l1 - l0) * u0;
              const lb = l0 + (l1 - l0) * u1;
              if (Math.min(la, lb) > reach || Math.max(la, lb) < -reach) continue;
              wallPos.push(Math.min(la, lb), Math.max(la, lb));
            }
          }
        }
      }
    }
    wallStart[n] = wallPos.length;
    // The road at each sample, matched along the whole route.
    const picks = matchRoads(data, cands);
    for (let i = 0; i < n; i++) {
      const c = picks[i];
      if (!c) continue;
      const road = data.roads[c.road];
      // Where our normal crosses the road's centreline (not just the nearest point's sideways part:
      // the road can run at an angle to the GTFS shape, through a junction hall or a turnaround).
      const rnx = -c.dy;
      const rny = c.dx;
      const cosN = rnx * nx[i] + rny * ny[i];
      const ox = c.px - bx[i];
      const oy = c.py - by[i];
      const dC = Math.abs(cosN) > 0.5 ? (ox * rnx + oy * rny) / cosN : ox * nx[i] + oy * ny[i];
      if (Math.abs(cosN) < 0.9) skew[i] = 1;
      const w = Math.max(3.2, road.width);
      const fromCentre = road.oneway ? Math.max(0, w / 2 - 1.75) : Math.min(6, Math.max(1.6, w / 2 - 1.75));
      target[i] = dC + fromCentre;
      roadC[i] = dC;
      kerbBase[i] = dC + (road.oneway ? w / 2 : Math.max(w / 2, 3.2));
      known[i] = 1;
      this.limit[i] = speedLimitOf(road);
      this.road[i] = c.road;
    }
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
      // The nearest edge within a couple of samples: a platform's end can kink towards the lane, and the
      // first and last samples can reach past the end to its far corners.
      const ed = Float32Array.from(z.edge, (_, k) => Math.min(...z.edge.subarray(Math.max(0, k - 2), k + 3)));
      const edgeAt = (s: number) => ed[Math.max(0, Math.min(ed.length - 1, Math.round((s - z.s0) / z.step)))];
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
        if (s > z.s0 - 8 && s < z.s1 + 8) skew[i] |= 2; // (alongside the platform: the lane's shift from the road is meant)
        if (s >= z.s0 && s <= z.s1) skew[i] |= 4;
        else skew[i] |= 8; // (pulling in or out)
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
    const spans: [number, number][] = [];
    let prev = NaN;
    for (let i = 0; i < n; i++) {
      const h = home[i];
      // Sideways spans blocked by walls here, merged where they overlap.
      spans.length = 0;
      for (let k = wallStart[i]; k < wallStart[i + 1]; k += 2) spans.push([wallPos[k], wallPos[k + 1]]);
      if (!spans.length || !TW) {
        prev = NaN;
        continue;
      }
      spans.sort((p1, p2) => p1[0] - p2[0]);
      const obLo: number[] = [];
      const obHi: number[] = [];
      for (const [a, b] of spans) {
        if (obLo.length && a <= obHi[obHi.length - 1]) obHi[obHi.length - 1] = Math.max(obHi[obHi.length - 1], b);
        else {
          obLo.push(a);
          obHi.push(b);
        }
      }
      const z = this.z[i];
      const at = (t: number) => TW.drivable(bx[i] + nx[i] * t, by[i] + ny[i] * t, z);
      // Gap g lies between blocked span g - 1 and span g.
      const gapLo = (g: number) => (g > 0 ? obHi[g - 1] + WALL_CLEAR : -Infinity);
      const gapHi = (g: number) => (g < obLo.length ? obLo[g] - WALL_CLEAR : Infinity);
      const fits = (g: number, ref: number) => {
        const a = gapLo(g);
        const b = gapHi(g);
        return a <= b && at(Math.max(a, Math.min(b, ref)));
      };
      let gi = 0;
      while (gi < obLo.length && obHi[gi] < h) gi++;
      let pick = -1;
      if (fits(gi, h)) pick = gi;
      else {
        const ref = Number.isNaN(prev) ? h : prev;
        let best = Infinity;
        for (let g = 0; g <= obLo.length; g++) {
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
        for (let d = 0; d <= obLo.length; d++) {
          const cand = [gi - d, gi + d].find((k) => k > 0 && k < obLo.length && at((obHi[k - 1] + obLo[k]) / 2));
          if (cand !== undefined) {
            g = cand;
            break;
          }
        }
        const a = g > 0 ? obHi[g - 1] : h - 3;
        const b = g < obLo.length ? obLo[g] : h + 3;
        const m = Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2 : h;
        const half = Math.max(0, (b - a) / 2 - WALL_CLEAR);
        lo[i] = m - half;
        hi[i] = m + half;
      }
      prev = Math.max(lo[i], Math.min(hi[i], h));
    }
    this.keepInside(lo, hi, home, skew);
    this.bandLo = lo;
    this.bandHi = hi;
    for (let i = 0; i < n; i++) {
      this.x[i] = bx[i] + nx[i] * this.offset[i];
      this.y[i] = by[i] + ny[i] * this.offset[i];
    }
    if (TW && WG) {
      this.fitToRoads(TW, WG, roadC, skew, picks);
      this.nudgeOffWalls(TW, WG);
      this.nudgeForTrailers(TW, WG);
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

  /**
   * Clamp the lane offsets into [lo, hi] (walled stretches), smoothing the
   * steps that creates without leaving the bounds; kerb distances follow.
   */
  private keepInside(lo: Float32Array, hi: Float32Array, home: Float32Array, skew: Uint8Array): void {
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
    // (Pulling in to a platform just past a tunnel mouth may swerve harder, as a driver would.)
    const stepAt = (i: number) => (skew[i] & 12 ? PULL_SLOPE : WALL_SLOPE) * TRACK_STEP;
    for (let i = 1; i < n; i++) {
      const step = stepAt(i);
      hi[i] = Math.min(hi[i], hi[i - 1] - home[i - 1] + home[i] + step);
      lo[i] = Math.max(lo[i], lo[i - 1] - home[i - 1] + home[i] - step);
    }
    for (let i = n - 2; i >= 0; i--) {
      const step = stepAt(i);
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
      // (Not alongside a platform: smoothing would round the lane off the platform edge.)
      for (let i = 0; i < n; i++) if (near[i] && !(skew[i] & 4)) off[i] = sm[i];
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
  private fitToRoads(TW: TrackWalls, G: WallGrid, roadC: Float32Array, skew: Uint8Array, picks: (RoadCand | null)[]): void {
    const n = this.n;
    const data = this.data;
    const W = TW.walls;
    const bad = new Uint8Array(n);
    let any = false;
    // Too sharp for a bus (folds where offsets from a skewed shape cross over): over 40 degrees in a step.
    const kink = (i: number) => {
      if (i < 1 || i + 1 >= n) return false;
      const ax = this.x[i] - this.x[i - 1];
      const ay = this.y[i] - this.y[i - 1];
      const bx = this.x[i + 1] - this.x[i];
      const by = this.y[i + 1] - this.y[i];
      return ax * bx + ay * by < Math.cos((40 * Math.PI) / 180) * Math.hypot(ax, ay) * Math.hypot(bx, by);
    };
    for (let i = 0; i < n; i++) {
      const z = this.z[i];
      const x = this.x[i];
      const y = this.y[i];
      if (
        skew[i] & 1 ||
        !TW.drivable(x, y, z) ||
        this.wallDist(W, G, x, y, z) < WALL_CLEAR - 0.6 ||
        (kink(i) && this.wallDist(W, G, x, y, z, 30) < Infinity)
      ) {
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
      // A one-way tube or ramp is a single carriageway between walls: keep to its centreline.
      if (r.oneway && walledRoad(r) && w < 8.5) return 0;
      return r.oneway ? Math.max(0, w / 2 - 1.75) : Math.min(6, Math.max(1.6, w / 2 - 1.75));
    };
    for (const [a, b] of runs) {
      // The roads matched along the whole route (connected, running the route's way).
      const m = b - a + 1;
      const pick = picks.slice(a, b + 1);
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
        // Keep a platform shift on the same road where that spot is clear; otherwise stay well inside
        // the carriageway's walls (the tube's walls stand half a lane-width out from its edge).
        const safe = Math.max(0, Math.max(3.2, r.width) / 2 + 0.9 - WALL_CLEAR);
        // On the road's own lane, unless the lane is pulling in to a platform on this road.
        let lat = c.road === this.road[i] && skew[i] === 2 ? this.offset[i] - roadC[i] : lane(r);
        const ok = (l: number) => {
          const qx = c.px - c.dy * l;
          const qy = c.py + c.dx * l;
          return TW.drivable(qx, qy, this.z[i]) && this.wallDist(W, G, qx, qy, this.z[i]) >= WALL_CLEAR - 0.6;
        };
        if (Math.abs(lat) > safe && !ok(lat)) lat = Math.max(-safe, Math.min(safe, lat));
        px[k] = c.px - c.dy * lat;
        py[k] = c.py + c.dx * lat;
      }
      // Better still, away from platforms: drive the matched roads themselves from the run's start to its
      // end (their own curves through a junction, rather than points projected from the GTFS shape).
      // (A platform approach in the stretch keeps its sideways shift beyond the road's lane.)
      const path = roadPath(data, pick, this.x[a], this.y[a], this.x[b], this.y[b], lane);
      if (path) {
        resample(path, px, py);
        const ex = new Float32Array(m);
        for (let k = 0; k < m; k++) {
          const i = a + k;
          const c = pick[k];
          if (!(skew[i] & 2) || !c || c.road !== this.road[i]) continue;
          ex[k] = this.offset[i] - roadC[i] - lane(data.roads[c.road]);
        }
        for (let k = 0; k < m; k++) {
          if (!ex[k]) continue;
          const k0 = Math.max(0, k - 1);
          const k1 = Math.min(m - 1, k + 1);
          const tx = px[k1] - px[k0];
          const ty = py[k1] - py[k0];
          const tl = Math.hypot(tx, ty) || 1;
          px[k] += (-ty / tl) * ex[k];
          py[k] += (tx / tl) * ex[k];
        }
      }
      for (let k = 0; k < m; k++) {
        const i = a + k;
        const w = Math.min(1, (k + 1) / (M + 1), (m - k) / (M + 1));
        this.x[i] += (px[k] - this.x[i]) * w;
        this.y[i] += (py[k] - this.y[i]) * w;
      }
      // Round off sharp corners where that stays clear (a bus sweeps a corner, it does not pivot).
      for (let pass = 0; pass < 3; pass++) {
        for (let k = 1; k < m - 1; k++) {
          const i = a + k;
          const qx = (this.x[i - 1] + 2 * this.x[i] + this.x[i + 1]) / 4;
          const qy = (this.y[i - 1] + 2 * this.y[i] + this.y[i + 1]) / 4;
          const z = this.z[i];
          if (TW.drivable(qx, qy, z) && this.wallDist(W, G, qx, qy, z) >= WALL_CLEAR - 0.4) {
            this.x[i] = qx;
            this.y[i] = qy;
          }
        }
      }
    }
  }

  /**
   * Last pass: a bus (or an articulated bus's trailer) runs along the chord
   * between lane points on either side of each sample, so where a body that
   * wide along that chord would touch a wall, ease the lane away from it a
   * little at a time (only into drivable space).
   */
  private nudgeOffWalls(TW: TrackWalls, G: WallGrid): void {
    const n = this.n;
    const W = TW.walls;
    const HALF = 1.5;
    // (Later passes only look again around what moved.)
    let look = new Uint8Array(n).fill(1);
    for (let pass = 0; pass < 8; pass++) {
      let moved = false;
      const next = new Uint8Array(n);
      for (let i = 1; i + 1 < n; i++) {
        if (!look[i]) continue;
        const z = this.z[i];
        const x0 = this.x[i - 1];
        const y0 = this.y[i - 1];
        let hx = this.x[i + 1] - x0;
        let hy = this.y[i + 1] - y0;
        const hl = Math.hypot(hx, hy);
        if (hl < 1) continue;
        hx /= hl;
        hy /= hl;
        // Left of the chord.
        const lx = -hy;
        const ly = hx;
        const cx = x0 + hx * hl * 0.5;
        const cy = y0 + hy * hl * 0.5;
        const half = hl * 0.5 + 1;
        let push = 0;
        const r = half + HALF;
        const gx0 = Math.max(0, Math.floor((cx - r - G.x0) / WALL_CELL));
        const gx1 = Math.min(G.nx - 1, Math.floor((cx + r - G.x0) / WALL_CELL));
        const gy0 = Math.max(0, Math.floor((cy - r - G.y0) / WALL_CELL));
        const gy1 = Math.min(G.ny - 1, Math.floor((cy + r - G.y0) / WALL_CELL));
        for (let gy = gy0; gy <= gy1; gy++) {
          for (let gx = gx0; gx <= gx1; gx++) {
            const c = gy * G.nx + gx;
            for (let q = G.start[c]; q < G.start[c + 1]; q++) {
              const w = G.items[q];
              if (W.hi[w] <= z + BUS_LO || W.lo[w] >= z + BUS_HI) continue;
              // The piece in the body's frame; clip to the body's length, then see how far it reaches in.
              const u0 = (W.ax[w] - cx) * hx + (W.ay[w] - cy) * hy;
              const u1 = (W.bx[w] - cx) * hx + (W.by[w] - cy) * hy;
              const v0 = (W.ax[w] - cx) * lx + (W.ay[w] - cy) * ly;
              const v1 = (W.bx[w] - cx) * lx + (W.by[w] - cy) * ly;
              let t0 = 0;
              let t1 = 1;
              const du = u1 - u0;
              if (Math.abs(du) < 1e-6) {
                if (Math.abs(u0) > half) continue;
              } else {
                const ta = (-half - u0) / du;
                const tb = (half - u0) / du;
                t0 = Math.max(t0, Math.min(ta, tb));
                t1 = Math.min(t1, Math.max(ta, tb));
                if (t0 > t1) continue;
              }
              const va = v0 + (v1 - v0) * t0;
              const vb = v0 + (v1 - v0) * t1;
              const vmin = Math.min(va, vb);
              const vmax = Math.max(va, vb);
              if (vmax < -HALF || vmin > HALF) continue;
              // Push away from the side the piece is mostly on (by how far it reaches in).
              const mid = (va + vb) / 2;
              const need = mid >= 0 ? -(HALF - vmin) : HALF + vmax;
              if (Math.abs(need) > Math.abs(push)) push = need;
            }
          }
        }
        if (!push) continue;
        const step = Math.sign(push) * Math.min(0.3, Math.abs(push));
        for (let k = i - 1; k <= i + 1; k++) {
          if (k < 0 || k >= n) continue;
          const f = k === i ? 1 : 0.5;
          const nxp = this.x[k] + lx * step * f;
          const nyp = this.y[k] + ly * step * f;
          if (!TW.drivable(nxp, nyp, this.z[k])) continue;
          const dNew = this.wallDist(W, G, nxp, nyp, this.z[k]);
          if (dNew < WALL_CLEAR - 0.6 && dNew < this.wallDist(W, G, this.x[k], this.y[k], this.z[k])) continue;
          this.x[k] = nxp;
          this.y[k] = nyp;
          moved = true;
          for (let q = Math.max(0, k - 2); q <= Math.min(n - 1, k + 2); q++) next[q] = 1;
        }
      }
      if (!moved) break;
      look = next;
    }
  }

  /**
   * Drive an articulated bus (the longest the routes use) along the lane and,
   * where a section sweeps into a wall (trailers cut the inside of tight
   * corners), swing the lane out there a little at a time.
   */
  private nudgeForTrailers(TW: TrackWalls, G: WallGrid): void {
    const n = this.n;
    const W = TW.walls;
    const spec = specFor('metro');
    const secs = spec.sections;
    const LIM = (50 * Math.PI) / 180;
    // Only near walls, with the chain driven in from WARM metres before (a chain started straight behind
    // on a curve is not where the trailers would be).
    const WARM = 40;
    const near = new Uint8Array(n);
    const sim = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (this.wallDist(W, G, this.x[i], this.y[i], this.z[i], 14) === Infinity) continue;
      near[i] = 1;
      for (let q = Math.max(0, i - WARM / TRACK_STEP); q <= i; q++) sim[q] = 1;
    }
    if (!near.includes(1)) return;
    // How far behind the front axle each section's tail is (it is only placed once driven that far).
    const tail = new Float64Array(secs.length);
    for (let k = 0, back = 0; k < secs.length; k++) {
      const sc = secs[k];
      if (k > 0) back += secs[k - 1].rearHitchFromFront - secs[k - 1].axleFromFront + sc.axleFromFront - sc.hitchFromFront;
      tail[k] = (k === 0 ? spec.wheelbase : back) + sc.length - sc.axleFromFront;
    }
    const at = (s: number): [number, number] => {
      const f = Math.max(0, Math.min(n - 1.0001, s / TRACK_STEP));
      const i = Math.floor(f);
      const t = f - i;
      return [this.x[i] + (this.x[i + 1] - this.x[i]) * t, this.y[i] + (this.y[i + 1] - this.y[i]) * t];
    };
    const sx = new Float64Array(secs.length);
    const sy = new Float64Array(secs.length);
    const sh = new Float64Array(secs.length);
    for (let pass = 0; pass < 10; pass++) {
      const push = new Float32Array(n);
      let fresh = true;
      let warm = 0;
      for (let s = 0; s < this.length - spec.wheelbase - 1; s += 1) {
        const i0 = Math.round(s / TRACK_STEP);
        const ic = Math.max(0, Math.min(n - 1, i0));
        if (!sim[ic]) {
          fresh = true;
          warm = 0;
          continue;
        }
        const [rx, ry] = at(s);
        const [fx, fy] = at(s + spec.wheelbase);
        const h0 = Math.atan2(fx - rx, fy - ry);
        sx[0] = rx;
        sy[0] = ry;
        sh[0] = h0;
        for (let k = 1; k < secs.length; k++) {
          const sp = secs[k - 1];
          const sc = secs[k];
          const c = sp.rearHitchFromFront - sp.axleFromFront;
          const d = sc.axleFromFront - sc.hitchFromFront;
          const hx = sx[k - 1] - Math.sin(sh[k - 1]) * c;
          const hy = sy[k - 1] - Math.cos(sh[k - 1]) * c;
          if (fresh) {
            sh[k] = sh[k - 1];
          } else {
            let hd = Math.atan2(hx - sx[k], hy - sy[k]);
            let rel = wrapAngle(sh[k - 1] - hd);
            rel = Math.max(-LIM, Math.min(LIM, rel));
            hd = wrapAngle(sh[k - 1] - rel);
            sh[k] = hd;
          }
          sx[k] = hx - Math.sin(sh[k]) * d;
          sy[k] = hy - Math.cos(sh[k]) * d;
        }
        fresh = false;
        warm += 1;
        if (s % 2 !== 0 || !near[ic]) continue;
        for (let k = 0; k < secs.length; k++) {
          const sc = secs[k];
          if (k > 0 && warm < tail[k] + 4) continue;
          const hx = Math.sin(sh[k]);
          const hy = Math.cos(sh[k]);
          const lx = -hy;
          const ly = hx;
          const co = sc.axleFromFront - sc.length / 2;
          const cx = sx[k] + hx * co;
          const cy = sy[k] + hy * co;
          // The lane sample this section is beside (and so its height: a trailer on a ramp is not at the
          // front's level).
          let j = -1;
          let bd = Infinity;
          for (let q = Math.max(0, i0 - 8); q <= Math.min(n - 1, i0 + 4); q++) {
            const dd = (this.x[q] - cx) ** 2 + (this.y[q] - cy) ** 2;
            if (dd < bd) {
              bd = dd;
              j = q;
            }
          }
          if (j < 0) continue;
          const need = this.bodyPush(W, G, cx, cy, this.z[j], hx, hy, sc.length / 2, spec.width / 2 + 0.15);
          if (!need) continue;
          // The section's sideways push, as the lane's sideways (+ = left of the lane).
          const a = Math.max(0, j - 1);
          const b = Math.min(n - 1, j + 1);
          const tl = Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a]) || 1;
          const nlx = -(this.y[b] - this.y[a]) / tl;
          const nly = (this.x[b] - this.x[a]) / tl;
          const v = need * (lx * nlx + ly * nly);
          if (Math.abs(v) > Math.abs(push[j])) push[j] = v;
        }
      }
      let moved = false;
      const movedAt = new Uint8Array(n);
      for (let j = 0; j < n; j++) {
        if (!push[j]) continue;
        const a = Math.max(0, j - 1);
        const b = Math.min(n - 1, j + 1);
        const tl = Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a]) || 1;
        const nlx = -(this.y[b] - this.y[a]) / tl;
        const nly = (this.x[b] - this.x[a]) / tl;
        const step = Math.sign(push[j]) * Math.min(0.3, Math.abs(push[j]));
        for (let k = j - 2; k <= j + 2; k++) {
          if (k < 0 || k >= n) continue;
          const f = k === j ? 1 : Math.abs(k - j) === 1 ? 0.7 : 0.35;
          const qx = this.x[k] + nlx * step * f;
          const qy = this.y[k] + nly * step * f;
          // Into drivable space, and not closer to a wall than it was (or than a bus allows).
          if (!TW.drivable(qx, qy, this.z[k])) continue;
          const dNew = this.wallDist(W, G, qx, qy, this.z[k]);
          if (dNew < WALL_CLEAR - 0.6 && dNew < this.wallDist(W, G, this.x[k], this.y[k], this.z[k])) continue;
          this.x[k] = qx;
          this.y[k] = qy;
          moved = true;
          movedAt[k] = 1;
        }
      }
      if (!moved) break;
      // Next pass: only around what moved (driven in from WARM metres before, through the chain's length).
      sim.fill(0);
      for (let k = 0; k < n; k++) {
        if (!movedAt[k]) continue;
        for (let q = Math.max(0, k - WARM / TRACK_STEP - 4); q <= Math.min(n - 1, k + 10); q++) sim[q] = 1;
      }
    }
  }

  /**
   * How far a body (centre, unit heading, half length and width) must move
   * sideways (+ = to its left) to clear the walls it overlaps; 0 if clear.
   */
  private bodyPush(W: TrackWalls['walls'], G: WallGrid, cx: number, cy: number, z: number, hx: number, hy: number, half: number, hw: number): number {
    const lx = -hy;
    const ly = hx;
    let push = 0;
    const r = half + hw;
    const gx0 = Math.max(0, Math.floor((cx - r - G.x0) / WALL_CELL));
    const gx1 = Math.min(G.nx - 1, Math.floor((cx + r - G.x0) / WALL_CELL));
    const gy0 = Math.max(0, Math.floor((cy - r - G.y0) / WALL_CELL));
    const gy1 = Math.min(G.ny - 1, Math.floor((cy + r - G.y0) / WALL_CELL));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = gy * G.nx + gx;
        for (let q = G.start[c]; q < G.start[c + 1]; q++) {
          const w = G.items[q];
          if (W.hi[w] <= z + BUS_LO || W.lo[w] >= z + BUS_HI) continue;
          const u0 = (W.ax[w] - cx) * hx + (W.ay[w] - cy) * hy;
          const u1 = (W.bx[w] - cx) * hx + (W.by[w] - cy) * hy;
          const v0 = (W.ax[w] - cx) * lx + (W.ay[w] - cy) * ly;
          const v1 = (W.bx[w] - cx) * lx + (W.by[w] - cy) * ly;
          let t0 = 0;
          let t1 = 1;
          const du = u1 - u0;
          if (Math.abs(du) < 1e-6) {
            if (Math.abs(u0) > half) continue;
          } else {
            const ta = (-half - u0) / du;
            const tb = (half - u0) / du;
            t0 = Math.max(t0, Math.min(ta, tb));
            t1 = Math.min(t1, Math.max(ta, tb));
            if (t0 > t1) continue;
          }
          const va = v0 + (v1 - v0) * t0;
          const vb = v0 + (v1 - v0) * t1;
          const vmin = Math.min(va, vb);
          const vmax = Math.max(va, vb);
          if (vmax < -hw || vmin > hw) continue;
          const need = (va + vb) / 2 >= 0 ? -(hw - vmin) : hw + vmax;
          if (Math.abs(need) > Math.abs(push)) push = need;
        }
      }
    }
    return push;
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
