// Ambient AI cars: instanced low-poly Aussie traffic (hatches, sedans, SUVs,
// utes, vans and taxis) driving a road graph built from the OSM roads.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoadKind, type BusPose, type MapData, type WorldHandle } from '../types';
import { wrapAngle } from '../data/coords';
import { speedLimitOf } from './roadIndex';
import { PointGrid, type Body } from './bodies';
import { rng } from './util';

const RADIUS = 650;
const DESPAWN = 800;
const VIEW = 600;
const MAX_CARS = 170;

interface Edge {
  pts: Float32Array;
  cum: Float32Array;
  len: number;
  a: number;
  b: number;
  oneway: boolean;
  lanes: number;
  width: number;
  limit: number;
  kind: RoadKind;
  weight: number;
  mx: number;
  my: number;
  /** Stop lines (distance along the directed lane) and signal coordinates, per direction. */
  sig: [number[], number[]];
  sigXY: [number[], number[]];
}

interface Node {
  x: number;
  y: number;
  out: number[];
  deg: number;
  until: number;
  holder: number;
}

interface Car {
  id: number;
  lane: number;
  u: number;
  v: number;
  lat: number;
  laneIdx: number;
  model: number;
  color: THREE.Color;
  next: number;
  vWant: number;
  x: number;
  y: number;
  heading: number;
  len: number;
  braking: boolean;
  sigI: number;
  sigState: 'green' | 'amber' | 'red' | null;
  sigTimer: number;
  stuck: number;
  ghost: number;
  claimed: number;
}

interface Model {
  geo: THREE.BufferGeometry;
  len: number;
  width: number;
  height: number;
  mesh: THREE.InstancedMesh;
  head: THREE.InstancedMesh;
  tail: THREE.InstancedMesh;
  count: number;
}

const INCLUDE = new Set<RoadKind>([RoadKind.Motorway, RoadKind.Trunk, RoadKind.Primary, RoadKind.Secondary, RoadKind.Tertiary, RoadKind.Residential]);
const CLASS_W: Partial<Record<RoadKind, number>> = {
  [RoadKind.Motorway]: 3,
  [RoadKind.Trunk]: 3,
  [RoadKind.Primary]: 3,
  [RoadKind.Secondary]: 2.2,
  [RoadKind.Tertiary]: 1.4,
  [RoadKind.Residential]: 0.35,
};

// Australian car colour mix (white dominates).
const PAINT: [number, number][] = [
  [0xf4f4f2, 30],
  [0xc9ccd0, 14],
  [0x7d838a, 12],
  [0x1d1f22, 11],
  [0x23395d, 6],
  [0x8f1d21, 6],
  [0x2f6fb5, 5],
  [0xd9d2c3, 4],
  [0x3c5a3a, 3],
  [0xe07b22, 2],
  [0xc8a24a, 2],
  [0x6b2a5c, 1],
];

