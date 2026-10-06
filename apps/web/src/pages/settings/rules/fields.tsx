import type { ReactNode } from 'react';
import { inputClass } from '../../../components/styles';
import type { DurationDraft, QuietDraft, RepeatDraft } from './draft';

/** Form controls for the nudge sheets and the notifications toggle. All at least 56 px tall. */

/** The visual part of a switch. The surrounding button carries the role and label. */
export function SwitchKnob({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`relative h-8 w-13 shrink-0 rounded-full transition-colors ${
        on ? 'bg-accent' : 'bg-line'
      }`}
    >
      <span
        className={`absolute top-1 size-6 rounded-full bg-white shadow transition-transform ${
          on ? 'left-6' : 'left-1'
        }`}
      />
    </span>
  );
}

interface SwitchRowProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
}

/** A full-width row that toggles, like an iOS Settings switch. */
export function SwitchRow({
  checked,
  onChange,
  label,
  description,
  disabled,
  icon,
}: SwitchRowProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex min-h-14 w-full items-center gap-3 rounded-2xl bg-surface-2 px-4 py-2 text-left disabled:opacity-50"
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </span>
      <SwitchKnob on={checked} />
    </button>
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
}

/** Two or three exclusive choices side by side, each optionally with a one-line hint. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedProps<T>) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-sm font-medium text-muted">{label}</legend>
      <div
        role="radiogroup"
        aria-label={label}
        className={`grid gap-2 ${options.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}
      >
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(o.value)}
              className={`flex min-h-14 flex-col justify-center rounded-2xl border px-3 py-2 text-left ${
                selected
                  ? 'border-accent bg-accent/10 text-fg'
                  : 'border-line bg-surface text-fg active:bg-surface-2'
              }`}
            >
              <span className="font-semibold">{o.label}</span>
              {o.hint && (
                <span className="mt-0.5 block text-xs leading-snug text-muted">{o.hint}</span>
              )}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-sm font-medium text-danger">
      {children}
    </p>
  );
}

interface DurationProps {
  id: string;
  label: string;
  value: DurationDraft;
  onChange: (value: DurationDraft) => void;
  error?: string;
  hint?: ReactNode;
}

/** A number with a minutes or hours unit. */
export function DurationInput({ id, label, value, onChange, error, hint }: DurationProps) {
  const errorId = `${id}-error`;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-muted">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          className={`${inputClass} tabular ${error ? 'border-danger' : ''}`}
          inputMode="decimal"
          enterKeyHint="done"
          autoComplete="off"
          value={value.value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        />
        {/* inputClass sets w-full, so the fixed width goes on a wrapper. */}
        <span className="w-36 shrink-0">
          <select
            aria-label={`${label} unit`}
            className={inputClass}
            value={value.unit}
            onChange={(e) => onChange({ ...value, unit: e.target.value === 'h' ? 'h' : 'min' })}
          >
            <option value="min">minutes</option>
            <option value="h">hours</option>
          </select>
        </span>
      </div>
      {hint && !error && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}

interface RepeatProps {
  id: string;
  value: RepeatDraft;
  onChange: (value: RepeatDraft) => void;
  error?: string;
}

/** "Once" or "Every N minutes" while still over the limit. */
export function RepeatInput({ id, value, onChange, error }: RepeatProps) {
  const errorId = `${id}-error`;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Segmented
        label="Repeat while still over"
        value={value.once ? 'once' : 'every'}
        options={[
          { value: 'once', label: 'Once' },
          { value: 'every', label: 'Repeat' },
        ]}
        onChange={(v) => onChange({ ...value, once: v === 'once' })}
      />
      {!value.once && (
        <div className="flex items-center gap-3">
          <label htmlFor={id} className="shrink-0 text-base">
            Every
          </label>
          <input
            id={id}
            className={`${inputClass} tabular ${error ? 'border-danger' : ''}`}
            inputMode="numeric"
            enterKeyHint="done"
            autoComplete="off"
            value={value.every}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => onChange({ ...value, every: e.target.value })}
          />
          <span className="shrink-0 text-base">minutes</span>
        </div>
      )}
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}

interface QuietProps {
  id: string;
  value: QuietDraft;
  onChange: (value: QuietDraft) => void;
  error?: string;
  /** What gets silenced, for the description. */
  subject: string;
}

/** Optional quiet hours: a switch, then From and To times. */
export function QuietInput({ id, value, onChange, error, subject }: QuietProps) {
  const errorId = `${id}-error`;
  const crosses = value.on && value.start !== '' && value.end !== '' && value.start > value.end;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SwitchRow
        checked={value.on}
        onChange={(on) => onChange({ ...value, on })}
        label="Quiet hours"
        description={`No ${subject} during these hours. If still over afterwards, it comes right after.`}
      />
      {value.on && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-sm font-medium text-muted">From</span>
            <input
              id={id}
              type="time"
              className={`${inputClass} tabular ${error ? 'border-danger' : ''}`}
              value={value.start}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => onChange({ ...value, start: e.target.value })}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-sm font-medium text-muted">To</span>
            <input
              type="time"
              className={`${inputClass} tabular ${error ? 'border-danger' : ''}`}
              value={value.end}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => onChange({ ...value, end: e.target.value })}
            />
          </label>
        </div>
      )}
      {crosses && !error && <p className="text-xs text-muted">Runs overnight, past midnight.</p>}
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}
