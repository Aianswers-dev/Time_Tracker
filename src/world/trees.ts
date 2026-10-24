/**
 * Vegetation: low-poly instanced trees. Mapped OSM trees, park/forest
 * scatter, street trees and backyard trees. Brisbane in late October:
 * jacarandas in purple bloom, poincianas starting.
 *
 * Crowns keep clear of carriageways: a crown that would hang into the space a
 * bus needs over a road is lifted (pruned trunk), narrowed, swapped for a
 * palm or the tree is left out.
 *
 * Level of detail is per tree: the trees are stored by 100 m cell and copied
 * into a few instanced "buckets" (full detail near the camera, two cheaper
 * shapes further out) whenever the camera has moved or turned enough. Only
 * the near buckets cast shadows (the sun's shadow box is ~220 m across), and
 * the far ones are culled by cell against the view.
 */
import * as THREE from 'three';
import { AreaKind, RoadKind } from '../types';
import { type Ctx, densityAt } from './ctx';
import { MeshGeo } from './geo';
import type { RoadIndex } from './roadindex';
import type { RI } from './roads';
import { roadAt } from './roads';
import { patch } from './shaders';
import {
  MASK_BUILDING,
  MASK_PLAZA,
  MASK_POOL,
  MASK_RAIL,
  MASK_SPORT,
  MASK_WATER,
  clamp,
  hash2,
  pointInRing,
  ringBounds,
  rng,
  signedArea,
  smoothstep,
  yieldFrame,
} from './util';

interface Species {
  tpl: 0 | 1 | 2; // broadleaf, palm, conifer
  w: [number, number];
  h: [number, number];
  leaf: number[];
  flower: number;
  flowerAmt: number;
  trunk: number;
}

const SP = {
  jacaranda: { tpl: 0, w: [8, 12], h: [7, 11], leaf: [0x9a7fd6, 0x8a6cc8, 0xa48ad8], flower: 0x6f8a4a, flowerAmt: 0.2, trunk: 0x5e5048 },
  poinciana: { tpl: 0, w: [10, 15], h: [5, 7], leaf: [0x4d7a33, 0x56823a], flower: 0xd8472c, flowerAmt: 0.28, trunk: 0x6a5a4a },
  fig: { tpl: 0, w: [16, 26], h: [12, 18], leaf: [0x2e5228, 0x355e2c, 0x2a4b25], flower: 0x3d6a30, flowerAmt: 0.2, trunk: 0x6e6658 },
  gum: { tpl: 0, w: [6, 10], h: [12, 20], leaf: [0x6f7f55, 0x7c8a5c, 0x66784e], flower: 0x8a9466, flowerAmt: 0.3, trunk: 0xd2cab8 },
  street: { tpl: 0, w: [5, 8], h: [6, 9], leaf: [0x4e7a3c, 0x5b8442, 0x46703a, 0x557d3e], flower: 0x6a9448, flowerAmt: 0.2, trunk: 0x5e5246 },
  bottlebrush: { tpl: 0, w: [3, 5], h: [3.5, 5], leaf: [0x4c6e3a], flower: 0xc8283a, flowerAmt: 0.35, trunk: 0x5a4c40 },
  mango: { tpl: 0, w: [8, 12], h: [8, 11], leaf: [0x2b4a26, 0x305229], flower: 0x3a5e30, flowerAmt: 0.1, trunk: 0x5a4c40 },
  palm: { tpl: 1, w: [5, 7], h: [8, 15], leaf: [0x5a8a3a, 0x6a944a, 0x4f7e36], flower: 0x7a9a4a, flowerAmt: 0.1, trunk: 0x8a8070 },
  pine: { tpl: 2, w: [5, 8], h: [14, 24], leaf: [0x2f4a2a, 0x34502e], flower: 0x2f4a2a, flowerAmt: 0, trunk: 0x5a4a3e },
} satisfies Record<string, Species>;
type SpName = keyof typeof SP;

function pickSpecies(r: number, table: [SpName, number][]): SpName {
  let acc = 0;
  for (const [n, p] of table) {
    acc += p;
    if (r < acc) return n;
  }
  return table[table.length - 1][0];
}

const T_MAPPED_CBD: [SpName, number][] = [['fig', 0.3], ['palm', 0.25], ['street', 0.25], ['jacaranda', 0.1], ['poinciana', 0.1]];
const T_MAPPED: [SpName, number][] = [['street', 0.25], ['gum', 0.18], ['jacaranda', 0.16], ['poinciana', 0.1], ['fig', 0.1], ['palm', 0.11], ['pine', 0.05], ['bottlebrush', 0.05]];
const T_PARK: [SpName, number][] = [['fig', 0.14], ['gum', 0.25], ['street', 0.22], ['jacaranda', 0.14], ['poinciana', 0.1], ['palm', 0.07], ['pine', 0.08]];
const T_WOOD: [SpName, number][] = [['gum', 0.68], ['street', 0.27], ['pine', 0.05]];
const T_STREET: [SpName, number][] = [['jacaranda', 0.22], ['poinciana', 0.1], ['street', 0.33], ['gum', 0.12], ['palm', 0.1], ['bottlebrush', 0.13]];
const T_YARD: [SpName, number][] = [['street', 0.3], ['gum', 0.18], ['palm', 0.16], ['jacaranda', 0.14], ['mango', 0.16], ['bottlebrush', 0.06]];

