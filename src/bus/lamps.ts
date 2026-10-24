// Lamp layout shared by the livery painter (lenses, lamps off) and the glow
// meshes (lamps on), so both always line up.
import * as THREE from 'three';
import type { BodyLayout, SectionLayout } from './spec';
import { ringAt } from './shell';
import { GeoBuilder, type RGB } from './util';

export type LampKind = 'head' | 'drl' | 'tail' | 'brake' | 'indL' | 'indR' | 'reverse' | 'markerF' | 'markerR' | 'markerS';
export type LampFace = 'front' | 'rear' | 'left' | 'right';

export interface LampDef {
  kind: LampKind;
  face: LampFace;
  circle: boolean;
  /** front/rear: metres from the viewer's left edge; sides: metres behind the body front. */
  a: number;
  h: number;
  w: number;
  t: number;
}

const L = (kind: LampKind, face: LampFace, circle: boolean, a: number, h: number, w: number, t: number): LampDef => ({
  kind, face, circle, a, h, w, t,
});

export function lampsFor(B: BodyLayout, sec: SectionLayout): LampDef[] {
  const W = B.hw * 2;
  const out: LampDef[] = [];
  const both = (d: LampDef, other: LampKind = d.kind) => {
    out.push(d);
    out.push({ ...d, a: W - d.a, kind: other });
  };
  const Lb = sec.bodyRear - sec.bodyFront;
  const metro = B.type === 'metro';
  if (sec.isFront) {
    if (metro) {
      both(L('head', 'front', true, 0.25, 0.66, 0.11, 0.11));
      both(L('head', 'front', true, 0.43, 0.66, 0.11, 0.11));
      both(L('drl', 'front', false, 0.34, 0.525, 0.38, 0.024));
      both(L('indR', 'front', false, 0.15, 0.72, 0.06, 0.08), 'indL');
      both(L('markerF', 'front', true, 0.32, 3.0, 0.05, 0.05));
    } else {
      both(L('head', 'front', true, 0.3, 0.835, 0.085, 0.085));
      both(L('head', 'front', true, 0.44, 0.835, 0.085, 0.085));
      both(L('drl', 'front', false, 0.34, 0.762, 0.46, 0.016));
      both(L('indR', 'front', false, 0.155, 0.835, 0.07, 0.07), 'indL');
      both(L('markerF', 'front', true, 0.2, 2.86, 0.06, 0.06));
    }
    out.push(L('indL', 'left', false, 0.65, metro ? 0.8 : 0.97, 0.07, 0.035));
    out.push(L('indR', 'right', false, 0.65, metro ? 0.8 : 0.97, 0.07, 0.035));
  }
  if (sec.isRear) {
    const hb = metro ? 1.13 : 1.075;
    both(L('indL', 'rear', false, 0.16, metro ? 1.41 : 1.36, 0.17, 0.2), 'indR');
    both(L('tail', 'rear', false, 0.16, hb, 0.17, 0.29));
    both(L('brake', 'rear', false, 0.16, hb, 0.17, 0.29));
    both(L('reverse', 'rear', false, 0.16, metro ? 0.86 : 0.8, 0.17, 0.17));
    both(L('markerR', 'rear', true, 0.14, B.yTop - 0.12, 0.055, 0.055));
    out.push(L('brake', 'rear', false, W / 2, B.yTop - 0.14, 0.6, 0.035));
  }
  // side markers and mid repeaters
  for (let s = 1.6; s < Lb - 0.8; s += metro ? 2.4 : 2.8) {
    out.push(L('markerS', 'left', false, s, metro ? 0.46 : 0.43, 0.06, 0.035));
    out.push(L('markerS', 'right', false, s, metro ? 0.46 : 0.43, 0.06, 0.035));
  }
  if (!metro || sec.index === 1) {
    const s = metro ? 0.9 : 4.4;
    out.push(L('indL', 'left', false, s, 0.5, 0.07, 0.035));
    out.push(L('indR', 'right', false, s, 0.5, 0.07, 0.035));
  }
  return out;
}

