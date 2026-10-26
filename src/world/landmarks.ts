/**
 * Landmark structures built from the data: the Story Bridge's steel
 * cantilever truss over the Bradfield Highway deck (which the road data puts
 * at its real ~30 m height), and the Eleanor Schonell (Green) Bridge's masts,
 * stays and covered paths beside the Eastern Busway deck.
 */
import * as THREE from 'three';
import type { Road } from '../types';
import type { Ctx } from './ctx';
import { COLOR_SPEC, MeshGeo, rgb } from './geo';
import { patch } from './shaders';
import { MASK_WATER, obb, pointInRing } from './util';

/** Outline of the Story Bridge main structure (from extras), if known. */
export function storyOutline(ctx: Ctx): Float32Array | null {
  const ex = ctx.extras;
  if (!ex) return null;
  let best: number[] | null = null;
  for (const b of ex.bridges) {
    if (b.n !== 'Story Bridge') continue;
    // the main span outline is the one reaching furthest north
    let maxY = -Infinity;
    for (let i = 1; i < b.p.length; i += 2) maxY = Math.max(maxY, b.p[i]);
    if (!best || maxY > Math.max(...best.filter((_, i) => i % 2 === 1))) best = b.p;
  }
  return best ? Float32Array.from(best) : null;
}

export function buildStoryBridge(ctx: Ctx): void {
  const outline = storyOutline(ctx);
  if (!outline) return;
  const o = obb(outline);
  // axis from the Kangaroo Point (south) end to the Petrie Bight (north) end
  let ux = o.ux;
  let uy = o.uy;
  if (uy < 0) {
    ux = -ux;
    uy = -uy;
  }
  const vx = -uy;
  const vy = ux;
  const L = o.hl * 2;
  const sx = o.cx - ux * o.hl;
  const sy = o.cy - uy * o.hl;
  // deck height along the axis from the Bradfield Highway bridge roads
  const roads = ctx.data.roads.filter((r) => r.bridge && r.name === 'Bradfield Highway');
  const deckZ = (u: number): number => {
    const x = sx + ux * u;
    const y = sy + uy * u;
    let best = Infinity;
    let z = 30;
    for (const r of roads) {
      for (let i = 0; i + 3 < r.pts.length; i += 2) {
        const ax = r.pts[i];
        const ay = r.pts[i + 1];
        const dx = r.pts[i + 2] - ax;
        const dy = r.pts[i + 3] - ay;
        const l2 = dx * dx + dy * dy || 1;
        let t = ((x - ax) * dx + (y - ay) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
        if (d < best) {
          best = d;
          z = r.z[i >> 1] + (r.z[(i >> 1) + 1] - r.z[i >> 1]) * t;
        }
      }
    }
    return z;
  };
  // main piers at the river banks: centre the 282 m main span on the water crossing
  let w0 = -1;
  let w1 = -1;
  for (let u = 0; u <= L; u += 2) {
    if (ctx.mask.has(sx + ux * u, sy + uy * u, 1)) {
      if (w0 < 0) w0 = u;
      w1 = u;
    }
  }
  const mid = w0 >= 0 ? (w0 + w1) / 2 : L / 2;
  const u1 = Math.max(20, mid - 141);
  const u2 = Math.min(L - 20, mid + 141);
  const half = (u2 - u1) / 2;
  const top = (u: number): number => {
    if (u < u1) return 9 + 31 * Math.pow(u / u1, 1.25);
    if (u > u2) return 9 + 31 * Math.pow((L - u) / (L - u2), 1.25);
    const d = Math.min(u - u1, u2 - u) / half;
    return 12 + 28 * Math.pow(1 - d, 2.2);
  };
  const bot = (u: number): number => {
    const d = Math.min(Math.abs(u - u1), Math.abs(u - u2));
    return -9 * Math.pow(Math.max(0, 1 - d / 75), 1.5) - 0.6;
  };
  const g = new MeshGeo([{ name: 'aLit', size: 1, type: 'f32' }]);
  const W = Math.max(11, o.hw - 1.0);
  const P = (u: number, side: number, h: number) => {
    const z = deckZ(u);
    return [sx + ux * u + vx * side * W, z + h, sy + uy * u + vy * side * W] as const;
  };
  const beam = (a: readonly [number, number, number], b: readonly [number, number, number], r: number, lit = 0) => g.beam(a[0], a[1], a[2], b[0], b[1], b[2], r, lit);
  const panels = Math.round(L / 9.5);
  const us: number[] = [];
  for (let k = 0; k <= panels; k++) us.push((k / panels) * L);
  for (const side of [1, -1]) {
    for (let k = 0; k < us.length; k++) {
      const u = us[k];
      const T = P(u, side, top(u));
      const B = P(u, side, bot(u));
      const isPier = Math.abs(u - u1) < 5 || Math.abs(u - u2) < 5;
      beam(B, T, isPier ? 1.1 : 0.42, 1);
      if (k + 1 < us.length) {
        const u2b = us[k + 1];
        const T2 = P(u2b, side, top(u2b));
        const B2 = P(u2b, side, bot(u2b));
        beam(T, T2, 0.75, 1);
        beam(B, B2, 0.75, 0);
        if (k % 2 === 0) beam(B, T2, 0.32);
        else beam(T, B2, 0.32);
      }
    }
  }
  // overhead lateral bracing and portals
  for (let k = 0; k < us.length; k++) {
    const u = us[k];
    const a = P(u, 1, top(u));
    const b = P(u, -1, top(u));
    beam(a, b, 0.32);
    if (k + 1 < us.length && k % 2 === 0) {
      const u2b = us[k + 1];
      beam(a, P(u2b, -1, top(u2b)), 0.18);
      beam(b, P(u2b, 1, top(u2b)), 0.18);
    }
  }
  // concrete piers under the main and anchor towers
  const conc = new MeshGeo([{ name: 'aLit', size: 1, type: 'f32' }]);
  for (const u of [u1, u2, 2, L - 2]) {
    for (const side of [1, -1]) {
      const x = sx + ux * u + vx * side * W;
      const y = sy + uy * u + vy * side * W;
      const ground = Math.min(ctx.field.natAt(x, y), ctx.data.terrain.waterLevel) - 2;
      const zt = deckZ(u) + bot(u) - 0.4;
      conc.box(x, y, ground, zt, ux, uy, u === u1 || u === u2 ? 3.2 : 2.2, 2.6, 0);
    }
  }
  const mat = patch(new THREE.MeshLambertMaterial({ color: 0x9aa0a6 }), {
    key: 'story',
    vertexPars: 'attribute float aLit;\nvarying float vLit;\nvarying vec3 vSP;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvLit = aLit;\nvSP = (modelMatrix * vec4(transformed, 1.0)).xyz;']],
    fragmentPars: 'uniform float uTime;\nvarying float vLit;\nvarying vec3 vSP;',
    fragment: [
      [
        'vec3 totalEmissiveRadiance = emissive;',
        // floodlit at night, with a slow colour wash along the span on the top chords
        `vec3 wash = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + vSP.z * 0.002 + uTime * 0.02));
        vec3 totalEmissiveRadiance = emissive + uNight * (vec3(0.35, 0.38, 0.45) + vLit * wash * 0.9) * 0.5;`,
      ],
    ],
  });
  const mesh = new THREE.Mesh(g.build(), mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'story-bridge';
  ctx.root.add(mesh);
  const concMat = patch(new THREE.MeshLambertMaterial({ color: 0xb8b2a4 }), { key: 'story-conc' });
  const cm = new THREE.Mesh(conc.build(), concMat);
  cm.castShadow = true;
  cm.receiveShadow = true;
  cm.name = 'story-piers';
  ctx.root.add(cm);
}

