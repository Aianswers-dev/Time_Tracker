import type { Category, Op, Rule, Segment, Settings } from '@time-tracker/shared';
import Dexie, { type EntityTable } from 'dexie';

/** Client-only key/value rows: token, lastSync, installedAt, seededAt, pushSubscriptionId. */
export interface MetaRow {
  key: string;
  value: string;
}

/**
 * One queued write for the server. `op` is a shared `Op` exactly as it will be
 * sent to `POST /api/ops`; `seq` keeps replay order. M1 only writes these; the
 * M2 flusher sends them and records `attempts` and `lastError`.
 */
export interface OutboxRow {
  seq?: number;
  opId: string;
  op: Op;
  attempts: number;
  lastError: string | null;
}

/**
 * Local-first store. Each schema change is a new `version(n)`; never edit a
 * version once it has shipped, because installed apps migrate through them.
 */
export class TimeTrackerDB extends Dexie {
  meta!: EntityTable<MetaRow, 'key'>;
  categories!: EntityTable<Category, 'id'>;
  segments!: EntityTable<Segment, 'id'>;
  rules!: EntityTable<Rule, 'id'>;
  settings!: EntityTable<Settings, 'id'>;
  outbox!: EntityTable<OutboxRow, 'seq'>;

  constructor(name = 'time-tracker') {
    super(name);
    this.version(1).stores({
      meta: 'key',
    });
    // M1: the synced tables (mirroring the server) and the outbox.
    this.version(2).stores({
      categories: 'id, sortOrder',
      segments: 'id, startedAt, categoryId',
      rules: 'id, categoryId',
      settings: 'id',
      outbox: '++seq, opId',
    });
  }
}

export const db = new TimeTrackerDB();
