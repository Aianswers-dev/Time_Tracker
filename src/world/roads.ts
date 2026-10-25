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
import { RoadKind, type EdgeWalls, type Road } from '../types';
import { type Ctx, densityAt } from './ctx';
import { MeshGeo } from './geo';
import { RoadIndex, roadHeight } from './roadindex';
import { NOISE_GLSL, patch } from './shaders';
import type { TerrainField } from './terrain';
import { greenBridgeSpan, storyOutline } from './landmarks';
import { makeRoadTextTexture, makeSignTextTexture, makeTunnelSignTexture } from './textures';
import { MASK_RAIL, MASK_WATER, clamp, pointInRing, yieldFrame } from './util';
import { onAnyPlatform } from '../data/stations';

export const KERB_H = 0.15;
const ROAD_CHUNK = 2500;
/** Clear height inside tunnels. */
const TUBE_H = 5.8;
/** How high a tube wall is solid for the driving collider (above any bus; below a road crossing low over the tube). */
const TUBE_WALL_H = 4.6;

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
  else if (surf > 2.5 && surf < 3.5) {
    // station bay: light-grey concrete slabs
    vec2 q = p / vec2(4.5, 3.6);
    vec2 f = abs(fract(q) - 0.5);
    float j = smoothstep(0.485, 0.5, max(f.x, f.y));
    c = vec3(0.62, 0.61, 0.58) * mix(0.9, 1.06, n.g) * mix(0.96, 1.04, n2.b) * (1.0 - j * 0.35);
  } else if (surf > 1.5 && surf < 2.5) {
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
        }
        // tunnel portal headwalls: precast panels 2.4 x 1.6 m with a vertical ribbed formliner (ribs every
        // 0.25 m, shaded as if lit from above one side; flat where they would be finer than a pixel)
        vec3 pd = abs(vColor.rgb - vec3(182.0, 177.0, 166.0) / 255.0);
        if (max(pd.r, max(pd.g, pd.b)) < 0.008) {
          vec3 fn = normalize(cross(dFdx(vGPos), dFdy(vGPos)));
          if (abs(fn.y) < 0.3) {
            float qh = abs(fn.x) > abs(fn.z) ? vGPos.z : vGPos.x;
            float amp = 1.0 - smoothstep(0.04, 0.12, fwidth(qh / 0.25));
            float rib = fract(qh / 0.25);
            float shade = mix(0.97, 0.88 + 0.2 * smoothstep(0.0, 0.5, rib) * (1.0 - smoothstep(0.55, 1.0, rib)), amp);
            vec2 pq = vec2(qh / 2.4, vGPos.y / 1.6);
            vec2 pf = (0.5 - abs(fract(pq) - 0.5)) * vec2(2.4, 1.6);
            float pj = 1.0 - smoothstep(0.01, 0.02 + fwidth(vGPos.y), min(pf.x, pf.y));
            diffuseColor.rgb *= shade * (1.0 - 0.35 * pj) * (0.95 + 0.1 * texture2D(uNoise, floor(pq) / 29.0).r);
          }
        }`,
      ],
    ],
  });
}

const TUBE_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uSigns;
varying vec3 vGPos;
varying vec4 vTube;
// set by tubeAlbedo: how much of the fragment glows and in what colour (luminaires, signs, delineators),
// and where it lies in the luminaires' rhythm (+1 under a lamp, -1 midway between two; 0 where the
// rhythm is too fine to show or the threshold lighting runs continuous)
float t_em = 0.0;
vec3 t_emc = vec3(0.0);
float t_pool = 0.0;
float t_line(float v, float period, float w) {
  float fw = max(fwidth(v), 1e-4);
  float d = abs(fract(v / period + 0.5) - 0.5) * period;
  return 1.0 - smoothstep(w * 0.5, w * 0.5 + fw * 1.2, d);
}
// a 0/1 pulse train (on while fract(x) < d), box-filtered over the pixel so distant lamps never shimmer
float t_pulseI(float x, float d) {
  return floor(x) * d + min(fract(x), d);
}
float t_pulse(float x, float d) {
  float fw = max(fwidth(x), 1e-4);
  return (t_pulseI(x + 0.5 * fw, d) - t_pulseI(x - 0.5 * fw, d)) / fw;
}
vec3 tubeAlbedo(vec3 base, float part) {
  float s = vTube.x;
  float h = vTube.y;
  if (part > 8.5) {
    // sign face: (s, h) are its coordinates in the sign atlas (makeTunnelSignTexture)
    vec3 sg = texture2D(uSigns, vTube.xy).rgb;
    t_em = 1.0;
    t_emc = sg * 1.3;
    return sg;
  }
  float n1 = texture2D(uNoise, vec2(s, h) / 4.1).r;
  float n2 = texture2D(uNoise, vec2(s, h) / 0.83 + 0.37).g;
  vec3 c = base * (0.93 + 0.1 * n1);
  // luminaires 1.6 m long every 4.5 m, lengthening to a near continuous line through the threshold zone
  // inside each portal; the walls and ceiling brighten under each lamp
  float duty = mix(0.92, 0.36, smoothstep(25.0, 70.0, vTube.w));
  float px = s / 4.5;
  t_pool = (1.0 - smoothstep(0.12, 0.4, fwidth(px))) * (1.0 - duty) * cos(6.2831853 * px);
  if (part < 0.5) {
    // painted wall panels 2.5 m wide, each its own shade, with joints, road grime in streaks above a dark
    // dado and a white delineator line, and dark painted concrete above the panels to the ceiling
    c *= 0.95 + 0.09 * texture2D(uNoise, vec2(floor(s / 2.5) / 37.0, 0.71)).r;
    c *= 1.0 - 0.3 * t_line(s, 2.5, 0.03) * step(1.25, h);
    c *= 1.0 - 0.22 * max(t_line(h - 2.8, 100.0, 0.025), t_line(h, 4.4, 0.03) * step(2.0, h));
    float streak = texture2D(uNoise, vec2(s / 1.7, h / 23.0) + 0.53).b;
    c *= 1.0 - (0.05 + 0.16 * streak) * (1.0 - smoothstep(1.25, 3.0, h));
    c = mix(c, vec3(0.27, 0.28, 0.29) * (0.88 + 0.18 * n2), step(h, 1.1));
    c = mix(c, vec3(0.95, 0.95, 0.9), step(1.12, h) * step(h, 1.24));
    c = mix(c, vec3(0.2, 0.205, 0.215) * (0.85 + 0.3 * n1), step(4.43, h));
  } else if (part < 1.5) {
    // ceiling: construction joints every 10 m and water stains
    c *= (1.0 - 0.35 * t_line(s, 10.0, 0.05)) * (0.82 + 0.3 * n1 * n2);
  } else if (part > 2.5 && part < 3.5) {
    // luminaire line: lamps, with the dark housing and trunking between them
    t_em = t_pulse(px + 0.5 * duty, duty);
    t_emc = base * 2.4;
    c = vec3(0.16, 0.165, 0.17);
  } else if (part > 3.5 && part < 5.5) {
    t_em = 1.0;
    t_emc = base * 1.6;
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
    // amber retroreflectors on the walkway's kerb face every 9 m (the face is the part of the walkway
    // whose height varies; fading out where they would be smaller than a pixel)
    float kerb = (smoothstep(0.06, 0.08, h) - smoothstep(0.16, 0.18, h)) * step(1e-5, fwidth(s)) * (1.0 - smoothstep(0.02, 0.06, fwidth(h)));
    t_em = t_pulse(s / 9.0 + 0.01, 0.02) * kerb;
    t_emc = vec3(1.0, 0.62, 0.16) * 1.4;
  }
  return c;
}
`;

/**
 * Tunnel interiors, lit by their own LED lines: vertex colour is the albedo,
 * aTube = (s along the road, height above it, part, distance to the portal).
 * Parts: 0 wall, 1 ceiling, 2 walkway and fittings, 3 light line, 4 sign
 * light, 5 red light, 6 metalwork, 7 tiled hall wall, 8 slatted hall ceiling,
 * 9 sign face (s, height = its u, v in the sign atlas).
 */
function tubeMaterial(ctx: Ctx, signs: THREE.Texture): THREE.MeshLambertMaterial {
  return patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), {
    key: 'tube5',
    uniforms: { uNoise: { value: ctx.tex.noise }, uSigns: { value: signs } },
    vertexPars: 'attribute vec4 aTube;\nvarying vec4 vTube;\nvarying vec3 vGPos;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvTube = aTube;\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;']],
    fragmentPars: TUBE_FRAG,
    fragment: [
      ['#include <color_fragment>', '#include <color_fragment>\nfloat part = floor(vTube.z + 0.5);\ndiffuseColor.rgb = tubeAlbedo(diffuseColor.rgb, part);\nw_inTube = 1.0;'],
      [
        'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
        `float th = vTube.y;
        float lit = 0.86 * (1.0 + 0.05 * t_pool);
        if (part < 0.5 || (part > 6.5 && part < 7.5)) lit = mix(0.64, 1.08, smoothstep(0.3, 5.0, th)) * (1.0 + 0.2 * t_pool * smoothstep(0.6, 4.0, th));
        else if (part < 1.5 || (part > 7.5 && part < 8.5)) lit = 0.72 * (1.0 + 0.16 * t_pool);
        else if (part > 5.5 && part < 6.5) lit = 0.8;
        float thr = 1.0 + 0.55 * (1.0 - smoothstep(6.0, 60.0, vTube.w));
        vec3 outgoingLight = mix(diffuseColor.rgb * ${TUNNEL_LIGHT} * lit * thr, t_emc, t_em);`,
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
/** Cells of the tunnel sign atlas (makeTunnelSignTexture): x, y, width, height in its 512 x 128 px. */
const SIGN_EXIT_L = [0, 0, 128, 64];
const SIGN_EXIT_R = [128, 0, 128, 64];
const SIGN_SOS = [256, 0, 128, 64];
const SIGN_HOSE = [384, 0, 128, 64];
const SIGN_GO = [0, 64, 64, 64];
const SIGN_STOP = [64, 64, 64, 64];

/** A lit sign face (tube part 9) showing an atlas cell, centred at (x, y, zc), w x hgt, facing (fx, fy). */
function signFace(t: MeshGeo, x: number, y: number, zc: number, w: number, hgt: number, fx: number, fy: number, cell: number[], pdv: number): void {
  // its right as seen from in front
  const rx = -fy;
  const ry = fx;
  const u0 = (cell[0] + 1) / 512;
  const u1 = (cell[0] + cell[2] - 1) / 512;
  const v0 = 1 - (cell[1] + cell[3] - 1) / 128;
  const v1 = 1 - (cell[1] + 1) / 128;
  const V = (o: number, dz: number, u: number, v: number) => t.vert(x + rx * o, zc + dz, y + ry * o, 255, 255, 255, u, v, 9, pdv);
  t.quad(V(-w / 2, -hgt / 2, u0, v0), V(w / 2, -hgt / 2, u1, v0), V(w / 2, hgt / 2, u1, v1), V(-w / 2, hgt / 2, u0, v1), fx, 0, -fy);
}

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
  /** The solid edges drawn (walls, parapets, pilasters), for the driving collider. */
  walls: EdgeWalls;
}

/** EdgeWalls kinds (the sim's WallKind). */
const EW_TUNNEL = 0;
const EW_PARAPET = 1;
const EW_RETAINING = 2;

/** Collects the solid edges as they are drawn (see EdgeWalls). */
class WallLog {
  private seg: number[] = [];
  private lo: number[] = [];
  private hi: number[] = [];
  private kind: number[] = [];
  private road: number[] = [];
  private tunnel: number[] = [];
  readonly ceilings: number[] = [];
  add(ax: number, ay: number, bx: number, by: number, lo: number, hi: number, kind: number, road: number, tunnel: boolean): void {
    if (Math.hypot(bx - ax, by - ay) < 0.02 || !(hi > lo)) return;
    this.seg.push(ax, ay, bx, by);
    this.lo.push(lo);
    this.hi.push(hi);
    this.kind.push(kind);
    this.road.push(road < 0 ? -1 : road);
    this.tunnel.push(tunnel ? 1 : 0);
  }
  /**
   * A wall whose foot and top run from (loA, hiA) at a to (loB, hiB) at b: in pieces of at most 2 m, each
   * spanning its own stretch (a long deck segment climbing 3 m never blocks a level it does not reach).
   */
  ramp(ax: number, ay: number, bx: number, by: number, loA: number, hiA: number, loB: number, hiB: number, kind: number, road: number, tunnel: boolean): void {
    const np = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 2));
    for (let q = 0; q < np; q++) {
      const f0 = q / np;
      const f1 = (q + 1) / np;
      const lo = Math.min(loA + (loB - loA) * f0, loA + (loB - loA) * f1);
      const hi = Math.max(hiA + (hiB - hiA) * f0, hiA + (hiB - hiA) * f1);
      this.add(ax + (bx - ax) * f0, ay + (by - ay) * f0, ax + (bx - ax) * f1, ay + (by - ay) * f1, lo, hi, kind, road, tunnel);
    }
  }
  /** The four sides of a box (as MeshGeo.box: centre, axis u with half-length hl, half-width hw across). */
  box(x: number, y: number, lo: number, hi: number, ux: number, uy: number, hl: number, hw: number, kind: number, road: number, tunnel: boolean): void {
    const vx = -uy;
    const vy = ux;
    const c = [
      [-hl, -hw],
      [hl, -hw],
      [hl, hw],
      [-hl, hw],
    ].map(([a, b]) => [x + ux * a + vx * b, y + uy * a + vy * b]);
    for (let i = 0; i < 4; i++) this.add(c[i][0], c[i][1], c[(i + 1) % 4][0], c[(i + 1) % 4][1], lo, hi, kind, road, tunnel);
  }
  result(): EdgeWalls {
    return {
      seg: Float32Array.from(this.seg),
      lo: Float32Array.from(this.lo),
      hi: Float32Array.from(this.hi),
      kind: Uint8Array.from(this.kind),
      road: Int32Array.from(this.road),
      tunnel: Uint8Array.from(this.tunnel),
      count: this.lo.length,
      ceilings: Float32Array.from(this.ceilings),
    };
  }
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
/** Tunnel portal headwalls: precast panels with a vertical ribbed formliner (see structMaterial). */
const PORTAL = [182, 177, 166];
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

