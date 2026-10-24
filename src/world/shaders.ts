/**
 * Shared shader plumbing for every world material.
 *
 * - One set of uniforms (time of day, sun, sky colours) referenced by all materials.
 * - `patch()` adds to a built-in three.js material:
 *   * horizon compression: view-space positions beyond COMPRESS_D0 are pulled
 *     radially towards the camera so distant terrain (Mt Coot-tha, the outer
 *     suburbs) stays inside the 6 km far plane without changing what is seen;
 *   * height fog whose colour is the sky's horizon colour in that direction,
 *     so the city melts into the sky dome seamlessly.
 */
import * as THREE from 'three';

export const COMPRESS_D0 = 5000;
export const COMPRESS_RANGE = 950;

export const U = {
  uTime: { value: 0 },
  /** 0 = full day, 1 = full night (drives emissive windows, street lights). */
  uNight: { value: 0 },
  /** Fraction of windows lit (time-of-day dependent). */
  uLit: { value: 0.3 },
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2).normalize() },
  uMoonDir: { value: new THREE.Vector3(-0.3, 0.6, -0.2).normalize() },
  uSkyZenith: { value: new THREE.Color(0x2a5fa8) },
  uSkyHorizon: { value: new THREE.Color(0xb8d4ea) },
  uSunGlow: { value: new THREE.Color(0xffd9a0) },
  uSunDisc: { value: new THREE.Color(0xffffff) },
  uGroundCol: { value: new THREE.Color(0x4a4a40) },
  uCloud: { value: new THREE.Color(0xffffff) },
  uCloudShade: { value: new THREE.Color(0x9aa6b8) },
  uFogHeight: { value: 420 },
  uCompress: { value: new THREE.Vector2(COMPRESS_D0, COMPRESS_RANGE) },
  /** Seconds on the traffic-signal clock (matches signalStateAt). */
  uSignalTime: { value: 0 },
  /** 1 when the camera is inside a road tunnel. */
  uInTunnel: { value: 0 },
};

export type SharedUniforms = typeof U;

/** Sky colour model shared by the dome, the fog and the environment map. */
export const SKY_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSunGlow;
uniform vec3 uGroundCol;
uniform float uNight;
vec3 w_sky(vec3 dir) {
  float y = dir.y;
  float h = clamp(y, 0.0, 1.0);
  vec3 col = mix(uSkyHorizon, uSkyZenith, pow(h, 0.55));
  float sd = max(dot(dir, uSunDir), 0.0);
  float low = 1.0 - smoothstep(0.0, 0.5, h);
  col += uSunGlow * (pow(sd, 5.0) * (0.25 + 0.55 * low) + pow(sd, 40.0) * 0.5);
  // faint city glow on the night horizon
  col += vec3(0.20, 0.11, 0.05) * uNight * pow(1.0 - h, 6.0) * 0.35;
  col = mix(col, uGroundCol, smoothstep(0.0, -0.12, y));
  return col;
}
vec3 w_fogColor(vec3 dir) {
  vec3 d = normalize(vec3(dir.x, max(dir.y, 0.0) * 0.25 + 0.015, dir.z));
  return w_sky(d);
}
`;

const VERT_PARS = /* glsl */ `
uniform vec2 uCompress;
varying float vWDist;
varying vec3 vWDir;
varying vec3 vWView;
`;

const VERT_COMPRESS = /* glsl */ `
vWView = mvPosition.xyz;
vWDir = (vec4(mvPosition.xyz, 0.0) * viewMatrix).xyz;
vWDist = length(mvPosition.xyz);
#ifdef W_COMPRESS
if (vWDist > uCompress.x) {
  float wdd = uCompress.x + uCompress.y * (1.0 - exp(-(vWDist - uCompress.x) / uCompress.y));
  mvPosition.xyz *= wdd / vWDist;
  gl_Position = projectionMatrix * mvPosition;
}
#endif
`;

const FRAG_PARS = /* glsl */ `
uniform float uFogHeight;
varying float vWDist;
varying vec3 vWDir;
varying vec3 vWView;
${SKY_GLSL}
vec3 w_outputColor(vec3 c) {
  #ifdef TONE_MAPPING
  c = toneMapping(c);
  #endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}
`;

/** Needs fogDensity, so it goes after fog_pars_fragment. */
const FRAG_FOGFN = /* glsl */ `
#ifdef USE_FOG
float w_fogFactor() {
  float hc = cameraPosition.y;
  float hp = hc + vWDir.y;
  float hAvg = max(0.0, (hc + hp) * 0.5);
  float dens = fogDensity * exp(-hAvg / uFogHeight) * W_FOGMUL;
  float fd = dens * vWDist;
  return 1.0 - exp(-fd * fd);
}
#endif
`;

const FRAG_FOG = /* glsl */ `
#ifdef USE_FOG
{
  float wf = w_fogFactor();
  gl_FragColor.rgb = mix(gl_FragColor.rgb, w_outputColor(w_fogColor(normalize(vWDir))), wf);
}
#endif
`;

export interface PatchOptions {
  /** Unique key per shader variant. */
  key: string;
  compress?: boolean;
  fogMul?: number;
  uniforms?: Record<string, THREE.IUniform>;
  vertexPars?: string;
  /** Replacements applied to the vertex shader, in order. */
  vertex?: [string, string][];
  fragmentPars?: string;
  fragment?: [string, string][];
  defines?: Record<string, string | number>;
}

function replaceOnce(src: string, find: string, repl: string, key: string): string {
  if (!src.includes(find)) {
    console.warn(`[world] shader patch ${key}: '${find}' not found`);
    return src;
  }
  return src.replace(find, repl);
}

/** Patch a built-in material with world fog/compression plus custom GLSL. */
export function patch<T extends THREE.Material>(mat: T, o: PatchOptions): T {
  const fogMul = (o.fogMul ?? 1).toFixed(3);
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U, o.uniforms ?? {});
    shader.defines = { ...(shader.defines ?? {}), ...(o.defines ?? {}), W_FOGMUL: fogMul };
    if (o.compress !== false) shader.defines.W_COMPRESS = '';
    let vs = shader.vertexShader;
    vs = replaceOnce(vs, '#include <common>', `#include <common>\n${VERT_PARS}\n${o.vertexPars ?? ''}`, o.key);
    for (const [a, b] of o.vertex ?? []) vs = replaceOnce(vs, a, b, o.key);
    vs = replaceOnce(vs, '#include <project_vertex>', `#include <project_vertex>\n${VERT_COMPRESS}`, o.key);
    let fs = shader.fragmentShader;
    fs = replaceOnce(fs, '#include <common>', `#include <common>\n${FRAG_PARS}\n${o.fragmentPars ?? ''}`, o.key);
    fs = replaceOnce(fs, '#include <fog_pars_fragment>', `#include <fog_pars_fragment>\n${FRAG_FOGFN}`, o.key);
    // Flat normals from the uncompressed view position (compression bends far planes).
    if (fs.includes('#include <normal_fragment_begin>')) {
      fs = fs.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.split('dFdx( vViewPosition )').join('dFdx( vWView )').split('dFdy( vViewPosition )').join('dFdy( vWView )'));
    }
    for (const [a, b] of o.fragment ?? []) fs = replaceOnce(fs, a, b, o.key);
    fs = replaceOnce(fs, '#include <fog_fragment>', FRAG_FOG, o.key);
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => `w-${o.key}-${fogMul}-${o.compress !== false}`;
  return mat;
}