// ---------------------------------------------------------------------------
// Templates (unit height, unit canopy width), attribute aPart: 0 trunk, 1 canopy

const SPEC = [{ name: 'aPart', size: 1, type: 'f32' as const }];

function lump(g: MeshGeo, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, detail: number, seed: number): void {
  const ico = detail < 0 ? new THREE.OctahedronGeometry(1, 0) : new THREE.IcosahedronGeometry(1, detail);
  const p = ico.getAttribute('position');
  const idx: number[] = [];
  const r = rng(seed);
  // icosahedron from three is non-indexed; jitter consistently by rounding positions
  const jit = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let j = jit.get(k);
    if (j === undefined) {
      j = 0.82 + r() * 0.3;
      jit.set(k, j);
    }
    // map space: (x, h, y) with y = -z
    idx.push(g.vert(cx + x * rx * j, cy + y * ry * j, cz - z * rz * j, 1));
  }
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i];
    const b = idx[i + 1];
    const c = idx[i + 2];
    // outward from lump centre
    const P = g.pos.arr;
    const mx = (P[3 * a] + P[3 * b] + P[3 * c]) / 3 - cx;
    const my = (P[3 * a + 1] + P[3 * b + 1] + P[3 * c + 1]) / 3 - cy;
    const mz = (P[3 * a + 2] + P[3 * b + 2] + P[3 * c + 2]) / 3 + cz;
    g.tri(a, b, c, mx, my, mz);
  }
  ico.dispose();
}

function trunk(g: MeshGeo, h: number, r0: number, r1: number, sides: number): void {
  const lo: number[] = [];
  const hi: number[] = [];
  for (let i = 0; i < sides; i++) {
    const t = (i / sides) * Math.PI * 2;
    lo.push(g.vert(Math.cos(t) * r0, 0, Math.sin(t) * r0, 0));
    hi.push(g.vert(Math.cos(t) * r1, h, Math.sin(t) * r1, 0));
  }
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const t = ((i + 0.5) / sides) * Math.PI * 2;
    g.quad(lo[i], lo[j], hi[j], hi[i], Math.cos(t), 0, -Math.sin(t));
  }
}

/** Level of detail: 0 near (~150 tris), 1 middle distance (~45), 2 far (crown only, ~8). */
type Lod = 0 | 1 | 2;

function broadleaf(lod: Lod): THREE.BufferGeometry {
  const g = new MeshGeo(SPEC);
  if (lod === 0) {
    trunk(g, 0.42, 0.035, 0.022, 6);
    lump(g, 0, 0.56, 0, 0.38, 0.3, 0.38, 1, 11);
    lump(g, 0.17, 0.68, 0.1, 0.26, 0.24, 0.26, 0, 12);
    lump(g, -0.15, 0.66, -0.12, 0.27, 0.24, 0.27, 0, 13);
    lump(g, 0.02, 0.8, -0.02, 0.24, 0.2, 0.24, 0, 14);
  } else if (lod === 1) {
    // the same silhouette from two coarse lumps, so the switch at ~150 m does not pop
    trunk(g, 0.42, 0.035, 0.022, 3);
    lump(g, 0, 0.58, 0, 0.43, 0.33, 0.43, 0, 16);
    lump(g, 0.02, 0.78, -0.02, 0.27, 0.22, 0.27, 0, 17);
  } else {
    lump(g, 0, 0.62, 0, 0.5, 0.38, 0.5, -1, 15);
  }
  return g.build();
}

