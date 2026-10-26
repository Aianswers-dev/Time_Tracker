// Canvas artwork for the driver's cab: the instrument cluster (Volvo-style
// analogue dials for the Optimus, a wide digital display for the Metro), the
// passenger "next stop" display, the go card driver console screen, and the
// static panels (door controls, switches, go card readers, stickers,
// destination keypad, console keys, the hail sticker seen from inside).
import type { CabState } from '../types';
import { playerSign } from './state';
import { FONT, roundRect } from './util';

export type Reg = { x: number; y: number; w: number; h: number };
type Ctx = CanvasRenderingContext2D;

// dynamic canvas (512 x 256)
export const DYN = { w: 512, h: 256 };
export const R_CLUSTER: Reg = { x: 0, y: 0, w: 512, h: 184 };
export const R_STOP: Reg = { x: 0, y: 184, w: 384, h: 72 };
export const R_TICKET: Reg = { x: 384, y: 184, w: 128, h: 72 };
// static canvas (512 x 512)
export const STA = { w: 512, h: 512 };
export const R_SWITCH_R: Reg = { x: 0, y: 0, w: 256, h: 128 };
export const R_SWITCH_L: Reg = { x: 256, y: 0, w: 256, h: 128 };
export const R_READER: Reg = { x: 0, y: 128, w: 96, h: 128 };
export const R_STICKER: Reg = { x: 96, y: 128, w: 208, h: 64 };
export const R_CCTV: Reg = { x: 96, y: 192, w: 208, h: 64 };
export const R_DESTCTL: Reg = { x: 304, y: 128, w: 208, h: 128 };
export const R_CONSOLE: Reg = { x: 0, y: 256, w: 192, h: 192 };
export const R_HAIL: Reg = { x: 192, y: 256, w: 320, h: 40 };
export const R_OVERHEAD: Reg = { x: 192, y: 296, w: 320, h: 64 };
export const R_RCONSOLE: Reg = { x: 192, y: 360, w: 320, h: 88 };
/** Plain matt patches for the moulded parts (u,v of a texel inside). */
export const R_PLAIN: Reg = { x: 0, y: 448, w: 64, h: 64 };

export function uvRect(r: Reg, W: number, H: number, flipU = false): [number, number, number, number] {
  const u0 = r.x / W, u1 = (r.x + r.w) / W;
  return [flipU ? u1 : u0, 1 - (r.y + r.h) / H, flipU ? u0 : u1, 1 - r.y / H];
}

// ---------------------------------------------------------------------------
// Instruments

