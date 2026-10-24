// RouteGuide: owns the player's route objects in the scene (stops, guidance
// chevrons, next-stop highlight) and runs the shift logic: serving stops,
// timetable adherence, off-route detection, turn hints and the end summary.
import * as THREE from 'three';
import type { MapData, Route } from '../types';
import { pointAlong, projectOnto } from '../data/coords';
import { drivable, roadIndexFor, speedLimitOf } from './roadIndex';
import { trackFor, type RouteTrack, type TrackSample } from './track';
import { computeTurns, shortStreet, type TurnHint } from './turns';
import { isStationStop, stopDisplayName, stopNumber, stopUsage } from './routeMeta';
import { flagAtlas, partsGroup, plateGeometry, poleParts, shelterParts, signMaterial, stationGroup, SIGN_H, SIGN_W, type Part } from './stops3d';
import { NextStopMarker, Ribbon } from './ribbon';
import { brighten, hashString } from './util';
import { session } from './session';

export const enum StopStatus {
  Pending = 0,
  Served = 1,
  Missed = 2,
  Skipped = 3,
}

export type GuideEventKind = 'served' | 'missed' | 'depart' | 'offroute' | 'onroute' | 'finished' | 'collision' | 'info';

export interface GuideEvent {
  id: number;
  kind: GuideEventKind;
  text: string;
  /** Schedule delta in seconds for 'served' events (+ = late). */
  delta?: number;
}

export interface RouteSummary {
  routeId: string;
  headsign: string;
  stopsTotal: number;
  stopsServed: number;
  stopsMissed: number;
  stopsSkipped: number;
  /** Served stops departed between 1 min early and 3:59 late. */
  onTime: number;
  /** 0..100 */
  punctuality: number;
  avgDelta: number;
  worstLate: number;
  worstEarly: number;
  collisions: number;
  distance: number;
  time: number;
  speedingSeconds: number;
  score: number;
  grade: string;
}

export interface GuideState {
  /** Distance driven along the route (projection of the bus front), metres. */
  s: number;
  routeLength: number;
  /** 0..1 along the route. */
  progress: number;
  nextStopIndex: number;
  nextStopName: string;
  nextStopNumber: string;
  nextStopCode: string;
  nextStopDistance: number;
  nextStopStation: boolean;
  /** Scheduled seconds after departure for the next stop. */
  nextStopDue: number;
  /** The front of the bus is in the next stop's zone. */
  atStop: boolean;
  /** In the zone and stopped: opening the doors serves the stop. */
  canServe: boolean;
  stopsTotal: number;
  stopsServed: number;
  stopsMissed: number;
  /** Per route stop, see StopStatus. */
  stopStatus: Uint8Array;
  /** Shift clock started (bus left the first stop). */
  shiftStarted: boolean;
  /** Seconds since departure. */
  shiftTime: number;
  /** Seconds behind (+) or ahead (−) of the timetable. */
  scheduleDelta: number;
  offRoute: boolean;
  /** Distance from the route line, metres. */
  routeDistance: number;
  /** Where to head to rejoin the route (map x/y). */
  rejoinX: number;
  rejoinY: number;
  finished: boolean;
  /** Next significant turn, or null. */
  turn: TurnHint | null;
  turnDistance: number;
  /** Posted speed limit at the bus, km/h. */
  speedLimit: number;
  speeding: boolean;
  roadName: string;
  distanceDriven: number;
  collisions: number;
  speedingSeconds: number;
  /** Recent events, newest last; ids increase monotonically. */
  events: GuideEvent[];
  summary: RouteSummary | null;
  ribbonVisible: boolean;
  /** Next traffic signal on the route within ~150 m (needs world.signalStateAt), or null. */
  signal: { distance: number; state: 'green' | 'amber' | 'red' } | null;
}

export interface RouteGuideOptions {
  /** Overall length of the player's bus (front to rear), metres. */
  busLength?: number;
}

interface StopPlace {
  x: number;
  y: number;
  heading: number;
  kerb: number;
  station: boolean;
}

