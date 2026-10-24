/**
 * Landmark structures built from the data: the Story Bridge's steel
 * cantilever truss over the Bradfield Highway deck (which the road data puts
 * at its real ~30 m height).
 */
import * as THREE from 'three';
import type { Ctx } from './ctx';
import { MeshGeo } from './geo';
import { patch } from './shaders';
import { obb } from './util';

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
