// RouteGuide: owns the player's route objects in the scene (stops, guidance
// chevrons, next-stop highlight) and runs the shift logic: serving stops,
// timetable adherence, off-route detection, turn hints and the end summary.
import * as THREE from 'three';
import type { BusType, MapData, Road, Route } from '../types';
import { pointAlong, projectOnto } from '../data/coords';
import { drivable, roadIndexFor, speedLimitOf } from './roadIndex';
import { TRACK_STEP, trackFor, useTrackWalls, type RouteTrack, type TrackSample, type TrackWalls } from './track';
import { computeTurns, shortStreet, type TurnHint } from './turns';
import { busTypeForRoute, isStationStop, stopDisplayName, stopNumber } from './routeMeta';
import { flagAtlas, partsGroup, plateGeometry, poleParts, signMaterial, SIGN_H, SIGN_W } from './stops3d';
import { buildPlatforms, type PlatformZone } from './platforms';
import { NextStopMarker, Ribbon } from './ribbon';
import { brighten } from './util';
import { session } from './session';
import { LEVEL_GAP, heightAt, heightsOf } from './height';
import type { Heights } from '../data/height';
import { Passengers, type DwellState } from './passengers';

export const enum StopStatus {
  Pending = 0,
  Served = 1,
  Missed = 2,
  Skipped = 3,
}

export type GuideEventKind = 'served' | 'missed' | 'depart' | 'offroute' | 'onroute' | 'finished' | 'collision' | 'leftbehind' | 'full' | 'info';

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
  /** Boardings over the shift. */
  passengersCarried: number;
  /** Left at a stop or carried past it by closing the doors early. */
  passengersLeft: number;
  /** Could not board because the bus was full. */
  passengersFull: number;
  /** Passenger time beyond the timetable's allowance, excused from punctuality (s). */
  passengerDelay: number;
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
  /**
   * The bus is in a tunnel, on a viaduct, or on a bridge over the river (for
   * the HUD), else null. Short culverts and bridges already named "… Bridge"
   * get no tag.
   */
  roadLevel: 'tunnel' | 'viaduct' | 'bridge' | null;
  /** Grade along the direction of travel (rise/run; + = uphill). */
  grade: number;
  distanceDriven: number;
  collisions: number;
  speedingSeconds: number;
  /** Recent events, newest last; ids increase monotonically. */
  events: GuideEvent[];
  summary: RouteSummary | null;
  ribbonVisible: boolean;
  /** Next traffic signal on the route within ~150 m (needs world.signalStateAt), or null. */
  signal: { distance: number; state: 'green' | 'amber' | 'red' } | null;
  /** Passengers on board, and what the bus holds (seated + standing). */
  load: number;
  capacity: number;
  /** Passengers getting off and on at the stop being served (doors open), or null. */
  dwell: DwellState | null;
  /** Stopped at the departure stop with passengers waiting: open the doors to board them. */
  canBoard: boolean;
  passengersCarried: number;
  /** Left behind by closing the doors early (see DwellState). */
  passengersLeft: number;
}

/** Door and kneel state from the cab controls (BusControls fits). */
export interface GuideCab {
  /** Door opening 0..1. */
  doorOpen: number;
  /** The driver's door switch (false once they press close). */
  doorsWanted: boolean;
  /** Kneel 0..1. */
  kneel: number;
}

export interface RouteGuideOptions {
  /** Overall length of the player's bus (front to rear), metres. */
  busLength?: number;
  /**
   * The driving collider's walls (tunnel tubes, parapets) to bound the guide
   * lane with. Without it the lane uses the most recently built collider for
   * this map, if any.
   */
  walls?: TrackWalls;
  /** The player's bus type, for passenger capacity and door times (default: the route's usual type). */
  busType?: BusType;
}

interface StopPlace {
  x: number;
  y: number;
  heading: number;
  kerb: number;
  station: boolean;
  /** Busway platform zone (serve at any bay along it), or null for a kerbside stop. */
  zone: PlatformZone | null;
  /** Road height at the place (m AHD). */
  z: number;
}

