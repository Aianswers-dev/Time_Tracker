// Shared textures and materials. Everything cached at module level is shared
// by all buses and must never be disposed by an individual bus.
import * as THREE from 'three';
import { FONT, canvasTexture, makeCanvas, roundRect } from './util';

let env: THREE.Texture | null = null;

/** Small procedural sky/city equirect used for paint and glass reflections. */
export function envMap(): THREE.Texture {
  if (env) return env;
  const { canvas, ctx } = makeCanvas(512, 256);
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#5f93d0');
  g.addColorStop(0.42, '#b9d3ec');
  g.addColorStop(0.5, '#dfe7ee');
  g.addColorStop(0.52, '#6c6f72');
  g.addColorStop(0.7, '#4a4c4f');
  g.addColorStop(1, '#2f3032');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 256);
  // skyline silhouettes around the horizon
  let x = 0;
  let k = 7;
  while (x < 512) {
    k = (k * 9301 + 49297) % 233280;
    const w = 8 + (k % 22);
    const h = 6 + ((k >> 3) % 34);
    ctx.fillStyle = `rgb(${120 + (k % 40)},${128 + (k % 36)},${140 + (k % 30)})`;
    ctx.fillRect(x, 128 - h, w, h + 2);
    x += w + (k % 5);
  }
  // a soft sun glint
  const s = ctx.createRadialGradient(150, 40, 0, 150, 40, 40);
  s.addColorStop(0, 'rgba(255,255,240,0.9)');
  s.addColorStop(1, 'rgba(255,255,240,0)');
  ctx.fillStyle = s;
  ctx.fillRect(100, 0, 100, 90);
  const t = canvasTexture(canvas);
  t.mapping = THREE.EquirectangularReflectionMapping;
  env = t;
  return t;
}

let wheelTex: THREE.Texture | null = null;

