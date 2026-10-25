// Ambient AI cars: instanced low-poly Aussie traffic (hatches, sedans, SUVs,
// utes, vans and taxis) driving a road graph built from the OSM roads.
//
// Junctions are managed, not just signalled: every junction (graph node with
// three or more arms) has a box with a reservation list. A vehicle decides at
// its commit point (the last place it can still stop comfortably at the stop
// line) and only enters when its signal allows it (or it has right of way),
// no conflicting movement holds the box (left-hand-traffic rules: opposing
// right turns cross straight-through traffic, crossing movements always
// conflict, movements into the same exit merge) and its exit has room, so it
// never stops inside the box. AI buses use the same reservations.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoadKind, type BusPose, type MapData, type WorldHandle } from '../types';
import { wrapAngle } from '../data/coords';
import { speedLimitOf } from './roadIndex';
import { PointGrid, type Body } from './bodies';
import { LEVEL_GAP, heightsOf } from './height';
import { TRACK_STEP, type RouteTrack } from './track';
import { rng } from './util';
import { nodeFacing, signalsFor } from '../data/signals';

const VIEW = 600;
/** Reservation id the player's bus holds junction boxes with (AI buses use -id, cars +id). */
export const PLAYER_HOLD = -1e9;
/** Jam breaker: seconds without progress (whatever the reason) before a vehicle is removed, out of view / in view. */
export const STALL_HIDDEN = 75;
export const STALL_VISIBLE = 180;
/** Instance capacity per model (the Normal level keeps ~95 cars). */
const CAPACITY = 110;

/** Why a vehicle is held up (the binding constraint this frame). */
export const enum Wait {
  None = 0,
  Red = 1,
  Player = 2,
  Car = 3,
  Bus = 4,
  Junction = 5,
  Crossing = 6,
}

export const enum Turn {
  Left = 0,
  Straight = 1,
  Right = 2,
}

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
  /** Bus-only (busway, bus road): in the graph for the AI buses' junctions, never driven by cars. */
  bus: boolean;
  weight: number;
  /** Priority class at junctions. */
  rank: number;
  /** Road height (m AHD) at each vertex of `pts`: vehicles on different levels never meet. */
  z: Float32Array;
  mx: number;
  my: number;
  /** Mid-block signals (pedestrian lights): stop-line distance along the directed lane, per direction. */
  sig: [number[], number[]];
  /** Signal node x, y for each entry of `sig`. */
  sigXY: [number[], number[]];
  /** Busway crossings: give-way line distance along the directed lane, per direction. */
  xs: [number[], number[]];
  /** Crossing point x, y, busway direction bx, by and height z for each entry of `xs` (5 numbers each). */
  xsXY: [number[], number[]];
}

interface Occupant {
  id: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
  cls: Turn;
  until: number;
}

interface Node {
  x: number;
  y: number;
  /** Road height at the node (m AHD). */
  z: number;
  out: number[];
  /** Edges touching this node. */
  edges: number[];
  deg: number;
  /** Main-road traffic passing an unsignalised junction marks it busy until this time. */
  until: number;
  holder: number;
  /** Highest road class meeting here (side roads give way to it). */
  rank: number;
  /** A traffic signal controls this junction. */
  sig: boolean;
  /** The directed signal nodes that make it signalised: [x, y, fx, fy, ...], f the way the traffic each faces heads. */
  faces: number[] | null;
  /** Junction box radius from the node, metres. */
  boxR: number;
  occ: Occupant[];
  /** The player's bus approaching (claimApproach), until `until`; null when none. */
  pc: PlayerApproach | null;
}

/** The player's bus heading into a junction: a point on its lane, its direction in, its movement, and seconds until it gets there. */
interface PlayerApproach {
  until: number;
  x: number;
  y: number;
  inX: number;
  inY: number;
  cls: Turn;
  eta: number;
}

/** An oncoming car turning right across the player's bus waits when the bus is this close (s). */
const ONCOMING_GAP = 4.5;

interface Hold {
  node: number;
  /** Distance travelled past the node (-1 until reached). */
  d: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
  cls: Turn;
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
  next2: number;
  vWant: number;
  x: number;
  y: number;
  /** Road height (m AHD) and grade pitch (radians, + = nose up). */
  z: number;
  pitch: number;
  heading: number;
  len: number;
  braking: boolean;
  sigI: number;
  sigState: 'green' | 'amber' | 'red' | null;
  sigTimer: number;
  xsI: number;
  xsCommit: number;
  holds: Hold[];
  /** Seconds held up by a bus (for overtaking on multi-lane roads). */
  busWait: number;
  /** Seconds stationary while not legitimately waiting. */
  idle: number;
  /** Distance driven, the odometer reading at the last progress mark, and seconds since it (jam breaker). */
  odo: number;
  mark: number;
  stall: number;
  /** Legitimately waiting (red light, the player, or a queue behind those). */
  exempt: boolean;
  /** Why it was held up last frame, and by whom (diagnostics). */
  why: Wait;
  ref: number;
  visible: boolean;
  dead: boolean;
}

/** Links between two nodes of one signalised junction shorter than this are inside it (a big junction spans 70 m). */
const INSIDE_LINK = 60;

/** A junction on an AI bus route (for the shared reservations). */
export interface BusJunction {
  node: number;
  x: number;
  y: number;
  /** Route distance of the node and of the bus's stop line. */
  s: number;
  stopS: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
  cls: Turn;
  boxR: number;
  sig: boolean;
  /** The bus arrives from a side road and must give way. */
  minor: boolean;
  /** A second node of the signalised junction entered at the previous one: that node's light holds. */
  inside: boolean;
}

export interface CarStats {
  overlapDespawns: number;
  stuckDespawns: number;
  /** Removed by the jam breaker (no progress for minutes, whatever the reason). */
  stallDespawns: number;
  waitingRed: number;
  waitingJunction: number;
  stationary: number;
}

function classify(turn: number): Turn {
  return turn < -0.6 ? Turn.Left : turn > 0.6 ? Turn.Right : Turn.Straight;
}

