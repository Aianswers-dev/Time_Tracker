/**
 * Bus dimensions (BusSpec) and the body layout used to build the meshes.
 *
 * Section numbers (read this if you implement articulated kinematics)
 * --------------------------------------------------------------------
 * Every section i has a "span" of `length` metres along the bus axis. Spans
 * tile the bus exactly: the spans of all sections add up to the overall
 * length (12.5 m rigid, 24.7 m Metro). For the Metro each articulation pivot
 * (turntable) sits in the middle of a 0.6 m bellows; each neighbouring span
 * owns half of that bellows (BELLOWS_HALF = 0.3 m), so the rigid body of a
 * section is shorter than its span by 0.3 m at each articulated end.
 *
 * All distances below are measured backwards from the FRONT of the span:
 *   axleFromFront       the section's rear-most (for section 0: rear/drive) axle.
 *   hitchFromFront      joint to the section in front = 0 (front of the span).
 *   rearHitchFromFront  joint to the section behind = length (rear of the span).
 *
 * So the pivot between section i-1 and section i is, in map coordinates,
 *   pivot = axle[i-1] - (rearHitchFromFront[i-1] - axleFromFront[i-1]) * fwd(heading[i-1])
 *         = axle[i]   + (axleFromFront[i]       - hitchFromFront[i])     * fwd(heading[i])
 * where axle[i] is BusPose.sections[i] (rear axle centre) and fwd(h) = (sin h, cos h).
 * In section i's local frame (origin = its axle, forward = -Z):
 *   front of span  z = -axleFromFront          (front pivot, i > 0)
 *   rear of span   z = length - axleFromFront  (rear pivot / rear bumper)
 *
 * Metro numbers: section 0 span 10.2 (front axle 2.65, drive axle 8.6 behind the
 * nose, pivot 1.6 m behind the drive axle); section 1 span 7.2 (axle 5.7 behind
 * its front pivot, rear pivot 1.5 m behind the axle); section 2 span 7.3
 * (axle 4.4 behind its pivot, 2.9 m rear overhang).
 */
import type { BusSpec, BusType } from '../types';

/** Length of the bellows between articulated sections. */
export const BELLOWS = 0.6;
export const BELLOWS_HALF = BELLOWS / 2;

const SPECS: Record<BusType, BusSpec> = {
  // Volgren Optimus on Volvo B8RLE, 12.5 m, front axle 2.7 m behind the bumper,
  // 6.1 m wheelbase, 3.7 m rear overhang. Height includes the roof A/C pod.
  rigid: {
    type: 'rigid',
    width: 2.5,
    height: 3.2,
    wheelbase: 6.1,
    frontOverhang: 2.7,
    maxSteer: 0.7,
    mass: 12500,
    sections: [{ length: 12.5, axleFromFront: 8.8, hitchFromFront: 0, rearHitchFromFront: 12.5 }],
  },
  // CityGlider: same Optimus body, different livery.
  glider: {
    type: 'glider',
    width: 2.5,
    height: 3.2,
    wheelbase: 6.1,
    frontOverhang: 2.7,
    maxSteer: 0.7,
    mass: 12500,
    sections: [{ length: 12.5, axleFromFront: 8.8, hitchFromFront: 0, rearHitchFromFront: 12.5 }],
  },
  // HESS lighTram 25 (Brisbane Metro), 24.7 m, three bodies, two bellows.
  // Height includes the roof battery / charging fairings.
  metro: {
    type: 'metro',
    width: 2.55,
    height: 3.4,
    wheelbase: 5.95,
    frontOverhang: 2.65,
    maxSteer: 0.75,
    mass: 29000,
    sections: [
      { length: 10.2, axleFromFront: 8.6, hitchFromFront: 0, rearHitchFromFront: 10.2 },
      { length: 7.2, axleFromFront: 5.7, hitchFromFront: 0, rearHitchFromFront: 7.2 },
      { length: 7.3, axleFromFront: 4.4, hitchFromFront: 0, rearHitchFromFront: 7.3 },
    ],
  },
};

export function specFor(type: BusType): BusSpec {
  const s = SPECS[type];
  return { ...s, sections: s.sections.map((x) => ({ ...x })) };
}

// ---------------------------------------------------------------------------
// Body layout (internal to src/bus). All z' values are metres behind the front
// of the section span; local z = z' - axleFromFront.

export interface Span {
  z0: number;
  z1: number;
}

export interface WindowSpan extends Span {
  /** Sill and top heights. */
  y0: number;
  y1: number;
}

export interface DoorSpan extends Span {
  style: 'swing' | 'slide';
}

export interface AxleDef {
  z: number;
  dual: boolean;
  steer: boolean;
}

export interface RoofPod extends Span {
  w: number;
  h: number;
  dark?: boolean;
}

