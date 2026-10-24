// Small helpers shared by the bus modules: a vertex-coloured geometry builder,
// canvas/texture helpers and a seeded RNG. Everything here is procedural.
import * as THREE from 'three';

export type RGB = [number, number, number];

/** '#rrggbb' or 0xrrggbb -> linear RGB triple (three.js working colour space). */
export function rgb(c: string | number): RGB {
  const col = new THREE.Color(c);
  return [col.r, col.g, col.b];
}

export function scaleRGB(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** Fake interior lighting baked into vertex colours (interiors are unlit). */
export function bakeShade(nx: number, ny: number, nz: number, y: number): number {
  // key light from above-front-left, fill from below; slight darkening near the floor
  const l1 = Math.max(0, nx * 0.25 + ny * 0.9 + nz * -0.35);
  const l2 = Math.max(0, -ny) * 0.12;
  const h = Math.min(1, Math.max(0, (y - 0.3) / 2.4));
  return (0.58 + 0.42 * l1 + l2) * (0.82 + 0.18 * h);
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();

/**
 * Accumulates triangles with position / normal / uv / colour, then builds one
 * BufferGeometry. Used to merge many small parts into a single draw call.
 */
export class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uvs: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /** When true, vertex colours get baked interior shading from the normal. */
  shade = false;
  /** Optional 4th colour channel (alpha), used for tinted glass. */
  alpha: number[] | null = null;

  get count(): number {
    return this.pos.length / 3;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: RGB, a = 1): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uvs.push(u, v);
    const k = this.shade ? bakeShade(nx, ny, nz, y) : 1;
    this.col.push(c[0] * k, c[1] * k, c[2] * k);
    if (this.alpha) this.alpha.push(a);
    return this.count - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Quad from 4 corners (counter-clockwise seen from the front). Flat normal. */
  quad(
    p0: THREE.Vector3Like,
    p1: THREE.Vector3Like,
    p2: THREE.Vector3Like,
    p3: THREE.Vector3Like,
    c: RGB,
    uv?: [number, number, number, number],
    a = 1,
  ): void {
    const ax = p1.x - p0.x, ay = p1.y - p0.y, az = p1.z - p0.z;
    const bx = p3.x - p0.x, by = p3.y - p0.y, bz = p3.z - p0.z;
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const [u0, v0, u1, v1] = uv ?? [0, 0, 1, 1];
    const i0 = this.vertex(p0.x, p0.y, p0.z, nx, ny, nz, u0, v0, c, a);
    const i1 = this.vertex(p1.x, p1.y, p1.z, nx, ny, nz, u1, v0, c, a);
    const i2 = this.vertex(p2.x, p2.y, p2.z, nx, ny, nz, u1, v1, c, a);
    const i3 = this.vertex(p3.x, p3.y, p3.z, nx, ny, nz, u0, v1, c, a);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  /** Axis-aligned box from min/max corners (all 6 faces, outward). */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: RGB, faces = 0b111111): void {
    const v = (x: number, y: number, z: number) => ({ x, y, z });
    if (faces & 1) this.quad(v(x1, y0, z1), v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), c); // +x
    if (faces & 2) this.quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0), c); // -x
    if (faces & 4) this.quad(v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0), v(x0, y1, z0), c); // +y
    if (faces & 8) this.quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1), c); // -y
    if (faces & 16) this.quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1), c); // +z
    if (faces & 32) this.quad(v(x1, y0, z0), v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), c); // -z
  }

  /** Append a three.js geometry transformed by `m`, painted with colour `c`. */
  add(g: THREE.BufferGeometry, m: THREE.Matrix4, c: RGB, uvRect?: [number, number, number, number], a = 1): void {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const t = g.getAttribute('uv');
    _nm.getNormalMatrix(m);
    const base = this.count;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(m);
      if (n) _n.fromBufferAttribute(n, i).applyMatrix3(_nm).normalize();
      else _n.set(0, 1, 0);
      let u = 0, w = 0;
      if (t) {
        u = t.getX(i);
        w = t.getY(i);
        if (uvRect) {
          u = uvRect[0] + u * (uvRect[2] - uvRect[0]);
          w = uvRect[1] + w * (uvRect[3] - uvRect[1]);
        }
      }
      this.vertex(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, u, w, c, a);
    }
    if (g.index) {
      const ix = g.index;
      for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
    } else {
      for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    }
  }

  /** Cylinder between two points (for poles, rails, arms). */
  rod(a: THREE.Vector3, b: THREE.Vector3, r: number, c: RGB, seg = 8): void {
    const len = a.distanceTo(b);
    if (len < 1e-5) return;
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
    const dir = _v.subVectors(b, a).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    this.add(g, m, c);
    g.dispose();
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    if (this.alpha) {
      const c4: number[] = [];
      for (let i = 0; i < this.count; i++) c4.push(this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2], this.alpha[i]);
      g.setAttribute('color', new THREE.Float32BufferAttribute(c4, 4));
    } else {
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    }
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export function mat4(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
    new THREE.Vector3(sx, sy, sz),
  );
}

// ---------------------------------------------------------------------------
// Canvas helpers

export function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return { canvas, ctx };
}

export function canvasTexture(canvas: HTMLCanvasElement, srgb = true, mips = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