function colorGeo(g: THREE.BufferGeometry, c: number): THREE.BufferGeometry {
  const col = new THREE.Color(c);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([col.r, col.g, col.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (g.index) return g.toNonIndexed();
  return g;
}

/** Low-poly car body: local -Z forward, origin at ground centre. */
function carGeometry(kind: string, L: number, W: number, H: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = 0xffffff;
  const glass = 0x1a2330;
  const dark = 0x161616;
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, c: number) => parts.push(colorGeo(new THREE.BoxGeometry(w, h, d).translate(x, y, z), c));
  const clear = 0.3;
  const lower = H * 0.42;
  box(W, lower, L, 0, clear + lower / 2, 0, body);
  // Bumpers.
  box(W * 0.98, 0.16, 0.12, 0, clear + 0.08, -L / 2 - 0.04, dark);
  box(W * 0.98, 0.16, 0.12, 0, clear + 0.08, L / 2 + 0.04, dark);
  const top = H - clear - lower;
  if (kind === 'ute') {
    const cl = L * 0.36;
    box(W * 0.94, top, cl, 0, clear + lower + top / 2, -L * 0.06, glass);
    box(W * 0.9, 0.06, cl * 0.9, 0, clear + lower + top + 0.03, -L * 0.06, body);
    // Tray rails.
    box(0.08, 0.28, L * 0.38, W / 2 - 0.06, clear + lower + 0.14, L * 0.3, body);
    box(0.08, 0.28, L * 0.38, -W / 2 + 0.06, clear + lower + 0.14, L * 0.3, body);
    box(W, 0.28, 0.08, 0, clear + lower + 0.14, L / 2 - 0.04, body);
    box(0.06, 0.5, 0.06, 0, clear + lower + top + 0.05, L * 0.12, dark);
  } else if (kind === 'van') {
    box(W * 0.96, top, L * 0.8, 0, clear + lower + top / 2, L * 0.09, glass);
    box(W * 0.97, top * 0.55, L * 0.62, 0, clear + lower + top * 0.6, L * 0.17, body);
    box(W * 0.94, 0.05, L * 0.8, 0, clear + lower + top + 0.02, L * 0.09, body);
  } else {
    const cl = kind === 'hatch' ? L * 0.56 : kind === 'suv' ? L * 0.62 : L * 0.46;
    const cz = kind === 'hatch' ? L * 0.14 : kind === 'suv' ? L * 0.1 : L * 0.04;
    box(W * 0.88, top, cl, 0, clear + lower + top / 2, cz, glass);
    box(W * 0.86, 0.05, cl * 0.92, 0, clear + lower + top + 0.02, cz, body);
    if (kind === 'taxi') {
      box(0.62, 0.17, 0.28, 0, clear + lower + top + 0.13, cz, 0xfff4c0);
    }
  }
  // Wheels.
  const r = 0.33;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wgeo = new THREE.CylinderGeometry(r, r, 0.24, 10).rotateZ(Math.PI / 2).translate(sx * (W / 2 - 0.1), r, sz * (L / 2 - 0.8));
      parts.push(colorGeo(wgeo, dark));
    }
  }
  const nonIndexed = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  return mergeGeometries(nonIndexed)!;
}

function lampGeometry(L: number, W: number, y: number, front: boolean): THREE.BufferGeometry {
  const quads: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const g = new THREE.PlaneGeometry(front ? 0.34 : 0.3, front ? 0.16 : 0.13);
    if (front) g.rotateY(Math.PI);
    g.translate(sx * (W / 2 - 0.25), y, front ? -L / 2 - 0.08 : L / 2 + 0.08);
    quads.push(g);
  }
  return mergeGeometries(quads)!;
}

export class CarTraffic {
  private edges: Edge[] = [];
  private nodes: Node[] = [];
  private cars: Car[] = [];
  private models: Model[] = [];
  private rand = rng(777);
  private nextId = 1;
  private candidates: number[] = [];
  private candW: number[] = [];
  private candSum = 0;
  private candTimer = 0;
  private initial = true;
  private busGrid = new PointGrid(8, 1024);
  /** Car positions for buses to avoid. */
  readonly grid = new PointGrid(8, 1024);
  private buckets = new Map<number, Car[]>();
  private maxCars = MAX_CARS;
  private costEma = 0.3;
  private costTimer = 0;
  private sphere = new THREE.Sphere();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v3 = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private headMat: THREE.MeshBasicMaterial;
  private tailMat: THREE.MeshBasicMaterial;
  private tailDay = new THREE.Color(0x5a0a0a);
  private tailNight = new THREE.Color(0xff2a1a);
  private tailBrake = new THREE.Color(0xff5040);
  private lastNight = -1;
  enabled = true;

  constructor(
    readonly scene: THREE.Scene,
    readonly data: MapData,
    readonly world: WorldHandle,
  ) {
    this.buildGraph();
    this.headMat = new THREE.MeshBasicMaterial({ color: 0xfff6dc });
    this.tailMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const defs: [string, number, number, number][] = [
      ['hatch', 4.2, 1.76, 1.5],
      ['sedan', 4.85, 1.83, 1.46],
      ['suv', 4.65, 1.87, 1.72],
      ['ute', 5.35, 1.87, 1.82],
      ['van', 5.3, 1.9, 2.05],
      ['taxi', 4.88, 1.84, 1.48],
    ];
    for (const [kind, L, W, H] of defs) {
      const geo = carGeometry(kind, L, W, H);
      const mesh = new THREE.InstancedMesh(geo, mat, MAX_CARS);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      mesh.frustumCulled = false;
      mesh.count = 0;
      const head = new THREE.InstancedMesh(lampGeometry(L, W, 0.62, true), this.headMat, MAX_CARS);
      head.frustumCulled = false;
      head.count = 0;
      const tail = new THREE.InstancedMesh(lampGeometry(L, W, 0.66, false), this.tailMat, MAX_CARS);
      tail.setColorAt(0, this.tailDay);
      tail.frustumCulled = false;
      tail.count = 0;
      scene.add(mesh, head, tail);
      this.models.push({ geo, len: L, width: W, height: H, mesh, head, tail, count: 0 });
    }
  }

