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
import { RoadKind, type BusPose, type BusSpec, type MapData, type WorldHandle } from '../types';
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
  outX: number;
  outY: number;
  cls: Turn;
  eta: number;
  /** Close enough that cars in the next lane do not turn across its lane in front of it. */
  near: boolean;
  /** It has right of way here (its light is not red, or it is on the main road): crossing movements yield to it. */
  prio: boolean;
}

/**
 * An oncoming vehicle turning right across the player's bus goes only when the
 * bus is further off than its own time to clear the bus's path plus this (s).
 * (A flat 4.5 s let a car waiting at the line pull out with the bus a few
 * metres short: from rest it takes about 4.5 s to clear.)
 */
const ONCOMING_MARGIN = 1.5;
/** A car whose lane ends at a node merges in front of the player's bus only this far (s) ahead of it. */
const MERGE_MARGIN = 1;
/** A route passes through a junction node within 7 m of it or inside its box, up to this far (m). */
const JUNCTION_PICK_MAX = 9;
/** Two ways out of a junction this far apart (rad) cross, for vehicles side by side going in. */
const ACROSS = 0.3;
/** Stop lines held back from a bus's swept path (holdBackFor): room left (m), farthest line (m), car size (m). */
const SWEEP_MARGIN = 0.25;
const SWEEP_MAX = 25;
const SWEEP_CAR_L = 5;
const SWEEP_CAR_W = 1.9;

/** Do two rectangles (centre, unit axis along, half length, half width) overlap? (Separating axes.) */
function boxesTouch(ax: number, ay: number, aux: number, auy: number, al: number, aw: number, bx: number, by: number, bux: number, buy: number, bl: number, bw: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const reach = al + aw + bl + bw;
  if (dx * dx + dy * dy > reach * reach) return false;
  // Each box's own two axes (along, across); the other's extent on them through |cos| and |sin|.
  const c = Math.abs(aux * bux + auy * buy);
  const s = Math.abs(aux * buy - auy * bux);
  if (Math.abs(dx * aux + dy * auy) > al + bl * c + bw * s) return false;
  if (Math.abs(-dx * auy + dy * aux) > aw + bl * s + bw * c) return false;
  if (Math.abs(dx * bux + dy * buy) > bl + al * c + aw * s) return false;
  if (Math.abs(-dx * buy + dy * bux) > bw + al * s + aw * c) return false;
  return true;
}
/** Car acceleration (m/s^2). */
const CAR_A = 1.7;
/** Half a car's width (m), as the overlap checks take it. */
const CAR_HALF_W = 0.92;
/** Distance (m) before a node over which a car going straight on eases to the next lane's offset. */
const LANE_BLEND = 14;
/** A link this short (m) before a lane ends: a car merges as if its own lane ended at the node before it. */
const MERGE_SHORT = 6;
/** Longest corner cut (m) of a left turn, on either lane. */
const CUT_MAX = 8;
/** Gap (s) to the next vehicle on a conflicting movement that one giving way waits for: merging left, and across. */
export const GAP_LEFT = 4.5;
export const GAP_ACROSS = 6.5;

/** Seconds to cover `d` m from speed `v`: holding it, or accelerating at `a` from rest, whichever is sooner (an upper bound). */
export function clearTime(v: number, d: number, a: number): number {
  return Math.min(d / Math.max(v, 0.1), Math.sqrt((2 * Math.max(0, d)) / a));
}