function frame(x: number, y: number, heading: number, out: THREE.Object3D): void {
  out.position.set(x, 0, -y);
  out.rotation.set(0, -heading, 0);
}

export class RouteGuide {
  state: GuideState;
  readonly track: RouteTrack;
  readonly turns: TurnHint[];
  readonly color: string;
  readonly places: StopPlace[];
  private readonly group = new THREE.Group();
  private readonly ribbon: Ribbon;
  private readonly marker: NextStopMarker;
  private readonly busLength: number;
  private readonly tmp: TrackSample = { x: 0, y: 0, hx: 0, hy: 1, heading: 0 };
  private initialised = false;
  private segI = 0;
  private departS = 0;
  private departT = 0;
  private departIndex = -1;
  private lastX = NaN;
  private lastY = NaN;
  private motionHeading = 0;
  private limitTimer = 0;
  private lastImpactT = -10;
  private time = 0;
  private eventId = 0;
  private servedDeltas: number[] = [];
  /** Stop that was served and whose departure delta is still pending. */
  private dwellIndex = -1;
  private finishTimer = -1;
  private endWait = 0;
  private turnIdx = 0;
  private sigIdx = 0;
  private sigTimer = 0;
  private sigState: 'green' | 'amber' | 'red' | null = null;
  private readonly onKey: (e: KeyboardEvent) => void;

