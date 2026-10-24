/**
 * Roads: asphalt ribbons, lane markings, kerbs and footpaths, busway barriers
 * and "BUS ONLY" words, bridge parapets/decks/piers and tunnel portals.
 *
 * Z-fighting is avoided with per-rank surface heights (roadHeight) and by
 * sampling asphalt in world space, so overlapping roads of the same rank
 * produce identical pixels.
 */
import * as THREE from 'three';
import { RoadKind, type Road } from '../types';
import { type Ctx, densityAt } from './ctx';
import { MeshGeo } from './geo';
import { RoadIndex, roadHeight } from './roadindex';
import { NOISE_GLSL, patch } from './shaders';
import { makeRoadTextTexture } from './textures';
import { MASK_WATER, clamp, pointInRing, yieldFrame } from './util';

export const KERB_H = 0.15;
const ROAD_CHUNK = 2500;

/** Prepared road: cumulative lengths and miter normals. */
export interface RI {
  r: Road;
  i: number;
  hw: number;
  y: number;
  n: number;
  cum: Float32Array;
  /** Left normal (map coords) per vertex, already scaled by the miter factor. */
  mx: Float32Array;
  my: Float32Array;
  len: number;
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
    const l0 = Math.hypot(d0x, d0y);
    const l1 = Math.hypot(d1x, d1y);
    if (l0 < 1e-6) {
      d0x = d1x;
      d0y = d1y;
    }
    if (l1 < 1e-6) {
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
  return { r, i, hw: r.width / 2, y: roadHeight(r), n, cum, mx, my, len: cum[n - 1] };
}

/** Point and (unscaled) left normal at distance s. */
export function roadAt(ri: RI, s: number): { x: number; y: number; nx: number; ny: number; k: number } {
  const p = ri.r.pts;
  const cum = ri.cum;
  let k = 0;
  let hi = ri.n - 1;
  if (s <= 0) k = 0;
  else if (s >= ri.len) k = ri.n - 2;
  else {
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
  return { x: ax + dx * t, y: ay + dy * t, nx: -dy / l, ny: dx / l, k };
}

/**
 * Walk [sA, sB] calling fn(x, y, nx, ny, s) at sA, every interior vertex and
 * sB; the normal includes the miter factor at vertices.
 */
export function walkRun(ri: RI, sA: number, sB: number, fn: (x: number, y: number, nx: number, ny: number, s: number) => void): void {
  const a = roadAt(ri, sA);
  const p = ri.r.pts;
  const atStart = sA <= 1e-3;
  fn(a.x, a.y, atStart ? ri.mx[0] : a.nx, atStart ? ri.my[0] : a.ny, sA);
  for (let v = a.k + 1; v < ri.n; v++) {
    const cv = ri.cum[v];
    if (cv <= sA + 0.01) continue;
    if (cv >= sB - 0.01) break;
    fn(p[2 * v], p[2 * v + 1], ri.mx[v], ri.my[v], cv);
  }
  const b = roadAt(ri, sB);
  const atEnd = sB >= ri.len - 1e-3;
  fn(b.x, b.y, atEnd ? ri.mx[ri.n - 1] : b.nx, atEnd ? ri.my[ri.n - 1] : b.ny, sB);
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

const ROAD_FRAG = /* glsl */ `
uniform sampler2D uAsphalt;
uniform sampler2D uNoise;
varying vec3 vRoad;
varying vec3 vGPos;
${NOISE_GLSL}
vec3 roadAlbedo() {
  vec2 p = vec2(vGPos.x, -vGPos.z);
  float surf = floor(vRoad.y + 0.5);
  vec3 a = texture2D(uAsphalt, p / 7.3).rgb;
  vec3 b = texture2D(uAsphalt, p / 29.0 + 0.37).rgb;
  vec4 n = texture2D(uNoise, p / 70.0);
  vec4 n2 = texture2D(uNoise, p / 13.0);
  vec3 c = mix(a, b, 0.35);
  c *= mix(0.86, 1.14, n.g) * mix(0.95, 1.05, n2.b);
  // patch repairs
  c = mix(c, c * 0.72, smoothstep(0.66, 0.7, n.b) * 0.8);
  if (surf > 0.5 && surf < 1.5) c *= vec3(1.12, 1.06, 1.02);
  else if (surf > 1.5 && surf < 2.5) {
    vec2 q = p / vec2(0.6, 0.3);
    q.x += step(0.5, fract(q.y * 0.5)) * 0.5;
    vec2 f = abs(fract(q) - 0.5);
    float j = smoothstep(0.47, 0.5, max(f.x * 1.0, f.y * 1.0));
    c = mix(vec3(0.42, 0.40, 0.38), vec3(0.55, 0.52, 0.48), n2.r) * (1.0 - j * 0.3);
  } else if (surf > 3.5 && surf < 4.5) c *= 0.55;
  else if (surf > 5.5) c *= 0.82;
  return pow(c, vec3(2.2));
}
`;

function roadMaterial(ctx: Ctx): THREE.MeshLambertMaterial {
  return patch(new THREE.MeshLambertMaterial({ color: 0xffffff }), {
    key: 'road',
    uniforms: { uAsphalt: { value: ctx.tex.asphalt }, uNoise: { value: ctx.tex.noise } },
    vertexPars: 'attribute vec3 aRoad;\nvarying vec3 vRoad;\nvarying vec3 vGPos;',
    vertex: [
      ['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);'],
      ['#include <begin_vertex>', '#include <begin_vertex>\nvRoad = aRoad;\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'],
    ],
    fragmentPars: ROAD_FRAG,
    fragment: [['vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( roadAlbedo(), opacity );']],
  });
}

export function markMaterial(ctx: Ctx): THREE.MeshLambertMaterial {
  return patch(new THREE.MeshLambertMaterial({ color: 0xffffff }), {
    key: 'mark',
    uniforms: { uNoise: { value: ctx.tex.noise } },
    vertexPars: 'attribute vec2 aMark;\nvarying vec2 vMark;\nvarying vec3 vGPos;',
    vertex: [
      ['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);'],
      ['#include <begin_vertex>', '#include <begin_vertex>\nvMark = aMark;\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'],
    ],
    fragmentPars: 'uniform sampler2D uNoise;\nvarying vec2 vMark;\nvarying vec3 vGPos;',
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
  return patch(new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), {
    key: 'foot',
    uniforms: { uNoise: { value: ctx.tex.noise } },
    vertexPars: 'attribute vec3 aFoot;\nvarying vec3 vFoot;\nvarying vec3 vGPos;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvFoot = aFoot;\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;']],
    fragmentPars: FOOT_FRAG,
    fragment: [['vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( pow(footAlbedo(), vec3(2.2)), opacity );']],
  });
}

/** Vertex-coloured flat-shaded concrete/steel with a little noise. */
export function structMaterial(ctx: Ctx, key = 'struct'): THREE.MeshLambertMaterial {
  return patch(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), {
    key,
    uniforms: { uNoise: { value: ctx.tex.noise } },
    vertexPars: 'varying vec3 vGPos;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;']],
    fragmentPars: 'uniform sampler2D uNoise;\nvarying vec3 vGPos;',
    fragment: [['#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 0.88 + 0.22 * texture2D(uNoise, (vGPos.xz + vGPos.y) / 6.0).r;']],
  });
}

