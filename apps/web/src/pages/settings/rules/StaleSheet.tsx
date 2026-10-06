import type { Settings } from '@time-tracker/shared';
import { useId, useState } from 'react';
import { Sheet } from '../../../components/Sheet';
import { errorMessage, useToast } from '../../../components/toast';
import { Button, ErrorText } from '../../../components/ui';
import { updateStaleCheck } from '../../../data/settingsActions';
import { ValidationError, type FieldErrors } from '../../../data/validation';
import { describeQuiet, describeStale } from './describe';
import {
  durationToDraft,
  parseNudgeDraft,
  quietToDraft,
  repeatToDraft,
  type NudgeDraft,
} from './draft';
import { DurationInput, QuietInput, RepeatInput, SwitchRow } from './fields';

interface Props {
  settings: Settings;
  /** Names of live categories exempt from the stale check, for the preview. */
  exemptNames: readonly string[];
  onClose: () => void;
}

/** Edit the stale check. Saving queues exactly one `settings.upsert` op. */
export function StaleSheet({ settings, exemptNames, onClose }: Props) {
  const toast = useToast();
  const id = useId();
  const [enabled, setEnabled] = useState(settings.staleEnabled);
  const [nudge, setNudge] = useState<NudgeDraft>(() => ({
    threshold: durationToDraft(settings.staleAfterMin),
    repeat: repeatToDraft(settings.staleRepeatMin, 60),
    quiet: quietToDraft(settings.staleQuietStart, settings.staleQuietEnd),
  }));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = parseNudgeDraft(nudge);
  const preview = parsed.ok
    ? [
        describeStale(
          {
            staleEnabled: enabled,
            staleAfterMin: parsed.values.thresholdMin,
            staleRepeatMin: parsed.values.repeatEveryMin,
          },
          exemptNames,
        ),
        enabled ? describeQuiet(parsed.values.quietStart, parsed.values.quietEnd) : null,
      ]
        .filter(Boolean)
        .join('. ')
    : null;

  function edit(next: Partial<NudgeDraft>) {
    setErrors({});
    setFormError(null);
    setNudge((d) => ({ ...d, ...next }));
  }

  async function save() {
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setBusy(true);
    try {
      await updateStaleCheck({
        staleEnabled: enabled,
        staleAfterMin: parsed.values.thresholdMin,
        staleRepeatMin: parsed.values.repeatEveryMin,
        staleQuietStart: parsed.values.quietStart,
        staleQuietEnd: parsed.values.quietEnd,
      });
      toast.show({ message: 'Stale check saved' });
      onClose();
    } catch (err) {
      if (err instanceof ValidationError) setErrors(err.fields);
      else setFormError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title="Still on it?" onClose={onClose}>
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
          {preview ?? 'Enter a limit to see what the stale check does.'}
        </p>
        <SwitchRow
          checked={enabled}
          onChange={setEnabled}
          label="Stale check"
          description="For when you forget to switch. Categories can opt out in their settings."
        />
        <DurationInput
          id={`${id}-threshold`}
          label="Ask after one stretch of"
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
          subject="stale checks"
        />
        <ErrorText>{formError}</ErrorText>
        <Button type="submit" variant="primary" disabled={busy}>
          Save
        </Button>
      </form>
    </Sheet>
  );
}