// ---------------------------------------------------------------------------
// Eleanor Schonell (Green) Bridge: a cable-stayed busway bridge between UQ
// St Lucia and Dutton Park (2006). The road data has the 7.4 m busway deck;
// this adds the rest of the 20 m deck: shared paths each side under arched
// galvanised ribs and a solar roof, two pairs of slender concrete masts with
// fan stays, twin piers on round pile caps in the river, dark steel girders.

/** A road polyline with distance, height and frame lookups. */
class RoadPath {
  readonly cum: number[] = [0];
  readonly len: number;
  constructor(readonly r: Road) {
    for (let i = 2; i < r.pts.length; i += 2) this.cum.push(this.cum[this.cum.length - 1] + Math.hypot(r.pts[i] - r.pts[i - 2], r.pts[i + 1] - r.pts[i - 1]));
    this.len = this.cum[this.cum.length - 1];
  }
  /** Point, height, unit tangent and left normal at distance u. */
  at(u: number): { x: number; y: number; z: number; tx: number; ty: number; nx: number; ny: number } {
    const p = this.r.pts;
    const s = Math.max(0, Math.min(this.len, u));
    let i = 0;
    while (i < this.cum.length - 2 && this.cum[i + 1] < s) i++;
    const l = Math.max(1e-6, this.cum[i + 1] - this.cum[i]);
    const t = (s - this.cum[i]) / l;
    const tx = (p[2 * i + 2] - p[2 * i]) / l;
    const ty = (p[2 * i + 3] - p[2 * i + 1]) / l;
    return { x: p[2 * i] + tx * l * t, y: p[2 * i + 1] + ty * l * t, z: this.r.z[i] + (this.r.z[i + 1] - this.r.z[i]) * t, tx, ty, nx: -ty, ny: tx };
  }
  /** Distance along and unsigned offset of the nearest point. */
  project(x: number, y: number): { u: number; d: number } {
    const p = this.r.pts;
    let best = { u: 0, d: Infinity };
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i];
      const ay = p[i + 1];
      const dx = p[i + 2] - ax;
      const dy = p[i + 3] - ay;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
      if (d < best.d) best = { u: this.cum[i >> 1] + t * Math.sqrt(l2), d };
    }
    return best;
  }
}

