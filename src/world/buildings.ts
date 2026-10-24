/**
 * OSM buildings: footprints extruded into walls with procedural facades,
 * flat or pitched roofs, merged into 600 m chunks (one draw call each).
 */
import * as THREE from 'three';
import { BuildingKind, type Building } from '../types';
import { type Ctx, densityAt } from './ctx';
import { F_HIGHSET, F_PITCHED, F_ROOF, F_SOFFIT, F_TILE, Style, makeBuildingMaterial } from './facade';
import { triangulate } from './ground';
import { IdGrid, centroid, f32, hash1, i8, obb, oriented, pointInRing, ringBounds, signedArea, smoothstep, u32, u8, yieldFrame } from './util';

export const CHUNK = 600;

const GLASS = [0x5d7f99, 0x4f7f7a, 0x6a7884, 0x7a8a8f, 0x41617a, 0x6b6455, 0x56708a, 0x8a9aa4];
const OFFICE = [0xc8c2b4, 0xa9a9a4, 0xd6d1c4, 0x8f9496, 0xbdb3a0, 0xe0dcd2];
const APART = [0xe8e4da, 0xd9d4c8, 0xc9c6bd, 0xefe9dc, 0xbfc4c4, 0xd8c8b0, 0xf2f0ea, 0xc4b8a4];
const SHOP = [0x9a5a3e, 0x8a4a35, 0xa8704f, 0xd8ccb0, 0xc8b89a, 0xe0d8c8, 0xb8a888, 0x7a8c7c, 0x9aa4ae, 0xe6dcc6];
const HOUSE = [0xf4f1e8, 0xf0e6cc, 0xe8dcc0, 0xdfe6dc, 0xd8e2e6, 0xf0e0c8, 0xe6e0d0, 0xc8d4c0, 0xece4d8, 0xf6f4ee, 0xe2d6e0, 0xd6e4ec];
const BRICK_HOUSE = [0x9a6048, 0xb07858, 0x8c5a44, 0xc09070];
const HOUSE_ROOF = [0xa9adab, 0xa9adab, 0x8e3b2c, 0x56634f, 0x45484b, 0xdcdad2, 0x6f7a80, 0x9aa09c, 0x7a3428];
const TILE_ROOF = [0xa85d3e, 0x9a4e36, 0x7a5a4a];
const INDUS = [0xb8b8b0, 0x9aa0a0, 0xc8c4b8, 0x8f9aa0, 0xd0ccc0, 0x7a8a7a];
const CIVIC = [0xc9b48a, 0xbfa77c, 0xd2c09a, 0x9a5d44, 0xc4b496];
const FLAT_ROOF = [0x9a9a96, 0x8a8a86, 0xb0aea6, 0x6e6e6c, 0xc8c4bc, 0xa4a098];

const pick = (arr: number[], r: number) => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];

