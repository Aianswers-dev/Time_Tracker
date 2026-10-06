import type { LocalParts } from '../lib/datetime';
import { inputClass } from './styles';

interface Props {
  label: string;
  value: LocalParts;
  onChange: (next: LocalParts) => void;
  disabled?: boolean;
}

/** A date and a time input side by side, in the settings timezone. */
export function DateTimeFields({ label, value, onChange, disabled }: Props) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5" disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium text-muted">{label}</legend>
      <div className="grid grid-cols-[1.25fr_1fr] gap-2">
        <input
          type="date"
          aria-label={`${label} date`}
          className={`${inputClass} tabular px-3`}
          value={value.date}
          onChange={(e) => onChange({ ...value, date: e.target.value })}
        />
        <input
          type="time"
          aria-label={`${label} time`}
          className={`${inputClass} tabular px-3`}
          value={value.time}
          onChange={(e) => onChange({ ...value, time: e.target.value })}
        />
      </div>
    </fieldset>
  );
}
