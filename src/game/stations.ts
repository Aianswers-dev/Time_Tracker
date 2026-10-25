// Station models for busway platforms: the TransLink station kit (paving,
// kerb/tactile edge, cantilevered canopies on a single row of posts, glazed
// rear screens, benches, bins, PIDs, totems, orange signs), elevated decks on
// columns, underground screen walls with door pods, median fences and lights,
// and the per-station landmarks of src/data/stations.ts (vaults, lift towers,
// overbridges, chargers, louvres, pavilions). Each station is one opaque mesh
// and one glass mesh; signs come from a shared atlas.
import * as THREE from 'three';
import { RoadKind, type MapData, type Road } from '../types';
import { DEFAULT_STATION, STATIONS, enclosureStyle, stationAt, type ConcourseDef, type OverbridgeDef, type StationDef, type TowerDef } from '../data/stations';
import type { Heights } from '../data/height';
import { heightsOf } from './height';
import { roadIndexFor } from './roadIndex';
import type { KerbChain, PlatformGeom } from './platforms';
import { Atlas, Pat, SGeo, glassMaterial, stationMaterial, type V3 } from './stationGeo';

const SLAB = 0.3;
const KERB_BAND = 0xd8d4ca;
const TACTILE = 0x4b4e52;
const YELLOW = 0xf2c200;
const YELLOW_TACTILE = 0xe2b21c;
const CONCRETE = 0xb7b3aa;
const CONCRETE_DARK = 0x8f8b84;
const STEEL_DARK = 0x1f2124;
const BENCH = 0x9ea4a8;
const WHITE = 0xf2f2ee;
const STAINLESS = 0xc9ccce;
const TERRACOTTA = 0xb8603a;

const isBus = (r: Road) => (r.bus || r.kind === RoadKind.Busway) && !(r as { bay?: boolean }).bay;

interface Sample {
  d: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** Inward normal (into the platform: left of travel). */
  nx: number;
  ny: number;
}

/** Samples every ~step m along a kerb chain (always including both ends). */
function samples(k: KerbChain, step: number, d0 = 0, d1 = k.len): Sample[] {
  const out: Sample[] = [];
  const n = Math.max(1, Math.round((d1 - d0) / step));
  for (let i = 0; i <= n; i++) out.push(at(k, d0 + ((d1 - d0) * i) / n));
  return out;
}

function at(k: KerbChain, d: number): Sample {
  const n = k.cum.length;
  const s = Math.max(0, Math.min(k.len, d));
  let i = 0;
  while (i < n - 2 && k.cum[i + 1] < s) i++;
  const ax = k.pts[2 * i];
  const ay = k.pts[2 * i + 1];
  const bx = k.pts[2 * i + 2];
  const by = k.pts[2 * i + 3];
  const l = Math.max(1e-6, k.cum[i + 1] - k.cum[i]);
  const t = (s - k.cum[i]) / l;
  let tx = (bx - ax) / l;
  let ty = (by - ay) / l;
  // smooth the tangent across vertices
  const blend = (j: number, w: number) => {
    if (j < 0 || j + 1 >= n) return;
    const lx = k.pts[2 * j + 2] - k.pts[2 * j];
    const ly = k.pts[2 * j + 3] - k.pts[2 * j + 1];
    const ll = Math.hypot(lx, ly) || 1;
    tx = tx * (1 - w) + (lx / ll) * w;
    ty = ty * (1 - w) + (ly / ll) * w;
  };
  if (t < 0.15) blend(i - 1, 0.5 * (1 - t / 0.15));
  else if (t > 0.85) blend(i + 1, 0.5 * ((t - 0.85) / 0.15));
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl;
  return { d: s, x: ax + (bx - ax) * t, y: ay + (by - ay) * t, tx, ty, nx: -ty, ny: tx };
}

