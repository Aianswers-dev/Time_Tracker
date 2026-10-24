/**
 * Sky dome, sun/moon, stars, clouds, lights, fog and the environment map, all
 * driven by local time of day for Brisbane in late October.
 */
import * as THREE from 'three';
import { NOISE_GLSL, SKY_GLSL, U, toDisplay } from './shaders';
import { clamp, smoothstep } from './util';

const DEG = Math.PI / 180;
const LAT = -27.47 * DEG;
/** Solar declination around 23 October. */
const DECL = -11.6 * DEG;
/** Local solar noon in AEST (longitude 153.02 E and the equation of time). */
const SOLAR_NOON = 11.55;

/** Sun direction in three.js world coordinates (x east, y up, z south). */
export function sunDirection(hours: number, out: THREE.Vector3): THREE.Vector3 {
  const h = (hours - SOLAR_NOON) * 15 * DEG;
  const e = -Math.cos(DECL) * Math.sin(h);
  const n = Math.sin(DECL) * Math.cos(LAT) - Math.cos(DECL) * Math.cos(h) * Math.sin(LAT);
  const u = Math.sin(DECL) * Math.sin(LAT) + Math.cos(DECL) * Math.cos(h) * Math.cos(LAT);
  return out.set(e, u, -n).normalize();
}

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const DOME_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDisc;
uniform vec3 uCloud;
uniform vec3 uCloudShade;
uniform float uClouds;
varying vec3 vDir;
${SKY_GLSL}
${NOISE_GLSL}
void main() {
  vec3 dir = normalize(vDir);
  vec3 col = w_sky(dir);
  float sd = dot(dir, uSunDir);
  // sun disc with a soft limb
  col += uSunDisc * smoothstep(0.99985, 0.99993, sd) * 40.0 * (1.0 - uNight);
  float up = dir.y;
  if (up > 0.0) {
    // stars
    vec3 sp = dir * 260.0;
    vec3 cell = floor(sp);
    float st = w_hash3(cell);
    if (st > 0.9965) {
      vec3 f = fract(sp) - 0.5;
      float tw = 0.6 + 0.4 * sin(uTime * (2.0 + st * 9.0) + st * 80.0);
      col += vec3(0.9, 0.95, 1.0) * smoothstep(0.22, 0.0, length(f)) * uNight * tw * smoothstep(0.0, 0.25, up) * 1.6;
    }
    // moon
    float md = dot(dir, uMoonDir);
    float disc = smoothstep(0.99955, 0.99965, md);
    float mare = w_noise(dir.xz * 900.0) * 0.25 + w_noise(dir.xz * 2600.0) * 0.1;
    col = mix(col, vec3(0.95, 0.93, 0.86) * (1.1 - mare) * 1.6, disc * uNight);
    col += vec3(0.25, 0.28, 0.35) * pow(max(md, 0.0), 300.0) * uNight * 0.6;
    // clouds on a plane above the city
    vec2 cp = dir.xz / (up + 0.06) * 1.1 + vec2(uTime * 0.0035, uTime * 0.0012);
    float n = w_fbm(cp * 1.6);
    n += 0.35 * w_fbm(cp * 5.3 + 3.1);
    float cover = smoothstep(uClouds, uClouds + 0.32, n);
    float light = clamp(0.55 + 0.6 * (w_fbm(cp * 1.6 + uSunDir.xz * 0.08) - n) + 0.3 * pow(max(sd, 0.0), 6.0), 0.0, 1.2);
    vec3 ccol = mix(uCloudShade, uCloud, light);
    float fade = smoothstep(0.0, 0.18, up);
    col = mix(col, ccol, cover * fade * 0.92);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface SkyKey {
  e: number;
  zenith: number;
  horizon: number;
  glow: number;
  sun: number;
  sunI: number;
  hemiSky: number;
  hemiGround: number;
  hemiI: number;
  cloud: number;
  shade: number;
  ground: number;
}

/** Keyframes by sun elevation (degrees). Colours are sRGB hex. */
const KEYS: SkyKey[] = [
  { e: -90, zenith: 0x02050c, horizon: 0x0a1020, glow: 0x000000, sun: 0x8aa0d0, sunI: 0.0, hemiSky: 0x3a4a70, hemiGround: 0x1d1b16, hemiI: 0.6, cloud: 0x1b2232, shade: 0x0c1018, ground: 0x06070a },
  { e: -12, zenith: 0x040a18, horizon: 0x101a30, glow: 0x050302, sun: 0x8aa0d0, sunI: 0.0, hemiSky: 0x3a4a70, hemiGround: 0x1d1b16, hemiI: 0.62, cloud: 0x1d2536, shade: 0x0d111a, ground: 0x07080b },
  { e: -6, zenith: 0x0e1a3a, horizon: 0x3a3550, glow: 0x6a3020, sun: 0xff8040, sunI: 0.0, hemiSky: 0x3c4870, hemiGround: 0x201a18, hemiI: 0.5, cloud: 0x4a3a48, shade: 0x1e1c28, ground: 0x0d0d10 },
  { e: -1.5, zenith: 0x203a6c, horizon: 0xd07850, glow: 0xff8a40, sun: 0xff7a30, sunI: 0.15, hemiSky: 0x5a6890, hemiGround: 0x3a2a20, hemiI: 0.75, cloud: 0xf09a70, shade: 0x584a5a, ground: 0x1a1612 },
  { e: 4, zenith: 0x2f5a9a, horizon: 0xf0b080, glow: 0xffb060, sun: 0xffa050, sunI: 1.6, hemiSky: 0x8aa8d0, hemiGround: 0x5a4a38, hemiI: 1.0, cloud: 0xffd0a8, shade: 0x8a7a84, ground: 0x2a2620 },
  { e: 12, zenith: 0x2e62b0, horizon: 0xc8d8e8, glow: 0xffd8a0, sun: 0xffe0b0, sunI: 2.6, hemiSky: 0xa8c4e8, hemiGround: 0x6a5e48, hemiI: 1.15, cloud: 0xfff0e0, shade: 0xa0a8b8, ground: 0x3a3a30 },
  { e: 35, zenith: 0x2a5fb0, horizon: 0xb8d4ee, glow: 0xfff0d0, sun: 0xfff4e4, sunI: 3.1, hemiSky: 0xb0cdf0, hemiGround: 0x6e6450, hemiI: 1.25, cloud: 0xffffff, shade: 0xaab4c4, ground: 0x44443a },
  { e: 90, zenith: 0x245ab0, horizon: 0xb0d0ee, glow: 0xfff6e0, sun: 0xffffff, sunI: 3.3, hemiSky: 0xb4d0f2, hemiGround: 0x726850, hemiI: 1.3, cloud: 0xffffff, shade: 0xb0b8c8, ground: 0x48483e },
];

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();
function lerpHex(a: number, b: number, t: number, out: THREE.Color): THREE.Color {
  tmpA.setHex(a);
  tmpB.setHex(b);
  return out.copy(tmpA).lerp(tmpB, t);
}

export class SkySystem {
  readonly dome: THREE.Mesh;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fog: THREE.FogExp2;
  private readonly envScene = new THREE.Scene();
  private readonly pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envHours = -100;
  private readonly sunDir = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly fogTmp = new THREE.Color();
  private shadowHalf = 0;
  /** Sun elevation in degrees, for other systems. */
  elevation = 45;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
  ) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...U, uClouds: { value: 0.58 } },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 24), mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.dome.name = 'sky';
    scene.add(this.dome);

    const envDome = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), mat.clone());
    (envDome.material as THREE.ShaderMaterial).uniforms = { ...U, uClouds: { value: 0.72 } };
    this.envScene.add(envDome);
    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.15;
    const sc = this.sun.shadow.camera;
    sc.near = 1;
    sc.far = 3000;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xb0cdf0, 0x6e6450, 1.2);
    scene.add(this.hemi);

    this.fog = new THREE.FogExp2(0xb8d4ee, 0.00026);
    scene.fog = this.fog;
    scene.background = new THREE.Color(0x9ec9ef);

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  /** `groundH`: ground height under the camera (shadow box size and placement follow the terrain). */
  update(camera: THREE.Camera, hours: number, groundH = 0): void {
    sunDirection(hours, this.sunDir);
    const e = Math.asin(clamp(this.sunDir.y, -1, 1)) / DEG;
    this.elevation = e;
    U.uSunDir.value.copy(this.sunDir);
    // Moon: roughly opposite the sun, a little north, waxing gibbous feel.
    U.uMoonDir.value.set(-this.sunDir.x * 0.8 + 0.15, Math.max(0.25, -this.sunDir.y * 0.9 + 0.2), -this.sunDir.z * 0.8 - 0.35).normalize();

    let k = 0;
    while (k < KEYS.length - 2 && KEYS[k + 1].e < e) k++;
    const a = KEYS[k];
    const b = KEYS[k + 1];
    const t = clamp((e - a.e) / (b.e - a.e), 0, 1);
    lerpHex(a.zenith, b.zenith, t, U.uSkyZenith.value);
    lerpHex(a.horizon, b.horizon, t, U.uSkyHorizon.value);
    lerpHex(a.glow, b.glow, t, U.uSunGlow.value);
    lerpHex(a.cloud, b.cloud, t, U.uCloud.value);
    lerpHex(a.shade, b.shade, t, U.uCloudShade.value);
    lerpHex(a.ground, b.ground, t, U.uGroundCol.value);
    U.uSunDisc.value.setRGB(1, 0.92, 0.8);
    const night = 1 - smoothstep(-7, 3, e);
    U.uNight.value = night;
    // windows: offices empty late at night, homes lit in the evening
    const hr = ((hours % 24) + 24) % 24;
    const evening = smoothstep(17, 19.5, hr) * (1 - smoothstep(22.5, 25.5, hr));
    const late = hr < 6 ? 1 - smoothstep(4.5, 6.5, hr) : 0;
    // about 35-40% of windows lit at dusk, a quarter at midnight, ~15-20% in the small hours
    U.uLit.value = 0.04 + night * (0.1 + 0.22 * evening + 0.04 * late);

    // Lights: the sun by day, the moon by night.
    const sunI = a.sunI + (b.sunI - a.sunI) * t;
    lerpHex(a.sun, b.sun, t, this.sun.color);
    if (sunI > 0.05) {
      this.sun.intensity = sunI;
      this.tmp.copy(this.sunDir);
    } else {
      this.sun.intensity = 0.45 * night;
      this.sun.color.setHex(0x9fb4e0);
      this.tmp.copy(U.uMoonDir.value);
    }
    lerpHex(a.hemiSky, b.hemiSky, t, this.hemi.color);
    lerpHex(a.hemiGround, b.hemiGround, t, this.hemi.groundColor);
    this.hemi.intensity = a.hemiI + (b.hemiI - a.hemiI) * t;

    // Fog: hazier at dawn/dusk, a little clearer at night.
    const dusk = 1 - smoothstep(4, 16, Math.abs(e));
    this.fog.density = 0.00024 + dusk * 0.00006;
    // For other subsystems' materials (standard three.js fog mixes in display space).
    toDisplay(U.uSkyHorizon.value, this.renderer.toneMappingExposure, this.fogTmp);
    this.fog.color.copy(this.fogTmp);
    (this.scene.background as THREE.Color).copy(this.fogTmp);

    // Shadow box follows the camera, snapped to texels to avoid shimmer.
    const cam = camera as THREE.PerspectiveCamera;
    const camH = Math.max(0, cam.position.y - groundH);
    const half = clamp(110 + camH * 0.9, 110, 700);
    if (Math.abs(half - this.shadowHalf) > 20) {
      this.shadowHalf = half;
      const sc = this.sun.shadow.camera;
      sc.left = -half;
      sc.right = half;
      sc.top = half;
      sc.bottom = -half;
      sc.updateProjectionMatrix();
      this.sun.shadow.normalBias = ((half * 2) / this.sun.shadow.mapSize.x) * 1.2;
    }
    const fwd = this.tmp2.set(0, 0, -1).applyQuaternion(cam.quaternion);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const cx = cam.position.x + fwd.x * this.shadowHalf * 0.55;
    const cz = cam.position.z + fwd.z * this.shadowHalf * 0.55;
    const texel = (this.shadowHalf * 2) / this.sun.shadow.mapSize.x;
    // light-space basis
    const ld = this.tmp;
    const right = this.tmp3.set(0, 1, 0).cross(ld);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const upv = this.tmp4.copy(ld).cross(right).normalize();
    const pr = Math.round((cx * right.x + groundH * right.y + cz * right.z) / texel) * texel;
    const pu = Math.round((cx * upv.x + groundH * upv.y + cz * upv.z) / texel) * texel;
    const pd = cx * ld.x + groundH * ld.y + cz * ld.z;
    const tx = right.x * pr + upv.x * pu + ld.x * pd;
    const ty = right.y * pr + upv.y * pu + ld.y * pd;
    const tz = right.z * pr + upv.z * pu + ld.z * pd;
    this.sun.target.position.set(tx, ty, tz);
    this.sun.position.set(tx + ld.x * 1500, ty + ld.y * 1500, tz + ld.z * 1500);
    this.sun.target.updateMatrixWorld();
    this.sun.castShadow = this.sun.intensity > 0.08 && !location.search.includes('noshadow');

    this.dome.position.copy(cam.position);

    // Environment map for reflective glass, refreshed as the sky changes.
    if (Math.abs(hours - this.envHours) > 0.12 && !location.search.includes('noenv')) {
      this.envHours = hours;
      const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 200);
      this.envRT?.dispose();
      this.envRT = rt;
      this.scene.environment = rt.texture;
    }
  }

  private readonly tmp2 = new THREE.Vector3();
  private readonly tmp3 = new THREE.Vector3();
  private readonly tmp4 = new THREE.Vector3();
}
