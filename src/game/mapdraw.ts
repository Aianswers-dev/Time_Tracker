// 2D map rendering of the city (menu preview, minimap tiles, full-screen map).
import { AreaKind, RoadKind, type Area, type MapData, type Route } from '../types';

export interface MapView {
  /** Map coordinate at canvas pixel (0, 0). */
  x0: number;
  y0: number;
  /** Pixels per metre. */
  scale: number;
}

export const MAP_COLORS = {
  bg: '#0d1e33',
  water: '#123f63',
  waterEdge: '#1b5584',
  park: '#14352f',
  sport: '#173a33',
  rail: '#3d4a5c',
  roadMinor: '#2a405b',
  roadMid: '#38557a',
  roadMajor: '#4f6f96',
  roadMotorway: '#7f8fb0',
  busway: '#00a5b5',
};

function roadStyle(kind: RoadKind, bus: boolean): { color: string; width: number; minScale: number } {
  if (bus || kind === RoadKind.Busway) return { color: MAP_COLORS.busway, width: 7, minScale: 0 };
  switch (kind) {
    case RoadKind.Motorway:
      return { color: MAP_COLORS.roadMotorway, width: 12, minScale: 0 };
    case RoadKind.Trunk:
      return { color: MAP_COLORS.roadMajor, width: 11, minScale: 0 };
    case RoadKind.Primary:
      return { color: MAP_COLORS.roadMajor, width: 10, minScale: 0 };
    case RoadKind.Secondary:
      return { color: MAP_COLORS.roadMid, width: 9, minScale: 0 };
    case RoadKind.Tertiary:
      return { color: MAP_COLORS.roadMid, width: 8, minScale: 0.05 };
    case RoadKind.Residential:
      return { color: MAP_COLORS.roadMinor, width: 7, minScale: 0.08 };
    case RoadKind.Service:
      return { color: MAP_COLORS.roadMinor, width: 4.5, minScale: 0.35 };
    case RoadKind.Pedestrian:
      return { color: MAP_COLORS.roadMinor, width: 3, minScale: 0.5 };
    default:
      return { color: MAP_COLORS.roadMinor, width: 6, minScale: 0.1 };
  }
}

/** Road draw order: minor first so major roads sit on top. */
const ORDER: RoadKind[] = [
  RoadKind.Pedestrian,
  RoadKind.Service,
  RoadKind.Residential,
  RoadKind.Tertiary,
  RoadKind.Secondary,
  RoadKind.Primary,
  RoadKind.Trunk,
  RoadKind.Motorway,
  RoadKind.Busway,
];

interface Bboxes {
  roads: Float32Array;
  water: Float32Array;
  areas: Float32Array;
}
const bboxCache = new WeakMap<MapData, Bboxes>();
function bboxesOf(pts: { pts: Float32Array }[]): Float32Array {
  const out = new Float32Array(pts.length * 4);
  pts.forEach((o, i) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const p = o.pts;
    for (let k = 0; k < p.length; k += 2) {
      if (p[k] < x0) x0 = p[k];
      if (p[k] > x1) x1 = p[k];
      if (p[k + 1] < y0) y0 = p[k + 1];
      if (p[k + 1] > y1) y1 = p[k + 1];
    }
    out.set([x0, y0, x1, y1], i * 4);
  });
  return out;
}
function bboxes(data: MapData): Bboxes {
  let b = bboxCache.get(data);
  if (!b) {
    b = { roads: bboxesOf(data.roads), water: bboxesOf(data.water), areas: bboxesOf(data.areas) };
    bboxCache.set(data, b);
  }
  return b;
}

function polyPath(ctx: CanvasRenderingContext2D, p: Float32Array, v: MapView): void {
  ctx.moveTo((p[0] - v.x0) * v.scale, (v.y0 - p[1]) * v.scale);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo((p[i] - v.x0) * v.scale, (v.y0 - p[i + 1]) * v.scale);
}

