// Exterior parts other than the painted shell.
import * as THREE from 'three';
import { BELLOWS, type BodyLayout, type SectionLayout } from './spec';
import { frontZ, rearZ, ringAt, sideX } from './shell';
import { SIGN_UV } from './sign';
import type { Livery } from './livery';
import { GeoBuilder, mat4, rgb, type RGB } from './util';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------
// Wheels

/** Wheel in its own frame: axle along X, outer face toward +X, radius R. */
export function wheelGeometry(R: number, width: number, seg: number): THREE.BufferGeometry {
  const gb = new GeoBuilder();
  const white: RGB = [1, 1, 1];
  const tread = new THREE.CylinderGeometry(R, R, width, seg, 1, true);
  gb.add(tread, mat4(0, 0, 0, 0, 0, Math.PI / 2), white, [0.5, 0, 1, 1]);
  // rounded shoulders
  const sh = new THREE.CylinderGeometry(R * 0.965, R, width * 0.08, seg, 1, true);
  gb.add(sh, mat4(width / 2 + width * 0.04, 0, 0, 0, 0, Math.PI / 2), white, [0.5, 0, 0.55, 0.1]);
  const face = new THREE.CircleGeometry(R * 0.965, seg);
  gb.add(face, mat4(width / 2 + width * 0.08, 0, 0, 0, Math.PI / 2, 0), white, [0, 0, 0.5, 1]);
  gb.add(face, mat4(-width / 2, 0, 0, 0, -Math.PI / 2, 0), white, [0, 0, 0.5, 1]);
  tread.dispose();
  sh.dispose();
  face.dispose();
  return gb.build();
}

export interface WheelSlot {
  x: number;
  z: number;
  steer: boolean;
  side: 1 | -1;
  dual: boolean;
}

