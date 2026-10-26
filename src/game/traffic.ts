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
import { TRACK_STEP, TrackBuild, hasTrack, trackFor, type RouteTrack, type TrackSample, type TrackSignal, type TrackStop } from './track';
import type { MapMarker } from './minimap';
import { brighten, rng } from './util';
import { CarTraffic, GAP_ACROSS, GAP_LEFT, PLAYER_HOLD, STALL_HIDDEN, STALL_VISIBLE, Turn, Wait, clearTime, removeAt, type BusJunction } from './cars';
import { hypot2 } from './hypot';
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
  /** Per junction of `jl`: where the bus stops for its light (the route's own stop line where it has one). */
  jLine: number[];
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
  /** Where its lane comes in to the player's lane (for the player's track `joinFor`), and the next one. */
  joins: Join[];
  joinFor: RouteTrack | null;
  joinNext: number;
  /** Where its lane and the player's, coming the other way, are too close for the two buses to pass, and the next one. */
  narrows: Join[];
  narrowNext: number;
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
  /** Coarse track distances inside the spawn radius: the first n. */
  inside: number[];
  n: number;
}

function totalLength(spec: BusSpec): number {
  let L = spec.sections[0].length;
  for (let i = 1; i < spec.sections.length; i++) {
    L += spec.sections[i].length - (spec.sections[i - 1].length - spec.sections[i - 1].rearHitchFromFront) - spec.sections[i].hitchFromFront;
  }
  return L;
}

/** AI bus acceleration (m/s^2). */
const BUS_A = 1.15;


/** Time gap (s) at which the player's bus claims the main road through an unsignalised junction. */
const MAJOR_GAP = 6;
/** ...and how far ahead (s) oncoming right-turners see it coming (a bus from rest needs 6-7 s to clear its path). */
const CLAIM_GAP = 9;
/** The player's bus pulling away (m/s^2), as its claims time it, up to `PLAYER_A_V` m/s. */
const PLAYER_A = 1.5;
const PLAYER_A_V = 8;
/** Stopped this close (m) behind its stop line on a green, the player's bus is about to go: it claims the junction. */
const LAUNCH_D = 4;
/** ...through the junction's nodes this far (m) ahead. */
const LAUNCH_R = 60;

/**
 * How far (m) a bus's axles track inside its front's path on a bend, per unit curvature: half the sum
 * of its axle-to-hitch spans squared, less the hitch overhangs behind the axles (which swing out).
 */
function offTrackK(spec: BusSpec): number {
  let k = spec.wheelbase * spec.wheelbase;
  const secs = spec.sections;
  for (let i = 1; i < secs.length; i++) {
    const link = Math.max(0.5, secs[i].axleFromFront - secs[i].hitchFromFront);
    const oh = Math.max(0, secs[i - 1].rearHitchFromFront - secs[i - 1].axleFromFront);
    k += link * link - oh * oh;
  }
  return k / 2;
}

/** Seconds until the player's bus gets d m ahead: at its speed, or picking up speed from a crawl. */
function playerEta(d: number, v: number): number {
  const a = PLAYER_A * Math.min(1, Math.max(0, (PLAYER_A_V - v) / 5));
  if (a <= 0) return d / Math.max(v, 1);
  return (Math.sqrt(v * v + 2 * a * d) - v) / a;
}
/**
 * Lane centrelines this close (m) put two buses side by side touching (2.5 m bodies, a little room):
 * where a bus's lane comes in beside the player's lane. Closer than JOIN_IN it is in it.
 */
const JOIN_D = 3.1;
const JOIN_IN = 1.2;
/** A bus giving way where its lane comes in waits where the two are still this far apart (m), up to JOIN_BACK (m) back. */
const JOIN_CLEAR = 3.9;
const JOIN_BACK = 12;
/** Two lanes this far apart in heading (cos) are not one coming in to the other (a crossing). */
const JOIN_COS = 0.64;
/** Grid cell (m) for finding the player's lane near a point. */
const JOIN_CELL = 8;
/** A bus merging in front of the player's bus has its tail in the lane this many seconds (s) before the player's front gets there. */
const MERGE_GAP = 2.5;
/**
 * An AI bus stops for the player's bus coming the other way once its centreline is this close (m, squared)
 * to the AI's path: touching distance, a little over the 2.5 m bodies (oncoming AI buses only from 1.8 m,
 * so that the next lane never stops them). An articulated bus's tail cuts in on a bend.
 */
const ONCOMING_PLAYER_R2 = 2.6 * 2.6;

/**
 * Where a bus's lane comes in to the player's lane: on the bus's track it is alongside from a0
 * (where it waits) and in the lane from a1; p0 and p1 are those places on the player's track.
 */
interface Join {
  a0: number;
  a1: number;
  p0: number;
  p1: number;
}

/**
 * Two buses coming opposite ways pass where their lanes are NARROW_W apart (m: the 2.5 m bodies and a
 * little room), plus on a bend the one on the outside cutting in towards the other: its axles track
 * inside its front's path by (sum of axle-to-hitch spans squared) * curvature / 2, and a little more
 * while the bend comes and goes (NARROW_BEND, m, beyond NARROW_K curvature). Closer than that is a
 * narrow: one of them waits.
 */
const NARROW_W = 2.9;
const NARROW_BEND = 0.2;
const NARROW_K = 0.01;

/**
 * Background track building: slices of BUILD_SLICE ms, in idle time and at least one every BUILD_WAIT ms
 * (about a frame); the routes near the player first, as of every BUILD_PRIO s.
 */
const BUILD_SLICE = 2;
const BUILD_WAIT = 20;
const BUILD_PRIO = 5;

/** How far past a route's stop line a signalised junction's first node may lie and still be on that line's light (m). */
const FAR_LINE = 70;

/** How far ahead (m) of an AI bus the car stop lines at its junctions are held back from its swept path. */
const AI_HOLD_AHEAD = 200;

