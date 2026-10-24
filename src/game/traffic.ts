// AI traffic: Brisbane buses driving their real routes around the player.
//
// Each AI bus follows its route's RouteTrack (left-lane path) with an IDM
// car-following model against every other bus and the player, slows for
// curves, stops at red signals (when the world exposes signalStateAt), and
// dwells at stops pulled in to the kerb with doors open, indicating out.
import * as THREE from 'three';
import type { BusFactory, BusLights, BusMesh, BusPose, BusSpec, BusType, Collider, MapData, Route, WorldHandle } from '../types';
import { wrapAngle } from '../data/coords';
import { busTypeForRoute, stopUsage } from './routeMeta';
import { TRACK_STEP, hasTrack, trackFor, type RouteTrack, type TrackSample, type TrackSignal, type TrackStop } from './track';
import type { MapMarker } from './minimap';
import { brighten, rng } from './util';
import { CarTraffic, PLAYER_HOLD, STALL_HIDDEN, STALL_VISIBLE, Wait, type BusJunction } from './cars';
import { TRAFFIC_CAPS, defaultTrafficLevel, type TrafficLevel } from './trafficLevel';
import { makeBody, type Body } from './bodies';
import { LEVEL_GAP, heightAt } from './height';
import { session } from './session';
import { buildPlatforms } from './platforms';
import { signalsFor } from '../data/signals';

const VIEW_DIST = 950;
const LOOK_MAX = 40;

const enum State {
  Drive = 0,
  Dwell = 1,
  Terminus = 2,
}

interface AiBus {
  id: number;
  route: Route;
  track: RouteTrack;
  type: BusType;
  key: string;
  mesh: BusMesh;
  spec: BusSpec;
  len: number;
  s: number;
  v: number;
  a: number;
  state: State;
  dwell: number;
  dwellTotal: number;
  nextStop: number;
  serve: boolean;
  door: number;
  pull: number;
  pullTarget: number;
  departT: number;
  sigIdx: number;
  sigState: 'green' | 'amber' | 'red' | null;
  sigTimer: number;
  sigCommit: boolean;
  /** Mid-block signals on the route (junction signals go through the reservations). */
  mids: TrackSignal[];
  /** Per junction of `jl`: how its light is asked (the guide's way, from the route's own signal), else null. */
  jAsk: (SignalAsk | null)[];
  /** Junctions on the route, the next one to commit to, and the ones we hold. */
  jl: BusJunction[];
  jNext: number;
  holds: number[];
  /** Bus id we are waiting behind (for the crossing tie-break), else 0. */
  obstacle: number;
  wait: Wait;
  exempt: boolean;
  idle: number;
  dead: boolean;
  /** Route distance at the last progress mark and seconds since it (jam breaker). */
  progS: number;
  stall: number;
  body: Body;
  pose: BusPose;
  lights: BusLights;
  visible: boolean;
  marker: MapMarker;
  age: number;
  turnSign: number;
}

/** Where and how a light is asked: the approach point and direction into its junction, and the level. */
interface SignalAsk {
  x: number;
  y: number;
  dx: number;
  dy: number;
  z: number;
}

interface Candidate {
  route: Route;
  track: RouteTrack;
  weight: number;
  inside: number[];
}

function totalLength(spec: BusSpec): number {
  let L = spec.sections[0].length;
  for (let i = 1; i < spec.sections.length; i++) {
    L += spec.sections[i].length - (spec.sections[i - 1].length - spec.sections[i - 1].rearHitchFromFront) - spec.sections[i].hitchFromFront;
  }
  return L;
}

/** IDM acceleration towards an obstacle at `gap` metres moving at `vLead`. */
function idm(v: number, v0: number, gap: number, vLead: number, s0: number): number {
  const A = 1.15;
  const B = 1.9;
  const T = 1.35;
  const free = 1 - Math.pow(v / Math.max(0.5, v0), 4);
  if (gap === Infinity) return A * free;
  const sStar = s0 + Math.max(0, v * T + (v * (v - vLead)) / (2 * Math.sqrt(A * B)));
  return A * (free - (sStar / Math.max(0.05, gap)) ** 2);
}

/** Time gap (s) at which the player's bus claims the main road through an unsignalised junction. */
const MAJOR_GAP = 6;

export class Traffic {
  private active: AiBus[] = [];
  private pool = new Map<string, BusMesh[]>();
  private candidates: Candidate[] = [];
  private candTimer = 0;
  private candCursor = 0;
  private candNext: Candidate[] = [];
  private spawnTimer = 0;
  private nextId = 1;
  private rand = rng(20240607);
  private buildQueue: Route[];
  private building = false;
  private initial = true;
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private tmp: TrackSample = { x: 0, y: 0, hx: 0, hy: 1, heading: 0 };
  private tmp2: TrackSample = { x: 0, y: 0, hx: 0, hy: 1, heading: 0 };
  private playerBody = makeBody(32);
  private playerLen = 12.5;
  /** Film/test runs (?film): fixed AI caps and track building per sim step, so runs are reproducible. */
  private film = false;
  /** AI buses in contact with the player's bus (id -> deepest body segment), from the last resolve(). */
  private touching = new Map<number, number>();
  private cap = { ax: 0, ay: 0, bx: 0, by: 0, r: 0, v: 0, heading: 0, z: 0 };
  private aheadHX = new Float32Array(LOOK_MAX);
  /** The vehicle that made the last junctionOk() fail on its exit (bus id or car id), else 0. */
  private jRef = 0;
  private aheadHY = new Float32Array(LOOK_MAX);
  private lastPlayerZ: number | undefined;
  private aheadX = new Float32Array(LOOK_MAX);
  private aheadY = new Float32Array(LOOK_MAX);
  private aheadZ = new Float32Array(LOOK_MAX);
  private playerSpec: BusSpec | null = null;
  private markersOut: MapMarker[] = [];
  private costEma = 0.5;
  private level: TrafficLevel = defaultTrafficLevel();
  private capBuses = TRAFFIC_CAPS[this.level].buses;
  private maxActive = this.capBuses;
  private radius = 1100;
  private byId = new Map<number, AiBus>();
  private plans = new WeakMap<RouteTrack, { mids: TrackSignal[]; jAsk: (SignalAsk | null)[] }>();
  private asks = new WeakMap<TrackSignal, SignalAsk>();
  private bodiesOut: Body[] = [];
  private exemptOut: boolean[] = [];
  /** Dev: simulate the traffic this many times per frame (?tff=N). */
  private ffSteps = 1;
  private ffExtra = 0;
  /** Dev: seconds to pre-simulate once the population is up (?twarm=S). */
  private warm = 0;
  /** Despawn counters (diagnostics). */
  readonly stats = { overlapDespawns: 0, stuckDespawns: 0, stallDespawns: 0, capDespawns: 0 };
  /** Recent safety-valve events (diagnostics). */
  readonly events: string[] = [];
  private costTimer = 0;
  private hours = 12;
  private created = 0;
  private usage: Float32Array;
  readonly cars: CarTraffic;
  /** Seconds of CPU spent in the last update (for diagnostics). */
  lastCostMs = 0;

