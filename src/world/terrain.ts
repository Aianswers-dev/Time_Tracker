/**
 * Terrain: the inner 10 m height grid (with roads carved/clamped into it) and
 * the outer 60 m horizon grid, meshed in chunks with distance LOD and skirts.
 *
 * `TerrainField.ren` starts as the natural ground and is lowered by road and
 * rail corridors (so the ground never covers a carriageway), and cells under
 * deep cuttings are removed (`hole`) so open cuttings are really open; the
 * corridor builder covers the hole edges with walls and cap strips.
 */
import * as THREE from 'three';
import { AreaKind, type MapData } from '../types';
import type { Ctx } from './ctx';
import { NOISE_GLSL, patch } from './shaders';
import { yieldFrame } from './util';

export class TerrainField {
  readonly x0: number;
  readonly y0: number;
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  readonly nat: Float32Array;
  readonly ren: Float32Array;
  /** Per cell ((nx-1) x (ny-1)): 1 = no ground here (open cutting). */
  readonly hole: Uint8Array;
  readonly ox0: number;
  readonly oy0: number;
  readonly ocell: number;
  readonly onx: number;
  readonly ony: number;
  readonly oh: Float32Array;
  readonly waterLevel: number;

  constructor(data: MapData) {
    const t = data.terrain;
    const inner = t.grids.find((g) => g.name === 'inner') ?? t.grids[0];
    const outer = t.grids.find((g) => g.name === 'outer') ?? t.grids[t.grids.length - 1];
    this.x0 = inner.x0;
    this.y0 = inner.y0;
    this.cell = inner.cell;
    this.nx = inner.nx;
    this.ny = inner.ny;
    this.nat = inner.h;
    this.ren = Float32Array.from(inner.h);
    this.hole = new Uint8Array((this.nx - 1) * (this.ny - 1));
    this.ox0 = outer.x0;
    this.oy0 = outer.y0;
    this.ocell = outer.cell;
    this.onx = outer.nx;
    this.ony = outer.ny;
    this.oh = outer.h;
    this.waterLevel = t.waterLevel;
  }

  /** Inner grid extent [x0, y0, x1, y1]. */
  get extent(): [number, number, number, number] {
    return [this.x0, this.y0, this.x0 + (this.nx - 1) * this.cell, this.y0 + (this.ny - 1) * this.cell];
  }

  inInner(x: number, y: number): boolean {
    const fx = (x - this.x0) / this.cell;
    const fy = (y - this.y0) / this.cell;
    return fx >= 0 && fy >= 0 && fx <= this.nx - 1 && fy <= this.ny - 1;
  }

