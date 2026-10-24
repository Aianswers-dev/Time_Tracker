/**
 * Roads in 3D: asphalt ribbons at the per-vertex heights from the data, lane
 * markings, kerbs and footpaths, and the earthworks around them:
 *
 * - at grade: the terrain is clamped below the carriageway, and each side
 *   gets a graded shoulder (batter) down/up to the natural ground, or a
 *   retaining wall when the cut/fill is deep;
 * - open cuttings (road well below the ground, e.g. tunnel approaches): the
 *   terrain cells are removed (TerrainField.hole), retaining walls rise from
 *   the road to the ground and a cap strip at ground level covers the edge of
 *   the hole;
 * - bridges and viaducts: deck fascia and underside, parapets, piers down to
 *   the ground or river bed (moved off any road or railway beneath) and
 *   abutments;
 * - tunnels: enclosed tubes (walls, ceiling, lights, walkways) at the road
 *   height, open toward neighbouring tunnel roads and underground platforms,
 *   with portal headwalls where they meet the surface.
 */
import * as THREE from 'three';
import { RoadKind, type Road } from '../types';
import { type Ctx, densityAt } from './ctx';
import { MeshGeo } from './geo';
import { RoadIndex, roadHeight } from './roadindex';
import { NOISE_GLSL, patch } from './shaders';
import type { TerrainField } from './terrain';
import { storyOutline } from './landmarks';
import { makeRoadTextTexture } from './textures';
import { MASK_RAIL, MASK_WATER, clamp, pointInRing, yieldFrame } from './util';

export const KERB_H = 0.15;
const ROAD_CHUNK = 2500;
/** Clear height inside tunnels. */
const TUBE_H = 5.8;

/** Prepared road: cumulative lengths, miter normals and heights. */
export interface RI {
  r: Road;
  i: number;
  hw: number;
  /** Small rank-dependent lift above the data height (junction layering). */
  lift: number;
  n: number;
  cum: Float32Array;
  /** Left normal (map coords) per vertex, already scaled by the miter factor. */
  mx: Float32Array;
  my: Float32Array;
  len: number;
  z: Float32Array;
}

export function prepRoad(r: Road, i: number): RI {
  const p = r.pts;
  const n = p.length >> 1;
  const cum = new Float32Array(n);
  const mx = new Float32Array(n);
  const my = new Float32Array(n);
  for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(p[2 * k] - p[2 * k - 2], p[2 * k + 1] - p[2 * k - 1]);
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 1);
    const b = Math.min(n - 1, k + 1);
    let d0x = p[2 * k] - p[2 * a];
    let d0y = p[2 * k + 1] - p[2 * a + 1];
    let d1x = p[2 * b] - p[2 * k];
    let d1y = p[2 * b + 1] - p[2 * k + 1];
    if (Math.hypot(d0x, d0y) < 1e-6) {
      d0x = d1x;
      d0y = d1y;
    }
    if (Math.hypot(d1x, d1y) < 1e-6) {
      d1x = d0x;
      d1y = d0y;
    }
    const L0 = Math.hypot(d0x, d0y) || 1;
    const L1 = Math.hypot(d1x, d1y) || 1;
    const n0x = -d0y / L0;
    const n0y = d0x / L0;
    const n1x = -d1y / L1;
    const n1y = d1x / L1;
    let ax = n0x + n1x;
    let ay = n0y + n1y;
    const al = Math.hypot(ax, ay);
    if (al < 1e-6) {
      ax = n1x;
      ay = n1y;
    } else {
      ax /= al;
      ay /= al;
    }
    const sc = 1 / Math.max(0.4, ax * n0x + ay * n0y);
    mx[k] = ax * Math.min(sc, 2.5);
    my[k] = ay * Math.min(sc, 2.5);
  }
  return { r, i, hw: r.width / 2, lift: roadHeight(r), n, cum, mx, my, len: cum[n - 1], z: r.z };
}

/** Point, height and (unscaled) left normal at distance s. */
export function roadAt(ri: RI, s: number): { x: number; y: number; z: number; nx: number; ny: number; k: number } {
  const p = ri.r.pts;
  const cum = ri.cum;
  let k = 0;
  let hi = ri.n - 1;
  if (s >= ri.len) k = ri.n - 2;
  else if (s > 0) {
    while (hi - k > 1) {
      const m = (k + hi) >> 1;
      if (cum[m] <= s) k = m;
      else hi = m;
    }
  }
  k = clamp(k, 0, ri.n - 2);
  const segL = cum[k + 1] - cum[k] || 1e-6;
  const t = clamp((s - cum[k]) / segL, 0, 1);
  const ax = p[2 * k];
  const ay = p[2 * k + 1];
  const dx = p[2 * k + 2] - ax;
  const dy = p[2 * k + 3] - ay;
  const l = Math.hypot(dx, dy) || 1;
  return { x: ax + dx * t, y: ay + dy * t, z: ri.z[k] + (ri.z[k + 1] - ri.z[k]) * t, nx: -dy / l, ny: dx / l, k };
}

/**
 * Walk [sA, sB] calling fn(x, y, z, nx, ny, s) at sA, every interior vertex
 * and sB; the normal includes the miter factor at vertices.
 */
export function walkRun(ri: RI, sA: number, sB: number, fn: (x: number, y: number, z: number, nx: number, ny: number, s: number) => void): void {
  const a = roadAt(ri, sA);
  const p = ri.r.pts;
  const atStart = sA <= 1e-3;
  fn(a.x, a.y, a.z, atStart ? ri.mx[0] : a.nx, atStart ? ri.my[0] : a.ny, sA);
  for (let v = a.k + 1; v < ri.n; v++) {
    const cv = ri.cum[v];
    if (cv <= sA + 0.01) continue;
    if (cv >= sB - 0.01) break;
    fn(p[2 * v], p[2 * v + 1], ri.z[v], ri.mx[v], ri.my[v], cv);
  }
  const b = roadAt(ri, sB);
  const atEnd = sB >= ri.len - 1e-3;
  fn(b.x, b.y, b.z, atEnd ? ri.mx[ri.n - 1] : b.nx, atEnd ? ri.my[ri.n - 1] : b.ny, sB);
}

/** Complement of skip intervals within [a, b]. */
function runsBetween(a: number, b: number, skips: [number, number][], minLen: number): [number, number][] {
  const s = skips.filter((k) => k[1] > a && k[0] < b).sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let cur = a;
  for (const [s0, s1] of s) {
    if (s0 > cur + minLen) out.push([cur, Math.min(s0, b)]);
    cur = Math.max(cur, s1);
  }
  if (b > cur + minLen) out.push([cur, b]);
  return out;
}

// ---------------------------------------------------------------------------
// Materials

/** Inside tunnels lighting comes from the tunnel lamps, not the sky. */
const TUNNEL_LIGHT = 'vec3(0.95, 0.86, 0.72) * 0.7';

const ROAD_FRAG = /* glsl */ `
uniform sampler2D uAsphalt;
uniform sampler2D uNoise;
varying vec4 vRoad;
varying vec3 vGPos;
${NOISE_GLSL}
vec3 roadAlbedo() {
  vec2 p = vec2(vGPos.x, -vGPos.z);
  float surf = floor(vRoad.y + 0.5);
  vec3 a = texture2D(uAsphalt, p / 7.3).rgb;
  vec3 b = texture2D(uAsphalt, p / 29.0 + 0.37).rgb;
  vec4 n = texture2D(uNoise, p / 70.0);
  vec4 n2 = texture2D(uNoise, p / 13.0);
  vec3 c = mix(a, b, 0.5);
  c = mix(vec3(0.30), c, 0.75);
  c *= mix(0.88, 1.12, n.g) * mix(0.95, 1.05, n2.b);
  c = mix(c, c * 0.78, smoothstep(0.66, 0.7, n.b) * 0.7);
  if (surf > 0.5 && surf < 1.5) c *= vec3(1.12, 1.06, 1.02);
  else if (surf > 1.5 && surf < 2.5) {
    vec2 q = p / vec2(0.6, 0.3);
    q.x += step(0.5, fract(q.y * 0.5)) * 0.5;
    vec2 f = abs(fract(q) - 0.5);
    float j = smoothstep(0.47, 0.5, max(f.x, f.y));
    c = mix(vec3(0.42, 0.40, 0.38), vec3(0.55, 0.52, 0.48), n2.r) * (1.0 - j * 0.3);
  } else if (surf > 5.5) c *= 0.84;
  return pow(c, vec3(2.2));
}
`;

const TUN_OUT = `vec3 outgoingLight = mix(reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance, diffuseColor.rgb * ${TUNNEL_LIGHT}, vTunnel);`;

function roadMaterial(ctx: Ctx): THREE.MeshLambertMaterial {
  return patch(new THREE.MeshLambertMaterial({ color: 0xffffff }), {
    key: 'road3',
    depthBias: 0.0012,
    uniforms: { uAsphalt: { value: ctx.tex.asphalt }, uNoise: { value: ctx.tex.noise } },
    vertexPars: 'attribute vec4 aRoad;\nvarying vec4 vRoad;\nvarying vec3 vGPos;\nvarying float vTunnel;',
    vertex: [
      ['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);'],
      ['#include <begin_vertex>', '#include <begin_vertex>\nvRoad = aRoad;\nvTunnel = aRoad.w;\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'],
    ],
    fragmentPars: ROAD_FRAG + '\nvarying float vTunnel;',
    fragment: [
      ['vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( roadAlbedo(), opacity );'],
      ['vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;', TUN_OUT],
    ],
  });
}

