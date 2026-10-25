/**
 * Gap-filling: OSM house coverage is patchy in some inner suburbs, so we place
 * instanced Queenslander-style houses along residential streets wherever the
 * lot is empty (no OSM building, park, water, rail, pool or road there).
 */
import * as THREE from 'three';
import { BuildingKind, RoadKind } from '../types';
import { CHUNK, NEAR_RANGE, type BuildingIndex } from './buildings';
import { type Ctx, boxAround, densityAt } from './ctx';
import { F_HIGHSET, F_TILE, Style, makeHouseMaterial } from './facade';
import { MeshGeo } from './geo';
import type { RoadIndex } from './roadindex';
import { type RI, roadAt } from './roads';
import {
  MASK_BUILDING,
  MASK_GREEN,
  MASK_PLAZA,
  MASK_POOL,
  MASK_RAIL,
  MASK_SPORT,
  MASK_WATER,
  centroid,
  hash2,
  hexRgb,
  rng,
  yieldFrame,
} from './util';

const WALLS = ['#f4f1e8', '#f0e6cc', '#e8dcc0', '#dfe6dc', '#d8e2e6', '#f0e0c8', '#e6e0d0', '#c8d4c0', '#ece4d8', '#f6f4ee', '#e2d6e0', '#d6e4ec', '#efe4b8'];
const BRICK = ['#9a6048', '#b07858', '#8c5a44', '#c09070'];
const ROOFS = ['#a9adab', '#a9adab', '#b4b8b6', '#8e3b2c', '#56634f', '#45484b', '#dcdad2', '#6f7a80', '#7a3428', '#3f5a6a'];
const TILES = ['#a85d3e', '#9a4e36', '#7a5a4a'];

const SPEC = [
  { name: 'uv', size: 2, type: 'f32' as const },
  { name: 'aAxis', size: 1, type: 'f32' as const },
];

