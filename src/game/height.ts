// Heights for everything the game places in the world. Route-bound things
// (guidance, stop flags, AI buses) use the route's own heights through
// RouteTrack.zAt; AI cars use their road's heights; this is the fallback for
// anything else, and the level-aware surface lookup for the HUD.
import { heightsFor, type Heights } from '../data/height';
import type { MapData } from '../types';

let shared: Heights | null = null;

/** The shared height queries (built once per map by data/height.ts). */
export function heightsOf(data: MapData): Heights {
  shared = heightsFor(data);
  return shared;
}

/**
 * Road surface (or ground) height at map (x, y), m AHD. Where roads stack,
 * `hintZ` (the height of whatever is being placed) picks the level.
 */
export function heightAt(x: number, y: number, hintZ?: number): number {
  if (!shared) return hintZ ?? 0;
  const surf = shared.surfaceAt(x, y, hintZ);
  // No road at our level right here (a wide station, a kerb between lanes):
  // stay on our level rather than drop to the street above or below.
  if (hintZ !== undefined && surf.road < 0 && Math.abs(surf.z - hintZ) > LEVEL_GAP) return hintZ;
  return surf.z;
}

/** Two things this far apart vertically are on different levels (viaduct over street, tunnel under it). */
export const LEVEL_GAP = 2.5;