/** Merged geometry builder for building chunks. */
export class BGeo {
  pos = f32(1 << 15);
  nrm = i8(1 << 15);
  uv = f32(1 << 14);
  col = u8(1 << 14);
  sty = u8(1 << 14);
  idx = u32(1 << 15);
  get count(): number {
    return this.pos.len / 3;
  }
  v(x: number, h: number, y: number, u: number, w: number, c: number, style: number, seed: number, flags: number, storey: number): number {
    const i = this.count;
    this.pos.push3(x, h, -y);
    this.nrm.push3(0, 127, 0);
    this.uv.push2(u, w);
    this.col.push3((c >> 16) & 255, (c >> 8) & 255, c & 255);
    this.sty.push4(style, seed, flags, storey);
    return i;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.take(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.take(), 3, true));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.take(), 2));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.col.take(), 3, true));
    g.setAttribute('aStyle', new THREE.BufferAttribute(this.sty.take(), 4, false));
    g.setIndex(new THREE.BufferAttribute(this.idx.take(), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
  /** Set the normal (three.js space, unit) of vertices a..b inclusive. */
  setNormal(a: number, b: number, nx: number, ny: number, nz: number): void {
    const n = this.nrm.arr;
    for (let v = a; v <= b; v++) {
      n[3 * v] = Math.round(nx * 127);
      n[3 * v + 1] = Math.round(ny * 127);
      n[3 * v + 2] = Math.round(nz * 127);
    }
  }
}

interface Look {
  style: Style;
  wall: number;
  roof: number;
  flags: number;
  storey: number;
  pitched: boolean;
  wallTop: number;
  roofH: number;
}

function classify(b: Building, area: number, cx: number, cy: number, dens: number, seed: number): Look {
  const r1 = hash1(seed * 3 + 1);
  const r2 = hash1(seed * 3 + 2);
  const r3 = hash1(seed * 3 + 3);
  const cbd = smoothstep(1700, 700, Math.hypot(cx - 80, cy + 150));
  const h = b.height;
  let style: Style;
  let wall: number;
  let roof = pick(FLAT_ROOF, r3);
  let storey = 3.2;
  let flags = 0;
  let pitched = false;
  let wallTop = h;
  let roofH = 0;
  const k = b.kind;
  const houseLike = k === BuildingKind.House || (k === BuildingKind.Generic && h <= 8 && area < 320 && dens < 0.25);
  if (k === BuildingKind.Roof) {
    style = Style.Canopy;
    wall = 0xb8b8b4;
    roof = 0x9a9a98;
  } else if (k === BuildingKind.Parking) {
    style = Style.Parking;
    wall = 0xb4b0a8;
  } else if (houseLike) {
    style = Style.House;
    const brick = r1 < 0.18;
    wall = brick ? pick(BRICK_HOUSE, r2) : pick(HOUSE, r2);
    const tile = brick ? r3 < 0.7 : r3 < 0.08;
    roof = tile ? pick(TILE_ROOF, r2) : pick(HOUSE_ROOF, r3);
    if (tile) flags |= F_TILE;
    pitched = true;
    storey = 3.0;
    if (h > 7.6) {
      wallTop = h - 2.2;
      roofH = 2.2;
    } else if (!brick && r1 > 0.6) {
      flags |= F_HIGHSET;
      wallTop = 5.5;
      roofH = 2.4;
    } else {
      wallTop = 3.2;
      roofH = 1.9;
    }
  } else if (k === BuildingKind.Shed) {
    style = Style.Industrial;
    wall = pick([0x9aa09c, 0x6f7a6a, 0xc8c4b8, 0x8a9294], r1);
    roof = wall;
    pitched = area < 120;
    wallTop = h;
    roofH = pitched ? 0.6 : 0;
  } else if (k === BuildingKind.Industrial) {
    style = Style.Industrial;
    wall = pick(INDUS, r1);
    roof = pick([0xb8bab6, 0xa4a8a6, 0xd0d0cc], r2);
  } else if (k === BuildingKind.Civic && h < 40) {
    style = Style.Civic;
    wall = pick(CIVIC, r1);
    storey = 4.4;
  } else if (h >= 38) {
    const glassP = 0.45 + cbd * 0.3;
    style = r1 < glassP ? Style.Glass : k === BuildingKind.Apartments ? Style.Apartment : Style.Office;
    wall = style === Style.Glass ? pick(GLASS, r2) : style === Style.Office ? pick(OFFICE, r2) : pick(APART, r2);
    storey = style === Style.Apartment ? 3.1 : 3.8;
    roof = pick([0x6e6e6c, 0x8a8a86, 0x5a5c5e], r3);
  } else if (k === BuildingKind.Apartments || (h >= 14 && dens < 0.35 && r1 < 0.6)) {
    style = Style.Apartment;
    wall = pick(APART, r2);
    storey = 3.1;
  } else if (h >= 14) {
    style = r1 < 0.35 + cbd * 0.3 ? Style.Glass : Style.Office;
    wall = style === Style.Glass ? pick(GLASS, r2) : pick(OFFICE, r2);
    storey = 3.7;
  } else if (k === BuildingKind.Commercial || dens > 0.2) {
    style = Style.Shop;
    wall = pick(SHOP, r2);
    storey = 3.4;
  } else {
    style = area > 400 ? Style.Industrial : Style.Shop;
    wall = style === Style.Industrial ? pick(INDUS, r2) : pick(SHOP, r2);
  }
  if (b.color) wall = parseInt(b.color.slice(1), 16);
  if (b.roofColor) roof = parseInt(b.roofColor.slice(1), 16);
  if (!pitched && (b.roof === 'h' || b.roof === 'p' || b.roof === 'g') && h < 30) {
    pitched = true;
    roofH = Math.min(4, h * 0.3);
    wallTop = h - roofH;
    if (style !== Style.House) roof = pick(HOUSE_ROOF, r3);
  }
  return { style, wall, roof, flags, storey, pitched, wallTop, roofH };
}

/** Walls along a CCW ring from y0 to y1 (absolute heights). */
function walls(g: BGeo, ring: ArrayLike<number>, y0: number, y1: number, L: Look, seed: number, u0: number): void {
  const n = ring.length >> 1;
  let u = u0;
  const st = Math.round(L.storey * 10);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[2 * i];
    const ay = ring[2 * i + 1];
    const bx = ring[2 * j];
    const by = ring[2 * j + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.05) continue;
    const a = g.v(ax, y0, ay, u, y0, L.wall, L.style, seed, L.flags, st);
    const b = g.v(bx, y0, by, u + len, y0, L.wall, L.style, seed, L.flags, st);
    const c = g.v(bx, y1, by, u + len, y1, L.wall, L.style, seed, L.flags, st);
    const d = g.v(ax, y1, ay, u, y1, L.wall, L.style, seed, L.flags, st);
    g.setNormal(a, d, (by - ay) / len, 0, (bx - ax) / len);
    g.idx.push3(a, b, c);
    g.idx.push3(a, c, d);
    u += len;
  }
}

