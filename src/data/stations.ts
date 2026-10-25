/**
 * Hand-authored dressing for Brisbane's busway and Metro stations: where each
 * station is, its line's canopy palette and the landmark structures that make
 * it recognisable (vaults, lift towers, overbridges, chargers...).
 *
 * Positions are map metres (x east, y north of King George Square), taken from
 * OSM (footbridge and roof centroids, bridge outlines) and checked against
 * aerial imagery; sizes and colours come from photos of the real stations.
 * The platforms themselves come from OSM via the pipeline (platforms.json);
 * this table only says how to dress them. Shared by the world (which skips the
 * OSM roofs a station model replaces) and the game (which builds the models).
 */
import { BuildingKind, type Building, type Platform } from '../types';

export type RoofStyle = 'flat' | 'vault' | 'none';

export interface OverbridgeDef {
  /** A point on the bridge axis (over the busway); the axis runs across the busway. */
  x: number;
  y: number;
  /** Optional explicit axis direction (unit, map), else perpendicular to the busway. */
  ax?: number;
  ay?: number;
  /** Length past each kerb-to-kerb edge (m): [left of travel, right] measured from the axis point. */
  len: [number, number];
  /** Deck width. */
  w: number;
  /** Glass tint 0xRRGGBB and frame colour. */
  glass: number;
  frame: number;
  /** Lift/stair towers at the two ends (each centred half its width in from an end of `len`). */
  towers: boolean;
  /** Tower footprint (m square), default 6.5. */
  towerW?: number;
  /** Towers' flat roof overhang past the body (m): [along the bridge axis, across it]; default 1.8. */
  towerHat?: [number, number];
  /** Towers' roof form: flat cantilevered "hat" (default) or a white hipped/pyramid roof (Gabba, QUT KG). */
  towerRoof?: 'flat' | 'pyramid';
  /** Towers are slim all-glass lift shafts (Mater Hill) rather than stair towers. */
  towerLift?: boolean;
  /** Flat white roof wider than the deck (CC's oval canopy). */
  roofW?: number;
  /** Roof only over this part of the deck, as a flat oval (CC); else the whole deck. */
  roofLen?: [number, number];
  /** Open deck with glass balustrades instead of a glazed tube (CC's Melbourne St overpass). */
  open?: boolean;
  /** Deck height above the busway (m). */
  clear?: number;
}

export interface TowerDef {
  x: number;
  y: number;
  /** Footprint (m) and height above the local platform/busway level. */
  w: number;
  d: number;
  h: number;
  /** Rotation (compass radians) of the footprint's long side, else aligned with the busway. */
  heading?: number;
  frame: number;
  /** Banner colour on one corner (TransLink orange) or 0 for none. */
  banner?: number;
  /** Ground-level building (not raised on the busway level). */
  ground?: boolean;
  /** Flat roof overhang past the body (m): [along the heading side, across]; default 1.8. */
  hat?: [number, number];
  /** Roof form: flat cantilevered "hat" (default) or a white hipped/pyramid roof. */
  roof?: 'flat' | 'pyramid';
  /** A slim all-glass lift shaft with a thin cap (Mater Hill's light-blue lifts). */
  lift?: boolean;
}

/**
 * A concourse building spanning the busway (RBWH): a raised box on columns
 * with white horizontal bands and glass, station lettering on its long faces.
 */
export interface ConcourseDef {
  x: number;
  y: number;
  /** Unit axis along the busway, extent along it [s0, s1] and width across. */
  ax: number;
  ay: number;
  len: [number, number];
  w: number;
  /** Underside above the busway, and height of the box (m). */
  clear: number;
  h: number;
}