export class Traffic {
  private active: AiBus[] = [];
  private pool = new Map<string, BusMesh[]>();
  // Spawn candidates: the first candN of candidates. A refresh fills candNext's objects (the
  // other buffer, reused) over a few frames and then swaps the two.
  private candidates: Candidate[] = [];
  private candN = 0;
  private candTimer = 0;
  private candCursor = 0;
  private candNext: Candidate[] = [];
  private candNextN = 0;
  private spawnTimer = 0;
  private nextId = 1;
  private rand = rng(20240607);
  private buildQueue: Route[];
  // Route tracks are built in the background a BUILD_SLICE at a time (a track takes 0.1-1 s), in idle
  // time between frames and at least a slice every BUILD_WAIT ms: building, the one under way (near: one
  // of the routes near the player); buildDue, a slice asked for; buildNear, how many of the queue's first
  // routes are near the player (prioritise, every BUILD_PRIO s while there are tracks to build).
  private building: TrackBuild | null = null;
  private buildingNear = false;
  private buildDue = false;
  private buildNear = 0;
  private buildPrio = 0;
  /** When the builder started, and how many tracks it built (for the log line when it is done). */
  private buildT0 = performance.now();
  private builtN = 0;
  private readonly buildRun = (d?: IdleDeadline): void => {
    this.buildDue = false;
    this.buildSome(d);
    this.scheduleBuild();
  };
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
  // step's scratch (nothing allocated per bus): the binding acceleration and why (lim), and the
  // nearest body on the path ahead (consider).
  private sAcc = 0.5;
  private sWhy: Wait = Wait.None;
  private sRef = 0;
  private cGap = 0.5;
  private cV = 0.5;
  private cId = 0;
  private cKind: Wait = Wait.None;
  /** consider's reach; idmTo's desired speed, gap, leader's speed and result; junctionOk's stop line distance. */
  private cReach = 0.5;
  private bV0 = 0.5;
  private iGap = 0.5;
  private iVL = 0.5;
  private iA = 0.5;
  private jStop = 0.5;
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
  private plans = new WeakMap<RouteTrack, { mids: TrackSignal[]; jAsk: (SignalAsk | null)[]; jLine: number[] }>();
  /** Per bus track: where it comes in to the player's lane `p`. */
  private joinCache = new WeakMap<RouteTrack, { p: RouteTrack; joins: Join[] }>();
  /** Per bus track: where it and the player's lane `p` are too close to pass. */
  private narrowCache = new WeakMap<RouteTrack, { p: RouteTrack; narrows: Join[] }>();
  /** The player's lane samples by grid cell. */
  private pGrid: { p: RouteTrack; cells: Map<number, number[]> } | null = null;
  // The spawn candidates' first-use caches (junctions, signal plan, and joins and narrows with the
  // player's lane: tens of ms for a route on a slow machine) are filled in idle time, so the first
  // bus spawned on a route does not pay for them in a frame. They are pure, so when they are filled
  // makes no difference to what they hold. warmAt: the next candidate to look at; warmFor: the
  // candidate list and player's lane a finished pass covered.
  private warmPending = false;
  private warmAt = 0;
  private warmFor: [Candidate[] | null, RouteTrack | null] = [null, null];
  private readonly warmRun = (d?: IdleDeadline): void => {
    this.warmPending = false;
    this.warmSome(d);
  };
  /** The player's lane and its front's place on it (null off the route). */
  private pTrack: RouteTrack | null = null;
  /** The player's track the car stop lines were held back for (holdBackFor). */
  private heldFor: RouteTrack | null = null;
  /** Per AI bus track: its junctions (by index) whose stop lines have been held back from its swept path. */
  private aiHeld = new WeakMap<RouteTrack, Uint8Array>();
  private pS = 0;
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
    // (Film runs build a few whole tracks per sim step instead: see simulate.)
    if (this.film || this.buildDue || !this.buildsLeft()) return;
    this.buildDue = true;
    if (typeof requestIdleCallback === 'function') requestIdleCallback(this.buildRun, { timeout: BUILD_WAIT });
    else setTimeout(this.buildRun, 4);
  }

  /** Tracks still to build (the queue's, and the one under way). */
  private buildsLeft(): boolean {
    return this.building !== null || this.buildQueue.length > 0;
  }

  /** Has the builder caught up: all tracks built (film runs), or those of the routes near the player? */
  private caughtUp(): boolean {
    return this.film ? !this.buildsLeft() : this.buildNear === 0 && !(this.building && this.buildingNear);
  }

  /** Build slices of the queue's tracks, first first: one, and more while the idle period lasts. */
  private buildSome(d?: IdleDeadline): void {
    for (let slices = 0; ; slices++) {
      if (slices > 0 && (!d || d.didTimeout || d.timeRemaining() < BUILD_SLICE + 1)) return;
      let b = this.building;
      while (!b) {
        const r = this.buildQueue.shift();
        if (!r) return;
        this.buildingNear = this.buildNear > 0;
        if (this.buildingNear) this.buildNear--;
        // (Not one built already: the player's own route, by its guide.)
        if (!hasTrack(r)) b = this.building = new TrackBuild(r, this.data);
      }
      // (A build that throws is dropped, not retried every slice.)
      this.building = null;
      if (!b.step(BUILD_SLICE)) this.building = b;
      else {
        this.builtN++;
        if (!this.buildsLeft()) console.info(`[traffic] ${this.builtN} route tracks built in the background in ${((performance.now() - this.buildT0) / 1000).toFixed(0)} s`);
      }
    }
  }

  /** Prioritise building tracks for routes near (x, y). */
  private prioritise(x: number, y: number): void {
    const near: Route[] = [];
    const far: Route[] = [];
    for (const r of this.buildQueue) (this.routeNear(r, x, y, this.radius + 300) ? near : far).push(r);
    this.buildQueue = [...near, ...far];
    this.buildNear = near.length;
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
    if (this.candCursor === 0) this.candNextN = 0;
    const next = this.candNext;
    const end = all ? routes.length : Math.min(routes.length, this.candCursor + 60);
    for (let k = this.candCursor; k < end; k++) {
      const r = routes[k];
      if (!hasTrack(r)) continue;
      const track = trackFor(r, this.data);
      const cand = (next[this.candNextN] ??= { route: r, track, weight: 0, inside: [], n: 0 });
      const inside = cand.inside;
      let n = 0;
      const c = track.coarse;
      for (let i = 0; i < c.length; i += 3) {
        const dx = c[i + 1] - px;
        const dy = c[i + 2] - py;
        if (dx * dx + dy * dy < R2) {
          if (n < inside.length) inside[n] = c[i];
          else inside.push(c[i]);
          n++;
        }
      }
      if (!n) continue;
      cand.route = r;
      cand.track = track;
      cand.weight = r.trips * n * 0.04;
      cand.n = n;
      this.candNextN++;
    }
    this.candCursor = end >= routes.length ? 0 : end;
    if (this.candCursor === 0) {
      this.candNext = this.candidates;
      this.candidates = next;
      this.candN = this.candNextN;
      this.warmAt = 0;
      this.warmFor[0] = null;
    }
  }

  /** Ask for an idle-time warming pass unless one is due or the last one covered the candidates. */
  private warmSoon(): void {
    if (this.warmPending || !this.candN || (this.warmFor[0] === this.candidates && this.warmFor[1] === this.pTrack)) return;
    this.warmPending = true;
    if (typeof requestIdleCallback === 'function') requestIdleCallback(this.warmRun, { timeout: 3000 });
    else setTimeout(this.warmRun, 200);
  }

  /** Warm candidates' caches while the idle period lasts (at least one cache a call). */
  private warmSome(d?: IdleDeadline): void {
    const P = this.pTrack;
    const cands = this.candidates;
    let jobs = 0;
    while (this.warmAt < this.candN) {
      if (jobs > 0 && (!d || d.didTimeout || d.timeRemaining() < 8)) {
        this.warmSoon();
        return;
      }
      const c = cands[this.warmAt];
      if (this.warmOne(c.route, c.track, P)) jobs++;
      else this.warmAt++;
    }
    this.warmAt = 0;
    this.warmFor[0] = cands;
    this.warmFor[1] = P;
  }

  /** Fill one missing first-use cache of route r's track a (false: none missing). */
  private warmOne(r: Route, a: RouteTrack, P: RouteTrack | null): boolean {
    if (!this.plans.has(a)) {
      this.signalPlan(a);
      return true;
    }
    // (As a bus on it would ask, in step, once the player's spec is known.)
    if (!P || !this.playerSpec) return false;
    if (this.joinCache.get(a)?.p !== P) {
      this.joinsOf(a, P);
      return true;
    }
    if (this.narrowCache.get(a)?.p !== P) {
      this.narrowsOf(a, P, this.buses.specFor(busTypeForRoute(r)));
      return true;
    }
    return false;
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
    const s = c.inside[Math.floor(this.rand() * c.n)] + (this.rand() - 0.5) * 36;
    if (s < 30 || s > r.length - 60) return false;
    c.track.sample(s, this.tmp);
    const dx = this.tmp.x - px;
    const dy = this.tmp.y - py;
    const d = hypot2(dx, dy);
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
    for (let oi = 0; oi < this.active.length; oi++) {
      const o = this.active[oi];
      const b = o.body;
      for (let k = 0; k < b.n; k++) {
        if (Math.abs(b.x[k] - this.tmp.x) < 26 && Math.abs(b.y[k] - this.tmp.y) < 26 && Math.abs(b.z[k] - zs) <= LEVEL_GAP && hypot2(b.x[k] - this.tmp.x, b.y[k] - this.tmp.y) < 26) return false;
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
      jLine: this.signalPlan(c.track).jLine,
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
      joins: [],
      joinFor: null,
      joinNext: 0,
      narrows: [],
      narrowNext: 0,
    };
    b.serve = this.decideServe(b);
    while (b.sigIdx < b.mids.length && b.mids[b.sigIdx].s < s) b.sigIdx++;
    while (b.jNext < b.jl.length && b.jl[b.jNext].stopS < s + 2) b.jNext++;
    this.updateBody(b);
    this.active.push(b);
    this.byId.set(b.id, b);
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
    const tr = b.track;
    tr.ql = b.pull;
    for (let k = 0; k < body.n; k++) {
      tr.qs = b.s - k * step;
      tr.sampleQ(this.tmp);
      body.x[k] = this.tmp.x;
      body.y[k] = this.tmp.y;
      body.z[k] = tr.qz;
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
    for (let bi = 0; bi < this.active.length; bi++) {
      const b = this.active[bi];
      const body = b.body;
      const mid = body.n >> 1;
      const cx = body.x[mid];
      const cy = body.y[mid];
      const dist = hypot2(cx - cam.x, -cy - cam.z);
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
    this.scheduleBuild();
  }

  /** One simulation step of the buses and cars (no drawing). */
  private simulate(dt: number, time: number, player: BusPose): void {
    this.simTime = time;
    const px = player.x;
    const py = player.y;
    this.updatePlayerBody(player);

    if (this.initial && !this.candN) this.prioritise(px, py);
    // (Building in the background, a slice at a time, takes minutes: the routes near the player first.)
    else if (!this.film && this.buildsLeft() && (this.buildPrio -= dt) <= 0) {
      this.buildPrio = BUILD_PRIO;
      this.prioritise(px, py);
    }
    // Film runs: tracks are built per sim step (not per wall-clock slice), so what exists when is reproducible.
    if (this.film) for (let k = 0; k < 3 && this.buildQueue.length; k++) trackFor(this.buildQueue.shift()!, this.data);
    this.candTimer -= dt;
    if (this.candCursor !== 0 || this.candTimer <= 0) {
      if (this.candCursor === 0) this.candTimer = this.candN ? 2 : 0.5;
      this.refreshCandidates(px, py, !this.candN);
    }

    // Despawn far away / finished / stuck buses.
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];
      const d = hypot2(b.body.fx - px, b.body.fy - py);
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
      for (let i = 0; i < this.active.length; i++) {
        const b = this.active[i];
        const d = hypot2(b.body.fx - px, b.body.fy - py);
        if (b.visible && d < 300) continue;
        const sc = d + (b.visible ? 0 : 1e5);
        if (sc > score) {
          score = sc;
          pick = i;
        }
      }
      if (pick >= 0) {
        this.removeBus(pick);
        this.stats.capDespawns++;
      }
    }

    // Spawn to keep the population up.
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.candN && this.capBuses > 0) {
      this.spawnTimer = this.initial ? 0 : 0.35;
      const cands = this.candidates;
      const nc = this.candN;
      let sumW = 0;
      for (let ci = 0; ci < nc; ci++) sumW += cands[ci].weight;
      const desired = Math.min(this.maxActive, Math.max(6, Math.round(sumW / 300)));
      let tries = this.initial ? 60 : 6;
      let made = 0;
      const maxMade = this.initial ? 10 : 2;
      while (this.active.length < desired && tries-- > 0 && made < maxMade) {
        let pick = this.rand() * sumW;
        let c = cands[0];
        for (let ci = 0; ci < nc; ci++) {
          const cc = cands[ci];
          pick -= cc.weight;
          if (pick <= 0) {
            c = cc;
            break;
          }
        }
        if (this.spawn(c, px, py)) made++;
      }
      // Populate freely (even in view) until the background track builder has caught up.
      if (this.initial && this.caughtUp() && (this.active.length >= desired || tries <= 0)) this.initial = false;
    } else if (this.capBuses === 0 && this.initial && this.caughtUp()) this.initial = false;

    // (byId holds every bus in the list: set in spawn, deleted in removeBus.)
    const g = session.guide;
    this.pTrack = g?.track && g.state && !g.state.offRoute ? g.track : null;
    this.pS = g?.state?.s ?? 0;
    // Car stop lines held back from the player's bus's swept path (once, before any car waits at one).
    if (this.pTrack && this.pTrack !== this.heldFor && this.playerSpec) {
      this.heldFor = this.pTrack;
      this.events.push(`stop lines held back from the route's swept path: ${this.cars.holdBackFor(this.pTrack, this.playerSpec)}`);
    }
    // ...and from each AI bus's, at the junctions it is coming up to (one junction a frame: 0.02-0.03 ms
    // on average, under 0.5 ms for the costliest of every route's junctions). 199/0 s 2309: a 60/0
    // turning left at Boundary St swept the line of the arm beside its way out, stopped in the box
    // behind a car waiting at its red there, and the box then held up the player's lane through it
    // for two minutes.
    let holdBudget = 1;
    for (let bi = 0; bi < this.active.length; bi++) {
      const b = this.active[bi];
      if (holdBudget <= 0) break;
      if (b.dead) continue;
      let done = this.aiHeld.get(b.track);
      if (!done) this.aiHeld.set(b.track, (done = new Uint8Array(b.jl.length)));
      for (let q = b.jNext; q < b.jl.length && b.jl[q].s < b.s + AI_HOLD_AHEAD && holdBudget > 0; q++) {
        if (done[q]) continue;
        done[q] = 1;
        holdBudget--;
        this.cars.holdBackFor(b.track, b.spec, q);
      }
    }
    this.claimJunctions(time, player);
    for (let bi = 0; bi < this.active.length; bi++) this.step(this.active[bi], dt, time);
    for (let bi = 0; bi < this.active.length; bi++) this.updateBody(this.active[bi]);

    // Safety valve: a bus that has driven into another bus is removed (the one behind).
    for (let ai = 0; ai < this.active.length; ai++) {
      const a = this.active[ai];
      if (a.dead) continue;
      const fx = a.body.fx;
      const fy = a.body.fy;
      for (let oi = 0; oi < this.active.length; oi++) {
        const o = this.active[oi];
        if (o === a || o.dead) continue;
        if (Math.abs(o.body.fx - fx) > o.len + 6 || Math.abs(o.body.fy - fy) > o.len + 6) continue;
        const body = o.body;
        let hit = false;
        const fz = a.body.fz;
        for (let q = 0; q < body.n && !hit; q++) hit = hypot2(body.x[q] - fx, body.y[q] - fy) < 1.6 && Math.abs(body.z[q] - fz) <= LEVEL_GAP;
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
    // (Filled in place and cut to length: an array emptied with `length = 0` loses its backing store.)
    let nb = 0;
    for (let bi = 0; bi < this.active.length; bi++) {
      const b = this.active[bi];
      if (b.dead) continue;
      bodies[nb] = b.body;
      exempt[nb] = b.exempt;
      nb++;
    }
    bodies.length = nb;
    exempt.length = nb;
    this.cars.simulate(dt, time, player, this.playerBody, bodies, exempt, this.frustum);
    this.warmSoon();
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
    const claim = Math.max(ahead, v * CLAIM_GAP);
    // Stopped at the stop line of a green: about to pull away. (A right turn across our path from
    // the other side, starting on the same green, would otherwise be on its way before we move.)
    // (The line it waits at for the light: the route's, often well before the node's own box edge.)
    const line = this.signalPlan(g.track).jLine;
    let launch = false;
    for (let k = lo; k < jl.length && jl[k].s - s < Math.max(claim, LAUNCH_R) + 10; k++) {
      const j = jl[k];
      if (j.s + j.boxR + len < s) continue;
      if (!j.sig && !j.minor && v > 1 && j.s - s < ahead) this.cars.markMajor(j.node, time, PLAYER_HOLD);
      const inBox = s > j.s - j.boxR;
      const committed = v > 1 && j.stopS - s < (v * v) / (2 * 3) + 2;
      const light = j.sig && !j.inside ? this.cars.signalFor(j.node, j.inX, j.inY, time, j.outX, j.outY) : null;
      // (Not on the way to a red light we can still stop at: the other way's green is its own.)
      const red = light === 'red' && !inBox && !committed;
      // (Not to turn right across the oncoming flow: that it waits for.)
      if (v <= 1 && light === 'green' && j.cls !== Turn.Right && Math.abs(line[k] - s) < LAUNCH_D) launch = true;
      // Right of way: in the box, our light (or the light we entered the junction on), or the main road.
      // (On an arm with no light, or from a side road, the autopilot gives way instead.)
      const prio = inBox || (j.sig ? j.inside || light !== null : !j.minor);
      // (Cars in the next lane do not turn across ours in front of us, crossing ones not across our path.)
      if (inBox || (!red && ((v > 1 && j.s - s < claim) || (launch && j.s - s < LAUNCH_R)))) {
        g.track.sample(j.stopS, this.tmp);
        const eta = inBox ? 0 : playerEta(j.s - s, v);
        this.cars.claimApproach(j.node, this.tmp.x, this.tmp.y, j.inX, j.inY, j.outX, j.outY, j.cls, eta, time + 0.5, inBox || j.s - s < ahead, prio);
      }
      if (inBox || committed) this.cars.enter(j.node, PLAYER_HOLD, j.inX, j.inY, j.outX, j.outY, j.cls, time + 0.5);
    }
  }

  private removeBus(i: number): void {
    const b = this.active[i];
    for (const q of b.holds) this.cars.leave(b.jl[q].node, -b.id);
    b.holds.length = 0;
    this.release(b);
    removeAt(this.active, i);
    this.byId.delete(b.id);
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
  private signalPlan(track: RouteTrack): { mids: TrackSignal[]; jAsk: (SignalAsk | null)[]; jLine: number[] } {
    let p = this.plans.get(track);
    if (!p) {
      const jl = this.cars.junctionsAlong(track);
      const model = signalsFor(this.data);
      const jAsk: (SignalAsk | null)[] = jl.map(() => null);
      // (A bus waits for the light where the player does, not at the node's own box edge 10-20 m on.)
      const jLine = jl.map((j) => j.stopS);
      const mids = track.signals.filter((sg, i) => {
        const q = this.signalAsk(track, sg);
        const ji = model.junctionAt(q.x, q.y, q.dx, q.dy, q.z);
        if (ji < 0) return true;
        let managed = false;
        const nextS = track.signals[i + 1]?.s ?? Infinity;
        jl.forEach((j, k) => {
          // The junction's nodes by its stop line, and (where the line is drawn well back, as at the
          // north end of Victoria Bridge) its first node further on, with no other node or light
          // between: otherwise the bus would cross the line on this light and then wait inside the
          // junction on another arm's light at that node.
          const prev = k > 0 ? jl[k - 1].s + jl[k - 1].boxR : -Infinity;
          const d = j.s - sg.s;
          const near = Math.abs(d) < 30 || (d > 0 && d < FAR_LINE && !j.inside && prev <= sg.s && nextS > j.s + 30);
          if (!j.sig || !near || this.cars.signalJunction(j.node, j.inX, j.inY) !== ji) return;
          managed = true;
          if (jAsk[k]) return;
          jAsk[k] = q;
          // (Not for a junction's second node, nor back inside the box of the junction before.)
          if (!j.inside) jLine[k] = Math.min(j.stopS, Math.max(sg.s, prev));
        });
        return !managed;
      });
      this.plans.set(track, (p = { mids, jAsk, jLine }));
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
    // The binding acceleration and why (lim), with no closure or captured variable per bus.
    this.bV0 = v0;
    this.iGap = Infinity;
    this.iVL = 0;
    this.idmTo(b, 2);
    this.sAcc = this.iA;
    this.sWhy = Wait.None;
    this.sRef = 0;

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
        if (gap < 140) {
          this.iGap = gap + 0.6;
          this.iVL = 0;
          this.idmMin(b, 0.6);
        }
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
    if (b.s > L - 120) {
      this.iGap = L - 1 - b.s;
      this.iVL = 0;
      this.idmMin(b, 0.5);
    }

    // Pull back out after a stop.
    if (time - b.departT < 6 && (!st || st.s - b.s > 45 || !b.serve)) b.pullTarget = 0;
    b.pull += Math.max(-dt * 0.45, Math.min(dt * 0.45, b.pullTarget - b.pull));

    // Junctions: same reservations as the cars (signal, box, exit room).
    const jl = b.jl;
    while (b.jNext < jl.length && jl[b.jNext].stopS < b.s - 2) b.jNext++;
    const j = jl[b.jNext];
    if (j) {
      if (!j.sig && !j.minor && j.s - b.s < Math.max(30, b.v * 4)) this.cars.markMajor(j.node, time, -1);
      const stopAt = this.lineOf(b, b.jNext) - b.s;
      const commitDist = Math.max(3, (b.v * b.v) / (2 * 2.2)) + 2;
      if (stopAt < commitDist + 35) {
        // Junctions closer together than our length are taken in one go.
        this.jStop = stopAt;
        let res = this.junctionOk(b, b.jNext, time);
        let k = b.jNext + 1;
        while (res === Wait.None && k < jl.length && jl[k].s - j.s < j.boxR + jl[k].boxR + b.len) {
          this.jStop = this.lineOf(b, k) - b.s;
          res = this.junctionOk(b, k, time);
          k++;
        }
        if (res !== Wait.None) {
          this.iGap = Math.max(0.05, stopAt);
          this.iVL = 0;
          this.idmLim(b, 0.8, res, this.jRef);
        } else if (stopAt <= commitDist) {
          this.cars.enterUntil = time + 4;
          for (let q = b.jNext; q < k; q++) {
            const jq = jl[q];
            this.cars.enterM(jq.node, -b.id, jq);
            b.holds.push(q);
          }
          b.jNext = k;
        }
      }
    }

    // Our lane coming in to the player's (out of a platform, off a ramp, from the lane beside): we
    // give way to the player's bus as at a junction, unless our tail is in well before it gets there.
    const P = this.pTrack;
    if (P) {
      if (b.joinFor !== P) {
        b.joins = this.joinsOf(tr, P);
        b.narrows = this.narrowsOf(tr, P, b.spec);
        b.joinFor = P;
        b.joinNext = 0;
        b.narrowNext = 0;
      }
      const joins = b.joins;
      while (b.joinNext < joins.length && joins[b.joinNext].a0 < b.s - 1) b.joinNext++;
      const J = joins[b.joinNext];
      const dA = J ? J.a0 - b.s : Infinity;
      // (Not once we could no longer stop short of it: then we are on our way in.)
      if (J && dA < Math.max(40, b.v * 5) && dA > (b.v * b.v) / (2 * 3.5) - 1) {
        const sp = this.pS;
        const pv = Math.abs(this.playerBody.speed);
        // (Its tail past where we are in the lane: we follow it.)
        if (sp - this.playerLen < J.p1 + 4) {
          const dP = J.p0 - sp;
          // Beside us or in the lane there now; else on its way there (from a standstill only from close by).
          let yieldTo = dP < 2;
          if (!yieldTo && dP < Math.max(60, pv * 8)) yieldTo = pv < 1 ? dP < 8 : playerEta(dP, pv) < clearTime(b.v, J.a1 - b.s + b.len, BUS_A) + MERGE_GAP;
          if (yieldTo) {
            this.iGap = Math.max(0.05, dA);
            this.iVL = 0;
            this.idmLim(b, 0.8, Wait.Player, 0);
          }
        }
      }
      // A narrow (a tight street on a bend, the player's bus cutting in towards our lane) with the player's
      // bus in it or on its way in before we would be through: we wait short of it (199/0 s 534, a 199/1
      // passing on the Hoogley St / Ganges St bend, 3 m between the lanes).
      const nrs = b.narrows;
      while (b.narrowNext < nrs.length && nrs[b.narrowNext].a0 < b.s - 1) b.narrowNext++;
      const N = nrs[b.narrowNext];
      const dN = N ? N.a0 - b.s : Infinity;
      if (N && dN < Math.max(40, b.v * 5) && dN > (b.v * b.v) / (2 * 3.5) - 1) {
        const sp = this.pS;
        const pv = Math.abs(this.playerBody.speed);
        // (Its tail not yet out at our end.)
        if (sp - this.playerLen < N.p1 + 2) {
          const dP = N.p0 - sp;
          let yieldTo = dP < 2;
          if (!yieldTo && dP < Math.max(60, pv * 8)) yieldTo = pv < 1 ? dP < 8 : playerEta(dP, pv) < clearTime(b.v, N.a1 - b.s + b.len, BUS_A) + MERGE_GAP;
          if (yieldTo) {
            this.iGap = Math.max(0.05, dN);
            this.iVL = 0;
            this.idmLim(b, 0.8, Wait.Player, 0);
          }
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
          if (!b.sigCommit) {
            this.iGap = gap;
            this.iVL = 0;
            this.idmLim(b, 1.0, Wait.Red, 0);
          }
        } else if (gap < 6) b.sigCommit = true;
      }
    }

    // Car following against other buses, the player and cars: sample our
    // path ahead once, then test every nearby body against it.
    const look = 9 + b.v * 3.2;
    const ns = Math.min(LOOK_MAX, Math.floor((look - 1.5) / 2.5) + 1);
    const ax = this.aheadX;
    const ay = this.aheadY;
    const az = this.aheadZ;
    const ahx = this.aheadHX;
    const ahy = this.aheadHY;
    tr.ql = b.pull;
    for (let k = 0; k < ns; k++) {
      tr.qs = b.s + 1.5 + k * 2.5;
      tr.sampleQ(this.tmp2);
      ax[k] = this.tmp2.x;
      ay[k] = this.tmp2.y;
      ahx[k] = this.tmp2.hx;
      ahy[k] = this.tmp2.hy;
      az[k] = tr.qz;
    }
    this.cGap = Infinity;
    this.cV = 0;
    this.cId = 0;
    this.cKind = Wait.None;
    this.cReach = look + 30;
    for (let oi = 0; oi < this.active.length; oi++) {
      const o = this.active[oi];
      if (o !== b && !o.dead) this.consider(b, ns, o.body, o.id, o);
    }
    this.consider(b, ns, this.playerBody, -2, null);
    let bestGap = this.cGap;
    let bestV = this.cV;
    let bestId = this.cId;
    let bestKind = this.cKind as Wait;
    const G = this.cars.grid;
    for (let k = 0; k < ns; k++) {
      const d = 1.5 + k * 2.5;
      if (d - 2.5 >= bestGap) break;
      // A car (0.92 m half width) touches us 2.2 m from our centreline.
      G.qx = ax[k];
      G.qy = ay[k];
      G.qz = az[k];
      const gi = G.nearestQ(2.4);
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
    if (bestGap < Infinity) {
      this.iGap = Math.max(0.05, bestGap - 0.5);
      this.iVL = bestV;
      this.idmLim(b, 2.2, bestKind, bestId);
    }
    // Touching the player's bus with our front half: stop (the player is never bulldozed).
    const tk = this.touching.get(b.id);
    const touchFront = tk !== undefined && tk < (b.body.n - 1) / 2;
    if (touchFront) this.lim(-6.5, Wait.Player);
    const why = this.sWhy as Wait;
    const wref = this.sRef as number;
    b.obstacle = why === Wait.Bus ? wref : 0;
    b.wait = why;
    b.exempt =
      why === Wait.Red ||
      why === Wait.Player ||
      (why === Wait.Bus && (this.byId.get(wref)?.exempt ?? false)) ||
      (why === Wait.Car && this.cars.isExempt(wref));

    const acc = Math.max(-6.5, Math.min(1.2, this.sAcc));
    b.a = acc;
    b.v = touchFront ? 0 : Math.max(0, b.v + acc * dt);
    // Convert lane speed to route distance (lanes are shorter on the inside of bends).
    const i = Math.max(0, Math.min(tr.n - 2, Math.floor(b.s / TRACK_STEP)));
    const segLen = hypot2(tr.x[i + 1] - tr.x[i], tr.y[i + 1] - tr.y[i]) / TRACK_STEP;
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
    tr.ql = 0;
    tr.qs = b.s + 6;
    tr.sampleQ(this.tmp);
    const h0 = this.tmp.heading;
    tr.qs = b.s + 36;
    tr.sampleQ(this.tmp);
    const turn = wrapAngle(this.tmp.heading - h0);
    b.turnSign = Math.abs(turn) > 0.6 ? Math.sign(turn) : 0;
    lights.indicatorLeft = !!pullingIn || b.turnSign < 0;
    lights.indicatorRight = (!pullingIn && pullingOut) || (b.turnSign > 0 && !pullingIn);
  }

  /**
   * Body `o` (vehicle `id`, the AI bus `other` or null for the player's) against bus b's path ahead
   * (the first `ns` points of aheadX/Y/Z/HX/HY), within cReach, keeping the nearest hit in cGap, cV,
   * cId, cKind.
   */
  private consider(b: AiBus, ns: number, o: Body, id: number, other: AiBus | null): void {
    const reach = this.cReach;
    const ax = this.aheadX;
    const ay = this.aheadY;
    const az = this.aheadZ;
    const ahx = this.aheadHX;
    const ahy = this.aheadHY;
    if (Math.abs(o.fx - b.body.fx) > reach || Math.abs(o.fy - b.body.fy) > reach) return;
    const rel = wrapAngle(o.heading - b.body.heading);
    // Two buses waiting on each other (across a junction, at a merge): one of them goes.
    if (other && other.obstacle === b.id && other.id < b.id) return;
    // Two 2.5 m wide bodies touch with their centrelines 2.5 m apart: look
    // wider than that, except at oncoming traffic in the next lane.
    const r2 = Math.abs(rel) > 2.4 ? (other ? 3.4 : ONCOMING_PLAYER_R2) : 2.8 * 2.8;
    for (let k = 0; k < ns; k++) {
      const d = 1.5 + k * 2.5;
      if (d - 2.5 > this.cGap) return;
      let found = false;
      for (let q = 0; q < o.n; q++) {
        const ex = o.x[q] - ax[k];
        const ey = o.y[q] - ay[k];
        // Only what is on our level (not the street under a viaduct).
        if (ex * ex + ey * ey < r2 && Math.abs(o.z[q] - az[k]) <= LEVEL_GAP) {
          // The gap to that point along our path (its points run bumper to bumper).
          const g = d + Math.max(-2.5, Math.min(2.5, ex * ahx[k] + ey * ahy[k]));
          if (g < this.cGap) {
            this.cGap = g;
            this.cV = Math.max(0, o.speed * Math.cos(rel));
            this.cId = id;
            this.cKind = other ? Wait.Bus : Wait.Player;
          }
          found = true;
        }
      }
      if (found) return;
    }
  }

  /**
   * IDM acceleration of bus b (desired speed bV0) towards an obstacle iGap metres ahead moving at iVL,
   * into iA. (Its inputs and result in fields: a double passed to or returned from a call that is not
   * inlined is boxed.)
   */
  private idmTo(b: AiBus, s0: number): void {
    const v = b.v;
    const v0 = this.bV0;
    const gap = this.iGap;
    const vLead = this.iVL;
    const A = BUS_A;
    const B = 1.9;
    const T = 1.35;
    const free = 1 - Math.pow(v / Math.max(0.5, v0), 4);
    if (gap === Infinity) {
      this.iA = A * free;
      return;
    }
    const sStar = s0 + Math.max(0, v * T + (v * (v - vLead)) / (2 * Math.sqrt(A * B)));
    this.iA = A * (free - (sStar / Math.max(0.05, gap)) ** 2);
  }

  /** lim() to idmTo's acceleration. */
  private idmLim(b: AiBus, s0: number, w: Wait, ref: number): void {
    this.idmTo(b, s0);
    if (this.iA < this.sAcc) {
      this.sAcc = this.iA;
      this.sWhy = w;
      this.sRef = ref;
    }
  }

  /** The acceleration held to idmTo's, its reason kept. */
  private idmMin(b: AiBus, s0: number): void {
    this.idmTo(b, s0);
    this.sAcc = Math.min(this.sAcc, this.iA);
  }

  /**
   * Bus b's stop line for junction q of its route (where it waits), unless it is already past that
   * (spawned there): the box edge. A line that would have it stand in a narrow with the player's lane
   * is moved back to the narrow's start, so that a bus that went on into one, sure to be through before
   * the player's got there, does not stop at a red light in it (61/0 s 7577, the busway tunnel's north
   * portal by the Cultural Centre: a 150/0 waiting at node 10193 stood across the player's way out of
   * the bend, too far from the player's lane to count as a lead).
   */
  private lineOf(b: AiBus, q: number): number {
    let line = b.jLine[q];
    if (b.s > line + 1) return b.jl[q].stopS;
    if (b.joinFor === this.pTrack) {
      const nrs = b.narrows;
      for (let k = b.narrowNext; k < nrs.length && nrs[k].a0 < line; k++) {
        const N = nrs[k];
        if (b.s <= N.a0 + 1 && line - b.len < N.a1) line = N.a0;
      }
    }
    return line;
  }

  /** The bus being stepped is held to acceleration `a` (why `w`, by `ref`) if that is the tightest so far. */
  private lim(a: number, w: Wait, ref = 0): void {
    if (a < this.sAcc) {
      this.sAcc = a;
      this.sWhy = w;
      this.sRef = ref;
    }
  }

  /**
   * Where lane `a` comes in to the player's lane `p` (the same way, on the same level): from at
   * least JOIN_D apart to alongside and then into it (a lane that only passes close is not one).
   * Where that is in a junction it manages, a bus waits at that junction's line, unless the
   * junction has lights (they keep the two movements apart and the player's claims hold the rest).
   */
  private joinsOf(a: RouteTrack, p: RouteTrack): Join[] {
    const hit = this.joinCache.get(a);
    if (hit && hit.p === p) return hit.joins;
    const joins: Join[] = [];
    this.joinCache.set(a, { p, joins });
    if (a === p) return joins;
    const cellsOfP = this.playerGrid(p);
    const n = a.n;
    const d = new Float32Array(n).fill(Infinity);
    const ps = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = a.x[i];
      const y = a.y[i];
      const cx = Math.floor(x / JOIN_CELL) + 8192;
      const cy = Math.floor(y / JOIN_CELL) + 8192;
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const l = cellsOfP.get(gx * 16384 + gy);
          if (!l) continue;
          for (const j of l) {
            if (a.tx[i] * p.tx[j] + a.ty[i] * p.ty[j] < JOIN_COS || Math.abs(a.z[i] - p.z[j]) > LEVEL_GAP) continue;
            const ax = p.x[j];
            const ay = p.y[j];
            const sx = p.x[j + 1] - ax;
            const sy = p.y[j + 1] - ay;
            const l2 = sx * sx + sy * sy || 1e-9;
            const t = Math.max(0, Math.min(1, ((x - ax) * sx + (y - ay) * sy) / l2));
            const e = Math.hypot(x - ax - sx * t, y - ay - sy * t);
            if (e < d[i]) {
              d[i] = e;
              ps[i] = (j + t) * TRACK_STEP;
            }
          }
        }
      }
    }
    const jl = this.cars.junctionsAlong(a);
    const line = this.signalPlan(a).jLine;
    for (let i = 1; i < n; i++) {
      if (!(d[i] < JOIN_D) || d[i - 1] < JOIN_D) continue;
      let k = i;
      while (k < n && d[k] < JOIN_D && d[k] > JOIN_IN) k++;
      if (k < n && d[k] <= JOIN_IN) {
        // Where it gets within JOIN_D, between the two samples; the bus waits a little before that,
        // where it is still JOIN_CLEAR off (its corner angled in towards the player's lane, the
        // player's bus off-tracking on a curve: M1/1 s 994 touched a 60/1 waiting at 2.8 m).
        const f = d[i - 1] < Infinity ? (d[i - 1] - JOIN_D) / Math.max(1e-6, d[i - 1] - d[i]) : 0;
        let a0 = (i - 1 + Math.min(1, f)) * TRACK_STEP;
        let q0 = i - 1;
        while (q0 > 0 && d[q0] < JOIN_CLEAR && d[q0 - 1] < Infinity && (i - q0) * TRACK_STEP < JOIN_BACK) q0--;
        if (d[q0] >= JOIN_CLEAR && d[q0 + 1] < JOIN_CLEAR) a0 = (q0 + Math.min(1, (d[q0] - JOIN_CLEAR) / Math.max(1e-6, d[q0] - d[q0 + 1]))) * TRACK_STEP;
        else if (d[q0] < JOIN_CLEAR) a0 = Math.min(a0, q0 * TRACK_STEP);
        let sig = false;
        for (let q = 0; q < jl.length; q++) {
          const j = jl[q];
          if (a0 > j.stopS - 2 && a0 < j.s + j.boxR + 3) {
            if (j.sig) sig = true;
            a0 = Math.min(a0, line[q]);
          }
        }
        if (!sig) joins.push({ a0, a1: k * TRACK_STEP, p0: ps[i], p1: ps[k] });
        // (On past the stretch in the lane.)
        i = k;
        while (i + 1 < n && d[i + 1] < JOIN_D) i++;
      } else i = k - 1;
    }
    return joins;
  }

  /**
   * Where lane `a` and the player's lane `p`, coming the other way on the same level, are too close
   * for a bus of `spec` and the player's to pass (see NARROW_W): a0 to a1 on `a` (a0 a sample short
   * of it, where the bus waits), p0 to p1 the same stretch on `p` (the player's way in and out).
   * Where a0 is in a junction, the bus waits at that junction's line. Inside the box of a junction with
   * lights the junction's rules keep the two apart (turning paths cross there); just past it they do
   * not, the two ways through having the green together (M2/1 s 7426, past the busway's lights at node
   * 10055 by the tunnel portal south of Mater Hill: the lanes 3.5 m apart on a 60 m bend, an M1/0 metro
   * coming north cleared the player's off-tracking rear section by 3 cm).
   */
  private narrowsOf(a: RouteTrack, p: RouteTrack, spec: BusSpec): Join[] {
    const hit = this.narrowCache.get(a);
    if (hit && hit.p === p) return hit.narrows;
    const narrows: Join[] = [];
    this.narrowCache.set(a, { p, narrows });
    const pSpec = this.playerSpec;
    if (a === p || !pSpec) return narrows;
    const G = this.playerGrid(p);
    const kP = offTrackK(pSpec);
    const kA = offTrackK(spec);
    const n = a.n;
    const ok = new Uint8Array(n);
    const ps = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = a.x[i];
      const y = a.y[i];
      const cx = Math.floor(x / JOIN_CELL) + 8192;
      const cy = Math.floor(y / JOIN_CELL) + 8192;
      let bd = Infinity;
      let bj = -1;
      let bt = 0;
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const l = G.get(gx * 16384 + gy);
          if (!l) continue;
          for (const j of l) {
            if (a.tx[i] * p.tx[j] + a.ty[i] * p.ty[j] > -JOIN_COS || Math.abs(a.z[i] - p.z[j]) > LEVEL_GAP) continue;
            const sx = p.x[j + 1] - p.x[j];
            const sy = p.y[j + 1] - p.y[j];
            const t = Math.max(0, Math.min(1, ((x - p.x[j]) * sx + (y - p.y[j]) * sy) / (sx * sx + sy * sy || 1e-9)));
            const e = Math.hypot(x - p.x[j] - sx * t, y - p.y[j] - sy * t);
            if (e < bd) {
              bd = e;
              bj = j;
              bt = t;
            }
          }
        }
      }
      if (bj < 0 || bd > NARROW_W + NARROW_BEND + Math.max(kP, kA) * 0.08) continue;
      // The bend there (over 16 m of the player's lane), and which of the two is on its outside.
      const j0 = Math.max(0, bj - 2);
      const j1 = Math.min(p.n - 1, bj + 2);
      const turn = p.tx[j0] * p.ty[j1] - p.ty[j0] * p.tx[j1];
      const k = Math.abs(Math.asin(Math.max(-1, Math.min(1, turn)))) / ((j1 - j0) * TRACK_STEP || 1);
      const side = p.tx[bj] * (y - p.y[bj]) - p.ty[bj] * (x - p.x[bj]);
      // (Its centre on our side: the player's bus is on the outside and cuts in towards us.)
      const kOut = Math.sign(turn) === Math.sign(side) ? kP : kA;
      const need = NARROW_W + (k > NARROW_K ? NARROW_BEND + kOut * k : 0);
      if (bd < need) {
        ok[i] = 1;
        ps[i] = (bj + bt) * TRACK_STEP;
      }
    }
    const jl = this.cars.junctionsAlong(a);
    const line = this.signalPlan(a).jLine;
    for (let i = 0; i < n; i++) {
      if (!ok[i]) continue;
      // (Gaps of a sample or two are the same stretch.)
      let k = i;
      for (let q = i + 1; q < n && q <= k + 2; q++) if (ok[q]) k = q;
      let a0 = Math.max(0, i - 1) * TRACK_STEP;
      let boxed = false;
      for (let q = 0; q < jl.length; q++) {
        const j = jl[q];
        if (a0 > j.stopS - 2 && a0 < j.s + j.boxR + 3) {
          if (j.sig && k * TRACK_STEP >= j.s - j.boxR && i * TRACK_STEP <= j.s + j.boxR) boxed = true;
          a0 = Math.min(a0, line[q]);
        }
      }
      if (!boxed) narrows.push({ a0, a1: k * TRACK_STEP, p0: ps[k], p1: ps[i] });
      i = k;
    }
    return narrows;
  }

  /** The player's lane samples by grid cell (shared by joinsOf and narrowsOf). */
  private playerGrid(p: RouteTrack): Map<number, number[]> {
    let G = this.pGrid;
    if (!G || G.p !== p) {
      const cells = new Map<number, number[]>();
      for (let i = 0; i + 1 < p.n; i++) {
        const k = (Math.floor(p.x[i] / JOIN_CELL) + 8192) * 16384 + Math.floor(p.y[i] / JOIN_CELL) + 8192;
        const l = cells.get(k);
        if (l) l.push(i);
        else cells.set(k, [i]);
      }
      G = this.pGrid = { p, cells };
    }
    return G.cells;
  }

  /** Keep reservations alive while the bus is in a box; release ones its tail has cleared. */
  private refreshHolds(b: AiBus, time: number): void {
    this.cars.enterUntil = time + 4;
    for (let k = b.holds.length - 1; k >= 0; k--) {
      const j = b.jl[b.holds[k]];
      if (b.s - b.len > j.s + j.boxR) {
        this.cars.leave(j.node, -b.id);
        removeAt(b.holds, k);
      } else this.cars.enterM(j.node, -b.id, j);
    }
  }

  /** May this bus go through junction `k` of its route (its stop line jStop ahead) now? */
  private junctionOk(b: AiBus, k: number, time: number): Wait {
    const stopAt = this.jStop;
    const j = b.jl[k];
    this.jRef = 0;
    // (A second node of the junction we just entered keeps the first node's light.)
    if (j.sig && !j.inside) {
      const a = b.jAsk[k];
      const st = a ? (this.world.signalStateAt?.(a.x, a.y, time, a.dx, a.dy, a.z) ?? null) : this.cars.signalFor(j.node, j.inX, j.inY, time, j.outX, j.outY);
      if (st === 'red') return Wait.Red;
      if (st === 'amber' && stopAt > (b.v * b.v) / (2 * 3)) return Wait.Red;
      // No light for this movement (an arm no signal faces): give way to the cars that have one.
      if (st === null && this.cars.conflictEta(j.node, j.inX, j.inY, j.outX, j.outY, j.cls, j.cls === Turn.Left ? GAP_LEFT : GAP_ACROSS) < Infinity) return Wait.Junction;
    } else if (this.cars.giveWayBusy(j.node, j.minor, time)) return Wait.Junction;
    // (Not across the player's bus where it has right of way, nor turning right across it, as the cars do.)
    // (Clear of the box: from a line drawn well back, as at the busway junctions, the node is further than a box on.)
    const clearD = Math.max(Math.max(0, stopAt) + 2 * j.boxR, j.s - b.s + j.boxR) + b.len;
    if (this.cars.playerConflict(j.node, j.inX, j.inY, j.outX, j.outY, j.cls, time, clearTime(b.v, clearD, BUS_A))) return Wait.Player;
    if (!this.cars.boxClear(j.node, -b.id, j.inX, j.inY, j.outX, j.outY, j.cls, time)) return this.cars.boxBlocker === PLAYER_HOLD ? Wait.Player : Wait.Junction;
    // Room on the far side for the whole bus to get out of the box (it never
    // stops with its tail across the junction). Waiting for a queue that is
    // itself waiting legitimately is legitimate (jRef names the blocker).
    const pb = this.playerBody;
    const G = this.cars.grid;
    const tr = b.track;
    tr.ql = 0;
    for (let q = j.s + j.boxR + 2; q <= j.s + j.boxR + b.len + 1; q += 3) {
      tr.qs = q;
      tr.sampleQ(this.tmp2);
      const x = this.tmp2.x;
      const y = this.tmp2.y;
      const z = tr.qz;
      G.qx = x;
      G.qy = y;
      G.qz = z;
      const gi = G.nearestQ(1.8);
      if (gi >= 0 && G.pv[gi] < 2) {
        this.jRef = G.pid[gi];
        return Wait.Car;
      }
      for (let oi = 0; oi < this.active.length; oi++) {
        const o = this.active[oi];
        if (o === b || o.dead || o.v > 2) continue;
        const body = o.body;
        if (Math.abs(body.fx - x) > o.len + 3 || Math.abs(body.fy - y) > o.len + 3) continue;
        for (let k = 0; k < body.n; k++) {
          if (hypot2(body.x[k] - x, body.y[k] - y) < 2.2 && Math.abs(body.z[k] - z) <= LEVEL_GAP) {
            this.jRef = o.id;
            return Wait.Bus;
          }
        }
      }
      if (Math.abs(pb.speed) < 2) {
        for (let k = 0; k < pb.n; k++) if (hypot2(pb.x[k] - x, pb.y[k] - y) < 2.2 && Math.abs(pb.z[k] - z) <= LEVEL_GAP) return Wait.Player;
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
    const tr = b.track;
    tr.ql = b.pull;
    tr.qs = rearS;
    tr.sampleQ(this.tmp);
    const zr = tr.qz;
    tr.qs = frontAxleS;
    tr.sampleQ(this.tmp2);
    const zf = tr.qz;
    const heading = Math.atan2(this.tmp2.x - this.tmp.x, this.tmp2.y - this.tmp.y);
    p.x = this.tmp.x;
    p.y = this.tmp.y;
    p.heading = heading;
    p.speed = b.v;
    const steer = Math.max(-spec.maxSteer, Math.min(spec.maxSteer, 2 * wrapAngle(this.tmp2.heading - heading)));
    p.steer += (steer - p.steer) * Math.min(1, dt * 8);
    p.wheelSpin += (b.v * dt) / 0.48;
    const wb = Math.max(1, frontAxleS - rearS);
    p.z = zr;
    p.sections[0].x = p.x;
    p.sections[0].y = p.y;
    p.sections[0].heading = heading;
    p.sections[0].z = zr;
    p.sections[0].pitch = Math.atan2(zf - zr, wb);
    // Trailing sections follow the path behind their hitches.
    let frontS = b.s;
    for (let i = 1; i < spec.sections.length; i++) {
      const prev = spec.sections[i - 1];
      const cur = spec.sections[i];
      const hitchS = frontS - prev.rearHitchFromFront;
      const curFront = hitchS + cur.hitchFromFront;
      const axleS = curFront - cur.axleFromFront;
      tr.qs = axleS;
      tr.sampleQ(this.tmp);
      const za = tr.qz;
      tr.qs = hitchS;
      tr.sampleQ(this.tmp2);
      const zh = tr.qz;
      const h = Math.atan2(this.tmp2.x - this.tmp.x, this.tmp2.y - this.tmp.y);
      const sec = p.sections[i];
      sec.x = this.tmp.x;
      sec.y = this.tmp.y;
      sec.heading = h;
      sec.z = za;
      sec.pitch = Math.atan2(zh - za, Math.max(1, hitchS - axleS));
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
          for (let bi = 0; bi < this.active.length; bi++) {
            const b = this.active[bi];
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
    for (let bi = 0; bi < this.active.length; bi++) out[bi] = this.active[bi].marker;
    out.length = this.active.length;
    return out;
  }

  /**
   * The AI buses' bodies (centreline points front first, bending with an articulated bus) and half
   * widths, for a driver looking along its lane for a bus ahead (the autopilot). Reused objects.
   */
  busBodies(): readonly { body: Body; half: number; len: number }[] {
    const out = this.busBodiesOut;
    let n = 0;
    for (let bi = 0; bi < this.active.length; bi++) {
      const b = this.active[bi];
      if (b.dead) continue;
      const r = (out[n] ??= { body: b.body, half: 0, len: 0 });
      r.body = b.body;
      r.half = b.spec.width / 2;
      r.len = b.len;
      n++;
    }
    out.length = n;
    return out;
  }
  private readonly busBodiesOut: { body: Body; half: number; len: number }[] = [];
  private simTime = 0;

  /**
   * Distance from `s` to the stop line of the next junction within `range` where the player's
   * route gives way (comes in from a side road at an unsignalised junction, or on an arm no
   * signal faces) and there is no gap: main-road traffic passing, a crossing movement in the
   * box, or a car on a conflicting movement due sooner than the bus clears it. At a light, a
   * vehicle already in the box on a movement across ours: an oncoming bus going straight on
   * went on the green the player's bus stood at the line for to turn right, and the bus pulled
   * out into it (199/0 s 1448). On the main road at a junction with no light, the same: a car
   * from the side road went while the bus stood at a stop 20 m short of it, and the bus pulled
   * away into it (199/0 s 375, node 7563). A vehicle standing in the box waiting for the player's
   * bus does not count: an oncoming 60/1 stood there for the bus turning right into Morry St, and
   * the bus for it (199/0 s 22). Infinity when there is none.
   */
  giveWayAhead(track: RouteTrack, s: number, range: number): number {
    const time = this.simTime;
    const waitsForUs = (holder: number): boolean => {
      const b = holder < 0 && holder !== PLAYER_HOLD ? this.byId.get(-holder) : undefined;
      return !!b && !b.dead && b.v < 0.5 && b.wait === Wait.Player;
    };
    for (const j of this.cars.junctionsAlong(track)) {
      if (j.stopS < s - 1) continue;
      if (j.stopS - s > range) break;
      if (j.inside) continue;
      if (j.sig ? this.cars.signalFor(j.node, j.inX, j.inY, time, j.outX, j.outY) !== null : !j.minor) {
        if (!this.cars.boxClear(j.node, PLAYER_HOLD, j.inX, j.inY, j.outX, j.outY, j.cls, time, waitsForUs)) return j.stopS - s;
        continue;
      }
      if (
        this.cars.giveWayBusy(j.node, true, time) ||
        !this.cars.boxClear(j.node, PLAYER_HOLD, j.inX, j.inY, j.outX, j.outY, j.cls, time, waitsForUs) ||
        this.cars.conflictEta(j.node, j.inX, j.inY, j.outX, j.outY, j.cls, j.cls === Turn.Left ? GAP_LEFT : GAP_ACROSS) < Infinity
      )
        return j.stopS - s;
    }
    return Infinity;
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
          next: j ? { node: j.node, stop: +(j.stopS - b.s).toFixed(1), line: +(b.jLine[b.jNext] - b.s).toFixed(1), sig: j.sig, minor: j.minor } : null,
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
