import type { Category, Rule, RuleKind } from '@time-tracker/shared';
import { Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { CategorySelect } from '../../../components/CategorySelect';
import { Sheet } from '../../../components/Sheet';
import { inputClass } from '../../../components/styles';
import { errorMessage, useToast } from '../../../components/toast';
import { Button, ErrorText } from '../../../components/ui';
import { addRule, deleteRule, updateRule, type RuleDraft } from '../../../data/ruleActions';
import { ValidationError, type FieldErrors } from '../../../data/validation';
import { describeQuiet, describeRule, KIND_LABEL, kindExplanation } from './describe';
import {
  durationToDraft,
  parseNudgeDraft,
  quietToDraft,
  repeatToDraft,
  type NudgeDraft,
} from './draft';
import { DurationInput, QuietInput, RepeatInput, Segmented, SwitchRow } from './fields';

interface Props {
  /** Undefined to add a rule. */
  rule?: Rule;
  /** Live categories in sortOrder, archived included. */
  categories: readonly Category[];
  defaultCategoryId: string;
  dayStartHour: number;
  onClose: () => void;
}

const DEFAULTS: Record<RuleKind, { thresholdMin: number; repeatEveryMin: number }> = {
  session: { thresholdMin: 60, repeatEveryMin: 30 },
  daily: { thresholdMin: 180, repeatEveryMin: 60 },
};

const MESSAGE_MAX = 200;

/** Add or edit one nudge rule. Saving queues exactly one `rule.upsert` op. */
export function RuleSheet({ rule, categories, defaultCategoryId, dayStartHour, onClose }: Props) {
  const toast = useToast();
  const id = useId();
  const [categoryId, setCategoryId] = useState(rule?.categoryId ?? defaultCategoryId);
  const [kind, setKind] = useState<RuleKind>(rule?.kind ?? 'session');
  const [nudge, setNudge] = useState<NudgeDraft>(() => ({
    threshold: durationToDraft(rule?.thresholdMin ?? DEFAULTS.session.thresholdMin),
    repeat: repeatToDraft(
      rule ? rule.repeatEveryMin : DEFAULTS.session.repeatEveryMin,
      DEFAULTS.session.repeatEveryMin,
    ),
    quiet: quietToDraft(rule?.quietStart ?? null, rule?.quietEnd ?? null),
  }));
  const [message, setMessage] = useState(rule?.message ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Until the owner touches the numbers, a new rule follows the kind's defaults.
  const [touched, setTouched] = useState(rule !== undefined);

  const category = categories.find((c) => c.id === categoryId);
  const parsed = parseNudgeDraft(nudge);
  const preview = parsed.ok
    ? [
        describeRule({ kind, ...parsed.values }, category?.name ?? 'this category'),
        describeQuiet(parsed.values.quietStart, parsed.values.quietEnd),
      ]
        .filter(Boolean)
        .join('. ')
    : null;

  function edit(next: Partial<NudgeDraft>) {
    setTouched(true);
    setErrors({});
    setFormError(null);
    setNudge((d) => ({ ...d, ...next }));
  }

  function pickKind(next: RuleKind) {
    setKind(next);
    setErrors({});
    if (!touched) {
      setNudge((d) => ({
        ...d,
        threshold: durationToDraft(DEFAULTS[next].thresholdMin),
        repeat: repeatToDraft(DEFAULTS[next].repeatEveryMin),
      }));
    }
  }

  async function save() {
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    const draft: RuleDraft = {
      categoryId,
      kind,
      ...parsed.values,
      message: message.trim() === '' ? null : message,
      enabled,
    };
    setBusy(true);
    setFormError(null);
    try {
      if (rule) await updateRule(rule.id, draft);
      else await addRule(draft);
      toast.show({ message: rule ? 'Rule saved' : 'Rule added' });
      onClose();
    } catch (err) {
      if (err instanceof ValidationError) setErrors(err.fields);
      else setFormError(errorMessage(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!rule) return;
    setBusy(true);
    try {
      await deleteRule(rule.id);
      toast.show({ message: 'Rule deleted' });
      onClose();
    } catch (err) {
      setFormError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title={rule ? 'Edit rule' : 'New rule'} onClose={onClose}>
      <form
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p
          className="rounded-2xl bg-surface-2 px-4 py-3 text-[15px] leading-snug"
          aria-live="polite"
        >
          {preview ?? 'Enter a limit to see what this rule does.'}
        </p>

        <div>
          <CategorySelect
            label="Category"
            value={categoryId}
            onChange={(v) => {
              setCategoryId(v);
              setErrors({});
            }}
            categories={categories}
          />
          <ErrorText>{errors.category}</ErrorText>
          {category?.archivedAt && (
            <p className="mt-1.5 text-xs text-muted">
              {category.name} is archived, so this rule won’t nudge until you unarchive it.
            </p>
          )}
        </div>

        <div>
          <Segmented
            label="Kind"
            value={kind}
            onChange={pickKind}
            options={(['session', 'daily'] as const).map((k) => ({
              value: k,
              label: KIND_LABEL[k],
              hint: kindExplanation(k, dayStartHour),
            }))}
          />
          <ErrorText>{errors.kind}</ErrorText>
        </div>

        <DurationInput
          id={`${id}-threshold`}
          label={kind === 'session' ? 'Nudge after' : 'Daily budget'}
          value={nudge.threshold}
          onChange={(threshold) => edit({ threshold })}
          error={errors.threshold}
        />

        <RepeatInput
          id={`${id}-repeat`}
          value={nudge.repeat}
          onChange={(repeat) => edit({ repeat })}
          error={errors.repeat}
        />

        <QuietInput
          id={`${id}-quiet`}
          value={nudge.quiet}
          onChange={(quiet) => edit({ quiet })}
          error={errors.quiet}
          subject="nudges from this rule"
        />

        <div>
          <label htmlFor={`${id}-message`} className="mb-1.5 block text-sm font-medium text-muted">
            Custom message (optional)
          </label>
          <textarea
            id={`${id}-message`}
            className={`${inputClass} min-h-24 resize-none py-3 ${errors.message ? 'border-danger' : ''}`}
            rows={2}
            maxLength={MESSAGE_MAX + 50}
            placeholder={
              kind === 'session'
                ? `You've been on ${category?.name ?? 'it'} for a while. Time to switch it up.`
                : 'That’s past your budget for today.'
            }
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setErrors({});
            }}
          />
          <p className="mt-1 flex justify-between gap-2 text-xs text-muted">
            <span>Replaces the notification text. The title stays.</span>
            <span className={`tabular ${message.trim().length > MESSAGE_MAX ? 'text-danger' : ''}`}>
              {message.trim().length}/{MESSAGE_MAX}
            </span>
          </p>
          <ErrorText>{errors.message}</ErrorText>
        </div>

        <SwitchRow
          checked={enabled}
          onChange={setEnabled}
          label="Enabled"
          description={enabled ? 'This rule can nudge you.' : 'Kept, but never nudges.'}
        />

        <ErrorText>{formError}</ErrorText>
        <Button type="submit" variant="primary" disabled={busy}>
          {rule ? 'Save' : 'Add rule'}
        </Button>

        {rule &&
          (confirmDelete ? (
            <div className="flex flex-col gap-2 rounded-2xl border border-line p-3">
              <p className="text-sm">Delete this rule? It stops nudging straight away.</p>
              <div className="grid grid-cols-2 gap-2">
                <Button disabled={busy} onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
                <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                  Delete
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="danger-soft" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 size={18} aria-hidden /> Delete rule
            </Button>
          ))}
      </form>
    </Sheet>
  );
}
