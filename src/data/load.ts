import type { Area, Building, MapData, Rail, Road, Route, Stop } from '../types';
import { cumulative } from './coords';

/* Raw JSON shapes written by tools/data/*.py. Coordinates are decimetre ints. */
interface RawRoad { k: number; w: number; l: number; p: number[]; n?: number; o?: 1; b?: 1; t?: 1; y?: number; lk?: 1; bus?: 1 }
interface RawRoads { bounds: [number, number, number, number]; names: string[]; roads: RawRoad[]; rail: { p: number[]; b?: 1; t?: 1 }[]; signals: number[]; crossings: number[] }
interface RawBuilding { h: number; m?: number; k?: number; pt?: 1; c?: string; r?: string; rc?: string; n?: string; p: number[] }
interface RawArea { k?: number; p: number[]; h?: number[][] }
interface RawAreas { water: RawArea[]; areas: RawArea[]; trees: number[] }
interface RawRoute { id: string; name: string; dir: number; headsign: string; color: string; text: string; op: string; trips: number; len: number; p: number[]; stops: [number, number][] }
interface RawRoutes { stops: { n: string; c: string; x: number; y: number }[]; routes: RawRoute[] }

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
const EXPECTED_BYTES = 9_600_000;

export async function loadMapData(onProgress: (fraction: number, label: string) => void): Promise<MapData> {
  let got = 0;
  const bump = (n: number) => {
    got += n;
    onProgress(Math.min(0.95, got / EXPECTED_BYTES), 'Downloading Brisbane…');
  };
  const [r, b, a, rt] = await Promise.all([
    fetchJson<RawRoads>('roads.json', bump),
    fetchJson<RawBuildings>('buildings.json', bump),
    fetchJson<RawAreas>('areas.json', bump),
    fetchJson<RawRoutes>('routes.json', bump),
  ]);
  onProgress(0.97, 'Decoding map…');

  const roads: Road[] = r.roads.map((x) => ({
    kind: x.k,
    width: x.w,
    lanes: x.l,
    oneway: !!x.o,
    bridge: !!x.b,
    tunnel: !!x.t,
    layer: x.y ?? 0,
    link: !!x.lk,
    bus: !!x.bus,
    name: x.n !== undefined ? r.names[x.n] : undefined,
    pts: dm(x.p),
  }));
  const rail: Rail[] = r.rail.map((x) => ({ bridge: !!x.b, tunnel: !!x.t, pts: dm(x.p) }));
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
  }));
  const area = (x: RawArea): Area => ({ kind: x.k ?? 0, pts: dm(x.p), holes: (x.h ?? []).map(dm) });
  const stops: Stop[] = rt.stops.map((s) => ({ name: s.n, code: s.c, x: s.x * 0.1, y: s.y * 0.1 }));
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
      length: cum[cum.length - 1],
      stops: x.stops.map(([stop, s]) => ({ stop, s: s * 0.1 })),
    };
  });

  return {
    bounds: r.bounds,
    roads,
    rail,
    signals: dm(r.signals),
    crossings: dm(r.crossings),
    buildings,
    areas: a.areas.map(area),
    water: a.water.map(area),
    trees: dm(a.trees),
    stops,
    routes,
  };
}

interface RawBuildings { buildings: RawBuilding[] }
