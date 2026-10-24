// Busway station platforms from data.platforms: raised slabs with a yellow
// tactile edge, canopies on covered platforms, and lettered bays (flags on the
// platform edge, dividers on the road) along every kerb. GTFS stops are
// matched to platforms so a bus can serve the stop at any bay.
import * as THREE from 'three';
import { RoadKind, type MapData, type Platform, type Route } from '../types';
import { pointAlong } from '../data/coords';
import { roadIndexFor } from './roadIndex';
import { LEVEL_GAP, heightAt, heightsOf } from './height';

export const PLATFORM_HEIGHT = 0.3;
const CANOPY_HEIGHT = 3.8;
const BAY_LENGTH = 16;

/** One kerb (the edge buses pull up to), oriented along the direction of travel. */
export interface KerbChain {
  /** Polyline [x, y, ...] along the platform edge, in bus travel direction. */
  pts: Float32Array;
  cum: Float32Array;
  len: number;
  /** Unit vector from the kerb into the road (left of travel is the platform). */
  outX: number;
  outY: number;
  /** Bay labels, front (downstream) first: "2A", "2B"... */
  bays: string[];
}

export interface PlatformGeom {
  index: number;
  name: string;
  /** Platform number if known ("1", "2", ...). */
  num: string;
  covered: boolean;
  underground: boolean;
  /** Outline ring [x, y, ...] (not closed) of the slab. */
  outline: Float32Array;
  kerbs: KerbChain[];
  /** Back edges (not facing a busway) for canopy posts: [x0, y0, x1, y1, ...]. */
  back: number[];
  /**
   * Height plane of the platform's road edge: z = z0 + slope * ((x, y) - (px, py)) . (tx, ty),
   * fitted to the busway beside the main kerb (platforms carry no heights of their own;
   * King George Square and Queen Street come out underground).
   */
  plane: { px: number; py: number; tx: number; ty: number; z0: number; slope: number };
  /** Bounding box for quick tests. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function signedArea(p: ArrayLike<number>): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
  }
  return a / 2;
}

function platformNumber(p: Platform): string {
  const m = /platform\s*(\d+[a-z]?)/i.exec(p.name);
  if (m) return m[1].toUpperCase();
  if (/^\d{1,2}[a-z]?$/i.test(p.ref)) return p.ref.toUpperCase();
  return '';
}

/** Normalised station name for matching ("Cultural Centre station, platform 1" -> "cultural centre"). */
export function stationKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/,.*$/, '')
    .replace(/\b(platform|busway|bus|station|stop)\b.*$/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const geomCache = new WeakMap<MapData, PlatformGeom[]>();

/** Platform outlines, kerbs and bays (cached per map). */
export function platformGeoms(data: MapData): PlatformGeom[] {
  const cached = geomCache.get(data);
  if (cached) return cached;
  heightsOf(data);
  const idx = roadIndexFor(data);
  const isBus = (r: { bus: boolean; kind: RoadKind }) => r.bus || r.kind === RoadKind.Busway;
  const busTunnel = (r: { bus: boolean; kind: RoadKind; tunnel: boolean }) => isBus(r) && r.tunnel;
  const out: PlatformGeom[] = [];
  (data.platforms ?? []).forEach((pl, index) => {
    const p = pl.pts;
    const n = p.length / 2;
    if (n < 2) return;
    let outline: Float32Array;
    const kerbSegs: { ax: number; ay: number; bx: number; by: number; ox: number; oy: number }[] = [];
    const back: number[] = [];
    if (pl.area && n >= 3) {
      outline = p;
      const ccw = signedArea(p) > 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = p[2 * i];
        const ay = p[2 * i + 1];
        const bx = p[2 * j];
        const by = p[2 * j + 1];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 0.5) continue;
        const ex = (bx - ax) / len;
        const ey = (by - ay) / len;
        // Outward normal: right of the edge for a counter-clockwise ring.
        const ox = ccw ? ey : -ey;
        const oy = ccw ? -ex : ex;
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const hit = len >= 2 ? idx.nearest(mx, my, 16, undefined, 0, isBus) : null;
        let kerb = false;
        if (hit) {
          const align = Math.abs(hit.dx * ex + hit.dy * ey);
          const facing = (hit.px - mx) * ox + (hit.py - my) * oy;
          kerb = align > 0.85 && facing > -0.5;
        }
        if (kerb) kerbSegs.push({ ax, ay, bx, by, ox, oy });
        else if (len > 3) back.push(ax, ay, bx, by);
      }
    } else {
      // A line: the platform edge. The body extends away from the busway.
      const hit = idx.nearest((p[0] + p[2 * n - 2]) / 2, (p[1] + p[2 * n - 1]) / 2, 20, undefined, 0, isBus);
      const ring: number[] = [];
      const backPts: number[] = [];
      for (let i = 0; i + 1 < n; i++) {
        const ax = p[2 * i];
        const ay = p[2 * i + 1];
        const bx = p[2 * i + 2];
        const by = p[2 * i + 3];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 0.3) continue;
        let ox = (by - ay) / len;
        let oy = -(bx - ax) / len;
        if (hit && (hit.px - ax) * ox + (hit.py - ay) * oy < 0) {
          ox = -ox;
          oy = -oy;
        }
        kerbSegs.push({ ax, ay, bx, by, ox, oy });
        backPts.push(ax - ox * 3.5, ay - oy * 3.5, bx - ox * 3.5, by - oy * 3.5);
      }
      for (const s of kerbSegs) ring.push(s.ax, s.ay);
      const last = kerbSegs[kerbSegs.length - 1];
      if (!last) return;
      ring.push(last.bx, last.by);
      for (let i = backPts.length - 2; i >= 0; i -= 2) ring.push(backPts[i], backPts[i + 1]);
      outline = new Float32Array(ring);
      for (let i = 0; i + 3 < backPts.length; i += 4) back.push(backPts[i], backPts[i + 1], backPts[i + 2], backPts[i + 3]);
    }
    // Join kerb segments into chains and orient them along the travel direction
    // (platform on the left, as buses drive on the left).
    const chains: KerbChain[] = [];
    const used = new Array<boolean>(kerbSegs.length).fill(false);
    const num = platformNumber(pl);
    for (let k = 0; k < kerbSegs.length; k++) {
      if (used[k]) continue;
      used[k] = true;
      const pts: number[] = [kerbSegs[k].ax, kerbSegs[k].ay, kerbSegs[k].bx, kerbSegs[k].by];
      let ox = kerbSegs[k].ox;
      let oy = kerbSegs[k].oy;
      let grew = true;
      while (grew) {
        grew = false;
        for (let m = 0; m < kerbSegs.length; m++) {
          if (used[m]) continue;
          const s = kerbSegs[m];
          const ex = pts[pts.length - 2];
          const ey = pts[pts.length - 1];
          if (Math.hypot(s.ax - ex, s.ay - ey) < 0.05) {
            pts.push(s.bx, s.by);
            ox += s.ox;
            oy += s.oy;
            used[m] = true;
            grew = true;
          } else if (Math.hypot(s.bx - pts[0], s.by - pts[1]) < 0.05) {
            pts.unshift(s.ax, s.ay);
            ox += s.ox;
            oy += s.oy;
            used[m] = true;
            grew = true;
          }
        }
      }
      const ol = Math.hypot(ox, oy) || 1;
      ox /= ol;
      oy /= ol;
      // Travel direction t has the platform on its left: left(t) = -out.
      const tx = -oy;
      const ty = ox;
      const dirX = pts[pts.length - 2] - pts[0];
      const dirY = pts[pts.length - 1] - pts[1];
      if (dirX * tx + dirY * ty < 0) {
        const rev: number[] = [];
        for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i], pts[i + 1]);
        pts.length = 0;
        pts.push(...rev);
      }
      const arr = new Float32Array(pts);
      const cum = new Float32Array(arr.length / 2);
      for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + Math.hypot(arr[2 * i] - arr[2 * i - 2], arr[2 * i + 1] - arr[2 * i - 1]);
      const len = cum[cum.length - 1];
      if (len < 8) continue;
      const nb = Math.max(1, Math.round(len / BAY_LENGTH));
      const bays: string[] = [];
      for (let b = 0; b < nb; b++) bays.push(`${num}${String.fromCharCode(65 + b)}`);
      chains.push({ pts: arr, cum, len, outX: ox, outY: oy, bays });
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < outline.length; i += 2) {
      x0 = Math.min(x0, outline[i]);
      x1 = Math.max(x1, outline[i]);
      y0 = Math.min(y0, outline[i + 1]);
      y1 = Math.max(y1, outline[i + 1]);
    }
    // Height: fit a line to the busway height beside the longest kerb.
    let plane = { px: (x0 + x1) / 2, py: (y0 + y1) / 2, tx: 1, ty: 0, z0: heightAt((x0 + x1) / 2, (y0 + y1) / 2), slope: 0 };
    const main = chains.reduce<KerbChain | null>((a, c) => (!a || c.len > a.len ? c : a), null);
    if (main) {
      const ds: number[] = [];
      const zs: number[] = [];
      // Underground platforms take the tunnel busway's height (falling back to any busway).
      for (const accept of pl.underground ? [busTunnel, isBus] : [isBus]) {
        for (let k = 0; k <= 6; k++) {
          const d = (main.len * k) / 6;
          const q = chainAt(main, d);
          const hit = idx.nearest(q.x + main.outX * 2, q.y + main.outY * 2, 25, undefined, 0, accept);
          if (!hit) continue;
          ds.push(d);
          zs.push(hit.z);
        }
        if (zs.length) break;
      }
      if (zs.length) {
        const n2 = zs.length;
        const md = ds.reduce((a, b) => a + b, 0) / n2;
        const mz = zs.reduce((a, b) => a + b, 0) / n2;
        let num2 = 0;
        let den = 0;
        for (let k = 0; k < n2; k++) {
          num2 += (ds[k] - md) * (zs[k] - mz);
          den += (ds[k] - md) ** 2;
        }
        const slope = den > 1e-6 ? Math.max(-0.12, Math.min(0.12, num2 / den)) : 0;
        const p0 = chainAt(main, 0);
        const tl = Math.hypot(main.pts[main.pts.length - 2] - main.pts[0], main.pts[main.pts.length - 1] - main.pts[1]) || 1;
        plane = {
          px: p0.x,
          py: p0.y,
          tx: (main.pts[main.pts.length - 2] - main.pts[0]) / tl,
          ty: (main.pts[main.pts.length - 1] - main.pts[1]) / tl,
          z0: mz - slope * md,
          slope,
        };
      }
    }
    out.push({ index, name: pl.name, num, covered: pl.covered, underground: pl.underground, outline, kerbs: chains, back, plane, x0, y0, x1, y1 });
  });
  geomCache.set(data, out);
  return out;
}