  constructor(
    readonly scene: THREE.Scene,
    readonly data: MapData,
    readonly buses: BusFactory,
    readonly world: WorldHandle,
  ) {
    this.usage = stopUsage(data);
    try {
      this.film = new URLSearchParams(location.search).has('film');
    } catch {
      /* no location (tests) */
    }
    // Build route tracks in the background, busiest routes first.
    this.buildQueue = [...data.routes].sort((a, b) => b.trips - a.trips);
    this.scheduleBuild();
    this.cars = new CarTraffic(scene, data, world);
    this.cars.fixedCaps = this.film;
    // Film/test runs: the traffic is inspectable from the page (window.__traffic.debugNear).
    if (this.film) Object.assign(globalThis, { __traffic: this });
    buildPlatforms(scene, data);
    session.traffic = this;
    session.world = world;
    try {
      const q = new URLSearchParams(location.search);
      this.ffSteps = Math.max(1, Math.min(40, Math.round(Number(q.get('tff') ?? 1)) || 1));
      this.warm = Math.max(0, Math.min(600, Number(q.get('twarm') ?? 0) || 0));
    } catch {
      /* no location (tests) */
    }
    this.setLevel(this.level);
    this.prewarm();
  }

  private scheduleBuild(): void {
    // (Film runs build a few tracks per sim step instead: see simulate.)
    if (this.film || this.building || !this.buildQueue.length) return;
    this.building = true;
    setTimeout(() => {
      this.building = false;
      const t0 = performance.now();
      while (this.buildQueue.length && performance.now() - t0 < 6) trackFor(this.buildQueue.shift()!, this.data);
      this.scheduleBuild();
    }, 4);
  }

  /** Prioritise building tracks for routes near (x, y). */
  private prioritise(x: number, y: number): void {
    const near: Route[] = [];
    const far: Route[] = [];
    for (const r of this.buildQueue) (this.routeNear(r, x, y, this.radius + 300) ? near : far).push(r);
    this.buildQueue = [...near, ...far];
  }

  private routeNear(r: Route, x: number, y: number, R: number): boolean {
    const p = r.pts;
    const R2 = R * R;
    for (let i = 0; i < p.length; i += 2) {
      const dx = p[i] - x;
      const dy = p[i + 1] - y;
      if (dx * dx + dy * dy < R2) return true;
    }
    return false;
  }

  /** Rebuild the spawn candidates incrementally (a slice of routes per call). */
  private refreshCandidates(px: number, py: number, all: boolean): void {
    const R2 = this.radius * this.radius;
    const routes = this.data.routes;
    if (this.candCursor === 0) this.candNext = [];
    const end = all ? routes.length : Math.min(routes.length, this.candCursor + 60);
    for (let k = this.candCursor; k < end; k++) {
      const r = routes[k];
      if (!hasTrack(r)) continue;
      const track = trackFor(r, this.data);
      const inside: number[] = [];
      const c = track.coarse;
      for (let i = 0; i < c.length; i += 3) {
        const dx = c[i + 1] - px;
        const dy = c[i + 2] - py;
        if (dx * dx + dy * dy < R2) inside.push(c[i]);
      }
      if (!inside.length) continue;
      this.candNext.push({ route: r, track, weight: r.trips * inside.length * 0.04, inside });
    }
    this.candCursor = end >= routes.length ? 0 : end;
    if (this.candCursor === 0) this.candidates = this.candNext;
  }

  /** Pool key: meshes are interchangeable when type and livery match (mirrors bus/livery.ts). */
  private poolKey(route: Route, type: BusType): string {
    if (type === 'metro') return 'metro';
    if (type === 'glider') return route.id === '61' ? 'glider:maroon' : 'glider:blue';
    if (route.id === '40' || route.id === '50') return 'rigid:loop';
    if (route.id === '60') return 'rigid:blue';
    if (route.id === '61') return 'rigid:maroon';
    if (route.operator && route.operator !== 'BT' && route.operator !== 'MET') return 'rigid:contract';
    return 'rigid:translink';
  }

  private createMesh(route: Route, type: BusType): BusMesh {
    const mesh = this.buses.createBus({ type, route, detail: 'low' });
    for (const s of mesh.sections) this.scene.add(s);
    mesh.setInteriorView(false);
    this.created++;
    return mesh;
  }

  /** Build a typical mix of AI meshes in idle time (e.g. while the menu is open). */
  private prewarm(): void {
    const want: [string, number][] = [
      ['rigid:translink', 28],
      ['rigid:contract', 3],
      ['rigid:loop', 2],
      ['metro', 4],
      ['glider:blue', 3],
      ['glider:maroon', 3],
    ];
    const sample = new Map<string, Route>();
    for (const r of this.data.routes) {
      const k = this.poolKey(r, busTypeForRoute(r));
      if (!sample.has(k)) sample.set(k, r);
    }
    const jobs: string[] = [];
    for (const [k, n] of want) if (sample.has(k)) for (let i = 0; i < n; i++) jobs.push(k);
    const tick = () => {
      const t0 = performance.now();
      while (jobs.length && performance.now() - t0 < 5) {
        const k = jobs.shift()!;
        const route = sample.get(k)!;
        const type = busTypeForRoute(route);
        let list = this.pool.get(k);
        if (!list) this.pool.set(k, (list = []));
        if (list.length + this.active.filter((b) => b.key === k).length >= 60) continue;
        const mesh = this.createMesh(route, type);
        for (const s of mesh.sections) s.visible = false;
        list.push(mesh);
      }
      if (jobs.length) setTimeout(tick, 30);
    };
    setTimeout(tick, 200);
  }

  private acquireMesh(route: Route, type: BusType): { mesh: BusMesh; key: string } {
    const key = this.poolKey(route, type);
    const list = this.pool.get(key);
    let mesh = list?.pop();
    if (!mesh) mesh = this.createMesh(route, type);
    for (const s of mesh.sections) s.visible = true;
    mesh.setDestination({ route: route.id, headsign: route.headsign });
    return { mesh, key };
  }

  private release(b: AiBus): void {
    for (const s of b.mesh.sections) s.visible = false;
    let list = this.pool.get(b.key);
    if (!list) this.pool.set(b.key, (list = []));
    list.push(b.mesh);
  }

