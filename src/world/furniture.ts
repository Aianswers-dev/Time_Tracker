/**
 * Street furniture: traffic signals (with a deterministic phase cycle shared
 * by the lamp shader and signalStateAt), stop lines, pedestrian crossings,
 * street lights that glow at night, railway track and overhead masts, and bus
 * stop shelters.
 */
import * as THREE from 'three';
import { RoadKind } from '../types';
import { type Ctx, densityAt } from './ctx';
import { MeshGeo } from './geo';
import type { RoadIndex } from './roadindex';
import { type RI, markMaterial, roadAt, structMaterial } from './roads';
import { U, patch } from './shaders';
import { IdGrid, MASK_WATER, hash1, hash2, walk, yieldFrame } from './util';

// ---------------------------------------------------------------------------
// Signal timing (keep in sync with SIGNAL_GLSL)

const AMBER = 3.5;
const ALL_RED = 2;

export interface Junction {
  x: number;
  y: number;
  /** Main approach axis (unit, map coords). */
  ax: number;
  ay: number;
  cycle: number;
  gA: number;
  gB: number;
  offset: number;
  /** Arms (unit vectors pointing out of the junction) and their phase group. */
  arms?: { ux: number; uy: number; g: number }[];
}

export type Light = 'green' | 'amber' | 'red';

export function phaseState(j: Junction, group: number, t: number): Light {
  const tau = (((t + j.offset) % j.cycle) + j.cycle) % j.cycle;
  if (group === 0) {
    if (tau < j.gA) return 'green';
    if (tau < j.gA + AMBER) return 'amber';
    return 'red';
  }
  const s = j.gA + AMBER + ALL_RED;
  if (j.gB <= 0) return 'red';
  if (tau >= s && tau < s + j.gB) return 'green';
  if (tau >= s + j.gB && tau < s + j.gB + AMBER) return 'amber';
  return 'red';
}

const SIGNAL_GLSL = /* glsl */ `
uniform float uSignalTime;
varying float vLamp;
varying vec4 vSig;
varying float vGroup;
float sigState(vec4 sg, float group, float t) {
  // returns 0 red, 1 amber, 2 green
  float cyc = sg.y;
  float tau = mod(t + sg.x, cyc);
  if (group < 0.5) {
    if (tau < sg.z) return 2.0;
    if (tau < sg.z + ${AMBER.toFixed(1)}) return 1.0;
    return 0.0;
  }
  float s = sg.z + ${(AMBER + ALL_RED).toFixed(1)};
  if (sg.w <= 0.0) return 0.0;
  if (tau >= s && tau < s + sg.w) return 2.0;
  if (tau >= s + sg.w && tau < s + sg.w + ${AMBER.toFixed(1)}) return 1.0;
  return 0.0;
}
`;

// ---------------------------------------------------------------------------
// Templates

function headTemplate(): THREE.BufferGeometry {
  const g = new MeshGeo([{ name: 'aLamp', size: 1, type: 'f32' }]);
  // housing: 0.34 w x 1.0 h x 0.24 d, front faces local +z (map -y)
  g.box(0, 0, -0.5, 0.5, 1, 0, 0.17, 0.12, -1);
  // backboard
  g.box(0, 0.13, -0.62, 0.62, 1, 0, 0.3, 0.012, -2);
  for (let i = 0; i < 3; i++) {
    const yc = 0.33 - i * 0.33;
    const r = 0.115;
    const n = 10;
    const z = -0.125; // map y; three z = +0.125 (front)
    const c = g.vert(0, yc, z, i);
    let prev = -1;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2;
      const v = g.vert(Math.cos(a) * r, yc + Math.sin(a) * r, z, i);
      if (prev >= 0) g.tri(c, prev, v, 0, 0, 1);
      prev = v;
    }
    // visor
    g.box(0, -0.2, yc + 0.125, yc + 0.14, 1, 0, 0.13, 0.08, -1);
  }
  return g.build();
}

function poleTemplate(): THREE.BufferGeometry {
  const g = new MeshGeo([]);
  g.cylinder(0, 0, 0, 1, 0.5, 7);
  return g.build();
}

function boxTemplate(): THREE.BufferGeometry {
  const g = new MeshGeo([]);
  g.box(0, 0, -0.5, 0.5, 1, 0, 0.5, 0.5);
  return g.build();
}

