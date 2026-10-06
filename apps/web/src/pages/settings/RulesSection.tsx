import type { Category, Rule } from '@time-tracker/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { CategoryBadge } from '../../components/CategoryBadge';
import { errorMessage, useToast } from '../../components/toast';
import { Button } from '../../components/ui';
import { useCategories, useSettings } from '../../data/hooks';
import { liveRules, setRuleEnabled } from '../../data/ruleActions';
import { updateStaleCheck } from '../../data/settingsActions';
import {
  describeQuiet,
  describeRule,
  describeStale,
  formatMinutes,
  KIND_LABEL,
} from './rules/describe';
import { RuleSheet } from './rules/RuleSheet';
import { StaleSheet } from './rules/StaleSheet';
import { SwitchKnob } from './rules/fields';
import { Section } from './Section';

type Editing = { kind: 'new' } | { kind: 'edit'; id: string } | { kind: 'stale' };

interface Group {
  category: Category;
  rules: Rule[];
}

/** Rules under their category, in category order. Rules of deleted categories are left out. */
function groupRules(categories: readonly Category[], rules: readonly Rule[]): Group[] {
  const byCategory = new Map<string, Rule[]>();
  for (const rule of rules) {
    const list = byCategory.get(rule.categoryId) ?? [];
    list.push(rule);
    byCategory.set(rule.categoryId, list);
  }
  const kindOrder = { session: 0, daily: 1 } as const;
  return categories
    .filter((c) => byCategory.has(c.id))
    .map((category) => ({
      category,
      rules: (byCategory.get(category.id) ?? []).sort(
        (a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.thresholdMin - b.thresholdMin,
      ),
    }));
}

/** Nudge rules grouped by category, plus the stale check in its own section. */
export function RulesSection() {
  const categories = useCategories();
  const settings = useSettings();
  const rules = useLiveQuery(liveRules, []);
  const toast = useToast();
  const [editing, setEditing] = useState<Editing | null>(null);

  async function run(work: () => Promise<unknown>) {
    try {
      await work();
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: 'error' });
    }
  }

  if (!categories || !settings || !rules) return null;

  const groups = groupRules(categories, rules);
  const active = categories.filter((c) => c.archivedAt === null);
  const exemptNames = active.filter((c) => c.exemptFromStaleCheck).map((c) => c.name);
  const current = editing?.kind === 'edit' ? rules.find((r) => r.id === editing.id) : undefined;
  const staleQuiet = describeQuiet(settings.staleQuietStart, settings.staleQuietEnd);

  return (
    <>
      <Section
        title="Rules"
        id="rules"
        description="Nudges when you spend too long on something. Tap a rule to change it."
      >
        {groups.length === 0 ? (
          <p className="py-2 text-sm text-muted">No rules yet. Add one to get nudged.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((g) => (
              <RuleGroup
                key={g.category.id}
                group={g}
                onEdit={(id) => setEditing({ kind: 'edit', id })}
                onToggle={(rule) => void run(() => setRuleEnabled(rule.id, !rule.enabled))}
              />
            ))}
          </div>
        )}
        <Button
          className="mt-4 w-full"
          disabled={active.length === 0}
          onClick={() => setEditing({ kind: 'new' })}
        >
          <Plus size={20} aria-hidden /> Add rule
        </Button>
      </Section>

      <Section
        title="Still on it?"
        id="stale"
        description="A nudge for when you probably forgot to switch."
      >
        <div className="flex items-stretch gap-1">
          <button
            type="button"
            onClick={() => setEditing({ kind: 'stale' })}
            className="flex min-h-16 min-w-0 flex-1 items-center gap-2 rounded-2xl px-1 py-2 text-left active:bg-surface-2"
          >
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">
                Stale check
                {settings.staleEnabled && (
                  <span className="font-normal text-muted">
                    {' '}
                    · {formatMinutes(settings.staleAfterMin)}
                  </span>
                )}
              </span>
              <span
                className={`block text-sm leading-snug ${settings.staleEnabled ? 'text-fg' : 'text-muted'}`}
              >
                {describeStale(settings, exemptNames)}
              </span>
              {settings.staleEnabled && staleQuiet && (
                <span className="mt-0.5 block text-xs text-muted">{staleQuiet}</span>
              )}
            </span>
            <ChevronRight size={18} className="shrink-0 text-muted" aria-hidden />
          </button>
          <ToggleButton
            on={settings.staleEnabled}
            label="Stale check"
            onClick={() =>
              void run(() => updateStaleCheck({ staleEnabled: !settings.staleEnabled }))
            }
          />
        </div>
      </Section>

      {editing?.kind === 'new' && (
        <RuleSheet
          categories={categories}
          defaultCategoryId={active[0]?.id ?? categories[0]?.id ?? ''}
          dayStartHour={settings.dayStartHour}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === 'edit' && current && (
        <RuleSheet
          rule={current}
          categories={categories}
          defaultCategoryId={current.categoryId}
          dayStartHour={settings.dayStartHour}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === 'stale' && (
        <StaleSheet
          settings={settings}
          exemptNames={exemptNames}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function ToggleButton({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className="inline-flex min-h-14 w-16 shrink-0 items-center justify-center rounded-2xl active:bg-surface-2"
    >
      <SwitchKnob on={on} />
    </button>
  );
}

interface GroupProps {
  group: Group;
  onEdit: (id: string) => void;
  onToggle: (rule: Rule) => void;
}

function RuleGroup({ group, onEdit, onToggle }: GroupProps) {
  const { category, rules } = group;
  const archived = category.archivedAt !== null;
  return (
    <div className={archived ? 'opacity-60' : undefined}>
      <h3 className="flex items-center gap-2 px-1 pb-1">
        <CategoryBadge category={category} size={28} className="rounded-lg" />
        <span className="min-w-0 truncate font-semibold">{category.name}</span>
        {archived && <span className="shrink-0 text-xs text-muted">Archived · won’t nudge</span>}
      </h3>
      <ul className="divide-y divide-line">
        {rules.map((rule) => {
          const quiet = describeQuiet(rule.quietStart, rule.quietEnd);
          const muted = !rule.enabled || archived;
          return (
            <li key={rule.id} className="flex items-stretch gap-1">
              <button
                type="button"
                onClick={() => onEdit(rule.id)}
                className="flex min-h-16 min-w-0 flex-1 items-center gap-2 rounded-2xl px-1 py-2 text-left active:bg-surface-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {KIND_LABEL[rule.kind]}
                    <span className="font-normal text-muted">
                      {' '}
                      · {rule.enabled ? formatMinutes(rule.thresholdMin) : 'Off'}
                    </span>
                  </span>
                  <span
                    className={`block text-sm leading-snug ${muted ? 'text-muted' : 'text-fg'}`}
                  >
                    {describeRule(rule, category.name)}
                  </span>
                  {(quiet || rule.message) && (
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {[quiet, rule.message && `“${rule.message}”`].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
                <ChevronRight size={18} className="shrink-0 text-muted" aria-hidden />
              </button>
              <ToggleButton
                on={rule.enabled}
                label={`${KIND_LABEL[rule.kind]} for ${category.name}`}
                onClick={() => onToggle(rule)}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
