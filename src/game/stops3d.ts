// Brisbane-style bus stop flags for the player's route (the world draws the
// shelters at every stop; busway platforms live in platforms.ts).
//
// Kerbside stops use the TransLink "flag" sign: a double-sided plate on a
// galvanised pole, mounted at right angles to the kerb so approaching buses
// see it face-on. White head with the TransLink mark, a blue panel with the
// bus pictogram and the stop number, then zone / stop ID and the routes that
// call there. A timetable case sits lower on the pole.
import * as THREE from 'three';
import { routesServing, stopNumber } from './routeMeta';
import type { MapData } from '../types';

export const SIGN_W = 0.46;
export const SIGN_H = 0.8;
const CELL_W = 128;
const CELL_H = 224;

function translinkMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  // Pink swoosh "t" mark followed by a lowercase wordmark.
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = '#e463a4';
  ctx.lineCap = 'round';
  ctx.lineWidth = size * 0.22;
  ctx.beginPath();
  ctx.arc(size * 0.42, size * 0.55, size * 0.36, Math.PI * 0.95, Math.PI * 2.15);
  ctx.stroke();
  ctx.lineWidth = size * 0.16;
  ctx.beginPath();
  ctx.moveTo(size * 0.42, size * 0.05);
  ctx.lineTo(size * 0.42, size * 0.75);
  ctx.stroke();
  ctx.fillStyle = '#1b2a5c';
  ctx.font = `800 ${Math.round(size * 0.62)}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText('translink', size * 0.95, size * 0.5);
  ctx.restore();
}

function busPictogram(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number): void {
  const h = w * 0.82;
  const x = cx - w / 2;
  const y = cy - h / 2;
  ctx.fillStyle = '#fff';
  const r = w * 0.12;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h * 0.86, r);
  ctx.fill();
  ctx.fillStyle = '#1556a8';
  ctx.beginPath();
  ctx.roundRect(x + w * 0.1, y + h * 0.12, w * 0.8, h * 0.36, r * 0.4);
  ctx.fill();
  ctx.fillRect(x + w * 0.2, y + h * 0.02, w * 0.6, h * 0.05);
  ctx.fillStyle = '#1556a8';
  ctx.beginPath();
  ctx.arc(x + w * 0.22, y + h * 0.68, w * 0.07, 0, Math.PI * 2);
  ctx.arc(x + w * 0.78, y + h * 0.68, w * 0.07, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillRect(x + w * 0.1, y + h * 0.84, w * 0.18, h * 0.16);
  ctx.fillRect(x + w * 0.72, y + h * 0.84, w * 0.18, h * 0.16);
}

/** Draw one flag sign face into a CELL_W x CELL_H cell. */
export function drawFlag(ctx: CanvasRenderingContext2D, ox: number, oy: number, num: string | null, code: string | null, routes: string[]): void {
  const W = CELL_W;
  const H = CELL_H;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // TransLink head.
  translinkMark(ctx, 9, 8, 20);
  // Blue panel.
  ctx.fillStyle = '#1556a8';
  ctx.fillRect(0, 36, W, num ? 118 : 104);
  busPictogram(ctx, W / 2, 72, 50);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  if (num) {
    ctx.font = '700 15px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText('STOP', W / 2, 118);
    const big = num.length > 4 ? 26 : 34;
    ctx.font = `900 ${big}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.fillText(num, W / 2, 148);
  } else {
    ctx.font = '800 20px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText('BUS', W / 2, 118);
    ctx.font = '800 20px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText('STOP', W / 2, 136);
  }
  // Zone + stop ID.
  const by = num ? 154 : 140;
  ctx.fillStyle = '#0b1f3a';
  ctx.fillRect(0, by, W, 20);
  ctx.fillStyle = '#fff';
  ctx.font = '700 12px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText(code ? `ZONE 1 · ${code}` : 'ZONE 1', W / 2, by + 14);
  // Routes.
  if (routes.length) {
    ctx.font = '800 12px system-ui, -apple-system, Segoe UI, sans-serif';
    const shown = routes.slice(0, 12);
    let x = 6;
    let y = by + 26;
    for (const r of shown) {
      const w = ctx.measureText(r).width + 8;
      if (x + w > W - 4) {
        x = 6;
        y += 16;
      }
      if (y > H - 14) break;
      ctx.fillStyle = '#e463a4';
      ctx.beginPath();
      ctx.roundRect(x, y, w, 14, 3);
      ctx.fill();
      ctx.fillStyle = '#1d1d1d';
      ctx.textAlign = 'left';
      ctx.fillText(r, x + 4, y + 11);
      x += w + 3;
    }
  }
  // Thin border.
  ctx.strokeStyle = '#c9d1db';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);
  ctx.restore();
}