/** Do two movements through the same junction box conflict? (left-hand traffic) */
export function movementsConflict(
  aInX: number,
  aInY: number,
  aOutX: number,
  aOutY: number,
  aCls: Turn,
  b: { inX: number; inY: number; outX: number; outY: number; cls: Turn },
): boolean {
  const inDot = aInX * b.inX + aInY * b.inY;
  if (inDot > 0.8) return false; // same approach: lanes and following handle it
  if (aOutX * b.outX + aOutY * b.outY > 0.8) return true; // merging into the same exit
  if (aCls === Turn.Left || b.cls === Turn.Left) return false; // left turns hug the kerb
  if (inDot < -0.8) return (aCls === Turn.Right) !== (b.cls === Turn.Right); // right turn across oncoming
  return true; // crossing paths
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

/** A point on a lane: position, unit direction of travel, road height and grade (rise / run along travel). */
interface LanePt {
  x: number;
  y: number;
  hx: number;
  hy: number;
  z: number;
  g: number;
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
  /** Car positions for buses to avoid (payload = speed, id = car id). */
  readonly grid = new PointGrid(8, 1024);
  private buckets = new Map<number, Car[]>();
  private byId = new Map<number, Car>();
  /**
   * Directed lanes that are short links from one node of a signalised junction
   * to another node of the same junction: the light asked at the first node holds.
   */
  private insideLane: Uint8Array = new Uint8Array(0);
  /** Stop-line distance from the end node for each directed lane (0 = uncontrolled). */
  private stopD: Float32Array = new Float32Array(0);
  /** Junction nodes (3+ arms) on a coarse grid, for mapping bus routes onto them. */
  private nodeGrid = new Map<number, number[]>();
  private busJunctions = new WeakMap<RouteTrack, BusJunction[]>();
  private capCars = 55;
  private radius = 520;
  private maxCars = 55;
  private costEma = 0.3;
  private costTimer = 0;
  private sphere = new THREE.Sphere();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v3 = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private headMat: THREE.MeshBasicMaterial;
  private tailMat: THREE.MeshBasicMaterial;
  private tailDay = new THREE.Color(0x5a0a0a);
  private tailNight = new THREE.Color(0xff2a1a);
  private tailBrake = new THREE.Color(0xff5040);
  private lastNight = -1;
  private pt: LanePt = { x: 0, y: 0, hx: 0, hy: 0, z: 0, g: 0 };
  /** The car whose queue fills a junction exit (set by canGo when it returns Junction for that reason). */
  private blockRef = 0;
  private pt2: LanePt = { x: 0, y: 0, hx: 0, hy: 0, z: 0, g: 0 };
  readonly stats: CarStats = { overlapDespawns: 0, stuckDespawns: 0, stallDespawns: 0, waitingRed: 0, waitingJunction: 0, stationary: 0 };
  /** Id of the holder that made the last boxClear() fail. */
  private boxBy = 0;
  /** Film/test runs: fixed caps (no adaptation to CPU time), so runs are reproducible. */
  fixedCaps = false;
  /** Recent safety-valve events (diagnostics). */
  readonly events: string[] = [];
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
      const mesh = new THREE.InstancedMesh(geo, mat, CAPACITY);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      mesh.frustumCulled = false;
      mesh.count = 0;
      const head = new THREE.InstancedMesh(lampGeometry(L, W, 0.62, true), this.headMat, CAPACITY);
      head.frustumCulled = false;
      head.count = 0;
      const tail = new THREE.InstancedMesh(lampGeometry(L, W, 0.66, false), this.tailMat, CAPACITY);
      tail.setColorAt(0, this.tailDay);
      tail.frustumCulled = false;
      tail.count = 0;
      scene.add(mesh, head, tail);
      this.models.push({ geo, len: L, width: W, height: H, mesh, head, tail, count: 0 });
    }
  }

  /** Density caps (from the traffic level). */
  setCaps(cars: number, radius: number): void {
    this.capCars = Math.min(CAPACITY, cars);
    this.maxCars = Math.min(this.maxCars, this.capCars) || this.capCars;
    this.radius = radius;
    this.candTimer = 0;
    if (cars === 0) for (const c of this.cars) this.kill(c);
  }

  // -------------------------------------------------------------------------
  // Graph

  private buildGraph(): void {
    const roads = this.data.roads;
    const key = (x: number, y: number) => Math.round(x * 2) * 100003 + Math.round(y * 2);
    // Vertex uses per position *and level*: a viaduct passing over a street at
    // the same x/y is not a junction with it.
    const uses = new Map<number, { z: number; n: number }[]>();
    const useAt = (kk: number, z: number) => uses.get(kk)?.find((u) => Math.abs(u.z - z) < LEVEL_GAP);
    const included: number[] = [];
    roads.forEach((r, i) => {
      // Car roads (never service roads: stations, platforms, car parks; nor car
      // tunnels), plus busways and bus roads, also in tunnels: cars never drive
      // those, but where they meet each other or a street the AI buses get the
      // same junction boxes, lights and give-way as everyone else.
      const busOnly = r.bus || r.kind === RoadKind.Busway;
      if (!busOnly && (!INCLUDE.has(r.kind) || r.tunnel)) return;
      included.push(i);
      for (let k = 0; k < r.pts.length; k += 2) {
        const kk = key(r.pts[k], r.pts[k + 1]);
        const add = k === 0 || k === r.pts.length - 2 ? 1 : 2;
        const u = useAt(kk, r.z[k / 2]);
        if (u) u.n += add;
        else {
          let l = uses.get(kk);
          if (!l) uses.set(kk, (l = []));
          l.push({ z: r.z[k / 2], n: add });
        }
      }
    });
    const nodeOf = new Map<number, number[]>();
    const node = (x: number, y: number, z: number): number => {
      const kk = key(x, y);
      let l = nodeOf.get(kk);
      if (!l) nodeOf.set(kk, (l = []));
      const hit = l.find((n) => Math.abs(this.nodes[n].z - z) < LEVEL_GAP);
      if (hit !== undefined) return hit;
      const n = this.nodes.length;
      this.nodes.push({ x, y, z, out: [], edges: [], deg: 0, until: -1, holder: -1, rank: 0, sig: false, faces: null, boxR: 4, occ: [], pc: null });
      l.push(n);
      return n;
    };
    for (const ri of included) {
      const r = roads[ri];
      const p = r.pts;
      let start = 0;
      const nv = p.length / 2;
      for (let v = 1; v < nv; v++) {
        const split = v === nv - 1 || (useAt(key(p[2 * v], p[2 * v + 1]), r.z[v])?.n ?? 0) >= 3;
        if (!split) continue;
        const pts = p.slice(start * 2, v * 2 + 2);
        const zs = r.z.slice(start, v + 1);
        start = v;
        const cum = new Float32Array(pts.length / 2);
        for (let k = 1; k < cum.length; k++) cum[k] = cum[k - 1] + Math.hypot(pts[2 * k] - pts[2 * k - 2], pts[2 * k + 1] - pts[2 * k - 1]);
        const len = cum[cum.length - 1];
        if (len < 1) continue;
        const a = node(pts[0], pts[1], zs[0]);
        const b = node(pts[pts.length - 2], pts[pts.length - 1], zs[zs.length - 1]);
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
          bus: r.bus || r.kind === RoadKind.Busway,
          weight: r.bus || r.kind === RoadKind.Busway ? 0 : len * (CLASS_W[r.kind] ?? 0.3) * (r.link ? 0.3 : 1),
          rank: (CLASS_W[r.kind] ?? 0.3) * (r.link ? 0.5 : 1),
          z: zs,
          mx: (pts[0] + pts[pts.length - 2]) / 2,
          my: (pts[1] + pts[pts.length - 1]) / 2,
          sig: [[], []],
          sigXY: [[], []],
          xs: [[], []],
          xsXY: [[], []],
        };
        const id = this.edges.length;
        this.edges.push(e);
        this.nodes[a].out.push(id * 2);
        if (!r.oneway) this.nodes[b].out.push(id * 2 + 1);
        for (const n of a === b ? [a] : [a, b]) {
          const nd = this.nodes[n];
          nd.deg++;
          nd.edges.push(id);
          nd.rank = Math.max(nd.rank, e.rank);
        }
      }
    }
    // Junction boxes: big enough to clear the widest crossing road.
    for (let n = 0; n < this.nodes.length; n++) {
      const nd = this.nodes[n];
      if (nd.deg < 3) continue;
      let hw = 0;
      for (const ei of nd.edges) hw = Math.max(hw, this.edges[ei].width / 2);
      nd.boxR = Math.max(4, Math.min(16, hw + 2.5));
      const gk = Math.floor(nd.x / 50) * 4096 + Math.floor(nd.y / 50);
      let l = this.nodeGrid.get(gk);
      if (!l) this.nodeGrid.set(gk, (l = []));
      l.push(n);
    }
    // Stop lines per directed lane, where the world paints them: clear of the
    // widest *other* road at the junction.
    this.stopD = new Float32Array(this.edges.length * 2);
    for (let lane = 0; lane < this.edges.length * 2; lane++) {
      const e = this.edges[lane >> 1];
      if (e.oneway && lane & 1) continue;
      const n = this.endNode(lane);
      const nd = this.nodes[n];
      if (nd.deg < 3 || e.len < 6) continue;
      let hw = 0;
      for (const ei of nd.edges) if (ei !== lane >> 1) hw = Math.max(hw, this.edges[ei].width / 2);
      this.stopD[lane] = Math.max(3.5, Math.min(Math.min(18, hw + 2.5), e.len - 2));
    }
    // Lanes that converge at a shallow angle meet before the node: hold them further back.
    const incoming = new Map<number, number[]>();
    for (let lane = 0; lane < this.edges.length * 2; lane++) {
      if (!this.stopD[lane]) continue;
      const n = this.endNode(lane);
      let l = incoming.get(n);
      if (!l) incoming.set(n, (l = []));
      l.push(lane);
    }
    for (const lanes of incoming.values()) {
      for (const a of lanes) {
        const [ax, ay] = this.laneEndDir(a);
        for (const b of lanes) {
          if (b >> 1 === a >> 1) continue;
          const [bx, by] = this.laneEndDir(b);
          const cos = ax * bx + ay * by;
          if (cos < 0.82) continue;
          const sin = Math.max(0.08, Math.sqrt(Math.max(0, 1 - cos * cos)));
          const need = Math.min(25, 2.6 / sin + 2);
          const e = this.edges[a >> 1];
          this.stopD[a] = Math.max(this.stopD[a], Math.min(need, e.len - 2));
        }
      }
    }
    // Signals: those near a junction control the junction; the rest are
    // mid-block (pedestrian) lights with their own stop line on the lane.
    const sg = this.data.signals;
    const edgeGrid = new Map<number, number[]>();
    this.edges.forEach((e, i) => {
      const gk = Math.floor(e.mx / 200) * 1000 + Math.floor(e.my / 200);
      let l = edgeGrid.get(gk);
      if (!l) edgeGrid.set(gk, (l = []));
      l.push(i);
    });
    const H = heightsOf(this.data);
    // Every graph node of a signalised junction is controlled (a dual-carriageway
    // crossing is several nodes, and a light is not always nearest its own node):
    // the nodes on the junction's level close to one of its signal nodes, or to
    // its centre (in the middle of a big junction whose stop lines stand well
    // back, so a path through it meets no unsignalised node between two of its
    // nodes, and is inside it at the second: below).
    for (const j of signalsFor(this.data).junctions) {
      if (!j.phases.length) continue;
      for (const k of [...j.nodes, -1]) {
        const sx = k < 0 ? j.x : sg[2 * k];
        const sy = k < 0 ? j.y : sg[2 * k + 1];
        const near = k < 0 ? 6 : 10;
        const f = k < 0 ? null : nodeFacing(this.data, k);
        const gx = Math.floor(sx / 50);
        const gy = Math.floor(sy / 50);
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            for (const n of this.nodeGrid.get((gx + ox) * 4096 + gy + oy) ?? []) {
              const nd = this.nodes[n];
              if (Math.abs(nd.z - j.z) > LEVEL_GAP || Math.hypot(nd.x - sx, nd.y - sy) >= nd.boxR + near) continue;
              nd.sig = true;
              if (f) (nd.faces ??= []).push(f.x, f.y, f.fx, f.fy);
            }
          }
        }
      }
    }
    for (let k = 0; k < sg.length; k += 2) {
      const sx = sg[k];
      const sy = sg[k + 1];
      // Signals stand at street level: they control only roads at that level.
      const sz = H.surfaceAt(sx, sy).z;
      const jn = this.nearestJunction(sx, sy, 30, sz);
      if (jn >= 0 && Math.hypot(this.nodes[jn].x - sx, this.nodes[jn].y - sy) < this.nodes[jn].boxR + 14) {
        this.nodes[jn].sig = true;
        continue;
      }
      const gx = Math.floor(sx / 200);
      const gy = Math.floor(sy / 200);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          for (const ei of edgeGrid.get((gx + ox) * 1000 + gy + oy) ?? []) {
            const e = this.edges[ei];
            if (e.bus) continue;
            const pr = this.project(e, sx, sy);
            if (pr.d > 7 || Math.abs(this.zAlong(e, pr.s) - sz) > LEVEL_GAP) continue;
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
    this.buildBuswayCrossings(edgeGrid);
    // (The junction each end asks its light of, as signalFor asks it.)
    this.insideLane = new Uint8Array(this.edges.length * 2);
    for (let lane = 0; lane < this.edges.length * 2; lane++) {
      const e = this.edges[lane >> 1];
      if (e.len >= INSIDE_LINK || (e.oneway && lane & 1)) continue;
      const a = lane & 1 ? e.b : e.a;
      const n = this.endNode(lane);
      if (!this.nodes[a].sig || !this.nodes[n].sig) continue;
      const [sx, sy] = this.laneStartDir(lane);
      const [ex, ey] = this.laneEndDir(lane);
      const ja = this.signalJunction(a, sx, sy);
      if (ja >= 0 && ja === this.signalJunction(n, ex, ey)) this.insideLane[lane] = 1;
    }
  }

  /**
   * Where a car road crosses a busway at grade, cars give way to buses. Only
   * real crossings (the busway goes on across the road): where a busway or
   * bus road merely starts or ends on a street the junction box handles it.
   */
  private buildBuswayCrossings(edgeGrid: Map<number, number[]>): void {
    const roads = this.data.roads;
    const isBus = (r: (typeof roads)[number]) => r.bus || r.kind === RoadKind.Busway;
    // Bus roads by end point, to follow a busway across a node where OSM splits it.
    const ends = new Map<number, number[]>();
    const ek = (x: number, y: number) => Math.round(x) * 100003 + Math.round(y);
    roads.forEach((r, i) => {
      if (!isBus(r)) return;
      for (const k of [0, r.pts.length - 2]) {
        const kk = ek(r.pts[k], r.pts[k + 1]);
        let l = ends.get(kk);
        if (!l) ends.set(kk, (l = []));
        l.push(i);
      }
    });
    // Does the bus road ri (and any bus road joined to it near X, Y) reach at
    // least 2.5 m to both sides of the line through (X, Y) along (dx, dy)?
    const crossesBoth = (ri: number, X: number, Y: number, dx: number, dy: number, Z: number): boolean => {
      const set = new Set<number>([ri]);
      const r0 = roads[ri];
      for (const k of [0, r0.pts.length - 2]) {
        if (Math.hypot(r0.pts[k] - X, r0.pts[k + 1] - Y) > 14) continue;
        for (const q of ends.get(ek(r0.pts[k], r0.pts[k + 1])) ?? []) set.add(q);
      }
      const l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l;
      const ny = dx / l;
      let pos = false;
      let neg = false;
      for (const q of set) {
        const r = roads[q];
        const p = r.pts;
        for (let i = 0; i + 3 < p.length; i += 2) {
          const sl = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
          const n = Math.max(1, Math.ceil(sl / 2));
          for (let k = 0; k <= n; k++) {
            const t = k / n;
            const x = p[i] + (p[i + 2] - p[i]) * t;
            const y = p[i + 1] + (p[i + 3] - p[i + 1]) * t;
            if (Math.hypot(x - X, y - Y) > 12) continue;
            const z = r.z[i / 2] + (r.z[i / 2 + 1] - r.z[i / 2]) * t;
            if (Math.abs(z - Z) > 1.5) continue;
            const side = (x - X) * nx + (y - Y) * ny;
            if (side > 2.5) pos = true;
            if (side < -2.5) neg = true;
            if (pos && neg) return true;
          }
        }
      }
      return false;
    };
    for (let ri = 0; ri < roads.length; ri++) {
      const r = roads[ri];
      if (!isBus(r)) continue;
      const p = r.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i];
        const ay = p[i + 1];
        const bx = p[i + 2];
        const by = p[i + 3];
        const za = r.z[i / 2];
        const zb = r.z[i / 2 + 1];
        const blen = Math.hypot(bx - ax, by - ay);
        if (blen < 0.1) continue;
        const gx0 = Math.floor(Math.min(ax, bx) / 200) - 1;
        const gx1 = Math.floor(Math.max(ax, bx) / 200) + 1;
        const gy0 = Math.floor(Math.min(ay, by) / 200) - 1;
        const gy1 = Math.floor(Math.max(ay, by) / 200) + 1;
        for (let gx = gx0; gx <= gx1; gx++) {
          for (let gy = gy0; gy <= gy1; gy++) {
            for (const ei of edgeGrid.get(gx * 1000 + gy) ?? []) {
              const e = this.edges[ei];
              if (e.bus) continue;
              const q = e.pts;
              for (let k = 0; k + 3 < q.length; k += 2) {
                const cx = q[k];
                const cy = q[k + 1];
                const dx = q[k + 2] - cx;
                const dy = q[k + 3] - cy;
                const ex = bx - ax;
                const ey = by - ay;
                const den = dx * ey - dy * ex;
                if (Math.abs(den) < 1e-6) continue;
                const t = ((ax - cx) * ey - (ay - cy) * ex) / den;
                const s = ((ax - cx) * dy - (ay - cy) * dx) / den;
                if (t < 0 || t > 1 || s < 0 || s > 1) continue;
                // Only where the two really meet (not a busway viaduct or tunnel crossing the street).
                const zc = e.z[k / 2] + (e.z[k / 2 + 1] - e.z[k / 2]) * t;
                const zw = za + (zb - za) * s;
                if (Math.abs(zc - zw) >= 1.5) continue;
                const along = e.cum[k / 2] + t * Math.hypot(dx, dy);
                const X = cx + dx * t;
                const Y = cy + dy * t;
                if (!crossesBoth(ri, X, Y, dx, dy, zw)) continue;
                // At a signalised crossing the light decides (the busway is in the
                // junction's box): a give-way line there held cars inside the box
                // while the bus waited for the box to clear (Cultural Centre).
                const nj = this.nearestJunction(X, Y, 14, zw);
                if (nj >= 0 && this.nodes[nj].sig) continue;
                const fwd = along - 5;
                if (fwd > 0) {
                  e.xs[0].push(fwd);
                  e.xsXY[0].push(X, Y, ex / blen, ey / blen, zw);
                }
                if (!e.oneway && e.len - along - 5 > 0) {
                  e.xs[1].push(e.len - along - 5);
                  e.xsXY[1].push(X, Y, ex / blen, ey / blen, zw);
                }
              }
            }
          }
        }
      }
    }
    for (const e of this.edges) {
      for (const d of [0, 1] as const) {
        const order = e.xs[d].map((s, i) => [s, i] as const).sort((x, y) => x[0] - y[0]);
        const s2: number[] = [];
        const xy: number[] = [];
        for (const [s, i] of order) {
          // One give-way line per crossing (segments meeting at the crossing node both hit it).
          if (s2.length && s - s2[s2.length - 1] < 3) continue;
          s2.push(s);
          xy.push(...e.xsXY[d].slice(i * 5, i * 5 + 5));
        }
        e.xs[d] = s2;
        e.xsXY[d] = xy;
      }
    }
  }

  /** Nearest junction node within r of (x, y) on the level of z (any level without z), or -1. */
  private nearestJunction(x: number, y: number, r: number, z?: number): number {
    let best = -1;
    let bd = r;
    const gx = Math.floor(x / 50);
    const gy = Math.floor(y / 50);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (const n of this.nodeGrid.get((gx + ox) * 4096 + gy + oy) ?? []) {
          if (z !== undefined && Math.abs(this.nodes[n].z - z) > LEVEL_GAP) continue;
          const d = Math.hypot(this.nodes[n].x - x, this.nodes[n].y - y);
          if (d < bd) {
            bd = d;
            best = n;
          }
        }
      }
    }
    return best;
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

  /** Road height at distance s along an edge (from its `a` end). */
  private zAlong(e: Edge, s: number): number {
    const c = e.cum;
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid;
    }
    const t = Math.max(0, Math.min(1, (s - c[lo]) / Math.max(1e-6, c[hi] - c[lo])));
    return e.z[lo] + (e.z[hi] - e.z[lo]) * t;
  }

  /** Point on a directed lane at distance u, shifted `lat` to the left. */
  private at(lane: number, u: number, lat: number, out: LanePt): void {
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
    const z = e.z;
    out.z = z[lo] + (z[hi] - z[lo]) * t;
    const g = (z[hi] - z[lo]) / l;
    out.g = rev ? -g : g;
  }

  /**
   * Lateral offset (left of the centreline) of lane `idx` (0 = kerb lane).
   * Lanes are spread evenly over the space the road really has, so two lanes
   * never share an offset even where OSM claims more lanes than fit.
   */
  private laneOffset(lane: number, idx: number): number {
    const e = this.edges[lane >> 1];
    const half = e.width / 2;
    const n = this.lanesIn(lane);
    const k = Math.min(idx, n - 1);
    const outer = half - 1.6;
    const inner = e.oneway ? -outer : Math.min(outer, 1.55);
    if (n <= 1) return e.oneway ? Math.max(0, outer) : Math.max(1.55, outer);
    const step = Math.min(3.2, (outer - inner) / (n - 1));
    return outer - k * step;
  }

  /** Usable lanes in this direction (what fits at ~2.7 m spacing). */
  private lanesIn(lane: number): number {
    const e = this.edges[lane >> 1];
    const half = e.width / 2;
    if (e.oneway) return Math.max(1, Math.min(e.lanes, 1 + Math.floor((2 * half - 3.2) / 2.7)));
    return Math.max(1, Math.min(Math.floor(e.lanes / 2), 1 + Math.floor((half - 3.15) / 2.7)));
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
      if (oe.bus) continue;
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
  // Junction reservations (shared with the AI buses)

  /** Unit direction of travel at the end of a lane (into its end node). */
  private laneEndDir(lane: number): [number, number] {
    const e = this.edges[lane >> 1];
    const p = e.pts;
    const n = p.length;
    let dx: number;
    let dy: number;
    if (lane & 1) {
      dx = p[0] - p[2];
      dy = p[1] - p[3];
    } else {
      dx = p[n - 2] - p[n - 4];
      dy = p[n - 1] - p[n - 3];
    }
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }

  /** Unit direction of travel at the start of a lane (out of its start node). */
  private laneStartDir(lane: number): [number, number] {
    const e = this.edges[lane >> 1];
    const p = e.pts;
    const n = p.length;
    let dx: number;
    let dy: number;
    if (lane & 1) {
      dx = p[n - 4] - p[n - 2];
      dy = p[n - 3] - p[n - 1];
    } else {
      dx = p[2] - p[0];
      dy = p[3] - p[1];
    }
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }

  /** The signal-model junction (src/data/signals.ts) a vehicle travelling (dirX, dirY) into `node` asks, or -1. */
  signalJunction(node: number, dirX: number, dirY: number): number {
    const nd = this.nodes[node];
    if (!nd.sig) return -1;
    return signalsFor(this.data).junctionAt(nd.x - dirX * 10, nd.y - dirY * 10, dirX, dirY, nd.z);
  }

  /**
   * Signal state for a vehicle travelling (dirX, dirY) into junction `node`
   * (and on out (outX, outY), if given), or null if unsignalised. A node
   * signalised by a signal standing further on, that the movement turns away
   * from before reaching it (a slip lane, a busway branching off before the
   * stop line), has no light for it: the guide shows the player none there.
   */
  signalFor(node: number, dirX: number, dirY: number, time: number, outX?: number, outY?: number): 'green' | 'amber' | 'red' | null {
    const nd = this.nodes[node];
    if (!nd.sig || !this.world.signalStateAt) return null;
    if (outX !== undefined && outY !== undefined && this.turnsOffBefore(nd, dirX, dirY, outX, outY)) return null;
    // Asked from a point on the approach, on the node's level (src/data/signals.ts).
    return this.world.signalStateAt(nd.x - dirX * 10, nd.y - dirY * 10, time, dirX, dirY, nd.z);
  }

  /** Do all the signals facing this movement into `nd` stand further on, off its way out? */
  private turnsOffBefore(nd: Node, inX: number, inY: number, outX: number, outY: number): boolean {
    const f = nd.faces;
    if (!f) return false;
    let facing = false;
    for (let k = 0; k < f.length; k += 4) {
      if (f[k + 2] * inX + f[k + 3] * inY <= 0.5) continue;
      const rx = f[k] - nd.x;
      const ry = f[k + 1] - nd.y;
      // (one at or before the node is the light we stop for here)
      if (rx * inX + ry * inY < nd.boxR) return false;
      // (heading on past it: the node lies on our way out)
      const on = rx * outX + ry * outY;
      if (on > 0 && (Math.abs(rx * outY - ry * outX) < 5 || on > 0.9 * Math.hypot(rx, ry))) return false;
      facing = true;
    }
    return facing;
  }

  /** Is the box clear of movements that conflict with this one? (Expired holders are dropped.) */
  boxClear(node: number, id: number, inX: number, inY: number, outX: number, outY: number, cls: Turn, time: number): boolean {
    const nd = this.nodes[node];
    let w = 0;
    for (let i = 0; i < nd.occ.length; i++) {
      const o = nd.occ[i];
      if (o.until >= time) nd.occ[w++] = o;
    }
    nd.occ.length = w;
    for (const o of nd.occ) {
      if (o.id !== id && movementsConflict(inX, inY, outX, outY, cls, o)) {
        this.boxBy = o.id;
        return false;
      }
    }
    return true;
  }

  /** The holder that made the last boxClear() fail (PLAYER_HOLD for the player's bus). */
  get boxBlocker(): number {
    return this.boxBy;
  }

  /** Reserve the box for a movement until `until` (refreshes an existing hold). */
  enter(node: number, id: number, inX: number, inY: number, outX: number, outY: number, cls: Turn, until: number): void {
    const nd = this.nodes[node];
    const o = nd.occ.find((x) => x.id === id);
    if (o) o.until = Math.max(o.until, until);
    else nd.occ.push({ id, inX, inY, outX, outY, cls, until });
  }

  leave(node: number, id: number): void {
    const occ = this.nodes[node].occ;
    const i = occ.findIndex((o) => o.id === id);
    if (i >= 0) occ.splice(i, 1);
  }

  /** Unsignalised junction: a side-road vehicle must wait while main-road traffic is passing. */
  giveWayBusy(node: number, minor: boolean, time: number): boolean {
    const nd = this.nodes[node];
    return !nd.sig && minor && nd.until > time;
  }

  /**
   * The player's bus is heading into `node` (lane point (x, y), direction (inX, inY), movement cls,
   * there in `eta` s), until `until`: cars on the same approach do not turn across its lane in front
   * of it, and oncoming cars do not turn right across its path when it is close.
   */
  claimApproach(node: number, x: number, y: number, inX: number, inY: number, cls: Turn, eta: number, until: number): void {
    const nd = this.nodes[node];
    if (nd.pc) Object.assign(nd.pc, { until, x, y, inX, inY, cls, eta });
    else nd.pc = { until, x, y, inX, inY, cls, eta };
  }

  /** Main-road vehicle approaching an unsignalised junction: mark it busy. */
  markMajor(node: number, time: number, holder: number): void {
    const nd = this.nodes[node];
    if (nd.sig) return;
    nd.until = time + 1.6;
    nd.holder = holder;
  }

  /** A slow car within r of (x, y) on the level of z (an exit that is not clear). */
  slowCarNear(x: number, y: number, r: number, z?: number): boolean {
    const i = this.grid.nearest(x, y, r, undefined, z);
    return i >= 0 && this.grid.pv[i] < 2;
  }

  /** Junctions an AI bus route passes through, in route order (cached per track). */
  junctionsAlong(track: RouteTrack): BusJunction[] {
    const cached = this.busJunctions.get(track);
    if (cached) return cached;
    const best = new Map<number, { i: number; d: number }>();
    for (let i = 0; i < track.n; i++) {
      // Only junctions on the route's level (not the street under a busway viaduct).
      const n = this.nearestJunction(track.x[i], track.y[i], 7, track.z[i]);
      if (n < 0) continue;
      const d = Math.hypot(this.nodes[n].x - track.x[i], this.nodes[n].y - track.y[i]);
      const cur = best.get(n);
      if (!cur || d < cur.d) best.set(n, { i, d });
    }
    const out: BusJunction[] = [];
    const clampI = (i: number) => Math.max(0, Math.min(track.n - 1, i));
    const list = [...best].sort((a, b) => a[1].i - b[1].i);
    list.forEach(([n, { i }], k) => {
      const nd = this.nodes[n];
      const s = i * TRACK_STEP;
      // Directions in and out over up to 12 m, but not past halfway to the
      // previous / next junction node (a turn there is not this node's movement).
      const back = k > 0 ? Math.max(3, Math.min(12, ((i - list[k - 1][1].i) * TRACK_STEP) / 2)) : 12;
      const fwd = k + 1 < list.length ? Math.max(3, Math.min(12, ((list[k + 1][1].i - i) * TRACK_STEP) / 2)) : 12;
      const ia = clampI(Math.round((s - back) / TRACK_STEP));
      const ib = clampI(Math.round((s + fwd) / TRACK_STEP));
      const inX = track.tx[ia];
      const inY = track.ty[ia];
      const outX = track.tx[ib];
      const outY = track.ty[ib];
      const turn = wrapAngle(Math.atan2(outX, outY) - Math.atan2(inX, inY));
      // The arm we arrive on points back along our travel direction.
      let arrive = -1;
      let bestDot = -2;
      for (const ei of nd.edges) {
        const [dx, dy] = this.edgeDirFrom(ei, n);
        const dot = -(dx * inX + dy * inY);
        if (dot > bestDot) {
          bestDot = dot;
          arrive = ei;
        }
      }
      let hw = 0;
      for (const ei of nd.edges) if (ei !== arrive) hw = Math.max(hw, this.edges[ei].width / 2);
      const stop = Math.max(3.5, Math.min(18, hw + 2.5));
      const rank = arrive >= 0 && bestDot > 0.6 ? this.edges[arrive].rank : nd.rank;
      out.push({
        node: n,
        x: nd.x,
        y: nd.y,
        s,
        stopS: s - stop,
        inX,
        inY,
        outX,
        outY,
        cls: classify(turn),
        boxR: nd.boxR,
        sig: nd.sig,
        minor: rank + 0.01 < nd.rank,
        inside: false,
      });
    });
    out.sort((a, b) => a.s - b.s);
    // Inside: the route's last signalised node before, within INSIDE_LINK, was the same junction's.
    out.forEach((j, k) => {
      if (!j.sig) return;
      for (let q = k - 1; q >= 0 && j.s - out[q].s < INSIDE_LINK; q--) {
        const p = out[q];
        if (!p.sig) continue;
        const jp = this.signalJunction(p.node, p.inX, p.inY);
        j.inside = jp >= 0 && jp === this.signalJunction(j.node, j.inX, j.inY);
        return;
      }
    });
    this.busJunctions.set(track, out);
    return out;
  }

  private edgeDirFrom(ei: number, node: number): [number, number] {
    const e = this.edges[ei];
    const p = e.pts;
    const n = p.length;
    let dx: number;
    let dy: number;
    if (e.a === node) {
      dx = p[2] - p[0];
      dy = p[3] - p[1];
    } else {
      dx = p[n - 4] - p[n - 2];
      dy = p[n - 3] - p[n - 1];
    }
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }

  // -------------------------------------------------------------------------

  private refreshCandidates(px: number, py: number): void {
    this.candidates.length = 0;
    this.candW.length = 0;
    this.candSum = 0;
    const R2 = this.radius * this.radius;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      if (e.bus) continue;
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
    // Never inside a junction box.
    const startN = this.nodes[lane & 1 ? e.b : e.a];
    const u0 = startN.deg >= 3 ? startN.boxR + 3 : 2;
    const u1 = e.len - this.stopD[lane] - 3;
    if (u1 <= u0) return false;
    const u = u0 + this.rand() * (u1 - u0);
    const laneIdx = Math.floor(this.rand() * this.lanesIn(lane));
    const lat = this.laneOffset(lane, laneIdx);
    const pt = this.pt;
    this.at(lane, u, lat, pt);
    const d = Math.hypot(pt.x - px, pt.y - py);
    if (d > this.radius || d < (this.initial ? 35 : 130)) return false;
    if (!this.initial && d < 420) {
      this.sphere.center.set(pt.x, pt.z + 1, -pt.y);
      this.sphere.radius = 4;
      if (frustum.intersectsSphere(this.sphere)) return false;
    }
    if (this.busGrid.nearest(pt.x, pt.y, 10, undefined, pt.z) >= 0) return false;
    if (this.grid.nearest(pt.x, pt.y, 10, undefined, pt.z) >= 0) return false;
    for (const c of this.cars) if (c.lane === lane && Math.abs(c.u - u) < 12) return false;
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
      next2: -1,
      vWant: 0.88 + this.rand() * 0.2,
      x: pt.x,
      y: pt.y,
      z: pt.z,
      pitch: Math.atan(pt.g),
      heading: Math.atan2(pt.hx, pt.hy),
      len: this.models[model].len,
      braking: false,
      sigI: 0,
      sigState: null,
      sigTimer: 0,
      xsI: 0,
      xsCommit: -1,
      holds: [],
      busWait: 0,
      idle: 0,
      odo: 0,
      mark: 0,
      stall: 0,
      why: Wait.None,
      ref: 0,
      exempt: false,
      visible: false,
      dead: false,
    };
    const sig = e.sig[lane & 1];
    while (c.sigI < sig.length && sig[c.sigI] < u) c.sigI++;
    const xs = e.xs[lane & 1];
    while (c.xsI < xs.length && xs[c.xsI] < u) c.xsI++;
    this.cars.push(c);
    return true;
  }

  private note(msg: string): void {
    this.events.push(msg);
    if (this.events.length > 30) this.events.shift();
  }

  private kill(c: Car): void {
    if (c.dead) return;
    c.dead = true;
    for (const h of c.holds) this.leave(h.node, c.id);
    c.holds.length = 0;
  }

  /** Grid index of the nearest other (live) car within r of (x, y) on the level of z, or -1. */
  private carNear(x: number, y: number, r: number, skip: number, z: number): number {
    const g = this.grid;
    let best = -1;
    let bd = r * r;
    g.query(x, y, r, (i) => {
      if (g.pid[i] === skip || Math.abs(g.pz[i] - z) > LEVEL_GAP) return false;
      const o = this.byId.get(g.pid[i]);
      if (!o || o.dead) return false;
      const d = (g.px[i] - x) ** 2 + (g.py[i] - y) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
      return false;
    });
    return best;
  }

  /** Speed of a car within r of (x, y) (on the level of z, if given), or -1 if none. */
  probe(x: number, y: number, r: number, z?: number): number {
    const i = this.grid.nearest(x, y, r, undefined, z);
    return i < 0 ? -1 : this.grid.pv[i];
  }

  /**
   * Footprint of car `id` as a capsule: end points (a = front), radius (half
   * width), speed, heading and height. False if there is no such car.
   */
  capsule(id: number, out: { ax: number; ay: number; bx: number; by: number; r: number; v: number; heading: number; z: number }): boolean {
    const c = this.byId.get(id);
    if (!c || c.dead) return false;
    const r = this.models[c.model].width / 2;
    const h = Math.max(0, c.len / 2 - r);
    const hx = Math.sin(c.heading);
    const hy = Math.cos(c.heading);
    out.ax = c.x + hx * h;
    out.ay = c.y + hy * h;
    out.bx = c.x - hx * h;
    out.by = c.y - hy * h;
    out.r = r;
    out.v = c.v;
    out.heading = c.heading;
    out.z = c.z;
    return true;
  }

  /** Cars within r of (x, y) with their state (diagnostics: film runs, probes). */
  debugNear(x: number, y: number, r: number): object[] {
    const out: object[] = [];
    for (const c of this.cars) {
      if (c.dead || Math.hypot(c.x - x, c.y - y) > r) continue;
      const n = this.endNode(c.lane);
      const e = this.edges[c.lane >> 1];
      out.push({ id: c.id, x: +c.x.toFixed(1), y: +c.y.toFixed(1), v: +c.v.toFixed(1), why: c.why, ref: c.ref, exempt: c.exempt, idle: +c.idle.toFixed(0), stall: +c.stall.toFixed(0), lane: c.lane, u: +c.u.toFixed(1), len: +e.len.toFixed(1), node: n, sig: this.nodes[n].sig, holds: c.holds.map((h) => h.node), visible: c.visible });
    }
    return out;
  }

  /** Is the car with this id waiting legitimately (red light, player, or a queue behind those)? */
  isExempt(id: number): boolean {
    return this.byId.get(id)?.exempt ?? false;
  }

  /** Car id of the car within r of (x, y) (on the level of z, if given), or -1. */
  carAt(x: number, y: number, r: number, z?: number): number {
    const i = this.grid.nearest(x, y, r, undefined, z);
    return i < 0 ? -1 : this.grid.pid[i];
  }

  /** Can this car go through the junction at the end of `lane` onto `next` right now? */
  private canGo(c: Car, lane: number, next: number, stopAt: number, time: number, depth: number): Wait {
    const N = this.endNode(lane);
    const nd = this.nodes[N];
    const [inX, inY] = this.laneEndDir(lane);
    const [outX, outY] = this.laneStartDir(next);
    const e0 = this.edges[lane >> 1];
    if (nd.sig) {
      // On a short link between two nodes of one junction we are already in it:
      // its light was ours at the first node (asked again here with the link's
      // direction it would be some other arm's).
      const st = this.insideLane[lane] ? null : this.signalFor(N, inX, inY, time, outX, outY);
      if (st === 'red') return Wait.Red;
      if (st === 'amber' && stopAt > (c.v * c.v) / (2 * 3.5)) return Wait.Red;
    } else {
      if (e0.rank + 0.01 < nd.rank && nd.until > time && nd.holder !== lane) return nd.holder === PLAYER_HOLD ? Wait.Player : Wait.Junction;
    }
    const cls = classify(wrapAngle(Math.atan2(outX, outY) - Math.atan2(inX, inY)));
    // The player's bus coming up on the same approach in the next lane: a car that would turn across
    // its lane in front of it (left from the lane on its right, right from the lane on its left) waits.
    // An oncoming car turning right gives way to it (into the same road as its left turn, or across its path).
    const pc = nd.pc;
    if (pc && pc.until > time) {
      const dot = inX * pc.inX + inY * pc.inY;
      if (dot > 0.8) {
        const side = (c.x - pc.x) * pc.inY - (c.y - pc.y) * pc.inX;
        if ((side > 1.8 && cls === Turn.Left && pc.cls !== Turn.Left) || (side < -1.8 && cls === Turn.Right && pc.cls !== Turn.Right)) return Wait.Player;
      } else if (dot < -0.8 && cls === Turn.Right && pc.cls !== Turn.Right && pc.eta < ONCOMING_GAP) return Wait.Player;
    }
    // The player's bus in (or about to enter) the box: waiting for it is legitimate.
    if (!this.boxClear(N, c.id, inX, inY, outX, outY, cls, time)) return this.boxBy === PLAYER_HOLD ? Wait.Player : Wait.Junction;
    // The exit must have room for the whole car, so it never stops in the box.
    const idx = Math.min(c.laneIdx, this.lanesIn(next) - 1);
    const room = nd.boxR + c.len + 1.5;
    const nb = this.buckets.get(next);
    if (nb) {
      for (const o of nb) {
        if (o === c || o.dead) continue;
        if (this.lanesIn(next) > 1 && o.laneIdx !== idx) continue;
        if (o.u < room && o.v < 2) {
          this.blockRef = o.id;
          return Wait.Junction;
        }
      }
    }
    const ne = this.edges[next >> 1];
    // ...and of buses (and the player's bus) standing there.
    for (let q = 0; q < 2; q++) {
      this.at(next, Math.min(ne.len, nd.boxR + 2 + q * c.len), this.laneOffset(next, idx), this.pt2);
      const hb = this.busGrid.nearest(this.pt2.x, this.pt2.y, 2.6, undefined, this.pt2.z);
      if (hb >= 0 && this.busGrid.pv[hb] < 2) {
        if (this.busGrid.pid[hb] === -1) return Wait.Player;
        this.blockRef = this.busGrid.pid[hb];
        return Wait.Bus;
      }
    }
    // A link too short to stop on: the junction after it must be enterable too.
    if (depth === 0 && this.shortLink(next, nd.boxR, c.len)) {
      if (c.next2 < 0) c.next2 = this.chooseNext(next);
      if (c.next2 >= 0) return this.canGo(c, next, c.next2, stopAt + ne.len, time, 1);
    }
    return Wait.None;
  }

  private commit(c: Car, lane: number, next: number, stopAt: number, time: number, depth: number): void {
    const N = this.endNode(lane);
    const nd = this.nodes[N];
    const [inX, inY] = this.laneEndDir(lane);
    const [outX, outY] = this.laneStartDir(next);
    const cls = classify(wrapAngle(Math.atan2(outX, outY) - Math.atan2(inX, inY)));
    const until = time + Math.min(16, (stopAt + 2 * nd.boxR + c.len) / Math.max(c.v, 3) + 2.5);
    this.enter(N, c.id, inX, inY, outX, outY, cls, until);
    if (!c.holds.some((h) => h.node === N)) c.holds.push({ node: N, d: -1, inX, inY, outX, outY, cls });
    const ne = this.edges[next >> 1];
    if (depth === 0 && c.next2 >= 0 && this.shortLink(next, nd.boxR, c.len)) this.commit(c, next, c.next2, stopAt + ne.len, time, 1);
  }

  /** A lane too short to wait on between two junction boxes. */
  private shortLink(lane: number, boxR: number, len: number): boolean {
    const e = this.edges[lane >> 1];
    const nd = this.nodes[this.endNode(lane)];
    return nd.deg >= 3 && e.len - this.stopD[lane] < boxR + len;
  }

  /** Index of a bus (or -1 = player) on the busway near a crossing at (X, Y, Z) along (bx, by), else -2. */
  private busOnBusway(X: number, Y: number, bx: number, by: number, Z: number): number {
    const g = this.busGrid;
    let found = -2;
    g.query(X, Y, 26, (i) => {
      if (Math.abs(g.pz[i] - Z) > LEVEL_GAP) return false;
      const dx = g.px[i] - X;
      const dy = g.py[i] - Y;
      const along = dx * bx + dy * by;
      const lat = Math.abs(dx * by - dy * bx);
      // On the crossing, or moving and close enough to reach it soon. (A bus
      // standing at a nearby platform or light is not a reason to wait.)
      if (lat < 4.5 && (Math.abs(along) < 7 || (g.pv[i] > 0.8 && Math.abs(along) < 25))) {
        found = g.pid[i];
        return true;
      }
      return false;
    });
    return found;
  }

  /**
   * Advance the car simulation. `busBodies` / `busExempt` are the AI buses
   * (index-aligned); the player is avoided through `playerBody`.
   */
  simulate(dt: number, time: number, player: BusPose, playerBody: Body, busBodies: readonly Body[], busExempt: readonly boolean[], frustum: THREE.Frustum): void {
    const t0 = performance.now();
    const px = player.x;
    const py = player.y;
    const bg = this.busGrid;
    bg.clear();
    // Body points and the midpoints between them (<= ~1.8 m apart), so a probe
    // with the contact radius cannot slip between two points.
    const addBody = (b: Body, v: number, id: number) => {
      for (let k = 0; k < b.n; k++) {
        bg.add(b.x[k], b.y[k], v, id, b.z[k]);
        if (k + 1 < b.n) bg.add((b.x[k] + b.x[k + 1]) / 2, (b.y[k] + b.y[k + 1]) / 2, v, id, (b.z[k] + b.z[k + 1]) / 2);
      }
    };
    addBody(playerBody, Math.max(0, Math.abs(playerBody.speed)), -1);
    busBodies.forEach((b, i) => addBody(b, b.speed, i));

    this.candTimer -= dt;
    if (this.candTimer <= 0) {
      this.candTimer = 2;
      this.refreshCandidates(px, py);
    }
    // Remove dead and far-away cars.
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const d = Math.hypot(c.x - px, c.y - py);
      if (c.dead || d > this.radius + 150 || i >= this.maxCars + 6) {
        this.kill(c);
        this.cars[i] = this.cars[this.cars.length - 1];
        this.cars.pop();
      }
    }
    // Spawn.
    if (this.enabled && this.capCars > 0) {
      const desired = Math.min(this.maxCars, Math.round(this.candSum / 90));
      let tries = this.initial ? 400 : 8;
      let made = 0;
      while (this.cars.length < desired && tries-- > 0 && made < (this.initial ? this.capCars : 2)) if (this.spawn(px, py, frustum)) made++;
      if (this.initial && this.candidates.length) this.initial = false;
    }

    // Buckets per lane, sorted by u; id lookup (exempt flags are last frame's).
    for (const list of this.buckets.values()) list.length = 0;
    this.byId.clear();
    for (const c of this.cars) {
      this.byId.set(c.id, c);
      let l = this.buckets.get(c.lane);
      if (!l) this.buckets.set(c.lane, (l = []));
      l.push(c);
    }
    for (const l of this.buckets.values()) if (l.length > 1) l.sort((a, b) => a.u - b.u);

    const pt = this.pt;
    const signalAt = this.world.signalStateAt;
    const st = this.stats;
    st.waitingRed = 0;
    st.waitingJunction = 0;
    st.stationary = 0;
    for (const c of this.cars) {
      if (c.dead) continue;
      const e = this.edges[c.lane >> 1];
      const remain = e.len - c.u;
      if (c.next < 0 && remain < 70) c.next = this.chooseNext(c.lane);
      const v0 = (e.limit / 3.6) * c.vWant;
      const A = 1.7;
      const B = 2.6;
      const T = 1.15;
      const idm = (gap: number, vLead: number, s0: number) => {
        const sStar = s0 + Math.max(0, c.v * T + (c.v * (c.v - vLead)) / (2 * Math.sqrt(A * B)));
        return A * (1 - Math.pow(c.v / Math.max(1, v0), 4) - (sStar / Math.max(0.05, gap)) ** 2);
      };
      let acc = A * (1 - Math.pow(c.v / Math.max(1, v0), 4));
      const wt: { why: Wait; ref: number } = { why: Wait.None, ref: 0 };
      const lim = (a: number, w: Wait, ref = 0) => {
        if (a < acc) {
          acc = a;
          wt.why = w;
          wt.ref = ref;
        }
      };
      const commitDist = Math.max(2.5, (c.v * c.v) / (2 * 2.5)) + 1.5;
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
      let leadId = 0;
      // Approaching a narrower exit, cars in the other lanes merge into ours: follow them too.
      const merging = c.next >= 0 && remain < 30 && this.lanesIn(c.next) < this.lanesIn(c.lane);
      for (let k = list.indexOf(c) + 1; k < list.length; k++) {
        const o = list[k];
        if (o.dead || (o.laneIdx !== c.laneIdx && this.lanesIn(c.lane) > 1 && !(merging && o.next === c.next))) continue;
        gap = o.u - c.u - (o.len + c.len) / 2;
        vLead = o.v;
        leadId = o.id;
        break;
      }
      if (gap === Infinity && c.next >= 0) {
        const nl = this.buckets.get(c.next);
        if (nl) {
          for (const o of nl) {
            if (o.dead || (o.laneIdx !== Math.min(c.laneIdx, this.lanesIn(c.next) - 1) && this.lanesIn(c.next) > 1)) continue;
            gap = remain + o.u - (o.len + c.len) / 2;
            vLead = o.v;
            leadId = o.id;
            break;
          }
        }
      }
      if (gap < 120) lim(idm(gap, vLead, 2.2), Wait.Car, leadId);
      // Anything else in our path: crossing cars, buses, the player.
      let busBlock = false;
      const look = 5 + c.v * 2;
      for (let d = c.len / 2 + 1; d <= look; d += 2) {
        this.sampleAhead(c, d, pt);
        const hc = this.carNear(pt.x, pt.y, 1.7, c.id, pt.z);
        if (hc >= 0) {
          lim(idm(d - c.len / 2 - 0.5, this.grid.pv[hc] * 0.6, 1.6), Wait.Car, this.grid.pid[hc]);
          break;
        }
        // A bus (1.25 m half width) touches a car (0.92) 2.2 m from its centreline: look wider than that.
        const hb = bg.nearest(pt.x, pt.y, 2.5, undefined, pt.z);
        if (hb >= 0) {
          lim(idm(d - c.len / 2 - 0.6, bg.pv[hb] * 0.8, 1.5), bg.pid[hb] === -1 ? Wait.Player : Wait.Bus, bg.pid[hb]);
          busBlock = bg.pv[hb] < 1;
          break;
        }
      }
      // Stuck behind a stopped bus on a multi-lane road: move over and overtake.
      if (busBlock && c.v < 1.5) c.busWait += dt;
      else c.busWait = Math.max(0, c.busWait - dt);
      if (c.busWait > 2.5 && this.lanesIn(c.lane) > 1) {
        const to = (c.laneIdx + 1) % this.lanesIn(c.lane);
        // Only into a gap.
        if (!list.some((o) => o !== c && !o.dead && o.laneIdx === to && Math.abs(o.u - c.u) < c.len + 6)) c.laneIdx = to;
        c.busWait = 0;
      }
      // Mid-block signals (pedestrian lights).
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
            this.at(c.lane, sig[c.sigI], 0, this.pt2);
            c.sigState = signalAt.call(this.world, xy[2 * c.sigI], xy[2 * c.sigI + 1], time, this.pt2.hx, this.pt2.hy, this.pt2.z);
          }
          if (c.sigState === 'red' || (c.sigState === 'amber' && sgap > (c.v * c.v) / (2 * 3) + 2)) lim(idm(sgap, 0, 0.8), Wait.Red);
        }
      }
      // Busway crossings: give way to any bus on the busway.
      const xs = e.xs[c.lane & 1];
      while (c.xsI < xs.length && xs[c.xsI] < c.u - 6) c.xsI++;
      if (c.xsI < xs.length && c.xsCommit !== c.xsI) {
        const xgap = xs[c.xsI] - c.u;
        if (xgap < 45 && xgap > -6) {
          const q = e.xsXY[c.lane & 1];
          const k = c.xsI * 5;
          const bus = this.busOnBusway(q[k], q[k + 1], q[k + 2], q[k + 3], q[k + 4]);
          if (bus !== -2) lim(idm(Math.max(0.05, xgap), 0, 0.5), bus === -1 ? Wait.Player : Wait.Crossing, bus);
          else if (xgap < 2) c.xsCommit = c.xsI; // keep looking until we are on it
        }
      }
      // Junction at the end of the lane.
      const N = this.endNode(c.lane);
      const nd = this.nodes[N];
      const sd = this.stopD[c.lane];
      if (sd > 0 && nd.deg >= 3) {
        if (!nd.sig && e.rank + 0.01 >= nd.rank && remain < 25) this.markMajor(N, time, c.lane);
        if (!c.holds.some((h) => h.node === N) && c.next >= 0) {
          const stopAt = remain - sd;
          if (stopAt < commitDist + 30) {
            this.blockRef = 0;
            const res = this.canGo(c, c.lane, c.next, stopAt, time, 0);
            if (res !== Wait.None) lim(idm(Math.max(0.05, stopAt), 0, 0.6), res, this.blockRef);
            else if (stopAt <= commitDist) this.commit(c, c.lane, c.next, stopAt, time, 0);
          }
        }
      }
      acc = Math.max(-7, Math.min(A, acc));
      c.braking = acc < -0.6 || c.v < 0.2;
      c.v = Math.max(0, c.v + acc * dt);
      c.u += c.v * dt;
      c.odo += c.v * dt;
      // Release junctions we have cleared; keep the others reserved while we are on our way through.
      for (let k = c.holds.length - 1; k >= 0; k--) {
        const h = c.holds[k];
        if (h.d >= 0) h.d += c.v * dt;
        const hn = this.nodes[h.node];
        if (h.d > hn.boxR + c.len) {
          this.leave(h.node, c.id);
          c.holds.splice(k, 1);
        } else this.enter(h.node, c.id, h.inX, h.inY, h.outX, h.outY, h.cls, time + 3);
      }
      // Advance onto the next lane.
      let guard = 0;
      while (c.u > this.edges[c.lane >> 1].len && guard++ < 4) {
        const over = c.u - this.edges[c.lane >> 1].len;
        const passed = this.endNode(c.lane);
        if (c.next < 0) c.next = this.chooseNext(c.lane);
        if (c.next < 0) {
          this.kill(c);
          break;
        }
        for (const h of c.holds) if (h.node === passed && h.d < 0) h.d = 0;
        c.lane = c.next;
        c.next = c.next2;
        c.next2 = -1;
        c.u = over;
        c.sigI = 0;
        c.sigState = null;
        c.xsI = 0;
        c.xsCommit = -1;
        c.laneIdx = Math.min(c.laneIdx, this.lanesIn(c.lane) - 1);
      }
      if (c.dead) continue;
      const target = this.laneOffset(c.lane, c.laneIdx);
      c.lat += Math.max(-dt * 1.2, Math.min(dt * 1.2, target - c.lat));
      this.at(c.lane, c.u, c.lat, pt);
      c.x = pt.x;
      c.y = pt.y;
      c.z = pt.z;
      const h = Math.atan2(pt.hx, pt.hy);
      c.heading += wrapAngle(h - c.heading) * Math.min(1, dt * 7);
      // Grade pitch, eased so cars do not snap over polyline kinks.
      c.pitch += (Math.atan(pt.g) - c.pitch) * Math.min(1, dt * 5);
      // Waiting legitimately? (Red light, the player, or queued behind someone who is.)
      const why = wt.why;
      c.why = why;
      c.ref = wt.ref;
      c.exempt =
        why === Wait.Red ||
        why === Wait.Player ||
        // Queued behind someone who is (also across a junction: its exit is full of such a queue).
        ((why === Wait.Car || (why === Wait.Junction && wt.ref > 0)) && (this.byId.get(wt.ref)?.exempt ?? false)) ||
        ((why === Wait.Bus || why === Wait.Crossing) && !!busExempt[wt.ref]);
      if (why === Wait.Red) st.waitingRed++;
      if (why === Wait.Junction) st.waitingJunction++;
      if (c.v < 0.3) st.stationary++;
      // Safety valve: a car that has not moved for a long time without a good reason goes away.
      if (c.v < 0.3 && !c.exempt && why !== Wait.None) c.idle += dt;
      else c.idle = 0;
      if (c.idle > (c.visible ? 45 : 25)) {
        this.note(`stuck lane ${c.lane} u ${c.u.toFixed(1)}/${e.len.toFixed(1)} why ${wt.why} ref ${wt.ref} end ${N} sig ${nd.sig}`);
        this.kill(c);
        st.stuckDespawns++;
      }
      // Jam breaker: no progress for minutes whatever the reason (a queue that
      // never clears, a wait on the player that never ends) and it goes.
      if (c.odo - c.mark > 3) {
        c.mark = c.odo;
        c.stall = 0;
      } else c.stall += dt;
      if (!c.dead && c.stall > (c.visible ? STALL_VISIBLE : STALL_HIDDEN)) {
        this.note(`stall lane ${c.lane} u ${c.u.toFixed(1)} why ${wt.why} ref ${wt.ref} end ${N} sig ${nd.sig}`);
        this.kill(c);
        st.stallDespawns++;
      }
    }

    // Car grid (for buses, the probes above and overlap checks).
    const g = this.grid;
    g.clear();
    for (const c of this.cars) {
      if (c.dead) continue;
      const hx = Math.sin(c.heading);
      const hy = Math.cos(c.heading);
      const dz = Math.tan(c.pitch) * c.len * 0.3;
      g.add(c.x + hx * c.len * 0.3, c.y + hy * c.len * 0.3, c.v, c.id, c.z + dz);
      g.add(c.x - hx * c.len * 0.3, c.y - hy * c.len * 0.3, c.v, c.id, c.z - dz);
    }
    // Safety valve: vehicles that overlap are removed (the one behind; cars give way to buses).
    for (const c of this.cars) {
      if (c.dead) continue;
      const hx = Math.sin(c.heading);
      const hy = Math.cos(c.heading);
      for (const f of [0.3, -0.3]) {
        const qx = c.x + hx * c.len * f;
        const qy = c.y + hy * c.len * f;
        const oc = this.carNear(qx, qy, 1.2, c.id, c.z);
        if (oc >= 0) {
          const o = this.byId.get(g.pid[oc]);
          if (o && !o.dead) {
            const ahead = (o.x - c.x) * hx + (o.y - c.y) * hy > 0;
            this.note(`car-car lanes ${c.lane}/${o.lane} u ${c.u.toFixed(1)}/${o.u.toFixed(1)} v ${c.v.toFixed(1)}/${o.v.toFixed(1)} holds ${c.holds.map((h) => h.node)}/${o.holds.map((h) => h.node)} end ${this.endNode(c.lane)}/${this.endNode(o.lane)}`);
            this.kill(ahead ? c : o);
            st.overlapDespawns++;
            break;
          }
        }
        const ob = bg.nearest(qx, qy, 1.6, undefined, c.z);
        // Inside an AI bus, or deep inside the player's bus (the player is never moved for it).
        if (ob >= 0 && (bg.pid[ob] >= 0 || (bg.px[ob] - qx) ** 2 + (bg.py[ob] - qy) ** 2 < 1.0)) {
          this.note(`car-bus lane ${c.lane} u ${c.u.toFixed(1)} v ${c.v.toFixed(1)} bus v ${bg.pv[ob].toFixed(1)} holds ${c.holds.map((h) => h.node)} end ${this.endNode(c.lane)}`);
          this.kill(c);
          st.overlapDespawns++;
          break;
        }
        // Touching the player's bus ahead: stop dead (it is never shoved out of the way).
        if (f > 0 && !c.dead) {
          let touch = false;
          bg.query(qx, qy, 2.3, (i) => {
            if (bg.pid[i] !== -1 || Math.abs(bg.pz[i] - c.z) > LEVEL_GAP) return false;
            touch = (bg.px[i] - c.x) * hx + (bg.py[i] - c.y) * hy > 0;
            return touch;
          });
          if (touch) c.v = 0;
        }
      }
    }

    const cost = performance.now() - t0;
    this.costEma += (cost - this.costEma) * 0.05;
    this.costTimer -= dt;
    if (this.fixedCaps) this.maxCars = this.capCars;
    else if (this.costTimer <= 0) {
      this.costTimer = 1;
      if (this.costEma > 0.6 && this.maxCars > 20) this.maxCars -= 4;
      else if (this.costEma < 0.35 && this.maxCars < this.capCars) this.maxCars += 2;
      if (this.maxCars > this.capCars) this.maxCars = this.capCars;
    }
  }

  private sampleAhead(c: Car, d: number, out: LanePt): void {
    const e = this.edges[c.lane >> 1];
    const u = c.u + d;
    if (u <= e.len || c.next < 0) this.at(c.lane, Math.min(u, e.len), c.lat, out);
    else this.at(c.next, Math.min(u - e.len, this.edges[c.next >> 1].len), this.laneOffset(c.next, Math.min(c.laneIdx, this.lanesIn(c.next) - 1)), out);
  }

  render(frustum: THREE.Frustum, cam: THREE.Vector3, hours: number): void {
    const night = hours < 6.6 || hours > 17.9 ? 1 : 0;
    if (night !== this.lastNight) {
      this.lastNight = night;
      for (const m of this.models) m.head.visible = !!night;
    }
    for (const m of this.models) m.count = 0;
    for (const c of this.cars) {
      c.visible = false;
      if (c.dead || !this.enabled) continue;
      const dx = c.x - cam.x;
      const dz = -c.y - cam.z;
      if (dx * dx + dz * dz > VIEW * VIEW) continue;
      this.sphere.center.set(c.x, c.z + 1, -c.y);
      this.sphere.radius = 3.2;
      if (!frustum.intersectsSphere(this.sphere)) continue;
      c.visible = true;
      const m = this.models[c.model];
      if (m.count >= CAPACITY) continue;
      const i = m.count++;
      // On the road at its height, yawed then pitched to the grade.
      this.v3.set(c.x, c.z, -c.y);
      this.euler.set(c.pitch, -c.heading, 0);
      this.q.setFromEuler(this.euler);
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
