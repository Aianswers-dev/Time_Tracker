// First-person driver's cab: right-hand drive dash with canvas instruments,
// a big flat bus steering wheel, ticketing console, go card readers, driver's
// safety screen, destination box backside, sun visor and the full saloon.
import * as THREE from 'three';
import type { BusType, Cab, CabState } from '../types';
import { layoutFor, type BodyLayout, type SectionLayout } from './spec';
import { frontZ } from './shell';
import { buildSaloon } from './saloon';
import { playerSign } from './state';
import { FONT, GeoBuilder, canvasTexture, makeCanvas, mat4, rgb, roundRect, type RGB } from './util';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// dynamic canvas regions (512 x 256)
const DYN = { w: 512, h: 256 };
const R_CLUSTER = { x: 0, y: 0, w: 512, h: 184 };
const R_STOP = { x: 0, y: 184, w: 384, h: 72 };
const R_TICKET = { x: 384, y: 184, w: 128, h: 72 };
// static canvas regions (512 x 256)
const STA = { w: 512, h: 256 };
const R_SWITCH_R = { x: 0, y: 0, w: 256, h: 128 };
const R_SWITCH_L = { x: 256, y: 0, w: 256, h: 128 };
const R_READER = { x: 0, y: 128, w: 96, h: 128 };
const R_STICKER = { x: 96, y: 128, w: 208, h: 64 };
const R_CCTV = { x: 96, y: 192, w: 208, h: 64 };
const R_DESTCTL = { x: 304, y: 128, w: 208, h: 128 };

type Reg = { x: number; y: number; w: number; h: number };

function uvRect(r: Reg, W: number, H: number): [number, number, number, number] {
  return [r.x / W, 1 - (r.y + r.h) / H, (r.x + r.w) / W, 1 - r.y / H];
}

/** Quad centred at c, spanning `w` along `right` and `h` along `up`. */
function panel(gb: GeoBuilder, c: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, w: number, h: number, uv: [number, number, number, number]): void {
  const r = right.clone().multiplyScalar(w / 2);
  const u = up.clone().multiplyScalar(h / 2);
  gb.quad(c.clone().sub(r).sub(u), c.clone().add(r).sub(u), c.clone().add(r).add(u), c.clone().sub(r).add(u), [1, 1, 1], uv);
}

/** Up/right vectors for a panel whose normal points toward `target` from `c` (roll-free). */
function facing(c: THREE.Vector3, target: THREE.Vector3): { right: THREE.Vector3; up: THREE.Vector3 } {
  const n = target.clone().sub(c).normalize();
  const right = new THREE.Vector3(0, 1, 0).cross(n).normalize();
  const up = n.clone().cross(right).normalize();
  return { right, up };
}

// ---------------------------------------------------------------------------
// Instruments

function dial(c: CanvasRenderingContext2D, cx: number, cy: number, r: number, value: number, max: number, major: number, minor: number, label: string, scale: number, bands: [number, number, string][]): void {
  const a0 = (135 * Math.PI) / 180;
  const sweep = (270 * Math.PI) / 180;
  const ang = (v: number) => a0 + sweep * Math.max(0, Math.min(1, v / max));
  const face = c.createRadialGradient(cx, cy - r * 0.3, r * 0.1, cx, cy, r);
  face.addColorStop(0, '#1d2026');
  face.addColorStop(1, '#090a0c');
  c.fillStyle = face;
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = '#6f757d';
  c.lineWidth = 3;
  c.stroke();
  for (const [v0, v1, col] of bands) {
    c.strokeStyle = col;
    c.lineWidth = 5;
    c.beginPath();
    c.arc(cx, cy, r - 9, ang(v0), ang(v1));
    c.stroke();
  }
  c.strokeStyle = '#e8ecf2';
  c.fillStyle = '#e8ecf2';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = `bold ${Math.round(r * 0.2)}px ${FONT}`;
  for (let v = 0; v <= max + 1e-6; v += minor) {
    const a = ang(v);
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
    const r0 = r - (isMajor ? 16 : 11);
    c.lineWidth = isMajor ? 2.5 : 1.3;
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    c.lineTo(cx + Math.cos(a) * (r - 5), cy + Math.sin(a) * (r - 5));
    c.stroke();
    if (isMajor) c.fillText(String(Math.round(v * scale)), cx + Math.cos(a) * (r - 29), cy + Math.sin(a) * (r - 29));
  }
  c.font = `${Math.round(r * 0.13)}px ${FONT}`;
  c.fillStyle = '#9aa2ad';
  c.fillText(label, cx, cy + r * 0.42);
  // needle
  const a = ang(value);
  c.strokeStyle = '#ff3b1f';
  c.lineWidth = 3.5;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(cx - Math.cos(a) * 12, cy - Math.sin(a) * 12);
  c.lineTo(cx + Math.cos(a) * (r - 12), cy + Math.sin(a) * (r - 12));
  c.stroke();
  c.lineCap = 'butt';
  c.fillStyle = '#2a2e35';
  c.beginPath();
  c.arc(cx, cy, 9, 0, Math.PI * 2);
  c.fill();
}

