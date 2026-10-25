// A route resampled into a drivable left-lane path with kerb distances, a
// curvature/limit speed profile and the traffic signals along it. Shared by
// the player's RouteGuide and the AI traffic.
import { RoadKind, type MapData, type Road, type Route } from '../types';
import { pointAlong, wrapAngle } from '../data/coords';
import { drivable, roadIndexFor, speedLimitOf } from './roadIndex';
import { busTypeForRoute, isStationStop } from './routeMeta';
import { matchStopPlatform, platformEdgeAt, platformGeoms, type PlatformZone } from './platforms';
import { LEVEL_GAP, heightsOf } from './height';
import { activeCollider } from '../sim/collider';
import { specFor } from '../bus/spec';
import { signalsFor } from '../data/signals';

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
  /**
   * Busway platform the stop is served from: any bay along [s0, s1] will do (trimmed to where the
   * lane runs alongside the platform edge).
   */
  zone: PlatformZone | null;
  /** Where a bus serving the stop stands with its front: the platform's front bay, else the stop. */
  target: number;
  /**
   * How far left of the lane a bus moves to stand ~0.35 m off the kerb or platform edge at `target`
   * (about 0 alongside a platform, where the lane already runs at the edge).
   */
  pull: number;
}

/** Lane centre this far from a platform edge puts the bus side ~0.35 m off it. */
const PLATFORM_LANE = 1.6;
/**
 * Passing a platform it does not stop at (on its left, at its level), a lane nearer its edge than
 * PLATFORM_LANE + PLATFORM_APART keeps the line the buses stopping there stand on (PLATFORM_LANE from the
 * edge), or, where it runs over halfway out to the next lane and a bus fits there, that lane (PLATFORM_APART
 * further out): beside a bus at the platform, not half across it.
 */
const PLATFORM_APART = 3.0;
/**
 * Alongside a stop's platform, a road whose left kerb is more than PLATFORM_KERB_GAP m further from the platform
 * edge than the nearest one's costs the road match this much more per sample: the bus is on the road beside the
 * platform (a busway splitting into a road along the platform and a through road, the GTFS shape nearer the
 * through road).
 */
const PLATFORM_MATCH = 6;
const PLATFORM_KERB_GAP = 1;
/**
 * A pull-in starts only once the lane has left walls standing between it and the platform line (a
 * viaduct parapet running on to the platform's end), this far past them (m: an articulated bus's rear
 * sections pass the walls' end before its front swings over), and may then ease on over up to
 * PULL_INTO m of the platform.
 */
const PULL_CLEAR = 8;
const PULL_INTO = 30;
/** Walls holding the lane less than this far off the platform line (m) leave the bus alongside. */
const PULL_HOLD = 0.6;
/**
 * The lane centre stays this far from walls (tunnel tubes, viaduct parapets,
 * cutting retaining walls; sim/collider.ts): half a bus plus a margin for the
 * body swinging out on bends.
 */
const WALL_CLEAR = 2.1;
/**
 * Room kept between a bus's sweep (front axle on the lane, the rear and any trailers trailing it inside
 * the bend) and the walls: with half a rigid bus, WALL_CLEAR, so a wall corner on the inside of a bend
 * gets WALL_CLEAR plus the offtracking. The driver's (or autopilot's) line and the body's sway are not exact.
 */
const SWEEP_MARGIN = 0.85;
/** The bus body's vertical span above the road (m; the collider's sections start 0.25 m up): walls outside it are not in the way. */
const BUS_LO = 0.25;
const BUS_HI = 3.4;
/**
 * On a two-way road a lane keeps at least this far left of the centre line (opposing lanes 3.3 m apart:
 * two buses 2.55 m wide pass 0.75 m apart), except inside a junction box (up to the stop lines), where
 * turning paths cross. So does a one-way carriageway's lane from the line midway between it and the
 * other direction's carriageway, where they run close (a busway's split).
 */
const OWN_MIN = 1.65;
/** How much nearer a wall than WALL_CLEAR a lane may run to keep OWN_MIN from the centre line. */
const OWN_OVER = 0.3;
/**
 * Where a bus's sweep on a bend would still hit a wall, its lane may give up as much of OWN_MIN, up to
 * OWN_GIVE (opposing lanes 3 m apart at the least).
 */
const OWN_GIVE = 0.15;
/**
 * In a junction box the lane keeps no half of the road it is on, but it keeps its side of the two-way roads
 * it comes from and goes on into, their centre lines carried on into the box, while it heads within
 * TURN_ALONG of them: OWN_MIN where it goes through the box straight on (turning less than TURN_STRAIGHT
 * radians), TURN_LEFT_MIN where it turns left (a bus swings wide into a narrow street) and TURN_RIGHT_MIN
 * (within TURN_RIGHT_ALONG) where it turns right, across the oncoming lanes. The wall sweep holds to this;
 * the corner solve only turning left, to TURN_LEFT_HOLD where that leaves the corner wide enough (see regularize).
 */
const TURN_ALONG = (50 * Math.PI) / 180;
/**
 * Before turning right (more than TURN_LANE_MIN radians) off a road with more than one lane its way, the
 * lane keeps to the right-hand lane for TURN_LANE_HOLD m, having moved over from the kerb lane in the
 * TURN_LANE_EASE m per lane's width before that: from the kerb lane the bus would turn across the lanes
 * going straight on.
 */
const TURN_LANE_MIN = 1.0;
const TURN_LANE_HOLD = 32;
const TURN_LANE_EASE = 9;
/** A turn lane the road leaves room to hold for less than this (m) is not taken. */
const TURN_LANE_HELD = 16;
/** Samples past a turn's node its turn lane may carry on straight for, to meet the lane it turns into. */
const TURN_CARRY = 6;
/** How hard the corner solve holds a turn lane's held samples sideways where they were (against bending). */
const TURN_HOLD_W = 1;
/**
 * Bearing right by TURN_FORK_MIN radians and up to TURN_LANE_MIN where another road carries straight on (a
 * fork), the lane takes the right-hand lane as for a turn: the traffic going straight on keeps the lanes left
 * of it.
 */
const TURN_FORK_MIN = 0.4;
/** Another road carries straight on from a fork's node within this (radians) of the approach. */
const TURN_FORK_ON = 0.35;
/**
 * Bearing right by TURN_BEAR_MIN up to TURN_FORK_MIN radians at a split (another road leaving the node straight on,
 * TURN_BEAR_APART or more left of the route's way: a busway splitting into platform roads), the lane takes the
 * right-hand lane too: buses queueing for the left-hand branch's platform wait in the kerb lane.
 */
const TURN_BEAR_MIN = 0.12;
const TURN_BEAR_APART = 0.12;
/** The route's own shape may bear up to this (radians) the other way at a split, the roads' headings deciding. */
const TURN_SPLIT_SLACK = 0.2;
const TURN_STRAIGHT = 0.35;
const TURN_LEFT_MIN = 0.0;
const TURN_LEFT_ALONG = (50 * Math.PI) / 180;
const TURN_RIGHT_MIN = 1.0;
const TURN_RIGHT_ALONG = (15 * Math.PI) / 180;
/**
 * Turning left, the corner solve keeps the lane this far left of the centre lines of the roads it turns from and
 * into (TURN_LEFT_MIN is the wall sweep's): the bus swings wide in the junction box, its body on its own side.
 */
const TURN_LEFT_HOLD = 1.25;
/**
 * A corner the junction-box solve leaves tighter than this (m) is solved again, from where that left it, while that
 * still eases it by TURN_EASED m (up to TURN_SOLVES times); still too tight, with the left-turn guard eased to the
 * centre lines, then without it (in a narrow street a bus swings across the centre line rather than kink).
 */
const TURN_GUARD_R = 6.5;
const TURN_SOLVES = 4;
const TURN_EASED = 0.25;
/** The left-turn guard's hold at each step (NaN: none). */
const TURN_GUARD_STEPS = [TURN_LEFT_HOLD, TURN_LEFT_MIN, NaN];
/**
 * Nor does it run more than OPP_IN inside a one-way carriageway heading against it (within acos(OPP_DOT)
 * of the opposite way): a dual carriageway's other half, mapped as its own way.
 */
const OPP_IN = 1;
const OPP_DOT = 0.7;
/** Junction box reach either side of a junction node (m), within these bounds. */
const JUNCTION_BOX_MIN = 4.5;
const JUNCTION_BOX_MAX = 12;
/**
 * Where a bus route turns sharply at a node (more than TURN_MIN radians), the junction box reaches as far
 * as a lane turning on a TURN_R m radius needs, plus TURN_RAMP to ease into the turn (up to TURN_BOX_MAX),
 * and a lane corner still tighter than R_OK in its own half may use it, the oncoming lanes in it included;
 * the stop lines stay behind it.
 */
const TURN_MIN = 0.7;
const TURN_R = 9;
const TURN_BOX_MAX = 24;
const TURN_RAMP = 5;
const R_OK = 7.6;
/** Times a lane stretch is solved again with the samples its solve could not fit pinned where they were. */
const PIN_RETRIES = 2;
/** Share of the steering lock the speed profile leaves spare in a bend, for the steering's corrections. */
const STEER_SPARE = 0.15;
/** Lane radius the last evening pass aims for in the lane's own half (m). */
const R_EASY = 9;
/**
 * The furthest a wall gap may be from the lane's own road lane and still bound it (m): a gap further
 * off is another carriageway seen along a skewed GTFS normal (a junction, a shape far off the road),
 * and the slope limit would drag the lane tens of metres towards it, over the centre line.
 */
const BAND_REACH = 5;
/** Sideways metres per metre the lane may move away from a walled stretch. */
const WALL_SLOPE = 0.35;
/** The same while pulling in to or out of a platform. */
const PULL_SLOPE = 0.6;
/** Samples either side whose wall bounds a lane sample also keeps to. */
const WALL_SPREAD = 1;
/** The most sideways slope (to the GTFS normal's frame) the wall band follows the road lane at. */
const BAND_SKEW = 0.5;

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
  /** (x, y) is inside a solid building footprint at height z (the lane keeps the bus off shop fronts). */
  pointInBuilding?(x: number, y: number, z?: number): boolean;
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

/** A road the route might be on at a sample: closest point, unit direction along travel, its height there, and a cost. */
interface RoadCand {
  road: number;
  px: number;
  py: number;
  dx: number;
  dy: number;
  z: number;
  cost: number;
}

/** A road only buses use (busway, bus lane, bus link). */
const busRoad = (r: Road): boolean => r.bus || r.kind === RoadKind.Busway;
/** How much further than the bus-road radius a one-way bus ramp is looked for near a sharp turn of the shape. */
const RAMP_REACH = 6;
/** A turn of the GTFS shape (heading 5-25 m before vs after) sharp enough that it may be running out to a node and back. */
const SHAPE_SHARP = 1.0;
/** How far either side of such a turn one-way bus ramps are looked for. */
const SHAPE_SHARP_SPAN = 32;

/**
 * Roads at level z within `radius` of (qx, qy) that run with the route
 * (one-way roads forwards only). (gdx, gdy) is the route's general direction
 * over ~60 m, (ldx, ldy) its local one: GTFS shapes wobble round junction
 * halls, and a bus carrying straight on does not tour the turnaround beside it.
 * Bus-only roads are looked for up to `busRadius` away: TransLink shapes cut
 * the corners their slip lanes take (Victoria Bridge onto North Quay). With
 * `ramps` (near a sharp turn of the shape), one-way bus roads running the
 * route's way are looked for RAMP_REACH further and their distance past 8 m
 * costs 0.2 a metre instead of 0.5: there the shapes can run out to the far
 * junction node and back, 20+ m off the ramp buses take (Eastern Busway onto
 * the SEB inbound, Butterfield Street onto the Northern Busway).
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
  busRadius = radius,
  ramps = false,
): RoadCand[] {
  const list: RoadCand[] = [];
  roadIndexFor(data).forEachNear(qx, qy, Math.max(radius, busRadius + (ramps ? RAMP_REACH : 0)), (ri, ax, ay, sdx, sdy, slen, d, zz) => {
    const r = data.roads[ri];
    if (!accept(r) || Math.abs(zz - z) > LEVEL_GAP) return;
    if (d > radius && !busRoad(r)) return;
    const ramp = ramps && busRoad(r) && r.oneway;
    if (d > busRadius && !ramp) return;
    const dot = sdx * gdx + sdy * gdy;
    const ldot = sdx * ldx + sdy * ldy;
    const best = Math.abs(dot) > Math.abs(ldot) ? dot : ldot;
    if (r.oneway ? best < minDot : Math.abs(best) < minDot) return;
    const t = Math.max(0, Math.min(slen, (qx - ax) * sdx + (qy - ay) * sdy));
    const sg = best < 0 ? -1 : 1;
    // (Main carriageways over narrow ramps and turnaround loops beside them; not a one-way bus lane or
    // slip road, which is where the bus really runs.)
    const narrow = r.width < 5 && !(busRoad(r) && r.oneway && !r.tunnel);
    const cost = (ramp ? Math.min(d, 8) * 0.5 + Math.max(0, d - 8) * 0.2 : d * 0.5) + (1 - Math.abs(dot)) * 30 + (narrow ? 4 : 0);
    const old = list.find((c) => c.road === ri);
    if (old && old.cost <= cost) return;
    const c = { road: ri, px: ax + sdx * t, py: ay + sdy * t, dx: sdx * sg, dy: sdy * sg, z: zz, cost };
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
            // (A bus does not pivot: turning back on itself at a node is a last resort when a slip road
            // or a wider sweep is on offer.)
            const deg = (Math.acos(Math.max(-1, Math.min(1, 1 - turn))) * 180) / Math.PI;
            tr = via ? 1 + turn * 15 + Math.max(0, deg - 95) * 2.5 : 80;
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
/**
 * The junction nodes where a bus route turns sharply (by its GTFS shape, at the node's level), with how
 * far either side of the node a lane turning there on a TURN_R m radius reaches (the turn's junction
 * box), and the nodes' positions for finding them near a signalised junction.
 */
export interface TurnBoxes {
  box: Map<number, number>;
  x: number[];
  y: number[];
  z: number[];
  r: number[];
}
const turnBoxCache = new WeakMap<MapData, TurnBoxes>();
export function turnBoxes(data: MapData): TurnBoxes {
  const hit = turnBoxCache.get(data);
  if (hit) return hit;
  const deg = new Map<number, number>();
  const at = new Map<number, [number, number, number]>();
  for (const r of data.roads) {
    const p = r.pts;
    const nv = p.length / 2;
    for (let k = 0; k < nv; k++) {
      const q = endKey(p[2 * k], p[2 * k + 1]);
      deg.set(q, (deg.get(q) ?? 0) + (k === 0 || k === nv - 1 ? 1 : 2));
      if (!at.has(q)) at.set(q, [p[2 * k], p[2 * k + 1], r.z[k]]);
    }
  }
  const CELL = 32;
  const grid = new Map<number, number[]>();
  for (const [q, d] of deg) {
    if (d < 3) continue;
    const [x, y] = at.get(q)!;
    const g = (Math.floor(x / CELL) + 2048) * 4096 + Math.floor(y / CELL) + 2048;
    let l = grid.get(g);
    if (!l) grid.set(g, (l = []));
    l.push(q);
  }
  const H = heightsOf(data);
  const out: TurnBoxes = { box: new Map(), x: [], y: [], z: [], r: [] };
  const heading = (route: Route, a: number, b: number) => {
    const pa = pointAlong(route.pts, route.cum, a);
    const pb = pointAlong(route.pts, route.cum, b);
    return Math.atan2(pb.x - pa.x, pb.y - pa.y);
  };
  for (const route of data.routes) {
    const p = route.pts;
    const cum = route.cum;
    // Each junction node within 5 m of the route line: where the line passes nearest it.
    const near = new Map<number, [number, number]>();
    for (let k = 0; k + 1 < cum.length; k++) {
      const ax = p[2 * k];
      const ay = p[2 * k + 1];
      const ex = p[2 * k + 2] - ax;
      const ey = p[2 * k + 3] - ay;
      const l2 = ex * ex + ey * ey;
      if (l2 < 1e-6) continue;
      const gx0 = Math.floor((Math.min(ax, ax + ex) - 5) / CELL);
      const gx1 = Math.floor((Math.max(ax, ax + ex) + 5) / CELL);
      const gy0 = Math.floor((Math.min(ay, ay + ey) - 5) / CELL);
      const gy1 = Math.floor((Math.max(ay, ay + ey) + 5) / CELL);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const l = grid.get((gx + 2048) * 4096 + gy + 2048);
          if (!l) continue;
          for (const q of l) {
            const [x, y] = at.get(q)!;
            const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2));
            const d = Math.hypot(x - ax - ex * t, y - ay - ey * t);
            if (d > 5) continue;
            const prev = near.get(q);
            if (!prev || d < prev[0]) near.set(q, [d, cum[k] + t * (cum[k + 1] - cum[k])]);
          }
        }
      }
    }
    for (const [q, [, s]] of near) {
      const [x, y, z] = at.get(q)!;
      // The turn: the line's heading 5-25 m before the node against 5-25 m after it.
      const turn = Math.abs(wrapAngle(heading(route, s + 5, s + 25) - heading(route, s - 25, s - 5)));
      if (turn < TURN_MIN || Math.abs(H.routeZ(route, s) - z) > LEVEL_GAP) continue;
      const box = Math.min(TURN_BOX_MAX, (TURN_R + 2) * Math.tan(Math.min(2.45, turn) / 2) + TURN_RAMP);
      const had = out.box.get(q);
      if (had === undefined) {
        out.x.push(x);
        out.y.push(y);
        out.z.push(z);
        out.r.push(0);
      }
      out.box.set(q, Math.max(had ?? 0, box));
    }
  }
  // (Positions in insertion order: fill the radii from the map.)
  let k = 0;
  for (const b of out.box.values()) out.r[k++] = b;
  turnBoxCache.set(data, out);
  return out;
}

/**
 * Per road, where along it other roads join (distance along the road of every vertex where three or more
 * road ends meet, a road passing through counting as two) and how far either side of each the junction
 * box reaches (to just short of where the stop lines go: half the widest road there + 2 m), and whether
 * its start and end are dead ends (no other road there).
 */
