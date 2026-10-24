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
  /** Lift/stair towers at the two ends (centred 3.5 m in from each end of `len`). */
  towers: boolean;
  /** Tower footprint (m square), default 6.5. */
  towerW?: number;
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
    ownRoofs: 60,
  },
  {
    key: 'roma',
    name: 'Roma Street',
    x: -375,
    y: 312,
    r: 75,
    post: 0xf2f2ee,
    fascia: 0xb06a45,
    roofTop: 0x7a7a78,
    soffit: 0xf2f2ee,
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
    post: 0x2f5f8f,
    fascia: 0x2f5f8f,
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
    overbridges: [{ x: 469, y: -1730, len: [-16, 16], w: 3.6, glass: 0x8fb0bf, frame: 0x2f5f8f, towers: false, clear: 6.2 }],
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
  },
  {
    key: 'gabba',
    name: 'Woolloongabba',
    x: 1123,
    y: -1910,
    r: 60,
    ...SEB,
    roofTop: 0x3d4144,
    paving: 0xb9b6ae,
    tile: 0.6,
    glass: 0x9fb7b0,
    tactile: 'charcoal',
    roof: 'flat',
    median: 'fence',
    medianLights: true,
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
    overbridges: [{ x: 1059.2, y: -3108.9, ax: 0.164, ay: 0.987, len: [-16, 15.75], w: 4, glass: 0x3fa7a0, frame: 0x2b2f33, towers: true, clear: 6.4 }],
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
    // The "skyway" concourse bridge over busway and rail to the rail platforms (north).
    overbridges: [{ x: 646, y: -2771, ax: 0.32, ay: 0.947, len: [-14, 40], w: 5, glass: 0x7fb3a0, frame: 0x2b2f33, towers: true, clear: 6.4 }],
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
    ...EB,
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
    towers: [{ x: 2012, y: -3236, w: 7, d: 7, h: 13, frame: 0x2b2f33, banner: ORANGE }],
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
    overbridges: [{ x: 2579, y: -3304, ax: 0, ay: 1, len: [-22, 22], w: 3.6, glass: 0x8fb3ad, frame: 0x4a3b30, towers: true, clear: 6.2 }],
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
    towers: [{ x: 1627, y: -4700, w: 8, d: 8, h: 11, frame: 0x22324a, banner: ORANGE, ground: true }],
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
    towers: [{ x: -848, y: 1082, w: 8, d: 8, h: 8, frame: 0x2f5f8f, banner: ORANGE, ground: true }],
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
    overbridges: [{ x: 185.05, y: 2120.2, ax: 0.15, ay: 0.989, len: [-17, 17], w: 3.6, glass: 0x8fb3ad, frame: 0x2b2f33, towers: true, towerW: 9, clear: 6.2 }],
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
