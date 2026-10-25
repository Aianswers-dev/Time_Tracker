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
 * Heights are metres AHD (about mean sea level) and three.js y = height. Use
 * src/data/height.ts: `Heights.ground(x, y)` for terrain and
 * `Heights.surfaceAt(x, y, hintZ)` for the road surface a vehicle is on
 * (bridges sit above what they cross, tunnels below; the hint picks the level).
 * The river surface is at `terrain.waterLevel`.
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
  /**
   * Tunnel under ground somewhere along it (pipeline, tools/data/elevation.py
   * boxed_tunnels): an enclosed tube from one end to the other, its portals
   * at the mapped ends, however little ground the terrain grid shows over it.
   */
  boxed?: boolean;
  layer: number;
  link: boolean;
  /** Bus-only road (busway / bus-designated service road). */
  bus: boolean;
  /**
   * Station stopping bay: a synthetic one-way bus carriageway (pipeline,
   * tools/data/stations.py) that fills the space between a busway and a
   * platform kerb, at the busway's height, tapering into the busway beyond
   * the platform ends. The platform is on its left (direction of travel);
   * its left edge runs 0.3 m under the platform slab. Draw it as station
   * pavement (concrete), with no parapet, wall or footpath on its left and
   * no gap to the busway on its right.
   */
  bay?: boolean;
  name?: string;
  /** Posted speed limit in km/h when tagged in OSM. */
  maxspeed?: number;
  /** Polyline, flat [x0, y0, x1, y1, ...] in metres. One-way roads point in the direction of travel. */
  pts: Float32Array;
  /** Surface height (m AHD) at each vertex. Bridges sit above what they cross, tunnels below. */
  z: Float32Array;
}

export interface Rail {
  bridge: boolean;
  tunnel: boolean;
  pts: Float32Array;
  /** Rail height (m AHD) at each vertex. */
  z: Float32Array;
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
  /** Ground height (m AHD) at the footprint centroid; `height`/`minHeight` are relative to it. */
  z: number;
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
  /** Road surface height at the stop (m AHD). */
  z: number;
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
  /** Road surface height (m AHD) at each vertex: stays in tunnels and on viaducts. */
  z: Float32Array;
  length: number;
  stops: RouteStop[];
}

/** A bus platform (busway station or interchange) from OSM. */
export interface Platform {
  /** e.g. "King George Square Platform 1"; may be empty. */
  name: string;
  /** Platform number/letter when tagged. */
  ref: string;
  /** Outline (area = true) or centre/edge line (area = false), flat [x, y, ...]. */
  pts: Float32Array;
  area: boolean;
  /** Has a roof/shelter over it. */
  covered: boolean;
  /** OSM layer (negative for underground). */
  layer: number;
  underground: boolean;
}

export interface MapData {
  /** [minX, minY, maxX, maxY] metres. */
  bounds: [number, number, number, number];
  roads: Road[];
  rail: Rail[];
  /** Traffic signal node positions, flat [x, y, ...]. */
  signals: Float32Array;
  /**
   * Per signal: index into `roads` of the road the signal stands on, or -1 for
   * signals mapped on paths and cycleways only (bike and pedestrian crossings
   * of a street, e.g. over a busway tunnel), which control no road traffic.
   */
  signalRoad?: Int32Array;
  /**
   * Per signal: the traffic it faces along its road's polyline (OSM
   * traffic_signals:direction): 1 forward (vertex order), -1 backward, 0 both
   * or not tagged.
   */
  signalDir?: Int8Array;
  /** Per signal: height (m AHD) of its road at the signal (ground for road -1). */
  signalZ?: Float32Array;
  /** Marked pedestrian crossings, flat [x, y, ...]. */
  crossings: Float32Array;
  /**
   * Mapped retaining walls (OSM barrier=retaining_wall), each a polyline [x, y, ...]: where a road in a
   * cutting has its wall when the map says so (src/world/roads.ts).
   */
  retainingWalls?: Float32Array[];
  buildings: Building[];
  areas: Area[];
  water: Area[];
  /** Individually mapped trees, flat [x, y, ...]. */
  trees: Float32Array;
  stops: Stop[];
  routes: Route[];
  /** Bus platforms at busway stations and interchanges (not solid buildings). */
  platforms: Platform[];
  terrain: TerrainGrids;
}

/** Ground height grids (m AHD), row-major from the south-west corner. See src/data/height.ts. */
export interface TerrainGrids {
  /** River / water surface height. */
  waterLevel: number;
  /** Fine grid over the map first, then a coarse horizon grid. */
  grids: { name: string; x0: number; y0: number; cell: number; nx: number; ny: number; h: Float32Array }[];
  attribution: string;
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
  /** Height of the road surface under section 0's rear axle (m AHD). Optional for old callers: treat missing as 0. */
  z?: number;
  heading: number;
  /** Signed speed in m/s along heading (negative = reversing). */
  speed: number;
  /** Front wheel steer angle, radians, positive = turning right. */
  steer: number;
  /** Accumulated wheel rotation in radians. */
  wheelSpin: number;
  /**
   * Pose of each section's rear axle. z = road height there (m AHD); pitch =
   * the section's grade angle (radians, + = nose up), not including sway.
   */
  sections: { x: number; y: number; heading: number; z?: number; pitch?: number }[];
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

/**
 * The solid edges the world draws along roads, for the driving collider, so a bus collides with exactly
 * what is on screen: tunnel tube walls, nose and end walls, portal pilasters, cutting retaining walls,
 * fill-wall and bridge parapets. Each piece is a line in plan (the face toward the road) with a vertical span.
 */
export interface EdgeWalls {
  /** ax, ay, bx, by per piece (map metres). */
  seg: Float32Array;
  /** Vertical span per piece (m AHD). */
  lo: Float32Array;
  hi: Float32Array;
  /** 0 tunnel structure, 1 parapet (bridge, fill wall), 2 retaining wall (cutting): the sim's WallKind. */
  kind: Uint8Array;
  /** Road each piece belongs to (-1: a railway's). */
  road: Int32Array;
  /** 1 where the piece belongs to a tunnel road (its tube, or the open cutting of its approach). */
  tunnel: Uint8Array;
  count: number;
  /**
   * Covered tube stretches (for cameras), 9 numbers each: ax, ay, bx, by, road height at a and b, reach
   * left and right of the centreline (to the walls, or across a platform hall), clear height inside.
   */
  ceilings: Float32Array;
}

export interface WorldHandle {
  /** The solid edges drawn along the roads (pass to the driving collider). */
  walls?: EdgeWalls;
  /** Call every frame. `hours` is local time of day 0..24. */
  update(dt: number, camera: THREE.Camera, hours: number): void;
  /**
   * Current state of the traffic signal nearest to a point, for AI and HUD.
   * Pass the approaching vehicle's travel direction (dirX, dirY, unit, map
   * coords) to get the phase for that approach; without it the approach is
   * guessed from the point's bearing from the junction centre. `z` (the
   * vehicle's road height) picks the level where junctions stack (a street
   * over a motorway). Null where no signal controls the approach. Junctions,
   * arms and phases: src/data/signals.ts.
   */
  signalStateAt?(x: number, y: number, timeSeconds: number, dirX?: number, dirY?: number, z?: number): 'green' | 'amber' | 'red' | null;
}