interface RoadNodes {
  junctions: Float32Array[];
  box: Float32Array[];
  /** The box a sharp bus turn there needs (0 where none turns sharply). */
  turn: Float32Array[];
  deadStart: Uint8Array;
  deadEnd: Uint8Array;
  cum: Float32Array[];
  /** A one-way road's start (2i) and end (2i + 1) at a split: the two-way road it carries on from (-1 if none). */
  split: Int32Array;
}
const roadNodesCache = new WeakMap<MapData, RoadNodes>();
function roadNodes(data: MapData): RoadNodes {
  const hit = roadNodesCache.get(data);
  if (hit) return hit;
  const deg = new Map<number, number>();
  const wide = new Map<number, number>();
  for (const r of data.roads) {
    const p = r.pts;
    const nv = p.length / 2;
    for (let k = 0; k < nv; k++) {
      const q = endKey(p[2 * k], p[2 * k + 1]);
      deg.set(q, (deg.get(q) ?? 0) + (k === 0 || k === nv - 1 ? 1 : 2));
      if (r.kind !== RoadKind.Pedestrian) wide.set(q, Math.max(wide.get(q) ?? 0, r.width));
    }
  }
  const n = data.roads.length;
  // A two-way road carrying on as its two one-way carriageways (one in, one out, both ahead of it, as a
  // dual carriageway or a busway's split is mapped) is no junction either: no paths cross there.
  const ends = new Map<number, number[]>();
  data.roads.forEach((r, i) => {
    const nv = r.pts.length / 2;
    if (nv < 2) return;
    for (const e of [0, 1]) {
      const q = endKey(r.pts[e ? 2 * nv - 2 : 0], r.pts[e ? 2 * nv - 1 : 1]);
      if (deg.get(q) !== 3) continue;
      const l = ends.get(q);
      if (l) l.push(i, e);
      else ends.set(q, [i, e]);
    }
  });
  const split = new Set<number>();
  const splitOf = new Int32Array(2 * n).fill(-1);
  for (const [q, l] of ends) {
    if (l.length !== 6) continue;
    // Each road's direction away from the node.
    const away = (k: number): [number, number] => {
      const p = data.roads[l[k]].pts;
      const nv = p.length / 2;
      const [a, b] = l[k + 1] ? [nv - 1, nv - 2] : [0, 1];
      const dx = p[2 * b] - p[2 * a];
      const dy = p[2 * b + 1] - p[2 * a + 1];
      const d = Math.hypot(dx, dy) || 1;
      return [dx / d, dy / d];
    };
    const two = [0, 2, 4].filter((k) => !data.roads[l[k]].oneway);
    const one = [0, 2, 4].filter((k) => data.roads[l[k]].oneway);
    if (two.length !== 1 || one.length !== 2 || [0, 2, 4].some((k) => data.roads[l[k]].kind === RoadKind.Pedestrian)) continue;
    if (l[one[0] + 1] === l[one[1] + 1]) continue;
    const [tx, ty] = away(two[0]);
    if (
      !one.every((k) => {
        const [ux, uy] = away(k);
        return ux * tx + uy * ty < -OPP_DOT;
      })
    ) continue;
    split.add(q);
    for (const k of one) splitOf[2 * l[k] + l[k + 1]] = l[two[0]];
  }
  const turns = turnBoxes(data);
  const out: RoadNodes = { junctions: new Array(n), box: new Array(n), turn: new Array(n), deadStart: new Uint8Array(n), deadEnd: new Uint8Array(n), cum: new Array(n), split: splitOf };
  data.roads.forEach((r, i) => {
    const p = r.pts;
    const nv = p.length / 2;
    const cum = roadCum(r);
    out.cum[i] = cum;
    const js: number[] = [];
    const bs: number[] = [];
    const ts: number[] = [];
    for (let k = 0; k < nv; k++) {
      const q = endKey(p[2 * k], p[2 * k + 1]);
      if ((deg.get(q) ?? 0) < 3 || split.has(q)) continue;
      js.push(cum[k]);
      bs.push(Math.max(JUNCTION_BOX_MIN, Math.min(JUNCTION_BOX_MAX, (wide.get(q) ?? 0) / 2 + 2)));
      ts.push(turns.box.get(q) ?? 0);
    }
    out.junctions[i] = Float32Array.from(js);
    out.box[i] = Float32Array.from(bs);
    out.turn[i] = Float32Array.from(ts);
    if (nv >= 2) {
      out.deadStart[i] = (deg.get(endKey(p[0], p[1])) ?? 0) <= 1 ? 1 : 0;
      out.deadEnd[i] = (deg.get(endKey(p[2 * nv - 2], p[2 * nv - 1])) ?? 0) <= 1 ? 1 : 0;
    }
  });
  roadNodesCache.set(data, out);
  return out;
}

/**
 * Whether a lane at `along` on two-way road `ri` may leave its own half: inside a junction box, where
 * turning paths cross (with `turning`, the box a sharp turn there needs), or near a dead end, where the
 * route turns round. (A road that simply carries on as the next way is no junction.)
 */
function ownHalfFree(nodes: RoadNodes, ri: number, along: number, turning = false): boolean {
  const js = nodes.junctions[ri];
  const bs = nodes.box[ri];
  const ts = nodes.turn[ri];
  for (let q = 0; q < js.length; q++) if (Math.abs(js[q] - along) < (turning ? Math.max(bs[q], ts[q]) : bs[q])) return true;
  const cum = nodes.cum[ri];
  return (nodes.deadStart[ri] === 1 && along < 20) || (nodes.deadEnd[ri] === 1 && along > cum[cum.length - 1] - 20);
}

/**
 * The line between a lane's one-way carriageway (road ri) and the nearest one running against it on its
 * right within `reach` (a dual carriageway's or a busway's other half, mapped as its own way), the two
 * directions' centre line: how far along the normal (-ty, tx) from (x, y) it crosses (+ = left), NaN with
 * no such carriageway. (tx, ty) is the lane's way. Past the carriageway's end at a split, the two-way road
 * it carries on from is that line.
 */
function midlineAcross(data: MapData, nodes: RoadNodes, ri: number, x: number, y: number, z: number, tx: number, ty: number, reach = 12): number {
  const nxv = -ty;
  const nyv = tx;
  /** Where (x, y) + n t meets a + d u (d a unit direction): [t, u], or null nearly parallel. */
  const across = (ax: number, ay: number, dx: number, dy: number): [number, number] | null => {
    const det = dx * nyv - nxv * dy;
    if (Math.abs(det) < 0.5) return null;
    return [(dx * (ay - y) - dy * (ax - x)) / det, (nxv * (ay - y) - nyv * (ax - x)) / det];
  };
  const p = data.roads[ri].pts;
  const nv = p.length / 2;
  // Our carriageway: its nearest piece's line, on past its ends (as the lane's road centre is found).
  let own = NaN;
  let ownD = Infinity;
  let past = -1;
  const opp: number[] = [];
  roadIndexFor(data).forEachNear(x, y, reach, (rj, ax, ay, dx, dy, len, d, zz) => {
    if (Math.abs(zz - z) > LEVEL_GAP) return;
    if (rj === ri) {
      const c = across(ax, ay, dx, dy);
      if (!c || d >= ownD) return;
      ownD = d;
      own = c[0];
      const atStart = Math.abs(ax - p[0]) + Math.abs(ay - p[1]) < 0.05;
      const atEnd = Math.abs(ax + dx * len - p[2 * nv - 2]) + Math.abs(ay + dy * len - p[2 * nv - 1]) < 0.05;
      past = c[1] < 0 && atStart ? 0 : c[1] > len && atEnd ? 1 : -1;
      return;
    }
    const r = data.roads[rj];
    if (!r.oneway || r.kind === RoadKind.Pedestrian || dx * tx + dy * ty > -OPP_DOT) return;
    const c = across(ax, ay, dx, dy);
    if (c && c[1] >= -0.5 && c[1] <= len + 0.5 && Math.abs(c[0]) <= reach) opp.push(c[0]);
  });
  if (Number.isNaN(own)) return NaN;
  const two = past >= 0 ? nodes.split[2 * ri + past] : -1;
  if (two >= 0) {
    const q = data.roads[two].pts;
    let best = NaN;
    for (let k = 0; 2 * k + 3 < q.length; k++) {
      const ex = q[2 * k + 2] - q[2 * k];
      const ey = q[2 * k + 3] - q[2 * k + 1];
      const len = Math.hypot(ex, ey);
      if (len < 1e-3) continue;
      const c = across(q[2 * k], q[2 * k + 1], ex / len, ey / len);
      if (c && c[1] >= -0.5 && c[1] <= len + 0.5 && Math.abs(c[0]) <= reach && !(Math.abs(c[0]) >= Math.abs(best))) best = c[0];
    }
    return best;
  }
  let near = -Infinity;
  for (const t of opp) if (t <= own + 0.25 && t > near) near = t;
  return near > -Infinity ? (own + near) / 2 : NaN;
}

/**
 * The centre lines a junction box's samples keep their side of (TURN_ALONG): for each sample with free[k],
 * the segment nearest it of road[j] at the nearest sample j before it and after it, within reach samples, whose
 * own half is kept (own[j] >= 0, free[j] unset), facing the lane's way there. Per sample two lines
 * (x, y, dx, dy each; NaN where none) and how far left of them it keeps (by the turn the lane makes through
 * the box: from just before it to just after it).
 */
function turnLines(data: MapData, road: Int32Array, own: Int32Array, free: Uint8Array, X: ArrayLike<number>, Y: ArrayLike<number>, reach = 10): Float32Array {
  const n = road.length;
  const out = new Float32Array(10 * n).fill(NaN);
  const put = (k: number, slot: number, j: number): void => {
    const p = data.roads[road[j]].pts;
    // (Its segment nearest sample k: the road's own curve into the node.)
    let q = own[j];
    let best = Infinity;
    for (let g = 0; 2 * g + 3 < p.length; g++) {
      const gx = p[2 * g + 2] - p[2 * g];
      const gy = p[2 * g + 3] - p[2 * g + 1];
      const t = Math.max(0, Math.min(1, ((X[k] - p[2 * g]) * gx + (Y[k] - p[2 * g + 1]) * gy) / (gx * gx + gy * gy || 1e-9)));
      const d = Math.hypot(X[k] - p[2 * g] - gx * t, Y[k] - p[2 * g + 1] - gy * t);
      if (d < best) {
        best = d;
        q = g;
      }
    }
    let ex = p[2 * q + 2] - p[2 * q];
    let ey = p[2 * q + 3] - p[2 * q + 1];
    const el = Math.hypot(ex, ey);
    if (el < 1e-3) return;
    ex /= el;
    ey /= el;
    const a = Math.max(0, j - 1);
    const b = Math.min(n - 1, j + 1);
    if (ex * (X[b] - X[a]) + ey * (Y[b] - Y[a]) < 0) {
      ex = -ex;
      ey = -ey;
    }
    const o = 10 * k + 4 * slot;
    out[o] = p[2 * q];
    out[o + 1] = p[2 * q + 1];
    out[o + 2] = ex;
    out[o + 3] = ey;
  };
  const guarded = (j: number) => own[j] >= 0 && road[j] >= 0 && !free[j] && !data.roads[road[j]].oneway;
  const need = new Float32Array(n).fill(NaN);
  const along = new Float32Array(n).fill(NaN);
  for (let k0 = 0; k0 < n; ) {
    if (!free[k0]) {
      k0++;
      continue;
    }
    let k1 = k0;
    while (k1 + 1 < n && free[k1 + 1]) k1++;
    const a0 = Math.max(0, k0 - 3);
    const a1 = Math.max(a0 + 1, k0);
    const b0 = Math.min(n - 2, k1);
    const b1 = Math.min(n - 1, k1 + 3);
    const turn = wrapAngle(Math.atan2(X[b1] - X[b0], Y[b1] - Y[b0]) - Math.atan2(X[a1] - X[a0], Y[a1] - Y[a0]));
    const st = Math.abs(turn) <= TURN_STRAIGHT;
    need.fill(st ? OWN_MIN : turn < 0 ? TURN_LEFT_MIN : TURN_RIGHT_MIN, k0, k1 + 1);
    along.fill(Math.cos(st ? TURN_ALONG : turn < 0 ? TURN_LEFT_ALONG : TURN_RIGHT_ALONG), k0, k1 + 1);
    k0 = k1 + 1;
  }
  for (let k = 0; k < n; k++) {
    if (!free[k] || Number.isNaN(need[k])) continue;
    out[10 * k + 8] = need[k];
    out[10 * k + 9] = along[k];
    for (let j = k - 1; j >= Math.max(0, k - reach); j--) {
      if (!guarded(j)) continue;
      put(k, 0, j);
      break;
    }
    for (let j = k + 1; j <= Math.min(n - 1, k + reach); j++) {
      if (!guarded(j)) continue;
      put(k, 1, j);
      break;
    }
  }
  return out;
}

/**
 * How far left of sample k's turn lines (turnLines) (x, y) is, heading (ux, uy), beyond what it keeps of them
 * (negative: nearer them than that): Infinity where none binds.
 */
function turnSide(L: Float32Array, k: number, x: number, y: number, ux: number, uy: number): number {
  const cos = L[10 * k + 9];
  let lat = Infinity;
  for (let o = 10 * k; o < 10 * k + 8; o += 4) {
    if (Number.isNaN(L[o]) || L[o + 2] * ux + L[o + 3] * uy < cos) continue;
    lat = Math.min(lat, L[o + 2] * (y - L[o + 1]) - L[o + 3] * (x - L[o]) - L[10 * k + 8]);
  }
  return lat;
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

/** A narrow two-way road's kerb lane keeps up to LANE_NARROW from the centre line, LANE_NARROW_KERB off the kerb. */
const LANE_NARROW = 1.75;
const LANE_NARROW_KERB = 0.2;
const BUS_HALF = 1.25;
/**
 * A road's lane centre from its own centreline (+ = left of travel): the kerb lane. On a narrow two-way road
 * it keeps up to LANE_NARROW from the centre line where the bus stays LANE_NARROW_KERB off the kerb: two
 * buses passing there have a metre between them.
 */
function laneFromCentre(r: Road): number {
  const w = Math.max(3.2, r.width);
  if (r.oneway) return Math.max(0, w / 2 - 1.75);
  return Math.min(6, Math.max(1.6, w / 2 - 1.75, Math.min(LANE_NARROW, w / 2 - BUS_HALF - LANE_NARROW_KERB)));
}
/**
 * A road's right-hand lane centre from its centreline (+ = left of travel), NaN with one lane its way. On a
 * one-way road it is the traffic's offside lane (cars.ts): as many lanes as fit 2.7 m apart, packed from the
 * left kerb at most 3.2 m apart, the queue to turn right waiting in it; on a bus-only road, the kerb lane
 * mirrored.
 */
function rightLaneFromCentre(r: Road): number {
  if (r.oneway) {
    const n = Math.min(r.lanes, 1 + Math.floor((r.width - 3.2) / 2.7));
    if (n < 2) return NaN;
    if (r.bus) return -laneFromCentre(r);
    const outer = r.width / 2 - 1.6;
    return outer - (n - 1) * Math.min(3.2, (2 * outer) / (n - 1));
  }
  const per = Math.floor(r.lanes / 2);
  return per >= 2 && r.width >= 12 ? Math.max(OWN_MIN, r.width / 2 / per / 2) : NaN;
}
const vertexRoadsCache = new WeakMap<MapData, Map<number, number[]>>();
/** Every road vertex by endKey: [road, vertex, ...]. */
function vertexRoads(data: MapData): Map<number, number[]> {
  const hit = vertexRoadsCache.get(data);
  if (hit) return hit;
  const out = new Map<number, number[]>();
  data.roads.forEach((r, i) => {
    if (r.kind === RoadKind.Pedestrian) return;
    for (let k = 0; 2 * k + 1 < r.pts.length; k++) {
      const q = endKey(r.pts[2 * k], r.pts[2 * k + 1]);
      const l = out.get(q);
      if (l) l.push(i, k);
      else out.set(q, [i, k]);
    }
  });
  vertexRoadsCache.set(data, out);
  return out;
}
/**
 * Whether a road other than a and b leaves the node nearest (x, y) of road b's ends within TURN_FORK_ON of heading h
 * (and, given the route's way on, at least `apart` left of it).
 */
function forkAt(data: MapData, a: number, b: number, x: number, y: number, h: number, on = NaN, apart = 0): boolean {
  const p = data.roads[b].pts;
  const nv = p.length / 2;
  const e = Math.hypot(p[0] - x, p[1] - y) <= Math.hypot(p[2 * nv - 2] - x, p[2 * nv - 1] - y) ? 0 : nv - 1;
  const l = vertexRoads(data).get(endKey(p[2 * e], p[2 * e + 1]));
  if (!l) return false;
  for (let k = 0; k < l.length; k += 2) {
    const c = l[k];
    if (c === a || c === b) continue;
    const r = data.roads[c];
    const v = l[k + 1];
    const q = r.pts;
    const m = q.length / 2;
    const dirs: [number, number][] = [];
    if (v + 1 < m) dirs.push([q[2 * v + 2] - q[2 * v], q[2 * v + 3] - q[2 * v + 1]]);
    if (v > 0 && !r.oneway) dirs.push([q[2 * v - 2] - q[2 * v], q[2 * v - 1] - q[2 * v + 1]]);
    for (const [dx, dy] of dirs) {
      const hq = Math.atan2(dx, dy);
      if (Math.abs(wrapAngle(hq - h)) < TURN_FORK_ON && !(wrapAngle(hq - on) > -apart)) return true;
    }
  }
  return false;
}
/**
 * Road ri's heading at its end nearest (x, y): leaving the node there (`out`), or arriving at it; NaN where it
 * cannot be driven that way (a one-way road).
 */
function headingAtEnd(data: MapData, ri: number, x: number, y: number, out: boolean): number {
  const r = data.roads[ri];
  const p = r.pts;
  const nv = p.length / 2;
  if (nv < 2) return NaN;
  const atStart = Math.hypot(p[0] - x, p[1] - y) <= Math.hypot(p[2 * nv - 2] - x, p[2 * nv - 1] - y);
  // (Along the road's points: leaving its start, arriving at its end.)
  const along = atStart === out;
  if (!along && r.oneway) return NaN;
  const [a, b] = atStart ? [0, 1] : [nv - 1, nv - 2];
  const h = Math.atan2(p[2 * b] - p[2 * a], p[2 * b + 1] - p[2 * a + 1]);
  return out ? h : wrapAngle(h + Math.PI);
}
/** From a road's centreline to its left kerb (two-way roads at least a lane each way). */
function halfWidthLeft(r: Road): number {
  const w = Math.max(3.2, r.width);
  return r.oneway ? w / 2 : Math.max(w / 2, 3.2);
}

/**
 * Least squares over the free points of a window of lane samples a..a+m-1: minimise the sum of
 * rows' w * (sum of cx * x + cy * y over the row's samples - c)^2, where a row names samples by their
 * index in the window and samples not in `free` stay where they are (X, Y). The free points' solved
 * coordinates come back interleaved (x0, y0, x1, y1, ...). Rows span at most three neighbouring
 * samples, so the system is banded and solved directly.
 */
interface LsqRow {
  w: number;
  k: number[];
  cx: number[];
  cy: number[];
  c: number;
}
function solveRows(X: Float32Array, Y: Float32Array, a: number, m: number, free: number[], rows: LsqRow[]): Float64Array {
  const f = free.length;
  const N = 2 * f;
  const at = new Int32Array(m).fill(-1);
  free.forEach((k, j) => (at[k] = j));
  const M = new Float64Array(N * N);
  const r = new Float64Array(N);
  const idx: number[] = [];
  const co: number[] = [];
  for (const row of rows) {
    let c0 = row.c;
    idx.length = 0;
    co.length = 0;
    for (let q = 0; q < row.k.length; q++) {
      const k = row.k[q];
      const u = at[k];
      if (u < 0) {
        c0 -= row.cx[q] * X[a + k] + row.cy[q] * Y[a + k];
        continue;
      }
      if (row.cx[q]) {
        idx.push(2 * u);
        co.push(row.cx[q]);
      }
      if (row.cy[q]) {
        idx.push(2 * u + 1);
        co.push(row.cy[q]);
      }
    }
    for (let p = 0; p < idx.length; p++) {
      r[idx[p]] += row.w * co[p] * c0;
      for (let q = 0; q < idx.length; q++) M[idx[p] * N + idx[q]] += row.w * co[p] * co[q];
    }
  }
  // Gaussian elimination within the band (symmetric positive definite: no pivoting, no fill outside it).
  const BW = 7;
  for (let c = 0; c < N; c++) {
    const d = M[c * N + c] || 1e-9;
    const e = Math.min(N - 1, c + BW);
    for (let row = c + 1; row <= e; row++) {
      const g = M[row * N + c] / d;
      if (!g) continue;
      for (let k = c; k <= e; k++) M[row * N + k] -= g * M[c * N + k];
      r[row] -= g * r[c];
    }
  }
  const x = new Float64Array(N);
  for (let c = N - 1; c >= 0; c--) {
    let v = r[c];
    const e = Math.min(N - 1, c + BW);
    for (let k = c + 1; k <= e; k++) v -= M[c * N + k] * x[k];
    x[c] = v / (M[c * N + c] || 1e-9);
  }
  return x;
}

/** Signals spatial hash shared by all tracks. */
const signalGrids = new WeakMap<MapData, Map<number, number[]>>();
function signalGrid(data: MapData): Map<number, number[]> {
  let g = signalGrids.get(data);
  if (!g) {
    g = new Map();
    const s = data.signals;
    for (let i = 0; i < s.length; i += 2) {
      // (signals on paths and cycleways only control no road traffic: src/data/signals.ts)
      if (data.signalRoad && data.signalRoad[i / 2] < 0) continue;
      const key = (Math.floor(s[i] / 40) + 1000) * 4096 + Math.floor(s[i + 1] / 40) + 1000;
      let a = g.get(key);
      if (!a) g.set(key, (a = []));
      a.push(i / 2);
    }
    signalGrids.set(data, g);
  }
  return g;
}

/**
 * Signal nodes grouped into junctions the way the world groups them for its
 * heads, stop lines and phases (nodes within 28 m chain together; the
 * junction is at their centroid).
 */
interface SignalJunctions {
  /** Junction of each signal node. */
  id: Int32Array;
  cx: Float32Array;
  cy: Float32Array;
  /** Stop line distance back from the centre (NaN until asked). */
  ds: Float32Array;
}
const signalJunctionCache = new WeakMap<MapData, SignalJunctions>();
function signalJunctions(data: MapData): SignalJunctions {
  let J = signalJunctionCache.get(data);
  if (J) return J;
  const sig = data.signals;
  const ns = sig.length >> 1;
  const parent = new Int32Array(ns).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const grid = signalGrid(data);
  for (let i = 0; i < ns; i++) {
    const gx = Math.floor(sig[2 * i] / 40) + 1000;
    const gy = Math.floor(sig[2 * i + 1] / 40) + 1000;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const j of grid.get((gx + ox) * 4096 + gy + oy) ?? []) {
          if (j <= i) continue;
          if (Math.hypot(sig[2 * j] - sig[2 * i], sig[2 * j + 1] - sig[2 * i + 1]) < 28) parent[find(j)] = find(i);
        }
      }
    }
  }
  const root = new Map<number, number>();
  const id = new Int32Array(ns);
  const sx: number[] = [];
  const sy: number[] = [];
  const cnt: number[] = [];
  for (let i = 0; i < ns; i++) {
    const r = find(i);
    let j = root.get(r);
    if (j === undefined) {
      j = sx.length;
      root.set(r, j);
      sx.push(0);
      sy.push(0);
      cnt.push(0);
    }
    id[i] = j;
    sx[j] += sig[2 * i];
    sy[j] += sig[2 * i + 1];
    cnt[j]++;
  }
  J = {
    id,
    cx: Float32Array.from(sx, (v, j) => v / cnt[j]),
    cy: Float32Array.from(sy, (v, j) => v / cnt[j]),
    ds: new Float32Array(sx.length).fill(NaN),
  };
  signalJunctionCache.set(data, J);
  return J;
}
/** Road ends (rounded to 0.1 m) and the roads ending there, per map. */
const roadEnds = new WeakMap<MapData, Map<number, number[]>>();
const endKey = (x: number, y: number) => Math.round(x * 10) * 1048576 + Math.round(y * 10);
/**
 * How far from road ri's start (end = 0) or end (end = 1) the nearest junction
 * (three or more roads meeting) is, following plain continuations (two roads
 * meeting) up to `max` metres; Infinity if none.
 */
