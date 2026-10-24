/**
 * Powertrains. Both return the tractive force at the wheels (N, signed along
 * the bus heading) and keep the engine/motor state the HUD and audio show.
 *
 * Diesel: a 7.7 L six (Volvo D8K-ish) through a ZF EcoLife-style 6-speed
 * automatic. First and reverse run through the torque converter, 2nd-6th are
 * locked up. Shift points follow throttle like a city-bus TCU (early, soft
 * shifts with light throttle; held gears and kickdown at full throttle).
 *
 * Electric: the Brisbane Metro's traction motors - constant force up to base
 * speed, constant power above it, single reduction, strong regen.
 */
import type { DriveInput } from '../types';

export interface PowertrainState {
  rpm: number;
  /** 1-based gear in D, 0 in N, -1 in R. */
  gearIndex: number;
  gearLabel: string;
  /** 0..1 positive torque demand actually delivered. */
  load: number;
  boost: number;
  shifting: boolean;
}

export interface Powertrain extends PowertrainState {
  readonly kind: 'diesel' | 'electric';
  /** Advance by h seconds. `speed` is signed m/s along heading. Returns wheel force in N (signed). */
  step(h: number, throttle: number, selector: DriveInput['gear'], speed: number): number;
  /** Engine braking at the wheels (N, >= 0) when the throttle is closed. */
  dragForce(speed: number): number;
  reset(): void;
  onShift?: (from: number, to: number) => void;
}

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (cur: number, target: number, h: number, tau: number) => cur + (target - cur) * (1 - Math.exp(-h / Math.max(1e-4, tau)));

/** Full-load torque curve, Nm. */
const TORQUE_CURVE: [number, number][] = [
  [500, 620],
  [800, 980],
  [1100, 1250],
  [1500, 1250],
  [1800, 1160],
  [2100, 960],
  [2300, 760],
  [2450, 0],
];

