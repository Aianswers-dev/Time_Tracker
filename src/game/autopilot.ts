// Autopilot: drives the player's bus along its route through the real physics
// and collider (pure pursuit on the guide lane, curve/limit/stop/signal speed
// planning, door cycles at stops) and logs whatever goes wrong on the way.
// Used by `?autopilot=1` (demo drive) and the route film/test tools.
import type { BusPose, BusSpec, DriveInput, InputAction } from '../types';
import type { RouteTrack, TrackSample } from './track';
import type { GuideState } from './guide';
import type { Traffic } from './traffic';
import { TRACK_STEP } from './track';
import { LEVEL_GAP } from './height';

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
  /** Collider result this frame (base collider details pass through). */
  hit?: { hit: boolean; impact: number; wall?: boolean; wallIndex?: number; water?: boolean };
  /** Road surface height under the rear axle as the physics sees it. */
  z?: number;
}

const DWELL = 4;
const DECEL = 1.1;
const SIGNAL_DECEL = 1.6;

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export class Autopilot {
  phase: AutopilotPhase = 'drive';
  readonly problems: AutopilotProblem[] = [];
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
  private stuckT = 0;
  private servedIdx = -1;
  private lastIdx = -1;
  private holdT = 0;
  private lastZ = NaN;
  private queueT = 0;
  private ignoreTrafficUntil = -1;
  private levelBadT = 0;
  private lastProblem = new Map<string, number>();
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

    // --- Steering: pure pursuit from the rear axle --------------------------------
    const Ld = clamp(7 + Math.abs(v) * 0.9, 8, 26);
    T.sample(this.sRear + Ld, this.tmp);
    const tx = this.tmp.x - pose.x;
    const ty = this.tmp.y - pose.y;
    // Target in the bus frame: forward = h, right = (hy, -hx).
    const fwd = tx * hx + ty * hy;
    const right = tx * hy - ty * hx;
    const d2 = fwd * fwd + right * right;
    const delta = Math.atan((2 * L * right) / Math.max(1, d2));
    const av = Math.abs(v);
    const ratio = 1 / (1 + Math.pow(Math.max(0, av - 1.5) / 6.5, 2));
    out.steer = clamp(delta / (spec.maxSteer * ratio), -1, 1);
    // Lateral error at the front axle.
    T.sample(sFront - spec.frontOverhang, this.tmp);
    const fx = pose.x + hx * L;
    const fy = pose.y + hy * L;
    const lat = (fx - this.tmp.x) * -this.tmp.hy + (fy - this.tmp.y) * this.tmp.hx;
    this.frame.lateral = -lat;

    // --- Speed planning --------------------------------------------------------------
    let target = Math.min(T.vmaxAt(sFront), (T.limitAt(sFront) / 3.6) * 0.97);
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
    if (stop && !g.finished) {
      // Front of the bus at the far end of a platform (whole bus alongside), else just past the flag.
      stopTarget = stop.zone ? Math.max(stop.zone.s0 + 2, stop.zone.s1 - 1.5) : stop.s + 2;
      const d = stopTarget - sFront;
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
    if (g.signal && g.signal.state !== 'green') {
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
      const lead = this.leadDistance(sFront, z, Math.min(70, 12 + v * v / (2 * DECEL) + v * 2));
      if (lead < Infinity) {
        const vs = Math.sqrt(2 * 1.8 * Math.max(0, lead - 4));
        if (vs < target) {
          target = vs;
          why = 'traffic';
          limitDist = lead;
        }
      }
    }

    // --- Stop / dwell state machine ------------------------------------------------------
    const stopped = Math.abs(v) < 0.25;
    out.gear = 'D';
    if (this.phase === 'dwell') {
      target = 0;
      this.dwellT += dt;
      if (this.dwellT > DWELL) {
        out.pressed.add('doors' as InputAction);
        this.phase = 'closing';
      }
    } else if (this.phase === 'closing') {
      target = 0;
      if (!a.doorsOpen && !a.interlock) this.phase = 'drive';
    } else if (stopped && g.canServe && !a.doorsOpen && ns !== this.servedIdx && why === 'stop') {
      out.pressed.add('doors' as InputAction);
      this.servedIdx = ns;
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
    // Queued behind traffic for a long time: something is wedged (log it, then drive through).
    if (why === 'traffic' && av < 0.5) this.queueT += dt;
    else this.queueT = 0;
    if (this.queueT > 40) {
      this.problem('blocked', `queued behind traffic for 40 s (lead ${limitDist.toFixed(0)} m ahead, ${this.traffic?.count ?? 0} AI buses)`, at, 1);
      this.queueT = 0;
      this.ignoreTrafficUntil = this.time + 12;
    }
    const moving = target > 1.5 && !a.interlock && this.phase !== 'dwell' && this.phase !== 'closing';
    if (moving && av < 0.3) this.stuckT += dt;
    else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    if (this.stuckT > 8 && !g.finished) {
      this.problem('stuck', `no progress for 8 s (target ${target.toFixed(1)} m/s, why=${why}, hit=${a.hit?.hit ? (a.hit.wall ? 'wall' : 'body') : 'none'})`, at, 1);
      this.stuckT = 0;
      this.rescues++;
      const s = this.sRear + 14;
      T.sample(s, this.tmp);
      this.rescue = { x: this.tmp.x, y: this.tmp.y, heading: this.tmp.heading, z: T.zAt(s) };
      this.sRear = s;
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
      this.rescues++;
      const s = this.sRear + 6;
      T.sample(s, this.tmp);
      this.rescue = { x: this.tmp.x, y: this.tmp.y, heading: this.tmp.heading, z: T.zAt(s) };
      this.sRear = s;
    }
    if (Number.isFinite(this.lastZ) && Math.abs(z - this.lastZ) > Math.max(0.25, av * dt * 0.25)) this.problem('z-jump', `road height jumped ${(z - this.lastZ).toFixed(2)} m in one frame at ${(v * 3.6).toFixed(0)} km/h`, at, 2);
    this.lastZ = z;
    if (Math.abs(pose.roll) > 0.12) this.problem('roll', `body roll ${(pose.roll * 57.3).toFixed(1)}°`, at, 5);
    return out;
  }

  /** Free distance along the lane ahead of the front to the nearest AI vehicle on it (same level), or Infinity. */
  private leadDistance(sFront: number, z: number, range: number): number {
    const tr = this.traffic!;
    const T = this.track;
    const grid = tr.cars.grid;
    const markers = tr.markers();
    for (let d = 2; d <= range; d += 2) {
      T.sample(sFront + d, this.tmp);
      const pz = T.zAt(sFront + d);
      if (Math.abs(pz - z) > LEVEL_GAP + Math.abs(d * 0.08)) continue;
      if (grid.nearest(this.tmp.x, this.tmp.y, 1.7, undefined, pz) >= 0) return d;
      for (const m of markers) {
        const dx = this.tmp.x - m.x;
        const dy = this.tmp.y - m.y;
        if (Math.abs(dx) > m.length + 2 || Math.abs(dy) > m.length + 2) continue;
        // Distance from the lane point to the AI bus centreline segment.
        const mx = Math.sin(m.heading);
        const my = Math.cos(m.heading);
        const along = clamp(dx * mx + dy * my, -m.length / 2, m.length / 2);
        const ex = dx - mx * along;
        const ey = dy - my * along;
        if (ex * ex + ey * ey < 1.8 * 1.8) return d;
      }
    }
    return Infinity;
  }

  /** Summary for logs. */
  report(): { time: number; rescues: number; phaseTime: Record<string, number>; problems: AutopilotProblem[] } {
    return { time: +this.time.toFixed(1), rescues: this.rescues, phaseTime: Object.fromEntries(Object.entries(this.phaseTime).map(([k, v]) => [k, +v.toFixed(1)])), problems: this.problems };
  }
}
