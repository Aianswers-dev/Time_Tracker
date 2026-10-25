/**
 * Node-side map loader (fs instead of fetch) for checks and tools run with
 * tsx; mirrors src/data/load.ts (buildings and areas are left out). Not part
 * of the app bundle.
 */
import { readFileSync } from 'node:fs';
import { cumulative } from '../../src/data/coords';
import type { MapData } from '../../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
const D = new URL('../../public/data/', import.meta.url);
const json = (n: string) => JSON.parse(readFileSync(new URL(n, D), 'utf8'));
const dm = (p: number[]) => {
  const o = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) o[i] = p[i] * 0.1;
  return o;
};

export function loadMapNode(): MapData {
  const r = json('roads.json');
  const rt = json('routes.json');
  const pf = json('platforms.json');
  const th = json('terrain.json');
  const bin = readFileSync(new URL('terrain.bin', D));
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const terrain = {
    waterLevel: th.waterLevel,
    attribution: th.attribution,
    grids: th.grids.map((g: { name: string; x0: number; y0: number; cell: number; nx: number; ny: number; byteOffset: number }) => {
      const n = g.nx * g.ny;
      const h = new Float32Array(n);
      for (let i = 0; i < n; i++) h[i] = view.getUint16(g.byteOffset + i * 2, true) * th.scale + th.offset;
      return { name: g.name, x0: g.x0, y0: g.y0, cell: g.cell, nx: g.nx, ny: g.ny, h };
    }),
  };
  return {
    bounds: r.bounds,
    roads: r.roads.map((x: any) => ({
      kind: x.k,
      width: x.w,
      lanes: x.l,
      oneway: !!x.o,
      bridge: !!x.b,
      tunnel: !!x.t,
      layer: x.y ?? 0,
      link: !!x.lk,
      bus: !!x.bus,
      ...(x.bay ? { bay: true } : {}),
      name: x.n !== undefined ? r.names[x.n] : undefined,
      maxspeed: x.ms,
      pts: dm(x.p),
      z: x.z ? dm(x.z) : new Float32Array(x.p.length / 2),
    })),
    rail: r.rail.map((x: any) => ({ bridge: !!x.b, tunnel: !!x.t, pts: dm(x.p), z: x.z ? dm(x.z) : new Float32Array(x.p.length / 2) })),
    signals: dm(r.signals),
    ...(r.sigr && r.sigd && r.sigz ? { signalRoad: Int32Array.from(r.sigr), signalDir: Int8Array.from(r.sigd), signalZ: dm(r.sigz) } : {}),
    crossings: dm(r.crossings),
    retainingWalls: (r.walls ?? []).map((w: number[]) => dm(w)),
    buildings: [],
    areas: [],
    water: [],
    trees: new Float32Array(0),
    stops: rt.stops.map((s: any) => ({ name: s.n, code: s.c, x: s.x * 0.1, y: s.y * 0.1, z: (s.z ?? 0) * 0.1 })),
    routes: rt.routes.map((x: any) => {
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
        stops: x.stops.map(([stop, s, t]: number[]) => ({ stop, s: s * 0.1, t })),
      };
    }),
    terrain,
    platforms: pf.platforms.map((x: any) => ({ name: x.n, ref: x.r, pts: dm(x.p), area: !!x.a, covered: !!x.cv, layer: x.y ?? 0, underground: !!x.u })),
  } as unknown as MapData;
}
