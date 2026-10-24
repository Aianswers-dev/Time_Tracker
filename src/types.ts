/**
 * Shared contract between the subsystems. Keep this file small and stable.
 *
 * Coordinates
 * -----------
 * Map data is in metres on a local plane centred on King George Square:
 * x = east, y = north. In three.js the world maps as
 *   position.x = x, position.y = height above ground, position.z = -y.
 * Use `toWorld` / `fromWorld` from ./data/coords.ts.
 *
 * Headings are radians measured from north, clockwise (compass style):
 * heading 0 faces north (+y, three.js -z), PI/2 faces east (+x).
 * Australia drives on the LEFT. Buses are right-hand drive.
 *
 * The world is flat: ground is y = 0 everywhere (bridges included). The river
 * surface sits below ground level.
 */

import type * as THREE from 'three';

// ---------------------------------------------------------------------------
// Map data (decoded from public/data/*.json by src/data/load.ts)

export const enum RoadKind {
  Motorway = 0,
  Trunk = 1,
  Primary = 2,
  Secondary = 3,
  Tertiary = 4,
  Residential = 5,
  Service = 6,
  Busway = 7,
  Pedestrian = 8,
}

export interface Road {
  kind: RoadKind;
  /** Carriageway width in metres. */
  width: number;
  lanes: number;
  oneway: boolean;
  bridge: boolean;
  tunnel: boolean;
  layer: number;
  link: boolean;
  /** Bus-only road (busway / bus-designated service road). */
  bus: boolean;
  name?: string;
  /** Posted speed limit in km/h when tagged in OSM. */
  maxspeed?: number;
  /** Polyline, flat [x0, y0, x1, y1, ...] in metres. One-way roads point in the direction of travel. */
  pts: Float32Array;
}

export interface Rail {
  bridge: boolean;
  tunnel: boolean;
  pts: Float32Array;
}

export const enum BuildingKind {
  Generic = 0,
  House = 1,
  Apartments = 2,
  Commercial = 3,
  Industrial = 4,
  Civic = 5,
  Shed = 6,
  Parking = 7,
  Roof = 8,
}

export interface Building {
  /** Roof height above ground in metres. */
  height: number;
  /** Bottom of the walls (for building parts that float, e.g. towers on podiums). */
  minHeight: number;
  kind: BuildingKind;
  /** True for an OSM building:part (outline may also exist separately). */
  part: boolean;
  /** '#rrggbb' from OSM if tagged. */
  color?: string;
  roofColor?: string;
  /** 'g' gabled, 'h' hipped, 'p' pyramidal, 'd' dome, 's' skillion. */
  roof?: string;
  name?: string;
  /** Footprint outer ring, flat [x, y, ...], not closed (last != first). */
  pts: Float32Array;
}

export const enum AreaKind {
  Water = 0,
  Park = 1,
  Wood = 2,
  Sport = 3,
  Cemetery = 4,
  Plaza = 5,
  Sand = 6,
}

export interface Area {
  kind: AreaKind;
  pts: Float32Array;
  holes: Float32Array[];
}

export interface Stop {
  name: string;
  code: string;
  x: number;
  y: number;
}

export interface RouteStop {
  /** Index into MapData.stops. */
  stop: number;
  /** Distance along the route polyline in metres. */
  s: number;
  /** Scheduled seconds after the first stop on this map (from the GTFS timetable). */
  t: number;
}

export interface Route {
  /** Public route number, e.g. "61", "M1", "412". */
  id: string;
  /** Long name, e.g. "Ashgrove Shops - Coorparoo via City". */
  name: string;
  dir: number;
  headsign: string;
  /** '#rrggbb' TransLink route colour. */
  color: string;
  textColor: string;
  /** GTFS service_id prefix: 'BT' Brisbane Transport, 'MET' Brisbane Metro, others are contract operators. */
  operator: string;
  /** Number of weekly-timetable trips using this shape (a frequency hint). */
  trips: number;
  /** Polyline in metres, clipped to the map. */
  pts: Float32Array;
  /** Cumulative distance at each vertex, cum[0] = 0, cum[n-1] = length. */
  cum: Float32Array;
  length: number;
  stops: RouteStop[];
}

export interface MapData {
  /** [minX, minY, maxX, maxY] metres. */
  bounds: [number, number, number, number];
  roads: Road[];
  rail: Rail[];
  /** Traffic signal node positions, flat [x, y, ...]. */
  signals: Float32Array;
  /** Marked pedestrian crossings, flat [x, y, ...]. */
  crossings: Float32Array;
  buildings: Building[];
  areas: Area[];
  water: Area[];
  /** Individually mapped trees, flat [x, y, ...]. */
  trees: Float32Array;
  stops: Stop[];
  routes: Route[];
}

// ---------------------------------------------------------------------------
// Buses

/**
 * 'rigid'   12.5 m Volgren Optimus style (Brisbane Transport / TransLink livery)
 * 'glider'  12.5 m CityGlider (livery follows the route: Blue = 60, Maroon = 61)
 * 'metro'   24.7 m bi-articulated Brisbane Metro (M1, M2)
 */