/** Where segment a-b crosses segment q0-q1: the fraction along a-b, or -1. */
function segCross(ax: number, ay: number, bx: number, by: number, q0x: number, q0y: number, q1x: number, q1y: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const ex = q1x - q0x;
  const ey = q1y - q0y;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-9) return -1;
  const wx = q0x - ax;
  const wy = q0y - ay;
  const t = (wx * ey - wy * ex) / den;
  const u = (wx * dy - wy * dx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

export async function buildRoads(ctx: Ctx, field: TerrainField, stripMat: THREE.Material, progress: (f: number) => void): Promise<RoadsResult> {
  const { data, R } = ctx;
  const roads = data.roads;
  const infos = roads.map((r, i) => prepRoad(r, i));
  const index = new RoadIndex(roads, data.bounds);
  const tunnels = new RoadIndex(roads, data.bounds, (r) => r.tunnel);
  // station stopping bays (pipeline roads beside the busway, under the platform's edge)
  const bays = new RoadIndex(roads, data.bounds, (r) => !!r.bay);
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
  /** Inside a surface platform's slab outline (a deck edge under it is hidden by the slab). */
  const underSurfacePlatform = (x: number, y: number) =>
    gradePlatforms.some((q) => q.p.area && x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1 && pointInRing(x, y, q.p.pts));
  const portals: { x: number; y: number; z: number }[] = [];
  const wallLog = new WallLog();

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
  // mapped retaining walls (OSM barrier=retaining_wall) as segments in a 16 m grid, for earthworks()
  const MW_CELL = 16;
  const mwSeg: number[] = [];
  const mwCells = new Map<number, number[]>();
  const mwKey = (cx: number, cy: number) => (cx + 4096) * 8192 + cy + 4096;
  for (const w of data.retainingWalls ?? []) {
    for (let i = 0; i + 3 < w.length; i += 2) {
      const id = mwSeg.length / 4;
      mwSeg.push(w[i], w[i + 1], w[i + 2], w[i + 3]);
      for (let cx = Math.floor(Math.min(w[i], w[i + 2]) / MW_CELL); cx <= Math.floor(Math.max(w[i], w[i + 2]) / MW_CELL); cx++) {
        for (let cy = Math.floor(Math.min(w[i + 1], w[i + 3]) / MW_CELL); cy <= Math.floor(Math.max(w[i + 1], w[i + 3]) / MW_CELL); cy++) {
          const key = mwKey(cx, cy);
          const cell = mwCells.get(key);
          if (cell) cell.push(id);
          else mwCells.set(key, [id]);
        }
      }
    }
  }
  /**
   * The nearest mapped retaining wall the ray from (x, y) along the unit direction (dx, dy) crosses
   * between t0 and t1, among segments within 37 degrees of parallel to (tx, ty): [t, segment] or null.
   * With `only` >= 0, just that segment, its line extended up to `ext` m past either end.
   */
  const mappedWallRay = (x: number, y: number, dx: number, dy: number, tx: number, ty: number, t0: number, t1: number, only = -1, ext = 0): [number, number] | null => {
    let best: [number, number] | null = null;
    const test = (id: number) => {
      const ax = mwSeg[4 * id];
      const ay = mwSeg[4 * id + 1];
      const ex = mwSeg[4 * id + 2] - ax;
      const ey = mwSeg[4 * id + 3] - ay;
      const el = Math.hypot(ex, ey);
      if (el < 0.1 || Math.abs(ex * tx + ey * ty) / el < 0.8) return;
      const den = ex * dy - dx * ey;
      if (Math.abs(den) < 1e-9) return;
      const wx = ax - x;
      const wy = ay - y;
      const t = (ex * wy - wx * ey) / den;
      const u = (dx * wy - dy * wx) / den;
      const e = ext / el + 1e-6;
      if (u < -e || u > 1 + e || t < t0 || t > t1) return;
      if (!best || t < best[0]) best = [t, id];
    };
    if (only >= 0) {
      test(only);
      return best;
    }
    const seen = new Set<number>();
    const xa = x + dx * t0;
    const ya = y + dy * t0;
    const xb = x + dx * t1;
    const yb = y + dy * t1;
    for (let cx = Math.floor(Math.min(xa, xb) / MW_CELL); cx <= Math.floor(Math.max(xa, xb) / MW_CELL); cx++) {
      for (let cy = Math.floor(Math.min(ya, yb) / MW_CELL); cy <= Math.floor(Math.max(ya, yb) / MW_CELL); cy++) {
        for (const id of mwCells.get(mwKey(cx, cy)) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          test(id);
        }
      }
    }
    return best;
  };
  // the Story Bridge truss carries its own piers (landmarks.ts)
  const story = storyOutline(ctx);
  // ... and the Green Bridge's cable-stayed span its own pylons
  const green = greenBridgeSpan(ctx);
  const otherAt = (x: number, y: number, z: number, self: number, dz = 2.5) => index.penetrationZ(x, y, z, dz, self);
  /**
   * Over another carriageway (or its cutting wall, 1 m beyond its edge) 1.5-12 m below, in the open: a
   * busway ramp between the carriageways of a street, or a tunnel road's open approach cutting (over its
   * box the ground, a fill wall or a footpath stands on the roof). (12 m: the street over the Inner
   * Northern Busway's portal at Roma Street stands 9 m above it, and its fill wall ran across the ramp.)
   */
  const overOpen = (x: number, y: number, z: number, self: number) =>
    index.penetrationZ(x, y, z - 6.75, 5.25, self, (q) => !roads[q].tunnel) > -1.05 ||
    (tunnels.penetrationZ(x, y, z - 6.75, 5.25, self) > -1.05 && field.roofAt(x, y) === -Infinity);
  // Mater Hill and Buranda busway stations stand between buff block cutting walls on a dark base
  const blockSites: [number, number][] = [];
  for (const pf of ctx.data.platforms) if (/Mater Hill|Buranda/i.test(pf.name) && pf.pts.length >= 2) blockSites.push([pf.pts[0], pf.pts[1]]);
  const blockWall = (x: number, y: number) => blockSites.some(([px, py]) => Math.hypot(px - x, py - y) < 170);
  /** Ground height for strips and wall tops that meet the terrain: the settled ground, never below the natural one. */
  const groundAt = (x: number, y: number) => Math.max(field.natAt(x, y), field.settledAt(x, y));
  /**
   * Underside of the lowest road deck passing more than 3 m over (x, y) at height z (within its width
   * + 1 m), or Infinity: a cutting wall standing under it stops there.
   */
  const deckSoffit = (x: number, y: number, z: number) => {
    const a = index.lowestAbove(x, y, z + 3, 1.0);
    if (a.road < 0) return Infinity;
    const q = roads[a.road];
    return a.z - (q.kind <= RoadKind.Trunk || q.kind === RoadKind.Busway || q.bus ? 1.9 : 1.3);
  };
  /** Top of a cutting wall at offset `cut` beside road point c (road level z0): 0.9 m over the ground behind it, under any deck over it. */
  const cutTop = (c: { x: number; y: number; nx: number; ny: number }, side: number, cut: number, z0: number) => {
    const wx = c.x + c.nx * side * cut;
    const wy = c.y + c.ny * side * cut;
    const g = groundAt(c.x + c.nx * side * (cut + 0.5), c.y + c.ny * side * (cut + 0.5));
    return Math.max(z0 + 1.0, Math.min(Math.max(g + 0.9, z0 + 1.2), deckSoffit(wx, wy, z0)));
  };
  // bus routes (GTFS shapes) with their heights: a cutting wall opens where one crosses it
  const routeIdx = new RoadIndex(
    data.routes.map((rt) => ({ pts: rt.pts, z: rt.z ?? new Float32Array(rt.pts.length / 2), width: 0, tunnel: false }) as unknown as Road),
    data.bounds,
    () => true,
  );
  // railways on the ground (track bed 4.2 m wide): one crossing low over a tunnel's cutting closes it into a box
  const railIdx = new RoadIndex(
    data.rail.filter((rl) => !rl.bridge && !rl.tunnel).map((rl) => ({ pts: rl.pts, z: rl.z, width: 4.2, tunnel: false }) as unknown as Road),
    data.bounds,
    () => true,
  );
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
    // (mitred at a plain join with the next road, as its earthworks are: no sliver of ground between)
    const m0 = endMiter(ri, false);
    const m1 = endMiter(ri, true);
    for (let k = 0; k + 1 < ss.length; k++) {
      if (!cov[k] || !cov[k + 1]) continue;
      const A = k === 0 && m0 && ss[0] === 0 ? { ...P0[k], nx: m0[0], ny: m0[1] } : P0[k];
      const B = k + 2 === ss.length && m1 && ss[k + 1] >= ri.len - 0.01 ? { ...P0[k + 1], nx: m1[0], ny: m1[1] } : P0[k + 1];
      const o = wallOff + 0.6;
      const q = [A.x + A.nx * o, A.y + A.ny * o, A.z + hc[k] + 0.15, B.x + B.nx * o, B.y + B.ny * o, B.z + hc[k + 1] + 0.15, B.x - B.nx * o, B.y - B.ny * o, B.z + hc[k + 1] + 0.15, A.x - A.nx * o, A.y - A.ny * o, A.z + hc[k] + 0.15];
      // keep the ground (and terrain skirts) above the roof; earth faces and ground strips stop at it
      // (not under a platform's slab beside a portal: Mater Hill platform 2 ends at its mouth)
      field.protectQuad(q, 10, underSurfacePlatform);
      field.addRoof(q, Math.max(A.z + hc[k], B.z + hc[k + 1]) + 0.15);
    }
  }
  /** A ground strip's height at (x, y): never below the roof of a tunnel box there. */
  const stripZ = (x: number, y: number, z: number) => Math.max(z, field.roofAt(x, y) + 0.05);

  // Cutting floors out to a mapped retaining wall (earthPlan()), as quads [road, z, x0, y0, ... x3, y3]
  // in the 16 m grid, so that no other road's cutting wall stands on one (earthworks())
  const mwFloor: number[] = [];
  const mwFloorCells = new Map<number, number[]>();
  if (mwSeg.length) {
    for (const ri of infos) {
      const r = ri.r;
      if (ri.n < 2 || ri.len < 0.5 || r.tunnel || r.bridge || r.bay) continue;
      // (only a road passing near a mapped wall)
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0; i + 1 < r.pts.length; i += 2) {
        x0 = Math.min(x0, r.pts[i]);
        x1 = Math.max(x1, r.pts[i]);
        y0 = Math.min(y0, r.pts[i + 1]);
        y1 = Math.max(y1, r.pts[i + 1]);
      }
      const R = ri.hw + 8;
      let near = false;
      for (let cx = Math.floor((x0 - R) / MW_CELL); cx <= Math.floor((x1 + R) / MW_CELL) && !near; cx++) {
        for (let cy = Math.floor((y0 - R) / MW_CELL); cy <= Math.floor((y1 + R) / MW_CELL) && !near; cy++) near = mwCells.has(mwKey(cx, cy));
      }
      if (!near) continue;
      const ss = gradeSamples(ri);
      for (const side of [1, -1]) {
        const { P, e0, mwShift, mwEnd } = earthPlan(ri, side, ss, footPlan(ri, side, ss).foot);
        for (let k = 0; k + 1 < ss.length; k++) {
          if (!(mwShift[k] > 0)) continue;
          const A = P[k];
          const B = P[k + 1];
          const oa = e0[k] + 0.6;
          const ob = e0[k + 1] + mwEnd[k + 1] + 0.6;
          const q = [A.x + A.nx * side * ri.hw, A.y + A.ny * side * ri.hw, B.x + B.nx * side * ri.hw, B.y + B.ny * side * ri.hw, B.x + B.nx * side * ob, B.y + B.ny * side * ob, A.x + A.nx * side * oa, A.y + A.ny * side * oa];
          const id = mwFloor.length;
          mwFloor.push(ri.i, (A.z + B.z) / 2, ...q);
          let qx0 = Infinity;
          let qy0 = Infinity;
          let qx1 = -Infinity;
          let qy1 = -Infinity;
          for (let v = 0; v < 8; v += 2) {
            qx0 = Math.min(qx0, q[v]);
            qx1 = Math.max(qx1, q[v]);
            qy0 = Math.min(qy0, q[v + 1]);
            qy1 = Math.max(qy1, q[v + 1]);
          }
          for (let cx = Math.floor(qx0 / MW_CELL); cx <= Math.floor(qx1 / MW_CELL); cx++) {
            for (let cy = Math.floor(qy0 / MW_CELL); cy <= Math.floor(qy1 / MW_CELL); cy++) {
              const key = mwKey(cx, cy);
              const cell = mwFloorCells.get(key);
              if (cell) cell.push(id);
              else mwFloorCells.set(key, [id]);
            }
          }
        }
      }
    }
  }
  /** On another road's cutting floor out to a mapped retaining wall, within 2 m of its level. */
  const onMappedFloor = (x: number, y: number, z: number, self: number) => {
    for (const id of mwFloorCells.get(mwKey(Math.floor(x / MW_CELL), Math.floor(y / MW_CELL))) ?? []) {
      if (mwFloor[id] === self || Math.abs(mwFloor[id + 1] - z) > 2) continue;
      let inside = false;
      for (let a = 0, b = 3; a < 4; b = a++) {
        const ax = mwFloor[id + 2 + 2 * a];
        const ay = mwFloor[id + 3 + 2 * a];
        const bx = mwFloor[id + 2 + 2 * b];
        const by = mwFloor[id + 3 + 2 * b];
        if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  };

  for (let ri0 = 0; ri0 < infos.length; ri0++) {
    const ri = infos[ri0];
    const r = ri.r;
    if (ri.n < 2 || ri.len < 0.5) continue;
    const mid = roadAt(ri, ri.len / 2);
    const L = layerFor(mid.x, mid.y);
    const hw = ri.hw;
    const lift = ri.lift;
    const tp = tubePreps.get(ri.i) ?? null;
    const surf = r.bay ? 3 : r.kind === RoadKind.Pedestrian ? 2 : r.bus ? 1 : r.kind === RoadKind.Motorway ? 6 : r.kind === RoadKind.Service ? 5 : 0;

    // ---- asphalt ribbon (and terrain clamp under at-grade roads)
    {
      const g = L.asphalt;
      let prevL = -1;
      let prevR = -1;
      let pq: number[] | null = null;
      // (mitred at a plain join with the next road, as the earthworks and a tunnel box's footprint are: the
      // surface's own clamp and carve then meet the next road's on one line, with no sliver of ground
      // left standing between them on the outside of the bend)
      const em0 = endMiter(ri, false);
      const em1 = endMiter(ri, true);
      for (const [ra, rb, inBox] of tubeRuns(tp, 0, ri.len)) walkRun(ri, ra, rb, (x, yy, z, nx0, ny0, s) => {
        const em = s <= 1e-3 ? em0 : s >= ri.len - 1e-3 ? em1 : null;
        const nx2 = em ? em[0] : nx0;
        const ny2 = em ? em[1] : ny0;
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
        // a dead end where the ground falls away (a street ending at a river bank, Park Avenue): a batter
        // round the bulb down to the ground, so its rim never floats over the slope
        if (!r.tunnel && !r.bridge && nodes.get(nodeKey(cx, cy))?.deg === 1) {
          const ring: [number, number, number, number, number][] = [];
          let low = false;
          let clash = false;
          for (let k = 0; k <= segs; k++) {
            const t = -Math.PI / 2 + (k / segs) * Math.PI;
            const dx = ux * Math.cos(t) - uy * Math.sin(t);
            const dy = ux * Math.sin(t) + uy * Math.cos(t);
            const drop = cz - field.natAt(cx + dx * (hw + 3), cy + dy * (hw + 3));
            const w = clamp(2.5 + 1.6 * Math.abs(drop), 3, 9);
            const ox = cx + dx * (hw + w);
            const oy = cy + dy * (hw + w);
            const oz = stripZ(ox, oy, field.natAt(ox, oy));
            if (oz < cz - 0.4) low = true;
            // (never over another road there)
            if (otherAt(ox, oy, cz, ri.i, 4) > -0.5 || otherAt(cx + dx * (hw + w / 2), cy + dy * (hw + w / 2), cz, ri.i, 4) > -0.5) clash = true;
            ring.push([dx, dy, ox, oy, Math.min(oz, cz)]);
          }
          if (low && !clash) {
            const sg = L.strip;
            let pi = -1;
            let po = -1;
            for (let k = 0; k <= segs; k++) {
              const [dx, dy, ox, oy, oz] = ring[k];
              const ii = sg.vert(cx + dx * hw, cz + lift - 0.02, cy + dy * hw);
              const io = sg.vert(ox, oz, oy);
              if (pi >= 0) {
                sg.quad(pi, ii, io, po, 0, 1, 0);
                const [pdx, pdy, pox, poy, poz] = ring[k - 1];
                field.clampQuad([cx + pdx * hw, cy + pdy * hw, cz, cx + dx * hw, cy + dy * hw, cz, ox, oy, oz, pox, poy, poz], 0.25);
              }
              pi = ii;
              po = io;
            }
          }
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
      // station bays: no lines of their own (the busway's edge line separates the stopping lane)
      if (!r.bay && r.kind !== RoadKind.Pedestrian && r.kind !== RoadKind.Residential && (r.kind !== RoadKind.Service || r.bus)) {
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
      if ((r.kind === RoadKind.Busway || r.bus) && !r.bay && ri.len > 40) {
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
    } else if (!r.bay) {
      // (a station bay's platform side is the platform; its busway side is the busway)
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
        if (ss.length > 1 && ss[ss.length - 1] >= ri.len - 0.5) ss[ss.length - 1] = ri.len;
        else if (ss[ss.length - 1] < ri.len) ss.push(ri.len);
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
  // ---- nor through a platform's slab
  platformCuts();

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
  const tubeMat = tubeMaterial(ctx, makeTunnelSignTexture());
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
  return { infos, index, tunnels, portals, tubes: tubesBuilt.map((b) => ({ road: b.ri.i, tp: b.tp, open: b.open })), walls: wallLog.result() };

  // =========================================================================
  // helpers (hoisted function declarations close over the locals above)

  /** At-grade road: footpaths, then the earthworks on each side. */
  function buildAtGrade(ri: RI, L: Layer, skips: [number, number][]): void {
    const ss = gradeSamples(ri);
    for (const side of [1, -1]) {
      const { foot, runs } = footPlan(ri, side, ss);
      for (const [a, b, w, style] of runs) footRun(L.foot, ri, a, b, side, w, style);
      earthworks(ri, L, side, ss, foot, skips);
    }
  }

  /** An at-grade road's earthworks samples: every 4 m, the last exactly at its end. */
  function gradeSamples(ri: RI): number[] {
    const step = 4;
    const ss: number[] = [];
    for (let s = 0; s <= ri.len + 0.01; s += step) ss.push(Math.min(s, ri.len));
    // (the last sample exactly at the end: the earthworks meet the next road's at the mitre line)
    if (ss.length > 1 && ss[ss.length - 1] >= ri.len - 0.5) ss[ss.length - 1] = ri.len;
    else if (ss[ss.length - 1] < ri.len) ss.push(ri.len);
    return ss;
  }

  /**
   * The footpath on one side of an at-grade road: its width at each sample (0 for none), and its runs
   * [from, to, width, style] for footRun().
   */
  function footPlan(ri: RI, side: number, ss: number[]): { foot: number[]; runs: [number, number, number, number][] } {
    const r = ri.r;
    const hw = ri.hw;
    const footKinds = r.kind >= RoadKind.Primary && r.kind <= RoadKind.Residential && !r.link;
    const expressway = r.kind === RoadKind.Trunk && r.oneway && r.lanes >= 3;
    const wantFoot = (footKinds || (r.kind === RoadKind.Trunk && !r.link)) && !expressway;
    const runs: [number, number, number, number][] = [];
    // footpath validity per sample
    const foot: number[] = ss.map((s) => {
      if (!wantFoot) return 0;
      const c = roadAt(ri, s);
      for (const off of [hw + 0.35, hw + 2.2, hw + 3.9]) {
        const qx = c.x + c.nx * side * off;
        const qy = c.y + c.ny * side * off;
        if (otherAt(qx, qy, c.z, ri.i) > -0.25 || inWater(qx, qy) || overOpen(qx, qy, c.z, ri.i)) return 0;
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
        runs.push([a, b, w, style]);
        for (let q = k; q <= e; q++) foot[q] = w;
      } else for (let q = k; q <= e; q++) foot[q] = 0;
      k = e + 1;
    }
    return { foot, runs };
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
   * Far edge of the station bay pavement alongside a busway, along the ray from (x, y) in the unit
   * direction (dx, dy): a bay that starts within 1 m of the carriageway edge `hw`, followed out to where
   * it ends (it widens beside the platform and tapers away beyond its ends). -1 if there is none.
   */
  function bayFar(x: number, y: number, z: number, dx: number, dy: number, hw: number): number {
    let last = -1;
    for (let o = hw - 0.25; o <= hw + 14; o += 0.25) {
      if (bays.penetrationZ(x + dx * o, y + dy * o, z, 1.2) > 0.05) last = o;
      else if (last > 0 || o > hw + 1) break;
    }
    return last;
  }

  /**
   * The ground beside one side of an at-grade road at the samples `ss`, before earthworks() looks at its
   * neighbours: where the earthworks start (`e0`, out to the cutting wall's line on a mapped retaining
   * wall), the edge height, the natural ground's depth and the profile it asks for (`raw`).
   */
  function earthPlan(ri: RI, side: number, ss: number[], foot: number[]) {
    const r = ri.r;
    const hw = ri.hw;
    const n = ss.length;
    const e0 = new Float32Array(n);
    const zE = new Float32Array(n);
    const P = ss.map((s) => roadAt(ri, s));
    // tunnel roads this one runs straight on into at an end (a portal approach): not a neighbour
    const straightOn = new Set<number>();
    // (and the road it runs straight on into at grade: its own earthworks take over at the join)
    const straightOnGrade = new Set<number>();
    // (and every road meeting it at its start, and at its end, and the tunnels within 15 m of either)
    const endNb = [new Set<number>(), new Set<number>()];
    if (ri.i >= 0) {
      const p = r.pts;
      for (const v of [0, ri.n - 1]) {
        const w = v === 0 ? 1 : ri.n - 2;
        const ex = p[2 * v];
        const ey = p[2 * v + 1];
        const ax = p[2 * w] - ex;
        const ay = p[2 * w + 1] - ey;
        const visit = (set: Set<number>) => (q: number) => {
          const t = roads[q].pts;
          const m = t.length >> 1;
          const at0 = Math.hypot(t[0] - ex, t[1] - ey) < 0.05;
          const at1 = Math.hypot(t[2 * m - 2] - ex, t[2 * m - 1] - ey) < 0.05;
          if (!at0 && !at1) return;
          const bx = at0 ? t[2] - t[0] : t[2 * m - 4] - t[2 * m - 2];
          const by = at0 ? t[3] - t[1] : t[2 * m - 3] - t[2 * m - 1];
          // (both pointing away from the shared node: straight on when nearly opposite)
          if ((ax * bx + ay * by) / ((Math.hypot(ax, ay) || 1) * (Math.hypot(bx, by) || 1)) < -0.7) set.add(q);
        };
        tunnels.roadsNear(ex, ey, 0.05, visit(straightOn));
        index.roadsNear(ex, ey, 0.05, visit(straightOnGrade));
        index.roadsNear(ex, ey, 0.05, (q) => endNb[v === 0 ? 0 : 1].add(q));
        tunnels.roadsNear(ex, ey, 15, (q) => endNb[v === 0 ? 0 : 1].add(q));
      }
    }
    const m0 = endMiter(ri, false);
    const m1 = endMiter(ri, true);
    if (m0 && ss[0] === 0) P[0] = { ...P[0], nx: m0[0], ny: m0[1] };
    if (m1 && ss[n - 1] === ri.len) P[n - 1] = { ...P[n - 1], nx: m1[0], ny: m1[1] };
    // A station platform beside a busway: the batter or cutting wall stands behind it, with the stopping
    // bay and the platform's footprint level with the road in front (from one sample before each
    // platform end on, so a cutting wall never cuts across the platform's corner); beyond the platform's
    // ends it stands behind the bay as it tapers back into the busway.
    let pfar: Float32Array | null = null;
    if (r.kind === RoadKind.Busway && !r.bay) {
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
      // (only a platform or bay on our side: one beyond the other carriageway of a dual busway is its)
      const carriageway = (q: number) => !roads[q].bay && roads[q].kind !== RoadKind.Pedestrian;
      const far = (c: ReturnType<typeof roadAt>) => {
        const dx = c.nx * side;
        const dy = c.ny * side;
        const f = Math.max(platformFar(c.x, c.y, dx, dy, hw), bayFar(c.x, c.y, c.z, dx, dy, hw));
        for (let o = hw + 0.5; o < f - 0.3; o += 0.5) if (index.penetrationZ(c.x + dx * o, c.y + dy * o, c.z, 1.5, ri.i, carriageway) > 0.3) return -1;
        return f;
      };
      const nearBay = P.some((c) => bays.nearest(c.x, c.y, R) !== null);
      if (nearBay || gradePlatforms.some((g) => g.x0 < rx1 + R && g.x1 > rx0 - R && g.y0 < ry1 + R && g.y1 > ry0 - R)) {
        const at0 = ss.map((s) => far(roadAt(ri, s)));
        if (at0.some((v) => v > 0)) {
          pfar = new Float32Array(n).fill(-1);
          for (let k = 0; k < n; k++) {
            const sa = ss[Math.max(0, k - 1)];
            const sb = ss[Math.min(n - 1, k + 1)];
            if (Math.max(at0[Math.max(0, k - 1)], at0[k], at0[Math.min(n - 1, k + 1)]) <= 0 && sb - sa < 12) continue;
            const steps = Math.max(1, Math.ceil((sb - sa) / 0.5));
            for (let q = 0; q <= steps; q++) pfar[k] = Math.max(pfar[k], far(roadAt(ri, sa + ((sb - sa) * q) / steps)));
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
    // A retaining wall mapped beside the road (OSM barrier=retaining_wall), nearly parallel to it and a
    // little further out than the cutting wall would stand (0.4-5 m): the cutting wall is that wall, with
    // the floor level with the road out to it (behind Cultural Centre platform 3 it stands 8 m out, behind
    // the station's paving, not on it). Past the mapped wall's ends, within the same cutting, its line runs
    // on for up to 12 m rather than the wall stepping back in toward the lanes. Not behind a footpath (the
    // wall stands at its back edge), nor where another carriageway or water lies in between (a road
    // meeting this one at an end may: the wall stops at its edge, or turns to the jamb of a tunnel portal
    // there, as at the turn into the Cultural Centre tunnel).
    const mwShift = new Float32Array(n);
    // (and where a cutting on the mapped line ends, the offset its last wall piece runs out to: the mapped
    // line still, not slanting back in to where the batter beyond it starts)
    const mwEnd = new Float32Array(n);
    if (mwSeg.length && !r.tunnel) {
      const hitSeg = new Int32Array(n).fill(-1);
      const clearTo = (k: number, dx: number, dy: number, to: number) => {
        const c = P[k];
        // (within 12 m of an end, the roads meeting it there)
        const near0 = ss[k] < 12;
        const near1 = ss[k] > ri.len - 12;
        const between = (q: number) => !roads[q].bay && roads[q].kind !== RoadKind.Pedestrian && !(near0 && endNb[0].has(q)) && !(near1 && endNb[1].has(q));
        for (let o = hw + 0.5; o < to - 0.3; o += 0.5) {
          const qx = c.x + dx * o;
          const qy = c.y + dy * o;
          if (inWater(qx, qy)) return false;
          if (index.penetrationZ(qx, qy, c.z, 1.5, ri.i, between) > 0.3) return false;
          if (tunnels.penetrationZ(qx, qy, c.z, 1.5, ri.i, (q) => !straightOn.has(q) && between(q)) > 0.3) return false;
        }
        return true;
      };
      const shiftAt = (k: number, only: number, ext: number): [number, number] | null => {
        if (foot[k] > 0) return null;
        const c = P[k];
        const fl = Math.hypot(c.nx, c.ny) || 1;
        const dx = (c.nx * side) / fl;
        const dy = (c.ny * side) / fl;
        const f0 = e0[k] + 0.6;
        // (the mapped line is the wall's middle: its face toward the road 0.2 m nearer)
        const h = mappedWallRay(c.x, c.y, dx, dy, -dy, dx, f0 + 0.6, f0 + 5.2, only, ext);
        if (!h || !clearTo(k, dx, dy, h[0] - 0.2)) return null;
        return [h[0] - 0.2 - f0, h[1]];
      };
      const tryAt = (k: number, only: number, ext: number) => {
        if (raw[k] !== 2) return;
        const h = shiftAt(k, only, ext);
        if (h) [mwShift[k], hitSeg[k]] = h;
      };
      for (let k = 0; k < n; k++) tryAt(k, -1, 0);
      if (hitSeg.some((v) => v >= 0)) {
        for (let k = 0; k < n; k++) {
          if (raw[k] !== 2 || hitSeg[k] >= 0) continue;
          let best = -1;
          for (let j = k - 1; j >= 0 && raw[j] === 2 && ss[k] - ss[j] <= 12; j--) {
            if (hitSeg[j] >= 0) {
              best = j;
              break;
            }
          }
          for (let j = k + 1; j < n && raw[j] === 2 && ss[j] - ss[k] <= 12; j++) {
            if (hitSeg[j] >= 0) {
              if (best < 0 || ss[j] - ss[k] < ss[k] - ss[best]) best = j;
              break;
            }
          }
          if (best >= 0) tryAt(k, hitSeg[best], 12);
        }
        for (let k = 0; k + 1 < n; k++) {
          if (hitSeg[k] < 0 || raw[k + 1] === 2) continue;
          const h = shiftAt(k + 1, hitSeg[k], 12);
          mwEnd[k + 1] = h ? h[0] : mwShift[k];
        }
        for (let k = 0; k < n; k++) e0[k] += mwShift[k];
      }
    }
    return { P, e0, zE, depth, raw, pfar, mwShift, mwEnd, straightOn, straightOnGrade };
  }

  /**
   * Shoulders / retaining walls / cuttings on one side of an at-grade road.
   * Profile types per sample: 0 none (junction), 1 batter, 2 cutting wall, 3 fill wall, 4 open cutting.
   */
  function earthworks(ri: RI, L: Layer, side: number, ss: number[], foot: number[], skips: [number, number][]): void {
    const r = ri.r;
    const hw = ri.hw;
    const n = ss.length;
    const type = new Uint8Array(n);
    const { P, e0, zE, depth, raw, pfar, mwShift, mwEnd, straightOn, straightOnGrade } = earthPlan(ri, side, ss, foot);
    const tubeNbAt = new Uint8Array(n);
    // (and a carriageway at grade level with us there: the gore between two busways meeting at Cultural Centre)
    const gradeNbAt = new Uint8Array(n);
    const gradeNb = (q: number) => !roads[q].tunnel && roads[q].kind !== RoadKind.Pedestrian && !straightOnGrade.has(q);
    for (let k = 0; k < n; k++) {
      const c = P[k];
      const ox = (off: number) => c.x + c.nx * side * off;
      const oy = (off: number) => c.y + c.ny * side * off;
      const t = raw[k];
      // in a junction, or another carriageway right beside us: leave it to the neighbour
      const inJ = skips.some(([a, b]) => ss[k] > a && ss[k] < b);
      const probe = t === 2 ? e0[k] + 0.3 : e0[k] + 1.5;
      // (a tunnel carriageway level with us counts too: the SEB's cutting wall at Woolloongabba ran on
      // into the tube's lanes where the busway turns into it)
      tubeNbAt[k] = tunnels.penetrationZ(ox(e0[k] + 0.3), oy(e0[k] + 0.3), c.z, 1.5, ri.i, (q) => !straightOn.has(q)) > -0.4 ? 1 : 0;
      gradeNbAt[k] = index.penetrationZ(ox(e0[k] + 0.3), oy(e0[k] + 0.3), c.z, 1.5, ri.i, gradeNb) > -0.4 ? 1 : 0;
      const nb =
        otherAt(ox(probe), oy(probe), c.z, ri.i, 3) > -0.4 ||
        (t === 2 && tubeNbAt[k] === 1) ||
        tunnels.penetrationZ(ox(probe), oy(probe), c.z, 1.5, ri.i, (q) => !straightOn.has(q)) > -0.4 ||
        (t === 1 && otherAt(ox(e0[k] + 5), oy(e0[k] + 5), c.z, ri.i, 3) > -0.4);
      // a batter would run down into the space of a road passing 2-8 m below (a street over a busway
      // portal): none there, the lower road's own earthworks and tunnel hold the ground (a batter
      // climbing to the ground above stays, as over the tunnels under King George Square)
      const lower = (o: number) => Math.max(index.penetrationZ(ox(o), oy(o), zE[k] - 5, 3, ri.i), tunnels.penetrationZ(ox(o), oy(o), zE[k] - 5, 3, ri.i)) > -1;
      const below = t === 1 && depth[k] < 0.3 && (lower(e0[k] + 1.5) || lower(e0[k] + 4));
      // likewise a fill wall that would stand in a lower road's cutting: that road's wall holds the ground
      const onLower = t === 3 && overOpen(ox(e0[k] + 0.3), oy(e0[k] + 0.3), zE[k], ri.i);
      if (nb || below || onLower || (inJ && t !== 2)) type[k] = 0;
      else type[k] = t;
      if (t === 2 && (nb || inJ)) type[k] = 4; // cutting but open toward a neighbour: floor only
    }
    // A cutting wall that would stand on another road's floor out to a mapped retaining wall (on the
    // inside of a turn off a busway whose wall stands on the mapped line, as into the Cultural Centre
    // tunnel): that floor runs on to the mapped wall, so here the cutting is open
    if (mwFloor.length) {
      for (let k = 0; k + 1 < n; k++) {
        if (type[k] !== 2 || mwShift[k] > 0) continue;
        const A = P[k];
        const B = P[k + 1];
        const ax = A.x + A.nx * side * (e0[k] + 0.6);
        const ay = A.y + A.ny * side * (e0[k] + 0.6);
        const bx = B.x + B.nx * side * (e0[k + 1] + mwEnd[k + 1] + 0.6);
        const by = B.y + B.ny * side * (e0[k + 1] + mwEnd[k + 1] + 0.6);
        let on = 0;
        for (const f of [0, 0.5, 1]) if (onMappedFloor(ax + (bx - ax) * f, ay + (by - ay) * f, A.z + (B.z - A.z) * f, ri.i)) on++;
        if (on >= 2) type[k] = 4;
      }
    }
    // (an open stretch keeps its own floor's width unless it runs on from a wall on the mapped line)
    for (let k = 0; k < n; k++) {
      if (mwShift[k] > 0 && type[k] !== 2 && !(k > 0 && type[k - 1] === 2 && mwShift[k - 1] > 0) && !(k + 1 < n && type[k + 1] === 2 && mwShift[k + 1] > 0)) e0[k] -= mwShift[k];
    }
    const eW = Float32Array.from(e0, (v, k) => v + mwEnd[k]);
    /**
     * The jamb of a tunnel portal (the tube's wall line at its end) within 6 m of the wall at sample k,
     * that lies alongside the road before sample k + 1: [s, e] for cutSeg(), its wall face there. Null if
     * there is none.
     */
    const portalJamb = (k: number): [number, number] | null => {
      const A = P[k];
      const B = P[k + 1];
      const wx = A.x + A.nx * side * (e0[k] + 0.6);
      const wy = A.y + A.ny * side * (e0[k] + 0.6);
      let jx = 0;
      let jy = 0;
      let jd = 6;
      tunnels.roadsNear(B.x, B.y, 15, (q) => {
        if (straightOn.has(q)) return;
        const qi = infos[q];
        for (const atEnd of [false, true]) {
          const c = roadAt(qi, atEnd ? qi.len : 0);
          if (Math.hypot(c.x - B.x, c.y - B.y) > 15) continue;
          const m = endMiter(qi, atEnd) ?? [c.nx, c.ny];
          for (const sd of [1, -1]) {
            const x = c.x + m[0] * sd * (qi.hw + 0.9);
            const y = c.y + m[1] * sd * (qi.hw + 0.9);
            const d = Math.hypot(x - wx, y - wy);
            if (d < jd) [jd, jx, jy] = [d, x, y];
          }
        }
      });
      if (jd >= 6) return null;
      // (where along the road its normal passes through the jamb, and how far out)
      const along = (s: number) => {
        const c = roadAt(ri, s);
        return ((jx - c.x) * c.ny - (jy - c.y) * c.nx) / (Math.hypot(c.nx, c.ny) || 1);
      };
      let s0 = ss[k];
      let s1 = ss[k + 1];
      if (along(s0) < 0 || along(s1) > 0) return null;
      for (let it = 0; it < 16; it++) {
        const s = (s0 + s1) / 2;
        if (along(s) > 0) s0 = s;
        else s1 = s;
      }
      const s = (s0 + s1) / 2;
      const c = roadAt(ri, s);
      const e = (((jx - c.x) * c.nx + (jy - c.y) * c.ny) * side) / (c.nx * c.nx + c.ny * c.ny || 1) - 0.6;
      return s - ss[k] > 0.3 && e > hw + 0.5 ? [s, e] : null;
    };
    // a cutting wall piece that would end inside such a tunnel's lanes stops where it meets them
    const g = L.strip;
    const st = L.struct;
    const at = (c: (typeof P)[number], off: number) => [c.x + c.nx * side * off, c.y + c.ny * side * off] as const;
    const shoulderW = (k: number) => clamp(2.5 + 1.6 * Math.abs(field.natAt(...at(P[k], e0[k] + 3)) - zE[k]), 3, 9);
    // a bus route crossing the line of a cutting wall at its level (a link the map's junctions miss): no
    // wall there, nor a few metres either side (more where it crosses at a shallow angle), floor only
    if (ri.i >= 0 && type.includes(2)) {
      const span = (k: number) => {
        const zk = zE[k] - (foot[k] > 0 ? KERB_H : 0.02);
        const zk1 = zE[k + 1] - (foot[k + 1] > 0 ? KERB_H : 0.02);
        return [Math.min(P[k].z, P[k + 1].z) - 0.4, Math.max(cutTop(P[k], side, e0[k] + 0.6, zk), cutTop(P[k + 1], side, eW[k + 1] + 0.6, zk1))];
      };
      const cross: number[] = [];
      for (let k = 0; k + 1 < n; k++) {
        if (type[k] !== 2) continue;
        const [ax, ay] = at(P[k], e0[k] + 0.6);
        const [bx, by] = at(P[k + 1], eW[k + 1] + 0.6);
        const [lo, hi] = span(k);
        routeIdx.roadsNear((ax + bx) / 2, (ay + by) / 2, Math.hypot(bx - ax, by - ay) / 2 + 0.5, (_q, sg) => {
          const S = routeIdx.seg;
          const qx0 = S[4 * sg];
          const qy0 = S[4 * sg + 1];
          const qx1 = S[4 * sg + 2];
          const qy1 = S[4 * sg + 3];
          const u = segCross(ax, ay, bx, by, qx0, qy0, qx1, qy1);
          if (u < 0) return;
          const cx = ax + (bx - ax) * u;
          const cy = ay + (by - ay) * u;
          const ql = Math.hypot(qx1 - qx0, qy1 - qy0) || 1;
          const f = Math.min(1, Math.max(0, ((cx - qx0) * (qx1 - qx0) + (cy - qy0) * (qy1 - qy0)) / (ql * ql)));
          const zq = routeIdx.segZ[2 * sg] + (routeIdx.segZ[2 * sg + 1] - routeIdx.segZ[2 * sg]) * f;
          if (zq + 3.6 <= lo || zq >= hi) return;
          const sin = Math.abs((bx - ax) * (qy1 - qy0) - (by - ay) * (qx1 - qx0)) / ((Math.hypot(bx - ax, by - ay) || 1) * ql);
          cross.push(cx, cy, zq, Math.min(20, 4 + 3 / Math.max(0.15, sin)));
        });
      }
      for (let k = 0; k + 1 < n && cross.length; k++) {
        if (type[k] !== 2) continue;
        const [ax, ay] = at(P[k], e0[k] + 0.6);
        const [bx, by] = at(P[k + 1], eW[k + 1] + 0.6);
        const [lo, hi] = span(k);
        for (let q = 0; q < cross.length; q += 4) {
          if (Math.hypot(cross[q] - (ax + bx) / 2, cross[q + 1] - (ay + by) / 2) < cross[q + 3] && cross[q + 2] + 3.6 > lo && cross[q + 2] < hi) {
            type[k] = 4;
            break;
          }
        }
      }
    }
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
        // (and the ground never pokes up through it between the grid vertices: the platform stands on it)
        if (!r.tunnel) surfQuads.push(h0x, h0y, A.z - 0.02, h1x, h1y, B.z - 0.02, q1x, q1y, B.z - 0.02, q0x, q0y, A.z - 0.02, 0);
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
      } else if (t === 2 && (tubeNbAt[k + 1] || gradeNbAt[k + 1])) {
        // (the wall stops where the outer corner of its box reaches the tunnel's tube wall line, hw + 0.9,
        // or the edge of a carriageway at grade)
        const inside = (f: number) => {
          const c = roadAt(ri, ss[k] + (ss[k + 1] - ss[k]) * f);
          const o = e0[k] + (eW[k + 1] - e0[k]) * f + 1.05;
          const ix = c.x + c.nx * side * o;
          const iy = c.y + c.ny * side * o;
          return (
            tunnels.penetrationZ(ix, iy, c.z, 1.5, ri.i, (q) => !straightOn.has(q)) > -0.9 ||
            index.penetrationZ(ix, iy, c.z, 1.5, ri.i, gradeNb) > 0
          );
        };
        let f0 = 0;
        let f1 = 1;
        if (inside(0)) f1 = 0;
        else for (let it = 0; it < 12; it++) inside((f0 + f1) / 2) ? (f1 = (f0 + f1) / 2) : (f0 = (f0 + f1) / 2);
        let sm = ss[k] + (ss[k + 1] - ss[k]) * f0;
        let em = e0[k] + (eW[k + 1] - e0[k]) * f0;
        // (a wall on a mapped line running on past the mapped wall's end into a tunnel portal turns to meet
        // the tube's wall at the portal instead, along the portal's headwall: the Cultural Centre tunnel)
        const j = mwShift[k] > 0 && mwEnd[k + 1] > 0 ? portalJamb(k) : null;
        if (j) {
          [sm, em] = j;
          f0 = (sm - ss[k]) / (ss[k + 1] - ss[k]);
        }
        const fm = f0 < 0.5 ? foot[k] : foot[k + 1];
        const M = roadAt(ri, sm);
        if (sm - ss[k] > 0.3) cutSeg(L, A, M, side, ss[k], sm, foot[k], fm, e0[k], em, hw, true, (k === 0 || type[k - 1] !== 2 ? 1 : 0) | 2, ri.i);
        cutSeg(L, sm - ss[k] > 0.3 ? M : A, B, side, sm - ss[k] > 0.3 ? sm : ss[k], ss[k + 1], sm - ss[k] > 0.3 ? fm : foot[k], foot[k + 1], sm - ss[k] > 0.3 ? em : e0[k], eW[k + 1], hw, false, 0, ri.i);
      } else if (t === 2 || t === 4) {
        const ends = t === 2 ? (k === 0 || type[k - 1] !== 2 ? 1 : 0) | (k + 2 >= n || type[k + 1] !== 2 || tubeNbAt[k + 2] || gradeNbAt[k + 2] ? 2 : 0) : 0;
        cutSeg(L, A, B, side, ss[k], ss[k + 1], foot[k], foot[k + 1], e0[k], eW[k + 1], hw, t === 2, ends, ri.i);
      } else if (t === 3) {
        // high fill: retaining wall from a parapet down to the ground
        const [w0x, w0y] = at(A, e0[k] + 0.1);
        const [w1x, w1y] = at(B, e0[k + 1] + 0.1);
        const [o0x, o0y] = at(A, e0[k] + 0.5);
        const [o1x, o1y] = at(B, e0[k + 1] + 0.5);
        // (none where the stretch between two samples passes over a lower road's open cutting, as
        // at a sample: a railway crossing a busway right at its tunnel mouth)
        if ([0.25, 0.5, 0.75].some((f) => overOpen(w0x + (w1x - w0x) * f, w0y + (w1y - w0y) * f, zE[k] + (zE[k + 1] - zE[k]) * f, ri.i) || overOpen(o0x + (o1x - o0x) * f, o0y + (o1y - o0y) * f, zE[k] + (zE[k + 1] - zE[k]) * f, ri.i))) continue;
        const ta = zE[k] + 0.9;
        const tb = zE[k + 1] + 0.9;
        // (over a tunnel's box the wall stands on its roof, never down through it)
        const bottom = (f: number) => {
          const x = o0x + (o1x - o0x) * f;
          const y = o0y + (o1y - o0y) * f;
          return Math.min(Math.max(field.natAt(x, y) - 0.8, field.roofAt(x, y) + 0.05), ta + (tb - ta) * f - 0.3);
        };
        const ga = bottom(0);
        const gb = bottom(1);
        const v0 = st.vert(w0x, zE[k], w0y, ...CONC);
        const v1 = st.vert(w1x, zE[k + 1], w1y, ...CONC);
        const v2 = st.vert(w1x, tb, w1y, ...CONC);
        const v3 = st.vert(w0x, ta, w0y, ...CONC);
        st.quad(v0, v1, v2, v3, -fx, 0, fy);
        const u0 = st.vert(o0x, ta, o0y, ...CONC);
        const u1 = st.vert(o1x, tb, o1y, ...CONC);
        st.quad(v3, v2, u1, u0, 0, 1, 0);
        wallLog.ramp(w0x, w0y, w1x, w1y, zE[k] - 0.4, ta, zE[k + 1] - 0.4, tb, EW_PARAPET, ri.i, false);
        // and its outer face, down to the ground; where the stretch runs from in front of a tunnel's portal
        // onto its box (a street over the mouth whose footpath ends there: Laura Street at the Eastern
        // Busway), the face steps up onto the roof at the box's edge rather than hanging down into the mouth
        const inBox = (f: number) => field.roofAt(o0x + (o1x - o0x) * f, o0y + (o1y - o0y) * f) > -Infinity;
        let fm = -1;
        if (inBox(0) !== inBox(1)) {
          const i0 = inBox(0);
          let lo = 0;
          let hi = 1;
          for (let it = 0; it < 14; it++) {
            const m = (lo + hi) / 2;
            if (inBox(m) === i0) lo = m;
            else hi = m;
          }
          fm = (lo + hi) / 2;
        }
        if (fm < 0) {
          st.quad(st.vert(o0x, ga, o0y, ...WALL), st.vert(o1x, gb, o1y, ...WALL), u1, u0, fx, 0, -fy);
          wallLog.ramp(o0x, o0y, o1x, o1y, ga, ta, gb, tb, EW_PARAPET, ri.i, false);
        } else {
          const mx = o0x + (o1x - o0x) * fm;
          const my = o0y + (o1y - o0y) * fm;
          const tm = ta + (tb - ta) * fm;
          const gm0 = bottom(Math.max(0, fm - 0.003));
          const gm1 = bottom(Math.min(1, fm + 0.003));
          const um = st.vert(mx, tm, my, ...CONC);
          st.quad(st.vert(o0x, ga, o0y, ...WALL), st.vert(mx, gm0, my, ...WALL), um, u0, fx, 0, -fy);
          st.quad(st.vert(mx, gm1, my, ...WALL), st.vert(o1x, gb, o1y, ...WALL), u1, um, fx, 0, -fy);
          wallLog.ramp(o0x, o0y, mx, my, ga, ta, gm0, tm, EW_PARAPET, ri.i, false);
          wallLog.ramp(mx, my, o1x, o1y, gm1, tm, gb, tb, EW_PARAPET, ri.i, false);
        }
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
    rid = -1,
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
    const T = 0.45;
    const [o0x, o0y] = at(A, cutA + T);
    const [o1x, o1y] = at(B, cutB + T);
    const mid = deckSoffit((w0x + w1x) / 2, (w0y + w1y) / 2, (z0 + z1) / 2);
    const topA = Math.min(cutTop(A, side, cutA, z0), mid);
    const topB = Math.min(cutTop(B, side, cutB, z1), mid);
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
    const tun = rid >= 0 && roads[rid].tunnel;
    wallLog.ramp(w0x, w0y, w1x, w1y, A.z - 0.4, topA, B.z - 0.4, topB, EW_RETAINING, rid, tun);
    if (ends & 1) wallLog.add(w0x, w0y, o0x, o0y, A.z - 0.4, topA, EW_RETAINING, rid, tun);
    if (ends & 2) wallLog.add(w1x, w1y, o1x, o1y, B.z - 0.4, topB, EW_RETAINING, rid, tun);
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
    // (and never on a station bay's platform side, its left)
    for (const side of r.bay ? [-1] : [1, -1]) {
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
          const top = r.kind !== RoadKind.Motorway ? 1.15 : 0.95;
          let px = NaN;
          let py = NaN;
          let pz = 0;
          walkRun(ri, ss[k], ss[e], (x, yy, z, nx2, ny2) => {
            const qx = x + nx2 * side * (hw + 0.05);
            const qy = yy + ny2 * side * (hw + 0.05);
            if (px === px) wallLog.ramp(px, py, qx, qy, pz - 0.4, pz + top, z - 0.4, z + top, EW_PARAPET, ri.i, false);
            px = qx;
            py = qy;
            pz = z;
          });
        }
        k = e + 1;
      }
    }
    // deck edges and underside. An edge inside another deck flush with this one (two one-way carriageways
    // whose decks overlap: Victoria Bridge, the Northern Busway at RBWH) is internal: no fascia there (one
    // over a deck a little lower stays: it is the step between them). Under a platform's slab (a stopping
    // bay's platform side) the fascia stops under the slab.
    const edgeCode = (x: number, y: number, z: number) => (otherAt(x, y, z, ri.i, 0.15) > 0.2 ? 1 : underSurfacePlatform(x, y) ? 2 : 0);
    const samples: { s: number; x: number; y: number; z: number; nx: number; ny: number }[] = [];
    walkRun(ri, 0, ri.len, (x, yy, z, nx2, ny2, s) => samples.push({ s, x, y: yy, z, nx: nx2, ny: ny2 }));
    {
      // where an edge goes in or out of another deck or a platform between the vertices, a sample either side
      const step = 2;
      const code = (s: number) => {
        const c = roadAt(ri, s);
        return edgeCode(c.x + c.nx * edge, c.y + c.ny * edge, c.z) * 4 + edgeCode(c.x - c.nx * edge, c.y - c.ny * edge, c.z);
      };
      let pc = code(0);
      const extra: number[] = [];
      for (let s = step; s < ri.len + step - 0.01; s += step) {
        const sc = Math.min(s, ri.len);
        const c = code(sc);
        if (c !== pc) extra.push(Math.max(0, sc - step), sc);
        pc = c;
      }
      for (const s of extra) {
        if (samples.some((q) => Math.abs(q.s - s) < 0.3)) continue;
        const c = roadAt(ri, s);
        samples.push({ s, x: c.x, y: c.y, z: c.z, nx: c.nx, ny: c.ny });
      }
      samples.sort((p, q) => p.s - q.s);
    }
    let prev: { v: number[]; cl: number; cr: number } | null = null;
    for (const q of samples) {
      const { x, z, nx: nx2, ny: ny2 } = q;
      const yy = q.y;
      const lx = x + nx2 * edge;
      const ly = yy + ny2 * edge;
      const rx = x - nx2 * edge;
      const ry = yy - ny2 * edge;
      const cl = edgeCode(lx, ly, z);
      const cr = edgeCode(rx, ry, z);
      const v = [
        g.vert(lx, cl === 2 ? z - 1.0 : z + ri.lift, ly, ...CONC),
        g.vert(lx, z - depth, ly, ...CONC),
        g.vert(rx, z - depth, ry, ...CONC_DARK),
        g.vert(rx, cr === 2 ? z - 1.0 : z + ri.lift, ry, ...CONC),
        g.vert(lx, z - depth, ly, ...CONC_DARK),
        g.vert(rx, z - depth, ry, ...CONC),
      ];
      if (prev) {
        if (!(cl === 1 && prev.cl === 1)) g.quad(prev.v[0], v[0], v[1], prev.v[1], nx2, 0, -ny2);
        if (!(cr === 1 && prev.cr === 1)) g.quad(prev.v[3], v[3], v[5], prev.v[5], -nx2, 0, ny2);
        g.quad(prev.v[4], v[4], v[2], prev.v[2], 0, -1, 0);
      }
      prev = { v, cl, cr };
    }
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
        // no pier cap hanging over a road that passes under the deck with less than a bus's headroom
        // under it (the columns run up to the deck instead)
        const capOk = [-1, -0.5, 0, 0.5, 1].every((f) => index.penetrationZ(c.x + c.nx * f * (hw + 0.2), c.y + c.ny * f * (hw + 0.2), bottom - 3.1, 2.1, ri.i) < -0.5);
        for (const o of cols) {
          const px = c.x + c.nx * o;
          const py = c.y + c.ny * o;
          const pr = heavy ? 0.85 : 0.6;
          g.cylinder(px, py, base, capOk ? bottom - 0.9 : bottom, pr, 10, ...CONC);
          wallLog.box(px, py, base, capOk ? bottom - 0.9 : bottom, tx, ty, pr * 0.95, pr * 0.95, EW_RETAINING, ri.i, false);
        }
        if (capOk) {
          g.box(c.x, c.y, bottom - 1.0, bottom, tx, ty, 0.9, hw + 0.2, ...CONC_DARK);
          wallLog.box(c.x, c.y, bottom - 1.0, bottom, tx, ty, 0.9, hw + 0.2, EW_RETAINING, ri.i, false);
        }
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
      // none across a street that passes under the deck's end (Turbot Street over Roma Street)
      if ([-edge, 0, edge].some((o) => index.penetrationZ(c.x + c.nx * o, c.y + c.ny * o, ground, 1, ri.i) > -1)) continue;
      g.box(c.x, c.y, ground - 1, c.z - 0.05, c.ny, -c.nx, 0.7, edge + 0.4, ...WALL);
      // (solid below the road it carries: a bus on that road, or one joining it a little lower, rides over it)
      wallLog.box(c.x, c.y, ground - 1, c.z - 0.6, c.ny, -c.nx, 0.7, edge + 0.4, EW_RETAINING, ri.i, false);
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
      wallLog.box(c.x - tx * 0.3, c.y - ty * 0.3, c.z + H, ground + 1.0, tx, ty, 0.6, half + 1, EW_RETAINING, -1, false);
      wallLog.box(c.x + c.nx * half - tx * 0.3, c.y + c.ny * half - ty * 0.3, c.z - 0.2, c.z + H, tx, ty, 0.6, 0.6, EW_RETAINING, -1, false);
      wallLog.box(c.x - c.nx * half - tx * 0.3, c.y - c.ny * half - ty * 0.3, c.z - 0.2, c.z + H, tx, ty, 0.6, 0.6, EW_RETAINING, -1, false);
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
   * Where a tunnel road is an enclosed box, sampled every 4 m: all along a
   * tunnel the pipeline boxed end to end, else under enough ground; and
   * under a street that crosses low over it (an underpass box, so
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
    // (the last sample exactly at the end, so a box reaches its portal or the next road)
    if (ss.length > 1 && ss[ss.length - 1] >= ri.len - 0.5) ss[ss.length - 1] = ri.len;
    else if (ss[ss.length - 1] < ri.len) ss.push(ri.len);
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
        // (and under another tunnel's tube passing over this one: the Northern Busway over Airport Link)
        const b = tunnels.lowestAbove(c.x + c.nx * o, c.y + c.ny * o, c.z + 4.0, 0.3, ri.i);
        if (b.z < z) {
          z = b.z;
          road = b.road;
        }
      }
      return { dz: z - c.z, road };
    };
    // a railway on the ground over the tube (the Cleveland line over the Eastern Busway at Buranda)
    const railAt = (s: number) => {
      const c = roadAt(ri, s);
      let z = Infinity;
      for (let q = -3; q <= 3; q++) {
        const o = (q / 3) * span;
        z = Math.min(z, railIdx.lowestAbove(c.x + c.nx * o, c.y + c.ny * o, c.z + 1.2, 0.3).z);
      }
      return { dz: z - c.z, road: z < Infinity ? -2 : -1 };
    };
    const ab = ss.map((s) => {
      const a = aboveAt(s);
      const b = railAt(s);
      return b.dz < a.dz ? b : a;
    });
    const abm = ss.slice(1).map((s1, k) => {
      const a = aboveAt((ss[k] + s1) / 2);
      const b = railAt((ss[k] + s1) / 2);
      return b.dz < a.dz ? b : a;
    });
    // the ceiling stays clear of the road's deck (a bridge's girders are deeper) or the track's ballast
    const lim = (a: { dz: number; road: number }) => (a.road === -2 ? a.dz - 0.9 : a.road < 0 ? Infinity : a.dz - (roads[a.road].bridge ? 2.2 : 0.65));
    const hc = ss.map((_, k) => clamp(Math.min(lim(ab[k]), k > 0 ? lim(abm[k - 1]) : Infinity, k < n - 1 ? lim(abm[k]) : Infinity), 4.6, H));
    // a street (not a bridge with its own deck) or a railway low over the cutting closes it into an
    // underpass box, run on a sample past it so the headwalls stand beside it, not in it
    const street = (a: { dz: number; road: number }) => (a.road === -2 || (a.road >= 0 && !roads[a.road].bridge)) && a.dz < H + 3;
    const over = ss.map((_, k) => street(ab[k]) || (k > 0 && street(abm[k - 1])) || (k < n - 1 && street(abm[k])));
    // a tunnel under ground somewhere (r.boxed, see tools/data/elevation.py boxed_tunnels) is a box from
    // one mapped end to the other: the 10 m ground grid, with the approach roads burned in, shows too
    // little ground over a portal's last 6-18 m, and over a shallow box under a plaza or a lawn (the
    // busway under the Cultural Centre and Victoria Park). Not under a deck or a railway too low for
    // the roof, which leaves the tube open there.
    const roomy = (k: number) => Math.min(lim(ab[k]), k > 0 ? lim(abm[k - 1]) : Infinity, k < n - 1 ? lim(abm[k]) : Infinity) >= 4.6;
    // Nor at a fork at its mouth, where a branch at grade leaves at an angle and its carriageway runs
    // through the box's wall line (the SEB's branches to Woolloongabba station where its tunnel from
    // Mater Hill ends), or where a platform's end stands in that line (Buranda platform 3 at its bay's
    // mouth): the approach is open until the line is clear, as before.
    const forkOpen = new Uint8Array(n);
    if (r.boxed) {
      for (const end of [0, 1]) {
        const v = end === 0 ? 0 : ri.n - 1;
        const w = end === 0 ? 1 : ri.n - 2;
        const ex = r.pts[2 * v];
        const ey = r.pts[2 * v + 1];
        const ax = r.pts[2 * w] - ex;
        const ay = r.pts[2 * w + 1] - ey;
        const branches = new Set<number>();
        index.roadsNear(ex, ey, 0.05, (q) => {
          const o = roads[q];
          if (q === ri.i || o.tunnel || o.bay || o.kind === RoadKind.Pedestrian) return;
          const t = o.pts;
          const m = t.length >> 1;
          const at0 = Math.hypot(t[0] - ex, t[1] - ey) < 0.05;
          if (!at0 && Math.hypot(t[2 * m - 2] - ex, t[2 * m - 1] - ey) >= 0.05) return;
          const bx = at0 ? t[2] - t[0] : t[2 * m - 4] - t[2 * m - 2];
          const by = at0 ? t[3] - t[1] : t[2 * m - 3] - t[2 * m - 1];
          // (not the road running straight on out of the mouth, nearly opposite at the shared node)
          if ((ax * bx + ay * by) / ((Math.hypot(ax, ay) || 1) * (Math.hypot(bx, by) || 1)) >= -0.7) branches.add(q);
        });
        let reach = -1;
        for (let d = 0.5; d <= Math.min(16, ri.len / 2); d += 0.5) {
          const c = roadAt(ri, end === 0 ? d : ri.len - d);
          for (const side of [1, -1]) {
            for (const o of [ri.hw + 0.6, wallOff]) {
              const x = c.x + c.nx * side * o;
              const y = c.y + c.ny * side * o;
              if ((branches.size && index.penetrationZ(x, y, c.z, 1.5, ri.i, (q) => branches.has(q)) > -0.4) || underSurfacePlatform(x, y)) reach = d;
            }
          }
        }
        for (let k = 0; k < n && reach > 0; k++) if ((end === 0 ? ss[k] : ri.len - ss[k]) <= reach) forkOpen[k] = 1;
      }
    }
    const cov = P0.map((c, k) => (!!r.boxed && roomy(k) && !forkOpen[k]) || covered(ri, c) || over[k] || (k > 0 && over[k - 1]) || (k < n - 1 && over[k + 1]));
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
      // an approach in an open cutting is open toward any carriageway level with it as well (the SEB's
      // branches meeting its tunnel at Woolloongabba): its wall would stand in that road
      const levelBeside = (c: { x: number; y: number; z: number; nx: number; ny: number }) =>
        otherAt(c.x + c.nx * side * (hw + 0.6), c.y + c.ny * side * (hw + 0.6), c.z, ri.i, 1.5) > -0.4;
      // ... and toward a platform its wall line would stand in (Buranda platform 3's end at the bay's portal)
      const onPlatform = (c: { x: number; y: number; nx: number; ny: number }) => {
        for (const o of [hw + 0.3, hw + 0.75]) {
          const x = c.x + c.nx * side * o;
          const y = c.y + c.ny * side * o;
          if (data.platforms.some((pf) => pf.area && pointInRing(x, y, pf.pts))) return true;
        }
        return false;
      };
      for (let k = 0; k + 1 < ss.length; k++) {
        if (boxSeg(k) || segOpen[k]) continue;
        if (levelBeside(P0[k]) || levelBeside(P0[k + 1]) || levelBeside(roadAt(ri, (ss[k] + ss[k + 1]) / 2))) segOpen[k] = true;
        else for (let f = 0; f <= 1.001 && !segOpen[k]; f += 0.125) if (onPlatform(roadAt(ri, ss[k] + (ss[k + 1] - ss[k]) * f))) segOpen[k] = true;
      }
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
        wallLog.add(c.x + c.nx * side * wallOff, c.y + c.ny * side * wallOff, c.x + c.nx * side * end, c.y + c.ny * side * end, c.z - 0.4, c.z + Math.min(hc[k], TUBE_WALL_H), EW_TUNNEL, ri.i, true);
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
          cutSeg(L, Am, Bm, side, ss[k], ss[k + 1], 0, 0, hw + 0.3, hw + 0.3, hw, !isOpen, ends, ri.i);
          continue;
        }
        // where this tube meets another one, run on a little so the two overlap
        // instead of leaving a wedge open on the outside of the bend
        // (not into an underground platform starting at the join: Queen St platform 1 at #9871's end)
        const platAt = (c: typeof A, dx: number, dy: number, o: number) => nearPlat && plats.some((pf) => pointInRing(c.x + dx + c.nx * side * o, c.y + dy + c.ny * side * o, pf.pts));
        if (k === 0 && joinStart && !platAt(A, -dirS[0] * TUBE_EXT, -dirS[1] * TUBE_EXT, isOpen ? wallOff : wo[k])) A = { ...A, x: A.x - dirS[0] * TUBE_EXT, y: A.y - dirS[1] * TUBE_EXT };
        if (k + 2 === ss.length && joinEnd && !platAt(B, dirE[0] * TUBE_EXT, dirE[1] * TUBE_EXT, isOpen ? wallOff : wo[k + 1])) B = { ...B, x: B.x + dirE[0] * TUBE_EXT, y: B.y + dirE[1] * TUBE_EXT };
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
          // wall (the shader paints the dado, delineator line and panel joints, or the hall's tiles), only
          // up to where its line runs into an underground platform's end (the hall is open beyond)
          let fa = 0;
          let fb = 1;
          if (nearPlat) {
            const inP = (f: number) =>
              plats.some((pf) =>
                pointInRing(A.x + (B.x - A.x) * f + (A.nx + (B.nx - A.nx) * f) * side * (woA + (woB - woA) * f), A.y + (B.y - A.y) * f + (A.ny + (B.ny - A.ny) * f) * side * (woA + (woB - woA) * f), pf.pts),
              );
            const i0 = inP(0);
            if (i0 !== inP(1)) {
              let lo = 0;
              let hi = 1;
              for (let it = 0; it < 12; it++) {
                const m = (lo + hi) / 2;
                if (inP(m) === i0) lo = m;
                else hi = m;
              }
              if (i0) fa = hi;
              else fb = lo;
            }
          }
          const lerpC = (f: number): typeof A => (f <= 0 ? A : f >= 1 ? B : { ...A, x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f, z: A.z + (B.z - A.z) * f, nx: A.nx + (B.nx - A.nx) * f, ny: A.ny + (B.ny - A.ny) * f });
          const Aw = lerpC(fa);
          const Bw = lerpC(fb);
          const sAw = sA + (sB - sA) * fa;
          const sBw = sA + (sB - sA) * fb;
          const hAw = hA + (hB - hA) * fa;
          const hBw = hA + (hB - hA) * fb;
          const woAw = woA + (woB - woA) * fa;
          const woBw = woA + (woB - woA) * fb;
          const wp = hall && pal === TUBE_PAL.kgs ? 7 : 0;
          if (fb - fa > 0.02) {
            t.quad(V(Aw, woAw, wz, pal.wall, sAw, wp), V(Bw, woBw, wz, pal.wall, sBw, wp), V(Bw, woBw, hBw, pal.wall, sBw, wp), V(Aw, woAw, hAw, pal.wall, sAw, wp), -fx, 0, fy);
            wallLog.ramp(Aw.x + Aw.nx * side * woAw, Aw.y + Aw.ny * side * woAw, Bw.x + Bw.nx * side * woBw, Bw.y + Bw.ny * side * woBw, Aw.z - 0.4, Aw.z + Math.min(hAw, TUBE_WALL_H), Bw.z - 0.4, Bw.z + Math.min(hBw, TUBE_WALL_H), EW_TUNNEL, ri.i, true);
          }
          if (!hall && fb - fa > 0.02) {
            // cable tray under the ceiling edge
            const tr = [70, 72, 74];
            t.quad(V(Aw, woAw, hAw - 0.62, tr, sAw, 6), V(Bw, woBw, hBw - 0.62, tr, sBw, 6), V(Bw, woBw - 0.42, hBw - 0.62, tr, sBw, 6), V(Aw, woAw - 0.42, hAw - 0.62, tr, sAw, 6), 0, -1, 0);
            t.quad(V(Aw, woAw - 0.42, hAw - 0.62, tr, sAw, 6), V(Bw, woBw - 0.42, hBw - 0.62, tr, sBw, 6), V(Bw, woBw - 0.42, hBw - 0.46, tr, sBw, 6), V(Aw, woAw - 0.42, hAw - 0.46, tr, sAw, 6), -fx, 0, fy);
          }
        }
        const cp = hall && pal === TUBE_PAL.kgs ? 8 : 1;
        t.quad(V(A, 0, hA, pal.ceil, sA, cp), V(B, 0, hB, pal.ceil, sB, cp), V(B, ceilB, hB, pal.ceil, sB, cp), V(A, ceilA, hA, pal.ceil, sA, cp), 0, -1, 0);
        // shallow cover: a grassed mound over the box so its roof never shows (not on a side open toward
        // a neighbouring tube, where it would slope down through that tube: Mater Hill's station bays run
        // on into the box beside the busway's; the roofs over the boxes cover the gap)
        if (!isOpen && (cover[k] < 0.6 || cover[k + 1] < 0.6)) {
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
    // the ceiling's extent for the cameras (out to the walls, or across a platform hall)
    for (let k = 0; k + 1 < ss.length; k++) {
      if (!boxSeg(k)) continue;
      wallLog.ceilings.push(P0[k].x, P0[k].y, P0[k + 1].x, P0[k + 1].y, P0[k].z, P0[k + 1].z, reach[0][k], reach[1][k], Math.min(hc[k], hc[k + 1]));
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
    // lane control signals hung over each lane every 150 m (and just inside the first portal): a green
    // arrow toward the traffic using the lane, a red cross toward oncoming traffic on a two-way road
    // (traffic keeps left: the lanes left of the road's direction carry it forward)
    if (boxLen > 120) {
      const lanes: { o: number; dir: number }[] = [];
      if (r.oneway) {
        const n = Math.max(1, r.lanes);
        for (let i = 0; i < n; i++) lanes.push({ o: -hw + ((i + 0.5) * 2 * hw) / n, dir: 1 });
      } else {
        const n = Math.max(1, Math.round(r.lanes / 2));
        for (let i = 0; i < n; i++) lanes.push({ o: ((i + 0.5) * hw) / n, dir: 1 }, { o: -((i + 0.5) * hw) / n, dir: -1 });
      }
      for (let s = 20; s < ri.len - 15; s += 150) {
        const k = segAt(s);
        if (!boxSeg(k) || !boxSeg(Math.min(ss.length - 2, k + 1)) || pals[k] === TUBE_PAL.kgs || pals[k] === TUBE_PAL.qsbs) continue;
        const hh = Math.min(hc[k], hc[Math.min(ss.length - 1, k + 1)]);
        if (hh < 5.0) continue;
        const c = roadAt(ri, s);
        const tx = c.ny;
        const ty = -c.nx;
        const z1 = c.z + hh - 0.2;
        const z0 = z1 - 0.6;
        for (const ln of lanes) {
          const x = c.x + c.nx * ln.o;
          const y = c.y + c.ny * ln.o;
          t.box(x, y, z0, z1, tx, ty, 0.12, 0.3, 34, 36, 38, s, 4.5, 6, pd[k]);
          t.box(x, y, z1, c.z + hh, tx, ty, 0.04, 0.1, 90, 92, 96, s, 4.5, 6, pd[k]);
          // the face toward -s is seen by traffic travelling +s
          signFace(t, x - tx * 0.125, y - ty * 0.125, (z0 + z1) / 2, 0.5, 0.5, -tx, -ty, ln.dir > 0 ? SIGN_GO : SIGN_STOP, pd[k]);
          if (!r.oneway) signFace(t, x + tx * 0.125, y + ty * 0.125, (z0 + z1) / 2, 0.5, 0.5, tx, ty, ln.dir < 0 ? SIGN_GO : SIGN_STOP, pd[k]);
        }
      }
    }
    // the way out: the nearer portal (or end of the road)
    const portalS = tp.portals.map(([k]) => ss[k]);
    const exitDir = (s: number) => {
      let best = s < ri.len / 2 ? 0 : ri.len;
      for (const p of portalS) if (Math.abs(p - s) < Math.abs(best - s)) best = p;
      return best < s ? -1 : 1;
    };
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
            // exit sign: a green light box, its face pointing the way to the nearer portal (seen from the
            // road, a sign on the left wall has +s to its right)
            t.box(px + ix * 0.07, py + iy * 0.07, c.z + 2.45, c.z + 2.83, tx, ty, 0.38, 0.06, 40, 190, 90, sx, 2.6, 4, pd[k]);
            signFace(t, px + ix * 0.135, py + iy * 0.135, c.z + 2.64, 0.72, 0.36, ix, iy, exitDir(sx) * side > 0 ? SIGN_EXIT_R : SIGN_EXIT_L, pd[k]);
          } else {
            // emergency cabinet (phone, hose) with a red light, an SOS sign and a hose reel sign over it
            t.box(px + ix * 0.13, py + iy * 0.13, c.z + 0.25, c.z + 1.55, tx, ty, 0.45, 0.13, 214, 214, 208, sx, 1.0, 2, pd[k]);
            t.box(px + ix * 0.27, py + iy * 0.27, c.z + 0.6, c.z + 1.4, tx, ty, 0.3, 0.012, 196, 40, 34, sx, 1.0, 2, pd[k]);
            t.box(px + ix * 0.1, py + iy * 0.1, c.z + 1.62, c.z + 1.8, tx, ty, 0.2, 0.1, 240, 40, 30, sx, 1.7, 5, pd[k]);
            const rx = -iy;
            const ry = ix;
            signFace(t, px + ix * 0.02 - rx * 0.27, py + iy * 0.02 - ry * 0.27, c.z + 2.05, 0.5, 0.25, ix, iy, SIGN_SOS, pd[k]);
            signFace(t, px + ix * 0.02 + rx * 0.27, py + iy * 0.02 + ry * 0.27, c.z + 2.05, 0.5, 0.25, ix, iy, SIGN_HOSE, pd[k]);
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
      // nothing of the portal stands on another carriageway at this level (a station bay's portal beside
      // its busway's, two tubes side by side, a busway branching off just outside the mouth) or on a platform
      const clear = (o: number, m: number) => {
        const x = c.x + c.nx * o;
        const y = c.y + c.ny * o;
        return tubeNb(x, y, c.z) <= -m && otherAt(x, y, c.z, ri.i, 1.5) <= -m && !data.platforms.some((pf) => pf.area && pointInRing(x, y, pf.pts));
      };
      // the box segment the portal opens into: on a side open toward a neighbouring tube there is no wall
      const seg = inward > 0 ? k : k - 1;
      for (const sd of [1, -1]) {
        if (!clear(sd * (half - 0.3), 0.6)) continue;
        st.boxF(c.x + c.nx * sd * (half - 0.3) - tx * 0.3, c.y + c.ny * sd * (half - 0.3) - ty * 0.3, c.z - 0.2, roof, tx, ty, 0.3, 0.3, ...CONC);
        wallLog.box(c.x + c.nx * sd * (half - 0.3) - tx * 0.3, c.y + c.ny * sd * (half - 0.3) - ty * 0.3, c.z - 0.4, Math.min(roof, c.z + TUBE_WALL_H), tx, ty, 0.3, 0.3, EW_TUNNEL, ri.i, true);
        // the headwall's face beside the opening, from the approach's wall line (hw + 0.3) across the
        // walkway and the tube's wall to the pilaster, so the mouth never shows a slot into the earth behind
        // the wall or under the ground beside a wall-less approach
        const o0 = hw + 0.3;
        const o1 = half - 0.6;
        const oc = (o0 + o1) / 2;
        if (seg < 0 || openSide[sd > 0 ? 0 : 1][seg] || !clear(sd * (o0 + 0.15), 0.3) || !clear(sd * oc, 0.6) || !clear(sd * (o1 - 0.15), 0.6)) continue;
        st.boxF(c.x + c.nx * sd * oc - tx * 0.3, c.y + c.ny * sd * oc - ty * 0.3, c.z - 0.2, roof, tx, ty, 0.3, (o1 - o0) / 2, ...PORTAL);
        wallLog.box(c.x + c.nx * sd * oc - tx * 0.3, c.y + c.ny * sd * oc - ty * 0.3, c.z - 0.4, Math.min(roof, c.z + TUBE_WALL_H), tx, ty, 0.3, (o1 - o0) / 2, EW_TUNNEL, ri.i, true);
      }
      const N = Math.max(4, Math.round((2 * half) / 1.2));
      const w = (2 * half) / N;
      // another carriageway higher than this one but less than a bus's headroom under its roof (a twin
      // tube whose road runs higher, Ivory Street): no headwall column over any of it
      const zu0 = Math.max(c.z + 0.6, roof - 4.0);
      const under = (x: number, y: number) =>
        zu0 >= roof ? -Infinity : Math.max(index.penetrationZ(x, y, (zu0 + roof) / 2, (roof - zu0) / 2, ri.i), tunnels.penetrationZ(x, y, (zu0 + roof) / 2, (roof - zu0) / 2, ri.i));
      let lintelTop = Infinity;
      for (let j = 0; j < N; j++) {
        const o = -half + (j + 0.5) * w;
        const px = c.x + c.nx * o;
        const py = c.y + c.ny * o;
        if (tubeNb(px, py, c.z) > 0 || under(px, py) > -w / 2) continue;
        const g = Math.max(groundAt(px + tx * 3, py + ty * 3), roof + 0.6);
        let top = g + 0.3;
        // a street over the mouth, or a bus route passing over it (a street wider than mapped)
        const above = index.lowestAbove(px - tx * 0.4, py - ty * 0.4, roof - 0.5, 0.5);
        const bus = routeIdx.lowestAbove(px - tx * 0.4, py - ty * 0.4, roof - 0.5, 2.5);
        const zs = Math.min(above.road >= 0 ? above.z : Infinity, bus.road >= 0 ? bus.z : Infinity);
        const street = zs < top + 2.5;
        if (street) {
          top = Math.max(roof + 0.25, zs - 0.05);
          lintelTop = Math.min(lintelTop, zs - 0.05);
        }
        st.boxF(px - tx * 0.3, py - ty * 0.3, roof, top, tx, ty, 0.3, w / 2 + 0.002, ...PORTAL);
        if (!street) {
          st.boxF(px - tx * 0.3, py - ty * 0.3, top, top + 0.12, tx, ty, 0.38, w / 2 + 0.002, ...CONC);
          st.boxF(px - tx * 0.5, py - ty * 0.5, top + 0.12, top + 1.0, tx, ty, 0.1, w / 2 + 0.002, ...CONC);
        }
        // (solid for a bus on a street beside the mouth)
        wallLog.add(px - tx * 0.3 - c.nx * (w / 2), py - ty * 0.3 - c.ny * (w / 2), px - tx * 0.3 + c.nx * (w / 2), py - ty * 0.3 + c.ny * (w / 2), roof, street ? top : top + 1.0, EW_TUNNEL, ri.i, true);
      }
      // lintel beam over the opening, standing 0.3 m proud of the headwall
      const lt = Math.min(roof + 1.0, lintelTop);
      if (lt > roof + 0.3) {
        // (only over this carriageway on a side where another one runs alongside)
        const wide = (sd: number) => clear(sd * (hw + 0.6), 0.3) && under(c.x + c.nx * sd * (wallOff + 0.6), c.y + c.ny * sd * (wallOff + 0.6)) <= -0.3;
        const eL = wide(1) ? wallOff + 0.6 : hw;
        const eR = wide(-1) ? wallOff + 0.6 : hw;
        const mo = (eL - eR) / 2;
        st.boxF(c.x + c.nx * mo - tx * 0.45, c.y + c.ny * mo - ty * 0.45, roof - 0.2, lt, tx, ty, 0.45, (eL + eR) / 2, ...CONC);
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
    // a covered dead end (the way stops here and nothing joins it): an end wall across the tube (never at
    // a station bay's ends, which taper into the busway without joining it in the graph)
    for (const end of r.bay ? [] : [0, 1]) {
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
      // never across another carriageway at this level (a station bay tapering into its busway, a road
      // ending on another's edge): only from the tube's walls in to where that carriageway begins
      const onRoad = (o: number) => tubeNb(c.x + c.nx * o + ox * 0.3, c.y + c.ny * o + oy * 0.3, c.z) > -0.15;
      const piece = (a: number, b: number) => {
        if (b - a <= 0.1) return;
        t.quad(e(a, -0.3), e(b, -0.3), e(b, hc[k]), e(a, hc[k]), -ox, 0, oy);
        const ex = c.x + ox * 0.05;
        const ey = c.y + oy * 0.05;
        wallLog.add(ex + c.nx * a, ey + c.ny * a, ex + c.nx * b, ey + c.ny * b, c.z - 0.4, c.z + Math.min(hc[k], TUBE_WALL_H), EW_TUNNEL, ri.i, true);
      };
      let l0 = oL;
      while (l0 - 0.25 > -oR && !onRoad(l0 - 0.25)) l0 -= 0.25;
      if (l0 - 0.25 <= -oR) piece(-oR, oL);
      else {
        piece(l0, oL);
        let r1 = -oR;
        while (r1 + 0.25 < l0 && !onRoad(r1 + 0.25)) r1 += 0.25;
        piece(-oR, r1);
      }
    }
    tubesBuilt.push({ ri, tp, L, reach, open: openSide, boxSeg });
  }

  /**
   * A jet fan hung under the ceiling: a 12-sided drum along the road with wider silencer cowls at its ends,
   * dark intake grilles with a hub, and two hangers. (The tube's light ignores normals, so the drum's
   * shading, lit from the ceiling above, is in its colours.)
   */
  function jetFan(t: MeshGeo, c: ReturnType<typeof roadAt>, o: number, zc: number, s: number, pdv: number): void {
    const tx = c.ny;
    const ty = -c.nx;
    const cx = c.x + c.nx * o;
    const cy = c.y + c.ny * o;
    const N = 12;
    const half = 2.0;
    const ring = (d: number, rr: number) => {
      const out: number[][] = [];
      for (let i = 0; i < N; i++) {
        const a = ((i + 0.5) / N) * Math.PI * 2;
        out.push([cx + tx * d + c.nx * Math.cos(a) * rr, zc + Math.sin(a) * rr, cy + ty * d + c.ny * Math.cos(a) * rr, Math.cos(a), Math.sin(a)]);
      }
      return out;
    };
    const drum = (d0: number, d1: number, rr: number, col: number[]) => {
      const a = ring(d0, rr);
      const b = ring(d1, rr);
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const nxm = (a[i][3] + a[j][3]) / 2;
        const nzm = (a[i][4] + a[j][4]) / 2;
        const f = 0.7 + 0.3 * nzm;
        const v = (p: number[]) => t.vert(p[0], p[1], p[2], col[0] * f, col[1] * f, col[2] * f, s, 4.5, 6, pdv);
        t.quad(v(a[i]), v(b[i]), v(b[j]), v(a[j]), c.nx * nxm, nzm, -c.ny * nxm);
      }
      return [a, b];
    };
    drum(-half + 0.45, half - 0.45, 0.56, [168, 172, 176]);
    for (const d of [-1, 1]) {
      const [p, q] = drum(d * (half - 0.45), d * half, 0.64, [120, 124, 128]);
      // the step from the cowl down to the body, and the grille at the end
      const inner = ring(d * (half - 0.45), 0.56);
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const v = (pp: number[]) => t.vert(pp[0], pp[1], pp[2], 96, 98, 102, s, 4.5, 6, pdv);
        t.quad(v(inner[i]), v(p[i]), v(p[j]), v(inner[j]), -tx * d, 0, ty * d);
      }
      const hub = ring(d * (half - 0.05), 0.2);
      const ctr = t.vert(cx + tx * (half - 0.05) * d, zc, cy + ty * (half - 0.05) * d, 70, 72, 76, s, 4.5, 6, pdv);
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const g = (pp: number[]) => t.vert(pp[0], pp[1], pp[2], 30, 32, 34, s, 4.5, 6, pdv);
        t.quad(g(hub[i]), g(q[i]), g(q[j]), g(hub[j]), tx * d, 0, -ty * d);
        const hv = (pp: number[]) => t.vert(pp[0], pp[1], pp[2], 70, 72, 76, s, 4.5, 6, pdv);
        t.tri(ctr, hv(hub[i]), hv(hub[j]), tx * d, 0, -ty * d);
      }
      t.box(cx + tx * d * 0.9, cy + ty * d * 0.9, zc + 0.5, zc + 0.86, tx, ty, 0.05, 0.3, 90, 92, 96, s, 4.5, 6, pdv);
    }
  }

  /**
   * A platform in the open whose slab reaches into rising ground beyond the cutting beside its busway
   * (Mater Hill platform 1's corner by its tunnel bay's portal): carve the ground out of the slab's
   * outline, in cells of about 2 m, down to the slab's top (the bus road beside it + 0.3 m, as
   * src/game/platforms.ts fits it) wherever the ground stands above it, so the slab is never buried; the
   * cut's earth face is the bank behind it. Never where the ground falls well below the slab (a deck on
   * fill or piers keeps the ground under it).
   */
  function platformCuts(): void {
    const isBus = (q: number) => roads[q].bus || roads[q].kind === RoadKind.Busway;
    /** Carve one piece of a slab (3 or 4 corners) out of the ground where the ground rises through it. */
    const piece = (cs: [number, number][]) => {
      let cx = 0;
      let cy = 0;
      for (const [x, y] of cs) {
        cx += x / cs.length;
        cy += y / cs.length;
      }
      const near = index.nearest(cx, cy, 25, isBus);
      if (!near) return;
      const top = near.z + 0.3;
      let hi = -Infinity;
      let lo = Infinity;
      for (const [x, y] of [...cs, [cx, cy]]) {
        const gz = field.settledAt(x, y);
        hi = Math.max(hi, gz);
        lo = Math.min(lo, gz);
      }
      if (hi < top + 0.02 || lo < top - 0.8) return;
      const fz = top - 0.05;
      const d = cs[cs.length - 1];
      field.holeQuad([cs[0][0], cs[0][1], fz, cs[1][0], cs[1][1], fz, cs[2][0], cs[2][1], fz, (cs[3] ?? d)[0], (cs[3] ?? d)[1], fz], 0, false, 0);
    };
    for (const g of gradePlatforms) {
      const p = g.p.pts;
      let m = p.length / 2;
      if (m > 3 && p[0] === p[2 * m - 2] && p[1] === p[2 * m - 1]) m--;
      if (!g.p.area || m < 3) continue;
      if (m === 4) {
        const P = (u: number, v: number): [number, number] => [
          (1 - u) * (1 - v) * p[0] + u * (1 - v) * p[2] + u * v * p[4] + (1 - u) * v * p[6],
          (1 - u) * (1 - v) * p[1] + u * (1 - v) * p[3] + u * v * p[5] + (1 - u) * v * p[7],
        ];
        const nu = Math.max(1, Math.ceil(Math.hypot(p[2] - p[0], p[3] - p[1]) / 2));
        const nv = Math.max(1, Math.ceil(Math.hypot(p[4] - p[2], p[5] - p[3]) / 2));
        for (let i = 0; i < nu; i++) {
          for (let j = 0; j < nv; j++) piece([P(i / nu, j / nv), P((i + 1) / nu, j / nv), P((i + 1) / nu, (j + 1) / nv), P(i / nu, (j + 1) / nv)]);
        }
        continue;
      }
      // any other outline: its triangles, each cut into triangles of about 2 m
      const ring: THREE.Vector2[] = [];
      for (let i = 0; i < m; i++) ring.push(new THREE.Vector2(p[2 * i], p[2 * i + 1]));
      for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(ring, [])) {
        const A = ring[a];
        const B = ring[b];
        const C = ring[c];
        const n = Math.max(1, Math.ceil(Math.max(A.distanceTo(B), B.distanceTo(C), C.distanceTo(A)) / 2));
        const P = (i: number, j: number): [number, number] => [A.x + ((B.x - A.x) * i + (C.x - A.x) * j) / n, A.y + ((B.y - A.y) * i + (C.y - A.y) * j) / n];
        for (let i = 0; i < n; i++) {
          for (let j = 0; i + j < n; j++) {
            piece([P(i, j), P(i + 1, j), P(i, j + 1)]);
            if (i + j < n - 1) piece([P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)]);
          }
        }
      }
    }
  }

  /** Where a tunnel box's ground was held below its roof (by a road beside or over it): carve it off the box and roof the box over. */
  function roofBoxes(): void {
    for (const { ri, tp, L, reach, boxSeg, open } of tubesBuilt) {
      const { ss, P0, hc } = tp;
      const g = L.strip;
      // (mitred at a plain join with the next road, as the box's footprint is: see the tunnel boxes)
      const m0 = endMiter(ri, false);
      const m1 = endMiter(ri, true);
      for (let k = 0; k + 1 < ss.length; k++) {
        if (!boxSeg(k)) continue;
        const A = k === 0 && m0 && ss[0] === 0 ? { ...P0[k], nx: m0[0], ny: m0[1] } : P0[k];
        const B = k + 2 === ss.length && m1 && ss[k + 1] >= ri.len - 0.01 ? { ...P0[k + 1], nx: m1[0], ny: m1[1] } : P0[k + 1];
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