interface GreenSpan {
  path: RoadPath;
  /** Pylon positions (distance along the road). */
  pylons: [number, number];
}

const greenCache = new WeakMap<Ctx, GreenSpan | null>();

/** The Green Bridge's busway road and pylon positions, if the map has it. */
function greenSpan(ctx: Ctx): GreenSpan | null {
  if (greenCache.has(ctx)) return greenCache.get(ctx) ?? null;
  let out: GreenSpan | null = null;
  const outline = ctx.extras?.bridges.find((b) => b.n === 'Eleanor Schonell Bridge')?.p;
  if (outline) {
    let best: RoadPath | null = null;
    for (const r of ctx.data.roads) {
      if (!r.bridge || !r.bus || r.pts.length < 4) continue;
      let inside = 0;
      for (let i = 0; i < r.pts.length; i += 2) if (pointInRing(r.pts[i], r.pts[i + 1], outline)) inside++;
      if (inside * 4 < r.pts.length) continue;
      const path = new RoadPath(r);
      if (!best || path.len > best.len) best = path;
    }
    if (best) {
      let w0 = -1;
      let w1 = -1;
      for (let u = 0; u <= best.len; u += 2) {
        const c = best.at(u);
        if (ctx.mask.has(c.x, c.y, MASK_WATER)) {
          if (w0 < 0) w0 = u;
          w1 = u;
        }
      }
      if (w0 < 0) {
        w0 = best.len * 0.2;
        w1 = best.len * 0.8;
      }
      // 185 m main span centred on the river; the pylons stand in the water near the banks
      const mid = (w0 + w1) / 2;
      const half = Math.max(20, Math.min(92.5, (w1 - w0) / 2 - 12));
      out = { path: best, pylons: [mid - half, mid + half] };
    }
  }
  greenCache.set(ctx, out);
  return out;
}

/**
 * For roads.ts: true where the Green Bridge's own pylons carry the deck (the
 * cable-stayed span), so no generic piers go there.
 */
export function greenBridgeSpan(ctx: Ctx): ((x: number, y: number) => boolean) | null {
  const g = greenSpan(ctx);
  if (!g) return null;
  return (x, y) => {
    const q = g.path.project(x, y);
    return q.d < 14 && q.u > g.pylons[0] - 16 && q.u < g.pylons[1] + 16;
  };
}

const MAST = 0xd3d3cf;
const GALV = 0xb4b9bb;
const PATH = 0xbcb9b1;
const PATH_EDGE = 0xa9a69e;
const GIRDER = 0x27313d;
const SOLAR = 0x323c48;
const ROOF_UNDER = 0xc9cdcf;
const CABLE = 0xe4e4e0;
const PILE = 0xb8b3a7;

type P3 = [number, number, number];

