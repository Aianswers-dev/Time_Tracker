import type { TimelineBlock } from '@time-tracker/shared';

/** Stable key for a Today bar block: the segment id, or the gap's start. */
export function blockKey(b: TimelineBlock): string {
  return b.kind === 'segment' ? b.segmentId : `gap-${b.start}`;
}
