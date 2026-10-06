import { settingsSchema, SETTINGS_ID, type Settings } from '@time-tracker/shared';
import { db } from '../db';
import { enqueue, settingsUpsertOp } from './outbox';
import {
  quietWindowError,
  ValidationError,
  validationErrorFromIssues,
  type NudgeField,
} from './validation';

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

/** The stale check ("Still on it?") fields of the settings row. */
export type StaleCheckPatch = Partial<
  Pick<
    Settings,
    'staleEnabled' | 'staleAfterMin' | 'staleRepeatMin' | 'staleQuietStart' | 'staleQuietEnd'
  >
>;

const STALE_FIELD_OF: Record<string, NudgeField> = {
  staleAfterMin: 'threshold',
  staleRepeatMin: 'repeat',
  staleQuietStart: 'quiet',
  staleQuietEnd: 'quiet',
};

/**
 * Update the stale check and queue one `settings.upsert` op. Validates with the
 * shared schema first and reports problems per form field (`ValidationError`),
 * so nothing invalid reaches Dexie or the outbox. No change, no op.
 */
export async function updateStaleCheck(patch: StaleCheckPatch): Promise<Settings> {
  return db.transaction('rw', db.settings, db.outbox, async () => {
    const now = new Date().toISOString();
    const current = await db.settings.get(SETTINGS_ID);
    if (!current) throw new Error('Settings are not ready yet');
    const unchanged = (Object.keys(patch) as (keyof StaleCheckPatch)[]).every(
      (k) => patch[k] === current[k],
    );
    if (unchanged) return current;
    const parsed = settingsSchema.safeParse({ ...current, ...patch, updatedAt: now });
    if (!parsed.success) {
      throw validationErrorFromIssues(
        parsed.error.issues,
        (k) => STALE_FIELD_OF[k] ?? null,
        'the stale check',
      );
    }
    const quiet = quietWindowError(parsed.data.staleQuietStart, parsed.data.staleQuietEnd);
    if (quiet) throw new ValidationError({ quiet });
    await db.settings.put(parsed.data);
    await enqueue(settingsUpsertOp(parsed.data, now));
    return parsed.data;
  });
}