/** Street light: pole 9 m, outreach arm toward local +x, luminaire at the end. */
function streetLightTemplate(): THREE.BufferGeometry {
  const g = new MeshGeo([{ name: 'aGlow', size: 1, type: 'f32' }]);
  g.cylinder(0, 0, 0, 9, 0.11, 6, 0);
  g.beam(0, 8.8, 0, 2.4, 9.25, 0, 0.05, 0);
  g.box(2.55, 0, 9.12, 9.3, 1, 0, 0.42, 0.16, 0);
  // lens (glows at night)
  const a = g.vert(2.15, 9.11, -0.13, 1);
  const b = g.vert(2.95, 9.11, -0.13, 1);
  const c = g.vert(2.95, 9.11, 0.13, 1);
  const d = g.vert(2.15, 9.11, 0.13, 1);
  g.quad(a, b, c, d, 0, -1, 0);
  return g.build();
}

function shelterTemplate(): THREE.BufferGeometry {
  const g = new MeshGeo([{ name: 'color', size: 3, type: 'u8', normalized: true }]);
  const steel = [58, 62, 66];
  const glass = [120, 140, 150];
  const ad = [235, 235, 225];
  // posts
  for (const x of [-1.9, 1.9]) for (const y of [-0.7, 0.6]) g.box(x, y, 0, 2.6, 1, 0, 0.04, 0.04, ...steel);
  // roof
  g.box(0, -0.05, 2.6, 2.72, 1, 0, 2.1, 0.95, ...steel);
  // back glass panel (map +y is the back)
  g.box(0, 0.62, 0.15, 2.4, 1, 0, 1.85, 0.015, ...glass);
  // advertising panel at one end
  g.box(1.95, 0, 0.1, 2.3, 0, 1, 0.65, 0.06, ...ad);
  // bench
  g.box(0, 0.35, 0.45, 0.5, 1, 0, 1.2, 0.18, ...steel);
  // stop sign pole at the kerb
  g.cylinder(-2.6, -0.9, 0, 2.8, 0.04, 5, 200, 200, 200);
  g.box(-2.6, -0.9, 2.1, 2.75, 1, 0, 0.22, 0.02, 250, 250, 245);
  return g.build();
}

// ---------------------------------------------------------------------------

interface Arm {
  y: number;
  ux: number;
  uy: number;
  hw: number;
  lanes: number;
  oneway: boolean;
  kind: RoadKind;
  incoming: boolean;
}

export interface Signals {
  junctions: Junction[];
  grid: IdGrid;
  /**
   * State for the junction nearest (x, y). With a travel direction (dirX, dirY)
   * the approach group comes from the direction of travel, which is exact;
   * otherwise it is guessed from the bearing of (x, y) from the junction centre
   * (ambiguous for points at the centre or on a corner).
   */
  stateAt(x: number, y: number, t: number, dirX?: number, dirY?: number): Light | null;
}

