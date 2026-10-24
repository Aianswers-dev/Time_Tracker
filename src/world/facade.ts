/**
 * Procedural facades: windows, cladding and roofs drawn in the fragment shader
 * from wall coordinates in metres (u along the wall, v height above ground).
 * Shared by merged OSM buildings and instanced generated houses.
 */
import * as THREE from 'three';
import { NOISE_GLSL, patch } from './shaders';

export const enum Style {
  Glass = 0,
  Office = 1,
  Apartment = 2,
  Shop = 3,
  House = 4,
  Industrial = 5,
  Civic = 6,
  Parking = 7,
  Canopy = 8,
}

/** Bit flags in aStyle.z */
export const F_ROOF = 1;
export const F_PITCHED = 2;
export const F_HIGHSET = 4;
export const F_TILE = 8;
export const F_SOFFIT = 16;

const FACADE_GLSL = /* glsl */ `
uniform float uLit;
uniform sampler2D uNoise;
varying vec2 vFUv;
varying vec4 vFStyle;
varying vec3 vFCol;
${NOISE_GLSL}
vec3 f_srgb(vec3 c) { return pow(c, vec3(2.2)); }
float f_bit(float flags, float b) { return mod(floor(flags / b), 2.0); }
// anti-aliased rectangle in cell space; r = (x0, x1, y0, y1)
float f_rect(vec2 f, vec4 r, vec2 fw) {
  vec2 a = smoothstep(r.xz - fw, r.xz + fw, f);
  vec2 b = 1.0 - smoothstep(r.yw - fw, r.yw + fw, f);
  return a.x * b.x * a.y * b.y;
}
float f_lines(float v, float period, float width) {
  float x = v / period;
  float fw = fwidth(x);
  float d = abs(fract(x) - 0.5);
  float m = smoothstep(width / period * 0.5 + fw, width / period * 0.5 - fw, 0.5 - d);
  return mix(m, width / period, smoothstep(0.3, 0.7, fw));
}

void facade(inout vec3 albedo, inout float rough, inout float metal, inout vec3 emis) {
  float style = floor(vFStyle.x + 0.5);
  float seed = vFStyle.y / 255.0;
  float flags = vFStyle.z;
  float storey = max(2.4, vFStyle.w / 10.0);
  vec3 base = f_srgb(vFCol);
  vec2 uv = vFUv;
  vec4 nz = texture2D(uNoise, uv / 9.0 + seed * 7.0);

  if (f_bit(flags, 1.0) > 0.5) {
    // ---------------- roofs
    if (f_bit(flags, 2.0) > 0.5) {
      if (f_bit(flags, 8.0) > 0.5) {
        float rowl = f_lines(uv.y, 0.34, 0.05);
        float coll = f_lines(uv.x + floor(uv.y / 0.34) * 0.13, 0.27, 0.03);
        albedo = base * (0.92 + 0.16 * nz.r) * (1.0 - 0.35 * rowl - 0.2 * coll);
        rough = 0.75; metal = 0.0;
      } else {
        float seam = f_lines(uv.x, 0.762, 0.05);
        float corr = f_lines(uv.x, 0.076, 0.03);
        albedo = base * (0.94 + 0.1 * nz.g) * (1.0 - 0.25 * seam - 0.12 * corr);
        float galv = step(0.6, base.r) * step(abs(base.r - base.b), 0.05);
        rough = mix(0.42, 0.28, galv); metal = mix(0.25, 0.65, galv);
      }
    } else {
      vec2 hc = uv / 9.0;
      float big = step(0.8, w_hash(floor(hc) + seed * 13.0));
      vec2 hfw = fwidth(hc);
      float hvac = big * f_rect(fract(hc), vec4(0.3, 0.62, 0.35, 0.6), hfw);
      hvac *= 1.0 - smoothstep(0.15, 0.4, max(hfw.x, hfw.y));
      vec4 nr = texture2D(uNoise, uv / 31.0 + seed * 3.0);
      albedo = base * (0.86 + 0.22 * nr.g) * (1.0 - 0.3 * hvac);
      rough = 0.9; metal = 0.0;
    }
    if (f_bit(flags, 16.0) > 0.5) albedo *= 0.45;
    return;
  }

  // ---------------- walls
  float lit = 0.0;
  vec3 litCol = vec3(1.0, 0.82, 0.58);
  float glassMask = 0.0;
  vec3 glassCol = vec3(0.05, 0.07, 0.09);
  vec3 wall = base * (0.9 + 0.2 * nz.b);
  float wallRough = 0.85;
  float gf = storey;

  if (style < 0.5) {
    // glass curtain wall
    float bay = 1.5;
    vec2 c = vec2(uv.x / bay, uv.y / storey);
    vec2 fw = fwidth(c);
    vec2 f = fract(c);
    float g = f_rect(f, vec4(0.05, 0.95, 0.2, 0.97), fw * 1.2);
    float far = smoothstep(0.25, 0.6, max(fw.x, fw.y));
    g = mix(g, 0.72, far);
    glassMask = g;
    vec3 tint = base;
    glassCol = tint * (0.6 + 0.08 * w_hash(vec2(floor(c.x / 6.0), floor(c.y)) + seed * 31.0));
    wall = mix(tint * 0.7, vec3(0.55, 0.57, 0.6), 0.5);
    vec2 cell = floor(vec2(uv.x / 4.5, c.y));
    float h = w_hash(cell + seed * 17.0);
    lit = step(h, uLit * 1.15) * g;
    litCol = mix(vec3(0.82, 0.9, 1.0), vec3(1.0, 0.9, 0.7), step(0.7, w_hash(cell * 1.7 + 3.0)));
  } else if (style < 1.5) {
    // office: concrete frame, punched glazing
    float bay = 3.2;
    vec2 c = vec2(uv.x / bay, uv.y / storey);
    vec2 fw = fwidth(c);
    vec2 f = fract(c);
    float g = f_rect(f, vec4(0.1, 0.9, 0.3, 0.92), fw * 1.2);
    g = mix(g, 0.58, smoothstep(0.25, 0.6, max(fw.x, fw.y)));
    glassMask = g;
    glassCol = mix(vec3(0.08, 0.12, 0.16), base * 0.3, 0.3);
    float h = w_hash(floor(c) + seed * 17.0);
    lit = step(h, uLit) * g;
    litCol = vec3(0.9, 0.95, 1.0);
  } else if (style < 2.5) {
    // apartments: balconies, sliding doors, solid panels
    float bay = 3.4;
    vec2 c = vec2(uv.x / bay, uv.y / storey);
    vec2 fw = fwidth(c);
    vec2 f = fract(c);
    float solid = step(0.62, w_hash(vec2(floor(c.x), seed * 5.0)));
    float g = f_rect(f, vec4(0.14, 0.86, 0.1, 0.84), fw * 1.2) * (1.0 - solid * 0.75);
    g = mix(g, 0.45, smoothstep(0.25, 0.6, max(fw.x, fw.y)));
    glassMask = g;
    float slab = f_rect(f, vec4(-1.0, 2.0, 0.0, 0.08), fw);
    wall *= 1.0 - slab * 0.35;
    glassCol = vec3(0.07, 0.09, 0.11);
    float h = w_hash(floor(c) + seed * 23.0);
    lit = step(h, uLit * 1.1) * g;
    litCol = mix(vec3(1.0, 0.78, 0.5), vec3(0.95, 0.92, 0.85), step(0.6, h * 3.1 - floor(h * 3.1)));
  } else if (style < 3.5) {
    // shops: shopfront + awning, windows above
    gf = 4.2;
    if (uv.y < gf) {
      float bay = 5.0;
      vec2 c = vec2(uv.x / bay, uv.y / gf);
      vec2 fw = fwidth(c);
      vec2 f = fract(c);
      float g = f_rect(f, vec4(0.04, 0.96, 0.03, 0.72), fw * 1.2);
      g = mix(g, 0.6, smoothstep(0.25, 0.6, max(fw.x, fw.y)));
      glassMask = g;
      glassCol = vec3(0.10, 0.11, 0.12);
      float awn = f_rect(f, vec4(-1.0, 2.0, 0.76, 0.84), fw);
      wall = mix(wall, vec3(0.08), awn * 0.8);
      lit = g * mix(0.25, 0.9, step(0.35, w_hash(floor(c) + seed)));
      litCol = vec3(1.0, 0.9, 0.75);
    } else {
      float bay = 3.0;
      vec2 c = vec2(uv.x / bay, (uv.y - gf) / storey);
      vec2 fw = fwidth(c);
      vec2 f = fract(c);
      float g = f_rect(f, vec4(0.25, 0.75, 0.25, 0.8), fw * 1.2);
      g = mix(g, 0.27, smoothstep(0.25, 0.6, max(fw.x, fw.y)));
      glassMask = g;
      glassCol = vec3(0.07, 0.08, 0.09);
      lit = step(w_hash(floor(c) + seed * 7.0), uLit * 0.8) * g;
    }
  } else if (style < 4.5) {
    // Queenslander: weatherboards, white trim, highset lattice
    float stump = f_bit(flags, 4.0) > 0.5 ? 2.5 : 0.7;
    float board = f_lines(uv.y, 0.19, 0.035);
    wall *= 1.0 - board * 0.22;
    wallRough = 0.8;
    if (uv.y < stump) {
      vec2 lp = uv * 5.0;
      float lat = max(f_lines(lp.x + lp.y, 1.0, 0.32), f_lines(lp.x - lp.y, 1.0, 0.32));
      vec3 under = vec3(0.05, 0.05, 0.05);
      wall = mix(under, base * 0.85, lat * (stump > 1.0 ? 0.85 : 0.3));
      float post = f_rect(fract(vec2(uv.x / 2.4, 0.5)), vec4(0.0, 0.07, -1.0, 2.0), fwidth(vec2(uv.x / 2.4, 0.5)));
      wall = mix(wall, base * 0.8, post);
    } else {
      float bay = 2.9;
      vec2 c = vec2(uv.x / bay, (uv.y - stump) / 3.0);
      vec2 fw = fwidth(c);
      vec2 f = fract(c);
      float frame = f_rect(f, vec4(0.27, 0.73, 0.22, 0.83), fw * 1.2);
      float g = f_rect(f, vec4(0.31, 0.69, 0.27, 0.78), fw * 1.2);
      float far = smoothstep(0.25, 0.6, max(fw.x, fw.y));
      frame = mix(frame, 0.0, far);
      g = mix(g, 0.15, far);
      float skip = step(0.78, w_hash(vec2(floor(c.x), seed * 9.0 + 1.0)));
      g *= 1.0 - skip;
      frame *= 1.0 - skip;
      wall = mix(wall, vec3(0.92, 0.92, 0.88), frame * (1.0 - g));
      glassMask = g * step(c.y, 1.0);
      glassCol = vec3(0.05, 0.06, 0.07);
      lit = step(w_hash(floor(c) + seed * 11.0), uLit * 1.25) * glassMask;
      litCol = vec3(1.0, 0.76, 0.46);
    }
  } else if (style < 5.5) {
    // industrial cladding: vertical ribs, a band of high windows
    float rib = f_lines(uv.x, 0.33, 0.06);
    wall *= 1.0 - rib * 0.18;
    wallRough = 0.55;
    metal = 0.2;
    vec2 c = vec2(uv.x / 6.0, (uv.y - 3.2) / 1.2);
    vec2 fw = fwidth(c);
    float band = f_rect(fract(c), vec4(0.1, 0.9, 0.2, 0.8), fw) * step(0.0, c.y) * step(c.y, 1.0);
    band = mix(band, 0.2 * step(0.0, c.y) * step(c.y, 1.0), smoothstep(0.25, 0.6, max(fw.x, fw.y)));
    glassMask = band;
    glassCol = vec3(0.1, 0.12, 0.13);
    lit = band * step(w_hash(floor(c) + seed), uLit * 0.5);
    litCol = vec3(0.9, 0.95, 1.0);
  } else if (style < 6.5) {
    // civic / heritage: tall windows, string courses
    float st = max(storey, 4.2);
    vec2 c = vec2(uv.x / 3.8, uv.y / st);
    vec2 fw = fwidth(c);
    vec2 f = fract(c);
    float g = f_rect(f, vec4(0.32, 0.68, 0.18, 0.82), fw * 1.2);
    g = mix(g, 0.2, smoothstep(0.25, 0.6, max(fw.x, fw.y)));
    float course = f_rect(f, vec4(-1.0, 2.0, 0.0, 0.05), fw);
    wall *= 1.0 - course * 0.25;
    glassMask = g;
    glassCol = vec3(0.06, 0.07, 0.08);
    lit = step(w_hash(floor(c) + seed * 3.0), uLit * 0.9) * g;
    litCol = vec3(1.0, 0.86, 0.62);
  } else if (style < 7.5) {
    // multi-storey car park: open bands
    vec2 c = vec2(uv.x / 8.0, uv.y / 3.0);
    vec2 fw = fwidth(c);
    float open = f_rect(fract(c), vec4(-1.0, 2.0, 0.35, 0.92), fw);
    glassMask = open;
    glassCol = vec3(0.04);
    lit = open * 0.35;
    litCol = vec3(0.95, 0.95, 0.85);
  }

  vec3 gc = glassCol;
  albedo = mix(wall, gc, glassMask);
  rough = mix(wallRough, 0.07, glassMask);
  metal = mix(metal, style < 0.5 ? 0.85 : 0.55, glassMask);
  float on = lit * uNight;
  float vary = 0.55 + 0.45 * w_hash(floor(uv / vec2(2.0, storey)) + seed * 41.0);
  emis += litCol * on * vary * 1.6;
  albedo = mix(albedo, albedo * 0.4, on);
}
`;