/** Flat polygon (roof facing up, or soffit facing down). */
function flatCap(g: BGeo, ring: ArrayLike<number>, h: number, color: number, L: Look, seed: number, up: boolean, extraFlags: number): void {
  const { coords, tris } = triangulate(ring, []);
  const base = g.count;
  const fl = F_ROOF | extraFlags | (L.flags & F_TILE);
  for (let i = 0; i < coords.length; i += 2) g.v(coords[i], h, coords[i + 1], coords[i], coords[i + 1], color, L.style, seed, fl, 30);
  if (!up) g.setNormal(base, g.count - 1, 0, -1, 0);
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i];
    const b = tris[i + 1];
    const c = tris[i + 2];
    const cr = (coords[2 * b] - coords[2 * a]) * (coords[2 * c + 1] - coords[2 * a + 1]) - (coords[2 * b + 1] - coords[2 * a + 1]) * (coords[2 * c] - coords[2 * a]);
    if (cr >= 0 === up) g.idx.push3(base + a, base + b, base + c);
    else g.idx.push3(base + a, base + c, base + b);
  }
}

/** Push triangle a,b,c (map x, h, y triples) wound so its normal faces direction d (three.js space). */
function faceTri(g: BGeo, ia: number, ib: number, ic: number, p: number[], dx: number, dy: number, dz: number): void {
  const ax = p[3] - p[0];
  const ay = p[4] - p[1];
  const az = -(p[5] - p[2]);
  const bx = p[6] - p[0];
  const by = p[7] - p[1];
  const bz = -(p[8] - p[2]);
  let nx = ay * bz - az * by;
  let ny = az * bx - ax * bz;
  let nz = ax * by - ay * bx;
  if (nx * dx + ny * dy + nz * dz >= 0) g.idx.push3(ia, ib, ic);
  else {
    g.idx.push3(ia, ic, ib);
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  for (const v of [ia, ib, ic]) g.setNormal(v, v, nx / l, ny / l, nz / l);
}

/** Roof triangle facing up, uv per corner. */
function roofTri(g: BGeo, p: number[], uvs: number[], L: Look, seed: number): void {
  const fl = F_ROOF | F_PITCHED | (L.flags & F_TILE);
  const a = g.v(p[0], p[1], p[2], uvs[0], uvs[1], L.roof, L.style, seed, fl, 30);
  const b = g.v(p[3], p[4], p[5], uvs[2], uvs[3], L.roof, L.style, seed, fl, 30);
  const c = g.v(p[6], p[7], p[8], uvs[4], uvs[5], L.roof, L.style, seed, fl, 30);
  faceTri(g, a, b, c, p, 0, 1, 0);
}

/** Hipped / pyramid / gabled roof on an oriented box. */
function boxRoof(g: BGeo, o: ReturnType<typeof obb>, eave: number, roofH: number, gable: boolean, L: Look, seed: number): void {
  const ov = 0.35;
  const hl = o.hl + ov;
  const hw = o.hw + ov;
  const ux = o.ux;
  const uy = o.uy;
  const vx = -uy;
  const vy = ux;
  const cx = o.cx;
  const cy = o.cy;
  const P = (a: number, b: number): [number, number] => [cx + ux * a + vx * b, cy + uy * a + vy * b];
  const c0 = P(-hl, -hw);
  const c1 = P(hl, -hw);
  const c2 = P(hl, hw);
  const c3 = P(-hl, hw);
  let rl = gable ? hl : Math.max(0, hl - hw);
  if (rl < 0.4) rl = 0;
  const r0 = P(-rl, 0);
  const r1 = P(rl, 0);
  const top = eave + roofH;
  const slope = Math.hypot(hw, roofH);
  const endSlope = Math.hypot(hl - rl, roofH);
  // long sides (trapezoids, or triangles for a pyramid)
  const side = (a: [number, number], b: [number, number], c: [number, number], d: [number, number], ua: number, ub: number, uc: number, ud: number) => {
    roofTri(g, [a[0], eave, a[1], b[0], eave, b[1], c[0], top, c[1]], [ua, 0, ub, 0, uc, slope], L, seed);
    if (rl > 0) roofTri(g, [a[0], eave, a[1], c[0], top, c[1], d[0], top, d[1]], [ua, 0, uc, slope, ud, slope], L, seed);
  };
  side(c0, c1, r1, r0, -hl, hl, rl, -rl);
  side(c2, c3, r0, r1, hl, -hl, -rl, rl);
  if (gable) {
    // vertical gable ends in wall colour, facing out
    const st = Math.round(L.storey * 10);
    const ends: [[number, number], [number, number], [number, number]][] = [
      [c1, c2, r1],
      [c3, c0, r0],
    ];
    for (const [a, b, r] of ends) {
      const ia = g.v(a[0], eave, a[1], 0, eave, L.wall, L.style, seed, L.flags, st);
      const ib = g.v(b[0], eave, b[1], hw * 2, eave, L.wall, L.style, seed, L.flags, st);
      const ir = g.v(r[0], top, r[1], hw, top, L.wall, L.style, seed, L.flags, st);
      const mx = (a[0] + b[0]) / 2 - cx;
      const my = (a[1] + b[1]) / 2 - cy;
      faceTri(g, ia, ib, ir, [a[0], eave, a[1], b[0], eave, b[1], r[0], top, r[1]], mx, 0, -my);
    }
  } else {
    roofTri(g, [c1[0], eave, c1[1], c2[0], eave, c2[1], r1[0], top, r1[1]], [-hw, 0, hw, 0, 0, endSlope], L, seed);
    roofTri(g, [c3[0], eave, c3[1], c0[0], eave, c0[1], r0[0], top, r0[1]], [hw, 0, -hw, 0, 0, endSlope], L, seed);
  }
  // soffit under the eaves
  const ring = [c0[0], c0[1], c1[0], c1[1], c2[0], c2[1], c3[0], c3[1]];
  flatCap(g, ring, eave - 0.02, 0x2a2a2a, L, seed, false, F_SOFFIT);
}

/** Pyramid over an arbitrary (star-shaped) footprint. */
function polyRoof(g: BGeo, ring: Float32Array, eave: number, roofH: number, L: Look, seed: number): boolean {
  const [cx, cy] = centroid(ring);
  if (!pointInRing(cx, cy, ring)) return false;
  const n = ring.length >> 1;
  const ov = 0.3;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[2 * i];
    const ay = ring[2 * i + 1];
    const bx = ring[2 * j];
    const by = ring[2 * j + 1];
    const da = Math.hypot(ax - cx, ay - cy) || 1;
    const db = Math.hypot(bx - cx, by - cy) || 1;
    const axo = ax + ((ax - cx) / da) * ov;
    const ayo = ay + ((ay - cy) / da) * ov;
    const bxo = bx + ((bx - cx) / db) * ov;
    const byo = by + ((by - cy) / db) * ov;
    const len = Math.hypot(bxo - axo, byo - ayo);
    const sl = Math.hypot((da + db) / 2, roofH);
    roofTri(g, [axo, eave, ayo, bxo, eave, byo, cx, eave + roofH, cy], [u, 0, u + len, 0, u + len / 2, sl], L, seed);
    u += len;
  }
  return true;
}

