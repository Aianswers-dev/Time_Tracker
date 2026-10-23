// STUB — replaced by the driving subsystem. Keep the exported names and signatures.
import * as THREE from 'three';
import type { BusMesh, BusPose, BusSpec, Cab, Collider, DriveInput, InputAction, MapData } from '../types';
import { headingDir, headingToRotY, toWorld } from '../data/coords';

export class InputManager {
  private keys = new Set<string>();
  private prev = new Set<string>();
  gear: DriveInput['gear'] = 'D';
  constructor() {
    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
  }
  poll(_dt: number): DriveInput {
    const k = this.keys;
    const map: [string, InputAction][] = [['KeyC', 'camera'], ['KeyO', 'doors'], ['Escape', 'pause'], ['KeyM', 'map'], ['KeyT', 'timeOfDay']];
    const pressed = new Set<InputAction>();
    const held = new Set<InputAction>();
    for (const [code, a] of map) {
      if (k.has(code)) held.add(a);
      if (k.has(code) && !this.prev.has(code)) pressed.add(a);
    }
    this.prev = new Set(k);
    return {
      throttle: k.has('KeyW') || k.has('ArrowUp') ? 1 : 0,
      brake: k.has('KeyS') || k.has('ArrowDown') ? 1 : 0,
      steer: (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0),
      gear: this.gear,
      pressed,
      held,
    };
  }
}

export class BusPhysics {
  pose: BusPose;
  rpm = 700;
  constructor(readonly spec: BusSpec) {
    this.pose = { x: 0, y: 0, heading: 0, speed: 0, steer: 0, wheelSpin: 0, sections: spec.sections.map(() => ({ x: 0, y: 0, heading: 0 })), roll: 0, pitch: 0 };
  }
  reset(x: number, y: number, heading: number): void {
    Object.assign(this.pose, { x, y, heading, speed: 0, steer: 0 });
    this.syncSections();
  }
  update(dt: number, input: DriveInput, controls: BusControls, collider?: Collider): { impact: number } {
    void controls;
    const p = this.pose;
    p.steer += (input.steer * this.spec.maxSteer - p.steer) * Math.min(1, dt * 3);
    p.speed += (input.throttle * 1.5 - input.brake * 4 * Math.sign(p.speed)) * dt;
    p.speed *= 1 - 0.02 * dt;
    p.heading += (p.speed / this.spec.wheelbase) * Math.tan(p.steer) * dt;
    const [dx, dy] = headingDir(p.heading);
    p.x += dx * p.speed * dt;
    p.y += dy * p.speed * dt;
    p.wheelSpin += (p.speed / 0.5) * dt;
    this.syncSections();
    const res = collider?.resolve(p, this.spec);
    return { impact: res?.impact ?? 0 };
  }
  private syncSections(): void {
    const p = this.pose;
    p.sections[0] = { x: p.x, y: p.y, heading: p.heading };
    for (let i = 1; i < p.sections.length; i++) {
      const prev = p.sections[i - 1];
      const [dx, dy] = headingDir(prev.heading);
      const back = this.spec.sections[i - 1].axleFromFront - this.spec.sections[i - 1].rearHitchFromFront - this.spec.sections[i].axleFromFront;
      p.sections[i] = { x: prev.x + dx * back, y: prev.y + dy * back, heading: prev.heading };
    }
  }
}

export function buildCollider(_data: MapData): Collider {
  return { resolve: () => ({ hit: false, impact: 0 }) };
}

export type CameraMode = 'cab' | 'chase' | 'top';

export class CameraRig {
  mode: CameraMode = 'cab';
  constructor(readonly camera: THREE.PerspectiveCamera) {}
  cycle(): void {
    this.mode = this.mode === 'cab' ? 'chase' : this.mode === 'chase' ? 'top' : 'cab';
  }
  update(_dt: number, bus: BusMesh, cab: Cab, pose: BusPose, _input: DriveInput): void {
    bus.setInteriorView(this.mode === 'cab');
    if (this.mode === 'cab') {
      const g = bus.sections[0];
      g.updateMatrixWorld();
      this.camera.position.copy(cab.eye).applyMatrix4(g.matrixWorld);
      this.camera.rotation.set(0, headingToRotY(pose.heading), 0, 'YXZ');
    } else {
      const [dx, dy] = headingDir(pose.heading);
      const back = this.mode === 'chase' ? 22 : 2;
      const h = this.mode === 'chase' ? 8 : 120;
      toWorld(pose.x - dx * back, pose.y - dy * back, h, this.camera.position);
      this.camera.lookAt(toWorld(pose.x + dx * 10, pose.y + dy * 10, 1));
    }
  }
}

export class BusAudio {
  start(): void {}
  update(_s: { rpm: number; throttle: number; speed: number; brake: number }): void {}
  horn(_on: boolean): void {}
  door(_opening: boolean): void {}
  indicatorTick(): void {}
  impact(_strength: number): void {}
  setMuted(_m: boolean): void {}
}

/** Cab switchgear: lights, indicators, doors, kneel and park brake, driven by input actions. */
export class BusControls {
  lights: import('../types').BusLights = {
    headlights: false, brake: false, reverse: false, indicatorLeft: false, indicatorRight: false, hazards: false,
  };
  /** Door opening fraction 0..1 (animated). */
  doorOpen = 0;
  doorsWanted = false;
  kneel = 0;
  parkBrake = false;
  update(dt: number, input: DriveInput, pose: BusPose): void {
    if (input.pressed.has('doors') && Math.abs(pose.speed) < 0.5) this.doorsWanted = !this.doorsWanted;
    if (input.pressed.has('indicatorLeft')) { this.lights.indicatorLeft = !this.lights.indicatorLeft; this.lights.indicatorRight = false; }
    if (input.pressed.has('indicatorRight')) { this.lights.indicatorRight = !this.lights.indicatorRight; this.lights.indicatorLeft = false; }
    if (input.pressed.has('hazards')) this.lights.hazards = !this.lights.hazards;
    if (input.pressed.has('headlights')) this.lights.headlights = !this.lights.headlights;
    if (input.pressed.has('parkBrake')) this.parkBrake = !this.parkBrake;
    this.doorOpen = Math.max(0, Math.min(1, this.doorOpen + (this.doorsWanted ? dt : -dt) * 0.8));
    this.lights.brake = input.brake > 0.05;
    this.lights.reverse = input.gear === 'R';
  }
  get doorsOpen(): boolean {
    return this.doorOpen > 0.02;
  }
}
