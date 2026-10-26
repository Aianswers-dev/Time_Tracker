/**
 * Traffic-signal model shared by the world (signal heads, stop lines) and the
 * game (the player's HUD and autopilot, AI buses and cars): which signal
 * nodes make one junction, its approach arms, its phases and the light every
 * approach shows. One model, so every consumer sees the same light.
 *
 * - Each signal node gets the level of the road it is a vertex of; nodes
 *   within 28 m *on the same level* form one junction (a street crossing over
 *   a motorway, or a busway viaduct over a street, are separate junctions).
 * - Arms are the roads at the junction's level within 24 m: tunnel portal
 *   approaches and pieces shorter than the 16 m probe count too.
 * - Arms a signal node faces (the pipeline's signal direction along its road)
 *   are controlled; an approach no node faces has no light and gives way.
 * - Clusters whose nodes stand more than 28 m apart but face each other's
 *   otherwise uncontrolled arms (a big junction with set-back stop lines) are
 *   one junction.
 * - Phases: controlled arms roughly opposite each other (straight-through
 *   flows) share a phase; every other one gets one of its own. Crossing or
 *   merging controlled streams are therefore never green together, and every
 *   controlled arm has a green in every cycle: none is ever permanently red.
 * - `stateAt` picks the junction (on the asker's level, matching its travel
 *   direction) and the arm pointing back along the travel direction.
 *
 * Pure data (no three.js): the world, the game and node checks use it alike.
 */
import { RoadKind, type MapData, type Road, type Route } from '../types';
import { heightsFor } from './height';

export const SIGNAL_AMBER = 3.5;
export const SIGNAL_ALL_RED = 2;

export type Light = 'green' | 'amber' | 'red';

export interface SignalArm {
  /** Unit vector pointing out of the junction (map coords): the road's own direction. */
  ux: number;
  uy: number;
  /** Where the arm's road passes closest to the junction centre; the stop line is `stop` m from here along u. */
  ox: number;
  oy: number;
  /** Widest road on this arm (index into MapData.roads). */
  road: number;
  /** Road height near the junction (m AHD). */
  z: number;
  hw: number;
  lanes: number;
  oneway: boolean;
  kind: RoadKind;
  /** Traffic can arrive on this arm. */
  incoming: boolean;
  /** Phase index (into SignalJunction.phases) of controlled incoming arms, -1 for exits and arms no signal faces. */
  phase: number;
  /** Stop line distance from (ox, oy) along the arm. */
  stop: number;
  /**
   * Where the arm goes into a tunnel (Infinity if it doesn't): from the centre to the tunnel's nearer
   * end, or 0 where (ox, oy) is that end out on the arm (`mouth`), measured from there.
   */
  open: number;
  /**
   * How far out along the arm from the centre a tunnel the arm runs into has its mapped end, where
   * (ox, oy) is that end (0 otherwise): the SEB under Stanley St (#6401) starts 11 m out from its
   * junction. The stop line keeps its clearance from the centre, and stands at (ox, oy) at the nearest.
   */
  mouth: number;
}

export interface SignalPhase {
  /** Green starts this many seconds into the cycle and lasts `green` s, then amber. */
  start: number;
  green: number;
}

export interface SignalJunction {
  x: number;
  y: number;
  /** Junction level (m AHD). */
  z: number;
  cycle: number;
  offset: number;
  /** Arms; empty when no road meets the signals at their level (the junction controls nothing). */
  arms: SignalArm[];
  phases: SignalPhase[];
  /** Signal node indices (into MapData.signals / 2). */
  nodes: number[];
}

/** The light a phase shows at time t. */
export function phaseLight(j: SignalJunction, phase: number, t: number): Light {
  const p = j.phases[phase];
  if (!p) return 'green';
  const c = j.cycle;
  const tau = (((t + j.offset) % c) + c) % c;
  const d = (((tau - p.start) % c) + c) % c;
  if (d < p.green) return 'green';
  if (d < p.green + SIGNAL_AMBER) return 'amber';
  return 'red';
}

/** Signal nodes this close (and on one level) belong to one junction. */
const CLUSTER_R = 28;
/** Roads this close to the junction centre are its arms. */
const ARM_R = 24;
/** Arm direction: from the centre to a point this far along the road. */
const ARM_PROBE = 16;
/** Levels further apart than this are different junctions. */
const LEVEL = 3.5;
/** stateAt looks for junctions within this radius. */
const PICK_R = 40;
/** Junctions closer than this (centres, m) along a road run coordinated. */
const COORD_R = 70;
/** Weekly bus trips through a phase that count as much as a residential lane (CLASS_W 1) in its green share. */
const BUS_TRIPS_W = 300;
/** Shortest green of a phase (s). */
const MIN_GREEN = 10;
/** Bus-route links: consecutive junctions along a route closer than this run one cycle, offset for the bus flow. */
const ROUTE_COORD_R = 400;
/** An approach chord ends where the path comes this close to the junction centre. */
const IN_R = 12;
/** Arms whose direction scores are this close (cos; ~40 degrees apart) are told apart by where we stand. */
const TIE = 0.25;
/** A signal node controls the arm whose traffic heads its facing way to within this (cos; 60 degrees). */
const FACE = 0.5;
/** A cluster's directed node this close to another cluster's centre may be that junction's signal for an arm. */
const MERGE_R = 60;
/** Clusters merge into one junction only while its nodes stay this close to their centre. */
const MERGE_SPREAD = 36;
/** ... and the node stands within this of the arm's line (m). */
const MERGE_LAT = 8;

const CLASS_W: Partial<Record<RoadKind, number>> = {
  [RoadKind.Motorway]: 3,
  [RoadKind.Trunk]: 3,
  [RoadKind.Primary]: 3,
  [RoadKind.Secondary]: 2.2,
  [RoadKind.Tertiary]: 1.6,
  [RoadKind.Residential]: 1,
  [RoadKind.Busway]: 1.6,
  [RoadKind.Service]: 0.8,
};

