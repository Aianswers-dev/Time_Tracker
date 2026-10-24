// Traffic density setting: menu choice, ?traffic= URL override, persisted pref.
import { safeStorageGet, safeStorageSet } from './util';

export type TrafficLevel = 'off' | 'light' | 'normal';

export interface TrafficCaps {
  /** AI buses kept around the player. */
  buses: number;
  /** AI cars kept around the player. */
  cars: number;
  /** Radius (m) the cars are spread over. */
  carRadius: number;
}

export const TRAFFIC_CAPS: Record<TrafficLevel, TrafficCaps> = {
  off: { buses: 0, cars: 0, carRadius: 0 },
  light: { buses: 26, cars: 55, carRadius: 520 },
  normal: { buses: 38, cars: 95, carRadius: 620 },
};

export const TRAFFIC_LABELS: Record<TrafficLevel, string> = { off: 'Off', light: 'Light', normal: 'Normal' };

const KEY = 'bbs.traffic.v1';

function parse(v: string | null | undefined): TrafficLevel | null {
  return v === 'off' || v === 'light' || v === 'normal' ? v : null;
}

/** ?traffic=off|light|normal, if present. */
export function trafficFromUrl(): TrafficLevel | null {
  try {
    return parse(new URLSearchParams(location.search).get('traffic'));
  } catch {
    return null;
  }
}

/** The level to use when nothing else has chosen one: URL, then saved pref, then Light. */
export function defaultTrafficLevel(): TrafficLevel {
  return trafficFromUrl() ?? parse(safeStorageGet(KEY)) ?? 'light';
}

export function saveTrafficLevel(level: TrafficLevel): void {
  safeStorageSet(KEY, level);
}
