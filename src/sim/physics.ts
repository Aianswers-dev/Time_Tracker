/**
 * Heavy-bus vehicle model.
 *
 * Longitudinal: powertrain force (comfort-limited like a real city-bus TCU),
 * air brakes with pressure lag and a progressive pedal, a blended retarder
 * (or regen), rolling resistance and aero drag.
 *
 * Lateral: kinematic bicycle about the rear axle at low speed (the bus pivots
 * on its rear wheels and the front overhang swings out), blending smoothly
 * into a steady-state understeer model with a yaw lag and a tyre-grip limit
 * at speed. Steering ratio is speed sensitive.
 *
 * Articulated sections are towed through their hitch: each trailer's rear
 * axle follows a no-slip tractrix, so trailers off-track into corners and can
 * jackknife when reversing. Joints are limited to +-50 degrees.
 *
 * Vertical: the front section samples the road surface under its rear and
 * front axles at the level it is already on, so the bus stays in a tunnel
 * under the street or up on a viaduct over it. A trailer's front rests on the
 * hitch of the section ahead, and its axle looks for the road at the level
 * that hitch is on, so the whole bus is always on one level (also right after
 * a reset). Heights follow the surface with a feed-forward spring (no jitter
 * at segment joins); steps of up to ~1.2 m are followed without an impact.
 * The bus changes level only where roads connect (ramps): the front section
 * stops at an edge with nothing at its level beyond (a deck side, a drop off
 * an embankment), like at a rock face, and a trailer whose wheels are over a
 * drop keeps the level. The grade pulls the bus back uphill and pushes it
 * downhill (m g sin(theta)); the brakes and park brake hold it.
 *
 * Integration runs in fixed-size substeps of at most 1/120 s so behaviour does
 * not depend on the frame rate.
 */
import type { BusPose, BusSpec, Collider, DriveInput } from '../types';
import { headingDir, wrapAngle } from '../data/coords';
import type { BusControls } from './controls';
import { DieselPowertrain, ElectricPowertrain, type Powertrain } from './powertrain';
import { emitSim, isSimInput, player, telemetry } from './hub';
import { isSimCollider, type SimCollider } from './collider';
import type { Surface } from '../data/height';

const G = 9.81;
const RHO = 1.2;
const SUBSTEP = 1 / 120;
const JOINT_LIMIT = (50 * Math.PI) / 180;
const WHEEL_RADIUS = 0.48;
/**
 * Off every road at the bus's level, ground further below than this is a drop (a viaduct's side, the top
 * of an embankment or a retaining wall), not a surface to drive down onto.
 */
const EDGE_DROP = 1.2;
/** How far past a bridge deck's carriageway edge an axle can be before it is off the deck (deck edge + a little). */
const DECK_EDGE = 0.6;
/** Steepest grade between a trailer's hitch and its axle (rise over run). */
const TRAILER_GRADE = 0.2;
/** Fastest the wheels follow a step down in the road (m/s, plus the surface's own rate). */
const STEP_DOWN_RATE = 3;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (cur: number, target: number, h: number, tau: number) => cur + (target - cur) * (1 - Math.exp(-h / Math.max(1e-4, tau)));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

interface Tuning {
  /** Comfort/traction limit on tractive acceleration, m/s^2. */
  aDrive: number;
  /** Service brake at full pedal, m/s^2. */
  aBrake: number;
  /** Retarder / regen capacity at speed, m/s^2. */
  aRetarder: number;
  /** Retarder / regen when the throttle is released, m/s^2. */
  aCoast: number;
  vMax: number;
  vReverse: number;
  /** Lateral grip limit, m/s^2. */
  aLat: number;
  /** Understeer gradient, rad per m/s^2. */
  understeer: number;
  cdA: number;
  crr: number;
}

function tuningFor(spec: BusSpec): Tuning {
  const metro = spec.type === 'metro';
  return {
    aDrive: metro ? 1.25 : spec.type === 'glider' ? 1.32 : 1.3,
    aBrake: 4.3,
    aRetarder: metro ? 1.6 : 1.4,
    aCoast: metro ? 0.4 : 0.32,
    vMax: (metro ? 70 : 80) / 3.6,
    vReverse: 11 / 3.6,
    aLat: metro ? 4.2 : 4.8,
    understeer: metro ? 0.011 : 0.0065,
    cdA: 0.62 * spec.width * spec.height,
    crr: 0.0085,
  };
}

export interface PhysicsResult {
  impact: number;
  hit: boolean;
  /** True on the frame the bus drove into the river (it is recovered to the nearest road automatically). */
  water: boolean;
}