  outerAt(x: number, y: number): number {
    const fx = Math.max(0, Math.min(this.onx - 1.001, (x - this.ox0) / this.ocell));
    const fy = Math.max(0, Math.min(this.ony - 1.001, (y - this.oy0) / this.ocell));
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const k = j * this.onx + i;
    const h = this.oh;
    return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - ty) + (h[k + this.onx] * (1 - tx) + h[k + this.onx + 1] * tx) * ty;
  }

  /** Natural ground (bilinear, as Heights.ground). */
  natAt(x: number, y: number): number {
    const fx = (x - this.x0) / this.cell;
    const fy = (y - this.y0) / this.cell;
    if (fx < 0 || fy < 0 || fx > this.nx - 1 || fy > this.ny - 1) return this.outerAt(x, y);
    const i = Math.min(this.nx - 2, Math.floor(fx));
    const j = Math.min(this.ny - 2, Math.floor(fy));
    const tx = fx - i;
    const ty = fy - j;
    const k = j * this.nx + i;
    const h = this.nat;
    return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - ty) + (h[k + this.nx] * (1 - tx) + h[k + this.nx + 1] * tx) * ty;
  }

  /** Rendered ground height, exactly matching the mesh triangulation (diagonal a-c). */
  renAt(x: number, y: number): number {
    const fx = (x - this.x0) / this.cell;
    const fy = (y - this.y0) / this.cell;
    if (fx < 0 || fy < 0 || fx > this.nx - 1 || fy > this.ny - 1) return this.outerAt(x, y);
    const i = Math.min(this.nx - 2, Math.floor(fx));
    const j = Math.min(this.ny - 2, Math.floor(fy));
    const tx = fx - i;
    const ty = fy - j;
    const k = j * this.nx + i;
    const h = this.ren;
    const a = h[k];
    const b = h[k + 1];
    const c = h[k + this.nx + 1];
    const d = h[k + this.nx];
    // triangles (a, b, c) where tx >= ty, else (a, c, d)
    if (tx >= ty) return a + (b - a) * tx + (c - b) * ty;
    return a + (c - d) * tx + (d - a) * ty;
  }

  /** True if (x, y) falls in a carved-out cell. */
  isHole(x: number, y: number): boolean {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((y - this.y0) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx - 1 || j >= this.ny - 1) return false;
    return this.hole[j * (this.nx - 1) + i] === 1;
  }

  /**
   * Lower rendered ground vertices that fall inside the convex quad (corners
   * in order, each [x, y, z]) to below the quad surface by `margin`.
   */
  clampQuad(q: number[], margin: number): void {
    const xs = [q[0], q[3], q[6], q[9]];
    const ys = [q[1], q[4], q[7], q[10]];
    const i0 = Math.max(0, Math.ceil((Math.min(...xs) - this.x0) / this.cell));
    const i1 = Math.min(this.nx - 1, Math.floor((Math.max(...xs) - this.x0) / this.cell));
    const j0 = Math.max(0, Math.ceil((Math.min(...ys) - this.y0) / this.cell));
    const j1 = Math.min(this.ny - 1, Math.floor((Math.max(...ys) - this.y0) / this.cell));
    if (i1 < i0 || j1 < j0) return;
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + j * this.cell;
      for (let i = i0; i <= i1; i++) {
        const x = this.x0 + i * this.cell;
        let z = triZ(q, 0, 3, 6, x, y);
        if (z === null) z = triZ(q, 0, 6, 9, x, y);
        if (z === null) continue;
        const k = j * this.nx + i;
        const v = z - margin;
        if (v < this.ren[k]) this.ren[k] = v;
      }
    }
  }

  /** Mark cells whose centre lies within `expand` metres of the convex quad (x, y corners) as holes. */
  holeQuad(q: number[], expand: number): void {
    const xs = [q[0], q[3], q[6], q[9]];
    const ys = [q[1], q[4], q[7], q[10]];
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - expand - this.x0) / c));
    const i1 = Math.min(this.nx - 2, Math.floor((Math.max(...xs) + expand - this.x0) / c));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - expand - this.y0) / c));
    const j1 = Math.min(this.ny - 2, Math.floor((Math.max(...ys) + expand - this.y0) / c));
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + (j + 0.5) * c;
      for (let i = i0; i <= i1; i++) {
        const x = this.x0 + (i + 0.5) * c;
        if (quadDist(q, x, y) <= expand) this.hole[j * (this.nx - 1) + i] = 1;
      }
    }
  }
}

/** z of point (x, y) on triangle (corners at q[a], q[b], q[c] as x,y,z triples) or null if outside. */
function triZ(q: number[], a: number, b: number, c: number, x: number, y: number): number | null {
  const ax = q[a];
  const ay = q[a + 1];
  const bx = q[b];
  const by = q[b + 1];
  const cx = q[c];
  const cy = q[c + 1];
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-9) return null;
  const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
  const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
  const l3 = 1 - l1 - l2;
  const e = -1e-6;
  if (l1 < e || l2 < e || l3 < e) return null;
  return l1 * q[a + 2] + l2 * q[b + 2] + l3 * q[c + 2];
}

function segD(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
}