function palm(lod: Lod): THREE.BufferGeometry {
  const g = new MeshGeo(SPEC);
  if (lod < 2) trunk(g, 0.92, 0.018, 0.012, lod === 0 ? 6 : 3);
  const fronds = lod === 0 ? 8 : lod === 1 ? 5 : 3;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + 0.3;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const px = -dy * (lod === 2 ? 0.1 : 0.07);
    const py = dx * (lod === 2 ? 0.1 : 0.07);
    // a drooping two-segment leaf, both faces
    const p0 = [0, 0.92, 0];
    const p1 = [dx * 0.28, 0.98, dy * 0.28];
    const p2 = [dx * 0.5, 0.82, dy * 0.5];
    const v0 = g.vert(p0[0], p0[1], p0[2], 1);
    const v1a = g.vert(p1[0] + px, p1[1], p1[2] + py, 1);
    const v1b = g.vert(p1[0] - px, p1[1], p1[2] - py, 1);
    const v2 = g.vert(p2[0], p2[1], p2[2], 1);
    g.tri(v0, v1a, v1b, 0, 1, 0);
    g.tri(v1a, v2, v1b, 0, 1, 0);
    const w0 = g.vert(p0[0], p0[1], p0[2], 1);
    const w1a = g.vert(p1[0] + px, p1[1], p1[2] + py, 1);
    const w1b = g.vert(p1[0] - px, p1[1], p1[2] - py, 1);
    const w2 = g.vert(p2[0], p2[1], p2[2], 1);
    g.tri(w0, w1a, w1b, 0, -1, 0);
    g.tri(w1a, w2, w1b, 0, -1, 0);
  }
  if (lod === 0) lump(g, 0, 0.92, 0, 0.05, 0.05, 0.05, 0, 21);
  return g.build();
}

function conifer(lod: Lod): THREE.BufferGeometry {
  const g = new MeshGeo(SPEC);
  if (lod < 2) trunk(g, 0.3, 0.03, 0.02, lod === 0 ? 5 : 3);
  const tiers = lod === 0 ? 4 : lod === 1 ? 2 : 1;
  const sides = lod === 0 ? 7 : 5;
  for (let t = 0; t < tiers; t++) {
    const y0 = 0.22 + (t / tiers) * 0.7;
    const y1 = lod === 2 ? 1.0 : y0 + 0.3;
    const r = 0.5 * (1 - t / (tiers + 0.6));
    const ring: number[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 + t;
      ring.push(g.vert(Math.cos(a) * r, y0, Math.sin(a) * r, 1));
    }
    for (let i = 0; i < sides; i++) {
      const top = g.vert(0, y1, 0, 1);
      const a = ((i + 0.5) / sides) * Math.PI * 2 + t;
      g.tri(ring[i], ring[(i + 1) % sides], top, Math.cos(a), 0.6, -Math.sin(a));
    }
  }
  return g.build();
}

// ---------------------------------------------------------------------------
// Crown envelope (fractions of the tree's width w and height h), for keeping
// crowns out of the space over carriageways.

/** Horizontal reach of the crown from the trunk, per template (fraction of w). */
const REACH = [0.49, 0.5, 0.5];
/** Top of the crown (fraction of h). */
const TOP = [1.0, 0.98, 1.05];
/** Most a crown may be raised on a longer, pruned trunk (fraction of h). */
const MAX_LIFT = [0.45, 0.3, 0.15];

/** Lowest point of the crown at horizontal distance `rw` (fraction of w) from the trunk, as a fraction of h. */
function crownBottom(tpl: number, rw: number): number {
  if (tpl === 1) return 0.8; // palm fronds droop to 0.82 h at their tips
  if (tpl === 2) return 0.22;
  // broadleaf: the main lump (centre 0.56 h, semi-axes 0.426 w x 0.336 h with
  // jitter) and the side lumps (centre 0.2 w out at 0.67 h, 0.29 w x 0.27 h),
  // whichever way the tree is turned
  let b = 1;
  const m = rw / 0.426;
  if (m < 1) b = 0.56 - 0.336 * Math.sqrt(1 - m * m);
  const s = (rw - 0.197) / 0.29;
  if (Math.abs(s) < 1) b = Math.min(b, 0.67 - 0.27 * Math.sqrt(1 - s * s));
  return b;
}

/** Height above a carriageway that crowns must clear (bus 3.4 m, pruned like real street trees). */
const ROAD_CLEAR = 4.5;
/** Crowns may hang this far over the kerb line at any height (the gutter is outside the bus). */
const KERB_OVERHANG = 0.3;
/** Trunks keep at least this far from the edge of a carriageway. */
const TRUNK_CLEAR = 0.6;

function treeMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: false });
  return patch(mat, {
    key: 'tree2',
    vertexPars: 'uniform float uTime;\nattribute float aPart;\nattribute vec4 iFlower;\nattribute vec4 iTrunk;\nvarying float vPart;\nvarying vec3 vLocal;\nvarying vec4 vFlower;\nvarying vec3 vTrunk;\nvarying vec3 vLeaf;',
    vertex: [
      [
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vPart = aPart;
        vLocal = position;
        vFlower = iFlower;
        vTrunk = iTrunk.rgb;
        #ifdef USE_INSTANCING_COLOR
        vLeaf = instanceColor;
        #else
        vLeaf = vec3(0.3, 0.5, 0.2);
        #endif
        // gentle wind sway in the canopy
        vec3 ip = instanceMatrix[3].xyz;
        float sway = sin(uTime * 1.3 + ip.x * 0.11 + ip.z * 0.07) * 0.012 * aPart * position.y;
        transformed.x += sway;
        transformed.z += sway * 0.6;
        // pruned street trees: the crown sits higher on a longer trunk
        transformed.y += iTrunk.w * mix(step(0.001, position.y), 1.0, aPart);`,
      ],
      ['#include <color_vertex>', ''],
    ],
    fragmentPars: 'uniform float uTime;\nvarying float vPart;\nvarying vec3 vLocal;\nvarying vec4 vFlower;\nvarying vec3 vTrunk;\nvarying vec3 vLeaf;\nfloat t_hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }',
    fragment: [
      ['#include <color_fragment>', ''],
      [
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec3 leaf = vLeaf;
        float blot = t_hash(floor(vLocal * 9.0 + vFlower.w * 31.0));
        leaf = mix(leaf, vFlower.rgb, step(blot, vFlower.w));
        leaf *= 0.82 + 0.3 * t_hash(floor(vLocal * 23.0));
        // darker inside / underneath the canopy
        leaf *= mix(0.6, 1.08, smoothstep(0.35, 0.95, vLocal.y));
        vec3 c = mix(vTrunk, leaf, step(0.5, vPart));
        vec4 diffuseColor = vec4( c, opacity );`,
      ],
    ],
  });
}

/** Shadow-pass material with the same crown lift as treeMaterial(). */
function treeDepthMaterial(): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute vec4 iTrunk;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += iTrunk.w * mix(step(0.001, position.y), 1.0, aPart);');
  };
  mat.customProgramCacheKey = () => 'tree-depth';
  return mat;
}

interface Inst {
  x: number;
  y: number;
  sp: SpName;
  s: number;
  /** Base height when known (street trees stand on the verge); otherwise the terrain. */
  z?: number;
  /** Size and crown lift (metres) once fitted against the roads. */
  w?: number;
  h?: number;
  lift?: number;
  /** Mapped trees are swapped for a palm rather than dropped when their crown does not fit. */
  mapped?: boolean;
}

// ---------------------------------------------------------------------------
// Per-tree LOD

const CELL = 100;
/** Full-detail trees within this 3D distance. */
const R_HI = 150;
/** The middle shape out to here (or the shadow radius, whichever is larger), then crowns only. */
const R_MID = 420;
/** No trees beyond this horizontal distance (fog has them by then). */
const R_FAR = 2600;
/** Rebuild the buckets after the camera moves this far (m) or turns this much. */
const MOVE = 6;
const TURN_COS = Math.cos((9 * Math.PI) / 180);
/** Cells within this angle outside the view still count as in view (covers turning between rebuilds). */
const VIEW_MARGIN = Math.sin((16 * Math.PI) / 180);

/** Per-template tree data sorted by cell (instance layout, ready to copy). */
interface Store {
  n: number;
  mat: Float32Array;
  col: Float32Array;
  flw: Float32Array;
  trk: Float32Array;
  /** three.js position of the base: x, y (up), z */
  p: Float32Array;
  start: Int32Array;
  count: Int32Array;
}

class Bucket {
  readonly mesh: THREE.InstancedMesh;
  n = 0;
  private cap = 0;
  private mat!: THREE.InstancedBufferAttribute;
  private col!: THREE.InstancedBufferAttribute;
  private flw!: THREE.InstancedBufferAttribute;
  private trk!: THREE.InstancedBufferAttribute;

  constructor(geo: THREE.BufferGeometry, material: THREE.Material, name: string, cap: number) {
    this.mesh = new THREE.InstancedMesh(geo, material, 0);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    // whole-map bounds (the world's underground culling keeps trees near tunnel portals)
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mesh.visible = false;
    this.grow(cap);
  }

  private grow(cap: number): void {
    const old = this.cap ? [this.mat, this.col, this.flw, this.trk] : null;
    this.cap = cap;
    const g = this.mesh.geometry;
    this.mat = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.flw = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.trk = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    for (const a of [this.mat, this.col, this.flw, this.trk]) a.setUsage(THREE.DynamicDrawUsage);
    if (old) {
      const fresh = [this.mat, this.col, this.flw, this.trk];
      old.forEach((a, i) => fresh[i].array.set((a.array as Float32Array).subarray(0, this.n * a.itemSize)));
      // free the old GPU buffers with the geometry; it re-uploads on the next draw
      g.dispose();
    }
    this.mesh.instanceMatrix = this.mat;
    this.mesh.instanceColor = this.col;
    g.setAttribute('iFlower', this.flw);
    g.setAttribute('iTrunk', this.trk);
  }

