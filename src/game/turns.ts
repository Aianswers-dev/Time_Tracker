// Turn-by-turn hints from a route polyline plus OSM street names.
import { RoadKind, type MapData, type Route } from '../types';
import { pointAlong, wrapAngle } from '../data/coords';
import { drivable, roadIndexFor } from './roadIndex';

export type TurnKind = 'left' | 'right' | 'slight-left' | 'slight-right' | 'sharp-left' | 'sharp-right' | 'uturn';

export interface TurnHint {
  /** Distance along the route of the turn apex. */
  s: number;
  kind: TurnKind;
  /** Signed turn angle in radians (+ = right). */
  angle: number;
  /** Street the route turns onto, if known. */
  street: string | null;
  /** Street before the turn, if known. */
  from: string | null;
  /** Ready-made phrase without the distance, e.g. "Turn left onto Adelaide St". */
  text: string;
}

const DEG = Math.PI / 180;

/** Shorten "Street" -> "St" etc. like a sat-nav. */
export function shortStreet(name: string): string {
  return name
    .replace(/\bStreet\b/g, 'St')
    .replace(/\bRoad\b/g, 'Rd')
    .replace(/\bTerrace\b/g, 'Tce')
    .replace(/\bAvenue\b/g, 'Ave')
    .replace(/\bParade\b/g, 'Pde')
    .replace(/\bHighway\b/g, 'Hwy')
    .replace(/\bDrive\b/g, 'Dr')
    .replace(/\bBoulevard\b/g, 'Blvd')
    .replace(/\bPlace\b/g, 'Pl')
    .replace(/\bLane\b/g, 'La')
    .replace(/\bCourt\b/g, 'Ct')
    .replace(/\bCrescent\b/g, 'Cres')
    .replace(/\bEsplanade\b/g, 'Esp');
}

function streetAt(data: MapData, route: Route, s: number, offsets: number[]): string | null {
  const idx = roadIndexFor(data);
  const votes = new Map<string, number>();
  for (const o of offsets) {
    const ss = s + o;
    if (ss < 0 || ss > route.length) continue;
    const p = pointAlong(route.pts, route.cum, ss);
    const hit = idx.nearest(p.x, p.y, 12, p.heading, 0.85, drivable);
    if (!hit) continue;
    const road = data.roads[hit.road];
    const name = road.name ?? (road.kind === RoadKind.Busway || road.bus ? 'the busway' : null);
    if (!name) continue;
    votes.set(name, (votes.get(name) ?? 0) + 1 / (1 + hit.dist * 0.1));
  }
  let best: string | null = null;
  let bv = 0;
  for (const [k, v] of votes) if (v > bv) [best, bv] = [k, v];
  return best;
}

function chordHeading(route: Route, s0: number, s1: number): number {
  const a = pointAlong(route.pts, route.cum, s0);
  const b = pointAlong(route.pts, route.cum, s1);
  return Math.atan2(b.x - a.x, b.y - a.y);
}

export function computeTurns(data: MapData, route: Route): TurnHint[] {
  const L = route.length;
  const step = 5;
  const n = Math.floor(L / step);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * step;
    if (s < 20 || s > L - 20) continue;
    d[i] = wrapAngle(chordHeading(route, s, s + 18) - chordHeading(route, s - 18, s));
  }
  const raw: { s: number; angle: number }[] = [];
  let i = 0;
  while (i < n) {
    if (Math.abs(d[i]) < 35 * DEG) {
      i++;
      continue;
    }
    const sign = Math.sign(d[i]);
    let j = i;
    let best = i;
    while (j < n && Math.abs(d[j]) >= 20 * DEG && Math.sign(d[j]) === sign) {
      if (Math.abs(d[j]) > Math.abs(d[best])) best = j;
      j++;
    }
    const s = best * step;
    const angle = wrapAngle(chordHeading(route, s + 12, s + 45) - chordHeading(route, s - 45, s - 12));
    raw.push({ s, angle });
    i = j + 1;
  }
  // Merge turns that are really one manoeuvre (e.g. a dog-leg or roundabout).
  const merged: { s: number; angle: number }[] = [];
  for (const t of raw) {
    const last = merged[merged.length - 1];
    if (last && t.s - last.s < 28) {
      const angle = wrapAngle(chordHeading(route, t.s + 12, t.s + 45) - chordHeading(route, last.s - 45, last.s - 12));
      last.angle = angle;
      continue;
    }
    merged.push({ ...t });
  }
  const out: TurnHint[] = [];
  for (const t of merged) {
    const a = t.angle;
    const abs = Math.abs(a);
    if (abs < 28 * DEG) continue;
    const street = streetAt(data, route, t.s, [22, 35, 50, 70]);
    const from = streetAt(data, route, t.s, [-70, -50, -35, -22]);
    // A road that simply bends keeps its name: not worth an instruction unless sharp.
    if (street && from && street === from && abs < 70 * DEG) continue;
    // Second half of a dog-leg onto the same street: already announced.
    const prev = out[out.length - 1];
    if (prev && street && prev.street === shortStreet(street) && t.s - prev.s < 90) continue;
    const right = a > 0;
    let kind: TurnKind;
    if (abs > 150 * DEG) kind = 'uturn';
    else if (abs > 115 * DEG) kind = right ? 'sharp-right' : 'sharp-left';
    else if (abs > 52 * DEG) kind = right ? 'right' : 'left';
    else kind = right ? 'slight-right' : 'slight-left';
    const verb =
      kind === 'uturn'
        ? 'Make a U-turn'
        : kind.startsWith('slight')
          ? `Keep ${right ? 'right' : 'left'}`
          : kind.startsWith('sharp')
            ? `Sharp ${right ? 'right' : 'left'}`
            : `Turn ${right ? 'right' : 'left'}`;
    const short = street ? shortStreet(street) : null;
    const text = short ? (street === from ? `${verb} to stay on ${short}` : `${verb} onto ${short}`) : verb;
    out.push({ s: t.s, kind, angle: a, street: short, from: from ? shortStreet(from) : null, text });
  }
  return out;
}
