/**
 * Ground: the land surface (map rectangle minus water, with islands), river
 * banks, park/sport/plaza areas and backyard pools, plus the low-detail outer
 * suburbs out to the horizon.
 */
import * as THREE from 'three';
import { Earcut } from 'three/src/extras/Earcut.js';
import { AreaKind, type Area } from '../types';
import type { Ctx, RawPoly } from './ctx';
import { NOISE_GLSL, patch } from './shaders';
import { IdGrid, MASK_WATER, f32, oriented, pointInRing, ringBounds, signedArea, u32, u8, yieldFrame } from './util';

export const INNER_PAD = 100;
export const WATER_Y = -2.5;
const BANK_DEPTH = -3.4;

export const enum Surf {
  Urban = 0,
  Park = 1,
  Wood = 2,
  Sport = 3,
  Cemetery = 4,
  Plaza = 5,
  Sand = 6,
  Pool = 7,
  Bank = 8,
  Outer = 9,
  Asphalt = 10,
}

// ---------------------------------------------------------------------------
// Geometry accumulator for ground-like meshes (position, normal, surface id)

export class GroundGeo {
  pos = f32(1 << 16);
  nrm = f32(1 << 16);
  surf = u8(1 << 14);
  idx = u32(1 << 16);
  get count(): number {
    return this.pos.len / 3;
  }
  vert(x: number, h: number, y: number, nx: number, ny: number, nz: number, s: number): number {
    const i = this.count;
    this.pos.push3(x, h, -y);
    this.nrm.push3(nx, ny, nz);
    this.surf.push(s);
    return i;
  }
  /** Flat triangles from earcut output on a flat coordinate array. */
  flat(coords: ArrayLike<number>, tris: number[], h: number, s: number): void {
    const base = this.count;
    for (let i = 0; i < coords.length; i += 2) this.vert(coords[i], h, coords[i + 1], 0, 1, 0, s);
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i];
      const b = tris[i + 1];
      const c = tris[i + 2];
      // counter-clockwise in map space faces up after the y -> -z flip
      const cr = (coords[2 * b] - coords[2 * a]) * (coords[2 * c + 1] - coords[2 * a + 1]) - (coords[2 * b + 1] - coords[2 * a + 1]) * (coords[2 * c] - coords[2 * a]);
      if (cr >= 0) this.idx.push3(base + a, base + b, base + c);
      else this.idx.push3(base + a, base + c, base + b);
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.take(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.take(), 3));
    g.setAttribute('aSurf', new THREE.BufferAttribute(this.surf.take(), 1));
    g.setIndex(new THREE.BufferAttribute(this.idx.take(), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Triangulate a polygon with holes; returns flat coords and triangle indices. */
export function triangulate(outer: ArrayLike<number>, holes: ArrayLike<number>[]): { coords: number[]; tris: number[] } {
  const coords: number[] = Array.from(outer);
  const holeIdx: number[] = [];
  for (const h of holes) {
    if (h.length < 6) continue;
    holeIdx.push(coords.length / 2);
    for (let i = 0; i < h.length; i++) coords.push(h[i]);
  }
  const tris = Earcut.triangulate(coords, holeIdx.length ? holeIdx : undefined, 2);
  return { coords, tris };
}

// ---------------------------------------------------------------------------
// Land = rectangle R minus water polygons (Weiler-Atherton against a rectangle)

interface Arc {
  pts: number[];
  pin: number;
  pout: number;
  used: boolean;
}

export interface LandPoly {
  outer: Float32Array;
  holes: Float32Array[];
}

function traceLand(water: Area[], R: [number, number, number, number]): LandPoly[] {
  const [x0, y0, x1, y1] = R;
  const W = x1 - x0;
  const H = y1 - y0;
  const P = 2 * (W + H);
  const inside = (x: number, y: number) => x > x0 && x < x1 && y > y0 && y < y1;
  const param = (x: number, y: number): number => {
    const e = 1e-3;
    if (Math.abs(y - y0) < e) return x - x0;
    if (Math.abs(x - x1) < e) return W + (y - y0);
    if (Math.abs(y - y1) < e) return W + H + (x1 - x);
    return 2 * W + H + (y1 - y);
  };
  // Liang-Barsky: portion of segment inside R
  const clip = (ax: number, ay: number, bx: number, by: number): [number, number] | null => {
    let t0 = 0;
    let t1 = 1;
    const dx = bx - ax;
    const dy = by - ay;
    const pp = [-dx, dx, -dy, dy];
    const qq = [ax - x0, x1 - ax, ay - y0, y1 - ay];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(pp[i]) < 1e-12) {
        if (qq[i] < 0) return null;
      } else {
        const t = qq[i] / pp[i];
        if (pp[i] < 0) {
          if (t > t1) return null;
          if (t > t0) t0 = t;
        } else {
          if (t < t0) return null;
          if (t < t1) t1 = t;
        }
      }
    }
    return t1 - t0 > 1e-9 ? [t0, t1] : null;
  };

  const arcs: Arc[] = [];
  const innerHoles: Float32Array[] = [];
  const islands: Float32Array[] = [];
  for (const a of water) {
    const ring = oriented(a.pts, false); // clockwise: water on the right
    const n = ring.length >> 1;
    if (n < 3) continue;
    let start = -1;
    for (let i = 0; i < n; i++) {
      if (!inside(ring[2 * i], ring[2 * i + 1])) {
        start = i;
        break;
      }
    }
    for (const h of a.holes) {
      let allIn = true;
      for (let i = 0; i < h.length; i += 2) if (!inside(h[i], h[i + 1])) allIn = false;
      if (allIn && h.length >= 6) islands.push(oriented(h, true));
    }
    if (start < 0) {
      innerHoles.push(ring);
      continue;
    }
    let cur: Arc | null = null;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      const j = (i + 1) % n;
      const ax = ring[2 * i];
      const ay = ring[2 * i + 1];
      const bx = ring[2 * j];
      const by = ring[2 * j + 1];
      if (cur === null) {
        const c = clip(ax, ay, bx, by);
        if (!c) continue;
        const ex = ax + (bx - ax) * c[0];
        const ey = ay + (by - ay) * c[0];
        const arc: Arc = { pts: [ex, ey], pin: param(ex, ey), pout: 0, used: false };
        if (inside(bx, by)) {
          arc.pts.push(bx, by);
          cur = arc;
        } else {
          const xx = ax + (bx - ax) * c[1];
          const xy = ay + (by - ay) * c[1];
          arc.pts.push(xx, xy);
          arc.pout = param(xx, xy);
          arcs.push(arc);
        }
      } else if (inside(bx, by)) {
        cur.pts.push(bx, by);
      } else {
        const c = clip(ax, ay, bx, by);
        const t1 = c ? c[1] : 0;
        const xx = ax + (bx - ax) * t1;
        const xy = ay + (by - ay) * t1;
        cur.pts.push(xx, xy);
        cur.pout = param(xx, xy);
        arcs.push(cur);
        cur = null;
      }
    }
  }

  const corners = [
    [0, x0, y0],
    [W, x1, y0],
    [W + H, x1, y1],
    [2 * W + H, x0, y1],
  ];
  const mod = (v: number) => ((v % P) + P) % P;
  const outers: Float32Array[] = [];
  if (arcs.length === 0) {
    outers.push(new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]));
  }
  for (const first of arcs) {
    if (first.used) continue;
    const ring: number[] = [];
    let cur = first;
    for (let guard = 0; guard < arcs.length + 2; guard++) {
      cur.used = true;
      for (const v of cur.pts) ring.push(v);
      let next: Arc | null = null;
      let best = Infinity;
      for (const a of arcs) {
        const d = mod(a.pin - cur.pout);
        if (d < best && (!a.used || a === first)) {
          best = d;
          next = a;
        }
      }
      if (!next) break;
      const cs = corners
        .map((c) => ({ d: mod(c[0] - cur.pout), x: c[1], y: c[2] }))
        .filter((c) => c.d > 0 && c.d < best)
        .sort((p, q) => p.d - q.d);
      for (const c of cs) ring.push(c.x, c.y);
      if (next === first) break;
      cur = next;
    }
    if (ring.length >= 6) outers.push(oriented(ring, true));
  }

  const polys: LandPoly[] = outers.map((o) => ({ outer: o, holes: [] }));
  for (const isl of islands) polys.push({ outer: isl, holes: [] });
  const areas = polys.map((p) => Math.abs(signedArea(p.outer)));
  for (const h of innerHoles) {
    let bi = -1;
    for (let i = 0; i < polys.length; i++) {
      if (pointInRing(h[0], h[1], polys[i].outer) && (bi < 0 || areas[i] < areas[bi])) bi = i;
    }
    if (bi >= 0) polys[bi].holes.push(h);
  }
  return polys;
}

