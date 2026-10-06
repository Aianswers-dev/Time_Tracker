import { addDaysToKey, dayKeyOf } from '@time-tracker/shared';
import { Download, FileJson, FileSpreadsheet, Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { inputClass } from '../../components/styles';
import { errorMessage, useToast } from '../../components/toast';
import { Button, Field } from '../../components/ui';
import { useSettings } from '../../data/hooks';
import {
  buildExportFile,
  EXPORT_RANGE_LABELS,
  EXPORT_RANGES,
  exportBounds,
  exportRangeKeys,
  type ExportFormat,
  type ExportRange,
} from '../../lib/export';
import { canShareFile, clickDownload, shareFile } from '../../lib/exportDeliver';
import { shortDateLabel } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { Section } from './Section';

interface Ready {
  file: File;
  url: string;
  count: number;
  shareable: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * CSV and JSON export for a chosen range of logical days. Built on the phone
 * from Dexie in the endpoints' formats (docs/04), so it works offline and with
 * no token. The file goes to the share sheet where the browser supports
 * sharing files (iOS), otherwise it downloads.
 */
export function ExportSection() {
  const settings = useSettings();
  const toast = useToast();
  const [range, setRange] = useState<ExportRange>('all');
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const now = useNow(60_000);

  // Revoke each Blob URL once it is replaced or the section goes away.
  useEffect(() => {
    if (!ready) return;
    return () => URL.revokeObjectURL(ready.url);
  }, [ready]);

  if (!settings) return null;

  const todayKey = dayKeyOf(now, settings);
  const customKeys = custom ?? { from: addDaysToKey(todayKey, -29), to: todayKey };
  const keys = exportRangeKeys(range, todayKey, customKeys);

  async function run(format: ExportFormat) {
    if (!settings) return;
    setBusy(format);
    try {
      const { file, count } = await buildExportFile(format, exportBounds(keys, settings), todayKey);
      const shareable = canShareFile(file);
      const url = URL.createObjectURL(file);
      setReady({ file, url, count, shareable });
      if (shareable) {
        const outcome = await shareFile(file);
        if (outcome === 'needs-tap') {
          toast.show({ message: 'Your file is ready. Tap Share to send it.' });
        }
      } else {
        clickDownload(url, file.name);
      }
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  async function shareAgain(file: File) {
    try {
      await shareFile(file);
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: 'error' });
    }
  }

  return (
    <Section
      title="Export"
      description="Your entries as a spreadsheet (CSV) or a full backup (JSON). Made on this phone, so it works offline."
    >
      <div className="flex flex-col gap-4" data-testid="export">
        <Field label="Range">
          <select
            className={inputClass}
            value={range}
            onChange={(e) => setRange(e.target.value as ExportRange)}
            data-testid="export-range"
          >
            {EXPORT_RANGES.map((r) => (
              <option key={r} value={r}>
                {EXPORT_RANGE_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>
        {range === 'custom' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="From">
              <input
                type="date"
                className={`${inputClass} tabular px-3`}
                value={customKeys.from}
                max={todayKey}
                onChange={(e) =>
                  e.target.value && setCustom({ ...customKeys, from: e.target.value })
                }
              />
            </Field>
            <Field label="To">
              <input
                type="date"
                className={`${inputClass} tabular px-3`}
                value={customKeys.to}
                max={todayKey}
                onChange={(e) => e.target.value && setCustom({ ...customKeys, to: e.target.value })}
              />
            </Field>
          </div>
        )}
        <p className="-mt-2 text-sm text-muted">
          {keys
            ? `${shortDateLabel(keys[0])} – ${shortDateLabel(keys[1])}, whole days from ${String(settings.dayStartHour).padStart(2, '0')}:00.`
            : 'Everything on this phone.'}{' '}
          Times are in {settings.timezone.replaceAll('_', ' ')}.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="primary"
            onClick={() => void run('csv')}
            disabled={busy !== null}
            data-testid="export-csv"
          >
            <FileSpreadsheet size={20} aria-hidden />
            {busy === 'csv' ? 'Preparing…' : 'CSV'}
          </Button>
          <Button
            onClick={() => void run('json')}
            disabled={busy !== null}
            data-testid="export-json"
          >
            <FileJson size={20} aria-hidden />
            {busy === 'json' ? 'Preparing…' : 'JSON'}
          </Button>
        </div>
        {ready && (
          <div
            className="flex items-center gap-3 rounded-2xl bg-surface-2 py-1 pr-1 pl-3"
            data-testid="export-ready"
          >
            <div className="min-w-0 flex-1 py-1">
              <p className="text-sm font-semibold break-all">{ready.file.name}</p>
              <p className="tabular text-xs text-muted">
                {ready.count} {ready.count === 1 ? 'entry' : 'entries'} ·{' '}
                {formatBytes(ready.file.size)}
              </p>
            </div>
            {ready.shareable ? (
              <Button onClick={() => void shareAgain(ready.file)} className="px-4">
                <Share2 size={18} aria-hidden />
                Share
              </Button>
            ) : (
              <a
                href={ready.url}
                download={ready.file.name}
                className="inline-flex min-h-14 items-center gap-2 rounded-2xl px-4 font-semibold text-accent active:opacity-75"
                data-testid="export-download"
              >
                <Download size={18} aria-hidden />
                Download
              </a>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
