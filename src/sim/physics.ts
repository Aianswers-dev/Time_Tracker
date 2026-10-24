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
 * Integration runs in fixed-size substeps of at most 1/120 s so behaviour does
 * not depend on the frame rate.
 */
import type { BusPose, BusSpec, Collider, DriveInput } from '../types';
import { headingDir, wrapAngle } from '../data/coords';
import type { BusControls } from './controls';
import { DieselPowertrain, ElectricPowertrain, type Powertrain } from './powertrain';
import { emitSim, isSimInput, player, telemetry } from './hub';
import { isSimCollider, type SimCollider } from './collider';

const G = 9.81;
const RHO = 1.2;
const SUBSTEP = 1 / 120;
const JOINT_LIMIT = (50 * Math.PI) / 180;
const WHEEL_RADIUS = 0.48;

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

  constructor(readonly spec: BusSpec) {
    this.tuning = tuningFor(spec);
    this.powertrain =
      spec.type === 'metro' ? new ElectricPowertrain(spec.mass * 1.45, 360_000) : new DieselPowertrain();
    this.powertrain.onShift = (from, to) => emitSim(this, { type: 'shift', from, to });
    this.joints = spec.sections.slice(1).map(() => 0);
    this.pose = {
      x: 0,
      y: 0,
      heading: 0,
      speed: 0,
      steer: 0,
      wheelSpin: 0,
      sections: spec.sections.map(() => ({ x: 0, y: 0, heading: 0 })),
      roll: 0,
      pitch: 0,
    };
  }

  /**
   * Place the bus with its section-0 rear axle at (x, y). Calling it with the
   * bus's own current pose (what the Backspace handler in main.ts does) also
   * puts the bus back onto the nearest road, aligned with it.
   */
  reset(x: number, y: number, heading: number): void {
    const p = this.pose;
    const inPlace = x === p.x && y === p.y && heading === p.heading;
    this.place(x, y, heading);
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
    const snap = c.nearestRoad(ax, ay, p.heading, 250);
    if (!snap) return false;
    const [nx, ny] = headingDir(snap.heading);
    // Left of travel = (-ny, nx) rotated: right vector is (ny, -nx).
    const lx = -ny;
    const ly = nx;
    const half = snap.width / 2;
    const lateral = snap.oneway ? Math.max(0, half - 1.9) * 0.5 : clamp(snap.width / 4, 0, Math.max(0, half - 1.5));
    const fxp = snap.x + lx * lateral;
    const fyp = snap.y + ly * lateral;
    this.place(fxp - nx * wb, fyp - ny * wb, snap.heading);
    for (let i = 0; i < 4; i++) {
      const r = c.resolve(this.pose, this.spec);
      if (!r.hit) break;
    }
    this.pose.speed = 0;
    emitSim(this, { type: 'reset' });
    return true;
  }

  private place(x: number, y: number, heading: number): void {
    const p = this.pose;
    p.x = x;
    p.y = y;
    p.heading = heading;
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
    for (let i = 0; i < n; i++) this.step(h, input, controls);

    const out: PhysicsResult = { impact: 0, hit: false, water: false };
    if (this.sinkT > 0) {
      this.sinkT -= dt;
      if (this.sinkT <= 0 && !this.recover()) this.sinkT = 0;
    } else if (collider) {
      const r = collider.resolve(this.pose, this.spec);
      out.hit = r.hit;
      out.impact = r.impact;
      if (r.hit) {
        // Kill the yaw rate partially so the bus doesn't keep rotating into the wall.
        this.yaw *= 0.6;
        if (r.impact > 0.25 && this.impactCooldown <= 0) {
          emitSim(this, r.impact > 1 ? { type: 'impact', strength: r.impact } : { type: 'scrape', strength: r.impact });
          this.impactCooldown = r.impact > 1 ? 0.25 : 0.08;
        } else if (Math.abs(this.pose.speed) > 0.3) emitSim(this, { type: 'scrape', strength: 0.3 });
      }
      if ((r as { water?: boolean }).water) {
        out.water = true;
        emitSim(this, { type: 'splash' });
        if (this.autoRecover) this.sinkT = 1.4;
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
    const cap = m * T.aDrive;
    drive = clamp(drive, -cap, cap);

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
    if (kneelCap && av > 1.4) service = Math.max(service, 1.0);
    const engineDrag = throttle < 0.03 ? this.powertrain.dragForce(v) : 0;
    const resist = m * (retDecel + service) + engineDrag + T.crr * m * G + 0.5 * RHO * T.cdA * v * v;
    let vNew = v + (drive / m) * h;
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
    const midHeading = p.heading + this.yaw * h * 0.5;
    p.heading = wrapAngle(p.heading + this.yaw * h);
    p.x += Math.sin(midHeading) * vNew * h;
    p.y += Math.cos(midHeading) * vNew * h;
    p.speed = vNew;
    p.wheelSpin = (p.wheelSpin + (vNew / WHEEL_RADIUS) * h) % (Math.PI * 2000);
    this.yawRate = this.yaw;
    this.accelLat = smooth(this.accelLat, vNew * this.yaw, h, 0.1);

    this.towSections();
    this.updateSway(h, c, av, sinking);
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

  private straightenSections(): void {
    const p = this.pose;
    const secs = p.sections;
    secs[0].x = p.x;
    secs[0].y = p.y;
    secs[0].heading = p.heading;
    for (let i = 1; i < secs.length; i++) {
      const prev = secs[i - 1];
      const sp = this.spec.sections[i - 1];
      const si = this.spec.sections[i];
      const back = sp.rearHitchFromFront - sp.axleFromFront + Math.max(0.5, si.axleFromFront - si.hitchFromFront);
      const [fx, fy] = headingDir(prev.heading);
      secs[i].x = prev.x - fx * back;
      secs[i].y = prev.y - fy * back;
      secs[i].heading = prev.heading;
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
      pitchT = -0.14;
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
  }

  /** The collider last passed to update(), if it is the driving subsystem's own. */
  get simCollider(): SimCollider | null {
    return this.collider && isSimCollider(this.collider) ? this.collider : null;
  }
}