export interface StationDef {
  key: string;
  /** Name on the totems. */
  name: string;
  x: number;
  y: number;
  /** Radius (m) that the station's platforms fall within. */
  r: number;
  /** Canopy posts and beams, fascia, roof top. */
  post: number;
  fascia: number;
  roofTop: number;
  soffit: number;
  /** Platform paving and its tile size (m), screen glass tint. */
  paving: number;
  tile: number;
  glass: number;
  /** 'charcoal' tactile + yellow line (SEB/INB/EB), or Metro-era wide yellow tactile. */
  tactile: 'charcoal' | 'yellow';
  roof: RoofStyle;
  /** Canopy panels in alternating colours (Cultural Centre's translucent roof). */
  panels?: number[];
  /** Underside of the canopy above the platform (m). */
  canopyH?: number;
  /** Depth of the canopy strip from the kerb (m). */
  canopyDepth?: number;
  /** Height of the glazed rear screens (m), default 2.45; UQ Lakes' run up to the canopy. */
  screenH?: number;
  /**
   * Canopy form: the flat cantilever (default) or Dutton Park Place's curved "wing", a blade on one
   * row of tall posts whose soffit rises towards the kerb.
   */
  canopy?: 'flat' | 'wing';
  /** Per-platform overrides by platform number (Roma St's new P1 vs the older P2). */
  platforms?: Record<string, Partial<Pick<StationDef, 'post' | 'fascia' | 'roofTop' | 'soffit' | 'canopyH' | 'canopyDepth' | 'screenH' | 'glass'>>>;
  /**
   * Underground (KGS, Queen St): glass screen walls with door pods instead of
   * canopies. Unset: from the platform data; false overrides it.
   */
  underground?: boolean;
  /** Vault ribs: colour, spacing (m), paired ribs, rise above the springing (m). */
  vault?: { rib: number; spacing: number; paired: boolean; rise: number; spring: number };
  /** Median fence between the two directions where platforms face each other. */
  median?: 'fence' | 'barrier';
  /** Twin-head light poles in the median. */
  medianLights?: boolean;
  /** Louvred blue-steel back walls (South Bank). */
  louvres?: number;
  overbridges?: OverbridgeDef[];
  towers?: TowerDef[];
  /** Pantograph chargers (UQ Lakes), map positions + heading of the bay. */
  chargers?: { x: number; y: number }[];
  /** OSM roofs (kind Roof) whose centroid is within this radius of the station are replaced by the model. */
  ownRoofs?: number;
  /** Other buildings replaced by the model, by footprint centroid (within 3 m). */
  ownBuildings?: [number, number][];
  concourse?: ConcourseDef;
  /**
   * Street entrance canopies: centre, unit facing (towards the street), length
   * across the facing, depth and underside height; the station name stands on
   * the front edge of the roof.
   */
  entrances?: { x: number; y: number; fx: number; fy: number; len: number; d: number; h: number }[];
}

// Line palettes (photos: Greenslopes/Gabba SEB charcoal, PAH/Boggo/Stones/Langlands EB bronze, INB green).
const SEB = { post: 0x2b2f33, fascia: 0x2b2f33, roofTop: 0x6d7174, soffit: 0xeeeeea };
const EB = { post: 0x4a3b30, fascia: 0x4a3b30, roofTop: 0x6f6a66, soffit: 0xefede8 };
const INB = { post: 0x2e4b3c, fascia: 0x2e4b3c, roofTop: 0x8c9192, soffit: 0xeceeea };
const ORANGE = 0xe8552b;