function junctionBeyond(data: MapData, ri: number, end: 0 | 1, max: number): number {
  let m = roadEnds.get(data);
  if (!m) {
    m = new Map();
    data.roads.forEach((r, k) => {
      const p = r.pts;
      if (p.length < 4) return;
      for (const q of [endKey(p[0], p[1]), endKey(p[p.length - 2], p[p.length - 1])]) {
        const l = m!.get(q);
        if (l) l.push(k);
        else m!.set(q, [k]);
      }
    });
    roadEnds.set(data, m);
  }
  let dist = 0;
  let r = ri;
  let e = end;
  for (let hop = 0; hop < 8; hop++) {
    const p = data.roads[r].pts;
    const q = e ? endKey(p[p.length - 2], p[p.length - 1]) : endKey(p[0], p[1]);
    const at = m.get(q) ?? [];
    if (at.length >= 3) return dist;
    const next = at.find((k) => k !== r);
    if (next === undefined) return Infinity;
    const np = data.roads[next].pts;
    const cum = roadCum(data.roads[next]);
    dist += cum[cum.length - 1];
    if (dist > max) return Infinity;
    // (Carry on out of the far end of the next road.)
    e = endKey(np[0], np[1]) === q ? 1 : 0;
    r = next;
  }
  return Infinity;
}
/** Junction j's stop line distance back from its centre: the widest road at its level within 24 m, half of it + 2.5 m. */
function junctionStop(data: MapData, J: SignalJunctions, j: number): number {
  if (!Number.isNaN(J.ds[j])) return J.ds[j];
  const idx = roadIndexFor(data);
  const cx = J.cx[j];
  const cy = J.cy[j];
  // The junction's level: the street nearest its centre.
  let nd = Infinity;
  let level = 0;
  idx.forEachNear(cx, cy, 30, (ri, _ax, _ay, _ux, _uy, _len, d, zz) => {
    if (!data.roads[ri].tunnel && d < nd) {
      nd = d;
      level = zz;
    }
  });
  let hw = 0;
  idx.forEachNear(cx, cy, 24, (ri, _ax, _ay, _ux, _uy, _len, _d, zz) => {
    const r = data.roads[ri];
    if (r.tunnel || r.kind === RoadKind.Pedestrian || Math.abs(zz - level) > 3) return;
    hw = Math.max(hw, r.width / 2);
  });
  J.ds[j] = Math.max(6, Math.min(22, hw + 2.5));
  return J.ds[j];
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
  /** Samples held in a turn lane (the corner solve keeps them there). */
  private turnHeld: Uint8Array;

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
    /** Where along the route (from the sample) each end in wallPos is. */
    const wallAl: number[] = [];
    const wallSeen = W ? new Int32Array(W.count) : new Int32Array(0);
    const cands: RoadCand[][] = [];
    // Where the GTFS shape turns sharply (and SHAPE_SHARP_SPAN either side): one-way bus ramps cutting
    // across are looked for further there.
    const rampNear = new Uint8Array(n);
    {
      const hd = (s0: number, s1: number) => {
        const a = pointAlong(route.pts, route.cum, s0);
        const b = pointAlong(route.pts, route.cum, s1);
        return Math.atan2(b.x - a.x, b.y - a.y);
      };
      const span = Math.round(SHAPE_SHARP_SPAN / TRACK_STEP);
      for (let i = 0; i < n; i++) {
        const s = Math.min(L, i * TRACK_STEP);
        if (Math.abs(wrapAngle(hd(s + 5, s + 25) - hd(s - 25, s - 5))) < SHAPE_SHARP) continue;
        for (let k = Math.max(0, i - span); k <= Math.min(n - 1, i + span); k++) rampNear[k] = 1;
      }
    }
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
      let list = roadCands(data, p.x, p.y, zr, gdx, gdy, dx, dy, 14, 0.5, drivable, 22, rampNear[i] === 1);
      if (!list.length) list = roadCands(data, p.x, p.y, zr, gdx, gdy, dx, dy, 32, 0.6, walledRoad);
      cands.push(list);
    }
    // The road at each sample, matched along the whole route.
    // (Alongside a platform: the road along its edge.)
    const zones = route.stops.map((_, k) => matchStopPlatform(data, route, k));
    for (const z of zones) {
      if (!z) continue;
      for (let i = Math.max(0, Math.ceil(z.s0 / TRACK_STEP)); i <= Math.min(n - 1, Math.floor(z.s1 / TRACK_STEP)); i++) {
        const list = cands[i];
        if (list.length < 2) continue;
        const e = z.edge[Math.max(0, Math.min(z.edge.length - 1, Math.round((i * TRACK_STEP - z.s0) / z.step)))];
        const gap = list.map((c) => {
          const dC = (c.px - bx[i]) * nx[i] + (c.py - by[i]) * ny[i];
          return dC < e ? Math.abs(dC + halfWidthLeft(data.roads[c.road]) - e) : Infinity;
        });
        const best = Math.min(...gap);
        if (!Number.isFinite(best)) continue;
        list.forEach((c, q) => {
          if (gap[q] > best + PLATFORM_KERB_GAP) c.cost += PLATFORM_MATCH;
        });
      }
    }
    const picks = matchRoads(data, cands);
    // The lane's height: the matched road's own (the GTFS line's heights can be the median's or a
    // neighbouring carriageway's, up to ~0.7 m off), kept within a metre of the route's level.
    {
      const dz = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const c = picks[i];
        dz[i] = c ? Math.max(-1, Math.min(1, c.z - this.z[i])) : 0;
      }
      const dzS = boxSmooth(median7(dz), 1);
      for (let i = 0; i < n; i++) this.z[i] += dzS[i];
    }
    for (let i = 0; i < n; i++) {
      const p = { x: bx[i], y: by[i] };
      const dx = ny[i];
      const dy = -nx[i];
      const zr = this.z[i];
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
              const aa = a0 + da * u0;
              const ab = a0 + da * u1;
              if (la <= lb) wallAl.push(aa, ab);
              else wallAl.push(ab, aa);
            }
          }
        }
      }
    }
    wallStart[n] = wallPos.length;
    /** The matched road's lane offset from its own centreline (+ = left). */
    const fromC = new Float32Array(n);
    /** How square our normal crosses the matched road (a sideways metre along it is cosR across the road). */
    const cosR = new Float32Array(n).fill(1);
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
      cosR[i] = Math.max(0.5, Math.abs(cosN));
      fromC[i] = laneFromCentre(road);
      roadC[i] = dC;
      kerbBase[i] = dC + halfWidthLeft(road);
      known[i] = 1;
      this.limit[i] = speedLimitOf(road);
      this.road[i] = c.road;
    }
    /** The last sample of each turn lane held to its turn's node. */
    const heldTo: number[] = [];
    this.turnHeld = new Uint8Array(n);
    // The turn lane before a right turn (TURN_LANE_MIN): where the matched road changes and the route turns
    // right there off a straight approach (not round a roundabout's ring), the samples before it on roads
    // with a right-hand lane of their own take it, eased in from the kerb lane (and not before a stop made
    // there: only past it, if there is room).
    {
      const hd = (s0: number, s1: number) => {
        const a = pointAlong(route.pts, route.cum, s0);
        const b = pointAlong(route.pts, route.cum, s1);
        return Math.atan2(b.x - a.x, b.y - a.y);
      };
      const stopS = route.stops.map((st) => st.s);
      const target = new Float32Array(n).fill(NaN);
      const weight = new Float32Array(n);
      for (let j = 1; j < n; j++) {
        const a = picks[j - 1];
        const b = picks[j];
        if (!a || !b || a.road === b.road) continue;
        const sj = j * TRACK_STEP;
        if (sj < 40 || sj > L - 30) continue;
        const turn = wrapAngle(hd(sj + 5, sj + 30) - hd(sj - 30, sj - 5));
        if (turn < -TURN_SPLIT_SLACK || Math.abs(wrapAngle(hd(sj - 30, sj - 8) - hd(sj - 60, sj - 30))) > 0.3) continue;
        // (Bearing right, only at a fork; gently, by the roads themselves, only at a split.)
        const h0 = hd(sj - 30, sj - 5);
        if (turn < TURN_FORK_MIN) {
          const ha = headingAtEnd(data, a.road, bx[j], by[j], false);
          const hb = headingAtEnd(data, b.road, bx[j], by[j], true);
          if (!(wrapAngle(hb - ha) >= TURN_BEAR_MIN && wrapAngle(hb - ha) < TURN_FORK_MIN)) continue;
          if (!forkAt(data, a.road, b.road, bx[j], by[j], ha, hb, TURN_BEAR_APART)) continue;
        } else if (turn < TURN_LANE_MIN && !forkAt(data, a.road, b.road, bx[j], by[j], h0)) continue;
        // (Back from the turn while the road has a right-hand lane: hold, then ease.)
        const lastStop = Math.max(-Infinity, ...stopS.filter((q) => q < sj + 5));
        const ks: number[] = [];
        const ws: number[] = [];
        const ts: number[] = [];
        let held = 0;
        let short = false;
        for (let k = j - 1; k >= 0; k--) {
          const c = picks[k];
          const r = c ? data.roads[c.road] : null;
          const rl = r ? rightLaneFromCentre(r) : NaN;
          const back = sj - k * TRACK_STEP;
          if (!r || Number.isNaN(rl)) {
            short = back <= TURN_LANE_HOLD;
            break;
          }
          const ease = (laneFromCentre(r) - rl) / 3.5 * TURN_LANE_EASE;
          if (back > TURN_LANE_HOLD + ease) break;
          // (A stop made on the way: the lane is at the kerb for it.)
          if (k * TRACK_STEP < lastStop + 10) break;
          const w = back <= TURN_LANE_HOLD ? 1 : 1 - (back - TURN_LANE_HOLD) / ease;
          ks.push(k);
          ws.push(w);
          ts.push(rl);
          if (w === 1) held++;
        }
        // (Too short to wait in: a roundabout's ring, a slip road between two nodes.)
        if (short && held * TRACK_STEP < TURN_LANE_HELD) continue;
        ks.forEach((k, q) => {
          if (ws[q] > weight[k]) {
            weight[k] = ws[q];
            target[k] = ts[q];
          }
        });
      }
      for (let i = 0; i < n; i++) if (weight[i] > 0 && known[i]) fromC[i] = fromC[i] + (target[i] - fromC[i]) * smooth01(weight[i]);
      for (let i = 0; i < n; i++) if (weight[i] === 1 && known[i]) this.turnHeld[i] = 1;
      for (let j = 1; j < n; j++) if (weight[j - 1] === 1 && known[j - 1] && !(weight[j] === 1 && known[j])) heldTo.push(j - 1);
    }
    // Fill unknown samples by interpolating between known neighbours.
    let lastKnown = -1;
    for (let i = 0; i <= n; i++) {
      if (i < n && !known[i]) continue;
      const a = lastKnown;
      const b = i < n ? i : -1;
      const ca = a >= 0 ? roadC[a] : b >= 0 ? roadC[b] : 0;
      const cb = b >= 0 ? roadC[b] : ca;
      const fa = a >= 0 ? fromC[a] : b >= 0 ? fromC[b] : 1.75;
      const fb = b >= 0 ? fromC[b] : fa;
      const ka = a >= 0 ? kerbBase[a] : b >= 0 ? kerbBase[b] : 3.6;
      const kb = b >= 0 ? kerbBase[b] : ka;
      const la = a >= 0 ? this.limit[a] : b >= 0 ? this.limit[b] : 50;
      for (let j = a + 1; j < (b >= 0 ? b : n); j++) {
        const f = b > a ? (j - a) / (b - a) : 0;
        roadC[j] = ca + (cb - ca) * f;
        fromC[j] = fa + (fb - fa) * f;
        kerbBase[j] = ka + (kb - ka) * f;
        this.limit[j] = la;
      }
      lastKnown = i;
    }
    // Past the node of a right turn from its turn lane, the lane carries on along that lane's line until it
    // meets the lane of the road turned into, where that starts left of it (a road mapped from the centreline
    // between carriageways, a busway link off a dual carriageway's offside lane): turning back towards the
    // centreline first, the lane would swing across the lanes beside it before turning.
    const unsmoothed = new Uint8Array(n);
    for (const k0 of heldTo) {
      const c = picks[k0];
      if (!c) continue;
      const o0 = roadC[k0] + fromC[k0];
      const px = bx[k0] + nx[k0] * o0;
      const py = by[k0] + ny[k0] * o0;
      const sg = c.dx * ny[k0] - c.dy * nx[k0] >= 0 ? 1 : -1;
      const ddx = c.dx * sg;
      const ddy = c.dy * sg;
      let end = -1;
      for (let k = k0 + 1; k < Math.min(n, k0 + 1 + TURN_CARRY); k++) {
        const den = nx[k] * ddy - ny[k] * ddx;
        if (Math.abs(den) < 0.5) break;
        const oA = ((px - bx[k]) * ddy - (py - by[k]) * ddx) / den;
        if (!(oA < roadC[k] + fromC[k])) break;
        fromC[k] = oA - roadC[k];
        end = k;
      }
      if (end < 0) continue;
      // (Unsmoothed there and just before: smoothing would round off the corner it makes.)
      unsmoothed.fill(1, Math.max(0, k0 - 3), end + 1);
    }
    // The lane is the matched road's own lane: where the road is (exactly: a GTFS shape that wanders
    // 10 m off a curving tunnel must not drag the lane across the centreline), plus the road's lane
    // offset, eased where that changes (a one-way ramp off a two-way busway). Only jumps in where the
    // road is (onto a carriageway that does not continue the last one, gaps in the match) are eased.
    const fS = boxSmooth(median7(fromC), 3);
    const cS = Float32Array.from(roadC);
    {
      const jump = new Uint8Array(n);
      for (let i = 1; i < n; i++) {
        const d = Math.abs(roadC[i] - roadC[i - 1]);
        if (d > 1.2 && (!known[i] || !known[i - 1] || this.road[i] !== this.road[i - 1])) {
          for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 2); j++) jump[j] = 1;
        }
      }
      for (let pass = 0; pass < 3; pass++) {
        const sm = boxSmooth(cS, 2);
        for (let i = 0; i < n; i++) if (jump[i]) cS[i] = sm[i];
      }
    }
    for (let i = 0; i < n; i++) if (unsmoothed[i]) fS[i] = roadC[i] + fromC[i] - cS[i];
    const kS = boxSmooth(median7(kerbBase), 3);
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.offset = new Float32Array(n);
    this.kerb = new Float32Array(n);
    // Samples matched to a road (or between matched ones) follow it however far the GTFS line is off;
    // elsewhere the lane keeps near the line.
    const near = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (known[i]) for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) near[j] = 1;
    for (let i = 0; i < n; i++) {
      const t = cS[i] + fS[i];
      const off = near[i] ? Math.max(-24, Math.min(24, t)) : Math.max(-3, Math.min(8, t));
      this.offset[i] = off;
      this.kerb[i] = Math.max(1.3, Math.min(6, kS[i] - off));
    }
    // The lane's own carriageway (before platform lead-ins): the walls either side of it bound the lane.
    const home = Float32Array.from(this.offset);
    const lo = new Float32Array(n).fill(-Infinity);
    const hi = new Float32Array(n).fill(Infinity);
    // Busway platforms: the lane hugs the platform edge so buses pull right alongside.
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
      // Before and after the platform the lane eases from the road lane to the platform line carried on
      // from the platform's end; where that would put the bus off the carriageway (the road bends away
      // from the route line at a split, and the eased lane cuts across the gore) it eases by the shift
      // from the road lane instead, carried along the road lane.
      const homeAt = (s: number) => home[Math.max(0, Math.min(n - 1, Math.round(s / TRACK_STEP)))];
      const pullIn = edgeAt(z.s0) - PLATFORM_LANE - homeAt(z.s0);
      const pullOut = edgeAt(z.s1) - PLATFORM_LANE - homeAt(z.s1);
      const offPaved = (i: number, o: number) => {
        let worst = -Infinity;
        for (const side of [-1.25, 0, 1.25]) {
          const q = H.surfaceAt(bx[i] + nx[i] * (o + side), by[i] + ny[i] * (o + side), this.z[i]);
          worst = Math.max(worst, q.road < 0 ? Infinity : q.edge);
        }
        return worst > 0.3;
      };
      // The pull-in eases over [inS, inS + inL], from the road lane. Where walls between the road lane and
      // the platform line hold the lane off it (a viaduct's parapet running on to the platform's end), it
      // starts only PULL_CLEAR past them, easing over the platform's first metres instead, and from the
      // line the walls held the lane on, carried on straight (stepping back to the road lane first and
      // then pulling in makes an S-bend at the walls' end that a trailer cuts into).
      let inS = z.s0 - lead - 5;
      let inL = lead;
      let ih = -1;
      let from: Float32Array | null = null;
      {
        const iEnd = Math.min(n - 1, Math.floor(Math.min(z.s1, z.s0 + PULL_INTO) / TRACK_STEP));
        // Where the walls leave the lane at sample i, if they hold it more than PULL_HOLD off the platform
        // line (nearer, the bus is still alongside); NaN where they do not.
        const heldAt = (i: number) => {
          const h = home[i];
          const t = edgeAt(i * TRACK_STEP) - PLATFORM_LANE;
          let o = NaN;
          for (let k = wallStart[i]; k < wallStart[i + 1]; k += 2) {
            const a = wallPos[k];
            const b = wallPos[k + 1];
            if (t > h && b > h && a < t + WALL_CLEAR - PULL_HOLD) o = Math.min(Number.isNaN(o) ? h : o, a - WALL_CLEAR);
            if (t < h && a < h && b > t - WALL_CLEAR + PULL_HOLD) o = Math.max(Number.isNaN(o) ? h : o, b + WALL_CLEAR);
          }
          return o;
        };
        for (let i = iEnd; i >= i0 && ih < 0; i--) if (!Number.isNaN(heldAt(i))) ih = i;
        const free = ih < 0 ? -Infinity : (ih + 0.5) * TRACK_STEP + PULL_CLEAR;
        // (Shorter to end within PULL_INTO of the platform's start, down to ~1 m sideways per 3.5 m.)
        const len = Math.max(20, shift * 3.5, Math.min(lead, z.s0 + PULL_INTO - free));
        // (Not where the walls run on along the platform, or leave no room for a bus alongside after.)
        if (free > inS && ih < iEnd - 1 && free + len < z.s1 - 25) {
          inS = free;
          inL = len;
          // The held line: through where the walls held the lane at ih and a few samples before.
          const k0 = Math.max(0, ih - 3);
          const oh = heldAt(ih);
          const ok0 = heldAt(k0);
          const px = bx[ih] + nx[ih] * oh;
          const py = by[ih] + ny[ih] * oh;
          let dx = ny[ih];
          let dy = -nx[ih];
          if (k0 < ih && !Number.isNaN(ok0)) {
            dx = px - bx[k0] - nx[k0] * ok0;
            dy = py - by[k0] - ny[k0] * ok0;
          }
          const dl = Math.hypot(dx, dy) || 1;
          dx /= dl;
          dy /= dl;
          const jEnd = Math.min(n - 1, Math.ceil((inS + inL) / TRACK_STEP));
          from = new Float32Array(Math.max(0, jEnd - ih));
          for (let j = ih + 1; j <= jEnd && from; j++) {
            // (base_j + n_j o on the line p + d u)
            const den = nx[j] * dy - ny[j] * dx;
            const o = ((px - bx[j]) * dy - (py - by[j]) * dx) / (den || 1e-9);
            if (Math.abs(den) < 0.5 || offPaved(j, o)) from = null;
            else from[j - ih - 1] = o;
          }
        }
      }
      for (let i = i0; i <= i1; i++) {
        const s = i * TRACK_STEP;
        const w = s < inS + inL ? smooth01((s - inS) / inL) : s > z.s1 ? 1 - smooth01((s - z.s1) / tail) : 1;
        const f = from && i > ih && i - ih - 1 < from.length ? from[i - ih - 1] : NaN;
        if (w <= 0 && Number.isNaN(f)) continue;
        if (s > z.s0 - 8 && s < z.s1 + 8) skew[i] |= 2; // (alongside the platform: the lane's shift from the road is meant)
        if (s >= z.s0 && s <= z.s1 && w >= 1) skew[i] |= 4;
        else skew[i] |= 8; // (pulling in or out)
        const kerbNow = this.kerb[i] + this.offset[i];
        if (!Number.isNaN(f)) this.offset[i] = f;
        let want = edgeAt(s) - PLATFORM_LANE;
        if (s < z.s0 || s > z.s1) {
          const alt = home[i] + (s < z.s0 ? pullIn : pullOut);
          const cur = this.offset[i];
          if (offPaved(i, cur + (want - cur) * w) && !offPaved(i, cur + (alt - cur) * w)) want = alt;
        }
        this.offset[i] += (want - this.offset[i]) * w;
        this.kerb[i] += (Math.max(PLATFORM_LANE, kerbNow - this.offset[i]) - this.kerb[i]) * (Number.isNaN(f) ? w : 1);
        if (s >= z.s0 && s <= z.s1 && w >= 1) this.kerb[i] = PLATFORM_LANE;
      }
    }
    // Platforms passed without stopping (PLATFORM_APART): outside the lane's own platform zones and their
    // lead-ins, eased in and out as a pull-in is.
    {
      const geoms = platformGeoms(data);
      const offPaved = (i: number, o: number) => {
        let worst = -Infinity;
        for (const side of [-1.25, 0, 1.25]) {
          const q = H.surfaceAt(bx[i] + nx[i] * (o + side), by[i] + ny[i] * (o + side), this.z[i]);
          worst = Math.max(worst, q.road < 0 ? Infinity : q.edge);
        }
        return worst > 0.3;
      };
      const shift = new Float32Array(n).fill(NaN);
      for (let i = 0; i < n; i++) {
        if (skew[i] & 14) continue;
        const o = this.offset[i];
        const px = bx[i] + nx[i] * o;
        const py = by[i] + ny[i] * o;
        let d = Infinity;
        for (const g of geoms) {
          if (px < g.x0 - 8 || px > g.x1 + 8 || py < g.y0 - 8 || py > g.y1 + 8) continue;
          const pl = g.plane;
          if (Math.abs(pl.z0 + pl.slope * ((px - pl.px) * pl.tx + (py - pl.py) * pl.ty) - this.z[i]) > LEVEL_GAP) continue;
          d = Math.min(d, platformEdgeAt(data, g.index, px, py, nx[i], ny[i], 8));
        }
        if (d >= PLATFORM_LANE + PLATFORM_APART) continue;
        // (Over halfway out where the next lane has no room: as near as it is.)
        const out = d - PLATFORM_LANE - PLATFORM_APART;
        if (d <= PLATFORM_LANE + PLATFORM_APART / 2) shift[i] = d - PLATFORM_LANE;
        else if (!offPaved(i, o + out)) shift[i] = out;
      }
      // (Each run alongside, gaps of a sample or two bridged, eased in before and out after.)
      const move = new Float32Array(n);
      const wgt = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        if (Number.isNaN(shift[i])) continue;
        let b = i;
        while (b + 1 < n && (!Number.isNaN(shift[b + 1]) || (b + 2 < n && !Number.isNaN(shift[b + 2]) && !(skew[b + 1] & 14)))) b++;
        for (let k = i; k <= b; k++) {
          if (Number.isNaN(shift[k])) shift[k] = shift[k - 1];
          move[k] = shift[k];
          wgt[k] = 1;
          skew[k] |= 2;
        }
        for (const [e, dir] of [[i, -1], [b, 1]] as const) {
          const lead = Math.max(20, Math.abs(shift[e]) * 5);
          for (let k = e + dir, t = 1; k >= 0 && k < n && t * TRACK_STEP < lead; k += dir, t++) {
            if (skew[k] & 14 && !wgt[k]) break;
            const w = 1 - smooth01((t * TRACK_STEP) / lead);
            if (w <= wgt[k]) continue;
            move[k] = shift[e];
            wgt[k] = w;
          }
        }
        i = b;
      }
      for (let i = 0; i < n; i++) {
        if (!wgt[i]) continue;
        if (wgt[i] < 1) skew[i] |= 10;
        this.offset[i] += move[i] * wgt[i];
      }
    }
    // The gap between walls the lane runs in: the one around its road lane where a bus fits and can
    // drive (a carriageway or station bay: platform bays are open in the collider), else the nearest
    // such gap, staying on the side chosen just before; where none fits (a junction hall, a tight
    // turnaround), the middle of the gap the carriageway is in.
    // (Measured straight across the GTFS normal, each wall piece over the strip a sample stands for; and
    // `skewed`, in the frame of the lane's road lane, which runs at a slope to the normal's where the shape
    // is skewed to the road: there a parapet beside the lane spans the sideways change over the strip,
    // and across the normal bounds the lane by its nearest end. The lane keeps the first, with room to
    // spare where the shape is skewed, but may use the second to keep its own half.)
    const spans: [number, number][] = [];
    const band = (skewed: boolean, lo: Float32Array, hi: Float32Array): void => {
      let prev = NaN;
      for (let i = 0; i < n; i++) {
        const h = home[i];
        // Sideways spans blocked by walls here, merged where they overlap.
        const ia = Math.max(0, i - 1);
        const ib = Math.min(n - 1, i + 1);
        const slope = skewed && ib > ia ? Math.max(-BAND_SKEW, Math.min(BAND_SKEW, (home[ib] - home[ia]) / ((ib - ia) * TRACK_STEP))) : 0;
        const clear = WALL_CLEAR * Math.sqrt(1 + slope * slope);
        spans.length = 0;
        for (let k = wallStart[i]; k < wallStart[i + 1]; k += 2) {
          const a = wallPos[k] - wallAl[k] * slope;
          const b = wallPos[k + 1] - wallAl[k + 1] * slope;
          spans.push(a <= b ? [a, b] : [b, a]);
        }
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
        const gapLo = (g: number) => (g > 0 ? obHi[g - 1] + clear : -Infinity);
        const gapHi = (g: number) => (g < obLo.length ? obLo[g] - clear : Infinity);
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
          const half = Math.max(0, (b - a) / 2 - clear);
          lo[i] = m - half;
          hi[i] = m + half;
        }
        if (Math.max(lo[i] - h, h - hi[i], 0) > BAND_REACH) {
          lo[i] = -Infinity;
          hi[i] = Infinity;
          prev = NaN;
          continue;
        }
        prev = Math.max(lo[i], Math.min(hi[i], h));
      }
    };
    band(false, lo, hi);
    const loS = new Float32Array(n).fill(-Infinity);
    const hiS = new Float32Array(n).fill(Infinity);
    band(true, loS, hiS);
    // On a two-way road (or a one-way carriageway beside the other direction's) the walls may narrow the
    // lane's room but not push it over the centre line while they leave room on its own side (outside
    // junction boxes and platform lead-ins).
    const floor = new Float32Array(n).fill(-Infinity);
    if (TW) {
      const nodes = roadNodes(data);
      for (let i = 0; i < n; i++) {
        const ri = this.road[i];
        if (!known[i] || ri < 0 || skew[i] & 14) continue;
        const r = data.roads[ri];
        if (!r.oneway && r.width < 6) continue;
        const cx = bx[i] + nx[i] * roadC[i];
        const cy = by[i] + ny[i] * roadC[i];
        const along = projectOnRoad(r, nodes.cum[ri], cx, cy);
        if (ownHalfFree(nodes, ri, along)) continue;
        // (Our normal's metres, across the road at a skew.)
        const own = Math.min(OWN_MIN, fromC[i]) / cosR[i];
        if (!r.oneway) floor[i] = roadC[i] + own;
        else {
          // A one-way carriageway keeps as far from the centre line between it and the other direction's.
          const mid = midlineAcross(data, nodes, ri, cx, cy, this.z[i], ny[i], -nx[i]);
          if (!Number.isNaN(mid)) floor[i] = roadC[i] + mid + own;
        }
      }
    }
    this.keepInside(lo, hi, home, skew, floor, hiS);
    this.bandLo = lo;
    this.bandHi = hi;
    for (let i = 0; i < n; i++) {
      this.x[i] = bx[i] + nx[i] * this.offset[i];
      this.y[i] = by[i] + ny[i] * this.offset[i];
    }
    if (TW && WG) {
      this.fitToRoads(TW, WG, roadC, skew, picks);
      this.nudgeOffBuildings(TW);
      this.nudgeOffWalls(TW, WG);
      this.nudgeForTrailers(TW, WG);
    }
    // Sweep corners a bus can drive. Alongside a platform the lane stays on the platform line, except at
    // its ends, where it may ease in later and out sooner.
    const fixed = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!(skew[i] & 4)) continue;
      let b = i;
      while (b + 1 < n && skew[b + 1] & 4) b++;
      for (let k = i + 2; k <= b - 2; k++) fixed[k] = 1;
      i = b;
    }
    this.regularize(TW, WG, fixed, data, skew);
    if (TW && WG) {
      // (Smoothing can bring a trailer's sweep back to a wall at a tunnel throat.)
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
    // The kerb from the lane as it finally runs, and the platform zones trimmed to where it runs alongside.
    this.fitKerb(data, zones);
    this.fillLimits(data, zones);
    // Speed profile: curvature, posted limits, then braking pass.
    // (Over the lane's own length: through a station hall or round the outside of a bend a sample's 4 m of
    // route can be twice that of lane, and on the inside much less.)
    const chord = new Float32Array(n);
    for (let i = 0; i + 1 < n; i++) chord[i] = Math.hypot(this.x[i + 1] - this.x[i], this.y[i + 1] - this.y[i]);
    const kappa = new Float32Array(n);
    // (And over 8 m, so a short bend is taken no faster than a long one as tight rather than averaged away.)
    const kappa8 = new Float32Array(n);
    for (let i = 1; i < n - 1; i++) {
      if (i >= 2 && i < n - 2) {
        const h0 = Math.atan2(this.tx[i - 2], this.ty[i - 2]);
        const h1 = Math.atan2(this.tx[i + 2], this.ty[i + 2]);
        const len = chord[i - 2] + chord[i - 1] + chord[i] + chord[i + 1];
        kappa[i] = Math.abs(wrapAngle(h1 - h0)) / Math.max(len, TRACK_STEP);
      }
      const h0 = Math.atan2(this.tx[i - 1], this.ty[i - 1]);
      const h1 = Math.atan2(this.tx[i + 1], this.ty[i + 1]);
      kappa8[i] = Math.abs(wrapAngle(h1 - h0)) / Math.max(chord[i - 1] + chord[i], TRACK_STEP);
    }
    const kSm = boxSmooth(kappa, 1);
    const k8Sm = boxSmooth(kappa8, 1);
    // Not faster than the bus can steer round the bend: the physics scales the lock by
    // 1 / (1 + ((v - 1.5) / 6.5)^2), and a front axle on radius R needs asin(wheelbase / R) of it. STEER_SPARE
    // of the lock is left for the autopilot's (or a driver's) corrections.
    const spec = specFor(busTypeForRoute(this.route));
    const lock = spec.maxSteer * (1 - STEER_SPARE);
    this.vmax = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const vCurve = Math.sqrt(1.7 / Math.max(kSm[i], k8Sm[i], 1e-4));
      const kPeak = Math.max(kappa8[Math.max(0, i - 1)], kappa8[i], kappa8[Math.min(n - 1, i + 1)]);
      const q = Math.asin(Math.min(1, spec.wheelbase * kPeak)) / lock;
      const vSteer = q >= 1 ? 0 : 1.5 + 6.5 * Math.sqrt(1 / q - 1);
      const road = this.road[i] >= 0 ? data.roads[this.road[i]] : undefined;
      const vLim = (this.limit[i] || 50) / 3.6 - (road && road.kind === RoadKind.Busway ? 0.5 : 1.0);
      this.vmax[i] = Math.max(2.5, Math.min(vCurve, vSteer, vLim, 22));
    }
    for (let i = n - 2; i >= 0; i--) {
      this.vmax[i] = Math.min(this.vmax[i], Math.sqrt(this.vmax[i + 1] ** 2 + 2 * 1.1 * Math.max(chord[i], 0.5)));
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
      const target = zone ? zone.s1 - 1.5 : st.s;
      const kerbT = this.kerbAt(target);
      const pull = Math.max(0, Math.min(zone ? 2.5 : 3, kerbT - PLATFORM_LANE));
      return { index, s: st.s, station: !!zone || isStationStop(data.stops[st.stop].name), kerb: this.kerb[i], zone, target, pull };
    });
    // Signals: one stop line per signalised junction the lane passes through, before the junction.
    this.signals = this.findSignals(data, H);
  }

  /**
   * The signalised junctions along the lane, each with its stop line. A signal
   * node counts if the lane passes within 9 m of it at its level: the level of
   * the road the node is on (not a street signal over a busway tunnel, nor one
   * on a viaduct deck above the street), and not on a one-way carriageway
   * running the other way (the general lanes beside a contraflow bus lane).
   * A node out on an approach applies to traffic heading into the junction,
   * not to traffic leaving it. Nodes are grouped into junctions as the world's
   * signals are (within 28 m): one stop line per junction, where the world
   * paints it (back along the lane from the junction centre by the widest
   * road's half width + 2.5 m, 6..22 m) or 7 m before the first of its nodes
   * the lane meets, whichever comes first. (x, y) is the junction centre, for
   * `signalStateAt`.
   */
  private findSignals(data: MapData, H: ReturnType<typeof heightsOf>): TrackSignal[] {
    const n = this.n;
    const X = this.x;
    const Y = this.y;
    const J = signalJunctions(data);
    const TB = turnBoxes(data);
    const idx = roadIndexFor(data);
    const grid = signalGrid(data);
    const sig = data.signals;
    /** Per junction pass: the nodes' lane positions (and the signal model's junction of each). */
    const hits: { j: number; s: number; mj: number }[] = [];
    const model = signalsFor(data);
    /** Per node, the sample it was last looked at (a route can pass a node again, as a loop back to its start does). */
    const seen = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const gx = Math.floor(X[i] / 40) + 1000;
      const gy = Math.floor(Y[i] / 40) + 1000;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const list = grid.get((gx + ox) * 4096 + gy + oy);
          if (!list) continue;
          for (const k of list) {
            if (i - (seen.get(k) ?? -Infinity) < 25) continue;
            const sx = sig[2 * k];
            const sy = sig[2 * k + 1];
            if (Math.hypot(sx - X[i], sy - Y[i]) > 9) continue;
            const along = (sx - X[i]) * this.tx[i] + (sy - Y[i]) * this.ty[i];
            // (samples can stand further apart than TRACK_STEP where the lane is fitted round a corner)
            const gap = Math.max(TRACK_STEP, Math.hypot(X[Math.min(n - 1, i + 1)] - X[i], Y[Math.min(n - 1, i + 1)] - Y[i]), Math.hypot(X[i] - X[Math.max(0, i - 1)], Y[i] - Y[Math.max(0, i - 1)]));
            if (Math.abs(along) > gap * 0.75) continue;
            seen.set(k, i);
            const z = this.z[i];
            // The roads the node is on (streets first: a busway tunnel may pass right under it).
            let level = false;
            let onRoad = false;
            let applies = false;
            let tunnelOnly = true;
            idx.forEachNear(sx, sy, 1.2, (ri) => {
              if (!data.roads[ri].tunnel) tunnelOnly = false;
            });
            // The traffic the node faces along its own road (OSM traffic_signals:direction, from the
            // pipeline), against the lane's way in over the last 12 m (before any turn at the node).
            const rk = data.signalRoad?.[k] ?? -1;
            const dk = data.signalDir?.[k] ?? 0;
            const i0 = Math.max(0, i - 3);
            const inL = Math.hypot(X[i] - X[i0], Y[i] - Y[i0]);
            const inX = inL > 1 ? (X[i] - X[i0]) / inL : this.tx[i];
            const inY = inL > 1 ? (Y[i] - Y[i0]) / inL : this.ty[i];
            let faces = false;
            idx.forEachNear(sx, sy, 1.2, (ri, _ax, _ay, ux, uy, _len, _d, zz) => {
              const r = data.roads[ri];
              // (its own road at the lane's level, even where that is the tunnel starting at the node)
              if (ri === rk && Math.abs(zz - z) <= LEVEL_GAP) faces ||= (ux * inX + uy * inY) * dk > 0.5;
              if (r.tunnel && !tunnelOnly) return;
              onRoad = true;
              if (Math.abs(zz - z) > LEVEL_GAP || r.kind === RoadKind.Pedestrian) return;
              level = true;
              const fwd = ux * this.tx[i] + uy * this.ty[i];
              // (A one-way carriageway the other way: the general lanes beside a contraflow bus lane.)
              if (r.oneway && fwd < -0.5) return;
              // A node facing one way controls the lane coming in that way, as the signal model has it
              // (src/data/signals.ts): not the opposing lane past it, nor a cross street at its vertex.
              if (dk && rk >= 0) return;
              // A node out on an approach to a junction controls the traffic heading into it: not the
              // traffic leaving it (the signal for the other direction, on the arm the lane turns into).
              const cum = roadCum(r);
              const L = cum[cum.length - 1];
              const u = projectOnRoad(r, cum, sx, sy);
              const d0 = u + junctionBeyond(data, ri, 0, 40);
              const d1 = L - u + junctionBeyond(data, ri, 1, 40);
              if (Math.min(d0, d1) < 3 || Math.min(d0, d1) > 40) applies = true;
              else if (d0 < d1) applies ||= fwd < 0;
              else applies ||= fwd > 0;
            });
            if (dk && rk >= 0) applies = faces;
            if (onRoad ? !level || !applies : Math.abs(H.ground(sx, sy) - z) > LEVEL_GAP) continue;
            hits.push({ j: J.id[k], s: i * TRACK_STEP + along, mj: model.nodeJunction[k] });
          }
        }
      }
    }
    hits.sort((p, q) => p.s - q.s);
    const out: TrackSignal[] = [];
    let lastMj = -1;
    for (let h = 0; h < hits.length; h++) {
      const j = hits[h].j;
      const mj = hits[h].mj;
      // The nodes of this junction on this pass.
      let s0 = hits[h].s;
      let s1 = s0;
      for (let q = h + 1; q < hits.length; q++) {
        if (hits[q].j !== j) continue;
        if (hits[q].s - s1 > 60) break;
        s1 = hits[q].s;
        hits.splice(q, 1);
        q--;
      }
      const cx = J.cx[j];
      const cy = J.cy[j];
      // Where the lane passes the junction centre.
      let best = Infinity;
      let sc = s0;
      for (let i = Math.max(0, Math.floor((s0 - 40) / TRACK_STEP)); i <= Math.min(n - 1, Math.ceil((s1 + 40) / TRACK_STEP)); i++) {
        const d = Math.hypot(X[i] - cx, Y[i] - cy);
        if (d < best) {
          best = d;
          sc = i * TRACK_STEP;
        }
      }
      // At the world's stop line, or before the first signal for this approach if that comes first (the
      // junction centre can lie off to one side of a turning lane).
      const base = Math.min(s0 - 7, best < 15 ? sc - junctionStop(data, J, j) : Infinity);
      const last = out[out.length - 1];
      // (one stop per junction: a second node group of the signal model's junction, which can span
      // 70 m, is the same light; the next junction's, unless right on top of this one, is its own)
      const gap = mj < 0 ? 30 : mj === lastMj ? 60 : 10;
      if (base < 12 || (last && base - last.s < gap)) continue;
      let stop = base;
      // And behind the junction box of any sharp bus turn here (a turning bus may sweep through this lane
      // in it): where the lane, followed back from the centre, leaves the last such box. (Not so far back
      // that it runs into the stop line before, or off the start.)
      if (best < 15) {
        let i = Math.min(n - 1, Math.round(sc / TRACK_STEP));
        const near: number[] = [];
        for (let k = 0; k < TB.x.length; k++) {
          if (Math.hypot(TB.x[k] - cx, TB.y[k] - cy) < 30 && Math.abs(TB.z[k] - this.z[i]) < LEVEL_GAP) near.push(k);
        }
        const inBox = (q: number) => near.some((k) => Math.hypot(X[q] - TB.x[k], Y[q] - TB.y[k]) < TB.r[k]);
        const lo = Math.max(0, Math.floor((sc - TURN_BOX_MAX - 12) / TRACK_STEP));
        if (near.length && inBox(i)) {
          while (i > lo && inBox(i - 1)) i--;
          const floor = Math.max(12, last ? last.s + gap : 12);
          stop = Math.max(Math.min(stop, (i - 1) * TRACK_STEP), Math.min(stop, floor));
        }
      }
      out.push({ s: stop, x: cx, y: cy });
      lastMj = mj;
    }
    return out;
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
  private keepInside(lo: Float32Array, hi: Float32Array, home: Float32Array, skew: Uint8Array, floor: Float32Array, hiS: Float32Array): void {
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
    const hiS0 = Float32Array.from(hiS);
    for (let i = 0; i < n; i++) {
      for (let j = Math.max(0, i - D); j <= Math.min(n - 1, i + D); j++) {
        // In the lane's own road frame (home), like the slope below.
        lo[i] = Math.max(lo[i], lo0[j] - home[j] + home[i]);
        hi[i] = Math.min(hi[i], hi0[j] - home[j] + home[i]);
        hiS[i] = Math.min(hiS[i], hiS0[j] - home[j] + home[i]);
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
      hiS[i] = Math.min(hiS[i], hiS[i - 1] - home[i - 1] + home[i] + step);
    }
    for (let i = n - 2; i >= 0; i--) {
      const step = stepAt(i);
      hi[i] = Math.min(hi[i], hi[i + 1] - home[i + 1] + home[i] + step);
      lo[i] = Math.max(lo[i], lo[i + 1] - home[i + 1] + home[i] - step);
      hiS[i] = Math.min(hiS[i], hiS[i + 1] - home[i + 1] + home[i] + step);
    }
    // Not over the centre line unless the walls leave no room on the lane's own side, measured in the lane's
    // frame (hiS) and even OWN_OVER nearer than WALL_CLEAR (then as far over as they allow, not midway): a
    // bus nearer a wall is better than two meeting head on.
    for (let i = 0; i < n; i++) {
      if (hi[i] === Infinity && lo[i] === -Infinity) continue;
      if (floor[i] > hi[i]) hi[i] = Math.min(floor[i], Math.max(hi[i], hiS[i] + OWN_OVER));
      lo[i] = Math.max(lo[i], Math.min(hi[i], floor[i]));
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
    // (The shift, not the offsets: where the lane's road bends away from the GTFS shape, smoothing its
    // offsets would cut the bend.)
    const shift = new Float32Array(n);
    for (let k = 0; k < 4; k++) {
      for (let i = 0; i < n; i++) shift[i] = off[i] - before[i];
      const sm = boxSmooth(shift, 2);
      // (Not alongside a platform: smoothing would round the lane off the platform edge.)
      for (let i = 0; i < n; i++) if (near[i] && !(skew[i] & 4)) off[i] = before[i] + sm[i];
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
          // (Not into a corner tighter than R_OK, or than it was: the push bends the lane, it does not kink it.)
          const ox = this.x[k];
          const oy = this.y[k];
          const r0 = Math.min(this.radiusAt(k - 1), this.radiusAt(k), this.radiusAt(k + 1));
          this.x[k] = nxp;
          this.y[k] = nyp;
          if (Math.min(this.radiusAt(k - 1), this.radiusAt(k), this.radiusAt(k + 1)) < Math.min(R_OK, r0) - 1e-6) {
            this.x[k] = ox;
            this.y[k] = oy;
            continue;
          }
          moved = true;
          for (let q = Math.max(0, k - 2); q <= Math.min(n - 1, k + 2); q++) next[q] = 1;
        }
      }
      if (!moved) break;
      look = next;
    }
  }

  /**
   * Posted limits on busways OSM leaves untagged. Busway ways are split at every bridge, tunnel and
   * platform and only some carry `maxspeed`, so the class default (80, 60 in tunnels) would flick the
   * limit up between tagged neighbours and put 80 through a station: an untagged busway stretch takes
   * the higher of the tagged busway limits either side of it along the route (within 2 km), or 60 (the
   * most any busway in the map is tagged) with none in reach, never above the default; and through a
   * station at most 50, as nearly all tagged station ways are.
   */
  private fillLimits(data: MapData, zones: (PlatformZone | null)[]): void {
    const n = this.n;
    // Tagged busway limit per sample: > 0 tagged, 0 untagged busway, -1 not a busway.
    // (Unmatched samples carry their limit from the matched one before them: on a busway, untagged.)
    const tag = new Int16Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const ri = this.road[i];
      if (ri < 0) {
        if (i > 0 && tag[i - 1] >= 0) tag[i] = 0;
        continue;
      }
      const r = data.roads[ri];
      if (r.kind === RoadKind.Busway) tag[i] = r.maxspeed && r.maxspeed >= 10 ? r.maxspeed : 0;
    }
    const reach = Math.round(2000 / TRACK_STEP);
    const before = new Int16Array(n);
    let last = 0;
    let lastI = -Infinity;
    for (let i = 0; i < n; i++) {
      if (tag[i] > 0) {
        last = tag[i];
        lastI = i;
      }
      before[i] = i - lastI <= reach ? last : 0;
    }
    last = 0;
    lastI = Infinity;
    for (let i = n - 1; i >= 0; i--) {
      if (tag[i] > 0) {
        last = tag[i];
        lastI = i;
      }
      if (tag[i] !== 0) continue;
      const after = lastI - i <= reach ? last : 0;
      const nb = Math.max(before[i], after);
      this.limit[i] = Math.min(this.limit[i], nb > 0 ? nb : 60);
    }
    for (const z of zones) {
      if (!z) continue;
      const i0 = Math.max(0, Math.floor((z.s0 - 15) / TRACK_STEP));
      const i1 = Math.min(n - 1, Math.ceil((z.s1 + 10) / TRACK_STEP));
      for (let i = i0; i <= i1; i++) if (tag[i] === 0) this.limit[i] = Math.min(this.limit[i], 50);
    }
  }

  /**
   * Kerb distances from the lane as it finally runs (the refits move the lane, not the kerb): to the
   * matched road's left edge, or alongside a platform to its edge. Each platform zone is trimmed to
   * the longest stretch where the lane really runs alongside the edge (walls at a tunnel mouth can
   * hold it off the platform's end), so the front bay a bus is sent to is one it can pull up at.
   */
  private fitKerb(data: MapData, zones: (PlatformZone | null)[]): void {
    const n = this.n;
    const X = this.x;
    const Y = this.y;
    const kerb = Float32Array.from(this.kerb);
    for (let i = 0; i < n; i++) {
      const ri = this.road[i];
      if (ri < 0) continue;
      const r = data.roads[ri];
      const p = r.pts;
      let best = Infinity;
      let lat = 0;
      for (let k = 0; k + 3 < p.length; k += 2) {
        const ex = p[k + 2] - p[k];
        const ey = p[k + 3] - p[k + 1];
        const l2 = ex * ex + ey * ey || 1e-9;
        const t = Math.max(0, Math.min(1, ((X[i] - p[k]) * ex + (Y[i] - p[k + 1]) * ey) / l2));
        const d = Math.hypot(X[i] - p[k] - ex * t, Y[i] - p[k + 1] - ey * t);
        if (d < best) {
          best = d;
          const sg = ex * this.tx[i] + ey * this.ty[i] >= 0 ? 1 : -1;
          lat = (sg * (ex * (Y[i] - p[k + 1]) - ey * (X[i] - p[k]))) / Math.sqrt(l2);
        }
      }
      if (best < 15) kerb[i] = halfWidthLeft(r) - lat;
    }
    const km = median7(kerb);
    for (let i = 0; i < n; i++) if (this.road[i] >= 0) this.kerb[i] = Math.max(1.3, Math.min(6, km[i]));
    zones.forEach((z, k) => {
      if (!z) return;
      const i0 = Math.max(0, Math.ceil(z.s0 / TRACK_STEP));
      const i1 = Math.min(n - 1, Math.floor(z.s1 / TRACK_STEP));
      if (i1 < i0) return;
      const ok = new Uint8Array(i1 - i0 + 1);
      for (let i = i0; i <= i1; i++) {
        const d = platformEdgeAt(data, z.platform, X[i], Y[i], -this.ty[i], this.tx[i], 12);
        if (Number.isFinite(d)) this.kerb[i] = Math.max(1.3, Math.min(6, d));
        ok[i - i0] = d <= PLATFORM_LANE + 0.7 ? 1 : 0;
      }
      // The longest stretch alongside.
      let ba = -1;
      let bb = -2;
      for (let a = 0; a < ok.length; a++) {
        if (!ok[a]) continue;
        let b = a;
        while (b + 1 < ok.length && ok[b + 1]) b++;
        if (b - a > bb - ba) {
          ba = a;
          bb = b;
        }
        a = b;
      }
      // (Nowhere a bus fits alongside, or all of it: as matched.)
      const trim = !(ba < 0 || (bb - ba) * TRACK_STEP < 12 || (ba === 0 && bb === ok.length - 1));
      // Within the lane too: a terminus platform can reach past the route's end, where there is no lane.
      const s0 = Math.max(0, trim ? Math.max(z.s0, (i0 + ba) * TRACK_STEP - TRACK_STEP / 2) : z.s0);
      const s1 = Math.min(this.length - 1, trim ? Math.min(z.s1, (i0 + bb) * TRACK_STEP + TRACK_STEP / 2) : z.s1);
      if ((s0 === z.s0 && s1 === z.s1) || s1 - s0 < 8) return;
      const e0 = Math.max(0, Math.round((s0 - z.s0) / z.step));
      const e1 = Math.min(z.edge.length, e0 + Math.floor((s1 - s0) / z.step) + 1);
      zones[k] = { ...z, s0, s1, edge: z.edge.slice(e0, e1) };
    });
  }

  /**
   * Where a bus on the lane would stand in a building (a footprint mapped over
   * the kerb, a lane offset towards the shops), move the lane sideways to the
   * nearest place clear of it that is still on the road, easing in and out.
   * (Between samples too: a corner between two is passed by the body. And the
   * body itself, its front axle on the lane and its rear a wheelbase back: the
   * front overhang swings out of a bend over the kerb, the rear cuts in.)
   */
  private nudgeOffBuildings(TW: TrackWalls): void {
    const inB = TW.pointInBuilding;
    if (!inB) return;
    const n = this.n;
    const X = this.x;
    const Y = this.y;
    const HALF = 1.4;
    const lxs = new Float32Array(n);
    const lys = new Float32Array(n);
    const want = new Float32Array(n);
    let any = false;
    const clear = (x: number, y: number, z: number, lx: number, ly: number) =>
      !inB(x, y, z + 1.5) && !inB(x + lx * HALF, y + ly * HALF, z + 1.5) && !inB(x - lx * HALF, y - ly * HALF, z + 1.5);
    /** The sideways move (+ = left) to the nearest place clear of buildings on the road, 0 where clear or none. */
    const need = (x0: number, y0: number, z: number, lx: number, ly: number): number => {
      if (clear(x0, y0, z, lx, ly)) return 0;
      for (let d = 0.25; d <= 5; d += 0.25) {
        const sg = [1, -1].find((g) => {
          const x = x0 + lx * d * g;
          const y = y0 + ly * d * g;
          return TW.drivable(x, y, z) && clear(x, y, z, lx, ly);
        });
        if (sg !== undefined) return (d + 0.25) * sg;
      }
      return 0;
    };
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      const dx = X[b] - X[a];
      const dy = Y[b] - Y[a];
      const dl = Math.hypot(dx, dy) || 1;
      const lx = -dy / dl;
      const ly = dx / dl;
      lxs[i] = lx;
      lys[i] = ly;
      const z = this.z[i];
      const w = need(X[i], Y[i], z, lx, ly);
      if (w) {
        want[i] = w;
        any = true;
      }
    }
    for (let i = 0; i + 1 < n; i++) {
      const dx = X[i + 1] - X[i];
      const dy = Y[i + 1] - Y[i];
      const dl = Math.hypot(dx, dy) || 1;
      const w = need((X[i] + X[i + 1]) / 2, (Y[i] + Y[i + 1]) / 2, (this.z[i] + this.z[i + 1]) / 2, -dy / dl, dx / dl);
      if (!w) continue;
      for (const k of [i, i + 1]) if (Math.abs(w) > Math.abs(want[k])) want[k] = w;
      any = true;
    }
    // The body: the first section of the route's bus (and a rigid bus), outline BODY_MARGIN clear.
    const BODY_MARGIN = 0.15;
    const specs = busTypeForRoute(this.route) === 'metro' ? [specFor('metro'), specFor('rigid')] : [specFor('rigid')];
    for (const spec of specs) {
      const sc = spec.sections[0];
      const wb = spec.wheelbase;
      const L = sc.length / 2 + BODY_MARGIN;
      const H = spec.width / 2 + BODY_MARGIN;
      const co = sc.axleFromFront - sc.length / 2;
      // (Samples the body spans either side of the front axle's.)
      const back = Math.ceil((sc.length - sc.axleFromFront + wb) / TRACK_STEP);
      const ahead = Math.ceil((sc.axleFromFront - wb) / TRACK_STEP);
      /** The body with its front axle at (fx, fy) and rear axle at (rx, ry) touches a building. */
      const hits = (fx: number, fy: number, rx: number, ry: number, z: number): boolean => {
        const hl = Math.hypot(fx - rx, fy - ry) || 1;
        const hx = (fx - rx) / hl;
        const hy = (fy - ry) / hl;
        const cx = rx + hx * co;
        const cy = ry + hy * co;
        for (let u = -L; u <= L + 1e-6; u += 0.5) {
          if (inB(cx + hx * u - hy * H, cy + hy * u + hx * H, z + 1.5)) return true;
          if (inB(cx + hx * u + hy * H, cy + hy * u - hx * H, z + 1.5)) return true;
        }
        for (let v = -H + 0.5; v < H; v += 0.5) {
          if (inB(cx + hx * L - hy * v, cy + hy * L + hx * v, z + 1.5)) return true;
          if (inB(cx - hx * L - hy * v, cy - hy * L + hx * v, z + 1.5)) return true;
        }
        return false;
      };
      for (let i = 1; i < n; i++) {
        // The rear axle: a wheelbase back along the lane's chords.
        let j = i;
        let left = wb;
        while (j > 0 && left > Math.hypot(X[j] - X[j - 1], Y[j] - Y[j - 1])) {
          left -= Math.hypot(X[j] - X[j - 1], Y[j] - Y[j - 1]);
          j--;
        }
        if (j === 0) continue;
        const sl = Math.hypot(X[j] - X[j - 1], Y[j] - Y[j - 1]) || 1;
        const rx = X[j] + ((X[j - 1] - X[j]) * left) / sl;
        const ry = Y[j] + ((Y[j - 1] - Y[j]) * left) / sl;
        const z = this.z[i];
        if (!hits(X[i], Y[i], rx, ry, z)) continue;
        const lx = lxs[i];
        const ly = lys[i];
        let w = 0;
        for (let d = 0.25; d <= 3 && !w; d += 0.25) {
          for (const g of [1, -1]) {
            const ox = lx * d * g;
            const oy = ly * d * g;
            if (!TW.drivable(X[i] + ox, Y[i] + oy, z) || hits(X[i] + ox, Y[i] + oy, rx + ox, ry + oy, z)) continue;
            w = (d + 0.25) * g;
            break;
          }
        }
        if (!w) continue;
        for (let k = Math.max(0, i - back); k <= Math.min(n - 1, i + ahead); k++) if (Math.abs(w) > Math.abs(want[k])) want[k] = w;
        any = true;
      }
    }
    if (!any) return;
    // Ease: each way, no more than 0.3 m sideways per metre along.
    const RAMP = 0.3 * TRACK_STEP;
    const pos = new Float32Array(n);
    const neg = new Float32Array(n);
    // (Also a sample either side: the lane between samples is a chord.)
    for (let i = 0; i < n; i++) {
      for (let k = Math.max(0, i - 1); k <= Math.min(n - 1, i + 1); k++) {
        pos[i] = Math.max(pos[i], want[k]);
        neg[i] = Math.max(neg[i], -want[k]);
      }
    }
    for (const arr of [pos, neg]) {
      for (let i = 1; i < n; i++) arr[i] = Math.max(arr[i], arr[i - 1] - RAMP);
      for (let i = n - 2; i >= 0; i--) arr[i] = Math.max(arr[i], arr[i + 1] - RAMP);
    }
    for (let i = 0; i < n; i++) {
      const d = pos[i] >= neg[i] ? pos[i] : -neg[i];
      if (!d) continue;
      const x = X[i] + lxs[i] * d;
      const y = Y[i] + lys[i] * d;
      // (Only onto the road.)
      if (!TW.drivable(x, y, this.z[i])) continue;
      X[i] = x;
      Y[i] = y;
    }
  }

  /**
   * Drive the route's buses (a rigid bus, and a Metro on a Metro route) along the lane as they are driven, the front
   * axle on the lane and the rest trailing it, and where a section sweeps into a wall (the rear and the
   * trailers cut the inside of a bend, the overhangs swing out) ease the lane away there a little at a
   * time, over a few samples either side. Walls on both sides of a sweep meet halfway.
   */
  private nudgeForTrailers(TW: TrackWalls, G: WallGrid): void {
    const n = this.n;
    const W = TW.walls;
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
    const at = (s: number): [number, number] => {
      const f = Math.max(0, Math.min(n - 1.0001, s / TRACK_STEP));
      const i = Math.floor(f);
      const t = f - i;
      return [this.x[i] + (this.x[i + 1] - this.x[i]) * t, this.y[i] + (this.y[i + 1] - this.y[i]) * t];
    };
    // The push spreads over SPREAD samples either side (a smooth bump, so it bends the lane gently).
    const SPREAD = 4;
    const bump = new Float64Array(SPREAD + 1);
    for (let d = 0; d <= SPREAD; d++) bump[d] = 0.5 * (1 + Math.cos((Math.PI * d) / (SPREAD + 1)));
    const pushL = new Float32Array(n);
    const pushR = new Float32Array(n);
    // How far each sample's buses are into a wall (the lane may give up as much of its own half there, at
    // most OWN_GIVE).
    const hard = new Float32Array(n);
    const drive = (spec: ReturnType<typeof specFor>): void => {
      const secs = spec.sections;
      // How far behind the front axle each section's tail is (it is only placed once driven that far).
      const tail = new Float64Array(secs.length);
      for (let k = 0, back = 0; k < secs.length; k++) {
        const sc = secs[k];
        if (k > 0) back += secs[k - 1].rearHitchFromFront - secs[k - 1].axleFromFront + sc.axleFromFront - sc.hitchFromFront;
        tail[k] = (k === 0 ? spec.wheelbase : back) + sc.length - sc.axleFromFront;
      }
      const sx = new Float64Array(secs.length);
      const sy = new Float64Array(secs.length);
      const sh = new Float64Array(secs.length);
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
        const [fx, fy] = at(s + spec.wheelbase);
        let [rx, ry] = at(s);
        if (!fresh) {
          // The front axle is on the lane (the autopilot steers it there) and the rear axle trails it:
          // inside the lane on a bend by about wheelbase^2 / 2R, and each trailer further inside.
          const dx = fx - sx[0];
          const dy = fy - sy[0];
          const dl = Math.hypot(dx, dy) || 1;
          rx = fx - (dx / dl) * spec.wheelbase;
          ry = fy - (dy / dl) * spec.wheelbase;
        }
        sx[0] = rx;
        sy[0] = ry;
        sh[0] = Math.atan2(fx - rx, fy - ry);
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
          if (warm < tail[k] + 4) continue;
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
          const need = this.bodyPush(W, G, cx, cy, this.z[j], hx, hy, sc.length / 2, spec.width / 2 + SWEEP_MARGIN);
          if (!need) continue;
          if (Math.abs(need) - SWEEP_MARGIN > hard[j]) hard[j] = Math.abs(need) - SWEEP_MARGIN;
          // The section's sideways push, as the lane's sideways (+ = left of the lane).
          const a = Math.max(0, j - 1);
          const b = Math.min(n - 1, j + 1);
          const tl = Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a]) || 1;
          const nlx = -(this.y[b] - this.y[a]) / tl;
          const nly = (this.x[b] - this.x[a]) / tl;
          const v = need * (lx * nlx + ly * nly);
          if (v > pushL[j]) pushL[j] = v;
          if (v < pushR[j]) pushR[j] = v;
        }
      }
    };
    // The route's own bus (a Metro route's) and a rigid bus, which any route may be driven with.
    const specs = busTypeForRoute(this.route) === 'metro' ? [specFor('metro'), specFor('rigid')] : [specFor('rigid')];
    // The lane moves as one displacement field D along its normals as they were on the way in, so the
    // passes add up to a smooth bend: no sample moves more than SLOPE further than the next, a sample that
    // would leave the road or close on a wall keeps where it was, and no move makes a corner tighter than
    // R_OK (or than it was).
    const SLOPE = 0.5;
    const X0 = Float64Array.from(this.x);
    const Y0 = Float64Array.from(this.y);
    const nx0 = new Float64Array(n);
    const ny0 = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - 1);
      const b = Math.min(n - 1, k + 1);
      const tl = Math.hypot(X0[b] - X0[a], Y0[b] - Y0[a]) || 1;
      nx0[k] = -(Y0[b] - Y0[a]) / tl;
      ny0[k] = (X0[b] - X0[a]) / tl;
    }
    const D = new Float64Array(n);
    const radius = (k: number, dd: Float64Array): number => {
      if (k < 1 || k + 1 >= n) return Infinity;
      const px = X0[k - 1] + nx0[k - 1] * dd[k - 1];
      const py = Y0[k - 1] + ny0[k - 1] * dd[k - 1];
      const qx = X0[k] + nx0[k] * dd[k];
      const qy = Y0[k] + ny0[k] * dd[k];
      const rx = X0[k + 1] + nx0[k + 1] * dd[k + 1];
      const ry = Y0[k + 1] + ny0[k + 1] * dd[k + 1];
      const la = Math.hypot(qx - px, qy - py);
      const lb = Math.hypot(rx - qx, ry - qy);
      if (la < 0.25 * TRACK_STEP || lb < 0.25 * TRACK_STEP) return 0;
      const t = Math.abs(wrapAngle(Math.atan2(rx - qx, ry - qy) - Math.atan2(qx - px, qy - py)));
      return t > 1e-4 ? Math.min(la, lb) / t : Infinity;
    };
    // On a two-way road, outside junction boxes, how far left of the centre line a point is (Infinity
    // where the lane may leave its own half): a move does not take the lane nearer the oncoming lane than
    // OWN_MIN (or than it was). Each sample's nearest segment of its road.
    const data = this.data;
    const nodes = roadNodes(data);
    const own = new Int32Array(n).fill(-1);
    const vMid = new Float32Array(n).fill(NaN);
    // (Not on a bend tighter than BEND, where a Metro's sweep needs more than its half of the road and two
    // buses could not pass anyway.)
    const BEND = 30;
    const bendR = (k: number): number => {
      const a = Math.max(0, k - 2);
      const b = Math.min(n - 1, k + 2);
      if (b - a < 2) return Infinity;
      const h0 = Math.atan2(X0[k] - X0[a], Y0[k] - Y0[a]);
      const h1 = Math.atan2(X0[b] - X0[k], Y0[b] - Y0[k]);
      const t = Math.abs(wrapAngle(h1 - h0));
      return t > 1e-4 ? (0.5 * (b - a) * TRACK_STEP) / t : Infinity;
    };
    for (let k = 0; k < n; k++) {
      const ri = this.road[k];
      if (ri < 0) continue;
      let tight = false;
      for (let q = Math.max(0, k - 3); q <= Math.min(n - 1, k + 3) && !tight; q++) tight = bendR(q) < BEND;
      if (tight) continue;
      const r = data.roads[ri];
      if (r.oneway) {
        // (A one-way carriageway: from the line between it and the other direction's, if near.)
        if (ownHalfFree(nodes, ri, projectOnRoad(r, nodes.cum[ri], X0[k], Y0[k]))) continue;
        vMid[k] = midlineAcross(data, nodes, ri, X0[k], Y0[k], this.z[k], ny0[k], -nx0[k]);
        continue;
      }
      if (r.width < 6) continue;
      const p = r.pts;
      let best = 12;
      for (let q = 0; 2 * q + 3 < p.length; q++) {
        const ex = p[2 * q + 2] - p[2 * q];
        const ey = p[2 * q + 3] - p[2 * q + 1];
        const t = Math.max(0, Math.min(1, ((X0[k] - p[2 * q]) * ex + (Y0[k] - p[2 * q + 1]) * ey) / (ex * ex + ey * ey || 1e-9)));
        const d = Math.hypot(X0[k] - p[2 * q] - ex * t, Y0[k] - p[2 * q + 1] - ey * t);
        if (d < best) {
          best = d;
          own[k] = q;
        }
      }
    }
    // (In a junction box, or on a tight bend by one: the roads it turns from and into, TURN_ALONG.)
    const tFree = new Uint8Array(n);
    {
      const boxed = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        const ri = this.road[k];
        if (ri < 0 || !ownHalfFree(nodes, ri, projectOnRoad(data.roads[ri], nodes.cum[ri], X0[k], Y0[k]), true)) continue;
        for (let q = Math.max(0, k - 4); q <= Math.min(n - 1, k + 4); q++) boxed[q] = 1;
      }
      for (let k = 0; k < n; k++) {
        if (!boxed[k] || !Number.isNaN(vMid[k])) continue;
        const ri = this.road[k];
        tFree[k] = own[k] < 0 || ri < 0 || ownHalfFree(nodes, ri, projectOnRoad(data.roads[ri], nodes.cum[ri], X0[k], Y0[k])) ? 1 : 0;
      }
    }
    const tLines = turnLines(data, this.road, own, tFree, X0, Y0);
    const sideOf = (k: number, x: number, y: number): number => {
      const ri = this.road[k];
      const p = data.roads[ri].pts;
      const cum = nodes.cum[ri];
      const ux = ny0[k];
      const uy = -nx0[k];
      let best = Infinity;
      let lat = Infinity;
      for (let q = Math.max(0, own[k] - 2); q <= Math.min(cum.length - 2, own[k] + 2); q++) {
        const ex = p[2 * q + 2] - p[2 * q];
        const ey = p[2 * q + 3] - p[2 * q + 1];
        const l2 = ex * ex + ey * ey || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - p[2 * q]) * ex + (y - p[2 * q + 1]) * ey) / l2));
        const d = Math.hypot(x - p[2 * q] - ex * t, y - p[2 * q + 1] - ey * t);
        if (d >= best) continue;
        best = d;
        if (ownHalfFree(nodes, ri, cum[q] + (cum[q + 1] - cum[q]) * t)) {
          lat = Infinity;
          continue;
        }
        const sg = ex * ux + ey * uy >= 0 ? 1 : -1;
        lat = (sg * (ex * (y - p[2 * q + 1]) - ey * (x - p[2 * q]))) / Math.sqrt(l2);
      }
      return lat;
    };
    const give = new Float32Array(n);
    const fits = (k: number, v: number, half = true): boolean => {
      const qx = X0[k] + nx0[k] * v;
      const qy = Y0[k] + ny0[k] * v;
      if (!TW.drivable(qx, qy, this.z[k])) return false;
      // (With `half`, keeping the lane's own half too.)
      if (half && own[k] >= 0) {
        const lat = sideOf(k, qx, qy);
        if (lat < OWN_MIN - give[k] && lat < sideOf(k, this.x[k], this.y[k]) - 1e-3) return false;
      }
      if (half && !Number.isNaN(vMid[k])) {
        const vNow = (this.x[k] - X0[k]) * nx0[k] + (this.y[k] - Y0[k]) * ny0[k];
        if (v - vMid[k] < OWN_MIN - give[k] && v < vNow - 1e-3) return false;
      }
      if (half && tFree[k]) {
        const lat = turnSide(tLines, k, qx, qy, ny0[k], -nx0[k]);
        if (lat < -give[k] && lat < turnSide(tLines, k, this.x[k], this.y[k], ny0[k], -nx0[k]) - 1e-3) return false;
      }
      const dNew = this.wallDist(W, G, qx, qy, this.z[k]);
      return !(dNew < WALL_CLEAR - 0.6 && dNew < this.wallDist(W, G, this.x[k], this.y[k], this.z[k]));
    };
    // How far each sample's buses are into the walls (with the margin), from the pass that drove them.
    const needNow = (): Float32Array => {
      const out = new Float32Array(n);
      for (let j = 0; j < n; j++) out[j] = Math.max(pushL[j], -pushR[j]);
      return out;
    };
    const sim0 = Uint8Array.from(sim);
    let need0: Float32Array | null = null;
    for (let pass = 0; pass < 10; pass++) {
      pushL.fill(0);
      pushR.fill(0);
      hard.fill(0);
      for (const spec of specs) drive(spec);
      if (!need0) need0 = needNow();
      for (let k = 0; k < n; k++) {
        let g = 0;
        for (let j = Math.max(0, k - SPREAD); j <= Math.min(n - 1, k + SPREAD); j++) g = Math.max(g, hard[j]);
        give[k] = Math.min(OWN_GIVE, g);
      }
      // Each sample's push: from walls one side, or halfway between where both sides press.
      const push = new Float32Array(n);
      for (let j = 0; j < n; j++) {
        const both = pushL[j] > 0 && pushR[j] < 0;
        push[j] = both ? (pushL[j] + pushR[j]) / 2 : pushL[j] + pushR[j];
      }
      // Spread: each sample moves by the strongest bump-weighted push near it (signed sum where they differ).
      const mvL = new Float32Array(n);
      const mvR = new Float32Array(n);
      for (let j = 0; j < n; j++) {
        if (!push[j]) continue;
        const step = Math.sign(push[j]) * Math.min(0.3, Math.abs(push[j]));
        for (let k = Math.max(0, j - SPREAD); k <= Math.min(n - 1, j + SPREAD); k++) {
          const v = step * bump[Math.abs(k - j)];
          if (v > mvL[k]) mvL[k] = v;
          if (v < mvR[k]) mvR[k] = v;
        }
      }
      const Dn = Float64Array.from(D);
      let any = false;
      for (let k = 0; k < n; k++) {
        const v = mvL[k] + mvR[k];
        if (Math.abs(v) < 1e-3) continue;
        Dn[k] += v;
        any = true;
      }
      if (!any) break;
      // Where two neighbours differ by more than SLOPE, the one that moves further this pass gives way
      // (D itself is within the limit, so this ends at worst at D).
      const ease = (): void => {
        for (let sweep = 0; sweep < 40; sweep++) {
          let changed = false;
          for (let k = 0; k + 1 < n; k++) {
            const gap = Dn[k + 1] - Dn[k];
            if (Math.abs(gap) <= SLOPE + 1e-9) continue;
            const over = Math.abs(gap) - SLOPE;
            const ik = Math.abs(Dn[k] - D[k]);
            const iq = Math.abs(Dn[k + 1] - D[k + 1]);
            // Move the one with the larger move this pass towards the other, no further back than D.
            const j = ik >= iq ? k : k + 1;
            const toward = j === k ? Math.sign(gap) : -Math.sign(gap);
            const room = Math.abs(Dn[j] - D[j]);
            const back = Math.sign(D[j] - Dn[j]);
            const amt = back === toward || room === 0 ? Math.min(over, room) : 0;
            if (amt <= 0) continue;
            Dn[j] += toward * amt;
            changed = true;
          }
          if (!changed) break;
        }
      };
      for (let round = 0; round < 6; round++) {
        ease();
        let held = false;
        for (let k = 0; k < n; k++) {
          if (Math.abs(Dn[k] - D[k]) < 1e-3) continue;
          const bendsOk = (): boolean => {
            for (let q = Math.max(1, k - 1); q <= Math.min(n - 2, k + 1); q++) if (radius(q, Dn) < Math.min(R_OK, radius(q, D)) - 1e-6) return false;
            return true;
          };
          const fit = fits(k, Dn[k]);
          let ok = fit && bendsOk();
          if (ok) continue;
          // (Held by its own half alone: as far as that allows.)
          const full = Dn[k];
          if (!fit && fits(k, full, false)) {
            for (const f of [0.5, 0.25]) {
              Dn[k] = D[k] + (full - D[k]) * f;
              if ((ok = fits(k, Dn[k]) && bendsOk())) break;
            }
          }
          if (!ok) Dn[k] = D[k];
          held = true;
        }
        if (!held) break;
      }
      let moved = false;
      const movedAt = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        if (Math.abs(Dn[k] - D[k]) < 1e-3 || !fits(k, Dn[k])) continue;
        D[k] = Dn[k];
        this.x[k] = X0[k] + nx0[k] * D[k];
        this.y[k] = Y0[k] + ny0[k] * D[k];
        moved = true;
        movedAt[k] = 1;
      }
      if (!moved) break;
      // Next pass: only around what moved (driven in from WARM metres before, through the chain's length).
      sim.fill(0);
      for (let k = 0; k < n; k++) {
        if (!movedAt[k]) continue;
        for (let q = Math.max(0, k - WARM / TRACK_STEP - 4); q <= Math.min(n - 1, k + 10); q++) sim[q] = 1;
      }
    }
    // A move that got the buses no clearer of the walls (walls no line through this road clears, such as
    // a junction its parapets close off) is undone, so the lane keeps its own line, in its own half,
    // there; so is one that gained little for how far it swerved.
    if (!need0 || !D.some((v) => v !== 0)) return;
    sim.set(sim0);
    pushL.fill(0);
    pushR.fill(0);
    for (const spec of specs) drive(spec);
    const need1 = needNow();
    for (let k = 0; k < n; ) {
      if (D[k] === 0) {
        k++;
        continue;
      }
      let e = k;
      while (e + 1 < n && D[e + 1] !== 0) e++;
      // (Over the stretch and the buses' length either side: how much less the buses are into walls in all.)
      let gain = 0;
      let far = 0;
      for (let q = Math.max(0, k - 12); q <= Math.min(n - 1, e + 12); q++) gain += need0[q] - need1[q];
      for (let q = k; q <= e; q++) far = Math.max(far, Math.abs(D[q]));
      if (gain < Math.max(0.1, 0.3 * far)) {
        for (let q = k; q <= e; q++) {
          D[q] = 0;
          this.x[q] = X0[q];
          this.y[q] = Y0[q];
        }
      }
      k = e + 1;
    }
  }

  /**
   * Local lane radius at sample i (from its two chords, the shorter of them: a corner between a short and a
   * long chord is as tight as the short one; 0 where the lane stalls or folds back).
   */
  private radiusAt(i: number): number {
    if (i < 1 || i + 1 >= this.n) return Infinity;
    const X = this.x;
    const Y = this.y;
    const ax = X[i] - X[i - 1];
    const ay = Y[i] - Y[i - 1];
    const bx = X[i + 1] - X[i];
    const by = Y[i + 1] - Y[i];
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 0.25 * TRACK_STEP || lb < 0.25 * TRACK_STEP) return 0;
    const d = Math.abs(wrapAngle(Math.atan2(bx, by) - Math.atan2(ax, ay)));
    return d > 1e-4 ? Math.min(la, lb) / d : Infinity;
  }

  /**
   * Corners, cusps and jogs tighter than a bus turns (a lane mitred round a
   * junction node, a GTFS corner offset to its inside, a platform pull-in):
   * relax each stretch around them towards the least bent curve between its
   * fixed ends (a bus sweeps a corner, swinging wide where the road has room)
   * while every point stays where a bus fits (on the carriageway or a bay,
   * clear of walls and buildings), then space the stretch's samples evenly.
   * `fixed` samples (alongside a platform) do not move.
   */
  private regularize(TW: TrackWalls | null, G: WallGrid | null, fixed: Uint8Array, data: MapData, skew: Uint8Array): void {
    const n = this.n;
    if (n < 6) return;
    const X = this.x;
    const Y = this.y;
    const W = TW?.walls;
    // Lane radius aimed for: a 24.7 m Metro's trailers and a 12.5 m bus's swing need ~10 m and up.
    const RMIN = 11;
    // On a two-way road (not inside a junction, not at a platform) the lane keeps to its own half, at
    // least OWN_MIN from the centre line so opposing lanes stay a lane apart: its nearest segment of the
    // matched road, and the road's length along it.
    const own = new Int32Array(n).fill(-1);
    const nodes = roadNodes(data);
    for (let i = 0; i < n; i++) {
      const ri = this.road[i];
      if (ri < 0 || skew[i] & 2) continue;
      const r = data.roads[ri];
      if (r.oneway || r.width < 6) continue;
      const p = r.pts;
      const cum = nodes.cum[ri];
      let best = 12;
      for (let k = 0; k + 1 < cum.length; k++) {
        const ex = p[2 * k + 2] - p[2 * k];
        const ey = p[2 * k + 3] - p[2 * k + 1];
        const t = Math.max(0, Math.min(1, ((X[i] - p[2 * k]) * ex + (Y[i] - p[2 * k + 1]) * ey) / (ex * ex + ey * ey || 1e-9)));
        const d = Math.hypot(X[i] - p[2 * k] - ex * t, Y[i] - p[2 * k + 1] - ey * t);
        if (d < best) {
          best = d;
          own[i] = k;
        }
      }
    }
    // One-way carriageways running against the lane near each sample (a dual carriageway's other half, a
    // busway's other direction): the lane keeps off them as it keeps its own half of a two-way road. Per
    // sample: their segments (start, direction, length, how near the centreline counts as on it), and
    // the sharp-turn junction boxes nearby.
    const oppStart = new Int32Array(n + 1);
    const oppSeg: number[] = [];
    const boxStart = new Int32Array(n + 1);
    const boxNear: number[] = [];
    {
      const idx = roadIndexFor(data);
      const TB = turnBoxes(data);
      for (let i = 0; i < n; i++) {
        oppStart[i] = oppSeg.length;
        boxStart[i] = boxNear.length;
        const a = Math.max(0, i - 1);
        const b = Math.min(n - 1, i + 1);
        const tl = Math.hypot(X[b] - X[a], Y[b] - Y[a]) || 1;
        const ux = (X[b] - X[a]) / tl;
        const uy = (Y[b] - Y[a]) / tl;
        // (Not one the lane already runs on: a shape against a one-way street, carriageways mapped
        // overlapping. Keeping it there no worse is all the solve can do.)
        const on = new Set<number>();
        const segs: number[] = [];
        idx.forEachNear(X[i], Y[i], 14, (rj, ax, ay, sdx, sdy, len, d, zz) => {
          const r = data.roads[rj];
          if (rj === this.road[i] || !r.oneway || r.kind === RoadKind.Pedestrian || Math.abs(zz - this.z[i]) > LEVEL_GAP) return;
          if (sdx * ux + sdy * uy > -OPP_DOT) return;
          if (d < r.width / 2 - OPP_IN) on.add(rj);
          segs.push(rj, ax, ay, sdx, sdy, len, r.width / 2 - OPP_IN);
        });
        for (let k = 0; k < segs.length; k += 7) if (!on.has(segs[k])) oppSeg.push(...segs.slice(k + 1, k + 7));
        if (oppSeg.length === oppStart[i]) continue;
        for (let k = 0; k < TB.x.length; k++) {
          if (Math.abs(TB.x[k] - X[i]) < 40 && Math.abs(TB.y[k] - Y[i]) < 40 && Math.abs(TB.z[k] - this.z[i]) < LEVEL_GAP) boxNear.push(TB.x[k], TB.y[k], TB.r[k]);
        }
      }
      oppStart[n] = oppSeg.length;
      boxStart[n] = boxNear.length;
    }
    // (In a junction box, the turn's included: the roads it turns from and into, TURN_ALONG.)
    const tFree = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const ri = this.road[i];
      if (ri >= 0 && ownHalfFree(nodes, ri, projectOnRoad(data.roads[ri], nodes.cum[ri], X[i], Y[i]), true)) tFree[i] = 1;
    }
    const tLines = turnLines(data, this.road, own, tFree, X, Y);
    /** The left-turn guard's hold at each sample (TURN_GUARD_STEPS). */
    const hold = new Float32Array(n).fill(TURN_LEFT_HOLD);
    /** Whether the stretch being solved may use the junction box its turn needs. */
    let relax = false;
    /** How far left of the matched road's centre line (x, y) is, facing (ux, uy); Infinity in a junction or near a dead end. */
    const sideOf = (i: number, x: number, y: number, ux: number, uy: number): number => {
      const ri = this.road[i];
      const p = data.roads[ri].pts;
      const cum = nodes.cum[ri];
      const last = cum.length - 1;
      let best = Infinity;
      let lat = Infinity;
      for (let k = Math.max(0, own[i] - 2); k <= Math.min(last - 1, own[i] + 2); k++) {
        const ex = p[2 * k + 2] - p[2 * k];
        const ey = p[2 * k + 3] - p[2 * k + 1];
        const l2 = ex * ex + ey * ey || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - p[2 * k]) * ex + (y - p[2 * k + 1]) * ey) / l2));
        const d = Math.hypot(x - p[2 * k] - ex * t, y - p[2 * k + 1] - ey * t);
        if (d >= best) continue;
        best = d;
        const along = cum[k] + (cum[k + 1] - cum[k]) * t;
        if (ownHalfFree(nodes, ri, along, relax)) {
          lat = Infinity;
          continue;
        }
        const sg = ex * ux + ey * uy >= 0 ? 1 : -1;
        lat = (sg * (ex * (y - p[2 * k + 1]) - ey * (x - p[2 * k]))) / Math.sqrt(l2);
      }
      return lat;
    };
    /** How badly a bus would stand with its lane centre at (x, y) (0 = fine): off the carriageway, near walls or buildings. */
    const badness = (i: number, x: number, y: number, ux: number, uy: number): number => {
      if (!TW) return 0;
      const z = this.z[i];
      let bad = 0;
      if (!TW.drivable(x, y, z)) bad += 3;
      // (The body's sides: half a bus out, on the road too.)
      const lx = -uy;
      const ly = ux;
      if (!TW.drivable(x + lx * 1.05, y + ly * 1.05, z)) bad += 1;
      if (!TW.drivable(x - lx * 1.05, y - ly * 1.05, z)) bad += 1;
      if (W && G) {
        const d = this.wallDist(W, G, x, y, z, 3);
        if (d < WALL_CLEAR - 0.45) bad += 1 + (WALL_CLEAR - 0.45 - d) * 2;
      }
      if (TW.pointInBuilding) {
        if (TW.pointInBuilding(x + lx * 1.5, y + ly * 1.5, z + 1.5)) bad += 2;
        if (TW.pointInBuilding(x - lx * 1.5, y - ly * 1.5, z + 1.5)) bad += 2;
      }
      // (Over the centre line into the oncoming lane outweighs a wall's clearance. A corner may use OWN_GIVE
      // of OWN_MIN, as a sweep may: held to all of it, some corners at junction boxes go unsolved.)
      if (own[i] >= 0) {
        const lat = sideOf(i, x, y, ux, uy);
        const least = OWN_MIN - OWN_GIVE;
        if (lat < least) bad += 4 + (least - lat) * 2;
      }
      // (A left turn swings wide in its junction box, in every pass, but keeps its body on its side of the
      // centre lines of the roads it turns from and into, TURN_LEFT_HOLD: a bus turning left from the kerb lane
      // does not swing out into the oncoming lanes, unless that kinks it (TURN_GUARD_R). A right turn or a
      // corner on the way through may use the box as before.)
      if (tFree[i] && !Number.isNaN(hold[i]) && tLines[10 * i + 8] === Math.fround(TURN_LEFT_MIN)) {
        const lat = turnSide(tLines, i, x, y, ux, uy) - (hold[i] - TURN_LEFT_MIN);
        if (lat < -OWN_GIVE) bad += 4 + (-OWN_GIVE - lat) * 2;
      }
      // (So does running on a one-way carriageway the other way, outside the junction box of a sharp turn
      // where the stretch may use it.)
      for (let k = oppStart[i]; k < oppStart[i + 1]; k += 6) {
        if (oppSeg[k + 2] * ux + oppSeg[k + 3] * uy > -OPP_DOT) continue;
        const t = Math.max(0, Math.min(oppSeg[k + 4], (x - oppSeg[k]) * oppSeg[k + 2] + (y - oppSeg[k + 1]) * oppSeg[k + 3]));
        const d = Math.hypot(x - oppSeg[k] - oppSeg[k + 2] * t, y - oppSeg[k + 1] - oppSeg[k + 3] * t);
        if (d >= oppSeg[k + 5]) continue;
        let boxed = false;
        for (let q = boxStart[i]; relax && q < boxStart[i + 1] && !boxed; q += 3) boxed = Math.hypot(x - boxNear[q], y - boxNear[q + 1]) < boxNear[q + 2];
        if (!boxed) bad += 4 + (oppSeg[k + 5] - d) * 2;
        break;
      }
      return bad;
    };
    const dirAt = (i: number): [number, number] => {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      const dx = X[b] - X[a];
      const dy = Y[b] - Y[a];
      const l = Math.hypot(dx, dy) || 1;
      return [dx / l, dy / l];
    };
    /** Regularize the stretch A..B (both ends locked) towards the least bent lane a bus fits. */
    const solveWindow = (A: number, B: number): void => {
      const m = B - A + 1;
      const X0 = X.slice(A, B + 1);
      const Y0 = Y.slice(A, B + 1);
      const lock = (i: number) => i <= A + 1 || i >= B - 1 || fixed[i] === 1;
      const cur = new Float32Array(m);
      for (let i = A; i <= B; i++) {
        const [ux, uy] = dirAt(i);
        cur[i - A] = badness(i, X[i], Y[i], ux, uy);
      }
      // The least bent curve through the locked points (bending energy: squared second differences, with
      // a weak pull back to where the lane was), solved directly. A point it puts where a bus does not fit
      // gets a one-sided constraint: stay on the near side of a line through the nearest place across the
      // lane that does fit (it may slide along that edge, or leave it when the curve swings wide); solved
      // again until all fit. If some still do not, it is solved again with those pinned where they were, and
      // the least tight of the solves is kept, going only part of the way from the old lane where a sample
      // still does not fit.
      const LAM = 0.01;
      const CW = 60;
      const SPACE = 4;
      const S0X = Float64Array.from(X0);
      const S0Y = Float64Array.from(Y0);
      const wt = new Float64Array(m).fill(LAM);
      // (Bending weighs more, iteration by iteration, where the curve is still tighter than RMIN: the
      // turn spreads out, swinging wide, rather than bunching where the road is narrowest.)
      const bw = new Float64Array(m).fill(1);
      const cw = new Float64Array(m);
      const cnx = new Float64Array(m);
      const cny = new Float64Array(m);
      const cc = new Float64Array(m);
      // (Samples pinned where they were: a solve could not fit them, so it is run again round them.)
      const pinned = new Uint8Array(m);
      const free: number[] = [];
      const setFree = (): void => {
        free.length = 0;
        for (let k = 0; k < m; k++) if (!lock(A + k) && !pinned[k]) free.push(k);
      };
      setFree();
      if (!free.length) return;
      const PX = Float32Array.from(X0);
      const PY = Float32Array.from(Y0);
      const bad = (k: number, x: number, y: number, ux: number, uy: number) => badness(A + k, x, y, ux, uy) > cur[k] + 1e-6;
      const tangent = (QX: ArrayLike<number>, QY: ArrayLike<number>, k: number): [number, number] => {
        const dx = QX[Math.min(m - 1, k + 1)] - QX[Math.max(0, k - 1)];
        const dy = QY[Math.min(m - 1, k + 1)] - QY[Math.max(0, k - 1)];
        const dl = Math.hypot(dx, dy) || 1;
        return [dx / dl, dy / dl];
      };
      /** The solve from the old lane (into PX, PY); how many samples it leaves where a bus does not fit. */
      const solve = (): number => {
        PX.set(X0);
        PY.set(Y0);
        wt.fill(LAM);
        bw.fill(1);
        cw.fill(0);
        let left = 0;
        for (let it = 0; it < 30; it++) {
          // Rows: bending (second differences, which measure curvature only while samples stay evenly
          // spaced, so also: each chord, along its present direction, as long as the stretch's mean), the
          // pull back to the old lane, and the half planes.
          const rows: LsqRow[] = [];
          let total = 0;
          for (let k = 0; k + 1 < m; k++) total += Math.hypot(PX[k + 1] - PX[k], PY[k + 1] - PY[k]);
          const hbar = Math.max(total, Math.hypot(PX[m - 1] - PX[0], PY[m - 1] - PY[0])) / (m - 1);
          let lux = PX[1] - PX[0];
          let luy = PY[1] - PY[0];
          for (let k = 0; k + 1 < m; k++) {
            const dx = PX[k + 1] - PX[k];
            const dy = PY[k + 1] - PY[k];
            const dl = Math.hypot(dx, dy);
            if (dl > 0.05) {
              lux = dx / dl;
              luy = dy / dl;
            }
            rows.push({ w: relax ? SPACE * 16 : SPACE, k: [k, k + 1], cx: [-lux, lux], cy: [-luy, luy], c: hbar });
          }
          for (let j = 1; j + 1 < m; j++) {
            rows.push({ w: bw[j], k: [j - 1, j, j + 1], cx: [1, -2, 1], cy: [0, 0, 0], c: 0 });
            rows.push({ w: bw[j], k: [j - 1, j, j + 1], cx: [0, 0, 0], cy: [1, -2, 1], c: 0 });
          }
          for (const k of free) {
            rows.push({ w: wt[k], k: [k], cx: [1], cy: [0], c: S0X[k] });
            rows.push({ w: wt[k], k: [k], cx: [0], cy: [1], c: S0Y[k] });
            if (cw[k] > 0) rows.push({ w: cw[k], k: [k], cx: [cnx[k]], cy: [cny[k]], c: cc[k] });
            // (A turn lane's held sample, sideways.)
            if (this.turnHeld[A + k]) {
              const [hx, hy] = tangent(S0X, S0Y, k);
              rows.push({ w: TURN_HOLD_W, k: [k], cx: [-hy], cy: [hx], c: -hy * S0X[k] + hx * S0Y[k] });
            }
          }
          const sol = solveRows(X, Y, A, m, free, rows);
          free.forEach((k, f) => {
            PX[k] = sol[2 * f];
            PY[k] = sol[2 * f + 1];
          });
          left = 0;
          let changed = 0;
          const rj = new Float64Array(m).fill(Infinity);
          let rlo = Infinity;
          for (let j = 1; j + 1 < m; j++) {
            const ax = PX[j] - PX[j - 1];
            const ay = PY[j] - PY[j - 1];
            const bx = PX[j + 1] - PX[j];
            const by = PY[j + 1] - PY[j];
            const turn = Math.abs(wrapAngle(Math.atan2(bx, by) - Math.atan2(ax, ay)));
            const len = (Math.hypot(ax, ay) + Math.hypot(bx, by)) / 2;
            rj[j] = turn > 1e-6 ? len / turn : Infinity;
            rlo = Math.min(rlo, rj[j]);
          }
          // (In the junction box pass only the tightest stretch stiffens, so the turn spreads out from there
          // even where RMIN is out of reach.)
          const rTarget = relax ? Math.min(RMIN, rlo * 1.3) : RMIN;
          for (let j = 1; j + 1 < m; j++) {
            if (rj[j] * 1.02 < rTarget && bw[j] < (relax ? 1600 : 200)) {
              bw[j] *= 2;
              changed++;
            }
          }
          for (const k of free) {
            const [ux, uy] = tangent(PX, PY, k);
            const isBad = bad(k, PX[k], PY[k], ux, uy);
            if (!isBad) {
              // Released where the curve pulls it further onto the good side.
              if (cw[k] > 0 && cnx[k] * PX[k] + cny[k] * PY[k] > cc[k] + 0.02) {
                cw[k] = 0;
                changed++;
              }
              continue;
            }
            left++;
            // The nearest place across the lane where a bus fits.
            let found = false;
            for (let d = 0.25; d <= 6 && !found; d += 0.25) {
              for (const sg of [1, -1]) {
                const qx = PX[k] - uy * d * sg;
                const qy = PY[k] + ux * d * sg;
                if (bad(k, qx, qy, ux, uy)) continue;
                const nx2 = -uy * sg;
                const ny2 = ux * sg;
                // (Keep the old edge if this one is barely different, else take the new one.)
                cnx[k] = nx2;
                cny[k] = ny2;
                cc[k] = nx2 * qx + ny2 * qy + 0.1;
                cw[k] = relax && cw[k] > 0 ? Math.min(CW * 64, cw[k] * 2) : CW;
                found = true;
                break;
              }
            }
            if (!found) {
              // Nowhere across: back where it was.
              wt[k] += CW;
            }
            changed++;
          }
          if (!left && !changed && it >= 3) break;
        }
        return left;
      };
      // Whatever still does not fit: only part of the way from the old lane.
      const partWay = (): number => {
        for (let t = 0.75; t > 0; t -= 0.25) {
          let ok = true;
          for (const k of free) {
            const x = S0X[k] + (PX[k] - S0X[k]) * t;
            const y = S0Y[k] + (PY[k] - S0Y[k]) * t;
            const [ux, uy] = tangent(PX, PY, k);
            if (bad(k, x, y, ux, uy)) {
              ok = false;
              break;
            }
          }
          if (ok) return t;
        }
        return 0;
      };
      const tightest = (): number => {
        let r = Infinity;
        for (let i = A + 1; i < B; i++) r = Math.min(r, this.radiusAt(i));
        return r;
      };
      const before = tightest();
      let best = -1;
      const keepX = new Float64Array(m);
      const keepY = new Float64Array(m);
      for (let attempt = 0; ; attempt++) {
        const left = solve();
        const t = left ? partWay() : 1;
        for (const k of free) {
          X[A + k] = S0X[k] + (PX[k] - S0X[k]) * t;
          Y[A + k] = S0Y[k] + (PY[k] - S0Y[k]) * t;
        }
        const r = tightest();
        if (r > best) {
          best = r;
          for (let k = 0; k < m; k++) {
            keepX[k] = X[A + k];
            keepY[k] = Y[A + k];
          }
        }
        for (let k = 0; k < m; k++) {
          X[A + k] = S0X[k];
          Y[A + k] = S0Y[k];
        }
        if (!left || attempt === PIN_RETRIES) break;
        let pins = 0;
        for (const k of free) {
          const [ux, uy] = tangent(PX, PY, k);
          if (bad(k, PX[k], PY[k], ux, uy)) {
            pinned[k] = 1;
            pins++;
          }
        }
        setFree();
        if (!pins || !free.length) break;
      }
      // (None better: as it was.)
      if (best >= before) {
        for (let k = 0; k < m; k++) {
          X[A + k] = keepX[k];
          Y[A + k] = keepY[k];
        }
      }
      for (let i = A; i <= B; i++) {
        const [ux, uy] = dirAt(i);
        cur[i - A] = badness(i, X[i], Y[i], ux, uy);
      }
      // Even spacing between the stretch's fixed points (each sample stands for the same length of lane).
      let k0 = A;
      for (let k = A + 1; k <= B; k++) {
        if (!(k === B || fixed[k] === 1)) continue;
        this.respace(k0, k, badness, dirAt);
        k0 = k;
      }
    };
    for (let round = 0; round < 3; round++) {
      // Stretches that need it, widened by the corner's setback (a tangent arc of RMIN needs RMIN tan(turn/2)
      // either side of the apex) plus room to ease in.
      const wins: [number, number][] = [];
      for (let i = 1; i + 1 < n; i++) {
        if (!(this.radiusAt(i) < RMIN)) continue;
        let b = i;
        while (b + 2 < n && this.radiusAt(b + 1) < RMIN) b++;
        let turn = 0;
        for (let k = Math.max(1, i - 1); k <= Math.min(n - 2, b + 1); k++) {
          const r = this.radiusAt(k);
          turn += r === 0 ? Math.PI / 2 : Math.abs(wrapAngle(Math.atan2(X[k + 1] - X[k], Y[k + 1] - Y[k]) - Math.atan2(X[k] - X[k - 1], Y[k] - Y[k - 1])));
        }
        const setback = RMIN * Math.tan(Math.min(2.4, turn) / 2);
        const M = Math.max(3, Math.min(12, Math.ceil(setback / TRACK_STEP) + 2 + round * 2));
        const a0 = Math.max(0, i - M);
        const b0 = Math.min(n - 1, b + M);
        const last = wins[wins.length - 1];
        if (last && a0 <= last[1]) last[1] = Math.max(last[1], b0);
        else wins.push([a0, b0]);
        i = b;
      }
      if (!wins.length) break;
      // A stretch still tighter than R_OK in its own half is solved again using the turn's junction box,
      // the oncoming lanes in it included.
      for (const [A, B] of wins) {
        if (B - A < 4) continue;
        relax = false;
        solveWindow(A, B);
        let tight = Infinity;
        for (let i = A + 1; i < B; i++) tight = Math.min(tight, this.radiusAt(i));
        if (tight < R_OK) {
          relax = true;
          for (let q = 0; q < TURN_GUARD_STEPS.length && (q === 0 || tight < TURN_GUARD_R); q++) {
            // (Never back to a firmer hold than a stretch overlapping this one came to; NaN stays NaN.)
            for (let i = A; i <= B; i++) hold[i] = Math.min(hold[i], TURN_GUARD_STEPS[q]);
            for (let k = 0; k < TURN_SOLVES; k++) {
              const was = tight;
              solveWindow(A, B);
              tight = Infinity;
              for (let i = A + 1; i < B; i++) tight = Math.min(tight, this.radiusAt(i));
              if (!(tight < TURN_GUARD_R) || !(tight > was + TURN_EASED)) break;
            }
          }
          relax = false;
        }
      }
    }
    // Even out the tightest spots: in the lane's own half up to R_EASY, then using the turn's
    // junction box where still under R_OK.
    this.evenCorners(fixed, badness, dirAt, R_EASY, () => (relax = false));
    this.evenCorners(fixed, badness, dirAt, R_OK, () => (relax = true));
    relax = false;
  }

  /**
   * What is still tighter than `target` after regularize: nudge each corner's tightest sample along its normal
   * (alone, or with its neighbours half as far) while that eases the corner's tightest radius and leaves
   * every point moved no worse off (the junction box of a sharp turn counting as road), a little at a time.
   * The least-bending solve spreads a turn by its total bending; this evens out its tightest spot.
   */
  private evenCorners(
    fixed: Uint8Array,
    badness: (i: number, x: number, y: number, ux: number, uy: number) => number,
    dirAt: (i: number) => [number, number],
    target: number,
    setMode: () => void,
  ): void {
    const n = this.n;
    const X = this.x;
    const Y = this.y;
    const local = (i: number): number => {
      let m = Infinity;
      for (let k = Math.max(1, i - 3); k <= Math.min(n - 2, i + 3); k++) m = Math.min(m, this.radiusAt(k));
      return m;
    };
    setMode();
    // First the whole corner: between samples K either side of its tightest one, a cubic (Hermite) curve
    // along the lane's own directions there, evenly resampled, where every sample it moves stays no worse
    // off and the corner's tightest radius grows.
    const span = (a: number, b: number): number => {
      let m = Infinity;
      for (let k = Math.max(1, a - 1); k <= Math.min(n - 2, b + 1); k++) m = Math.min(m, this.radiusAt(k));
      return m;
    };
    const dense = 24;
    for (let i = 2; i + 2 < n; i++) {
      const r = this.radiusAt(i);
      if (!(r < target) || r > local(i)) continue;
      let best = span(i - 3, i + 3);
      let bestPts: Float64Array | null = null;
      let bestA = 0;
      for (let K = 3; K <= 8; K++) {
        const a = i - K;
        const b = i + K;
        if (a < 1 || b > n - 2) break;
        let blocked = false;
        for (let k = a + 1; k < b; k++) if (fixed[k]) blocked = true;
        if (blocked) break;
        const t0x = X[a] - X[a - 1];
        const t0y = Y[a] - Y[a - 1];
        const t1x = X[b + 1] - X[b];
        const t1y = Y[b + 1] - Y[b];
        const l0 = Math.hypot(t0x, t0y) || 1;
        const l1 = Math.hypot(t1x, t1y) || 1;
        const chord = Math.hypot(X[b] - X[a], Y[b] - Y[a]);
        const was = new Float64Array(b - a + 1);
        for (let k = a + 1; k < b; k++) {
          const [vx, vy] = dirAt(k);
          was[k - a] = badness(k, X[k], Y[k], vx, vy);
        }
        for (const lam of [0.5, 0.75, 1, 1.25, 1.5]) {
          const m0 = (lam * chord) / l0;
          const m1 = (lam * chord) / l1;
          // The curve, densely, then its length along it.
          const cx = new Float64Array(dense * (b - a) + 1);
          const cy = new Float64Array(cx.length);
          const cl = new Float64Array(cx.length);
          for (let q = 0; q < cx.length; q++) {
            const t = q / (cx.length - 1);
            const h00 = 2 * t * t * t - 3 * t * t + 1;
            const h10 = t * t * t - 2 * t * t + t;
            const h01 = -2 * t * t * t + 3 * t * t;
            const h11 = t * t * t - t * t;
            cx[q] = h00 * X[a] + h10 * m0 * t0x + h01 * X[b] + h11 * m1 * t1x;
            cy[q] = h00 * Y[a] + h10 * m0 * t0y + h01 * Y[b] + h11 * m1 * t1y;
            if (q) cl[q] = cl[q - 1] + Math.hypot(cx[q] - cx[q - 1], cy[q] - cy[q - 1]);
          }
          const total = cl[cl.length - 1];
          const pts = new Float64Array(2 * (b - a + 1));
          let q = 0;
          for (let k = 0; k <= b - a; k++) {
            const u = (total * k) / (b - a);
            while (q + 1 < cl.length - 1 && cl[q + 1] < u) q++;
            const f = Math.max(0, Math.min(1, (u - cl[q]) / (cl[q + 1] - cl[q] || 1e-9)));
            pts[2 * k] = cx[q] + (cx[q + 1] - cx[q]) * f;
            pts[2 * k + 1] = cy[q] + (cy[q + 1] - cy[q]) * f;
          }
          const keep = new Float64Array(2 * (b - a + 1));
          for (let k = a; k <= b; k++) {
            keep[2 * (k - a)] = X[k];
            keep[2 * (k - a) + 1] = Y[k];
          }
          for (let k = a + 1; k < b; k++) {
            X[k] = pts[2 * (k - a)];
            Y[k] = pts[2 * (k - a) + 1];
          }
          let ok = true;
          for (let k = a + 1; k < b && ok; k++) {
            const [vx, vy] = dirAt(k);
            if (badness(k, X[k], Y[k], vx, vy) > was[k - a] + 1e-6) ok = false;
          }
          const got = ok ? span(a, b) : -1;
          for (let k = a + 1; k < b; k++) {
            X[k] = keep[2 * (k - a)];
            Y[k] = keep[2 * (k - a) + 1];
          }
          if (got > best + 0.05) {
            best = got;
            bestPts = pts;
            bestA = a;
          }
        }
      }
      if (!bestPts) continue;
      const m = bestPts.length / 2 - 1;
      for (let k = 1; k < m; k++) {
        X[bestA + k] = bestPts[2 * k];
        Y[bestA + k] = bestPts[2 * k + 1];
      }
    }
    // Then what is left, a sample (or a few) at a time.
    // (Offsets from the sample and how far each moves: it alone, it with a neighbour, or a wider bulge.)
    const PATTERNS: [number, number][][] = [
      [[0, 1]],
      [
        [-1, 0.5],
        [0, 1],
        [1, 0.5],
      ],
      [
        [0, 1],
        [1, 1],
      ],
      [
        [-1, 1],
        [0, 1],
      ],
      [
        [-1, 0.5],
        [0, 1],
        [1, 1],
        [2, 0.5],
      ],
      [
        [-2, 0.5],
        [-1, 1],
        [0, 1],
        [1, 0.5],
      ],
      [
        [-2, 0.3],
        [-1, 0.7],
        [0, 1],
        [1, 0.7],
        [2, 0.3],
      ],
    ];
    for (let pass = 0; pass < 40; pass++) {
      let moved = false;
      for (let i = 2; i + 2 < n; i++) {
        const r = this.radiusAt(i);
        if (!(r < target) || fixed[i]) continue;
        const base = local(i);
        if (r > base) continue;
        const [ux, uy] = dirAt(i);
        let best = base;
        let bestStep = 0;
        let bestPat = -1;
        for (let pi = 0; pi < PATTERNS.length; pi++) {
          const pat = PATTERNS[pi];
          if (pat.some(([o]) => i + o < 1 || i + o > n - 2 || fixed[i + o])) continue;
          for (const step of [0.4, -0.4, 0.15, -0.15]) {
            const old = pat.map(([o]) => [X[i + o], Y[i + o]]);
            const was = pat.map(([o]) => {
              const [vx, vy] = dirAt(i + o);
              return badness(i + o, X[i + o], Y[i + o], vx, vy);
            });
            pat.forEach(([o, f]) => {
              X[i + o] += -uy * step * f;
              Y[i + o] += ux * step * f;
            });
            let ok = true;
            pat.forEach(([o], q) => {
              const [vx, vy] = dirAt(i + o);
              if (badness(i + o, X[i + o], Y[i + o], vx, vy) > was[q] + 1e-6) ok = false;
            });
            const got = ok ? local(i) : -1;
            pat.forEach(([o], q) => {
              X[i + o] = old[q][0];
              Y[i + o] = old[q][1];
            });
            if (got > best + 0.02) {
              best = got;
              bestStep = step;
              bestPat = pi;
            }
          }
        }
        if (bestPat < 0) continue;
        for (const [o, f] of PATTERNS[bestPat]) {
          X[i + o] += -uy * bestStep * f;
          Y[i + o] += ux * bestStep * f;
        }
        moved = true;
      }
      if (!moved) break;
    }
  }

  /** Space samples a..b evenly along the lane between them (where that leaves no point worse off). */
  private respace(a: number, b: number, badness: (i: number, x: number, y: number, ux: number, uy: number) => number, dirAt: (i: number) => [number, number]): void {
    if (b - a < 2) return;
    const X = this.x;
    const Y = this.y;
    const m = b - a;
    const cum = new Float64Array(m + 1);
    for (let k = 1; k <= m; k++) cum[k] = cum[k - 1] + Math.hypot(X[a + k] - X[a + k - 1], Y[a + k] - Y[a + k - 1]);
    const total = cum[m];
    if (total < 1) return;
    const nxs = new Float32Array(m + 1);
    const nys = new Float32Array(m + 1);
    let seg = 0;
    for (let k = 0; k <= m; k++) {
      const u = (total * k) / m;
      while (seg + 1 < m && cum[seg + 1] < u) seg++;
      const L = cum[seg + 1] - cum[seg] || 1e-6;
      const t = Math.max(0, Math.min(1, (u - cum[seg]) / L));
      nxs[k] = X[a + seg] + (X[a + seg + 1] - X[a + seg]) * t;
      nys[k] = Y[a + seg] + (Y[a + seg + 1] - Y[a + seg]) * t;
    }
    for (let k = 1; k < m; k++) {
      const [ux, uy] = dirAt(a + k);
      if (badness(a + k, nxs[k], nys[k], ux, uy) > badness(a + k, X[a + k], Y[a + k], ux, uy) + 0.5) return;
    }
    for (let k = 1; k < m; k++) {
      X[a + k] = nxs[k];
      Y[a + k] = nys[k];
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

  /**
   * Nearest point of the lane to (x, y) between route distances `from` and `to`: its route distance and
   * how far (x, y) is from it. (The lane can run well off the GTFS line, e.g. through a station hall.)
   */
  project(x: number, y: number, from: number, to: number): { s: number; dist: number } {
    const i0 = Math.max(0, Math.floor(from / TRACK_STEP));
    const i1 = Math.min(this.n - 2, Math.ceil(to / TRACK_STEP));
    let bd = Infinity;
    let bs = Math.max(0, Math.min(this.length, from));
    for (let i = i0; i <= i1; i++) {
      const ax = this.x[i];
      const ay = this.y[i];
      const dx = this.x[i + 1] - ax;
      const dy = this.y[i + 1] - ay;
      const l2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
      if (d < bd) {
        bd = d;
        bs = (i + t) * TRACK_STEP;
      }
    }
    return { s: bs, dist: bd };
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