function fillAreas(ctx: CanvasRenderingContext2D, list: Area[], bb: Float32Array, v: MapView, w: number, h: number, pick: (a: Area) => string | null): void {
  const vx1 = v.x0 + w / v.scale;
  const vy1 = v.y0 - h / v.scale;
  const groups = new Map<string, number[]>();
  for (let i = 0; i < list.length; i++) {
    if (bb[i * 4 + 2] < v.x0 || bb[i * 4] > vx1 || bb[i * 4 + 3] < vy1 || bb[i * 4 + 1] > v.y0) continue;
    const c = pick(list[i]);
    if (!c) continue;
    let g = groups.get(c);
    if (!g) groups.set(c, (g = []));
    g.push(i);
  }
  for (const [color, ids] of groups) {
    ctx.beginPath();
    for (const i of ids) {
      const a = list[i];
      polyPath(ctx, a.pts, v);
      ctx.closePath();
      for (const hole of a.holes) {
        polyPath(ctx, hole, v);
        ctx.closePath();
      }
    }
    ctx.fillStyle = color;
    ctx.fill('evenodd');
  }
}

export interface DrawCityOptions {
  /** Multiply road widths (in metres) for legibility at small scales. */
  widthBoost?: number;
  /** Minimum road stroke in pixels. */
  minPx?: number;
  alpha?: number;
  background?: boolean;
}

/** Draw the static city into a canvas region of size w x h px. */
export function drawCity(ctx: CanvasRenderingContext2D, data: MapData, v: MapView, w: number, h: number, opt: DrawCityOptions = {}): void {
  const bb = bboxes(data);
  const boost = opt.widthBoost ?? 1;
  const minPx = opt.minPx ?? 0.6;
  ctx.save();
  ctx.globalAlpha = opt.alpha ?? 1;
  if (opt.background !== false) {
    ctx.fillStyle = MAP_COLORS.bg;
    ctx.fillRect(0, 0, w, h);
  }
  fillAreas(ctx, data.areas, bb.areas, v, w, h, (a) =>
    a.kind === AreaKind.Park || a.kind === AreaKind.Wood || a.kind === AreaKind.Cemetery ? MAP_COLORS.park : a.kind === AreaKind.Sport ? MAP_COLORS.sport : null,
  );
  fillAreas(ctx, data.water, bb.water, v, w, h, () => MAP_COLORS.water);
  const vx1 = v.x0 + w / v.scale;
  const vy1 = v.y0 - h / v.scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Rail first, thin.
  ctx.beginPath();
  for (const r of data.rail) if (!r.tunnel) polyPath(ctx, r.pts, v);
  ctx.strokeStyle = MAP_COLORS.rail;
  ctx.lineWidth = Math.max(minPx, 2.5 * v.scale * boost);
  ctx.stroke();
  const buckets = new Map<RoadKind, number[]>();
  const busBucket: number[] = [];
  const roads = data.roads;
  for (let i = 0; i < roads.length; i++) {
    if (bb.roads[i * 4 + 2] < v.x0 - 20 || bb.roads[i * 4] > vx1 + 20 || bb.roads[i * 4 + 3] < vy1 - 20 || bb.roads[i * 4 + 1] > v.y0 + 20) continue;
    const r = roads[i];
    if (r.bus || r.kind === RoadKind.Busway) {
      busBucket.push(i);
      continue;
    }
    let b = buckets.get(r.kind);
    if (!b) buckets.set(r.kind, (b = []));
    b.push(i);
  }
  for (const kind of ORDER) {
    const ids = kind === RoadKind.Busway ? busBucket : buckets.get(kind);
    if (!ids || !ids.length) continue;
    const st = roadStyle(kind, kind === RoadKind.Busway);
    if (v.scale < st.minScale) continue;
    ctx.beginPath();
    for (const i of ids) polyPath(ctx, roads[i].pts, v);
    ctx.strokeStyle = st.color;
    ctx.lineWidth = Math.max(minPx, st.width * v.scale * boost);
    ctx.stroke();
  }
  ctx.restore();
}

/** Stroke a route polyline, optionally only [s0, s1]. */
export function strokeRoute(ctx: CanvasRenderingContext2D, route: Route, v: MapView, color: string, widthPx: number, s0 = 0, s1 = Infinity): void {
  const p = route.pts;
  const c = route.cum;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < c.length; i++) {
    if (c[i] < s0 && i + 1 < c.length && c[i + 1] < s0) continue;
    if (c[i] > s1 && (i === 0 || c[i - 1] > s1)) break;
    const X = (p[2 * i] - v.x0) * v.scale;
    const Y = (v.y0 - p[2 * i + 1]) * v.scale;
    if (!started) {
      ctx.moveTo(X, Y);
      started = true;
    } else ctx.lineTo(X, Y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = widthPx;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/** Fit a bbox into w x h px with padding. */
export function fitView(x0: number, y0: number, x1: number, y1: number, w: number, h: number, pad: number): MapView {
  const bw = Math.max(50, x1 - x0);
  const bh = Math.max(50, y1 - y0);
  const scale = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return { x0: cx - w / 2 / scale, y0: cy + h / 2 / scale, scale };
}

export function routeBounds(route: Route): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const p = route.pts;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]);
    x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]);
    y1 = Math.max(y1, p[i + 1]);
  }
  return [x0, y0, x1, y1];
}