export const STATIONS: StationDef[] = [
  {
    key: 'kgs',
    name: 'King George Square',
    x: 25,
    y: 72,
    r: 95,
    ...SEB,
    paving: 0xd8d0c0,
    tile: 0.6,
    glass: 0xa9c4c8,
    tactile: 'charcoal',
    roof: 'none',
    underground: true,
    // The Adelaide St entrance pavilions (granite wedges) are modelled; their OSM boxes are skipped.
    ownBuildings: [
      [68, 3],
      [99, 30],
    ],
  },
  {
    key: 'queenst',
    name: 'Queen Street',
    x: 125,
    y: -170,
    r: 90,
    ...SEB,
    paving: 0xc9bea9,
    tile: 0.5,
    glass: 0xb7c2b8,
    tactile: 'charcoal',
    roof: 'none',
    underground: true,
  },
  {
    key: 'cc',
    name: 'Cultural Centre',
    x: -455,
    y: -530,
    r: 110,
    post: 0x3a332d,
    fascia: 0x5a4636,
    roofTop: 0xa8a49c,
    soffit: 0xd9d4ca,
    // translucent panels seen from above: peach and white squares between dark brown beams (imagery)
    panels: [0xdca07a, 0xdcdcd6, 0xdca07a, 0xcfcfc9],
    paving: 0xc9bfae,
    tile: 0.6,
    glass: 0x9fb7b0,
    tactile: 'yellow',
    roof: 'flat',
    median: 'fence',
    medianLights: true,
    // The QPAC - Museum overpass (Melbourne Street Overpass outline) with its white oval canopy.
    overbridges: [{ x: -461, y: -531, ax: 0.52, ay: -0.854, len: [-60, 60], w: 8, glass: 0xdfe6e6, frame: 0xd9d9d4, towers: false, roofW: 15, roofLen: [-28, 28], open: true, clear: 6.8 }],
    // its dark-framed glass lift shafts beside the deck (OSM elevators 10290775677, 13417295247; photo
    // Cultural_Centre_busway_front)
    towers: [
      { x: -458.2, y: -549.2, w: 3.2, d: 3.2, h: 10.4, heading: 2.595, frame: 0x2b2f33, lift: true },
      { x: -481.4, y: -511.2, w: 3.2, d: 3.2, h: 10.4, heading: 2.595, frame: 0x2b2f33, lift: true },
    ],
    ownRoofs: 60,
  },
  {
    key: 'roma',
    name: 'Roma Street',
    x: -375,
    y: 312,
    r: 75,
    // the new P1 (2026): white posts, copper fascia band; P2: white fascia on grey square posts
    post: 0xf2f2ee,
    fascia: 0xb06a45,
    roofTop: 0x7a7a78,
    soffit: 0xf2f2ee,
    platforms: { '2': { post: 0x8a8d90, fascia: 0xf2f2ee } },
    paving: 0x6e6f71,
    tile: 0.6,
    glass: 0xb9cfd3,
    tactile: 'yellow',
    roof: 'flat',
    median: 'barrier',
    ownRoofs: 45,
  },
  {
    key: 'southbank',
    name: 'South Bank',
    x: -147,
    y: -1335,
    r: 60,
    // very dark plum-navy steel (photos: South_Bank_busway_station,_South_Brisbane,_Queensland_01/02)
    post: 0x312c38,
    fascia: 0x312c38,
    roofTop: 0x8a8e90,
    soffit: 0xf0f0ec,
    paving: 0xc8c0b0,
    tile: 0.6,
    glass: 0x9fb7b0,
    tactile: 'charcoal',
    roof: 'flat',
    canopyDepth: 6,
    louvres: 0xc9cdd0,
    median: 'fence',
    // the lift/stair buildings at the platforms' south ends (OSM elevators, white roofs in imagery
    // about 13 x 11 m centred (-139.3, -1369.7) and (-118.3, -1354.7))
    towers: [
      { x: -139.5, y: -1370, w: 8, d: 7.5, h: 5.6, frame: 0x312c38, banner: ORANGE, hat: [2.6, 1.9] },
      { x: -118.5, y: -1356, w: 7.5, d: 7.5, h: 5.6, frame: 0x312c38, banner: ORANGE, hat: [2, 1.8] },
    ],
    ownRoofs: 45,
  },
  {
    key: 'mater',
    name: 'Mater Hill',
    x: 477,
    y: -1731,
    r: 50,
    post: 0x2f4a3a,
    fascia: 0x2f4a3a,
    roofTop: 0x7c8082,
    soffit: 0xf1f1ec,
    paving: 0xa9a49b,
    tile: 0.6,
    glass: 0x9fb7b0,
    tactile: 'charcoal',
    roof: 'flat',
    median: 'fence',
    // The glazed footbridge (OSM 508391959, (467,-1744)-(472,-1716)) with a glass lift shaft in a light-blue
    // frame at each end, standing on the platforms. East of x 490 the station runs under the Mater buildings.
    overbridges: [{ x: 469.5, y: -1730, ax: 0.176, ay: 0.984, len: [-16.05, 16.05], w: 3.6, glass: 0x8fb0bf, frame: 0x5f9fc8, towers: true, towerW: 3.2, towerLift: true, clear: 6.2 }],
  },
  {
    key: 'buranda',
    name: 'Buranda',
    x: 1570,
    y: -3147,
    r: 60,
    post: 0x2f5f8f,
    fascia: 0x2f5f8f,
    roofTop: 0x7c8082,
    soffit: 0xf1f1ec,
    paving: 0xc9bfaa,
    tile: 0.6,
    glass: 0x9fb7b0,
    tactile: 'charcoal',
    roof: 'flat',
    median: 'fence',
    // The bright blue-steel glazed footbridge (photo BurandaStation.jpg) across the cutting at the platforms' south ends (OSM 458013390,
    // (1573,-3171)-(1596,-3151), lifts at both ends); the white-roofed entrance building at its SW end.
    overbridges: [{ x: 1584.5, y: -3161, ax: 0.754, ay: 0.656, len: [-19.5, 19.5], w: 3.6, glass: 0x9fc3c8, frame: 0x2d6db5, towers: true, towerW: 7, towerHat: [2.5, 1.5], clear: 6.4 }],
  },
  {
    key: 'gabba',
    name: 'Woolloongabba',
    x: 1123,
    y: -1910,
    r: 60,
    ...SEB,
    roofTop: 0x3d4144,
    // dark charcoal soffit with downlights (photo: Woolloongabba_Busway_station)
    soffit: 0x4a4d50,
    paving: 0xb9b6ae,
    tile: 0.6,
    glass: 0x9fb7b0,
    tactile: 'charcoal',
    roof: 'flat',
    median: 'fence',
    medianLights: true,
    // The footbridge at the platforms' west end (OSM 458014092) between two square towers with white hipped
    // roofs (imagery: about 11.5 m square, centred (1091.2,-1888.5) and (1087,-1912.3)); the south tower's
    // body sits back from the eastbound lane, its roof overhanging it.
    overbridges: [{ x: 1089.1, y: -1902, ax: 0.152, ay: 0.988, len: [-17.9, 17.9], w: 4, glass: 0x9fb7b0, frame: 0x2b2f33, towers: true, towerW: 8, towerHat: [1.8, 1.8], towerRoof: 'pyramid', clear: 6.4 }],
  },
  {
    key: 'pah',
    name: 'PA Hospital',
    x: 1032,
    y: -3105,
    r: 70,
    ...EB,
    paving: 0xd8cfbd,
    tile: 0.6,
    glass: 0x8fb3ad,
    tactile: 'charcoal',
    roof: 'flat',
    median: 'fence',
    medianLights: true,
    // Lift towers on the platforms' east-end landings joined by the teal overbridge, on the line
    // of the OSM footbridge (building 36455, (1057,-3122)-(1061,-3096)).
    // Imagery (z20): hats about 21 m along the busway x 16 m, centred (1063.5,-3083) behind platform 1 and
    // (1056.5,-3123) on platform 2's east end, the 4.6 m glazed bridge between them; OSM's elevators
    // ((1062,-3094), (1056,-3125)) are the lift doors at the bridge ends.
    overbridges: [{ x: 1059.2, y: -3108.9, ax: 0.164, ay: 0.987, len: [-19.15, 30.45], w: 4.4, glass: 0x3fa7a0, frame: 0x2b2f33, towers: true, towerW: 9, towerHat: [3.5, 6], clear: 6.4 }],
    // OSM boxes the model replaces: the north station building, the footbridge and the south building.
    ownBuildings: [
      [1062, -3089],
      [1059, -3109],
      [1056, -3131],
    ],
  },
  {
    key: 'boggo',
    name: 'Boggo Road',
    x: 690,
    y: -2785,
    r: 80,
    ...EB,
    post: 0x2b2f33,
    fascia: 0xeeeeea,
    paving: 0xcfcfca,
    tile: 0.6,
    glass: 0x7fb3a0,
    tactile: 'charcoal',
    roof: 'flat',
    median: 'fence',
    // The "skyway": one straight glazed concourse over the busway, platform 4 and the rail line (OSM roof 36454
    // and building 53591, about 3.6-3.9 m wide, centreline (651.8,-2757) + s (0.377,0.926), s -30.4..50), on
    // round concrete columns, ending in a stair/lift box at Boggo Road (north). Two lift towers with white hat
    // roofs stand on the busway platforms (imagery about 10-12 m square at (666.5,-2759) behind platform 4,
    // with a short landing from the skyway, and (648.2,-2782.3) beside the skyway's south end behind
    // platform 3); the north one sits a little south-west, clear of the rail line 5 m north-east.
    overbridges: [
      { x: 651.8, y: -2757, ax: 0.377, ay: 0.926, len: [-30.4, 44], w: 4, glass: 0x7fb3a0, frame: 0x2b2f33, towers: false, clear: 6.4 },
      { x: 659.3, y: -2759, ax: 0.968, ay: -0.251, len: [-5.8, 4.5], w: 3.2, glass: 0x7fb3a0, frame: 0x2b2f33, towers: false, clear: 6.4 },
    ],
    towers: [
      { x: 667, y: -2761, w: 8, d: 7, h: 12, frame: 0x2b2f33, banner: ORANGE, hat: [2, 2] },
      { x: 648.5, y: -2782.5, w: 7, d: 7, h: 12, frame: 0x2b2f33, banner: ORANGE, hat: [2, 2.5] },
      { x: 670, y: -2714.5, w: 7.7, d: 6.1, h: 12.8, heading: 0.386, frame: 0x2b2f33, hat: [0.6, 0.6] },
    ],
    // OSM's rail-side part of the skyway (a 7 m block from the ground over the tracks)
    ownBuildings: [[660.6, -2729.1]],
    ownRoofs: 70,
  },
  {
    key: 'uq',
    name: 'UQ Lakes',
    x: -560,
    y: -3228,
    r: 90,
    post: 0x4b3a3d,
    fascia: 0x4b3a3d,
    roofTop: 0x7a7476,
    soffit: 0xf0efea,
    paving: 0xc9c8c2,
    tile: 0.6,
    glass: 0x9fb7b0,
    tactile: 'charcoal',
    roof: 'flat',
    // full-height glazed rear screens up to the canopy (photos UQ_Lakes_busway_station_01-03)
    screenH: 4.1,
    // 600 kW pantograph chargers at stops A and B and in the bus refuge.
    chargers: [
      { x: -520.1, y: -3211.9 },
      { x: -545, y: -3211 },
      { x: -600, y: -3226 },
    ],
    ownRoofs: 90,
  },
  {
    key: 'dpp',
    name: 'Dutton Park Place',
    x: 113,
    y: -3245,
    r: 35,
    // the curved "wing" on tall dark grey posts: light grey panelled soffit, dark stacked fins on top
    // (photo: Dutton_Park_Place_busway_station.jpeg)
    post: 0x5a5e62,
    fascia: 0x4e5256,
    roofTop: 0x45494d,
    soffit: 0xc9cdcf,
    canopy: 'wing',
    canopyH: 4.6,
    paving: 0xcfcbc2,
    tile: 0.6,
    glass: 0x8fb3ad,
    tactile: 'charcoal',
    roof: 'flat',
    ownRoofs: 30,
  },
  {
    key: 'stones',
    name: 'Stones Corner',
    x: 2050,
    y: -3219,
    r: 60,
    ...EB,
    paving: 0x5f6164,
    tile: 0.6,
    glass: 0x8fb3ad,
    tactile: 'yellow',
    roof: 'flat',
    median: 'fence',
    // Lift/stair towers just past the platforms' east ends (OSM elevators (2090,-3215), (2084,-3240); imagery
    // hats about 16 x 14 m). No overbridge: the platforms are linked under the viaduct.
    towers: [
      { x: 2091, y: -3214, w: 8, d: 8, h: 6.5, frame: 0x2b2f33, banner: ORANGE, hat: [4, 3] },
      { x: 2085, y: -3240.5, w: 8, d: 7.5, h: 6.5, frame: 0x2b2f33, banner: ORANGE, hat: [3.5, 2.5] },
    ],
    ownRoofs: 45,
  },
  {
    key: 'langlands',
    name: 'Langlands Park',
    x: 2565,
    y: -3304,
    r: 60,
    ...EB,
    paving: 0xcfcbc2,
    tile: 0.6,
    glass: 0x8fb3ad,
    tactile: 'charcoal',
    roof: 'flat',
    canopyDepth: 4.5,
    median: 'fence',
    // lift towers on the landings behind both platforms (platform outlines), joined across the busway
    // charcoal frames, grey panels, green-tinted glass (photo Langlands_Park_busway_station)
    // (imagery hats about 13.7 m square centred (2579.4,-3281.6) and (2578.2,-3318.5), on the platforms'
    // landings; OSM elevators (2579,-3287), (2579,-3320))
    overbridges: [{ x: 2579, y: -3303.3, ax: 0, ay: 1, len: [-19.2, 25.7], w: 3.6, glass: 0x8fb3ad, frame: 0x3a3c3f, towers: true, towerW: 7.5, towerHat: [3.1, 3.1], clear: 6.2 }],
    // the bronze entrance canopy with "Langlands Park" lettering on Old Cleveland Rd
    entrances: [{ x: 2556, y: -3326, fx: 0, fy: -1, len: 18, d: 5, h: 3.4 }],
    ownRoofs: 40,
  },
  {
    key: 'greenslopes',
    name: 'Greenslopes',
    x: 1652,
    y: -4680,
    r: 75,
    ...SEB,
    paving: 0xcbbfa6,
    tile: 0.6,
    glass: 0x9fb7b0,
    tactile: 'charcoal',
    roof: 'flat',
    median: 'fence',
    // The footbridge at the platforms' south ends (OSM 683341103, (1655,-4715)-(1677,-4704), lifts at both
    // ends) between two navy towers with big flat white roofs (imagery about 13 x 12 m).
    overbridges: [{ x: 1666, y: -4709.5, ax: 0.894, ay: 0.447, len: [-16, 16], w: 3.6, glass: 0x9fb7b0, frame: 0x22324a, towers: true, towerW: 7, towerHat: [3, 2.5], clear: 6.4 }],
    ownRoofs: 60,
  },
  {
    key: 'normanby',
    name: 'Normanby',
    x: -832,
    y: 1102,
    r: 45,
    // an open cutting below Kelvin Grove Rd (OSM's layer=-1 only means "below the road bridge")
    underground: false,
    post: 0x2f5f8f,
    fascia: 0xeeeeea,
    roofTop: 0x8a8e90,
    soffit: 0xf0f0ec,
    paving: 0xbfb8aa,
    tile: 0.6,
    glass: 0x8fb3ad,
    tactile: 'charcoal',
    roof: 'flat',
    // Two lift towers at the platforms' south ends, up to Kelvin Grove Rd (OSM roofs 480017429 / 480017430,
    // roof:shape=pyramidal, 3 levels; imagery about 10-11 m square with an X of ridges; photo
    // Normanby_stn_looking_S: teal steel, pale louvres, glass, a wide thin white roof).
    towers: [
      { x: -853.3, y: 1103.5, w: 7.5, d: 7.5, h: 9.5, frame: 0x2b6a6e, banner: ORANGE, hat: [1.7, 1.7], roof: 'pyramid' },
      { x: -834, y: 1081.5, w: 7.5, d: 7.5, h: 9.5, frame: 0x2b6a6e, banner: ORANGE, hat: [1.7, 1.7], roof: 'pyramid' },
    ],
    ownRoofs: 40,
  },
  {
    key: 'qutkg',
    name: 'QUT Kelvin Grove',
    x: -523,
    y: 1870,
    r: 110,
    ...INB,
    paving: 0xb9b2a5,
    tile: 0.9,
    glass: 0x9fb7b0,
    tactile: 'charcoal',
    roof: 'vault',
    vault: { rib: 0x2e4b3c, spacing: 6, paired: true, rise: 4.2, spring: 4.6 },
    median: 'fence',
    // The overbridge past the platforms' north ends between two light-blue towers with white pyramid roofs
    // (OSM elevators (-528,1918), (-504,1914), footbridge 521961062; imagery about 11.5 m square).
    overbridges: [{ x: -516.8, y: 1917.7, ax: 0.992, ay: -0.127, len: [-16.75, 16.75], w: 4, glass: 0x9fb7b0, frame: 0x6a9cc0, towers: true, towerW: 8.5, towerHat: [1.5, 1.5], towerRoof: 'pyramid', clear: 6.4 }],
    // OSM's 7 m boxes for those two towers
    ownBuildings: [
      [-527.7, 1921.6],
      [-503.9, 1913.9],
    ],
    ownRoofs: 110,
  },
  {
    key: 'herston',
    name: 'Herston',
    x: 130,
    y: 2125,
    r: 190,
    ...INB,
    post: 0x2b2f33,
    fascia: 0x2b2f33,
    paving: 0xb98f7a,
    tile: 0.6,
    glass: 0x9fb7b0,
    tactile: 'charcoal',
    roof: 'vault',
    vault: { rib: 0x2b2f33, spacing: 3.2, paired: false, rise: 3.6, spring: 4.6 },
    median: 'fence',
    ownRoofs: 190,
    // The two lift towers at the platforms' east ends (OSM 53118 / 53116, ~10 m square) joined by a
    // glazed overbridge across the busway (photo: Herston_busway_station_and_Northern_Busway).
    // Dark teal steel with white louvres and thin flat white hats (photo: Overbridge,_lifts_and_stairs_at_
    // north_portal_of_Herston_Bus_Station).
    overbridges: [{ x: 185.05, y: 2120.2, ax: 0.15, ay: 0.989, len: [-17, 17], w: 3.6, glass: 0x8fb3ad, frame: 0x1f4d52, towers: true, towerW: 9, towerHat: [1.6, 1.6], clear: 6.2 }],
    ownBuildings: [
      [187, 2132],
      [183, 2108],
    ],
  },
  {
    key: 'rbwh',
    name: 'RBWH',
    x: 560,
    y: 2418,
    r: 60,
    ...INB,
    post: 0x2b2f33,
    fascia: 0xf0f0ec,
    paving: 0xc8c6c0,
    tile: 0.6,
    glass: 0x7fb3a0,
    tactile: 'charcoal',
    roof: 'flat',
    median: 'fence',
    medianLights: true,
    // the white-banded concourse over the busway at the south end (imagery: x 537-565, y 2351-2388)
    concourse: { x: 551, y: 2369.5, ax: 0, ay: 1, len: [-18.5, 18.5], w: 28, clear: 5.4, h: 5.2 },
  },
];

