import { defaultSettings, SEED_CATEGORIES, SEED_RULES, SETTINGS_ID } from '@time-tracker/shared';
import { db } from '../db';
import { categoryUpsertOp, enqueue, ruleUpsertOp, settingsUpsertOp } from './outbox';

export function deviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * First-run seed (docs/01 P5, P6). Runs in one rw transaction keyed by the
 * `seededAt` meta row, so calling it twice (StrictMode, two tabs) seeds once.
 * Each seeded row is also queued as an upsert so the server receives it once
 * sync exists (M2).
 */
export async function ensureSeeded(timezone: string = deviceTimezone()): Promise<boolean> {
  return db.transaction(
    'rw',
    [db.meta, db.categories, db.rules, db.settings, db.outbox],
    async () => {
      if (await db.meta.get('seededAt')) return false;
      const now = new Date().toISOString();

      const settings = (await db.settings.get(SETTINGS_ID)) ?? defaultSettings(timezone);
      await db.categories.bulkPut([...SEED_CATEGORIES]);
      await db.rules.bulkPut([...SEED_RULES]);
      await db.settings.put(settings);

      await enqueue(
        ...SEED_CATEGORIES.map((c) => categoryUpsertOp(c, now)),
        ...SEED_RULES.map((r) => ruleUpsertOp(r, now)),
        settingsUpsertOp(settings, now),
      );

      await db.meta.put({ key: 'seededAt', value: now });
      if (!(await db.meta.get('installedAt'))) {
        await db.meta.put({ key: 'installedAt', value: now });
      }
      return true;
    },
  );
}
