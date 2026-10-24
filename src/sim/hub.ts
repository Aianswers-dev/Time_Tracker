/**
 * Internal wiring for the driving subsystem.
 *
 * `main.ts` only hands each class what the shared contract needs, so the
 * pieces that want more (audio wants engine load and door events, input wants
 * the bus speed for speed-sensitive steering, the touch UI wants lamp states)
 * read the PLAYER's telemetry here. Only objects that are driven by an
 * InputManager poll (the player's physics and controls) write to it, so AI
 * buses that reuse these classes cannot hijack the cab sounds.
 */
import type { BusType, DriveInput } from '../types';

export type CameraModeName = 'cab' | 'chase' | 'top' | 'cinematic';

export type SimEvent =
  | { type: 'shift'; from: number; to: number }
  | { type: 'impact'; strength: number }
  | { type: 'scrape'; strength: number }
  | { type: 'splash' }
  | { type: 'airHiss'; strength: number }
  | { type: 'purge' }
  | { type: 'parkBrake'; on: boolean }
  | { type: 'door'; opening: boolean }
  | { type: 'doorWarning' }
  | { type: 'doorShut' }
  | { type: 'kneel'; down: boolean }
  | { type: 'indicator'; on: boolean }
  | { type: 'gearSelect'; gear: DriveInput['gear'] }
  | { type: 'refused'; what: string }
  | { type: 'reset' }
  | { type: 'jackknife' };

export interface Telemetry {
  busType: BusType;
  speed: number;
  rpm: number;
  gearIndex: number;
  gearLabel: string;
  /** 0..1 engine/motor load (positive torque). */
  load: number;
  /** 0..1 braking torque from retarder / regen. */
  retarder: number;
  /** 0..1 turbo boost (diesel only). */
  boost: number;
  shifting: boolean;
  /** 0..1 how far past the tyres' grip the bus is being pushed. */
  slip: number;
  brakePressure: number;
  reverse: boolean;
  accelLong: number;
  accelLat: number;
  yawRate: number;
  /** Articulation angles (radians) between consecutive sections. */
  joints: number[];
  /** Controls side. */
  doorOpen: number;
  doorsWanted: boolean;
  kneel: number;
  parkBrake: boolean;
  indicatorLeft: boolean;
  indicatorRight: boolean;
  hazards: boolean;
  headlights: boolean;
  flasherOn: boolean;
  airPressure: number;
  gear: DriveInput['gear'];
  view: CameraModeName;
  /** Seconds since the simulation started (player physics clock). */
  time: number;
}

export const telemetry: Telemetry = {
  busType: 'rigid',
  speed: 0,
  rpm: 650,
  gearIndex: 1,
  gearLabel: 'D1',
  load: 0,
  retarder: 0,
  boost: 0,
  shifting: false,
  slip: 0,
  brakePressure: 0,
  reverse: false,
  accelLong: 0,
  accelLat: 0,
  yawRate: 0,
  joints: [],
  doorOpen: 0,
  doorsWanted: false,
  kneel: 0,
  parkBrake: false,
  indicatorLeft: false,
  indicatorRight: false,
  hazards: false,
  headlights: false,
  flasherOn: false,
  airPressure: 9.6,
  gear: 'D',
  view: 'cab',
  time: 0,
};

/** The player's physics/controls instances (set on their first update with player input). */
export const player: { physics: object | null; controls: object | null } = { physics: null, controls: null };

type Listener = (e: SimEvent) => void;
const listeners = new Set<Listener>();

export function onSimEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Emit an event on behalf of `source`; dropped unless `source` is the player's physics or controls. */
export function emitSim(source: object, e: SimEvent): void {
  if (source !== player.physics && source !== player.controls) return;
  for (const fn of listeners) fn(e);
}

/** Emit unconditionally (input-side events such as gear selection). */
export function emitSimAny(e: SimEvent): void {
  for (const fn of listeners) fn(e);
}

/** Extra fields the InputManager adds on top of the DriveInput contract. */
export interface SimInput extends DriveInput {
  /** Marks input that came from the player's InputManager. */
  player: true;
  /** Free-look offsets from mouse drag / right stick / touch drag, radians. + yaw = look left, + pitch = look up. */
  lookYaw: number;
  lookPitch: number;
  /** True while the user is actively dragging (camera should not auto-return). */
  lookActive: boolean;
  /** Mouse wheel / pinch steps this frame (+ = zoom out). */
  zoom: number;
  /** Device that last produced steering. */
  device: 'keyboard' | 'gamepad' | 'touch';
  /** Hard (instant, full) braking requested, e.g. Shift+S. */
  emergency: boolean;
}

export function isSimInput(i: DriveInput): i is SimInput {
  return (i as Partial<SimInput>).player === true;
}

// Dev builds (or ?simdebug): expose telemetry for automated checks (tools/shot, Playwright).
if (typeof window !== 'undefined' && (import.meta.env?.DEV || location.search.includes('simdebug')))
  Object.assign(window, { __busSim: { telemetry, player } });