  constructor(
    readonly scene: THREE.Scene,
    readonly data: MapData,
    readonly route: Route,
    opts: RouteGuideOptions = {},
  ) {
    this.busLength = opts.busLength ?? 13;
    this.track = trackFor(route, data);
    this.turns = computeTurns(data, route);
    this.color = brighten(route.color, 0.32);
    const n = route.stops.length;
    this.state = {
      s: 0,
      routeLength: route.length,
      progress: 0,
      nextStopIndex: 0,
      nextStopName: '',
      nextStopNumber: '',
      nextStopCode: '',
      nextStopDistance: Infinity,
      nextStopStation: false,
      nextStopDue: 0,
      atStop: false,
      canServe: false,
      stopsTotal: n,
      stopsServed: 0,
      stopsMissed: 0,
      stopStatus: new Uint8Array(n),
      shiftStarted: false,
      shiftTime: 0,
      scheduleDelta: 0,
      offRoute: false,
      routeDistance: 0,
      rejoinX: 0,
      rejoinY: 0,
      finished: false,
      turn: null,
      turnDistance: Infinity,
      speedLimit: 50,
      speeding: false,
      roadName: '',
      distanceDriven: 0,
      collisions: 0,
      speedingSeconds: 0,
      events: [],
      summary: null,
      ribbonVisible: true,
      signal: null,
    };
    this.places = this.track.stops.map((ts) => {
      this.track.sample(ts.s, this.tmp);
      const lx = -this.tmp.hy;
      const ly = this.tmp.hx;
      const off = ts.kerb + (ts.station ? 0.05 : 0.6);
      return { x: this.tmp.x + lx * off, y: this.tmp.y + ly * off, heading: this.tmp.heading, kerb: ts.kerb, station: ts.station };
    });
    // Seed the projection window at the start stop (loop routes start where they end).
    const s0 = Math.max(route.stops[0] ? route.stops[0].s : 0, this.busLength + 2);
    this.state.s = s0;
    this.segI = pointAlong(route.pts, route.cum, s0).i;
    this.group.name = 'route-guide';
    scene.add(this.group);
    this.buildRouteStops();
    this.buildCityStops();
    this.ribbon = new Ribbon(scene, this.track, this.color);
    this.marker = new NextStopMarker(scene, this.track, this.color);
    this.onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyV' && !e.repeat && !(e.target instanceof HTMLInputElement)) this.toggleRibbon();
    };
    addEventListener('keydown', this.onKey);
    session.guide = this;
  }

  // -------------------------------------------------------------------------
  // Scene construction

  private buildRouteStops(): void {
    const data = this.data;
    const usage = stopUsage(data);
    const stopIdx = this.route.stops.map((s) => s.stop);
    const atlas = flagAtlas(data, stopIdx, false);
    const signMat = signMaterial(atlas.tex);
    const pole = poleParts();
    this.route.stops.forEach((rs, i) => {
      const p = this.places[i];
      const name = data.stops[rs.stop].name;
      if (p.station) {
        const g = stationGroup(name);
        // Platform centred a little behind the stopping point.
        this.track.sample(rs.s - 9, this.tmp);
        const lx = -this.tmp.hy;
        const ly = this.tmp.hx;
        frame(this.tmp.x + lx * (p.kerb + 0.05), this.tmp.y + ly * (p.kerb + 0.05), this.tmp.heading, g);
        this.group.add(g);
        return;
      }
      const g = partsGroup(pole);
      const plate = new THREE.Mesh(plateGeometry(atlas.uv[i]), signMat);
      plate.position.set(SIGN_W / 2 + 0.03, 3.15 - SIGN_H / 2 - 0.05, 0);
      g.add(plate);
      frame(p.x, p.y, p.heading, g);
      this.group.add(g);
      if (usage[rs.stop] > 220) {
        const sh = partsGroup(shelterParts(hashString(name)));
        this.track.sample(rs.s - 6, this.tmp);
        const lx = -this.tmp.hy;
        const ly = this.tmp.hx;
        const off = p.kerb + 0.9 + 0.95;
        frame(this.tmp.x + lx * off, this.tmp.y + ly * off, this.tmp.heading, sh);
        this.group.add(sh);
      }
    });
  }

  /** Cheap instanced poles (and shelters at busy stops) for every other stop in the city. */
  private buildCityStops(): void {
    const data = this.data;
    const idx = roadIndexFor(data);
    const usage = stopUsage(data);
    const own = this.route.stops.map((s) => data.stops[s.stop]);
    const seen = new Set<string>();
    const poles: THREE.Matrix4[] = [];
    const shelters: THREE.Matrix4[] = [];
    const o = new THREE.Object3D();
    data.stops.forEach((st, si) => {
      const key = `${Math.round(st.x / 3)},${Math.round(st.y / 3)}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (isStationStop(st.name)) return;
      for (const s of own) if (Math.abs(s.x - st.x) < 8 && Math.abs(s.y - st.y) < 8) return;
      const hit = idx.nearest(st.x, st.y, 25, undefined, 0, drivable);
      let x = st.x;
      let y = st.y;
      let heading = 0;
      if (hit) {
        const road = data.roads[hit.road];
        const tx = hit.side > 0 ? hit.dx : -hit.dx;
        const ty = hit.side > 0 ? hit.dy : -hit.dy;
        const half = road.oneway ? road.width / 2 : Math.max(3.2, road.width / 2);
        const off = half + 0.6;
        x = hit.px - ty * off;
        y = hit.py + tx * off;
        heading = Math.atan2(tx, ty);
      }
      frame(x, y, heading, o);
      o.updateMatrix();
      poles.push(o.matrix.clone());
      if (usage[si] > 300 && hit) {
        const [hx, hy] = [Math.sin(heading), Math.cos(heading)];
        const off = 0.9 + 0.95;
        frame(x - hy * off + hx * 6, y + hx * off + hy * 6, heading, o);
        o.updateMatrix();
        shelters.push(o.matrix.clone());
      }
    });
    const generic = flagAtlas(data, [0], true);
    const parts: Part[] = [...poleParts(), { geo: plateGeometry(generic.uv[0]).translate(SIGN_W / 2 + 0.03, 3.15 - SIGN_H / 2 - 0.05, 0), mat: signMaterial(generic.tex) }];
    const addInstanced = (ps: Part[], ms: THREE.Matrix4[]) => {
      if (!ms.length) return;
      for (const p of ps) {
        const im = new THREE.InstancedMesh(p.geo, p.mat, ms.length);
        ms.forEach((m, i) => im.setMatrixAt(i, m));
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        this.group.add(im);
      }
    };
    addInstanced(parts, poles);
    addInstanced(shelterParts(1), shelters);
  }

  // -------------------------------------------------------------------------

  /** Where the player's bus should start: map x/y of the FRONT of the bus and heading. */
  startPose(): { x: number; y: number; heading: number } {
    const first = this.route.stops[0];
    const s = Math.min(this.route.length - 1, Math.max(first ? first.s : 0, this.busLength + 2));
    const kerb = this.track.kerbAt(s);
    const pull = Math.max(0, kerb - 1.7);
    this.track.sample(s, this.tmp, pull);
    return { x: this.tmp.x, y: this.tmp.y, heading: this.tmp.heading };
  }

  toggleRibbon(on?: boolean): void {
    this.ribbon.visible = on ?? !this.ribbon.visible;
    this.state.ribbonVisible = this.ribbon.visible;
    this.emit('info', this.ribbon.visible ? 'Guidance chevrons on' : 'Guidance chevrons off (V)');
  }

  /** Report a collision impact (m/s) from the physics. */
  noteImpact(impact: number): void {
    if (impact < 1.2 || this.time - this.lastImpactT < 1.5 || this.state.finished) return;
    this.lastImpactT = this.time;
    this.state.collisions++;
    this.emit('collision', impact > 4 ? 'Heavy collision!' : 'Collision');
  }

  private emit(kind: GuideEventKind, text: string, delta?: number): void {
    const ev: GuideEvent = { id: ++this.eventId, kind, text, delta };
    this.state.events.push(ev);
    if (this.state.events.length > 12) this.state.events.shift();
  }

  /** Scheduled seconds after departure at route distance s (linear between timing points). */
  private expectedAt(s: number): number {
    const st = this.route.stops;
    if (!st.length) return 0;
    let t: number;
    if (s <= st[0].s) t = st[0].t;
    else if (s >= st[st.length - 1].s) t = st[st.length - 1].t;
    else {
      let i = 0;
      while (i < st.length - 2 && st[i + 1].s < s) i++;
      const a = st[i];
      const b = st[i + 1];
      t = a.t + ((b.t - a.t) * (s - a.s)) / Math.max(1, b.s - a.s);
    }
    return t - this.departT;
  }

  private project(x: number, y: number): { s: number; dist: number } {
    const r = this.route;
    const cum = r.cum;
    const s0 = this.state.s;
    // Search a window around the last position, then fall back to the whole route.
    let from = this.segI;
    while (from > 0 && cum[from] > s0 - 150) from--;
    let to = this.segI;
    while (to < cum.length - 1 && cum[to] < s0 + 400) to++;
    let pr = this.projectNear(x, y, from, to + 1, s0);
    if (pr.dist > 25 || (!this.initialised && pr.dist > 12)) {
      // Not near the expected place (teleport, shortcut): search the whole route,
      // preferring a stretch that runs the way we are heading (loops overlap themselves).
      const g = projectOnto(r.pts, cum, x, y);
      const aligned = (() => {
        const p = pointAlong(r.pts, cum, g.s);
        return Math.cos(p.heading - this.motionHeading) > 0.2;
      })();
      if ((!this.initialised && (aligned || g.dist < pr.dist - 5)) || (g.dist < pr.dist - 5 && g.dist < 20 && g.s > s0 - 30 && aligned)) pr = g;
    }
    this.segI = pr.i;
    return { s: pr.s, dist: pr.dist };
  }

  /**
   * Windowed projection that prefers continuity: where the route doubles back
   * on itself (hairpins, out-and-back legs) the nearest segment by distance
   * alone can belong to a later part of the route.
   */
  private projectNear(x: number, y: number, from: number, to: number, s0: number): { s: number; dist: number; i: number } {
    const pts = this.route.pts;
    const cum = this.route.cum;
    let best = Infinity;
    let bs = s0;
    let bd = Infinity;
    let bi = this.segI;
    const end = Math.min(to, cum.length - 1);
    for (let i = Math.max(0, from); i < end; i++) {
      const ax = pts[2 * i];
      const ay = pts[2 * i + 1];
      const dx = pts[2 * i + 2] - ax;
      const dy = pts[2 * i + 3] - ay;
      const len2 = dx * dx + dy * dy || 1e-9;
      let t = ((x - ax) * dx + (y - ay) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
      const s = cum[i] + t * Math.sqrt(len2);
      const score = d + Math.max(0, Math.abs(s - s0) - 25) * 0.08;
      if (score < best) {
        best = score;
        bs = s;
        bd = d;
        bi = i;
      }
    }
    return { s: bs, dist: bd, i: bi };
  }

  update(dt: number, frontX: number, frontY: number, doorsOpen: boolean, speed: number, heading?: number, hours = 12): GuideState {
    const st = this.state;
    this.time += dt;
    // Motion heading for limit lookup and rejoin checks.
    if (heading !== undefined) this.motionHeading = heading;
    else if (Number.isFinite(this.lastX)) {
      const dx = frontX - this.lastX;
      const dy = frontY - this.lastY;
      if (dx * dx + dy * dy > 0.04) this.motionHeading = Math.atan2(dx, dy) + (speed < 0 ? Math.PI : 0);
    }
    if (Number.isFinite(this.lastX)) {
      const d = Math.hypot(frontX - this.lastX, frontY - this.lastY);
      if (d < 20) st.distanceDriven += d;
    }
    this.lastX = frontX;
    this.lastY = frontY;

    const prevS = st.s;
    const pr = this.project(frontX, frontY);
    st.s = pr.s;
    st.routeDistance = pr.dist;
    st.progress = Math.min(1, st.s / Math.max(1, this.route.length));
    const stops = this.route.stops;

    if (!this.initialised) {
      this.initialised = true;
      // Stops behind the start are skipped; the stop we start at is the departure stop.
      for (let i = 0; i < stops.length; i++) {
        if (Math.abs(stops[i].s - st.s) < 20 && this.departIndex < 0) {
          this.departIndex = i;
          break;
        }
        if (stops[i].s < st.s - 20) st.stopStatus[i] = StopStatus.Skipped;
      }
      this.departS = st.s;
      if (this.departIndex >= 0) this.departT = stops[this.departIndex].t;
      else this.departT = this.expectedAt(st.s) + this.departT;
      this.emit('info', `Route ${this.route.id} to ${this.route.headsign}`);
    }

    // Shift clock starts when we pull away from the departure point.
    if (!st.shiftStarted && !st.finished && Math.abs(speed) > 0.6 && Math.abs(st.s - this.departS) > 2) {
      st.shiftStarted = true;
      if (this.departIndex >= 0 && st.stopStatus[this.departIndex] === StopStatus.Pending) {
        st.stopStatus[this.departIndex] = StopStatus.Served;
        st.stopsServed++;
        this.servedDeltas.push(0);
      }
      this.emit('depart', 'Departed — have a good shift!');
    }
    if (st.shiftStarted && !st.finished) st.shiftTime += dt;
    if (session.hours !== null) hours = session.hours;

    // Off-route with hysteresis.
    const wasOff = st.offRoute;
    st.offRoute = wasOff ? pr.dist > 20 : pr.dist > 30;
    if (st.offRoute !== wasOff) this.emit(st.offRoute ? 'offroute' : 'onroute', st.offRoute ? 'Off route — return to the route' : 'Back on route');
    if (st.offRoute) {
      const p = pointAlong(this.route.pts, this.route.cum, Math.min(this.route.length, st.s + 25));
      st.rejoinX = p.x;
      st.rejoinY = p.y;
    }

    // Stop logic.
    let next = -1;
    for (let i = 0; i < stops.length; i++) {
      if (st.stopStatus[i] !== StopStatus.Pending) continue;
      if (i === this.departIndex && !st.shiftStarted) continue;
      next = i;
      break;
    }
    // Missed: we are well past the stop without serving it.
    if (next >= 0 && st.s > stops[next].s + 22 && !st.offRoute) {
      st.stopStatus[next] = StopStatus.Missed;
      st.stopsMissed++;
      this.emit('missed', `Missed stop: ${stopDisplayName(this.data.stops[stops[next].stop].name)}`);
      next = -1;
      for (let i = 0; i < stops.length; i++) if (st.stopStatus[i] === StopStatus.Pending && i !== this.departIndex) {
        next = i;
        break;
      }
    }
    // Departure delta for the stop we just served, measured as we leave it.
    if (this.dwellIndex >= 0) {
      const ds = stops[this.dwellIndex];
      if (st.s > ds.s + 16 || (Math.abs(speed) > 2 && !doorsOpen)) {
        const delta = st.shiftTime - (ds.t - this.departT);
        this.servedDeltas.push(delta);
        this.dwellIndex = -1;
      }
    }
    st.atStop = false;
    st.canServe = false;
    if (next >= 0) {
      const ns = stops[next];
      const along = st.s - ns.s;
      st.atStop = along > -15 && along < 18 && pr.dist < 14;
      st.canServe = st.atStop && Math.abs(speed) < 0.5;
      if (st.canServe && doorsOpen && st.shiftStarted) {
        st.stopStatus[next] = StopStatus.Served;
        st.stopsServed++;
        const delta = st.shiftTime - (ns.t - this.departT);
        this.dwellIndex = next;
        this.emit('served', `Served ${stopDisplayName(this.data.stops[ns.stop].name)}`, delta);
        const last = next === stops.length - 1;
        if (last) this.finishTimer = 2.5;
      }
    }
    if (next !== st.nextStopIndex || !st.nextStopName) {
      st.nextStopIndex = next;
      if (next >= 0) {
        const s = this.data.stops[stops[next].stop];
        st.nextStopName = stopDisplayName(s.name);
        st.nextStopNumber = stopNumber(s.name);
        st.nextStopCode = s.code;
        st.nextStopStation = isStationStop(s.name);
        st.nextStopDue = stops[next].t - this.departT;
        const p = this.places[next];
        this.marker.setStop(stops[next].s, p.x, p.y);
      } else {
        st.nextStopName = '';
        st.nextStopNumber = '';
        st.nextStopCode = '';
        st.nextStopStation = false;
        this.marker.setStop(null, 0, 0);
      }
    }
    st.nextStopDistance = next >= 0 ? stops[next].s - st.s : Infinity;

    // Timetable delta.
    if (st.shiftStarted) {
      if (this.dwellIndex >= 0) st.scheduleDelta = st.shiftTime - (stops[this.dwellIndex].t - this.departT);
      else st.scheduleDelta = st.shiftTime - this.expectedAt(Math.max(st.s, prevS - 1));
    } else st.scheduleDelta = 0;

    // Finish: all stops resolved and near the end, or the end of the line reached.
    if (!st.finished) {
      const allDone = next < 0;
      if (this.finishTimer > 0) {
        this.finishTimer -= dt;
        if (this.finishTimer <= 0) this.finish();
      } else {
        const L = this.route.length;
        const atEnd = st.s > L - 6;
        const lastPendingNear = next >= 0 && Math.abs(stops[next].s - st.s) < 25;
        if (atEnd && Math.abs(speed) < 0.5) this.endWait += dt;
        else this.endWait = 0;
        if (allDone && st.s > L - 40 && Math.abs(speed) < 1) this.finish();
        // At the end of the line with the last stop unserved: give the driver time to open the doors.
        else if (atEnd && (!lastPendingNear || this.endWait > 25 || pr.dist > 25)) this.finish();
      }
    }

    // Turn hint.
    while (this.turnIdx < this.turns.length && this.turns[this.turnIdx].s < st.s - 4) this.turnIdx++;
    while (this.turnIdx > 0 && this.turns[this.turnIdx - 1].s >= st.s - 4) this.turnIdx--;
    const t = this.turns[this.turnIdx];
    st.turn = t && !st.offRoute ? t : null;
    st.turnDistance = t ? t.s - st.s : Infinity;

    // Upcoming traffic signal.
    const sigs = this.track.signals;
    while (this.sigIdx < sigs.length && sigs[this.sigIdx].s < st.s - 3) {
      this.sigIdx++;
      this.sigState = null;
    }
    while (this.sigIdx > 0 && sigs[this.sigIdx - 1].s >= st.s - 3) this.sigIdx--;
    const sg = sigs[this.sigIdx];
    const world = session.world;
    if (sg && world?.signalStateAt && !st.offRoute && sg.s - st.s < 150) {
      this.sigTimer -= dt;
      if (this.sigTimer <= 0 || this.sigState === null) {
        this.sigTimer = 0.2;
        this.sigState = world.signalStateAt(sg.x, sg.y, this.time);
      }
      st.signal = this.sigState ? { distance: Math.max(0, sg.s - st.s), state: this.sigState } : null;
    } else st.signal = null;

    // Speed limit and street name, refreshed a few times a second.
    this.limitTimer -= dt;
    if (this.limitTimer <= 0) {
      this.limitTimer = 0.25;
      const idx = roadIndexFor(this.data);
      const hit = idx.nearest(frontX, frontY, 14, this.motionHeading, 0.6, drivable) ?? idx.nearest(frontX, frontY, 10, undefined, 0, drivable);
      if (hit) {
        const road = this.data.roads[hit.road];
        st.speedLimit = speedLimitOf(road);
        st.roadName = road.name ? shortStreet(road.name) : road.bus ? 'Busway' : '';
      } else if (!st.offRoute) {
        st.speedLimit = this.track.limitAt(st.s);
      }
    }
    const kmh = Math.abs(speed) * 3.6;
    st.speeding = kmh > st.speedLimit + 5;
    if (st.speeding && !st.finished) st.speedingSeconds += dt;

    // Scene objects.
    this.ribbon.update(dt, st.s, st.offRoute || st.finished);
    this.marker.update(dt, Math.max(0, st.nextStopDistance), hours);
    return st;
  }

  private finish(): void {
    const st = this.state;
    if (st.finished) return;
    st.finished = true;
    for (let i = 0; i < st.stopStatus.length; i++) {
      if (st.stopStatus[i] === StopStatus.Pending) {
        st.stopStatus[i] = StopStatus.Missed;
        st.stopsMissed++;
      }
    }
    if (this.dwellIndex >= 0) {
      this.servedDeltas.push(st.shiftTime - (this.route.stops[this.dwellIndex].t - this.departT));
      this.dwellIndex = -1;
    }
    this.marker.setStop(null, 0, 0);
    const d = this.servedDeltas;
    const onTime = d.filter((x) => x >= -60 && x < 240).length;
    const skipped = Array.from(st.stopStatus).filter((x) => x === StopStatus.Skipped).length;
    const counted = Math.max(1, st.stopsTotal - skipped);
    const punctuality = d.length ? Math.round((onTime / d.length) * 100) : 0;
    const served = st.stopsServed / counted;
    let score = 100 * (0.55 * served + 0.35 * (punctuality / 100) + 0.1);
    score -= st.collisions * 6 + Math.min(20, st.speedingSeconds / 6);
    score = Math.max(0, Math.min(100, Math.round(score)));
    const grade = score >= 90 ? 'A' : score >= 78 ? 'B' : score >= 64 ? 'C' : score >= 50 ? 'D' : 'F';
    st.summary = {
      routeId: this.route.id,
      headsign: this.route.headsign,
      stopsTotal: st.stopsTotal,
      stopsServed: st.stopsServed,
      stopsMissed: st.stopsMissed,
      stopsSkipped: skipped,
      onTime,
      punctuality,
      avgDelta: d.length ? d.reduce((a, b) => a + b, 0) / d.length : 0,
      worstLate: d.length ? Math.max(0, ...d) : 0,
      worstEarly: d.length ? Math.min(0, ...d) : 0,
      collisions: st.collisions,
      distance: st.distanceDriven,
      time: st.shiftTime,
      speedingSeconds: st.speedingSeconds,
      score,
      grade,
    };
    this.emit('finished', `End of route ${this.route.id}`);
  }

  dispose(): void {
    if (session.guide === this) session.guide = null;
    removeEventListener('keydown', this.onKey);
    this.ribbon.dispose();
    this.marker.dispose();
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}