/** Sloping bank skirt along a land ring (land on the left of each edge). */
function addBank(g: GroundGeo, ring: ArrayLike<number>, skip: (ax: number, ay: number, bx: number, by: number) => boolean): void {
  const n = ring.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[2 * i];
    const ay = ring[2 * i + 1];
    const bx = ring[2 * j];
    const by = ring[2 * j + 1];
    if (skip(ax, ay, bx, by)) continue;
    const dx = bx - ax;
    const dy = by - ay;
    const l = Math.hypot(dx, dy);
    if (l < 0.05) continue;
    // water to the right
    const rx = dy / l;
    const ry = -dx / l;
    const out = 1.4;
    const drop = BANK_DEPTH;
    // face normal (map coords) leaning toward the water and up
    const nl = Math.hypot(out, drop);
    const nh = out / nl;
    const nxy = -drop / nl;
    const nx = rx * nxy;
    const nz = -ry * nxy;
    const a = g.vert(ax, 0, ay, nx, nh, nz, Surf.Bank);
    const b = g.vert(bx, 0, by, nx, nh, nz, Surf.Bank);
    const c = g.vert(bx + rx * out, drop, by + ry * out, nx, nh, nz, Surf.Bank);
    const d = g.vert(ax + rx * out, drop, ay + ry * out, nx, nh, nz, Surf.Bank);
    g.idx.push3(a, d, c);
    g.idx.push3(a, c, b);
  }
}