export interface BuildingIndex {
  grid: IdGrid;
  /** minX, minY, maxX, maxY per building. */
  box: Float32Array;
  big: Uint8Array;
}

export async function buildBuildings(ctx: Ctx, progress: (f: number) => void): Promise<BuildingIndex> {
  const { data, R } = ctx;
  const nx = Math.ceil((R[2] - R[0]) / CHUNK);
  const ny = Math.ceil((R[3] - R[1]) / CHUNK);
  const chunks = new Map<number, BGeo>();
  const mat = makeBuildingMaterial(ctx.tex.noise);
  const n = data.buildings.length;
  const box = new Float32Array(n * 4);
  const big = new Uint8Array(n);
  const grid = new IdGrid(R[0], R[1], R[2], R[3], 40);

  for (let bi = 0; bi < n; bi++) {
    const b = data.buildings[bi];
    if (b.pts.length < 6) continue;
    const ring = oriented(b.pts, true);
    const [x0, y0, x1, y1] = ringBounds(ring);
    box.set([x0, y0, x1, y1], bi * 4);
    grid.addBox(bi, x0, y0, x1, y1);
    const area = Math.abs(signedArea(ring));
    const [cx, cy] = centroid(ring);
    const dens = densityAt(ctx, cx, cy);
    const seed = Math.floor(hash1(bi * 7 + 3) * 255);
    const L = classify(b, area, cx, cy, dens, bi + 1);
    if (L.style !== Style.House && (area > 600 || b.height > 12)) big[bi] = 1;
    const i = Math.min(nx - 1, Math.max(0, Math.floor((cx - R[0]) / CHUNK)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor((cy - R[1]) / CHUNK)));
    const key = j * nx + i;
    let g = chunks.get(key);
    if (!g) {
      g = new BGeo();
      chunks.set(key, g);
    }
    const m = b.minHeight;
    if (L.style === Style.Canopy) {
      const top = b.height;
      const bot = Math.max(m, top - 0.6);
      walls(g, ring, bot, top, L, seed, seed);
      flatCap(g, ring, top, L.roof, L, seed, true, 0);
      flatCap(g, ring, bot, 0x555555, L, seed, false, F_SOFFIT);
    } else if (L.pitched && L.roofH > 0) {
      const o = obb(ring);
      const nv = ring.length >> 1;
      const eave = Math.max(m + 1, L.wallTop);
      walls(g, ring, m, eave, L, seed, seed);
      if (o.fill > 0.78 && nv <= 10) {
        boxRoof(g, o, eave, L.roofH, b.roof === 'g' || (L.style !== Style.House && b.roof !== 'h' && b.roof !== 'p'), L, seed);
      } else if (!(nv <= 14 && polyRoof(g, ring, eave, Math.min(L.roofH, 1.6), L, seed))) {
        flatCap(g, ring, eave, L.roof, L, seed, true, 0);
      }
    } else {
      walls(g, ring, m, b.height, L, seed, seed);
      flatCap(g, ring, b.height, L.roof, L, seed, true, 0);
      if (m > 0.4) flatCap(g, ring, m, 0x4a4a4a, L, seed, false, F_SOFFIT);
    }
    if (bi % 4000 === 0) {
      progress(bi / n);
      await yieldFrame();
    }
  }

  for (const [key, g] of chunks) {
    const geo = g.build();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `buildings-${key}`;
    ctx.root.add(mesh);
    const c = geo.boundingSphere!.center;
    ctx.cull.push({ obj: mesh, x: c.x, z: c.z, range: 7500 });
  }
  return { grid, box, big };
}