/**
 * Whole-city base image at a fixed scale, rendered once and reused for the
 * menu preview and the full-screen map.
 */
const baseCache = new WeakMap<MapData, { canvas: HTMLCanvasElement; view: MapView }>();
export function cityBase(data: MapData, px = 2048): { canvas: HTMLCanvasElement; view: MapView } {
  let b = baseCache.get(data);
  if (!b) {
    const [x0, y0, x1, y1] = data.bounds;
    const canvas = document.createElement('canvas');
    const scale = px / Math.max(x1 - x0, y1 - y0);
    canvas.width = Math.ceil((x1 - x0) * scale);
    canvas.height = Math.ceil((y1 - y0) * scale);
    const view: MapView = { x0, y0: y1, scale };
    const ctx = canvas.getContext('2d')!;
    drawCity(ctx, data, view, canvas.width, canvas.height, { widthBoost: 1.6, minPx: 0.5 });
    b = { canvas, view };
    baseCache.set(data, b);
  }
  return b;
}

/** Copy the part of the base image covering view `v` into ctx (w x h px). */
export function blitBase(ctx: CanvasRenderingContext2D, data: MapData, v: MapView, w: number, h: number): void {
  const base = cityBase(data);
  const bv = base.view;
  const sx = (v.x0 - bv.x0) * bv.scale;
  const sy = (bv.y0 - v.y0) * bv.scale;
  const sw = (w / v.scale) * bv.scale;
  const sh = (h / v.scale) * bv.scale;
  ctx.fillStyle = MAP_COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(base.canvas, sx, sy, sw, sh, 0, 0, w, h);
}

/**
 * Tile cache for the minimap: square tiles of TILE px at a given scale.
 * Tiles are drawn lazily (at most a few per frame) and kept in an LRU.
 */
export const TILE = 512;
export class TileCache {
  private tiles = new Map<string, { canvas: HTMLCanvasElement; used: number }>();
  private frame = 0;
  constructor(
    readonly data: MapData,
    readonly scale: number,
    readonly route: Route | null,
    readonly routeColor: string,
    readonly maxTiles = 24,
  ) {}

  get tileMetres(): number {
    return TILE / this.scale;
  }

  has(tx: number, ty: number): boolean {
    return this.tiles.has(`${tx},${ty}`);
  }

  /** Tile canvas covering [tx*T, (tx+1)*T) x [ty*T, (ty+1)*T) metres, or null if not ready. */
  get(tx: number, ty: number, allowDraw: boolean): HTMLCanvasElement | null {
    const key = `${tx},${ty}`;
    const t = this.tiles.get(key);
    if (t) {
      t.used = this.frame;
      return t.canvas;
    }
    if (!allowDraw) return null;
    const canvas = document.createElement('canvas');
    canvas.width = TILE;
    canvas.height = TILE;
    const ctx = canvas.getContext('2d')!;
    const m = this.tileMetres;
    const v: MapView = { x0: tx * m, y0: (ty + 1) * m, scale: this.scale };
    drawCity(ctx, this.data, v, TILE, TILE, { widthBoost: this.scale < 0.4 ? 1.8 : 1.15, minPx: 1 });
    if (this.route) {
      strokeRoute(ctx, this.route, v, 'rgba(0,0,0,0.45)', Math.max(5, 9 * this.scale));
      strokeRoute(ctx, this.route, v, this.routeColor, Math.max(3, 6 * this.scale));
    }
    this.tiles.set(key, { canvas, used: this.frame });
    if (this.tiles.size > this.maxTiles) {
      let oldest = '';
      let ou = Infinity;
      for (const [k, v2] of this.tiles) if (v2.used < ou) [oldest, ou] = [k, v2.used];
      this.tiles.delete(oldest);
    }
    return canvas;
  }

  tick(): void {
    this.frame++;
  }
}
