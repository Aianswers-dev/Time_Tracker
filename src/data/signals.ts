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
 * - Phases: arms roughly opposite each other (straight-through flows) share a
 *   phase; every other incoming arm gets one of its own. Crossing or merging
 *   streams are therefore never green together, and every incoming arm has a
 *   green in every cycle: no approach is ever permanently red.
 * - `stateAt` picks the junction (on the asker's level, matching its travel
 *   direction) and the arm pointing back along the travel direction.
 *
 * Pure data (no three.js): the world, the game and node checks use it alike.
 */
import { RoadKind, type MapData, type Road } from '../types';
import { heightsFor } from './height';

export const SIGNAL_AMBER = 3.5;
export const SIGNAL_ALL_RED = 2;

export type Light = 'green' | 'amber' | 'red';

export interface SignalArm {
  /** Unit vector pointing out of the junction (map coords). */
  ux: number;
  uy: number;
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
  /** Phase index (into SignalJunction.phases) of incoming arms, -1 for exits. */
  phase: number;
  /** Stop line distance from the junction centre. */
  stop: number;
  /** Distance from the centre to where the arm goes into a tunnel (Infinity if it doesn't). */
  open: number;
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
/** An approach chord ends where the path comes this close to the junction centre. */
const IN_R = 12;
/** Arms whose direction scores are this close (cos; ~40 degrees apart) are told apart by where we stand. */
const TIE = 0.25;

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
    for (let i = 0; i < ns; i++) {
      const x = sig[2 * i];
      const y = sig[2 * i + 1];
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
      const key = Math.floor(sig[2 * i] / CLUSTER_R) * 65536 + Math.floor(sig[2 * i + 1] / CLUSTER_R);
      let l = ngrid.get(key);
      if (!l) ngrid.set(key, (l = []));
      l.push(i);
    }
    for (let i = 0; i < ns; i++) {
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
      const r = find(i);
      let g = groups.get(r);
      if (!g) groups.set(r, (g = []));
      g.push(i);
    }