export function wheelSlots(B: BodyLayout, sec: SectionLayout): WheelSlot[] {
  const out: WheelSlot[] = [];
  for (const ax of sec.axles) {
    for (const side of [1, -1] as const) {
      const x = side * (B.hw - (ax.dual ? 0.3 : 0.18));
      out.push({ x, z: ax.z - sec.axleFromFront, steer: ax.steer, side, dual: ax.dual });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Underbody, wheel housings, door wells, mud flaps (dark, double sided)

export function buildDark(B: BodyLayout, sec: SectionLayout, opts: { underbody?: boolean; doorWells: boolean; staticWheels: boolean; lowTrim?: Livery | null }): THREE.BufferGeometry {
  const gb = new GeoBuilder();
  const zo = -sec.axleFromFront;
  const dark: RGB = rgb('#141517');
  const housing: RGB = rgb('#0d0e10');
  const hw = B.hw;
  const under = opts.underbody !== false;
  // underside
  if (under) gb.quad(
    V(-hw + 0.05, 0.31, sec.bodyFront + 0.15 + zo),
    V(hw - 0.05, 0.31, sec.bodyFront + 0.15 + zo),
    V(hw - 0.05, 0.31, sec.bodyRear - 0.15 + zo),
    V(-hw + 0.05, 0.31, sec.bodyRear - 0.15 + zo),
    dark,
  );
  for (const ax of under ? sec.axles : []) {
    const z0 = ax.z - 0.68 + zo, z1 = ax.z + 0.68 + zo;
    const top = B.tyreR + 0.62;
    for (const s of [1, -1]) {
      const xo = s * (hw - 0.03), xi = s * (hw - 0.56);
      const [xa, xb] = s > 0 ? [xi, xo] : [xo, xi];
      gb.box(xa, 0.28, z0, xb, top, z1, housing, (s > 0 ? 2 : 1) | 4 | 16 | 32);
      // mud flap behind the wheel
      gb.quad(V(xa + 0.02, 0.12, z1 - 0.02), V(xb - 0.02, 0.12, z1 - 0.02), V(xb - 0.02, 0.4, z1 - 0.02), V(xa + 0.02, 0.4, z1 - 0.02), rgb('#0a0a0b'));
    }
    // axle beam
    gb.box(-hw + 0.5, B.tyreR - 0.06, ax.z - 0.07 + zo, hw - 0.5, B.tyreR + 0.06, ax.z + 0.07 + zo, dark);
  }
  if (opts.doorWells) {
    for (const d of sec.doors) {
      const z0 = d.z0 + zo, z1 = d.z1 + zo;
      const x0 = -hw + 0.03, x1 = -hw + 0.8;
      const wall: RGB = rgb('#2a2d31');
      gb.box(x0, 0.3, z0, x1, B.doorTop, z1, wall, 1 | 4 | 16 | 32);
      gb.quad(V(x0 + 0.01, 0.34, z1), V(x0 + 0.01, 0.34, z0), V(x1, 0.34, z0), V(x1, 0.34, z1), rgb('#4b4f55'));
      gb.quad(V(x0 + 0.01, 0.345, z1), V(x0 + 0.01, 0.345, z0), V(x0 + 0.07, 0.345, z0), V(x0 + 0.07, 0.345, z1), rgb('#e2b400'));
      for (const z of [z0 + 0.06, z1 - 0.06]) gb.rod(V(x0 + 0.12, 0.34, z), V(x0 + 0.12, B.doorTop - 0.05, z), 0.02, rgb('#f2c400'), 6);
    }
  }
  if (opts.staticWheels) {
    const tyre: RGB = rgb('#18181a');
    const hub: RGB = rgb('#9a9fa6');
    for (const w of wheelSlots(B, sec)) {
      const width = w.dual ? 0.54 : 0.28;
      const cyl = new THREE.CylinderGeometry(B.tyreR, B.tyreR, width, 12, 1, false);
      gb.add(cyl, mat4(w.x, B.tyreR, w.z, 0, 0, Math.PI / 2), tyre);
      const disc = new THREE.CircleGeometry(B.tyreR * 0.58, 10);
      gb.add(disc, mat4(w.x + w.side * (width / 2 + 0.005), B.tyreR, w.z, 0, (w.side * Math.PI) / 2, 0), hub);
      cyl.dispose();
      disc.dispose();
    }
  }
  if (opts.lowTrim) addTrim(gb, B, sec, opts.lowTrim, true);
  return gb.build();
}

// ---------------------------------------------------------------------------
// Trim: mirrors, wipers, bike rack, roof pods, antennas

function roundedSlab(w: number, l: number, h: number, r: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const x0 = -w / 2, x1 = w / 2, y0 = -l / 2, y1 = l / 2;
  s.moveTo(x0 + r, y0);
  s.lineTo(x1 - r, y0);
  s.quadraticCurveTo(x1, y0, x1, y0 + r);
  s.lineTo(x1, y1 - r);
  s.quadraticCurveTo(x1, y1, x1 - r, y1);
  s.lineTo(x0 + r, y1);
  s.quadraticCurveTo(x0, y1, x0, y1 - r);
  s.lineTo(x0, y0 + r);
  s.quadraticCurveTo(x0, y0, x0 + r, y0);
  const bev = Math.min(0.06, h * 0.45);
  const g = new THREE.ExtrudeGeometry(s, { depth: h - bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev * 0.9, bevelSegments: 2, curveSegments: 3 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, bev, 0);
  return g;
}

export function addTrim(gb: GeoBuilder, B: BodyLayout, sec: SectionLayout, lv: Livery, low: boolean): void {
  const zo = -sec.axleFromFront;
  const hw = B.hw;
  const metro = B.type === 'metro';
  const black: RGB = rgb('#18191c');
  const white: RGB = rgb('#eceeef');
  // roof pods
  for (const pod of sec.roofPods) {
    const g = roundedSlab(pod.w, pod.z1 - pod.z0, pod.h, Math.min(0.35, pod.w * 0.2));
    gb.add(g, mat4(0, B.yTop - 0.02, (pod.z0 + pod.z1) / 2 + zo), pod.dark ? rgb('#3a3e44') : white);
    g.dispose();
    if (!low && !pod.dark) {
      // A/C condenser grilles / fairing seams
      const n = Math.max(1, Math.floor((pod.z1 - pod.z0) / 1.4));
      for (let i = 0; i < n; i++) {
        const zc = pod.z0 + ((i + 0.5) * (pod.z1 - pod.z0)) / n + zo;
        gb.box(-pod.w * 0.3, B.yTop + pod.h - 0.005, zc - 0.32, pod.w * 0.3, B.yTop + pod.h + 0.003, zc + 0.32, rgb('#7d848c'), 4);
      }
    }
    if (pod.dark && !low) {
      // TOSA charging receiver arm
      gb.rod(V(0, B.yTop + pod.h, pod.z0 + 0.2 + zo), V(0, B.yTop + pod.h + 0.18, pod.z0 + 0.7 + zo), 0.04, rgb('#55595f'), 6);
      gb.box(-0.45, B.yTop + pod.h + 0.15, pod.z0 + 0.55 + zo, 0.45, B.yTop + pod.h + 0.22, pod.z0 + 0.85 + zo, rgb('#2a2d31'));
    }
  }
  if (!sec.isFront) return;
  // mirrors (rams-horn on the Optimus, short stalks on the Metro)
  const housing = lv.mirror;
  for (const s of [1, -1]) {
    const zf = frontZ(B, sec, 2.6);
    if (metro) {
      const base = V(s * (hw - 0.03), 2.35, zf + 0.25 + zo);
      const head = V(s * (hw + 0.2), 2.3, zf - 0.05 + zo);
      gb.rod(base, head, 0.025, black, 6);
      gb.box(head.x - 0.1, head.y - 0.16, head.z - 0.04, head.x + 0.1, head.y + 0.16, head.z + 0.04, black);
      if (!low) gb.quad(V(head.x - 0.085, head.y - 0.14, head.z + 0.042), V(head.x + 0.085, head.y - 0.14, head.z + 0.042), V(head.x + 0.085, head.y + 0.14, head.z + 0.042), V(head.x - 0.085, head.y + 0.14, head.z + 0.042), rgb('#556677'));
    } else {
      const p0 = V(s * (hw - 0.04), 2.96, zf + 0.32 + zo);
      const p1 = V(s * (hw + 0.08), 2.99, zf + 0.0 + zo);
      const p2 = V(s * (hw + 0.17), 2.86, zf - 0.28 + zo);
      const p3 = V(s * (hw + 0.17), 2.68, zf - 0.36 + zo);
      gb.rod(p0, p1, 0.022, black, 6);
      gb.rod(p1, p2, 0.022, black, 6);
      gb.rod(p2, p3, 0.022, black, 6);
      const hx = s * (hw + 0.17), hy = 2.44, hz = zf - 0.37 + zo;
      const g = roundedSlab(0.22, 0.38, 0.09, 0.05);
      // slab is flat in XZ; stand it up so its large faces look forward/back
      gb.add(g, new THREE.Matrix4().makeTranslation(hx, hy, hz).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)).multiply(new THREE.Matrix4().makeTranslation(0, -0.045, 0)), housing);
      g.dispose();
      if (!low) gb.quad(V(hx - 0.09, hy - 0.16, hz + 0.047), V(hx + 0.09, hy - 0.16, hz + 0.047), V(hx + 0.09, hy + 0.16, hz + 0.047), V(hx - 0.09, hy + 0.16, hz + 0.047), rgb('#4f6070'));
    }
  }
  if (low) return;
  // wipers parked along the bottom of the windscreen
  const hW = metro ? 1.0 : 1.15;
  const zw = frontZ(B, sec, hW) - 0.025 + zo;
  for (const s of [1, -1]) {
    gb.rod(V(s * 0.62, hW, zw), V(s * 0.62 - s * 0.92, hW + 0.05, zw - 0.005), 0.012, black, 5);
    gb.box(s * 0.62 - 0.03, hW - 0.03, zw - 0.02, s * 0.62 + 0.03, hW + 0.03, zw + 0.02, black);
  }
  // antennas
  gb.rod(V(0.4, B.yTop, 0.8 + zo), V(0.42, B.yTop + 0.16, 0.86 + zo), 0.008, black, 4);
  gb.box(-0.5, B.yTop - 0.01, 0.9 + zo, -0.36, B.yTop + 0.03, 1.02 + zo, black);
  if (!metro) {
    // folded bike rack (Brisbane buses carry 2-bike front racks)
    const zr = frontZ(B, sec, 0.7) - 0.12 + zo;
    const rack: RGB = rgb('#1d1f23');
    const alu: RGB = rgb('#a9aeb4');
    gb.box(-0.86, 0.5, zr - 0.05, 0.86, 0.57, zr + 0.04, rack);
    gb.box(-0.86, 0.94, zr - 0.05, 0.86, 1.0, zr + 0.04, rack);
    gb.box(-0.82, 0.565, zr - 0.04, 0.82, 0.585, zr + 0.03, alu);
    gb.box(-0.82, 0.995, zr - 0.04, 0.82, 1.015, zr + 0.03, alu);
    for (const x of [-0.84, 0.84, -0.2, 0.2]) gb.rod(V(x, 0.44, zr), V(x, 1.0, zr), 0.018, rack, 6);
    for (const x of [-0.5, 0.5]) gb.box(x - 0.04, 0.42, zr, x + 0.04, 0.48, zr + 0.13, rack);
  }
}

export function buildTrim(B: BodyLayout, sec: SectionLayout, lv: Livery): THREE.BufferGeometry {
  const gb = new GeoBuilder();
  addTrim(gb, B, sec, lv, false);
  return gb.build();
}

// ---------------------------------------------------------------------------
// Destination sign quads

export function buildSignGeometry(B: BodyLayout, sec: SectionLayout, parts: ('front' | 'side' | 'rear')[]): THREE.BufferGeometry | null {
  const gb = new GeoBuilder();
  const zo = -sec.axleFromFront;
  const W = B.hw * 2;
  const metro = B.type === 'metro';
  const white: RGB = [1, 1, 1];
  if (parts.includes('front') && sec.isFront) {
    const [h0, h1] = metro ? [2.45, 2.67] : [2.755, 2.965];
    const half = metro ? W / 2 - 0.36 : W / 2 - 0.3;
    // follow the curved front in strips so the shell never pokes through
    const [u0, v0, u1, v1] = SIGN_UV.front;
    const n = 6;
    for (let k = 0; k < n; k++) {
      const ha = h0 + ((h1 - h0) * k) / n, hb = h0 + ((h1 - h0) * (k + 1)) / n;
      const za = frontZ(B, sec, ha) - 0.007 + zo, zb = frontZ(B, sec, hb) - 0.007 + zo;
      const va = v0 + ((v1 - v0) * k) / n, vb = v0 + ((v1 - v0) * (k + 1)) / n;
      // viewer's left (u0) is the bus right (+x)
      gb.quad(V(half, ha, za), V(-half, ha, za), V(-half, hb, zb), V(half, hb, zb), white, [u0, va, u1, vb]);
    }
  }
  if (parts.includes('side') && sec.isFront) {
    const [s0, s1, h0, h1] = metro ? [2.0, 3.38, 2.42, 2.65] : [1.62, 3.0, 2.24, 2.47];
    const x0 = -(sideX(B, sec, h0) + 0.005), x1 = -(sideX(B, sec, h1) + 0.005);
    // left side, viewed from -x: viewer's left is the front
    gb.quad(V(x0, h0, s0 + zo), V(x0, h0, s1 + zo), V(x1, h1, s1 + zo), V(x1, h1, s0 + zo), white, SIGN_UV.side);
  }
  if (parts.includes('rear') && sec.isRear) {
    const [h0, h1] = [2.52, 2.77];
    const z0 = rearZ(B, sec, h0) + 0.006 + zo, z1 = rearZ(B, sec, h1) + 0.006 + zo;
    gb.quad(V(-0.25, h0, z0), V(0.25, h0, z0), V(0.25, h1, z1), V(-0.25, h1, z1), white, SIGN_UV.rear);
  }
  return gb.count ? gb.build() : null;
}

// ---------------------------------------------------------------------------
// Door leaves

export interface LeafSlot {
  /** Hinge / reference point (section local). */
  hinge: THREE.Vector3;
  /** +1 if the leaf extends toward +z from its hinge, -1 toward -z. */
  dir: 1 | -1;
  width: number;
  height: number;
  yc: number;
  style: 'swing' | 'slide';
}

export function leafSlots(B: BodyLayout, sec: SectionLayout): LeafSlot[] {
  const zo = -sec.axleFromFront;
  const out: LeafSlot[] = [];
  const y0 = B.y0 + 0.04, y1 = B.doorTop - 0.03;
  const x = -(sideX(B, sec, 1.5) - 0.02);
  for (const d of sec.doors) {
    const w = (d.z1 - d.z0) / 2 - 0.01;
    out.push({ hinge: V(x, 0, d.z0 + 0.01 + zo), dir: 1, width: w, height: y1 - y0, yc: (y0 + y1) / 2, style: d.style });
    out.push({ hinge: V(x, 0, d.z1 - 0.01 + zo), dir: -1, width: w, height: y1 - y0, yc: (y0 + y1) / 2, style: d.style });
  }
  return out;
}

const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

/** Leaf matrix for opening fraction t (0 closed .. 1 open). Leaf geometry is a unit box. */
export function leafMatrix(slot: LeafSlot, t: number, out: THREE.Matrix4): THREE.Matrix4 {
  const k = Math.max(0, Math.min(1, t));
  if (slot.style === 'swing') {
    const out1 = Math.min(1, k * 3) * 0.07;
    const ang = Math.max(0, (k - 0.1) / 0.9) * 1.45;
    const phi = slot.dir > 0 ? -ang : ang;
    _q.setFromEuler(_e.set(0, phi, 0));
    // leaf centre relative to hinge (along its own z)
    _p.set(0, 0, (slot.dir * slot.width) / 2).applyQuaternion(_q);
    _p.x += slot.hinge.x - out1;
    _p.y = slot.yc;
    _p.z += slot.hinge.z;
  } else {
    const out1 = Math.min(1, k * 4) * 0.09;
    const slide = Math.max(0, (k - 0.25) / 0.75) * slot.width * 0.96;
    _q.identity();
    _p.set(slot.hinge.x - out1, slot.yc, slot.hinge.z + (slot.dir * slot.width) / 2 - slot.dir * slide);
  }
  _s.set(1, slot.height, slot.width * slot.dir);
  return out.compose(_p, _q, _s);
}

/** Unit door leaf (thickness 0.035 m, height 1, width 1). u = 1 is the meeting edge. */
export function leafGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.035, 1, 1);
  return g;
}