/** Point at distance d along a chain (clamped). */
function chainAt(c: KerbChain, d: number): { x: number; y: number; tx: number; ty: number } {
  const n = c.cum.length;
  const s = Math.max(0, Math.min(c.len, d));
  let i = 0;
  while (i < n - 2 && c.cum[i + 1] < s) i++;
  const ax = c.pts[2 * i];
  const ay = c.pts[2 * i + 1];
  const bx = c.pts[2 * i + 2];
  const by = c.pts[2 * i + 3];
  const l = Math.max(1e-6, c.cum[i + 1] - c.cum[i]);
  const t = (s - c.cum[i]) / l;
  return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, tx: (bx - ax) / l, ty: (by - ay) / l };
}

// ---------------------------------------------------------------------------
// Matching GTFS stops to platforms

export interface PlatformZone {
  platform: number;
  /** Route distances alongside the platform kerb. */
  s0: number;
  s1: number;
  /** Lateral distance (left) from the route line to the platform edge at s, sampled every `step` m from s0. */
  edge: Float32Array;
  step: number;
}

/** Distance along the ray (x, y) + t (dx, dy), t in [0, maxT], to the platform outline, or Infinity. */
function rayHit(g: PlatformGeom, x: number, y: number, dx: number, dy: number, maxT: number): number {
  const p = g.outline;
  const n = p.length / 2;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[2 * i];
    const ay = p[2 * i + 1];
    const ex = p[2 * j] - ax;
    const ey = p[2 * j + 1] - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - x) * ey - (ay - y) * ex) / den;
    const u = ((ax - x) * dy - (ay - y) * dx) / den;
    if (t >= 0 && t <= maxT && u >= 0 && u <= 1 && t < best) best = t;
  }
  return best;
}