/** Wheel atlas: left half = outer face (tyre wall, rim, hub), right half = tread. */
export function wheelTexture(): THREE.Texture {
  if (wheelTex) return wheelTex;
  const { canvas, ctx } = makeCanvas(512, 256);
  const cx = 128, cy = 128;
  ctx.fillStyle = '#141415';
  ctx.fillRect(0, 0, 512, 256);
  const wall = ctx.createRadialGradient(cx, cy, 70, cx, cy, 128);
  wall.addColorStop(0, '#202022');
  wall.addColorStop(0.7, '#262628');
  wall.addColorStop(1, '#111112');
  ctx.fillStyle = wall;
  ctx.beginPath();
  ctx.arc(cx, cy, 127, 0, Math.PI * 2);
  ctx.fill();
  // sidewall lettering
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = '#3a3a3d';
  ctx.font = `bold 13px ${FONT}`;
  ctx.textAlign = 'center';
  const label = 'XZU 3  275/70 R22.5  TUBELESS  152/148J   ';
  for (let i = 0; i < label.length; i++) {
    ctx.save();
    ctx.rotate((i / label.length) * Math.PI * 2);
    ctx.fillText(label[i], 0, -104);
    ctx.restore();
  }
  ctx.restore();
  // rim
  const rim = ctx.createRadialGradient(cx - 18, cy - 18, 10, cx, cy, 76);
  rim.addColorStop(0, '#f2f4f6');
  rim.addColorStop(0.6, '#c3c8cd');
  rim.addColorStop(1, '#7e848b');
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(cx, cy, 76, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#5c6168';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, 68, 0, Math.PI * 2);
  ctx.stroke();
  // hand holes
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * 52, cy + Math.sin(a) * 52);
    ctx.rotate(a);
    ctx.fillStyle = '#18191b';
    ctx.beginPath();
    ctx.ellipse(0, 0, 7, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // hub and nuts
  ctx.fillStyle = '#4a4e54';
  ctx.beginPath();
  ctx.arc(cx, cy, 36, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.31;
    ctx.fillStyle = '#d6dade';
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * 27, cy + Math.sin(a) * 27, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#9aa0a7';
  ctx.beginPath();
  ctx.arc(cx, cy, 15, 0, Math.PI * 2);
  ctx.fill();
  // tread (right half): grooves around the circumference
  ctx.fillStyle = '#19191a';
  ctx.fillRect(256, 0, 256, 256);
  ctx.fillStyle = '#0c0c0d';
  for (const y of [50, 98, 158, 206]) ctx.fillRect(256, y, 256, 9);
  for (let x = 256; x < 512; x += 12) ctx.fillRect(x, 0, 3, 256);
  wheelTex = canvasTexture(canvas);
  return wheelTex;
}

const doorTex = new Map<string, THREE.Texture>();

/** One door leaf: dark frame, tinted glass (alpha), mid rail; Metro gets hazard edges. */
export function doorTexture(metro: boolean): THREE.Texture {
  const key = metro ? 'metro' : 'std';
  const hit = doorTex.get(key);
  if (hit) return hit;
  const { canvas, ctx } = makeCanvas(128, 512);
  ctx.clearRect(0, 0, 128, 512);
  ctx.fillStyle = metro ? '#d8dadd' : '#101214';
  ctx.fillRect(0, 0, 128, 512);
  // glass panes
  ctx.clearRect(12, 14, 104, 220);
  ctx.clearRect(12, 262, 104, 236);
  ctx.fillStyle = 'rgba(18,26,34,0.5)';
  ctx.fillRect(12, 14, 104, 220);
  ctx.fillRect(12, 262, 104, 236);
  // rubber seal on the meeting edge (u = 1)
  ctx.fillStyle = '#060708';
  ctx.fillRect(116, 0, 12, 512);
  if (metro) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(84, 0, 32, 512);
    ctx.clip();
    ctx.fillStyle = '#f2c200';
    ctx.fillRect(84, 0, 32, 512);
    ctx.fillStyle = '#111';
    for (let y = -40; y < 560; y += 36) {
      ctx.beginPath();
      ctx.moveTo(84, y);
      ctx.lineTo(116, y + 22);
      ctx.lineTo(116, y + 40);
      ctx.lineTo(84, y + 18);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  // door button and sticker (no text: rear leaves are mirrored instances)
  ctx.fillStyle = '#f7d117';
  roundRect(ctx, 34, 236, 30, 22, 4);
  ctx.fill();
  ctx.fillStyle = '#1a7a32';
  ctx.beginPath();
  ctx.arc(49, 247, 6, 0, Math.PI * 2);
  ctx.fill();
  const t = canvasTexture(canvas);
  doorTex.set(key, t);
  return t;
}

let moquette: THREE.Texture | null = null;

/**
 * Seat atlas: u < 0.75 is TransLink moquette (royal blue with light blue
 * waves and lime specks), u >= 0.75 grey seat-shell plastic.
 */
export function seatTexture(): THREE.Texture {
  if (moquette) return moquette;
  const { canvas, ctx } = makeCanvas(256, 256);
  ctx.fillStyle = '#1b3c9c';
  ctx.fillRect(0, 0, 192, 256);
  ctx.strokeStyle = '#4aa2ee';
  ctx.lineWidth = 5;
  for (let y = -10; y < 270; y += 22) {
    ctx.beginPath();
    for (let x = 0; x <= 192; x += 6) {
      const yy = y + Math.sin(x / 15 + y * 0.3) * 5;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  let k = 11;
  for (let i = 0; i < 520; i++) {
    k = (k * 1103515245 + 12345) & 0x7fffffff;
    const x = k % 192;
    const y = (k >> 8) % 256;
    ctx.fillStyle = i % 3 ? '#cfe05a' : '#e7ef8a';
    ctx.fillRect(x, y, 2 + (k % 3), 2);
  }
  ctx.fillStyle = '#8f959c';
  ctx.fillRect(192, 0, 64, 256);
  ctx.fillStyle = '#2b2e33';
  ctx.fillRect(192, 200, 64, 56);
  const t = canvasTexture(canvas);
  t.wrapS = THREE.ClampToEdgeWrapping;
  moquette = t;
  return t;
}

export const SEAT_UV = {
  fabric: [0.02, 0.25, 0.72, 0.98] as [number, number, number, number],
  plastic: [0.78, 0.3, 0.98, 0.95] as [number, number, number, number],
  dark: [0.8, 0.02, 0.98, 0.18] as [number, number, number, number],
};
