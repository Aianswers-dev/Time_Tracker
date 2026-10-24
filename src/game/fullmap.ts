// Full-screen route map (key M): whole route, progress, stops, buses.
import type { MapData, Route } from '../types';
import { drawCity, fitView, routeBounds, strokeRoute, type MapView } from './mapdraw';
import { StopStatus, type GuideState } from './guide';
import type { MapMarker } from './minimap';
import { stopDisplayName } from './routeMeta';

export class FullMap {
  readonly canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private base: HTMLCanvasElement | null = null;
  private view: MapView | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private t = 0;

  constructor(
    readonly data: MapData,
    readonly route: Route,
    readonly color: string,
  ) {}

  /** Rebuild the static layer for the current canvas size. */
  private layout(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (!w || !h) return;
    if (this.base && w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const [x0, y0, x1, y1] = routeBounds(this.route);
    const pad = Math.min(w, h) * 0.08 + 40;
    const v = fitView(x0, y0, x1, y1, w * dpr, h * dpr, pad * dpr);
    this.view = v;
    const base = document.createElement('canvas');
    base.width = this.canvas.width;
    base.height = this.canvas.height;
    const bctx = base.getContext('2d')!;
    drawCity(bctx, this.data, v, base.width, base.height, { widthBoost: v.scale < 0.3 ? 1.6 : 1.1, minPx: 0.7 * dpr });
    this.base = base;
  }

  draw(dt: number, g: GuideState, px: number, py: number, heading: number, markers: readonly MapMarker[]): void {
    this.layout();
    const v = this.view;
    if (!this.base || !v) return;
    this.t += dt;
    const ctx = this.ctx;
    const d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.base, 0, 0);
    // Route: done part dim, remaining bright.
    strokeRoute(ctx, this.route, v, 'rgba(0,0,0,0.55)', 9 * d);
    strokeRoute(ctx, this.route, v, 'rgba(255,255,255,0.35)', 5 * d, 0, g.s);
    strokeRoute(ctx, this.route, v, this.color, 5 * d, g.s);
    const P = (x: number, y: number): [number, number] => [(x - v.x0) * v.scale, (v.y0 - y) * v.scale];
    // AI buses.
    for (const m of markers) {
      const [X, Y] = P(m.x, m.y);
      if (X < -20 || Y < -20 || X > this.canvas.width + 20 || Y > this.canvas.height + 20) continue;
      ctx.save();
      ctx.translate(X, Y);
      ctx.rotate(m.heading);
      ctx.fillStyle = m.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2 * d;
      const len = Math.max(8 * d, m.length * v.scale);
      const w = Math.max(4.5 * d, 2.6 * v.scale);
      ctx.fillRect(-w / 2, -len * 0.5, w, len);
      ctx.strokeRect(-w / 2, -len * 0.5, w, len);
      ctx.restore();
    }
    // Stops.
    const stops = this.route.stops;
    ctx.font = `600 ${12 * d}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'middle';
    for (let i = 0; i < stops.length; i++) {
      const s = this.data.stops[stops[i].stop];
      const [X, Y] = P(s.x, s.y);
      const st = g.stopStatus[i];
      const isNext = i === g.nextStopIndex;
      const r = (isNext ? 7 + Math.sin(this.t * 5) * 1.5 : 5) * d;
      ctx.beginPath();
      ctx.arc(X, Y, r, 0, Math.PI * 2);
      ctx.fillStyle = isNext ? '#ffd23f' : st === StopStatus.Served ? '#8dc63f' : st === StopStatus.Missed ? '#ff5a5a' : st === StopStatus.Skipped ? '#6b7d92' : '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2 * d;
      ctx.strokeStyle = '#0b1f3a';
      ctx.stroke();
      if (isNext || i === 0 || i === stops.length - 1) {
        const label = stopDisplayName(s.name);
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(7,18,35,0.85)';
        ctx.beginPath();
        ctx.roundRect(X + 10 * d, Y - 10 * d, tw + 12 * d, 20 * d, 6 * d);
        ctx.fill();
        ctx.fillStyle = isNext ? '#ffd23f' : '#fff';
        ctx.fillText(label, X + 16 * d, Y);
      }
    }
    // Player.
    const [X, Y] = P(px, py);
    ctx.save();
    ctx.translate(X, Y);
    ctx.beginPath();
    ctx.arc(0, 0, (16 + Math.sin(this.t * 3) * 3) * d, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,165,181,0.25)';
    ctx.fill();
    ctx.rotate(heading);
    const a = 10 * d;
    ctx.beginPath();
    ctx.moveTo(0, -a * 1.3);
    ctx.lineTo(a, a);
    ctx.lineTo(0, a * 0.45);
    ctx.lineTo(-a, a);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2.5 * d;
    ctx.strokeStyle = '#00a5b5';
    ctx.stroke();
    ctx.restore();
  }

  invalidate(): void {
    this.base = null;
  }
}
