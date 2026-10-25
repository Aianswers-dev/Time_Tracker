// Autopilot: drives the player's bus along its route through the real physics
// and collider (Stanley steering on the guide lane, curve/limit/stop/signal speed
// planning, door cycles at stops) and logs whatever goes wrong on the way.
// Used by `?autopilot=1` (demo drive) and the route film/test tools.
import type { BusPose, BusSpec, DriveInput, InputAction } from '../types';
import type { RouteTrack, TrackSample } from './track';
import type { GuideState } from './guide';
import type { Traffic } from './traffic';
import type { Body } from './bodies';
import { TRACK_STEP } from './track';
import { LEVEL_GAP } from './height';
import { wrapAngle } from '../data/coords';

export type AutopilotPhase = 'drive' | 'stopping' | 'dwell' | 'closing' | 'signal' | 'queue' | 'stuck' | 'done';

export interface AutopilotProblem {
  /** Sim seconds since the start. */
  t: number;
  /** Route distance of the bus front. */
  s: number;
  x: number;
  y: number;
  z: number;
  kind: string;
  detail: string;
}

export interface AutopilotFrame {
  phase: AutopilotPhase;
  /** Lateral error of the front axle from the lane centre (m, + = left of it). */
  lateral: number;
  /** Target speed m/s. */
  target: number;
  /** Distance to whatever we are slowing for (m), or Infinity. */
  limitDist: number;
  limitWhy: string;
}

/** The world and vehicle bits the autopilot needs each frame. */
export interface AutopilotInputs {
  dt: number;
  pose: BusPose;
  guide: GuideState;
  doorsOpen: boolean;
  /** Door interlock holding the bus. */
  interlock: boolean;
  /** Kneel 0..1 (to kneel for a passenger who needs it). */
  kneel?: number;
  /** Collider result this frame (base collider details pass through). */
  hit?: { hit: boolean; impact: number; wall?: boolean; wallIndex?: number; water?: boolean };
  /** Road surface height under the rear axle as the physics sees it. */
  z?: number;
}

/** Doors open with no passenger dwell from the guide: close after this (s). */
const MIN_DWELL = 4;
/** Give up waiting for the passengers after this (s); the guide caps passenger time at ~40 s. */
const MAX_DWELL = 75;
/** A look in the mirrors once everyone is aboard, before closing the doors (s). */
const MIRRORS = 1.2;
const DECEL = 1.1;
const SIGNAL_DECEL = 1.6;
/** Stanley cross-track gain (1/s) and how far ahead the lane heading is read (s per m/s). */
const STANLEY_K = 1.4;
const PREVIEW = 0.35;

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/** One stop's dwell, for the logs. */
export interface AutopilotDwell {
  /** Route stop index. */
  stop: number;
  /** Doors open to doors closing (s). */
  secs: number;
  off: number;
  on: number;
  /** Left at the stop because the bus was full. */
  full: number;
  /** On board when the doors closed. */
  load: number;
}

export class Autopilot {
  phase: AutopilotPhase = 'drive';
  readonly problems: AutopilotProblem[] = [];
  readonly dwells: AutopilotDwell[] = [];
  readonly frame: AutopilotFrame = { phase: 'drive', lateral: 0, target: 0, limitDist: Infinity, limitWhy: '' };
  /** Time spent in each phase (s). */
  readonly phaseTime: Record<string, number> = {};
  time = 0;
  /** Times the bus was put back on the lane after getting stuck. */
  rescues = 0;
  /** Set when the bus should be teleported (stuck): rear-axle pose on the lane. */
  rescue: { x: number; y: number; heading: number; z: number } | null = null;