  /** Append `cnt` trees of `st` starting at index `i`. */
  push(st: Store, i: number, cnt: number): void {
    if (this.n + cnt > this.cap) this.grow(Math.max(this.cap * 2, this.n + cnt + 256));
    const n = this.n;
    (this.mat.array as Float32Array).set(st.mat.subarray(i * 16, (i + cnt) * 16), n * 16);
    (this.col.array as Float32Array).set(st.col.subarray(i * 3, (i + cnt) * 3), n * 3);
    (this.flw.array as Float32Array).set(st.flw.subarray(i * 4, (i + cnt) * 4), n * 4);
    (this.trk.array as Float32Array).set(st.trk.subarray(i * 4, (i + cnt) * 4), n * 4);
    this.n += cnt;
  }

  /** Append tree `i` of `st` (no temporary views; the near buckets add trees one by one). */
  pushOne(st: Store, i: number): void {
    if (this.n + 1 > this.cap) this.grow(this.cap * 2);
    const n = this.n++;
    const M = this.mat.array as Float32Array;
    for (let c = 0; c < 16; c++) M[n * 16 + c] = st.mat[i * 16 + c];
    const C = this.col.array as Float32Array;
    for (let c = 0; c < 3; c++) C[n * 3 + c] = st.col[i * 3 + c];
    const F = this.flw.array as Float32Array;
    const T = this.trk.array as Float32Array;
    for (let c = 0; c < 4; c++) {
      F[n * 4 + c] = st.flw[i * 4 + c];
      T[n * 4 + c] = st.trk[i * 4 + c];
    }
  }

  commit(): void {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (!this.n) return;
    for (const a of [this.mat, this.col, this.flw, this.trk]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * a.itemSize);
      a.needsUpdate = true;
    }
  }
}