export function markMaterial(ctx: Ctx): THREE.MeshLambertMaterial {
  return patch(new THREE.MeshLambertMaterial({ color: 0xffffff }), {
    key: 'mark3',
    depthBias: 0.0016,
    uniforms: { uNoise: { value: ctx.tex.noise } },
    vertexPars: 'attribute vec3 aMark;\nvarying vec3 vMark;\nvarying vec3 vGPos;\nvarying float vTunnel;',
    vertex: [
      ['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);'],
      ['#include <begin_vertex>', '#include <begin_vertex>\nvMark = aMark;\nvTunnel = aMark.z;\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'],
    ],
    fragmentPars: 'uniform sampler2D uNoise;\nvarying vec3 vMark;\nvarying vec3 vGPos;\nvarying float vTunnel;',
    fragment: [
      [
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `float pat = floor(vMark.y + 0.5);
        if (pat > 0.5 && pat < 1.5 && fract(vMark.x / 12.0) > 0.25) discard;
        if (pat > 1.5 && pat < 2.5 && fract(vMark.x / 4.0) > 0.25) discard;
        if (pat > 2.5 && pat < 3.5 && fract(vMark.x / 1.2) > 0.5) discard;
        vec4 wn = texture2D(uNoise, vec2(vGPos.x, -vGPos.z) / 3.1);
        float wear = mix(0.62, 0.95, smoothstep(0.25, 0.65, wn.g));
        vec3 paint = pat > 3.5 ? vec3(0.85, 0.68, 0.12) : vec3(wear);
        vec4 diffuseColor = vec4( paint, opacity );`,
      ],
      ['vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;', TUN_OUT],
    ],
  });
}

const FOOT_FRAG = /* glsl */ `
uniform sampler2D uNoise;
varying vec3 vFoot;
varying vec3 vGPos;
${NOISE_GLSL}
float fl(float v, float period, float w, float fwv) { float x = v / period; float f = max(fwv / period, 1e-3); float d = 0.5 - abs(fract(x) - 0.5); return 1.0 - w_ss(w / period * 0.5 - f, w / period * 0.5 + f, d); }
vec3 footAlbedo() {
  vec2 p = vec2(vGPos.x, -vGPos.z);
  vec4 n1 = texture2D(uNoise, p / 5.0);
  vec4 n2 = texture2D(uNoise, p / 37.0);
  float across = vFoot.x;
  float along = vFoot.y;
  float style = floor(vFoot.z + 0.5);
  float FA = fwidth(along);
  vec3 conc = vec3(0.66, 0.65, 0.61) * (0.9 + 0.16 * n1.r) * (0.94 + 0.1 * n2.g);
  vec3 kerb = vec3(0.72, 0.71, 0.68) * (0.9 + 0.12 * n1.r);
  if (style > 3.5) return conc * 0.8;
  if (style > 2.5) return kerb * 0.92;
  if (across < 0.32) return kerb;
  if (style < 0.5) {
    vec3 grass = mix(vec3(0.36, 0.45, 0.24), vec3(0.52, 0.50, 0.33), smoothstep(0.4, 0.75, n2.g)) * (0.85 + 0.3 * n1.r);
    float path = step(2.4, across) * step(across, 3.75);
    float joint = fl(along, 1.5, 0.02, FA) * path;
    return mix(grass, conc * (1.0 - joint * 0.25), path);
  }
  if (style < 1.5) {
    vec2 q = vec2(along / 0.6, across / 0.6);
    vec2 f = abs(fract(q) - 0.5);
    float j = smoothstep(0.46, 0.5, max(f.x, f.y));
    vec3 pav = mix(vec3(0.56, 0.55, 0.53), vec3(0.66, 0.64, 0.60), w_hash(floor(q)));
    return pav * (0.92 + 0.12 * n1.r) * (1.0 - j * 0.22);
  }
  float joint = fl(along, 1.8, 0.02, FA);
  return conc * (1.0 - joint * 0.25);
}
`;

function footMaterial(ctx: Ctx): THREE.MeshLambertMaterial {
  return patch(new THREE.MeshLambertMaterial({ color: 0xffffff }), {
    key: 'foot3',
    depthBias: 0.0008,
    uniforms: { uNoise: { value: ctx.tex.noise } },
    vertexPars: 'attribute vec3 aFoot;\nvarying vec3 vFoot;\nvarying vec3 vGPos;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvFoot = aFoot;\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;']],
    fragmentPars: FOOT_FRAG,
    fragment: [['vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( pow(footAlbedo(), vec3(2.2)), opacity );']],
  });
}

/** Vertex-coloured concrete/steel with a little noise. */
export function structMaterial(ctx: Ctx, key = 'struct'): THREE.MeshLambertMaterial {
  return patch(new THREE.MeshLambertMaterial({ vertexColors: true }), {
    key,
    uniforms: { uNoise: { value: ctx.tex.noise } },
    vertexPars: 'varying vec3 vGPos;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;']],
    fragmentPars: 'uniform sampler2D uNoise;\nvarying vec3 vGPos;',
    fragment: [['#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 0.88 + 0.22 * texture2D(uNoise, (vGPos.xz + vGPos.y) / 6.0).r;']],
  });
}

/** Tunnel interiors: lit by their own lamps; vertex colour r=1 marks a lamp. */
function tubeMaterial(ctx: Ctx): THREE.MeshLambertMaterial {
  return patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), {
    key: 'tube3',
    uniforms: { uNoise: { value: ctx.tex.noise } },
    vertexPars: 'varying vec3 vGPos;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;']],
    fragmentPars: 'uniform sampler2D uNoise;\nvarying vec3 vGPos;',
    fragment: [
      ['#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 0.86 + 0.24 * texture2D(uNoise, (vGPos.xz + vGPos.y) / 5.0).r;'],
      [
        'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
        `float lamp = step(0.97, vColor.r);
        vec3 outgoingLight = diffuseColor.rgb * ${TUNNEL_LIGHT} + lamp * vec3(1.0, 0.92, 0.75) * 2.5;`,
      ],
    ],
  });
}

// ---------------------------------------------------------------------------

export interface RoadsResult {
  infos: RI[];
  index: RoadIndex;
  /** Tunnel-only index. */
  tunnels: RoadIndex;
  /** Tunnel mouths (map x, y and road height): where an underground camera can see out. */
  portals: { x: number; y: number; z: number }[];
}

interface Layer {
  asphalt: MeshGeo;
  foot: MeshGeo;
  mark: MeshGeo;
  struct: MeshGeo;
  words: MeshGeo;
  strip: MeshGeo;
  tube: MeshGeo;
  track: MeshGeo;
}

const nodeKey = (x: number, y: number) => (Math.round(x * 10) + 80000) * 160000 + (Math.round(y * 10) + 80000);

const CONC = [192, 188, 178];
const CONC_DARK = [205, 200, 190];
const WALL = [176, 170, 158];
const STEEL = [74, 78, 82];