  private sRear = 0;
  private dwellT = 0;
  /** Time since the guide said everyone is aboard. */
  private doneT = 0;
  private stuckT = 0;
  private servedIdx = -1;
  private lastIdx = -1;
  /** Opened the doors at the departure stop. */
  private boardedStart = false;
  /** Knelt for a passenger at this stop. */
  private knelt = false;
  private holdT = 0;
  private lastZ = NaN;
  /** How far left of the lane we steer (pulling in to a kerb stop), eased like the AI buses. */
  private pull = 0;
  private queueT = 0;
  private redT = 0;
  private ignoreSignalUntil = -1;
  private ignoreTrafficUntil = -1;
  /** Only vehicles squarely on the lane count as a lead until then (after a long queue). */
  private strictLeadUntil = -1;
  /** Consecutive 40 s blocked spells without moving on. */
  private blockedN = 0;
  private levelBadT = 0;
  private lastProblem = new Map<string, number>();
  private readonly near: { body: Body; half: number; len: number }[] = [];
  private tmp: TrackSample = { x: 0, y: 0, hx: 0, hy: 1, heading: 0 };
  private readonly out: DriveInput = { throttle: 0, brake: 0, steer: 0, gear: 'D', pressed: new Set(), held: new Set() };

  constructor(
    readonly track: RouteTrack,
    readonly spec: BusSpec,
    private readonly traffic?: Traffic,
  ) {}

  /** Start at the rear-axle pose (finds our place on the lane). */
  reset(pose: BusPose): void {
    this.sRear = this.project(pose.x, pose.y, 0, this.track.length);
    this.lastZ = NaN;
    this.pull = 0;
  }

  /**
   * Put the bus back on the lane `jump` metres on, but not past the stop it's heading for, and
   * only where its whole length is clear of AI vehicles (teleporting into a queue gets the bus
   * shoved sideways, over a kerb or parapet). Nowhere clear: put it straight on the lane where it
   * is, or, if even that is taken, leave it and try again later.
   */
  private rescueTo(jump: number, stopTarget: number): boolean {
    const T = this.track;
    const rearTarget = stopTarget - this.spec.sections[0].axleFromFront - 0.5;
    const cap = rearTarget > this.sRear ? rearTarget : Infinity;
    const want = Math.max(this.sRear + 3, Math.min(this.sRear + jump, cap));
    let s = NaN;
    for (let c = want; c >= this.sRear - 0.01; c -= 2) {
      if (this.clearAt(c)) {
        s = c;
        break;
      }
    }
    if (!Number.isFinite(s)) return false;
    T.sample(s, this.tmp, this.pull);
    this.rescues++;
    this.rescue = { x: this.tmp.x, y: this.tmp.y, heading: this.tmp.heading, z: T.zAt(s) };
    this.sRear = s;
    return true;
  }

  /** Is the lane clear of AI buses and cars for the whole bus with its rear axle at s? */
  private clearAt(sRear: number): boolean {
    if (!this.traffic) return true;
    const T = this.track;
    const front = sRear + this.spec.sections[0].axleFromFront;
    let len = 0;
    for (const sec of this.spec.sections) len += sec.length;
    const R = this.spec.width / 2;
    const grid = this.traffic.cars.grid;
    const bodies = this.traffic.busBodies();
    for (let d = 0; d <= len + 1; d += 1.5) {
      const ss = front + 1 - d;
      T.sample(ss, this.tmp, this.pull);
      const pz = T.zAt(ss);
      const px = this.tmp.x;
      const py = this.tmp.y;
      if (grid.nearest(px, py, R + 1.2, undefined, pz) >= 0) return false;
      for (const b of bodies) {
        const B = b.body;
        if (Math.abs(B.fx - px) > b.len + 4 || Math.abs(B.fy - py) > b.len + 4) continue;
        for (let k = 0; k + 1 < B.n; k++) {
          if (Math.abs(B.z[k] - pz) > LEVEL_GAP && Math.abs(B.z[k + 1] - pz) > LEVEL_GAP) continue;
          const ax = B.x[k];
          const ay = B.y[k];
          const sx = B.x[k + 1] - ax;
          const sy = B.y[k + 1] - ay;
          const l2 = sx * sx + sy * sy;
          const t = l2 > 1e-6 ? clamp(((px - ax) * sx + (py - ay) * sy) / l2, 0, 1) : 0;
          const r = R + b.half + 0.3;
          if ((px - ax - sx * t) ** 2 + (py - ay - sy * t) ** 2 < r * r) return false;
        }
      }
    }
    return true;
  }