/** Vertex/fragment snippets for hand-written ShaderMaterials that want world fog. */
export const RAW = {
  vertPars: `#include <common>\n#include <logdepthbuf_pars_vertex>\n${VERT_PARS}`,
  /** Expects `vec4 mvPosition` already computed and assigned to gl_Position. */
  vertMain: `${VERT_COMPRESS}\n#include <logdepthbuf_vertex>`,
  fragPars: `#include <common>\n#include <logdepthbuf_pars_fragment>\n#ifdef USE_FOG\nuniform vec3 fogColor;\nuniform float fogDensity;\n#endif\n${FRAG_PARS}\n${FRAG_FOGFN}`,
  fragFog: FRAG_FOG,
};

// ---------------------------------------------------------------------------
// CPU helpers for matching three.js output colour (fog for other materials).

function rrtOdt(v: number): number {
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return a / b;
}

/** Linear colour -> displayed sRGB (ACES filmic as in three.js r170). */
export function toDisplay(c: THREE.Color, exposure: number, out: THREE.Color): THREE.Color {
  let r = (c.r * exposure) / 0.6;
  let g = (c.g * exposure) / 0.6;
  let b = (c.b * exposure) / 0.6;
  const ir = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const ig = 0.076 * r + 0.90834 * g + 0.01566 * b;
  const ib = 0.0284 * r + 0.13383 * g + 0.83777 * b;
  const tr = rrtOdt(ir);
  const tg = rrtOdt(ig);
  const tb = rrtOdt(ib);
  r = 1.60475 * tr - 0.53108 * tg - 0.07367 * tb;
  g = -0.10208 * tr + 1.10813 * tg - 0.00605 * tb;
  b = -0.00327 * tr - 0.07276 * tg + 1.07602 * tb;
  const enc = (x: number) => {
    x = Math.min(1, Math.max(0, x));
    return x < 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  };
  return out.setRGB(enc(r), enc(g), enc(b), THREE.LinearSRGBColorSpace);
}

/** Common GLSL noise helpers. */
export const NOISE_GLSL = /* glsl */ `
float w_hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float w_hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float w_noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(w_hash(i), w_hash(i + vec2(1.0, 0.0)), u.x), mix(w_hash(i + vec2(0.0, 1.0)), w_hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float w_fbm(vec2 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * w_noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
`;