  private spawn(c: Candidate, px: number, py: number): boolean {
    const r = c.route;
    const s = c.inside[Math.floor(this.rand() * c.inside.length)] + (this.rand() - 0.5) * 36;
    if (s < 30 || s > r.length - 60) return false;
    c.track.sample(s, this.tmp);
    const dx = this.tmp.x - px;
    const dy = this.tmp.y - py;
    const d = Math.hypot(dx, dy);
    if (d > this.radius) return false;
    if (this.initial ? d < 45 : d < 120) return false;
    if (this.shadowsPlayer(r, s)) return false;
    const zs = c.track.zAt(s);
    if (!this.initial && d < 500) {
      this.sphere.center.set(this.tmp.x, zs + 2, -this.tmp.y);
      this.sphere.radius = 14;
      if (this.frustum.intersectsSphere(this.sphere)) return false;
    }
    // Never spawn in or right before a junction box.
    for (const j of this.cars.junctionsAlong(c.track)) if (Math.abs(j.s - s) < j.boxR + 22) return false;
    // Keep clear of other buses on the same stretch.
    for (const o of this.active) {
      const b = o.body;
      for (let k = 0; k < b.n; k++) {
        if (Math.abs(b.x[k] - this.tmp.x) < 26 && Math.abs(b.y[k] - this.tmp.y) < 26 && Math.abs(b.z[k] - zs) <= LEVEL_GAP && Math.hypot(b.x[k] - this.tmp.x, b.y[k] - this.tmp.y) < 26) return false;
      }
    }
    const type = busTypeForRoute(r);
    const spec = this.buses.specFor(type);
    const { mesh, key } = this.acquireMesh(r, type);
    let nextStop = 0;
    while (nextStop < r.stops.length && r.stops[nextStop].s < s + 8) nextStop++;
    const len = totalLength(spec);
    const nb = Math.max(3, Math.ceil(len / 3.5) + 1);
    const b: AiBus = {
      id: this.nextId++,
      route: r,
      track: c.track,
      type,
      key,
      mesh,
      spec,
      len,
      s,
      v: Math.min(c.track.vmaxAt(s), 7 + this.rand() * 4),
      a: 0,
      state: State.Drive,
      dwell: 0,
      dwellTotal: 0,
      nextStop,
      serve: false,
      door: 0,
      pull: 0,
      pullTarget: 0,
      departT: -100,
      sigIdx: 0,
      sigState: null,
      sigTimer: 0,
      sigCommit: false,
      mids: this.signalPlan(c.track).mids,
      jAsk: this.signalPlan(c.track).jAsk,
      jl: this.cars.junctionsAlong(c.track),
      jNext: 0,
      holds: [],
      obstacle: 0,
      wait: Wait.None,
      exempt: false,
      idle: 0,
      dead: false,
      progS: s,
      stall: 0,
      body: makeBody(nb),
      pose: {
        x: 0,
        y: 0,
        heading: 0,
        speed: 0,
        steer: 0,
        wheelSpin: this.rand() * 6,
        z: 0,
        sections: spec.sections.map(() => ({ x: 0, y: 0, heading: 0, z: 0, pitch: 0 })),
        roll: 0,
        pitch: 0,
      },
      lights: { headlights: false, brake: false, reverse: false, indicatorLeft: false, indicatorRight: false, hazards: false },
      visible: true,
      marker: { x: 0, y: 0, heading: 0, color: brighten(r.color, 0.25), length: len },
      age: 0,
      turnSign: 0,
    };
    b.serve = this.decideServe(b);
    while (b.sigIdx < b.mids.length && b.mids[b.sigIdx].s < s) b.sigIdx++;
    while (b.jNext < b.jl.length && b.jl[b.jNext].stopS < s + 2) b.jNext++;
    this.updateBody(b);
    this.active.push(b);
    return true;
  }

  /**
   * Would an AI bus of route r at s run just ahead of (or right behind) the
   * player on its own route? Real headways are minutes apart; a twin a few
   * hundred metres ahead would take every stop and every light first.
   */
  private shadowsPlayer(r: Route, s: number): boolean {
    const g = session.guide;
    if (!g?.route || !g.state || g.route.id !== r.id || g.route.dir !== r.dir) return false;
    return s > g.state.s - 400 && s < g.state.s + 1500;
  }

  private decideServe(b: AiBus): boolean {
    const st = b.route.stops[b.nextStop];
    if (!st) return false;
    const ts = b.track.stops[b.nextStop];
    if (ts?.station) return true;
    const u = this.usage[st.stop];
    return this.rand() < Math.min(0.92, 0.4 + u / 1600);
  }

  private updateBody(b: AiBus): void {
    const body = b.body;
    const step = b.len / (body.n - 1);
    for (let k = 0; k < body.n; k++) {
      b.track.sample(b.s - k * step, this.tmp, b.pull);
      body.x[k] = this.tmp.x;
      body.y[k] = this.tmp.y;
      body.z[k] = b.track.zAt(b.s - k * step);
      if (k === 0) body.heading = this.tmp.heading;
    }
    body.fx = body.x[0];
    body.fy = body.y[0];
    body.fz = body.z[0];
    body.speed = b.v;
  }

  private updatePlayerBody(p: BusPose): void {
    const n = p.sections.length;
    if (!this.playerSpec || this.playerSpec.sections.length !== n) this.playerSpec = this.buses.specFor(n >= 3 ? 'metro' : 'rigid');
    const spec = this.playerSpec;
    const body = this.playerBody;
    const z0 = this.playerZ(p);
    let k = 0;
    for (let i = 0; i < n && i < spec.sections.length; i++) {
      const sec = p.sections[i];
      const ss = spec.sections[i];
      const hx = Math.sin(sec.heading);
      const hy = Math.cos(sec.heading);
      const front = ss.axleFromFront;
      const rear = ss.length - ss.axleFromFront;
      const sz = sec.z ?? z0;
      const tg = Math.tan(sec.pitch ?? 0);
      // At most ~2 m apart (an AI path probe with the contact radius cannot pass between them).
      const m = Math.min(10, Math.max(2, Math.ceil(ss.length / 2) + 1));
      for (let j = 0; j < m && k < body.x.length; j++) {
        const t = front - ((front + rear) * j) / (m - 1);
        body.x[k] = sec.x + hx * t;
        body.y[k] = sec.y + hy * t;
        body.z[k] = sz + tg * t;
        k++;
      }
    }
    body.n = k;
    body.heading = p.heading;
    body.speed = p.speed;
    let L = spec.sections[0].length;
    for (let i = 1; i < spec.sections.length && i < n; i++) L += spec.sections[i].length - (spec.sections[i - 1].length - spec.sections[i - 1].rearHitchFromFront) - spec.sections[i].hitchFromFront;
    this.playerLen = L;
    body.fx = body.x[0];
    body.fy = body.y[0];
    body.fz = body.z[0];
  }

  /**
   * The player's road height: the pose's own z when physics provides it,
   * otherwise the surface under the bus, kept on the level it was last on.
   */
  private playerZ(p: BusPose): number {
    if (p.z !== undefined) return (this.lastPlayerZ = p.z);
    const z = heightAt(p.x, p.y, session.playerZ ?? this.lastPlayerZ);
    this.lastPlayerZ = z;
    return z;
  }

  /**
   * Advance the AI. `hours` (optional) switches headlights on at night.
   * Call after the player's physics so the player's pose is current.
   */
  /** Traffic density: 'off', 'light' (default) or 'normal'. */
  setLevel(level: TrafficLevel): void {
    this.level = level;
    const caps = TRAFFIC_CAPS[level];
    this.capBuses = caps.buses;
    this.maxActive = Math.min(Math.max(this.maxActive, 1), caps.buses);
    if (level !== 'off' && this.maxActive < Math.min(18, caps.buses)) this.maxActive = Math.min(18, caps.buses);
    this.radius = level === 'normal' ? 1400 : 1100;
    this.cars.setCaps(caps.cars, caps.carRadius);
    this.cars.enabled = caps.cars > 0;
    this.candTimer = 0;
  }

  get trafficLevel(): TrafficLevel {
    return this.level;
  }