/** Atlas of flag faces, one cell per stop. Returns the texture and a UV rect per stop. */
export function flagAtlas(data: MapData, stopIdx: number[], generic: boolean): { tex: THREE.CanvasTexture; uv: [number, number, number, number][] } {
  const cols = 8;
  const n = Math.max(1, stopIdx.length);
  const rows = Math.ceil(n / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * CELL_W;
  canvas.height = rows * CELL_H;
  const ctx = canvas.getContext('2d')!;
  const serving = routesServing(data);
  const uv: [number, number, number, number][] = [];
  stopIdx.forEach((si, k) => {
    const cx = (k % cols) * CELL_W;
    const cy = Math.floor(k / cols) * CELL_H;
    const s = data.stops[si];
    if (generic) drawFlag(ctx, cx, cy, null, null, []);
    else drawFlag(ctx, cx, cy, stopNumber(s.name), s.code, serving[si] ?? []);
    uv.push([cx / canvas.width, 1 - (cy + CELL_H) / canvas.height, CELL_W / canvas.width, CELL_H / canvas.height]);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, uv };
}

/** Plate geometry with UVs pointing at one atlas cell on both large faces. */
export function plateGeometry(uv: [number, number, number, number]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(SIGN_W, SIGN_H, 0.03);
  const a = g.getAttribute('uv') as THREE.BufferAttribute;
  const [u0, v0, du, dv] = uv;
  // Box faces: +x, -x, +y, -y, +z, -z (4 verts each). Map the +z and -z faces to the cell.
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      if (f === 4 || f === 5) a.setXY(i, u0 + a.getX(i) * du, v0 + a.getY(i) * dv);
      else a.setXY(i, u0 + 0.02 * du, v0 + 0.02 * dv); // edges: plain white
    }
  }
  a.needsUpdate = true;
  return g;
}

// ---------------------------------------------------------------------------
// Shared materials (created lazily, reused by every stop)

let mats: { pole: THREE.MeshLambertMaterial; caseMat: THREE.MeshLambertMaterial } | null = null;

function materials(): NonNullable<typeof mats> {
  if (!mats) mats = { pole: new THREE.MeshLambertMaterial({ color: 0xa9b1b8 }), caseMat: new THREE.MeshLambertMaterial({ color: 0x1b2a44 }) };
  return mats;
}

export interface Part {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

/**
 * Stop pole parts in the stop's local frame: origin at the pole base,
 * -Z = direction of travel, +X = towards the road.
 */
export function poleParts(): Part[] {
  const m = materials();
  return [
    { geo: new THREE.CylinderGeometry(0.04, 0.045, 3.15, 8).translate(0, 1.575, 0), mat: m.pole },
    { geo: box(0.32, 0.5, 0.06, 0.1, 1.45, 0), mat: m.caseMat },
  ];
}

/** Group made of parts (one mesh per part). */
export function partsGroup(parts: Part[]): THREE.Group {
  const g = new THREE.Group();
  for (const p of parts) g.add(new THREE.Mesh(p.geo, p.mat));
  return g;
}

export function signMaterial(tex: THREE.Texture): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.28 });
}
