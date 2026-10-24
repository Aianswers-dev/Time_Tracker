/** Ground helpers: polygon triangulation, water polygon lists and backyard pools. */
import * as THREE from 'three';
import { Earcut } from 'three/src/extras/Earcut.js';
import { AreaKind } from '../types';
import type { Ctx } from './ctx';
import { NOISE_GLSL, patch } from './shaders';
import type { TerrainField } from './terrain';
import { f32, u32 } from './util';

export const INNER_PAD = 100;

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

/** Flat polygon mesh builder (upward faces) in map coordinates. */
export class FlatGeo {
  pos = f32(1 << 14);
  idx = u32(1 << 14);
  get count(): number {
    return this.pos.len / 3;
  }
  add(coords: ArrayLike<number>, tris: number[], h: number): void {
    const base = this.count;
    for (let i = 0; i < coords.length; i += 2) this.pos.push3(coords[i], h, -coords[i + 1]);
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i];
      const b = tris[i + 1];
      const c = tris[i + 2];
      const cr = (coords[2 * b] - coords[2 * a]) * (coords[2 * c + 1] - coords[2 * a + 1]) - (coords[2 * b + 1] - coords[2 * a + 1]) * (coords[2 * c] - coords[2 * a]);
      if (cr >= 0) this.idx.push3(base + a, base + b, base + c);
      else this.idx.push3(base + a, base + c, base + b);
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.take(), 3));
    const n = new Float32Array(this.pos.len);
    for (let i = 1; i < n.length; i += 3) n[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    g.setIndex(new THREE.BufferAttribute(this.idx.take(), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Water polygons: the map's own plus the horizon river/bay from extras. */
export function waterPolys(ctx: Ctx): { outer: ArrayLike<number>; holes: ArrayLike<number>[] }[] {
  const out: { outer: ArrayLike<number>; holes: ArrayLike<number>[] }[] = ctx.data.water.map((w) => ({ outer: w.pts, holes: w.holes }));
  if (ctx.extras) for (const w of ctx.extras.water) out.push({ outer: w.p, holes: w.h ?? [] });
  return out;
}

/** Backyard and public pools, each flat at the highest ground under it. */
export function buildPools(ctx: Ctx, field: TerrainField): void {
  const g = new FlatGeo();
  for (const a of ctx.data.areas) {
    if (a.kind !== AreaKind.Water || a.pts.length < 6) continue;
    let h = -Infinity;
    for (let i = 0; i < a.pts.length; i += 2) h = Math.max(h, field.renAt(a.pts[i], a.pts[i + 1]));
    const { coords, tris } = triangulate(a.pts, a.holes);
    g.add(coords, tris, h + 0.08);
  }
  if (!g.count) return;
  const mat = patch(new THREE.MeshLambertMaterial({ color: 0x4fb8d4 }), {
    key: 'pool',
    vertexPars: 'varying vec3 vGPos;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;']],
    fragmentPars: `uniform float uTime;\nvarying vec3 vGPos;\n${NOISE_GLSL}`,
    fragment: [
      [
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec2 p = vec2(vGPos.x, -vGPos.z);
        float rip = w_noise(p * 2.5 + uTime * 0.6) * 0.5 + w_noise(p * 5.0 - uTime * 0.4) * 0.5;
        vec4 diffuseColor = vec4(mix(vec3(0.05, 0.36, 0.5), vec3(0.3, 0.7, 0.82), smoothstep(0.55, 0.85, rip)), opacity);`,
      ],
      ['vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive + diffuseColor.rgb * uNight * 0.4;'],
    ],
  });
  const m = new THREE.Mesh(g.build(), mat);
  m.name = 'pools';
  m.receiveShadow = true;
  ctx.root.add(m);
  ctx.cull.push({ obj: m, x: 0, z: 0, range: 1e9 });
}