/** The station a point belongs to (nearest centre within its radius). */
export function stationAt(x: number, y: number): StationDef | null {
  let best: StationDef | null = null;
  let bd = Infinity;
  for (const s of STATIONS) {
    const d = Math.hypot(x - s.x, y - s.y);
    if (d < s.r && d / s.r < bd) {
      bd = d / s.r;
      best = s;
    }
  }
  return best;
}

/** Default dressing for platforms outside every listed station. */
export const DEFAULT_STATION: StationDef = {
  key: '',
  name: '',
  x: 0,
  y: 0,
  r: 0,
  ...SEB,
  paving: 0xcfc8ba,
  tile: 0.6,
  glass: 0x9fb7b0,
  tactile: 'charcoal',
  roof: 'flat',
};

/**
 * The Inner Northern Busway's glazed / wire-mesh enclosures (QUT Kelvin Grove
 * to Herston): OSM maps each as a large `building=roof` over the busway. They
 * become arched vaults (the vault style of the nearest listed station).
 */
const ENCLOSURE_ZONE = { x0: -640, y0: 1690, x1: 210, y1: 2215, minArea: 900 };

function ringInfo(p: Float32Array): { cx: number; cy: number; area: number } {
  const n = p.length / 2;
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    cx += p[2 * i];
    cy += p[2 * i + 1];
    a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
  }
  return { cx: cx / n, cy: cy / n, area: Math.abs(a) / 2 };
}