function torqueAt(rpm: number): number {
  const c = TORQUE_CURVE;
  if (rpm <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (rpm <= c[i][0]) {
      const t = (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
      return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t;
    }
  }
  return 0;
}

export class DieselPowertrain implements Powertrain {
  readonly kind = 'diesel' as const;
  rpm = 650;
  gearIndex = 1;
  gearLabel = 'D1';
  load = 0;
  boost = 0;
  shifting = false;
  onShift?: (from: number, to: number) => void;

  readonly idle = 650;
  readonly governed = 2300;
  readonly ratios = [3.36, 1.91, 1.42, 1.0, 0.72, 0.62];
  readonly reverseRatio = 4.18;
  readonly axle = 6.2;
  readonly wheelRadius = 0.48;
  readonly efficiency = 0.88;

  private gear = 1; // 1..6 while in D
  private shiftT = 0;
  private shiftFrom = 1;
  private sinceShift = 10;
  private torqueCmd = 0;
  private thrFilt = 0;

  reset(): void {
    this.rpm = this.idle;
    this.gear = 1;
    this.gearIndex = 1;
    this.gearLabel = 'D1';
    this.load = 0;
    this.boost = 0;
    this.shifting = false;
    this.shiftT = 0;
    this.sinceShift = 10;
    this.torqueCmd = 0;
    this.thrFilt = 0;
  }

  /** Engine rpm the transmission input would turn at for this gear and road speed. */
  private turbineRpm(gear: number, speed: number): number {
    const wheelRpm = (Math.abs(speed) / this.wheelRadius) * (60 / TAU);
    return wheelRpm * this.axle * (gear < 0 ? this.reverseRatio : this.ratios[gear - 1]);
  }

  step(h: number, throttle: number, selector: DriveInput['gear'], speed: number): number {
    this.sinceShift += h;
    this.thrFilt = smooth(this.thrFilt, throttle, h, 0.5);
    // Turbo spools with exhaust energy (rpm x load) and lags behind it.
    const boostTarget = clamp(this.torqueCmd * clamp((this.rpm - 800) / 900, 0, 1), 0, 1);
    this.boost = smooth(this.boost, boostTarget, h, boostTarget > this.boost ? 0.9 : 0.45);
    // Torque builds with turbo boost: ~55% instantly, the rest as boost comes in.
    const avail = 0.55 + 0.45 * this.boost;
    this.torqueCmd = smooth(this.torqueCmd, throttle, h, throttle > this.torqueCmd ? 0.22 : 0.12);
    const demand = Math.min(this.torqueCmd, avail + 0.2 * (1 - this.torqueCmd));

    if (selector === 'N') {
      this.shifting = false;
      this.gearIndex = 0;
      this.gearLabel = 'N';
      const target = this.idle + throttle * (this.governed - 80 - this.idle);
      this.rpm = smooth(this.rpm, target, h, target > this.rpm ? 0.28 : 0.55);
      this.load = throttle * 0.35;
      return 0;
    }

    const reverse = selector === 'R';
    if (reverse) {
      this.gear = 1;
      this.gearIndex = -1;
      this.gearLabel = 'R';
      this.shifting = false;
    } else {
      this.autoShift(speed);
      this.gearIndex = this.gear;
      this.gearLabel = `D${this.gear}`;
    }

    let force: number;
    const converter = reverse || this.gear === 1;
    const ratio = reverse ? this.reverseRatio : this.ratios[this.gear - 1];
    const turb = this.turbineRpm(reverse ? -1 : this.gear, speed);
    if (converter) {
      // Hydrodynamic: the engine runs up to its stall speed, the converter multiplies torque.
      const stall = this.idle + demand * (1380 - this.idle);
      const coupled = turb / 0.93;
      const target = Math.pow(Math.pow(stall, 4) + Math.pow(coupled, 4), 0.25);
      this.rpm = smooth(this.rpm, Math.min(target, this.governed + 60), h, target > this.rpm ? 0.3 : 0.4);
      const sr = clamp(turb / Math.max(1, this.rpm), 0, 1);
      const tr = sr < 0.86 ? 1.85 - (0.85 * sr) / 0.86 : 1;
      force = (torqueAt(this.rpm) * demand * tr * ratio * this.axle * this.efficiency) / this.wheelRadius;
      // Idle creep through the converter (fades as the bus rolls).
      force += 2200 * clamp(1 - Math.abs(speed) / 1.6, 0, 1) * (1 - demand);
    } else {
      let rpmLocked = Math.max(turb, this.idle * 0.92);
      let mult = 1;
      if (this.shifting) {
        // Inertia phase: rpm slews from the old gear's speed to the new one, torque dips.
        this.shiftT += h;
        const f = clamp(this.shiftT / 0.42, 0, 1);
        const from = Math.max(this.turbineRpm(this.shiftFrom, speed), this.idle);
        const e = f * f * (3 - 2 * f);
        rpmLocked = from + (rpmLocked - from) * e;
        mult = 0.35 + 0.65 * Math.abs(2 * f - 1);
        if (f >= 1) this.shifting = false;
      }
      this.rpm = smooth(this.rpm, rpmLocked, h, 0.06);
      force = (torqueAt(this.rpm) * demand * mult * ratio * this.axle * this.efficiency) / this.wheelRadius;
    }
    // Governor fuel cut.
    if (this.rpm > this.governed) force *= clamp(1 - (this.rpm - this.governed) / 120, 0, 1);
    this.load = clamp(demand, 0, 1);
    return reverse ? -force : force;
  }

  private autoShift(speed: number): void {
    if (this.shifting || this.sinceShift < 1.1) return;
    const thr = this.thrFilt;
    const rpmNow = this.gear === 1 ? this.turbineRpm(1, speed) / 0.93 : this.turbineRpm(this.gear, speed);
    const up = 1280 + 640 * thr;
    const down = 820 + 380 * thr;
    if (this.gear < this.ratios.length && rpmNow > up && speed > 0.5) {
      this.shiftTo(this.gear + 1);
      return;
    }
    if (this.gear > 1) {
      const kickdown = thr > 0.85 && rpmNow < 1350 && this.turbineRpm(this.gear - 1, speed) < 1850;
      if (rpmNow < down || kickdown) this.shiftTo(this.gear - 1);
    }
  }

  private shiftTo(g: number): void {
    const from = this.gear;
    this.shiftFrom = from;
    this.gear = g;
    this.shiftT = 0;
    this.sinceShift = 0;
    // Shifts out of / into first are converter shifts: no locked-up rpm slew.
    this.shifting = from !== 1 && g !== 1;
    this.onShift?.(from, g);
  }

  dragForce(speed: number): number {
    if (this.gearIndex === 0 || this.gearIndex === 1 || this.gearIndex === -1) return 150;
    const ratio = this.ratios[this.gear - 1];
    return Math.abs(speed) > 0.5 ? (130 * ratio * this.axle) / this.wheelRadius : 0;
  }
}

export class ElectricPowertrain implements Powertrain {
  readonly kind = 'electric' as const;
  rpm = 0;
  gearIndex = 1;
  gearLabel = 'D';
  load = 0;
  boost = 0;
  shifting = false;
  onShift?: (from: number, to: number) => void;

  readonly wheelRadius = 0.48;
  readonly reduction = 11;
  private cmd = 0;

  constructor(
    readonly maxForce: number,
    readonly maxPower: number,
  ) {}

  reset(): void {
    this.rpm = 0;
    this.cmd = 0;
    this.load = 0;
  }

  step(h: number, throttle: number, selector: DriveInput['gear'], speed: number): number {
    this.rpm = (Math.abs(speed) / this.wheelRadius) * (60 / TAU) * this.reduction;
    this.gearIndex = selector === 'N' ? 0 : selector === 'R' ? -1 : 1;
    this.gearLabel = selector;
    // Inverter ramps torque smoothly (jerk limit).
    this.cmd = smooth(this.cmd, selector === 'N' ? 0 : throttle, h, throttle > this.cmd ? 0.18 : 0.08);
    const v = Math.max(Math.abs(speed), 0.5);
    const f = Math.min(this.maxForce, this.maxPower / v) * this.cmd;
    this.load = this.cmd;
    if (selector === 'N') return 0;
    return selector === 'R' ? -f : f;
  }

  dragForce(): number {
    return 0;
  }
}
