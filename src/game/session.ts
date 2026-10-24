// Shared per-session state so the game pieces work together even when
// main.ts only wires the minimum (explicit options always take precedence).
import type { WorldHandle } from '../types';
import type { MapMarker } from './minimap';

export interface TrafficLike {
  markers(): readonly MapMarker[];
}
export interface GuideLike {
  toggleRibbon(on?: boolean): void;
}

export const session: {
  traffic: TrafficLike | null;
  guide: GuideLike | null;
  world: WorldHandle | null;
  /** Latest local time of day seen by the HUD (hours 0..24), or null. */
  hours: number | null;
} = { traffic: null, guide: null, world: null, hours: null };