// ---------------------------------------------------------------------------
// Bellows (Metro): rings between two section faces, rebuilt each frame.

const PROFILE_N = 22;
const RINGS = 25;

function bellowsProfile(B: BodyLayout): [number, number, number, number][] {
  // [x, y, nx, ny] around the cross-section, bottom-left -> top -> bottom-right
  const out: [number, number, number, number][] = [];
  const hw = B.hw - 0.06;
  const yb = 0.34, yt = B.yTop - 0.08;
  const r = 0.26;
  out.push([-hw, yb, -1, 0]);
  for (let i = 0; i <= 5; i++) out.push([-hw, yb + ((yt - r - yb) * i) / 5, -1, 0]);
  for (let i = 1; i <= 4; i++) {
    const a = Math.PI - (i / 4) * (Math.PI / 2);
    out.push([-hw + r + Math.cos(a) * r, yt - r + Math.sin(a) * r, Math.cos(a), Math.sin(a)]);
  }
  for (let i = 1; i <= 4; i++) {
    const a = Math.PI / 2 - (i / 4) * (Math.PI / 2);
    out.push([hw - r + Math.cos(a) * r, yt - r + Math.sin(a) * r, Math.cos(a), Math.sin(a)]);
  }
  for (let i = 1; i <= 5; i++) out.push([hw, yt - r - ((yt - r - yb) * i) / 5, 1, 0]);
  // floor (turntable plate) back across
  out.push([hw, yb, 0, 1]);
  out.push([-hw, yb, 0, 1]);
  return out.slice(0, PROFILE_N);
}