  private project(x: number, y: number, from: number, to: number): number {
    const T = this.track;
    const i0 = Math.max(0, Math.floor(from / TRACK_STEP));
    const i1 = Math.min(T.n - 1, Math.ceil(to / TRACK_STEP));
    let best = Infinity;
    let bi = i0;
    for (let i = i0; i <= i1; i++) {
      const d = (T.x[i] - x) ** 2 + (T.y[i] - y) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    // Refine on the segment either side.
    let bs = bi * TRACK_STEP;
    let bd = best;
    for (const j of [bi - 1, bi]) {
      if (j < 0 || j + 1 >= T.n) continue;
      const ax = T.x[j];
      const ay = T.y[j];
      const dx = T.x[j + 1] - ax;
      const dy = T.y[j + 1] - ay;
      const l2 = dx * dx + dy * dy || 1e-9;
      const t = clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1);
      const d = (ax + dx * t - x) ** 2 + (ay + dy * t - y) ** 2;
      if (d <= bd) {
        bd = d;
        bs = (j + t) * TRACK_STEP;
      }
    }
    return bs;
  }

  problem(kind: string, detail: string, p: { s: number; x: number; y: number; z: number }, every = 4): void {
    const last = this.lastProblem.get(kind) ?? -1e9;
    if (this.time - last < every) return;
    this.lastProblem.set(kind, this.time);
    this.problems.push({ t: +this.time.toFixed(1), s: Math.round(p.s), x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), kind, detail });
  }

  update(a: AutopilotInputs): DriveInput {
    const { dt, pose, guide: g } = a;
    const T = this.track;
    const spec = this.spec;
    const out = this.out;
    out.pressed.clear();
    this.time += dt;
    this.phaseTime[this.phase] = (this.phaseTime[this.phase] ?? 0) + dt;
    const v = pose.speed;
    const sec0 = spec.sections[0];
    const L = spec.wheelbase;
    const hx = Math.sin(pose.heading);
    const hy = Math.cos(pose.heading);
    this.sRear = this.project(pose.x, pose.y, this.sRear - 12, this.sRear + 30);
    const sFront = this.sRear + sec0.axleFromFront;
    const z = a.z ?? pose.z ?? 0;
    const at = { s: sFront, x: pose.x + hx * sec0.axleFromFront, y: pose.y + hy * sec0.axleFromFront, z };

    // --- Steering: Stanley on the front axle -------------------------------------
    // Keeping the front axle on the lane centres a long bus's swept path on the lane in a bend
    // (the rear wheels track inside, the front overhang swings out). Steering the rear axle
    // along the lane instead puts the front corner ~2 m wide on a 20 m radius, into the wall.
    const av = Math.abs(v);
    const fx = pose.x + hx * L;
    const fy = pose.y + hy * L;
    const sAxle = this.project(fx, fy, this.sRear + L - 4, this.sRear + L + 4);
    T.sample(sAxle, this.tmp, this.pull);
    // Front axle left (+) / right (−) of the lane.
    const lat = (fx - this.tmp.x) * -this.tmp.hy + (fy - this.tmp.y) * this.tmp.hx;
    this.frame.lateral = -lat;
    // The lane's heading a little ahead covers the steering rate and the yaw lag.
    T.sample(sAxle + 1 + av * PREVIEW, this.tmp, this.pull);
    const delta = wrapAngle(this.tmp.heading - pose.heading) + Math.atan2(STANLEY_K * lat, 1 + av);
    const ratio = 1 / (1 + Math.pow(Math.max(0, av - 1.5) / 6.5, 2));
    out.steer = clamp(delta / (spec.maxSteer * ratio), -1, 1);

    // --- Speed planning --------------------------------------------------------------
    // Not faster than the bend the rest of the bus is still in.
    let target = Math.min(T.vmaxAt(sFront), T.vmaxAt(sAxle), T.vmaxAt(this.sRear), (T.limitAt(sFront) / 3.6) * 0.97);
    let why = 'cruise';
    let limitDist = Infinity;
    // Curves and limits ahead (vmax already brakes for curves; limits we brake for here).
    for (let d = 10; d < 140; d += 10) {
      const lim = Math.min(T.vmaxAt(sFront + d), (T.limitAt(sFront + d) / 3.6) * 0.97);
      const vv = Math.sqrt(lim * lim + 2 * DECEL * d);
      if (vv < target) {
        target = vv;
        why = 'curve';
        limitDist = d;
      }
    }

    // Next stop.
    const ns = g.nextStopIndex;
    const stop = ns >= 0 ? T.stops.find((q) => q.index === ns) : undefined;
    if (ns !== this.lastIdx) {
      this.lastIdx = ns;
      this.holdT = 0;
    }
    let stopTarget = Infinity;
    let pullWant = 0;
    if (stop && !g.finished) {
      // Front of the bus at the far end of a platform (whole bus alongside), else just past the flag.
      stopTarget = stop.zone ? Math.max(stop.zone.s0 + 2, stop.target) : stop.s + 2;
      const d = stopTarget - sFront;
      // Pull in towards the kerb or platform edge over the last 45 m (the track says how far).
      if (d < 45 && d > -6) pullWant = stop.pull;
      const vs = Math.sqrt(2 * DECEL * Math.max(0, d - 0.3));
      if (vs < target) {
        target = vs;
        why = 'stop';
        limitDist = d;
      }
      // Overshot a little (still in the zone): stop where we are.
      if (d < 0 && g.atStop) {
        target = 0;
        why = 'stop';
      }
    }

    // Red/amber signal ahead (stop line).
    if (g.signal && g.signal.state !== 'green' && this.time > this.ignoreSignalUntil) {
      const d = g.signal.distance;
      const need = (v * v) / (2 * 3.0);
      // Amber too close to stop: go through.
      if (!(g.signal.state === 'amber' && d < need)) {
        const vs = Math.sqrt(2 * SIGNAL_DECEL * Math.max(0, d - 1.5));
        if (vs < target) {
          target = vs;
          why = 'signal';
          limitDist = d;
        }
      }
    }

    // Vehicles ahead on the lane.
    if (this.traffic && this.time > this.ignoreTrafficUntil) {
      const lead = this.leadDistance(sFront, z, Math.min(70, 12 + v * v / (2 * DECEL) + v * 2), this.time < this.strictLeadUntil);
      if (lead < Infinity) {
        const vs = Math.sqrt(2 * 1.8 * Math.max(0, lead - 4));
        if (vs < target) {
          target = vs;
          why = 'traffic';
          limitDist = lead;
        }
      }
    }

    if (this.phase === 'dwell' || this.phase === 'closing') pullWant = this.pull;
    this.pull += clamp(pullWant - this.pull, -dt * 0.45, dt * 0.45);

    // --- Stop / dwell state machine ------------------------------------------------------
    const stopped = Math.abs(v) < 0.25;
    out.gear = 'D';
    if (this.phase === 'dwell') {
      target = 0;
      this.dwellT += dt;
      const d = g.dwell;
      // Kneel for a passenger with a pram or wheelchair (driving off raises the bus again).
      if (d?.kneelFor && !this.knelt && (a.kneel ?? 0) < 0.05) {
        out.pressed.add('kneel' as InputAction);
        this.knelt = true;
      }
      // Wait for everyone to get off and on, as a driver would.
      this.doneT = d?.done ? this.doneT + dt : 0;
      const ready = d ? this.doneT > MIRRORS : this.dwellT > MIN_DWELL;
      if (ready || this.dwellT > MAX_DWELL) {
        if (!ready) this.problem('dwell-timeout', `passengers still moving after ${MAX_DWELL} s at stop #${d?.stop ?? ns} (${d ? `${d.alighting} to get off, ${d.boardTotal - d.boarding} to board` : 'no dwell'})`, at, 1);
        if (d) this.dwells.push({ stop: d.stop, secs: +this.dwellT.toFixed(1), off: d.alightTotal, on: d.boarding, full: d.full, load: g.load });
        out.pressed.add('doors' as InputAction);
        this.phase = 'closing';
      }
    } else if (this.phase === 'closing') {
      target = 0;
      if (!a.doorsOpen && !a.interlock) this.phase = 'drive';
    } else if (stopped && g.canBoard && !a.doorsOpen && !this.boardedStart) {
      // Passengers waiting at the departure stop.
      out.pressed.add('doors' as InputAction);
      this.boardedStart = true;
      this.knelt = false;
      this.phase = 'dwell';
      this.dwellT = 0;
    } else if (stopped && g.canServe && !a.doorsOpen && ns !== this.servedIdx && why === 'stop') {
      out.pressed.add('doors' as InputAction);
      this.servedIdx = ns;
      this.knelt = false;
      this.phase = 'dwell';
      this.dwellT = 0;
    } else if (stopped && why === 'stop' && !g.canServe && stop && sFront > stopTarget - 3) {
      // At our stopping point but the guide does not count us as at the stop.
      this.holdT += dt;
      if (this.holdT > 2) {
        this.problem('cannot-serve', `stopped at s=${sFront.toFixed(0)} for stop #${ns} (target ${stopTarget.toFixed(0)}, atStop=${g.atStop}, routeDist=${g.routeDistance.toFixed(1)})`, at, 30);
        // Creep on: the guide marks it missed once we are past.
        this.servedIdx = ns;
        this.lastIdx = -2;
      }
    } else if (this.phase !== 'stuck') this.phase = why === 'signal' && stopped ? 'signal' : why === 'traffic' && stopped ? 'queue' : why === 'stop' ? 'stopping' : 'drive';
    if (ns === this.servedIdx && this.phase !== 'dwell' && this.phase !== 'closing' && why === 'stop' && !g.canServe) {
      // Already handled (served or given up): don't brake for it again.
      target = Math.max(target, 3);
    }
    if (g.finished) {
      target = 0;
      this.phase = 'done';
    }

    // --- Pedals ------------------------------------------------------------------------
    const err = target - v;
    // Gravity along the road when going downhill (m/s^2), which the brakes have to hold as well.
    const downhill = Math.max(0, -g.grade) * 9.81;
    if (target < 0.05 && v < 2) {
      // Stopping or holding: firm, so it neither creeps past the stop on a hill nor rolls into the car ahead.
      out.throttle = 0;
      out.brake = v < 0.6 ? 0.65 : 0.8;
    } else if (err > 0.15) {
      out.throttle = clamp(0.25 + err * 0.35 + Math.max(0, g.grade) * 4, 0, 1);
      out.brake = 0;
    } else if (err < -0.3) {
      // Decelerate on the planned profile (DECEL) when slowing for something ahead, plus the speed
      // error and the grade; the service brake gives 4.3 * pedal^1.25 m/s^2.
      out.throttle = 0;
      const planned = Number.isFinite(limitDist) && limitDist < 150 ? Math.min(2.2, (v * v - target * target) / (2 * Math.max(1, limitDist - 1))) : 0;
      const aWant = clamp(planned + -err * 0.9 + downhill, 0, 4.3);
      out.brake = clamp(Math.pow(aWant / 4.3, 0.8), 0, 1);
    } else {
      out.throttle = clamp(0.12 + Math.max(0, g.grade) * 4, 0, 0.5);
      out.brake = 0;
    }
    this.frame.phase = this.phase;
    this.frame.target = target;
    this.frame.limitDist = limitDist;
    this.frame.limitWhy = why;

    // --- Problem detection ----------------------------------------------------------------
    // Held at a red for minutes: the light never turns green for this approach (log it, then go).
    if (why === 'signal' && av < 0.5) this.redT += dt;
    else if (why !== 'signal') this.redT = 0;
    if (this.redT > 150) {
      this.problem('red-forever', `red light ${g.signal ? Math.round(g.signal.distance) : '?'} m ahead for 150 s`, at, 1);
      this.redT = 0;
      this.ignoreSignalUntil = this.time + 15;
    }
    // Queued behind traffic for a long time: log it, then count only vehicles squarely on the lane
    // (a bus or car beside it can hold the sensor); only a queue that still hasn't moved after
    // two minutes is driven through (the traffic's own jam breaker should have cleared it).
    if (why === 'traffic' && av < 0.5) this.queueT += dt;
    else {
      this.queueT = 0;
      if (av > 3) this.blockedN = 0;
    }
    if (this.queueT > 40) {
      this.blockedN++;
      this.problem('blocked', `queued behind traffic for 40 s (lead ${limitDist.toFixed(0)} m ahead, ${this.traffic?.count ?? 0} AI buses)`, at, 1);
      this.queueT = 0;
      this.strictLeadUntil = this.time + 20;
      if (this.blockedN >= 3) this.ignoreTrafficUntil = this.time + 12;
    }
    const moving = target > 1.5 && !a.interlock && this.phase !== 'dwell' && this.phase !== 'closing';
    if (moving && av < 0.3) this.stuckT += dt;
    else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    if (this.stuckT > 8 && !g.finished) {
      this.problem('stuck', `no progress for 8 s (target ${target.toFixed(1)} m/s, why=${why}, hit=${a.hit?.hit ? (a.hit.wall ? 'wall' : 'body') : 'none'})`, at, 1);
      this.stuckT = 0;
      if (!this.rescueTo(14, stopTarget)) this.problem('no-rescue', 'stuck, but the lane ahead is full of traffic: waiting', at, 1);
    }
    if (a.hit?.hit && a.hit.impact > 0.4) {
      this.problem(a.hit.wall ? 'hit-wall' : 'hit', `impact ${a.hit.impact.toFixed(1)} m/s${a.hit.wall ? ` wall #${a.hit.wallIndex}` : ''} at ${(v * 3.6).toFixed(0)} km/h, lateral ${this.frame.lateral.toFixed(2)} m`, at, 2);
    } else if (a.hit?.hit && av > 1) this.problem('scrape', `contact${a.hit.wall ? ` wall #${a.hit.wallIndex}` : ''} at ${(v * 3.6).toFixed(0)} km/h, lateral ${this.frame.lateral.toFixed(2)} m`, at, 6);
    if (a.hit?.water) this.problem('water', 'drove into the river', at, 5);
    if (Math.abs(this.frame.lateral) > 1.6 && av > 2) this.problem('off-lane', `${this.frame.lateral.toFixed(2)} m off the lane centre at ${(v * 3.6).toFixed(0)} km/h`, at, 5);
    const tz = T.zAt(this.sRear);
    if (Math.abs(z - tz) > Math.min(1.2, LEVEL_GAP)) {
      this.problem('level', `bus at z=${z.toFixed(1)} but the lane is at ${tz.toFixed(1)} (Δ ${(z - tz).toFixed(1)} m)`, at, 5);
      this.levelBadT += dt;
    } else this.levelBadT = 0;
    // Fallen off (or jumped onto) another level: put the bus back on the lane so the run goes on.
    if (this.levelBadT > 3 && !this.rescue) {
      this.problem('wrong-level', `on the wrong level for 3 s (Δ ${(z - tz).toFixed(1)} m): put back on the lane`, at, 1);
      this.levelBadT = 0;
      if (!this.rescueTo(6, stopTarget)) this.problem('no-rescue', 'on the wrong level, but the lane ahead is full of traffic: waiting', at, 1);
    }
    if (Number.isFinite(this.lastZ) && Math.abs(z - this.lastZ) > Math.max(0.25, av * dt * 0.25)) this.problem('z-jump', `road height jumped ${(z - this.lastZ).toFixed(2)} m in one frame at ${(v * 3.6).toFixed(0)} km/h`, at, 2);
    // A rescue teleports the bus before the next frame: don't count that as a jump.
    this.lastZ = this.rescue ? NaN : z;
    if (Math.abs(pose.roll) > 0.12) this.problem('roll', `body roll ${(pose.roll * 57.3).toFixed(1)}°`, at, 5);
    return out;
  }

  /** Free distance along the lane ahead of the front to the nearest AI vehicle on it (same level), or Infinity. */
  private leadDistance(sFront: number, z: number, range: number, strict = false): number {
    const tr = this.traffic!;
    const T = this.track;
    const grid = tr.cars.grid;
    // The AI buses that could be on the stretch ahead, as their real bodies (an articulated or
    // turning bus bends; a straight segment for it sweeps across lanes it isn't in, or misses it).
    const near = this.near;
    near.length = 0;
    T.sample(sFront + range / 2, this.tmp);
    const cx = this.tmp.x;
    const cy = this.tmp.y;
    const cr = range / 2 + 4;
    for (const b of tr.busBodies()) {
      if (Math.abs(b.body.fx - cx) < cr + b.len && Math.abs(b.body.fy - cy) < cr + b.len) near.push(b);
    }
    for (let d = 2; d <= range; d += 2) {
      T.sample(sFront + d, this.tmp);
      const pz = T.zAt(sFront + d);
      if (Math.abs(pz - z) > LEVEL_GAP + Math.abs(d * 0.08)) continue;
      const px = this.tmp.x;
      const py = this.tmp.y;
      if (grid.nearest(px, py, strict ? 1.0 : 1.7, undefined, pz) >= 0) return d;
      for (const b of near) {
        const B = b.body;
        for (let k = 0; k + 1 < B.n; k++) {
          if (Math.abs(B.z[k] - pz) > LEVEL_GAP && Math.abs(B.z[k + 1] - pz) > LEVEL_GAP) continue;
          const ax = B.x[k];
          const ay = B.y[k];
          const sx = B.x[k + 1] - ax;
          const sy = B.y[k + 1] - ay;
          const l2 = sx * sx + sy * sy;
          const t = l2 > 1e-6 ? clamp(((px - ax) * sx + (py - ay) * sy) / l2, 0, 1) : 0;
          const ex = px - ax - sx * t;
          const ey = py - ay - sy * t;
          // A bus along our lane (ahead or oncoming) counts within ~1.8 m of the lane centre; one
          // across it only when its body really covers the lane centre (not a car-length off).
          const along = Math.abs(sx * this.tmp.hx + sy * this.tmp.hy) > 0.7 * Math.sqrt(l2);
          const reach = along && !strict ? b.half + 0.55 : b.half - 0.2;
          if (ex * ex + ey * ey < reach * reach) return d;
        }
      }
    }
    return Infinity;
  }


  /** Summary for logs. */
  report(): { time: number; rescues: number; phaseTime: Record<string, number>; problems: AutopilotProblem[]; dwells: AutopilotDwell[] } {
    return { time: +this.time.toFixed(1), rescues: this.rescues, phaseTime: Object.fromEntries(Object.entries(this.phaseTime).map(([k, v]) => [k, +v.toFixed(1)])), problems: this.problems, dwells: this.dwells };
  }
}
