// Circular heading-up minimap: pre-rendered tiles, rotated blit per frame.
import type { MapData, Route } from '../types';
import { TILE, TileCache } from './mapdraw';
import { StopStatus } from './guide';

export interface MapMarker {
  x: number;
  y: number;
  heading: number;
  color: string;
  /** Body length in metres. */
  length: number;
}

const ZOOMS = [600, 1500];

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private caches: TileCache[] = [];
  private zoom = 0;
  private sizePx = 0;
  private dpr = 1;
  private t = 0;

  constructor(
    readonly data: MapData,
    readonly route: Route,
    readonly routeColor: string,
  ) {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
  }

  toggleZoom(): string {
    this.zoom = (this.zoom + 1) % ZOOMS.length;
    return `${ZOOMS[this.zoom]} m`;
  }

  get zoomLabel(): string {
    return ZOOMS[this.zoom] >= 1000 ? `${(ZOOMS[this.zoom] / 1000).toFixed(1)} km` : `${ZOOMS[this.zoom]} m`;
  }

  private ensureSize(): boolean {
    const css = this.canvas.clientWidth;
    if (!css) return false;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const px = Math.round(css * dpr);
    if (px !== this.sizePx || dpr !== this.dpr) {
      this.sizePx = px;
      this.dpr = dpr;
      this.canvas.width = px;
      this.canvas.height = px;
      this.caches = ZOOMS.map((m) => new TileCache(this.data, px / m, this.route, this.routeColor, 12));
    }
    return true;
  }

  /** Draw a frame. `stopStatus` and `next` colour the route's stops. */
  draw(dt: number, x: number, y: number, heading: number, stopStatus: Uint8Array, next: number, markers: readonly MapMarker[]): void {
    if (!this.ensureSize()) return;
    this.t += dt;
    const ctx = this.ctx;
    const S = this.sizePx;
    const cache = this.caches[this.zoom];
    cache.tick();
    const scale = cache.scale;
    const tm = cache.tileMetres;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d1e33';
    ctx.fillRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(-heading);
    ctx.translate(-x * scale, y * scale);
    // Tiles covering the view circle (radius in metres, padded for rotation).
    const r = (S / 2 / scale) * 1.05;
    const tx0 = Math.floor((x - r) / tm);
    const tx1 = Math.floor((x + r) / tm);
    const ty0 = Math.floor((y - r) / tm);
    const ty1 = Math.floor((y + r) / tm);
    let budget = 1;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const had = cache.has(tx, ty);
        const c = cache.get(tx, ty, had || budget > 0);
        if (!had && c) budget--;
        if (!c) continue;
        ctx.drawImage(c, tx * TILE, -(ty + 1) * TILE);
      }
    }
    // Route stops.
    const stops = this.route.stops;
    const dotR = Math.max(3, 4 * this.dpr);
    for (let i = 0; i < stops.length; i++) {
      const s = this.data.stops[stops[i].stop];
      const X = s.x * scale;
      const Y = -s.y * scale;
      const st = stopStatus[i];
      ctx.beginPath();
      ctx.arc(X, Y, i === next ? dotR * (1.3 + 0.25 * Math.sin(this.t * 5)) : dotR, 0, Math.PI * 2);
      ctx.fillStyle = i === next ? '#ffd23f' : st === StopStatus.Served ? '#8dc63f' : st === StopStatus.Missed ? '#ff5a5a' : st === StopStatus.Skipped ? '#6b7d92' : '#ffffff';
      ctx.fill();
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.strokeStyle = '#0b1f3a';
      ctx.stroke();
    }
    // Other buses.
    for (const m of markers) {
      const X = m.x * scale;
      const Y = -m.y * scale;
      const len = Math.max(9 * this.dpr, m.length * scale);
      const w = Math.max(5 * this.dpr, 2.6 * scale);
      ctx.save();
      ctx.translate(X, Y);
      ctx.rotate(m.heading);
      ctx.fillStyle = m.color;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -len * 0.5, w, len, w / 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-w / 2 + 1, -len * 0.5 + 1, w - 2, Math.max(1.5, len * 0.12));
      ctx.restore();
    }
    ctx.restore();
    // Player arrow at the centre, pointing up.
    const a = 9 * this.dpr;
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.beginPath();
    ctx.moveTo(0, -a * 1.25);
    ctx.lineTo(a, a);
    ctx.lineTo(0, a * 0.45);
    ctx.lineTo(-a, a);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 6 * this.dpr;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2 * this.dpr;
    ctx.strokeStyle = '#00a5b5';
    ctx.stroke();
    ctx.restore();
    // Inner vignette ring.
    const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.36, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(7,18,35,0)');
    g.addColorStop(1, 'rgba(7,18,35,0.55)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Warm tiles around a point over the next frames (call with spare time). */
  prewarm(x: number, y: number): void {
    if (!this.ensureSize()) return;
    const cache = this.caches[this.zoom];
    const tm = cache.tileMetres;
    const tx = Math.floor(x / tm);
    const ty = Math.floor(y / tm);
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) cache.get(tx + ox, ty + oy, true);
  }
}
