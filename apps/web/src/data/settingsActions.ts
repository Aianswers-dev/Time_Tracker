import { settingsSchema, SETTINGS_ID, type Settings } from '@time-tracker/shared';
import { db } from '../db';
import { enqueue, settingsUpsertOp } from './outbox';

export type SettingsPatch = Partial<Omit<Settings, 'id' | 'updatedAt'>>;

/** Update the settings singleton and queue one `settings.upsert` op. */
export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  return db.transaction('rw', db.settings, db.outbox, async () => {
    const now = new Date().toISOString();
    const current = await db.settings.get(SETTINGS_ID);
    if (!current) throw new Error('Settings are not ready yet');
    const unchanged = (Object.keys(patch) as (keyof SettingsPatch)[]).every(
      (k) => patch[k] === current[k],
    );
    if (unchanged) return current;
    const next = settingsSchema.parse({ ...current, ...patch, updatedAt: now });
    await db.settings.put(next);
    await enqueue(settingsUpsertOp(next, now));
    return next;
  });
}