export async function buildRoads(ctx: Ctx, field: TerrainField, stripMat: THREE.Material, progress: (f: number) => void): Promise<RoadsResult> {
  const { data, R } = ctx;
  const roads = data.roads;
  const infos = roads.map((r, i) => prepRoad(r, i));
  const index = new RoadIndex(roads, data.bounds);
  const tunnels = new RoadIndex(roads, data.bounds, (r) => r.tunnel);
  const mask = ctx.mask;
  const underPlatforms = data.platforms.filter((p) => p.underground || p.layer < 0);
  const portals: { x: number; y: number; z: number }[] = [];

  // Node degrees for junction detection and portals.
  interface Node {
    deg: number;
    maxHW: number;
    tun: number;
    surf: number;
  }
  const nodes = new Map<number, Node>();
  for (const ri of infos) {
    const p = ri.r.pts;
    for (let v = 0; v < ri.n; v++) {
      const k = nodeKey(p[2 * v], p[2 * v + 1]);
      let nd = nodes.get(k);
      if (!nd) {
        nd = { deg: 0, maxHW: 0, tun: 0, surf: 0 };
        nodes.set(k, nd);
      }
      nd.deg += v === 0 || v === ri.n - 1 ? 1 : 2;
      nd.maxHW = Math.max(nd.maxHW, ri.hw);
      if (ri.r.tunnel) nd.tun++;
      else nd.surf++;
    }
  }

  const nx = Math.ceil((R[2] - R[0]) / ROAD_CHUNK);
  const layers = new Map<number, Layer>();
  const layerFor = (x: number, y: number): Layer => {
    const i = clamp(Math.floor((x - R[0]) / ROAD_CHUNK), 0, nx - 1);
    const j = clamp(Math.floor((y - R[1]) / ROAD_CHUNK), 0, 99);
    const key = j * nx + i;
    let l = layers.get(key);
    if (!l) {
      const col = [{ name: 'color', size: 3, type: 'u8' as const, normalized: true }];
      l = {
        asphalt: new MeshGeo([{ name: 'aRoad', size: 4, type: 'f32' }]),
        foot: new MeshGeo([{ name: 'aFoot', size: 3, type: 'f32' }]),
        mark: new MeshGeo([{ name: 'aMark', size: 3, type: 'f32' }]),
        struct: new MeshGeo(col),
        words: new MeshGeo([{ name: 'uv', size: 2, type: 'f32' }]),
        strip: new MeshGeo([]),
        tube: new MeshGeo(col),
        track: new MeshGeo([{ name: 'uv', size: 2, type: 'f32' }]),
      };
      layers.set(key, l);
    }
    return l;
  };

  const inWater = (x: number, y: number) => mask.has(x, y, MASK_WATER);
  // the Story Bridge truss carries its own piers (landmarks.ts)
  const story = storyOutline(ctx);
  const otherAt = (x: number, y: number, z: number, self: number, dz = 2.5) => index.penetrationZ(x, y, z, dz, self);

  for (let ri0 = 0; ri0 < infos.length; ri0++) {
    const ri = infos[ri0];
    const r = ri.r;
    if (ri.n < 2 || ri.len < 0.5) continue;
    const mid = roadAt(ri, ri.len / 2);
    const L = layerFor(mid.x, mid.y);
    const hw = ri.hw;
    const lift = ri.lift;
    const tun = r.tunnel ? 1 : 0;
    const surf = r.kind === RoadKind.Pedestrian ? 2 : r.bus ? 1 : r.kind === RoadKind.Motorway ? 6 : r.kind === RoadKind.Service ? 5 : 0;

    // ---- asphalt ribbon (and terrain clamp under at-grade roads)
    {
      const g = L.asphalt;
      let prevL = -1;
      let prevR = -1;
      let pq: number[] | null = null;
      walkRun(ri, 0, ri.len, (x, yy, z, nx2, ny2, s) => {
        const h = z + lift;
        const lx = x + nx2 * hw;
        const ly = yy + ny2 * hw;
        const rx = x - nx2 * hw;
        const ry = yy - ny2 * hw;
        const tt = tun && covered(ri, { x, y: yy, z }) ? 1 : 0;
        const l = g.vert(lx, h, ly, hw, surf, s, tt);
        const rr = g.vert(rx, h, ry, -hw, surf, s, tt);
        if (prevL >= 0) g.up(prevL, prevR, rr, l);
        prevL = l;
        prevR = rr;
        const q = [lx, ly, z, rx, ry, z];
        if (pq && !r.tunnel) field.clampQuad([pq[0], pq[1], pq[2], pq[3], pq[4], pq[5], q[3], q[4], q[5], q[0], q[1], q[2]], r.bridge ? 1.6 : 0.3);
        pq = q;
      });
      // round end caps fill junction wedges and make cul-de-sac bulbs
      const p = r.pts;
      for (const end of [0, 1]) {
        const v = end === 0 ? 0 : ri.n - 1;
        const cx = p[2 * v];
        const cy = p[2 * v + 1];
        const cz = ri.z[v];
        const tx = end === 0 ? -(p[2] - p[0]) : p[2 * v] - p[2 * v - 2];
        const ty = end === 0 ? -(p[3] - p[1]) : p[2 * v + 1] - p[2 * v - 1];
        const tl = Math.hypot(tx, ty) || 1;
        const ux = tx / tl;
        const uy = ty / tl;
        const ct = tun && covered(ri, { x: cx, y: cy, z: cz }) ? 1 : 0;
        const c = g.vert(cx, cz + lift, cy, 0, surf, 0, ct);
        const segs = 6;
        let prev = -1;
        for (let k = 0; k <= segs; k++) {
          const t = -Math.PI / 2 + (k / segs) * Math.PI;
          const dx = ux * Math.cos(t) - uy * Math.sin(t);
          const dy = ux * Math.sin(t) + uy * Math.cos(t);
          const vi = g.vert(cx + dx * hw, cz + lift, cy + dy * hw, 0, surf, 0, ct);
          if (prev >= 0) g.tri(c, prev, vi, 0, 1, 0);
          prev = vi;
        }
        if (!r.tunnel) {
          field.clampQuad(
            [cx - uy * hw, cy + ux * hw, cz, cx + uy * hw, cy - ux * hw, cz, cx + uy * hw + ux * hw, cy - ux * hw + uy * hw, cz, cx - uy * hw + ux * hw, cy + ux * hw + uy * hw, cz],
            r.bridge ? 1.6 : 0.3,
          );
        }
      }
    }

    // ---- junction zones (no markings)
    const skips: [number, number][] = [];
    {
      const p = r.pts;
      for (let v = 0; v < ri.n; v++) {
        const nd = nodes.get(nodeKey(p[2 * v], p[2 * v + 1]));
        if (!nd) continue;
        const isEnd = v === 0 || v === ri.n - 1;
        if (nd.deg >= 3) {
          const rad = nd.maxHW + 3;
          skips.push([ri.cum[v] - rad, ri.cum[v] + rad]);
        } else if (isEnd && nd.deg === 1) {
          if (otherAt(p[2 * v], p[2 * v + 1], ri.z[v], ri.i) > -0.5) skips.push([ri.cum[v] - hw - 9, ri.cum[v] + hw + 9]);
        }
      }
    }

    // ---- lane markings
    {
      const lines: { off: number; w: number; pat: number }[] = [];
      const lanes = Math.max(1, r.lanes);
      const major = r.kind <= RoadKind.Tertiary || r.kind === RoadKind.Busway || r.bus;
      if (r.kind !== RoadKind.Pedestrian && r.kind !== RoadKind.Residential && (r.kind !== RoadKind.Service || r.bus)) {
        if (r.oneway) {
          const lw = r.width / lanes;
          for (let k = 1; k < lanes; k++) lines.push({ off: -hw + k * lw, w: 0.12, pat: 1 });
          if (r.kind === RoadKind.Motorway || r.kind === RoadKind.Trunk || r.kind === RoadKind.Busway || r.bus || lanes >= 3) {
            lines.push({ off: hw - 0.3, w: 0.15, pat: 0 });
            lines.push({ off: -hw + 0.3, w: 0.15, pat: 0 });
          }
        } else if (major && lanes >= 2) {
          const per = Math.max(1, Math.floor(lanes / 2));
          const lw = (hw - 0.3) / per;
          if (lanes >= 4 || r.kind <= RoadKind.Primary) {
            lines.push({ off: 0.13, w: 0.1, pat: 0 });
            lines.push({ off: -0.13, w: 0.1, pat: 0 });
          } else {
            lines.push({ off: 0, w: 0.12, pat: 1 });
          }
          for (let k = 1; k < per; k++) {
            lines.push({ off: k * lw, w: 0.12, pat: 1 });
            lines.push({ off: -k * lw, w: 0.12, pat: 1 });
          }
          if (r.kind === RoadKind.Busway || r.bus || r.kind <= RoadKind.Trunk) {
            lines.push({ off: hw - 0.3, w: 0.15, pat: 0 });
            lines.push({ off: -hw + 0.3, w: 0.15, pat: 0 });
          }
        }
      }
      if (lines.length) {
        const runs = runsBetween(0.5, ri.len - 0.5, skips, 2);
        const g = L.mark;
        for (const [a, b] of runs) {
          for (const ln of lines) {
            let pl = -1;
            let pr = -1;
            walkRun(ri, a, b, (x, yy, z, nx2, ny2, s) => {
              const o0 = ln.off - ln.w / 2;
              const o1 = ln.off + ln.w / 2;
              const h = z + lift + 0.004;
              const tt = tun && covered(ri, { x, y: yy, z }) ? 1 : 0;
              const l = g.vert(x + nx2 * o1, h, yy + ny2 * o1, s, ln.pat, tt);
              const rr = g.vert(x + nx2 * o0, h, yy + ny2 * o0, s, ln.pat, tt);
              if (pl >= 0) g.up(pl, pr, rr, l);
              pl = l;
              pr = rr;
            });
          }
        }
      }
      // BUS ONLY words on busways
      if ((r.kind === RoadKind.Busway || r.bus) && ri.len > 40) {
        const g = L.words;
        const lanesDir: { off: number; dir: number }[] = r.oneway
          ? [{ off: 0, dir: 1 }]
          : [
              { off: hw / 2, dir: 1 },
              { off: -hw / 2, dir: -1 },
            ];
        for (let s = 25; s < ri.len - 10; s += 140) {
          if (skips.some(([a, b]) => s > a - 6 && s < b + 6)) continue;
          for (const ld of lanesDir) {
            const c = roadAt(ri, s);
            const tx = c.ny * ld.dir;
            const ty = -c.nx * ld.dir;
            const lx = -ty;
            const ly = tx;
            const ccx = c.x + c.nx * ld.off;
            const ccy = c.y + c.ny * ld.off;
            const halfW = Math.min(1.5, (r.oneway ? hw : hw / 2) - 0.4);
            const halfL = 2.6;
            const z0 = roadAt(ri, s - halfL * ld.dir).z + lift + 0.006;
            const z1 = roadAt(ri, s + halfL * ld.dir).z + lift + 0.006;
            const a0 = g.vert(ccx - tx * halfL + lx * halfW, z0, ccy - ty * halfL + ly * halfW, 0, 0);
            const a1 = g.vert(ccx - tx * halfL - lx * halfW, z0, ccy - ty * halfL - ly * halfW, 1, 0);
            const a2 = g.vert(ccx + tx * halfL - lx * halfW, z1, ccy + ty * halfL - ly * halfW, 1, 1);
            const a3 = g.vert(ccx + tx * halfL + lx * halfW, z1, ccy + ty * halfL + ly * halfW, 0, 1);
            g.up(a0, a1, a2, a3);
          }
        }
      }
    }

    if (r.tunnel) {
      buildTube(ri, L);
    } else if (r.bridge) {
      buildBridge(ri, L);
    } else {
      buildAtGrade(ri, L, skips);
    }

    if (ri0 % 1200 === 0) {
      progress(ri0 / infos.length);
      await yieldFrame();
    }
  }

  // ---- railway: track bed, earthworks, bridges and tunnel portals
  {
    const railNodes = new Map<number, { tun: number; surf: number }>();
    for (const rl of data.rail) {
      const n = rl.pts.length >> 1;
      for (const v of [0, n - 1]) {
        const k = nodeKey(rl.pts[2 * v], rl.pts[2 * v + 1]);
        let nd = railNodes.get(k);
        if (!nd) {
          nd = { tun: 0, surf: 0 };
          railNodes.set(k, nd);
        }
        if (rl.tunnel) nd.tun++;
        else nd.surf++;
      }
    }
    let k = 0;
    for (const rl of data.rail) {
      const pseudo: Road = { kind: RoadKind.Service, width: 4.2, lanes: 1, oneway: true, bridge: rl.bridge, tunnel: rl.tunnel, layer: 0, link: false, bus: false, pts: rl.pts, z: rl.z };
      const ri = prepRoad(pseudo, -1 - k++);
      if (ri.n < 2 || ri.len < 1) continue;
      const mid = roadAt(ri, ri.len / 2);
      const L = layerFor(mid.x, mid.y);
      if (rl.tunnel) {
        railPortals(ri, L, railNodes);
        continue;
      }
      const g = L.track;
      let pl = -1;
      let pr = -1;
      let pq: number[] | null = null;
      walkRun(ri, 0, ri.len, (x, yy, z, nx2, ny2, s) => {
        const lx = x + nx2 * 2.1;
        const ly = yy + ny2 * 2.1;
        const rx = x - nx2 * 2.1;
        const ry = yy - ny2 * 2.1;
        const l = g.vert(lx, z + 0.05, ly, 0, s / 3.9);
        const rr = g.vert(rx, z + 0.05, ry, 1, s / 3.9);
        if (pl >= 0) g.up(pl, pr, rr, l);
        pl = l;
        pr = rr;
        const q = [lx, ly, z, rx, ry, z];
        if (pq) field.clampQuad([pq[0], pq[1], pq[2], pq[3], pq[4], pq[5], q[3], q[4], q[5], q[0], q[1], q[2]], rl.bridge ? 1.4 : 0.3);
        pq = q;
      });
      if (rl.bridge) buildBridge(ri, L);
      else {
        const ss: number[] = [];
        for (let s = 0; s <= ri.len + 0.01; s += 5) ss.push(Math.min(s, ri.len));
        if (ss[ss.length - 1] < ri.len - 0.5) ss.push(ri.len);
        const none = ss.map(() => 0);
        for (const side of [1, -1]) earthworks(ri, L, side, ss, none, []);
      }
      if (k % 200 === 0) await yieldFrame();
    }
  }

  // ---- meshes
  const roadMat = roadMaterial(ctx);
  const trackMat = patch(new THREE.MeshLambertMaterial({ map: ctx.tex.track }), {
    key: 'track3',
    depthBias: 0.001,
    vertex: [['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);']],
    fragment: [['#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = pow(diffuseColor.rgb, vec3(2.2));']],
  });
  const markMat = markMaterial(ctx);
  const footMat = footMaterial(ctx);
  const structMat = structMaterial(ctx);
  const tubeMat = tubeMaterial(ctx);
  const text = makeRoadTextTexture(['BUS ONLY']);
  const wordMat = patch(new THREE.MeshLambertMaterial({ map: text.tex, transparent: true, alphaTest: 0.35, color: 0xd8d8d8, depthWrite: false }), {
    key: 'words3',
    depthBias: 0.002,
    vertex: [['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);']],
  });
  for (const [key, l] of layers) {
    const add = (geo: MeshGeo, mat: THREE.Material, name: string, opts: { cast?: boolean; order?: number; range?: number } = {}) => {
      if (geo.empty) return;
      const g = geo.build();
      const m = new THREE.Mesh(g, mat);
      m.name = `${name}-${key}`;
      m.receiveShadow = true;
      m.castShadow = !!opts.cast;
      if (opts.order) m.renderOrder = opts.order;
      ctx.root.add(m);
      const c = g.boundingSphere!.center;
      ctx.cull.push({ obj: m, x: c.x, z: c.z, range: opts.range ?? 4500 });
    };
    // ground strips take the natural terrain's normals so they shade like the ground around them
    {
      const g = l.strip;
      const P = g.pos.arr;
      for (let v = 0; v < g.count; v++) {
        const x = P[3 * v];
        const y = -P[3 * v + 2];
        const gx = (field.natAt(x + 2, y) - field.natAt(x - 2, y)) / 4;
        const gy = (field.natAt(x, y + 2) - field.natAt(x, y - 2)) / 4;
        const ln = Math.hypot(gx, 1, gy);
        g.setNormal(v, -gx / ln, 1 / ln, gy / ln);
      }
    }
    add(l.asphalt, roadMat, 'asphalt', { range: 9000 });
    add(l.mark, markMat, 'mark', { range: 2600 });
    add(l.words, wordMat, 'words', { order: 2, range: 1500 });
    add(l.foot, footMat, 'foot');
    add(l.strip, stripMat, 'strip', { range: 9000 });
    add(l.struct, structMat, 'struct', { cast: true, range: 7000 });
    add(l.tube, tubeMat, 'tube', { range: 2500 });
    add(l.track, trackMat, 'track', { range: 5000 });
  }
  return { infos, index, tunnels, portals };

  // =========================================================================
  // helpers (hoisted function declarations close over the locals above)

  /** At-grade road: footpaths, then the earthworks on each side. */
  function buildAtGrade(ri: RI, L: Layer, skips: [number, number][]): void {
    const r = ri.r;
    const hw = ri.hw;
    const footKinds = r.kind >= RoadKind.Primary && r.kind <= RoadKind.Residential && !r.link;
    const expressway = r.kind === RoadKind.Trunk && r.oneway && r.lanes >= 3;
    const wantFoot = (footKinds || (r.kind === RoadKind.Trunk && !r.link)) && !expressway;
    const step = 4;
    const ss: number[] = [];
    for (let s = 0; s <= ri.len + 0.01; s += step) ss.push(Math.min(s, ri.len));
    if (ss[ss.length - 1] < ri.len - 0.5) ss.push(ri.len);
    for (const side of [1, -1]) {
      // footpath validity per sample
      const foot: number[] = ss.map((s) => {
        if (!wantFoot) return 0;
        const c = roadAt(ri, s);
        for (const off of [hw + 0.35, hw + 2.2, hw + 3.9]) {
          const qx = c.x + c.nx * side * off;
          const qy = c.y + c.ny * side * off;
          if (otherAt(qx, qy, c.z, ri.i) > -0.25 || inWater(qx, qy)) return 0;
        }
        return 1;
      });
      // footpath runs
      let k = 0;
      while (k < foot.length) {
        if (!foot[k]) {
          k++;
          continue;
        }
        let e = k;
        while (e + 1 < foot.length && foot[e + 1]) e++;
        const a = Math.max(0, ss[k] - (k > 0 ? 1.5 : 0));
        const b = Math.min(ri.len, ss[e] + (e < foot.length - 1 ? 1.5 : 0));
        if (b - a > 3) {
          const c = roadAt(ri, (a + b) / 2);
          const dens = densityAt(ctx, c.x + c.nx * side * (hw + 6), c.y + c.ny * side * (hw + 6));
          const style = dens > 0.28 ? 1 : dens > 0.1 ? 2 : 0;
          const w = style === 1 ? 4.2 : style === 2 ? 3.2 : 3.9;
          footRun(L.foot, ri, a, b, side, w, style);
          for (let q = k; q <= e; q++) foot[q] = w;
        } else for (let q = k; q <= e; q++) foot[q] = 0;
        k = e + 1;
      }
      earthworks(ri, L, side, ss, foot, skips);
    }
  }

  /**
   * Shoulders / retaining walls / cuttings on one side of an at-grade road.
   * Profile types per sample: 0 none (junction), 1 batter, 2 cutting wall, 3 fill wall.
   */
  function earthworks(ri: RI, L: Layer, side: number, ss: number[], foot: number[], skips: [number, number][]): void {
    const r = ri.r;
    const hw = ri.hw;
    const n = ss.length;
    const type = new Uint8Array(n);
    const e0 = new Float32Array(n);
    const zE = new Float32Array(n);
    const P = ss.map((s) => roadAt(ri, s));
    for (let k = 0; k < n; k++) {
      const c = P[k];
      const fw = foot[k];
      e0[k] = hw + (fw > 0 ? fw : 0.15);
      zE[k] = c.z + (fw > 0 ? KERB_H : 0);
      const ox = (off: number) => c.x + c.nx * side * off;
      const oy = (off: number) => c.y + c.ny * side * off;
      const hn = field.natAt(ox(e0[k] + 2.5), oy(e0[k] + 2.5));
      const d = hn - zE[k];
      const t = d > 1.3 ? 2 : d < -2.2 ? 3 : 1;
      // in a junction, or another carriageway right beside us: leave it to the neighbour
      const inJ = skips.some(([a, b]) => ss[k] > a && ss[k] < b);
      const probe = t === 2 ? e0[k] + 0.3 : e0[k] + 1.5;
      const nb = otherAt(ox(probe), oy(probe), c.z, ri.i, 3) > -0.4 || (t === 1 && otherAt(ox(e0[k] + 5), oy(e0[k] + 5), c.z, ri.i, 3) > -0.4);
      if (nb || (inJ && t !== 2)) type[k] = 0;
      else type[k] = t;
      if (t === 2 && (nb || inJ)) type[k] = 4; // cutting but open toward a neighbour: floor only
    }
    const g = L.strip;
    const st = L.struct;
    const at = (c: (typeof P)[number], off: number) => [c.x + c.nx * side * off, c.y + c.ny * side * off] as const;
    const shoulderW = (k: number) => clamp(2.5 + 1.6 * Math.abs(field.natAt(...at(P[k], e0[k] + 3)) - zE[k]), 3, 9);
    for (let k = 0; k + 1 < n; k++) {
      const t = type[k];
      if (t === 0) continue;
      const A = P[k];
      let kb = k + 1;
      if (t === 1) {
        // merge up to three straight, evenly graded samples into one shoulder quad
        const wa = shoulderW(k);
        while (kb - k < 3 && kb + 1 < n && type[kb] === 1 && e0[kb + 1] === e0[k]) {
          const C = P[kb + 1];
          if (A.nx * C.nx + A.ny * C.ny < 0.998) break;
          const wc = shoulderW(kb + 1);
          let ok = true;
          for (let q = k + 1; q <= kb; q++) {
            const f = (ss[q] - ss[k]) / (ss[kb + 1] - ss[k]);
            if (Math.abs(zE[q] - (zE[k] + (zE[kb + 1] - zE[k]) * f)) > 0.06) ok = false;
            const [px, py] = at(P[q], e0[q] + wa + (wc - wa) * f);
            const [ax, ay] = at(A, e0[k] + wa);
            const [cx, cy] = at(C, e0[kb + 1] + wc);
            const lin = field.natAt(ax, ay) + (field.natAt(cx, cy) - field.natAt(ax, ay)) * f;
            if (Math.abs(field.natAt(px, py) - lin) > 0.12) ok = false;
          }
          if (!ok) break;
          kb++;
        }
      }
      const B = P[kb];
      const fx = side * A.nx;
      const fy = side * A.ny;
      if (t === 1) {
        // graded shoulder to the natural ground
        const wa = shoulderW(k);
        const wb = shoulderW(kb);
        const [a0x, a0y] = at(A, e0[k]);
        const [b0x, b0y] = at(B, e0[kb]);
        const [a1x, a1y] = at(A, e0[k] + wa);
        const [b1x, b1y] = at(B, e0[kb] + wb);
        const a1z = field.natAt(a1x, a1y);
        const b1z = field.natAt(b1x, b1y);
        const i0 = g.vert(a0x, zE[k], a0y);
        const i1 = g.vert(b0x, zE[kb], b0y);
        const i2 = g.vert(b1x, b1z, b1y);
        const i3 = g.vert(a1x, a1z, a1y);
        g.quad(i0, i1, i2, i3, 0, 1, 0);
        // small skirt so the strip edge never shows a gap
        const s2 = g.vert(b1x, b1z - 0.4, b1y);
        const s3 = g.vert(a1x, a1z - 0.4, a1y);
        g.quad(i3, i2, s2, s3, fx, 0, -fy);
        field.clampQuad([a0x, a0y, zE[k], b0x, b0y, zE[kb], b1x, b1y, b1z, a1x, a1y, a1z], 0.25);
        k = kb - 1;
      } else if (t === 2 || t === 4) {
        cutSeg(L, A, B, side, ss[k], ss[k + 1], foot[k], foot[k + 1], e0[k], e0[k + 1], hw, t === 2);
        // ends of a walled cutting: carry the ground cap on past the end, over the carved cells there
        if (t === 2 && (k === 0 || type[k - 1] !== 2)) cutEndCap(L, P[k], P[k + 1], side, e0[k] + 0.6);
        if (t === 2 && (k + 2 >= n || type[k + 1] !== 2)) cutEndCap(L, P[k + 1], P[k], side, e0[k + 1] + 0.6);
      } else if (t === 3) {
        // high fill: retaining wall from a parapet down to the ground
        const [w0x, w0y] = at(A, e0[k] + 0.1);
        const [w1x, w1y] = at(B, e0[k + 1] + 0.1);
        const [o0x, o0y] = at(A, e0[k] + 0.5);
        const [o1x, o1y] = at(B, e0[k + 1] + 0.5);
        const ga = field.natAt(o0x, o0y) - 0.8;
        const gb = field.natAt(o1x, o1y) - 0.8;
        const ta = zE[k] + 0.9;
        const tb = zE[k + 1] + 0.9;
        const v0 = st.vert(w0x, zE[k], w0y, ...CONC);
        const v1 = st.vert(w1x, zE[k + 1], w1y, ...CONC);
        const v2 = st.vert(w1x, tb, w1y, ...CONC);
        const v3 = st.vert(w0x, ta, w0y, ...CONC);
        st.quad(v0, v1, v2, v3, -fx, 0, fy);
        const u0 = st.vert(o0x, ta, o0y, ...CONC);
        const u1 = st.vert(o1x, tb, o1y, ...CONC);
        st.quad(v3, v2, u1, u0, 0, 1, 0);
        const q0 = st.vert(o0x, ga, o0y, ...WALL);
        const q1 = st.vert(o1x, gb, o1y, ...WALL);
        st.quad(q0, q1, u1, u0, fx, 0, -fy);
        // keep the fill under the deck: clamp natural ground there
        field.clampQuad([...at(A, 0), ga, ...at(B, 0), gb, ...at(B, e0[k + 1]), gb, ...at(A, e0[k]), ga], 0.3);
      }
    }
    void r;
  }

  /**
   * One segment of open cutting on one side: carve the terrain, floor from the
   * kerb to the wall, retaining wall up to the ground (with a parapet) and a
   * cap strip at ground level that covers the edge of the carved cells.
   */
  function cutSeg(
    L: Layer,
    A: ReturnType<typeof roadAt>,
    B: ReturnType<typeof roadAt>,
    side: number,
    sA: number,
    sB: number,
    footA: number,
    footB: number,
    eA: number,
    eB: number,
    hw: number,
    wall: boolean,
  ): void {
    const g = L.strip;
    const st = L.struct;
    const at = (c: typeof A, off: number) => [c.x + c.nx * side * off, c.y + c.ny * side * off] as const;
    const fx = side * A.nx;
    const fy = side * A.ny;
    const cutA = wall ? eA + 0.6 : eA + 3.5;
    const cutB = wall ? eB + 0.6 : eB + 3.5;
    const [c0x, c0y] = at(A, 0);
    const [c1x, c1y] = at(B, 0);
    const [w0x, w0y] = at(A, cutA);
    const [w1x, w1y] = at(B, cutB);
    field.holeQuad([c0x, c0y, 0, c1x, c1y, 0, w1x, w1y, 0, w0x, w0y, 0], 0.3);
    const [f0x, f0y] = at(A, footA > 0 ? eA : hw);
    const [f1x, f1y] = at(B, footB > 0 ? eB : hw);
    const z0 = A.z + (footA > 0 ? KERB_H : -0.02);
    const z1 = B.z + (footB > 0 ? KERB_H : -0.02);
    const j0 = L.foot.vert(f0x, z0, f0y, 0.5, sA, 4);
    const j1 = L.foot.vert(f1x, z1, f1y, 0.5, sB, 4);
    const j2 = L.foot.vert(w1x, z1, w1y, 0.5, sB, 4);
    const j3 = L.foot.vert(w0x, z0, w0y, 0.5, sA, 4);
    L.foot.quad(j0, j1, j2, j3, 0, 1, 0);
    if (!wall) return;
    const ga = field.natAt(...at(A, cutA + 0.5));
    const gb = field.natAt(...at(B, cutB + 0.5));
    const T = 0.45;
    const [o0x, o0y] = at(A, cutA + T);
    const [o1x, o1y] = at(B, cutB + T);
    const topA = Math.max(ga + 0.9, z0 + 1.2);
    const topB = Math.max(gb + 0.9, z1 + 1.2);
    const v0 = st.vert(w0x, z0 - 0.2, w0y, ...WALL);
    const v1 = st.vert(w1x, z1 - 0.2, w1y, ...WALL);
    const v2 = st.vert(w1x, topB, w1y, ...WALL);
    const v3 = st.vert(w0x, topA, w0y, ...WALL);
    st.quad(v0, v1, v2, v3, -fx, 0, fy);
    const u0 = st.vert(o0x, topA, o0y, ...CONC);
    const u1 = st.vert(o1x, topB, o1y, ...CONC);
    const u2 = st.vert(w1x, topB, w1y, ...CONC);
    const u3 = st.vert(w0x, topA, w0y, ...CONC);
    st.quad(u0, u1, u2, u3, 0, 1, 0);
    const q0 = st.vert(o0x, ga - 1, o0y, ...WALL);
    const q1 = st.vert(o1x, gb - 1, o1y, ...WALL);
    st.quad(q0, q1, u1, u0, fx, 0, -fy);
    const cols = [T, 6 + T, 16 + T];
    let prevA = -1;
    let prevB = -1;
    for (const o of cols) {
      const [ax, ay] = at(A, cutA + o);
      const [bx, by] = at(B, cutB + o);
      const ia = g.vert(ax, field.natAt(ax, ay), ay);
      const ib = g.vert(bx, field.natAt(bx, by), by);
      if (prevA >= 0) g.quad(prevA, prevB, ib, ia, 0, 1, 0);
      prevA = ia;
      prevB = ib;
    }
  }

  /**
   * Ground cap continuing 15 m past the end of a walled cutting (`c` is the end
   * sample, `prev` the one before it), tapering away from the road so it never
   * hangs over the shoulder that takes over there.
   */
  function cutEndCap(L: Layer, c: ReturnType<typeof roadAt>, prev: ReturnType<typeof roadAt>, side: number, cut: number): void {
    const g = L.strip;
    let ox = c.x - prev.x;
    let oy = c.y - prev.y;
    const ol = Math.hypot(ox, oy) || 1;
    ox /= ol;
    oy /= ol;
    const T = 0.45;
    // carved cells reach up to a cell diagonal (14 m) past the end; taper only
    // slightly so the cap still meets the shoulder strip that takes over
    const rows: [number, number][] = [
      [0, cut + T],
      [15, cut + T + 2.5],
    ];
    const cols = [0, 6, 16];
    const grid: number[][] = rows.map(([d, inner]) =>
      cols.map((o) => {
        const x = c.x + ox * d + c.nx * side * (inner + o);
        const y = c.y + oy * d + c.ny * side * (inner + o);
        return g.vert(x, field.natAt(x, y), y);
      }),
    );
    for (let q = 0; q + 1 < cols.length; q++) g.quad(grid[0][q], grid[0][q + 1], grid[1][q + 1], grid[1][q], 0, 1, 0);
    // short skirt under the inner edge
    const sk = rows.map(([d, inner]) => {
      const x = c.x + ox * d + c.nx * side * inner;
      const y = c.y + oy * d + c.ny * side * inner;
      return g.vert(x, field.natAt(x, y) - 1.5, y);
    });
    g.quad(grid[0][0], grid[1][0], sk[1], sk[0], -side * c.nx, 0, side * c.ny);
  }

  /** Raised kerb + footpath strip (heights follow the road). */
  function footRun(g: MeshGeo, ri: RI, a: number, b: number, side: number, W: number, style: number): void {
    const hw = ri.hw;
    let prev: number[] | null = null;
    let last: number[] = [];
    let first = true;
    const cap = (ix: number, iy: number, ox: number, oy: number, z: number, s: number, fx: number, fz: number) => {
      const c1 = g.vert(ix, z + KERB_H, iy, 0, s, 3);
      const c2 = g.vert(ox, z + KERB_H, oy, W, s, 3);
      const c3 = g.vert(ox, z - 0.3, oy, W, s, 3);
      const c4 = g.vert(ix, z, iy, 0, s, 3);
      g.quad(c1, c2, c3, c4, fx, 0, fz);
    };
    walkRun(ri, a, b, (x, yy, z, nx2, ny2, s) => {
      const ix = x + nx2 * side * hw;
      const iy = yy + ny2 * side * hw;
      const ox = x + nx2 * side * (hw + W);
      const oy = yy + ny2 * side * (hw + W);
      const zr = z + ri.lift;
      const top = z + KERB_H;
      const kb = g.vert(ix, zr, iy, 0, s, 3);
      const kt = g.vert(ix, top, iy, 0, s, 3);
      const ti = g.vert(ix, top, iy, 0, s, style);
      const to = g.vert(ox, top, oy, W, s, style);
      const ot = g.vert(ox, top, oy, W, s, 3);
      const ob = g.vert(ox, z - 0.4, oy, W, s, 3);
      const v = [kb, kt, ti, to, ot, ob];
      if (prev) {
        g.quad(prev[0], kb, kt, prev[1], -nx2 * side, 0, ny2 * side);
        g.up(prev[2], ti, to, prev[3]);
        g.quad(prev[4], ot, ob, prev[5], nx2 * side, 0, -ny2 * side);
      }
      if (first) cap(ix, iy, ox, oy, z, s, -ny2, -nx2);
      first = false;
      prev = v;
      last = [ix, iy, ox, oy, z, s, nx2, ny2];
    });
    if (last.length) cap(last[0], last[1], last[2], last[3], last[4], last[5], last[7], last[6]);
    // clamp the ground under the whole footpath run
    let pq: number[] | null = null;
    walkRun(ri, a, b, (x, yy, z, nx2, ny2) => {
      const q = [x + nx2 * side * hw, yy + ny2 * side * hw, z, x + nx2 * side * (hw + W), yy + ny2 * side * (hw + W), z];
      if (pq) field.clampQuad([pq[0], pq[1], pq[2], pq[3], pq[4], pq[5], q[3], q[4], q[5], q[0], q[1], q[2]], 0.2);
      pq = q;
    });
  }

  /** Bridge / viaduct: fascia + underside, parapets, piers, abutments. */
  function buildBridge(ri: RI, L: Layer): void {
    const r = ri.r;
    const hw = ri.hw;
    const g = L.struct;
    const heavy = r.kind <= RoadKind.Trunk || r.kind === RoadKind.Busway || r.bus;
    const depth = heavy ? 1.9 : 1.3;
    const edge = hw + 0.45;
    // parapets, open where another carriageway at the same level runs alongside
    for (const side of [1, -1]) {
      const step = 3;
      const ss: number[] = [];
      const ok: boolean[] = [];
      for (let s = 0; s <= ri.len + 0.01; s += step) {
        const c = roadAt(ri, Math.min(s, ri.len));
        const qx = c.x + c.nx * side * (hw + 0.25);
        const qy = c.y + c.ny * side * (hw + 0.25);
        ok.push(otherAt(qx, qy, c.z, ri.i, 1.5) < -0.15);
        ss.push(Math.min(s, ri.len));
      }
      let k = 0;
      while (k < ok.length) {
        if (!ok[k]) {
          k++;
          continue;
        }
        let e = k;
        while (e + 1 < ok.length && ok[e + 1]) e++;
        if (ss[e] - ss[k] > 2) {
          parapet(g, ri, ss[k], ss[e], side, hw + 0.05, edge, 0, 0.95, CONC);
          if (r.kind !== RoadKind.Motorway) parapet(g, ri, ss[k], ss[e], side, hw + 0.15, hw + 0.27, 1.05, 1.15, STEEL);
        }
        k = e + 1;
      }
    }
    // deck edges and underside
    let prev: number[] | null = null;
    walkRun(ri, 0, ri.len, (x, yy, z, nx2, ny2) => {
      const lx = x + nx2 * edge;
      const ly = yy + ny2 * edge;
      const rx = x - nx2 * edge;
      const ry = yy - ny2 * edge;
      const v = [
        g.vert(lx, z + ri.lift, ly, ...CONC),
        g.vert(lx, z - depth, ly, ...CONC),
        g.vert(rx, z - depth, ry, ...CONC_DARK),
        g.vert(rx, z + ri.lift, ry, ...CONC),
        g.vert(lx, z - depth, ly, ...CONC_DARK),
        g.vert(rx, z - depth, ry, ...CONC),
      ];
      if (prev) {
        g.quad(prev[0], v[0], v[1], prev[1], nx2, 0, -ny2);
        g.quad(prev[3], v[3], v[5], prev[5], -nx2, 0, ny2);
        g.quad(prev[4], v[4], v[2], prev[2], 0, -1, 0);
      }
      prev = v;
    });
    // piers, moved off roads and railways underneath
    const span = ri.len > 200 && ri.z[0] > 12 ? 40 : 30;
    const highDeck = (s: number) => roadAt(ri, s).z > 26; // Story Bridge main span: no generic piers
    for (let s = span * 0.5; s < ri.len - 6; s += span) {
      let placed = false;
      for (const shift of [0, 4, -4, 8, -8, 12, -12]) {
        const sp = s + shift;
        if (sp < 4 || sp > ri.len - 4) continue;
        const c = roadAt(ri, sp);
        const bottom = c.z - depth;
        const ground = field.renAt(c.x, c.y);
        if (bottom - ground < 1.2) {
          placed = true;
          break;
        }
        if ((highDeck(sp) && inWater(c.x, c.y)) || (story && pointInRing(c.x, c.y, story))) {
          placed = true;
          break;
        }
        const cols = hw > 6 ? [-hw * 0.55, hw * 0.55] : [0];
        let clear = true;
        for (const o of cols) {
          const px = c.x + c.nx * o;
          const py = c.y + c.ny * o;
          if (index.penetrationZ(px, py, ground, 4, ri.i) > -1.4) clear = false;
          if (mask.near(px, py, 1.5, MASK_RAIL)) clear = false;
        }
        if (!clear) continue;
        const tx = c.ny;
        const ty = -c.nx;
        const base = Math.min(ground, ctx.data.terrain.waterLevel) - 1;
        for (const o of cols) {
          const px = c.x + c.nx * o;
          const py = c.y + c.ny * o;
          g.cylinder(px, py, base, bottom - 0.9, heavy ? 0.85 : 0.6, 10, ...CONC);
        }
        g.box(c.x, c.y, bottom - 1.0, bottom, tx, ty, 0.9, hw + 0.2, ...CONC_DARK);
        placed = true;
        break;
      }
      void placed;
    }
    // abutments where the deck lands on a surface road
    const p = r.pts;
    for (const end of [0, 1]) {
      const v = end === 0 ? 0 : ri.n - 1;
      const nd = nodes.get(nodeKey(p[2 * v], p[2 * v + 1]));
      if (!nd || nd.surf <= 1) continue;
      const c = roadAt(ri, end === 0 ? 0 : ri.len);
      const ground = field.natAt(c.x, c.y);
      if (c.z - depth - ground < 0.3) continue;
      g.box(c.x, c.y, ground - 1, c.z - 0.05, c.ny, -c.nx, 0.7, edge + 0.4, ...WALL);
    }
  }

  function parapet(g: MeshGeo, ri: RI, a: number, b: number, side: number, o0: number, o1: number, h0: number, h1: number, col: number[]): void {
    let prev: number[] | null = null;
    walkRun(ri, a, b, (x, yy, z, nx2, ny2) => {
      const ix = x + nx2 * side * o0;
      const iy = yy + ny2 * side * o0;
      const ox = x + nx2 * side * o1;
      const oy = yy + ny2 * side * o1;
      const v = [g.vert(ix, z + h0, iy, ...col), g.vert(ix, z + h1, iy, ...col), g.vert(ox, z + h1, oy, ...col), g.vert(ox, z + h0, oy, ...col)];
      if (prev) {
        g.quad(prev[0], v[0], v[1], prev[1], -nx2 * side, 0, ny2 * side);
        g.up(prev[1], v[1], v[2], prev[2]);
        g.quad(prev[3], v[3], v[2], prev[2], nx2 * side, 0, -ny2 * side);
      } else {
        g.quad(v[0], v[1], v[2], v[3], -ny2, 0, -nx2);
      }
      prev = v;
    });
  }

  /** Railway tunnel mouths: headwall and a dark opening (trains only; no interior). */
  function railPortals(ri: RI, L: Layer, railNodes: Map<number, { tun: number; surf: number }>): void {
    const p = ri.r.pts;
    for (const end of [0, 1]) {
      const v = end === 0 ? 0 : ri.n - 1;
      const nd = railNodes.get(nodeKey(p[2 * v], p[2 * v + 1]));
      if (!nd || nd.surf === 0) continue;
      const c = roadAt(ri, end === 0 ? 0 : ri.len);
      const inward = end === 0 ? 1 : -1;
      const tx = c.ny * inward;
      const ty = -c.nx * inward;
      const H = 6.2;
      const half = 3.2;
      const ground = Math.max(field.natAt(c.x + tx * 6, c.y + ty * 6), c.z + H + 0.5);
      const st = L.struct;
      st.box(c.x - tx * 0.3, c.y - ty * 0.3, c.z + H, ground + 1.0, tx, ty, 0.6, half + 1, ...WALL);
      st.box(c.x + c.nx * half - tx * 0.3, c.y + c.ny * half - ty * 0.3, c.z - 0.2, c.z + H, tx, ty, 0.6, 0.6, ...WALL);
      st.box(c.x - c.nx * half - tx * 0.3, c.y - c.ny * half - ty * 0.3, c.z - 0.2, c.z + H, tx, ty, 0.6, 0.6, ...WALL);
      const d = 1.2;
      const m0 = st.vert(c.x + tx * d + c.nx * half, c.z, c.y + ty * d + c.ny * half, 8, 8, 9);
      const m1 = st.vert(c.x + tx * d - c.nx * half, c.z, c.y + ty * d - c.ny * half, 8, 8, 9);
      const m2 = st.vert(c.x + tx * d - c.nx * half, c.z + H, c.y + ty * d - c.ny * half, 8, 8, 9);
      const m3 = st.vert(c.x + tx * d + c.nx * half, c.z + H, c.y + ty * d + c.ny * half, 8, 8, 9);
      st.quad(m0, m1, m2, m3, -tx, 0, ty);
    }
  }

  /** Is the tunnel deep enough here to be an enclosed tube (else an open cutting)? */
  function covered(ri: RI, c: { x: number; y: number; z: number }): boolean {
    const H = ri.r.kind === RoadKind.Motorway ? TUBE_H + 0.6 : TUBE_H;
    return field.natAt(c.x, c.y) - (c.z + H) > -1.2;
  }

  /**
   * Tunnel: enclosed tube (walls, ceiling, walkways, lamps) where there is
   * ground over it, open toward neighbouring tunnel roads and underground
   * platforms; where the ground is too low (portal approaches) it is an open
   * cutting instead, with a headwall where the two meet.
   */
  function buildTube(ri: RI, L: Layer): void {
    const r = ri.r;
    const hw = ri.hw;
    const t = L.tube;
    const wallOff = hw + 0.9;
    const H = r.kind === RoadKind.Motorway ? TUBE_H + 0.6 : TUBE_H;
    const wallC = [168, 166, 160];
    const ceilC = [92, 92, 94];
    const walkC = [120, 118, 112];
    const lamp = [255, 236, 190];
    const inPlatform = (x: number, y: number) => underPlatforms.some((pf) => pf.area && pointInRing(x, y, pf.pts));
    // other carriageways at this level, tunnels included (the main index leaves tunnels out)
    const tubeNb = (x: number, y: number, z: number) => Math.max(otherAt(x, y, z, ri.i, 3), tunnels.penetrationZ(x, y, z, 3, ri.i));
    const step = 4;
    const ss: number[] = [];
    for (let s = 0; s <= ri.len + 0.01; s += step) ss.push(Math.min(s, ri.len));
    if (ss[ss.length - 1] < ri.len - 0.5) ss.push(ri.len);
    const P0 = ss.map((s) => roadAt(ri, s));
    const cov = P0.map((c) => covered(ri, c));
    const TUBE_EXT = 2.5;
    const joinStart = (nodes.get(nodeKey(r.pts[0], r.pts[1]))?.tun ?? 0) > 1;
    const joinEnd = (nodes.get(nodeKey(r.pts[r.pts.length - 2], r.pts[r.pts.length - 1]))?.tun ?? 0) > 1;
    const unit = (ax: number, ay: number, bx: number, by: number): [number, number] => {
      const l = Math.hypot(bx - ax, by - ay) || 1;
      return [(bx - ax) / l, (by - ay) / l];
    };
    const nP = P0.length;
    const dirS = unit(P0[0].x, P0[0].y, P0[Math.min(1, nP - 1)].x, P0[Math.min(1, nP - 1)].y);
    const dirE = unit(P0[Math.max(0, nP - 2)].x, P0[Math.max(0, nP - 2)].y, P0[nP - 1].x, P0[nP - 1].y);
    const cover = P0.map((c) => field.natAt(c.x, c.y) - (c.z + H));
    // keep the ground (and terrain skirts) above the roof of the covered parts
    for (let k = 0; k + 1 < ss.length; k++) {
      if (!cov[k] && !cov[k + 1]) continue;
      const A = P0[k];
      const B = P0[k + 1];
      const o = wallOff + 0.6;
      field.protectQuad(
        [A.x + A.nx * o, A.y + A.ny * o, A.z + H + 0.15, B.x + B.nx * o, B.y + B.ny * o, B.z + H + 0.15, B.x - B.nx * o, B.y - B.ny * o, B.z + H + 0.15, A.x - A.nx * o, A.y - A.ny * o, A.z + H + 0.15],
        10,
      );
    }
    for (const side of [1, -1]) {
      // open toward a neighbouring tunnel carriageway (its tube closes the far side)
      // (also wherever the wall line itself would stand in or against another carriageway)
      const nbAt = (c: { x: number; y: number; z: number; nx: number; ny: number }) => {
        const at = (o: number) => tubeNb(c.x + c.nx * side * o, c.y + c.ny * side * o, c.z);
        return at(wallOff) > -0.5 || at(wallOff + 0.4) > -0.6 || at(wallOff + 3) > -0.6;
      };
      const open = P0.map(nbAt);
      const segOpen = ss.slice(1).map((s1, k) => open[k] || open[k + 1] || nbAt(roadAt(ri, (ss[k] + s1) / 2)));
      // where the open side closes up again, a short nose wall seals the wedge between the two tubes
      const nose = (k: number) => {
        const c = P0[k];
        if (!cov[k]) return;
        let end = -1;
        for (let o = wallOff + 0.5; o <= wallOff + 12; o += 0.5) {
          if (tubeNb(c.x + c.nx * side * o, c.y + c.ny * side * o, c.z) > -1.0) {
            end = o;
            break;
          }
        }
        if (end < 0) return;
        const q = (o: number, hh: number) => t.vert(c.x + c.nx * side * o, c.z + hh, c.y + c.ny * side * o, ...wallC);
        t.quad(q(wallOff, 0), q(end, 0), q(end, H), q(wallOff, H), c.ny, 0, c.nx);
      };
      // underground platform beside the road: push the wall out past its far
      // edge, unless another carriageway lies just beyond it (an island
      // platform): then the two share one hall and there is no wall between
      const platEdge = P0.map((c) => {
        let last = -1;
        for (let o = hw + 0.3; o < hw + 26; o += 0.5) {
          if (inPlatform(c.x + c.nx * side * o, c.y + c.ny * side * o)) last = o;
          else if (last >= 0 || o > hw + 8) break;
        }
        return last;
      });
      const shared = P0.map((c, k) => {
        const last = platEdge[k];
        if (last < 0) return false;
        for (let o = last + 0.5; o <= last + 8; o += 0.5) if (tubeNb(c.x + c.nx * side * o, c.y + c.ny * side * o, c.z) > -0.5) return true;
        return false;
      });
      const wo = platEdge.map((last, k) => (last >= 0 && !shared[k] ? Math.max(wallOff, last + 1.2) : wallOff));
      for (let k = 0; k + 1 < ss.length; k++) {
        let A = P0[k];
        let B = P0[k + 1];
        const isShared = shared[k] || shared[k + 1];
        const isOpen = segOpen[k] || isShared;
        if (k > 0 && (segOpen[k - 1] || shared[k - 1] || shared[k]) !== isOpen) nose(k);
        if (!cov[k] && !cov[k + 1]) {
          // approach in an open cutting
          cutSeg(L, A, B, side, ss[k], ss[k + 1], 0, 0, hw + 0.3, hw + 0.3, hw, !isOpen);
          if (!isOpen && k === 0) cutEndCap(L, A, B, side, hw + 0.9);
          if (!isOpen && k + 2 === ss.length) cutEndCap(L, B, A, side, hw + 0.9);
          continue;
        }
        // where this tube meets another one, run on a little so the two overlap
        // instead of leaving a wedge open on the outside of the bend
        if (k === 0 && joinStart) A = { ...A, x: A.x - dirS[0] * TUBE_EXT, y: A.y - dirS[1] * TUBE_EXT };
        if (k + 2 === ss.length && joinEnd) B = { ...B, x: B.x + dirE[0] * TUBE_EXT, y: B.y + dirE[1] * TUBE_EXT };
        const P = (c: typeof A, off: number, h: number) => [c.x + c.nx * side * off, c.z + h, c.y + c.ny * side * off] as const;
        const fx = side * A.nx;
        const fy = side * A.ny;
        const woA = isOpen ? wallOff : wo[k];
        const woB = isOpen ? wallOff : wo[k + 1];
        // shared hall: ceiling reaches over the platform into the other carriageway
        const ceilA = isShared ? Math.max(wallOff + 6, platEdge[k] + 3) : isOpen ? wallOff + 6 : woA;
        const ceilB = isShared ? Math.max(wallOff + 6, platEdge[k + 1] + 3) : isOpen ? wallOff + 6 : woB;
        if (isOpen) {
          // toward a neighbouring carriageway: a flush floor under the gap, no kerb
          const f0 = t.vert(...P(A, hw - 0.2, -0.04), ...walkC);
          const f1 = t.vert(...P(B, hw - 0.2, -0.04), ...walkC);
          const f2 = t.vert(...P(B, ceilB, -0.04), ...walkC);
          const f3 = t.vert(...P(A, ceilA, -0.04), ...walkC);
          t.quad(f0, f1, f2, f3, 0, 1, 0);
        } else {
          const w0 = t.vert(...P(A, hw, 0.25), ...walkC);
          const w1 = t.vert(...P(B, hw, 0.25), ...walkC);
          const w2 = t.vert(...P(B, woB, 0.25), ...walkC);
          const w3 = t.vert(...P(A, woA, 0.25), ...walkC);
          t.quad(w0, w1, w2, w3, 0, 1, 0);
          const k0 = t.vert(...P(A, hw, 0), ...walkC);
          const k1 = t.vert(...P(B, hw, 0), ...walkC);
          t.quad(k0, k1, w1, w0, -fx, 0, fy);
        }
        const c0 = t.vert(...P(A, 0, H), ...ceilC);
        const c1 = t.vert(...P(B, 0, H), ...ceilC);
        const c2 = t.vert(...P(B, ceilB, H), ...ceilC);
        const c3 = t.vert(...P(A, ceilA, H), ...ceilC);
        t.quad(c0, c1, c2, c3, 0, -1, 0);
        if (!isOpen) {
          const a0 = t.vert(...P(A, woA, 0), ...wallC);
          const a1 = t.vert(...P(B, woB, 0), ...wallC);
          const a2 = t.vert(...P(B, woB, H), ...wallC);
          const a3 = t.vert(...P(A, woA, H), ...wallC);
          t.quad(a0, a1, a2, a3, -fx, 0, fy);
          const d0 = t.vert(...P(A, woA - 0.01, 0), 70, 72, 74);
          const d1 = t.vert(...P(B, woB - 0.01, 0), 70, 72, 74);
          const d2 = t.vert(...P(B, woB - 0.01, 1.1), 70, 72, 74);
          const d3 = t.vert(...P(A, woA - 0.01, 1.1), 70, 72, 74);
          t.quad(d0, d1, d2, d3, -fx, 0, fy);
        }
        // shallow cover: a grassed mound over the box so its roof never shows
        if (cover[k] < 0.6 || cover[k + 1] < 0.6) {
          const g = L.strip;
          const mound = (c: typeof A, o: number) => {
            const x = c.x + c.nx * side * o;
            const y = c.y + c.ny * side * o;
            const top = c.z + H + 0.5;
            return g.vert(x, o <= wallOff + 1 ? Math.max(field.natAt(x, y), top) : field.natAt(x, y), y);
          };
          const cols = [0, wallOff + 1, wallOff + 8];
          let pa = -1;
          let pb = -1;
          for (const o of cols) {
            const ia = mound(A, o);
            const ib = mound(B, o);
            if (pa >= 0) g.quad(pa, pb, ib, ia, 0, 1, 0);
            pa = ia;
            pb = ib;
          }
        }
      }
    }
    // lamps along the covered parts of the ceiling
    for (let s = 3; s < ri.len; s += 9) {
      const c = roadAt(ri, s);
      if (!covered(ri, c)) continue;
      const tx = c.ny;
      const ty = -c.nx;
      for (const o of [-hw * 0.45, hw * 0.45]) {
        const cx = c.x + c.nx * o;
        const cy = c.y + c.ny * o;
        const h = c.z + H - 0.06;
        const a = t.vert(cx - tx * 1.6 - c.nx * 0.18, h, cy - ty * 1.6 - c.ny * 0.18, ...lamp);
        const b = t.vert(cx + tx * 1.6 - c.nx * 0.18, h, cy + ty * 1.6 - c.ny * 0.18, ...lamp);
        const cc = t.vert(cx + tx * 1.6 + c.nx * 0.18, h, cy + ty * 1.6 + c.ny * 0.18, ...lamp);
        const dd = t.vert(cx - tx * 1.6 + c.nx * 0.18, h, cy - ty * 1.6 + c.ny * 0.18, ...lamp);
        t.quad(a, b, cc, dd, 0, -1, 0);
      }
    }
    // portals: where an open approach meets the covered tube, and covered ends that meet the surface
    const p = r.pts;
    const portalAt = (k: number, inward: number) => {
      const c = P0[k];
      portals.push({ x: c.x, y: c.y, z: c.z });
      const tx = c.ny * inward;
      const ty = -c.nx * inward;
      const ground = Math.max(field.natAt(c.x + tx * 6, c.y + ty * 6), c.z + H + 0.5);
      const half = wallOff + 1.2;
      const st = L.struct;
      st.box(c.x - tx * 0.3, c.y - ty * 0.3, c.z + H, ground + 1.0, tx, ty, 0.6, half, ...WALL);
      st.box(c.x + c.nx * (half - 0.3) - tx * 0.3, c.y + c.ny * (half - 0.3) - ty * 0.3, c.z - 0.2, c.z + H, tx, ty, 0.6, 0.6, ...WALL);
      st.box(c.x - c.nx * (half - 0.3) - tx * 0.3, c.y - c.ny * (half - 0.3) - ty * 0.3, c.z - 0.2, c.z + H, tx, ty, 0.6, 0.6, ...WALL);
      // ground over the mouth (covers the carved edge of the approach cutting)
      const g = L.strip;
      const rows = [0, 8, 18];
      const cols = [-half - 10, -half, 0, half, half + 10];
      const ids: number[][] = rows.map((d) =>
        cols.map((o) => {
          const x = c.x + tx * d + c.nx * o;
          const y = c.y + ty * d + c.ny * o;
          return g.vert(x, Math.max(field.natAt(x, y), c.z + H + 0.5), y);
        }),
      );
      for (let a = 0; a + 1 < rows.length; a++) for (let b = 0; b + 1 < cols.length; b++) g.quad(ids[a][b], ids[a][b + 1], ids[a + 1][b + 1], ids[a + 1][b], 0, 1, 0);
    };
    for (let k = 0; k + 1 < ss.length; k++) {
      if (!cov[k] && cov[k + 1]) portalAt(k + 1, 1);
      if (cov[k] && !cov[k + 1]) portalAt(k, -1);
    }
    for (const end of [0, 1]) {
      const v = end === 0 ? 0 : ri.n - 1;
      const k = end === 0 ? 0 : ss.length - 1;
      const nd = nodes.get(nodeKey(p[2 * v], p[2 * v + 1]));
      if (!nd || nd.surf === 0 || !cov[k]) continue;
      portalAt(k, end === 0 ? 1 : -1);
    }
  }
}