export class BusPhysics {
  pose: BusPose;
  rpm = 650;
  /** 1..6 in D (diesel), 1 for electric, 0 neutral, -1 reverse. */
  gearIndex = 1;
  /** 'D1'..'D6', 'D', 'N', 'R' for the HUD. */
  gearLabel = 'D1';
  /** Filtered longitudinal / lateral acceleration (m/s^2, + = forward / right). */
  accelLong = 0;
  accelLat = 0;
  yawRate = 0;
  /** 0..1 brake chamber pressure. */
  brakePressure = 0;
  /** 0..1 engine load. */
  load = 0;
  /** 0..1 understeer beyond the grip limit (tyre squeal). */
  slip = 0;
  /** Articulation angle per joint (radians, + = trailer swung to the left of the leading section's line). */
  joints: number[];
  /** Recover to the nearest road automatically after a splash. */
  autoRecover = true;
  /** Grade of section 0 (radians, + = nose up). */
  grade = 0;
  /** Road under section 0's rear axle (index into MapData.roads, -1 = off road). */
  roadIndex = -1;
  /** On a tunnel road. */
  inTunnel = false;
  /** All wheels of section 0 are off the ground (ran off an edge). */
  airborne = false;
  readonly tuning: Tuning;
  readonly powertrain: Powertrain;

  private yaw = 0;
  private steerAngle = 0;
  private rollS = 0;
  private pitchS = 0;
  private rollV = 0;
  private pitchV = 0;
  private rollBase = 0;
  private pitchBase = 0;
  private bump = 0;
  private bumpV = 0;
  private aLongRaw = 0;
  private collider: Collider | null = null;
  private sinkT = 0;
  private jackknifeWarned = false;
  private time = 0;
  private impactCooldown = 0;
  private rand = 12345;
  // Vertical state per section: rear axle and front axle / hitch heights, their rates, last targets.
  private zR: Float64Array;
  private zF: Float64Array;
  private vzR: Float64Array;
  private vzF: Float64Array;
  private tR: Float64Array;
  private tF: Float64Array;
  private airR: Uint8Array;
  private airF: Uint8Array;
  /** Section 0's front / rear axle is over a drop with nothing at its level (only after a reset onto an edge). */
  private hangF = false;
  private hangR = false;
  private settleZ = true;
  /** False when placed without a height before the map was known: settle on the road nearest the ground. */
  private zKnown = false;
  private gradeSin = 0;
  /** Largest vertical impact this frame (landing after a fall, or running into a step / rock face). */
  private landing = 0;
  private save = { x: 0, y: 0, heading: 0, secs: [] as { x: number; y: number; heading: number }[] };
  private waterRecover = false;
  /** Hill-start assist: seconds of brake hold left after the pedal is released at a stop. */
  private hillHold = 0;

  constructor(readonly spec: BusSpec) {
    this.tuning = tuningFor(spec);
    this.powertrain =
      spec.type === 'metro' ? new ElectricPowertrain(spec.mass * 1.45, 360_000) : new DieselPowertrain();
    this.powertrain.onShift = (from, to) => emitSim(this, { type: 'shift', from, to });
    this.joints = spec.sections.slice(1).map(() => 0);
    const n = spec.sections.length;
    this.zR = new Float64Array(n);
    this.zF = new Float64Array(n);
    this.vzR = new Float64Array(n);
    this.vzF = new Float64Array(n);
    this.tR = new Float64Array(n);
    this.tF = new Float64Array(n);
    this.airR = new Uint8Array(n);
    this.airF = new Uint8Array(n);
    this.pose = {
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
      speed: 0,
      steer: 0,
      wheelSpin: 0,
      sections: spec.sections.map(() => ({ x: 0, y: 0, heading: 0, z: 0, pitch: 0 })),
      roll: 0,
      pitch: 0,
    };
  }

  /**
   * Place the bus with its section-0 rear axle at (x, y), on the road level
   * nearest to `z` (m AHD; pass the route height at the start so a bus that
   * starts in a tunnel stays in it). Calling it with the bus's own current
   * pose (what the Backspace handler in main.ts does) instead puts the bus
   * back onto the nearest road at its current level, aligned with it.
   */
  reset(x: number, y: number, heading: number, z?: number): void {
    const p = this.pose;
    const inPlace = x === p.x && y === p.y && heading === p.heading;
    this.place(x, y, heading, inPlace ? (p.z ?? 0) : z);
    if (inPlace) this.recover();
  }