export function buildGreenBridge(ctx: Ctx): void {
  const gs = greenSpan(ctx);
  if (!gs) return;
  const { path, pylons } = gs;
  const g = new MeshGeo(COLOR_SPEC);
  const hw = path.r.width / 2;
  const e0 = hw + 0.45; // busway deck edge (roads.ts)
  const e1 = e0 + 5.35; // outer edge of the paths: 19-20 m overall
  const mastOff = e0 + 0.75;
  const L = path.len;
  const water = ctx.data.terrain.waterLevel;
  const P = (u: number, off: number, h: number): P3 => {
    const c = path.at(u);
    return [c.x + c.nx * off, c.z + h, c.y + c.ny * off];
  };
  const beam = (a: P3, b: P3, r: number, col: number) => g.beam(a[0], a[1], a[2], b[0], b[1], b[2], r, ...rgb(col));
  // stations along the deck every 3 m
  const us: number[] = [];
  for (let u = 0; u < L; u += 3) us.push(u);
  us.push(L);

  // --- path decks, outer girders and the underside
  for (const side of [1, -1]) {
    let prev: number[] | null = null;
    for (const u of us) {
      const c = path.at(u);
      const ix = c.x + c.nx * side * (e0 - 0.05);
      const iy = c.y + c.ny * side * (e0 - 0.05);
      const ox = c.x + c.nx * side * e1;
      const oy = c.y + c.ny * side * e1;
      const v = [
        g.vert(ix, c.z + 0.1, iy, ...rgb(PATH)),
        g.vert(ox, c.z + 0.1, oy, ...rgb(PATH)),
        g.vert(ox, c.z + 0.1, oy, ...rgb(PATH_EDGE)),
        g.vert(ox, c.z - 0.55, oy, ...rgb(PATH_EDGE)),
        g.vert(ox, c.z - 0.55, oy, ...rgb(GIRDER)),
        g.vert(ix, c.z - 0.55, iy, ...rgb(GIRDER)),
      ];
      if (prev) {
        g.up(prev[0], v[0], v[1], prev[1]);
        g.quad(prev[2], v[2], v[3], prev[3], c.nx * side, 0, -c.ny * side);
        g.quad(prev[4], v[4], v[5], prev[5], 0, -1, 0);
      }
      prev = v;
    }
    // dark steel edge girder under the outer edge
    for (let k = 0; k + 1 < us.length; k++) beam(P(us[k], side * (e1 - 0.35), -1.2), P(us[k + 1], side * (e1 - 0.35), -1.2), 0.3, GIRDER);
  }
  // cross girders under the whole deck every 6 m
  for (let u = 3; u < L - 1; u += 6) {
    const c = path.at(u);
    g.box(c.x, c.y, c.z - 2.05, c.z - 0.55, c.nx, c.ny, e1 - 0.2, 0.18, ...rgb(GIRDER));
  }

  // --- outer railings
  for (const side of [1, -1]) {
    const off = side * (e1 - 0.08);
    for (let k = 0; k + 1 < us.length; k++) {
      const u = us[k];
      const u2 = us[k + 1];
      beam(P(u, off, 1.25), P(u2, off, 1.25), 0.035, GALV);
      beam(P(u, off, 0.65), P(u2, off, 0.65), 0.02, GALV);
      beam(P(u, off, 0.15), P(u2, off, 0.15), 0.02, GALV);
      const c = path.at(u);
      g.box(c.x + c.nx * off, c.y + c.ny * off, c.z + 0.1, c.z + 1.25, c.tx, c.ty, 0.03, 0.03, ...rgb(GALV));
    }
  }

  // --- covered paths: ribs rise beside the busway barrier and arch out over the path
  const a = e0 + 0.3;
  const R = 2.7;
  const H0 = 1.1;
  const HR = 2.25;
  const prof: [number, number][] = [[a, 0.1]];
  for (let k = 0; k <= 6; k++) {
    const ph = Math.PI - (k / 6) * (Math.PI / 2);
    prof.push([a + R + R * Math.cos(ph), H0 + HR * Math.sin(ph)]);
  }
  prof.push([e1 + 0.3, H0 + HR - 0.25]);
  const roofFrom = 3; // profile point where the roof sheeting starts
  for (const side of [1, -1]) {
    for (let u = 1.5; u < L - 1; u += 3) {
      if (Math.abs(u - pylons[0]) < 2 || Math.abs(u - pylons[1]) < 2) continue;
      for (let k = 0; k + 1 < prof.length; k++) beam(P(u, side * prof[k][0], prof[k][1]), P(u, side * prof[k + 1][0], prof[k + 1][1]), 0.06, GALV);
    }
    // roof sheeting: solar panels on top, light underside
    for (let k = roofFrom; k + 1 < prof.length; k++) {
      const [l0, h0] = prof[k];
      const [l1, h1] = prof[k + 1];
      let prev: number[] | null = null;
      for (const u of us) {
        const c = path.at(u);
        const pt = (l: number, h: number, col: number) => g.vert(c.x + c.nx * side * l, c.z + h, c.y + c.ny * side * l, ...rgb(col));
        const v = [pt(l0, h0 + 0.08, SOLAR), pt(l1, h1 + 0.08, SOLAR), pt(l0, h0 + 0.03, ROOF_UNDER), pt(l1, h1 + 0.03, ROOF_UNDER)];
        if (prev) {
          // sheet normal: up and outwards across the profile (three.js space)
          const dl = l1 - l0;
          const dh = h1 - h0;
          const fx = -dh * c.nx * side;
          const fy = -dh * c.ny * side;
          g.quad(prev[0], v[0], v[1], prev[1], fx, dl, -fy);
          g.quad(prev[2], v[2], v[3], prev[3], -fx, -dl, fy);
        }
        prev = v;
      }
    }
    // longitudinal tube along the rib bases
    for (let k = 0; k + 1 < us.length; k++) beam(P(us[k], side * a, H0), P(us[k + 1], side * a, H0), 0.05, GALV);
  }

  // --- pylons: twin masts on a round pile cap, fan stays to the deck
  for (const up of pylons) {
    const c = path.at(up);
    const wet = ctx.mask.has(c.x, c.y, MASK_WATER);
    const base = wet ? water : ctx.field.natAt(c.x, c.y);
    if (wet) g.cylinder(c.x, c.y, water - 1.5, water + 1.6, 6.2, 18, ...rgb(PILE));
    else g.box(c.x, c.y, base - 1, base + 0.4, c.tx, c.ty, 3, mastOff + 2, ...rgb(PILE));
    // crosshead under the deck between the masts
    g.box(c.x, c.y, c.z - 2.9, c.z - 2.0, c.nx, c.ny, mastOff, 0.9, ...rgb(MAST));
    for (const side of [1, -1]) {
      const mx = c.x + c.nx * side * mastOff;
      const my = c.y + c.ny * side * mastOff;
      // [height, half length along the deck, half width across]
      const sec: P3[] = [
        [base + 1.6, 1.4, 0.9],
        [c.z - 0.5, 0.95, 0.6],
        [c.z + 48, 0.42, 0.3],
      ];
      for (let k = 0; k + 1 < sec.length; k++) taper(g, mx, my, c.tx, c.ty, sec[k], sec[k + 1], MAST);
      // stays: nine each way in a fan, the outermost to the top
      for (const dir of [1, -1]) {
        for (let k = 0; k < 9; k++) {
          const ud = up + dir * (14 + k * 9.4);
          if (ud < 3 || ud > L - 3) continue;
          beam(P(up, side * mastOff, 30.5 + k * 2.1), P(ud, side * mastOff, 0.35), 0.045, CABLE);
        }
      }
    }
  }
  const mat = patch(new THREE.MeshLambertMaterial({ vertexColors: true }), { key: 'green-bridge' });
  const mesh = new THREE.Mesh(g.build(), mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'green-bridge';
  ctx.root.add(mesh);
}

/** A tapered vertical box between sections [height, half length along (ux, uy), half width]. */
function taper(g: MeshGeo, x: number, y: number, ux: number, uy: number, a: P3, b: P3, col: number): void {
  const vx = -uy;
  const vy = ux;
  const cs: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const c = rgb(col);
  const pt = (s: P3, q: [number, number]) => g.vert(x + ux * q[0] * s[1] + vx * q[1] * s[2], s[0], y + uy * q[0] * s[1] + vy * q[1] * s[2], ...c);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const mx = ux * (cs[i][0] + cs[j][0]) + vx * (cs[i][1] + cs[j][1]);
    const my = uy * (cs[i][0] + cs[j][0]) + vy * (cs[i][1] + cs[j][1]);
    g.quad(pt(a, cs[i]), pt(a, cs[j]), pt(b, cs[j]), pt(b, cs[i]), mx, 0, -my);
  }
  const top = cs.map((q) => pt(b, q));
  g.up(top[0], top[1], top[2], top[3]);
}

