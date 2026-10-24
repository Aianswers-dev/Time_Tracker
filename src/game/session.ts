// Shared per-session state so the game pieces work together even when
// main.ts only wires the minimum (explicit options always take precedence).
import type { WorldHandle } from '../types';
import type { MapMarker } from './minimap';
import type { TrafficLevel } from './trafficLevel';

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
  /** Traffic density chosen in the menu (Traffic picks it up on its next update). */
  trafficLevel: TrafficLevel | null;
  /** The guide's estimate of the player's road height (m AHD), for level checks when the pose has no z. */
  playerZ: number | null;
} = { traffic: null, guide: null, world: null, hours: null, trafficLevel: null, playerZ: null };
