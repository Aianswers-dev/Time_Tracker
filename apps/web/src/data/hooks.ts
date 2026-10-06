import { SETTINGS_ID, type Category, type Segment, type Settings } from '@time-tracker/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { db } from '../db';
import { findOpenSegment, loadAround } from './window';

/** Reactive reads. Each returns undefined until its first query resolves. */

export function useSettings(): Settings | undefined {
  return useLiveQuery(() => db.settings.get(SETTINGS_ID), []);
}

/** Live (not deleted) categories in sortOrder, archived ones included. */
export function useCategories(): Category[] | undefined {
  return useLiveQuery(
    () =>
      db.categories
        .orderBy('sortOrder')
        .filter((c) => c.deletedAt === null)
        .toArray(),
    [],
  );
}

export function useCategoryMap(categories: readonly Category[] | undefined): Map<string, Category> {
  return useMemo(() => new Map((categories ?? []).map((c) => [c.id, c])), [categories]);
}

/** The running segment, null before the first switch, undefined while loading. */
export function useOpenSegment(): Segment | null | undefined {
  return useLiveQuery(() => findOpenSegment(), []);
}

/**
 * Live segments that can overlap [fromMs, toMs), loaded by the startedAt index
 * with a margin (see `loadAround`). Pass null to skip the query.
 */
export function useSegmentsAround(fromMs: number | null, toMs: number): Segment[] | undefined {
  return useLiveQuery(
    () => (fromMs === null ? Promise.resolve(undefined) : loadAround(fromMs, toMs)),
    [fromMs, toMs],
  );
}