  /**
   * Advance the AI. `hours` (optional) switches headlights on at night.
   * Call after the player's physics so the player's pose is current.
   */
  update(dt: number, timeSeconds: number, player: BusPose, camera: THREE.Camera, hours?: number): void {
    const t0 = performance.now();
    if (hours !== undefined) this.hours = hours;
    else if (session.hours !== null) this.hours = session.hours;
    if (session.trafficLevel && session.trafficLevel !== this.level) this.setLevel(session.trafficLevel);
    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const cam = camera.position;

    for (let k = 0; k < this.ffSteps; k++) {
      if (k > 0) this.ffExtra += dt;
      this.simulate(dt, timeSeconds + this.ffExtra, player);
    }
    if (this.warm > 0 && !this.initial) {
      // Dev fast-forward: run the traffic for a while without drawing it.
      const steps = Math.round(this.warm * 20);
      this.warm = 0;
      for (let k = 0; k < steps; k++) {
        this.ffExtra += 0.05;
        this.simulate(0.05, timeSeconds + this.ffExtra, player);
      }
    }
    const time = timeSeconds + this.ffExtra;

    // Visuals (frustum + distance culled).
    for (const b of this.active) {
      const body = b.body;
      const mid = body.n >> 1;
      const cx = body.x[mid];
      const cy = body.y[mid];
      const dist = Math.hypot(cx - cam.x, -cy - cam.z);
      this.sphere.center.set(cx, body.z[mid] + 2, -cy);
      this.sphere.radius = b.len / 2 + 3;
      const vis = dist < VIEW_DIST && this.frustum.intersectsSphere(this.sphere);
      if (vis !== b.visible) {
        b.visible = vis;
        for (const s of b.mesh.sections) s.visible = vis;
      }
      const m = b.marker;
      m.x = cx;
      m.y = cy;
      m.heading = body.heading;
      if (!vis) continue;
      this.pose(b, dt);
      b.mesh.setPose(b.pose);
      b.mesh.setLights(b.lights, time);
      b.mesh.setDoors(b.door);
    }
    this.cars.render(this.frustum, cam, this.hours);

    // Adaptive cap keeps the AI inside its frame budget.
    const cost = performance.now() - t0;
    this.lastCostMs = cost;
    this.costEma += (cost / this.ffSteps - this.costEma) * 0.05;
    this.costTimer -= dt;
    if (this.film) this.maxActive = this.capBuses;
    else if (this.costTimer <= 0) {
      this.costTimer = 1;
      if (this.costEma > 1.4 && this.maxActive > 12) this.maxActive--;
      else if (this.costEma < 0.9 && this.maxActive < this.capBuses) this.maxActive++;
      if (this.maxActive > this.capBuses) this.maxActive = this.capBuses;
    }
    if (this.buildQueue.length) this.scheduleBuild();
  }