export async function buildFurniture(ctx: Ctx, roads: { infos: RI[]; index: RoadIndex }, progress: (f: number) => void): Promise<Signals> {
  const { data, R } = ctx;
  const index = roads.index;
  const infos = roads.infos;
  const marks = new MeshGeo([{ name: 'aMark', size: 2, type: 'f32' }]);

  // ---- cluster signal nodes into junctions
  const sig = data.signals;
  const ns = sig.length >> 1;
  const parent = new Int32Array(ns).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const sg = new IdGrid(R[0], R[1], R[2], R[3], 30);
  for (let i = 0; i < ns; i++) sg.addPoint(i, sig[2 * i], sig[2 * i + 1]);
  for (let i = 0; i < ns; i++) {
    const x = sig[2 * i];
    const y = sig[2 * i + 1];
    sg.query(x - 28, y - 28, x + 28, y + 28, (j) => {
      if (j <= i) return;
      if (Math.hypot(sig[2 * j] - x, sig[2 * j + 1] - y) < 28) parent[find(j)] = find(i);
    });
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < ns; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) {
      g = [];
      groups.set(r, g);
    }
    g.push(i);
  }

  const junctions: Junction[] = [];
  interface Head {
    x: number;
    y: number;
    h: number;
    fx: number;
    fy: number;
    j: number;
    group: number;
  }
  const heads: Head[] = [];
  const poles: { x: number; y: number; h: number }[] = [];
  const arms: { x: number; y: number; dx: number; dy: number; len: number; h: number }[] = [];

  const stopLine = (sx: number, sy: number, tx: number, ty: number, o0: number, o1: number, h: number) => {
    // across the lanes; t = travel direction, left normal l = (-ty, tx)
    const lx = -ty;
    const ly = tx;
    const w = 0.22;
    const a = marks.vert(sx + lx * o0 - tx * w, h, sy + ly * o0 - ty * w, 0, 0);
    const b = marks.vert(sx + lx * o1 - tx * w, h, sy + ly * o1 - ty * w, 0, 0);
    const c = marks.vert(sx + lx * o1 + tx * w, h, sy + ly * o1 + ty * w, 0, 0);
    const d = marks.vert(sx + lx * o0 + tx * w, h, sy + ly * o0 + ty * w, 0, 0);
    marks.up(a, b, c, d);
  };

  for (const members of groups.values()) {
    let cx = 0;
    let cy = 0;
    for (const m of members) {
      cx += sig[2 * m];
      cy += sig[2 * m + 1];
    }
    cx /= members.length;
    cy /= members.length;
    // approaches
    const found: Arm[] = [];
    const seen = new Set<number>();
    index.roadsNear(cx, cy, 24, (road) => {
      if (seen.has(road)) return;
      seen.add(road);
      const ri = infos[road];
      const rd = ri.r;
      if (rd.tunnel || rd.kind === RoadKind.Pedestrian) return;
      // project centre onto road
      let best = Infinity;
      let s0 = 0;
      const p = rd.pts;
      for (let k = 0; k + 1 < ri.n; k++) {
        const ax = p[2 * k];
        const ay = p[2 * k + 1];
        const dx = p[2 * k + 2] - ax;
        const dy = p[2 * k + 3] - ay;
        const l2 = dx * dx + dy * dy || 1;
        let t = ((cx - ax) * dx + (cy - ay) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(ax + dx * t - cx, ay + dy * t - cy);
        if (d < best) {
          best = d;
          s0 = ri.cum[k] + t * Math.sqrt(l2);
        }
      }
      for (const dir of [1, -1]) {
        const s = s0 + dir * 16;
        if (s < 0 || s > ri.len) continue;
        const q = roadAt(ri, s);
        let ux = q.x - cx;
        let uy = q.y - cy;
        const l = Math.hypot(ux, uy);
        if (l < 4) continue;
        ux /= l;
        uy /= l;
        const incoming = !rd.oneway || dir === -1;
        found.push({ y: ri.y, ux, uy, hw: ri.hw, lanes: rd.lanes, oneway: rd.oneway, kind: rd.kind, incoming });
      }
    });
    if (!found.length) continue;
    // merge arms pointing the same way
    const armsJ: Arm[] = [];
    for (const a of found.sort((p, q) => q.hw - p.hw)) {
      const m = armsJ.find((b) => a.ux * b.ux + a.uy * b.uy > 0.9);
      if (m) m.incoming = m.incoming || a.incoming;
      else armsJ.push({ ...a });
    }
    const main = [...armsJ].sort((p, q) => p.kind - q.kind || q.hw - p.hw)[0];
    const groupOf = (a: Arm) => (Math.abs(a.ux * main.ux + a.uy * main.uy) > 0.7 ? 0 : 1);
    const hasB = armsJ.some((a) => groupOf(a) === 1);
    const majorish = main.kind <= RoadKind.Secondary;
    const cycle = hasB ? (majorish ? 90 : 70) : 60;
    const usable = cycle - 2 * (AMBER + ALL_RED);
    const gA = hasB ? usable * (main.kind <= RoadKind.Primary ? 0.62 : 0.55) : cycle - 20;
    const gB = hasB ? usable - gA : 0;
    const jn: Junction = {
      x: cx,
      y: cy,
      ax: main.ux,
      ay: main.uy,
      cycle,
      gA,
      gB,
      offset: hash2(cx, cy, 71) * cycle,
      arms: armsJ.map((a) => ({ ux: a.ux, uy: a.uy, g: groupOf(a) })),
    };
    const ji = junctions.length;
    junctions.push(jn);

    for (const a of armsJ) {
      if (!a.incoming) continue;
      let ds = 6;
      for (const b of armsJ) if (b !== a) ds = Math.max(ds, b.hw + 2.5);
      ds = Math.min(ds, 22);
      const sx = cx + a.ux * ds;
      const sy = cy + a.uy * ds;
      const tx = -a.ux;
      const ty = -a.uy;
      const lx = -ty;
      const ly = tx;
      const group = groupOf(a);
      // stop line across the incoming lanes (left half for two-way roads)
      if (a.kind !== RoadKind.Service) stopLine(sx, sy, tx, ty, a.oneway ? -a.hw + 0.3 : 0.2, a.hw - 0.3, a.y + 0.003);
      // primary pole on the left kerb
      const px = sx + lx * (a.hw + 0.9);
      const py = sy + ly * (a.hw + 0.9);
      if (index.penetration(px, py) > -0.3) continue;
      poles.push({ x: px, y: py, h: 4.6 });
      heads.push({ x: px, y: py, h: 3.4, fx: a.ux, fy: a.uy, j: ji, group });
      const multi = (a.oneway ? a.lanes : a.lanes / 2) >= 2 || a.kind <= RoadKind.Secondary;
      if (multi) {
        const len = Math.min(a.oneway ? a.hw * 1.3 : a.hw * 0.9, 9);
        poles.push({ x: px, y: py, h: 6.4 });
        arms.push({ x: px, y: py, dx: -lx, dy: -ly, len, h: 6.2 });
        heads.push({ x: px - lx * len, y: py - ly * len, h: 5.6, fx: a.ux, fy: a.uy, j: ji, group });
      }
      // far-side right pole (across the junction) for major roads
      if (a.kind <= RoadKind.Secondary) {
        const fx = cx - a.ux * ds - lx * (a.oneway ? a.hw + 0.9 : 1.5);
        const fy = cy - a.uy * ds - ly * (a.oneway ? a.hw + 0.9 : 1.5);
        if (index.penetration(fx, fy) < -0.3) {
          poles.push({ x: fx, y: fy, h: 4.6 });
          heads.push({ x: fx, y: fy, h: 3.4, fx: a.ux, fy: a.uy, j: ji, group });
        }
      }
    }
  }
  progress(0.25);
  await yieldFrame();

  // ---- signal meshes
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const struct = structMaterial(ctx, 'furn');
  {
    const poleMat = patch(new THREE.MeshLambertMaterial({ color: 0x8c9294 }), { key: 'pole' });
    const pm = new THREE.InstancedMesh(poleTemplate(), poleMat, poles.length);
    poles.forEach((p, i) => {
      m4.makeScale(0.2, p.h, 0.2).setPosition(p.x, 0, -p.y);
      pm.setMatrixAt(i, m4);
    });
    const am = new THREE.InstancedMesh(boxTemplate(), poleMat, arms.length);
    arms.forEach((a, i) => {
      const ang = Math.atan2(a.dy, a.dx); // local +x -> map direction (dx, dy)
      q.setFromAxisAngle(yAxis, ang);
      v.set(a.x + (a.dx * a.len) / 2, a.h, -(a.y + (a.dy * a.len) / 2));
      sc.set(a.len, 0.16, 0.16);
      m4.compose(v, q, sc);
      am.setMatrixAt(i, m4);
    });
    const headMat = patch(new THREE.MeshLambertMaterial({ color: 0x1a1c1e }), {
      key: 'sighead',
      vertexPars: 'attribute float aLamp;\nattribute vec4 iSig;\nattribute float iGroup;\nvarying float vLamp;\nvarying vec4 vSig;\nvarying float vGroup;',
      vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvLamp = aLamp;\nvSig = iSig;\nvGroup = iGroup;']],
      fragmentPars: SIGNAL_GLSL,
      fragment: [
        [
          'vec4 diffuseColor = vec4( diffuse, opacity );',
          `vec3 base = diffuse;
          vec3 lampGlow = vec3(0.0);
          if (vLamp < -1.5) base = vec3(0.02);
          else if (vLamp > -0.5) {
            float st = sigState(vSig, vGroup, uSignalTime);
            float idx = floor(vLamp + 0.5);
            vec3 lc = idx < 0.5 ? vec3(1.0, 0.08, 0.04) : idx < 1.5 ? vec3(1.0, 0.55, 0.0) : vec3(0.1, 1.0, 0.45);
            float on = (idx < 0.5 && st < 0.5) || (idx > 0.5 && idx < 1.5 && st > 0.5 && st < 1.5) || (idx > 1.5 && st > 1.5) ? 1.0 : 0.0;
            base = lc * 0.08;
            lampGlow = lc * on * 4.0;
          }
          vec4 diffuseColor = vec4( base, opacity );`,
        ],
        ['vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive + lampGlow;'],
      ],
    });
    const hgeo = headTemplate();
    const hm = new THREE.InstancedMesh(hgeo, headMat, heads.length);
    const sigAttr = new Float32Array(heads.length * 4);
    const grpAttr = new Float32Array(heads.length);
    heads.forEach((h, i) => {
      // local +z (front) should face map direction (fx, fy) -> three (fx, 0, -fy)
      const ang = Math.atan2(h.fx, -h.fy);
      q.setFromAxisAngle(yAxis, ang);
      v.set(h.x, h.h, -h.y);
      sc.set(1, 1, 1);
      m4.compose(v, q, sc);
      hm.setMatrixAt(i, m4);
      const j = junctions[h.j];
      sigAttr.set([j.offset, j.cycle, j.gA, j.gB], i * 4);
      grpAttr[i] = h.group;
    });
    hgeo.setAttribute('iSig', new THREE.InstancedBufferAttribute(sigAttr, 4));
    hgeo.setAttribute('iGroup', new THREE.InstancedBufferAttribute(grpAttr, 1));
    for (const m of [pm, am, hm]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.computeBoundingSphere();
      m.frustumCulled = false;
      ctx.root.add(m);
    }
    pm.name = 'signal-poles';
    am.name = 'signal-arms';
    hm.name = 'signal-heads';
  }
  progress(0.35);
  await yieldFrame();

  // ---- pedestrian crossings
  const cr = data.crossings;
  const jgrid = new IdGrid(R[0], R[1], R[2], R[3], 50);
  junctions.forEach((j, i) => jgrid.addPoint(i, j.x, j.y));
  const nearJunction = (x: number, y: number, r: number) => {
    let hit = false;
    jgrid.query(x - r, y - r, x + r, y + r, (i) => {
      if (Math.hypot(junctions[i].x - x, junctions[i].y - y) < r) hit = true;
    });
    return hit;
  };
  for (let i = 0; i < cr.length; i += 2) {
    const x = cr[i];
    const y = cr[i + 1];
    const nr = index.nearest(x, y, 6);
    if (!nr) continue;
    const rd = infos[nr.road].r;
    if (rd.kind === RoadKind.Motorway || rd.kind === RoadKind.Service || rd.tunnel) continue;
    const hw = infos[nr.road].hw;
    const tx = nr.dx;
    const ty = nr.dy;
    const lx = -ty;
    const ly = tx;
    const h = infos[nr.road].y + 0.003;
    const signalised = nearJunction(x, y, 40);
    const P = (a: number, b: number) => [nr.px + tx * a + lx * b, nr.py + ty * a + ly * b];
    const quad = (a0: number, a1: number, b0: number, b1: number) => {
      const p0 = P(a0, b0);
      const p1 = P(a1, b0);
      const p2 = P(a1, b1);
      const p3 = P(a0, b1);
      const ia = marks.vert(p0[0], h, p0[1], 0, 0);
      const ib = marks.vert(p1[0], h, p1[1], 0, 0);
      const ic = marks.vert(p2[0], h, p2[1], 0, 0);
      const id = marks.vert(p3[0], h, p3[1], 0, 0);
      marks.up(ia, ib, ic, id);
    };
    if (signalised) {
      // two parallel lines bounding the walk
      quad(-1.7, -1.45, -hw + 0.2, hw - 0.2);
      quad(1.45, 1.7, -hw + 0.2, hw - 0.2);
    } else {
      for (let b = -hw + 0.4; b < hw - 0.5; b += 1.1) quad(-1.6, 1.6, b, b + 0.55);
    }
  }
  {
    const mm = new THREE.Mesh(marks.build(), markMaterial(ctx));
    mm.name = 'crossings';
    mm.receiveShadow = true;
    mm.frustumCulled = false;
    ctx.root.add(mm);
  }
  progress(0.45);
  await yieldFrame();

  // ---- street lights
  {
    interface SL {
      x: number;
      y: number;
      ang: number;
    }
    const lights: SL[] = [];
    for (const ri of infos) {
      const rd = ri.r;
      if (rd.tunnel || rd.kind === RoadKind.Pedestrian || rd.kind === RoadKind.Service || rd.kind === RoadKind.Busway) continue;
      const major = rd.kind <= RoadKind.Tertiary;
      const step = rd.kind === RoadKind.Motorway ? 48 : major ? 36 : 55;
      const sides = rd.kind <= RoadKind.Primary && !rd.oneway && rd.width > 12 ? [1, -1] : [1];
      for (const side of sides) {
        const phase = hash1(ri.i * 3 + side) * step + (side < 0 ? step / 2 : 0);
        for (let s = phase; s < ri.len - 3; s += step) {
          const c = roadAt(ri, s);
          const off = ri.hw + (rd.bridge ? 0.5 : 1.0);
          const x = c.x + c.nx * side * off;
          const y = c.y + c.ny * side * off;
          if (index.penetration(x, y, ri.i) > -0.4) continue;
          if (!rd.bridge && ctx.mask.has(x, y, MASK_WATER)) continue;
          // arm points back over the road: local +x -> map (-nx*side, -ny*side)
          const dx = -c.nx * side;
          const dy = -c.ny * side;
          lights.push({ x, y, ang: Math.atan2(dy, dx) });
        }
      }
    }
    const tpl = streetLightTemplate();
    const poleMat = patch(new THREE.MeshLambertMaterial({ color: 0x9a9fa2 }), {
      key: 'slight',
      vertexPars: 'attribute float aGlow;\nvarying float vGlow;',
      vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;']],
      fragmentPars: 'varying float vGlow;',
      fragment: [['vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive + vec3(1.0, 0.82, 0.55) * vGlow * (0.3 + uNight * 5.0);']],
    });
    const glowTex = ctx.tex.glow;
    const glowMat = patch(
      new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffd9a0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      {
        key: 'glow',
        fogFade: true,
        projectAnchor: '// W_PROJECT',
        vertex: [
          [
            '#include <project_vertex>',
            `vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            float gsz = length(instanceMatrix[0].xyz);
            mvPosition.xy += position.xy * gsz;
            gl_Position = projectionMatrix * mvPosition;
            // W_PROJECT`,
          ],
        ],
        fragment: [['vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse * uNight * 1.3, opacity );']],
      },
    );
    const poolMat = patch(
      new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffc98a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      {
        key: 'pool',
        fogFade: true,
        fragment: [['vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse * uNight * 0.75, opacity );']],
      },
    );
    const quadGeo = new THREE.PlaneGeometry(1, 1);
    const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const CH = 1500;
    const nx = Math.ceil((R[2] - R[0]) / CH);
    const byChunk = new Map<number, SL[]>();
    for (const l of lights) {
      const key = Math.max(0, Math.floor((l.y - R[1]) / CH)) * nx + Math.max(0, Math.min(nx - 1, Math.floor((l.x - R[0]) / CH)));
      let a = byChunk.get(key);
      if (!a) {
        a = [];
        byChunk.set(key, a);
      }
      a.push(l);
    }
    for (const [key, ls] of byChunk) {
      const n = ls.length;
      const pm = new THREE.InstancedMesh(tpl, poleMat, n);
      const gm = new THREE.InstancedMesh(quadGeo, glowMat, n);
      const om = new THREE.InstancedMesh(poolGeo, poolMat, n);
      let cx = 0;
      let cz = 0;
      ls.forEach((l, i) => {
        q.setFromAxisAngle(yAxis, l.ang);
        v.set(l.x, 0, -l.y);
        m4.compose(v, q, sc.set(1, 1, 1));
        pm.setMatrixAt(i, m4);
        const hx = l.x + Math.cos(l.ang) * 2.55;
        const hz = -l.y - Math.sin(l.ang) * 2.55;
        m4.makeScale(3.2, 3.2, 3.2).setPosition(hx, 9.0, hz);
        gm.setMatrixAt(i, m4);
        m4.makeScale(17, 1, 17).setPosition(hx, 0.17, hz);
        om.setMatrixAt(i, m4);
        cx += l.x;
        cz -= l.y;
      });
      pm.castShadow = true;
      pm.receiveShadow = true;
      for (const m of [pm, gm, om]) {
        m.computeBoundingSphere();
        m.name = `streetlights-${key}`;
        ctx.root.add(m);
      }
      gm.renderOrder = 5;
      om.renderOrder = 4;
      cx /= n;
      cz /= n;
      ctx.cull.push({ obj: pm, x: cx, z: cz, range: 2600 });
      ctx.cull.push({ obj: gm, x: cx, z: cz, range: 6000 });
      ctx.cull.push({ obj: om, x: cx, z: cz, range: 2600 });
      nightOnly.push(gm, om);
    }
    ctx.tick.push(() => {
      // glows and light pools only exist after dusk
      if (U.uNight.value < 0.02) for (const o of nightOnly) o.visible = false;
    });
  }
  progress(0.65);
  await yieldFrame();

  // ---- railway: ballast + sleepers + rails, overhead masts
  {
    const track = new MeshGeo([
      { name: 'uv', size: 2, type: 'f32' },
      { name: 'color', size: 3, type: 'u8', normalized: true },
    ]);
    const masts: { x: number; y: number; ang: number }[] = [];
    for (const rl of data.rail) {
      if (rl.tunnel) continue;
      const p = rl.pts;
      const n = p.length >> 1;
      if (n < 2) continue;
      let s = 0;
      let prevL = -1;
      let prevR = -1;
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1);
        const b = Math.min(n - 1, i + 1);
        let dx = p[2 * b] - p[2 * a];
        let dy = p[2 * b + 1] - p[2 * a + 1];
        const l = Math.hypot(dx, dy) || 1;
        dx /= l;
        dy /= l;
        if (i > 0) s += Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
        const h = rl.bridge ? 0.08 : 0.012;
        const L = track.vert(p[2 * i] - dy * 2, h, p[2 * i + 1] + dx * 2, 0, s / 3.9, 255, 255, 255);
        const Rr = track.vert(p[2 * i] + dy * 2, h, p[2 * i + 1] - dx * 2, 1, s / 3.9, 255, 255, 255);
        if (prevL >= 0) track.up(prevL, prevR, Rr, L);
        prevL = L;
        prevR = Rr;
      }
      walk(p, 60, (x, y, dx, dy) => {
        const mx = x - dy * 3.2;
        const my = y + dx * 3.2;
        if (index.penetration(mx, my) > -0.5 || ctx.mask.has(mx, my, MASK_WATER)) return;
        masts.push({ x: mx, y: my, ang: Math.atan2(-dx, dy) });
      }, 20);
    }
    const trackMat = patch(new THREE.MeshLambertMaterial({ map: ctx.tex.track, vertexColors: true }), {
      key: 'track',
      vertex: [['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);']],
      fragment: [['#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = pow(diffuseColor.rgb, vec3(2.2));']],
    });
    const tm = new THREE.Mesh(track.build(), trackMat);
    tm.receiveShadow = true;
    tm.name = 'rail';
    tm.frustumCulled = false;
    ctx.root.add(tm);
    // masts: pole + cantilever over the track
    const mg = new MeshGeo([{ name: 'color', size: 3, type: 'u8', normalized: true }]);
    mg.box(0, 0, 0, 7.2, 1, 0, 0.12, 0.12, 120, 124, 126);
    mg.beam(0, 6.6, 0, 3.6, 6.6, 0, 0.05, 120, 124, 126);
    mg.beam(0, 7.1, 0, 3.6, 6.65, 0, 0.03, 120, 124, 126);
    const mastGeo = mg.build();
    const mm = new THREE.InstancedMesh(mastGeo, struct, masts.length);
    masts.forEach((m, i) => {
      q.setFromAxisAngle(yAxis, m.ang);
      m4.compose(v.set(m.x, 0, -m.y), q, sc.set(1, 1, 1));
      mm.setMatrixAt(i, m4);
    });
    mm.castShadow = true;
    mm.computeBoundingSphere();
    mm.name = 'rail-masts';
    mm.frustumCulled = false;
    ctx.root.add(mm);
  }
  progress(0.8);
  await yieldFrame();

  // ---- bus stop shelters
  {
    const tpl = shelterTemplate();
    const items: { x: number; y: number; ang: number }[] = [];
    // Busway platforms draw their own canopies (src/game/platforms.ts).
    const platformBoxes = data.platforms.map((pf) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < pf.pts.length; i += 2) {
        x0 = Math.min(x0, pf.pts[i]); x1 = Math.max(x1, pf.pts[i]);
        y0 = Math.min(y0, pf.pts[i + 1]); y1 = Math.max(y1, pf.pts[i + 1]);
      }
      return [x0 - 12, y0 - 12, x1 + 12, y1 + 12];
    });
    const nearPlatform = (x: number, y: number) => platformBoxes.some((bb) => x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3]);
    for (const st of data.stops) {
      if (nearPlatform(st.x, st.y)) continue;
      const nr = index.nearest(st.x, st.y, 25, (ri) => !infos[ri].r.tunnel && infos[ri].r.kind !== RoadKind.Motorway);
      if (!nr) continue;
      const ri = infos[nr.road];
      if (ri.r.kind === RoadKind.Busway || ri.r.bus) continue;
      // side of the road the stop is on
      const lx = -nr.dy;
      const ly = nr.dx;
      const side = (st.x - nr.px) * lx + (st.y - nr.py) * ly >= 0 ? 1 : -1;
      const off = ri.hw + 1.3;
      const x = nr.px + lx * side * off;
      const y = nr.py + ly * side * off;
      if (index.penetration(x, y, nr.road) > -1 || ctx.mask.near(x, y, 1.5, 4)) continue;
      if (densityAt(ctx, x, y) > 0.6) continue;
      // template back (+map y) faces away from the road: local +y -> side normal
      const bx = lx * side;
      const by = ly * side;
      items.push({ x, y, ang: Math.atan2(-bx, by) });
    }
    const sm = new THREE.InstancedMesh(tpl, struct, items.length);
    items.forEach((it, i) => {
      q.setFromAxisAngle(yAxis, it.ang);
      m4.compose(v.set(it.x, 0, -it.y), q, sc.set(1, 1, 1));
      sm.setMatrixAt(i, m4);
    });
    sm.castShadow = true;
    sm.receiveShadow = true;
    sm.computeBoundingSphere();
    sm.frustumCulled = false;
    sm.name = 'shelters';
    ctx.root.add(sm);
  }
  progress(1);

  const grid = new IdGrid(R[0], R[1], R[2], R[3], 60);
  junctions.forEach((j, i) => grid.addPoint(i, j.x, j.y));
  return {
    junctions,
    grid,
    stateAt(x: number, y: number, t: number, dirX?: number, dirY?: number): Light | null {
      let best = -1;
      let bd = 40;
      grid.query(x - 40, y - 40, x + 40, y + 40, (i) => {
        const d = Math.hypot(junctions[i].x - x, junctions[i].y - y);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      if (best < 0) return null;
      const j = junctions[best];
      let dx = x - j.x;
      let dy = y - j.y;
      if (dirX !== undefined && dirY !== undefined && (dirX !== 0 || dirY !== 0)) {
        // The approach arm is the one pointing back along the travel direction:
        // use that arm's group so the answer matches its signal heads exactly.
        let bestDot = 0.5;
        let g = -1;
        for (const a of j.arms ?? []) {
          const d = -(a.ux * dirX + a.uy * dirY);
          if (d > bestDot) {
            bestDot = d;
            g = a.g;
          }
        }
        if (g >= 0) return phaseState(j, g, t);
        dx = -dirX;
        dy = -dirY;
      }
      const l = Math.hypot(dx, dy) || 1;
      // Same rule as the heads: arms within ~45° of the main axis are group 0.
      const group = Math.abs((dx * j.ax + dy * j.ay) / l) > 0.7 ? 0 : 1;
      return phaseState(j, group, t);
    },
  };
}

const nightOnly: THREE.Object3D[] = [];