/** The speed (m/s) a car slows to for a turn of `turn` rad (more than 0.5) at the end of its lane. */
function turnSpeed(turn: number): number {
  return 4.5 + 7 * (1 - Math.min(1, turn / 2));
}

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
  /**
   * The inside corner of a turn into `next` (see cutOf): leave this lane cutA m before its end and join
   * the next cutB m after its start, at its offset cutLat; for the lane, next lane and lane index keyed.
   */
  cutLane: number;
  cutNext: number;
  cutIdx: number;
  cutA: number;
  cutB: number;
  cutLat: number;
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
  // A right turn across oncoming traffic; and two opposing right turns, whose
  // paths through the box cross (taken together they block each other there).
  if (inDot < -0.8) return aCls === Turn.Right || b.cls === Turn.Right;
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
  /** Per lane: 0 not yet known, 1 not on a roundabout's ring, 2 on one (see onRing). */
  private ring: Int8Array = new Int8Array(0);
  /** Stop-line distance from the end node for each directed lane (0 = uncontrolled). */
  private stopD: Float32Array = new Float32Array(0);
  /**
   * Per directed lane: at its end node (unsignalised) it gives way to the other arms. A lower class
   * of road than the junction's best, or the stem of a T-junction of equal roads (the T-intersection
   * rule: the road that ends gives way to the one that goes on).
   */
  private minorIn: Uint8Array = new Uint8Array(0);
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
  private pt3: LanePt = { x: 0, y: 0, hx: 0, hy: 0, z: 0, g: 0 };
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
    // Who gives way at an unsignalised junction: a lesser road; at a T of equal roads, its stem (two
    // arms within 50° of straight on, clearly straighter than any other pair, the third off to the side).
    this.minorIn = new Uint8Array(this.edges.length * 2);
    for (let lane = 0; lane < this.edges.length * 2; lane++) {
      const nd = this.nodes[this.endNode(lane)];
      if (this.edges[lane >> 1].rank + 0.01 < nd.rank) this.minorIn[lane] = 1;
    }
    for (let n = 0; n < this.nodes.length; n++) {
      const nd = this.nodes[n];
      const es = nd.edges;
      if (es.length !== 3 || es.some((ei) => this.edges[ei].a === this.edges[ei].b)) continue;
      const d = es.map((ei) => this.armDir(ei, n, 10));
      const dot = (i: number, j: number) => d[i][0] * d[j][0] + d[i][1] * d[j][1];
      // (Arm k against the pair of the other two.)
      const pd = [dot(1, 2), dot(2, 0), dot(0, 1)];
      const stem = pd.indexOf(Math.min(...pd));
      const other = Math.min(pd[(stem + 1) % 3], pd[(stem + 2) % 3]);
      if (pd[stem] > -0.64 || other < pd[stem] + 0.25 || Math.max(pd[(stem + 1) % 3], pd[(stem + 2) % 3]) > 0.8) continue;
      const ek = this.edges[es[stem]];
      if (ek.rank > Math.max(this.edges[es[(stem + 1) % 3]].rank, this.edges[es[(stem + 2) % 3]].rank) + 0.01) continue;
      this.minorIn[ek.b === n ? es[stem] * 2 : es[stem] * 2 + 1] = 1;
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
    // The arm on a car's left leaving at an acute angle: its exit lane runs close past the waiting
    // car's nose (the kerb lanes of the two arms face each other). Hold the car back until its
    // front corner clears a car on that lane, or the two block each other in the box for good.
    for (let a = 0; a < this.edges.length * 2; a++) {
      if (!this.stopD[a]) continue;
      const nd = this.nodes[this.endNode(a)];
      const [ax, ay] = this.laneEndDir(a);
      const la = this.laneOffset(a, 0) + CAR_HALF_W;
      let need = 0;
      for (const o of nd.out) {
        if (o >> 1 === a >> 1) continue;
        const [ox, oy] = this.laneStartDir(o);
        if (ox * -ay + oy * ax <= 0) continue; // not on our left
        const cos = -(ax * ox + ay * oy); // between our arm (pointing away from the node) and that one
        const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
        if (cos <= 0 || sin < 0.2) continue;
        const front = (this.laneOffset(o, 0) + CAR_HALF_W + 0.3 + la * cos) / sin;
        need = Math.max(need, front + 2.3);
      }
      const e = this.edges[a >> 1];
      this.stopD[a] = Math.max(this.stopD[a], Math.min(25, need, e.len - 2));
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

  /**
   * The lane after `lane` for a car in lane index `idx` of it: turning left only from the kerb lane
   * and right only from the offside one (across the lane beside it, in front of whoever is in that
   * one, only where nothing else is open to it). OSM rarely says which lanes turn; a wide way out
   * is no sign of a double turn lane (inside a big junction every link is wide).
   */
  private chooseNext(lane: number, idx = 0): number {
    const node = this.nodes[this.endNode(lane)];
    const e = this.edges[lane >> 1];
    const rev = lane & 1;
    // Incoming heading at the node.
    const p = e.pts;
    const n = p.length;
    const [hx, hy] = rev ? [p[0] - p[2], p[1] - p[3]] : [p[n - 2] - p[n - 4], p[n - 1] - p[n - 3]];
    const hIn = Math.atan2(hx, hy);
    const lanes = this.lanesIn(lane);
    let best = -1;
    let sum = 0;
    const opts: [number, number][] = [];
    for (let pass = 0; pass < 2 && !opts.length; pass++) {
      for (const o of node.out) {
        if (o >> 1 === lane >> 1) continue;
        const oe = this.edges[o >> 1];
        if (oe.bus) continue;
        const op = oe.pts;
        const on = op.length;
        const [ox, oy] = o & 1 ? [op[on - 4] - op[on - 2], op[on - 3] - op[on - 1]] : [op[2] - op[0], op[3] - op[1]];
        const signed = wrapAngle(Math.atan2(ox, oy) - hIn);
        if (pass === 0 && lanes > 1 && !this.onRing(lane)) {
          if (signed < -0.5 && idx > 0) continue;
          if (signed > 0.5 && idx < lanes - 1) continue;
        }
        const turn = Math.abs(signed);
        const w = (Math.cos(turn) + 1.25) * (CLASS_W[oe.kind] ?? 0.3) * (oe.len < 15 ? 0.6 : 1);
        opts.push([o, w]);
        sum += w;
      }
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

  /**
   * Is `lane` on a roundabout's ring: one-way lanes, each bending a little right into the next, that
   * come back round to it within a few hundred metres? (There a car leaves from whichever lane it is
   * in: kept to the kerb lane to turn left, the inner lane's cars would go round for ever.)
   */
  private onRing(lane: number): boolean {
    if (this.ring.length !== this.edges.length * 2) this.ring = new Int8Array(this.edges.length * 2);
    let r = this.ring[lane];
    if (r === 0) {
      r = 1;
      let cur = lane;
      let len = 0;
      for (let k = 0; k < 16 && len < 400 && this.edges[cur >> 1].oneway; k++) {
        // The ring carries on bending right; ways off it leave to the left (or straight on).
        let nx = -1;
        let bestT = -Infinity;
        for (const o of this.nodes[this.endNode(cur)].out) {
          if (o >> 1 === cur >> 1 || this.edges[o >> 1].bus) continue;
          const t = this.turnAngle(cur, o);
          if (t > -0.15 && t < 1.2 && t > bestT) {
            bestT = t;
            nx = o;
          }
        }
        if (nx < 0) break;
        if (nx === lane) {
          r = 2;
          break;
        }
        len += this.edges[nx >> 1].len;
        cur = nx;
      }
      this.ring[lane] = r;
    }
    return r === 2;
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

  /**
   * A turn's inside corner: where the car's lane line crosses the next lane's. The car leaves its lane
   * there, before the node, and joins the next lane past it, at the same point. Driving out to the
   * node and pivoting on it instead puts the car's centre on the centreline of the road it turns into
   * and swings its tail across the far half of the road it leaves, into the oncoming traffic going
   * straight on (a left turn); or jumps it sideways at the node by twice its offset times the sine of
   * half the turn (61/0 s 4851: 1.8 m, into the player's bus, on a sharp right turn from a one-way's
   * offside lane). No cut going straight on, where the lines cross past the node, or where the corner
   * is behind the stop line.
   */
  private cutOf(c: Car): void {
    if (c.cutLane === c.lane && c.cutNext === c.next && c.cutIdx === c.laneIdx) return;
    c.cutLane = c.lane;
    c.cutNext = c.next;
    c.cutIdx = c.laneIdx;
    c.cutA = 0;
    c.cutB = 0;
    const a = c.lane;
    const b = c.next;
    if (b < 0) return;
    const latB = this.laneOffset(b, Math.min(c.laneIdx, this.lanesIn(b) - 1));
    c.cutLat = latB;
    const ea = this.edges[a >> 1];
    const eb = this.edges[b >> 1];
    const p = this.pt3;
    this.at(a, ea.len, this.laneOffset(a, c.laneIdx), p);
    const ax = p.hx;
    const ay = p.hy;
    const wx0 = p.x;
    const wy0 = p.y;
    this.at(b, 0, latB, p);
    const bx = p.hx;
    const by = p.hy;
    const cr = ax * by - ay * bx;
    // (A right turn's lines cross before the node too where both lanes are on the right of their roads,
    // the offside lanes of one-way roads: the inside of the turn. Elsewhere they cross past it, no cut.)
    if (Math.abs(cr) < 0.48 || ax * bx + ay * by < -0.9) return; // not a turn of ~29 degrees or more
    const wx = p.x - wx0;
    const wy = p.y - wy0;
    const ca = -(wx * by - wy * bx) / cr;
    const cb = (wx * ay - wy * ax) / cr;
    const sd = this.stopD[a];
    if (ca < 0.3 || cb < 0.3 || ca > Math.min(CUT_MAX, ea.len * 0.5, sd > 0 ? sd - 0.5 : Infinity) || cb > Math.min(CUT_MAX, eb.len * 0.5)) return;
    c.cutA = ca;
    c.cutB = cb;
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
        // (A car holding the box but stopped for us, our nose already in its way out (we came
        // through the junction's inside link), lets us out first: else the two wait for good.)
        const h = o.id > 0 ? this.byId.get(o.id) : undefined;
        if (h && !h.dead && h.v < 0.5 && h.why === Wait.Car && h.ref === id) continue;
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
   * there in `eta` s, out along (outX, outY)), until `until`: cars on the same approach do not turn
   * across its lane in front of it (when `near`), and vehicles crossing its path do not cut in
   * front of it (see playerConflict).
   */
  claimApproach(
    node: number,
    x: number,
    y: number,
    inX: number,
    inY: number,
    outX: number,
    outY: number,
    cls: Turn,
    eta: number,
    until: number,
    near: boolean,
    prio: boolean,
  ): void {
    const nd = this.nodes[node];
    if (nd.pc) Object.assign(nd.pc, { until, x, y, inX, inY, outX, outY, cls, eta, near, prio });
    else nd.pc = { until, x, y, inX, inY, outX, outY, cls, eta, near, prio };
  }

  /**
   * Would a vehicle coming into `node` along (inX, inY) and out along (outX,
   * outY) cut across the player's bus, which it would not clear in `clearT` s
   * (plus a margin)? Any movement crossing the bus's where the bus has right
   * of way (a right-turner on the shared green, the far carriageway of a
   * divided road crossed at the junction's second node, an arm with no light);
   * a right turn across it coming the other way, always.
   */
  playerConflict(node: number, inX: number, inY: number, outX: number, outY: number, cls: Turn, time: number, clearT: number): boolean {
    const pc = this.nodes[node].pc;
    if (!pc || pc.until <= time || pc.eta >= clearT + ONCOMING_MARGIN) return false;
    const dot = inX * pc.inX + inY * pc.inY;
    if (dot > 0.8) return false; // the same approach: the next-lane rule
    if (dot < -0.8 && cls === Turn.Right && pc.cls !== Turn.Right) return true;
    return pc.prio && movementsConflict(inX, inY, outX, outY, cls, pc);
  }

  /**
   * Seconds until the first car coming into `node` on a movement that conflicts with ours
   * (in, out, cls) gets there, if under `horizon` (the gap a vehicle giving way there has);
   * Infinity when none. Cars held at a red light do not count.
   */
  conflictEta(node: number, inX: number, inY: number, outX: number, outY: number, cls: Turn, horizon: number): number {
    let best = Infinity;
    for (const c of this.cars) {
      if (c.dead || c.v < 0.5 || c.next < 0 || c.why === Wait.Red || this.endNode(c.lane) !== node) continue;
      const eta = (this.edges[c.lane >> 1].len - c.u) / c.v;
      if (eta >= horizon || eta >= best) continue;
      const [ix, iy] = this.laneEndDir(c.lane);
      const [ox, oy] = this.laneStartDir(c.next);
      const ccls = classify(wrapAngle(Math.atan2(ox, oy) - Math.atan2(ix, iy)));
      if (movementsConflict(inX, inY, outX, outY, cls, { inX: ix, inY: iy, outX: ox, outY: oy, cls: ccls })) best = eta;
    }
    return best;
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
      // Only junctions on the route's level (not the street under a busway viaduct). Within 7 m, or
      // inside the node's box: a left turn round a wide junction's corner passes 7-8 m from its node
      // and through the waiting cars' stop lines (199/0 s 8872 at Commercial Rd, Teneriffe).
      const n = this.nearestJunction(track.x[i], track.y[i], JUNCTION_PICK_MAX, track.z[i]);
      if (n < 0) continue;
      const d = Math.hypot(this.nodes[n].x - track.x[i], this.nodes[n].y - track.y[i]);
      if (d > 7 && (d > this.nodes[n].boxR || !this.passesThrough(n, track, i))) continue;
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
      const minor = arrive >= 0 && bestDot > 0.6 && this.minorIn[this.edges[arrive].b === n ? arrive * 2 : arrive * 2 + 1] === 1;
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
        minor,
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

  /**
   * Stop lines held back from a bus's swept path: a bus of `spec` following `track` (its front axle on
   * the lane, the rest tracking in behind) that would touch either of the first two cars waiting at
   * another arm's line moves that line back until it is clear, up to SWEEP_MAX from the node. A bus
   * turning left out of one narrow road into another swings over the far half of the one it turns
   * into, where cars wait at their red (199/0 s 1926, s 7070). Returns the number of lines moved.
   */
  holdBackFor(track: RouteTrack, spec: BusSpec): number {
    const secs = spec.sections;
    const ns = secs.length;
    // Section i: its axle, its hitch to the one in front (section 0: the front axle), unit heading.
    const ax = new Float64Array(ns);
    const ay = new Float64Array(ns);
    const hx = new Float64Array(ns);
    const hy = new Float64Array(ns);
    const link = secs.map((s, i) => (i === 0 ? spec.wheelbase : Math.max(0.5, s.axleFromFront - s.hitchFromFront)));
    const halfW = spec.width / 2 + SWEEP_MARGIN;
    const rects: number[] = [];
    const smp = { x: 0, y: 0, hx: 0, hy: 1, heading: 0 };
    const pt = this.pt2;
    let moved = 0;
    for (const j of this.junctionsAlong(track)) {
      const nd = this.nodes[j.node];
      // Arms with a line cars wait at; the one the bus comes in on too, for the lanes beside the
      // bus's (it may cross them before the node).
      const lanes: number[] = [];
      const same: boolean[] = [];
      for (const ei of nd.edges) {
        const e = this.edges[ei];
        if (e.bus) continue;
        const L = e.b === j.node ? ei * 2 : ei * 2 + 1;
        if ((e.oneway && L & 1) || !this.stopD[L] || this.endNode(L) !== j.node) continue;
        const [ix, iy] = this.laneEndDir(L);
        lanes.push(L);
        same.push(ix * j.inX + iy * j.inY > 0.7);
      }
      if (!lanes.length) continue;
      // The bus's body over its way through: section rectangles (centre, unit axis, half length).
      rects.length = 0;
      const s0 = Math.max(0, j.s - 50);
      const s1 = Math.min(track.length, j.s + 50);
      for (let s = s0; s <= s1; s += 1) {
        track.sample(s, smp);
        for (let i = 0; i < ns; i++) {
          // Where it hangs from: the front axle on the lane, or the hitch on the section in front.
          const px = i === 0 ? smp.x : ax[i - 1] + hx[i - 1] * (secs[i - 1].axleFromFront - secs[i - 1].rearHitchFromFront);
          const py = i === 0 ? smp.y : ay[i - 1] + hy[i - 1] * (secs[i - 1].axleFromFront - secs[i - 1].rearHitchFromFront);
          if (s === s0) {
            // Start straight behind, along the lane.
            const bx = i === 0 ? smp.hx : hx[i - 1];
            const by = i === 0 ? smp.hy : hy[i - 1];
            ax[i] = px - bx * link[i];
            ay[i] = py - by * link[i];
          }
          let dx = px - ax[i];
          let dy = py - ay[i];
          const l = Math.hypot(dx, dy) || 1;
          dx /= l;
          dy /= l;
          ax[i] = px - dx * link[i];
          ay[i] = py - dy * link[i];
          hx[i] = dx;
          hy[i] = dy;
          // Front face to back face, about the axle.
          const f = secs[i].axleFromFront;
          const b = secs[i].length - f;
          const cx = ax[i] + (dx * (f - b)) / 2;
          const cy = ay[i] + (dy * (f - b)) / 2;
          if (Math.hypot(cx - nd.x, cy - nd.y) < 45) rects.push(cx, cy, dx, dy, (f + b) / 2);
        }
      }
      for (let li = 0; li < lanes.length; li++) {
        const L = lanes[li];
        const e = this.edges[L >> 1];
        const cap = Math.min(SWEEP_MAX, e.len - 2);
        const n = this.lanesIn(L);
        const hitK = (sd: number, k: number): boolean => {
          for (let q = 0; q < 2; q++) {
            const dc = sd + SWEEP_CAR_L / 2 - 0.6 + q * (SWEEP_CAR_L + 2);
            if (dc > e.len) break;
            this.at(L, e.len - dc, this.laneOffset(L, k), pt);
            for (let r = 0; r < rects.length; r += 5) {
              if (boxesTouch(pt.x, pt.y, pt.hx, pt.hy, SWEEP_CAR_L / 2, SWEEP_CAR_W / 2, rects[r], rects[r + 1], rects[r + 2], rects[r + 3], rects[r + 4], halfW)) return true;
            }
          }
          return false;
        };
        // (On the bus's own approach, not the lane it comes along, which it covers however far back.)
        const ks: number[] = [];
        for (let k = 0; k < n; k++) if (!same[li] || !hitK(cap, k)) ks.push(k);
        if (!ks.length) continue;
        const hit = (sd: number): boolean => ks.some((k) => hitK(sd, k));
        let sd = this.stopD[L];
        if (!hit(sd)) continue;
        while (sd < cap && hit(sd)) sd += 0.5;
        if (sd < cap) {
          this.stopD[L] = sd;
          moved++;
        }
      }
    }
    return moved;
  }

  /** Does `track` come in on one of `node`'s arms and leave on another, around its sample `i` (12 m either side)? */
  private passesThrough(node: number, track: RouteTrack, i: number): boolean {
    const ia = Math.max(0, i - 3);
    const ib = Math.min(track.n - 1, i + 3);
    let inArm = -1;
    let outArm = -1;
    for (const ei of this.nodes[node].edges) {
      const [dx, dy] = this.armDir(ei, node, 10);
      if (inArm < 0 && -(dx * track.tx[ia] + dy * track.ty[ia]) > 0.8) inArm = ei;
      else if (outArm < 0 && dx * track.tx[ib] + dy * track.ty[ib] > 0.8) outArm = ei;
    }
    return inArm >= 0 && outArm >= 0;
  }

  /** Unit direction from `node` to the point `d` m out along edge `ei` (steadier than its first segment). */
  private armDir(ei: number, node: number, d: number): [number, number] {
    const e = this.edges[ei];
    this.at(e.a === node ? ei * 2 : ei * 2 + 1, Math.min(d, e.len), 0, this.pt2);
    const nd = this.nodes[node];
    const dx = this.pt2.x - nd.x;
    const dy = this.pt2.y - nd.y;
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
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
      cutLane: -1,
      cutNext: -1,
      cutIdx: -1,
      cutA: 0,
      cutB: 0,
      cutLat: 0,
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
    const cls = classify(wrapAngle(Math.atan2(outX, outY) - Math.atan2(inX, inY)));
    if (nd.sig) {
      // On a short link between two nodes of one junction we are already in it:
      // its light was ours at the first node (asked again here with the link's
      // direction it would be some other arm's).
      const inside = this.insideLane[lane];
      const st = inside ? null : this.signalFor(N, inX, inY, time, outX, outY);
      if (st === 'red') return Wait.Red;
      if (st === 'amber' && stopAt > (c.v * c.v) / (2 * 3.5)) return Wait.Red;
      // No light for this movement (an arm no signal faces, a slip lane): give way to the cars that have one.
      if (!inside && st === null && this.conflictEta(N, inX, inY, outX, outY, cls, cls === Turn.Left ? GAP_LEFT : GAP_ACROSS) < Infinity) return Wait.Junction;
    } else {
      if (this.minorIn[lane] && nd.until > time && nd.holder !== lane) return nd.holder === PLAYER_HOLD ? Wait.Player : Wait.Junction;
    }
    // The player's bus coming up on the same approach in the next lane: a car whose way and the bus's
    // cross waits. It would turn across the bus's lane in front of it (left from the lane on its right,
    // right from the lane on its left), or the bus goes out across the car's (a busway leaving on the
    // right from the kerb lane: 222/0 s 2521); or the car is on the inside of the bus's turn, which its
    // tail cuts across (turning right beside it: 199/0 s 5062). A car crossing its path from another
    // arm gives way to it (playerConflict).
    const pc = nd.pc;
    if (pc && pc.until > time) {
      const dot = inX * pc.inX + inY * pc.inY;
      if (dot > 0.8) {
        const side = (c.x - pc.x) * pc.inY - (c.y - pc.y) * pc.inX;
        // (+: the bus's way out is to the right of ours.)
        const across = wrapAngle(Math.atan2(pc.outX, pc.outY) - Math.atan2(outX, outY));
        if (pc.near && ((side > 1.8 && (across > ACROSS || (cls === Turn.Right && pc.cls === Turn.Right))) || (side < -1.8 && (across < -ACROSS || (cls === Turn.Left && pc.cls === Turn.Left)))))
          return Wait.Player;
        // Our lane ends here (the road narrows by its offside lane) and the bus is coming along the one we
        // merge into: unless we are in, tail and all, a second before it gets there, we fall in behind it.
        // (Or just after, past a link too short to stop on: 61/0 s 4332 lost its lane 2.5 m on and
        // cut in across the bus's front.)
        let ends = c.laneIdx >= this.lanesIn(next);
        let extra = 0;
        if (!ends && depth === 0 && this.shortLink(next, nd.boxR, c.len)) {
          if (c.next2 < 0) c.next2 = this.chooseNext(next, Math.min(c.laneIdx, this.lanesIn(next) - 1));
          ends = c.next2 >= 0 && c.laneIdx >= this.lanesIn(c.next2);
          extra = this.edges[next >> 1].len;
        }
        if (
          depth === 0 &&
          side > 1.8 &&
          cls === Turn.Straight &&
          pc.cls === Turn.Straight &&
          ends &&
          outX * pc.outX + outY * pc.outY > 0.8 &&
          pc.eta < clearTime(c.v, Math.max(0, stopAt) + this.stopD[lane] + extra + c.len, CAR_A) + MERGE_MARGIN
        )
          return Wait.Player;
      } else if (this.playerConflict(N, inX, inY, outX, outY, cls, time, this.turnClear(c, lane, next, stopAt, nd.boxR))) return Wait.Player;
    }
    // The player's bus in (or about to enter) the box: waiting for it is legitimate.
    // (A car holding it from the queue in its exit, its tail still in the box, names the wait: as
    // legitimate as that queue.)
    if (!this.boxClear(N, c.id, inX, inY, outX, outY, cls, time)) {
      if (this.boxBy === PLAYER_HOLD) return Wait.Player;
      this.blockRef = Math.max(0, this.boxBy);
      return Wait.Junction;
    }
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
      if (c.next2 < 0) c.next2 = this.chooseNext(next, Math.min(c.laneIdx, this.lanesIn(next) - 1));
      if (c.next2 >= 0) return this.canGo(c, next, c.next2, stopAt + ne.len, time, 1);
    }
    return Wait.None;
  }

  /**
   * Seconds for car `c`, `stopAt` m short of its stop line on `lane`, to be through the box (radius boxR)
   * into `next`: slowing for the turn on the way, as simulate has it, and through the box at that speed.
   * (Timed at the speed it comes in with, a car 40 m out at 50 km/h turned right in front of the
   * player's bus 60 m off: it then slowed to 22 km/h for the turn.)
   */
  private turnClear(c: Car, lane: number, next: number, stopAt: number, boxR: number): number {
    const d0 = Math.max(0, stopAt);
    const d1 = 2 * boxR + c.len;
    const turn = Math.abs(this.turnAngle(lane, next));
    const vt = turn > 0.5 ? turnSpeed(turn) : Infinity;
    if (c.v <= vt) return clearTime(c.v, d0 + d1, CAR_A);
    return d0 / ((c.v + vt) / 2) + clearTime(vt, d1, CAR_A);
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
      if (c.next < 0 && remain < 70) c.next = this.chooseNext(c.lane, c.laneIdx);
      this.cutOf(c);
      const v0 = (e.limit / 3.6) * c.vWant;
      const A = CAR_A;
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
          const vt = turnSpeed(turn);
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
            gap = remain - c.cutA + o.u - c.cutB - (o.len + c.len) / 2;
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
        if (!list.some((o) => o !== c && !o.dead && o.laneIdx === to && Math.abs(o.u - c.u) < c.len + 6)) {
          c.laneIdx = to;
          // (A turn chosen from the old lane is chosen again from the new one, unless we are committed to it.)
          if (c.next >= 0 && !c.holds.some((h) => h.node === this.endNode(c.lane))) {
            c.next = -1;
            c.next2 = -1;
          }
        }
        c.busWait = 0;
      }
      // Our lane ends just ahead (the road narrows by it; or past a link too short to stop on, the one
      // after: 61/0 s 4332): we move over only into a gap, behind a bus alongside in the lane we merge
      // into, not across its front (a car merges in front of the player's bus at a junction only if it
      // is through in time: canGo).
      let mergeBlocked = false;
      if (c.next >= 0) {
        let mEnd = Infinity;
        let mLane = -1;
        if (c.laneIdx >= this.lanesIn(c.next)) {
          mEnd = remain;
          mLane = c.next;
        } else if (c.next2 >= 0 && this.edges[c.next >> 1].len < MERGE_SHORT && c.laneIdx >= this.lanesIn(c.next2)) {
          mEnd = remain + this.edges[c.next >> 1].len;
          mLane = c.next2;
        }
        if (mEnd < LANE_BLEND + 8) {
          // Where we would be in the lane we merge into: beside our tail (and a bus length's gap behind it) to our nose.
          const to = this.laneOffset(c.lane, Math.max(0, this.lanesIn(mLane) - 1));
          for (let q = -c.len / 2 - 4; q <= c.len / 2 + 1 && !mergeBlocked; q += 2.5) {
            const u = Math.min(e.len, Math.max(0, c.u + q));
            this.at(c.lane, u, to, pt);
            const hb = bg.nearest(pt.x, pt.y, 2.2, undefined, pt.z);
            if (hb >= 0) {
              mergeBlocked = true;
              lim(idm(Math.max(0.05, mEnd - c.len / 2 - 1), 0, 0.6), bg.pid[hb] === -1 ? Wait.Player : Wait.Bus, bg.pid[hb]);
            }
          }
        }
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
        if (!nd.sig && !this.minorIn[c.lane] && remain < 25) this.markMajor(N, time, c.lane);
        if (!c.holds.some((h) => h.node === N) && c.next >= 0) {
          // (To the stop line from our front, not our middle: waiting with the nose 2 m over it put
          // it in the near lane of a narrow road, the player's bus there passing a metre off it.)
          const stopAt = remain - sd - (c.len / 2 - 0.6);
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
      // Advance onto the next lane (at a left turn's corner, short of the node).
      let guard = 0;
      for (;;) {
        this.cutOf(c);
        const end = this.edges[c.lane >> 1].len - c.cutA;
        if (c.u <= end || guard++ >= 4) break;
        const over = c.u - end;
        const passed = this.endNode(c.lane);
        if (c.next < 0) c.next = this.chooseNext(c.lane, c.laneIdx);
        if (c.next < 0) {
          this.kill(c);
          break;
        }
        const cut = c.cutA > 0 && c.cutNext === c.next;
        const join = cut ? c.cutB : 0;
        for (const h of c.holds) if (h.node === passed && h.d < 0) h.d = join;
        if (cut) c.lat = c.cutLat;
        c.lane = c.next;
        c.next = c.next2;
        c.next2 = -1;
        c.u = over + join;
        c.sigI = 0;
        c.sigState = null;
        c.xsI = 0;
        c.xsCommit = -1;
        c.laneIdx = Math.min(c.laneIdx, this.lanesIn(c.lane) - 1);
      }
      if (c.dead) continue;
      let target = this.laneOffset(c.lane, c.laneIdx);
      // Carrying straight on into a lane further left (a divided road's carriageway, whose centreline
      // bends in to the undivided road's at the node): move over before the node, not after it with
      // the corner cut across the oncoming lane. (Further right waits for the far side. Where a one-way
      // road only gains a lane, its kerb moves out at the node, not before it: so do its lanes.)
      const left = this.edges[c.lane >> 1].len - c.u;
      const widens = c.next >= 0 && this.edges[c.lane >> 1].oneway && this.edges[c.next >> 1].oneway && this.lanesIn(c.next) > this.lanesIn(c.lane);
      if (c.next >= 0 && left < LANE_BLEND && !widens && !mergeBlocked) {
        const to = this.laneOffset(c.next, Math.min(c.laneIdx, this.lanesIn(c.next) - 1));
        const straight = Math.abs(this.turnAngle(c.lane, c.next)) < 0.5;
        if (to > target && straight) target += (to - target) * (1 - left / LANE_BLEND);
        else if (to < target && straight && this.edges[c.next >> 1].oneway) {
          // ...and into a one-way road's lane further right (no oncoming traffic there), as far as our half
          // of a two-way road allows, as the bus lanes do: the second lane's car, going over only past the
          // node, was still in the way of the player's bus moving over before it (61/1 s 3097).
          const to2 = this.edges[c.lane >> 1].oneway ? to : Math.max(to, CAR_HALF_W + 0.3);
          if (to2 < target) target += (to2 - target) * (1 - left / LANE_BLEND);
        }
      }
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
    // (cutOf is current: the car's update has just called it)
    const end = e.len - c.cutA;
    if (u <= end || c.next < 0) this.at(c.lane, Math.min(u, e.len), c.lat, out);
    else this.at(c.next, Math.min(u - end + c.cutB, this.edges[c.next >> 1].len), this.laneOffset(c.next, Math.min(c.laneIdx, this.lanesIn(c.next) - 1)), out);
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