  // -------------------------------------------------------------------------
  // Graph

  private buildGraph(): void {
    const roads = this.data.roads;
    const key = (x: number, y: number) => Math.round(x * 2) * 100003 + Math.round(y * 2);
    const uses = new Map<number, number>();
    const included: number[] = [];
    roads.forEach((r, i) => {
      if (!INCLUDE.has(r.kind) || r.bus || r.tunnel) return;
      included.push(i);
      for (let k = 0; k < r.pts.length; k += 2) {
        const kk = key(r.pts[k], r.pts[k + 1]);
        uses.set(kk, (uses.get(kk) ?? 0) + (k === 0 || k === r.pts.length - 2 ? 1 : 2));
      }
    });
    const nodeOf = new Map<number, number>();
    const node = (x: number, y: number): number => {
      const kk = key(x, y);
      let n = nodeOf.get(kk);
      if (n === undefined) {
        n = this.nodes.length;
        this.nodes.push({ x, y, out: [], deg: 0, until: -1, holder: -1 });
        nodeOf.set(kk, n);
      }
      return n;
    };
    for (const ri of included) {
      const r = roads[ri];
      const p = r.pts;
      let start = 0;
      const nv = p.length / 2;
      for (let v = 1; v < nv; v++) {
        const split = v === nv - 1 || (uses.get(key(p[2 * v], p[2 * v + 1])) ?? 0) >= 3;
        if (!split) continue;
        const pts = p.slice(start * 2, v * 2 + 2);
        start = v;
        const cum = new Float32Array(pts.length / 2);
        for (let k = 1; k < cum.length; k++) cum[k] = cum[k - 1] + Math.hypot(pts[2 * k] - pts[2 * k - 2], pts[2 * k + 1] - pts[2 * k - 1]);
        const len = cum[cum.length - 1];
        if (len < 1) continue;
        const a = node(pts[0], pts[1]);
        const b = node(pts[pts.length - 2], pts[pts.length - 1]);
        const e: Edge = {
          pts,
          cum,
          len,
          a,
          b,
          oneway: r.oneway,
          lanes: Math.max(1, r.lanes),
          width: Math.max(3.4, r.width),
          limit: speedLimitOf(r),
          kind: r.kind,
          weight: len * (CLASS_W[r.kind] ?? 0.3) * (r.link ? 0.3 : 1),
          mx: (pts[0] + pts[pts.length - 2]) / 2,
          my: (pts[1] + pts[pts.length - 1]) / 2,
          sig: [[], []],
          sigXY: [[], []],
        };
        const id = this.edges.length;
        this.edges.push(e);
        this.nodes[a].out.push(id * 2);
        this.nodes[a].deg++;
        this.nodes[b].deg++;
        if (!r.oneway) this.nodes[b].out.push(id * 2 + 1);
      }
    }
    // Signals onto lanes.
    const sg = this.data.signals;
    const grid = new Map<number, number[]>();
    this.edges.forEach((e, i) => {
      const gk = Math.floor(e.mx / 200) * 1000 + Math.floor(e.my / 200);
      let l = grid.get(gk);
      if (!l) grid.set(gk, (l = []));
      l.push(i);
    });
    for (let k = 0; k < sg.length; k += 2) {
      const sx = sg[k];
      const sy = sg[k + 1];
      const gx = Math.floor(sx / 200);
      const gy = Math.floor(sy / 200);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          for (const ei of grid.get((gx + ox) * 1000 + gy + oy) ?? []) {
            const e = this.edges[ei];
            const pr = this.project(e, sx, sy);
            if (pr.d > 7) continue;
            const fwd = pr.s - 6;
            if (fwd > 0 && fwd < e.len) {
              e.sig[0].push(fwd);
              e.sigXY[0].push(sx, sy);
            }
            if (!e.oneway) {
              const back = e.len - pr.s - 6;
              if (back > 0 && back < e.len) {
                e.sig[1].push(back);
                e.sigXY[1].push(sx, sy);
              }
            }
          }
        }
      }
    }
    for (const e of this.edges) {
      for (const d of [0, 1] as const) {
        const order = e.sig[d].map((s, i) => [s, i] as const).sort((x, y) => x[0] - y[0]);
        const s2: number[] = [];
        const xy: number[] = [];
        for (const [s, i] of order) {
          if (s2.length && s - s2[s2.length - 1] < 20) continue;
          s2.push(s);
          xy.push(e.sigXY[d][2 * i], e.sigXY[d][2 * i + 1]);
        }
        e.sig[d] = s2;
        e.sigXY[d] = xy;
      }
    }
  }

  private project(e: Edge, x: number, y: number): { s: number; d: number } {
    let best = Infinity;
    let bs = 0;
    const p = e.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i];
      const ay = p[i + 1];
      const dx = p[i + 2] - ax;
      const dy = p[i + 3] - ay;
      const l2 = dx * dx + dy * dy || 1e-6;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
      if (d < best) {
        best = d;
        bs = e.cum[i / 2] + t * Math.sqrt(l2);
      }
    }
    return { s: bs, d: best };
  }

  /** Point on a directed lane at distance u, shifted `lat` to the left. */
  private at(lane: number, u: number, lat: number, out: { x: number; y: number; hx: number; hy: number }): void {
    const e = this.edges[lane >> 1];
    const rev = (lane & 1) === 1;
    const s = Math.max(0, Math.min(e.len, rev ? e.len - u : u));
    const c = e.cum;
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid;
    }
    const p = e.pts;
    const t = (s - c[lo]) / Math.max(1e-6, c[hi] - c[lo]);
    let hx = p[2 * hi] - p[2 * lo];
    let hy = p[2 * hi + 1] - p[2 * lo + 1];
    const l = Math.hypot(hx, hy) || 1;
    hx /= l;
    hy /= l;
    if (rev) {
      hx = -hx;
      hy = -hy;
    }
    out.x = p[2 * lo] + (p[2 * hi] - p[2 * lo]) * t - hy * lat;
    out.y = p[2 * lo + 1] + (p[2 * hi + 1] - p[2 * lo + 1]) * t + hx * lat;
    out.hx = hx;
    out.hy = hy;
  }

  private laneOffset(lane: number, idx: number): number {
    const e = this.edges[lane >> 1];
    const half = e.width / 2;
    if (e.oneway) {
      const k = Math.min(idx, e.lanes - 1);
      return Math.max(-half + 1.6, half - 1.65 - k * 3.2);
    }
    const per = Math.max(1, Math.floor(e.lanes / 2));
    const k = Math.min(idx, per - 1);
    return Math.max(1.55, half - 1.65 - k * 3.2);
  }

  private lanesIn(lane: number): number {
    const e = this.edges[lane >> 1];
    return e.oneway ? e.lanes : Math.max(1, Math.floor(e.lanes / 2));
  }

  private endNode(lane: number): number {
    const e = this.edges[lane >> 1];
    return lane & 1 ? e.a : e.b;
  }

  private chooseNext(lane: number): number {
    const node = this.nodes[this.endNode(lane)];
    const e = this.edges[lane >> 1];
    const rev = lane & 1;
    // Incoming heading at the node.
    const p = e.pts;
    const n = p.length;
    const [hx, hy] = rev ? [p[0] - p[2], p[1] - p[3]] : [p[n - 2] - p[n - 4], p[n - 1] - p[n - 3]];
    const hIn = Math.atan2(hx, hy);
    let best = -1;
    let sum = 0;
    const opts: [number, number][] = [];
    for (const o of node.out) {
      if (o >> 1 === lane >> 1) continue;
      const oe = this.edges[o >> 1];
      const op = oe.pts;
      const on = op.length;
      const [ox, oy] = o & 1 ? [op[on - 4] - op[on - 2], op[on - 3] - op[on - 1]] : [op[2] - op[0], op[3] - op[1]];
      const turn = Math.abs(wrapAngle(Math.atan2(ox, oy) - hIn));
      const w = (Math.cos(turn) + 1.25) * (CLASS_W[oe.kind] ?? 0.3) * (oe.len < 15 ? 0.6 : 1);
      opts.push([o, w]);
      sum += w;
    }
    if (!opts.length) return e.oneway ? -1 : lane ^ 1;
    let r = this.rand() * sum;
    for (const [o, w] of opts) {
      r -= w;
      if (r <= 0) {
        best = o;
        break;
      }
    }
    return best >= 0 ? best : opts[0][0];
  }

  private turnAngle(from: number, to: number): number {
    if (to < 0) return 0;
    const e = this.edges[from >> 1];
    const p = e.pts;
    const n = p.length;
    const [hx, hy] = from & 1 ? [p[0] - p[2], p[1] - p[3]] : [p[n - 2] - p[n - 4], p[n - 1] - p[n - 3]];
    const oe = this.edges[to >> 1];
    const op = oe.pts;
    const on = op.length;
    const [ox, oy] = to & 1 ? [op[on - 4] - op[on - 2], op[on - 3] - op[on - 1]] : [op[2] - op[0], op[3] - op[1]];
    return wrapAngle(Math.atan2(ox, oy) - Math.atan2(hx, hy));
  }

  // -------------------------------------------------------------------------

  private refreshCandidates(px: number, py: number): void {
    this.candidates.length = 0;
    this.candW.length = 0;
    this.candSum = 0;
    const R2 = RADIUS * RADIUS;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const dx = e.mx - px;
      const dy = e.my - py;
      if (dx * dx + dy * dy > R2) continue;
      this.candidates.push(i);
      this.candW.push(e.weight);
      this.candSum += e.weight;
    }
  }

  private pickPaint(): THREE.Color {
    let total = 0;
    for (const [, w] of PAINT) total += w;
    let r = this.rand() * total;
    for (const [c, w] of PAINT) {
      r -= w;
      if (r <= 0) return new THREE.Color(c);
    }
    return new THREE.Color(PAINT[0][0]);
  }

  private spawn(px: number, py: number, frustum: THREE.Frustum): boolean {
    if (!this.candidates.length) return false;
    let r = this.rand() * this.candSum;
    let ei = this.candidates[0];
    for (let i = 0; i < this.candidates.length; i++) {
      r -= this.candW[i];
      if (r <= 0) {
        ei = this.candidates[i];
        break;
      }
    }
    const e = this.edges[ei];
    const lane = ei * 2 + (!e.oneway && this.rand() < 0.5 ? 1 : 0);
    const u = this.rand() * e.len;
    const laneIdx = Math.floor(this.rand() * this.lanesIn(lane));
    const lat = this.laneOffset(lane, laneIdx);
    const pt = { x: 0, y: 0, hx: 0, hy: 0 };
    this.at(lane, u, lat, pt);
    const d = Math.hypot(pt.x - px, pt.y - py);
    if (d > RADIUS || d < (this.initial ? 30 : 130)) return false;
    if (!this.initial && d < 420) {
      this.sphere.center.set(pt.x, 1, -pt.y);
      this.sphere.radius = 4;
      if (frustum.intersectsSphere(this.sphere)) return false;
    }
    if (this.busGrid.nearest(pt.x, pt.y, 9) >= 0) return false;
    if (this.grid.nearest(pt.x, pt.y, 9) >= 0) return false;
    for (const c of this.cars) if (c.lane === lane && Math.abs(c.u - u) < 10) return false;
    const roll = this.rand();
    const model = roll < 0.22 ? 0 : roll < 0.47 ? 1 : roll < 0.68 ? 2 : roll < 0.85 ? 3 : roll < 0.93 ? 4 : 5;
    let color = this.pickPaint();
    if (model === 5) color = new THREE.Color(this.rand() < 0.55 ? 0xf6c400 : 0xf2f2f0);
    if (model === 3 && this.rand() < 0.4) color = new THREE.Color(0xf4f4f2);
    const c: Car = {
      id: this.nextId++,
      lane,
      u,
      v: Math.min(12, e.limit / 3.6) * (0.5 + this.rand() * 0.4),
      lat,
      laneIdx,
      model,
      color,
      next: -1,
      vWant: 0.88 + this.rand() * 0.2,
      x: pt.x,
      y: pt.y,
      heading: Math.atan2(pt.hx, pt.hy),
      len: this.models[model].len,
      braking: false,
      sigI: 0,
      sigState: null,
      sigTimer: 0,
      stuck: 0,
      ghost: 0,
      claimed: -1,
    };
    const sig = e.sig[lane & 1];
    while (c.sigI < sig.length && sig[c.sigI] < u) c.sigI++;
    this.cars.push(c);
    return true;
  }

  /** Speed of a car within r of (x, y), or -1 if none. */
  probe(x: number, y: number, r: number): number {
    const i = this.grid.nearest(x, y, r);
    return i < 0 ? -1 : this.grid.pv[i];
  }

  update(dt: number, time: number, player: BusPose, playerBody: Body, busBodies: Body[], frustum: THREE.Frustum, cam: THREE.Vector3, hours: number): void {
    const t0 = performance.now();
    if (!this.enabled) {
      for (const m of this.models) m.mesh.count = m.head.count = m.tail.count = 0;
      return;
    }
    const px = player.x;
    const py = player.y;
    // Bus footprints for avoidance.
    const bg = this.busGrid;
    bg.clear();
    for (let k = 0; k < playerBody.n; k++) bg.add(playerBody.x[k], playerBody.y[k], Math.max(0, playerBody.speed), -1);
    busBodies.forEach((b, i) => {
      for (let k = 0; k < b.n; k++) bg.add(b.x[k], b.y[k], b.speed, i);
    });

    this.candTimer -= dt;
    if (this.candTimer <= 0) {
      this.candTimer = 2;
      this.refreshCandidates(px, py);
    }
    // Despawn.
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const d = Math.hypot(c.x - px, c.y - py);
      if (d > DESPAWN || i >= this.maxCars + 6 || c.lane < 0) {
        this.cars[i] = this.cars[this.cars.length - 1];
        this.cars.pop();
      }
    }
    // Spawn.
    const desired = Math.min(this.maxCars, Math.round(this.candSum / 90));
    let tries = this.initial ? 400 : 8;
    let made = 0;
    while (this.cars.length < desired && tries-- > 0 && made < (this.initial ? 200 : 3)) if (this.spawn(px, py, frustum)) made++;
    if (this.initial && this.candidates.length) this.initial = false;

    // Buckets per lane, sorted by u.
    for (const list of this.buckets.values()) list.length = 0;
    for (const c of this.cars) {
      let l = this.buckets.get(c.lane);
      if (!l) this.buckets.set(c.lane, (l = []));
      l.push(c);
    }
    for (const l of this.buckets.values()) if (l.length > 1) l.sort((a, b) => a.u - b.u);

    const pt = { x: 0, y: 0, hx: 0, hy: 0 };
    const signalAt = this.world.signalStateAt;
    for (const c of this.cars) {
      const e = this.edges[c.lane >> 1];
      const remain = e.len - c.u;
      if (c.next < 0 && remain < 60) c.next = this.chooseNext(c.lane);
      const v0 = (e.limit / 3.6) * c.vWant;
      const A = 1.7;
      const B = 2.6;
      const T = 1.15;
      const idm = (gap: number, vLead: number, s0: number) => {
        const sStar = s0 + Math.max(0, c.v * T + (c.v * (c.v - vLead)) / (2 * Math.sqrt(A * B)));
        return A * (1 - Math.pow(c.v / Math.max(1, v0), 4) - (sStar / Math.max(0.05, gap)) ** 2);
      };
      let acc = A * (1 - Math.pow(c.v / Math.max(1, v0), 4));
      // Slow for the turn at the end of the lane.
      if (c.next >= 0 && remain < 50) {
        const turn = Math.abs(this.turnAngle(c.lane, c.next));
        if (turn > 0.5) {
          const vt = 4.5 + 7 * (1 - Math.min(1, turn / 2));
          const need = (c.v * c.v - vt * vt) / (2 * Math.max(4, remain - 3));
          if (need > 0) acc = Math.min(acc, -need * 1.1);
        }
      }
      // Leader on the same lane (and lane index), or on the next lane.
      const list = this.buckets.get(c.lane)!;
      let gap = Infinity;
      let vLead = 0;
      for (let k = list.indexOf(c) + 1; k < list.length; k++) {
        const o = list[k];
        if (o.laneIdx !== c.laneIdx && this.lanesIn(c.lane) > 1) continue;
        gap = o.u - c.u - (o.len + c.len) / 2;
        vLead = o.v;
        break;
      }
      if (gap === Infinity && c.next >= 0) {
        const nl = this.buckets.get(c.next);
        if (nl) {
          for (const o of nl) {
            if (o.laneIdx !== Math.min(c.laneIdx, this.lanesIn(c.next) - 1) && this.lanesIn(c.next) > 1) continue;
            gap = remain + o.u - (o.len + c.len) / 2;
            vLead = o.v;
            break;
          }
        }
      }
      if (gap < 120) acc = Math.min(acc, idm(gap, vLead, 2.2));
      // Buses (AI and player) ahead on the path.
      if (c.ghost <= 0) {
        const look = 6 + c.v * 2.2;
        for (let d = c.len / 2 + 1; d <= look; d += 2.5) {
          this.sampleAhead(c, d, pt);
          const hit = bg.nearest(pt.x, pt.y, 2.1);
          if (hit >= 0) {
            acc = Math.min(acc, idm(d - c.len / 2 - 0.6, bg.pv[hit] * 0.8, 1.5));
            break;
          }
        }
      } else c.ghost -= dt;
      // Signals.
      const sig = e.sig[c.lane & 1];
      if (c.sigI < sig.length) {
        const sgap = sig[c.sigI] - c.u;
        if (sgap < -1) {
          c.sigI++;
          c.sigState = null;
        } else if (signalAt && sgap < 70) {
          c.sigTimer -= dt;
          if (c.sigTimer <= 0 || c.sigState === null) {
            c.sigTimer = 0.3;
            const xy = e.sigXY[c.lane & 1];
            c.sigState = signalAt.call(this.world, xy[2 * c.sigI], xy[2 * c.sigI + 1], time);
          }
          const stopDist = (c.v * c.v) / (2 * 3);
          if (c.sigState === 'red' || (c.sigState === 'amber' && sgap > stopDist + 2)) acc = Math.min(acc, idm(sgap, 0, 0.8));
        }
      }
      // Unsignalised junctions: first come, first served.
      const endN = this.nodes[this.endNode(c.lane)];
      if (!signalAt || !e.sig[c.lane & 1].length) {
        if (endN.deg >= 3 && remain < 14 && c.claimed !== this.endNode(c.lane)) {
          if (endN.until < time || endN.holder === c.lane) {
            endN.until = time + 1.8;
            endN.holder = c.lane;
            c.claimed = this.endNode(c.lane);
          } else acc = Math.min(acc, idm(Math.max(0.1, remain - 4), 0, 0.5));
        }
      }
      acc = Math.max(-7, Math.min(A, acc));
      c.braking = acc < -0.6 || c.v < 0.2;
      c.v = Math.max(0, c.v + acc * dt);
      if (c.v < 0.1) c.stuck += dt;
      else c.stuck = 0;
      if (c.stuck > 14) {
        c.ghost = 3;
        c.stuck = 0;
      }
      c.u += c.v * dt;
      // Advance onto the next lane.
      let guard = 0;
      while (c.u > this.edges[c.lane >> 1].len && guard++ < 4) {
        const over = c.u - this.edges[c.lane >> 1].len;
        if (c.next < 0) c.next = this.chooseNext(c.lane);
        if (c.next < 0) {
          c.lane = -1;
          break;
        }
        c.lane = c.next;
        c.next = -1;
        c.u = over;
        c.sigI = 0;
        c.sigState = null;
        c.claimed = -1;
        c.laneIdx = Math.min(c.laneIdx, this.lanesIn(c.lane) - 1);
      }
      if (c.lane < 0) continue;
      const target = this.laneOffset(c.lane, c.laneIdx);
      c.lat += Math.max(-dt * 1.2, Math.min(dt * 1.2, target - c.lat));
      this.at(c.lane, c.u, c.lat, pt);
      c.x = pt.x;
      c.y = pt.y;
      const h = Math.atan2(pt.hx, pt.hy);
      c.heading += wrapAngle(h - c.heading) * Math.min(1, dt * 7);
    }

    // Car grid for the buses, then render.
    const g = this.grid;
    g.clear();
    for (const c of this.cars) {
      if (c.lane < 0) continue;
      const hx = Math.sin(c.heading);
      const hy = Math.cos(c.heading);
      g.add(c.x + hx * c.len * 0.3, c.y + hy * c.len * 0.3, c.v, c.id);
      g.add(c.x - hx * c.len * 0.3, c.y - hy * c.len * 0.3, c.v, c.id);
    }
    this.render(frustum, cam, hours);

    const cost = performance.now() - t0;
    this.costEma += (cost - this.costEma) * 0.05;
    this.costTimer -= dt;
    if (this.costTimer <= 0) {
      this.costTimer = 1;
      if (this.costEma > 0.8 && this.maxCars > 50) this.maxCars -= 4;
      else if (this.costEma < 0.45 && this.maxCars < MAX_CARS) this.maxCars += 2;
    }
  }

  private sampleAhead(c: Car, d: number, out: { x: number; y: number; hx: number; hy: number }): void {
    const e = this.edges[c.lane >> 1];
    const u = c.u + d;
    if (u <= e.len || c.next < 0) this.at(c.lane, Math.min(u, e.len), c.lat, out);
    else this.at(c.next, Math.min(u - e.len, this.edges[c.next >> 1].len), this.laneOffset(c.next, Math.min(c.laneIdx, this.lanesIn(c.next) - 1)), out);
  }

  private render(frustum: THREE.Frustum, cam: THREE.Vector3, hours: number): void {
    const night = hours < 6.6 || hours > 17.9 ? 1 : 0;
    if (night !== this.lastNight) {
      this.lastNight = night;
      for (const m of this.models) m.head.visible = !!night;
    }
    for (const m of this.models) m.count = 0;
    for (const c of this.cars) {
      if (c.lane < 0) continue;
      const dx = c.x - cam.x;
      const dz = -c.y - cam.z;
      if (dx * dx + dz * dz > VIEW * VIEW) continue;
      this.sphere.center.set(c.x, 1, -c.y);
      this.sphere.radius = 3.2;
      if (!frustum.intersectsSphere(this.sphere)) continue;
      const m = this.models[c.model];
      const i = m.count++;
      this.v3.set(c.x, 0, -c.y);
      this.q.setFromAxisAngle(this.up, -c.heading);
      this.m4.compose(this.v3, this.q, this.one);
      m.mesh.setMatrixAt(i, this.m4);
      m.mesh.setColorAt(i, c.color);
      m.tail.setMatrixAt(i, this.m4);
      m.tail.setColorAt(i, c.braking ? this.tailBrake : night ? this.tailNight : this.tailDay);
      if (night) m.head.setMatrixAt(i, this.m4);
    }
    for (const m of this.models) {
      m.mesh.count = m.count;
      m.tail.count = m.count;
      m.head.count = night ? m.count : 0;
      m.mesh.instanceMatrix.needsUpdate = true;
      if (m.mesh.instanceColor) m.mesh.instanceColor.needsUpdate = true;
      m.tail.instanceMatrix.needsUpdate = true;
      if (m.tail.instanceColor) m.tail.instanceColor.needsUpdate = true;
      if (night) m.head.instanceMatrix.needsUpdate = true;
    }
  }

  get count(): number {
    return this.cars.length;
  }

  dispose(): void {
    for (const m of this.models) {
      m.mesh.removeFromParent();
      m.head.removeFromParent();
      m.tail.removeFromParent();
      m.geo.dispose();
    }
  }
}
