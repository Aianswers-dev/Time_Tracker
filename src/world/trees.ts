/**
 * Vegetation: low-poly instanced trees in 1 km chunks with a near and a far
 * LOD. Mapped OSM trees, park/forest scatter, street trees and backyard trees.
 * Brisbane in late October: jacarandas in purple bloom, poincianas starting.
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
  hash2,
  pointInRing,
  ringBounds,
  rng,
  signedArea,
  smoothstep,
  yieldFrame,
} from './util';

const TREE_CHUNK = 1500;

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
  const ico = new THREE.IcosahedronGeometry(1, detail);
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

function broadleaf(detail: number): THREE.BufferGeometry {
  const g = new MeshGeo(SPEC);
  trunk(g, 0.42, 0.035, 0.022, detail > 0 ? 6 : 4);
  if (detail > 0) {
    lump(g, 0, 0.56, 0, 0.38, 0.3, 0.38, 1, 11);
    lump(g, 0.17, 0.68, 0.1, 0.26, 0.24, 0.26, 0, 12);
    lump(g, -0.15, 0.66, -0.12, 0.27, 0.24, 0.27, 0, 13);
    lump(g, 0.02, 0.8, -0.02, 0.24, 0.2, 0.24, 0, 14);
  } else {
    lump(g, 0, 0.62, 0, 0.47, 0.36, 0.47, 0, 15);
  }
  return g.build();
}

function palm(detail: number): THREE.BufferGeometry {
  const g = new MeshGeo(SPEC);
  trunk(g, 0.92, 0.018, 0.012, detail > 0 ? 6 : 3);
  const fronds = detail > 0 ? 8 : 5;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + 0.3;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const px = -dy * 0.07;
    const py = dx * 0.07;
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
  if (detail > 0) lump(g, 0, 0.92, 0, 0.05, 0.05, 0.05, 0, 21);
  return g.build();
}

function conifer(detail: number): THREE.BufferGeometry {
  const g = new MeshGeo(SPEC);
  trunk(g, 0.3, 0.03, 0.02, 5);
  const tiers = detail > 0 ? 4 : 2;
  const sides = detail > 0 ? 7 : 5;
  for (let t = 0; t < tiers; t++) {
    const y0 = 0.22 + (t / tiers) * 0.7;
    const y1 = y0 + 0.3;
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

function treeMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: false });
  return patch(mat, {
    key: 'tree',
    vertexPars: 'uniform float uTime;\nattribute float aPart;\nattribute vec4 iFlower;\nattribute vec3 iTrunk;\nvarying float vPart;\nvarying vec3 vLocal;\nvarying vec4 vFlower;\nvarying vec3 vTrunk;\nvarying vec3 vLeaf;',
    vertex: [
      [
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vPart = aPart;
        vLocal = position;
        vFlower = iFlower;
        vTrunk = iTrunk;
        #ifdef USE_INSTANCING_COLOR
        vLeaf = instanceColor;
        #else
        vLeaf = vec3(0.3, 0.5, 0.2);
        #endif
        // gentle wind sway in the canopy
        vec3 ip = instanceMatrix[3].xyz;
        float sway = sin(uTime * 1.3 + ip.x * 0.11 + ip.z * 0.07) * 0.012 * aPart * position.y;
        transformed.x += sway;
        transformed.z += sway * 0.6;`,
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

interface Inst {
  x: number;
  y: number;
  sp: SpName;
  s: number;
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
    list.push({ x, y, sp, s: hash2(x, y, 2) });
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
        list.push({ x, y, sp, s: hash2(x, y, 8) * 0.7 });
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

  // ---- build instanced chunks
  const tplHi = [broadleaf(1), palm(1), conifer(1)];
  const tplLo = [broadleaf(0), palm(0), conifer(0)];
  const mat = treeMaterial();
  const nx = Math.ceil((R[2] - R[0]) / TREE_CHUNK);
  const groups = new Map<number, Inst[][]>();
  for (const it of list) {
    const i = Math.max(0, Math.min(nx - 1, Math.floor((it.x - R[0]) / TREE_CHUNK)));
    const j = Math.max(0, Math.floor((it.y - R[1]) / TREE_CHUNK));
    const key = j * nx + i;
    let g = groups.get(key);
    if (!g) {
      g = [[], [], []];
      groups.set(key, g);
    }
    g[SP[it.sp].tpl].push(it);
  }
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const col = new THREE.Color();
  for (const [key, g] of groups) {
    for (let tpl = 0; tpl < 3; tpl++) {
      const items = g[tpl];
      if (!items.length) continue;
      const n = items.length;
      const flower = new Float32Array(n * 4);
      const trunkC = new Float32Array(n * 3);
      const hi = new THREE.InstancedMesh(tplHi[tpl], mat, n);
      let cx = 0;
      let cz = 0;
      items.forEach((it, i) => {
        const sp: Species = SP[it.sp];
        const hgt = sp.h[0] + (sp.h[1] - sp.h[0]) * it.s;
        const wid = sp.w[0] + (sp.w[1] - sp.w[0]) * (it.s * 0.7 + hash2(it.x, it.y, 11) * 0.3);
        q.setFromAxisAngle(up, hash2(it.x, it.y, 12) * Math.PI * 2);
        pos.set(it.x, 0, -it.y);
        scl.set(wid, hgt, wid);
        m4.compose(pos, q, scl);
        hi.setMatrixAt(i, m4);
        const leafHex = sp.leaf[Math.floor(hash2(it.x, it.y, 13) * sp.leaf.length) % sp.leaf.length];
        col.setHex(leafHex);
        col.multiplyScalar(0.9 + hash2(it.x, it.y, 14) * 0.2);
        hi.setColorAt(i, col);
        col.setHex(sp.flower);
        flower.set([col.r, col.g, col.b, sp.flowerAmt * (0.6 + hash2(it.x, it.y, 15) * 0.8)], i * 4);
        col.setHex(sp.trunk);
        trunkC.set([col.r, col.g, col.b], i * 3);
        cx += it.x;
        cz -= it.y;
      });
      const fAttr = new THREE.InstancedBufferAttribute(flower, 4);
      const tAttr = new THREE.InstancedBufferAttribute(trunkC, 3);
      hi.geometry = tplHi[tpl].clone();
      hi.geometry.setAttribute('iFlower', fAttr);
      hi.geometry.setAttribute('iTrunk', tAttr);
      hi.castShadow = true;
      hi.receiveShadow = true;
      hi.computeBoundingSphere();
      hi.name = `trees-${key}-${tpl}`;
      const lo = new THREE.InstancedMesh(tplLo[tpl].clone(), mat, n);
      lo.instanceMatrix = hi.instanceMatrix;
      lo.instanceColor = hi.instanceColor;
      lo.geometry.setAttribute('iFlower', fAttr);
      lo.geometry.setAttribute('iTrunk', tAttr);
      lo.boundingSphere = hi.boundingSphere;
      lo.name = `trees-lo-${key}-${tpl}`;
      ctx.root.add(hi, lo);
      cx /= n;
      cz /= n;
      ctx.cull.push({ obj: hi, x: cx, z: cz, range: 750 });
      // far LOD shown beyond the near range (handled by a tick below)
      lodPairs.push({ hi, lo, x: cx, z: cz });
    }
  }
  ctx.tick.push((_dt, camera) => {
    const p = camera.position;
    for (const l of lodPairs) {
      const d = Math.hypot(l.x - p.x, l.z - p.z);
      l.lo.visible = d >= 750 && d < 7000;
    }
  });
  progress(1);
  return list.length;
}

const lodPairs: { hi: THREE.InstancedMesh; lo: THREE.InstancedMesh; x: number; z: number }[] = [];
