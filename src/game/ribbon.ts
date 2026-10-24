// Guidance chevrons on the road ahead and the next-stop highlight.
import * as THREE from 'three';
import type { RouteTrack, TrackSample } from './track';
import { smoothstep } from './util';

const CHEVRONS = 46;
const SPACING = 5.5;
const AHEAD = 250;

const vert = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute float aAlpha;
varying float vAlpha;
varying vec2 vUv;
void main() {
  vAlpha = aAlpha;
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}`;

const frag = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
varying float vAlpha;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(uColor, vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

function chevronGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const w = 1.3;
  s.moveTo(-w, -0.55);
  s.lineTo(0, 0.25);
  s.lineTo(w, -0.55);
  s.lineTo(w, -0.05);
  s.lineTo(0, 0.75);
  s.lineTo(-w, -0.05);
  s.closePath();
  return new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2);
}

export class Ribbon {
  readonly mesh: THREE.InstancedMesh;
  private alpha: THREE.InstancedBufferAttribute;
  private readonly mat: THREE.ShaderMaterial;
  private readonly tmp: TrackSample = { x: 0, y: 0, hx: 0, hy: 1, heading: 0 };
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private phase = 0;
  visible = true;
  private fade = 1;

  constructor(
    scene: THREE.Scene,
    readonly track: RouteTrack,
    color: string,
  ) {
    const geo = chevronGeometry();
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(CHEVRONS), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.alpha);
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(color) } }]),
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, CHEVRONS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  /** s = distance along route of the bus front. */
  update(dt: number, s: number, offRoute: boolean): void {
    const target = this.visible && !offRoute ? 1 : 0;
    this.fade += (target - this.fade) * Math.min(1, dt * 4);
    this.mesh.visible = this.fade > 0.01;
    if (!this.mesh.visible) return;
    this.phase = (this.phase + dt * 0.55) % 1;
    const L = this.track.length;
    const base = Math.ceil((s + 7) / SPACING) * SPACING;
    for (let i = 0; i < CHEVRONS; i++) {
      const ss = base + i * SPACING;
      const d = ss - s;
      let a = 0;
      if (ss < L - 2 && d < AHEAD) {
        a = smoothstep(6, 18, d) * (1 - smoothstep(AHEAD * 0.55, AHEAD, d));
        // A soft pulse travelling forwards along the ribbon.
        const wave = 0.5 + 0.5 * Math.cos(((d / 60 - this.phase) % 1) * Math.PI * 2);
        a *= 0.5 + 0.32 * wave;
      }
      this.alpha.setX(i, a * this.fade);
      this.track.sample(ss, this.tmp);
      this.pos.set(this.tmp.x, 0.09, -this.tmp.y);
      this.q.setFromAxisAngle(this.up, -this.tmp.heading);
      this.m4.compose(this.pos, this.q, this.one);
      this.mesh.setMatrixAt(i, this.m4);
    }
    this.alpha.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

function bayTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 512);
  ctx.strokeStyle = '#ffd23f';
  ctx.lineWidth = 10;
  ctx.strokeRect(8, 8, 112, 496);
  ctx.fillStyle = 'rgba(255,210,63,0.16)';
  ctx.fillRect(8, 8, 112, 496);
  ctx.save();
  ctx.translate(64, 256);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#ffd23f';
  ctx.font = '900 54px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('BUS STOP', 0, 0);
  ctx.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function beamTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0.9)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}

/** Glowing painted bay at the kerb + a floating marker above the next stop. */
export class NextStopMarker {
  readonly group = new THREE.Group();
  private bay: THREE.Mesh;
  private bayMat: THREE.MeshBasicMaterial;
  private diamond: THREE.Mesh;
  private ring: THREE.Mesh;
  private beam: THREE.Mesh;
  private beamMat: THREE.MeshBasicMaterial;
  private t = 0;
  private stopS = -1;
  private readonly tmp: TrackSample = { x: 0, y: 0, hx: 0, hy: 1, heading: 0 };

  constructor(
    scene: THREE.Scene,
    readonly track: RouteTrack,
    color: string,
  ) {
    this.bayMat = new THREE.MeshBasicMaterial({
      map: bayTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.bay = new THREE.Mesh(new THREE.BufferGeometry(), this.bayMat);
    this.bay.renderOrder = 4;
    this.bay.frustumCulled = false;
    scene.add(this.bay);
    const c = new THREE.Color(color);
    this.diamond = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0).scale(1, 1.6, 1), new THREE.MeshBasicMaterial({ color: c }));
    const edge = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.62, 0).scale(1, 1.6, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.8 }),
    );
    this.diamond.add(edge);
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.15, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.beamMat = new THREE.MeshBasicMaterial({
      color: c.clone().lerp(new THREE.Color(0xffd23f), 0.3),
      alphaMap: beamTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, 40, 16, 1, true).translate(0, 20, 0), this.beamMat);
    this.group.add(this.diamond, this.ring, this.beam);
    scene.add(this.group);
  }

  /** Place the marker at stop position (x, y) and the bay ending at route distance s. */
  setStop(s: number | null, x: number, y: number): void {
    if (s === null) {
      this.group.visible = false;
      this.bay.visible = false;
      this.stopS = -1;
      return;
    }
    this.group.visible = true;
    this.bay.visible = true;
    this.group.position.set(x, 0, -y);
    if (s === this.stopS) return;
    this.stopS = s;
    // Bay strip hugging the kerb, from 16 m before the flag to 2 m past it.
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const s0 = s - 16;
    const s1 = s + 2;
    const steps = 9;
    const w = 3.0;
    for (let k = 0; k <= steps; k++) {
      const ss = s0 + ((s1 - s0) * k) / steps;
      this.track.sample(ss, this.tmp);
      const kb = this.track.kerbAt(ss);
      const lx = -this.tmp.hy;
      const ly = this.tmp.hx;
      const inner = kb - 0.25 - w;
      const outer = kb - 0.25;
      pos.push(this.tmp.x + lx * inner, 0.085, -(this.tmp.y + ly * inner));
      pos.push(this.tmp.x + lx * outer, 0.085, -(this.tmp.y + ly * outer));
      // Texture runs along v from the far end (s1) at the top.
      const v = k / steps;
      uv.push(1, v, 0, v);
      if (k < steps) {
        const a = k * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.bay.geometry.dispose();
    this.bay.geometry = g;
  }

  update(dt: number, distance: number, hours: number): void {
    if (!this.group.visible) return;
    this.t += dt;
    this.diamond.position.y = 5.2 + Math.sin(this.t * 2.2) * 0.25;
    this.diamond.rotation.y += dt * 1.6;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 4);
    this.ring.position.y = 0.1;
    const rs = 1 + pulse * 0.25;
    this.ring.scale.set(rs, 1, rs);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.35 + pulse * 0.45;
    this.bayMat.opacity = 0.55 + pulse * 0.45;
    // The beam is a far-away beacon: fade it out as the bus gets close.
    const night = hours < 6.5 || hours > 18.2;
    this.beamMat.opacity = smoothstep(40, 160, distance) * (night ? 0.45 : 0.4);
    this.beam.visible = this.beamMat.opacity > 0.01;
    // Keep the diamond readable from far away.
    const sc = 1 + smoothstep(80, 600, distance) * 2.5;
    this.diamond.scale.setScalar(sc);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.bay.removeFromParent();
    this.bay.geometry.dispose();
  }
}