export type BusType = 'rigid' | 'glider' | 'metro';

export interface BusSection {
  /** Body length of this section in metres. */
  length: number;
  /** Distance from the section's front face to its (rear-most) axle. */
  axleFromFront: number;
  /**
   * For sections after the first: distance from this section's front face
   * to the articulation joint that connects it to the section in front.
   * (Usually small, the joint sits at the front face.)
   */
  hitchFromFront: number;
  /**
   * Distance from this section's front face to the joint that the NEXT
   * section hangs off. Only used when a following section exists.
   */
  rearHitchFromFront: number;
}

export interface BusSpec {
  type: BusType;
  width: number;
  height: number;
  /** Front section wheelbase (front axle to rear axle). */
  wheelbase: number;
  /** Front axle distance behind the front face. */
  frontOverhang: number;
  /** Maximum front-wheel steering angle (radians). */
  maxSteer: number;
  /** Section 0 is the driven front body. */
  sections: BusSection[];
  /** Mass in kg (affects acceleration and braking feel). */
  mass: number;
}

/** Physics state handed to meshes and the HUD every frame. */
export interface BusPose {
  /** Position of section 0's REAR AXLE centre at ground level, metres (map x/y). */
  x: number;
  y: number;
  heading: number;
  /** Signed speed in m/s along heading (negative = reversing). */
  speed: number;
  /** Front wheel steer angle, radians, positive = turning right. */
  steer: number;
  /** Accumulated wheel rotation in radians. */
  wheelSpin: number;
  /** Pose of each section's rear axle (index 0 duplicates x/y/heading above). */
  sections: { x: number; y: number; heading: number }[];
  /** Body roll (radians, + = leaning right) and pitch (+ = nose up) for visual sway. */
  roll: number;
  pitch: number;
}

export interface BusLights {
  headlights: boolean;
  brake: boolean;
  reverse: boolean;
  indicatorLeft: boolean;
  indicatorRight: boolean;
  hazards: boolean;
}

export interface DestinationSign {
  route: string;
  headsign: string;
}

export interface BusMesh {
  spec: BusSpec;
  /**
   * One group per section, added to the scene by whoever creates the bus.
   * Section group local frame: origin at ground level at the centre of that
   * section's rear axle, forward is local -Z, up +Y, right +X.
   */
  sections: THREE.Group[];
  setPose(pose: BusPose): void;
  setLights(lights: BusLights, timeSeconds: number): void;
  /** 0 = closed, 1 = fully open. */
  setDoors(open: number): void;
  setDestination(sign: DestinationSign): void;
  /** Show/hide the exterior shell around the driver (hidden in first-person). */
  setInteriorView(inside: boolean): void;
  dispose(): void;
}

export interface CabState {
  speedKmh: number;
  rpm: number;
  steeringWheel: number; // radians of steering wheel rotation (+ = right)
  lights: BusLights;
  doorsOpen: boolean;
  stopRequested: boolean;
  timeSeconds: number;
  /** Selected gear for the dash display ('R', 'N', 'D'), when known. */
  gear?: string;
}

export interface Cab {
  /** Attach to BusMesh.sections[0]. Same local frame as the section. */
  group: THREE.Group;
  /** Driver's eye position in section 0 local coordinates. */
  eye: THREE.Vector3;
  update(state: CabState): void;
}

export interface BusFactory {
  specFor(type: BusType): BusSpec;
  createBus(opts: { type: BusType; route?: Route; detail: 'high' | 'low' }): BusMesh;
  createCab(type: BusType): Cab;
}

// ---------------------------------------------------------------------------
// Driving

export interface DriveInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1 (full left) .. 1 (full right) */
  steer: number;
  /** Gear selector. */
  gear: 'D' | 'N' | 'R';
  /** Edge-triggered actions this frame. */
  pressed: Set<InputAction>;
  /** Held this frame. */
  held: Set<InputAction>;
}

export type InputAction =
  | 'doors'
  | 'kneel'
  | 'horn'
  | 'indicatorLeft'
  | 'indicatorRight'
  | 'hazards'
  | 'headlights'
  | 'camera'
  | 'lookLeft'
  | 'lookRight'
  | 'lookBack'
  | 'gearUp'
  | 'gearDown'
  | 'map'
  | 'pause'
  | 'timeOfDay'
  | 'parkBrake'
  | 'reset';

export interface Collider {
  /** Returns a corrected pose if the bus footprint overlaps an obstacle, plus impact speed. */
  resolve(pose: BusPose, spec: BusSpec): { hit: boolean; impact: number };
}

// ---------------------------------------------------------------------------
// World

export interface WorldHandle {
  /** Call every frame. `hours` is local time of day 0..24. */
  update(dt: number, camera: THREE.Camera, hours: number): void;
  /** Current state of the traffic signal nearest to a point, for AI and HUD. */
  signalStateAt?(x: number, y: number, timeSeconds: number): 'green' | 'amber' | 'red' | null;
}