/**
 * The platform (if any) a route stop is served from, and the stretch of the
 * route alongside its kerb. Name and platform number are preferred; geometry
 * (a platform edge just left of the route) is required.
 */
export function matchStopPlatform(data: MapData, route: Route, stopIndex: number): PlatformZone | null {
  const geoms = platformGeoms(data);
  if (!geoms.length) return null;
  const rs = route.stops[stopIndex];
  const stop = data.stops[rs.stop];
  const key = stationKey(stop.name);
  const numM = /platform\s*(\d+)/i.exec(stop.name) ?? /,\s*(\d+)[a-z]?$/i.exec(stop.name);
  const num = numM ? numM[1] : '';
  let best: PlatformZone | null = null;
  let bestScore = Infinity;
  const step = 2;
  const zr = heightsOf(data).routeZ(route, rs.s);
  for (const g of geoms) {
    if (stop.x < g.x0 - 70 || stop.x > g.x1 + 70 || stop.y < g.y0 - 70 || stop.y > g.y1 + 70) continue;
    // Same level only (an underground station under a street stop is not it).
    const pl = g.plane;
    if (Math.abs(pl.z0 + pl.slope * ((stop.x - pl.px) * pl.tx + (stop.y - pl.py) * pl.ty) - zr) > LEVEL_GAP) continue;
    // Walk the route around the stop and cast to the left.
    const from = Math.max(0, rs.s - 110);
    const to = Math.min(route.length, rs.s + 110);
    const hits: { s: number; h: number }[] = [];
    for (let s = from; s <= to; s += step) {
      const q = pointAlong(route.pts, route.cum, s);
      const lx = -Math.cos(q.heading);
      const ly = Math.sin(q.heading);
      const h = rayHit(g, q.x - lx * 1.5, q.y - ly * 1.5, lx, ly, 18);
      if (h < Infinity) hits.push({ s, h: h - 1.5 });
    }
    if (hits.length < 3) continue;
    // The run of hits closest to the stop.
    const runs: { s: number; h: number }[][] = [];
    for (const hpt of hits) {
      const run = runs[runs.length - 1];
      if (run && hpt.s - run[run.length - 1].s <= step * 3) run.push(hpt);
      else runs.push([hpt]);
    }
    let run = runs[0];
    let rd = Infinity;
    for (const r of runs) {
      const d = rs.s < r[0].s ? r[0].s - rs.s : rs.s > r[r.length - 1].s ? rs.s - r[r.length - 1].s : 0;
      if (d < rd) {
        rd = d;
        run = r;
      }
    }
    const s0 = run[0].s;
    const s1 = run[run.length - 1].s;
    if (s1 - s0 < 8 || rd > 40) continue;
    const gKey = stationKey(g.name);
    const nameOk = !!gKey && !!key && (gKey.includes(key) || key.includes(gKey));
    const numOk = !!num && num === g.num.replace(/[A-Z]$/, '');
    const score = rd - (nameOk ? 30 : 0) - (numOk ? 20 : 0);
    if (score < bestScore) {
      bestScore = score;
      const edge = new Float32Array(Math.floor((s1 - s0) / step) + 1);
      for (const hpt of run) {
        const i = Math.round((hpt.s - s0) / step);
        if (i >= 0 && i < edge.length) edge[i] = hpt.h;
      }
      // Fill any gaps.
      for (let i = 1; i < edge.length; i++) if (!edge[i]) edge[i] = edge[i - 1];
      best = { platform: g.index, s0, s1, edge, step };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Scene

function bayTexture(labels: string[]): { tex: THREE.CanvasTexture; uv: Map<string, [number, number, number, number]> } {
  const uniq = [...new Set(labels)];
  const W = 96;
  const H = 128;
  const cols = 16;
  const rows = Math.max(1, Math.ceil(uniq.length / cols));
  const c = document.createElement('canvas');
  c.width = cols * W;
  c.height = rows * H;
  const ctx = c.getContext('2d')!;
  const uv = new Map<string, [number, number, number, number]>();
  uniq.forEach((label, k) => {
    const x = (k % cols) * W;
    const y = Math.floor(k / cols) * H;
    ctx.fillStyle = '#0b1f3a';
    ctx.fillRect(x, y, W, H);
    ctx.fillStyle = '#e463a4';
    ctx.fillRect(x, y + H - 10, W, 10);
    ctx.fillStyle = '#9fc3e6';
    ctx.font = '800 16px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BAY', x + W / 2, y + 26);
    ctx.fillStyle = '#ffffff';
    ctx.font = `900 ${label.length > 2 ? 40 : 52}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.fillText(label, x + W / 2, y + 88);
    uv.set(label, [x / c.width, 1 - (y + H) / c.height, W / c.width, H / c.height]);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, uv };
}

function ringShape(p: Float32Array): THREE.Shape | null {
  const n = p.length / 2;
  if (n < 3) return null;
  const s = new THREE.Shape();
  s.moveTo(p[0], p[1]);
  for (let i = 1; i < n; i++) s.lineTo(p[2 * i], p[2 * i + 1]);
  s.closePath();
  return s;
}

const built = new WeakSet<THREE.Scene>();

/** Add every platform to the scene (once per scene). */
export function buildPlatforms(scene: THREE.Scene, data: MapData): void {
  if (built.has(scene)) return;
  built.add(scene);
  const geoms = platformGeoms(data);
  if (!geoms.length) return;
  const group = new THREE.Group();
  group.name = 'platforms';
  const concrete = new THREE.MeshLambertMaterial({ color: 0xbdb9b0 });
  const tactile = new THREE.MeshLambertMaterial({ color: 0xf2c200, emissive: 0x3a2e00, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0xeef1f4, emissive: 0x3c4248, side: THREE.DoubleSide });
  const postMat = new THREE.MeshLambertMaterial({ color: 0x2f353c });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xfff1d6 });
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xf4f4f4, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const poleMat = new THREE.MeshLambertMaterial({ color: 0xa9b1b8 });
  const slabs: THREE.BufferGeometry[] = [];
  const roofs: THREE.BufferGeometry[] = [];
  const tact: number[] = [];
  const lines: number[] = [];
  const posts: THREE.Matrix4[] = [];
  const flags: { x: number; y: number; h: number; label: string; heading: number }[] = [];
  const m4 = new THREE.Matrix4();
  // A flat quad draped on the platform's height plane, `dh` above it.
  let zf = (_x: number, _y: number) => 0;
  const quad = (arr: number[], ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, dh: number) => {
    const ha = zf(ax, ay) + dh;
    const hb = zf(bx, by) + dh;
    const hc = zf(cx, cy) + dh;
    const hd = zf(dx, dy) + dh;
    arr.push(ax, ha, -ay, bx, hb, -by, cx, hc, -cy, ax, ha, -ay, cx, hc, -cy, dx, hd, -dy);
  };
  const drape = (geo: THREE.BufferGeometry, dh: number) => {
    const a = geo.getAttribute('position');
    for (let i = 0; i < a.count; i++) a.setY(i, a.getY(i) + zf(a.getX(i), -a.getZ(i)) + dh);
  };
  for (const g of geoms) {
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < g.outline.length; i += 2) {
      cx += g.outline[i];
      cy += g.outline[i + 1];
    }
    cx /= g.outline.length / 2;
    cy /= g.outline.length / 2;
    const pl = g.plane;
    zf = (x: number, y: number) => pl.z0 + pl.slope * ((x - pl.px) * pl.tx + (y - pl.py) * pl.ty);
    const shape = ringShape(g.outline);
    if (shape) {
      const slab = new THREE.ExtrudeGeometry(shape, { depth: PLATFORM_HEIGHT, bevelEnabled: false });
      slab.rotateX(-Math.PI / 2);
      const sn = slab.index ? slab.toNonIndexed() : slab;
      drape(sn, 0);
      slabs.push(sn);
      if (g.covered) {
        const roof = new THREE.ExtrudeGeometry(shape, { depth: 0.18, bevelEnabled: false });
        roof.rotateX(-Math.PI / 2);
        const rn = roof.index ? roof.toNonIndexed() : roof;
        drape(rn, CANOPY_HEIGHT);
        roofs.push(rn);
      }
    }
    const top = PLATFORM_HEIGHT + 0.004;
    for (const k of g.kerbs) {
      // Tactile strip just in from the edge (the platform is on the left of travel).
      for (let i = 0; i + 1 < k.cum.length; i++) {
        const ax = k.pts[2 * i];
        const ay = k.pts[2 * i + 1];
        const bx = k.pts[2 * i + 2];
        const by = k.pts[2 * i + 3];
        const ix = -k.outX;
        const iy = -k.outY;
        quad(tact, ax + ix * 0.15, ay + iy * 0.15, bx + ix * 0.15, by + iy * 0.15, bx + ix * 0.65, by + iy * 0.65, ax + ix * 0.65, ay + iy * 0.65, top);
      }
      // Bays: flag at the front of each bay, divider lines on the road between bays.
      const nb = k.bays.length;
      const bl = k.len / nb;
      for (let b = 0; b < nb; b++) {
        const front = k.len - b * bl - 1.2;
        const q = chainAt(k, front);
        flags.push({ x: q.x - k.outX * 0.45, y: q.y - k.outY * 0.45, h: zf(q.x, q.y) + PLATFORM_HEIGHT, label: k.bays[b], heading: Math.atan2(q.tx, q.ty) });
        const d = chainAt(k, k.len - b * bl);
        const ox = k.outX;
        const oy = k.outY;
        const tx = d.tx * 0.07;
        const ty = d.ty * 0.07;
        const h = 0.05;
        quad(lines, d.x + ox * 0.2 - tx, d.y + oy * 0.2 - ty, d.x + ox * 3.0 - tx, d.y + oy * 3.0 - ty, d.x + ox * 3.0 + tx, d.y + oy * 3.0 + ty, d.x + ox * 0.2 + tx, d.y + oy * 0.2 + ty, h);
        if (b === nb - 1) {
          const e = chainAt(k, 0);
          quad(lines, e.x + ox * 0.2 - tx, e.y + oy * 0.2 - ty, e.x + ox * 3.0 - tx, e.y + oy * 3.0 - ty, e.x + ox * 3.0 + tx, e.y + oy * 3.0 + ty, e.x + ox * 0.2 + tx, e.y + oy * 0.2 + ty, h);
        }
      }
      // Edge line along the kerb on the road.
      for (let i = 0; i + 1 < k.cum.length; i++) {
        const ax = k.pts[2 * i];
        const ay = k.pts[2 * i + 1];
        const bx = k.pts[2 * i + 2];
        const by = k.pts[2 * i + 3];
        const h = 0.05;
        quad(lines, ax + k.outX * 0.2, ay + k.outY * 0.2, bx + k.outX * 0.2, by + k.outY * 0.2, bx + k.outX * 0.32, by + k.outY * 0.32, ax + k.outX * 0.32, ay + k.outY * 0.32, h);
      }
    }
    if (g.covered) {
      // Posts along the back edges, inset onto the platform.
      for (let i = 0; i + 3 < g.back.length; i += 4) {
        const ax = g.back[i];
        const ay = g.back[i + 1];
        const bx = g.back[i + 2];
        const by = g.back[i + 3];
        const len = Math.hypot(bx - ax, by - ay);
        const ex = (bx - ax) / len;
        const ey = (by - ay) / len;
        let nx = -ey;
        let ny = ex;
        if ((cx - ax) * nx + (cy - ay) * ny < 0) {
          nx = -nx;
          ny = -ny;
        }
        for (let d = 2; d < len - 1; d += 7.5) {
          const px = ax + ex * d + nx * 0.5;
          const py = ay + ey * d + ny * 0.5;
          m4.makeTranslation(px, zf(px, py) + PLATFORM_HEIGHT + (CANOPY_HEIGHT - PLATFORM_HEIGHT) / 2, -py);
          posts.push(m4.clone());
        }
      }
    }
  }
  const merge = (geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null => {
    if (!geos.length) return null;
    const pos: number[] = [];
    for (const g of geos) {
      const a = g.getAttribute('position');
      for (let i = 0; i < a.count; i++) pos.push(a.getX(i), a.getY(i), a.getZ(i));
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.computeVertexNormals();
    return out;
  };
  const slabGeo = merge(slabs);
  if (slabGeo) group.add(new THREE.Mesh(slabGeo, concrete));
  const roofGeo = merge(roofs);
  if (roofGeo) group.add(new THREE.Mesh(roofGeo, roofMat));
  const flat = (arr: number[], mat: THREE.Material) => {
    if (!arr.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = 2;
    group.add(m);
  };
  flat(tact, tactile);
  flat(lines, lineMat);
  if (posts.length) {
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, CANOPY_HEIGHT - PLATFORM_HEIGHT, 0.2), postMat, posts.length);
    posts.forEach((m, i) => im.setMatrixAt(i, m));
    im.computeBoundingSphere();
    group.add(im);
  }
  // Lamps under the canopies (a strip along each kerb).
  if (roofGeo) {
    const strips: number[] = [];
    for (const g of geoms) {
      if (!g.covered) continue;
      const pl = g.plane;
      zf = (x: number, y: number) => pl.z0 + pl.slope * ((x - pl.px) * pl.tx + (y - pl.py) * pl.ty);
      for (const k of g.kerbs) {
        for (let i = 0; i + 1 < k.cum.length; i++) {
          const ax = k.pts[2 * i] - k.outX * 1.6;
          const ay = k.pts[2 * i + 1] - k.outY * 1.6;
          const bx = k.pts[2 * i + 2] - k.outX * 1.6;
          const by = k.pts[2 * i + 3] - k.outY * 1.6;
          const h = CANOPY_HEIGHT - 0.02;
          quad(strips, ax, ay, bx, by, bx - k.outX * 0.15, by - k.outY * 0.15, ax - k.outX * 0.15, ay - k.outY * 0.15, h);
        }
      }
    }
    if (strips.length) {
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(strips, 3));
      const lm = new THREE.Mesh(sg, lamp);
      lm.material.side = THREE.DoubleSide;
      group.add(lm);
    }
  }
  // Bay flags: a pole with a double-sided lettered plate facing along the kerb.
  if (flags.length) {
    const { tex, uv } = bayTexture(flags.map((f) => f.label));
    const plateMat = new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35 });
    const poleGeo = new THREE.CylinderGeometry(0.04, 0.045, 2.6, 6).translate(0, 1.3, 0);
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, flags.length);
    const o = new THREE.Object3D();
    flags.forEach((f, i) => {
      o.position.set(f.x, f.h, -f.y);
      o.rotation.set(0, -f.heading, 0);
      o.updateMatrix();
      poles.setMatrixAt(i, o.matrix);
      const plate = new THREE.BoxGeometry(0.42, 0.56, 0.03);
      const a = plate.getAttribute('uv') as THREE.BufferAttribute;
      const r = uv.get(f.label)!;
      for (let q = 0; q < a.count; q++) {
        const face = Math.floor(q / 4);
        if (face === 4 || face === 5) a.setXY(q, r[0] + a.getX(q) * r[2], r[1] + a.getY(q) * r[3]);
        else a.setXY(q, r[0] + 0.02 * r[2], r[1] + 0.98 * r[3]);
      }
      // Plate sticks out over the platform edge towards the road (local +X is the road side).
      plate.translate(0.26, 2.3, 0);
      const mesh = new THREE.Mesh(plate, plateMat);
      mesh.position.copy(o.position);
      mesh.rotation.copy(o.rotation);
      group.add(mesh);
    });
    poles.computeBoundingSphere();
    group.add(poles);
  }
  scene.add(group);
}
