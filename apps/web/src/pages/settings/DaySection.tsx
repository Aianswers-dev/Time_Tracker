import { useMemo } from 'react';
import { inputClass } from '../../components/styles';
import { errorMessage, useToast } from '../../components/toast';
import { Field } from '../../components/ui';
import { useSettings } from '../../data/hooks';
import { deviceTimezone } from '../../data/seed';
import { updateSettings, type SettingsPatch } from '../../data/settingsActions';
import { Section } from './Section';

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function timezoneList(current: string | undefined): string[] {
  const all = new Set<string>(Intl.supportedValuesOf?.('timeZone') ?? []);
  all.add('UTC');
  all.add(deviceTimezone());
  if (current) all.add(current);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** Day start hour and timezone. Storage is UTC, so changing either only re-renders. */
export function DaySection() {
  const settings = useSettings();
  const toast = useToast();
  const zones = useMemo(() => timezoneList(settings?.timezone), [settings?.timezone]);
  const device = deviceTimezone();

  async function save(patch: SettingsPatch) {
    try {
      await updateSettings(patch);
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: 'error' });
    }
  }

  if (!settings) return null;

  return (
    <Section
      title="Day"
      description="A late night counts toward the day it started, until the day start hour."
    >
      <div className="flex flex-col gap-4">
        <Field label="Day starts at">
          <select
            className={`${inputClass} tabular`}
            value={settings.dayStartHour}
            onChange={(e) => void save({ dayStartHour: Number(e.target.value) })}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timezone">
          <select
            className={inputClass}
            value={settings.timezone}
            onChange={(e) => void save({ timezone: e.target.value })}
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replaceAll('_', ' ')}
                {z === device ? ' (this device)' : ''}
              </option>
            ))}
          </select>
        </Field>
        {settings.timezone !== device && (
          <button
            type="button"
            className="min-h-14 rounded-2xl bg-surface-2 px-4 text-left text-sm font-medium"
            onClick={() => void save({ timezone: device })}
          >
            Use this device’s timezone ({device.replaceAll('_', ' ')})
          </button>
        )}
      </div>
    </Section>
  );
}