function dial(c: Ctx, cx: number, cy: number, r: number, value: number, max: number, major: number, minor: number, label: string, scale: number, bands: [number, number, string][]): void {
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
  c.strokeStyle = '#8a9099';
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
  c.font = `bold ${Math.round(r * 0.21)}px ${FONT}`;
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

function arrow(c: Ctx, x: number, y: number, dir: 1 | -1, on: boolean): void {
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

function lamp(c: Ctx, x: number, y: number, text: string, on: boolean, col: string): void {
  c.fillStyle = on ? col : '#1a1c20';
  roundRect(c, x - 19, y - 9, 38, 18, 4);
  c.fill();
  c.fillStyle = on ? '#000' : '#3a3e45';
  c.font = `bold 10px ${FONT}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, x, y + 1);
}

function headlampIcon(c: Ctx, x: number, y: number, on: boolean): void {
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

export interface ClusterState {
  speed: number;
  rpm: number;
  flash: boolean;
  st: CabState;
  trip: number;
  metro: boolean;
}

export function drawCluster(c: Ctx, s: ClusterState): void {
  if (s.metro) drawDigitalCluster(c, s);
  else drawAnalogueCluster(c, s);
}

function drawAnalogueCluster(c: Ctx, s: ClusterState): void {
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
  dial(c, 98, 96, 80, s.speed, 120, 20, 10, 'km/h', 1, [[60, 120, '#7a1c1c']]);
  dial(c, 414, 96, 80, s.rpm / 100, 30, 5, 2.5, 'x1000 r/min', 0.1, [[10, 18, '#1f7a3a'], [26, 30, '#a01818']]);
  // centre TFT
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
  c.fillText(gearOf(s), 206, 84);
  c.font = `11px ${FONT}`;
  c.fillStyle = '#9fb4d0';
  const t = Math.floor(st.timeSeconds);
  c.fillText(`TRIP ${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`, 256, 128);
  c.fillText(`${s.trip.toFixed(2)} km   27°C`, 256, 143);
  const msg = st.doorsOpen ? 'DOORS OPEN' : st.stopRequested ? 'STOP REQUESTED' : 'FUEL ▮▮▮▮▯';
  c.fillStyle = st.doorsOpen || st.stopRequested ? '#ffb020' : '#6f8aa8';
  c.font = `bold 11px ${FONT}`;
  c.fillText(msg, 256, 158);
  lamp(c, 40, 170, 'DOOR', st.doorsOpen, '#ff8a00');
  lamp(c, 84, 170, 'STOP', st.stopRequested, '#ff2a1a');
  lamp(c, 128, 170, 'BRAKE', L.brake && s.speed < 1, '#ff2a1a');
  lamp(c, 384, 170, 'HAZ', L.hazards && s.flash, '#ff2a1a');
  lamp(c, 428, 170, 'ABS', false, '#ffb000');
  lamp(c, 472, 170, 'ECAS', true, '#2cff4a');
  c.restore();
}

function gearOf(s: ClusterState): string {
  const L = s.st.lights;
  return s.st.gear ?? (L.reverse ? 'R' : s.speed < 0.5 && s.rpm < 760 ? 'N' : 'D');
}

/** HESS / Brisbane Metro: one wide colour TFT (speed, power/regen, battery). */
function drawDigitalCluster(c: Ctx, s: ClusterState): void {
  const { x, y, w, h } = R_CLUSTER;
  const st = s.st;
  const L = st.lights;
  c.save();
  c.translate(x, y);
  c.fillStyle = '#020304';
  c.fillRect(0, 0, w, h);
  const bg = c.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0b1422');
  bg.addColorStop(1, '#04070c');
  c.fillStyle = bg;
  roundRect(c, 6, 6, w - 12, h - 12, 14);
  c.fill();
  // speed arc (left) and power / regen arc (right)
  const arcBar = (cx: number, frac: number, col: string, neg: boolean) => {
    c.lineWidth = 12;
    c.strokeStyle = '#17202c';
    c.beginPath();
    c.arc(cx, 104, 66, Math.PI * 0.75, Math.PI * 2.25);
    c.stroke();
    const f = Math.max(0, Math.min(1, frac));
    if (f > 0.002) {
      c.strokeStyle = col;
      c.beginPath();
      if (neg) c.arc(cx, 104, 66, Math.PI * 1.5 - f * Math.PI * 0.75, Math.PI * 1.5);
      else c.arc(cx, 104, 66, Math.PI * 0.75, Math.PI * 0.75 + f * Math.PI * 1.5);
      c.stroke();
    }
  };
  arcBar(110, s.speed / 80, s.speed > 60 ? '#ff5a3c' : '#3fa9ff', false);
  const p = (s.rpm - 700) / 2300;
  if (L.brake && s.speed > 1) arcBar(402, 0.35, '#3ce07a', true);
  else arcBar(402, p, '#2fd0ff', false);
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = '#ffffff';
  c.font = `bold 52px ${FONT}`;
  c.fillText(String(Math.round(s.speed)), 110, 100);
  c.font = `bold 12px ${FONT}`;
  c.fillStyle = '#8fb3d9';
  c.fillText('km/h', 110, 132);
  c.fillText(L.brake && s.speed > 1 ? 'REGEN' : 'POWER', 402, 132);
  c.font = `bold 30px ${FONT}`;
  c.fillStyle = '#e8f3ff';
  c.fillText(`${Math.round(Math.max(0, p) * 100)}`, 402, 100);
  // centre: gear, indicators, battery, doors
  const left = L.indicatorLeft || L.hazards;
  const right = L.indicatorRight || L.hazards;
  arrow(c, 214, 34, -1, left && s.flash);
  arrow(c, 298, 34, 1, right && s.flash);
  headlampIcon(c, 256, 34, L.headlights);
  c.font = `bold 34px ${FONT}`;
  c.fillStyle = L.reverse ? '#ffb020' : '#7fffa0';
  c.fillText(gearOf(s), 256, 78);
  c.fillStyle = '#1a2534';
  roundRect(c, 204, 104, 104, 16, 4);
  c.fill();
  c.fillStyle = '#3ce07a';
  roundRect(c, 206, 106, 78, 12, 3);
  c.fill();
  c.font = `bold 10px ${FONT}`;
  c.fillStyle = '#cfe3f7';
  c.fillText('SOC 78%', 256, 132);
  const msg = st.doorsOpen ? 'DOORS OPEN' : st.stopRequested ? 'STOP REQUESTED' : `${s.trip.toFixed(1)} km`;
  c.fillStyle = st.doorsOpen || st.stopRequested ? '#ffb020' : '#7f9cbc';
  c.font = `bold 11px ${FONT}`;
  c.fillText(msg, 256, 150);
  lamp(c, 40, 168, 'DOOR', st.doorsOpen, '#ff8a00');
  lamp(c, 84, 168, 'STOP', st.stopRequested, '#ff2a1a');
  lamp(c, 128, 168, 'BRAKE', L.brake && s.speed < 1, '#ff2a1a');
  lamp(c, 384, 168, 'HAZ', L.hazards && s.flash, '#ff2a1a');
  lamp(c, 428, 168, 'HV', true, '#2cff4a');
  lamp(c, 472, 168, 'READY', true, '#2cff4a');
  c.restore();
}

export function drawStop(c: Ctx, st: CabState): void {
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
  c.fillStyle = 'rgba(0,0,0,0.55)';
  for (let i = 0; i < w; i += 4) c.fillRect(i, 0, 1.4, h);
  for (let j = 0; j < h; j += 4) c.fillRect(0, j, w, 1.4);
  c.restore();
}

/** go card driver console touch screen. */
export function drawTicket(c: Ctx, st: CabState): void {
  const { x, y, w, h } = R_TICKET;
  c.save();
  c.translate(x, y);
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#103a78');
  g.addColorStop(1, '#0a2552');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  c.fillStyle = '#0b1830';
  c.fillRect(0, 0, w, 14);
  c.fillStyle = '#ffffff';
  c.font = `bold 10px ${FONT}`;
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillText(`Route ${playerSign.route || '--'}`, 4, 7);
  c.textAlign = 'right';
  const t = Math.floor(st.timeSeconds);
  c.fillText(`${Math.floor(t / 60) % 24}:${String(t % 60).padStart(2, '0')}`, w - 4, 7);
  c.textAlign = 'left';
  c.font = `9px ${FONT}`;
  c.fillText((playerSign.headsign || 'Not in service').slice(0, 22), 4, 22);
  // touch buttons
  const btn = (bx: number, by: number, bw: number, label: string, col: string) => {
    c.fillStyle = col;
    roundRect(c, bx, by, bw, 18, 3);
    c.fill();
    c.fillStyle = '#ffffff';
    c.font = `bold 8px ${FONT}`;
    c.textAlign = 'center';
    c.fillText(label, bx + bw / 2, by + 9.5);
  };
  btn(4, 32, 58, 'ADULT 50c', '#1f6fd0');
  btn(66, 32, 58, 'CONCESSION', '#1f6fd0');
  btn(4, 52, 58, 'go card ✔', '#1b8a4a');
  btn(66, 52, 58, 'MENU', '#3a4656');
  c.restore();
}

// ---------------------------------------------------------------------------
// Static panels

export function drawStatic(c: Ctx, metro: boolean): void {
  c.fillStyle = '#16181c';
  c.fillRect(0, 0, STA.w, STA.h);
  const sw = (r: Reg, title: string, labels: [string, string][]) => {
    c.save();
    c.translate(r.x, r.y);
    const g = c.createLinearGradient(0, 0, 0, r.h);
    g.addColorStop(0, '#2a2d32');
    g.addColorStop(1, '#1b1d21');
    c.fillStyle = g;
    c.fillRect(0, 0, r.w, r.h);
    c.fillStyle = '#9aa1aa';
    c.font = `bold 9px ${FONT}`;
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText(title, 8, 4);
    const cols = 4;
    labels.forEach(([lab, col], i) => {
      const cx = 10 + (i % cols) * 61;
      const cy = 17 + Math.floor(i / cols) * 55;
      c.fillStyle = '#0c0d0f';
      roundRect(c, cx, cy, 52, 46, 6);
      c.fill();
      const rg = c.createLinearGradient(0, cy + 4, 0, cy + 30);
      rg.addColorStop(0, col);
      rg.addColorStop(1, '#101114');
      c.fillStyle = rg;
      roundRect(c, cx + 6, cy + 4, 40, 26, 4);
      c.fill();
      c.fillStyle = '#ffb347';
      c.fillRect(cx + 22, cy + 7, 8, 2);
      c.fillStyle = '#d8dce2';
      c.font = `bold 9px ${FONT}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(lab, cx + 26, cy + 38);
    });
    c.restore();
  };
  sw(R_SWITCH_R, 'LIGHTS · CLIMATE', [['HAZARD', '#b0221d'], ['HEAD', '#3a3f46'], ['WIPER', '#3a3f46'], ['DEMIST', '#3a3f46'], ['SALOON', '#3a3f46'], ['A/C', '#3a3f46'], ['RADIO', '#2a5a9a'], ['CCTV', '#3a3f46']]);
  sw(R_SWITCH_L, 'DOOR CONTROL', [['FRONT', '#1e8a3c'], ['REAR', '#1e8a3c'], metro ? ['MIDDLE', '#1e8a3c'] : ['CLOSE', '#a3201b'], ['KNEEL', '#c08a0b'], ['RAMP', '#1f4f9a'], ['PRAM', '#3a3f46'], ['P BRAKE', '#a3201b'], ['DEST', '#1f4f9a']]);
  // go card reader face (as on the door poles)
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
  c.textBaseline = 'alphabetic';
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
  // go card driver console: housing face with keys (the screen is dynamic)
  c.save();
  c.translate(R_CONSOLE.x, R_CONSOLE.y);
  const cg = c.createLinearGradient(0, 0, 0, R_CONSOLE.h);
  cg.addColorStop(0, '#3b3f45');
  cg.addColorStop(1, '#25282c');
  c.fillStyle = cg;
  roundRect(c, 0, 0, R_CONSOLE.w, R_CONSOLE.h, 14);
  c.fill();
  c.fillStyle = '#07090c';
  roundRect(c, 14, 14, 164, 96, 6);
  c.fill();
  for (let i = 0; i < 8; i++) {
    const bx = 16 + (i % 4) * 41, by = 122 + Math.floor(i / 4) * 32;
    c.fillStyle = i === 3 ? '#1e8a3c' : i === 7 ? '#a3201b' : '#5a6068';
    roundRect(c, bx, by, 34, 24, 5);
    c.fill();
  }
  c.fillStyle = '#c9ced4';
  c.font = `bold 9px ${FONT}`;
  c.textAlign = 'center';
  c.fillText('translink', R_CONSOLE.w / 2, R_CONSOLE.h - 6);
  c.restore();
  // "PLEASE HAIL DRIVER" windscreen sticker seen from inside (reversed print on clear film)
  c.save();
  c.translate(R_HAIL.x, R_HAIL.y);
  c.fillStyle = '#d9b400';
  c.fillRect(0, 0, R_HAIL.w, R_HAIL.h);
  c.translate(R_HAIL.w, 0);
  c.scale(-1, 1);
  c.fillStyle = '#141414';
  c.font = `bold 24px ${FONT}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('PLEASE HAIL DRIVER', R_HAIL.w / 2, R_HAIL.h / 2 + 1, R_HAIL.w - 50);
  for (const xx of [14, R_HAIL.w - 14]) {
    c.beginPath();
    c.arc(xx, R_HAIL.h / 2, 10, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
  // overhead console strip: speaker grille, fleet number, maker's badge
  c.save();
  c.translate(R_OVERHEAD.x, R_OVERHEAD.y);
  c.fillStyle = metro ? '#d6d9dc' : '#c3c7cb';
  c.fillRect(0, 0, R_OVERHEAD.w, R_OVERHEAD.h);
  c.fillStyle = 'rgba(0,0,0,0.25)';
  for (let i = 0; i < 9; i++) c.fillRect(24 + i * 9, 20, 5, 26);
  c.fillStyle = '#4a4f57';
  c.font = `bold 16px ${FONT}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(metro ? 'HESS' : 'VOLGREN', 210, 32);
  c.font = `bold 12px ${FONT}`;
  c.fillText(metro ? '9026' : 'T2825', 292, 32);
  c.strokeStyle = 'rgba(0,0,0,0.2)';
  c.lineWidth = 2;
  c.strokeRect(2, 2, R_OVERHEAD.w - 4, R_OVERHEAD.h - 4);
  c.restore();
  // right-hand console: park brake, emergency door release, ramp, fan
  c.save();
  c.translate(R_RCONSOLE.x, R_RCONSOLE.y);
  c.fillStyle = '#2b2e33';
  c.fillRect(0, 0, R_RCONSOLE.w, R_RCONSOLE.h);
  c.fillStyle = '#b9bec5';
  roundRect(c, 150, 12, 150, 64, 6);
  c.fill();
  for (const bx of [190, 260]) {
    c.fillStyle = '#7a1010';
    c.beginPath();
    c.arc(bx, 40, 14, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#ff3a2a';
    c.beginPath();
    c.arc(bx, 40, 9, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = '#20232a';
  c.font = `bold 8px ${FONT}`;
  c.textAlign = 'center';
  c.fillText('ALARM', 190, 66);
  c.fillText('DOOR EMERG', 260, 66);
  c.fillStyle = '#1b1d21';
  roundRect(c, 14, 18, 44, 52, 6);
  c.fill();
  c.fillStyle = '#c7a21a';
  roundRect(c, 24, 26, 24, 34, 4);
  c.fill();
  c.fillStyle = '#d8dce2';
  c.fillText('P', 36, 46);
  c.restore();
  // plain patch (moulded plastic texel)
  c.fillStyle = '#ffffff';
  c.fillRect(R_PLAIN.x, R_PLAIN.y, R_PLAIN.w, R_PLAIN.h);
}
