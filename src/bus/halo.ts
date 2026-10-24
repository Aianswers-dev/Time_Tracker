// Soft additive glare around headlamps and tail lamps at night. Flat quads
// facing out of the lamp faces, so they vanish edge-on like real beams.
import * as THREE from 'three';
import type { BodyLayout, SectionLayout } from './spec';
import { lampFrame, lampsFor } from './lamps';
import { GeoBuilder, canvasTexture, makeCanvas, type RGB } from './util';

let mat: THREE.MeshBasicMaterial | null = null;

export function haloMaterial(): THREE.MeshBasicMaterial {
  if (mat) return mat;
  const { canvas, ctx } = makeCanvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.12, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  mat = new THREE.MeshBasicMaterial({
    map: canvasTexture(canvas),
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  return mat;
}

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3(0, 1, 0);

export function haloGeometry(B: BodyLayout, sec: SectionLayout): THREE.BufferGeometry | null {
  const defs = lampsFor(B, sec).filter((d) => d.kind === 'head' || d.kind === 'tail');
  if (!defs.length) return null;
  const gb = new GeoBuilder();
  for (const d of defs) {
    lampFrame(B, sec, d, 0.03, _c, _n);
    _r.crossVectors(_u, _n).normalize();
    const head = d.kind === 'head';
    const s = head ? 0.55 : 0.32;
    const col: RGB = head ? [0.55, 0.52, 0.45] : [0.5, 0.02, 0.01];
    const p = (sx: number, sy: number) => ({ x: _c.x + _r.x * sx * s, y: _c.y + sy * s, z: _c.z + _r.z * sx * s });
    gb.quad(p(-1, -1), p(1, -1), p(1, 1), p(-1, 1), col, [0, 0, 1, 1]);
  }
  return gb.build();
}
