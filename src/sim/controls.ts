/**
 * Cab switchgear: lights, indicators (with steering self-cancel and a flasher
 * relay), hazards, doors (valve delay, closing warning, reversing edges),
 * kneeling, park brake and a small air system that drives the pneumatic
 * sounds (brake-release "pssht", dryer purge).
 */
import type { BusLights, BusPose, DriveInput } from '../types';
import { emitSim, isSimInput, player, telemetry } from './hub';

type DoorPhase = 'closed' | 'valve' | 'opening' | 'open' | 'warning' | 'closing';

/** 90 flashes per minute, matching the lamp blink in src/bus. */
const FLASH_HZ = 1.5;
const DOOR_VALVE = 0.35;
const DOOR_OPEN_TIME = 1.5;
const DOOR_WARN_TIME = 0.75;
const DOOR_CLOSE_TIME = 1.7;
const KNEEL_DOWN_TIME = 2.2;
const KNEEL_UP_TIME = 2.8;

export class BusControls {
  lights: BusLights = {
    headlights: false,
    brake: false,
    reverse: false,
    indicatorLeft: false,
    indicatorRight: false,
    hazards: false,
  };
  /** Door opening fraction 0..1 (animated, eased). */
  doorOpen = 0;
  /** Driver's door switch position. */
  doorsWanted = false;
  /** Kneel 0 = ride height, 1 = fully knelt (front kerb side ~8 cm lower). */
  kneel = 0;
  kneelWanted = false;
  parkBrake = false;
  /** Flasher relay output: true while the indicator lamps are lit. Use it to blink lamps in sync with the click. */
  flasherOn = false;
  /** Brake reservoir pressure, bar. */
  airPressure = 9.6;
  /** True while the door brake holds the bus (doors open or opening/closing). */
  doorBrake = false;

  private doorPhase: DoorPhase = 'closed';
  private doorT = 0;
  private doorLinear = 0;
  private indicatorArmed = false;
  private compressorOn = false;
  private lastHiss = -10;
  private time = 0;
  private brakeHeld = 0;
  private brakePeak = 0;
  private movedT = 0;
  private stoppedT = 0;

  update(dt: number, input: DriveInput, pose: BusPose): void {
    if (isSimInput(input)) player.controls = this;
    this.time += dt;
    const p = input.pressed;
    const speed = Math.abs(pose.speed);
    const L = this.lights;

    // --- Lights ------------------------------------------------------------
    if (p.has('headlights')) L.headlights = !L.headlights;
    if (p.has('hazards')) L.hazards = !L.hazards;
    if (p.has('indicatorLeft')) {
      L.indicatorLeft = !L.indicatorLeft;
      L.indicatorRight = false;
      this.indicatorArmed = false;
    }
    if (p.has('indicatorRight')) {
      L.indicatorRight = !L.indicatorRight;
      L.indicatorLeft = false;
      this.indicatorArmed = false;
    }
    // Self-cancel: once the wheel has been wound well into the indicated turn, cancel when it comes back.
    const ind = L.indicatorLeft ? -1 : L.indicatorRight ? 1 : 0;
    if (ind !== 0) {
      const s = pose.steer * ind;
      if (s > 0.2) this.indicatorArmed = true;
      if (this.indicatorArmed && s < 0.05) {
        L.indicatorLeft = false;
        L.indicatorRight = false;
        this.indicatorArmed = false;
      }
    }
    this.updateFlasher();

    // --- Park brake --------------------------------------------------------
    if (p.has('parkBrake')) {
      this.parkBrake = !this.parkBrake;
      emitSim(this, { type: 'parkBrake', on: this.parkBrake });
      if (!this.parkBrake) this.useAir(0.25);
    }

    // --- Doors ---------------------------------------------------------------
    if (p.has('doors')) {
      if (!this.doorsWanted && speed > 0.6) emitSim(this, { type: 'refused', what: 'doors' });
      else this.doorsWanted = !this.doorsWanted;
    }
    this.updateDoors(dt);
    this.doorBrake = this.doorPhase !== 'closed';

    // --- Kneel ---------------------------------------------------------------
    if (p.has('kneel')) {
      if (!this.kneelWanted && speed > 0.4) emitSim(this, { type: 'refused', what: 'kneel' });
      else {
        this.kneelWanted = !this.kneelWanted;
        emitSim(this, { type: 'kneel', down: this.kneelWanted });
        this.useAir(this.kneelWanted ? 0.3 : 0.45);
      }
    }
    // Driving off raises the bus automatically.
    if (this.kneelWanted && input.throttle > 0.15 && this.doorPhase === 'closed') {
      this.kneelWanted = false;
      emitSim(this, { type: 'kneel', down: false });
      this.useAir(0.45);
    }
    this.kneel = Math.max(0, Math.min(1, this.kneel + (this.kneelWanted ? dt / KNEEL_DOWN_TIME : -dt / KNEEL_UP_TIME)));

    // --- Air: brake-release hiss and compressor/dryer cycle --------------------
    this.brakeHeld += (input.brake - this.brakeHeld) * Math.min(1, dt * 12);
    if (speed < 0.25) this.brakePeak = Math.max(this.brakePeak, this.brakeHeld);
    else this.brakePeak = 0;
    if (speed < 0.25 && this.brakePeak > 0.3 && input.brake < 0.04 && !this.parkBrake) {
      // Driver lets the pedal up at a stop: the brake chambers exhaust.
      if (this.time - this.lastHiss > 1.2) {
        emitSim(this, { type: 'airHiss', strength: Math.min(1, this.brakePeak) });
        this.lastHiss = this.time;
      }
      this.useAir(0.18 * this.brakePeak);
      this.brakePeak = 0;
    }
    // Coming to rest on the brake: a softer "psst" as the stop brake takes over.
    if (speed > 1) this.movedT = 2;
    else this.movedT = Math.max(0, this.movedT - dt);
    if (speed < 0.05 && input.brake > 0.2) this.stoppedT += dt;
    else if (speed > 0.3) this.stoppedT = 0;
    if (this.stoppedT >= 0.5 && this.stoppedT - dt < 0.5 && this.movedT > 0 && this.time - this.lastHiss > 1.2) {
      emitSim(this, { type: 'airHiss', strength: 0.3 });
      this.lastHiss = this.time;
    }
    if (this.airPressure < 9.0) this.compressorOn = true;
    if (this.compressorOn) {
      this.airPressure += dt * 0.09;
      if (this.airPressure >= 10) {
        this.airPressure = 10;
        this.compressorOn = false;
        emitSim(this, { type: 'purge' });
      }
    }

    // --- Lamps derived from the driveline ------------------------------------
    L.brake = input.brake > 0.05 || this.doorBrake || (this.parkBrake && speed < 0.1);
    L.reverse = input.gear === 'R';

    if (player.controls === this) {
      const t = telemetry;
      t.doorOpen = this.doorOpen;
      t.doorsWanted = this.doorsWanted;
      t.kneel = this.kneel;
      t.parkBrake = this.parkBrake;
      t.indicatorLeft = L.indicatorLeft;
      t.indicatorRight = L.indicatorRight;
      t.hazards = L.hazards;
      t.headlights = L.headlights;
      t.flasherOn = this.flasherOn;
      t.airPressure = this.airPressure;
    }
  }