  /** Snap onto the nearest road (left lane of a two-way road), facing along it. Returns false if no road is near. */
  recover(): boolean {
    const c = this.collider;
    if (!c || !isSimCollider(c)) return false;
    const p = this.pose;
    const wb = this.spec.wheelbase;
    const [fx, fy] = headingDir(p.heading);
    // Snap the driver's end, not the rear axle.
    const ax = p.x + fx * wb;
    const ay = p.y + fy * wb;
    // After a splash, look for a road at street level; otherwise stay on the current level.
    const level = this.waterRecover ? undefined : this.zF[0];
    this.waterRecover = false;
    const snap = c.nearestRoad(ax, ay, p.heading, 250, level);
    if (!snap) return false;
    const [nx, ny] = headingDir(snap.heading);
    // Left of travel = (-ny, nx) rotated: right vector is (ny, -nx).
    const lx = -ny;
    const ly = nx;
    const half = snap.width / 2;
    const lateral = snap.oneway ? Math.max(0, half - 1.9) * 0.5 : clamp(snap.width / 4, 0, Math.max(0, half - 1.5));
    const fxp = snap.x + lx * lateral;
    const fyp = snap.y + ly * lateral;
    this.place(fxp - nx * wb, fyp - ny * wb, snap.heading, snap.z);
    this.laySections(c, snap.z, lateral);
    void this.updateVertical(0, 0);
    for (let i = 0; i < 4; i++) {
      const r = c.resolve(this.pose, this.spec);
      if (!r.hit) break;
    }
    this.pose.speed = 0;
    emitSim(this, { type: 'reset' });
    return true;
  }

  private place(x: number, y: number, heading: number, z?: number): void {
    const p = this.pose;
    p.x = x;
    p.y = y;
    p.heading = heading;
    // Without a height, use the road nearest the ground (or 0 before the map is known).
    const c = this.simCollider;
    const zz = z ?? (c ? c.surface(x, y).z : (p.z ?? 0));
    this.zKnown = z !== undefined || c !== null;
    p.z = zz;
    this.zR.fill(zz);
    this.zF.fill(zz);
    this.tR.fill(zz);
    this.tF.fill(zz);
    this.vzR.fill(0);
    this.vzF.fill(0);
    this.airR.fill(0);
    this.airF.fill(0);
    this.hangF = this.hangR = false;
    this.settleZ = true;
    this.grade = 0;
    this.gradeSin = 0;
    this.airborne = false;
    p.speed = 0;
    p.steer = 0;
    p.roll = 0;
    p.pitch = 0;
    this.yaw = 0;
    this.steerAngle = 0;
    this.rollS = 0;
    this.pitchS = 0;
    this.rollV = 0;
    this.pitchV = 0;
    this.bump = 0;
    this.bumpV = 0;
    this.rollBase = 0;
    this.pitchBase = 0;
    this.accelLong = 0;
    this.accelLat = 0;
    this.aLongRaw = 0;
    this.brakePressure = 0;
    this.sinkT = 0;
    this.powertrain.reset();
    this.straightenSections();
  }

  update(dt: number, input: DriveInput, controls: BusControls, collider?: Collider): PhysicsResult {
    if (isSimInput(input)) player.physics = this;
    if (collider) this.collider = collider;
    dt = Math.min(dt, 0.1);
    if (!(dt > 1e-6)) {
      this.writeTelemetry();
      return { impact: 0, hit: false, water: false };
    }
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);
    const n = Math.max(1, Math.ceil(dt / SUBSTEP - 1e-6));
    const h = dt / n;
    this.landing = 0;
    for (let i = 0; i < n; i++) this.step(h, input, controls);