function arrow(c: CanvasRenderingContext2D, x: number, y: number, dir: 1 | -1, on: boolean): void {
  c.fillStyle = on ? '#2cff4a' : '#0f2a14';
  c.beginPath();
  c.moveTo(x + dir * 14, y);
  c.lineTo(x, y - 11);
  c.lineTo(x, y - 5);
  c.lineTo(x - dir * 12, y - 5);
  c.lineTo(x - dir * 12, y + 5);
  c.lineTo(x, y + 5);
  c.lineTo(x, y + 11);
  c.closePath();
  c.fill();
}

function lamp(c: CanvasRenderingContext2D, x: number, y: number, text: string, on: boolean, col: string): void {
  c.fillStyle = on ? col : '#1a1c20';
  roundRect(c, x - 19, y - 9, 38, 18, 4);
  c.fill();
  c.fillStyle = on ? '#000' : '#3a3e45';
  c.font = `bold 10px ${FONT}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, x, y + 1);
}

function headlampIcon(c: CanvasRenderingContext2D, x: number, y: number, on: boolean): void {
  c.strokeStyle = on ? '#2cff4a' : '#183020';
  c.fillStyle = c.strokeStyle;
  c.lineWidth = 2;
  c.beginPath();
  c.ellipse(x - 3, y, 6, 8, 0, Math.PI / 2, Math.PI * 1.5, true);
  c.closePath();
  c.fill();
  for (const dy of [-6, -2, 2, 6]) {
    c.beginPath();
    c.moveTo(x + 5, y + dy);
    c.lineTo(x + 14, y + dy + 2);
    c.stroke();
  }
}

interface ClusterState {
  speed: number;
  rpm: number;
  flash: boolean;
  st: CabState;
  trip: number;
  metro: boolean;
}

function drawCluster(c: CanvasRenderingContext2D, s: ClusterState): void {
  const { x, y, w, h } = R_CLUSTER;
  c.save();
  c.translate(x, y);
  c.fillStyle = '#050607';
  c.fillRect(0, 0, w, h);
  const bez = c.createLinearGradient(0, 0, 0, h);
  bez.addColorStop(0, '#2a2d33');
  bez.addColorStop(1, '#121316');
  c.fillStyle = bez;
  roundRect(c, 2, 2, w - 4, h - 4, 22);
  c.fill();
  const st = s.st;
  const L = st.lights;
  if (!s.metro) {
    dial(c, 98, 96, 80, s.speed, 120, 20, 10, 'km/h', 1, [[60, 120, '#7a1c1c']]);
    dial(c, 414, 96, 80, s.rpm / 100, 30, 5, 2.5, 'x1000 r/min', 0.1, [[10, 18, '#1f7a3a'], [26, 30, '#a01818']]);
  } else {
    // Metro: power meter instead of a tachometer
    dial(c, 98, 96, 80, s.speed, 100, 20, 10, 'km/h', 1, [[70, 100, '#7a1c1c']]);
    const p = Math.max(0, Math.min(100, ((s.rpm - 700) / 2300) * 100));
    dial(c, 414, 96, 80, p, 100, 25, 12.5, 'POWER %', 1, [[0, 25, '#1f5f9a'], [75, 100, '#a01818']]);
  }
  // centre LCD
  c.fillStyle = '#0d1621';
  roundRect(c, 184, 22, 144, 144, 10);
  c.fill();
  c.strokeStyle = '#3c4552';
  c.lineWidth = 2;
  c.stroke();
  const left = L.indicatorLeft || L.hazards;
  const right = L.indicatorRight || L.hazards;
  arrow(c, 206, 38, -1, left && s.flash);
  arrow(c, 306, 38, 1, right && s.flash);
  headlampIcon(c, 250, 38, L.headlights);
  c.fillStyle = '#d6e6ff';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = `bold 46px ${FONT}`;
  c.fillText(String(Math.round(s.speed)), 256, 84);
  c.font = `bold 11px ${FONT}`;
  c.fillStyle = '#7f93ad';
  c.fillText('km/h', 256, 110);
  c.font = `bold 22px ${FONT}`;
  c.fillStyle = L.reverse ? '#ffb020' : '#7fffa0';
  c.fillText(L.reverse ? 'R' : s.speed < 0.5 && s.rpm < 760 ? 'N' : 'D', 206, 84);
  c.font = `11px ${FONT}`;
  c.fillStyle = '#9fb4d0';
  const t = Math.floor(st.timeSeconds);
  c.fillText(`TRIP ${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`, 256, 128);
  c.fillText(`${s.trip.toFixed(2)} km   27°C`, 256, 143);
  const msg = st.doorsOpen ? 'DOORS OPEN' : st.stopRequested ? 'STOP REQUESTED' : s.metro ? 'SOC 78%' : 'FUEL ▮▮▮▮▯';
  c.fillStyle = st.doorsOpen || st.stopRequested ? '#ffb020' : '#6f8aa8';
  c.font = `bold 11px ${FONT}`;
  c.fillText(msg, 256, 158);
  // tell-tale row along the bottom
  lamp(c, 40, 170, 'DOOR', st.doorsOpen, '#ff8a00');
  lamp(c, 84, 170, 'STOP', st.stopRequested, '#ff2a1a');
  lamp(c, 128, 170, 'BRAKE', L.brake && s.speed < 1, '#ff2a1a');
  lamp(c, 384, 170, 'HAZ', L.hazards && s.flash, '#ff2a1a');
  lamp(c, 428, 170, 'ABS', false, '#ffb000');
  lamp(c, 472, 170, s.metro ? 'READY' : 'ECAS', true, '#2cff4a');
  c.restore();
}

function drawStop(c: CanvasRenderingContext2D, st: CabState): void {
  const { x, y, w, h } = R_STOP;
  c.save();
  c.translate(x, y);
  c.fillStyle = '#060404';
  c.fillRect(0, 0, w, h);
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  if (st.stopRequested) {
    c.fillStyle = '#ff2b14';
    c.font = `bold 40px ${FONT}`;
    c.fillText('BUS STOPPING', w / 2, h / 2 + 2);
  } else {
    c.fillStyle = '#ff7a1a';
    c.font = `bold 26px ${FONT}`;
    const t = playerSign.route ? `${playerSign.route}  ${playerSign.headsign}` : 'translink.com.au';
    c.fillText(t.slice(0, 26), w / 2, h / 2 + 2, w - 12);
  }
  // LED grid mask
  c.fillStyle = 'rgba(0,0,0,0.55)';
  for (let i = 0; i < w; i += 4) c.fillRect(i, 0, 1.4, h);
  for (let j = 0; j < h; j += 4) c.fillRect(0, j, w, 1.4);
  c.restore();
}

function drawTicket(c: CanvasRenderingContext2D, st: CabState): void {
  const { x, y, w, h } = R_TICKET;
  c.save();
  c.translate(x, y);
  c.fillStyle = '#0c2a5a';
  c.fillRect(0, 0, w, h);
  c.fillStyle = '#ffffff';
  c.font = `bold 12px ${FONT}`;
  c.textAlign = 'left';
  c.textBaseline = 'top';
  c.fillText(`Route ${playerSign.route || '--'}`, 5, 4);
  c.font = `10px ${FONT}`;
  c.fillText((playerSign.headsign || 'Not in service').slice(0, 20), 5, 19);
  c.fillStyle = '#f6c400';
  c.font = `bold 13px ${FONT}`;
  c.fillText('50c FARES', 5, 34);
  c.fillStyle = '#9ec5ff';
  c.font = `10px ${FONT}`;
  const t = Math.floor(st.timeSeconds);
  c.fillText(`go card  ✔   ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, 5, 52);
  c.restore();
}