/** The vault style for an enclosure roof (or null if this building is not one). */
export function enclosureStyle(b: Building): StationDef | null {
  if (b.kind !== BuildingKind.Roof || b.pts.length < 6) return null;
  const z = ENCLOSURE_ZONE;
  const { cx, cy, area } = ringInfo(b.pts);
  if (area < z.minArea || cx < z.x0 || cx > z.x1 || cy < z.y0 || cy > z.y1) return null;
  let best: StationDef | null = null;
  let bd = Infinity;
  for (const s of STATIONS) {
    if (s.roof !== 'vault') continue;
    const d = Math.hypot(cx - s.x, cy - s.y);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

function inRing(p: ArrayLike<number>, x: number, y: number): boolean {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[2 * i];
    const yi = p[2 * i + 1];
    const xj = p[2 * j];
    const yj = p[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function nearLine(p: ArrayLike<number>, x: number, y: number, r: number): boolean {
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i];
    const ay = p[i + 1];
    const dx = p[i + 2] - ax;
    const dy = p[i + 3] - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    if (Math.hypot(ax + dx * t - x, ay + dy * t - y) < r) return true;
  }
  return false;
}

interface PlatBox {
  p: Platform;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const platBoxes = new WeakMap<Platform[], PlatBox[]>();

function boxesOf(ps: Platform[]): PlatBox[] {
  let out = platBoxes.get(ps);
  if (out) return out;
  out = [];
  for (const p of ps) {
    if (p.underground || p.pts.length < 4) continue;
    const pad = p.area ? 0 : 2.5;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < p.pts.length; i += 2) {
      x0 = Math.min(x0, p.pts[i] - pad);
      x1 = Math.max(x1, p.pts[i] + pad);
      y0 = Math.min(y0, p.pts[i + 1] - pad);
      y1 = Math.max(y1, p.pts[i + 1] + pad);
    }
    out.push({ p, x0, y0, x1, y1 });
  }
  platBoxes.set(ps, out);
  return out;
}

/**
 * True if (x, y) lies on a surface platform (or within `pad` m of one). Used
 * by the world to leave bridge parapets out between a stopping bay and its
 * platform.
 */
export function onAnyPlatform(platforms: Platform[], x: number, y: number, pad = 0.3): boolean {
  for (const q of boxesOf(platforms)) {
    if (x < q.x0 - pad || x > q.x1 + pad || y < q.y0 - pad || y > q.y1 + pad) continue;
    if (q.p.area ? inRing(q.p.pts, x, y) || nearLine(q.p.pts, x, y, pad) : nearLine(q.p.pts, x, y, 2.2 + pad)) return true;
  }
  return false;
}

/**
 * True when a building stands on a surface busway platform: covering at least
 * half of it, or lying mostly on it. OSM maps several stations' shelters as
 * plain buildings (Herston, Buranda, Woolloongabba, Stones Corner, PA
 * Hospital, RBWH, South Bank, Mater Hill); they rendered as solid blocks over
 * the platforms, and the station model replaces them.
 */
function onPlatform(b: Building, platforms: Platform[]): boolean {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < b.pts.length; i += 2) {
    x0 = Math.min(x0, b.pts[i]);
    x1 = Math.max(x1, b.pts[i]);
    y0 = Math.min(y0, b.pts[i + 1]);
    y1 = Math.max(y1, b.pts[i + 1]);
  }
  for (const q of boxesOf(platforms)) {
    if (q.x1 < x0 || q.x0 > x1 || q.y1 < y0 || q.y0 > y1) continue;
    const on = (x: number, y: number) => (q.p.area ? inRing(q.p.pts, x, y) : nearLine(q.p.pts, x, y, 2.2));
    let inB = 0;
    let inP = 0;
    let both = 0;
    const step = 1;
    for (let x = Math.min(x0, q.x0) + 0.5; x < Math.max(x1, q.x1); x += step) {
      for (let y = Math.min(y0, q.y0) + 0.5; y < Math.max(y1, q.y1); y += step) {
        const a = inRing(b.pts, x, y);
        const p = on(x, y);
        if (a) inB++;
        if (p) inP++;
        if (a && p) both++;
      }
    }
    if (both && (both >= 0.5 * inP || both >= 0.7 * inB)) return true;
  }
  return false;
}

/**
 * True for an OSM building that a station model replaces (canopy roofs, the
 * QUT Kelvin Grove and Herston vaults, KGS's entrance pavilions, shelters
 * mapped as buildings on surface platforms): the world leaves it out so it is
 * not drawn twice.
 */
export function stationOwnsBuilding(b: Building, platforms?: Platform[]): boolean {
  const n = b.pts.length / 2;
  if (n < 3) return false;
  if (enclosureStyle(b)) return true;
  const { cx, cy } = ringInfo(b.pts);
  for (const s of STATIONS) {
    if (Math.hypot(cx - s.x, cy - s.y) > s.r + 20) continue;
    if (b.kind === BuildingKind.Roof && s.ownRoofs && Math.hypot(cx - s.x, cy - s.y) < s.ownRoofs) return true;
    for (const [ox, oy] of s.ownBuildings ?? []) if (Math.hypot(cx - ox, cy - oy) < 3) return true;
  }
  return !!platforms && b.kind !== BuildingKind.House && onPlatform(b, platforms);
}
