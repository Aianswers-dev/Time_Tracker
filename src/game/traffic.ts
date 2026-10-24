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
import { TRACK_STEP, hasTrack, trackFor, type RouteTrack, type TrackSample } from './track';
import type { MapMarker } from './minimap';
import { brighten, rng } from './util';
import { CarTraffic } from './cars';
import { makeBody, type Body } from './bodies';
import { session } from './session';

const RADIUS = 1500;
const DESPAWN = 1800;
const VIEW_DIST = 950;
const MAX_BUSES = 48;

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
  stuck: number;
  ghost: number;
  obstacle: number;
  body: Body;
  pose: BusPose;
  lights: BusLights;
  visible: boolean;
  marker: MapMarker;
  age: number;
  turnSign: number;
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
  private playerBody = makeBody(12);
  private playerSpec: BusSpec | null = null;
  private markersOut: MapMarker[] = [];
  private costEma = 0.5;
  private maxActive = MAX_BUSES;
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
    // Build route tracks in the background, busiest routes first.
    this.buildQueue = [...data.routes].sort((a, b) => b.trips - a.trips);
    this.scheduleBuild();
    this.cars = new CarTraffic(scene, data, world);
    session.traffic = this;
    session.world = world;
    this.prewarm();
  }

  private scheduleBuild(): void {
    if (this.building || !this.buildQueue.length) return;
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
    for (const r of this.buildQueue) (this.routeNear(r, x, y, RADIUS + 300) ? near : far).push(r);
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
    const R2 = RADIUS * RADIUS;
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

  private spawn(c: Candidate, px: number, py: number, camera: THREE.Camera | null): boolean {
    const r = c.route;
    const s = c.inside[Math.floor(this.rand() * c.inside.length)] + (this.rand() - 0.5) * 36;
    if (s < 30 || s > r.length - 60) return false;
    c.track.sample(s, this.tmp);
    const dx = this.tmp.x - px;
    const dy = this.tmp.y - py;
    const d = Math.hypot(dx, dy);
    if (d > RADIUS) return false;
    if (this.initial ? d < 45 : d < 120) return false;
    if (!this.initial && camera && d < 500) {
      this.sphere.center.set(this.tmp.x, 2, -this.tmp.y);
      this.sphere.radius = 14;
      if (this.frustum.intersectsSphere(this.sphere)) return false;
    }
    // Keep clear of other buses on the same stretch.
    for (const o of this.active) {
      const b = o.body;
      for (let k = 0; k < b.n; k++) {
        if (Math.abs(b.x[k] - this.tmp.x) < 26 && Math.abs(b.y[k] - this.tmp.y) < 26 && Math.hypot(b.x[k] - this.tmp.x, b.y[k] - this.tmp.y) < 26) return false;
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
      stuck: 0,
      ghost: 0,
      obstacle: 0,
      body: makeBody(nb),
      pose: {
        x: 0,
        y: 0,
        heading: 0,
        speed: 0,
        steer: 0,
        wheelSpin: this.rand() * 6,
        sections: spec.sections.map(() => ({ x: 0, y: 0, heading: 0 })),
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
    while (b.sigIdx < c.track.signals.length && c.track.signals[b.sigIdx].s < s) b.sigIdx++;
    this.updateBody(b);
    this.active.push(b);
    return true;
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
      if (k === 0) body.heading = this.tmp.heading;
    }
    body.fx = body.x[0];
    body.fy = body.y[0];
    body.speed = b.v;
  }

  private updatePlayerBody(p: BusPose): void {
    const n = p.sections.length;
    if (!this.playerSpec || this.playerSpec.sections.length !== n) this.playerSpec = this.buses.specFor(n >= 3 ? 'metro' : 'rigid');
    const spec = this.playerSpec;
    const body = this.playerBody;
    let k = 0;
    for (let i = 0; i < n && i < spec.sections.length; i++) {
      const sec = p.sections[i];
      const ss = spec.sections[i];
      const hx = Math.sin(sec.heading);
      const hy = Math.cos(sec.heading);
      const front = ss.axleFromFront;
      const rear = ss.length - ss.axleFromFront;
      const m = Math.min(5, Math.max(2, Math.ceil(ss.length / 3.5)));
      for (let j = 0; j < m && k < body.x.length; j++) {
        const t = front - ((front + rear) * j) / (m - 1);
        body.x[k] = sec.x + hx * t;
        body.y[k] = sec.y + hy * t;
        k++;
      }
    }
    body.n = k;
    body.heading = p.heading;
    body.speed = p.speed;
    body.fx = body.x[0];
    body.fy = body.y[0];
  }

  /**
   * Advance the AI. `hours` (optional) switches headlights on at night.
   * Call after the player's physics so the player's pose is current.
   */
  update(dt: number, timeSeconds: number, player: BusPose, camera: THREE.Camera, hours?: number): void {
    const t0 = performance.now();
    if (hours !== undefined) this.hours = hours;
    else if (session.hours !== null) this.hours = session.hours;
    const px = player.x;
    const py = player.y;
    this.updatePlayerBody(player);
    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const cam = camera.position;

    if (this.initial && !this.candidates.length) {
      this.prioritise(px, py);
    }
    this.candTimer -= dt;
    if (this.candCursor !== 0 || this.candTimer <= 0) {
      if (this.candCursor === 0) this.candTimer = this.candidates.length ? 2 : 0.5;
      this.refreshCandidates(px, py, !this.candidates.length);
    }

    // Despawn far away / finished buses.
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];
      const d = Math.hypot(b.body.fx - px, b.body.fy - py);
      const done = b.state === State.Terminus && b.dwell <= 0 && (!b.visible || b.dwell < -20);
      if (d > DESPAWN || done || i >= this.maxActive + 4) {
        this.release(b);
        this.active.splice(i, 1);
      }
    }

    // Spawn to keep the population up.
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.candidates.length) {
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
        if (this.spawn(c, px, py, camera)) made++;
      }
      // Populate freely (even in view) until the background track builder has caught up.
      if (this.initial && !this.buildQueue.length && (this.active.length >= desired || tries <= 0)) this.initial = false;
    }

    // Simulate.
    for (const b of this.active) this.step(b, dt, timeSeconds);
    for (const b of this.active) this.updateBody(b);

    // Visuals (frustum + distance culled).
    for (const b of this.active) {
      const body = b.body;
      const mid = body.n >> 1;
      const cx = body.x[mid];
      const cy = body.y[mid];
      const dist = Math.hypot(cx - cam.x, -cy - cam.z);
      this.sphere.center.set(cx, 2, -cy);
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
      b.mesh.setLights(b.lights, timeSeconds);
      b.mesh.setDoors(b.door);
    }

    this.cars.update(dt, timeSeconds, player, this.playerBody, this.active.map((b) => b.body), this.frustum, cam, this.hours);

    // Adaptive cap keeps the AI inside its frame budget.
    const cost = performance.now() - t0;
    this.lastCostMs = cost;
    this.costEma += (cost - this.costEma) * 0.05;
    this.costTimer -= dt;
    if (this.costTimer <= 0) {
      this.costTimer = 1;
      if (this.costEma > 1.6 && this.maxActive > 18) this.maxActive--;
      else if (this.costEma < 1.0 && this.maxActive < MAX_BUSES) this.maxActive++;
    }
    if (this.buildQueue.length) this.scheduleBuild();
  }

  private step(b: AiBus, dt: number, time: number): void {
    const tr = b.track;
    const L = tr.length;
    b.age += dt;
    const stops = b.route.stops;
    const lights = b.lights;
    lights.headlights = this.hours < 6.6 || this.hours > 17.9;

    if (b.state === State.Dwell || b.state === State.Terminus) {
      b.v = 0;
      b.a = 0;
      b.dwell -= dt;
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
    let obstacle = 0;

    // Next stop.
    const st = stops[b.nextStop];
    if (st) {
      const gap = st.s - b.s;
      if (b.serve) {
        if (gap < 1.2 && b.v < 0.35) {
          b.state = State.Dwell;
          b.dwellTotal = b.dwell = 9 + this.rand() * 11;
          b.v = 0;
          return;
        }
        if (gap < 140) acc = Math.min(acc, idm(b.v, v0, gap + 0.6, 0, 0.6));
        b.pullTarget = gap < 45 ? Math.max(0, tr.kerbAt(st.s) - 1.75) : 0;
      } else if (gap < -2) {
        b.nextStop++;
        b.serve = this.decideServe(b);
      }
    }
    if (b.s >= L - 1.5) {
      b.state = State.Terminus;
      b.dwellTotal = b.dwell = 8;
      b.v = 0;
      return;
    }
    if (b.s > L - 120) acc = Math.min(acc, idm(b.v, v0, L - 1 - b.s, 0, 0.5));

    // Pull back out after a stop.
    if (time - b.departT < 6 && (!st || st.s - b.s > 45 || !b.serve)) b.pullTarget = 0;
    b.pull += Math.max(-dt * 0.45, Math.min(dt * 0.45, b.pullTarget - b.pull));

    // Signals.
    const sig = tr.signals[b.sigIdx];
    const signalAt = this.world.signalStateAt;
    if (sig) {
      const gap = sig.s - b.s;
      if (gap < -1) {
        b.sigIdx++;
        b.sigState = null;
        b.sigCommit = false;
      } else if (signalAt && gap < 80) {
        b.sigTimer -= dt;
        if (b.sigTimer <= 0 || b.sigState === null) {
          b.sigTimer = 0.25;
          b.sigState = signalAt.call(this.world, sig.x, sig.y, time);
        }
        const stopDist = (b.v * b.v) / (2 * 2.6);
        if (b.sigState === 'red' || (b.sigState === 'amber' && !b.sigCommit && gap > stopDist + 1)) {
          if (!b.sigCommit) {
            acc = Math.min(acc, idm(b.v, v0, gap, 0, 1.0));
            obstacle = -1;
          }
        } else if (gap < 6) b.sigCommit = true;
      }
    }

    // Car following against other buses and the player.
    const look = 9 + b.v * 3.2;
    const bodyF = b.body;
    let bestGap = Infinity;
    let bestV = 0;
    let bestId = 0;
    const consider = (o: Body, id: number, other: AiBus | null) => {
      const dx = o.fx - bodyF.fx;
      const dy = o.fy - bodyF.fy;
      const reach = look + 30;
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) return;
      const rel = wrapAngle(o.heading - bodyF.heading);
      const crossing = Math.abs(rel) > 0.9 && Math.abs(rel) < 2.4;
      if (other && crossing) {
        if (b.ghost > 0) return;
        // Two buses waiting on each other: the older id goes first.
        if (other.obstacle === b.id && other.id < b.id) return;
      }
      for (let d = 1.5; d <= look; d += 2.5) {
        tr.sample(b.s + d, this.tmp2, b.pull);
        for (let k = 0; k < o.n; k++) {
          const ex = o.x[k] - this.tmp2.x;
          const ey = o.y[k] - this.tmp2.y;
          if (ex * ex + ey * ey < 3.4) {
            if (d < bestGap) {
              bestGap = d;
              bestV = Math.max(0, o.speed * Math.cos(rel));
              bestId = id;
            }
            return;
          }
        }
        if (d > bestGap) return;
      }
    };
    for (const o of this.active) if (o !== b) consider(o.body, o.id, o);
    consider(this.playerBody, -1, null);
    // Cars in the way.
    for (let d = 1.5; d <= look && d < bestGap; d += 2.5) {
      tr.sample(b.s + d, this.tmp2, b.pull);
      const cv = this.cars.probe(this.tmp2.x, this.tmp2.y, 1.9);
      if (cv >= 0) {
        bestGap = d;
        bestV = cv;
        bestId = 0;
        break;
      }
    }
    if (bestGap < Infinity) {
      acc = Math.min(acc, idm(b.v, v0, Math.max(0.05, bestGap - 1.2), bestV, 2.2));
      obstacle = bestId;
    }
    b.obstacle = obstacle;

    // Deadlock watchdog: if stuck behind another AI for a long time, squeeze past.
    if (b.v < 0.2 && obstacle > 0) b.stuck += dt;
    else b.stuck = Math.max(0, b.stuck - dt * 2);
    if (b.stuck > 10) {
      b.ghost = 4;
      b.stuck = 0;
    }
    if (b.ghost > 0) b.ghost -= dt;

    acc = Math.max(-6.5, Math.min(1.2, acc));
    b.a = acc;
    b.v = Math.max(0, b.v + acc * dt);
    // Convert lane speed to route distance (lanes are shorter on the inside of bends).
    const i = Math.max(0, Math.min(tr.n - 2, Math.floor(b.s / TRACK_STEP)));
    const segLen = Math.hypot(tr.x[i + 1] - tr.x[i], tr.y[i + 1] - tr.y[i]) / TRACK_STEP;
    b.s += (b.v * dt) / Math.max(0.4, Math.min(1.6, segLen || 1));

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
    p.sections[0].x = p.x;
    p.sections[0].y = p.y;
    p.sections[0].heading = heading;
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
   */
  resolve(pose: BusPose, spec: BusSpec): { hit: boolean; impact: number } {
    const out = { hit: false, impact: 0 };
    const R = spec.width / 2;
    for (let iter = 0; iter < 3; iter++) {
      let best = 0;
      let bnx = 0;
      let bny = 0;
      let bsec = 0;
      let otherV = 0;
      let otherH = 0;
      for (let si = 0; si < pose.sections.length && si < spec.sections.length; si++) {
        const sec = pose.sections[si];
        const ss = spec.sections[si];
        const hx = Math.sin(sec.heading);
        const hy = Math.cos(sec.heading);
        const front = ss.axleFromFront - 0.2;
        const rear = ss.length - ss.axleFromFront - 0.2;
        const m = Math.max(2, Math.ceil((front + rear) / 2.2) + 1);
        for (let j = 0; j < m; j++) {
          const t = front - ((front + rear) * j) / (m - 1);
          const px = sec.x + hx * t;
          const py = sec.y + hy * t;
          for (const b of this.active) {
            const body = b.body;
            if (Math.abs(body.fx - px) > b.len + 4 || Math.abs(body.fy - py) > b.len + 4) continue;
            for (let k = 0; k < body.n; k++) {
              const dx = px - body.x[k];
              const dy = py - body.y[k];
              const d = Math.hypot(dx, dy);
              const pen = R + 1.25 - d;
              if (pen > best && d > 1e-3) {
                best = pen;
                bnx = dx / d;
                bny = dy / d;
                bsec = si;
                otherV = b.v;
                otherH = body.heading;
              }
            }
          }
          const ci = this.cars.grid.nearest(px, py, R + 1.0);
          if (ci >= 0) {
            const g = this.cars.grid;
            const dx = px - g.px[ci];
            const dy = py - g.py[ci];
            const d = Math.hypot(dx, dy);
            const pen = R + 1.0 - d;
            if (pen > best && d > 1e-3) {
              best = pen;
              bnx = dx / d;
              bny = dy / d;
              bsec = si;
              otherV = 0;
              otherH = 0;
            }
          }
        }
      }
      if (best <= 0.01) break;
      out.hit = true;
      const push = best + 0.002;
      pose.x += bnx * push;
      pose.y += bny * push;
      for (const sp of pose.sections) {
        sp.x += bnx * push;
        sp.y += bny * push;
      }
      const sh = (pose.sections[bsec] ?? pose).heading;
      const fn = Math.sin(sh) * bnx + Math.cos(sh) * bny;
      // Relative normal velocity (the other vehicle's motion counts too).
      const vOther = otherV * (Math.sin(otherH) * bnx + Math.cos(otherH) * bny);
      const vn = pose.speed * fn - vOther;
      if (vn < 0) {
        out.impact = Math.max(out.impact, -vn);
        pose.speed -= vn * fn * 1.05;
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