    for (const members of groups.values()) {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const m of members) {
        cx += sig[2 * m];
        cy += sig[2 * m + 1];
        cz += nz[m];
      }
      cx /= members.length;
      cy /= members.length;
      cz /= members.length;
      const j = this.buildJunction(roads, geo, segs, cx, cy, cz);
      j.nodes = members;
      const ji = this.junctions.length;
      this.junctions.push(j);
      for (const m of members) this.nodeJunction[m] = ji;
      const key = Math.floor(cx / 60) * 65536 + Math.floor(cy / 60);
      let l = this.grid.get(key);
      if (!l) this.grid.set(key, (l = []));
      l.push(ji);
    }
    this.coordinate();
  }

  private buildJunction(roads: Road[], geo: RoadGeo[], segs: SegGrid, cx: number, cy: number, cz: number): SignalJunction {
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
        found.push({ ux, uy, road: ri, z: q.z, hw: r.width / 2, lanes: r.lanes, oneway: r.oneway, kind: r.kind, incoming, open, name: r.name });
      }
    });
    // Merge arms pointing the same way (the widest road names the arm).
    const arms: (Found & { phase: number; stop: number })[] = [];
    for (const a of found.sort((p, q) => q.hw - p.hw || p.kind - q.kind)) {
      // (within ~30°: the two carriageways of a divided road, a slip lane beside its road)
      const m = arms.find((b) => a.ux * b.ux + a.uy * b.uy > 0.86);
      if (m) {
        m.incoming = m.incoming || a.incoming;
        m.open = Math.min(m.open, a.open);
      } else arms.push({ ...a, phase: -1, stop: 6 });
    }
    // Stop lines clear of the widest other road.
    for (const a of arms) {
      let ds = 6;
      for (const b of arms) if (b !== a) ds = Math.max(ds, b.hw + 2.5);
      a.stop = Math.min(ds, 22);
    }
    // Phases: pair opposite incoming arms (straight through each other), the rest alone.
    // Signals nobody can see (every approach is inside a tunnel, e.g. in an
    // underground bus station, where no heads are drawn) control nothing.
    const inc = arms.filter((a) => a.incoming);
    if (inc.every((a) => a.open < 5)) inc.length = 0;
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
        const green = Math.max(10, (usable * w[pi]) / sum);
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
   * Junctions within COORD_R of each other along a road run one cycle, the
   * green for the road between them starting at the far one as traffic from
   * the near one gets there: a short link is not held full by a red at its
   * far end while its near end is green (busway junction pairs at Buranda,
   * the two halves of a dual-carriageway crossing, offset T junctions).
   */
  private coordinate(): void {
    const J = this.junctions;
    const ok = (j: SignalJunction) => j.phases.length >= 2;
    // The phase at a feeding the road towards b, and the phase at b taking it from a.
    const flow = (a: SignalJunction, b: SignalJunction): { pa: number; pb: number } | null => {
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / d;
      const uy = (b.y - a.y) / d;
      let pa = -1;
      let best = 0.8;
      // (straight on from the arm opposite the one towards b)
      for (const r of a.arms) {
        const c = -(r.ux * ux + r.uy * uy);
        if (r.incoming && r.phase >= 0 && c > best) {
          best = c;
          pa = r.phase;
        }
      }
      let pb = -1;
      best = 0.8;
      for (const r of b.arms) {
        const c = -(r.ux * ux + r.uy * uy);
        if (r.incoming && r.phase >= 0 && c > best) {
          best = c;
          pb = r.phase;
        }
      }
      if (pa < 0) {
        // No straight-on feeder: the road's own arm at a.
        best = 0.8;
        for (const r of a.arms) {
          const c = r.ux * ux + r.uy * uy;
          if (r.incoming && r.phase >= 0 && c > best) {
            best = c;
            pa = r.phase;
          }
        }
      }
      return pa >= 0 && pb >= 0 ? { pa, pb } : null;
    };
    const near = (i: number): number[] => {
      const j = J[i];
      const out: number[] = [];
      const gx = Math.floor(j.x / 60);
      const gy = Math.floor(j.y / 60);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          for (const k of this.grid.get((gx + ox) * 65536 + gy + oy) ?? []) {
            const o = J[k];
            if (k === i || !ok(o) || Math.abs(o.z - j.z) > LEVEL) continue;
            if (Math.hypot(o.x - j.x, o.y - j.y) < COORD_R) out.push(k);
          }
        }
      }
      return out;
    };
    const clear = SIGNAL_AMBER + SIGNAL_ALL_RED;
    const seen = new Uint8Array(J.length);
    for (let root = 0; root < J.length; root++) {
      if (seen[root] || !ok(J[root])) continue;
      // The group: junctions chained within COORD_R that share a road.
      const order = [root];
      const parent = new Map<number, { p: number; pa: number; pb: number }>();
      seen[root] = 1;
      for (let q = 0; q < order.length; q++) {
        const a = order[q];
        for (const b of near(a)) {
          if (seen[b]) continue;
          const f = flow(J[a], J[b]);
          if (!f) continue;
          seen[b] = 1;
          parent.set(b, { p: a, ...f });
          order.push(b);
        }
      }
      if (order.length < 2) continue;
      // One cycle (the longest), every phase's green stretched in proportion.
      const C = Math.max(...order.map((k) => J[k].cycle));
      for (const k of order) {
        const j = J[k];
        if (j.cycle === C) continue;
        const P = j.phases.length;
        const sum = j.phases.reduce((t, ph) => t + ph.green, 0);
        const f = (C - P * clear) / sum;
        let start = 0;
        for (const ph of j.phases) {
          ph.start = start;
          ph.green *= f;
          start += ph.green + clear;
        }
        j.cycle = C;
      }
      // Offsets down the tree: the far end's green starts as traffic from the near end arrives.
      for (const k of order) {
        const e = parent.get(k);
        if (!e) continue;
        const a = J[e.p];
        const b = J[k];
        const delay = Math.hypot(b.x - a.x, b.y - a.y) / 12;
        b.offset = (((b.phases[e.pb].start - a.phases[e.pa].start + a.offset - delay) % C) + C) % C;
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
    let best = -1;
    let bd = -Infinity;
    const hasDir = dirX !== undefined && dirY !== undefined && (dirX !== 0 || dirY !== 0);
    let bx = x - j.x;
    let by = y - j.y;
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
    if (hasDir) for (const a of j.arms) if (a.incoming) top = Math.max(top, -(a.ux * dirX! + a.uy * dirY!));
    j.arms.forEach((a, i) => {
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
   * Approach direction of a path (a route lane) through the junction of the
   * signal node at (x, y): the chord over the 15 m before the path's point
   * nearest the junction centre, whatever the path does after it (a stop
   * line or signal node on the exit arm doesn't matter), and the point 12 m
   * before the junction to ask stateAt from. `at(s, out)` samples the path;
   * `s` is the path distance of the signal. Null when no junction.
   */
  approachDir(x: number, y: number, z: number | undefined, at: (s: number, out: { x: number; y: number }) => unknown, s: number): { dx: number; dy: number; x: number; y: number } | null {
    const ji = this.junctionAt(x, y, undefined, undefined, z);
    if (ji < 0) return null;
    const j = this.junctions[ji];
    const p = { x: 0, y: 0 };
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
    if (a < 0) return null;
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
