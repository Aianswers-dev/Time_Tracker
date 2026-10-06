import type { DayKey } from '@time-tracker/shared';
import { inputClass } from '../../components/styles';
import { RANGE_KINDS, RANGE_LABELS, type RangeKind } from './range';

interface TabsProps {
  value: RangeKind;
  onChange: (kind: RangeKind) => void;
}

/** One row of range presets above everything they scope (dataviz: filters first). */
export function RangeTabs({ value, onChange }: TabsProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Range"
      className="grid grid-cols-5 gap-1 rounded-2xl bg-surface-2 p-1"
      data-testid="range-tabs"
    >
      {RANGE_KINDS.map((kind) => {
        const selected = kind === value;
        return (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={RANGE_LABELS[kind].long}
            data-range={kind}
            onClick={() => onChange(kind)}
            className={`min-h-14 rounded-xl px-1 text-sm font-semibold transition-colors ${
              selected ? 'bg-surface text-fg shadow-sm' : 'text-muted active:bg-surface/60'
            }`}
          >
            {RANGE_LABELS[kind].short}
          </button>
        );
      })}
    </div>
  );
}

interface CustomProps {
  from: DayKey;
  to: DayKey;
  max: DayKey;
  onChange: (from: string, to: string) => void;
}

/** The custom range's two date pickers. Logical days, both inclusive. */
export function CustomRangePicker({ from, to, max, onChange }: CustomProps) {
  return (
    <fieldset className="grid grid-cols-2 gap-2" data-testid="custom-range">
      <legend className="sr-only">Custom range</legend>
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-sm font-medium text-muted">From</span>
        <input
          type="date"
          className={`${inputClass} tabular px-3`}
          value={from}
          max={max}
          onChange={(e) => e.target.value && onChange(e.target.value, to)}
          data-testid="custom-from"
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-sm font-medium text-muted">To</span>
        <input
          type="date"
          className={`${inputClass} tabular px-3`}
          value={to}
          max={max}
          onChange={(e) => e.target.value && onChange(from, e.target.value)}
          data-testid="custom-to"
        />
      </label>
    </fieldset>
  );
}