  get doorsOpen(): boolean {
    return this.doorOpen > 0.02;
  }

  /** Physics: true when the door interlock must hold the bus. */
  get interlock(): boolean {
    return this.doorBrake;
  }

  /** The relay runs off the sim clock, in phase with the lamps in src/bus: (t * 1.5) % 1 < 0.5. */
  private updateFlasher(): void {
    const L = this.lights;
    const active = L.hazards || L.indicatorLeft || L.indicatorRight;
    const on = active && (this.time * FLASH_HZ) % 1 < 0.5;
    if (on !== this.flasherOn) {
      this.flasherOn = on;
      emitSim(this, { type: 'indicator', on });
    }
  }

  private updateDoors(dt: number): void {
    this.doorT += dt;
    const want = this.doorsWanted;
    switch (this.doorPhase) {
      case 'closed':
        if (want) this.setDoorPhase('valve');
        break;
      case 'valve':
        if (!want) this.setDoorPhase('closed');
        else if (this.doorT >= DOOR_VALVE) {
          this.setDoorPhase('opening');
          emitSim(this, { type: 'door', opening: true });
          this.useAir(0.12);
        }
        break;
      case 'opening':
        this.doorLinear = Math.min(1, this.doorLinear + dt / DOOR_OPEN_TIME);
        if (!want) {
          this.setDoorPhase('closing');
          emitSim(this, { type: 'door', opening: false });
        } else if (this.doorLinear >= 1) this.setDoorPhase('open');
        break;
      case 'open':
        if (!want) {
          this.setDoorPhase('warning');
          emitSim(this, { type: 'doorWarning' });
        }
        break;
      case 'warning':
        if (want) this.setDoorPhase('open');
        else if (this.doorT >= DOOR_WARN_TIME) {
          this.setDoorPhase('closing');
          emitSim(this, { type: 'door', opening: false });
          this.useAir(0.12);
        }
        break;
      case 'closing':
        this.doorLinear = Math.max(0, this.doorLinear - dt / DOOR_CLOSE_TIME);
        if (want) {
          // Sensitive edges: re-open.
          this.setDoorPhase('opening');
          emitSim(this, { type: 'door', opening: true });
        } else if (this.doorLinear <= 0) {
          this.setDoorPhase('closed');
          emitSim(this, { type: 'doorShut' });
        }
        break;
    }
    const x = this.doorLinear;
    this.doorOpen = x * x * (3 - 2 * x);
  }

  private setDoorPhase(ph: DoorPhase): void {
    this.doorPhase = ph;
    this.doorT = 0;
  }

  private useAir(bar: number): void {
    this.airPressure = Math.max(6, this.airPressure - bar);
  }
}
