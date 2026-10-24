// Brisbane-style bus stop furniture.
//
// Kerbside stops use the TransLink "flag" sign: a double-sided plate on a
// galvanised pole, mounted at right angles to the kerb so approaching buses
// see it face-on. White head with the TransLink mark, a blue panel with the
// bus pictogram and the stop number, then zone / stop ID and the routes that
// call there. A timetable case sits lower on the pole. Busier stops get an
// Adshel-style glass shelter with a back-lit advertising panel; busway stops
// (Cultural Centre, King George Square, ...) are raised platforms with a
// canopy and a station name board.
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

let mats: {
  pole: THREE.MeshLambertMaterial;
  frame: THREE.MeshLambertMaterial;
  roof: THREE.MeshLambertMaterial;
  glass: THREE.MeshLambertMaterial;
  bench: THREE.MeshLambertMaterial;
  concrete: THREE.MeshLambertMaterial;
  tactile: THREE.MeshLambertMaterial;
  canopy: THREE.MeshLambertMaterial;
  caseMat: THREE.MeshLambertMaterial;
  lamp: THREE.MeshBasicMaterial;
  ads: THREE.MeshBasicMaterial[];
} | null = null;

function posterTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const posters: [string, string, string, string][] = [
    ['#ff8a3d', '#ffd166', 'SOUTH BANK', 'Summer nights by the river'],
    ['#1aa39a', '#9be15d', 'GO CARD', 'Tap on. Tap off.'],
    ['#6a3ef0', '#ff5fa2', 'THE VALLEY', 'Live music, every night'],
    ['#0b5ed7', '#5bc0eb', 'XXXX', 'Brewed in Milton since 1878'],
  ];
  posters.forEach(([a, b, title, sub], i) => {
    const x = i * 128;
    const gr = ctx.createLinearGradient(x, 0, x + 128, 256);
    gr.addColorStop(0, a);
    gr.addColorStop(1, b);
    ctx.fillStyle = gr;
    ctx.fillRect(x, 0, 128, 256);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.arc(x + 96, 70, 46, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '900 21px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, x + 64, 170);
    ctx.font = '600 11px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText(sub, x + 64, 192);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function materials(): NonNullable<typeof mats> {
  if (mats) return mats;
  const poster = posterTexture();
  const ads = [0, 1, 2, 3].map((i) => {
    const t = poster.clone();
    t.repeat.set(0.25, 1);
    t.offset.set(i * 0.25, 0);
    t.needsUpdate = true;
    return new THREE.MeshBasicMaterial({ map: t, color: 0xdddddd });
  });
  mats = {
    pole: new THREE.MeshLambertMaterial({ color: 0xa9b1b8 }),
    frame: new THREE.MeshLambertMaterial({ color: 0x3a4148 }),
    roof: new THREE.MeshLambertMaterial({ color: 0x2b3036 }),
    glass: new THREE.MeshLambertMaterial({ color: 0xbfe3f2, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }),
    bench: new THREE.MeshLambertMaterial({ color: 0x8a6a4a }),
    concrete: new THREE.MeshLambertMaterial({ color: 0xb9b6ae }),
    tactile: new THREE.MeshLambertMaterial({ color: 0xf2c200, emissive: 0x332700 }),
    canopy: new THREE.MeshLambertMaterial({ color: 0xeef1f4, emissive: 0x3c4248, side: THREE.DoubleSide }),
    caseMat: new THREE.MeshLambertMaterial({ color: 0x1b2a44 }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xfff1d6 }),
    ads,
  };
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

/** Adshel-style shelter parts. Local frame as above; centred on origin. */
export function shelterParts(adVariant: number): Part[] {
  const m = materials();
  const L = 4.6;
  const D = 1.7;
  const H = 2.55;
  const parts: Part[] = [
    // Roof slab, cantilevered towards the road.
    { geo: box(D + 0.35, 0.12, L + 0.3, 0.2, H, 0), mat: m.roof },
    // LED strip under the roof.
    { geo: box(0.12, 0.02, L - 0.6, -0.1, H - 0.07, 0), mat: m.lamp },
    // Back posts.
    { geo: box(0.08, H, 0.08, -D / 2, H / 2, -L / 2 + 0.1), mat: m.frame },
    { geo: box(0.08, H, 0.08, -D / 2, H / 2, L / 2 - 0.1), mat: m.frame },
    { geo: box(0.08, H, 0.08, -D / 2, H / 2, 0), mat: m.frame },
    // Glass back wall and one glass end.
    { geo: box(0.02, H - 0.35, L - 0.2, -D / 2 + 0.03, (H - 0.35) / 2 + 0.15, 0), mat: m.glass },
    { geo: box(D - 0.25, H - 0.35, 0.02, -0.1, (H - 0.35) / 2 + 0.15, -L / 2 + 0.1), mat: m.glass },
    // Bench.
    { geo: box(0.42, 0.05, 2.1, -D / 2 + 0.3, 0.46, 0.4), mat: m.bench },
    { geo: box(0.05, 0.46, 0.05, -D / 2 + 0.3, 0.23, -0.5), mat: m.frame },
    { geo: box(0.05, 0.46, 0.05, -D / 2 + 0.3, 0.23, 1.3), mat: m.frame },
    // Advertising light box at the downstream end.
    { geo: box(D - 0.25, 1.85, 0.16, -0.1, 1.15, L / 2 - 0.12), mat: m.frame },
    { geo: new THREE.PlaneGeometry(D - 0.4, 1.7).translate(0, 0, 0.085).translate(-0.1, 1.15, L / 2 - 0.12), mat: m.ads[adVariant % 4] },
    { geo: new THREE.PlaneGeometry(D - 0.4, 1.7).rotateY(Math.PI).translate(0, 0, -0.085).translate(-0.1, 1.15, L / 2 - 0.12), mat: m.ads[(adVariant + 1) % 4] },
  ];
  return parts;
}

function stationSignTexture(name: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#0b1f3a';
  ctx.fillRect(0, 0, 1024, 128);
  ctx.fillStyle = '#e463a4';
  ctx.fillRect(0, 118, 1024, 10);
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect(18, 18, 92, 92, 18);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.translate(26, 30);
  ctx.strokeStyle = '#e463a4';
  ctx.lineCap = 'round';
  ctx.lineWidth = 15;
  ctx.beginPath();
  ctx.arc(38, 40, 26, Math.PI * 0.95, Math.PI * 2.15);
  ctx.stroke();
  ctx.lineWidth = 11;
  ctx.beginPath();
  ctx.moveTo(38, 4);
  ctx.lineTo(38, 56);
  ctx.stroke();
  ctx.restore();
  const label = name.replace(/,?\s*(platform\s*\d+[a-z]?|\d+[a-z])$/i, '').replace(/\s+busway station$/i, ' station');
  const plat = /platform\s*(\d+[a-z]?)$/i.exec(name)?.[1] ?? /,\s*(\d+[a-z])$/i.exec(name)?.[1];
  ctx.fillStyle = '#fff';
  ctx.font = '800 58px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textBaseline = 'middle';
  let size = 58;
  while (ctx.measureText(label).width > (plat ? 700 : 860) && size > 30) {
    size -= 2;
    ctx.font = `800 ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
  }
  ctx.fillText(label, 134, 64);
  if (plat) {
    ctx.fillStyle = '#00a5b5';
    ctx.beginPath();
    ctx.roundRect(1024 - 150, 20, 130, 88, 14);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = '800 22px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText('PLATFORM', 1024 - 85, 42);
    ctx.font = '900 46px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText(plat.toUpperCase(), 1024 - 85, 82);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Busway platform with canopy; local frame as above, origin at the platform's road edge centre. */
export function stationGroup(name: string): THREE.Group {
  const m = materials();
  const g = new THREE.Group();
  const L = 34;
  const W = 4.2;
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const mesh = new THREE.Mesh(geo, mat);
    g.add(mesh);
    return mesh;
  };
  add(box(W, 0.32, L, -W / 2, 0.16, 0), m.concrete);
  add(box(0.6, 0.01, L, -0.35, 0.325, 0), m.tactile);
  // Canopy on a row of columns at the back.
  for (let z = -L / 2 + 2; z <= L / 2 - 2; z += 6) add(box(0.22, 4.2, 0.22, -W + 0.4, 2.42, z), m.frame);
  add(box(W + 1.0, 0.18, L - 1, -W / 2 + 0.3, 4.55, 0), m.canopy);
  for (const x of [-W + 1.0, -1.0]) add(box(0.14, 0.03, L - 3, x, 4.44, 0), m.lamp);
  add(box(0.12, 0.35, L - 1, 0.75, 4.4, 0), m.roof);
  // Back glass balustrade.
  add(box(0.03, 1.1, L - 2, -W + 0.15, 0.32 + 0.55, 0), m.glass);
  // Benches.
  for (const z of [-8, 0, 8]) add(box(0.45, 0.06, 2.2, -W + 0.8, 0.8, z), m.bench);
  // Name boards hanging from the canopy, facing both directions of travel.
  const tex = stationSignTexture(name);
  const signMat = new THREE.MeshBasicMaterial({ map: tex });
  for (const z of [-L / 2 + 4, L / 2 - 4]) {
    const board = add(box(3.6, 0.45, 0.06, -W / 2, 3.85, z), m.frame);
    void board;
    add(new THREE.PlaneGeometry(3.5, 0.44).translate(-W / 2, 3.85, z + 0.035), signMat);
    add(new THREE.PlaneGeometry(3.5, 0.44).rotateY(Math.PI).translate(-W / 2, 3.85, z - 0.035), signMat);
  }
  return g;
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
