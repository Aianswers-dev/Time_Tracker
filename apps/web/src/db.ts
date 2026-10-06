import Dexie, { type EntityTable } from 'dexie';

export interface MetaRow {
  key: string;
  value: string;
}

/**
 * Local-first store. M1 adds categories, segments, rules, settings and outbox as new
 * versioned migrations (version(2), ...); never edit version(1) once shipped.
 */
export class TimeTrackerDB extends Dexie {
  meta!: EntityTable<MetaRow, 'key'>;

  constructor() {
    super('time-tracker');
    this.version(1).stores({
      meta: 'key',
    });
  }
}

export const db = new TimeTrackerDB();