const GROUND_PARS = /* glsl */ `
attribute float aSurf;
varying float vSurf;
varying vec3 vGPos;
`;

const GROUND_FRAG_PARS = /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uDensity;
uniform vec4 uDensityRect;
uniform sampler2D uOuter;
uniform vec4 uOuterRect;
uniform float uTime;
varying float vSurf;
varying vec3 vGPos;
${NOISE_GLSL}
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float w_aa(float v, float w) { float f = fwidth(v); return smoothstep(w + f, w - f, v); }
vec3 lawnCol(vec2 p, vec4 n1, vec4 n2, vec4 n3) {
  vec3 green = vec3(0.38, 0.47, 0.25);
  vec3 dry = vec3(0.56, 0.53, 0.36);
  vec3 c = mix(green, dry, smoothstep(0.42, 0.78, n2.g + (n1.r - 0.5) * 0.35));
  c = mix(c, vec3(0.30, 0.38, 0.20), smoothstep(0.6, 0.9, n2.b) * 0.6);
  return c * (0.86 + 0.28 * n3.r);
}
vec3 groundAlbedo(out float emis) {
  emis = 0.0;
  vec2 p = vec2(vGPos.x, -vGPos.z);
  vec4 n1 = texture2D(uNoise, p / 23.0);
  vec4 n2 = texture2D(uNoise, p / 190.0);
  vec4 n3 = texture2D(uNoise, p / 4.3);
  float s = floor(vSurf + 0.5);
  vec3 c;
  if (s < 0.5) {
    float dens = texture2D(uDensity, (p - uDensityRect.xy) * uDensityRect.zw).r;
    vec3 lawn = lawnCol(p, n1, n2, n3);
    vec3 conc = vec3(0.60, 0.59, 0.55) * (0.88 + 0.2 * n3.r) * (0.9 + 0.2 * n1.g);
    vec3 lot = vec3(0.30, 0.30, 0.31) * (0.9 + 0.2 * n3.r);
    vec3 paved = mix(conc, lot, smoothstep(0.55, 0.7, n2.r));
    c = mix(lawn, paved, smoothstep(0.10, 0.34, dens + (n2.g - 0.5) * 0.12));
  } else if (s < 1.5) {
    c = lawnCol(p, n1, n2, n3) * vec3(0.95, 1.06, 0.92);
  } else if (s < 2.5) {
    c = mix(vec3(0.26, 0.31, 0.17), vec3(0.36, 0.30, 0.20), smoothstep(0.4, 0.7, n1.g)) * (0.8 + 0.35 * n3.r);
  } else if (s < 3.5) {
    float stripe = step(0.5, fract(p.x / 7.0 + p.y / 41.0));
    c = vec3(0.33, 0.52, 0.22) * (0.92 + 0.1 * stripe) * (0.92 + 0.12 * n3.r);
  } else if (s < 4.5) {
    float g = step(0.82, w_hash(floor(p / vec2(2.4, 1.6))));
    c = mix(lawnCol(p, n1, n2, n3), vec3(0.62, 0.61, 0.58), g * 0.8);
  } else if (s < 5.5) {
    vec2 q = fract(p / 0.6);
    float joint = max(w_aa(abs(q.x - 0.5), 0.03), w_aa(abs(q.y - 0.5), 0.03));
    c = mix(vec3(0.70, 0.66, 0.60), vec3(0.58, 0.55, 0.50), n1.g * 0.6) * (0.94 + 0.12 * n3.r);
    c *= 1.0 - joint * 0.18;
  } else if (s < 6.5) {
    c = vec3(0.80, 0.72, 0.55) * (0.9 + 0.2 * n3.r);
  } else if (s < 7.5) {
    float rip = w_noise(p * 2.5 + uTime * 0.6) * 0.5 + w_noise(p * 5.0 - uTime * 0.4) * 0.5;
    c = mix(vec3(0.22, 0.62, 0.74), vec3(0.55, 0.85, 0.92), smoothstep(0.55, 0.85, rip));
    emis = uNight * 0.35;
  } else if (s < 8.5) {
    float dens = texture2D(uDensity, (p - uDensityRect.xy) * uDensityRect.zw).r;
    float h = vGPos.y;
    vec3 mud = mix(vec3(0.33, 0.29, 0.22), vec3(0.22, 0.20, 0.16), smoothstep(-1.2, -2.4, h));
    vec3 top = mix(vec3(0.30, 0.36, 0.20), mud, smoothstep(-0.2, -0.9, h + (n3.r - 0.5) * 0.5));
    vec3 wall = vec3(0.58, 0.55, 0.49) * (0.85 + 0.2 * n3.r);
    wall *= 1.0 - 0.15 * step(0.5, fract(h * 1.4 + floor(p.x * 0.8 + p.y * 0.8) * 0.5));
    c = mix(top, wall, smoothstep(0.15, 0.35, dens));
    c *= 0.85 + 0.3 * n1.r;
  } else if (s < 9.5) {
    vec4 o = texture2D(uOuter, (p - uOuterRect.xy) * uOuterRect.zw);
    float veg = o.g;
    vec3 lawn = lawnCol(p, n1, n2, n3);
    // suburb: little roofs and trees on ~18 m lots, faded out where too fine to see
    vec2 lot = p / vec2(17.0, 21.0);
    vec2 li = floor(lot);
    vec2 lf = fract(lot);
    float hsh = w_hash(li);
    float roof = step(0.18, lf.x) * step(lf.x, 0.78) * step(0.22, lf.y) * step(lf.y, 0.75) * step(hsh, 0.25 + o.r * 1.8 + 0.25);
    vec3 roofCol = hsh < 0.3 ? vec3(0.62, 0.62, 0.62) : hsh < 0.55 ? vec3(0.55, 0.30, 0.24) : hsh < 0.75 ? vec3(0.80, 0.80, 0.78) : vec3(0.40, 0.42, 0.44);
    float tree = smoothstep(0.55, 0.7, n1.g + n3.r * 0.3);
    vec3 sub = mix(lawn, roofCol, roof);
    sub = mix(sub, vec3(0.20, 0.30, 0.15), tree * 0.7);
    float far = smoothstep(2.0, 6.0, length(fwidth(p)));
    vec3 subAvg = mix(lawn, vec3(0.45, 0.42, 0.38), 0.35 + o.r * 0.4) * 0.85;
    sub = mix(sub, subAvg, far);
    vec3 forest = mix(vec3(0.17, 0.25, 0.12), vec3(0.24, 0.32, 0.16), n2.g) * (0.85 + 0.3 * n1.r);
    c = mix(sub, forest, smoothstep(0.3, 0.8, veg));
    c = mix(c, vec3(0.32, 0.32, 0.33), smoothstep(0.5, 0.9, o.b) * 0.4);
  } else {
    c = vec3(0.30, 0.30, 0.31) * (0.9 + 0.2 * n3.r);
  }
  return c;
}
`;

export function makeGroundMaterial(ctx: Ctx): THREE.MeshLambertMaterial {
  const d = ctx.density;
  const ex = ctx.extras;
  const outerRect = new THREE.Vector4(0, 0, 1, 1);
  if (ex) {
    const r = ex.raster;
    const yb = r.y1 - r.h * r.cell;
    outerRect.set(r.x0, yb, 1 / (r.w * r.cell), 1 / (r.h * r.cell));
  }
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  return patch(mat, {
    key: 'ground',
    uniforms: {
      uNoise: { value: ctx.tex.noise },
      uDensity: { value: d.tex },
      uDensityRect: { value: new THREE.Vector4(d.x0, d.y0, 1 / (d.nx * d.cell), 1 / (d.ny * d.cell)) },
      uOuter: { value: ctx.outerTex ?? ctx.tex.noise },
      uOuterRect: { value: outerRect },
    },
    vertexPars: GROUND_PARS,
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvSurf = aSurf;\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;']],
    fragmentPars: GROUND_FRAG_PARS,
    fragment: [
      ['vec4 diffuseColor = vec4( diffuse, opacity );', 'float gEmis;\n\tvec4 diffuseColor = vec4( srgb(groundAlbedo(gEmis)), opacity );'],
      ['vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive + diffuseColor.rgb * gEmis;'],
    ],
  });
}

// ---------------------------------------------------------------------------
// Convex clipping (area triangles against land triangles)

function clipConvex(subject: number[], clipTri: ArrayLike<number>): number[] {
  // clip triangle in CCW order
  const ccw = (clipTri[2] - clipTri[0]) * (clipTri[5] - clipTri[1]) - (clipTri[3] - clipTri[1]) * (clipTri[4] - clipTri[0]) > 0;
  let out = subject;
  for (let e = 0; e < 3; e++) {
    const i = ccw ? e : 2 - e;
    const j = ccw ? (e + 1) % 3 : (4 - e) % 3;
    const ax = clipTri[2 * i];
    const ay = clipTri[2 * i + 1];
    const bx = clipTri[2 * j];
    const by = clipTri[2 * j + 1];
    const inp = out;
    out = [];
    const n = inp.length >> 1;
    if (n === 0) break;
    const side = (x: number, y: number) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    for (let k = 0; k < n; k++) {
      const px = inp[2 * k];
      const py = inp[2 * k + 1];
      const qx = inp[2 * ((k + 1) % n)];
      const qy = inp[2 * ((k + 1) % n) + 1];
      const sp = side(px, py);
      const sq = side(qx, qy);
      if (sp >= 0) out.push(px, py);
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq);
        out.push(px + (qx - px) * t, py + (qy - py) * t);
      }
    }
  }
  return out;
}

const AREA_SURF: Record<number, Surf> = {
  [AreaKind.Park]: Surf.Park,
  [AreaKind.Wood]: Surf.Wood,
  [AreaKind.Sport]: Surf.Sport,
  [AreaKind.Cemetery]: Surf.Cemetery,
  [AreaKind.Plaza]: Surf.Plaza,
  [AreaKind.Sand]: Surf.Sand,
  [AreaKind.Water]: Surf.Pool,
};
const AREA_H: Record<number, number> = {
  [AreaKind.Park]: 0.004,
  [AreaKind.Wood]: 0.006,
  [AreaKind.Cemetery]: 0.007,
  [AreaKind.Sand]: 0.008,
  [AreaKind.Sport]: 0.009,
  [AreaKind.Plaza]: 0.011,
  [AreaKind.Water]: 0.013,
};

export async function buildGround(ctx: Ctx, mat: THREE.Material): Promise<void> {
  const { data, R } = ctx;
  const land = traceLand(data.water, R);
  const g = new GroundGeo();
  const landTris: number[] = [];
  for (const lp of land) {
    const { coords, tris } = triangulate(lp.outer, lp.holes);
    g.flat(coords, tris, 0, Surf.Urban);
    for (const t of tris) landTris.push(coords[2 * t], coords[2 * t + 1]);
  }
  const onR = (ax: number, ay: number, bx: number, by: number) => {
    const e = 0.5;
    return (
      (Math.abs(ax - R[0]) < e && Math.abs(bx - R[0]) < e) ||
      (Math.abs(ax - R[2]) < e && Math.abs(bx - R[2]) < e) ||
      (Math.abs(ay - R[1]) < e && Math.abs(by - R[1]) < e) ||
      (Math.abs(ay - R[3]) < e && Math.abs(by - R[3]) < e)
    );
  };
  for (const lp of land) {
    addBank(g, lp.outer, onR);
    for (const h of lp.holes) addBank(g, h, onR);
  }
  await yieldFrame();

  // Land triangle index for clipping areas that spill over water.
  const nTri = landTris.length / 6;
  const triGrid = new IdGrid(R[0], R[1], R[2], R[3], 250);
  for (let t = 0; t < nTri; t++) {
    const o = t * 6;
    triGrid.addBox(
      t,
      Math.min(landTris[o], landTris[o + 2], landTris[o + 4]),
      Math.min(landTris[o + 1], landTris[o + 3], landTris[o + 5]),
      Math.max(landTris[o], landTris[o + 2], landTris[o + 4]),
      Math.max(landTris[o + 1], landTris[o + 3], landTris[o + 5]),
    );
  }
  const mask = ctx.mask;
  const overWater = (a: Area): boolean => {
    const [bx0, by0, bx1, by1] = ringBounds(a.pts);
    const c = mask.cell;
    for (let y = by0 + c * 0.5; y < by1; y += c) {
      for (let x = bx0 + c * 0.5; x < bx1; x += c) {
        if (mask.has(x, y, MASK_WATER) && pointInRing(x, y, a.pts)) return true;
      }
    }
    return false;
  };

  const sorted = [...data.areas].sort((a, b) => (AREA_H[a.kind] ?? 0) - (AREA_H[b.kind] ?? 0));
  let k = 0;
  for (const a of sorted) {
    const surf = AREA_SURF[a.kind];
    if (surf === undefined || a.pts.length < 6) continue;
    const h = AREA_H[a.kind] ?? 0.005;
    const { coords, tris } = triangulate(a.pts, a.holes);
    if (a.kind !== AreaKind.Water && overWater(a)) {
      const seen = new Set<number>();
      for (let i = 0; i < tris.length; i += 3) {
        const tri = [coords[2 * tris[i]], coords[2 * tris[i] + 1], coords[2 * tris[i + 1]], coords[2 * tris[i + 1] + 1], coords[2 * tris[i + 2]], coords[2 * tris[i + 2] + 1]];
        seen.clear();
        triGrid.query(Math.min(tri[0], tri[2], tri[4]), Math.min(tri[1], tri[3], tri[5]), Math.max(tri[0], tri[2], tri[4]), Math.max(tri[1], tri[3], tri[5]), (t) => {
          if (seen.has(t)) return;
          seen.add(t);
          const poly = clipConvex(tri, landTris.slice(t * 6, t * 6 + 6));
          const n = poly.length >> 1;
          if (n < 3) return;
          const base = g.count;
          for (let v = 0; v < n; v++) g.vert(poly[2 * v], h, poly[2 * v + 1], 0, 1, 0, surf);
          // fan; CCW in map space faces up
          const ccw = signedArea(poly) > 0;
          for (let v = 1; v + 1 < n; v++) {
            if (ccw) g.idx.push3(base, base + v, base + v + 1);
            else g.idx.push3(base, base + v + 1, base + v);
          }
        });
      }
    } else {
      g.flat(coords, tris, h, surf);
    }
    if (++k % 400 === 0) await yieldFrame();
  }
  const mesh = new THREE.Mesh(g.build(), mat);
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  mesh.frustumCulled = false;
  ctx.root.add(mesh);
}

/** Water surfaces need the same polygons; exported for water.ts. */
export function waterPolys(ctx: Ctx): { outer: ArrayLike<number>; holes: ArrayLike<number>[] }[] {
  const out: { outer: ArrayLike<number>; holes: ArrayLike<number>[] }[] = ctx.data.water.map((w) => ({ outer: w.pts, holes: w.holes }));
  if (ctx.extras) for (const w of ctx.extras.water) out.push({ outer: w.p, holes: w.h ?? [] });
  return out;
}

export function buildOuter(ctx: Ctx, mat: THREE.Material): void {
  const ex = ctx.extras;
  const g = new GroundGeo();
  const R = ctx.R;
  if (ex) {
    const big = ex.big;
    const onEdge = (ax: number, ay: number, bx: number, by: number) => {
      const e = 1.5;
      const lines: [number, number][] = [
        [0, R[0]],
        [0, R[2]],
        [1, R[1]],
        [1, R[3]],
        [0, big[0]],
        [0, big[2]],
        [1, big[1]],
        [1, big[3]],
      ];
      for (const [ax2, v] of lines) {
        if (ax2 === 0 && Math.abs(ax - v) < e && Math.abs(bx - v) < e) return true;
        if (ax2 === 1 && Math.abs(ay - v) < e && Math.abs(by - v) < e) return true;
      }
      return false;
    };
    for (const lp of ex.land as RawPoly[]) {
      const outer = oriented(lp.p, true);
      const holes = (lp.h ?? []).map((h) => oriented(h, false));
      const { coords, tris } = triangulate(outer, holes);
      g.flat(coords, tris, 0, Surf.Outer);
      addBank(g, outer, onEdge);
      for (const h of holes) addBank(g, h, onEdge);
    }
    // major roads beyond the map as plain asphalt ribbons
    for (const r of ex.roads) {
      const hw = r.w / 2;
      const p = r.p;
      const n = p.length >> 1;
      if (n < 2) continue;
      const base = g.count;
      for (let i = 0; i < n; i++) {
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(n - 1, i + 1);
        let dx = p[2 * i1] - p[2 * i0];
        let dy = p[2 * i1 + 1] - p[2 * i0 + 1];
        const l = Math.hypot(dx, dy) || 1;
        dx /= l;
        dy /= l;
        g.vert(p[2 * i] - dy * hw, 0.03 + r.k * 0.002, p[2 * i + 1] + dx * hw, 0, 1, 0, Surf.Asphalt);
        g.vert(p[2 * i] + dy * hw, 0.03 + r.k * 0.002, p[2 * i + 1] - dx * hw, 0, 1, 0, Surf.Asphalt);
      }
      for (let i = 0; i + 1 < n; i++) {
        const a = base + 2 * i;
        g.idx.push3(a, a + 1, a + 3);
        g.idx.push3(a, a + 3, a + 2);
      }
    }
  } else {
    // Fallback: a plain ring around the map.
    const P = 12000;
    const outer = [R[0] - P, R[1] - P, R[2] + P, R[1] - P, R[2] + P, R[3] + P, R[0] - P, R[3] + P];
    const hole = [R[0], R[1], R[0], R[3], R[2], R[3], R[2], R[1]];
    const { coords, tris } = triangulate(outer, [hole]);
    g.flat(coords, tris, 0, Surf.Outer);
  }
  const mesh = new THREE.Mesh(g.build(), mat);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = 'outer-ground';
  ctx.root.add(mesh);
}
