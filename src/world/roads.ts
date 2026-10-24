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
import { greenBridgeSpan, storyOutline } from './landmarks';
import { makeRoadTextTexture, makeSignTextTexture } from './textures';
import { MASK_RAIL, MASK_WATER, clamp, pointInRing, yieldFrame } from './util';
import { onAnyPlatform } from '../data/stations';

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

/** Inside tunnels lighting comes from the tunnel's LED lines, not the sky. */
const TUNNEL_LIGHT = 'vec3(0.93, 0.9, 0.82) * 0.72';
/** Brighter threshold zone inside each portal; the tunnel flag carries 1 + distance to the portal / 100. */
const TUN_THRESHOLD = '(1.0 + 0.55 * (1.0 - smoothstep(6.0, 60.0, max(vTunnel - 1.0, 0.0) * 100.0)))';

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

const TUN_OUT = `float wTun = clamp(vTunnel, 0.0, 1.0);
w_inTube = wTun;
vec3 outgoingLight = mix(reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance, diffuseColor.rgb * ${TUNNEL_LIGHT} * ${TUN_THRESHOLD}, wTun);`;

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
    fragment: [
      [
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb *= 0.88 + 0.22 * texture2D(uNoise, (vGPos.xz + vGPos.y) / 6.0).r;
        // buff block walls: 0.6 x 0.3 m blocks in stretcher bond
        vec3 bd = abs(vColor.rgb - vec3(200.0, 180.0, 142.0) / 255.0);
        if (max(bd.r, max(bd.g, bd.b)) < 0.008) {
          vec3 fn = normalize(cross(dFdx(vGPos), dFdy(vGPos)));
          vec2 q = vec2((abs(fn.x) > abs(fn.z) ? vGPos.z : vGPos.x) / 0.6, vGPos.y / 0.3);
          q.x += 0.5 * mod(floor(q.y), 2.0);
          vec2 f = (0.5 - abs(fract(q) - 0.5)) * vec2(0.6, 0.3);
          float j = 1.0 - smoothstep(0.006, 0.016 + fwidth(vGPos.y) * 0.5, min(f.x, f.y));
          diffuseColor.rgb *= (1.0 - 0.3 * j) * (0.95 + 0.1 * texture2D(uNoise, floor(q) / 37.0).r);
        }`,
      ],
    ],
  });
}

const TUBE_FRAG = /* glsl */ `
uniform sampler2D uNoise;
varying vec3 vGPos;
varying vec4 vTube;
float t_line(float v, float period, float w) {
  float fw = max(fwidth(v), 1e-4);
  float d = abs(fract(v / period + 0.5) - 0.5) * period;
  return 1.0 - smoothstep(w * 0.5, w * 0.5 + fw * 1.2, d);
}
vec3 tubeAlbedo(vec3 base, float part) {
  float s = vTube.x;
  float h = vTube.y;
  float n1 = texture2D(uNoise, vec2(s, h) / 4.1).r;
  float n2 = texture2D(uNoise, vec2(s, h) / 0.83 + 0.37).g;
  vec3 c = base * (0.93 + 0.1 * n1);
  if (part < 0.5) {
    // painted wall panels with joints every 2.5 m, a dark dado and a white delineator line above it
    c *= 1.0 - 0.3 * t_line(s, 2.5, 0.03) * step(1.25, h);
    c *= 1.0 - 0.2 * t_line(h, 4.4, 0.03) * step(2.0, h);
    c = mix(c, vec3(0.27, 0.28, 0.29) * (0.88 + 0.18 * n2), step(h, 1.1));
    c = mix(c, vec3(0.95, 0.95, 0.9), step(1.12, h) * step(h, 1.24));
  } else if (part > 6.5 && part < 7.5) {
    // station hall: glazed terracotta tiles to 3 m, light render above
    float g = max(t_line(s, 0.3, 0.012), t_line(h, 0.15, 0.012));
    vec3 tile = base * (0.86 + 0.24 * texture2D(uNoise, floor(vec2(s / 0.3, h / 0.15)) / 41.0).r);
    tile = mix(tile, vec3(0.72, 0.69, 0.63), g);
    c = mix(vec3(0.86, 0.85, 0.82) * (0.94 + 0.08 * n1), tile, step(h, 3.0));
  } else if (part > 7.5) {
    // slatted ceiling: light slats across the hall with dark gaps
    c = mix(base, base * 0.3, t_line(s, 0.4, 0.12));
  } else if (part > 1.5 && part < 2.5) {
    c *= 0.9 + 0.14 * n2;
  }
  return c;
}
`;

/**
 * Tunnel interiors, lit by their own LED lines: vertex colour is the albedo,
 * aTube = (s along the road, height above it, part, distance to the portal).
 * Parts: 0 wall, 1 ceiling, 2 walkway and fittings, 3 light line, 4 sign
 * light, 5 red light, 6 metalwork, 7 tiled hall wall, 8 slatted hall ceiling.
 */
function tubeMaterial(ctx: Ctx): THREE.MeshLambertMaterial {
  return patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), {
    key: 'tube4',
    uniforms: { uNoise: { value: ctx.tex.noise } },
    vertexPars: 'attribute vec4 aTube;\nvarying vec4 vTube;\nvarying vec3 vGPos;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvTube = aTube;\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;']],
    fragmentPars: TUBE_FRAG,
    fragment: [
      ['#include <color_fragment>', '#include <color_fragment>\nfloat part = floor(vTube.z + 0.5);\ndiffuseColor.rgb = tubeAlbedo(diffuseColor.rgb, part);\nw_inTube = 1.0;'],
      [
        'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
        `float th = vTube.y;
        float lit = 0.86;
        if (part < 0.5 || (part > 6.5 && part < 7.5)) lit = mix(0.7, 1.1, smoothstep(0.3, 5.0, th));
        else if (part < 1.5 || part > 7.5) lit = 0.72;
        else if (part > 5.5 && part < 6.5) lit = 0.8;
        float thr = 1.0 + 0.55 * (1.0 - smoothstep(6.0, 60.0, vTube.w));
        float em = step(2.5, part) * step(part, 5.5);
        vec3 outgoingLight = mix(diffuseColor.rgb * ${TUNNEL_LIGHT} * lit * thr, vColor * (part < 3.5 ? 2.4 : 1.6), em);`,
      ],
    ],
  });
}

/** A tunnel road's tube, sampled every 4 m (see tubePrep in buildRoads). */
export interface Tube {
  ss: number[];
  P0: ReturnType<typeof roadAt>[];
  /** Enclosed (ground or a street over it) at each sample; a box spans segments with both ends enclosed. */
  cov: boolean[];
  /** Clear height inside at each sample. */
  hc: number[];
  /** Distance along the road to the nearest portal at each sample (999: none). */
  pd: number[];
  /** [sample, inward (+1: the tube lies toward larger s)]. */
  portals: [number, number][];
  /** Full clear height of this tube. */
  H: number;
}

/** Tunnel colours: walls, ceiling, walkways. Busways cream, roads light grey, the two underground stations their own. */
const TUBE_PAL = {
  road: { wall: [210, 210, 204], ceil: [62, 64, 68], walk: [150, 148, 142] },
  bus: { wall: [226, 216, 190], ceil: [78, 78, 80], walk: [162, 158, 148] },
  kgs: { wall: [176, 86, 56], ceil: [214, 214, 210], walk: [172, 168, 160] },
  qsbs: { wall: [200, 178, 142], ceil: [104, 94, 80], walk: [150, 140, 126] },
};
const KERB_TUBE = [196, 190, 120];

// ---------------------------------------------------------------------------

export interface RoadsResult {
  infos: RI[];
  index: RoadIndex;
  /** Tunnel-only index. */
  tunnels: RoadIndex;
  /** Tunnel mouths (map x, y and road height): where an underground camera can see out. */
  portals: { x: number; y: number; z: number }[];
  /** Every tunnel road's tube as built: road id, samples, and per side (+1, -1) which segments are open. */
  tubes: { road: number; tp: Tube; open: boolean[][] }[];
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
  plate: MeshGeo;
}

const nodeKey = (x: number, y: number) => (Math.round(x * 10) + 80000) * 160000 + (Math.round(y * 10) + 80000);

const CONC = [192, 188, 178];
const CONC_DARK = [205, 200, 190];
const WALL = [176, 170, 158];
/** Station cutting walls (Mater Hill, Buranda): buff block (joints drawn by structMaterial) on a dark base. */
const BUFF = [200, 180, 142];
const BASE_DARK = [74, 74, 72];
const STEEL = [74, 78, 82];

/**
 * Where the ray from (x, y) along the unit direction (dx, dy) runs inside the polygon `ring` (flat
 * x, y pairs), up to maxT: [enter, leave] runs, nearest first. Each stretch between two edge crossings
 * is tested at its middle, so a ray through a vertex or along an edge cannot flip inside and outside.
 */
function rayRuns(ring: ArrayLike<number>, x: number, y: number, dx: number, dy: number, maxT: number): [number, number][] {
  const n = ring.length / 2;
  const ts: number[] = [0];
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = ring[2 * j];
    const ay = ring[2 * j + 1];
    const ex = ring[2 * i] - ax;
    const ey = ring[2 * i + 1] - ay;
    const den = ex * dy - dx * ey;
    if (Math.abs(den) < 1e-9) continue;
    const wx = ax - x;
    const wy = ay - y;
    const t = (ex * wy - wx * ey) / den;
    const u = (dx * wy - dy * wx) / den;
    if (u >= -1e-6 && u <= 1 + 1e-6 && t > 0 && t < maxT) ts.push(t);
  }
  ts.push(maxT);
  ts.sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (let q = 0; q + 1 < ts.length; q++) {
    if (ts[q + 1] - ts[q] < 1e-4) continue;
    const m = (ts[q] + ts[q + 1]) / 2;
    if (!pointInRing(x + dx * m, y + dy * m, ring)) continue;
    const last = runs[runs.length - 1];
    if (last && ts[q] - last[1] < 1e-3) last[1] = ts[q + 1];
    else runs.push([ts[q], ts[q + 1]]);
  }
  return runs;
}

export async function buildRoads(ctx: Ctx, field: TerrainField, stripMat: THREE.Material, progress: (f: number) => void): Promise<RoadsResult> {
  const { data, R } = ctx;
  const roads = data.roads;
  const infos = roads.map((r, i) => prepRoad(r, i));
  const index = new RoadIndex(roads, data.bounds);
  const tunnels = new RoadIndex(roads, data.bounds, (r) => r.tunnel);
  const mask = ctx.mask;
  const underPlatforms = data.platforms.filter((p) => p.underground || p.layer < 0);
  // each underground platform's level: the bus tunnel beside it, where src/game/platforms.ts takes the
  // slab's height from (NaN when there is none)
  const underZ = underPlatforms.map((pf) => {
    let best: { dist: number; z: number } | null = null;
    for (let i = 0; i + 1 < pf.pts.length; i += 2) {
      const n = tunnels.nearest(pf.pts[i], pf.pts[i + 1], 25, (q) => roads[q].bus || roads[q].kind === RoadKind.Busway);
      if (n && (!best || n.dist < best.dist)) best = n;
    }
    return best ? best.z : NaN;
  });
  // platforms in the open (at grade or in a cutting), with their bounding boxes, for the earthworks beside them
  const gradePlatforms = data.platforms
    .filter((p) => !(p.underground || p.layer < 0) && p.pts.length >= 4)
    .map((p) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0; i + 1 < p.pts.length; i += 2) {
        x0 = Math.min(x0, p.pts[i]);
        x1 = Math.max(x1, p.pts[i]);
        y0 = Math.min(y0, p.pts[i + 1]);
        y1 = Math.max(y1, p.pts[i + 1]);
      }
      return { p, x0, y0, x1, y1 };
    });
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

  // Road ends per node (direction pointing away from the node, into the road), so a road that simply
  // continues as another way can share one mitred side line with it: no wedge of ground left between
  // the two roads' cuttings or shoulders on the outside of the bend.
  const roadEnds = new Map<number, { i: number; dx: number; dy: number; z: number }[]>();
  for (const ri of infos) {
    if (ri.n < 2) continue;
    const p = ri.r.pts;
    for (const atEnd of [0, 1]) {
      const v = atEnd ? ri.n - 1 : 0;
      const u = atEnd ? ri.n - 2 : 1;
      const dx = p[2 * u] - p[2 * v];
      const dy = p[2 * u + 1] - p[2 * v + 1];
      const l = Math.hypot(dx, dy);
      if (l < 1e-6) continue;
      const k = nodeKey(p[2 * v], p[2 * v + 1]);
      let l2 = roadEnds.get(k);
      if (!l2) roadEnds.set(k, (l2 = []));
      l2.push({ i: ri.i, dx: dx / l, dy: dy / l, z: ri.z[v] });
    }
  }
  /** At a plain two-way join (one road continuing as another), the mitred side normal at this road's start/end. */
  const endMiter = (ri: RI, atEnd: boolean): [number, number] | null => {
    const p = ri.r.pts;
    const v = atEnd ? ri.n - 1 : 0;
    const k = nodeKey(p[2 * v], p[2 * v + 1]);
    if (nodes.get(k)?.deg !== 2) return null;
    const l = roadEnds.get(k);
    if (!l || l.length !== 2) return null;
    const self = l.find((e) => e.i === ri.i && (l[0].i !== l[1].i || (atEnd ? e === l[1] : e === l[0])));
    const other = self && l.find((e) => e !== self);
    if (!self || !other || Math.abs(self.z - other.z) > 0.5) return null;
    // forward tangent through the node, in this road's direction
    const tx = atEnd ? other.dx - self.dx : self.dx - other.dx;
    const ty = atEnd ? other.dy - self.dy : self.dy - other.dy;
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-6) return null;
    const mnx = -ty / tl;
    const mny = tx / tl;
    // this road's own normal at the end
    const fx = atEnd ? -self.dx : self.dx;
    const fy = atEnd ? -self.dy : self.dy;
    const cos = mnx * -fy + mny * fx;
    if (cos < 0.6) return null; // a sharp bend: leave it
    return [mnx / cos, mny / cos];
  };

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
        words: new MeshGeo([
          { name: 'uv', size: 2, type: 'f32' },
          { name: 'aTun', size: 1, type: 'f32' },
        ]),
        strip: new MeshGeo([]),
        tube: new MeshGeo([...col, { name: 'aTube', size: 4, type: 'f32' }]),
        track: new MeshGeo([{ name: 'uv', size: 2, type: 'f32' }]),
        plate: new MeshGeo([{ name: 'uv', size: 2, type: 'f32' }]),
      };
      layers.set(key, l);
    }
    return l;
  };

  const inWater = (x: number, y: number) => mask.has(x, y, MASK_WATER);
  // the Story Bridge truss carries its own piers (landmarks.ts)
  const story = storyOutline(ctx);
  // ... and the Green Bridge's cable-stayed span its own pylons
  const green = greenBridgeSpan(ctx);
  const otherAt = (x: number, y: number, z: number, self: number, dz = 2.5) => index.penetrationZ(x, y, z, dz, self);
  // Mater Hill and Buranda busway stations stand between buff block cutting walls on a dark base
  const blockSites: [number, number][] = [];
  for (const pf of ctx.data.platforms) if (/Mater Hill|Buranda/i.test(pf.name) && pf.pts.length >= 2) blockSites.push([pf.pts[0], pf.pts[1]]);
  const blockWall = (x: number, y: number) => blockSites.some(([px, py]) => Math.hypot(px - x, py - y) < 170);
  /** Ground height for strips and wall tops that meet the terrain: the settled ground, never below the natural one. */
  const groundAt = (x: number, y: number) => Math.max(field.natAt(x, y), field.settledAt(x, y));
  /**
   * For a tube's open side: a street (not a tunnel) level with the tube road (at most 0.5 m above it,
   * 3 m below) that is itself under ground; a street above, or one in an open cutting, gets a wall.
   * Keep in step with tubeNb in src/sim/collider.ts.
   */
  const levelNb = (x: number, y: number, z: number, self: number, H: number) => {
    const v = index.penetrationZ(x, y, z - 1.25, 1.75, self);
    if (v === -Infinity || field.natAt(x, y) - (z + H) <= -1.8) return -Infinity;
    return v;
  };
  /** At-grade road and footpath surfaces (4 corners x, y, z along the road, then the surface's lift): see clearSurfaces(). */
  const surfQuads: number[] = [];
  /** Boxes built so far, for roofBoxes() once every road has clamped the ground. */
  const tubesBuilt: { ri: RI; tp: Tube; L: Layer; reach: number[][]; open: boolean[][]; boxSeg: (k: number) => boolean }[] = [];
  // tunnel names for the portal lintels: one atlas row each
  const plateNames: string[] = [];
  const plateIdx = new Map<string, number>();
  for (const r of roads) {
    if (!r.tunnel || !r.name || plateIdx.has(r.name) || !/Busway|Tunnel|Bypass|Link|Legacy Way/.test(r.name)) continue;
    plateIdx.set(r.name, plateNames.length);
    plateNames.push(r.name === 'Clem Jones Tunnel' ? 'CLEM7' : r.name.toUpperCase());
  }
  const plateRow = (name: string) => plateIdx.get(name) ?? -1;
  const plateText = makeSignTextTexture(plateNames);
  /** Name plate on a portal lintel: dark panel with white lettering, facing out of the tunnel (-tx, -ty). */
  const namePlate = (L: Layer, x: number, y: number, tx: number, ty: number, zc: number, hgt: number, maxW: number, row: number) => {
    const aspect = (plateText.widths[row] * 1024) / 64;
    let hh = hgt;
    let w = hh * aspect;
    if (w > maxW - 0.4) {
      w = maxW - 0.4;
      hh = w / aspect;
    }
    const nx = -ty;
    const ny = tx;
    L.struct.boxF(x + tx * 0.03, y + ty * 0.03, zc - hgt / 2, zc + hgt / 2, tx, ty, 0.03, w / 2 + 0.2, 34, 44, 56);
    const u0 = 0.5 - plateText.widths[row] / 2;
    const u1 = 0.5 + plateText.widths[row] / 2;
    const v0 = 1 - (row + 1) / plateText.rows;
    const v1 = 1 - row / plateText.rows;
    const g = L.plate;
    // seen from outside (looking along +t), the plate's left is +n
    const a = g.vert(x + nx * (w / 2), zc - hh / 2, y + ny * (w / 2), u0, v0);
    const b = g.vert(x - nx * (w / 2), zc - hh / 2, y - ny * (w / 2), u1, v0);
    const c = g.vert(x - nx * (w / 2), zc + hh / 2, y - ny * (w / 2), u1, v1);
    const d = g.vert(x + nx * (w / 2), zc + hh / 2, y + ny * (w / 2), u0, v1);
    g.quad(a, b, c, d, -tx, 0, ty);
  };

  // Tunnel boxes first: every road's ground strips and earth faces must know where the boxes are.
  const tubePreps = new Map<number, Tube>();
  for (const ri of infos) {
    if (!ri.r.tunnel || ri.n < 2 || ri.len < 0.5) continue;
    const tp = tubePrep(ri);
    tubePreps.set(ri.i, tp);
    const wallOff = ri.hw + 0.9;
    const { ss, P0, cov, hc } = tp;
    for (let k = 0; k + 1 < ss.length; k++) {
      if (!cov[k] || !cov[k + 1]) continue;
      const A = P0[k];
      const B = P0[k + 1];
      const o = wallOff + 0.6;
      const q = [A.x + A.nx * o, A.y + A.ny * o, A.z + hc[k] + 0.15, B.x + B.nx * o, B.y + B.ny * o, B.z + hc[k + 1] + 0.15, B.x - B.nx * o, B.y - B.ny * o, B.z + hc[k + 1] + 0.15, A.x - A.nx * o, A.y - A.ny * o, A.z + hc[k] + 0.15];
      // keep the ground (and terrain skirts) above the roof; earth faces and ground strips stop at it
      field.protectQuad(q, 10);
      field.addRoof(q, Math.max(A.z + hc[k], B.z + hc[k + 1]) + 0.15);
    }
  }
  /** A ground strip's height at (x, y): never below the roof of a tunnel box there. */
  const stripZ = (x: number, y: number, z: number) => Math.max(z, field.roofAt(x, y) + 0.05);

  for (let ri0 = 0; ri0 < infos.length; ri0++) {
    const ri = infos[ri0];
    const r = ri.r;
    if (ri.n < 2 || ri.len < 0.5) continue;
    const mid = roadAt(ri, ri.len / 2);
    const L = layerFor(mid.x, mid.y);
    const hw = ri.hw;
    const lift = ri.lift;
    const tp = tubePreps.get(ri.i) ?? null;
    const surf = r.kind === RoadKind.Pedestrian ? 2 : r.bus ? 1 : r.kind === RoadKind.Motorway ? 6 : r.kind === RoadKind.Service ? 5 : 0;

    // ---- asphalt ribbon (and terrain clamp under at-grade roads)
    {
      const g = L.asphalt;
      let prevL = -1;
      let prevR = -1;
      let pq: number[] | null = null;
      for (const [ra, rb, inBox] of tubeRuns(tp, 0, ri.len)) walkRun(ri, ra, rb, (x, yy, z, nx2, ny2, s) => {
        const h = z + lift;
        const lx = x + nx2 * hw;
        const ly = yy + ny2 * hw;
        const rx = x - nx2 * hw;
        const ry = yy - ny2 * hw;
        const tt = tp ? tubeFlag(tp, s, inBox) : 0;
        const l = g.vert(lx, h, ly, hw, surf, s, tt);
        const rr = g.vert(rx, h, ry, -hw, surf, s, tt);
        if (prevL >= 0) g.up(prevL, prevR, rr, l);
        prevL = l;
        prevR = rr;
        const q = [lx, ly, z, rx, ry, z];
        if (pq && !r.tunnel) field.clampQuad([pq[0], pq[1], pq[2], pq[3], pq[4], pq[5], q[3], q[4], q[5], q[0], q[1], q[2]], r.bridge ? 1.6 : 0.3);
        if (pq && !r.tunnel && !r.bridge) surfQuads.push(pq[0], pq[1], pq[2], q[0], q[1], q[2], q[3], q[4], q[5], pq[3], pq[4], pq[5], lift);
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
        const ct = tp ? tubeFlag(tp, end === 0 ? 0 : ri.len, tubeRuns(tp, end === 0 ? 0 : ri.len - 0.01, end === 0 ? 0.01 : ri.len)[0][2]) : 0;
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
            for (const [ra, rb, inBox] of tubeRuns(tp, a, b)) walkRun(ri, ra, rb, (x, yy, z, nx2, ny2, s) => {
              const o0 = ln.off - ln.w / 2;
              const o1 = ln.off + ln.w / 2;
              const h = z + lift + 0.004;
              const tt = tp ? tubeFlag(tp, s, inBox) : 0;
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
            // in tunnel light inside a tube, like the road under it
            const wt = tp ? tubeFlag(tp, s, inBoxAt(tp, s)) : 0;
            const a0 = g.vert(ccx - tx * halfL + lx * halfW, z0, ccy - ty * halfL + ly * halfW, 0, 0, wt);
            const a1 = g.vert(ccx - tx * halfL - lx * halfW, z0, ccy - ty * halfL - ly * halfW, 1, 0, wt);
            const a2 = g.vert(ccx + tx * halfL - lx * halfW, z1, ccy + ty * halfL - ly * halfW, 1, 1, wt);
            const a3 = g.vert(ccx + tx * halfL + lx * halfW, z1, ccy + ty * halfL + ly * halfW, 0, 1, wt);
            g.up(a0, a1, a2, a3);
          }
        }
      }
    }

    if (tp) {
      buildTube(ri, L, tp);
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

  // ---- tunnel boxes whose ground was held below the roof get their own roof
  roofBoxes();
  // ---- the ground never pokes up through a road or footpath
  clearSurfaces();

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
    key: 'words4',
    depthBias: 0.002,
    vertexPars: 'attribute float aTun;\nvarying float vTunnel;',
    vertex: [
      ['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);'],
      ['#include <begin_vertex>', '#include <begin_vertex>\nvTunnel = aTun;'],
    ],
    fragmentPars: 'varying float vTunnel;',
    fragment: [['vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;', TUN_OUT]],
  });
  const plateMat = patch(new THREE.MeshLambertMaterial({ map: plateText.tex, transparent: true, alphaTest: 0.3, depthWrite: false }), {
    key: 'plate1',
    depthBias: 0.002,
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
    add(l.plate, plateMat, 'plate', { order: 2, range: 900 });
  }
  return { infos, index, tunnels, portals, tubes: tubesBuilt.map((b) => ({ road: b.ri.i, tp: b.tp, open: b.open })) };

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
   * Far side of a station platform beside a busway, along the ray from (x, y) in the unit direction
   * (dx, dy), for a platform whose kerb lies within 10 m of the carriageway edge `hw`: where the ray
   * leaves an outline platform, or 3.5 m behind a platform mapped as its edge line (the body
   * src/game/platforms.ts gives it). -1 if there is none.
   */
  function platformFar(x: number, y: number, dx: number, dy: number, hw: number): number {
    let best = -1;
    const R = hw + 16;
    const ts: number[] = [];
    for (const g of gradePlatforms) {
      if (x < g.x0 - R || x > g.x1 + R || y < g.y0 - R || y > g.y1 + R) continue;
      const p = g.p.pts;
      const n = p.length / 2;
      if (g.p.area) {
        const run = rayRuns(p, x, y, dx, dy, R).find(([a, b]) => b > hw - 0.5 && a < hw + 10);
        // (a ray running along a platform at an angle does not say how deep it is)
        if (run && run[1] - Math.max(run[0], hw) < 15) best = Math.max(best, run[1]);
        continue;
      }
      ts.length = 0;
      for (let e = 0; e + 1 < n; e++) {
        const ax = p[2 * e];
        const ay = p[2 * e + 1];
        const ex = p[2 * e + 2] - ax;
        const ey = p[2 * e + 3] - ay;
        const den = ex * dy - dx * ey;
        if (Math.abs(den) < 1e-9) continue;
        const wx = ax - x;
        const wy = ay - y;
        const tt = (ex * wy - wx * ey) / den;
        const u = (dx * wy - dy * wx) / den;
        if (u >= 0 && u <= 1 && tt > 0 && tt < R) ts.push(tt);
      }
      ts.sort((a, b) => a - b);
      const t0 = ts.find((v) => v > hw - 0.5 && v < hw + 10);
      if (t0 !== undefined) best = Math.max(best, t0 + 3.5);
    }
    return best;
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
    const m0 = endMiter(ri, false);
    const m1 = endMiter(ri, true);
    if (m0 && ss[0] === 0) P[0] = { ...P[0], nx: m0[0], ny: m0[1] };
    if (m1 && ss[n - 1] === ri.len) P[n - 1] = { ...P[n - 1], nx: m1[0], ny: m1[1] };
    // A station platform beside a busway: the batter or cutting wall stands behind it, with the stopping
    // bay and the platform's footprint level with the road in front (from one sample before each
    // platform end on, so a cutting wall never cuts across the platform's corner).
    let pfar: Float32Array | null = null;
    if (r.kind === RoadKind.Busway && gradePlatforms.length) {
      let rx0 = Infinity;
      let ry0 = Infinity;
      let rx1 = -Infinity;
      let ry1 = -Infinity;
      for (let i = 0; i + 1 < r.pts.length; i += 2) {
        rx0 = Math.min(rx0, r.pts[i]);
        rx1 = Math.max(rx1, r.pts[i]);
        ry0 = Math.min(ry0, r.pts[i + 1]);
        ry1 = Math.max(ry1, r.pts[i + 1]);
      }
      const R = hw + 16;
      if (gradePlatforms.some((g) => g.x0 < rx1 + R && g.x1 > rx0 - R && g.y0 < ry1 + R && g.y1 > ry0 - R)) {
        const at0 = ss.map((s) => {
          const c = roadAt(ri, s);
          return platformFar(c.x, c.y, c.nx * side, c.ny * side, hw);
        });
        if (at0.some((v) => v > 0)) {
          pfar = new Float32Array(n).fill(-1);
          for (let k = 0; k < n; k++) {
            const sa = ss[Math.max(0, k - 1)];
            const sb = ss[Math.min(n - 1, k + 1)];
            if (Math.max(at0[Math.max(0, k - 1)], at0[k], at0[Math.min(n - 1, k + 1)]) <= 0 && sb - sa < 12) continue;
            const steps = Math.max(1, Math.ceil((sb - sa) / 0.5));
            for (let q = 0; q <= steps; q++) {
              const c = roadAt(ri, sa + ((sb - sa) * q) / steps);
              pfar[k] = Math.max(pfar[k], platformFar(c.x, c.y, c.nx * side, c.ny * side, hw));
            }
          }
        }
      }
    }
    // depth of the natural ground beside the road, and the profile per sample with hysteresis (a walled
    // cutting starts deeper than 1.6 m and runs on while deeper than 0.9 m; a fill wall likewise), short
    // runs merged into their neighbours, so walls never break up into a row of short pieces
    const depth = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const c = P[k];
      const fw = foot[k];
      e0[k] = hw + (fw > 0 ? fw : 0.15);
      zE[k] = c.z + (fw > 0 ? KERB_H : 0);
      if (pfar && pfar[k] > 0) {
        e0[k] = Math.max(e0[k], pfar[k] + 0.3);
        zE[k] = c.z;
      }
      depth[k] = field.natAt(c.x + c.nx * side * (e0[k] + 2.5), c.y + c.ny * side * (e0[k] + 2.5)) - zE[k];
    }
    const raw = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const d = depth[k];
      const prev = k > 0 ? raw[k - 1] : 1;
      raw[k] = d > 1.6 || (prev === 2 && d > 0.9) ? 2 : d < -2.6 || (prev === 3 && d < -1.6) ? 3 : 1;
    }
    for (let k = n - 2; k >= 0; k--) {
      // and backwards, so a run also starts early
      if (raw[k] === 1 && raw[k + 1] === 2 && depth[k] > 0.9) raw[k] = 2;
      if (raw[k] === 1 && raw[k + 1] === 3 && depth[k] < -1.6) raw[k] = 3;
    }
    {
      let a = 0;
      while (a < n) {
        let b = a;
        while (b + 1 < n && raw[b + 1] === raw[a]) b++;
        const len = b - a + 1;
        const before = a > 0 ? raw[a - 1] : 0;
        const after = b + 1 < n ? raw[b + 1] : 0;
        let deep = 0;
        for (let q = a; q <= b; q++) deep = Math.max(deep, Math.abs(depth[q]));
        // a short gap between two walled stretches of the same kind joins them
        if (raw[a] === 1 && len <= 2 && before > 1 && before === after) raw.fill(before, a, b + 1);
        // a short wall piece that is not deep becomes part of the batter
        else if (raw[a] !== 1 && len <= 2 && deep < 2.5 && before !== raw[a] && after !== raw[a]) raw.fill(1, a, b + 1);
        a = b + 1;
      }
    }
    for (let k = 0; k < n; k++) {
      const c = P[k];
      const ox = (off: number) => c.x + c.nx * side * off;
      const oy = (off: number) => c.y + c.ny * side * off;
      const t = raw[k];
      // in a junction, or another carriageway right beside us: leave it to the neighbour
      const inJ = skips.some(([a, b]) => ss[k] > a && ss[k] < b);
      const probe = t === 2 ? e0[k] + 0.3 : e0[k] + 1.5;
      const nb = otherAt(ox(probe), oy(probe), c.z, ri.i, 3) > -0.4 || (t === 1 && otherAt(ox(e0[k] + 5), oy(e0[k] + 5), c.z, ri.i, 3) > -0.4);
      // a batter would run down into the space of a road passing 2-8 m below (a street over a busway
      // portal): none there, the lower road's own earthworks and tunnel hold the ground (a batter
      // climbing to the ground above stays, as over the tunnels under King George Square)
      const lower = (o: number) => Math.max(index.penetrationZ(ox(o), oy(o), zE[k] - 5, 3, ri.i), tunnels.penetrationZ(ox(o), oy(o), zE[k] - 5, 3, ri.i)) > -1;
      const below = t === 1 && depth[k] < 0.3 && (lower(e0[k] + 1.5) || lower(e0[k] + 4));
      if (nb || below || (inJ && t !== 2)) type[k] = 0;
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
      const fl = Math.hypot(A.nx, A.ny) || 1; // (a mitred end normal is longer than 1)
      const fx = (side * A.nx) / fl;
      const fy = (side * A.ny) / fl;
      if (pfar && (t === 1 || t === 3) && (pfar[k] > 0 || pfar[kb] > 0)) {
        // the stopping bay and the platform's footprint: a floor level with the road out to the batter or
        // wall (a cutting's floor does this in cutSeg)
        const [h0x, h0y] = at(A, hw);
        const [h1x, h1y] = at(B, hw);
        const [q0x, q0y] = at(A, e0[k]);
        const [q1x, q1y] = at(B, e0[kb]);
        const b0 = L.foot.vert(h0x, A.z - 0.02, h0y, 0.5, ss[k], 4);
        const b1 = L.foot.vert(h1x, B.z - 0.02, h1y, 0.5, ss[kb], 4);
        const b2 = L.foot.vert(q1x, B.z - 0.02, q1y, 0.5, ss[kb], 4);
        const b3 = L.foot.vert(q0x, A.z - 0.02, q0y, 0.5, ss[k], 4);
        L.foot.quad(b0, b1, b2, b3, 0, 1, 0);
        field.clampQuad([h0x, h0y, A.z, h1x, h1y, B.z, q1x, q1y, B.z, q0x, q0y, A.z], 0.25);
      }
      if (t === 1) {
        // graded shoulder to the natural ground
        const wa = shoulderW(k);
        const wb = shoulderW(kb);
        const [a0x, a0y] = at(A, e0[k]);
        const [b0x, b0y] = at(B, e0[kb]);
        const [a1x, a1y] = at(A, e0[k] + wa);
        const [b1x, b1y] = at(B, e0[kb] + wb);
        const a1z = stripZ(a1x, a1y, field.natAt(a1x, a1y));
        const b1z = stripZ(b1x, b1y, field.natAt(b1x, b1y));
        const i0 = g.vert(a0x, zE[k], a0y);
        const i1 = g.vert(b0x, zE[kb], b0y);
        const i2 = g.vert(b1x, b1z, b1y);
        const i3 = g.vert(a1x, a1z, a1y);
        g.quad(i0, i1, i2, i3, 0, 1, 0);
        // small skirt so the strip edge never shows a gap
        const s2 = g.vert(b1x, stripZ(b1x, b1y, b1z - 0.4), b1y);
        const s3 = g.vert(a1x, stripZ(a1x, a1y, a1z - 0.4), a1y);
        g.quad(i3, i2, s2, s3, fx, 0, -fy);
        field.clampQuad([a0x, a0y, zE[k], b0x, b0y, zE[kb], b1x, b1y, b1z, a1x, a1y, a1z], 0.25);
        k = kb - 1;
      } else if (t === 2 || t === 4) {
        const ends = t === 2 ? (k === 0 || type[k - 1] !== 2 ? 1 : 0) | (k + 2 >= n || type[k + 1] !== 2 ? 2 : 0) : 0;
        cutSeg(L, A, B, side, ss[k], ss[k + 1], foot[k], foot[k + 1], e0[k], e0[k + 1], hw, t === 2, ends);
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
    ends = 0,
  ): void {
    const g = L.strip;
    const st = L.struct;
    const at = (c: typeof A, off: number) => [c.x + c.nx * side * off, c.y + c.ny * side * off] as const;
    const fl = Math.hypot(A.nx, A.ny) || 1; // (a mitred end normal is longer than 1)
    const fx = (side * A.nx) / fl;
    const fy = (side * A.ny) / fl;
    const cutA = wall ? eA + 0.6 : eA + 3.5;
    const cutB = wall ? eB + 0.6 : eB + 3.5;
    const [c0x, c0y] = at(A, 0);
    const [c1x, c1y] = at(B, 0);
    const [w0x, w0y] = at(A, cutA);
    const [w1x, w1y] = at(B, cutB);
    // exact carve: the ground outside the quad stays, with an earth face down to the road at its edge
    field.holeQuad([c0x, c0y, A.z, c1x, c1y, B.z, w1x, w1y, B.z, w0x, w0y, A.z], 0.3, false, 0);
    const [f0x, f0y] = at(A, footA > 0 ? eA : hw);
    const [f1x, f1y] = at(B, footB > 0 ? eB : hw);
    const z0 = A.z + (footA > 0 ? KERB_H : -0.02);
    const z1 = B.z + (footB > 0 ? KERB_H : -0.02);
    // an open cut's floor runs on under the earth face at the carve edge
    const [g0x, g0y] = wall ? [w0x, w0y] : at(A, cutA + 0.5);
    const [g1x, g1y] = wall ? [w1x, w1y] : at(B, cutB + 0.5);
    const j0 = L.foot.vert(f0x, z0, f0y, 0.5, sA, 4);
    const j1 = L.foot.vert(f1x, z1, f1y, 0.5, sB, 4);
    const j2 = L.foot.vert(g1x, z1, g1y, 0.5, sB, 4);
    const j3 = L.foot.vert(g0x, z0, g0y, 0.5, sA, 4);
    L.foot.quad(j0, j1, j2, j3, 0, 1, 0);
    if (footA > 0 || footB > 0) {
      // footpath runs start and end between samples: a floor at road level from the kerb covers the rest
      const [h0x, h0y] = at(A, hw);
      const [h1x, h1y] = at(B, hw);
      const b0 = L.foot.vert(h0x, A.z - 0.03, h0y, 0.5, sA, 4);
      const b1 = L.foot.vert(h1x, B.z - 0.03, h1y, 0.5, sB, 4);
      const b2 = L.foot.vert(g1x, B.z - 0.03, g1y, 0.5, sB, 4);
      const b3 = L.foot.vert(g0x, A.z - 0.03, g0y, 0.5, sA, 4);
      L.foot.quad(b0, b1, b2, b3, 0, 1, 0);
    }
    if (!wall) return;
    const ga = groundAt(...at(A, cutA + 0.5));
    const gb = groundAt(...at(B, cutB + 0.5));
    const T = 0.45;
    const [o0x, o0y] = at(A, cutA + T);
    const [o1x, o1y] = at(B, cutB + T);
    const topA = Math.max(ga + 0.9, z0 + 1.2);
    const topB = Math.max(gb + 0.9, z1 + 1.2);
    if (blockWall(A.x, A.y)) {
      // station cutting: a dark base to 1 m, buff block above
      const b0 = st.vert(w0x, z0 - 0.2, w0y, ...BASE_DARK);
      const b1 = st.vert(w1x, z1 - 0.2, w1y, ...BASE_DARK);
      const b2 = st.vert(w1x, z1 + 1.0, w1y, ...BASE_DARK);
      const b3 = st.vert(w0x, z0 + 1.0, w0y, ...BASE_DARK);
      st.quad(b0, b1, b2, b3, -fx, 0, fy);
      const v0 = st.vert(w0x, z0 + 1.0, w0y, ...BUFF);
      const v1 = st.vert(w1x, z1 + 1.0, w1y, ...BUFF);
      const v2 = st.vert(w1x, topB, w1y, ...BUFF);
      const v3 = st.vert(w0x, topA, w0y, ...BUFF);
      st.quad(v0, v1, v2, v3, -fx, 0, fy);
    } else {
      const v0 = st.vert(w0x, z0 - 0.2, w0y, ...WALL);
      const v1 = st.vert(w1x, z1 - 0.2, w1y, ...WALL);
      const v2 = st.vert(w1x, topB, w1y, ...WALL);
      const v3 = st.vert(w0x, topA, w0y, ...WALL);
      st.quad(v0, v1, v2, v3, -fx, 0, fy);
    }
    const u0 = st.vert(o0x, topA, o0y, ...CONC);
    const u1 = st.vert(o1x, topB, o1y, ...CONC);
    const u2 = st.vert(w1x, topB, w1y, ...CONC);
    const u3 = st.vert(w0x, topA, w0y, ...CONC);
    st.quad(u0, u1, u2, u3, 0, 1, 0);
    // outer face down to the road: the wall is a solid box (its back is in the ground)
    const q0 = st.vert(o0x, z0 - 0.2, o0y, ...WALL);
    const q1 = st.vert(o1x, z1 - 0.2, o1y, ...WALL);
    st.quad(q0, q1, u1, u0, fx, 0, -fy);
    // close the box where the wall starts or ends
    const endFace = (wx: number, wy: number, ox: number, oy: number, zb: number, top: number, dx: number, dy: number) => {
      const e0 = st.vert(wx, zb - 0.2, wy, ...WALL);
      const e1 = st.vert(ox, zb - 0.2, oy, ...WALL);
      const e2 = st.vert(ox, top, oy, ...WALL);
      const e3 = st.vert(wx, top, wy, ...WALL);
      st.quad(e0, e1, e2, e3, dx, 0, -dy);
    };
    const ux = B.x - A.x;
    const uy = B.y - A.y;
    if (ends & 1) endFace(w0x, w0y, o0x, o0y, z0, topA, -ux, -uy);
    if (ends & 2) endFace(w1x, w1y, o1x, o1y, z1, topB, ux, uy);
    const cols = [T, 6 + T, 16 + T];
    let prevA = -1;
    let prevB = -1;
    for (const o of cols) {
      const [ax, ay] = at(A, cutA + o);
      const [bx, by] = at(B, cutB + o);
      const ia = g.vert(ax, stripZ(ax, ay, groundAt(ax, ay)), ay);
      const ib = g.vert(bx, stripZ(bx, by, groundAt(bx, by)), by);
      if (prevA >= 0) g.quad(prevA, prevB, ib, ia, 0, 1, 0);
      prevA = ia;
      prevB = ib;
    }
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
      if (pq && !ri.r.bridge && !ri.r.tunnel) surfQuads.push(pq[0], pq[1], pq[2], q[0], q[1], q[2], q[3], q[4], q[5], pq[3], pq[4], pq[5], KERB_H);
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
        // no parapet between a stopping bay and its platform either
        const px = c.x + c.nx * side * (hw + 0.7);
        const py = c.y + c.ny * side * (hw + 0.7);
        ok.push(otherAt(qx, qy, c.z, ri.i, 1.5) < -0.15 && !(heavy && onAnyPlatform(ctx.data.platforms, px, py)));
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
        if ((highDeck(sp) && inWater(c.x, c.y)) || (story && pointInRing(c.x, c.y, story)) || green?.(c.x, c.y)) {
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
   * Where a tunnel road is an enclosed box, sampled every 4 m: under enough
   * ground, or under a street that crosses low over it (an underpass box, so
   * the street never spans an open cutting as a bare ribbon); its clear
   * height, lowered under a road that crosses low over the tube (never below
   * 4.6 m); and its portals.
   */
  function tubePrep(ri: RI): Tube {
    const r = ri.r;
    const wallOff = ri.hw + 0.9;
    const H = r.kind === RoadKind.Motorway ? TUBE_H + 0.6 : TUBE_H;
    const ss: number[] = [];
    for (let s = 0; s <= ri.len + 0.01; s += 4) ss.push(Math.min(s, ri.len));
    if (ss[ss.length - 1] < ri.len - 0.5) ss.push(ri.len);
    const P0 = ss.map((s) => roadAt(ri, s));
    const n = ss.length;
    // the lowest road (not a tunnel) over the tube's footprint
    const span = wallOff + 0.6;
    const aboveAt = (s: number) => {
      const c = roadAt(ri, s);
      let z = Infinity;
      let road = -1;
      for (let q = -3; q <= 3; q++) {
        const o = (q / 3) * span;
        const a = index.lowestAbove(c.x + c.nx * o, c.y + c.ny * o, c.z + 1.2, 0.3);
        if (a.z < z) {
          z = a.z;
          road = a.road;
        }
      }
      return { dz: z - c.z, road };
    };
    const ab = ss.map(aboveAt);
    const abm = ss.slice(1).map((s1, k) => aboveAt((ss[k] + s1) / 2));
    // the ceiling stays clear of the road's deck (a bridge's girders are deeper)
    const lim = (a: { dz: number; road: number }) => (a.road < 0 ? Infinity : a.dz - (roads[a.road].bridge ? 2.2 : 0.65));
    const hc = ss.map((_, k) => clamp(Math.min(lim(ab[k]), k > 0 ? lim(abm[k - 1]) : Infinity, k < n - 1 ? lim(abm[k]) : Infinity), 4.6, H));
    // a street (not a bridge with its own deck) low over the cutting closes it into an underpass box,
    // run on a sample past the street so the headwalls stand beside it, not in it
    const street = (a: { dz: number; road: number }) => a.road >= 0 && !roads[a.road].bridge && a.dz < H + 3;
    const over = ss.map((_, k) => street(ab[k]) || (k > 0 && street(abm[k - 1])) || (k < n - 1 && street(abm[k])));
    const cov = P0.map((c, k) => covered(ri, c) || over[k] || (k > 0 && over[k - 1]) || (k < n - 1 && over[k + 1]));
    // no 4-8 m slivers of open cutting between two boxes, and no lone covered sample
    for (let k = 1; k + 1 < n; k++) {
      if (!cov[k] && cov[k - 1] && (cov[k + 1] || (k + 2 < n && cov[k + 2]))) cov[k] = true;
    }
    for (let k = 0; k < n; k++) {
      if (cov[k] && (k === 0 || !cov[k - 1]) && (k === n - 1 || !cov[k + 1]) && n > 1) cov[k] = false;
    }
    const portals: [number, number][] = [];
    for (let k = 0; k + 1 < n; k++) {
      if (!cov[k] && cov[k + 1]) portals.push([k + 1, 1]);
      if (cov[k] && !cov[k + 1]) portals.push([k, -1]);
    }
    const p = r.pts;
    for (const end of [0, 1]) {
      const v = end === 0 ? 0 : ri.n - 1;
      const k = end === 0 ? 0 : n - 1;
      const nd = nodes.get(nodeKey(p[2 * v], p[2 * v + 1]));
      if (!nd || nd.surf === 0 || !cov[k]) continue;
      portals.push([k, end === 0 ? 1 : -1]);
    }
    const pd = ss.map((s) => {
      let d = 999;
      for (const [k] of portals) d = Math.min(d, Math.abs(ss[k] - s));
      return d;
    });
    return { ss, P0, cov, hc, pd, portals, H };
  }

  /** Stretches [a, b] of a road, split where its tube box starts and ends: [s0, s1, inBox]. */
  function tubeRuns(tp: Tube | null, a: number, b: number): [number, number, boolean][] {
    if (!tp) return [[a, b, false]];
    const { ss, cov } = tp;
    const out: [number, number, boolean][] = [];
    let s0 = a;
    let k = 0;
    while (k + 1 < ss.length && ss[k + 1] <= a) k++;
    let box = cov[k] && cov[Math.min(k + 1, ss.length - 1)];
    for (; k + 1 < ss.length; k++) {
      const bk = cov[k] && cov[k + 1];
      if (bk !== box && ss[k] > s0 && ss[k] < b) {
        out.push([s0, ss[k], box]);
        s0 = ss[k];
      }
      box = bk;
      if (ss[k + 1] >= b) break;
    }
    out.push([s0, b, box]);
    return out;
  }

  /** The road/mark shaders' tunnel flag: 0 in the open, else 1 + distance to the nearest portal / 100. */
  /** Whether distance s along the road lies in one of its tube's box segments. */
  function inBoxAt(tp: Tube, s: number): boolean {
    const { ss, cov } = tp;
    let k = 0;
    while (k + 2 < ss.length && ss[k + 1] <= s) k++;
    return cov[k] && cov[k + 1];
  }

  function tubeFlag(tp: Tube, s: number, inBox: boolean): number {
    if (!inBox) return 0;
    let d = 999;
    for (const [k] of tp.portals) d = Math.min(d, Math.abs(tp.ss[k] - s));
    return 1 + Math.min(d, 900) / 100;
  }

  /**
   * Tunnel: enclosed box (walls, ceiling, walkways, light lines, fittings)
   * where it is covered, open toward neighbouring tunnel carriageways at this
   * level and underground platforms; where the ground is too low (portal
   * approaches) an open cutting instead, with a portal where the two meet.
   */
  function buildTube(ri: RI, L: Layer, tp: Tube): void {
    const r = ri.r;
    const hw = ri.hw;
    const t = L.tube;
    const wallOff = hw + 0.9;
    const { ss, P0, cov, hc, pd } = tp;
    const busway = r.kind === RoadKind.Busway || r.bus;
    // the underground platforms beside this tube: within 40 m of its centreline and at its level (a
    // service ramp passing over a station's hall is no part of it)
    const plats = underPlatforms.filter((pf, i) => {
      if (!pf.area) return false;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let j = 0; j + 1 < pf.pts.length; j += 2) {
        x0 = Math.min(x0, pf.pts[j]);
        x1 = Math.max(x1, pf.pts[j]);
        y0 = Math.min(y0, pf.pts[j + 1]);
        y1 = Math.max(y1, pf.pts[j + 1]);
      }
      return P0.some((c) => c.x > x0 - 40 && c.x < x1 + 40 && c.y > y0 - 40 && c.y < y1 + 40 && !(Math.abs(c.z - underZ[i]) > 3));
    });
    /**
     * An underground platform beside the road, along the ray from (x, y) in direction (dx, dy): where the
     * ray enters and leaves the first platform it meets within 8 m of the kerb (exact, against the outline
     * the station model draws), or null.
     */
    const platSpan = (x: number, y: number, dx: number, dy: number): [number, number] | null => {
      let best: [number, number] | null = null;
      for (const pf of plats) {
        if (!pf.area) continue;
        const run = rayRuns(pf.pts, x, y, dx, dy, hw + 40).find(([a, b]) => b > hw - 0.5 && a < hw + 8);
        // (a ray running on along a platform at a shallow angle meets its end, not its side)
        if (run && run[1] - Math.max(run[0], hw) < 20 && (!best || run[1] > best[1])) best = run;
      }
      return best;
    };
    const platExit = (x: number, y: number, dx: number, dy: number) => platSpan(x, y, dx, dy)?.[1] ?? -1;
    const hallAt = (x: number, y: number) => {
      let best: (typeof underPlatforms)[number] | null = null;
      let bd = 60;
      for (const pf of plats) {
        const d = Math.hypot(pf.pts[0] - x, pf.pts[1] - y);
        if (d < bd + 150 && pf.area) {
          // distance to the platform outline's vertices is enough to name the hall
          for (let i = 0; i < pf.pts.length; i += 2) {
            const e = Math.hypot(pf.pts[i] - x, pf.pts[i + 1] - y);
            if (e < bd) {
              bd = e;
              best = pf;
            }
          }
        }
      }
      const nm = best?.name ?? '';
      return /King George/i.test(nm) ? TUBE_PAL.kgs : /Queen St/i.test(nm) ? TUBE_PAL.qsbs : busway ? TUBE_PAL.bus : TUBE_PAL.road;
    };
    // other carriageways at this level: tunnels within 3 m; streets only if they are level with this
    // one (never one above it) and themselves under ground, so a side never opens into a cutting
    const tubeNb = (x: number, y: number, z: number) => Math.max(levelNb(x, y, z, ri.i, tp.H), tunnels.penetrationZ(x, y, z, 3, ri.i));
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
    const boxSeg = (q: number) => q >= 0 && q + 1 < ss.length && cov[q] && cov[q + 1];
    const cover = P0.map((c, k) => field.natAt(c.x, c.y) - (c.z + hc[k]));
    // per side, per segment: wall offset where a wall stands (else -1), and the ceiling's reach
    const wallAtSide: number[][] = [];
    const reach: number[][] = [];
    const openSide: boolean[][] = [];
    const pals = ss.map((_, k) => {
      const c = P0[k];
      return hallAt(c.x, c.y);
    });
    const nearPlat = plats.length > 0;
    for (const side of [1, -1]) {
      const wl: number[] = [];
      const rc: number[] = [];
      const op: boolean[] = [];
      wallAtSide.push(wl);
      reach.push(rc);
      openSide.push(op);
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
        // (never across an underground platform: the hall is open there)
        for (let o = wallOff + 0.5; o < end; o += 1) {
          const x = c.x + c.nx * side * o;
          const y = c.y + c.ny * side * o;
          if (plats.some((pf) => pointInRing(x, y, pf.pts))) return;
        }
        const pal = pals[k];
        const q = (o: number, hh: number) => t.vert(c.x + c.nx * side * o, c.z + hh, c.y + c.ny * side * o, ...pal.wall, ss[k] + o, hh, 0, pd[k]);
        t.quad(q(wallOff, 0), q(end, 0), q(end, hc[k]), q(wallOff, hc[k]), c.ny, 0, c.nx);
      };
      // underground platform beside the road: push the wall out past its far
      // edge, unless another carriageway lies just beyond it (an island
      // platform): then the two share one hall and there is no wall between
      const platEdge = P0.map((c) => platExit(c.x, c.y, c.nx * side, c.ny * side));
      const shared = P0.map((c, k) => {
        const last = platEdge[k];
        if (last < 0) return false;
        // Search 22 m past the platform: Queen St platform 2's far carriageway is ~13.5 m beyond its kerb.
        // Keep in step with the matching search in src/sim/collider.ts.
        for (let o = last + 0.5; o <= last + 22; o += 0.5) if (tubeNb(c.x + c.nx * side * o, c.y + c.ny * side * o, c.z) > -0.5) return true;
        return false;
      });
      // the wall stands 0.35 m behind the platform's far edge (the hall's tiled back wall is 0.15 m in front
      // of that edge), from one sample before each platform end on, so it never cuts across a corner
      const sideFine = (s0: number, s1: number) => {
        let m = -1;
        const steps = Math.max(1, Math.ceil((s1 - s0) / 0.5));
        for (let q = 0; q <= steps; q++) {
          const c = roadAt(ri, s0 + ((s1 - s0) * q) / steps);
          m = Math.max(m, platExit(c.x, c.y, c.nx * side, c.ny * side));
        }
        return m;
      };
      const wo = ss.map((_, k) => {
        if (!nearPlat || shared[k] || (k > 0 && shared[k - 1]) || (k + 1 < ss.length && shared[k + 1])) return wallOff;
        const e = sideFine(ss[Math.max(0, k - 1)], ss[Math.min(ss.length - 1, k + 1)]);
        return e >= 0 ? Math.max(wallOff, e + 0.35) : wallOff;
      });
      // a wall that would still stand inside a platform (a road meeting the platform's end at an angle):
      // that side stays open to the hall instead
      for (let k = 0; k + 1 < ss.length; k++) {
        if (!boxSeg(k) || segOpen[k] || shared[k] || shared[k + 1]) continue;
        const A = P0[k];
        const B = P0[k + 1];
        for (let f = 0.1; f < 1; f += 0.2) {
          const o = wo[k] + (wo[k + 1] - wo[k]) * f;
          const x = A.x + (B.x - A.x) * f + (A.nx + (B.nx - A.nx) * f) * side * o;
          const y = A.y + (B.y - A.y) * f + (A.ny + (B.ny - A.ny) * f) * side * o;
          if (plats.some((pf) => pointInRing(x, y, pf.pts))) {
            segOpen[k] = true;
            break;
          }
        }
      }
      const walledSeg = (q: number) => boxSeg(q) && !(segOpen[q] || shared[q] || shared[q + 1]);
      const baySeg = (q: number) => walledSeg(q) && (wo[q] > wallOff + 0.05 || wo[q + 1] > wallOff + 0.05);
      for (let k = 0; k + 1 < ss.length; k++) {
        let A = P0[k];
        let B = P0[k + 1];
        const isShared = shared[k] || shared[k + 1];
        const isOpen = segOpen[k] || isShared;
        wl.push(-1);
        rc.push(wallOff);
        op.push(isOpen);
        if (k > 0 && (segOpen[k - 1] || shared[k - 1] || shared[k]) !== isOpen) nose(k);
        if (!boxSeg(k)) {
          // approach in an open cutting
          // walls start/end where the neighbouring segment is open on this side (a box has its headwall)
          const wallAt = (q: number) => q >= 0 && q + 1 < ss.length && !(segOpen[q] || shared[q] || shared[q + 1]);
          const ends = isOpen ? 0 : (k === 0 || (!boxSeg(k - 1) && !wallAt(k - 1)) ? 1 : 0) | (k + 2 === ss.length || (!boxSeg(k + 1) && !wallAt(k + 1)) ? 2 : 0);
          // mitred at a plain join with the next road, like earthworks()
          const m0 = k === 0 ? endMiter(ri, false) : null;
          const m1 = k + 2 === ss.length ? endMiter(ri, true) : null;
          const Am = m0 ? { ...A, nx: m0[0], ny: m0[1] } : A;
          const Bm = m1 ? { ...B, nx: m1[0], ny: m1[1] } : B;
          cutSeg(L, Am, Bm, side, ss[k], ss[k + 1], 0, 0, hw + 0.3, hw + 0.3, hw, !isOpen, ends);
          continue;
        }
        // where this tube meets another one, run on a little so the two overlap
        // instead of leaving a wedge open on the outside of the bend
        if (k === 0 && joinStart) A = { ...A, x: A.x - dirS[0] * TUBE_EXT, y: A.y - dirS[1] * TUBE_EXT };
        if (k + 2 === ss.length && joinEnd) B = { ...B, x: B.x + dirE[0] * TUBE_EXT, y: B.y + dirE[1] * TUBE_EXT };
        const pal = pals[k];
        const hall = pal === TUBE_PAL.kgs || pal === TUBE_PAL.qsbs;
        const sA = ss[k];
        const sB = ss[k + 1];
        const hA = hc[k];
        const hB = hc[k + 1];
        const V = (c: typeof A, off: number, h: number, col: number[], s: number, part: number, hh = h) =>
          t.vert(c.x + c.nx * side * off, c.z + h, c.y + c.ny * side * off, col[0], col[1], col[2], s, hh, part, c === A || s === sA ? pd[k] : pd[k + 1]);
        const fx = side * A.nx;
        const fy = side * A.ny;
        const woA = isOpen ? wallOff : wo[k];
        const woB = isOpen ? wallOff : wo[k + 1];
        // shared hall: ceiling reaches over the platform into the other carriageway; toward a
        // neighbouring tube, floor and ceiling run to the edge of its carriageway (its own cover the rest)
        const gapEnd = (c: typeof A) => {
          for (let o = hw; o <= wallOff + 6; o += 0.25) if (tubeNb(c.x + c.nx * side * o, c.y + c.ny * side * o, c.z) > 0.05) return o + 0.15;
          return wallOff + 6;
        };
        const gA = isOpen && !isShared ? gapEnd(A) : 0;
        const gB = isOpen && !isShared ? gapEnd(B) : 0;
        const ceilA = isShared ? Math.max(wallOff + 6, platEdge[k] + 3) : isOpen ? gA + 0.3 : woA;
        const ceilB = isShared ? Math.max(wallOff + 6, platEdge[k + 1] + 3) : isOpen ? gB + 0.3 : woB;
        const floorA = isOpen && !isShared ? gA : ceilA;
        const floorB = isOpen && !isShared ? gB : ceilB;
        rc[k] = Math.max(ceilA, ceilB);
        if (isOpen) {
          // toward a neighbouring carriageway: a flush floor under the gap, no kerb
          t.quad(V(A, hw - 0.2, -0.04, pal.walk, sA, 2), V(B, hw - 0.2, -0.04, pal.walk, sB, 2), V(B, floorB, -0.04, pal.walk, sB, 2), V(A, floorA, -0.04, pal.walk, sA, 2), 0, 1, 0);
        } else {
          wl[k] = (woA + woB) / 2;
          const bay = baySeg(k);
          const wz = bay ? -0.04 : 0.25;
          if (bay) {
            // beside an underground platform: a flush floor (the stopping bay) out to the wall, under the
            // platform slab the station draws; the walkway ends with a face where it meets the bay
            t.quad(V(A, hw - 0.2, -0.04, pal.walk, sA, 2), V(B, hw - 0.2, -0.04, pal.walk, sB, 2), V(B, woB, -0.04, pal.walk, sB, 2), V(A, woA, -0.04, pal.walk, sA, 2), 0, 1, 0);
            const ux = B.x - A.x;
            const uy = B.y - A.y;
            if (walledSeg(k - 1) && !baySeg(k - 1))
              t.quad(V(A, hw, -0.04, KERB_TUBE, sA, 2), V(A, wallOff, -0.04, KERB_TUBE, sA, 2), V(A, wallOff, 0.25, KERB_TUBE, sA, 2), V(A, hw, 0.25, KERB_TUBE, sA, 2), ux, 0, -uy);
            if (walledSeg(k + 1) && !baySeg(k + 1))
              t.quad(V(B, wallOff, -0.04, KERB_TUBE, sB, 2), V(B, hw, -0.04, KERB_TUBE, sB, 2), V(B, hw, 0.25, KERB_TUBE, sB, 2), V(B, wallOff, 0.25, KERB_TUBE, sB, 2), -ux, 0, uy);
          } else {
            // walkway and kerb
            const w0 = V(A, hw, 0.25, pal.walk, sA, 2);
            const w1 = V(B, hw, 0.25, pal.walk, sB, 2);
            t.quad(w0, w1, V(B, woB, 0.25, pal.walk, sB, 2), V(A, woA, 0.25, pal.walk, sA, 2), 0, 1, 0);
            t.quad(V(A, hw, 0, KERB_TUBE, sA, 2), V(B, hw, 0, KERB_TUBE, sB, 2), V(B, hw, 0.25, KERB_TUBE, sB, 2), V(A, hw, 0.25, KERB_TUBE, sA, 2), -fx, 0, fy);
          }
          // wall (the shader paints the dado, delineator line and panel joints, or the hall's tiles)
          const wp = hall && pal === TUBE_PAL.kgs ? 7 : 0;
          t.quad(V(A, woA, wz, pal.wall, sA, wp), V(B, woB, wz, pal.wall, sB, wp), V(B, woB, hB, pal.wall, sB, wp), V(A, woA, hA, pal.wall, sA, wp), -fx, 0, fy);
          if (!hall) {
            // cable tray under the ceiling edge
            const tr = [70, 72, 74];
            t.quad(V(A, woA, hA - 0.62, tr, sA, 6), V(B, woB, hB - 0.62, tr, sB, 6), V(B, woB - 0.42, hB - 0.62, tr, sB, 6), V(A, woA - 0.42, hA - 0.62, tr, sA, 6), 0, -1, 0);
            t.quad(V(A, woA - 0.42, hA - 0.62, tr, sA, 6), V(B, woB - 0.42, hB - 0.62, tr, sB, 6), V(B, woB - 0.42, hB - 0.46, tr, sB, 6), V(A, woA - 0.42, hA - 0.46, tr, sA, 6), -fx, 0, fy);
          }
        }
        const cp = hall && pal === TUBE_PAL.kgs ? 8 : 1;
        t.quad(V(A, 0, hA, pal.ceil, sA, cp), V(B, 0, hB, pal.ceil, sB, cp), V(B, ceilB, hB, pal.ceil, sB, cp), V(A, ceilA, hA, pal.ceil, sA, cp), 0, -1, 0);
        // shallow cover: a grassed mound over the box so its roof never shows
        if (cover[k] < 0.6 || cover[k + 1] < 0.6) {
          const g = L.strip;
          const mound = (c: typeof A, o: number, hh: number) => {
            const x = c.x + c.nx * side * o;
            const y = c.y + c.ny * side * o;
            const top = c.z + hh + 0.5;
            return g.vert(x, stripZ(x, y, o <= wallOff + 1 ? Math.max(field.natAt(x, y), top) : field.natAt(x, y)), y);
          };
          const cols = [0, wallOff + 1, wallOff + 8];
          let pa = -1;
          let pb = -1;
          for (const o of cols) {
            const ia = mound(A, o, hA);
            const ib = mound(B, o, hB);
            if (pa >= 0) g.quad(pa, pb, ib, ia, 0, 1, 0);
            pa = ia;
            pb = ib;
          }
        }
      }
    }
    // light lines along the ceiling over the lanes (doubled in the 40 m inside each portal), and in a
    // long tube jet fans in pairs; on each walled side an exit sign and an emergency cabinet every 60 m
    const lanesO = hw > 6 ? [-hw * 0.6, 0, hw * 0.6] : [-hw * 0.42, hw * 0.42];
    let boxLen = 0;
    for (let k = 0; k + 1 < ss.length; k++) if (boxSeg(k)) boxLen += ss[k + 1] - ss[k];
    for (let k = 0; k + 1 < ss.length; k++) {
      if (!boxSeg(k)) continue;
      const A = P0[k];
      const B = P0[k + 1];
      const thr = Math.min(pd[k], pd[k + 1]) < 40;
      const offs = thr ? lanesO.flatMap((o) => [o - 0.35, o + 0.35]) : lanesO;
      const lamp = pals[k] === TUBE_PAL.qsbs ? [255, 214, 160] : [250, 246, 232];
      for (const o of offs) {
        const q = (c: typeof A, d: number, hh: number, s: number, pdv: number) => t.vert(c.x + c.nx * (o + d), c.z + hh - 0.03, c.y + c.ny * (o + d), lamp[0], lamp[1], lamp[2], s, hh, 3, pdv);
        t.quad(q(A, -0.13, hc[k], ss[k], pd[k]), q(B, -0.13, hc[k + 1], ss[k + 1], pd[k + 1]), q(B, 0.13, hc[k + 1], ss[k + 1], pd[k + 1]), q(A, 0.13, hc[k], ss[k], pd[k]), 0, -1, 0);
      }
    }
    const segAt = (s: number) => Math.min(ss.length - 2, Math.max(0, Math.floor(s / 4)));
    if (boxLen > 300) {
      for (let s = 60; s < ri.len - 30; s += 100) {
        const k = segAt(s);
        if (!boxSeg(k) || pals[k] !== pals[0] || pals[k] === TUBE_PAL.kgs || pals[k] === TUBE_PAL.qsbs) continue;
        const c = roadAt(ri, s);
        const hh = Math.min(hc[k], hc[k + 1]);
        if (hh < 5.6) continue;
        for (const o of hw > 4.5 ? [-hw * 0.35, hw * 0.35] : [0]) jetFan(t, c, o, c.z + hh - 0.85, s, pd[k]);
      }
    }
    for (const [si, side] of [
      [0, 1],
      [1, -1],
    ]) {
      for (let s = side > 0 ? 18 : 48; s < ri.len - 6; s += 60) {
        for (const [ds, what] of [
          [0, 0],
          [30, 1],
        ]) {
          const sx = s + ds;
          if (sx > ri.len - 4) continue;
          const k = segAt(sx);
          const o = wallAtSide[si][k];
          if (o < 0 || pals[k] === TUBE_PAL.kgs || pals[k] === TUBE_PAL.qsbs) continue;
          const c = roadAt(ri, sx);
          const tx = c.ny;
          const ty = -c.nx;
          const px = c.x + c.nx * side * o;
          const py = c.y + c.ny * side * o;
          const ix = -c.nx * side;
          const iy = -c.ny * side;
          if (what === 0) {
            // exit sign: green light box with a white panel
            t.box(px + ix * 0.07, py + iy * 0.07, c.z + 2.45, c.z + 2.8, tx, ty, 0.36, 0.06, 40, 190, 90, sx, 2.6, 4, pd[k]);
            t.box(px + ix * 0.14, py + iy * 0.14, c.z + 2.53, c.z + 2.72, tx, ty, 0.1, 0.012, 235, 245, 235, sx, 2.6, 4, pd[k]);
          } else {
            // emergency cabinet (phone, hose) with a red light over it
            t.box(px + ix * 0.13, py + iy * 0.13, c.z + 0.25, c.z + 1.55, tx, ty, 0.45, 0.13, 214, 214, 208, sx, 1.0, 2, pd[k]);
            t.box(px + ix * 0.27, py + iy * 0.27, c.z + 0.6, c.z + 1.4, tx, ty, 0.3, 0.012, 196, 40, 34, sx, 1.0, 2, pd[k]);
            t.box(px + ix * 0.1, py + iy * 0.1, c.z + 1.62, c.z + 1.8, tx, ty, 0.2, 0.1, 240, 40, 30, sx, 1.7, 5, pd[k]);
          }
        }
      }
    }
    // portals: headwall that retains the ground behind it (stopping under any street that runs over the
    // mouth), lintel with the tunnel's name, coping and parapet, pilasters
    const plate = r.name ? plateRow(r.name) : -1;
    const portalAt = (k: number, inward: number) => {
      const c = P0[k];
      portals.push({ x: c.x, y: c.y, z: c.z });
      const tx = c.ny * inward;
      const ty = -c.nx * inward;
      const roof = c.z + hc[k];
      const half = wallOff + 1.2;
      const st = L.struct;
      for (const sd of [1, -1]) st.boxF(c.x + c.nx * sd * (half - 0.3) - tx * 0.3, c.y + c.ny * sd * (half - 0.3) - ty * 0.3, c.z - 0.2, roof, tx, ty, 0.3, 0.3, ...CONC);
      const N = Math.max(4, Math.round((2 * half) / 1.2));
      const w = (2 * half) / N;
      let lintelTop = Infinity;
      for (let j = 0; j < N; j++) {
        const o = -half + (j + 0.5) * w;
        const px = c.x + c.nx * o;
        const py = c.y + c.ny * o;
        const g = Math.max(groundAt(px + tx * 3, py + ty * 3), roof + 0.6);
        let top = g + 0.3;
        const above = index.lowestAbove(px - tx * 0.4, py - ty * 0.4, roof - 0.5, 0.5);
        const street = above.road >= 0 && above.z < top + 2.5;
        if (street) {
          top = Math.max(roof + 0.25, above.z - 0.05);
          lintelTop = Math.min(lintelTop, above.z - 0.05);
        }
        st.boxF(px - tx * 0.3, py - ty * 0.3, roof, top, tx, ty, 0.3, w / 2 + 0.002, ...WALL);
        if (!street) {
          st.boxF(px - tx * 0.3, py - ty * 0.3, top, top + 0.12, tx, ty, 0.38, w / 2 + 0.002, ...CONC);
          st.boxF(px - tx * 0.5, py - ty * 0.5, top + 0.12, top + 1.0, tx, ty, 0.1, w / 2 + 0.002, ...CONC);
        }
      }
      // lintel beam over the opening, standing 0.3 m proud of the headwall
      const lt = Math.min(roof + 1.0, lintelTop);
      if (lt > roof + 0.3) {
        st.boxF(c.x - tx * 0.45, c.y - ty * 0.45, roof - 0.2, lt, tx, ty, 0.45, wallOff + 0.6, ...CONC);
        if (plate >= 0 && lt > roof + 0.75) namePlate(L, c.x - tx * 0.905, c.y - ty * 0.905, tx, ty, roof + (lt - roof - 0.2) / 2 - 0.1 + 0.0, Math.min(0.62, lt - roof - 0.1), wallOff * 2 - 0.4, plate);
      }
      // ground over the mouth (covers the carved edge of the approach cutting)
      const g = L.strip;
      const rows = [0, 8, 18];
      const cols = [-half - 10, -half, 0, half, half + 10];
      const ids: number[][] = rows.map((d) =>
        cols.map((o) => {
          const x = c.x + tx * d + c.nx * o;
          const y = c.y + ty * d + c.ny * o;
          return g.vert(x, stripZ(x, y, Math.max(groundAt(x, y), roof + 0.5)), y);
        }),
      );
      for (let a = 0; a + 1 < rows.length; a++) for (let b = 0; b + 1 < cols.length; b++) g.quad(ids[a][b], ids[a][b + 1], ids[a + 1][b + 1], ids[a + 1][b], 0, 1, 0);
    };
    for (const [k, inward] of tp.portals) portalAt(k, inward);
    // a covered dead end (the way stops here and nothing joins it): an end wall across the tube
    for (const end of [0, 1]) {
      const k = end === 0 ? 0 : ss.length - 1;
      const v = end === 0 ? 0 : ri.n - 1;
      if ((nodes.get(nodeKey(r.pts[2 * v], r.pts[2 * v + 1]))?.deg ?? 0) !== 1 || !cov[k]) continue;
      const c = P0[k];
      const ox = end === 0 ? -dirS[0] : dirE[0];
      const oy = end === 0 ? -dirS[1] : dirE[1];
      const pal = pals[k];
      const e = (o: number, hh: number) => t.vert(c.x + c.nx * o + ox * 0.05, c.z + hh, c.y + c.ny * o + oy * 0.05, ...pal.wall, o, hh, 0, pd[k]);
      // across the tube's full width there (out to a pushed-back wall beside a platform, but not across
      // a platform running on past the end: the station closes its hall)
      const sg = end === 0 ? 0 : ss.length - 2;
      const span = (sd: number, rc: number) => {
        const sp = platSpan(c.x, c.y, c.nx * sd, c.ny * sd);
        return Math.max(wallOff, sp ? Math.min(rc, sp[0] - 0.05) : rc);
      };
      const oL = span(1, reach[0][sg] ?? 0);
      const oR = span(-1, reach[1][sg] ?? 0);
      t.quad(e(-oR, -0.3), e(oL, -0.3), e(oL, hc[k]), e(-oR, hc[k]), -ox, 0, oy);
    }
    tubesBuilt.push({ ri, tp, L, reach, open: openSide, boxSeg });
  }

  /** A jet fan hung under the ceiling: an octagonal drum along the road with dark ends and a hanger. */
  function jetFan(t: MeshGeo, c: ReturnType<typeof roadAt>, o: number, zc: number, s: number, pdv: number): void {
    const tx = c.ny;
    const ty = -c.nx;
    const cx = c.x + c.nx * o;
    const cy = c.y + c.ny * o;
    const R = 0.6;
    const half = 2.0;
    const col = [150, 154, 158];
    const ring = (d: number, rr: number) => {
      const out: number[][] = [];
      for (let i = 0; i < 8; i++) {
        const a = ((i + 0.5) / 8) * Math.PI * 2;
        out.push([cx + tx * d + c.nx * Math.cos(a) * rr, zc + Math.sin(a) * rr, cy + ty * d + c.ny * Math.cos(a) * rr, Math.cos(a), Math.sin(a)]);
      }
      return out;
    };
    const a = ring(-half, R);
    const b = ring(half, R);
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      const v = (p: number[]) => t.vert(p[0], p[1], p[2], col[0], col[1], col[2], s, 4.5, 6, pdv);
      const nxm = (a[i][3] + a[j][3]) / 2;
      const nzm = (a[i][4] + a[j][4]) / 2;
      t.quad(v(a[i]), v(b[i]), v(b[j]), v(a[j]), c.nx * nxm, nzm, -c.ny * nxm);
    }
    for (const [rg, d] of [
      [a, -1],
      [b, 1],
    ] as const) {
      const ctr = t.vert(cx + tx * half * d, zc, cy + ty * half * d, 40, 42, 44, s, 4.5, 6, pdv);
      for (let i = 0; i < 8; i++) {
        const j = (i + 1) % 8;
        const v = (p: number[]) => t.vert(p[0], p[1], p[2], 40, 42, 44, s, 4.5, 6, pdv);
        t.tri(ctr, v(rg[i]), v(rg[j]), tx * d, 0, -ty * d);
      }
    }
    t.box(cx, cy, zc + R - 0.05, zc + R + 0.3, tx, ty, 0.8, 0.08, 90, 92, 96, s, 4.5, 6, pdv);
  }

  /** Where a tunnel box's ground was held below its roof (by a road beside or over it): carve it off the box and roof the box over. */
  function roofBoxes(): void {
    for (const { ri, tp, L, reach, boxSeg, open } of tubesBuilt) {
      const { ss, P0, hc } = tp;
      const g = L.strip;
      for (let k = 0; k + 1 < ss.length; k++) {
        if (!boxSeg(k)) continue;
        const A = P0[k];
        const B = P0[k + 1];
        const ra = A.z + hc[k] + 0.3;
        const rb = B.z + hc[k + 1] + 0.3;
        const eL = reach[0][k] + 0.6;
        const eR = reach[1][k] + 0.6;
        let low = false;
        for (const [c, rf] of [
          [A, ra],
          [B, rb],
        ] as const) {
          for (const o of [-eR + 0.6, 0, eL - 0.6]) if (field.settledAt(c.x + c.nx * o, c.y + c.ny * o) < rf - 0.05) low = true;
        }
        if (!low) continue;
        const at = (c: typeof A, o: number) => [c.x + c.nx * o, c.y + c.ny * o] as const;
        const [a0x, a0y] = at(A, eL);
        const [b0x, b0y] = at(B, eL);
        const [b1x, b1y] = at(B, -eR);
        const [a1x, a1y] = at(A, -eR);
        field.holeQuad([a0x, a0y, ra, b0x, b0y, rb, b1x, b1y, rb, a1x, a1y, ra], 0, true, 0);
        // grassed roof at the ground or the roof, whichever is higher, with a skirt at its edges
        const cols = [eL, 0, -eR];
        const top = (c: typeof A, o: number, rf: number) => {
          const [x, y] = at(c, o);
          return g.vert(x, Math.max(rf, field.settledAt(x, y) + 0.02), y);
        };
        let pa = -1;
        let pb = -1;
        for (const o of cols) {
          const ia = top(A, o, ra);
          const ib = top(B, o, rb);
          if (pa >= 0) g.quad(pa, pb, ib, ia, 0, 1, 0);
          pa = ia;
          pb = ib;
        }
        for (const o of [eL, -eR]) {
          // (no skirt on a side open toward the next carriageway: it would hang across it)
          if (open[o > 0 ? 0 : 1][k]) continue;
          const sd = Math.sign(o) || 1;
          const [ax, ay] = at(A, o);
          const [bx, by] = at(B, o);
          const ta = Math.max(ra, field.settledAt(ax, ay) + 0.02);
          const tb = Math.max(rb, field.settledAt(bx, by) + 0.02);
          const [qax, qay] = at(A, o + sd * 0.8);
          const [qbx, qby] = at(B, o + sd * 0.8);
          const ga = Math.min(ta, field.settledAt(qax, qay)) - 0.3;
          const gb = Math.min(tb, field.settledAt(qbx, qby)) - 0.3;
          if (ga > ta - 0.35 && gb > tb - 0.35) continue;
          const v0 = g.vert(ax, ta, ay);
          const v1 = g.vert(bx, tb, by);
          const v2 = g.vert(bx, gb, by);
          const v3 = g.vert(ax, ga, ay);
          g.quad(v0, v1, v2, v3, A.nx * sd, 0, -A.ny * sd);
        }
      }
      void ri;
    }
  }

  /**
   * The ground is a 10 m grid and clamps only reach the grid points inside a
   * road, so on a cross-slope a ground triangle spanning the carriageway can
   * rise through the uphill lane. Wherever the settled ground would show
   * through a road or footpath surface: where it is only a little above,
   * lower the grid vertices around it (up to 0.3 m, the dip spread over the
   * 10 m cell beside the road); where it still shows, carve it out exactly
   * along that surface (the earth face at its edge is the small cut bank you
   * would see), in pieces of up to 8 m.
   */
  function clearSurfaces(): void {
    const Q = surfQuads;
    const { x0: gx0, y0: gy0, cell } = field;
    const q = new Array<number>(12);
    const pts: number[] = [];
    /**
     * Sub-quad of quad o from fraction ua to ub along it into q (corners as in surfQuads: 0 and 1 along
     * one side, 3 and 2 along the other, z already lifted to the surface), and into pts the points
     * where the ground can stand highest over it: its corners, the crossings of its edges with the
     * ground grid's lines and diagonals (the ground is planar between them), and grid vertices inside.
     */
    const prep = (o: number, ua: number, ub: number) => {
      const lift = Q[o + 12];
      let n = 0;
      for (const [c, d, u] of [
        [0, 3, ua],
        [0, 3, ub],
        [9, 6, ub],
        [9, 6, ua],
      ]) {
        for (let m = 0; m < 3; m++) q[n++] = Q[o + c + m] + (Q[o + d + m] - Q[o + c + m]) * u + (m === 2 ? lift : 0);
      }
      pts.length = 0;
      for (let e = 0; e < 4; e++) {
        const ax = q[3 * e];
        const ay = q[3 * e + 1];
        const az = q[3 * e + 2];
        const e2 = (e + 1) % 4;
        const bx = q[3 * e2];
        const by = q[3 * e2 + 1];
        const bz = q[3 * e2 + 2];
        pts.push(ax, ay, az);
        // grid coordinates along the edge: fx = ga + (gb - ga) t, likewise fy and fx - fy (the diagonals)
        const fa = (ax - gx0) / cell;
        const fb = (bx - gx0) / cell;
        const ha = (ay - gy0) / cell;
        const hb = (by - gy0) / cell;
        for (const [p0, p1] of [
          [fa, fb],
          [ha, hb],
          [fa - ha, fb - hb],
        ]) {
          if (Math.abs(p1 - p0) < 1e-9) continue;
          const lo = Math.ceil(Math.min(p0, p1));
          const hi = Math.floor(Math.max(p0, p1));
          for (let g = lo; g <= hi; g++) {
            const t = (g - p0) / (p1 - p0);
            if (t > 0 && t < 1) pts.push(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
          }
        }
      }
      // grid vertices inside (the surface height there by the nearer side's start/end heights)
      const xs = [q[0], q[3], q[6], q[9]];
      const ys = [q[1], q[4], q[7], q[10]];
      for (let gj = Math.ceil((Math.min(...ys) - gy0) / cell); gj <= Math.floor((Math.max(...ys) - gy0) / cell); gj++) {
        for (let gi = Math.ceil((Math.min(...xs) - gx0) / cell); gi <= Math.floor((Math.max(...xs) - gx0) / cell); gi++) {
          const x = gx0 + gi * cell;
          const y = gy0 + gj * cell;
          if (!pointInRing(x, y, [q[0], q[1], q[3], q[4], q[6], q[7], q[9], q[10]])) continue;
          const dx = q[3] - q[0];
          const dy = q[4] - q[1];
          const t = clamp(((x - q[0]) * dx + (y - q[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
          pts.push(x, y, q[2] + (q[5] - q[2]) * t);
        }
      }
    };
    /** Highest the settled ground stands over the prepared points, less 3 cm. */
    const worst = () => {
      let w = -Infinity;
      for (let k = 0; k < pts.length; k += 3) w = Math.max(w, field.settledAt(pts[k], pts[k + 1]) - (pts[k + 2] - 0.03));
      return w;
    };
    const qlen = (o: number) => Math.hypot(Q[o + 3] - Q[o], Q[o + 4] - Q[o + 1]);
    // 1. ground only a little above: lower its grid vertices there
    for (let o = 0; o < Q.length; o += 13) {
      prep(o, 0, 1);
      for (let k = 0; k < pts.length; k += 3) {
        // a point on an edge lies on two ground triangles: lower the one inside the surface
        const cx = (q[0] + q[3] + q[6] + q[9]) / 4;
        const cy = (q[1] + q[4] + q[7] + q[10]) / 4;
        const x = pts[k] + (cx - pts[k]) * 1e-3;
        const y = pts[k + 1] + (cy - pts[k + 1]) * 1e-3;
        const e = field.settledAt(x, y) - (pts[k + 2] - 0.03);
        if (e > 0 && e < 0.3) field.lowerAt(x, y, e + 0.02);
      }
    }
    // 2. what still shows through: carve it out exactly along the surface (the floor is the surface
    // itself: a footpath stands KERB_H above its road), over the runs of 8 m pieces where it shows
    const poke: boolean[] = [];
    for (let o = 0; o < Q.length; o += 13) {
      const nP = Math.max(1, Math.ceil(qlen(o) / 8));
      poke.length = 0;
      for (let p = 0; p < nP; p++) {
        prep(o, p / nP, (p + 1) / nP);
        poke.push(worst() > 0);
      }
      for (let p = 0; p < nP; p++) {
        if (!poke[p]) continue;
        let p1 = p;
        while (p1 + 1 < nP && poke[p1 + 1]) p1++;
        prep(o, p / nP, (p1 + 1) / nP);
        field.holeQuad(q.slice(), 0, false, 0, true);
        p = p1;
      }
    }
  }
}