export interface SectionLayout {
  index: number;
  span: number;
  axleFromFront: number;
  /** Rigid body extent (z'). */
  bodyFront: number;
  bodyRear: number;
  axles: AxleDef[];
  isFront: boolean;
  isRear: boolean;
  /** Kerb-side (left, -X) doors. */
  doors: DoorSpan[];
  windowsL: WindowSpan[];
  windowsR: WindowSpan[];
  /** Raised rear saloon (low-entry buses): floor steps up from z0. */
  rearPlatform?: { z0: number; y: number; z1?: number; y1?: number };
  roofPods: RoofPod[];
}

export interface BodyLayout {
  type: BusType;
  hw: number;
  /** Skirt bottom and roof top. */
  y0: number;
  yTop: number;
  sill: number;
  winTop: number;
  doorTop: number;
  floor: number;
  ceiling: number;
  frontRadius: number;
  rearRadius: number;
  shoulder: number;
  tyreR: number;
  /** Extra z' set-back of the front face at height y (rake). */
  frontInset(y: number): number;
  rearInset(y: number): number;
  /** Inward offset of the side walls at height y (tumblehome / tuck-under). */
  sideInset(y: number): number;
  /** Heights where the body cross-section changes (rings of the shell). */
  levels: number[];
  sections: SectionLayout[];
  /** Driver's eye in section 0: x right of centre, height, z' behind the nose. */
  eye: { x: number; y: number; z: number };
}

function lerpSeg(y: number, pts: [number, number][]): number {
  if (y <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [ya, va] = pts[i - 1];
    const [yb, vb] = pts[i];
    if (y <= yb) {
      const t = (y - ya) / Math.max(1e-6, yb - ya);
      return va + (vb - va) * t;
    }
  }
  return pts[pts.length - 1][1];
}

function smooth(y: number, pts: [number, number][]): number {
  // piecewise linear but with a smoothstep in each segment, for curved glass
  if (y <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [ya, va] = pts[i - 1];
    const [yb, vb] = pts[i];
    if (y <= yb) {
      let t = (y - ya) / Math.max(1e-6, yb - ya);
      t = t * t * (3 - 2 * t);
      return va + (vb - va) * t;
    }
  }
  return pts[pts.length - 1][1];
}

const W = (z0: number, z1: number, y0: number, y1: number): WindowSpan => ({ z0, z1, y0, y1 });

function optimusLayout(type: BusType): BodyLayout {
  const sill = 1.12;
  const top = 2.55;
  return {
    type,
    hw: 1.25,
    y0: 0.3,
    yTop: 3.02,
    sill,
    winTop: top,
    doorTop: 2.6,
    floor: 0.36,
    ceiling: 2.7,
    frontRadius: 0.2,
    rearRadius: 0.17,
    shoulder: 0.16,
    tyreR: 0.5,
    frontInset: (y) =>
      lerpSeg(y, [
        [0.3, 0.04],
        [0.36, 0.0],
        [0.98, 0.02],
        [2.72, 0.16],
        [3.02, 0.24],
      ]),
    rearInset: (y) =>
      lerpSeg(y, [
        [0.3, 0.04],
        [0.36, 0.0],
        [1.9, 0.0],
        [3.02, 0.07],
      ]),
    sideInset: (y) =>
      lerpSeg(y, [
        [0.3, 0.03],
        [0.37, 0.0],
        [sill, 0.0],
        [2.65, 0.03],
      ]),
    levels: [0.3, 0.33, 0.37, 0.55, 0.75, 0.98, 1.12, 1.6, 2.1, 2.55, 2.72, 2.86, 2.93, 2.97, 3.0, 3.015, 3.02],
    sections: [
      {
        index: 0,
        span: 12.5,
        axleFromFront: 8.8,
        bodyFront: 0,
        bodyRear: 12.5,
        axles: [
          { z: 2.7, dual: false, steer: true },
          { z: 8.8, dual: true, steer: false },
        ],
        isFront: true,
        isRear: true,
        doors: [
          { z0: 0.28, z1: 1.43, style: 'slide' },
          { z0: 5.6, z1: 6.8, style: 'slide' },
        ],
        windowsL: [W(1.55, 3.4, sill, top), W(3.5, 5.45, sill, top), W(6.95, 8.1, sill, top), W(8.2, 10.05, sill, top), W(10.15, 11.55, sill, top), W(11.65, 12.15, sill + 0.1, top)],
        windowsR: [W(0.24, 1.55, 0.98, top), W(1.65, 3.4, sill, top), W(3.5, 5.45, sill, top), W(5.55, 7.4, sill, top), W(7.5, 9.35, sill, top), W(9.45, 11.55, sill, top), W(11.65, 12.15, sill + 0.1, top)],
        rearPlatform: { z0: 7.05, y: 0.72, z1: 10.9, y1: 0.98 },
        roofPods: [
          { z0: 1.5, z1: 4.45, w: 1.92, h: 0.2 },
          { z0: 10.85, z1: 12.0, w: 1.5, h: 0.14 },
        ],
      },
    ],
    eye: { x: 0.62, y: 2.2, z: 1.4 },
  };
}