function drawStatic(c: CanvasRenderingContext2D): void {
  c.fillStyle = '#16181c';
  c.fillRect(0, 0, STA.w, STA.h);
  const sw = (r: Reg, labels: [string, string][]) => {
    c.save();
    c.translate(r.x, r.y);
    c.fillStyle = '#1e2025';
    c.fillRect(0, 0, r.w, r.h);
    const cols = 4;
    labels.forEach(([lab, col], i) => {
      const cx = 12 + (i % cols) * 60;
      const cy = 10 + Math.floor(i / cols) * 58;
      c.fillStyle = '#0c0d0f';
      roundRect(c, cx, cy, 50, 46, 6);
      c.fill();
      c.fillStyle = col;
      roundRect(c, cx + 6, cy + 5, 38, 24, 4);
      c.fill();
      c.fillStyle = '#d8dce2';
      c.font = `bold 9px ${FONT}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(lab, cx + 25, cy + 38);
    });
    c.restore();
  };
  sw(R_SWITCH_R, [['HAZARD', '#a3201b'], ['LIGHTS', '#30343a'], ['WIPER', '#30343a'], ['DEMIST', '#30343a'], ['INT LT', '#30343a'], ['KNEEL', '#b8860b'], ['RAMP', '#1f4f9a'], ['A/C', '#30343a']]);
  sw(R_SWITCH_L, [['DOOR 1', '#1e7a35'], ['DOOR 2', '#1e7a35'], ['PRAM', '#30343a'], ['P BRAKE', '#a3201b'], ['HORN', '#30343a'], ['RADIO', '#30343a'], ['CCTV', '#30343a'], ['DEST', '#1f4f9a']]);
  // go card reader face
  c.save();
  c.translate(R_READER.x, R_READER.y);
  c.fillStyle = '#d9dcdf';
  c.fillRect(0, 0, R_READER.w, R_READER.h);
  c.fillStyle = '#1c2c3a';
  c.fillRect(10, 10, 76, 26);
  c.fillStyle = '#9cf0a0';
  c.font = `bold 8px ${FONT}`;
  c.textAlign = 'center';
  c.fillText('PLEASE TOUCH', 48, 21);
  c.fillText('YOUR go CARD', 48, 31);
  c.strokeStyle = '#f2c400';
  c.lineWidth = 7;
  c.beginPath();
  c.arc(48, 84, 28, 0, Math.PI * 2);
  c.stroke();
  c.fillStyle = '#eef0f2';
  c.beginPath();
  c.arc(48, 84, 24, 0, Math.PI * 2);
  c.fill();
  c.restore();
  // stickers
  const sticker = (r: Reg, bg: string, fg: string, lines: string[]) => {
    c.save();
    c.translate(r.x, r.y);
    c.fillStyle = bg;
    c.fillRect(0, 0, r.w, r.h);
    c.fillStyle = fg;
    c.font = `bold 13px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    lines.forEach((l, i) => c.fillText(l, r.w / 2, r.h / 2 + (i - (lines.length - 1) / 2) * 16));
    c.restore();
  };
  sticker(R_STICKER, '#f6c400', '#111', ['Please do not distract', 'the driver while the', 'bus is in motion']);
  sticker(R_CCTV, '#1d4fbf', '#fff', ['WARNING', 'CCTV IN OPERATION']);
  // destination controller keypad
  c.save();
  c.translate(R_DESTCTL.x, R_DESTCTL.y);
  c.fillStyle = '#26292e';
  c.fillRect(0, 0, R_DESTCTL.w, R_DESTCTL.h);
  c.fillStyle = '#1a2a12';
  c.fillRect(12, 10, 184, 34);
  c.fillStyle = '#b6f27a';
  c.font = `bold 14px ${FONT}`;
  c.textAlign = 'left';
  c.fillText('DEST 061  RTE', 20, 32);
  for (let i = 0; i < 12; i++) {
    c.fillStyle = '#4a4f57';
    roundRect(c, 14 + (i % 6) * 31, 54 + Math.floor(i / 6) * 34, 26, 26, 4);
    c.fill();
    c.fillStyle = '#e8ebef';
    c.font = `bold 11px ${FONT}`;
    c.textAlign = 'center';
    c.fillText('1234567890*#'[i], 27 + (i % 6) * 31, 71 + Math.floor(i / 6) * 34);
  }
  c.restore();
}

// ---------------------------------------------------------------------------

function buildFurniture(B: BodyLayout, sec: SectionLayout, dz: number): { geo: THREE.BufferGeometry; wheelCenter: THREE.Vector3 } {
  const zo = -sec.axleFromFront + dz;
  const Z = (z: number) => z + zo;
  const gb = new GeoBuilder();
  gb.shade = true;
  const dash: RGB = rgb('#26282c');
  const dashTop: RGB = rgb('#1b1c1f');
  const grey: RGB = rgb('#4b5058');
  const fz = (y: number) => frontZ(B, sec, y) + 0.07 - dz;
  // left shelf in front of the entrance
  const zl = fz(1.22);
  gb.box(-B.hw + 0.09, 0.34, Z(zl), 0.06, 1.2, Z(0.5), dash, 1 | 2 | 4 | 16);
  gb.box(-B.hw + 0.09, 1.2, Z(zl), 0.06, 1.23, Z(0.52), dashTop, 4 | 16);
  // driver's dash
  const zd = fz(1.4);
  gb.box(0.06, 0.8, Z(zd), B.hw - 0.09, 1.38, Z(0.72), dash, 2 | 16 | 1);
  gb.quad(V(0.06, 1.38, Z(0.72)), V(B.hw - 0.09, 1.38, Z(0.72)), V(B.hw - 0.09, 1.47, Z(zd)), V(0.06, 1.47, Z(zd)), dashTop);
  // slim instrument binnacle: sloped cover, short hood lip, side cheeks
  const hx0 = 0.31, hx1 = 0.93;
  gb.quad(V(hx0, 1.86, Z(0.44)), V(hx1, 1.86, Z(0.44)), V(hx1, 1.46, Z(0.16)), V(hx0, 1.46, Z(0.16)), dashTop);
  gb.box(hx0, 1.855, Z(0.44), hx1, 1.875, Z(0.555), dashTop);
  for (const x of [hx0, hx1]) {
    const dir = x === hx0 ? -1 : 1;
    gb.quad(V(x, 1.44, Z(0.16)), V(x, 1.44, Z(0.6)), V(x, 1.875, Z(0.555)), V(x, 1.875, Z(0.44)), dir < 0 ? dash : dash);
  }
  gb.box(hx0, 1.4, Z(0.52), hx1, 1.64, Z(0.6), dash, 16 | 4);
  // right wing (switches) and left wing (console pedestal)
  gb.box(0.95, 0.8, Z(0.5), B.hw - 0.09, 1.34, Z(1.0), dash, 2 | 4 | 16);
  gb.box(0.04, 0.8, Z(0.5), 0.3, 1.4, Z(0.78), dash, 1 | 4 | 16 | 2);
  // ticketing console on a pedestal left of the wheel
  gb.rod(V(0.17, 1.4, Z(0.66)), V(0.17, 1.55, Z(0.66)), 0.025, grey, 6);
  gb.box(0.04, 1.52, Z(0.56), 0.3, 1.7, Z(0.72), rgb('#2e3238'));
  // steering column
  const wheelCenter = V(0.62, 1.6, Z(0.85));
  gb.rod(V(0.62, 1.12, Z(0.6)), wheelCenter.clone().add(V(0, -0.03, -0.04)), 0.05, rgb('#1c1d20'), 8);
  gb.box(0.5, 1.0, Z(0.58), 0.74, 1.2, Z(0.74), rgb('#1c1d20'));
  // pedals
  gb.box(0.48, 0.8, Z(0.35), 0.58, 0.86, Z(0.5), rgb('#3a3d42'));
  gb.box(0.7, 0.8, Z(0.38), 0.78, 0.86, Z(0.5), rgb('#3a3d42'));
  // driver's seat (no headrest so the saloon stays visible when looking back)
  const seat: RGB = rgb('#2c3038');
  gb.box(0.52, 0.8, Z(1.42), 0.74, 1.2, Z(1.62), rgb('#1c1d20'));
  gb.box(0.38, 1.2, Z(1.22), 0.86, 1.34, Z(1.72), seat);
  const back = new THREE.BoxGeometry(0.48, 0.66, 0.1);
  gb.add(back, mat4(0.62, 1.7, Z(1.8), -0.12), seat);
  const stripe = new THREE.BoxGeometry(0.1, 0.62, 0.005);
  gb.add(stripe, mat4(0.62, 1.7, Z(1.745), -0.12), rgb('#1f50c8'));
  back.dispose();
  stripe.dispose();
  // destination sign cabinet behind the front display
  const metro = B.type === 'metro';
  const [hb0, hb1] = metro ? [2.43, 2.69] : [2.73, 2.99];
  const zh = fz(metro ? 2.56 : 2.86) - 0.02;
  const depth = metro ? 0.1 : 0.22;
  gb.box(-B.hw + (metro ? 0.36 : 0.12), hb0, Z(zh), B.hw - (metro ? 0.36 : 0.12), hb1, Z(zh + depth), rgb(metro ? '#1c1e22' : '#464a51'), 2 | 1 | 8 | 16);
  if (!metro) for (const x of [-0.7, 0.0, 0.7]) gb.box(x - 0.03, hb0 + 0.08, Z(zh + depth), x + 0.03, hb0 + 0.14, Z(zh + depth + 0.02), rgb('#9aa0a7'));
  // black rubber seal around the inside of the windscreen
  const g0 = metro ? 0.98 : 1.12, g1 = metro ? 2.4 : 2.72, xg = B.hw - (metro ? 0.22 : 0.15);
  const seal = rgb('#08090a');
  gb.quad(V(xg, g1 - 0.03, Z(fz(g1) - 0.015)), V(-xg, g1 - 0.03, Z(fz(g1) - 0.015)), V(-xg, g1, Z(fz(g1) - 0.015)), V(xg, g1, Z(fz(g1) - 0.015)), seal);
  for (const sx of [1, -1]) {
    const xa = sx * xg, xb = sx * (xg - 0.03);
    gb.quad(V(xa, g0, Z(fz(g0) - 0.015)), V(xb, g0, Z(fz(g0) - 0.015)), V(xb, g1, Z(fz(g1) - 0.015)), V(xa, g1, Z(fz(g1) - 0.015)), seal);
  }
  // convex saloon mirror at the top of the windscreen
  gb.rod(V(0.05, g1 - 0.01, Z(fz(g1) + 0.01)), V(0.05, g1 - 0.08, Z(fz(g1) + 0.12)), 0.01, rgb('#202226'), 5);
  gb.box(-0.12, g1 - 0.2, Z(fz(g1) + 0.12), 0.22, g1 - 0.06, Z(fz(g1) + 0.15), rgb('#202226'));
  gb.quad(V(-0.105, g1 - 0.19, Z(fz(g1) + 0.152)), V(0.205, g1 - 0.19, Z(fz(g1) + 0.152)), V(0.205, g1 - 0.07, Z(fz(g1) + 0.152)), V(-0.105, g1 - 0.07, Z(fz(g1) + 0.152)), rgb('#7d8ea0'));
  // go card readers on the door poles
  for (const d of sec.doors.slice(0, 2)) {
    const zr = d.z1 + 0.06 - dz;
    gb.box(-(B.hw - 0.08 - 0.25) + 0.02, 1.08, Z(zr - 0.1), -(B.hw - 0.08 - 0.25) + 0.1, 1.32, Z(zr + 0.1), rgb('#d4d7db'));
  }
  return { geo: gb.build(), wheelCenter };
}

function steeringWheelGeometry(): THREE.BufferGeometry {
  const gb = new GeoBuilder();
  gb.shade = true;
  const black: RGB = rgb('#202125');
  const rim = new THREE.TorusGeometry(0.255, 0.021, 8, 36);
  gb.add(rim, mat4(0, 0, 0, Math.PI / 2, 0, 0), black);
  for (const a of [Math.PI / 2 + 0.25, Math.PI / 2 - 0.25, -Math.PI / 2]) {
    const spoke = new THREE.BoxGeometry(0.21, 0.022, 0.05);
    gb.add(spoke, mat4(Math.cos(a) * 0.13, -0.012, Math.sin(a) * -0.13, 0, a, 0), rgb('#2a2c31'));
    spoke.dispose();
  }
  const hub = new THREE.CylinderGeometry(0.085, 0.095, 0.06, 18);
  gb.add(hub, mat4(0, -0.02, 0), rgb('#2c2f35'));
  const badge = new THREE.CircleGeometry(0.035, 16);
  gb.add(badge, mat4(0, 0.0115, 0, -Math.PI / 2), rgb('#8f969e'));
  // rim grip marks at 10 and 2 o'clock
  for (const a of [Math.PI * 0.8, Math.PI * 0.2]) {
    const g = new THREE.TorusGeometry(0.255, 0.024, 6, 6, 0.35);
    gb.add(g, mat4(0, 0, 0, Math.PI / 2, 0, a - 0.17), rgb('#33363c'));
    g.dispose();
  }
  rim.dispose();
  hub.dispose();
  badge.dispose();
  return gb.build();
}

export function createCab(type: BusType): Cab {
  const B = layoutFor(type);
  const sec = B.sections[0];
  const metro = type === 'metro';
  const dz = B.eye.z - 1.4; // furniture laid out for an eye 1.4 m behind the nose
  const zo = -sec.axleFromFront;
  const Z = (z: number) => z + zo;
  const group = new THREE.Group();
  group.name = 'cab';
  group.userData.busCab = true;
  const eye = new THREE.Vector3(B.eye.x, B.eye.y, Z(B.eye.z));

  const saloon = buildSaloon(B, sec, true);
  group.add(saloon.group);

  const furn = buildFurniture(B, sec, dz);
  const furnMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const furniture = new THREE.Mesh(furn.geo, furnMat);
  furniture.name = 'cabFurniture';
  group.add(furniture);

  // steering wheel: pivot tilted 35 degrees from horizontal
  const wheelPivot = new THREE.Group();
  wheelPivot.position.copy(furn.wheelCenter);
  wheelPivot.rotation.x = (35 * Math.PI) / 180;
  const wheelMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const wheel = new THREE.Mesh(steeringWheelGeometry(), wheelMat);
  wheel.name = 'steeringWheel';
  wheelPivot.add(wheel);
  group.add(wheelPivot);

  // canvas textures
  const dyn = makeCanvas(DYN.w, DYN.h);
  const dynTex = canvasTexture(dyn.canvas, true, false);
  const sta = makeCanvas(STA.w, STA.h);
  drawStatic(sta.ctx);
  const staTex = canvasTexture(sta.canvas);

  const dg = new GeoBuilder();
  const eyeTarget = eye.clone();
  {
    const c = V(0.62, 1.755, Z(0.52 + dz));
    const f = facing(c, eyeTarget);
    panel(dg, c, f.right, f.up, 0.56, 0.2, uvRect(R_CLUSTER, DYN.w, DYN.h));
  }
  {
    // passenger display hanging behind the driver, facing the saloon
    panel(dg, V(-0.25, 2.52, Z(2.06)), V(1, 0, 0), V(0, 1, 0), 0.8, 0.15, uvRect(R_STOP, DYN.w, DYN.h));
  }
  {
    const c = V(0.2, 1.62, Z(0.73 + dz));
    const f = facing(c, eyeTarget);
    panel(dg, c, f.right, f.up, 0.2, 0.12, uvRect(R_TICKET, DYN.w, DYN.h));
  }
  const dynMat = new THREE.MeshBasicMaterial({ map: dynTex, toneMapped: false });
  const dynMesh = new THREE.Mesh(dg.build(), dynMat);
  dynMesh.name = 'instruments';
  group.add(dynMesh);

  const sg = new GeoBuilder();
  {
    const c = V(1.06, 1.36, Z(0.76 + dz));
    const f = facing(c, eyeTarget);
    panel(sg, c, f.right, f.up, 0.2, 0.14, uvRect(R_SWITCH_R, STA.w, STA.h));
    const c2 = V(0.16, 1.42, Z(0.64 + dz));
    const f2 = facing(c2, eyeTarget);
    panel(sg, c2, f2.right, f2.up, 0.22, 0.1, uvRect(R_SWITCH_L, STA.w, STA.h));
    const c3 = V(-0.4, 1.235, Z(0.33 + dz));
    const f3 = facing(c3, eyeTarget);
    panel(sg, c3, f3.right, f3.up, 0.26, 0.16, uvRect(R_DESTCTL, STA.w, STA.h));
  }
  for (const d of sec.doors.slice(0, 2)) {
    const zr = d.z1 + 0.06;
    const x = -(B.hw - 0.08 - 0.25) + 0.105;
    sg.quad(V(x, 1.09, Z(zr + 0.09)), V(x, 1.09, Z(zr - 0.09)), V(x, 1.31, Z(zr - 0.09)), V(x, 1.31, Z(zr + 0.09)), [1, 1, 1], uvRect(R_READER, STA.w, STA.h));
  }
  // stickers on the back of the driver's partition
  sg.quad(V(0.3, 1.18, Z(1.925 + dz)), V(0.75, 1.18, Z(1.925 + dz)), V(0.75, 1.32, Z(1.925 + dz)), V(0.3, 1.32, Z(1.925 + dz)), [1, 1, 1], uvRect(R_STICKER, STA.w, STA.h));
  sg.quad(V(0.8, 1.18, Z(1.925 + dz)), V(1.1, 1.18, Z(1.925 + dz)), V(1.1, 1.27, Z(1.925 + dz)), V(0.8, 1.27, Z(1.925 + dz)), [1, 1, 1], uvRect(R_CCTV, STA.w, STA.h));
  const staMat = new THREE.MeshBasicMaterial({ map: staTex });
  const staMesh = new THREE.Mesh(sg.build(), staMat);
  staMesh.name = 'cabPanels';
  group.add(staMesh);

  // sun visor (tinted roller blind) on the driver's side
  const vg = new GeoBuilder();
  vg.alpha = [];
  const zv = frontZ(B, sec, 2.62) + 0.1;
  const vy0 = metro ? 2.22 : 2.56, vy1 = metro ? 2.39 : 2.715;
  // roller blind: darker toward the top edge
  const c0 = vg.vertex(1.1, vy0, Z(zv), 0, 0, 1, 0, 0, [0.02, 0.02, 0.03], 0.35);
  const c1 = vg.vertex(0.16, vy0, Z(zv), 0, 0, 1, 0, 0, [0.02, 0.02, 0.03], 0.35);
  const c2 = vg.vertex(0.16, vy1, Z(zv + 0.02), 0, 0, 1, 0, 0, [0.02, 0.02, 0.03], 0.75);
  const c3 = vg.vertex(1.1, vy1, Z(zv + 0.02), 0, 0, 1, 0, 0, [0.02, 0.02, 0.03], 0.75);
  vg.tri(c0, c1, c2);
  vg.tri(c0, c2, c3);
  // bottom rail of the blind
  vg.quad(V(1.1, vy0 - 0.012, Z(zv)), V(0.16, vy0 - 0.012, Z(zv)), V(0.16, vy0, Z(zv)), V(1.1, vy0, Z(zv)), [0.08, 0.08, 0.09], undefined, 1);
  const visorMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const visor = new THREE.Mesh(vg.build(), visorMat);
  visor.renderOrder = 3;
  group.add(visor);

  let lastKey = '';
  let lastDraw = -1;
  let lastT = 0;
  let trip = 0;
  let night: boolean | null = null;

  return {
    group,
    eye,
    update(st: CabState) {
      wheel.rotation.y = -st.steeringWheel;
      const dt = Math.max(0, Math.min(0.5, st.timeSeconds - lastT));
      lastT = st.timeSeconds;
      trip += (st.speedKmh / 3600) * dt;
      const flash = (st.timeSeconds * 1.5) % 1 < 0.5;
      if (night !== st.lights.headlights) {
        night = st.lights.headlights;
        saloon.setNight(night);
      }
      const L = st.lights;
      const key = [
        Math.round(st.speedKmh * 2),
        Math.round(st.rpm / 20),
        flash && (L.indicatorLeft || L.indicatorRight || L.hazards) ? 1 : 0,
        L.indicatorLeft ? 1 : 0, L.indicatorRight ? 1 : 0, L.hazards ? 1 : 0, L.headlights ? 1 : 0, L.reverse ? 1 : 0, L.brake ? 1 : 0,
        st.doorsOpen ? 1 : 0,
        st.stopRequested ? 1 : 0,
        Math.floor(st.timeSeconds),
        playerSign.route,
      ].join(',');
      if (key !== lastKey && (st.timeSeconds - lastDraw > 0.05 || st.timeSeconds < lastDraw)) {
        lastKey = key;
        lastDraw = st.timeSeconds;
        drawCluster(dyn.ctx, { speed: st.speedKmh, rpm: st.rpm, flash, st, trip, metro });
        drawStop(dyn.ctx, st);
        drawTicket(dyn.ctx, st);
        dynTex.needsUpdate = true;
      }
    },
  };
}