function frame(x: number, y: number, heading: number, out: THREE.Object3D, z: number): void {
  out.position.set(x, z, -y);
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
  private lastZ = 0;
  private readonly heights: Heights;
  private endWait = 0;
  private turnIdx = 0;
  private sigIdx = 0;
  private sigTimer = 0;
  private sigState: 'green' | 'amber' | 'red' | null = null;
  private readonly pax: Passengers;
  /** The doors were opened at the departure stop before the shift. */
  private departBoarded = false;
  /** Route distance where the current dwell started (the bus is held there while the doors are open). */
  private paxS = 0;
  private readonly onKey: (e: KeyboardEvent) => void;

  constructor(
    readonly scene: THREE.Scene,
    readonly data: MapData,
    readonly route: Route,
    opts: RouteGuideOptions = {},
  ) {
    this.busLength = opts.busLength ?? 13;
    this.heights = heightsOf(data);
    if (opts.walls) useTrackWalls(data, opts.walls);
    this.track = trackFor(route, data);
    this.turns = computeTurns(data, route);
    this.color = brighten(route.color, 0.32);
    this.pax = new Passengers(data, route, opts.busType ?? busTypeForRoute(route), (k, t) => this.emit(k, t));
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
      roadLevel: null,
      grade: 0,
      distanceDriven: 0,
      collisions: 0,
      speedingSeconds: 0,
      events: [],
      summary: null,
      ribbonVisible: true,
      signal: null,
      load: 0,
      capacity: this.pax.capacity,
      dwell: null,
      canBoard: false,
      passengersCarried: 0,
      passengersLeft: 0,
    };
    // The flag stands a few metres ahead of the stop (the world puts a shelter at the stop itself).
    this.places = this.track.stops.map((ts) => {
      const z = ts.zone;
      const at = z ? (z.s0 + z.s1) / 2 : ts.s + 3;
      this.track.sample(at, this.tmp);
      const lx = -this.tmp.hy;
      const ly = this.tmp.hx;
      const kerb = z ? this.track.kerbAt((z.s0 + z.s1) / 2) : ts.kerb;
      const off = kerb + (z ? 1.4 : 0.6);
      return { x: this.tmp.x + lx * off, y: this.tmp.y + ly * off, heading: this.tmp.heading, kerb, station: ts.station, zone: z, z: this.track.zAt(at) };
    });
    // Seed the projection window at the start stop (loop routes start where they end).
    const s0 = this.startS();
    this.state.s = s0;
    this.lastZ = this.track.zAt(s0);
    this.segI = pointAlong(route.pts, route.cum, s0).i;
    this.group.name = 'route-guide';
    scene.add(this.group);
    buildPlatforms(scene, data);
    this.buildRouteStops();
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
    const stopIdx = this.route.stops.map((s) => s.stop);
    const atlas = flagAtlas(data, stopIdx, false);
    const signMat = signMaterial(atlas.tex);
    const pole = poleParts();
    this.route.stops.forEach((_rs, i) => {
      const p = this.places[i];
      // Busway platforms carry their own bay flags (see platforms.ts).
      if (p.zone) return;
      const g = partsGroup(pole);
      const plate = new THREE.Mesh(plateGeometry(atlas.uv[i]), signMat);
      plate.position.set(SIGN_W / 2 + 0.03, 3.15 - SIGN_H / 2 - 0.05, 0);
      g.add(plate);
      frame(p.x, p.y, p.heading, g, p.z);
      this.group.add(g);
    });
  }

  // -------------------------------------------------------------------------

  /** Where the player's bus should start: map x/y of the FRONT of the bus and heading. */
  startPose(): { x: number; y: number; heading: number; z: number } {
    const s = this.startS();
    const kerb = this.track.kerbAt(s);
    const pull = Math.max(0, kerb - 1.7);
    this.track.sample(s, this.tmp, pull);
    return { x: this.tmp.x, y: this.tmp.y, heading: this.tmp.heading, z: this.track.zAt(s) };
  }

  /**
   * The guidance lane at route distance `s` (metres along the route): map x/y
   * and heading of the FRONT of the bus, and the road height there. This is
   * the path the guide and the AI buses follow (on the carriageway at its
   * level), unlike the raw GTFS shape, which can run metres off a busway
   * tunnel. Use it to place the bus part-way along the route (dev `?s=`).
   */
  trackPose(s: number): { x: number; y: number; heading: number; z: number } {
    const ss = Math.max(0, Math.min(this.route.length, s));
    this.track.sample(ss, this.tmp);
    return { x: this.tmp.x, y: this.tmp.y, heading: this.tmp.heading, z: this.track.zAt(ss) };
  }

  /** Start of the stretch where the front of the bus counts as being at stop i (at a platform: the front door alongside it). */
  private zoneFrom(i: number): number {
    const z = this.places[i]?.zone;
    const s = this.route.stops[i].s;
    return z ? z.s0 + 1.5 : s - 15;
  }

  /** End of the stretch where the front of the bus counts as being at stop i (the front door still about at the platform). */
  private zoneTo(i: number): number {
    const z = this.places[i]?.zone;
    const s = this.route.stops[i].s;
    return z ? z.s1 + 3 : s + 18;
  }

  /** Route distance of the front of the bus at the start (first stop; front bay of a platform). */
  private startS(): number {
    const first = this.track.stops[0];
    const want = first ? (first.zone ? first.zone.s1 - 1 : first.s) : 0;
    return Math.min(this.route.length - 1, Math.max(want, this.busLength + 2));
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

  /** Shift time for the timetable: passenger time beyond the usual allowance at a stop is not the driver's. */
  private shiftClock(): number {
    return this.state.shiftTime - this.pax.excused;
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

  /**
   * Advance the shift. `frontZ` (optional) is the road height under the front
   * of the bus; it picks the level where roads stack (tunnel under a street).
   * `cab` (optional) gives the door opening and kneel for the passengers; without
   * it they move whenever the doors are open.
   */
  update(dt: number, frontX: number, frontY: number, doorsOpen: boolean, speed: number, heading?: number, hours = 12, frontZ?: number, cab?: GuideCab): GuideState {
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
    // On the street under the route (or above its tunnel) is not on the route.
    if (frontZ !== undefined) {
      const dz = Math.abs(frontZ - this.track.zAt(pr.s));
      if (dz > LEVEL_GAP) pr.dist = Math.max(pr.dist, 35 + dz);
    }
    st.s = pr.s;
    st.routeDistance = pr.dist;
    st.progress = Math.min(1, st.s / Math.max(1, this.route.length));
    const stops = this.route.stops;
    // Where the front is for stop i: at a platform on the lane (it can run well off the GTFS line through a
    // station hall), and alongside it within `near`; at a kerbside stop on the route line.
    let lane: { s: number; dist: number } | null = null;
    const at = (i: number): { s: number; dist: number; near: number } => {
      if (!this.places[i]?.zone) return { s: st.s, dist: pr.dist, near: 14 };
      if (!lane) {
        lane = this.track.project(frontX, frontY, st.s - 40, st.s + 40);
        // (Fallen off a viaduct platform onto the street below is not alongside it.)
        const dz = frontZ === undefined ? 0 : Math.abs(frontZ - this.track.zAt(lane.s));
        if (dz > LEVEL_GAP) lane.dist = Math.max(lane.dist, 35 + dz);
      }
      return { s: lane.s, dist: lane.dist, near: 3.5 };
    };

    if (!this.initialised) {
      this.initialised = true;
      // Stops behind the start are skipped; the stop we start at is the departure stop.
      for (let i = 0; i < stops.length; i++) {
        if ((Math.abs(stops[i].s - st.s) < 20 || (st.s >= this.zoneFrom(i) && st.s <= this.zoneTo(i))) && this.departIndex < 0) {
          this.departIndex = i;
          break;
        }
        if (stops[i].s < st.s - 20) st.stopStatus[i] = StopStatus.Skipped;
      }
      // Riders already aboard from the stops behind the start.
      let first = 0;
      while (first < stops.length && st.stopStatus[first] === StopStatus.Skipped) first++;
      this.pax.startAt(this.departIndex >= 0 ? this.departIndex : first, hours);
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
      // Pulled out without opening the doors: whoever was waiting is still at the stop.
      if (this.departIndex >= 0 && !this.departBoarded) {
        this.departBoarded = true;
        this.pax.leaveAll(this.departIndex, hours);
      }
      this.emit('depart', 'Departed — have a good shift!');
    }
    if (st.shiftStarted && !st.finished) st.shiftTime += dt;
    if (session.hours !== null) hours = session.hours;
    // Departure stop: passengers board before the shift clock starts.
    st.canBoard = this.departIndex >= 0 && !this.departBoarded && !st.shiftStarted && !st.finished && Math.abs(speed) < 0.5;
    if (st.canBoard && doorsOpen) {
      this.departBoarded = true;
      st.canBoard = false;
      this.pax.start(this.departIndex, hours);
      this.paxS = at(this.departIndex).s;
    }

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
    if (next >= 0 && st.s > this.zoneTo(next) + 18 && !st.offRoute) {
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
      if (st.s > this.zoneTo(this.dwellIndex) || (Math.abs(speed) > 2 && !doorsOpen)) {
        const delta = this.shiftClock() - (ds.t - this.departT);
        this.servedDeltas.push(delta);
        this.dwellIndex = -1;
      }
    }
    st.atStop = false;
    st.canServe = false;
    if (next >= 0) {
      const ns = stops[next];
      // Kerbside: front within ~15 m of the flag. Platform: alongside any bay.
      const a = at(next);
      st.atStop = a.s >= this.zoneFrom(next) && a.s <= this.zoneTo(next) && a.dist < a.near;
      st.canServe = st.atStop && Math.abs(speed) < 0.5;
      // (A stop at the same spot as the one just served waits for its passengers to finish.)
      if (st.canServe && doorsOpen && st.shiftStarted && !this.pax.busy) {
        st.stopStatus[next] = StopStatus.Served;
        st.stopsServed++;
        const delta = this.shiftClock() - (ns.t - this.departT);
        this.dwellIndex = next;
        this.emit('served', `Served ${stopDisplayName(this.data.stops[ns.stop].name)}`, delta);
        this.pax.start(next, hours);
        this.paxS = a.s;
      }
    }
    // Passengers move while the doors are fully open and the bus is held at the stop.
    const pi = this.pax.stopIndex;
    if (pi >= 0) {
      const a = at(pi);
      if (Math.abs(a.s - this.paxS) > 4 || a.dist > 14) this.pax.depart();
      else {
        const doors = !doorsOpen ? 'shut' : !cab ? 'open' : !cab.doorsWanted ? 'closing' : cab.doorOpen > 0.98 ? 'open' : 'opening';
        this.pax.update(dt, doors, Math.abs(speed) < 0.3, cab?.kneel ?? 0, st.shiftStarted);
      }
      // End of the line: finish once everyone is off (or the doors close on them).
      if (pi === stops.length - 1 && !this.pax.busy && this.finishTimer <= 0 && !st.finished) this.finishTimer = 2.5;
    }
    st.dwell = this.pax.view;
    st.load = this.pax.load;
    st.passengersCarried = this.pax.carried;
    st.passengersLeft = this.pax.left;
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
        if (p.zone) this.marker.setStop(p.zone.s1 + 1, p.x, p.y, p.zone.s0 - 1, p.z);
        else this.marker.setStop(stops[next].s, p.x, p.y, undefined, p.z);
      } else {
        st.nextStopName = '';
        st.nextStopNumber = '';
        st.nextStopCode = '';
        st.nextStopStation = false;
        this.marker.setStop(null, 0, 0);
      }
    }
    st.nextStopDistance = next < 0 ? Infinity : this.places[next].zone ? Math.max(0, this.places[next].zone!.s0 - st.s) : stops[next].s - st.s;

    // Timetable delta.
    if (st.shiftStarted) {
      if (this.dwellIndex >= 0) st.scheduleDelta = this.shiftClock() - (stops[this.dwellIndex].t - this.departT);
      else st.scheduleDelta = this.shiftClock() - this.expectedAt(Math.max(st.s, prevS - 1));
    } else st.scheduleDelta = 0;

    // Finish: all stops resolved and near the end, or the end of the line reached.
    if (!st.finished) {
      const allDone = next < 0;
      if (this.finishTimer > 0) {
        this.finishTimer -= dt;
        if (this.finishTimer <= 0) this.finish();
      } else if (!this.pax.busy) {
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
        this.track.sample(sg.s, this.tmp);
        this.sigState = world.signalStateAt(sg.x, sg.y, this.time, this.tmp.hx, this.tmp.hy);
      }
      st.signal = this.sigState ? { distance: Math.max(0, sg.s - st.s), state: this.sigState } : null;
    } else st.signal = null;

    // Speed limit and street name, refreshed a few times a second.
    this.limitTimer -= dt;
    if (this.limitTimer <= 0) {
      this.limitTimer = 0.25;
      const idx = roadIndexFor(this.data);
      // Our level: the physics' height if given, else the route's, else where we last were.
      const hint = frontZ ?? (!st.offRoute ? this.track.zAt(st.s) : this.lastZ);
      const surf = this.heights.surfaceAt(frontX, frontY, hint);
      // No road at our level right under the front (wide station, lane hugging a platform): keep our level.
      const z = surf.road < 0 && Math.abs(surf.z - hint) > LEVEL_GAP ? hint : surf.z;
      this.lastZ = z;
      session.playerZ = z;
      // On the route: the road its lane is matched to (not a side street at a junction, nor the road under a
      // bridge or over a tunnel); off it, the nearest road at our level.
      const onRoad = st.offRoute ? -1 : this.track.road[Math.max(0, Math.min(this.track.n - 1, Math.round(st.s / TRACK_STEP)))];
      const hit = onRoad >= 0 ? null : (idx.nearest(frontX, frontY, 14, this.motionHeading, 0.6, drivable, z) ?? idx.nearest(frontX, frontY, 10, undefined, 0, drivable, z));
      const ri = onRoad >= 0 ? onRoad : hit ? hit.road : surf.road;
      if (ri >= 0) {
        const road = this.data.roads[ri];
        st.speedLimit = onRoad >= 0 ? this.track.limitAt(st.s) : speedLimitOf(road);
        // (Route numbers tagged as the name are not street names; an unnamed link on the route keeps the street.)
        const name = road.name && !/^[\d;\s]+$/.test(road.name) ? shortStreet(road.name) : '';
        st.roadName = name || (road.bus ? 'Busway' : onRoad >= 0 ? st.roadName : '');
        st.roadLevel = road.tunnel ? 'tunnel' : road.bridge ? elevatedKind(road, this.heights) : null;
      } else {
        st.roadLevel = null;
        if (!st.offRoute) st.speedLimit = this.track.limitAt(st.s);
      }
      // Grade along the way we are going.
      if (!st.offRoute) st.grade = this.track.gradeAt(st.s, 8) * (speed < -0.2 ? -1 : 1);
      else {
        const hx = Math.sin(this.motionHeading) * 8;
        const hy = Math.cos(this.motionHeading) * 8;
        st.grade = (heightAt(frontX + hx, frontY + hy, z) - heightAt(frontX - hx, frontY - hy, z)) / 16;
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
      this.servedDeltas.push(this.shiftClock() - (this.route.stops[this.dwellIndex].t - this.departT));
      this.dwellIndex = -1;
    }
    this.marker.setStop(null, 0, 0);
    this.pax.depart();
    st.dwell = null;
    const d = this.servedDeltas;
    const onTime = d.filter((x) => x >= -60 && x < 240).length;
    const skipped = Array.from(st.stopStatus).filter((x) => x === StopStatus.Skipped).length;
    const counted = Math.max(1, st.stopsTotal - skipped);
    const punctuality = d.length ? Math.round((onTime / d.length) * 100) : 0;
    const served = st.stopsServed / counted;
    let score = 100 * (0.55 * served + 0.35 * (punctuality / 100) + 0.1);
    score -= st.collisions * 6 + Math.min(20, st.speedingSeconds / 6);
    // A point for every passenger the doors closed on (or left at the departure stop).
    score -= Math.min(25, this.pax.left);
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
      passengersCarried: this.pax.carried,
      passengersLeft: this.pax.left,
      passengersFull: this.pax.full,
      passengerDelay: this.pax.excused,
      score,
      grade,
    };
    this.emit('finished', `End of route ${this.route.id}`);
  }

  dispose(): void {
    if (session.guide === this) {
      session.guide = null;
      session.playerZ = null;
    }
    removeEventListener('keydown', this.onKey);
    this.ribbon.dispose();
    this.marker.dispose();
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}

const elevated = new WeakMap<Road, 'viaduct' | 'bridge' | null>();
/** What kind of elevated road this is, for the HUD tag (cached per road). */
function elevatedKind(road: Road, H: Heights): 'viaduct' | 'bridge' | null {
  let v = elevated.get(road);
  if (v === undefined) {
    const p = road.pts;
    let len = 0;
    let wet = false;
    for (let i = 0; i < p.length; i += 2) {
      if (i) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
      if (H.ground(p[i], p[i + 1]) < H.waterLevel) wet = true;
    }
    for (let i = 0; i + 3 < p.length && !wet; i += 2) wet = H.ground((p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2) < H.waterLevel;
    v = len < 40 || /\bbridge\b/i.test(road.name ?? '') ? null : wet ? 'bridge' : 'viaduct';
    elevated.set(road, v);
  }
  return v;
}