export const LAMP_ON: Record<LampKind, RGB> = {
  head: [1, 0.97, 0.9],
  drl: [0.92, 0.96, 1],
  tail: [0.7, 0.02, 0.02],
  brake: [1, 0.06, 0.04],
  indL: [1, 0.5, 0.04],
  indR: [1, 0.5, 0.04],
  reverse: [1, 1, 1],
  markerF: [1, 0.9, 0.7],
  markerR: [0.8, 0.03, 0.02],
  markerS: [1, 0.55, 0.08],
};

export const LAMP_OFF: Record<LampKind, string> = {
  head: '#cfd4da',
  drl: '#dde2e8',
  tail: '#6e0b10',
  brake: '#6e0b10',
  indL: '#c47a18',
  indR: '#c47a18',
  reverse: '#d4d6d8',
  markerF: '#e8e3d6',
  markerR: '#7a0c12',
  markerS: '#d08a20',
};

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3(0, 1, 0);

/** Position and outward normal (section-local) of a lamp centre on the body surface. */
export function lampFrame(B: BodyLayout, sec: SectionLayout, d: LampDef, lift: number, outC: THREE.Vector3, outN: THREE.Vector3): void {
  const r = ringAt(B, sec, d.h);
  const zOff = -sec.axleFromFront;
  if (d.face === 'front' || d.face === 'rear') {
    const x = d.face === 'front' ? B.hw - d.a : d.a - B.hw;
    const rad = d.face === 'front' ? r.rf : r.rr;
    const inner = r.hw - rad;
    const ax = Math.abs(x);
    let dz = 0;
    let nx = 0;
    let nz = 1;
    if (ax > inner) {
      const dx = Math.min(rad, ax - inner);
      const c = Math.sqrt(Math.max(0, rad * rad - dx * dx));
      dz = rad - c;
      nx = (dx / rad) * Math.sign(x);
      nz = c / rad;
    }
    if (d.face === 'front') {
      outC.set(x, d.h, r.zf + dz + zOff);
      outN.set(nx, 0, -nz).normalize();
    } else {
      outC.set(x, d.h, r.zr - dz + zOff);
      outN.set(nx, 0, nz).normalize();
    }
  } else {
    const sgn = d.face === 'left' ? -1 : 1;
    outC.set(sgn * r.hw, d.h, sec.bodyFront + d.a + zOff);
    outN.set(sgn, 0, 0);
  }
  outC.addScaledVector(outN, lift);
}

/** Merged glow geometry for the given lamp kinds (vertex coloured). */
export function lampGeometry(B: BodyLayout, sec: SectionLayout, kinds: LampKind[], lift = 0.007, grow = 1): THREE.BufferGeometry | null {
  const defs = lampsFor(B, sec).filter((d) => kinds.includes(d.kind));
  if (!defs.length) return null;
  const gb = new GeoBuilder();
  for (const d of defs) {
    lampFrame(B, sec, d, lift, _c, _n);
    _r.crossVectors(_u, _n).normalize();
    const col = LAMP_ON[d.kind];
    const w = (d.w / 2) * grow;
    const t = (d.t / 2) * grow;
    if (d.circle) {
      const seg = 14;
      const c0 = gb.vertex(_c.x, _c.y, _c.z, _n.x, _n.y, _n.z, 0.5, 0.5, col);
      const first = gb.count;
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const ca = Math.cos(a) * w;
        const sa = Math.sin(a) * t;
        gb.vertex(_c.x + _r.x * ca, _c.y + sa, _c.z + _r.z * ca, _n.x, _n.y, _n.z, 0, 0, col);
      }
      for (let i = 0; i < seg; i++) gb.tri(c0, first + i, first + ((i + 1) % seg));
    } else {
      const p = (sx: number, sy: number) => ({ x: _c.x + _r.x * sx * w, y: _c.y + sy * t, z: _c.z + _r.z * sx * w });
      gb.quad(p(-1, -1), p(1, -1), p(1, 1), p(-1, 1), col);
    }
  }
  return gb.build();
}