/** Unit house: walls x,z in [-0.5, 0.5], y in [0, 1]; hipped roof to y = 1.5; optional front verandah (-z). */
function houseTemplate(verandah: boolean, ridge: number): THREE.BufferGeometry {
  const g = new MeshGeo(SPEC);
  // walls (map coords: x, h, y; three z = -y, so local three z = -mapY)
  const W = (x0: number, z0: number, x1: number, z1: number, axis: number, fx: number, fz: number) => {
    const u0 = axis === 0 ? x0 : z0;
    const u1 = axis === 0 ? x1 : z1;
    const a = g.vert(x0, 0, -z0, u0, 0, axis);
    const b = g.vert(x1, 0, -z1, u1, 0, axis);
    const c = g.vert(x1, 1, -z1, u1, 1, axis);
    const d = g.vert(x0, 1, -z0, u0, 1, axis);
    g.quad(a, b, c, d, fx, 0, fz);
  };
  W(-0.5, -0.5, 0.5, -0.5, 0, 0, -1);
  W(0.5, 0.5, -0.5, 0.5, 0, 0, 1);
  W(0.5, -0.5, 0.5, 0.5, 1, 1, 0);
  W(-0.5, 0.5, -0.5, -0.5, 1, -1, 0);
  // hipped roof, ridge along z
  const ov = 0.06;
  const ex = 0.5 + ov;
  const ez = 0.5 + ov;
  const top = 1.5;
  const rz = ridge;
  const V = (x: number, y: number, z: number, u: number, v: number, axis: number) => g.vert(x, y, -z, u, v, axis);
  // side faces (sloping toward +-x), axis 3: u along z
  {
    const a = V(ex, 1, -ez, -ez, 0, 3);
    const b = V(ex, 1, ez, ez, 0, 3);
    const c = V(0, top, rz, rz, 1, 3);
    const d = V(0, top, -rz, -rz, 1, 3);
    g.quad(a, b, c, d, 1, 1, 0);
    const a2 = V(-ex, 1, ez, ez, 0, 3);
    const b2 = V(-ex, 1, -ez, -ez, 0, 3);
    const c2 = V(0, top, -rz, -rz, 1, 3);
    const d2 = V(0, top, rz, rz, 1, 3);
    g.quad(a2, b2, c2, d2, -1, 1, 0);
  }
  // hip ends (sloping toward +-z), axis 2: u along x
  {
    const a = V(-ex, 1, -ez, -ex, 0, 2);
    const b = V(ex, 1, -ez, ex, 0, 2);
    const c = V(0, top, -rz, 0, 1, 2);
    g.tri(a, b, c, 0, 1, -1);
    const a2 = V(ex, 1, ez, ex, 0, 2);
    const b2 = V(-ex, 1, ez, -ex, 0, 2);
    const c2 = V(0, top, rz, 0, 1, 2);
    g.tri(a2, b2, c2, 0, 1, 1);
  }
  // eave soffit (dark, facing down) - tagged as roof via a negative v so it shades dark
  {
    const a = V(-ex, 0.99, -ez, 0, 0, 4);
    const b = V(ex, 0.99, -ez, 0, 0, 4);
    const c = V(ex, 0.99, ez, 0, 0, 4);
    const d = V(-ex, 0.99, ez, 0, 0, 4);
    g.quad(a, b, c, d, 0, -1, 0);
  }
  if (verandah) {
    const z0 = -0.5;
    const z1 = -0.78;
    const y0 = 0.86;
    const y1 = 0.76;
    const a = V(-0.5, y0, z0, -0.5, 0.3, 2);
    const b = V(0.5, y0, z0, 0.5, 0.3, 2);
    const c = V(0.5, y1, z1, 0.5, 0, 2);
    const d = V(-0.5, y1, z1, -0.5, 0, 2);
    g.quad(a, b, c, d, 0, 1, -0.3);
    const a2 = V(-0.5, y1 - 0.01, z1, 0, 0, 4);
    const b2 = V(0.5, y1 - 0.01, z1, 0, 0, 4);
    const c2 = V(0.5, y0 - 0.01, z0, 0, 0, 4);
    const d2 = V(-0.5, y0 - 0.01, z0, 0, 0, 4);
    g.quad(a2, b2, c2, d2, 0, -1, 0);
    // posts and a rail
    for (const px of [-0.47, -0.16, 0.16, 0.47]) {
      const pw = 0.012;
      const zc = z1 + 0.02;
      const p0 = V(px - pw, 0, zc, px, 0, 0);
      const p1 = V(px + pw, 0, zc, px, 0, 0);
      const p2 = V(px + pw, y1, zc, px, y1, 0);
      const p3 = V(px - pw, y1, zc, px, y1, 0);
      g.quad(p0, p1, p2, p3, 0, 0, -1);
      const q0 = V(px + pw, 0, zc, px, 0, 1);
      const q1 = V(px + pw, 0, zc + 0.03, px, 0, 1);
      const q2 = V(px + pw, y1, zc + 0.03, px, y1, 1);
      const q3 = V(px + pw, y1, zc, px, y1, 1);
      g.quad(q0, q1, q2, q3, 1, 0, 0);
    }
  }
  return g.build();
}

export interface HouseResult {
  count: number;
  yards: { x: number; y: number }[];
}