/** Distance from (x, y) along (dx, dy) to a closed ring, or Infinity. */
function rayRing(p: Float32Array, x: number, y: number, dx: number, dy: number, maxT: number): number {
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

function pointInRing(p: Float32Array, x: number, y: number): boolean {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[2 * i];
    const yi = p[2 * i + 1];
    const xj = p[2 * j];
    const yj = p[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

interface StationBuild {
  def: StationDef;
  geo: SGeo;
  glass: SGeo;
  plats: PlatformGeom[];
}

interface Ctx {
  data: MapData;
  heights: Heights;
  idx: ReturnType<typeof roadIndexFor>;
  atlas: Atlas;
  lines: number[];
}

/** Lettered stops (KGS "1c", Queen St "1f", UQ Lakes "A") and platform numbers at a platform, from GTFS. */
function stopsAt(c: Ctx, g: PlatformGeom, zf: (x: number, y: number) => number): { code: string; k: KerbChain; d: number }[] {
  const out: { code: string; k: KerbChain; d: number }[] = [];
  for (const s of c.data.stops) {
    if (s.x < g.x0 - 15 || s.x > g.x1 + 15 || s.y < g.y0 - 15 || s.y > g.y1 + 15) continue;
    const m = /,\s*(\d[a-h])\s*$/i.exec(s.name) ?? /\bstop\s+([a-h])\s*$/i.exec(s.name);
    if (!m) continue;
    if (Math.abs(zf(s.x, s.y) - s.z) > 3) continue;
    let best: { k: KerbChain; d: number; dist: number } | null = null;
    for (const k of g.kerbs) {
      for (let d = 0; d <= k.len; d += 1) {
        const q = at(k, d);
        const dist = Math.hypot(q.x - s.x, q.y - s.y);
        if (!best || dist < best.dist) best = { k, d, dist };
      }
    }
    if (!best || best.dist > 12) continue;
    const code = m[1].length === 2 ? m[1].toLowerCase() : m[1].toUpperCase();
    if (out.some((o) => o.code === code)) continue;
    out.push({ code, k: best.k, d: best.d });
  }
  return out;
}

/** Platform number from the platform, or from a GTFS stop on it. */
function platformNumber(c: Ctx, g: PlatformGeom): string {
  if (g.num) return g.num.replace(/[A-Z]$/, '');
  for (const s of c.data.stops) {
    if (s.x < g.x0 - 12 || s.x > g.x1 + 12 || s.y < g.y0 - 12 || s.y > g.y1 + 12) continue;
    const m = /platform\s*(\d+)/i.exec(s.name);
    if (m) return m[1];
  }
  return '';
}

/** Underground platform? The station's own setting wins over OSM's layer (Normanby is an open cutting). */
function isUnder(def: StationDef, g: PlatformGeom): boolean {
  return def.underground ?? g.underground;
}

/**
 * OSM maps some platforms twice (a line and an area: Normanby). Drop an
 * unnamed platform whose middle lies on a named one of the same station.
 */
function dedupe(plats: PlatformGeom[]): PlatformGeom[] {
  return plats.filter((g) => {
    if (g.name) return true;
    const cx = (g.x0 + g.x1) / 2;
    const cy = (g.y0 + g.y1) / 2;
    return !plats.some((h) => h !== g && h.name && pointInRing(h.outline, cx, cy));
  });
}

// ---------------------------------------------------------------------------

export function buildStations(scene: THREE.Scene, data: MapData, geoms: PlatformGeom[]): THREE.Group {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'stations';
  const c: Ctx = { data, heights: heightsOf(data), idx: roadIndexFor(data), atlas: new Atlas(), lines: [] };
  // Group platforms by station.
  const builds = new Map<string, StationBuild>();
  const anon: StationBuild[] = [];
  const mk = (def: StationDef): StationBuild => ({ def, geo: new SGeo(), glass: new SGeo(), plats: [] });
  for (const g of geoms) {
    const cx = (g.x0 + g.x1) / 2;
    const cy = (g.y0 + g.y1) / 2;
    const def = stationAt(cx, cy);
    if (def) {
      let b = builds.get(def.key);
      if (!b) builds.set(def.key, (b = mk(def)));
      b.plats.push(g);
    } else {
      // unnamed busway stops elsewhere: join a nearby anonymous station
      let b = anon.find((a) => a.plats.some((p) => Math.hypot((p.x0 + p.x1) / 2 - cx, (p.y0 + p.y1) / 2 - cy) < 70));
      if (!b) anon.push((b = mk({ ...DEFAULT_STATION, x: cx, y: cy, r: 70 })));
      b.plats.push(g);
    }
  }
  // Station structures without platforms in the data still get their landmarks.
  for (const def of STATIONS) if (!builds.has(def.key) && (def.overbridges || def.towers || def.chargers || def.ownBuildings)) builds.set(def.key, mk(def));
  const all = [...builds.values(), ...anon];
  for (const b of all) {
    b.plats = dedupe(b.plats);
    for (const g of b.plats) buildPlatform(c, b, g);
    buildMedian(c, b);
    for (const o of b.def.overbridges ?? []) buildOverbridge(c, b, o);
    for (const t of b.def.towers ?? []) buildTower(c, b, t, null);
    buildChargers(c, b);
    if (b.def.key === 'kgs') buildPavilions(c, b);
    if (b.def.key === 'roma') buildRomaP1(c, b);
    if (b.def.concourse) buildConcourse(c, b, b.def.concourse);
    for (const e of b.def.entrances ?? []) buildEntrance(c, b, e);
  }
  // INB enclosures (QUT Kelvin Grove to Herston)
  for (const bld of data.buildings) {
    const def = enclosureStyle(bld);
    if (!def) continue;
    const b = builds.get(def.key) ?? mk(def);
    if (!builds.has(def.key)) {
      builds.set(def.key, b);
      all.push(b);
    }
    buildVault(c, b, bld.pts);
  }
  c.atlas.build();
  const opaque = stationMaterial(c.atlas);
  const glass = glassMaterial();
  for (const b of all) {
    if (!b.geo.empty) {
      const m = new THREE.Mesh(b.geo.finish(c.atlas), opaque);
      m.name = `station-${b.def.key || 'stop'}`;
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
    if (!b.glass.empty) {
      const m = new THREE.Mesh(b.glass.finish(c.atlas), glass);
      m.name = `station-glass-${b.def.key || 'stop'}`;
      m.renderOrder = 3;
      group.add(m);
    }
  }
  if (c.lines.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(c.lines, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xf0f0ec, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    m.renderOrder = 2;
    m.name = 'station-lines';
    group.add(m);
  }
  scene.add(group);
  let tris = 0;
  for (const m of group.children) tris += ((m as THREE.Mesh).geometry.index?.count ?? 0) / 3;
  console.info(`[stations] ${all.length} stations, ${group.children.length} meshes, ${Math.round(tris / 1000)}k triangles, built in ${Math.round(performance.now() - t0)} ms`);
  return group;
}

// ---------------------------------------------------------------------------
// One platform

function buildPlatform(c: Ctx, b: StationBuild, g: PlatformGeom): void {
  const own = b.def.platforms?.[platformNumber(c, g)];
  const def = own ? { ...b.def, ...own } : b.def;
  const geo = b.geo;
  const glass = b.glass;
  const pl = g.plane;
  const zf = (x: number, y: number) => pl.z0 + pl.slope * ((x - pl.px) * pl.tx + (y - pl.py) * pl.ty);
  const top = (x: number, y: number) => zf(x, y) + SLAB;
  const underground = isUnder(def, g);
  geo.lit = underground;
  const main = g.kerbs.reduce<KerbChain | null>((a, k) => (!a || k.len > a.len ? k : a), null);
  if (main) {
    const s0 = at(main, 0);
    geo.frame(s0.x, s0.y, s0.tx, s0.ty);
  } else geo.frame(g.outline[0], g.outline[1], 1, 0);

  // Elevated? (slab well above the terrain under most of it)
  const ring = g.outline;
  const n = ring.length / 2;
  let high = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const x = ring[2 * i];
    const y = ring[2 * i + 1];
    cnt++;
    if (zf(x, y) - c.heights.ground(x, y) > 1.6) high++;
  }
  const elevated = !underground && cnt > 0 && high / cnt > 0.6;
  const bottomAt = (x: number, y: number) => (elevated ? top(x, y) - 1.25 : zf(x, y) - 0.6);

  // --- slab: paved top, kerb faces, deck fascia
  const contour = [] as THREE.Vector2[];
  for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(ring[2 * i], ring[2 * i + 1]));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  geo.paint(def.paving, Pat.Tiles, def.tile);
  const tv: number[] = [];
  for (let i = 0; i < n; i++) tv.push(geo.vert(ring[2 * i], top(ring[2 * i], ring[2 * i + 1]), ring[2 * i + 1]));
  for (const t of tris) geo.tri(tv[t[0]], tv[t[1]], tv[t[2]], 0, 1, 0);
  if (elevated) {
    geo.paint(CONCRETE_DARK);
    const bv: number[] = [];
    for (let i = 0; i < n; i++) bv.push(geo.vert(ring[2 * i], bottomAt(ring[2 * i], ring[2 * i + 1]), ring[2 * i + 1]));
    for (const t of tris) geo.tri(bv[t[0]], bv[t[1]], bv[t[2]], 0, -1, 0);
  }
  geo.paint(elevated ? CONCRETE : 0xc4c0b6);
  const ccw = (() => {
    let a = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      a += ring[2 * i] * ring[2 * j + 1] - ring[2 * j] * ring[2 * i + 1];
    }
    return a > 0;
  })();
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[2 * i];
    const ay = ring[2 * i + 1];
    const bx = ring[2 * j];
    const by = ring[2 * j + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.01) continue;
    const ox = ccw ? (by - ay) / len : -(by - ay) / len;
    const oy = ccw ? -(bx - ax) / len : (bx - ax) / len;
    geo.face(
      [
        [ax, ay, bottomAt(ax, ay)],
        [bx, by, bottomAt(bx, by)],
        [bx, by, top(bx, by)],
        [ax, ay, top(ax, ay)],
      ],
      ox,
      oy,
      0,
    );
  }

  // --- edges: kerb band, tactile and yellow line along every kerb; road edge line
  const lift = 0.012;
  const strip = (k: KerbChain, o0: number, o1: number, col: number, pat = Pat.None, size = 1) => {
    geo.paint(col, pat, size);
    const ss = samples(k, 2);
    for (let i = 0; i + 1 < ss.length; i++) {
      const a = ss[i];
      const e = ss[i + 1];
      geo.face(
        [
          [a.x + a.nx * o0, a.y + a.ny * o0, top(a.x, a.y) + lift],
          [e.x + e.nx * o0, e.y + e.ny * o0, top(e.x, e.y) + lift],
          [e.x + e.nx * o1, e.y + e.ny * o1, top(e.x, e.y) + lift],
          [a.x + a.nx * o1, a.y + a.ny * o1, top(a.x, a.y) + lift],
        ],
        0,
        0,
        1,
      );
    }
  };
  for (const k of g.kerbs) {
    strip(k, 0, 0.3, KERB_BAND);
    if (def.tactile === 'yellow') strip(k, 0.3, 0.9, YELLOW_TACTILE, Pat.Tactile);
    else {
      strip(k, 0.3, 0.9, TACTILE, Pat.Tactile);
      strip(k, 0.9, 1.0, YELLOW);
    }
    // white line on the road along the kerb
    const ss = samples(k, 2);
    for (let i = 0; i + 1 < ss.length; i++) {
      const a = ss[i];
      const e = ss[i + 1];
      const h = 0.05;
      const pa0 = [a.x - a.nx * 0.2, a.y - a.ny * 0.2];
      const pa1 = [a.x - a.nx * 0.32, a.y - a.ny * 0.32];
      const pe0 = [e.x - e.nx * 0.2, e.y - e.ny * 0.2];
      const pe1 = [e.x - e.nx * 0.32, e.y - e.ny * 0.32];
      const za = zf(a.x, a.y) + h;
      const ze = zf(e.x, e.y) + h;
      c.lines.push(pa0[0], za, -pa0[1], pe0[0], ze, -pe0[1], pe1[0], ze, -pe1[1], pa0[0], za, -pa0[1], pe1[0], ze, -pe1[1], pa1[0], za, -pa1[1]);
    }
  }

  // --- elevated deck: columns under the kerb and back lines, glass balustrade on the back
  if (elevated) {
    for (const k of g.kerbs) {
      for (const s of samples(k, 10, 2, Math.max(2.1, k.len - 2))) {
        const depth = Math.min(rayRing(ring, s.x + s.nx * 0.05, s.y + s.ny * 0.05, s.nx, s.ny, 25), 20);
        for (const off of [0.8, Math.max(1.6, depth - 0.8)]) {
          const px = s.x + s.nx * off;
          const py = s.y + s.ny * off;
          const zt = bottomAt(px, py);
          const gz = c.heights.ground(px, py);
          if (zt - gz < 1) continue;
          // not in a street or busway underneath
          const under = c.idx.nearest(px, py, 12, undefined, 0, undefined, gz, 3);
          if (under && under.dist < c.data.roads[under.road].width / 2 + 0.8) continue;
          geo.paint(CONCRETE);
          geo.cylinder(px, py, gz - 1.5, zt, 0.42, 10, false);
          geo.paint(CONCRETE_DARK);
          geo.box(px, py, zt - 0.05, zt + 0.02, s.tx, s.ty, 0.7, 0.7, true);
        }
      }
    }
    for (let i = 0; i + 3 < g.back.length; i += 4) {
      const ax = g.back[i];
      const ay = g.back[i + 1];
      const bx = g.back[i + 2];
      const by = g.back[i + 3];
      glass.paint(def.glass);
      glass.face(
        [
          [ax, ay, top(ax, ay) + 0.1],
          [bx, by, top(bx, by) + 0.1],
          [bx, by, top(bx, by) + 1.1],
          [ax, ay, top(ax, ay) + 1.1],
        ],
        0,
        0,
        0,
      );
      geo.paint(STEEL_DARK);
      geo.beam([ax, ay, top(ax, ay) + 1.12], [bx, by, top(bx, by) + 1.12], 0.04);
    }
  }

  if (underground) {
    buildUndergroundPlatform(c, b, g, top);
    geo.lit = false;
    return;
  }

  // --- canopy, posts and rear screens along each kerb
  const vault = def.roof === 'vault';
  const covered = g.covered && def.roof !== 'none';
  const H = def.canopyH ?? 4.2;
  const D = def.canopyDepth ?? 4.6;
  const SH = Math.min(def.screenH ?? 2.45, H - 0.05);
  const num = platformNumber(c, g);
  for (const k of g.kerbs) {
    if (k.len < 6) continue;
    const ss = samples(k, 3);
    // canopy depth at each sample: platform depth (to the outline), capped
    const depth = ss.map((s) => {
      const d = rayRing(ring, s.x + s.nx * 0.05, s.y + s.ny * 0.05, s.nx, s.ny, 30);
      return Number.isFinite(d) ? d : 3.5;
    });
    const back = depth.map((d) => Math.max(1.6, Math.min(d - 0.25, D)));
    const front = 0.45;
    if (covered && !vault) (def.canopy === 'wing' ? wingCanopy : canopy)(geo, def, ss, back, front, top, H);
    // posts on the back line every ~9 m; screens between them
    const postAt: Sample[] = [];
    const np = Math.max(2, Math.round((k.len - 3) / 9) + 1);
    for (let i = 0; i < np; i++) postAt.push(at(k, 1.5 + ((k.len - 3) * i) / (np - 1)));
    const backAt = (s: Sample) => {
      const d = rayRing(ring, s.x + s.nx * 0.05, s.y + s.ny * 0.05, s.nx, s.ny, 30);
      return Math.max(1.6, Math.min((Number.isFinite(d) ? d : 3.5) - 0.25, D)) - 0.35;
    };
    if (covered && !vault) {
      geo.paint(def.post);
      for (const s of postAt) {
        const o = backAt(s);
        const px = s.x + s.nx * o;
        const py = s.y + s.ny * o;
        geo.box(px, py, top(px, py), top(px, py) + H + 0.05, s.tx, s.ty, 0.13, 0.13);
      }
    }
    // glazed rear screens (with a few gaps), ad panels, benches and bins
    if (covered || vault) {
      for (let i = 0; i + 1 < postAt.length; i++) {
        if (i % 4 === 3 && postAt.length > 3) continue;
        const a = postAt[i];
        const e = postAt[i + 1];
        const oa = backAt(a) + 0.05;
        const oe = backAt(e) + 0.05;
        const ax = a.x + a.nx * oa;
        const ay = a.y + a.ny * oa;
        const ex = e.x + e.nx * oe;
        const ey = e.y + e.ny * oe;
        glass.paint(def.glass);
        glass.face(
          [
            [ax, ay, top(ax, ay) + 0.12],
            [ex, ey, top(ex, ey) + 0.12],
            [ex, ey, top(ex, ey) + SH],
            [ax, ay, top(ax, ay) + SH],
          ],
          0,
          0,
          0,
        );
        geo.paint(def.post);
        geo.beam([ax, ay, top(ax, ay) + SH + 0.03], [ex, ey, top(ex, ey) + SH + 0.03], 0.04);
        geo.beam([ax, ay, top(ax, ay) + 0.1], [ex, ey, top(ex, ey) + 0.1], 0.03);
        // an advertising / timetable case every other bay
        if (i % 2 === 1) {
          const mx = (ax + ex) / 2;
          const my = (ay + ey) / 2;
          const tx = (ex - ax) / (Math.hypot(ex - ax, ey - ay) || 1);
          const ty = (ey - ay) / (Math.hypot(ex - ax, ey - ay) || 1);
          geo.paint(0x2a2c2f);
          geo.box(mx, my, top(mx, my) + 0.3, top(mx, my) + 2.2, tx, ty, 0.7, 0.07);
          geo.lamp();
          geo.face(
            [
              [mx - tx * 0.62 - ty * 0.08, my - ty * 0.62 + tx * 0.08, top(mx, my) + 0.4],
              [mx + tx * 0.62 - ty * 0.08, my + ty * 0.62 + tx * 0.08, top(mx, my) + 0.4],
              [mx + tx * 0.62 - ty * 0.08, my + ty * 0.62 + tx * 0.08, top(mx, my) + 2.1],
              [mx - tx * 0.62 - ty * 0.08, my - ty * 0.62 + tx * 0.08, top(mx, my) + 2.1],
            ],
            ty,
            -tx,
            0,
          );
        }
      }
    }
    // furniture along the platform
    for (let d = 5; d < k.len - 4; d += 15) {
      const s = at(k, d);
      const o = Math.max(1.4, backAt(s) - 0.6);
      if (o < 1.5) continue;
      bench(geo, s.x + s.nx * o, s.y + s.ny * o, top(s.x, s.y), s.tx, s.ty, -s.nx, -s.ny);
      if (Math.round(d / 15) % 2 === 1) {
        const bx = s.x + s.nx * o + s.tx * 1.6;
        const by = s.y + s.ny * o + s.ty * 1.6;
        geo.paint(0x8d9295, Pat.Louvre, 0.08);
        geo.cylinder(bx, by, top(bx, by), top(bx, by) + 0.95, 0.24, 8);
      }
    }
    // entry end (upstream): totem, validators, ticket machine; "Platform N" sign; PIDs; "Depart" flag
    const entry = at(k, Math.min(2.5, k.len / 3));
    const eo = Math.min(backAt(entry), 3.2);
    if (eo > 1.6) {
      const tx = entry.x + entry.nx * (eo - 0.3);
      const ty = entry.y + entry.ny * (eo - 0.3);
      totem(c, geo, def.name || '', tx, ty, top(tx, ty), -entry.tx, -entry.ty);
      const vx = entry.x + entry.nx * 1.7 + entry.tx * 2.2;
      const vy = entry.y + entry.ny * 1.7 + entry.ty * 2.2;
      validator(geo, vx, vy, top(vx, vy), entry.tx, entry.ty);
      validator(geo, vx + entry.tx * 1.2, vy + entry.ty * 1.2, top(vx, vy), entry.tx, entry.ty);
    }
    const hang = covered && !vault ? top(entry.x, entry.y) + H - 0.02 : 0;
    if (num) {
      const key = c.atlas.want({ kind: 'platform', text: num, sub: def.name ? `${def.name} station` : undefined });
      const s = at(k, Math.min(6, k.len * 0.25));
      const px = s.x + s.nx * 1.6;
      const py = s.y + s.ny * 1.6;
      const h = top(px, py) + 3.05;
      if (hang) {
        geo.paint(STEEL_DARK);
        geo.box(px, py, h + 0.25, top(px, py) + H, s.tx, s.ty, 0.02, 0.4);
      } else {
        geo.paint(STEEL_DARK);
        geo.cylinder(px + s.nx * 0.9, py + s.ny * 0.9, top(px, py), h + 0.3, 0.05, 6);
      }
      geo.paint(ORANGE_HEX);
      geo.box(px, py, h - 0.27, h + 0.27, s.nx, s.ny, 0.78, 0.05);
      geo.deferSign(c.atlas, key, px, py, h, -s.tx, -s.ty, 1.5, 0.5, 0.06);
    }
    if (covered || vault) {
      for (let d = 12; d < k.len - 8; d += 25) {
        const s = at(k, d);
        const px = s.x + s.nx * 1.9;
        const py = s.y + s.ny * 1.9;
        const h = top(px, py) + 2.75;
        geo.paint(0x0f1012);
        geo.box(px, py, h - 0.2, h + 0.2, s.nx, s.ny, 0.08, 0.72);
        if (!vault) {
          geo.paint(STEEL_DARK);
          geo.box(px, py, h + 0.2, top(px, py) + H, s.tx, s.ty, 0.02, 0.02);
        }
        const key = c.atlas.want({ kind: 'pid', text: pidText(c, def) });
        geo.deferSign(c.atlas, key, px, py, h, -s.tx, -s.ty, 1.36, 0.34, 0.085);
      }
    }
    {
      // lead stop "Depart" sign at the downstream end
      const s = at(k, Math.max(0, k.len - 2.5));
      const px = s.x + s.nx * 0.9;
      const py = s.y + s.ny * 0.9;
      const h = top(px, py) + 2.75;
      geo.paint(STEEL_DARK);
      if (hang) geo.box(px, py, h + 0.3, top(px, py) + H, s.tx, s.ty, 0.015, 0.015);
      else geo.cylinder(px + s.nx * 0.25, py + s.ny * 0.25, top(px, py), h + 0.35, 0.045, 6);
      const key = c.atlas.want({ kind: 'depart', text: 'Depart' });
      geo.paint(ORANGE_HEX);
      geo.box(px, py, h - 0.31, h + 0.31, s.nx, s.ny, 0.25, 0.025);
      geo.deferSign(c.atlas, key, px, py, h, -s.tx, -s.ty, 0.5, 0.62, 0.03);
    }
    // lettered stops on surface platforms (UQ Lakes): blue stop totems
    for (const st of stopsAt(c, g, zf)) {
      if (st.k !== k) continue;
      const s = at(k, st.d);
      const px = s.x + s.nx * 1.3;
      const py = s.y + s.ny * 1.3;
      geo.paint(0x1f5aa6);
      geo.box(px, py, top(px, py), top(px, py) + 2.6, s.tx, s.ty, 0.09, 0.22);
      const key = c.atlas.want({ kind: 'stop', text: st.code, sub: 'blue' });
      geo.deferSign(c.atlas, key, px, py, top(px, py) + 2.1, -s.tx, -s.ty, 0.42, 0.3, 0.1);
    }
  }
  // South Bank: blue steel frame with aluminium louvres along the back of the platform
  if (def.louvres) {
    for (let i = 0; i + 3 < g.back.length; i += 4) {
      const ax = g.back[i];
      const ay = g.back[i + 1];
      const bx = g.back[i + 2];
      const by = g.back[i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 8) continue;
      const tx = (bx - ax) / len;
      const ty = (by - ay) / len;
      geo.paint(def.louvres, Pat.Louvre, 0.16);
      geo.panel(
        [
          [ax, ay, top(ax, ay) + 2.5],
          [bx, by, top(bx, by) + 2.5],
          [bx, by, top(bx, by) + 6.2],
          [ax, ay, top(ax, ay) + 6.2],
        ],
        -ty,
        tx,
        0,
      );
      geo.paint(def.post);
      for (let d = 0; d <= len + 0.01; d += len / Math.max(1, Math.round(len / 4.5))) {
        const px = ax + tx * d;
        const py = ay + ty * d;
        geo.box(px, py, top(px, py), top(px, py) + 6.4, tx, ty, 0.14, 0.14);
      }
      geo.beam([ax, ay, top(ax, ay) + 6.3], [bx, by, top(bx, by) + 6.3], 0.12);
    }
  }
}

const ORANGE_HEX = 0xe8552b;

function pidText(c: Ctx, def: StationDef): string {
  void c;
  if (def.key === 'kgs' || def.key === 'cc' || def.key === 'southbank') return 'M1 Eight Mile Plains|M2 UQ Lakes|222 Carindale';
  if (def.key === 'roma' || def.key === 'normanby' || def.key === 'qutkg' || def.key === 'herston' || def.key === 'rbwh') return 'M2 RBWH|M1 Roma St|330 Bracken Ridge';
  return 'M2 UQ Lakes|66 RBWH|222 Carindale';
}

/** The flat cantilevered canopy over a kerb strip. */
function canopy(geo: SGeo, def: StationDef, ss: Sample[], back: number[], front: number, top: (x: number, y: number) => number, H: number): void {
  const T = 0.45;
  const F = (i: number): V3 => [ss[i].x + ss[i].nx * front, ss[i].y + ss[i].ny * front, 0];
  const B = (i: number): V3 => [ss[i].x + ss[i].nx * back[i], ss[i].y + ss[i].ny * back[i], 0];
  const hU = (p: V3) => top(p[0], p[1]) + H;
  for (let i = 0; i + 1 < ss.length; i++) {
    const f0 = F(i);
    const f1 = F(i + 1);
    const b0 = B(i);
    const b1 = B(i + 1);
    // top
    geo.paint(def.panels ? def.panels[(i >> 1) % def.panels.length] : def.roofTop);
    geo.face(
      [
        [f0[0], f0[1], hU(f0) + T],
        [f1[0], f1[1], hU(f1) + T],
        [b1[0], b1[1], hU(b1) + T],
        [b0[0], b0[1], hU(b0) + T],
      ],
      0,
      0,
      1,
    );
    // soffit
    geo.paint(def.panels ? mixCol(def.panels[(i >> 1) % def.panels.length], def.soffit, 0.5) : def.soffit, Pat.Soffit, 1.2);
    geo.face(
      [
        [f0[0], f0[1], hU(f0)],
        [f1[0], f1[1], hU(f1)],
        [b1[0], b1[1], hU(b1)],
        [b0[0], b0[1], hU(b0)],
      ],
      0,
      0,
      -1,
    );
    // fascia front and back
    geo.paint(def.fascia);
    const tx = ss[i + 1].x - ss[i].x;
    const ty = ss[i + 1].y - ss[i].y;
    geo.face(
      [
        [f0[0], f0[1], hU(f0) - 0.06],
        [f1[0], f1[1], hU(f1) - 0.06],
        [f1[0], f1[1], hU(f1) + T],
        [f0[0], f0[1], hU(f0) + T],
      ],
      ty,
      -tx,
      0,
    );
    geo.face(
      [
        [b0[0], b0[1], hU(b0)],
        [b1[0], b1[1], hU(b1)],
        [b1[0], b1[1], hU(b1) + T],
        [b0[0], b0[1], hU(b0) + T],
      ],
      -ty,
      tx,
      0,
    );
    // downlights, two rows
    geo.lamp();
    for (const o of [1.2, Math.max(1.5, back[i] - 1.1)]) {
      const s = ss[i];
      const px = s.x + s.nx * o;
      const py = s.y + s.ny * o;
      const h = top(px, py) + H - 0.012;
      const r = 0.16;
      geo.face(
        [
          [px - s.tx * r - s.nx * r, py - s.ty * r - s.ny * r, h],
          [px + s.tx * r - s.nx * r, py + s.ty * r - s.ny * r, h],
          [px + s.tx * r + s.nx * r, py + s.ty * r + s.ny * r, h],
          [px - s.tx * r + s.nx * r, py - s.ty * r + s.ny * r, h],
        ],
        0,
        0,
        -1,
      );
    }
  }
  // end caps
  geo.paint(def.fascia);
  for (const i of [0, ss.length - 1]) {
    const f = F(i);
    const bb = B(i);
    const s = ss[i];
    const sgn = i === 0 ? -1 : 1;
    geo.face(
      [
        [f[0], f[1], hU(f) - 0.06],
        [bb[0], bb[1], hU(bb)],
        [bb[0], bb[1], hU(bb) + T],
        [f[0], f[1], hU(f) + T],
      ],
      s.tx * sgn,
      s.ty * sgn,
      0,
    );
  }
  // transverse beams under the soffit every ~6 m
  geo.paint(def.fascia);
  const step = Math.max(1, Math.round(6 / 3));
  for (let i = 0; i < ss.length; i += step) {
    const s = ss[i];
    const f = F(i);
    const bb = B(i);
    const hf = hU(f) - 0.17;
    const hb = hU(bb) - 0.17;
    geo.beam([bb[0] - s.nx * 0.1, bb[1] - s.ny * 0.1, hb], [f[0] + s.nx * 0.3, f[1] + s.ny * 0.3, hf], 0.12, true);
  }
}

/**
 * Dutton Park Place's "wing": a blade carried on the back row of posts, its panelled soffit curving up
 * towards the kerb and its top a stack of dark fins stepping down to a knife edge at the front.
 */
function wingCanopy(geo: SGeo, def: StationDef, ss: Sample[], back: number[], front: number, top: (x: number, y: number) => number, H: number): void {
  const WR = 1.4; // soffit rise at the front edge
  const N = 4; // strips across the depth, back (u 0) to front (u 1)
  const P = (i: number, u: number): [number, number] => {
    const o = back[i] + (front - back[i]) * u;
    return [ss[i].x + ss[i].nx * o, ss[i].y + ss[i].ny * o];
  };
  const hs = (u: number) => H + WR * u * u;
  const ht = (u: number) => hs(u) + 0.18 + 0.6 * (1 - u);
  const fin = mixCol(def.roofTop, 0x000000, 0.3);
  for (let i = 0; i + 1 < ss.length; i++) {
    const tx = ss[i + 1].x - ss[i].x;
    const ty = ss[i + 1].y - ss[i].y;
    for (let j = 0; j < N; j++) {
      const u0 = j / N;
      const u1 = (j + 1) / N;
      const a0 = P(i, u0);
      const a1 = P(i + 1, u0);
      const b0 = P(i, u1);
      const b1 = P(i + 1, u1);
      const z = (p: [number, number], h: number): V3 => [p[0], p[1], top(p[0], p[1]) + h];
      geo.paint(def.soffit, Pat.Soffit, 1.5);
      geo.face([z(a0, hs(u0)), z(a1, hs(u0)), z(b1, hs(u1)), z(b0, hs(u1))], 0, 0, -1);
      // top, with a dark fin standing up along each strip's back edge (the stacked look from the side)
      geo.paint(def.roofTop);
      geo.face([z(a0, ht(u0)), z(a1, ht(u0)), z(b1, ht(u1)), z(b0, ht(u1))], 0, 0, 1);
      if (j > 0) {
        geo.paint(fin);
        geo.face([z(a0, ht(u0)), z(a1, ht(u0)), z(a1, ht(u0) + 0.3), z(a0, ht(u0) + 0.3)], ty, -tx, 0);
      }
    }
    // knife edge at the front
    geo.paint(fin);
    const f0 = P(i, 1);
    const f1 = P(i + 1, 1);
    geo.face(
      [
        [f0[0], f0[1], top(f0[0], f0[1]) + hs(1)],
        [f1[0], f1[1], top(f1[0], f1[1]) + hs(1)],
        [f1[0], f1[1], top(f1[0], f1[1]) + ht(1)],
        [f0[0], f0[1], top(f0[0], f0[1]) + ht(1)],
      ],
      ty,
      -tx,
      0,
    );
    // back edge over the posts
    geo.paint(def.fascia);
    const a0 = P(i, 0);
    const a1 = P(i + 1, 0);
    const za0 = top(a0[0], a0[1]);
    const za1 = top(a1[0], a1[1]);
    geo.face(
      [
        [a0[0], a0[1], za0 + hs(0)],
        [a1[0], a1[1], za1 + hs(0)],
        [a1[0], a1[1], za1 + ht(0)],
        [a0[0], a0[1], za0 + ht(0)],
      ],
      -ty,
      tx,
      0,
    );
  }
  // end caps: the blade's profile
  geo.paint(def.fascia);
  for (const i of [0, ss.length - 1]) {
    const sgn = i === 0 ? -1 : 1;
    for (let j = 0; j < N; j++) {
      const u0 = j / N;
      const u1 = (j + 1) / N;
      const a = P(i, u0);
      const e = P(i, u1);
      const za = top(a[0], a[1]);
      const ze = top(e[0], e[1]);
      geo.face(
        [
          [a[0], a[1], za + hs(u0)],
          [e[0], e[1], ze + hs(u1)],
          [e[0], e[1], ze + ht(u1)],
          [a[0], a[1], za + ht(u0)],
        ],
        ss[i].tx * sgn,
        ss[i].ty * sgn,
        0,
      );
    }
  }
}

function mixCol(a: number, b: number, t: number): number {
  const r = ((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t;
  const g = ((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t;
  const bl = (a & 255) * (1 - t) + (b & 255) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

/** Slatted metal bench pair facing (fx, fy). */
function bench(geo: SGeo, x: number, y: number, h: number, tx: number, ty: number, fx: number, fy: number): void {
  for (const o of [-1.0, 1.0]) {
    const cx = x + tx * o;
    const cy = y + ty * o;
    geo.paint(BENCH, Pat.Louvre, 0.07);
    geo.box(cx, cy, h + 0.42, h + 0.47, tx, ty, 0.88, 0.22);
    geo.box(cx - fx * 0.22, cy - fy * 0.22, h + 0.5, h + 0.85, tx, ty, 0.88, 0.025);
    geo.paint(0x55595d);
    for (const l of [-0.75, 0.75]) geo.box(cx + tx * l, cy + ty * l, h, h + 0.42, tx, ty, 0.03, 0.2);
  }
}

/** Go card validator post. */
function validator(geo: SGeo, x: number, y: number, h: number, tx: number, ty: number): void {
  geo.paint(0x3a3d41);
  geo.box(x, y, h, h + 1.25, tx, ty, 0.11, 0.09);
  geo.paint(0x1d5fb0);
  geo.box(x, y, h + 1.0, h + 1.3, tx, ty, 0.13, 0.1);
  geo.lamp();
  geo.face(
    [
      [x - tx * 0.08 - ty * 0.105, y - ty * 0.08 + tx * 0.105, h + 1.1],
      [x + tx * 0.08 - ty * 0.105, y + ty * 0.08 + tx * 0.105, h + 1.1],
      [x + tx * 0.08 - ty * 0.105, y + ty * 0.08 + tx * 0.105, h + 1.24],
      [x - tx * 0.08 - ty * 0.105, y - ty * 0.08 + tx * 0.105, h + 1.24],
    ],
    -ty,
    tx,
    0,
  );
}

/** Station-name totem: black, orange top band, facing (fx, fy). */
function totem(c: Ctx, geo: SGeo, name: string, x: number, y: number, h: number, fx: number, fy: number): void {
  geo.paint(0x1e1f21);
  geo.box(x, y, h, h + 2.45, -fy, fx, 0.27, 0.07);
  if (!name) return;
  const key = c.atlas.want({ kind: 'totem', text: name });
  geo.deferSign(c.atlas, key, x, y, h + 1.25, fx, fy, 0.5, 2.0, 0.075);
}

// ---------------------------------------------------------------------------
// Underground platforms (KGS, Queen St): glass screen wall with doors and stop pods,
// a low waiting-hall ceiling with linear lights, terracotta-tiled back wall.

function buildUndergroundPlatform(c: Ctx, b: StationBuild, g: PlatformGeom, top: (x: number, y: number) => number): void {
  const def = b.def;
  const geo = b.geo;
  const glass = b.glass;
  const kgs = def.key === 'kgs';
  const HH = kgs ? 3.3 : 2.9;
  const ring = g.outline;
  const zf = (x: number, y: number) => top(x, y) - SLAB;
  const stops = stopsAt(c, g, zf);
  for (const k of g.kerbs) {
    if (k.len < 6) continue;
    const ss = samples(k, 2.5);
    const o = 1.25;
    // the glass wall, broken by door openings at each stop
    const doors = stops.filter((s) => s.k === k).map((s) => s.d);
    for (let i = 0; i + 1 < ss.length; i++) {
      const a = ss[i];
      const e = ss[i + 1];
      const ax = a.x + a.nx * o;
      const ay = a.y + a.ny * o;
      const ex = e.x + e.nx * o;
      const ey = e.y + e.ny * o;
      const nearDoor = doors.some((d) => Math.abs((a.d + e.d) / 2 - d) < 2.2);
      glass.paint(nearDoor ? 0x8fa6aa : def.glass);
      glass.face(
        [
          [ax, ay, top(ax, ay) + 0.05],
          [ex, ey, top(ex, ey) + 0.05],
          [ex, ey, top(ex, ey) + 2.7],
          [ax, ay, top(ax, ay) + 2.7],
        ],
        0,
        0,
        0,
      );
      geo.paint(STAINLESS);
      geo.box(ax, ay, top(ax, ay), top(ax, ay) + 2.7, a.tx, a.ty, 0.035, 0.05);
      // bulkhead over the glass up to the hall ceiling
      geo.paint(kgs ? 0xd9d9d4 : 0x9a9488);
      geo.face(
        [
          [ax, ay, top(ax, ay) + 2.7],
          [ex, ey, top(ex, ey) + 2.7],
          [ex, ey, top(ex, ey) + HH],
          [ax, ay, top(ax, ay) + HH],
        ],
        -a.nx,
        -a.ny,
        0,
      );
      geo.beam([ax, ay, top(ax, ay) + 2.72], [ex, ey, top(ex, ey) + 2.72], 0.05);
    }
    // stop pods (KGS) or door frames (Queen St) with orange "Stop 1c" signs
    for (const st of stops) {
      if (st.k !== k) continue;
      const s = at(k, st.d);
      const px = s.x + s.nx * o;
      const py = s.y + s.ny * o;
      const key = c.atlas.want({ kind: 'stop', text: st.code });
      if (kgs) {
        for (const side of [-1, 1]) {
          const qx = px + s.tx * side * 1.6;
          const qy = py + s.ty * side * 1.6;
          geo.paint(STAINLESS);
          geo.cylinder(qx, qy, top(qx, qy), top(qx, qy) + 2.7, 0.38, 12);
          geo.paint(ORANGE_HEX);
          geo.box(qx - s.nx * 0.39, qy - s.ny * 0.39, top(qx, qy) + 1.95, top(qx, qy) + 2.45, s.tx, s.ty, 0.36, 0.02);
          geo.deferSign(c.atlas, key, qx - s.nx * 0.42, qy - s.ny * 0.42, top(qx, qy) + 2.2, -s.nx, -s.ny, 0.7, 0.49, 0, false);
        }
      } else {
        geo.paint(0x2a2b2d);
        for (const side of [-1, 1]) geo.box(px + s.tx * side * 1.1, py + s.ty * side * 1.1, top(px, py), top(px, py) + 2.7, s.tx, s.ty, 0.08, 0.1);
        geo.paint(ORANGE_HEX);
        geo.box(px - s.nx * 0.12, py - s.ny * 0.12, top(px, py) + 2.25, top(px, py) + 2.65, s.tx, s.ty, 0.5, 0.02);
        geo.deferSign(c.atlas, key, px - s.nx * 0.15, py - s.ny * 0.15, top(px, py) + 2.45, -s.nx, -s.ny, 0.56, 0.39, 0, false);
      }
      // hanging sign facing along the platform for the approaching driver
      geo.paint(ORANGE_HEX);
      const hx = px - s.nx * 0.6;
      const hy = py - s.ny * 0.6;
      geo.deferSign(c.atlas, key, hx, hy, top(hx, hy) + 3.05, -s.tx, -s.ty, 0.6, 0.42, 0);
      geo.paint(STEEL_DARK);
      geo.box(hx, hy, top(hx, hy) + 3.26, top(hx, hy) + HH + 1.2, s.tx, s.ty, 0.015, 0.015);
    }
    // benches behind the glass
    for (let d = 6; d < k.len - 4; d += 14) {
      const s = at(k, d);
      const depth = rayRing(ring, s.x + s.nx * 0.05, s.y + s.ny * 0.05, s.nx, s.ny, 30);
      const off = Math.min(Number.isFinite(depth) ? depth - 0.6 : 3, 3.2);
      if (off < 2.2) continue;
      bench(geo, s.x + s.nx * off, s.y + s.ny * off, top(s.x, s.y), s.tx, s.ty, -s.nx, -s.ny);
    }
  }
  // waiting hall ceiling with linear lights over the whole platform
  const n = ring.length / 2;
  const contour: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(ring[2 * i], ring[2 * i + 1]));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  geo.paint(kgs ? 0xe6e6e2 : 0x8a8478, kgs ? Pat.Coffer : Pat.None, 0.5);
  const cv: number[] = [];
  for (let i = 0; i < n; i++) cv.push(geo.vert(ring[2 * i], top(ring[2 * i], ring[2 * i + 1]) + HH, ring[2 * i + 1]));
  for (const t of tris) geo.tri(cv[t[0]], cv[t[1]], cv[t[2]], 0, -1, 0);
  geo.lamp();
  for (const k of g.kerbs) {
    for (const o of kgs ? [2.0, 3.6] : [2.2]) {
      const ss = samples(k, 4);
      for (let i = 0; i + 1 < ss.length; i++) {
        const a = ss[i];
        const e = ss[i + 1];
        const da = rayRing(ring, a.x + a.nx * 0.05, a.y + a.ny * 0.05, a.nx, a.ny, 30);
        if (!(da > o + 0.4)) continue;
        const h = (p: Sample) => top(p.x, p.y) + HH - 0.015;
        geo.face(
          [
            [a.x + a.nx * o, a.y + a.ny * o, h(a)],
            [e.x + e.nx * o, e.y + e.ny * o, h(e)],
            [e.x + e.nx * (o + 0.12), e.y + e.ny * (o + 0.12), h(e)],
            [a.x + a.nx * (o + 0.12), a.y + a.ny * (o + 0.12), h(a)],
          ],
          0,
          0,
          -1,
        );
      }
    }
  }
  // tiled back wall (terracotta at KGS) along the back edges, inset from the hall wall
  for (let i = 0; i + 3 < g.back.length; i += 4) {
    const ax = g.back[i];
    const ay = g.back[i + 1];
    const bx = g.back[i + 2];
    const by = g.back[i + 3];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 4) continue;
    // inward normal (towards the platform centroid)
    let nx = -(by - ay) / len;
    let ny = (bx - ax) / len;
    const cx = (g.x0 + g.x1) / 2;
    const cy = (g.y0 + g.y1) / 2;
    if ((cx - ax) * nx + (cy - ay) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const pa: [number, number] = [ax + nx * 0.15, ay + ny * 0.15];
    const pb: [number, number] = [bx + nx * 0.15, by + ny * 0.15];
    geo.paint(kgs ? TERRACOTTA : 0xb3a68c, Pat.Louvre, kgs ? 0.3 : 0.6);
    geo.face(
      [
        [pa[0], pa[1], top(pa[0], pa[1])],
        [pb[0], pb[1], top(pb[0], pb[1])],
        [pb[0], pb[1], top(pb[0], pb[1]) + HH],
        [pa[0], pa[1], top(pa[0], pa[1]) + HH],
      ],
      nx,
      ny,
      0,
    );
  }
}

// ---------------------------------------------------------------------------
// Median fence (and lights) between facing platforms

function buildMedian(c: Ctx, b: StationBuild): void {
  const def = b.def;
  if (!def.median) return;
  const geo = b.geo;
  const glass = b.glass;
  const chains: { k: KerbChain; g: PlatformGeom }[] = [];
  for (const g of b.plats) if (!isUnder(def, g)) for (const k of g.kerbs) chains.push({ k, g });
  const done = new Set<string>();
  for (let i = 0; i < chains.length; i++) {
    for (let j = 0; j < chains.length; j++) {
      if (i === j || chains[i].g === chains[j].g) continue;
      const A = chains[i].k;
      const B = chains[j].k;
      if (A.outX * B.outX + A.outY * B.outY > -0.7) continue;
      const pair = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (done.has(pair)) continue;
      done.add(pair);
      // midline points between the two kerbs
      const pts: { x: number; y: number; z: number; tx: number; ty: number }[] = [];
      for (let d = -12; d <= A.len + 12; d += 2.5) {
        const s = at(A, Math.max(0, Math.min(A.len, d)));
        const ex = d < 0 ? d : d > A.len ? d - A.len : 0;
        const ax = s.x + s.tx * ex;
        const ay = s.y + s.ty * ex;
        // across to B along the outward normal
        let best = Infinity;
        let bx = 0;
        let by = 0;
        for (let e = 0; e <= B.len; e += 1) {
          const q = at(B, e);
          const dx = q.x - ax;
          const dy = q.y - ay;
          const along = dx * s.tx + dy * s.ty;
          if (Math.abs(along) > 1.5) continue;
          const across = -(dx * s.nx + dy * s.ny);
          if (across > 8 && across < 22 && across < best) {
            best = across;
            bx = q.x;
            by = q.y;
          }
        }
        if (!Number.isFinite(best)) {
          if (d < 0 || d > A.len) {
            // beyond the platform ends: continue along the last midline direction
            const last = pts[pts.length - 1];
            if (last && d > A.len) pts.push({ x: last.x + last.tx * 2.5, y: last.y + last.ty * 2.5, z: last.z, tx: last.tx, ty: last.ty });
          }
          continue;
        }
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const hit = c.idx.nearest(mx, my, 4, undefined, 0, isBus);
        if (!hit) continue;
        // the busway's centreline must be under the fence (never across a lane)
        if (hit.dist > 1.4) continue;
        pts.push({ x: mx, y: my, z: hit.z, tx: s.tx, ty: s.ty });
      }
      if (pts.length < 4) continue;
      fenceRun(c, geo, glass, def, pts);
    }
  }
}

function fenceRun(c: Ctx, geo: SGeo, glass: SGeo, def: StationDef, pts: { x: number; y: number; z: number; tx: number; ty: number }[]): void {
  void c;
  // split into continuous runs (gaps > 4 m)
  const runs: (typeof pts)[] = [[]];
  for (const p of pts) {
    const r = runs[runs.length - 1];
    const q = r[r.length - 1];
    if (q && Math.hypot(p.x - q.x, p.y - q.y) > 4) runs.push([p]);
    else r.push(p);
  }
  for (const r of runs) {
    if (r.length < 3) continue;
    for (let i = 0; i + 1 < r.length; i++) {
      const a = r[i];
      const e = r[i + 1];
      const nx = -(e.y - a.y);
      const ny = e.x - a.x;
      const nl = Math.hypot(nx, ny) || 1;
      const ux = nx / nl;
      const uy = ny / nl;
      if (def.median === 'barrier') {
        // tall concrete median barrier (Roma St)
        geo.paint(0xb9b5ac);
        for (const s of [1, -1]) {
          geo.face(
            [
              [a.x + ux * s * 0.4, a.y + uy * s * 0.4, a.z],
              [e.x + ux * s * 0.4, e.y + uy * s * 0.4, e.z],
              [e.x + ux * s * 0.2, e.y + uy * s * 0.2, e.z + 1.15],
              [a.x + ux * s * 0.2, a.y + uy * s * 0.2, a.z + 1.15],
            ],
            ux * s,
            uy * s,
            0.3,
          );
        }
        geo.face(
          [
            [a.x + ux * 0.2, a.y + uy * 0.2, a.z + 1.15],
            [e.x + ux * 0.2, e.y + uy * 0.2, e.z + 1.15],
            [e.x - ux * 0.2, e.y - uy * 0.2, e.z + 1.15],
            [a.x - ux * 0.2, a.y - uy * 0.2, a.z + 1.15],
          ],
          0,
          0,
          1,
        );
        continue;
      }
      // raised kerb
      geo.paint(0xbdb9b0);
      geo.face(
        [
          [a.x + ux * 0.4, a.y + uy * 0.4, a.z + 0.18],
          [e.x + ux * 0.4, e.y + uy * 0.4, e.z + 0.18],
          [e.x - ux * 0.4, e.y - uy * 0.4, e.z + 0.18],
          [a.x - ux * 0.4, a.y - uy * 0.4, a.z + 0.18],
        ],
        0,
        0,
        1,
      );
      for (const s of [1, -1]) {
        geo.face(
          [
            [a.x + ux * s * 0.4, a.y + uy * s * 0.4, a.z - 0.05],
            [e.x + ux * s * 0.4, e.y + uy * s * 0.4, e.z - 0.05],
            [e.x + ux * s * 0.4, e.y + uy * s * 0.4, e.z + 0.18],
            [a.x + ux * s * 0.4, a.y + uy * s * 0.4, a.z + 0.18],
          ],
          ux * s,
          uy * s,
          0,
        );
      }
      // black palisade: post, two rails, dark see-through infill
      geo.paint(0x16171a);
      geo.box(a.x, a.y, a.z + 0.18, a.z + 1.35, e.x - a.x, e.y - a.y, 0.04, 0.04);
      geo.beam([a.x, a.y, a.z + 1.3], [e.x, e.y, e.z + 1.3], 0.03, false);
      geo.beam([a.x, a.y, a.z + 0.3], [e.x, e.y, e.z + 0.3], 0.025, false);
      glass.paint(0x1a1c1f);
      glass.face(
        [
          [a.x, a.y, a.z + 0.3],
          [e.x, e.y, e.z + 0.3],
          [e.x, e.y, e.z + 1.28],
          [a.x, a.y, a.z + 1.28],
        ],
        0,
        0,
        0,
      );
      // twin-head light poles every ~25 m
      if (def.medianLights && i % 10 === 5) {
        geo.paint(0x1c1d20);
        geo.cylinder(a.x, a.y, a.z + 0.18, a.z + 9, 0.11, 8);
        const tx = e.x - a.x;
        const ty = e.y - a.y;
        const tl = Math.hypot(tx, ty) || 1;
        for (const s of [1, -1]) {
          const hx = a.x + ux * s * 1.7;
          const hy = a.y + uy * s * 1.7;
          geo.paint(0x1c1d20);
          geo.beam([a.x, a.y, a.z + 8.9], [hx, hy, a.z + 8.9], 0.05);
          geo.box(hx, hy, a.z + 8.75, a.z + 8.95, tx / tl, ty / tl, 0.35, 0.22, true);
          geo.lamp();
          geo.face(
            [
              [hx - (tx / tl) * 0.3 - ux * 0.18, hy - (ty / tl) * 0.3 - uy * 0.18, a.z + 8.74],
              [hx + (tx / tl) * 0.3 - ux * 0.18, hy + (ty / tl) * 0.3 - uy * 0.18, a.z + 8.74],
              [hx + (tx / tl) * 0.3 + ux * 0.18, hy + (ty / tl) * 0.3 + uy * 0.18, a.z + 8.74],
              [hx - (tx / tl) * 0.3 + ux * 0.18, hy - (ty / tl) * 0.3 + uy * 0.18, a.z + 8.74],
            ],
            0,
            0,
            -1,
          );
        }
      }
    }
    const l = r[r.length - 1];
    geo.paint(0x16171a);
    geo.box(l.x, l.y, l.z + 0.18, l.z + 1.35, l.tx, l.ty, 0.04, 0.04);
  }
}

// ---------------------------------------------------------------------------
// Landmarks

/** Busway level near a point (the nearest busway's surface), else the ground. */
function buswayZ(c: Ctx, x: number, y: number, r = 40): number {
  const hit = c.idx.nearest(x, y, r, undefined, 0, isBus);
  return hit ? hit.z : c.heights.ground(x, y);
}

/** True if a surface rail line runs within `r` m of (x, y) (no bridge piers on the tracks). */
function nearRail(c: Ctx, x: number, y: number, r: number): boolean {
  for (const l of c.data.rail) {
    if (l.tunnel) continue;
    const p = l.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i];
      const ay = p[i + 1];
      const dx = p[i + 2] - ax;
      const dy = p[i + 3] - ay;
      if (Math.min(ax, ax + dx) > x + r || Math.max(ax, ax + dx) < x - r || Math.min(ay, ay + dy) > y + r || Math.max(ay, ay + dy) < y - r) continue;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      if (Math.hypot(ax + dx * t - x, ay + dy * t - y) < r) return true;
    }
  }
  return false;
}

function buildOverbridge(c: Ctx, b: StationBuild, o: OverbridgeDef): void {
  const geo = b.geo;
  const glass = b.glass;
  let ax = o.ax ?? 0;
  let ay = o.ay ?? 0;
  const hit = c.idx.nearest(o.x, o.y, 40, undefined, 0, isBus);
  if (!o.ax && !o.ay) {
    if (!hit) return;
    ax = -hit.dy;
    ay = hit.dx;
  }
  const zb = hit ? hit.z : c.heights.ground(o.x, o.y);
  const deck = zb + (o.clear ?? 6.4);
  const [s0, s1] = o.len;
  const w = o.w / 2;
  const nx = -ay;
  const ny = ax;
  const P = (s: number, off: number): [number, number] => [o.x + ax * s + nx * off, o.y + ay * s + ny * off];
  // deck slab
  const a0 = P(s0, -w - 0.2);
  const a1 = P(s1, -w - 0.2);
  const b0 = P(s0, w + 0.2);
  const b1 = P(s1, w + 0.2);
  geo.paint(0xcac6bd, Pat.Tiles, 0.6);
  geo.face(
    [
      [a0[0], a0[1], deck],
      [a1[0], a1[1], deck],
      [b1[0], b1[1], deck],
      [b0[0], b0[1], deck],
    ],
    0,
    0,
    1,
  );
  geo.paint(CONCRETE);
  geo.box(o.x + ax * ((s0 + s1) / 2), o.y + ay * ((s0 + s1) / 2), deck - 0.9, deck - 0.01, ax, ay, (s1 - s0) / 2, w + 0.25, true);
  // glazed sides (a tube, or balustrades on an open deck) with frame posts, roof
  const roofH = deck + (o.open ? 4.6 : 3.1);
  const sideH = o.open ? deck + 1.15 : roofH - 0.05;
  const len = s1 - s0;
  const nposts = Math.max(2, Math.round(len / 3));
  const [r0, r1] = o.roofLen ?? [s0 - 0.6, s1 + 0.6];
  for (const side of [-1, 1]) {
    const p0 = P(s0, side * w);
    const p1 = P(s1, side * w);
    glass.paint(o.glass);
    glass.face(
      [
        [p0[0], p0[1], deck + 0.05],
        [p1[0], p1[1], deck + 0.05],
        [p1[0], p1[1], sideH],
        [p0[0], p0[1], sideH],
      ],
      0,
      0,
      0,
    );
    geo.paint(o.frame);
    for (let i = 0; i <= nposts; i++) {
      const s = s0 + (len * i) / nposts;
      const p = P(s, side * w);
      geo.box(p[0], p[1], deck, sideH, ax, ay, 0.06, 0.06);
    }
    geo.beam([p0[0], p0[1], deck + 1.05], [p1[0], p1[1], deck + 1.05], 0.05, false);
    if (o.open) {
      // slender white columns carrying the canopy
      geo.paint(WHITE);
      for (let s = r0 + 4; s <= r1 - 4; s += 8) {
        const p = P(s, side * (w - 0.4));
        geo.cylinder(p[0], p[1], deck, roofH, 0.16, 8, false);
      }
    }
  }
  const rw = (o.roofW ?? o.w + 1.6) / 2;
  const rm = (r0 + r1) / 2;
  const rl = (r1 - r0) / 2;
  if (o.roofLen) {
    // flat-oval white canopy: an ellipse slab
    const N = 28;
    const ring: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2;
      ring.push(P(rm + Math.cos(t) * rl, Math.sin(t) * rw));
    }
    geo.paint(WHITE);
    const cTop = P(rm, 0);
    const cBot = geo.vert(cTop[0], roofH, cTop[1]);
    const cUp = geo.vert(cTop[0], roofH + 0.45, cTop[1]);
    for (let i = 0; i < N; i++) {
      const a = ring[i];
      const b2 = ring[(i + 1) % N];
      geo.face(
        [
          [a[0], a[1], roofH],
          [b2[0], b2[1], roofH],
          [b2[0], b2[1], roofH + 0.45],
          [a[0], a[1], roofH + 0.45],
        ],
        (a[0] + b2[0]) / 2 - cTop[0],
        (a[1] + b2[1]) / 2 - cTop[1],
        0,
      );
      geo.tri(cUp, geo.vert(a[0], roofH + 0.45, a[1]), geo.vert(b2[0], roofH + 0.45, b2[1]), 0, 1, 0);
    }
    geo.paint(0xe6e6e2, Pat.Soffit, 1.5);
    for (let i = 0; i < N; i++) {
      const a = ring[i];
      const b2 = ring[(i + 1) % N];
      geo.tri(cBot, geo.vert(a[0], roofH, a[1]), geo.vert(b2[0], roofH, b2[1]), 0, -1, 0);
    }
  } else {
    // flat roof
    geo.paint(WHITE);
    geo.box(o.x + ax * rm, o.y + ay * rm, roofH, roofH + 0.35, ax, ay, rl, rw, true);
    geo.paint(0x9a9c9e);
    geo.box(o.x + ax * rm, o.y + ay * rm, roofH + 0.35, roofH + 0.5, ax, ay, rl - 0.3, rw - 0.4);
  }
  // towers or piers at the ends, plus piers where the ground allows
  const tw = o.towerW ?? 6.5;
  const ends: number[] = o.towers ? [s0 + tw / 2 + 0.25, s1 - tw / 2 - 0.25] : [];
  for (const s of ends) {
    const p = P(s, 0);
    const t: TowerDef = { x: p[0], y: p[1], w: tw, d: tw, h: roofH - zb + (o.towerLift ? 0.6 : 2.5), heading: Math.atan2(ax, ay), frame: o.frame, banner: o.towerLift ? 0 : 0xe8552b, hat: o.towerHat, roof: o.towerRoof, lift: o.towerLift };
    buildTower(c, b, t, Math.min(c.heights.ground(p[0], p[1]), zb));
  }
  const pierStep = 12;
  for (let s = s0 + 2; s <= s1 - 2; s += pierStep) {
    if (ends.some((e) => Math.abs(e - s) < 5)) continue;
    const p = P(s, 0);
    const gz = c.heights.ground(p[0], p[1]);
    const under = c.idx.nearest(p[0], p[1], 12);
    if (under && under.dist < c.data.roads[under.road].width / 2 + 1.0) continue;
    if (deck - gz < 1.5 || nearRail(c, p[0], p[1], 3.2)) continue;
    geo.paint(CONCRETE);
    geo.cylinder(p[0], p[1], gz - 1, deck - 0.9, 0.45, 10, false);
  }
}

/** Street entrance canopy (Langlands Park): flat roof on posts, the station name standing on its front edge. */
function buildEntrance(c: Ctx, b: StationBuild, e: NonNullable<StationDef['entrances']>[number]): void {
  const geo = b.geo;
  const z = c.heights.ground(e.x, e.y);
  const tx = e.fy; // along the front (right of the facing)
  const ty = -e.fx;
  const h0 = z + e.h;
  const h1 = h0 + 0.45;
  geo.paint(b.def.fascia);
  geo.box(e.x, e.y, h0, h1, tx, ty, e.len / 2, e.d / 2, false);
  geo.paint(b.def.soffit, Pat.Soffit, 1.2);
  const P = (s: number, f: number): [number, number] => [e.x + tx * s + e.fx * f, e.y + ty * s + e.fy * f];
  const cs = [P(-e.len / 2, -e.d / 2), P(e.len / 2, -e.d / 2), P(e.len / 2, e.d / 2), P(-e.len / 2, e.d / 2)];
  geo.face(
    cs.map(([x, y]) => [x, y, h0 - 0.01] as V3),
    0,
    0,
    -1,
  );
  geo.paint(b.def.post);
  const np = Math.max(2, Math.round(e.len / 6) + 1);
  for (let i = 0; i < np; i++) {
    const s = -e.len / 2 + 0.6 + ((e.len - 1.2) * i) / (np - 1);
    for (const f of [-e.d / 2 + 0.6, e.d / 2 - 0.6]) {
      const [x, y] = P(s, f);
      geo.box(x, y, c.heights.ground(x, y) - 0.3, h0, tx, ty, 0.1, 0.1);
    }
  }
  if (b.def.name) {
    const key = c.atlas.want({ kind: 'lettering', text: b.def.name });
    const [x, y] = P(-e.len / 2 + 4.2, e.d / 2 - 0.3);
    geo.deferSign(c.atlas, key, x, y, h1 + 0.42, e.fx, e.fy, 7.5, 0.7, 0.05);
  }
}

/** A concourse box over the busway (RBWH): white horizontal bands and glass on columns, lettering. */
function buildConcourse(c: Ctx, b: StationBuild, o: ConcourseDef): void {
  const geo = b.geo;
  const glass = b.glass;
  const hit = c.idx.nearest(o.x, o.y, 30, undefined, 0, isBus);
  const z0 = (hit ? hit.z : c.heights.ground(o.x, o.y)) + o.clear;
  const z1 = z0 + o.h;
  const { ax, ay } = o;
  const nx = -ay;
  const ny = ax;
  const [s0, s1] = o.len;
  const w = o.w / 2;
  const P = (s: number, off: number): [number, number] => [o.x + ax * s + nx * off, o.y + ay * s + ny * off];
  const cs: [number, number][] = [P(s0, -w), P(s1, -w), P(s1, w), P(s0, w)];
  // glass skin, set back behind the bands
  for (let i = 0; i < 4; i++) {
    const a = cs[i];
    const e = cs[(i + 1) % 4];
    const fx = (a[0] + e[0]) / 2 - o.x;
    const fy = (a[1] + e[1]) / 2 - o.y;
    glass.paint(0x6f8f96);
    glass.face(
      [
        [a[0], a[1], z0 + 0.6],
        [e[0], e[1], z0 + 0.6],
        [e[0], e[1], z1 - 0.6],
        [a[0], a[1], z1 - 0.6],
      ],
      fx,
      fy,
      0,
    );
    // white bands: floor edge, mid rail and the deep roof band, with rounded corners
    // approximated by an outward bulge at mid-height
    geo.paint(WHITE);
    for (const [h0, h1, out] of [
      [z0 - 0.1, z0 + 0.6, 0.25],
      [z0 + 2.1, z0 + 2.5, 0.35],
      [z1 - 1.2, z1 + 0.1, 0.45],
    ] as [number, number, number][]) {
      const fl = Math.hypot(fx, fy) || 1;
      const ox = (fx / fl) * out;
      const oy = (fy / fl) * out;
      geo.face(
        [
          [a[0] + ox, a[1] + oy, h0],
          [e[0] + ox, e[1] + oy, h0],
          [e[0] + ox, e[1] + oy, h1],
          [a[0] + ox, a[1] + oy, h1],
        ],
        fx,
        fy,
        0,
      );
      geo.face(
        [
          [a[0], a[1], h0],
          [e[0], e[1], h0],
          [e[0] + ox, e[1] + oy, h0],
          [a[0] + ox, a[1] + oy, h0],
        ],
        0,
        0,
        -1,
      );
      geo.face(
        [
          [a[0], a[1], h1],
          [e[0], e[1], h1],
          [e[0] + ox, e[1] + oy, h1],
          [a[0] + ox, a[1] + oy, h1],
        ],
        0,
        0,
        1,
      );
    }
    // lettering on the long faces
    if (Math.abs(fx * nx + fy * ny) > 0.5 * Math.hypot(fx, fy) && b.def.name) {
      const fl = Math.hypot(fx, fy) || 1;
      const key = c.atlas.want({ kind: 'lettering', text: `${b.def.name} station` });
      const mx = a[0] + (e[0] - a[0]) * 0.3 + (fx / fl) * 0.47;
      const my = a[1] + (e[1] - a[1]) * 0.3 + (fy / fl) * 0.47;
      geo.deferSign(c.atlas, key, mx, my, z1 - 0.55, fx / fl, fy / fl, 8, 0.75, 0, false);
    }
  }
  // roof and soffit
  geo.paint(0xd9d9d6);
  geo.face(
    cs.map(([x, y]) => [x, y, z1] as V3),
    0,
    0,
    1,
  );
  geo.paint(0xe8e8e4, Pat.Soffit, 1.2);
  geo.face(
    cs.map(([x, y]) => [x, y, z0 - 0.1] as V3),
    0,
    0,
    -1,
  );
  // columns along the long sides, off the roads below
  for (const side of [-1, 1]) {
    for (let s = s0 + 1; s <= s1 - 1 + 1e-6; s += (s1 - s0 - 2) / Math.max(1, Math.round((s1 - s0 - 2) / 9))) {
      const p = P(s, side * (w - 0.6));
      const gz = c.heights.ground(p[0], p[1]);
      const under = c.idx.nearest(p[0], p[1], 12, undefined, 0, undefined, gz, 3);
      if (under && under.dist < c.data.roads[under.road].width / 2 + 0.8) continue;
      const bus = c.idx.nearest(p[0], p[1], 12, undefined, 0, isBus);
      if (bus && bus.dist < c.data.roads[bus.road].width / 2 + 0.8) continue;
      geo.paint(WHITE);
      geo.cylinder(p[0], p[1], Math.min(gz, z0) - 1, z0, 0.35, 10, false);
    }
  }
}

/** Lift/stair tower: dark steel frame, glass and louvres, flat white cantilevered "hat" roof. */
function buildTower(c: Ctx, b: StationBuild, t: TowerDef, base: number | null): void {
  const geo = b.geo;
  const glass = b.glass;
  let hx = 0;
  let hy = 1;
  if (t.heading !== undefined) {
    hx = Math.sin(t.heading);
    hy = Math.cos(t.heading);
  } else {
    const hit = c.idx.nearest(t.x, t.y, 60, undefined, 0, isBus);
    if (hit) {
      hx = hit.dx;
      hy = hit.dy;
    }
  }
  const gz = c.heights.ground(t.x, t.y);
  const z0 = base ?? (t.ground ? gz : Math.min(gz, buswayZ(c, t.x, t.y)));
  const z1 = (t.ground ? gz : buswayZ(c, t.x, t.y)) + t.h;
  const hw = t.w / 2;
  const hd = t.d / 2;
  const vx = -hy;
  const vy = hx;
  const corner = (i: number, j: number): [number, number] => [t.x + hx * hw * i + vx * hd * j, t.y + hy * hw * i + vy * hd * j];
  // core: glass on two faces, louvres on the others (a lift shaft is glass all round)
  const cs: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  if (t.lift) {
    buildLiftShaft(geo, glass, t, corner, cs, z0, z1, hx, hy);
    return;
  }
  for (let i = 0; i < 4; i++) {
    const p = corner(...cs[i]);
    const q = corner(...cs[(i + 1) % 4]);
    const fx = (p[0] + q[0]) / 2 - t.x;
    const fy = (p[1] + q[1]) / 2 - t.y;
    if (i % 2 === 0) {
      glass.paint(0x7f9fa6);
      glass.face(
        [
          [p[0], p[1], z0 - 1],
          [q[0], q[1], z0 - 1],
          [q[0], q[1], z1 - 0.6],
          [p[0], p[1], z1 - 0.6],
        ],
        fx,
        fy,
        0,
      );
    } else {
      geo.paint(mixCol(t.frame, 0xc9cdd0, 0.55), Pat.Louvre, 0.18);
      geo.face(
        [
          [p[0], p[1], z0 - 1],
          [q[0], q[1], z0 - 1],
          [q[0], q[1], z1 - 0.6],
          [p[0], p[1], z1 - 0.6],
        ],
        fx,
        fy,
        0,
      );
    }
  }
  // inner lift shaft (opaque, so the glass reads)
  geo.paint(0x3b3f43);
  geo.box(t.x, t.y, z0 - 1, z1 - 0.6, hx, hy, hw * 0.45, hd * 0.45);
  // frame
  geo.paint(t.frame);
  for (const [i, j] of cs) {
    const p = corner(i, j);
    geo.box(p[0], p[1], z0 - 1, z1, hx, hy, 0.16, 0.16);
  }
  for (let h = z0 + 4; h < z1 - 1; h += 4) {
    for (let i = 0; i < 4; i++) {
      const p = corner(...cs[i]);
      const q = corner(...cs[(i + 1) % 4]);
      geo.beam([p[0], p[1], h], [q[0], q[1], h], 0.09, false);
    }
  }
  const [ow, od] = t.hat ?? [1.8, 1.8];
  if (t.roof === 'pyramid') {
    // white hipped roof on a thin eave (Woolloongabba, QUT Kelvin Grove)
    geo.paint(WHITE);
    geo.box(t.x, t.y, z1, z1 + 0.3, hx, hy, hw + ow, hd + od, true);
    const rise = Math.min(hw, hd) * 0.55;
    const ring = cs.map(([i, j]) => [t.x + hx * (hw + ow) * i + vx * (hd + od) * j, t.y + hy * (hw + ow) * i + vy * (hd + od) * j] as [number, number]);
    for (let i = 0; i < 4; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % 4];
      const mx = (p[0] + q[0]) / 2 - t.x;
      const my = (p[1] + q[1]) / 2 - t.y;
      geo.paint(i % 2 ? 0xe4e4e0 : 0xf0f0ec);
      geo.face(
        [
          [p[0], p[1], z1 + 0.3],
          [q[0], q[1], z1 + 0.3],
          [t.x, t.y, z1 + 0.3 + rise],
        ],
        mx,
        my,
        0.5,
      );
    }
  } else {
    // flat cantilevered hat roof
    geo.paint(WHITE);
    geo.box(t.x, t.y, z1, z1 + 0.35, hx, hy, hw + ow, hd + od, true);
    geo.paint(0x2b2f33);
    geo.box(t.x, t.y, z1 + 0.35, z1 + 0.55, hx, hy, hw + ow - 0.2, hd + od - 0.2);
  }
  // orange banner on a corner
  if (t.banner) {
    const p = corner(1, 1);
    const key = c.atlas.want({ kind: 'banner', text: b.def.name || 'TransLink' });
    const bh = Math.min(6, (z1 - z0) * 0.45);
    geo.paint(ORANGE_HEX);
    geo.box(p[0] + vx * 0.5, p[1] + vy * 0.5, z1 - 1 - bh, z1 - 1, hx, hy, 0.5, 0.03);
    geo.deferSign(c.atlas, key, p[0] + vx * 0.5, p[1] + vy * 0.5, z1 - 1 - bh / 2, hx, hy, 0.95, bh, 0.035);
  }
}

/** A glazed lift shaft (Mater Hill): glass all round in a light steel frame, a thin flat cap. */
function buildLiftShaft(
  geo: SGeo,
  glass: SGeo,
  t: TowerDef,
  corner: (i: number, j: number) => [number, number],
  cs: [number, number][],
  z0: number,
  z1: number,
  hx: number,
  hy: number,
): void {
  for (let i = 0; i < 4; i++) {
    const p = corner(...cs[i]);
    const q = corner(...cs[(i + 1) % 4]);
    glass.paint(0x9ccad6);
    glass.face(
      [
        [p[0], p[1], z0 - 0.5],
        [q[0], q[1], z0 - 0.5],
        [q[0], q[1], z1],
        [p[0], p[1], z1],
      ],
      (p[0] + q[0]) / 2 - t.x,
      (p[1] + q[1]) / 2 - t.y,
      0,
    );
  }
  geo.paint(t.frame);
  for (const [i, j] of cs) {
    const p = corner(i, j);
    geo.box(p[0], p[1], z0 - 0.5, z1, hx, hy, 0.09, 0.09);
  }
  for (let h = z0 + 3; h < z1 - 0.5; h += 3) {
    for (let i = 0; i < 4; i++) {
      const p = corner(...cs[i]);
      const q = corner(...cs[(i + 1) % 4]);
      geo.beam([p[0], p[1], h], [q[0], q[1], h], 0.06, false);
    }
  }
  // the car and its stainless doors at the bottom, the machine head at the top
  geo.paint(STAINLESS);
  geo.box(t.x, t.y, z0, z0 + 2.3, hx, hy, t.w * 0.3, t.d * 0.3);
  geo.paint(t.frame);
  geo.box(t.x, t.y, z1, z1 + 0.5, hx, hy, t.w / 2 + 0.25, t.d / 2 + 0.25, true);
}

/** UQ Lakes pantograph chargers: steel mast, L-arm over the bay, hood with the pantograph. */
function buildChargers(c: Ctx, b: StationBuild): void {
  const geo = b.geo;
  for (const ch of b.def.chargers ?? []) {
    const hit = c.idx.nearest(ch.x, ch.y, 25, undefined, 0, isBus);
    if (!hit) continue;
    const r = c.data.roads[hit.road];
    const side = (ch.x - hit.px) * -hit.dy + (ch.y - hit.py) * hit.dx >= 0 ? 1 : -1;
    const nx = -hit.dy * side;
    const ny = hit.dx * side;
    const off = r.width / 2 + 1.6;
    const mx = hit.px + nx * off;
    const my = hit.py + ny * off;
    const z = hit.z;
    const lane = r.width / 4;
    geo.paint(0xc8cbcd);
    geo.box(mx, my, z, z + 6.4, hit.dx, hit.dy, 0.22, 0.3);
    geo.beam([mx, my, z + 6.1], [hit.px + nx * lane, hit.py + ny * lane, z + 6.1], 0.18);
    const hx = hit.px + nx * lane;
    const hy = hit.py + ny * lane;
    geo.box(hx, hy, z + 5.2, z + 6.0, hit.dx, hit.dy, 1.6, 0.65, true);
    geo.paint(0x3a3d41);
    geo.box(hx, hy, z + 4.7, z + 5.2, hit.dx, hit.dy, 0.9, 0.08, true);
    geo.box(hx, hy, z + 4.62, z + 4.7, hit.dx, hit.dy, 0.1, 0.7, true);
    // base cabinet
    geo.paint(0x9ea3a6);
    geo.box(mx + nx * 1.2, my + ny * 1.2, z, z + 2.1, hit.dx, hit.dy, 0.9, 0.4);
  }
}

/** King George Square's granite wedge entrance pavilions on Adelaide St (from their OSM footprints). */
function buildPavilions(c: Ctx, b: StationBuild): void {
  const geo = b.geo;
  const glass = b.glass;
  for (const [ox, oy] of b.def.ownBuildings ?? []) {
    const bld = c.data.buildings.find((q) => {
      const n = q.pts.length / 2;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < n; i++) {
        cx += q.pts[2 * i];
        cy += q.pts[2 * i + 1];
      }
      return Math.hypot(cx / n - ox, cy / n - oy) < 3;
    });
    if (!bld) continue;
    const p = bld.pts;
    const n = p.length / 2;
    // wedge: low at the square side, rising to the street side (away from the square centre)
    let ux = ox - b.def.x;
    let uy = oy - b.def.y;
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul;
    uy /= ul;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const s = (p[2 * i] - ox) * ux + (p[2 * i + 1] - oy) * uy;
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
    const z = c.heights.ground(ox, oy);
    const roofAt = (x: number, y: number) => z + 1.4 + (5.6 * ((x - ox) * ux + (y - oy) * uy - lo)) / Math.max(1, hi - lo);
    geo.frame(ox, oy, ux, uy);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = p[2 * i];
      const ay = p[2 * i + 1];
      const bx = p[2 * j];
      const by = p[2 * j + 1];
      const fx = (ax + bx) / 2 - ox;
      const fy = (ay + by) / 2 - oy;
      const facing = (fx * ux + fy * uy) / (Math.hypot(fx, fy) || 1);
      if (facing > 0.6) {
        // glazed entrance front under the raised end
        glass.paint(0x9fb3b6);
        glass.face(
          [
            [ax, ay, z],
            [bx, by, z],
            [bx, by, roofAt(bx, by) - 1.3],
            [ax, ay, roofAt(ax, ay) - 1.3],
          ],
          fx,
          fy,
          0,
        );
        geo.paint(0x7f7a74, Pat.Tiles, 1.2);
        geo.face(
          [
            [ax, ay, roofAt(ax, ay) - 1.3],
            [bx, by, roofAt(bx, by) - 1.3],
            [bx, by, roofAt(bx, by)],
            [ax, ay, roofAt(ax, ay)],
          ],
          fx,
          fy,
          0,
        );
        const key = c.atlas.want({ kind: 'lettering', text: 'King George Square station' });
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const el = Math.hypot(bx - ax, by - ay);
        const fl = Math.hypot(fx, fy) || 1;
        geo.deferSign(c.atlas, key, mx + (fx / fl) * 0.06, my + (fy / fl) * 0.06, (roofAt(ax, ay) + roofAt(bx, by)) / 2 - 0.65, fx / fl, fy / fl, Math.min(el * 0.9, 9), Math.min(el * 0.9, 9) / 10.7, 0, false);
      } else {
        geo.paint(0x8f8a84, Pat.Tiles, 1.2);
        geo.face(
          [
            [ax, ay, z - 0.3],
            [bx, by, z - 0.3],
            [bx, by, roofAt(bx, by)],
            [ax, ay, roofAt(ax, ay)],
          ],
          fx,
          fy,
          0,
        );
      }
    }
    // sloping roof (triangle fan of the footprint), granite with a pale edge
    const contour: THREE.Vector2[] = [];
    for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(p[2 * i], p[2 * i + 1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    geo.paint(0x9a958e, Pat.Tiles, 1.5);
    const vs: number[] = [];
    for (let i = 0; i < n; i++) vs.push(geo.vert(p[2 * i], roofAt(p[2 * i], p[2 * i + 1]), p[2 * i + 1]));
    for (const t of tris) geo.tri(vs[t[0]], vs[t[1]], vs[t[2]], 0, 1, 0);
  }
}

/** Roma Street P1 (opened Aug 2026): glass station building with a deep terracotta coffered roof overhang. */
function buildRomaP1(c: Ctx, b: StationBuild): void {
  const g = b.plats.find((p) => platformNumber(c, p) === '1');
  if (!g) return;
  const k = g.kerbs.reduce<KerbChain | null>((a, q) => (!a || q.len > a.len ? q : a), null);
  if (!k) return;
  const geo = b.geo;
  const glass = b.glass;
  const pl = g.plane;
  const top = (x: number, y: number) => pl.z0 + pl.slope * ((x - pl.px) * pl.tx + (y - pl.py) * pl.ty) + SLAB;
  const ss = samples(k, 3);
  const depth = ss.map((s) => {
    const d = rayRing(g.outline, s.x + s.nx * 0.05, s.y + s.ny * 0.05, s.nx, s.ny, 30);
    return Number.isFinite(d) ? d : 5;
  });
  const BD = 9; // building depth behind the platform
  for (let i = 0; i + 1 < ss.length; i++) {
    const a = ss[i];
    const e = ss[i + 1];
    const ga: [number, number] = [a.x + a.nx * depth[i], a.y + a.ny * depth[i]];
    const ge: [number, number] = [e.x + e.nx * depth[i + 1], e.y + e.ny * depth[i + 1]];
    const za = top(a.x, a.y);
    const ze = top(e.x, e.y);
    // upper glass storey over the platform back, the lower level glazed too
    glass.paint(0xb9cfd3);
    glass.face(
      [
        [ga[0], ga[1], za + 0.1],
        [ge[0], ge[1], ze + 0.1],
        [ge[0], ge[1], ze + 10.2],
        [ga[0], ga[1], za + 10.2],
      ],
      -a.nx,
      -a.ny,
      0,
    );
    // building body behind (dark so the glass reads)
    const ba: [number, number] = [ga[0] + a.nx * BD, ga[1] + a.ny * BD];
    const be: [number, number] = [ge[0] + e.nx * BD, ge[1] + e.ny * BD];
    geo.paint(0x45494d);
    geo.face(
      [
        [ga[0] + a.nx * 1.5, ga[1] + a.ny * 1.5, za],
        [ge[0] + e.nx * 1.5, ge[1] + e.ny * 1.5, ze],
        [ge[0] + e.nx * 1.5, ge[1] + e.ny * 1.5, ze + 10.2],
        [ga[0] + a.nx * 1.5, ga[1] + a.ny * 1.5, za + 10.2],
      ],
      -a.nx,
      -a.ny,
      0,
    );
    // floor slab band (white) at the upper level
    geo.paint(WHITE);
    geo.face(
      [
        [ga[0] - a.nx * 0.05, ga[1] - a.ny * 0.05, za + 4.6],
        [ge[0] - e.nx * 0.05, ge[1] - e.ny * 0.05, ze + 4.6],
        [ge[0] - e.nx * 0.05, ge[1] - e.ny * 0.05, ze + 5.3],
        [ga[0] - a.nx * 0.05, ga[1] - a.ny * 0.05, za + 5.3],
      ],
      -a.nx,
      -a.ny,
      0,
    );
    // deep roof overhang: terracotta coffers underneath, from the back of the building to past the kerb
    const fa: [number, number] = [a.x - a.nx * 1.2, a.y - a.ny * 1.2];
    const fe: [number, number] = [e.x - e.nx * 1.2, e.y - e.ny * 1.2];
    geo.paint(0xb06a45, Pat.Coffer, 1.5);
    geo.face(
      [
        [fa[0], fa[1], za + 10.2],
        [fe[0], fe[1], ze + 10.2],
        [be[0], be[1], ze + 10.2],
        [ba[0], ba[1], za + 10.2],
      ],
      0,
      0,
      -1,
    );
    geo.paint(0x8b8d8f);
    geo.face(
      [
        [fa[0], fa[1], za + 11.6],
        [fe[0], fe[1], ze + 11.6],
        [be[0], be[1], ze + 11.6],
        [ba[0], ba[1], za + 11.6],
      ],
      0,
      0,
      1,
    );
    geo.paint(0x9a5a3a);
    geo.face(
      [
        [fa[0], fa[1], za + 10.2],
        [fe[0], fe[1], ze + 10.2],
        [fe[0], fe[1], ze + 11.6],
        [fa[0], fa[1], za + 11.6],
      ],
      -a.nx,
      -a.ny,
      0,
    );
    // white columns at the platform back every other sample, forking into V struts under the roof
    if (i % 2 === 0) {
      geo.paint(WHITE);
      const cx = ga[0] - a.nx * 0.4;
      const cy = ga[1] - a.ny * 0.4;
      geo.box(cx, cy, za, za + 7.6, a.tx, a.ty, 0.22, 0.22);
      for (const sg of [-1, 1]) geo.beam([cx, cy, za + 7.5], [cx + a.tx * 1.7 * sg - a.nx * 0.6, cy + a.ty * 1.7 * sg - a.ny * 0.6, za + 10.2], 0.14, false);
    }
  }
}

/** QUT Kelvin Grove / Herston / INB enclosures: an arched vault over the busway and platforms, from the OSM roof footprint. */
function buildVault(c: Ctx, b: StationBuild, foot: Float32Array): void {
  const v = b.def.vault;
  if (!v) return;
  const geo = b.geo;
  const glass = b.glass;
  // the busway through the footprint: the bus road with the longest run inside it
  let bestRoad = -1;
  let bestLen = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < foot.length; i += 2) {
    x0 = Math.min(x0, foot[i]);
    x1 = Math.max(x1, foot[i]);
    y0 = Math.min(y0, foot[i + 1]);
    y1 = Math.max(y1, foot[i + 1]);
  }
  c.data.roads.forEach((r, ri) => {
    if (!isBus(r) || r.tunnel) return;
    let len = 0;
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const mx = (r.pts[i] + r.pts[i + 2]) / 2;
      const my = (r.pts[i + 1] + r.pts[i + 3]) / 2;
      if (mx < x0 || mx > x1 || my < y0 || my > y1) continue;
      if (pointInRing(foot, mx, my)) len += Math.hypot(r.pts[i + 2] - r.pts[i], r.pts[i + 3] - r.pts[i + 1]);
    }
    if (len > bestLen) {
      bestLen = len;
      bestRoad = ri;
    }
  });
  if (bestRoad < 0 || bestLen < 20) return;
  const r = c.data.roads[bestRoad];
  // walk the road, keep samples inside the footprint
  const ribs: { x: number; y: number; z: number; tx: number; ty: number; L: [number, number]; R: [number, number] }[] = [];
  let acc = 0;
  let next = 0;
  for (let i = 0; i + 3 < r.pts.length; i += 2) {
    const ax = r.pts[i];
    const ay = r.pts[i + 1];
    const bx = r.pts[i + 2];
    const by = r.pts[i + 3];
    const sl = Math.hypot(bx - ax, by - ay);
    if (sl < 1e-3) continue;
    const tx = (bx - ax) / sl;
    const ty = (by - ay) / sl;
    while (next <= acc + sl) {
      const t = (next - acc) / sl;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      next += v.spacing;
      if (!pointInRing(foot, x, y)) continue;
      const nx = -ty;
      const ny = tx;
      const dl = rayRing(foot, x, y, nx, ny, 40);
      const dr = rayRing(foot, x, y, -nx, -ny, 40);
      if (!Number.isFinite(dl) || !Number.isFinite(dr) || dl + dr < 8) continue;
      const z = r.z[i / 2] + (r.z[i / 2 + 1] - r.z[i / 2]) * t;
      ribs.push({ x, y, z, tx, ty, L: [x + nx * (dl - 0.3), y + ny * (dl - 0.3)], R: [x - nx * (dr - 0.3), y - ny * (dr - 0.3)] });
    }
    acc += sl;
  }
  if (ribs.length < 2) return;
  // over the stations the vault is sheeted in metal over the platforms with a
  // glazed crown; between them (the INB enclosures) it is glazed throughout
  const atStation = Math.hypot((x0 + x1) / 2 - b.def.x, (y0 + y1) / 2 - b.def.y) < b.def.r + 10;
  const N = 12;
  const arch = (rb: (typeof ribs)[number], k: number): V3 => {
    const u = k / N;
    const span = Math.hypot(rb.L[0] - rb.R[0], rb.L[1] - rb.R[1]);
    const rise = v.rise * Math.min(1.25, Math.max(0.6, span / 24));
    const h = rb.z + 0.3 + v.spring + rise * Math.sin(Math.PI * u);
    return [rb.L[0] + (rb.R[0] - rb.L[0]) * u, rb.L[1] + (rb.R[1] - rb.L[1]) * u, h];
  };
  // ribs (paired at QUT), columns at the springing
  for (const rb of ribs) {
    const offs = v.paired ? [-0.3, 0.3] : [0];
    for (const o of offs) {
      geo.paint(v.rib);
      for (let k = 0; k < N; k++) {
        const p = arch(rb, k);
        const q = arch(rb, k + 1);
        geo.beam([p[0] + rb.tx * o, p[1] + rb.ty * o, p[2]], [q[0] + rb.tx * o, q[1] + rb.ty * o, q[2]], 0.13, false);
      }
    }
    for (const end of [rb.L, rb.R]) {
      geo.paint(v.rib);
      const gz = Math.min(rb.z + 0.3, c.heights.ground(end[0], end[1]) + 0.2);
      geo.box(end[0], end[1], gz - 0.5, rb.z + 0.3 + v.spring + 0.1, rb.tx, rb.ty, v.paired ? 0.5 : 0.17, 0.17);
    }
  }
  // longitudinal galvanised tubes and the skin between ribs
  for (let i = 0; i + 1 < ribs.length; i++) {
    const a = ribs[i];
    const e = ribs[i + 1];
    if (Math.hypot(a.x - e.x, a.y - e.y) > v.spacing * 2.5) continue;
    for (let k = 0; k <= N; k += 2) {
      geo.paint(0xb8bcbd);
      geo.beam(arch(a, k), arch(e, k), 0.05, false);
    }
    for (let k = 0; k < N; k++) {
      const p0 = arch(a, k);
      const p1 = arch(a, k + 1);
      const q0 = arch(e, k);
      const q1 = arch(e, k + 1);
      const quad: V3[] = [p0, p1, q1, q0];
      const centre = Math.abs((k + 0.5) / N - 0.5) < 0.2;
      if (atStation && !centre) {
        // corrugated metal deck over the platforms (both faces)
        geo.paint(0xb9bcbc, Pat.Louvre, 0.25);
        geo.panel(quad, 0, 0, 1);
      } else {
        glass.paint(b.def.key === 'qutkg' ? 0xcfd8d4 : 0xbfc6c4);
        glass.face(quad, 0, 0, 1);
      }
    }
  }
}