    const out: PhysicsResult = { impact: 0, hit: false, water: false };
    if (this.landing > 2.5) {
      out.impact = this.landing;
      emitSim(this, { type: 'impact', strength: this.landing });
    }
    if (this.sinkT > 0) {
      this.sinkT -= dt;
      if (this.sinkT <= 0 && !this.recover()) this.sinkT = 0;
    } else if (collider) {
      if (isSimCollider(collider)) collider.setStepTime(dt);
      const r = collider.resolve(this.pose, this.spec);
      out.hit = r.hit;
      out.impact = Math.max(out.impact, r.impact);
      if (r.hit) {
        // Take a little of the yaw rate out; the contact itself turns the bus parallel to the wall.
        this.yaw *= 0.9;
        if (r.impact > 0.25 && this.impactCooldown <= 0) {
          emitSim(this, r.impact > 1 ? { type: 'impact', strength: r.impact } : { type: 'scrape', strength: r.impact });
          this.impactCooldown = r.impact > 1 ? 0.25 : 0.08;
        } else if (Math.abs(this.pose.speed) > 0.3) emitSim(this, { type: 'scrape', strength: 0.3 });
      }
      if ((r as { water?: boolean }).water) {
        out.water = true;
        emitSim(this, { type: 'splash' });
        if (this.autoRecover) {
          this.sinkT = 1.4;
          this.waterRecover = true;
        }
        this.pose.speed = 0;
      }
    }
    this.writeTelemetry();
    return out;
  }

  private step(h: number, input: DriveInput, c: BusControls): void {
    const spec = this.spec;
    const T = this.tuning;
    const p = this.pose;
    const m = spec.mass;
    this.time += h;
    const v = p.speed;
    const sinking = this.sinkT > 0;
    const emergency = isSimInput(input) && input.emergency;

    // --- Driver demands, interlocks ---------------------------------------------
    let throttle = sinking ? 0 : clamp(input.throttle, 0, 1);
    let brake = sinking ? 1 : clamp(input.brake, 0, 1);
    if (emergency) brake = 1;
    const interlock = c.interlock;
    if (interlock) throttle = 0;
    let selector = input.gear;
    // Transmission protection: no direction change while rolling.
    if (selector === 'R' && v > 0.8) selector = 'N';
    if (selector === 'D' && v < -0.8) selector = 'N';
    // Speed governors.
    if (selector === 'D') throttle *= clamp((T.vMax - v) / 0.9, 0, 1);
    if (selector === 'R') throttle *= clamp((T.vReverse + v) / 0.6, 0, 1);
    // Kneeling: walking pace only until the suspension is back up.
    const kneelCap = c.kneel > 0.05;
    if (kneelCap && Math.abs(v) > 1.4) throttle = 0;
    // Articulation protection when reversing a bendy bus.
    let jackknife = false;
    if (v < -0.1) for (const j of this.joints) if (Math.abs(j) > JOINT_LIMIT - 0.12) jackknife = true;
    if (jackknife) {
      brake = Math.max(brake, 0.8);
      throttle = 0;
      if (!this.jackknifeWarned) emitSim(this, { type: 'jackknife' });
      this.jackknifeWarned = true;
    } else if (v >= 0) this.jackknifeWarned = false;

    // --- Steering ------------------------------------------------------------------
    const av = Math.abs(v);
    const ratio = 1 / (1 + Math.pow(Math.max(0, av - 1.5) / 6.5, 2));
    const target = clamp(input.steer, -1, 1) * spec.maxSteer * ratio;
    const rate = 1.0 * h;
    this.steerAngle += clamp(target - this.steerAngle, -rate, rate);
    p.steer = this.steerAngle;

    // --- Powertrain ----------------------------------------------------------------
    let drive = this.powertrain.step(h, throttle, selector, v);
    // Comfort limit on acceleration, so on a hill the TCU lets through what the grade takes.
    const gAlong = -G * this.gradeSin; // gravity along the heading, m/s^2
    const cap = m * (T.aDrive + Math.max(0, -Math.sign(drive) * gAlong));
    drive = clamp(drive, -cap, cap);
    if (this.airborne) drive = 0;

    // --- Brakes and resistances ---------------------------------------------------
    const bpTau = emergency ? 0.08 : brake > this.brakePressure ? 0.24 : 0.14;
    this.brakePressure = smooth(this.brakePressure, brake, h, bpTau);
    const pedal = T.aBrake * Math.pow(this.brakePressure, 1.25);
    const fade = smoothstep(1.2, 6, av);
    const coast = throttle < 0.03 && selector !== 'N' ? T.aCoast * fade : 0;
    const retDecel = Math.min(T.aRetarder * fade, Math.max(coast, pedal));
    let service = Math.max(0, pedal - retDecel);
    if (interlock) service = Math.max(service, 2.5);
    if (c.parkBrake) service = Math.max(service, 3.4);
    // Hill-start assist: stopped on a grade with the brake applied, the brakes hold for up to 2.5 s after
    // the pedal comes up, until the drive pulls harder than the slope.
    const dirSign = selector === 'D' ? 1 : selector === 'R' ? -1 : 0;
    const rollback = dirSign * gAlong < 0; // gravity pulls against the selected direction
    const slopeAcc = rollback ? Math.abs(gAlong) : 0;
    if (av < 0.05 && this.brakePressure > 0.25 && slopeAcc > 0.15) this.hillHold = 2.5;
    else if (av > 0.3) this.hillHold = 0;
    if (this.hillHold > 0) {
      this.hillHold -= h;
      if (Math.abs(drive) / m < slopeAcc) service = Math.max(service, slopeAcc + 0.2);
      else this.hillHold = 0;
    }
    if (kneelCap && av > 1.4) service = Math.max(service, 1.0);
    const engineDrag = throttle < 0.03 ? this.powertrain.dragForce(v) : 0;
    const grip = this.airborne ? 0 : 1;
    const resist = grip * (m * (retDecel + service) + engineDrag + T.crr * m * G) + 0.5 * RHO * T.cdA * v * v;
    let vNew = v + (drive / m + gAlong) * h;
    const dvRes = (resist / m) * h;
    if (Math.abs(vNew) <= dvRes) vNew = 0;
    else vNew -= Math.sign(vNew) * dvRes;
    if (sinking) vNew *= Math.exp(-6 * h);
    this.aLongRaw = (vNew - v) / h;
    this.accelLong = smooth(this.accelLong, this.aLongRaw, h, 0.12);
    this.load = this.powertrain.load;
    this.retarderLevel = T.aRetarder > 0 ? retDecel / T.aRetarder : 0;

    // --- Yaw: kinematic at low speed, understeer + grip limit at speed --------------
    const L = spec.wheelbase;
    const tanD = Math.tan(this.steerAngle);
    const rSS = (vNew * tanD) / (L + T.understeer * vNew * vNew);
    const aSS = vNew * rSS;
    const aEff = T.aLat * Math.tanh(aSS / T.aLat);
    const rTarget = Math.abs(aSS) > 1e-6 ? rSS * (aEff / aSS) : rSS;
    this.slip = Math.max(0, Math.abs(aSS) - Math.abs(aEff)) / T.aLat;
    const yawTau = 0.035 + 0.012 * Math.abs(vNew);
    this.yaw = smooth(this.yaw, rTarget, h, yawTau);
    // Remember where we were, in case the move runs into a rock face (see updateVertical).
    const sv = this.save;
    sv.x = p.x;
    sv.y = p.y;
    sv.heading = p.heading;
    for (let i = 0; i < p.sections.length; i++) {
      const sp = p.sections[i];
      const d = (sv.secs[i] ??= { x: 0, y: 0, heading: 0 });
      d.x = sp.x;
      d.y = sp.y;
      d.heading = sp.heading;
    }
    const midHeading = p.heading + this.yaw * h * 0.5;
    p.heading = wrapAngle(p.heading + this.yaw * h);
    p.x += Math.sin(midHeading) * vNew * h;
    p.y += Math.cos(midHeading) * vNew * h;
    p.speed = vNew;
    p.wheelSpin = (p.wheelSpin + (vNew / WHEEL_RADIUS) * h) % (Math.PI * 2000);
    this.yawRate = this.yaw;
    this.accelLat = smooth(this.accelLat, vNew * this.yaw, h, 0.1);

    this.towSections();
    if (this.updateVertical(h, vNew)) {
      // The ground ahead rises like a wall (tunnel rock, a hillside cutting, a kerb far too high): stop.
      p.x = sv.x;
      p.y = sv.y;
      p.heading = sv.heading;
      for (let i = 0; i < p.sections.length; i++) {
        const sp = p.sections[i];
        const d = sv.secs[i];
        sp.x = d.x;
        sp.y = d.y;
        sp.heading = d.heading;
      }
      this.landing = Math.max(this.landing, Math.abs(vNew));
      p.speed = -0.1 * vNew;
      this.yaw = 0;
    }
    this.updateSway(h, c, av, sinking);
  }

  /**
   * Follow the road surface under each section's rear axle and front axle
   * (hitch for trailers), at the level each is already on. h = 0 settles
   * instantly (after a reset).
   */
  private updateVertical(h: number, v: number): boolean {
    const c = this.simCollider;
    const p = this.pose;
    const spec = this.spec;
    const secs = p.sections;
    const settle = this.settleZ || h <= 0;
    const sinking = this.sinkT > 0;
    // The front section's axles must stay on something at their level: off the road a sudden rise is a
    // face the bus can't climb, and a drop is an edge it can't drive off (levels change on ramps only).
    if (c && !settle && !sinking) {
      const s0 = secs[0];
      const fx = s0.x + Math.sin(s0.heading) * spec.wheelbase;
      const fy = s0.y + Math.cos(s0.heading) * spec.wheelbase;
      if (this.blocked(c, fx, fy, this.zF[0], s0.heading, this.hangF)) return true;
      if (this.blocked(c, s0.x, s0.y, this.zR[0], s0.heading, this.hangR)) return true;
    }
    let wSum = 0;
    let gSum = 0;
    for (let i = 0; i < secs.length; i++) {
      const sp = secs[i];
      const ss = spec.sections[i];
      const dF = i === 0 ? spec.wheelbase : Math.max(0.5, ss.axleFromFront - ss.hitchFromFront);
      const fx = sp.x + Math.sin(sp.heading) * dF;
      const fy = sp.y + Math.cos(sp.heading) * dF;
      if (sinking) {
        // Going under: settle below the water surface, nose first.
        const floor = (c?.waterLevel ?? 0) - 2.8;
        this.zR[i] = Math.max(floor, this.zR[i] - 0.9 * h);
        this.zF[i] = Math.max(floor - 0.8, this.zF[i] - 1.4 * h);
      } else if (c && i === 0) {
        // Front section: both axles at the level they are on (placed without a height: the road nearest
        // the ground under the rear axle, and the front axle on that level).
        const unknown = settle && !this.zKnown;
        const sR = c.surface(sp.x, sp.y, unknown ? undefined : this.zR[0], 2.2, sp.heading);
        const hintR = unknown ? sR.z : this.zR[0];
        const hintF = unknown ? sR.z : this.zF[0];
        const sF = c.surface(fx, fy, hintF, 2.2, sp.heading);
        this.roadIndex = sR.road;
        this.inTunnel = sR.road >= 0 && !!c.road(sR.road)?.tunnel;
        this.hangR = this.hanging(c, sp.x, sp.y, sR, hintR);
        this.hangF = this.hanging(c, fx, fy, sF, hintF);
        // With something under one axle the section keeps its level over the gap under the other;
        // with nothing under either (placed in mid-air) it falls.
        const fall = this.hangR && this.hangF;
        const tRz = fall ? (sR.road >= 0 ? c.ground(sp.x, sp.y) : sR.z) : this.levelTarget(sR, hintR);
        const tFz = fall ? (sF.road >= 0 ? c.ground(fx, fy) : sF.z) : this.levelTarget(sF, hintF);
        if (settle) {
          this.zR[0] = this.tR[0] = tRz;
          this.zF[0] = this.tF[0] = tFz;
          this.vzR[0] = this.vzF[0] = 0;
          this.airR[0] = this.airF[0] = 0;
        } else {
          this.followZ(this.zR, this.vzR, this.tR, this.airR, 0, tRz, h, v);
          this.followZ(this.zF, this.vzF, this.tF, this.airF, 0, tFz, h, v);
        }
      } else if (c) {
        // Trailer: its front rests on the hitch of the section ahead (on the line through that section's
        // axles), and its axle is on the road at the hitch's level, never steeper than TRAILER_GRADE from it.
        const ps = spec.sections[i - 1];
        const dP = i === 1 ? spec.wheelbase : Math.max(0.5, ps.axleFromFront - ps.hitchFromFront);
        const back = ps.rearHitchFromFront - ps.axleFromFront;
        const slopeP = (this.zR[i - 1] - this.zF[i - 1]) / dP;
        const hz = this.zR[i - 1] + slopeP * back;
        const lim = TRAILER_GRADE * dF;
        // Where the axle should be: on the leading section's grade after a reset, else this section's own.
        const pred = hz + clamp(settle ? slopeP * dF : this.zR[i] - this.zF[i], -lim, lim);
        const sR = c.surface(sp.x, sp.y, pred, 2.2, sp.heading);
        const tRz = clamp(this.levelTarget(sR, pred), hz - lim, hz + lim);
        this.zF[i] = this.tF[i] = hz;
        this.vzF[i] = 0;
        this.airF[i] = 0;
        if (settle) {
          this.zR[i] = this.tR[i] = tRz;
          this.vzR[i] = 0;
          this.airR[i] = 0;
        } else this.followZ(this.zR, this.vzR, this.tR, this.airR, i, tRz, h, v);
        this.zR[i] = clamp(this.zR[i], hz - lim, hz + lim);
      }
      const pitch = Math.atan2(this.zF[i] - this.zR[i], dF);
      sp.z = this.zR[i];
      sp.pitch = pitch;
      wSum += ss.length;
      gSum += ss.length * Math.sin(pitch);
    }
    this.settleZ = false;
    if (c) this.zKnown = true;
    p.z = this.zR[0];
    this.grade = secs[0].pitch ?? 0;
    this.gradeSin = wSum > 0 ? gSum / wSum : 0;
    this.airborne = this.airR[0] === 1 && this.airF[0] === 1;
    return false;
  }

  /**
   * Nothing to stand on at level z under (x, y) (surface sample `s` taken there at that level): no road
   * or station bay, and the ground more than EDGE_DROP below; or past the side of a bridge deck (beyond
   * its edge, no other carriageway there) with the ground that far below.
   */
  private hanging(c: SimCollider, x: number, y: number, s: Surface, z: number): boolean {
    if (s.road >= 0) {
      if (s.edge <= DECK_EDGE || !c.road(s.road)?.bridge) return false;
      return z - c.ground(x, y) > EDGE_DROP && !c.drivable(x, y, z);
    }
    return z - s.z > EDGE_DROP && !c.drivable(x, y, z);
  }

  /** Height the wheels at surface sample `s` follow: the road, else the ground unless it is a face or a drop (keep level z). */
  private levelTarget(s: Surface, z: number): number {
    if (s.road >= 0) return s.z;
    // No road at this level and the ground far above: rock over a tunnel (or a cliff face), not a surface
    // to stand on. Far below: the drop beside a deck. Either way keep the level (walls and the face and
    // edge checks stop the front section; a trailer's wheels just hang there).
    if (s.z - z > 2.2 || z - s.z > EDGE_DROP) return z;
    return s.z;
  }

  /**
   * Moving an axle of the front section to (x, y) at level z runs into a rock face (off the road, the
   * ground well above), or over an edge (see `hanging`). An axle already over a drop (placed there) may
   * move on, so the bus can drive back onto the road.
   */
  private blocked(c: SimCollider, x: number, y: number, z: number, heading: number, wasHanging: boolean): boolean {
    const s = c.surface(x, y, z, 2.2, heading);
    if (s.road < 0 && s.z - z > 0.6 && !c.drivable(x, y, z)) return true;
    return !wasHanging && this.hanging(c, x, y, s, z);
  }

  private followZ(z: Float64Array, vz: Float64Array, tPrev: Float64Array, air: Uint8Array, i: number, target: number, h: number, v: number): void {
    if (air[i] || z[i] - target > EDGE_DROP) {
      // A road far below the wheels (they don't drive off edges, see levelTarget): free fall onto it.
      vz[i] -= G * h;
      z[i] += vz[i] * h;
      if (z[i] <= target) {
        this.landing = Math.max(this.landing, -vz[i]);
        z[i] = target;
        vz[i] = 0;
        air[i] = 0;
      } else air[i] = 1;
    } else {
      // Feed the surface's own rate forward (lag-free on grades), then a short spring for steps and joins:
      // up at once (the wheels can't sink into the road), down a step at a few m/s (no free fall, no thump).
      const lim = Math.abs(v) * 0.25 + 0.5;
      const rate = clamp((target - tPrev[i]) / h, -lim, lim);
      z[i] += rate * h;
      z[i] += Math.max(-STEP_DOWN_RATE * h, (target - z[i]) * (1 - Math.exp(-h / 0.07)));
      if (z[i] < target - 0.25) z[i] = target - 0.25;
      vz[i] = rate;
    }
    tPrev[i] = target;
  }

  /** Retarder / regen share 0..1 (audio). */
  retarderLevel = 0;

  private towSections(): void {
    const p = this.pose;
    const secs = p.sections;
    secs[0].x = p.x;
    secs[0].y = p.y;
    secs[0].heading = p.heading;
    for (let i = 1; i < secs.length; i++) {
      const prev = secs[i - 1];
      const sp = this.spec.sections[i - 1];
      const si = this.spec.sections[i];
      const c = sp.rearHitchFromFront - sp.axleFromFront;
      const d = Math.max(0.5, si.axleFromFront - si.hitchFromFront);
      const hx = prev.x - Math.sin(prev.heading) * c;
      const hy = prev.y - Math.cos(prev.heading) * c;
      const cur = secs[i];
      let hd = Math.atan2(hx - cur.x, hy - cur.y);
      let rel = wrapAngle(prev.heading - hd);
      if (rel > JOINT_LIMIT) rel = JOINT_LIMIT;
      else if (rel < -JOINT_LIMIT) rel = -JOINT_LIMIT;
      hd = wrapAngle(prev.heading - rel);
      cur.heading = hd;
      cur.x = hx - Math.sin(hd) * d;
      cur.y = hy - Math.cos(hd) * d;
      this.joints[i - 1] = rel;
    }
  }

  /**
   * After a snap onto a road: each trailer's axle onto the same lane of the road at that level (on a
   * bend, sections laid out straight would stand off the road, into its walls).
   */
  private laySections(c: SimCollider, z: number, lateral: number): void {
    const secs = this.pose.sections;
    for (let i = 1; i < secs.length; i++) {
      const prev = secs[i - 1];
      const sp = this.spec.sections[i - 1];
      const si = this.spec.sections[i];
      const back = sp.rearHitchFromFront - sp.axleFromFront;
      const d = Math.max(0.5, si.axleFromFront - si.hitchFromFront);
      const [px, py] = headingDir(prev.heading);
      const hx = prev.x - px * back;
      const hy = prev.y - py * back;
      const snap = c.nearestRoad(hx - px * d, hy - py * d, prev.heading, 12, z);
      if (!snap || Math.abs(snap.z - z) > 1.5) continue;
      const [nx, ny] = headingDir(snap.heading);
      const tx = snap.x - ny * lateral;
      const ty = snap.y + nx * lateral;
      let hd = Math.atan2(hx - tx, hy - ty);
      const rel = clamp(wrapAngle(prev.heading - hd), -JOINT_LIMIT * 0.5, JOINT_LIMIT * 0.5);
      hd = wrapAngle(prev.heading - rel);
      const [fx, fy] = headingDir(hd);
      secs[i].x = hx - fx * d;
      secs[i].y = hy - fy * d;
      secs[i].heading = hd;
      this.joints[i - 1] = rel;
    }
  }

  private straightenSections(): void {
    const p = this.pose;
    const secs = p.sections;
    secs[0].x = p.x;
    secs[0].y = p.y;
    secs[0].heading = p.heading;
    secs[0].z = p.z ?? 0;
    secs[0].pitch = 0;
    for (let i = 1; i < secs.length; i++) {
      const prev = secs[i - 1];
      const sp = this.spec.sections[i - 1];
      const si = this.spec.sections[i];
      const back = sp.rearHitchFromFront - sp.axleFromFront + Math.max(0.5, si.axleFromFront - si.hitchFromFront);
      const [fx, fy] = headingDir(prev.heading);
      secs[i].x = prev.x - fx * back;
      secs[i].y = prev.y - fy * back;
      secs[i].heading = prev.heading;
      secs[i].z = p.z ?? 0;
      secs[i].pitch = 0;
      this.joints[i - 1] = 0;
    }
  }

  /** Body roll / pitch: spring-damper driven by acceleration, plus kneel lean and road texture. */
  private updateSway(h: number, c: BusControls, av: number, sinking: boolean): void {
    const p = this.pose;
    const metro = this.spec.type === 'metro';
    // Kneeling lowers the front kerb-side (left) corner by ~8 cm.
    const kneelRoll = -c.kneel * (0.08 / this.spec.width) * 0.9;
    const kneelPitch = -c.kneel * (0.08 / Math.max(4, this.spec.sections[0].length * 0.7));
    let rollT = -this.accelLat * (metro ? 0.0095 : 0.011) + kneelRoll;
    let pitchT = this.aLongRaw * 0.0055 + kneelPitch;
    if (sinking) {
      rollT = 0.06;
      pitchT = 0;
    }
    // Low-pass the targets a little so brake release at standstill gives a smooth rock back.
    this.rollBase = smooth(this.rollBase, rollT, h, 0.05);
    this.pitchBase = smooth(this.pitchBase, pitchT, h, 0.05);
    const wr = Math.PI * 2 * 0.85;
    const wp = Math.PI * 2 * 1.1;
    const rollA = wr * wr * (this.rollBase - this.rollS) - 2 * 0.32 * wr * this.rollV;
    const pitchA = wp * wp * (this.pitchBase - this.pitchS) - 2 * 0.42 * wp * this.pitchV;
    this.rollV += rollA * h;
    this.pitchV += pitchA * h;
    // Road texture: random impulses scaled with speed.
    if (av > 0.5) {
      const k = Math.min(1, av / 16) * 0.0009;
      this.rollV += (this.random() - 0.5) * k * 60 * h * 2;
      this.bumpV += (this.random() - 0.5) * k * 90 * h * 2;
    }
    this.bumpV += (-200 * this.bump - 14 * this.bumpV) * h;
    this.bump += this.bumpV * h;
    this.rollS += this.rollV * h;
    this.pitchS += this.pitchV * h;
    p.roll = this.rollS;
    p.pitch = this.pitchS + this.bump * 0.02;
  }

  private random(): number {
    // xorshift32, deterministic.
    let x = this.rand;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rand = x >>> 0;
    return this.rand / 4294967296;
  }

  private writeTelemetry(): void {
    const pt = this.powertrain;
    this.rpm = pt.rpm;
    this.gearIndex = pt.gearIndex;
    this.gearLabel = pt.gearLabel;
    if (player.physics !== this) return;
    const t = telemetry;
    t.busType = this.spec.type;
    t.speed = this.pose.speed;
    t.rpm = pt.rpm;
    t.gearIndex = pt.gearIndex;
    t.gearLabel = pt.gearLabel;
    t.load = pt.load;
    t.boost = pt.boost;
    t.shifting = pt.shifting;
    t.retarder = this.retarderLevel;
    t.slip = this.slip;
    t.brakePressure = this.brakePressure;
    t.reverse = pt.gearIndex === -1;
    t.accelLong = this.accelLong;
    t.accelLat = this.accelLat;
    t.yawRate = this.yawRate;
    t.joints = this.joints;
    t.time = this.time;
    t.z = this.pose.z ?? 0;
    t.grade = this.grade;
    t.inTunnel = this.inTunnel;
    t.airborne = this.airborne;
  }

  /** The collider last passed to update(), if it is the driving subsystem's own. */
  get simCollider(): SimCollider | null {
    return this.collider && isSimCollider(this.collider) ? this.collider : null;
  }
}