/** Distance from point to convex quad (0 inside). Corners as x,y,z triples. */
function quadDist(q: number[], x: number, y: number): number {
  let inside = true;
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const a = k * 3;
    const b = ((k + 1) % 4) * 3;
    const cr = (q[b] - q[a]) * (y - q[a + 1]) - (q[b + 1] - q[a + 1]) * (x - q[a]);
    const s = Math.sign(cr);
    if (s !== 0) {
      if (sign === 0) sign = s;
      else if (s !== sign) inside = false;
    }
  }
  if (inside) return 0;
  let d = Infinity;
  for (let k = 0; k < 4; k++) {
    const a = k * 3;
    const b = ((k + 1) % 4) * 3;
    d = Math.min(d, segD(x, y, q[a], q[a + 1], q[b], q[b + 1]));
  }
  return d;
}

// ---------------------------------------------------------------------------
// Land cover texture (park, wood, sport, plaza weights) at 5 m

export function makeLandcover(data: MapData, R: [number, number, number, number]): { tex: THREE.Texture; rect: THREE.Vector4 } {
  const cell = 5;
  const w = Math.ceil((R[2] - R[0]) / cell);
  const h = Math.ceil((R[3] - R[1]) / cell);
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.globalCompositeOperation = 'lighter';
    return { c, g };
  };
  const A = mk();
  const B = mk();
  const path = (g: CanvasRenderingContext2D, rings: ArrayLike<number>[]) => {
    g.beginPath();
    for (const r of rings) {
      for (let i = 0; i < r.length; i += 2) {
        const px = (r[i] - R[0]) / cell;
        const py = (R[3] - r[i + 1]) / cell;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.closePath();
    }
    g.fill('evenodd');
  };
  for (const a of data.areas) {
    const rings = [a.pts, ...a.holes];
    switch (a.kind) {
      case AreaKind.Park:
        A.g.fillStyle = '#ff0000';
        path(A.g, rings);
        break;
      case AreaKind.Wood:
        A.g.fillStyle = '#00ff00';
        path(A.g, rings);
        break;
      case AreaKind.Sport:
        A.g.fillStyle = '#0000ff';
        path(A.g, rings);
        break;
      case AreaKind.Cemetery:
        A.g.fillStyle = '#ff0000';
        path(A.g, rings);
        break;
      case AreaKind.Plaza:
      case AreaKind.Sand:
        B.g.fillStyle = '#ff0000';
        path(B.g, rings);
        break;
    }
  }
  const da = A.g.getImageData(0, 0, w, h).data;
  const db = B.g.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  // flip rows so v = 0 is the south edge
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    const dst = y * w * 4;
    for (let x = 0; x < w; x++) {
      const s = src + x * 4;
      const d = dst + x * 4;
      out[d] = da[s];
      out[d + 1] = da[s + 1];
      out[d + 2] = da[s + 2];
      out[d + 3] = db[s];
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return { tex, rect: new THREE.Vector4(R[0], R[1], 1 / (w * cell), 1 / (h * cell)) };
}

// ---------------------------------------------------------------------------
// Material

const TERRAIN_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uDensity;
uniform vec4 uDensityRect;
uniform sampler2D uLand;
uniform vec4 uLandRect;
uniform sampler2D uOuter;
uniform vec4 uOuterRect;
uniform float uWaterLevel;
varying vec3 vGPos;
varying vec3 vGNrm;
${NOISE_GLSL}
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float w_aa(float v, float w, float fwv) { float f = max(fwv, 1e-3); return 1.0 - w_ss(w - f, w + f, v); }
vec3 lawnCol(vec4 n1, vec4 n2, vec4 n3) {
  vec3 green = vec3(0.35, 0.43, 0.24);
  vec3 dry = vec3(0.52, 0.50, 0.36);
  vec3 c = mix(green, dry, smoothstep(0.48, 0.8, n2.g + (n1.r - 0.5) * 0.35));
  c = mix(c, vec3(0.20, 0.27, 0.14), smoothstep(0.62, 0.72, n1.g) * 0.75);
  c = mix(c, vec3(0.28, 0.35, 0.19), smoothstep(0.6, 0.9, n2.b) * 0.6);
  return c * (0.86 + 0.28 * n3.r);
}
vec3 terrainAlbedo() {
  vec2 p = vec2(vGPos.x, -vGPos.z);
  vec4 n1 = texture2D(uNoise, p / 23.0);
  vec4 n2 = texture2D(uNoise, p / 190.0);
  vec4 n3 = texture2D(uNoise, p / 4.3);
  vec2 FWP = fwidth(p);
  vec3 lawn = lawnCol(n1, n2, n3);
  vec3 c;
#ifdef W_OUTER
  vec4 o = texture2D(uOuter, (p - uOuterRect.xy) * uOuterRect.zw);
  vec2 lot = p / vec2(17.0, 21.0);
  vec2 li = floor(lot);
  vec2 lf = fract(lot);
  float hsh = w_hash(li);
  float roof = step(0.18, lf.x) * step(lf.x, 0.78) * step(0.22, lf.y) * step(lf.y, 0.75) * step(hsh, 0.25 + o.r * 1.8 + 0.25);
  vec3 roofCol = hsh < 0.3 ? vec3(0.62, 0.62, 0.62) : hsh < 0.55 ? vec3(0.55, 0.30, 0.24) : hsh < 0.75 ? vec3(0.80, 0.80, 0.78) : vec3(0.40, 0.42, 0.44);
  float tree = smoothstep(0.55, 0.7, n1.g + n3.r * 0.3);
  vec3 sub = mix(lawn, roofCol, roof);
  sub = mix(sub, vec3(0.20, 0.30, 0.15), tree * 0.7);
  float far = smoothstep(2.0, 6.0, length(FWP));
  vec3 subAvg = mix(lawn, vec3(0.45, 0.42, 0.38), 0.35 + o.r * 0.4) * 0.85;
  sub = mix(sub, subAvg, far);
  vec3 forest = mix(vec3(0.17, 0.25, 0.12), vec3(0.24, 0.32, 0.16), n2.g) * (0.85 + 0.3 * n1.r);
  c = mix(sub, forest, smoothstep(0.3, 0.8, o.g));
  c = mix(c, vec3(0.32, 0.32, 0.33), smoothstep(0.5, 0.9, o.b) * 0.4);
#else
  vec4 lc = texture2D(uLand, (p - uLandRect.xy) * uLandRect.zw);
  float dens = texture2D(uDensity, (p - uDensityRect.xy) * uDensityRect.zw).r;
  vec3 conc = vec3(0.60, 0.59, 0.55) * (0.88 + 0.2 * n3.r) * (0.9 + 0.2 * n1.g);
  vec3 lotc = vec3(0.30, 0.30, 0.31) * (0.9 + 0.2 * n3.r);
  vec3 paved = mix(conc, lotc, smoothstep(0.55, 0.7, n2.r));
  c = mix(lawn, paved, smoothstep(0.10, 0.34, dens + (n2.g - 0.5) * 0.12));
  vec3 park = lawn * vec3(0.95, 1.06, 0.92);
  vec3 wood = mix(vec3(0.26, 0.31, 0.17), vec3(0.36, 0.30, 0.20), smoothstep(0.4, 0.7, n1.g)) * (0.8 + 0.35 * n3.r);
  float stripe = step(0.5, fract(p.x / 7.0 + p.y / 41.0));
  vec3 sport = vec3(0.33, 0.52, 0.22) * (0.92 + 0.1 * stripe) * (0.92 + 0.12 * n3.r);
  vec2 q = fract(p / 0.6);
  float joint = max(w_aa(0.5 - abs(q.x - 0.5), 0.03, FWP.x / 0.6), w_aa(0.5 - abs(q.y - 0.5), 0.03, FWP.y / 0.6));
  vec3 plaza = mix(vec3(0.70, 0.66, 0.60), vec3(0.58, 0.55, 0.50), n1.g * 0.6) * (0.94 + 0.12 * n3.r) * (1.0 - joint * 0.18);
  c = mix(c, park, smoothstep(0.2, 0.8, lc.r));
  c = mix(c, wood, smoothstep(0.2, 0.8, lc.g));
  c = mix(c, sport, smoothstep(0.2, 0.8, lc.b));
  c = mix(c, plaza, smoothstep(0.2, 0.8, lc.a));
#endif
  // steep banks and cuttings: bare earth; river margins: mud
  float steep = 1.0 - smoothstep(0.72, 0.9, normalize(vGNrm).y);
  vec3 earth = mix(vec3(0.42, 0.36, 0.27), vec3(0.33, 0.30, 0.25), n1.r) * (0.85 + 0.3 * n3.g);
  c = mix(c, earth, steep * 0.75);
  float bank = 1.0 - smoothstep(uWaterLevel + 0.3, uWaterLevel + 1.6, vGPos.y + (n1.g - 0.5) * 0.6);
  vec3 mud = mix(vec3(0.33, 0.29, 0.22), vec3(0.20, 0.18, 0.15), smoothstep(uWaterLevel + 0.2, uWaterLevel - 1.5, vGPos.y));
  c = mix(c, mud, bank);
  if (!gl_FrontFacing) c = vec3(0.16, 0.14, 0.12) * (0.8 + 0.4 * n3.r);
  return c;
}
`;

export function makeTerrainMaterial(ctx: Ctx, land: { tex: THREE.Texture; rect: THREE.Vector4 }, outer: boolean, depthBias = 0): THREE.MeshLambertMaterial {
  const d = ctx.density;
  const ex = ctx.extras;
  const outerRect = new THREE.Vector4(0, 0, 1, 1);
  if (ex) {
    const r = ex.raster;
    const yb = r.y1 - r.h * r.cell;
    outerRect.set(r.x0, yb, 1 / (r.w * r.cell), 1 / (r.h * r.cell));
  }
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: depthBias ? THREE.FrontSide : THREE.DoubleSide });
  return patch(mat, {
    key: outer ? 'terrain-outer' : depthBias ? 'terrain-strip' : 'terrain',
    depthBias,
    uniforms: {
      uNoise: { value: ctx.tex.noise },
      uDensity: { value: d.tex },
      uDensityRect: { value: new THREE.Vector4(d.x0, d.y0, 1 / (d.nx * d.cell), 1 / (d.ny * d.cell)) },
      uLand: { value: land.tex },
      uLandRect: { value: land.rect },
      uOuter: { value: ctx.outerTex ?? ctx.tex.noise },
      uOuterRect: { value: outerRect },
      uWaterLevel: { value: ctx.data.terrain.waterLevel },
    },
    defines: outer ? { W_OUTER: '' } : {},
    vertexPars: 'varying vec3 vGPos;\nvarying vec3 vGNrm;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvGNrm = objectNormal;']],
    fragmentPars: TERRAIN_FRAG,
    fragment: [['vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( srgb(terrainAlbedo()), opacity );']],
  });
}

// ---------------------------------------------------------------------------
// Meshing

const CH = 192;
const SKIRT = 8;

interface LodChunk {
  meshes: THREE.Mesh[];
  /** Bounds in map coords. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function chunkGeometry(f: TerrainField, ci0: number, cj0: number, ci1: number, cj1: number, s: number): THREE.BufferGeometry | null {
  const xsI: number[] = [];
  for (let i = ci0; i < ci1; i += s) xsI.push(i);
  xsI.push(ci1);
  const ysJ: number[] = [];
  for (let j = cj0; j < cj1; j += s) ysJ.push(j);
  ysJ.push(cj1);
  const w = xsI.length;
  const h = ysJ.length;
  const nv = w * h + 2 * (w + h) * 2;
  const pos = new Float32Array(nv * 3);
  const nrm = new Int8Array(nv * 3);
  const nx = f.nx;
  const H = f.ren;
  let v = 0;
  const put = (i: number, j: number, dz: number) => {
    const k = j * nx + i;
    pos[v * 3] = f.x0 + i * f.cell;
    pos[v * 3 + 1] = H[k] + dz;
    pos[v * 3 + 2] = -(f.y0 + j * f.cell);
    const il = Math.max(0, i - s);
    const ir = Math.min(nx - 1, i + s);
    const jd = Math.max(0, j - s);
    const ju = Math.min(f.ny - 1, j + s);
    const gx = (H[j * nx + ir] - H[j * nx + il]) / ((ir - il) * f.cell);
    const gy = (H[ju * nx + i] - H[jd * nx + i]) / ((ju - jd) * f.cell);
    // normal of z = h(x, y): (-gx, 1, gy) in three space (z = -y)
    const l = Math.hypot(gx, 1, gy);
    nrm[v * 3] = Math.round((-gx / l) * 127);
    nrm[v * 3 + 1] = Math.round((1 / l) * 127);
    nrm[v * 3 + 2] = Math.round((gy / l) * 127);
    return v++;
  };
  for (let b = 0; b < h; b++) for (let a = 0; a < w; a++) put(xsI[a], ysJ[b], 0);
  const idx: number[] = [];
  const hw = f.nx - 1;
  for (let b = 0; b + 1 < h; b++) {
    for (let a = 0; a + 1 < w; a++) {
      // skip carved cells (at coarse LOD, judge by the block centre)
      const ci = s === 1 ? xsI[a] : Math.min(f.nx - 2, Math.floor((xsI[a] + xsI[a + 1]) / 2));
      const cj = s === 1 ? ysJ[b] : Math.min(f.ny - 2, Math.floor((ysJ[b] + ysJ[b + 1]) / 2));
      if (f.hole[cj * hw + ci]) continue;
      const p00 = b * w + a;
      const p10 = p00 + 1;
      const p01 = p00 + w;
      const p11 = p01 + 1;
      // diagonal p00-p11 (matches renAt), counter-clockwise from above
      idx.push(p00, p10, p11, p00, p11, p01);
    }
  }
  if (!idx.length) return null;
  // skirts along the four edges
  const edge = (list: number[]) => {
    for (let e = 0; e + 1 < list.length; e++) {
      const a = list[e];
      const b = list[e + 1];
      const a2 = v;
      pos.set([pos[a * 3], pos[a * 3 + 1] - SKIRT, pos[a * 3 + 2]], v * 3);
      nrm.set([nrm[a * 3], nrm[a * 3 + 1], nrm[a * 3 + 2]], v * 3);
      v++;
      const b2 = v;
      pos.set([pos[b * 3], pos[b * 3 + 1] - SKIRT, pos[b * 3 + 2]], v * 3);
      nrm.set([nrm[b * 3], nrm[b * 3 + 1], nrm[b * 3 + 2]], v * 3);
      v++;
      idx.push(a, b, b2, a, b2, a2);
    }
  };
  edge(Array.from({ length: w }, (_, a) => a));
  edge(Array.from({ length: w }, (_, a) => (h - 1) * w + a));
  edge(Array.from({ length: h }, (_, b) => b * w));
  edge(Array.from({ length: h }, (_, b) => b * w + w - 1));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(0, v * 3), 3, true));
  g.setIndex(v < 65535 ? new THREE.BufferAttribute(Uint16Array.from(idx), 1) : new THREE.BufferAttribute(Uint32Array.from(idx), 1));
  g.computeBoundingSphere();
  return g;
}

export async function buildTerrain(ctx: Ctx, f: TerrainField, mat: THREE.Material, outerMat: THREE.Material): Promise<void> {
  const chunks: LodChunk[] = [];
  for (let cj = 0; cj < f.ny - 1; cj += CH) {
    for (let ci = 0; ci < f.nx - 1; ci += CH) {
      const ci1 = Math.min(f.nx - 1, ci + CH);
      const cj1 = Math.min(f.ny - 1, cj + CH);
      const meshes: THREE.Mesh[] = [];
      for (const s of [1, 2, 4]) {
        const g = chunkGeometry(f, ci, cj, ci1, cj1, s);
        if (!g) continue;
        const m = new THREE.Mesh(g, mat);
        m.receiveShadow = true;
        m.castShadow = s === 1;
        m.name = `terrain-${ci}-${cj}-${s}`;
        m.visible = false;
        ctx.root.add(m);
        meshes.push(m);
      }
      chunks.push({ meshes, x0: f.x0 + ci * f.cell, y0: f.y0 + cj * f.cell, x1: f.x0 + ci1 * f.cell, y1: f.y0 + cj1 * f.cell });
    }
    await yieldFrame();
  }
  ctx.tick.push((_dt, camera) => {
    const px = camera.position.x;
    const py = -camera.position.z;
    const ph = Math.max(0, camera.position.y);
    for (const c of chunks) {
      const dx = Math.max(c.x0 - px, 0, px - c.x1);
      const dy = Math.max(c.y0 - py, 0, py - c.y1);
      const d = Math.hypot(dx, dy) + ph * 0.5;
      const lod = d < 700 ? 0 : d < 2200 ? 1 : 2;
      c.meshes.forEach((m, i) => (m.visible = i === Math.min(lod, c.meshes.length - 1)));
    }
  });

  // ---- outer horizon grid, with the inner area cut out (inner skirts cover the seam)
  const [ex0, ey0, ex1, ey1] = f.extent;
  const OC = 144;
  for (let cj = 0; cj < f.ony - 1; cj += OC) {
    for (let ci = 0; ci < f.onx - 1; ci += OC) {
      const ci1 = Math.min(f.onx - 1, ci + OC);
      const cj1 = Math.min(f.ony - 1, cj + OC);
      // chunks well away from the inner grid use every other sample
      const bx = Math.max(ex0 - (f.ox0 + ci1 * f.ocell), 0, f.ox0 + ci * f.ocell - ex1);
      const by = Math.max(ey0 - (f.oy0 + cj1 * f.ocell), 0, f.oy0 + cj * f.ocell - ey1);
      const st = Math.hypot(bx, by) > 2500 ? 2 : 1;
      const range = (a0: number, a1: number) => {
        const out: number[] = [];
        for (let a = a0; a < a1; a += st) out.push(a);
        out.push(a1);
        return out;
      };
      const is = range(ci, ci1);
      const js = range(cj, cj1);
      const w = is.length;
      const pos: number[] = [];
      const nrm: number[] = [];
      const idx: number[] = [];
      for (const j of js) {
        for (const i of is) {
          const x = f.ox0 + i * f.ocell;
          const y = f.oy0 + j * f.ocell;
          let z = f.oh[j * f.onx + i];
          const inside = x > ex0 + 1 && x < ex1 - 1 && y > ey0 + 1 && y < ey1 - 1;
          if (inside) z -= 6;
          pos.push(x, z, -y);
          const il = Math.max(0, i - 1);
          const ir = Math.min(f.onx - 1, i + 1);
          const jd = Math.max(0, j - 1);
          const ju = Math.min(f.ony - 1, j + 1);
          const gx = (f.oh[j * f.onx + ir] - f.oh[j * f.onx + il]) / ((ir - il) * f.ocell);
          const gy = (f.oh[ju * f.onx + i] - f.oh[jd * f.onx + i]) / ((ju - jd) * f.ocell);
          const l = Math.hypot(gx, 1, gy);
          nrm.push(-gx / l, 1 / l, gy / l);
        }
      }
      for (let jj = 0; jj + 1 < js.length; jj++) {
        for (let ii = 0; ii + 1 < is.length; ii++) {
          const x0 = f.ox0 + is[ii] * f.ocell;
          const y0 = f.oy0 + js[jj] * f.ocell;
          const x1 = f.ox0 + is[ii + 1] * f.ocell;
          const y1 = f.oy0 + js[jj + 1] * f.ocell;
          // skip cells fully inside the inner grid
          if (x0 > ex0 + f.ocell && x1 < ex1 - f.ocell && y0 > ey0 + f.ocell && y1 < ey1 - f.ocell) continue;
          const a = jj * w + ii;
          idx.push(a, a + 1, a + w + 1, a, a + w + 1, a + w);
        }
      }
      if (!idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, outerMat);
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.name = `terrain-outer-${ci}-${cj}`;
      ctx.root.add(m);
    }
  }
}