function metroLayout(): BodyLayout {
  const sill = 0.85;
  const top = 2.75;
  const hs = 1.22; // sill over the wheel arches
  return {
    type: 'metro',
    hw: 1.275,
    y0: 0.3,
    yTop: 3.12,
    sill,
    winTop: top,
    doorTop: 2.68,
    floor: 0.36,
    ceiling: 2.8,
    frontRadius: 0.42,
    rearRadius: 0.3,
    shoulder: 0.2,
    tyreR: 0.5,
    frontInset: (y) =>
      smooth(y, [
        [0.3, 0.06],
        [0.38, 0.0],
        [0.92, 0.03],
        [2.5, 0.17],
        [2.95, 0.36],
        [3.12, 0.55],
      ]),
    rearInset: (y) =>
      lerpSeg(y, [
        [0.3, 0.05],
        [0.38, 0.0],
        [2.6, 0.04],
        [3.12, 0.16],
      ]),
    sideInset: (y) =>
      lerpSeg(y, [
        [0.3, 0.035],
        [0.38, 0.0],
        [sill, 0.0],
        [2.8, 0.035],
      ]),
    levels: [0.3, 0.33, 0.38, 0.55, 0.72, 0.92, 1.3, 1.7, 2.1, 2.5, 2.7, 2.85, 2.95, 3.02, 3.07, 3.1, 3.115, 3.12],
    sections: [
      {
        index: 0,
        span: 10.2,
        axleFromFront: 8.6,
        bodyFront: 0,
        bodyRear: 10.2 - BELLOWS_HALF,
        axles: [
          { z: 2.65, dual: false, steer: true },
          { z: 8.6, dual: true, steer: false },
        ],
        isFront: true,
        isRear: false,
        doors: [
          { z0: 0.42, z1: 1.78, style: 'slide' },
          { z0: 5.55, z1: 6.95, style: 'slide' },
        ],
        windowsL: [W(1.9, 3.4, hs, top), W(3.5, 5.45, sill, top), W(7.05, 7.95, sill, top), W(8.05, 9.15, hs, top), W(9.25, 9.78, sill, top)],
        windowsR: [W(0.3, 1.8, 1.0, top), W(1.9, 3.4, hs, top), W(3.5, 5.45, sill, top), W(5.55, 7.95, sill, top), W(8.05, 9.15, hs, top), W(9.25, 9.78, sill, top)],
        roofPods: [
          { z0: 0.95, z1: 2.15, w: 1.1, h: 0.2, dark: true },
          { z0: 2.4, z1: 9.6, w: 2.1, h: 0.28 },
        ],
      },
      {
        index: 1,
        span: 7.2,
        axleFromFront: 5.7,
        bodyFront: BELLOWS_HALF,
        bodyRear: 7.2 - BELLOWS_HALF,
        axles: [{ z: 5.7, dual: true, steer: false }],
        isFront: false,
        isRear: false,
        doors: [{ z0: 0.6, z1: 1.98, style: 'slide' }],
        windowsL: [W(2.08, 3.5, sill, top), W(3.6, 5.0, sill, top), W(5.1, 6.3, hs, top), W(6.4, 6.82, sill, top)],
        windowsR: [W(0.4, 1.98, sill, top), W(2.08, 3.5, sill, top), W(3.6, 5.0, sill, top), W(5.1, 6.3, hs, top), W(6.4, 6.82, sill, top)],
        roofPods: [{ z0: 0.6, z1: 6.6, w: 2.1, h: 0.28 }],
      },
      {
        index: 2,
        span: 7.3,
        axleFromFront: 4.4,
        bodyFront: BELLOWS_HALF,
        bodyRear: 7.3,
        axles: [{ z: 4.4, dual: true, steer: false }],
        isFront: false,
        isRear: true,
        doors: [{ z0: 0.6, z1: 1.98, style: 'slide' }],
        windowsL: [W(2.08, 3.7, sill, top), W(3.8, 5.0, hs, top), W(5.1, 6.4, sill, top), W(6.5, 7.0, sill + 0.15, top)],
        windowsR: [W(0.4, 1.98, sill, top), W(2.08, 3.7, sill, top), W(3.8, 5.0, hs, top), W(5.1, 6.4, sill, top), W(6.5, 7.0, sill + 0.15, top)],
        roofPods: [{ z0: 0.6, z1: 5.6, w: 2.1, h: 0.28 }],
      },
    ],
    eye: { x: 0.62, y: 2.2, z: 1.4 },
  };
}

const LAYOUTS = new Map<BusType, BodyLayout>();

export function layoutFor(type: BusType): BodyLayout {
  let l = LAYOUTS.get(type);
  if (!l) {
    l = type === 'metro' ? metroLayout() : optimusLayout(type);
    LAYOUTS.set(type, l);
  }
  return l;
}