export async function buildTrees(
  ctx: Ctx,
  roads: { infos: RI[]; index: RoadIndex },
  extraYards: { x: number; y: number }[],
  progress: (f: number) => void,
): Promise<number> {
  const { data, mask, R } = ctx;
  const index = roads.index;
  const list: Inst[] = [];
  const r = rng(4242);
  const blocked = (x: number, y: number, rad: number, flags = MASK_BUILDING | MASK_WATER | MASK_POOL | MASK_RAIL | MASK_SPORT) =>
    mask.near(x, y, rad, flags) || index.clearance(x, y, rad + 2) < rad;
  const cbdness = (x: number, y: number) => smoothstep(1800, 700, Math.hypot(x - 80, y + 150));
  const newFarm = (x: number, y: number) => Math.hypot(x - 2800, y + 60) < 380;

  // 1. mapped trees
  const t = data.trees;
  for (let i = 0; i < t.length; i += 2) {
    const x = t[i];
    const y = t[i + 1];
    if (mask.has(x, y, MASK_WATER | MASK_BUILDING)) continue;
    const h = hash2(x, y, 1);
    let sp = pickSpecies(h, cbdness(x, y) > 0.5 ? T_MAPPED_CBD : T_MAPPED);
    if (newFarm(x, y) && h < 0.7) sp = 'jacaranda';
    list.push({ x, y, sp, s: hash2(x, y, 2), mapped: true });
  }
  progress(0.1);
  await yieldFrame();

  // 2. parks and forest scatter
  for (const a of data.areas) {
    if (a.kind !== AreaKind.Park && a.kind !== AreaKind.Wood && a.kind !== AreaKind.Cemetery) continue;
    const area = Math.abs(signedArea(a.pts));
    if (area < 150) continue;
    const per = a.kind === AreaKind.Wood ? 80 : a.kind === AreaKind.Cemetery ? 900 : 520;
    const n = Math.min(4000, Math.floor(area / per));
    const [x0, y0, x1, y1] = ringBounds(a.pts);
    let placed = 0;
    for (let k = 0; k < n * 3 && placed < n; k++) {
      const x = x0 + r() * (x1 - x0);
      const y = y0 + r() * (y1 - y0);
      if (!pointInRing(x, y, a.pts)) continue;
      if (a.holes.some((h) => pointInRing(x, y, h))) continue;
      if (blocked(x, y, 2, MASK_BUILDING | MASK_WATER | MASK_POOL | MASK_RAIL | MASK_SPORT | MASK_PLAZA)) continue;
      // parks: clumps and open lawns
      if (a.kind === AreaKind.Park && hash2(Math.floor(x / 40), Math.floor(y / 40), 7) < 0.35) continue;
      let sp = pickSpecies(r(), a.kind === AreaKind.Wood ? T_WOOD : T_PARK);
      if (newFarm(x, y) && r() < 0.55) sp = 'jacaranda';
      list.push({ x, y, sp, s: r() });
      placed++;
    }
  }
  progress(0.3);
  await yieldFrame();

  // 3. street trees on residential and minor roads
  let k = 0;
  for (const ri of roads.infos) {
    const rd = ri.r;
    if (rd.tunnel || rd.bridge || rd.link) continue;
    if (rd.kind !== RoadKind.Residential && rd.kind !== RoadKind.Tertiary && rd.kind !== RoadKind.Secondary) continue;
    const step = rd.kind === RoadKind.Residential ? 16 : 22;
    for (const side of [1, -1]) {
      for (let s = 6 + hash2(ri.i, side, 3) * step; s < ri.len - 6; s += step * (0.7 + hash2(s, ri.i, side) * 0.6)) {
        const c = roadAt(ri, s);
        const off = ri.hw + 2.2;
        const x = c.x + c.nx * side * off;
        const y = c.y + c.ny * side * off;
        const h = hash2(x, y, 5);
        const dens = densityAt(ctx, x, y);
        if (h > 0.55 - dens * 0.4) continue;
        if (index.penetration(x, y) > -1.2) continue;
        if (mask.near(x, y, 1.5, MASK_BUILDING | MASK_WATER | MASK_POOL | MASK_RAIL)) continue;
        let sp = pickSpecies(hash2(x, y, 6), T_STREET);
        if (newFarm(x, y) && h < 0.4) sp = 'jacaranda';
        list.push({ x, y, sp, s: hash2(x, y, 8) * 0.7, z: c.z + 0.1 });
      }
    }
    if (++k % 2000 === 0) await yieldFrame();
  }
  progress(0.5);

  // 4. backyard trees behind houses
  for (const p of extraYards) {
    if (hash2(p.x, p.y, 16) > 0.7) continue;
    if (blocked(p.x, p.y, 2.5)) continue;
    list.push({ x: p.x, y: p.y, sp: pickSpecies(hash2(p.x, p.y, 9), T_YARD), s: hash2(p.x, p.y, 10) });
  }
  progress(0.6);
  await yieldFrame();

  // nothing grows in open cuttings
  {
    let w = 0;
    for (let i = 0; i < list.length; i++) if (!ctx.field.isHole(list[i].x, list[i].y)) list[w++] = list[i];
    list.length = w;
  }

  // ---- crowns clear of the carriageways
  const fitT0 = performance.now();
  const stats = { lifted: 0, narrowed: 0, palms: 0, dropped: 0 };
  {
    const seg = index.seg;
    const segZ = index.segZ;
    const segHW = index.segHW;
    const kinds = index.roads.map((rd) => rd.kind);
    /** Lift (m) the crown needs over the roads near (x, y), or Infinity when the trunk is on a carriageway. */
    const liftNeeded = (x: number, y: number, base: number, tpl: number, w: number, h: number): number => {
      const reach = REACH[tpl] * w;
      let need = 0;
      index.roadsNear(x, y, reach + index.maxHW, (ri, k, dist) => {
        if (kinds[ri] === RoadKind.Pedestrian) return;
        const c = dist - segHW[k];
        if (c < TRUNK_CLEAR) {
          need = Infinity;
          return;
        }
        const rr = c + KERB_OVERHANG;
        if (rr >= reach) return;
        // road height at the closest point
        const ax = seg[4 * k];
        const ay = seg[4 * k + 1];
        const dx = seg[4 * k + 2] - ax;
        const dy = seg[4 * k + 3] - ay;
        const l2 = dx * dx + dy * dy;
        const u = l2 > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) : 0;
        const z = segZ[2 * k] + (segZ[2 * k + 1] - segZ[2 * k]) * u;
        // a crown wholly below a deck is no trouble
        if (base + TOP[tpl] * h < z - 1.2) return;
        need = Math.max(need, z + ROAD_CLEAR - (base + crownBottom(tpl, rr / w) * h));
      });
      return need;
    };
    const fit = (it: Inst, sp: SpName, base: number): boolean => {
      const S: Species = SP[sp];
      const h = S.h[0] + (S.h[1] - S.h[0]) * it.s;
      const w = S.w[0] + (S.w[1] - S.w[0]) * (it.s * 0.7 + hash2(it.x, it.y, 11) * 0.3);
      for (const f of [1, 0.8, 0.62]) {
        const need = liftNeeded(it.x, it.y, base, S.tpl, w * f, h);
        if (need === Infinity) return false;
        if (need > MAX_LIFT[S.tpl] * h) continue;
        it.sp = sp;
        it.w = w * f;
        it.h = h;
        it.lift = Math.max(0, need);
        if (need > 0) stats.lifted++;
        if (f < 1) stats.narrowed++;
        return true;
      }
      return false;
    };
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const base = it.z ?? ctx.field.renAt(it.x, it.y) - 0.2;
      it.z = base;
      if (fit(it, it.sp, base)) list[w++] = it;
      else if (it.mapped && it.sp !== 'palm' && fit(it, 'palm', base)) {
        stats.palms++;
        list[w++] = it;
      } else stats.dropped++;
      if (i % 20000 === 19999) await yieldFrame();
    }
    list.length = w;
  }
  const fitT1 = performance.now();
  progress(0.75);
  await yieldFrame();

  // ---- per-template stores, sorted by cell (random order within a cell)
  const gx0 = R[0];
  const gy0 = R[1];
  const gnx = Math.ceil((R[2] - R[0]) / CELL);
  const gny = Math.ceil((R[3] - R[1]) / CELL);
  const cellOf = (x: number, y: number) => clamp(Math.floor((y - gy0) / CELL), 0, gny - 1) * gnx + clamp(Math.floor((x - gx0) / CELL), 0, gnx - 1);
  const keyed = list.map((it) => ({ it, cell: cellOf(it.x, it.y), ord: hash2(it.x, it.y, 31) }));
  keyed.sort((a, b) => a.cell - b.cell || a.ord - b.ord);
  const cellY0 = new Float32Array(gnx * gny).fill(Infinity);
  const cellY1 = new Float32Array(gnx * gny).fill(-Infinity);
  const stores: Store[] = [0, 1, 2].map((tpl) => {
    const items = keyed.filter((e) => SP[e.it.sp].tpl === tpl);
    const n = items.length;
    const st: Store = {
      n,
      mat: new Float32Array(n * 16),
      col: new Float32Array(n * 3),
      flw: new Float32Array(n * 4),
      trk: new Float32Array(n * 4),
      p: new Float32Array(n * 3),
      start: new Int32Array(gnx * gny),
      count: new Int32Array(gnx * gny),
    };
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    items.forEach(({ it, cell }, i) => {
      const sp: Species = SP[it.sp];
      const hgt = it.h!;
      q.setFromAxisAngle(up, hash2(it.x, it.y, 12) * Math.PI * 2);
      pos.set(it.x, it.z!, -it.y);
      scl.set(it.w!, hgt, it.w!);
      m4.compose(pos, q, scl);
      m4.toArray(st.mat, i * 16);
      const leafHex = sp.leaf[Math.floor(hash2(it.x, it.y, 13) * sp.leaf.length) % sp.leaf.length];
      col.setHex(leafHex);
      col.multiplyScalar(0.9 + hash2(it.x, it.y, 14) * 0.2);
      st.col.set([col.r, col.g, col.b], i * 3);
      col.setHex(sp.flower);
      st.flw.set([col.r, col.g, col.b, sp.flowerAmt * (0.6 + hash2(it.x, it.y, 15) * 0.8)], i * 4);
      col.setHex(sp.trunk);
      // lift in units of the tree's height (the instance matrix scales y by it)
      st.trk.set([col.r, col.g, col.b, (it.lift ?? 0) / hgt], i * 4);
      st.p.set([it.x, it.z!, -it.y], i * 3);
      if (st.count[cell] === 0) st.start[cell] = i;
      st.count[cell]++;
      cellY0[cell] = Math.min(cellY0[cell], it.z!);
      cellY1[cell] = Math.max(cellY1[cell], it.z! + hgt + (it.lift ?? 0));
    });
    return st;
  });
  progress(0.9);

  // ---- buckets: [lod][template]; near ones cast shadows
  const mat = treeMaterial();
  const depth = treeDepthMaterial();
  const builders = [broadleaf, palm, conifer];
  const BUCKETS = [
    { lod: 0 as Lod, shadow: true, name: 'hi', cap: 1024 },
    { lod: 1 as Lod, shadow: true, name: 'mid-sh', cap: 2048 },
    { lod: 1 as Lod, shadow: false, name: 'mid', cap: 2048 },
    { lod: 2 as Lod, shadow: false, name: 'far', cap: 8192 },
  ];
  const buckets: Bucket[][] = BUCKETS.map((b) =>
    [0, 1, 2].map((tpl) => {
      const bk = new Bucket(builders[tpl](b.lod), mat, `trees-${b.name}-${tpl}`, Math.min(b.cap, Math.max(16, stores[tpl].n)));
      bk.mesh.castShadow = b.shadow;
      bk.mesh.receiveShadow = b.lod < 2;
      if (b.shadow) bk.mesh.customDepthMaterial = depth;
      ctx.root.add(bk.mesh);
      return bk;
    }),
  );
  const [HI, MIDSH, MID, FAR] = buckets;

  const last = { x: NaN, y: 0, z: 0, fx: 0, fy: 0, fz: 0, p0: 0, p5: 0 };
  const fwd = new THREE.Vector3();
  const frustum = new THREE.Frustum();
  const pm = new THREE.Matrix4();
  const planes = frustum.planes;
  const rebuild = (cam: THREE.Camera): void => {
    const px = last.x;
    const py = last.y;
    const pz = last.z;
    for (const row of buckets) for (const b of row) b.n = 0;
    // the shadow box (sky.ts) is +-(110 + 0.9 x camera height) and sits half its size ahead
    const camH = Math.max(0, py - ctx.field.renAt(px, -pz));
    const half = clamp(110 + camH * 0.9, 110, 700);
    const rSh = 2 * half + 25;
    const rMid = Math.max(R_MID, rSh);
    pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pm);
    const inView = (cx: number, cy: number, cz: number, rad: number, dist: number): boolean => {
      const m = rad + dist * VIEW_MARGIN;
      for (let i = 0; i < 6; i++) {
        const pl = planes[i];
        if (pl.normal.x * cx + pl.normal.y * cy + pl.normal.z * cz + pl.constant < -m) return false;
      }
      return true;
    };
    const i0 = Math.max(0, Math.floor((px - R_FAR - gx0) / CELL));
    const i1 = Math.min(gnx - 1, Math.floor((px + R_FAR - gx0) / CELL));
    const j0 = Math.max(0, Math.floor((-pz - R_FAR - gy0) / CELL));
    const j1 = Math.min(gny - 1, Math.floor((-pz + R_FAR - gy0) / CELL));
    for (let j = j0; j <= j1; j++) {
      // three.js z of the cell's north and south edges
      const zn = -(gy0 + (j + 1) * CELL);
      const zs = -(gy0 + j * CELL);
      const dz = Math.max(zn - pz, 0, pz - zs);
      for (let i = i0; i <= i1; i++) {
        const c = j * gnx + i;
        if (cellY1[c] < cellY0[c]) continue;
        const xw = gx0 + i * CELL;
        const dx = Math.max(xw - px, 0, px - xw - CELL);
        const d = Math.hypot(dx, dz);
        if (d > R_FAR) continue;
        const cy = (cellY0[c] + cellY1[c]) / 2;
        const vis = inView(xw + CELL / 2, cy, (zn + zs) / 2, CELL * 0.71 + (cellY1[c] - cellY0[c]) / 2, d);
        if (d >= rMid) {
          if (!vis) continue;
          for (let tpl = 0; tpl < 3; tpl++) {
            const st = stores[tpl];
            const n = st.count[c];
            if (n) FAR[tpl].push(st, st.start[c], n);
          }
          continue;
        }
        // near cells: per tree
        for (let tpl = 0; tpl < 3; tpl++) {
          const st = stores[tpl];
          const n = st.count[c];
          if (!n) continue;
          const s0 = st.start[c];
          const P = st.p;
          for (let q = s0; q < s0 + n; q++) {
            const ex = P[3 * q] - px;
            const ez = P[3 * q + 2] - pz;
            const d2 = Math.sqrt(ex * ex + ez * ez);
            if (d2 < rSh) {
              const ey = P[3 * q + 1] - py;
              (d2 * d2 + ey * ey < R_HI * R_HI ? HI : MIDSH)[tpl].pushOne(st, q);
            } else if (vis) (d2 < rMid ? MID : FAR)[tpl].pushOne(st, q);
          }
        }
      }
    }
    for (const row of buckets) for (const b of row) b.commit();
  };
  ctx.tick.push((_dt, camera) => {
    camera.updateWorldMatrix(true, false);
    const e = camera.matrixWorld.elements;
    const x = e[12];
    const y = e[13];
    const z = e[14];
    fwd.set(-e[8], -e[9], -e[10]).normalize();
    const pe = camera.projectionMatrix.elements;
    const moved = !(Math.hypot(x - last.x, y - last.y, z - last.z) < MOVE);
    const turned = fwd.x * last.fx + fwd.y * last.fy + fwd.z * last.fz < TURN_COS;
    const zoomed = Math.abs(pe[0] - last.p0) > 0.02 * Math.abs(pe[0]) || Math.abs(pe[5] - last.p5) > 0.02 * Math.abs(pe[5]);
    if (!moved && !turned && !zoomed) return;
    Object.assign(last, { x, y, z, fx: fwd.x, fy: fwd.y, fz: fwd.z, p0: pe[0], p5: pe[5] });
    const t0 = performance.now();
    rebuild(camera);
    if (debug) {
      debug.rebuilds++;
      debug.lastMs = performance.now() - t0;
      debug.maxMs = Math.max(debug.maxMs, debug.lastMs);
      debug.counts = buckets.map((row) => row.map((b) => b.n));
    }
  });
  // ?world=debug: window.__trees has the bucket sizes and rebuild cost
  const debug = location.search.includes('world=debug') ? { rebuilds: 0, lastMs: 0, maxMs: 0, counts: [] as number[][] } : null;
  if (debug) (window as unknown as { __trees: typeof debug }).__trees = debug;
  console.info(
    `[world] trees by roads (${Math.round(fitT1 - fitT0)} ms): ${stats.lifted} crowns lifted, ${stats.narrowed} narrowed, ${stats.palms} swapped for palms, ${stats.dropped} left out`,
  );
  progress(1);
  return list.length;
}