  /** One simulation step of the buses and cars (no drawing). */
  private simulate(dt: number, time: number, player: BusPose): void {
    const px = player.x;
    const py = player.y;
    this.updatePlayerBody(player);

    if (this.initial && !this.candidates.length) this.prioritise(px, py);
    // Film runs: tracks are built per sim step (not per wall-clock slice), so what exists when is reproducible.
    if (this.film) for (let k = 0; k < 3 && this.buildQueue.length; k++) trackFor(this.buildQueue.shift()!, this.data);
    this.candTimer -= dt;
    if (this.candCursor !== 0 || this.candTimer <= 0) {
      if (this.candCursor === 0) this.candTimer = this.candidates.length ? 2 : 0.5;
      this.refreshCandidates(px, py, !this.candidates.length);
    }

    // Despawn far away / finished / stuck buses.
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];
      const d = Math.hypot(b.body.fx - px, b.body.fy - py);
      // End of the trip: gone once out of view, or a few seconds after its last
      // dwell (it never holds a terminal's front bay for long).
      const done = b.state === State.Terminus && b.dwell <= 0 && (!b.visible || b.dwell < -6);
      const stuck = b.idle > (b.visible ? 45 : 25);
      // Jam breaker: no progress for minutes whatever the reason (exempt waits included).
      const stalled = !stuck && b.stall > (b.visible ? STALL_VISIBLE : STALL_HIDDEN);
      // The player's own route just ahead of or behind the player (e.g. spawned before the guide existed).
      const twin = !b.visible && this.shadowsPlayer(b.route, b.s);
      if (stuck || stalled) {
        if (stuck) this.stats.stuckDespawns++;
        else this.stats.stallDespawns++;
        const j = b.jl[b.jNext];
        this.events.push(`bus ${b.route.id} ${stuck ? 'stuck' : 'stalled'} wait ${b.wait} obst ${b.obstacle} s ${b.s.toFixed(0)} next j ${j ? `${j.node} stop ${(j.stopS - b.s).toFixed(1)} sig ${j.sig} minor ${j.minor}` : '-'} holds ${b.holds.length}`);
        if (this.events.length > 30) this.events.shift();
      }
      if (b.dead || d > this.radius + 300 || done || stuck || stalled || twin) this.removeBus(i);
    }
    // Over the cap (the level was lowered, or the CPU budget shrank): the
    // farthest bus out of view goes first, never one in view within 300 m.
    if (this.active.length > this.maxActive + 4) {
      let pick = -1;
      let score = -1;
      this.active.forEach((b, i) => {
        const d = Math.hypot(b.body.fx - px, b.body.fy - py);
        if (b.visible && d < 300) return;
        const sc = d + (b.visible ? 0 : 1e5);
        if (sc > score) {
          score = sc;
          pick = i;
        }
      });
      if (pick >= 0) {
        this.removeBus(pick);
        this.stats.capDespawns++;
      }
    }

    // Spawn to keep the population up.
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.candidates.length && this.capBuses > 0) {
      this.spawnTimer = this.initial ? 0 : 0.35;
      let sumW = 0;
      for (const c of this.candidates) sumW += c.weight;
      const desired = Math.min(this.maxActive, Math.max(6, Math.round(sumW / 300)));
      let tries = this.initial ? 60 : 6;
      let made = 0;
      const maxMade = this.initial ? 10 : 2;
      while (this.active.length < desired && tries-- > 0 && made < maxMade) {
        let pick = this.rand() * sumW;
        let c = this.candidates[0];
        for (const cc of this.candidates) {
          pick -= cc.weight;
          if (pick <= 0) {
            c = cc;
            break;
          }
        }
        if (this.spawn(c, px, py)) made++;
      }
      // Populate freely (even in view) until the background track builder has caught up.
      if (this.initial && !this.buildQueue.length && (this.active.length >= desired || tries <= 0)) this.initial = false;
    } else if (this.capBuses === 0 && this.initial && !this.buildQueue.length) this.initial = false;

    this.byId.clear();
    for (const b of this.active) this.byId.set(b.id, b);
    this.claimJunctions(time, player);
    for (const b of this.active) this.step(b, dt, time);
    for (const b of this.active) this.updateBody(b);

    // Safety valve: a bus that has driven into another bus is removed (the one behind).
    for (const a of this.active) {
      if (a.dead) continue;
      const fx = a.body.fx;
      const fy = a.body.fy;
      for (const o of this.active) {
        if (o === a || o.dead) continue;
        if (Math.abs(o.body.fx - fx) > o.len + 6 || Math.abs(o.body.fy - fy) > o.len + 6) continue;
        const body = o.body;
        let hit = false;
        const fz = a.body.fz;
        for (let q = 0; q < body.n && !hit; q++) hit = Math.hypot(body.x[q] - fx, body.y[q] - fy) < 1.6 && Math.abs(body.z[q] - fz) <= LEVEL_GAP;
        if (hit) {
          a.dead = true;
          this.stats.overlapDespawns++;
          this.events.push(`bus overlap ${a.route.id} into ${o.route.id} v ${a.v.toFixed(1)}/${o.v.toFixed(1)}`);
          break;
        }
      }
    }

    const bodies = this.bodiesOut;
    const exempt = this.exemptOut;
    bodies.length = 0;
    exempt.length = 0;
    for (const b of this.active) {
      if (b.dead) continue;
      bodies.push(b.body);
      exempt.push(b.exempt);
    }
    this.cars.simulate(dt, time, player, this.playerBody, bodies, exempt, this.frustum);
  }

  /**
   * The player's bus takes part in the junction rules like an AI bus: on its
   * route's main road it marks unsignalised junctions busy (side roads give
   * way), and it holds a junction box while in it or too close to stop.
   */
  private claimJunctions(time: number, player: BusPose): void {
    const g = session.guide;
    if (!g?.track || !g.state || g.state.offRoute) return;
    const jl = this.cars.junctionsAlong(g.track);
    const s = g.state.s;
    const v = Math.abs(player.speed);
    const len = this.playerLen;
    let lo = 0;
    let hi = jl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (jl[mid].s + jl[mid].boxR + len < s) lo = mid + 1;
      else hi = mid;
    }
    // Side roads and merges give way to the player from MAJOR_GAP s away (a
    // fixed 30 m was 1.5 s at busway speed: a bus merging from a station or a
    // ramp had already committed and pulled out in front).
    const ahead = Math.max(30, v * MAJOR_GAP);
    for (let k = lo; k < jl.length && jl[k].s - s < ahead + 10; k++) {
      const j = jl[k];
      if (j.s + j.boxR + len < s) continue;
      if (!j.sig && !j.minor && v > 1 && j.s - s < ahead) this.cars.markMajor(j.node, time, PLAYER_HOLD);
      const inBox = s > j.s - j.boxR;
      const committed = v > 1 && j.stopS - s < (v * v) / (2 * 3) + 2;
      if (inBox || committed) this.cars.enter(j.node, PLAYER_HOLD, j.inX, j.inY, j.outX, j.outY, j.cls, time + 0.5);
    }
  }

  private removeBus(i: number): void {
    const b = this.active[i];
    for (const q of b.holds) this.cars.leave(b.jl[q].node, -b.id);
    b.holds.length = 0;
    this.release(b);
    this.active.splice(i, 1);
  }

  /** How a track signal is asked for: the approach point and direction into its junction, and the level. */
  private signalAsk(tr: RouteTrack, sig: TrackSignal): SignalAsk {
    let q = this.asks.get(sig);
    if (!q) {
      const z = tr.zAt(sig.s);
      const ad = signalsFor(this.data).approachDir(sig.x, sig.y, z, (s, o) => Object.assign(o, tr.sample(s, this.tmp2)), sig.s);
      tr.sample(sig.s, this.tmp2);
      q = ad ? { x: ad.x, y: ad.y, dx: ad.dx, dy: ad.dy, z } : { x: sig.x, y: sig.y, dx: this.tmp2.hx, dy: this.tmp2.hy, z };
      this.asks.set(sig, q);
    }
    return q;
  }

  /**
   * How a route's lights are obeyed. A track signal at a signalised junction
   * the bus manages through the reservations is that junction's light, asked
   * exactly as the player's guide asks it (so the AI and the HUD agree); every
   * other track signal is a mid-block light obeyed at its own stop line.
   */
  private signalPlan(track: RouteTrack): { mids: TrackSignal[]; jAsk: (SignalAsk | null)[] } {
    let p = this.plans.get(track);
    if (!p) {
      const jl = this.cars.junctionsAlong(track);
      const model = signalsFor(this.data);
      const jAsk: (SignalAsk | null)[] = jl.map(() => null);
      const mids = track.signals.filter((sg) => {
        const q = this.signalAsk(track, sg);
        const ji = model.junctionAt(q.x, q.y, q.dx, q.dy, q.z);
        if (ji < 0) return true;
        let managed = false;
        jl.forEach((j, k) => {
          if (!j.sig || Math.abs(j.s - sg.s) >= 30 || this.cars.signalJunction(j.node, j.inX, j.inY) !== ji) return;
          managed = true;
          jAsk[k] ??= q;
        });
        return !managed;
      });
      this.plans.set(track, (p = { mids, jAsk }));
    }
    return p;
  }

  private step(b: AiBus, dt: number, time: number): void {
    const tr = b.track;
    const L = tr.length;
    b.age += dt;
    const stops = b.route.stops;
    const lights = b.lights;
    lights.headlights = this.hours < 6.6 || this.hours > 17.9;
    this.refreshHolds(b, time);

    if (b.state === State.Dwell || b.state === State.Terminus) {
      b.v = 0;
      b.a = 0;
      b.dwell -= dt;
      b.wait = Wait.None;
      b.exempt = true;
      b.idle = 0;
      b.progS = b.s;
      b.stall = 0;
      const opening = b.dwellTotal - b.dwell > 0.8 && b.dwell > 2.4;
      b.door = Math.max(0, Math.min(1, b.door + (opening ? dt : -dt) / 1.4));
      lights.brake = true;
      lights.indicatorLeft = false;
      lights.indicatorRight = b.state === State.Dwell && b.dwell < 3.5;
      lights.hazards = false;
      if (b.state === State.Dwell && b.dwell <= 0 && b.door <= 0.01) {
        b.state = State.Drive;
        b.departT = time;
        b.nextStop++;
        b.serve = this.decideServe(b);
      }
      return;
    }

    // Free-road speed from the track profile.
    const v0 = tr.vmaxAt(b.s + Math.min(10, b.v * 0.8));
    let acc = idm(b.v, v0, Infinity, 0, 2);
    const wt: { why: Wait; ref: number } = { why: Wait.None, ref: 0 };
    const lim = (a: number, w: Wait, ref = 0) => {
      if (a < acc) {
        acc = a;
        wt.why = w;
        wt.ref = ref;
      }
    };

    // Next stop.
    const st = stops[b.nextStop];
    if (st) {
      // At a busway platform the front bay is the target; queued behind
      // another bus inside the platform we serve the bay we are at.
      // (Tracks that give each stop its own front target and pull, src/game/track.ts, are used as given.)
      const ts = tr.stops[b.nextStop] as (TrackStop & { target?: number; pull?: number }) | undefined;
      const zone = ts?.zone;
      const gap = (ts?.target ?? (zone ? zone.s1 - 1.5 : st.s)) - b.s;
      const atBay = !!zone && b.s > zone.s0 + 10 && b.s < zone.s1 + 1 && b.v < 0.3 && b.wait === Wait.Bus;
      if (b.serve) {
        if ((gap < 1.2 && b.v < 0.35) || atBay) {
          b.state = State.Dwell;
          b.dwellTotal = b.dwell = 9 + this.rand() * 11;
          b.v = 0;
          return;
        }
        if (gap < 140) acc = Math.min(acc, idm(b.v, v0, gap + 0.6, 0, 0.6));
        // Kerbside stops pull in to the kerb (where one was found near the lane);
        // at platforms the lane already runs along the platform edge.
        const kerb = tr.kerbAt(st.s);
        const pull = ts?.pull !== undefined ? Math.max(0, Math.min(3, ts.pull)) : !zone && !ts?.station && kerb < 4.5 ? Math.max(0, Math.min(1.8, kerb - 1.75)) : 0;
        b.pullTarget = gap < 45 ? pull : 0;
      } else if (gap < -2) {
        b.nextStop++;
        b.serve = this.decideServe(b);
      }
    }
    if (b.s >= L - 3 && b.v < 0.6) {
      b.state = State.Terminus;
      // Passengers already got off at the last stop's dwell.
      b.dwellTotal = b.dwell = time - b.departT < 30 ? 2 : 8;
      b.v = 0;
      return;
    }
    if (b.s > L - 120) acc = Math.min(acc, idm(b.v, v0, L - 1 - b.s, 0, 0.5));

    // Pull back out after a stop.
    if (time - b.departT < 6 && (!st || st.s - b.s > 45 || !b.serve)) b.pullTarget = 0;
    b.pull += Math.max(-dt * 0.45, Math.min(dt * 0.45, b.pullTarget - b.pull));

    // Junctions: same reservations as the cars (signal, box, exit room).
    const jl = b.jl;
    while (b.jNext < jl.length && jl[b.jNext].stopS < b.s - 2) b.jNext++;
    const j = jl[b.jNext];
    if (j) {
      if (!j.sig && !j.minor && j.s - b.s < Math.max(30, b.v * 4)) this.cars.markMajor(j.node, time, -1);
      const stopAt = j.stopS - b.s;
      const commitDist = Math.max(3, (b.v * b.v) / (2 * 2.2)) + 2;
      if (stopAt < commitDist + 35) {
        // Junctions closer together than our length are taken in one go.
        let res = this.junctionOk(b, b.jNext, stopAt, time);
        let k = b.jNext + 1;
        while (res === Wait.None && k < jl.length && jl[k].s - j.s < j.boxR + jl[k].boxR + b.len) {
          res = this.junctionOk(b, k, stopAt + (jl[k].stopS - j.stopS), time);
          k++;
        }
        if (res !== Wait.None) lim(idm(b.v, v0, Math.max(0.05, stopAt), 0, 0.8), res, this.jRef);
        else if (stopAt <= commitDist) {
          for (let q = b.jNext; q < k; q++) {
            const jq = jl[q];
            this.cars.enter(jq.node, -b.id, jq.inX, jq.inY, jq.outX, jq.outY, jq.cls, time + 4);
            b.holds.push(q);
          }
          b.jNext = k;
        }
      }
    }

    // Mid-block signals (pedestrian lights).
    const signalAt = this.world.signalStateAt;
    const mids = b.mids;
    while (b.sigIdx < mids.length && mids[b.sigIdx].s < b.s - 1) {
      b.sigIdx++;
      b.sigState = null;
      b.sigCommit = false;
    }
    const sig = mids[b.sigIdx];
    if (sig && signalAt) {
      const gap = sig.s - b.s;
      if (gap < 80) {
        b.sigTimer -= dt;
        if (b.sigTimer <= 0 || b.sigState === null) {
          b.sigTimer = 0.25;
          // Asked the way the player's guide asks (same approach point, direction and level).
          const q = this.signalAsk(tr, sig);
          b.sigState = signalAt.call(this.world, q.x, q.y, time, q.dx, q.dy, q.z);
        }
        const stopDist = (b.v * b.v) / (2 * 2.6);
        if (b.sigState === 'red' || (b.sigState === 'amber' && !b.sigCommit && gap > stopDist + 1)) {
          if (!b.sigCommit) lim(idm(b.v, v0, gap, 0, 1.0), Wait.Red);
        } else if (gap < 6) b.sigCommit = true;
      }
    }

    // Car following against other buses, the player and cars: sample our
    // path ahead once, then test every nearby body against it.
    const look = 9 + b.v * 3.2;
    const bodyF = b.body;
    const ns = Math.min(LOOK_MAX, Math.floor((look - 1.5) / 2.5) + 1);
    const ax = this.aheadX;
    const ay = this.aheadY;
    const az = this.aheadZ;
    const ahx = this.aheadHX;
    const ahy = this.aheadHY;
    for (let k = 0; k < ns; k++) {
      tr.sample(b.s + 1.5 + k * 2.5, this.tmp2, b.pull);
      ax[k] = this.tmp2.x;
      ay[k] = this.tmp2.y;
      ahx[k] = this.tmp2.hx;
      ahy[k] = this.tmp2.hy;
      az[k] = tr.zAt(b.s + 1.5 + k * 2.5);
    }
    let bestGap = Infinity;
    let bestV = 0;
    let bestId = 0;
    let bestKind: Wait = Wait.None;
    const reach = look + 30;
    const consider = (o: Body, id: number, other: AiBus | null) => {
      if (Math.abs(o.fx - bodyF.fx) > reach || Math.abs(o.fy - bodyF.fy) > reach) return;
      const rel = wrapAngle(o.heading - bodyF.heading);
      // Two buses waiting on each other (across a junction, at a merge): one of them goes.
      if (other && other.obstacle === b.id && other.id < b.id) return;
      // Two 2.5 m wide bodies touch with their centrelines 2.5 m apart: look
      // wider than that, except at oncoming traffic in the next lane.
      const r2 = Math.abs(rel) > 2.4 ? 3.4 : 2.8 * 2.8;
      for (let k = 0; k < ns; k++) {
        const d = 1.5 + k * 2.5;
        if (d - 2.5 > bestGap) return;
        let found = false;
        for (let q = 0; q < o.n; q++) {
          const ex = o.x[q] - ax[k];
          const ey = o.y[q] - ay[k];
          // Only what is on our level (not the street under a viaduct).
          if (ex * ex + ey * ey < r2 && Math.abs(o.z[q] - az[k]) <= LEVEL_GAP) {
            // The gap to that point along our path (its points run bumper to bumper).
            const g = d + Math.max(-2.5, Math.min(2.5, ex * ahx[k] + ey * ahy[k]));
            if (g < bestGap) {
              bestGap = g;
              bestV = Math.max(0, o.speed * Math.cos(rel));
              bestId = id;
              bestKind = other ? Wait.Bus : Wait.Player;
            }
            found = true;
          }
        }
        if (found) return;
      }
    };
    for (const o of this.active) if (o !== b && !o.dead) consider(o.body, o.id, o);
    consider(this.playerBody, -2, null);
    const G = this.cars.grid;
    for (let k = 0; k < ns; k++) {
      const d = 1.5 + k * 2.5;
      if (d - 2.5 >= bestGap) break;
      // A car (0.92 m half width) touches us 2.2 m from our centreline.
      const gi = G.nearest(ax[k], ay[k], 2.4, undefined, az[k]);
      if (gi >= 0) {
        // Its grid points sit ~1 m inside its bumpers.
        const g = d + Math.max(-2.5, Math.min(2.5, (G.px[gi] - ax[k]) * ahx[k] + (G.py[gi] - ay[k]) * ahy[k])) - 1;
        if (g < bestGap) {
          bestGap = g;
          bestV = Math.max(0, G.pv[gi]);
          bestId = G.pid[gi];
          bestKind = Wait.Car;
        }
        break;
      }
    }
    if (bestGap < Infinity) lim(idm(b.v, v0, Math.max(0.05, bestGap - 0.5), bestV, 2.2), bestKind, bestId);
    // Touching the player's bus with our front half: stop (the player is never bulldozed).
    const tk = this.touching.get(b.id);
    const touchFront = tk !== undefined && tk < (b.body.n - 1) / 2;
    if (touchFront) lim(-6.5, Wait.Player);
    const why = wt.why;
    b.obstacle = why === Wait.Bus ? wt.ref : 0;
    b.wait = why;
    b.exempt =
      why === Wait.Red ||
      why === Wait.Player ||
      (why === Wait.Bus && (this.byId.get(wt.ref)?.exempt ?? false)) ||
      (why === Wait.Car && this.cars.isExempt(wt.ref));

    acc = Math.max(-6.5, Math.min(1.2, acc));
    b.a = acc;
    b.v = touchFront ? 0 : Math.max(0, b.v + acc * dt);
    // Convert lane speed to route distance (lanes are shorter on the inside of bends).
    const i = Math.max(0, Math.min(tr.n - 2, Math.floor(b.s / TRACK_STEP)));
    const segLen = Math.hypot(tr.x[i + 1] - tr.x[i], tr.y[i + 1] - tr.y[i]) / TRACK_STEP;
    b.s += (b.v * dt) / Math.max(0.4, Math.min(1.6, segLen || 1));
    if (b.s - b.progS > 4) {
      b.progS = b.s;
      b.stall = 0;
    } else b.stall += dt;
    // Safety valve: stationary for a long time without a good reason.
    if (b.v < 0.3 && !b.exempt) b.idle += dt;
    else b.idle = 0;

    // Lights and indicators.
    lights.brake = acc < -0.45 || b.v < 0.1;
    lights.hazards = false;
    b.door = Math.max(0, b.door - dt / 1.2);
    const stNext = stops[b.nextStop];
    const pullingIn = b.serve && stNext && stNext.s - b.s < 60 && stNext.s - b.s > 0;
    const pullingOut = time - b.departT < 4.5;
    // Turn indicators ~35 m before a corner.
    tr.sample(b.s + 6, this.tmp);
    const h0 = this.tmp.heading;
    tr.sample(b.s + 36, this.tmp);
    const turn = wrapAngle(this.tmp.heading - h0);
    b.turnSign = Math.abs(turn) > 0.6 ? Math.sign(turn) : 0;
    lights.indicatorLeft = !!pullingIn || b.turnSign < 0;
    lights.indicatorRight = (!pullingIn && pullingOut) || (b.turnSign > 0 && !pullingIn);
  }

  /** Keep reservations alive while the bus is in a box; release ones its tail has cleared. */
  private refreshHolds(b: AiBus, time: number): void {
    for (let k = b.holds.length - 1; k >= 0; k--) {
      const j = b.jl[b.holds[k]];
      if (b.s - b.len > j.s + j.boxR) {
        this.cars.leave(j.node, -b.id);
        b.holds.splice(k, 1);
      } else this.cars.enter(j.node, -b.id, j.inX, j.inY, j.outX, j.outY, j.cls, time + 4);
    }
  }

  /** May this bus go through junction `j` (stop line `stopAt` ahead) now? */
  private junctionOk(b: AiBus, k: number, stopAt: number, time: number): Wait {
    const j = b.jl[k];
    this.jRef = 0;
    // (A second node of the junction we just entered keeps the first node's light.)
    if (j.sig && !j.inside) {
      const a = b.jAsk[k];
      const st = a ? (this.world.signalStateAt?.(a.x, a.y, time, a.dx, a.dy, a.z) ?? null) : this.cars.signalFor(j.node, j.inX, j.inY, time);
      if (st === 'red') return Wait.Red;
      if (st === 'amber' && stopAt > (b.v * b.v) / (2 * 3)) return Wait.Red;
    } else if (this.cars.giveWayBusy(j.node, j.minor, time)) return Wait.Junction;
    if (!this.cars.boxClear(j.node, -b.id, j.inX, j.inY, j.outX, j.outY, j.cls, time)) return this.cars.boxBlocker === PLAYER_HOLD ? Wait.Player : Wait.Junction;
    // Room on the far side for the whole bus to get out of the box (it never
    // stops with its tail across the junction). Waiting for a queue that is
    // itself waiting legitimately is legitimate (jRef names the blocker).
    const pb = this.playerBody;
    const G = this.cars.grid;
    for (let q = j.s + j.boxR + 2; q <= j.s + j.boxR + b.len + 1; q += 3) {
      b.track.sample(q, this.tmp2, 0);
      const x = this.tmp2.x;
      const y = this.tmp2.y;
      const z = b.track.zAt(q);
      const gi = G.nearest(x, y, 1.8, undefined, z);
      if (gi >= 0 && G.pv[gi] < 2) {
        this.jRef = G.pid[gi];
        return Wait.Car;
      }
      for (const o of this.active) {
        if (o === b || o.dead || o.v > 2) continue;
        const body = o.body;
        if (Math.abs(body.fx - x) > o.len + 3 || Math.abs(body.fy - y) > o.len + 3) continue;
        for (let k = 0; k < body.n; k++) {
          if (Math.hypot(body.x[k] - x, body.y[k] - y) < 2.2 && Math.abs(body.z[k] - z) <= LEVEL_GAP) {
            this.jRef = o.id;
            return Wait.Bus;
          }
        }
      }
      if (Math.abs(pb.speed) < 2) {
        for (let k = 0; k < pb.n; k++) if (Math.hypot(pb.x[k] - x, pb.y[k] - y) < 2.2 && Math.abs(pb.z[k] - z) <= LEVEL_GAP) return Wait.Player;
      }
    }
    return Wait.None;
  }

  private pose(b: AiBus, dt: number): void {
    const spec = b.spec;
    const p = b.pose;
    const sec0 = spec.sections[0];
    // Section 0: rear axle on the path, heading towards the front axle.
    const rearS = b.s - sec0.axleFromFront;
    const frontAxleS = b.s - spec.frontOverhang;
    b.track.sample(rearS, this.tmp, b.pull);
    b.track.sample(frontAxleS, this.tmp2, b.pull);
    const heading = Math.atan2(this.tmp2.x - this.tmp.x, this.tmp2.y - this.tmp.y);
    p.x = this.tmp.x;
    p.y = this.tmp.y;
    p.heading = heading;
    p.speed = b.v;
    const steer = Math.max(-spec.maxSteer, Math.min(spec.maxSteer, 2 * wrapAngle(this.tmp2.heading - heading)));
    p.steer += (steer - p.steer) * Math.min(1, dt * 8);
    p.wheelSpin += (b.v * dt) / 0.48;
    const zr = b.track.zAt(rearS);
    const wb = Math.max(1, frontAxleS - rearS);
    p.z = zr;
    p.sections[0].x = p.x;
    p.sections[0].y = p.y;
    p.sections[0].heading = heading;
    p.sections[0].z = zr;
    p.sections[0].pitch = Math.atan2(b.track.zAt(frontAxleS) - zr, wb);
    // Trailing sections follow the path behind their hitches.
    let frontS = b.s;
    for (let i = 1; i < spec.sections.length; i++) {
      const prev = spec.sections[i - 1];
      const cur = spec.sections[i];
      const hitchS = frontS - prev.rearHitchFromFront;
      const curFront = hitchS + cur.hitchFromFront;
      const axleS = curFront - cur.axleFromFront;
      b.track.sample(axleS, this.tmp, b.pull);
      b.track.sample(hitchS, this.tmp2, b.pull);
      const h = Math.atan2(this.tmp2.x - this.tmp.x, this.tmp2.y - this.tmp.y);
      const sec = p.sections[i];
      sec.x = this.tmp.x;
      sec.y = this.tmp.y;
      sec.heading = h;
      const za = b.track.zAt(axleS);
      sec.z = za;
      sec.pitch = Math.atan2(b.track.zAt(hitchS) - za, Math.max(1, hitchS - axleS));
      frontS = curFront;
    }
    // Gentle body motion.
    const kappa = Math.tan(p.steer) / Math.max(1, spec.wheelbase);
    const roll = Math.max(-0.05, Math.min(0.05, -0.012 * b.v * b.v * kappa));
    const pitch = Math.max(-0.03, Math.min(0.03, b.a * 0.006));
    p.roll += (roll - p.roll) * Math.min(1, dt * 3);
    p.pitch += (pitch - p.pitch) * Math.min(1, dt * 3);
  }

  /**
   * Push the player's bus out of AI buses and cars (same contract as
   * Collider.resolve: corrects pose in place, trims speed into the contact).
   *
   * Every body is a chain of capsules whose round ends stop at the bumpers
   * (radius = half width), so contact means real overlap, not a 1-2 m
   * envelope. The AI vehicles are kinematic: the one touching the player
   * stops (see step and CarTraffic.simulate) and the player is moved at most
   * 0.3 m per frame, so a stopped bus is never bulldozed. The other
   * vehicle's own speed counts in the impact.
   */
  resolve(pose: BusPose, spec: BusSpec): { hit: boolean; impact: number } {
    const out = { hit: false, impact: 0 };
    const R = spec.width / 2;
    // Vehicles on another level (viaduct above, tunnel below) are not in the way.
    const z0 = this.playerZ(pose);
    this.touching.clear();
    const cap = this.cap;
    const G = this.cars.grid;
    let moved = 0;
    for (let iter = 0; iter < 3; iter++) {
      let best = 0;
      let bnx = 0;
      let bny = 0;
      let bsec = 0;
      let ovx = 0;
      let ovy = 0;
      let bestBus: AiBus | null = null;
      let bestK = 0;
      // Deepest contact between the player sample point (px, py) and segment a-b of radius r.
      let px = 0;
      let py = 0;
      const seg = (ax: number, ay: number, bx: number, by: number, r: number): boolean => {
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 1e-6 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
        const ex = px - ax - dx * t;
        const ey = py - ay - dy * t;
        const d = Math.hypot(ex, ey);
        const pen = R + r - d;
        if (pen > best && d > 1e-3) {
          best = pen;
          bnx = ex / d;
          bny = ey / d;
          return true;
        }
        return false;
      };
      for (let si = 0; si < pose.sections.length && si < spec.sections.length; si++) {
        const sec = pose.sections[si];
        const ss = spec.sections[si];
        const hx = Math.sin(sec.heading);
        const hy = Math.cos(sec.heading);
        // Our own capsule: sample points from R inside the front to R inside the rear.
        const front = ss.axleFromFront - R;
        const rear = ss.length - ss.axleFromFront - R;
        const sz = sec.z ?? z0;
        const tg = Math.tan(sec.pitch ?? 0);
        const m = Math.max(2, Math.ceil((front + rear) / 1.2) + 1);
        for (let j = 0; j < m; j++) {
          const t = front - ((front + rear) * j) / (m - 1);
          px = sec.x + hx * t;
          py = sec.y + hy * t;
          const pz = sz + tg * t;
          for (const b of this.active) {
            if (b.dead) continue;
            const body = b.body;
            if (Math.abs(body.fx - px) > b.len + 4 || Math.abs(body.fy - py) > b.len + 4) continue;
            const rB = b.spec.width / 2;
            const n = body.n;
            // The AI bus's end points move rB in from its bumpers.
            const f = Math.min(0.45, rB / Math.max(0.1, b.len / (n - 1)));
            for (let k = 0; k + 1 < n; k++) {
              if (Math.abs(body.z[k] - pz) > LEVEL_GAP && Math.abs(body.z[k + 1] - pz) > LEVEL_GAP) continue;
              let ax = body.x[k];
              let ay = body.y[k];
              let bx = body.x[k + 1];
              let by = body.y[k + 1];
              const dx = bx - ax;
              const dy = by - ay;
              if (k === 0) {
                ax += dx * f;
                ay += dy * f;
              }
              if (k + 2 === n) {
                bx -= dx * f;
                by -= dy * f;
              }
              if (seg(ax, ay, bx, by, rB)) {
                bsec = si;
                // The AI bus moves front first: from point k+1 towards point k.
                const l = Math.hypot(dx, dy) || 1;
                ovx = (-dx / l) * b.v;
                ovy = (-dy / l) * b.v;
                bestBus = b;
                bestK = k;
              }
            }
          }
          G.query(px, py, R + 3.6, (i) => {
            if (Math.abs(G.pz[i] - pz) > LEVEL_GAP || !this.cars.capsule(G.pid[i], cap)) return false;
            if (seg(cap.ax, cap.ay, cap.bx, cap.by, cap.r)) {
              bsec = si;
              ovx = Math.sin(cap.heading) * cap.v;
              ovy = Math.cos(cap.heading) * cap.v;
              bestBus = null;
            }
            return false;
          });
        }
      }
      if (best <= 0.01) break;
      out.hit = true;
      const hitBus = bestBus as AiBus | null;
      if (hitBus) {
        this.touching.set(hitBus.id, bestK);
        // Deep inside the player's bus (a reset or rescue put it there): the AI bus goes, never the player.
        if (best > R + hitBus.spec.width / 2 - 1 && !hitBus.dead) {
          hitBus.dead = true;
          this.stats.overlapDespawns++;
          this.events.push(`bus ${hitBus.route.id} inside the player's bus: removed`);
          if (this.events.length > 30) this.events.shift();
        }
      }
      const push = Math.min(best + 0.002, 0.3 - moved);
      if (push <= 0) break;
      moved += push;
      pose.x += bnx * push;
      pose.y += bny * push;
      for (const sp of pose.sections) {
        sp.x += bnx * push;
        sp.y += bny * push;
      }
      const sh = (pose.sections[bsec] ?? pose).heading;
      const fn = Math.sin(sh) * bnx + Math.cos(sh) * bny;
      // Relative normal velocity (the other vehicle's motion counts too)...
      const vOther = ovx * bnx + ovy * bny;
      const vn = pose.speed * fn - vOther;
      if (vn < 0) {
        // ...but the impact reported (and scored by the guide) is the player's own speed into the contact.
        out.impact = Math.max(out.impact, Math.max(0, -pose.speed * fn));
        // Our motion into the contact is taken away; the contact never adds speed
        // (a stopped bus is not launched by the vehicle that touched it).
        const ns = pose.speed - vn * fn * 1.05;
        pose.speed = Math.sign(ns) === Math.sign(pose.speed) && Math.abs(ns) < Math.abs(pose.speed) ? ns : Math.sign(ns) === Math.sign(pose.speed) ? pose.speed : 0;
      }
    }
    return out;
  }

  /** A Collider that resolves `base` (buildings, kerbs) and then the AI vehicles. */
  wrapCollider<C extends Collider>(base: C): C {
    const wrapped = Object.create(base) as C;
    wrapped.resolve = (pose: BusPose, spec: BusSpec) => {
      const a = base.resolve(pose, spec);
      const b = this.resolve(pose, spec);
      return { ...a, hit: a.hit || b.hit, impact: Math.max(a.impact, b.impact) };
    };
    return wrapped;
  }

  /** Map markers for the HUD minimap and full map (reused objects). */
  markers(): readonly MapMarker[] {
    const out = this.markersOut;
    out.length = 0;
    for (const b of this.active) out.push(b.marker);
    return out;
  }

  /** AI buses and cars within r of (x, y) with their state, and recent valve events (diagnostics). */
  debugNear(x: number, y: number, r = 60): object {
    const buses = this.active
      .filter((b) => Math.hypot(b.body.fx - x, b.body.fy - y) < r + b.len)
      .map((b) => {
        const j = b.jl[b.jNext];
        return {
          id: b.id,
          route: `${b.route.id}/${b.route.dir}`,
          x: +b.body.fx.toFixed(1),
          y: +b.body.fy.toFixed(1),
          s: +b.s.toFixed(1),
          v: +b.v.toFixed(1),
          state: b.state,
          wait: b.wait,
          obstacle: b.obstacle,
          exempt: b.exempt,
          idle: +b.idle.toFixed(0),
          stall: +b.stall.toFixed(0),
          visible: b.visible,
          next: j ? { node: j.node, stop: +(j.stopS - b.s).toFixed(1), sig: j.sig, minor: j.minor } : null,
          holds: b.holds.map((q) => b.jl[q].node),
          touching: this.touching.has(b.id),
        };
      });
    return { buses, cars: this.cars.debugNear(x, y, r), events: [...this.events.slice(-8), ...this.cars.events.slice(-8)], stats: { ...this.stats, cars: { ...this.cars.stats } } };
  }

  /** Number of AI buses currently active (diagnostics). */
  get count(): number {
    return this.active.length;
  }

  dispose(): void {
    for (const b of this.active) this.release(b);
    this.active = [];
    for (const list of this.pool.values()) for (const m of list) {
      for (const s of m.sections) s.removeFromParent();
      m.dispose();
    }
    this.pool.clear();
    this.cars.dispose();
  }
}