export async function buildHouses(ctx: Ctx, roads: { infos: RI[]; index: RoadIndex }, bidx: BuildingIndex, progress: (f: number) => void): Promise<HouseResult> {
  const { mask, R, data } = ctx;
  const index = roads.index;
  const r = rng(777);
  const BLOCK = MASK_BUILDING | MASK_WATER | MASK_GREEN | MASK_SPORT | MASK_POOL | MASK_RAIL | MASK_PLAZA;
  interface H {
    x: number;
    y: number;
    tx: number;
    ty: number;
    ox: number;
    oy: number;
    w: number;
    d: number;
    h: number;
    /** Lowest ground under the house (the walls start there). */
    base: number;
    tpl: number;
    style: number;
    seed: number;
    flags: number;
    wall: string;
    roof: string;
  }
  const houses: H[] = [];
  const yards: { x: number; y: number }[] = [];

  const nearBig = (x: number, y: number, rad: number): boolean => {
    let hit = false;
    bidx.grid.query(x - rad, y - rad, x + rad, y + rad, (id) => {
      if (hit || !bidx.big[id]) return;
      const b = bidx.box;
      if (b[4 * id] - rad < x && b[4 * id + 2] + rad > x && b[4 * id + 1] - rad < y && b[4 * id + 3] + rad > y) hit = true;
    });
    return hit;
  };

  const footprintFree = (cx: number, cy: number, ux: number, uy: number, vx: number, vy: number, hw: number, hd: number): boolean => {
    for (let a = -1; a <= 1.001; a += 0.5) {
      for (let b = -1; b <= 1.001; b += 0.5) {
        const x = cx + ux * a * (hw + 1) + vx * b * (hd + 1);
        const y = cy + uy * a * (hw + 1) + vy * b * (hd + 1);
        if (mask.has(x, y, BLOCK)) return false;
      }
    }
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [0, -1],
      [0, 1],
    ]) {
      const x = cx + ux * a * hw + vx * b * hd;
      const y = cy + uy * a * hw + vy * b * hd;
      if (index.clearance(x, y, 4) < 1.8) return false;
    }
    return true;
  };

  const stamp = (cx: number, cy: number, ux: number, uy: number, vx: number, vy: number, hw: number, hd: number) => {
    const ring = [-1, -1, 1, -1, 1, 1, -1, 1];
    const pts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = ring[2 * i];
      const b = ring[2 * i + 1];
      pts.push(cx + ux * a * (hw + 0.8) + vx * b * (hd + 0.8), cy + uy * a * (hw + 0.8) + vy * b * (hd + 0.8));
    }
    mask.fillRings([pts], MASK_BUILDING);
  };

  let k = 0;
  for (const ri of roads.infos) {
    const rd = ri.r;
    if (rd.tunnel || rd.bridge || rd.link) continue;
    if (rd.kind !== RoadKind.Residential && rd.kind !== RoadKind.Tertiary) continue;
    if (ri.len < 14) continue;
    const mid = roadAt(ri, ri.len / 2);
    if (densityAt(ctx, mid.x, mid.y) > (rd.kind === RoadKind.Tertiary ? 0.08 : 0.2)) continue;
    for (const side of [1, -1]) {
      let s = 5 + r() * 6;
      while (s < ri.len - 5) {
        const lot = 10 + r() * 6;
        const c = roadAt(ri, s + lot / 2);
        s += lot;
        const w = Math.min(12, Math.max(7, lot - 2.5 - r() * 1.5));
        const d = 10 + r() * 5;
        const setback = ri.hw + 3.9 + 3 + r() * 4;
        // road direction t, outward o
        const tx = c.ny;
        const ty = -c.nx;
        const ox = c.nx * side;
        const oy = c.ny * side;
        const cx = c.x + ox * (setback + d / 2);
        const cy = c.y + oy * (setback + d / 2);
        if (!footprintFree(cx, cy, tx, ty, ox, oy, w / 2, d / 2)) continue;
        if (nearBig(cx, cy, 18)) continue;
        if (densityAt(ctx, cx, cy) > 0.22) continue;
        // ground under the footprint: skip cuttings and very steep lots
        let zMin = Infinity;
        let zMax = -Infinity;
        let carved = false;
        for (const [a2, b2] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
          [0, 0],
        ]) {
          const px = cx + tx * a2 * (w / 2) + ox * b2 * (d / 2);
          const py = cy + ty * a2 * (w / 2) + oy * b2 * (d / 2);
          const gz = ctx.field.renAt(px, py);
          zMin = Math.min(zMin, gz);
          zMax = Math.max(zMax, gz);
          if (ctx.field.isHole(px, py)) carved = true;
        }
        if (carved || zMax - zMin > 4.5) continue;
        const zc = ctx.field.renAt(cx, cy);
        stamp(cx, cy, tx, ty, ox, oy, w / 2, d / 2);
        const hsh = hash2(cx, cy, 31);
        const brick = hsh < 0.14;
        const highset = !brick && hash2(cx, cy, 32) < 0.45;
        const tile = brick ? hash2(cx, cy, 33) < 0.75 : hash2(cx, cy, 33) < 0.06;
        houses.push({
          x: cx,
          y: cy,
          tx,
          ty,
          ox,
          oy,
          w,
          d,
          h: (highset ? 5.4 : 3.1) + (zc - zMin),
          base: zMin - 0.15,
          tpl: brick || hash2(cx, cy, 34) < 0.25 ? 1 : 0,
          style: Style.House,
          seed: Math.floor(hash2(cx, cy, 35) * 255),
          flags: (highset ? F_HIGHSET : 0) | (tile ? F_TILE : 0),
          wall: brick ? BRICK[Math.floor(hash2(cx, cy, 36) * BRICK.length)] : WALLS[Math.floor(hash2(cx, cy, 36) * WALLS.length)],
          roof: tile ? TILES[Math.floor(hash2(cx, cy, 37) * TILES.length)] : ROOFS[Math.floor(hash2(cx, cy, 37) * ROOFS.length)],
        });
        // backyard trees
        for (let t = 0; t < 2; t++) {
          if (r() < 0.62) {
            const back = d / 2 + 3 + r() * 9;
            const lat = (r() - 0.5) * lot;
            yards.push({ x: cx + ox * back + tx * lat, y: cy + oy * back + ty * lat });
          }
        }
      }
    }
    if (++k % 1500 === 0) {
      progress(k / roads.infos.length);
      await yieldFrame();
    }
  }
  // yard trees around mapped OSM houses too
  for (const b of data.buildings) {
    if (b.kind !== BuildingKind.House || b.pts.length < 6) continue;
    const [cx, cy] = centroid(b.pts);
    if (hash2(cx, cy, 41) > 0.55) continue;
    const a = hash2(cx, cy, 42) * Math.PI * 2;
    const dd = 8 + hash2(cx, cy, 43) * 6;
    yards.push({ x: cx + Math.cos(a) * dd, y: cy + Math.sin(a) * dd });
  }

  // ---- instanced meshes per building chunk, shown (like the low OSM buildings) while
  // the camera is within NEAR_RANGE of the chunk's nearest house: one-storey houses
  // are a few pixels and in the haze beyond that
  const mat = makeHouseMaterial(ctx.tex.noise);
  const tpls = [houseTemplate(true, 0.12), houseTemplate(false, 0.28)];
  const HCH = CHUNK;
  const nx = Math.ceil((R[2] - R[0]) / HCH);
  const groups = new Map<number, H[][]>();
  for (const h of houses) {
    const i = Math.max(0, Math.min(nx - 1, Math.floor((h.x - R[0]) / HCH)));
    const j = Math.max(0, Math.floor((h.y - R[1]) / HCH));
    const key = j * nx + i;
    let g = groups.get(key);
    if (!g) {
      g = [[], []];
      groups.set(key, g);
    }
    g[h.tpl].push(h);
  }
  const m = new THREE.Matrix4();
  for (const [key, g] of groups) {
    for (let t = 0; t < 2; t++) {
      const items = g[t];
      if (!items.length) continue;
      const n = items.length;
      const style = new Uint8Array(n * 4);
      const wall = new Uint8Array(n * 3);
      const roof = new Uint8Array(n * 3);
      const geo = tpls[t].clone();
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      let cx = 0;
      let cz = 0;
      const xz: number[] = [];
      items.forEach((h, i) => {
        // basis: X along the road (flipped so Z = outward stays right-handed), Y up, Z away from the road
        let xx = h.tx;
        let xy = h.ty;
        // right of (xx, xy) must equal outward for a right-handed basis
        const rightX = xy;
        const rightY = -xx;
        if (rightX * h.ox + rightY * h.oy < 0) {
          xx = -xx;
          xy = -xy;
        }
        m.set(xx * h.w, 0, h.ox * h.d, h.x, 0, h.h, 0, h.base, -xy * h.w, 0, -h.oy * h.d, -h.y, 0, 0, 0, 1);
        mesh.setMatrixAt(i, m);
        style.set([h.style, h.seed, h.flags, 30], i * 4);
        wall.set(hexRgb(h.wall), i * 3);
        roof.set(hexRgb(h.roof), i * 3);
        cx += h.x;
        cz -= h.y;
        xz.push(h.x, -h.y);
      });
      geo.setAttribute('iStyle', new THREE.InstancedBufferAttribute(style, 4, false));
      geo.setAttribute('iWall', new THREE.InstancedBufferAttribute(wall, 3, true));
      geo.setAttribute('iRoof', new THREE.InstancedBufferAttribute(roof, 3, true));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      mesh.name = `houses-${key}-${t}`;
      ctx.root.add(mesh);
      ctx.cull.push({ obj: mesh, x: cx / n, z: cz / n, range: NEAR_RANGE, box: boxAround(xz, 10) });
    }
  }
  progress(1);
  return { count: houses.length, yards };
}