const TUNNEL_FRAG = /* glsl */ `
uniform float uInTunnel;
varying float vPortal;
`;

// ---------------------------------------------------------------------------

export interface RoadsResult {
  infos: RI[];
  index: RoadIndex;
  /** Tunnel-only index for the camera-in-tunnel test. */
  tunnels: RoadIndex;
}

interface Layer {
  asphalt: MeshGeo;
  foot: MeshGeo;
  mark: MeshGeo;
  struct: MeshGeo;
  words: MeshGeo;
  tunnel: MeshGeo;
}

const nodeKey = (x: number, y: number) => (Math.round(x * 10) + 80000) * 160000 + (Math.round(y * 10) + 80000);

export async function buildRoads(ctx: Ctx, noPierZones: Float32Array[], progress: (f: number) => void): Promise<RoadsResult> {
  const { data, R } = ctx;
  const roads = data.roads;
  const infos = roads.map((r, i) => prepRoad(r, i));
  const index = new RoadIndex(roads, data.bounds);
  const tunnels = new RoadIndex(roads, data.bounds, (r) => r.tunnel);
  const mask = ctx.mask;

  // Node degrees for junction detection.
  interface Node {
    deg: number;
    maxHW: number;
    tun: number;
    surf: number;
  }
  const nodes = new Map<number, Node>();
  const touch = (x: number, y: number, w: number, hw: number, tunnel: boolean) => {
    const k = nodeKey(x, y);
    let nd = nodes.get(k);
    if (!nd) {
      nd = { deg: 0, maxHW: 0, tun: 0, surf: 0 };
      nodes.set(k, nd);
    }
    nd.deg += w;
    if (hw > nd.maxHW) nd.maxHW = hw;
    if (tunnel) nd.tun++;
    else nd.surf++;
  };
  for (const ri of infos) {
    const p = ri.r.pts;
    for (let v = 0; v < ri.n; v++) touch(p[2 * v], p[2 * v + 1], v === 0 || v === ri.n - 1 ? 1 : 2, ri.hw, ri.r.tunnel);
  }

  const nx = Math.ceil((R[2] - R[0]) / ROAD_CHUNK);
  const layers = new Map<number, Layer>();
  const layerFor = (x: number, y: number): Layer => {
    const i = clamp(Math.floor((x - R[0]) / ROAD_CHUNK), 0, nx - 1);
    const j = clamp(Math.floor((y - R[1]) / ROAD_CHUNK), 0, 99);
    const key = j * nx + i;
    let l = layers.get(key);
    if (!l) {
      l = {
        asphalt: new MeshGeo([{ name: 'aRoad', size: 3, type: 'f32' }]),
        foot: new MeshGeo([{ name: 'aFoot', size: 3, type: 'f32' }]),
        mark: new MeshGeo([{ name: 'aMark', size: 2, type: 'f32' }]),
        struct: new MeshGeo([{ name: 'color', size: 3, type: 'u8', normalized: true }]),
        words: new MeshGeo([{ name: 'uv', size: 2, type: 'f32' }]),
        tunnel: new MeshGeo([
          { name: 'color', size: 3, type: 'u8', normalized: true },
          { name: 'aPortal', size: 1, type: 'f32' },
        ]),
      };
      layers.set(key, l);
    }
    return l;
  };

  const inWater = (x: number, y: number) => mask.has(x, y, MASK_WATER);
  const nearWater = (x: number, y: number) => mask.near(x, y, 3, MASK_WATER);

  for (let ri0 = 0; ri0 < infos.length; ri0++) {
    const ri = infos[ri0];
    const r = ri.r;
    if (ri.n < 2 || ri.len < 0.5) continue;
    const mid = roadAt(ri, ri.len / 2);
    const L = layerFor(mid.x, mid.y);
    const hw = ri.hw;
    const y = ri.y;
    if (r.tunnel) {
      buildTunnel(ri, L, nodes, nodeKey);
      continue;
    }
    const surf = r.kind === RoadKind.Pedestrian ? 2 : r.bus ? 1 : r.kind === RoadKind.Motorway ? 6 : r.kind === RoadKind.Service ? 5 : 0;

    // ---- asphalt ribbon
    {
      const g = L.asphalt;
      let prevL = -1;
      let prevR = -1;
      walkRun(ri, 0, ri.len, (x, yy, nx2, ny2, s) => {
        const l = g.vert(x + nx2 * hw, y, yy + ny2 * hw, hw, surf, s);
        const rr = g.vert(x - nx2 * hw, y, yy - ny2 * hw, -hw, surf, s);
        if (prevL >= 0) g.up(prevL, prevR, rr, l);
        prevL = l;
        prevR = rr;
      });
      // round end caps fill junction wedges and make cul-de-sac bulbs
      const p = r.pts;
      for (const end of [0, 1]) {
        const v = end === 0 ? 0 : ri.n - 1;
        const cx = p[2 * v];
        const cy = p[2 * v + 1];
        const tx = end === 0 ? -(p[2] - p[0]) : p[2 * v] - p[2 * v - 2];
        const ty = end === 0 ? -(p[3] - p[1]) : p[2 * v + 1] - p[2 * v - 1];
        const tl = Math.hypot(tx, ty) || 1;
        const ux = tx / tl;
        const uy = ty / tl;
        const c = g.vert(cx, y, cy, 0, surf, 0);
        const segs = 6;
        let prev = -1;
        for (let k = 0; k <= segs; k++) {
          const t = -Math.PI / 2 + (k / segs) * Math.PI;
          // rotate u by t: left normal is (-uy, ux)
          const dx = ux * Math.cos(t) - uy * Math.sin(t);
          const dy = ux * Math.sin(t) + uy * Math.cos(t);
          const vi = g.vert(cx + dx * hw, y, cy + dy * hw, 0, surf, 0);
          if (prev >= 0) g.tri(c, prev, vi, 0, 1, 0);
          prev = vi;
        }
      }
    }

    // ---- junction zones (no markings, no footpath continuation)
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
          // dead end or a T onto another road's segment
          const pen = index.penetration(p[2 * v], p[2 * v + 1], ri.i);
          if (pen > -0.5) skips.push([ri.cum[v] - hw - 9, ri.cum[v] + hw + 9]);
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
        const my = y + 0.0025;
        for (const [a, b] of runs) {
          for (const ln of lines) {
            let pl = -1;
            let pr = -1;
            walkRun(ri, a, b, (x, yy, nx2, ny2, s) => {
              const o0 = ln.off - ln.w / 2;
              const o1 = ln.off + ln.w / 2;
              const l = g.vert(x + nx2 * o1, my, yy + ny2 * o1, s, ln.pat);
              const rr = g.vert(x + nx2 * o0, my, yy + ny2 * o0, s, ln.pat);
              if (pl >= 0) g.up(pl, pr, rr, l);
              pl = l;
              pr = rr;
            });
          }
        }
      }
      // BUS ONLY words on busways
      if ((r.kind === RoadKind.Busway || r.bus) && !r.bridge && ri.len > 40) {
        const g = L.words;
        const lanesDir: { off: number; dir: number }[] = r.oneway ? [{ off: 0, dir: 1 }] : [
          { off: hw / 2, dir: 1 },
          { off: -hw / 2, dir: -1 },
        ];
        for (let s = 25; s < ri.len - 10; s += 140) {
          if (skips.some(([a, b]) => s > a - 6 && s < b + 6)) continue;
          for (const ld of lanesDir) {
            const c = roadAt(ri, s);
            const tx = c.ny * ld.dir;
            const ty = -c.nx * ld.dir;
            // travel direction t; left of travel = (-ty, tx)
            const lx = -ty;
            const ly = tx;
            const ccx = c.x + c.nx * ld.off;
            const ccy = c.y + c.ny * ld.off;
            const halfW = Math.min(1.5, (r.oneway ? hw : hw / 2) - 0.4);
            const halfL = 2.6;
            const wy = y + 0.004;
            // u runs from the driver's left to right, v from near to far
            const a0 = g.vert(ccx - tx * halfL + lx * halfW, wy, ccy - ty * halfL + ly * halfW, 0, 0);
            const a1 = g.vert(ccx - tx * halfL - lx * halfW, wy, ccy - ty * halfL - ly * halfW, 1, 0);
            const a2 = g.vert(ccx + tx * halfL - lx * halfW, wy, ccy + ty * halfL - ly * halfW, 1, 1);
            const a3 = g.vert(ccx + tx * halfL + lx * halfW, wy, ccy + ty * halfL + ly * halfW, 0, 1);
            g.up(a0, a1, a2, a3);
          }
        }
      }
    }

    // ---- kerbs and footpaths
    const footKinds = r.kind >= RoadKind.Primary && r.kind <= RoadKind.Residential && !r.bridge && !r.link;
    const expressway = r.kind === RoadKind.Trunk && (r.oneway && r.lanes >= 3);
    if ((footKinds || (r.kind === RoadKind.Trunk && !r.bridge && !r.link)) && !expressway) {
      const W = 4.0;
      for (const side of [1, -1]) {
        const step = 4;
        const valid: boolean[] = [];
        const ss: number[] = [];
        for (let s = 0; s <= ri.len + 0.01; s += step) {
          const c = roadAt(ri, Math.min(s, ri.len));
          let ok = true;
          for (const off of [hw + 0.35, hw + W * 0.55, hw + W - 0.2]) {
            const qx = c.x + c.nx * side * off;
            const qy = c.y + c.ny * side * off;
            if (index.penetration(qx, qy, ri.i) > -0.25 || inWater(qx, qy)) {
              ok = false;
              break;
            }
          }
          valid.push(ok);
          ss.push(Math.min(s, ri.len));
        }
        // runs of valid samples
        let k = 0;
        while (k < valid.length) {
          if (!valid[k]) {
            k++;
            continue;
          }
          let e = k;
          while (e + 1 < valid.length && valid[e + 1]) e++;
          const a = Math.max(0, ss[k] - (k > 0 ? 1.5 : 0));
          const b = Math.min(ri.len, ss[e] + (e < valid.length - 1 ? 1.5 : 0));
          if (b - a > 3) {
            // footpath style from the local land use: CBD paving, mid concrete, suburban verge
            const c = roadAt(ri, (a + b) / 2);
            const dens = densityAt(ctx, c.x + c.nx * side * (hw + 6), c.y + c.ny * side * (hw + 6));
            const style = dens > 0.28 ? 1 : dens > 0.1 ? 2 : 0;
            const w = style === 1 ? 4.2 : style === 2 ? 3.2 : 3.9;
            footRun(L.foot, ri, a, b, side, w, style, y);
          }
          k = e + 1;
        }
      }
    }

    // ---- bridges: parapets, deck fascia, piers
    if (r.bridge) {
      const g = L.struct;
      const conc = [190, 186, 176];
      const steel = [70, 74, 78];
      for (const side of [1, -1]) {
        const step = 3;
        const valid: boolean[] = [];
        const ss: number[] = [];
        for (let s = 0; s <= ri.len + 0.01; s += step) {
          const c = roadAt(ri, Math.min(s, ri.len));
          const qx = c.x + c.nx * side * (hw + 0.2);
          const qy = c.y + c.ny * side * (hw + 0.2);
          valid.push(index.penetration(qx, qy, ri.i) < -0.15);
          ss.push(Math.min(s, ri.len));
        }
        let k = 0;
        while (k < valid.length) {
          if (!valid[k]) {
            k++;
            continue;
          }
          let e = k;
          while (e + 1 < valid.length && valid[e + 1]) e++;
          const a = ss[k];
          const b = ss[e];
          if (b - a > 2) {
            parapet(g, ri, a, b, side, hw + 0.05, hw + 0.4, y, y + 0.95, conc);
            if (r.kind !== RoadKind.Motorway) parapet(g, ri, a, b, side, hw + 0.15, hw + 0.25, y + 1.05, y + 1.15, steel);
          }
          k = e + 1;
        }
      }
      // fascia + soffit and piers where over water
      const step = 6;
      let runA = -1;
      for (let s = 0; s <= ri.len + step; s += step) {
        const sc = Math.min(s, ri.len);
        const c = roadAt(ri, sc);
        const over = s <= ri.len && nearWater(c.x, c.y);
        if (over && runA < 0) runA = sc;
        if ((!over || s > ri.len) && runA >= 0) {
          const b = Math.min(ri.len, sc);
          if (b - runA > 1) deckUnder(g, ri, Math.max(0, runA - step), Math.min(ri.len, b + step), y, conc);
          runA = -1;
        }
      }
      for (let s = 20; s < ri.len - 10; s += 42) {
        const c = roadAt(ri, s);
        if (!inWater(c.x, c.y)) continue;
        if (noPierZones.some((z) => pointInRing(c.x, c.y, z))) continue;
        const dx = c.ny;
        const dy = -c.nx;
        g.box(c.x, c.y, -7, -1.3, dx, dy, 1.0, hw * 0.75, ...conc);
        g.box(c.x, c.y, -1.9, -1.2, dx, dy, 1.4, hw + 0.2, ...conc.map((v) => v * 0.9));
      }
    }

    // ---- busway edge barriers
    if (r.kind === RoadKind.Busway && !r.bridge) {
      const g = L.struct;
      const col = [178, 176, 170];
      for (const side of [1, -1]) {
        const step = 3;
        const valid: boolean[] = [];
        const ss: number[] = [];
        for (let s = 0; s <= ri.len + 0.01; s += step) {
          const c = roadAt(ri, Math.min(s, ri.len));
          const qx = c.x + c.nx * side * (hw + 0.5);
          const qy = c.y + c.ny * side * (hw + 0.5);
          valid.push(index.penetration(qx, qy, ri.i) < -0.6 && !skips.some(([a, b]) => s > a && s < b));
          ss.push(Math.min(s, ri.len));
        }
        let k = 0;
        while (k < valid.length) {
          if (!valid[k]) {
            k++;
            continue;
          }
          let e = k;
          while (e + 1 < valid.length && valid[e + 1]) e++;
          if (ss[e] - ss[k] > 6) jersey(g, ri, ss[k], ss[e], side, hw + 0.25, y, col);
          k = e + 1;
        }
      }
    }

    if (ri0 % 1500 === 0) {
      progress(ri0 / infos.length);
      await yieldFrame();
    }
  }

  // ---- meshes
  const roadMat = roadMaterial(ctx);
  const markMat = markMaterial(ctx);
  const footMat = footMaterial(ctx);
  const structMat = structMaterial(ctx);
  const text = makeRoadTextTexture(['BUS ONLY']);
  const wordMat = patch(new THREE.MeshLambertMaterial({ map: text.tex, transparent: true, alphaTest: 0.35, color: 0xd8d8d8, depthWrite: false }), {
    key: 'words',
    vertex: [['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);']],
  });
  const tunnelMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), {
    key: 'tunnel',
    vertexPars: 'attribute float aPortal;\nvarying float vPortal;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvPortal = aPortal;']],
    fragmentPars: TUNNEL_FRAG,
    fragment: [
      // aPortal: 0 portal frame (always), 1 interior (only from inside), 2 dark mouth (only from outside)
      ['vec4 diffuseColor = vec4( diffuse, opacity );', 'if ((vPortal > 0.5 && vPortal < 1.5 && uInTunnel < 0.5) || (vPortal > 1.5 && uInTunnel > 0.5)) discard;\n\tvec4 diffuseColor = vec4( diffuse, opacity );'],
      ['vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive + (vColor.r > 0.95 ? vColor.rgb * 1.5 : vec3(0.0));'],
    ],
  });
  for (const [key, l] of layers) {
    const add = (geo: MeshGeo, mat: THREE.Material, name: string, opts: { cast?: boolean; order?: number } = {}) => {
      if (geo.empty) return;
      const g = geo.build();
      const m = new THREE.Mesh(g, mat);
      m.name = `${name}-${key}`;
      m.receiveShadow = true;
      m.castShadow = !!opts.cast;
      if (opts.order) m.renderOrder = opts.order;
      ctx.root.add(m);
      const c = g.boundingSphere!.center;
      ctx.cull.push({ obj: m, x: c.x, z: c.z, range: name === 'asphalt' ? 9000 : name === 'mark' ? 2600 : 4000 });
    };
    add(l.asphalt, roadMat, 'asphalt');
    add(l.mark, markMat, 'mark');
    add(l.words, wordMat, 'words', { order: 2 });
    add(l.foot, footMat, 'foot');
    add(l.struct, structMat, 'struct', { cast: true });
    add(l.tunnel, tunnelMat, 'tunnel');
  }
  return { infos, index, tunnels };

  // ---- helpers (hoisted)
  function footRun(g: MeshGeo, ri: RI, a: number, b: number, side: number, W: number, style: number, roadY: number): void {
    const hw = ri.hw;
    let p0 = -1;
    let p1 = -1;
    let p2 = -1;
    let p3 = -1;
    let p4 = -1;
    let p5 = -1;
    let first = true;
    let last: number[] = [];
    walkRun(ri, a, b, (x, yy, nx2, ny2, s) => {
      const ix = x + nx2 * side * hw;
      const iy = yy + ny2 * side * hw;
      const ox = x + nx2 * side * (hw + W);
      const oy = yy + ny2 * side * (hw + W);
      // kerb face bottom/top, top inner/outer, outer face top/bottom
      const kb = g.vert(ix, roadY, iy, 0, s, 3);
      const kt = g.vert(ix, KERB_H, iy, 0, s, 3);
      const ti = g.vert(ix, KERB_H, iy, 0, s, style);
      const to = g.vert(ox, KERB_H, oy, W, s, style);
      const ot = g.vert(ox, KERB_H, oy, W, s, 3);
      const ob = g.vert(ox, 0, oy, W, s, 3);
      if (!first) {
        // kerb face looks toward the road centre
        g.quad(p0, kb, kt, p1, -nx2 * side, 0, ny2 * side);
        g.up(p2, ti, to, p3);
        g.quad(p4, ot, ob, p5, nx2 * side, 0, -ny2 * side);
      }
      if (first) {
        // start cap
        const t0x = ny2;
        const t0y = -nx2;
        const c1 = g.vert(ix, KERB_H, iy, 0, s, 3);
        const c2 = g.vert(ox, KERB_H, oy, W, s, 3);
        const c3 = g.vert(ox, 0, oy, W, s, 3);
        const c4 = g.vert(ix, 0, iy, 0, s, 3);
        g.quad(c1, c2, c3, c4, -t0x, 0, t0y);
      }
      first = false;
      p0 = kb;
      p1 = kt;
      p2 = ti;
      p3 = to;
      p4 = ot;
      p5 = ob;
      last = [ix, iy, ox, oy, nx2, ny2, s];
    });
    if (last.length) {
      const [ix, iy, ox, oy, nx2, ny2, s] = last;
      const t0x = ny2;
      const t0y = -nx2;
      const c1 = g.vert(ix, KERB_H, iy, 0, s, 3);
      const c2 = g.vert(ox, KERB_H, oy, W, s, 3);
      const c3 = g.vert(ox, 0, oy, W, s, 3);
      const c4 = g.vert(ix, 0, iy, 0, s, 3);
      g.quad(c1, c2, c3, c4, t0x, 0, -t0y);
    }
  }

  function parapet(g: MeshGeo, ri: RI, a: number, b: number, side: number, o0: number, o1: number, h0: number, h1: number, col: number[]): void {
    let prev: number[] | null = null;
    walkRun(ri, a, b, (x, yy, nx2, ny2) => {
      const ix = x + nx2 * side * o0;
      const iy = yy + ny2 * side * o0;
      const ox = x + nx2 * side * o1;
      const oy = yy + ny2 * side * o1;
      const v = [g.vert(ix, h0, iy, ...col), g.vert(ix, h1, iy, ...col), g.vert(ox, h1, oy, ...col), g.vert(ox, h0, oy, ...col)];
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

  function jersey(g: MeshGeo, ri: RI, a: number, b: number, side: number, o: number, roadY: number, col: number[]): void {
    let prev: number[] | null = null;
    walkRun(ri, a, b, (x, yy, nx2, ny2) => {
      const P = (off: number, h: number) => g.vert(x + nx2 * side * off, h, yy + ny2 * side * off, ...col);
      const v = [P(o, roadY), P(o + 0.12, 0.3), P(o + 0.2, 0.82), P(o + 0.4, 0.82), P(o + 0.48, 0.3), P(o + 0.6, 0)];
      if (prev) {
        for (let k = 0; k < 5; k++) {
          const fx = k < 2 ? -nx2 * side : k === 2 ? 0 : nx2 * side;
          const fz = k < 2 ? ny2 * side : k === 2 ? 0 : -ny2 * side;
          g.quad(prev[k], v[k], v[k + 1], prev[k + 1], fx, k === 2 ? 1 : 0.3, fz);
        }
      }
      prev = v;
    });
  }

  function deckUnder(g: MeshGeo, ri: RI, a: number, b: number, roadY: number, col: number[]): void {
    const hw = ri.hw + 0.4;
    let prev: number[] | null = null;
    const under = col.map((v) => v * 0.7);
    walkRun(ri, a, b, (x, yy, nx2, ny2) => {
      const lx = x + nx2 * hw;
      const ly = yy + ny2 * hw;
      const rx = x - nx2 * hw;
      const ry = yy - ny2 * hw;
      const v = [g.vert(lx, roadY, ly, ...col), g.vert(lx, -1.3, ly, ...col), g.vert(rx, -1.3, ry, ...under), g.vert(rx, roadY, ry, ...col), g.vert(lx, -1.3, ly, ...under)];
      if (prev) {
        g.quad(prev[0], v[0], v[1], prev[1], nx2, 0, -ny2);
        g.quad(prev[3], v[3], v[2], prev[2], -nx2, 0, ny2);
        g.quad(prev[4], v[4], v[2], prev[2], 0, -1, 0);
      }
      prev = v;
    });
  }
}

/** Tunnel interior near the portals, plus portal frames. */
function buildTunnel(ri: RI, L: Layer, nodes: Map<number, { deg: number; tun: number; surf: number }>, key: (x: number, y: number) => number): void {
  const r = ri.r;
  const p = r.pts;
  const hw = ri.hw + 0.6;
  const g = L.tunnel;
  const portalAt: number[] = [];
  for (const end of [0, 1]) {
    const v = end === 0 ? 0 : ri.n - 1;
    const nd = nodes.get(key(p[2 * v], p[2 * v + 1]));
    if (nd && nd.surf > 0) portalAt.push(end === 0 ? 0 : ri.len);
  }
  const d = 1;
  const wall = [92, 92, 90];
  const ceil = [60, 60, 62];
  const road = [48, 48, 50];
  const lamp = [255, 236, 190];
  const H = 5.2;
  let prev: number[] | null = null;
  walkRun(ri, 0, ri.len, (x, yy, nx2, ny2) => {
    const lx = x + nx2 * hw;
    const ly = yy + ny2 * hw;
    const rx = x - nx2 * hw;
    const ry = yy - ny2 * hw;
    const v = [
      g.vert(lx, 0.03, ly, ...road, d),
      g.vert(rx, 0.03, ry, ...road, d),
      g.vert(lx, 0, ly, ...wall, d),
      g.vert(lx, H, ly, ...wall, d),
      g.vert(rx, 0, ry, ...wall, d),
      g.vert(rx, H, ry, ...wall, d),
      g.vert(lx, H, ly, ...ceil, d),
      g.vert(rx, H, ry, ...ceil, d),
    ];
    if (prev) {
      g.up(prev[0], prev[1], v[1], v[0]);
      g.quad(prev[2], v[2], v[3], prev[3], -nx2, 0, ny2);
      g.quad(prev[4], v[4], v[5], prev[5], nx2, 0, -ny2);
      g.quad(prev[6], v[6], v[7], prev[7], 0, -1, 0);
    }
    prev = v;
  });
  // ceiling lamps every 12 m
  for (let s = 4; s < ri.len; s += 12) {
    const c = roadAt(ri, s);
    for (const o of [-hw * 0.5, hw * 0.5]) {
      const cx = c.x + c.nx * o;
      const cy = c.y + c.ny * o;
      const tx = c.ny;
      const ty = -c.nx;
      const a = g.vert(cx - tx * 1.2 - c.nx * 0.15, H - 0.05, cy - ty * 1.2 - c.ny * 0.15, ...lamp, d);
      const b = g.vert(cx + tx * 1.2 - c.nx * 0.15, H - 0.05, cy + ty * 1.2 - c.ny * 0.15, ...lamp, d);
      const cc = g.vert(cx + tx * 1.2 + c.nx * 0.15, H - 0.05, cy + ty * 1.2 + c.ny * 0.15, ...lamp, d);
      const dd = g.vert(cx - tx * 1.2 + c.nx * 0.15, H - 0.05, cy - ty * 1.2 + c.ny * 0.15, ...lamp, d);
      g.quad(a, b, cc, dd, 0, -1, 0);
    }
  }
  // portal frames
  const frame = [168, 164, 156];
  for (const s of portalAt) {
    const c = roadAt(ri, s);
    const tx = c.ny;
    const ty = -c.nx;
    // dark mouth a little inside, facing out of the tunnel
    const inward = s === 0 ? 1 : -1;
    const mx = c.x + tx * inward * 1.5;
    const my = c.y + ty * inward * 1.5;
    const black = [6, 6, 7];
    const m0 = g.vert(mx + c.nx * hw, 0, my + c.ny * hw, ...black, 2);
    const m1 = g.vert(mx - c.nx * hw, 0, my - c.ny * hw, ...black, 2);
    const m2 = g.vert(mx - c.nx * hw, H, my - c.ny * hw, ...black, 2);
    const m3 = g.vert(mx + c.nx * hw, H, my + c.ny * hw, ...black, 2);
    g.quad(m0, m1, m2, m3, -tx * inward, 0, ty * inward);
    g.box(c.x, c.y, H, H + 1.6, tx, ty, 0.6, hw + 1.2, ...frame, 0);
    g.box(c.x + c.nx * (hw + 0.8), c.y + c.ny * (hw + 0.8), 0, H + 1.6, tx, ty, 0.6, 0.6, ...frame, 0);
    g.box(c.x - c.nx * (hw + 0.8), c.y - c.ny * (hw + 0.8), 0, H + 1.6, tx, ty, 0.6, 0.6, ...frame, 0);
  }
}