function hash01(x: number, y: number, salt: number): number {
  let h = Math.imul(Math.round(x * 4), 73856093) ^ Math.imul(Math.round(y * 4), 19349663) ^ Math.imul(salt, 83492791);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

interface RoadGeo {
  cum: Float32Array;
  len: number;
}

function roadGeo(r: Road): RoadGeo {
  const p = r.pts;
  const n = p.length >> 1;
  const cum = new Float32Array(n);
  for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(p[2 * k] - p[2 * k - 2], p[2 * k + 1] - p[2 * k - 1]);
  return { cum, len: cum[n - 1] };
}

function pointAt(r: Road, g: RoadGeo, s: number): { x: number; y: number; z: number } {
  const p = r.pts;
  const cum = g.cum;
  const n = cum.length;
  let k = 0;
  let hi = n - 1;
  while (hi - k > 1) {
    const m = (k + hi) >> 1;
    if (cum[m] <= s) k = m;
    else hi = m;
  }
  k = Math.max(0, Math.min(n - 2, k));
  const t = Math.max(0, Math.min(1, (s - cum[k]) / (cum[k + 1] - cum[k] || 1e-6)));
  return { x: p[2 * k] + (p[2 * k + 2] - p[2 * k]) * t, y: p[2 * k + 1] + (p[2 * k + 3] - p[2 * k + 1]) * t, z: r.z[k] + (r.z[k + 1] - r.z[k]) * t };
}

/** Projection of (x, y) onto a road: distance along it, distance from it, height there. */
function project(r: Road, g: RoadGeo, x: number, y: number): { s: number; d: number; z: number } {
  const p = r.pts;
  let best = Infinity;
  let bs = 0;
  let bz = 0;
  for (let k = 0; k + 3 < p.length; k += 2) {
    const ax = p[k];
    const ay = p[k + 1];
    const dx = p[k + 2] - ax;
    const dy = p[k + 3] - ay;
    const l2 = dx * dx + dy * dy || 1e-9;
    let t = ((x - ax) * dx + (y - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best) {
      best = d;
      bs = g.cum[k >> 1] + t * Math.sqrt(l2);
      bz = r.z[k >> 1] + (r.z[(k >> 1) + 1] - r.z[k >> 1]) * t;
    }
  }
  return { s: bs, d: best, z: bz };
}

/**
 * The incoming arm (of a junction centred at (cx, cy)) a vehicle at (x, y)
 * travelling (dirX, dirY) arrives on: the arm pointing back along its travel,
 * where it stands breaking near ties. -1 if none.
 */
function pickArm(arms: readonly Pick<SignalArm, 'ux' | 'uy' | 'incoming'>[], cx: number, cy: number, x: number, y: number, dirX?: number, dirY?: number): number {
  let best = -1;
  let bd = -Infinity;
  const hasDir = dirX !== undefined && dirY !== undefined && (dirX !== 0 || dirY !== 0);
  let bx = x - cx;
  let by = y - cy;
  const bl = Math.hypot(bx, by);
  if (bl > 1e-3) {
    bx /= bl;
    by /= bl;
  }
  // Where we stand counts too once we are clearly out on an arm, but only to
  // break ties between arms that point about the way we came (a skewed
  // junction): the centre of a wide or multi-node junction can lie well off
  // the road, and then where we stand says little.
  const w = hasDir ? Math.max(0, Math.min(1, (bl - 4) / 8)) * 0.6 : 1;
  let top = -Infinity;
  if (hasDir) for (const a of arms) if (a.incoming) top = Math.max(top, -(a.ux * dirX! + a.uy * dirY!));
  arms.forEach((a, i) => {
    if (!a.incoming) return;
    // The arm pointing back along our travel, and the arm we stand on.
    const h = hasDir ? -(a.ux * dirX! + a.uy * dirY!) : 0;
    if (h < top - TIE) return;
    const d = h + (bl > 1e-3 ? w * (a.ux * bx + a.uy * by) : -i * 1e-3);
    if (d > bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

/**
 * Where a signal node's light is asked from: 2 m before the node along the
 * traffic it faces (fx, fy), or, for a node far out on a big junction's
 * approach, nearer the centre (so that it is still this junction's).
 */
function nodeAsk(cx: number, cy: number, x: number, y: number, fx: number, fy: number): { x: number; y: number } {
  const ax = x - fx * 2 - cx;
  const ay = y - fy * 2 - cy;
  const c = Math.min(1, 30 / (Math.hypot(ax, ay) || 1));
  return { x: cx + ax * c, y: cy + ay * c };
}

/** Unit direction (vertex order) of the road's segment nearest (x, y). */
function segmentDir(r: Road, x: number, y: number): [number, number] {
  const p = r.pts;
  let best = Infinity;
  let ux = 0;
  let uy = 1;
  for (let k = 0; k + 3 < p.length; k += 2) {
    const dx = p[k + 2] - p[k];
    const dy = p[k + 3] - p[k + 1];
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-6) continue;
    const t = Math.max(0, Math.min(1, ((x - p[k]) * dx + (y - p[k + 1]) * dy) / l2));
    const d = Math.hypot(p[k] + dx * t - x, p[k + 1] + dy * t - y);
    if (d < best) {
      best = d;
      const l = Math.sqrt(l2);
      ux = dx / l;
      uy = dy / l;
    }
  }
  return [ux, uy];
}

/** A directed signal node: where it stands and the way the traffic it faces heads (null if untagged). */
export interface Facing {
  x: number;
  y: number;
  fx: number;
  fy: number;
}

/** The traffic a signal node faces: along its own road, the pipeline's direction (OSM traffic_signals:direction). */
export function nodeFacing(data: MapData, m: number): Facing | null {
  const ri = data.signalRoad?.[m] ?? -1;
  const d = data.signalDir?.[m] ?? 0;
  if (ri < 0 || !d) return null;
  const x = data.signals[2 * m];
  const y = data.signals[2 * m + 1];
  const [rx, ry] = segmentDir(data.roads[ri], x, y);
  return { x, y, fx: rx * d, fy: ry * d };
}

/**
 * The arm (of a junction centred at (cx, cy)) a directed signal node
 * controls: the one its traffic arrives on, asked from where approachDir and
 * stateAt ask it, if that traffic heads in along it. -1 if none.
 */
function facedArm(arms: readonly Pick<SignalArm, 'ux' | 'uy' | 'incoming'>[], cx: number, cy: number, f: Facing): number {
  const q = nodeAsk(cx, cy, f.x, f.y, f.fx, f.fy);
  const i = pickArm(arms, cx, cy, q.x, q.y, f.fx, f.fy);
  return i >= 0 && -(arms[i].ux * f.fx + arms[i].uy * f.fy) > FACE ? i : -1;
}

/** Uniform grid of road segments (all roads, tunnels included). */
class SegGrid {
  private cells = new Map<number, number[]>();
  private stamp: Uint32Array;
  private gen = 1;
  constructor(
    roads: Road[],
    private cell = 32,
  ) {
    this.stamp = new Uint32Array(roads.length);
    roads.forEach((r, ri) => {
      const p = r.pts;
      const pad = r.width / 2;
      for (let k = 0; k + 3 < p.length; k += 2) {
        const x0 = Math.floor((Math.min(p[k], p[k + 2]) - pad) / cell);
        const x1 = Math.floor((Math.max(p[k], p[k + 2]) + pad) / cell);
        const y0 = Math.floor((Math.min(p[k + 1], p[k + 3]) - pad) / cell);
        const y1 = Math.floor((Math.max(p[k + 1], p[k + 3]) + pad) / cell);
        for (let gy = y0; gy <= y1; gy++) {
          for (let gx = x0; gx <= x1; gx++) {
            const key = gx * 65536 + gy;
            let l = this.cells.get(key);
            if (!l) this.cells.set(key, (l = []));
            if (l[l.length - 1] !== ri) l.push(ri);
          }
        }
      }
    });
  }
  /** Each road with a segment's bounding box within r of (x, y), once. */
  roadsNear(x: number, y: number, r: number, fn: (road: number) => void): void {
    const g = ++this.gen;
    const c = this.cell;
    for (let gy = Math.floor((y - r) / c); gy <= Math.floor((y + r) / c); gy++) {
      for (let gx = Math.floor((x - r) / c); gx <= Math.floor((x + r) / c); gx++) {
        for (const ri of this.cells.get(gx * 65536 + gy) ?? []) {
          if (this.stamp[ri] === g) continue;
          this.stamp[ri] = g;
          fn(ri);
        }
      }
    }
  }
}

export class SignalModel {
  readonly junctions: SignalJunction[] = [];
  /** Junction of each signal node (index into junctions). */
  readonly nodeJunction: Int32Array;
  private grid = new Map<number, number[]>();
  /** Per junction: its directed signal nodes, [x, y, fx, fy, ...] with f the way the traffic it faces heads. */
  private faces: Float32Array[] = [];

  constructor(data: MapData) {
    const roads = data.roads;
    const geo = roads.map(roadGeo);
    const segs = new SegGrid(roads);
    const H = heightsFor(data);
    const sig = data.signals;
    const ns = sig.length >> 1;
    this.nodeJunction = new Int32Array(ns).fill(-1);

    // ---- each signal node's level: the road it is a vertex of
    const vkey = (x: number, y: number) => (Math.round(x * 10) + 1048576) * 2097152 + (Math.round(y * 10) + 1048576);
    const want = new Map<number, number>();
    for (let i = 0; i < ns; i++) want.set(vkey(sig[2 * i], sig[2 * i + 1]), i);
    const onVertex: { road: number; z: number }[][] = Array.from({ length: ns }, () => []);
    roads.forEach((r, ri) => {
      const p = r.pts;
      for (let k = 0; k < p.length; k += 2) {
        const i = want.get(vkey(p[k], p[k + 1]));
        if (i !== undefined) onVertex[i].push({ road: ri, z: r.z[k >> 1] });
      }
    });
    const nz = new Float32Array(ns);
    // Signals the pipeline found on paths and cycleways only control no road traffic.
    const sigRoad = data.signalRoad;
    const live = (i: number) => !sigRoad || sigRoad[i] >= 0;
    for (let i = 0; i < ns; i++) {
      const x = sig[2 * i];
      const y = sig[2 * i + 1];
      // (the pipeline's height of the signal's own road, where it gives one)
      if (data.signalZ && sigRoad && sigRoad[i] >= 0) {
        nz[i] = data.signalZ[i];
        continue;
      }
      const veh = onVertex[i].filter((v) => roads[v.road].kind !== RoadKind.Pedestrian);
      const on = veh.length ? veh : onVertex[i];
      if (on.length) {
        // A node shared by roads on one level (or a portal): take the open road's height.
        const open = on.filter((v) => !roads[v.road].tunnel);
        const use = open.length ? open : on;
        nz[i] = use.reduce((a, v) => a + v.z, 0) / use.length;
        continue;
      }
      // Not on any exported road: the nearest vehicle road within 4 m (open roads first), else the ground.
      let best = Infinity;
      let bz = H.ground(x, y);
      segs.roadsNear(x, y, 4, (ri) => {
        const r = roads[ri];
        if (r.kind === RoadKind.Pedestrian) return;
        const q = project(r, geo[ri], x, y);
        const score = q.d + (r.tunnel ? 6 : 0) + (r.bridge ? 3 : 0);
        if (q.d < 4 && score < best) {
          best = score;
          bz = q.z;
        }
      });
      nz[i] = bz;
    }

    // ---- cluster per junction and level
    const parent = new Int32Array(ns).map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const ngrid = new Map<number, number[]>();
    for (let i = 0; i < ns; i++) {
      if (!live(i)) continue;
      const key = Math.floor(sig[2 * i] / CLUSTER_R) * 65536 + Math.floor(sig[2 * i + 1] / CLUSTER_R);
      let l = ngrid.get(key);
      if (!l) ngrid.set(key, (l = []));
      l.push(i);
    }
    for (let i = 0; i < ns; i++) {
      if (!live(i)) continue;
      const x = sig[2 * i];
      const y = sig[2 * i + 1];
      const gx = Math.floor(x / CLUSTER_R);
      const gy = Math.floor(y / CLUSTER_R);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          for (const j of ngrid.get((gx + ox) * 65536 + gy + oy) ?? []) {
            if (j <= i || Math.abs(nz[j] - nz[i]) > LEVEL) continue;
            if (Math.hypot(sig[2 * j] - x, sig[2 * j + 1] - y) < CLUSTER_R) parent[find(j)] = find(i);
          }
        }
      }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < ns; i++) {
      if (!live(i)) continue;
      const r = find(i);
      let g = groups.get(r);
      if (!g) groups.set(r, (g = []));
      g.push(i);
    }

    const centre = (members: readonly number[]) => {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const m of members) {
        cx += sig[2 * m];
        cy += sig[2 * m + 1];
        cz += nz[m];
      }
      return { x: cx / members.length, y: cy / members.length, z: cz / members.length };
    };
    const clusters = [...groups.values()];
    const built = clusters.map((members) => {
      const c = centre(members);
      return this.buildJunction(data, geo, segs, c.x, c.y, c.z, members);
    });

    // ---- one junction over several clusters. Where a junction's stop lines
    // stand further apart than CLUSTER_R (a big junction, or a T whose
    // approach signals are set back, as where the Woolloongabba busway joins
    // the SEB), its nodes fall into separate clusters, each controlling only
    // the arms its own nodes face and running its own phases: streams that
    // cross in the box could be green together. A directed node of one
    // cluster that faces an incoming arm of another, out on that arm within
    // MERGE_R of its centre, where no node of that cluster faces the arm, is
    // that junction's signal for it: the two are one junction (nearest pairs
    // first, while its nodes stay within MERGE_SPREAD of their centre).
    const facing = Array.from({ length: ns }, (_, m) => (live(m) ? nodeFacing(data, m) : null));
    const cgrid = new Map<number, number[]>();
    built.forEach((j, k) => {
      const key = Math.floor(j.x / 60) * 65536 + Math.floor(j.y / 60);
      let l = cgrid.get(key);
      if (!l) cgrid.set(key, (l = []));
      l.push(k);
    });
    const cand: { a: number; b: number; d: number }[] = [];
    built.forEach((A, a) => {
      if (!A.phases.length && !A.arms.length) return;
      const faced = new Set<number>();
      for (const m of clusters[a]) {
        const f = facing[m];
        // (an untagged node controls every arm)
        if (!f) return;
        faced.add(facedArm(A.arms, A.x, A.y, f));
      }
      const gx = Math.floor(A.x / 60);
      const gy = Math.floor(A.y / 60);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          for (const b of cgrid.get((gx + ox) * 65536 + gy + oy) ?? []) {
            if (b === a || Math.abs(built[b].z - A.z) > LEVEL) continue;
            for (const m of clusters[b]) {
              const f = facing[m];
              if (!f) continue;
              const d = Math.hypot(f.x - A.x, f.y - A.y);
              if (d > MERGE_R) continue;
              const i = facedArm(A.arms, A.x, A.y, f);
              if (i < 0 || faced.has(i)) continue;
              const u = A.arms[i];
              const rx = f.x - u.ox;
              const ry = f.y - u.oy;
              if (rx * u.ux + ry * u.uy < 2 || Math.abs(rx * u.uy - ry * u.ux) > MERGE_LAT) continue;
              cand.push({ a, b, d });
            }
          }
        }
      }
    });
    const root = clusters.map((_, k) => k);
    const top = (k: number): number => {
      while (root[k] !== k) k = root[k] = root[root[k]];
      return k;
    };
    const merged = clusters.map((members) => [...members]);
    for (const c of cand.sort((p, q) => p.d - q.d)) {
      const ra = top(c.a);
      const rb = top(c.b);
      if (ra === rb) continue;
      const all = [...merged[ra], ...merged[rb]];
      const m = centre(all);
      if (all.some((n) => Math.hypot(sig[2 * n] - m.x, sig[2 * n + 1] - m.y) > MERGE_SPREAD)) continue;
      root[rb] = ra;
      merged[ra] = all;
    }

    clusters.forEach((_, k) => {
      if (top(k) !== k) return;
      const members = merged[k];
      let j = built[k];
      if (members.length !== clusters[k].length) {
        const c = centre(members);
        j = this.buildJunction(data, geo, segs, c.x, c.y, c.z, members);
      }
      j.nodes = members;
      const ji = this.junctions.length;
      this.junctions.push(j);
      const f: number[] = [];
      for (const m of members) {
        const n = facing[m];
        if (n) f.push(n.x, n.y, n.fx, n.fy);
      }
      this.faces.push(Float32Array.from(f));
      for (const m of members) this.nodeJunction[m] = ji;
      const key = Math.floor(j.x / 60) * 65536 + Math.floor(j.y / 60);
      let l = this.grid.get(key);
      if (!l) this.grid.set(key, (l = []));
      l.push(ji);
    });
    this.coordinate(data.routes);
  }

  private buildJunction(data: MapData, geo: RoadGeo[], segs: SegGrid, cx: number, cy: number, cz: number, nodes: number[]): SignalJunction {
    const roads = data.roads;
    interface Found extends Omit<SignalArm, 'phase' | 'stop'> {
      name?: string;
    }
    const found: Found[] = [];
    segs.roadsNear(cx, cy, ARM_R, (ri) => {
      const r = roads[ri];
      if (r.kind === RoadKind.Pedestrian) return;
      const g = geo[ri];
      const q = project(r, g, cx, cy);
      if (q.d > ARM_R) return;
      // Only roads at the junction's level (not a viaduct overhead or a tunnel below).
      if (Math.abs(q.z - cz) > 3) return;
      // Where a tunnel road starts: the open stretch of this arm ends at its nearer end.
      let open = Infinity;
      if (r.tunnel) {
        const a = pointAt(r, g, 0);
        const b = pointAt(r, g, g.len);
        open = Math.min(Math.hypot(a.x - cx, a.y - cy), Math.hypot(b.x - cx, b.y - cy));
      }
      const p0 = pointAt(r, g, q.s);
      // (the centre beyond the tunnel's end: the arm goes in at p0 itself, out on the arm)
      const atEnd = r.tunnel && (q.s < 0.05 || q.s > g.len - 0.05);
      for (const dir of [1, -1]) {
        // Probe 16 m along the road, or as far as it goes (short links, pieces before a portal).
        const s = Math.max(0, Math.min(g.len, q.s + dir * ARM_PROBE));
        if (Math.abs(s - q.s) < 2.5) continue;
        const pt = pointAt(r, g, s);
        if (Math.hypot(pt.x - cx, pt.y - cy) < 4) continue;
        // The road's own direction from where it passes the centre (the centre of a
        // wide or multi-node junction can lie well off a road).
        let ux = pt.x - p0.x;
        let uy = pt.y - p0.y;
        const l = Math.hypot(ux, uy);
        if (l < 2) continue;
        ux /= l;
        uy /= l;
        const incoming = !r.oneway || dir === -1;
        const mouth = atEnd ? Math.max(0, (p0.x - cx) * ux + (p0.y - cy) * uy) : 0;
        found.push({ ux, uy, ox: p0.x, oy: p0.y, road: ri, z: q.z, hw: r.width / 2, lanes: r.lanes, oneway: r.oneway, kind: r.kind, incoming, open, mouth, name: r.name });
      }
    });
    // Merge arms pointing the same way (the widest road names the arm).
    const arms: (Found & { phase: number; stop: number })[] = [];
    for (const a of found.sort((p, q) => q.hw - p.hw || p.kind - q.kind)) {
      // (within ~30°: the two carriageways of a divided road, a slip lane beside its road)
      const m = arms.find((b) => a.ux * b.ux + a.uy * b.uy > 0.86);
      if (m) {
        // (the stop line and heads go on the incoming carriageway)
        if (!m.incoming && a.incoming) Object.assign(m, { ox: a.ox, oy: a.oy, road: a.road, z: a.z, hw: a.hw, lanes: a.lanes, oneway: a.oneway, mouth: a.mouth });
        m.incoming = m.incoming || a.incoming;
        m.open = Math.min(m.open, a.open);
      } else arms.push({ ...a, phase: -1, stop: 6 });
    }
    // Stop lines clear of the widest other road, measured from the centre: on an arm that goes into a
    // tunnel out on the arm (`mouth`) the line stands that far out, and at the tunnel's mapped end at the
    // nearest, never inside it (SEB #6401 under Stanley St, 11 m out, the street 4 m into the tunnel).
    for (const a of arms) {
      let ds = 6;
      for (const b of arms) if (b !== a) ds = Math.max(ds, b.hw + 2.5);
      a.stop = Math.max(0, Math.min(ds, 22) - a.mouth);
    }
    // The incoming arms the junction's signal nodes face. The pipeline gives each
    // node the road it stands on and the direction of the traffic it faces along
    // that road (OSM traffic_signals:direction): a node controls the arm that
    // traffic arrives on, heading its way, on the node's side of the centre. An
    // arm no node faces has no light (a free slip lane): it gives way in the
    // box as at an unsignalised junction, as the player's guide
    // (src/game/track.ts) shows it no light. Untagged nodes, or map data
    // without directions, control every arm.
    const controlled = new Set<number>();
    for (const m of nodes) {
      const f = nodeFacing(data, m);
      if (!f) {
        arms.forEach((_, i) => controlled.add(i));
        break;
      }
      const i = facedArm(arms, cx, cy, f);
      if (i < 0) continue;
      controlled.add(i);
      // A node well out on its arm (a big junction's set-back stop line): the
      // line where the guide stops for it, 7 m before it (src/game/track.ts),
      // where the arm runs straight out to it.
      const a = arms[i];
      const rx = f.x - a.ox;
      const ry = f.y - a.oy;
      if (Math.abs(rx * a.uy - ry * a.ux) < 4) a.stop = Math.min(40, Math.max(a.stop, rx * a.ux + ry * a.uy - 7));
    }
    // Phases: pair opposite controlled arms (straight through each other), the rest alone.
    // Signals nobody can see (every approach is inside a tunnel, e.g. in an
    // underground bus station, where no heads are drawn) control nothing.
    const inc = arms.filter((a, i) => a.incoming && (controlled.has(i) || !controlled.size));
    if (inc.every((a) => a.open < 5)) inc.length = 0;
    // (an arm that goes into a tunnel at its o does so right there)
    for (const a of arms) if (a.mouth) a.open = 0;
    const pairs: { a: number; b: number; score: number }[] = [];
    for (let i = 0; i < inc.length; i++) {
      for (let k = i + 1; k < inc.length; k++) {
        const opp = -(inc[i].ux * inc[k].ux + inc[i].uy * inc[k].uy);
        if (opp < 0.7) continue;
        const sameRoad = inc[i].name !== undefined && inc[i].name === inc[k].name ? 0.25 : 0;
        const sameKind = inc[i].kind === inc[k].kind ? 0.1 : 0;
        pairs.push({ a: i, b: k, score: opp + sameRoad + sameKind });
      }
    }
    pairs.sort((p, q) => q.score - p.score);
    const groups: number[][] = [];
    const used = new Set<number>();
    for (const p of pairs) {
      if (used.has(p.a) || used.has(p.b)) continue;
      used.add(p.a);
      used.add(p.b);
      groups.push([p.a, p.b]);
    }
    for (let i = 0; i < inc.length; i++) if (!used.has(i)) groups.push([i]);
    const weight = (g: number[]) => Math.max(...g.map((i) => (CLASS_W[inc[i].kind] ?? 0.8) * (inc[i].oneway ? inc[i].lanes : inc[i].lanes / 2 + 0.5)));
    // The main road's phase first.
    groups.sort((p, q) => weight(q) - weight(p));
    groups.forEach((g, pi) => {
      for (const i of g) inc[i].phase = pi;
    });

    const P = groups.length;
    const main = [...arms].sort((p, q) => p.kind - q.kind || q.hw - p.hw)[0];
    const clear = SIGNAL_AMBER + SIGNAL_ALL_RED;
    let cycle: number;
    const phases: SignalPhase[] = [];
    if (P === 0) cycle = 60;
    else if (P === 1) {
      // One stream (a pedestrian crossing, or a junction whose side roads aren't mapped): a walk phase.
      cycle = 60;
      phases.push({ start: 0, green: cycle - 20 });
    } else {
      const majorish = main.kind <= RoadKind.Secondary;
      cycle = Math.min(120, (majorish ? 90 : 70) + (P - 2) * 20);
      const usable = cycle - P * clear;
      const w = groups.map((g) => Math.sqrt(weight(g)));
      const sum = w.reduce((a, b) => a + b, 0);
      let start = 0;
      for (let pi = 0; pi < P; pi++) {
        const green = Math.max(MIN_GREEN, (usable * w[pi]) / sum);
        phases.push({ start, green });
        start += green + clear;
      }
      cycle = Math.max(cycle, start);
    }
    return {
      x: cx,
      y: cy,
      z: cz,
      cycle,
      offset: hash01(cx, cy, 71) * cycle,
      arms: arms.map(({ name: _n, ...a }) => a),
      phases,
      nodes: [],
    };
  }

  /**
   * Junctions within COORD_R of each other run one cycle, the green for the
   * link between them starting at the far one as traffic released at the near
   * one gets there: a short link is not held full by a red at its far end
   * while its near end is green (busway junction pairs at Buranda, the two
   * halves of a dual-carriageway crossing, offset T junctions). The flow a
   * pair is set for is the bus routes' through it (by trips), else the
   * heaviest road feeding the link; a group is a maximum spanning tree.
   * Consecutive junctions along a bus route up to ROUTE_COORD_R apart that
   * run the same cycle are linked the same way: a green wave for the buses.
   * The bus trips through each phase also weigh towards its green share.
   */
  private coordinate(routes: readonly Route[]): void {
    const J = this.junctions;
    const ok = (j: SignalJunction) => j.phases.length >= 2;
    interface Link {
      a: number;
      b: number;
      pa: number;
      pb: number;
      w: number;
    }
    const best = new Map<number, Link>();
    const offer = (l: Link) => {
      const key = Math.min(l.a, l.b) * 65536 + Math.max(l.a, l.b);
      const cur = best.get(key);
      if (!cur || l.w > cur.w) best.set(key, l);
    };
    const near = (x: number, y: number, z: number, r: number): number => {
      let bi = -1;
      let bd = r;
      const gx = Math.floor(x / 60);
      const gy = Math.floor(y / 60);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          for (const k of this.grid.get((gx + ox) * 65536 + gy + oy) ?? []) {
            const j = J[k];
            if (!ok(j) || Math.abs(j.z - z) > LEVEL) continue;
            const d = Math.hypot(j.x - x, j.y - y);
            if (d < bd) {
              bd = d;
              bi = k;
            }
          }
        }
      }
      return bi;
    };

    // ---- the bus routes' flows: consecutive controlled junctions along each route
    const at = (r: Route, s: number, o: { x: number; y: number; z: number }) => {
      const cum = r.cum;
      let lo = 0;
      let hi = cum.length - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (cum[m] <= s) lo = m;
        else hi = m;
      }
      const t = Math.max(0, Math.min(1, (s - cum[lo]) / (cum[hi] - cum[lo] || 1)));
      o.x = r.pts[2 * lo] + (r.pts[2 * hi] - r.pts[2 * lo]) * t;
      o.y = r.pts[2 * lo + 1] + (r.pts[2 * hi + 1] - r.pts[2 * lo + 1]) * t;
      o.z = r.z[lo] + (r.z[hi] - r.z[lo]) * t;
      return o;
    };
    const p = { x: 0, y: 0, z: 0 };
    const q = { x: 0, y: 0, z: 0 };
    const flows = new Map<string, Link>();
    // Bus trips through each junction, by phase.
    const busT = new Map<number, number[]>();
    for (const r of routes) {
      if (r.cum.length < 2) continue;
      // Visits: junction, and the route distance nearest its centre.
      const visits: { j: number; s: number; d: number }[] = [];
      for (let s = 0; s <= r.length; s += 4) {
        at(r, s, p);
        const k = near(p.x, p.y, p.z, 14);
        if (k < 0) continue;
        const d = Math.hypot(J[k].x - p.x, J[k].y - p.y);
        const last = visits[visits.length - 1];
        if (last && last.j === k) {
          if (d < last.d) {
            last.d = d;
            last.s = s;
          }
        } else visits.push({ j: k, s, d });
      }
      // (asked as the guide and the AI buses ask: approachDir, then stateAt's junction and arm)
      const sampler = (s2: number, o: { x: number; y: number }) => {
        at(r, s2, q);
        o.x = q.x;
        o.y = q.y;
      };
      const phaseOf = (v: { j: number; s: number }) => {
        const j = J[v.j];
        const ad = this.approachDir(j.x, j.y, j.z, sampler, v.s);
        if (!ad || this.junctionAt(ad.x, ad.y, ad.dx, ad.dy, j.z) !== v.j) return -1;
        const arm = this.approachArm(v.j, ad.x, ad.y, ad.dx, ad.dy);
        return arm >= 0 ? j.arms[arm].phase : -1;
      };
      const ph = visits.map(phaseOf);
      visits.forEach((v, i) => {
        if (ph[i] < 0) return;
        let t = busT.get(v.j);
        if (!t) busT.set(v.j, (t = new Array<number>(J[v.j].phases.length).fill(0)));
        t[ph[i]] += r.trips;
      });
      for (let i = 1; i < visits.length; i++) {
        const a = visits[i - 1];
        const b = visits[i];
        const dab = Math.hypot(J[a.j].x - J[b.j].x, J[a.j].y - J[b.j].y);
        if (b.s - a.s > ROUTE_COORD_R * 1.4 || dab >= ROUTE_COORD_R) continue;
        // (a long link joins junctions that run the same cycle anyway: one with
        // more phases would stretch a whole corridor's cycle)
        if (dab >= COORD_R && J[a.j].cycle !== J[b.j].cycle) continue;
        const pa = ph[i - 1];
        const pb = ph[i];
        if (pa < 0 || pb < 0) continue;
        // (routes add up per direction and phase pair)
        const fk = `${a.j},${b.j},${pa},${pb}`;
        const f = flows.get(fk);
        if (f) f.w += 100 + r.trips;
        else flows.set(fk, { a: a.j, b: b.j, pa, pb, w: 100 + r.trips });
      }
    }
    for (const f of flows.values()) offer(f);
    const armW = (r: SignalArm) => (CLASS_W[r.kind] ?? 0.8) * (r.oneway ? r.lanes : r.lanes / 2 + 0.5);

    // ---- greens: the buses through a junction count towards their phase's
    // share (bus priority, as on a busway approach), within the same cycle
    for (const [k, bt] of busT) {
      const j = J[k];
      const P = j.phases.length;
      const usable = j.cycle - P * (SIGNAL_AMBER + SIGNAL_ALL_RED + MIN_GREEN);
      if (usable <= 0) continue;
      const w = new Array<number>(P).fill(0);
      for (const a of j.arms) if (a.incoming && a.phase >= 0) w[a.phase] = Math.max(w[a.phase], armW(a));
      const ws = w.map((v, i) => Math.sqrt(v + bt[i] / BUS_TRIPS_W));
      const sum = ws.reduce((t, v) => t + v, 0);
      let st = 0;
      j.phases.forEach((phase, i) => {
        phase.start = st;
        phase.green = MIN_GREEN + (usable * ws[i]) / sum;
        st += phase.green + SIGNAL_AMBER + SIGNAL_ALL_RED;
      });
    }

    // ---- elsewhere: the heaviest road feeding the link (straight on preferred)
    const flow = (ai: number, bi: number): Link | null => {
      const a = J[ai];
      const b = J[bi];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / d;
      const uy = (b.y - a.y) / d;
      let fa: SignalArm | null = null;
      let fw = 0;
      for (const r of a.arms) {
        const c = r.ux * ux + r.uy * uy;
        // (not the link's own arm: its traffic comes from b)
        if (!r.incoming || r.phase < 0 || c > 0.5) continue;
        const w = armW(r) * (1 + Math.max(0, -c));
        if (w > fw) {
          fw = w;
          fa = r;
        }
      }
      let pb = -1;
      let bc = 0.8;
      for (const r of b.arms) {
        const c = -(r.ux * ux + r.uy * uy);
        if (r.incoming && r.phase >= 0 && c > bc) {
          bc = c;
          pb = r.phase;
        }
      }
      return fa && pb >= 0 ? { a: ai, b: bi, pa: fa.phase, pb, w: armW(fa) } : null;
    };
    J.forEach((ja, a) => {
      if (!ok(ja)) return;
      const gx = Math.floor(ja.x / 60);
      const gy = Math.floor(ja.y / 60);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          for (const b of this.grid.get((gx + ox) * 65536 + gy + oy) ?? []) {
            const jb = J[b];
            if (b <= a || !ok(jb) || Math.abs(jb.z - ja.z) > LEVEL || Math.hypot(jb.x - ja.x, jb.y - ja.y) >= COORD_R) continue;
            if (best.has(a * 65536 + b)) continue;
            const f = flow(a, b);
            const r = flow(b, a);
            if (f && (!r || f.w >= r.w)) offer(f);
            else if (r) offer(r);
          }
        }
      }
    });

    // ---- maximum spanning forest
    const links = [...best.values()].sort((x, y) => y.w - x.w);
    const root = new Int32Array(J.length).map((_, i) => i);
    const find = (i: number): number => {
      while (root[i] !== i) {
        root[i] = root[root[i]];
        i = root[i];
      }
      return i;
    };
    const adj = new Map<number, Link[]>();
    for (const l of links) {
      const ra = find(l.a);
      const rb = find(l.b);
      if (ra === rb) continue;
      root[ra] = rb;
      for (const k of [l.a, l.b]) {
        let v = adj.get(k);
        if (!v) adj.set(k, (v = []));
        v.push(l);
      }
    }
    const clear = SIGNAL_AMBER + SIGNAL_ALL_RED;
    const seen = new Uint8Array(J.length);
    for (const first of adj.keys()) {
      if (seen[first]) continue;
      const order = [first];
      seen[first] = 1;
      const via = new Map<number, Link>();
      for (let i = 0; i < order.length; i++) {
        for (const l of adj.get(order[i]) ?? []) {
          const o = l.a === order[i] ? l.b : l.a;
          if (seen[o]) continue;
          seen[o] = 1;
          via.set(o, l);
          order.push(o);
        }
      }
      // One cycle (the longest), every phase's green stretched in proportion.
      const C = Math.max(...order.map((k) => J[k].cycle));
      for (const k of order) {
        const j = J[k];
        if (j.cycle === C) continue;
        const P = j.phases.length;
        const sum = j.phases.reduce((t, ph) => t + ph.green, 0);
        const f = (C - P * clear) / sum;
        let st = 0;
        for (const ph of j.phases) {
          ph.start = st;
          ph.green *= f;
          st += ph.green + clear;
        }
        j.cycle = C;
      }
      // Offsets down the tree: b's green for the link starts as traffic released at a arrives.
      const mod = (v: number) => ((v % C) + C) % C;
      for (const k of order) {
        const l = via.get(k);
        if (!l) continue;
        const a = J[l.a];
        const b = J[l.b];
        const delay = Math.hypot(b.x - a.x, b.y - a.y) / 12;
        if (k === l.b) b.offset = mod(b.phases[l.pb].start - a.phases[l.pa].start + a.offset - delay);
        else a.offset = mod(a.phases[l.pa].start - b.phases[l.pb].start + b.offset + delay);
      }
    }
  }

  /**
   * The junction for a vehicle at (x, y): within 40 m, on its level (with z),
   * the one whose arms fit its travel direction (with dir). -1 if none.
   */
  junctionAt(x: number, y: number, dirX?: number, dirY?: number, z?: number): number {
    let best = -1;
    let bd = Infinity;
    const gx = Math.floor(x / 60);
    const gy = Math.floor(y / 60);
    const hasDir = dirX !== undefined && dirY !== undefined && (dirX !== 0 || dirY !== 0);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const ji of this.grid.get((gx + ox) * 65536 + gy + oy) ?? []) {
          const j = this.junctions[ji];
          let d = Math.hypot(j.x - x, j.y - y);
          if (d > PICK_R) continue;
          if (z !== undefined && Math.abs(j.z - z) > LEVEL) continue;
          if (!j.phases.length) d += 10;
          else if (hasDir) {
            let m = -1;
            for (const a of j.arms) if (a.incoming) m = Math.max(m, -(a.ux * dirX! + a.uy * dirY!));
            if (m < 0.3) d += 15;
          }
          if (d < bd) {
            bd = d;
            best = ji;
          }
        }
      }
    }
    return best;
  }

  /** The incoming arm a vehicle at (x, y) travelling (dirX, dirY) arrives on (-1 if the junction has none). */
  approachArm(ji: number, x: number, y: number, dirX?: number, dirY?: number): number {
    const j = this.junctions[ji];
    return pickArm(j.arms, j.x, j.y, x, y, dirX, dirY);
  }

  /**
   * Approach direction of a path (a route lane) through the junction of the
   * signal node at (x, y), and the point to ask stateAt from. Where the path
   * comes up to one of the junction's signal nodes facing its way (within
   * 9 m, its last 12 m heading within 60 degrees of the node's facing), that
   * node's facing, asked from just before it: the arm the node controls
   * (however the path turns before the centre of a wide junction). Else the
   * chord over the 15 m before the path's point nearest the junction centre,
   * whatever the path does after it (a stop line or signal node on the exit
   * arm doesn't matter), asked 12 m before the junction. `at(s, out)` samples
   * the path; `s` is the path distance of the signal. Null when no junction.
   */
  approachDir(x: number, y: number, z: number | undefined, at: (s: number, out: { x: number; y: number }) => unknown, s: number): { dx: number; dy: number; x: number; y: number } | null {
    const ji = this.junctionAt(x, y, undefined, undefined, z);
    if (ji < 0) return null;
    const j = this.junctions[ji];
    const p = { x: 0, y: 0 };
    const f = this.faces[ji];
    if (f.length) {
      const b = { x: 0, y: 0 };
      for (let q = s - 30; q <= s + 40; q += 1) {
        at(q, p);
        for (let k = 0; k < f.length; k += 4) {
          if (Math.hypot(p.x - f[k], p.y - f[k + 1]) > 9) continue;
          at(q - 12, b);
          const l = Math.hypot(p.x - b.x, p.y - b.y);
          if (l < 1) continue;
          const dx = (p.x - b.x) / l;
          const dy = (p.y - b.y) / l;
          if (dx * f[k + 2] + dy * f[k + 3] <= FACE) continue;
          // (asked as the junction decided which arm the node controls)
          const a = nodeAsk(j.x, j.y, f[k], f[k + 1], f[k + 2], f[k + 3]);
          return { dx: f[k + 2], dy: f[k + 3], x: a.x, y: a.y };
        }
      }
    }
    let sc = s;
    let bd = Infinity;
    for (let q = s - 30; q <= s + 40; q += 1) {
      at(q, p);
      const d = Math.hypot(p.x - j.x, p.y - j.y);
      if (d < bd) {
        bd = d;
        sc = q;
      }
    }
    // The chord ends where the path comes within IN_R of the centre, before
    // any turn it makes inside the junction (the nearest point can be well
    // into a turn when the centre lies off the road).
    let se = sc;
    for (let q = sc; q >= sc - 40; q -= 1) {
      at(q, p);
      if (Math.hypot(p.x - j.x, p.y - j.y) >= IN_R) {
        se = q;
        break;
      }
    }
    at(se - 15, p);
    const ax = p.x;
    const ay = p.y;
    at(se, p);
    const l = Math.hypot(p.x - ax, p.y - ay);
    if (l < 1) return null;
    const dx = (p.x - ax) / l;
    const dy = (p.y - ay) / l;
    at(se - 2, p);
    return { dx, dy, x: p.x, y: p.y };
  }

  /** Light for a vehicle at (x, y) travelling (dirX, dirY) on level z, or null where no signal controls it. */
  stateAt(x: number, y: number, t: number, dirX?: number, dirY?: number, z?: number): Light | null {
    const ji = this.junctionAt(x, y, dirX, dirY, z);
    if (ji < 0) return null;
    const j = this.junctions[ji];
    if (!j.phases.length) return null;
    const a = this.approachArm(ji, x, y, dirX, dirY);
    // (an arm no signal faces has no light)
    if (a < 0 || j.arms[a].phase < 0) return null;
    return phaseLight(j, j.arms[a].phase, t);
  }
}

const models = new WeakMap<MapData, SignalModel>();

/** The shared signal model of a map (built once, ~50 ms). */
export function signalsFor(data: MapData): SignalModel {
  let m = models.get(data);
  if (!m) models.set(data, (m = new SignalModel(data)));
  return m;
}