export class Bellows {
  readonly geometry: THREE.BufferGeometry;
  private readonly prof: [number, number, number, number][];
  private readonly pos: Float32Array;
  private readonly nor: Float32Array;
  constructor(B: BodyLayout) {
    this.prof = bellowsProfile(B);
    const n = this.prof.length;
    this.pos = new Float32Array(RINGS * n * 3);
    this.nor = new Float32Array(RINGS * n * 3);
    const col = new Float32Array(RINGS * n * 3);
    const uv = new Float32Array(RINGS * n * 2);
    const idx: number[] = [];
    for (let k = 0; k < RINGS; k++) {
      for (let i = 0; i < n; i++) {
        const j = k * n + i;
        const floor = i >= n - 2;
        const c = floor ? [0.33, 0.34, 0.36] : k % 2 ? [0.48, 0.5, 0.54] : [0.8, 0.82, 0.86];
        col.set(c, j * 3);
        uv[j * 2] = k / (RINGS - 1);
        uv[j * 2 + 1] = i / (n - 1);
      }
    }
    for (let k = 0; k < RINGS - 1; k++) {
      for (let i = 0; i < n - 1; i++) {
        const a = k * n + i, b = a + 1, d = a + n, c = d + 1;
        idx.push(a, b, c, a, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.geometry = g;
    this.update(new THREE.Vector3(0, 0, -BELLOWS), 0, new THREE.Vector3(0, 0, 0));
  }

  /**
   * Fill the tube between the rear face of the section in front (centre `a`,
   * facing heading offset `angle` relative to this section, local frame) and
   * this section's front face centre `b` (facing straight ahead).
   */
  update(a: THREE.Vector3, angle: number, b: THREE.Vector3): void {
    const n = this.prof.length;
    const len = Math.max(0.05, a.distanceTo(b));
    for (let k = 0; k < RINGS; k++) {
      const t = k / (RINGS - 1);
      // Hermite from b (t=0, dir -z) to a (t=1, dir rotated by angle)
      const h00 = 2 * t ** 3 - 3 * t ** 2 + 1, h10 = t ** 3 - 2 * t ** 2 + t, h01 = -2 * t ** 3 + 3 * t ** 2, h11 = t ** 3 - t ** 2;
      const dax = Math.sin(angle), daz = -Math.cos(angle);
      const cx = h00 * b.x + h10 * len * 0 + h01 * a.x + h11 * len * dax;
      const cz = h00 * b.z + h10 * len * -1 + h01 * a.z + h11 * len * daz;
      const phi = angle * t;
      const rx = Math.cos(phi), rz = Math.sin(phi);
      const shrink = k % 2 ? 0.955 : 1;
      for (let i = 0; i < n; i++) {
        const [px, py, nx, ny] = this.prof[i];
        const floor = i >= n - 2;
        const sx = floor ? px : px * shrink;
        const sy = floor ? py : 0.34 + (py - 0.34) * (shrink === 1 ? 1 : 0.985);
        const j = (k * n + i) * 3;
        this.pos[j] = cx + rx * sx;
        this.pos[j + 1] = sy;
        this.pos[j + 2] = cz + rz * sx;
        this.nor[j] = rx * nx;
        this.nor[j + 1] = ny;
        this.nor[j + 2] = rz * nx;
      }
    }
    const g = this.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
    g.computeBoundingSphere();
  }
}

/** Static bellows for low detail: a straight corrugated tube of length 1 along z, centred. */
export function lowBellowsGeometry(B: BodyLayout): THREE.BufferGeometry {
  const gb = new GeoBuilder();
  const hw = B.hw - 0.06;
  const yb = 0.34, yt = B.yTop - 0.1;
  const N = 6;
  for (let k = 0; k < N; k++) {
    const z0 = -0.5 + k / N, z1 = -0.5 + (k + 1) / N;
    const c: RGB = k % 2 ? [0.5, 0.52, 0.56] : [0.78, 0.8, 0.84];
    gb.quad(V(hw, yb, z1), V(hw, yb, z0), V(hw, yt, z0), V(hw, yt, z1), c);
    gb.quad(V(-hw, yb, z0), V(-hw, yb, z1), V(-hw, yt, z1), V(-hw, yt, z0), c);
    gb.quad(V(-hw, yt, z1), V(hw, yt, z1), V(hw, yt, z0), V(-hw, yt, z0), c);
  }
  return gb.build();
}

export { ringAt };
