/** Generic merged-geometry builder in map coordinates (x east, y north, h up). */
import * as THREE from 'three';
import { Buf, f32, u32, u8 } from './util';

export interface AttrSpec {
  name: string;
  size: number;
  type: 'f32' | 'u8';
  normalized?: boolean;
}

export class MeshGeo {
  readonly pos = f32(1 << 14);
  /** Face normals (last face wins on shared vertices); used for shadow bias and smooth-free lighting. */
  readonly nrm = f32(1 << 14);
  readonly idx = u32(1 << 14);
  private readonly bufs: Buf<Float32Array | Uint8Array>[];
  constructor(readonly spec: AttrSpec[]) {
    this.bufs = spec.map((s) => (s.type === 'f32' ? f32(1 << 13) : u8(1 << 13)) as Buf<Float32Array | Uint8Array>);
  }
  get count(): number {
    return this.pos.len / 3;
  }
  /** Add a vertex; `a` holds the attribute values in spec order. */
  vert(x: number, h: number, y: number, ...a: number[]): number {
    const i = this.count;
    this.pos.push3(x, h, -y);
    this.nrm.push3(0, 1, 0);
    let k = 0;
    for (let s = 0; s < this.spec.length; s++) {
      const b = this.bufs[s];
      for (let c = 0; c < this.spec[s].size; c++) b.push(a[k++] ?? 0);
    }
    return i;
  }
  /** Triangle oriented so its normal points along (fx, fy, fz) in three.js space. */
  tri(a: number, b: number, c: number, fx: number, fy: number, fz: number): void {
    const p = this.pos.arr;
    const ax = p[3 * b] - p[3 * a];
    const ay = p[3 * b + 1] - p[3 * a + 1];
    const az = p[3 * b + 2] - p[3 * a + 2];
    const bx = p[3 * c] - p[3 * a];
    const by = p[3 * c + 1] - p[3 * a + 1];
    const bz = p[3 * c + 2] - p[3 * a + 2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    if (nx * fx + ny * fy + nz * fz >= 0) this.idx.push3(a, b, c);
    else {
      this.idx.push3(a, c, b);
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-12) {
      const n = this.nrm.arr;
      for (const v of [a, b, c]) {
        n[3 * v] = nx / l;
        n[3 * v + 1] = ny / l;
        n[3 * v + 2] = nz / l;
      }
    }
  }
  /** Quad a-b-c-d (in order around its edge) facing (fx, fy, fz). */
  quad(a: number, b: number, c: number, d: number, fx: number, fy: number, fz: number): void {
    this.tri(a, b, c, fx, fy, fz);
    this.tri(a, c, d, fx, fy, fz);
  }
  /** Override the normal of some vertices (e.g. smooth ground strips). */
  setNormal(v: number, nx: number, ny: number, nz: number): void {
    const n = this.nrm.arr;
    n[3 * v] = nx;
    n[3 * v + 1] = ny;
    n[3 * v + 2] = nz;
  }
  /** Quad facing up. */
  up(a: number, b: number, c: number, d: number): void {
    this.quad(a, b, c, d, 0, 1, 0);
  }
  /**
   * Axis-aligned-in-local-frame box: centre (x, y) at heights h0..h1, half
   * sizes along unit direction (ux, uy) and its left normal. Attributes per vertex.
   */
  box(x: number, y: number, h0: number, h1: number, ux: number, uy: number, hl: number, hw: number, ...a: number[]): void {
    const vx = -uy;
    const vy = ux;
    const cs: [number, number][] = [
      [-hl, -hw],
      [hl, -hw],
      [hl, hw],
      [-hl, hw],
    ];
    const lo: number[] = [];
    const hi: number[] = [];
    for (const [p, q] of cs) {
      lo.push(this.vert(x + ux * p + vx * q, h0, y + uy * p + vy * q, ...a));
      hi.push(this.vert(x + ux * p + vx * q, h1, y + uy * p + vy * q, ...a));
    }
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const [p, q] = cs[i];
      const [p2, q2] = cs[j];
      const mx = ux * (p + p2) * 0.5 + vx * (q + q2) * 0.5;
      const my = uy * (p + p2) * 0.5 + vy * (q + q2) * 0.5;
      this.quad(lo[i], lo[j], hi[j], hi[i], mx, 0, -my);
    }
    this.quad(hi[0], hi[1], hi[2], hi[3], 0, 1, 0);
    this.quad(lo[0], lo[1], lo[2], lo[3], 0, -1, 0);
  }
  /** Box between two points (a beam), square section of half-size r. */
  beam(ax: number, ah: number, ay: number, bx: number, bh: number, by: number, r: number, ...a: number[]): void {
    // three.js space vectors
    const A = new THREE.Vector3(ax, ah, -ay);
    const B = new THREE.Vector3(bx, bh, -by);
    const d = B.clone().sub(A);
    const len = d.length();
    if (len < 1e-4) return;
    d.divideScalar(len);
    const up = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const s1 = new THREE.Vector3().crossVectors(d, up).normalize().multiplyScalar(r);
    const s2 = new THREE.Vector3().crossVectors(d, s1).normalize().multiplyScalar(r);
    const corners = [
      s1.clone().add(s2),
      s1.clone().sub(s2),
      s1.clone().negate().sub(s2),
      s1.clone().negate().add(s2),
    ];
    const ia: number[] = [];
    const ib: number[] = [];
    for (const c of corners) {
      ia.push(this.vert(A.x + c.x, A.y + c.y, -(A.z + c.z), ...a));
      ib.push(this.vert(B.x + c.x, B.y + c.y, -(B.z + c.z), ...a));
    }
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const m = corners[i].clone().add(corners[j]);
      this.quad(ia[i], ia[j], ib[j], ib[i], m.x, m.y, m.z);
    }
    this.quad(ia[0], ia[1], ia[2], ia[3], -d.x, -d.y, -d.z);
    this.quad(ib[0], ib[1], ib[2], ib[3], d.x, d.y, d.z);
  }
  /** Vertical cylinder (n sides) from h0 to h1, radius r. */
  cylinder(x: number, y: number, h0: number, h1: number, r: number, n: number, ...a: number[]): void {
    const lo: number[] = [];
    const hi: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      lo.push(this.vert(x + Math.cos(t) * r, h0, y + Math.sin(t) * r, ...a));
      hi.push(this.vert(x + Math.cos(t) * r, h1, y + Math.sin(t) * r, ...a));
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const t = ((i + 0.5) / n) * Math.PI * 2;
      this.quad(lo[i], lo[j], hi[j], hi[i], Math.cos(t), 0, -Math.sin(t));
    }
    for (let i = 1; i + 1 < n; i++) this.tri(hi[0], hi[i], hi[i + 1], 0, 1, 0);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.take(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.take(), 3));
    this.spec.forEach((s, i) => g.setAttribute(s.name, new THREE.BufferAttribute(this.bufs[i].take(), s.size, s.normalized ?? false)));
    g.setIndex(new THREE.BufferAttribute(this.idx.take(), 1));
    g.computeBoundingSphere();
    return g;
  }
  get empty(): boolean {
    return this.idx.len === 0;
  }
}

/** Colour attribute spec used by simple vertex-coloured meshes. */
export const COLOR_SPEC: AttrSpec[] = [{ name: 'color', size: 3, type: 'u8', normalized: true }];

/** Split a 0xRRGGBB colour into three bytes. */
export function rgb(c: number): [number, number, number] {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}
