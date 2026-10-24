// Route classification, search and stop naming helpers.
import type { BusType, MapData, Route } from '../types';

export function busTypeForRoute(route: Route): BusType {
  if (route.operator === 'MET' || route.id === 'M1' || route.id === 'M2') return 'metro';
  if (route.id === '60' || route.id === '61') return 'glider';
  return 'rigid';
}

export type RouteGroup = 'metro' | 'glider' | 'buz' | 'loop' | 'night' | 'south' | 'east' | 'north' | 'west' | 'other';

export const GROUP_LABELS: Record<RouteGroup, string> = {
  metro: 'Brisbane Metro',
  glider: 'CityGlider',
  buz: 'BUZ',
  loop: 'City loops',
  night: 'NightLink',
  south: 'Southside',
  east: 'Eastside',
  north: 'Northside',
  west: 'Westside',
  other: 'Other',
};

export const GROUP_ORDER: RouteGroup[] = ['metro', 'glider', 'buz', 'loop', 'night', 'south', 'east', 'north', 'west', 'other'];

/** High-frequency Bus Upgrade Zone routes (only those present are shown). */
const BUZ = new Set(['100', '111', '120', '130', '140', '150', '180', '196', '199', '200', '222', '330', '333', '340', '345', '385', '412', '444', '555']);
const LOOPS = new Set(['30', '40', '50']);

export function groupOf(route: Route): RouteGroup {
  const id = route.id;
  if (route.operator === 'MET' || /^M\d$/.test(id)) return 'metro';
  if (id === '60' || id === '61') return 'glider';
  if (/^N\d/.test(id) || /nightlink/i.test(route.name)) return 'night';
  if (BUZ.has(id)) return 'buz';
  if (LOOPS.has(id)) return 'loop';
  const n = Number(id);
  if (n >= 100 && n < 200) return 'south';
  if (n >= 200 && n < 300) return 'east';
  if (n >= 300 && n < 400) return 'north';
  if (n >= 400 && n < 500) return 'west';
  return 'other';
}

export function serviceTag(route: Route): string | null {
  const n = route.name;
  if (/rocket/i.test(n)) return 'Rocket';
  if (/bullet/i.test(n)) return 'Bullet';
  if (/express/i.test(n)) return 'Express';
  if (/hail 'n' ride/i.test(n)) return "Hail 'n' Ride";
  if (/shuttle/i.test(n)) return 'Shuttle';
  return null;
}

export const OPERATOR_NAMES: Record<string, string> = {
  BT: 'Transport for Brisbane',
  MET: 'Brisbane Metro',
  LCBS: 'Logan City Bus Service',
  TDEV: 'Transdev Queensland',
  MGB: 'Mt Gravatt Bus Service',
  PRT: 'Park Ridge Transit',
  HBL: 'Hornibrook Bus Lines',
};

/** Busway platforms and interchanges get a station rather than a kerbside stop. */
export function isStationStop(name: string): boolean {
  if (/^(King George Square|Queen Street station|Roma Street busway|Cultural Centre|South Bank busway|UQ Lakes)/i.test(name)) return true;
  if (/\b(at|near)\b/i.test(name) && !/^Lower Level/i.test(name)) return false;
  return /\b(station|busway)\b(,|$)/i.test(name) || /busway station/i.test(name);
}

/** "stop 12a" -> "12A"; "platform 2" -> "P2"; "Queen Street station, 1f" -> "1F"; '' if none. */
export function stopNumber(name: string): string {
  let m = /\bstop\s*(\d+[a-z]?(?:\/\d+[a-z]?)?)\b/i.exec(name);
  if (m) return m[1].toUpperCase();
  m = /\bplatform\s*(\d+[a-z]?)\b/i.exec(name);
  if (m) return `P${m[1].toUpperCase()}`;
  m = /,\s*(\d+[a-z])$/i.exec(name);
  if (m) return m[1].toUpperCase();
  return '';
}

/** Name without the trailing ", stop 12a" / "Stop 28" part, for display. */
export function stopDisplayName(name: string): string {
  return name
    .replace(/,\s*stop\s*\d+[a-z]?(\/\d+[a-z]?)?$/i, '')
    .replace(/\s+Stop\s+\d+[a-z]?\b/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface RouteEntry {
  id: string;
  group: RouteGroup;
  name: string;
  color: string;
  textColor: string;
  operator: string;
  dirs: Route[];
  trips: number;
  search: string;
  tag: string | null;
}

export function routeEntries(data: MapData): RouteEntry[] {
  const by = new Map<string, Route[]>();
  for (const r of data.routes) {
    let a = by.get(r.id);
    if (!a) by.set(r.id, (a = []));
    a.push(r);
  }
  const out: RouteEntry[] = [];
  for (const [id, dirs] of by) {
    dirs.sort((a, b) => a.dir - b.dir);
    const r0 = dirs[0];
    const stopNames = new Set<string>();
    for (const d of dirs) for (const st of d.stops) stopNames.add(stopDisplayName(data.stops[st.stop].name));
    const search = [id, r0.name, ...dirs.map((d) => d.headsign), ...stopNames, OPERATOR_NAMES[r0.operator] ?? ''].join(' | ').toLowerCase();
    out.push({
      id,
      group: groupOf(r0),
      name: r0.name,
      color: r0.color,
      textColor: r0.textColor,
      operator: r0.operator,
      dirs,
      trips: dirs.reduce((a, d) => a + d.trips, 0),
      search,
      tag: serviceTag(r0),
    });
  }
  const key = (id: string) => {
    const m = /^([A-Z]*)(\d+)/.exec(id);
    const pre = m ? m[1] : id;
    const num = m ? Number(m[2]) : 0;
    const rank = pre === 'M' ? 0 : pre === '' ? 1 : 2;
    return [rank, num] as const;
  };
  out.sort((a, b) => {
    const ka = key(a.id);
    const kb = key(b.id);
    return ka[0] - kb[0] || ka[1] - kb[1] || a.id.localeCompare(b.id);
  });
  return out;
}

/** Score an entry against a query (higher is better, 0 = no match). */
export function matchScore(e: RouteEntry, q: string): number {
  if (!q) return 1;
  const id = e.id.toLowerCase();
  if (id === q) return 1000;
  if (id.startsWith(q)) return 500 - id.length;
  const words = q.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const w of words) {
    const i = e.search.indexOf(w);
    if (i < 0) return 0;
    score += i < e.name.length + id.length + 3 ? 50 : 10;
  }
  return score;
}

/** Weekly trips through each stop (sum over routes), for choosing shelters. */
const usageCache = new WeakMap<MapData, Float32Array>();
export function stopUsage(data: MapData): Float32Array {
  let u = usageCache.get(data);
  if (!u) {
    u = new Float32Array(data.stops.length);
    for (const r of data.routes) for (const st of r.stops) u[st.stop] += r.trips;
    usageCache.set(data, u);
  }
  return u;
}

/** Route numbers serving each stop. */
const servingCache = new WeakMap<MapData, string[][]>();
export function routesServing(data: MapData): string[][] {
  let s = servingCache.get(data);
  if (!s) {
    s = data.stops.map(() => [] as string[]);
    for (const r of data.routes) for (const st of r.stops) if (!s[st.stop].includes(r.id)) s[st.stop].push(r.id);
    servingCache.set(data, s);
  }
  return s;
}
