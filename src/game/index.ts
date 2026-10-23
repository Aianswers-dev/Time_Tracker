// STUB — replaced by the gameplay/UI subsystem. Keep the exported names and signatures.
import * as THREE from 'three';
import type { BusFactory, BusLights, BusPose, BusType, MapData, Route, WorldHandle } from '../types';
import { pointAlong, projectOnto } from '../data/coords';

export interface MenuChoice {
  route: Route;
  type: BusType;
  /** Local time of day to start at, 0..24. */
  hours: number;
}

export function busTypeForRoute(route: Route): BusType {
  if (route.operator === 'MET' || route.id === 'M1' || route.id === 'M2') return 'metro';
  if (route.id === '60' || route.id === '61') return 'glider';
  return 'rigid';
}

export async function showMenu(data: MapData): Promise<MenuChoice> {
  const route = data.routes.find((r) => r.id === '61') ?? data.routes[0];
  return { route, type: busTypeForRoute(route), hours: 10 };
}

export interface GuideState {
  /** Distance driven along the route, metres. */
  s: number;
  nextStopIndex: number;
  nextStopName: string;
  nextStopDistance: number;
  offRoute: boolean;
  finished: boolean;
}

export class RouteGuide {
  state: GuideState;
  constructor(
    readonly scene: THREE.Scene,
    readonly data: MapData,
    readonly route: Route,
  ) {
    this.state = { s: 0, nextStopIndex: 0, nextStopName: '', nextStopDistance: 0, offRoute: false, finished: false };
  }
  /** Where the player's bus should start: map x/y of the front of the bus and heading. */
  startPose(): { x: number; y: number; heading: number } {
    const p = pointAlong(this.route.pts, this.route.cum, 5);
    return { x: p.x, y: p.y, heading: p.heading };
  }
  update(_dt: number, frontX: number, frontY: number, _doorsOpen: boolean, _speed: number): GuideState {
    const pr = projectOnto(this.route.pts, this.route.cum, frontX, frontY);
    this.state.s = pr.s;
    this.state.offRoute = pr.dist > 30;
    const next = this.route.stops.find((st) => st.s > pr.s);
    if (next) {
      this.state.nextStopIndex = this.route.stops.indexOf(next);
      this.state.nextStopName = this.data.stops[next.stop].name;
      this.state.nextStopDistance = next.s - pr.s;
    }
    return this.state;
  }
  dispose(): void {}
}

export interface HudFrame {
  route: Route;
  pose: BusPose;
  speedKmh: number;
  rpm: number;
  gear: string;
  lights: BusLights;
  doorsOpen: boolean;
  guide: GuideState;
  hours: number;
  cameraMode: string;
  fps: number;
}

export class Hud {
  private el: HTMLDivElement;
  constructor(root: HTMLElement, readonly data: MapData) {
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:fixed;left:12px;top:12px;font:14px system-ui;background:#0008;padding:8px;border-radius:6px;white-space:pre';
    root.appendChild(this.el);
  }
  update(f: HudFrame): void {
    this.el.textContent = `${f.route.id} ${f.route.headsign}\n${f.speedKmh.toFixed(0)} km/h  ${f.gear}\nNext: ${f.guide.nextStopName} (${f.guide.nextStopDistance.toFixed(0)} m)`;
  }
  toast(_msg: string): void {}
  toggleMap(): void {}
  dispose(): void {
    this.el.remove();
  }
}

export class Traffic {
  constructor(
    readonly scene: THREE.Scene,
    readonly data: MapData,
    readonly buses: BusFactory,
    readonly world: WorldHandle,
  ) {}
  update(_dt: number, _timeSeconds: number, _player: BusPose, _camera: THREE.Camera): void {}
}
