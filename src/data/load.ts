import type { Area, Building, MapData, Platform, Rail, Road, Route, Stop, TerrainGrids } from '../types';
import { cumulative } from './coords';

/* Raw JSON shapes written by tools/data/*.py. Coordinates are decimetre ints. */
interface RawRoad { z?: number[]; ms?: number; k: number; w: number; l: number; p: number[]; n?: number; o?: 1; b?: 1; t?: 1; tb?: 1; y?: number; lk?: 1; bus?: 1; bay?: 1 }
interface RawRoads { bounds: [number, number, number, number]; names: string[]; roads: RawRoad[]; rail: { p: number[]; z?: number[]; b?: 1; t?: 1 }[]; signals: number[]; sigr?: number[]; sigd?: number[]; sigz?: number[]; crossings: number[]; walls?: number[][] }
interface RawBuilding { z?: number; h: number; m?: number; k?: number; pt?: 1; c?: string; r?: string; rc?: string; n?: string; p: number[] }
interface RawArea { k?: number; p: number[]; h?: number[][] }
interface RawAreas { water: RawArea[]; areas: RawArea[]; trees: number[] }
interface RawRoute { z?: number[]; id: string; name: string; dir: number; headsign: string; color: string; text: string; op: string; trips: number; len: number; p: number[]; stops: [number, number, number][] }
interface RawPlatforms { platforms: { n: string; r: string; p: number[]; a?: 1; cv?: 1; y?: number; u?: 1 }[] }
interface RawRoutes { stops: { n: string; c: string; x: number; y: number; z?: number }[]; routes: RawRoute[] }

const dm = (p: number[]): Float32Array => {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = p[i] * 0.1;
  return out;
};

async function fetchJson<T>(name: string, onBytes: (n: number) => void): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/${name}`);
  if (!res.ok || !res.body) throw new Error(`Failed to load ${name}: ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes(value.length);
  }
  const blob = new Blob(chunks);
  return JSON.parse(await blob.text()) as T;
}

/** Approximate uncompressed total, for the progress bar. */
const EXPECTED_BYTES = 14_200_000;

export async function loadMapData(onProgress: (fraction: number, label: string) => void): Promise<MapData> {
  let got = 0;
  const bump = (n: number) => {
    got += n;
    onProgress(Math.min(0.95, got / EXPECTED_BYTES), 'Downloading Brisbane…');
  };
  const [r, b, a, rt, pf, terrain] = await Promise.all([
    fetchJson<RawRoads>('roads.json', bump),
    fetchJson<RawBuildings>('buildings.json', bump),
    fetchJson<RawAreas>('areas.json', bump),
    fetchJson<RawRoutes>('routes.json', bump),
    fetchJson<RawPlatforms>('platforms.json', bump),
    loadTerrain(bump),
  ]);
  onProgress(0.97, 'Decoding map…');

  const roads: Road[] = r.roads.map((x) => ({
    kind: x.k,
    width: x.w,
    lanes: x.l,
    oneway: !!x.o,
    bridge: !!x.b,
    tunnel: !!x.t,
    ...(x.tb ? { boxed: true } : {}),
    layer: x.y ?? 0,
    link: !!x.lk,
    bus: !!x.bus,
    ...(x.bay ? { bay: true } : {}),
    name: x.n !== undefined ? r.names[x.n] : undefined,
    maxspeed: x.ms,
    pts: dm(x.p),
    z: x.z ? dm(x.z) : new Float32Array(x.p.length / 2),
  }));
  const rail: Rail[] = r.rail.map((x) => ({ bridge: !!x.b, tunnel: !!x.t, pts: dm(x.p), z: x.z ? dm(x.z) : new Float32Array(x.p.length / 2) }));
  const buildings: Building[] = b.buildings.map((x) => ({
    height: x.h,
    minHeight: x.m ?? 0,
    kind: x.k ?? 0,
    part: !!x.pt,
    color: x.c,
    roofColor: x.rc,
    roof: x.r,
    name: x.n,
    pts: dm(x.p),
    z: (x.z ?? 0) * 0.1,
  }));
  const area = (x: RawArea): Area => ({ kind: x.k ?? 0, pts: dm(x.p), holes: (x.h ?? []).map(dm) });
  const stops: Stop[] = rt.stops.map((s) => ({ name: s.n, code: s.c, x: s.x * 0.1, y: s.y * 0.1, z: (s.z ?? 0) * 0.1 }));
  const routes: Route[] = rt.routes.map((x) => {
    const pts = dm(x.p);
    const cum = cumulative(pts);
    return {
      id: x.id,
      name: x.name,
      dir: x.dir,
      headsign: x.headsign,
      color: x.color,
      textColor: x.text,
      operator: x.op,
      trips: x.trips,
      pts,
      cum,
      z: x.z ? dm(x.z) : new Float32Array(cum.length),
      length: cum[cum.length - 1],
      stops: x.stops.map(([stop, s, t]) => ({ stop, s: s * 0.1, t })),
    };
  });

  return {
    bounds: r.bounds,
    roads,
    rail,
    signals: dm(r.signals),
    ...(r.sigr && r.sigd && r.sigz
      ? { signalRoad: Int32Array.from(r.sigr), signalDir: Int8Array.from(r.sigd), signalZ: dm(r.sigz) }
      : {}),
    crossings: dm(r.crossings),
    retainingWalls: (r.walls ?? []).map(dm),
    buildings,
    areas: a.areas.map(area),
    water: a.water.map(area),
    trees: dm(a.trees),
    stops,
    routes,
    terrain,
    platforms: pf.platforms.map(
      (x): Platform => ({
        name: x.n,
        ref: x.r,
        pts: dm(x.p),
        area: !!x.a,
        covered: !!x.cv,
        layer: x.y ?? 0,
        underground: !!x.u,
      }),
    ),
  };
}

interface RawBuildings { buildings: RawBuilding[] }

interface RawTerrainHeader {
  scale: number;
  offset: number;
  waterLevel: number;
  attribution: string;
  grids: { name: string; x0: number; y0: number; cell: number; nx: number; ny: number; byteOffset: number }[];
}

/** terrain.json header + terrain.bin (uint16 little-endian, h = v * scale + offset). */
async function loadTerrain(onBytes: (n: number) => void): Promise<TerrainGrids> {
  const header = await fetchJson<RawTerrainHeader>('terrain.json', onBytes);
  const res = await fetch(`${import.meta.env.BASE_URL}data/terrain.bin`);
  if (!res.ok) throw new Error(`Failed to load terrain.bin: ${res.status}`);
  const buf = await res.arrayBuffer();
  onBytes(buf.byteLength);
  const view = new DataView(buf);
  return {
    waterLevel: header.waterLevel,
    attribution: header.attribution,
    grids: header.grids.map((g) => {
      const n = g.nx * g.ny;
      const h = new Float32Array(n);
      for (let i = 0; i < n; i++) h[i] = view.getUint16(g.byteOffset + i * 2, true) * header.scale + header.offset;
      return { name: g.name, x0: g.x0, y0: g.y0, cell: g.cell, nx: g.nx, ny: g.ny, h };
    }),
  };
}
