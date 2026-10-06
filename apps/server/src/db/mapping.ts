import type { Category, Rule, Segment, Settings } from '@time-tracker/shared';
import { SETTINGS_ID } from '@time-tracker/shared';
import type { CategoryRow, RuleRow, SegmentRow, SettingsRow } from './schema';

/**
 * DB rows <-> shared entities. Drizzle already maps snake_case columns to
 * camelCase keys; these functions convert 0/1 integers to booleans and back,
 * and keep the server-only `synced_at` on the server: the `from` functions drop
 * it, the `to` functions take the value to write.
 */

const bool = (n: number): boolean => n !== 0;
const int = (b: boolean): number => (b ? 1 : 0);

export function categoryFromRow(r: CategoryRow): Category {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    icon: r.icon,
    sortOrder: r.sortOrder,
    exemptFromStaleCheck: bool(r.exemptFromStaleCheck),
    archivedAt: r.archivedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
  };
}

export function categoryToRow(c: Category, syncedAt: string): CategoryRow {
  return {
    id: c.id,
    name: c.name,
    color: c.color,
    icon: c.icon,
    sortOrder: c.sortOrder,
    exemptFromStaleCheck: int(c.exemptFromStaleCheck),
    archivedAt: c.archivedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    deletedAt: c.deletedAt,
    syncedAt,
  };
}

export function segmentFromRow(r: SegmentRow): Segment {
  return {
    id: r.id,
    categoryId: r.categoryId,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    note: r.note,
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
  };
}

export function segmentToRow(s: Segment, syncedAt: string): SegmentRow {
  return {
    id: s.id,
    categoryId: s.categoryId,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    note: s.note,
    source: s.source,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    deletedAt: s.deletedAt,
    syncedAt,
  };
}

export function ruleFromRow(r: RuleRow): Rule {
  return {
    id: r.id,
    categoryId: r.categoryId,
    kind: r.kind,
    thresholdMin: r.thresholdMin,
    repeatEveryMin: r.repeatEveryMin,
    quietStart: r.quietStart,
    quietEnd: r.quietEnd,
    message: r.message,
    enabled: bool(r.enabled),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
  };
}

export function ruleToRow(r: Rule, syncedAt: string): RuleRow {
  return {
    id: r.id,
    categoryId: r.categoryId,
    kind: r.kind,
    thresholdMin: r.thresholdMin,
    repeatEveryMin: r.repeatEveryMin,
    quietStart: r.quietStart,
    quietEnd: r.quietEnd,
    message: r.message,
    enabled: int(r.enabled),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
    syncedAt,
  };
}

export function settingsFromRow(r: SettingsRow): Settings {
  return {
    id: SETTINGS_ID,
    timezone: r.timezone,
    dayStartHour: r.dayStartHour,
    staleEnabled: bool(r.staleEnabled),
    staleAfterMin: r.staleAfterMin,
    staleRepeatMin: r.staleRepeatMin,
    staleQuietStart: r.staleQuietStart,
    staleQuietEnd: r.staleQuietEnd,
    updatedAt: r.updatedAt,
  };
}

export function settingsToRow(s: Settings, syncedAt: string): SettingsRow {
  return {
    id: s.id,
    timezone: s.timezone,
    dayStartHour: s.dayStartHour,
    staleEnabled: int(s.staleEnabled),
    staleAfterMin: s.staleAfterMin,
    staleRepeatMin: s.staleRepeatMin,
    staleQuietStart: s.staleQuietStart,
    staleQuietEnd: s.staleQuietEnd,
    updatedAt: s.updatedAt,
    syncedAt,
  };
}