// ---------------------------------------------------------------------------
// Victoria Bridge (1969): bus/Metro only since 2021, with a two-way cycleway
// and footpaths beside the busway. The road data has the 7.4 m busway; this
// fills the rest of the bridge outline (≈22 m) with path decks, the green
// cycleway and the balustrade.

const CYCLE = 0x3f7d4f;
const FOOT = 0xc2bdb2;
const BALUSTRADE = 0xd2cdc2;
const FASCIA = 0xb9b3a7;
const SOFFIT = 0x8c877e;

export function buildVictoriaBridge(ctx: Ctx): void {
  const outline = ctx.extras?.bridges.find((b) => b.n === 'Victoria Bridge')?.p;
  if (!outline) return;
  const o = obb(outline);
  const vx = -o.uy;
  const vy = o.ux;
  const roads: Road[] = [];
  for (const r of ctx.data.roads) {
    if (!r.bridge || !r.bus || r.pts.length < 4) continue;
    let inside = false;
    for (let i = 0; i < r.pts.length && !inside; i += 2) inside = pointInRing(r.pts[i], r.pts[i + 1], outline);
    if (inside) roads.push(r);
  }
  if (!roads.length) return;
  // samples across the bridge every metre. Each busway carriageway crossing the row line covers it out to
  // its deck's edge (hw + 0.45, its parapet's outer face, as roads.ts draws it), measured along the row;
  // the path decks run from the outermost of those edges to the outline, at that carriageway's height.
  // (Each carriageway's own width: the 10.9 m three-lane piece at the north end is not the 7.4 m busway
  // across the span, which a single bridge-wide width left a 1.7 m slot of river beside.)
  // (and a row at each carriageway vertex, so the decks' edges bend together)
  const us: number[] = [];
  for (let u = -o.hl; u <= o.hl + 0.01; u += 1) us.push(u);
  for (const r of roads) {
    for (let k = 0; k < r.pts.length; k += 2) {
      const u = (r.pts[k] - o.cx) * o.ux + (r.pts[k + 1] - o.cy) * o.uy;
      if (Math.abs(u) < o.hl && us.every((q) => Math.abs(q - u) > 0.3)) us.push(u);
    }
  }
  us.sort((a, b) => a - b);
  const rows: { x: number; y: number; zp: number; zm: number; ip: number; im: number; ep: number; em: number }[] = [];
  for (const u of us) {
    const x = o.cx + o.ux * u;
    const y = o.cy + o.uy * u;
    let ip = -Infinity;
    let im = Infinity;
    let zp = NaN;
    let zm = NaN;
    for (const r of roads) {
      const p = r.pts;
      const edge = r.width / 2 + 0.45;
      for (let k = 0; k + 3 < p.length; k += 2) {
        const ax = p[k];
        const ay = p[k + 1];
        const dx = p[k + 2] - ax;
        const dy = p[k + 3] - ay;
        const den = vx * dy - vy * dx;
        if (Math.abs(den) < 1e-9) continue;
        const s = ((ax - x) * vy - (ay - y) * vx) / den;
        if (s < 0 || s > 1) continue;
        const cos = Math.abs(dx * o.ux + dy * o.uy) / Math.hypot(dx, dy);
        if (cos < 0.5) continue;
        const t = ((ax - x) * dy - (ay - y) * dx) / den;
        const z = r.z[k >> 1] + (r.z[(k >> 1) + 1] - r.z[k >> 1]) * s;
        if (t + edge / cos > ip) {
          ip = t + edge / cos;
          zp = z;
        }
        if (t - edge / cos < im) {
          im = t - edge / cos;
          zm = z;
        }
      }
    }
    // the outline's edges either side of the axis here
    const ep = rayRing(outline, x, y, vx, vy);
    const em = rayRing(outline, x, y, -vx, -vy);
    const ok = Number.isFinite(zp) && ep < 20 && em < 20;
    rows.push(ok ? { x, y, zp, zm, ip, im, ep, em } : { x, y, zp: NaN, zm: NaN, ip: 0, im: 0, ep: 0, em: 0 });
  }
  const g = new MeshGeo(COLOR_SPEC);
  // the wider side carries the cycleway beside the busway
  let wide = 0;
  for (const r of rows) if (Number.isFinite(r.zp)) wide += r.ep - r.ip - (r.em + r.im);
  const cycleSide = wide >= 0 ? 1 : -1;
  for (const side of [1, -1]) {
    let prev: { v: number[]; r: (typeof rows)[number]; z: number; outer: number } | null = null;
    let post = Infinity;
    for (const r of rows) {
      if (!Number.isFinite(r.zp)) {
        prev = null;
        post = Infinity;
        continue;
      }
      // a little under the parapet's outer face, so no slot shows between them
      const inner = (side > 0 ? r.ip : r.im) - side * 0.05;
      const outer = side > 0 ? r.ep : -r.em;
      const z = side > 0 ? r.zp : r.zm;
      const width = (outer - inner) * side;
      if (width < 1) {
        prev = null;
        post = Infinity;
        continue;
      }
      const at = (l: number, h: number, col: number) => g.vert(r.x + vx * l, z + h, r.y + vy * l, ...rgb(col));
      const cyc = side === cycleSide && width > 5 ? 3.0 : 0;
      const l1 = inner + side * cyc;
      const v = [
        at(inner, 0.08, CYCLE),
        at(l1, 0.08, CYCLE),
        at(l1, 0.12, FOOT),
        at(outer, 0.12, FOOT),
        at(outer, 0.12, FASCIA),
        at(outer, -1.5, FASCIA),
        at(outer, -1.5, SOFFIT),
        at(inner, -1.5, SOFFIT),
        at(l1, 0.08, FOOT),
        at(l1, 0.12, FOOT),
      ];
      if (prev) {
        const p = prev.v;
        if (cyc) g.up(p[0], v[0], v[1], p[1]);
        g.up(p[2], v[2], v[3], p[3]);
        g.quad(p[4], v[4], v[5], p[5], vx * side, 0, -vy * side);
        g.quad(p[6], v[6], v[7], p[7], 0, -1, 0);
        if (cyc) g.quad(p[8], v[8], v[9], p[9], -vx * side, 0, vy * side);
        // balustrade: a continuous rail on posts
        const ax = prev.r.x + vx * (prev.outer - side * 0.18);
        const ay = prev.r.y + vy * (prev.outer - side * 0.18);
        const bx = r.x + vx * (outer - side * 0.18);
        const by = r.y + vy * (outer - side * 0.18);
        g.beam(ax, prev.z + 1.02, ay, bx, z + 1.02, by, 0.11, ...rgb(BALUSTRADE));
        g.beam(ax, prev.z + 0.22, ay, bx, z + 0.22, by, 0.09, ...rgb(BALUSTRADE));
        // its posts about every 3 m
        if (post > 2.9) {
          g.box(ax, ay, prev.z + 0.1, prev.z + 0.95, o.ux, o.uy, 0.12, 0.12, ...rgb(BALUSTRADE));
          post = 0;
        }
        post += Math.hypot(bx - ax, by - ay);
      }
      prev = { v, r, z, outer };
    }
  }
  if (g.empty) return;
  const mat = patch(new THREE.MeshLambertMaterial({ vertexColors: true }), { key: 'victoria-bridge' });
  const mesh = new THREE.Mesh(g.build(), mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'victoria-bridge';
  ctx.root.add(mesh);
}

/** Distance from (x, y) along unit (dx, dy) to a ring's boundary, or Infinity. */
function rayRing(p: ArrayLike<number>, x: number, y: number, dx: number, dy: number): number {
  const n = p.length / 2;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[2 * i];
    const ay = p[2 * i + 1];
    const ex = p[2 * j] - ax;
    const ey = p[2 * j + 1] - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - x) * ey - (ay - y) * ex) / den;
    const s = ((ax - x) * dy - (ay - y) * dx) / den;
    if (t >= 0 && s >= 0 && s <= 1 && t < best) best = t;
  }
  return best;
}