/** Standard material for merged OSM building chunks. */
export function makeBuildingMaterial(noise: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, envMapIntensity: 0.9 });
  return patch(mat, {
    key: 'bld',
    uniforms: { uNoise: { value: noise } },
    vertexPars: `attribute vec4 aStyle;\nattribute vec3 aCol;\nvarying vec2 vFUv;\nvarying vec4 vFStyle;\nvarying vec3 vFCol;`,
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvFUv = uv;\nvFStyle = aStyle;\nvFCol = aCol;']],
    fragmentPars: FACADE_GLSL,
    fragment: [['#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nfacade(diffuseColor.rgb, roughnessFactor, metalnessFactor, totalEmissiveRadiance);']],
    defines: { USE_UV: '' },
  });
}

/**
 * Material for instanced generated houses. Template uv is in unit space and
 * aAxis says which instance scale axis maps to metres (0 x-walls, 1 z-walls, 2 roof).
 */
export function makeHouseMaterial(noise: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, flatShading: true, envMapIntensity: 0.9 });
  return patch(mat, {
    key: 'house',
    uniforms: { uNoise: { value: noise } },
    vertexPars: `attribute float aAxis;\nattribute vec4 iStyle;\nattribute vec3 iWall;\nattribute vec3 iRoof;\nvarying vec2 vFUv;\nvarying vec4 vFStyle;\nvarying vec3 vFCol;`,
    vertex: [
      [
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 isc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        float roofV = step(1.5, aAxis);
        if (aAxis < 0.5) vFUv = vec2(uv.x * isc.x, uv.y * isc.y);
        else if (aAxis < 1.5) vFUv = vec2(uv.x * isc.z, uv.y * isc.y);
        else if (aAxis < 2.5) vFUv = vec2(uv.x * isc.x, uv.y * length(vec2(isc.z * 0.5, isc.y * 0.5)));
        else vFUv = vec2(uv.x * isc.z, uv.y * length(vec2(isc.x * 0.5, isc.y * 0.5)));
        vFStyle = vec4(iStyle.x, iStyle.y, iStyle.z + roofV * (1.0 + 2.0), iStyle.w);
        vFCol = mix(iWall, iRoof, roofV);`,
      ],
    ],
    fragmentPars: FACADE_GLSL,
    fragment: [['#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nfacade(diffuseColor.rgb, roughnessFactor, metalnessFactor, totalEmissiveRadiance);']],
    defines: { USE_UV: '' },
  });
}
