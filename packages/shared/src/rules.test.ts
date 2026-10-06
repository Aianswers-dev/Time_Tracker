import { describe, expect, it } from 'vitest';
import type { Category, NotificationLogEntry, Rule, Segment, Settings } from './entities';
import { evaluateRules, type RuleEngineInput } from './rules';
import { defaultSettings, SEED_CATEGORIES, SEED_CATEGORY_IDS, SEED_RULES } from './seed';
import { applyRows, switchCategory } from './segments';
import { todayMsFor } from './stats';
import { dayKeyOf, HOUR_MS, MINUTE_MS, SECOND_MS, toIso } from './time';

const OLD = '2026-01-01T00:00:00.000Z';
/** 2026-10-06 11:00 AEDT. */
const START = Date.parse('2026-10-06T00:00:00.000Z');
const MIN = MINUTE_MS;

const settings: Settings = defaultSettings('Australia/Sydney');

function category(key: keyof typeof SEED_CATEGORY_IDS, extra: Partial<Category> = {}): Category {
  const c = SEED_CATEGORIES.find((x) => x.id === SEED_CATEGORY_IDS[key]);
  if (!c) throw new Error(key);
  return { ...c, ...extra };
}

const relaxing = category('relaxing');
const sleep = category('sleep');

function openSeg(cat: Category, startMs = START, id = 'seg-1'): Segment {
  return {
    id,
    categoryId: cat.id,
    startedAt: toIso(startMs),
    endedAt: null,
    note: null,
    source: 'app',
    createdAt: OLD,
    updatedAt: OLD,
    deletedAt: null,
  };
}

function rule(id: string, extra: Partial<Rule> = {}): Rule {
  return {
    id,
    categoryId: relaxing.id,
    kind: 'session',
    thresholdMin: 60,
    repeatEveryMin: null,
    quietStart: null,
    quietEnd: null,
    message: null,
    enabled: true,
    createdAt: OLD,
    updatedAt: OLD,
    deletedAt: null,
    ...extra,
  };
}

let logCounter = 0;
function sent(n: Omit<NotificationLogEntry, 'id' | 'title' | 'body'>): NotificationLogEntry {
  return { id: `log-${++logCounter}`, title: 't', body: 'b', ...n };
}

/** Input with stale checks off unless asked for, so each test sees only what it sets up. */
function input(over: Partial<RuleEngineInput> & { nowMs: number }): RuleEngineInput {
  const { nowMs, ...rest } = over;
  return {
    now: toIso(nowMs),
    settings: { ...settings, staleEnabled: false },
    openSegment: openSeg(relaxing),
    category: relaxing,
    rules: [],
    todayMs: nowMs - START,
    log: [],
    ...rest,
  };
}

describe('evaluateRules: basics', () => {
  it('no open segment yields nothing', () => {
    const out = evaluateRules(
      input({ nowMs: START + 10 * HOUR_MS, openSegment: null, rules: [rule('r')] }),
    );
    expect(out).toEqual([]);
  });

  it('a closed or deleted "open" segment yields nothing', () => {
    const closed = { ...openSeg(relaxing), endedAt: toIso(START + HOUR_MS) };
    const deleted = { ...openSeg(relaxing), deletedAt: OLD };
    for (const openSegment of [closed, deleted]) {
      expect(
        evaluateRules(input({ nowMs: START + 10 * HOUR_MS, openSegment, rules: [rule('r')] })),
      ).toEqual([]);
    }
  });

  it('an archived, deleted or mismatched category yields nothing', () => {
    const settingsOn = { ...settings, staleEnabled: true };
    for (const cat of [
      { ...relaxing, archivedAt: OLD },
      { ...relaxing, deletedAt: OLD },
      category('housework'),
      null,
    ]) {
      const out = evaluateRules(
        input({
          nowMs: START + 10 * HOUR_MS,
          category: cat,
          settings: settingsOn,
          rules: [rule('r'), rule('d', { kind: 'daily' })],
        }),
      );
      expect(out).toEqual([]);
    }
  });

  it('ignores rules for other categories, disabled rules and deleted rules', () => {
    const rules = [
      rule('other', { categoryId: sleep.id }),
      rule('off', { enabled: false }),
      rule('gone', { deletedAt: OLD }),
      rule('daily-off', { kind: 'daily', enabled: false }),
    ];
    expect(evaluateRules(input({ nowMs: START + 10 * HOUR_MS, rules }))).toEqual([]);
  });

  it('several rules can fire in one evaluation', () => {
    const out = evaluateRules(
      input({
        nowMs: START + 6 * HOUR_MS,
        settings: { ...settings, staleEnabled: true },
        rules: [
          rule('s1', { thresholdMin: 60 }),
          rule('s2', { thresholdMin: 120 }),
          rule('d1', { kind: 'daily', thresholdMin: 180 }),
        ],
      }),
    );
    expect(out.map((n) => n.tag)).toEqual(['session:s1', 'session:s2', 'daily:d1', 'stale']);
  });
});

describe('evaluateRules: session rules', () => {
  const r = rule('r', { thresholdMin: 60 });

  it('fires at the threshold, not a minute before (or a millisecond before)', () => {
    expect(evaluateRules(input({ nowMs: START + 59 * MIN, rules: [r] }))).toEqual([]);
    expect(evaluateRules(input({ nowMs: START + 60 * MIN - 1, rules: [r] }))).toEqual([]);
    const out = evaluateRules(input({ nowMs: START + 60 * MIN, rules: [r] }));
    expect(out).toEqual([
      {
        kind: 'session',
        ruleId: 'r',
        segmentId: 'seg-1',
        dayKey: null,
        title: 'Relaxing for 1h 0m',
        body: "You've been on Relaxing for 1h 0m straight. Time to switch it up.",
        tag: 'session:r',
      },
    ]);
  });

  it('does not fire twice without repeatEveryMin', () => {
    const log = [
      sent({
        kind: 'session',
        ruleId: 'r',
        segmentId: 'seg-1',
        dayKey: null,
        sentAt: toIso(START + 60 * MIN),
      }),
    ];
    for (const after of [61, 90, 600, 6000]) {
      expect(evaluateRules(input({ nowMs: START + after * MIN, rules: [r], log }))).toEqual([]);
    }
  });

  it('repeats at exactly repeatEveryMin after the last send', () => {
    const rep = rule('r', { thresholdMin: 60, repeatEveryMin: 30 });
    const lastSent = START + 61 * MIN;
    const log = [
      sent({
        kind: 'session',
        ruleId: 'r',
        segmentId: 'seg-1',
        dayKey: null,
        sentAt: toIso(START + 60 * MIN),
      }),
      sent({
        kind: 'session',
        ruleId: 'r',
        segmentId: 'seg-1',
        dayKey: null,
        sentAt: toIso(lastSent),
      }),
    ];
    expect(evaluateRules(input({ nowMs: lastSent + 29 * MIN, rules: [rep], log }))).toEqual([]);
    const out = evaluateRules(input({ nowMs: lastSent + 30 * MIN, rules: [rep], log }));
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('Relaxing for 1h 31m');
  });

  it('allows 30 seconds of cron drift on a repeat, and no more', () => {
    const rep = rule('r', { thresholdMin: 60, repeatEveryMin: 30 });
    const lastSent = START + 60 * MIN;
    const log = [
      sent({
        kind: 'session',
        ruleId: 'r',
        segmentId: 'seg-1',
        dayKey: null,
        sentAt: toIso(lastSent),
      }),
    ];
    const at = (ms: number) => evaluateRules(input({ nowMs: lastSent + ms, rules: [rep], log }));
    expect(at(29 * MIN + 29 * SECOND_MS)).toEqual([]);
    expect(at(29 * MIN + 30 * SECOND_MS)).toHaveLength(1);
    expect(at(29 * MIN + 31 * SECOND_MS)).toHaveLength(1);
  });

  it('uses the most recent log row, whatever the log order', () => {
    const rep = rule('r', { thresholdMin: 60, repeatEveryMin: 30 });
    const log = [
      sent({
        kind: 'session',
        ruleId: 'r',
        segmentId: 'seg-1',
        dayKey: null,
        sentAt: toIso(START + 100 * MIN),
      }),
      sent({
        kind: 'session',
        ruleId: 'r',
        segmentId: 'seg-1',
        dayKey: null,
        sentAt: toIso(START + 60 * MIN),
      }),
    ];
    expect(evaluateRules(input({ nowMs: START + 120 * MIN, rules: [rep], log }))).toEqual([]);
  });

  it('log rows for other rules, kinds or segments do not count', () => {
    const log = [
      sent({
        kind: 'session',
        ruleId: 'other',
        segmentId: 'seg-1',
        dayKey: null,
        sentAt: toIso(START + 60 * MIN),
      }),
      sent({
        kind: 'session',
        ruleId: 'r',
        segmentId: 'seg-0',
        dayKey: null,
        sentAt: toIso(START + 60 * MIN),
      }),
      sent({
        kind: 'daily',
        ruleId: 'r',
        segmentId: null,
        dayKey: '2026-10-06',
        sentAt: toIso(START + 60 * MIN),
      }),
    ];
    expect(evaluateRules(input({ nowMs: START + 70 * MIN, rules: [r], log }))).toHaveLength(1);
  });

  it('switching category resets session rules: new segment id, no log', () => {
    const first = openSeg(relaxing);
    const log = [
      sent({
        kind: 'session',
        ruleId: 'r',
        segmentId: first.id,
        dayKey: null,
        sentAt: toIso(START + 60 * MIN),
      }),
    ];
    // Switch away and back.
    let ids = 0;
    const ctx = (ms: number) => ({ now: toIso(ms), newId: () => `seg-new-${++ids}` });
    const away = switchCategory([first], { categoryId: sleep.id }, ctx(START + 70 * MIN));
    const segs = applyRows([first], away.rows);
    const back = switchCategory(segs, { categoryId: relaxing.id }, ctx(START + 80 * MIN));
    const reopened = back.opened;
    expect(reopened?.id).not.toBe(first.id);
    const nowMs = START + 80 * MIN + 59 * MIN;
    expect(evaluateRules(input({ nowMs, openSegment: reopened, rules: [r], log }))).toEqual([]);
    const out = evaluateRules(
      input({ nowMs: nowMs + MIN, openSegment: reopened, rules: [r], log }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.segmentId).toBe(reopened?.id);
  });

  it('a custom message replaces the body but not the title', () => {
    const custom = rule('r', { message: 'Go outside.' });
    const out = evaluateRules(input({ nowMs: START + 61 * MIN, rules: [custom] }));
    expect(out[0]?.title).toBe('Relaxing for 1h 1m');
    expect(out[0]?.body).toBe('Go outside.');
  });

  it('a blank custom message falls back to the default body', () => {
    for (const message of ['', '   ']) {
      const out = evaluateRules(
        input({ nowMs: START + 61 * MIN, rules: [rule('r', { message })] }),
      );
      expect(out[0]?.body).toBe(
        "You've been on Relaxing for 1h 1m straight. Time to switch it up.",
      );
    }
  });
});

describe('evaluateRules: daily rules', () => {
  const d = rule('d', { kind: 'daily', thresholdMin: 180 });

  it('counts the open segment up to now (via todayMsFor)', () => {
    const open = openSeg(relaxing);
    const segs = [open];
    const today = dayKeyOf(START, settings);
    const run = (nowMs: number) =>
      evaluateRules(
        input({
          nowMs,
          rules: [d],
          todayMs: todayMsFor(segs, relaxing.id, today, settings, nowMs),
        }),
      );
    expect(run(START + 179 * MIN)).toEqual([]);
    expect(run(START + 180 * MIN)).toEqual([
      {
        kind: 'daily',
        ruleId: 'd',
        segmentId: null,
        dayKey: '2026-10-06',
        title: '3h 0m of Relaxing today',
        body: "That's past your 3h 0m budget for today.",
        tag: 'daily:d',
      },
    ]);
  });

  it('counts a segment that started before dayStartHour only for the part inside today', () => {
    // Relaxing since 01:00 AEDT on the 7th; the 7th's logical day starts at 04:00.
    const start = Date.parse('2026-10-06T14:00:00.000Z');
    const segs = [openSeg(relaxing, start)];
    const nowMs = Date.parse('2026-10-06T19:59:00.000Z'); // 06:59 AEDT
    const today = dayKeyOf(nowMs, settings);
    expect(today).toBe('2026-10-07');
    const todayMs = todayMsFor(segs, relaxing.id, today, settings, nowMs);
    expect(todayMs).toBe(179 * MIN);
    const two = rule('d', { kind: 'daily', thresholdMin: 180 });
    expect(evaluateRules(input({ nowMs, openSegment: segs[0], rules: [two], todayMs }))).toEqual(
      [],
    );
    const later = nowMs + MIN;
    const out = evaluateRules(
      input({
        nowMs: later,
        openSegment: segs[0],
        rules: [two],
        todayMs: todayMsFor(segs, relaxing.id, today, settings, later),
      }),
    );
    expect(out).toHaveLength(1);
  });

  it('dedupes by day and fires again the next logical day', () => {
    const nowMs = START + 5 * HOUR_MS;
    const log = [
      sent({
        kind: 'daily',
        ruleId: 'd',
        segmentId: null,
        dayKey: '2026-10-06',
        sentAt: toIso(START + 3 * HOUR_MS),
      }),
    ];
    expect(evaluateRules(input({ nowMs, rules: [d], log, todayMs: 5 * HOUR_MS }))).toEqual([]);
    // 04:00 AEDT on the 7th is 17:00 UTC on the 6th.
    const nextDay = Date.parse('2026-10-06T17:00:00.000Z');
    const out = evaluateRules(input({ nowMs: nextDay, rules: [d], log, todayMs: 4 * HOUR_MS }));
    expect(out).toHaveLength(1);
    expect(out[0]?.dayKey).toBe('2026-10-07');
    // One minute before the day starts it is still the 6th.
    expect(
      evaluateRules(input({ nowMs: nextDay - MIN, rules: [d], log, todayMs: 10 * HOUR_MS })),
    ).toEqual([]);
  });

  it('repeats within a day when repeatEveryMin is set', () => {
    const rep = rule('d', { kind: 'daily', thresholdMin: 180, repeatEveryMin: 60 });
    const lastSent = START + 4 * HOUR_MS;
    const log = [
      sent({
        kind: 'daily',
        ruleId: 'd',
        segmentId: null,
        dayKey: '2026-10-06',
        sentAt: toIso(lastSent),
      }),
    ];
    expect(
      evaluateRules(input({ nowMs: lastSent + 59 * MIN, rules: [rep], log, todayMs: 5 * HOUR_MS })),
    ).toEqual([]);
    expect(
      evaluateRules(input({ nowMs: lastSent + 60 * MIN, rules: [rep], log, todayMs: 5 * HOUR_MS })),
    ).toHaveLength(1);
  });

  it('is independent of the session length', () => {
    // A short session on top of a long day still triggers the daily rule.
    const nowMs = START + 5 * MIN;
    const out = evaluateRules(input({ nowMs, rules: [d], todayMs: 200 * MIN }));
    expect(out.map((n) => n.kind)).toEqual(['daily']);
    expect(out[0]?.title).toBe('3h 20m of Relaxing today');
  });
});

describe('evaluateRules: stale check', () => {
  const on: Settings = { ...settings, staleEnabled: true, staleAfterMin: 300, staleRepeatMin: 60 };

  it('fires at staleAfterMin with the default copy', () => {
    expect(evaluateRules(input({ nowMs: START + 299 * MIN, settings: on }))).toEqual([]);
    expect(evaluateRules(input({ nowMs: START + 300 * MIN, settings: on }))).toEqual([
      {
        kind: 'stale',
        ruleId: null,
        segmentId: 'seg-1',
        dayKey: null,
        title: 'Still on Relaxing?',
        body: "It's been 5h 0m. Tap to update if you've moved on.",
        tag: 'stale',
      },
    ]);
  });

  it('repeats every staleRepeatMin, or never when it is null', () => {
    const lastSent = START + 300 * MIN;
    const log = [
      sent({
        kind: 'stale',
        ruleId: null,
        segmentId: 'seg-1',
        dayKey: null,
        sentAt: toIso(lastSent),
      }),
    ];
    expect(evaluateRules(input({ nowMs: lastSent + 59 * MIN, settings: on, log }))).toEqual([]);
    expect(evaluateRules(input({ nowMs: lastSent + 60 * MIN, settings: on, log }))).toHaveLength(1);
    const once = { ...on, staleRepeatMin: null };
    expect(evaluateRules(input({ nowMs: lastSent + 600 * MIN, settings: once, log }))).toEqual([]);
  });

  it('is skipped for an exempt category', () => {
    const out = evaluateRules(
      input({
        nowMs: START + 12 * HOUR_MS,
        settings: on,
        category: sleep,
        openSegment: openSeg(sleep),
      }),
    );
    expect(out).toEqual([]);
    expect(sleep.exemptFromStaleCheck).toBe(true);
  });

  it('is skipped when staleEnabled is false', () => {
    const off = { ...on, staleEnabled: false };
    expect(evaluateRules(input({ nowMs: START + 12 * HOUR_MS, settings: off }))).toEqual([]);
  });

  it('a stale row for another segment does not count', () => {
    const log = [
      sent({
        kind: 'stale',
        ruleId: null,
        segmentId: 'seg-0',
        dayKey: null,
        sentAt: toIso(START + 301 * MIN),
      }),
    ];
    expect(evaluateRules(input({ nowMs: START + 302 * MIN, settings: on, log }))).toHaveLength(1);
  });

  it('respects the stale quiet window', () => {
    // 22:00 to 07:00 local. START + 11h is 22:00 AEDT.
    const quiet = { ...on, staleQuietStart: '22:00', staleQuietEnd: '07:00' };
    expect(evaluateRules(input({ nowMs: START + 11 * HOUR_MS, settings: quiet }))).toEqual([]);
    expect(evaluateRules(input({ nowMs: START + 20 * HOUR_MS - MIN, settings: quiet }))).toEqual(
      [],
    );
    expect(evaluateRules(input({ nowMs: START + 20 * HOUR_MS, settings: quiet }))).toHaveLength(1);
  });
});

describe('evaluateRules: quiet hours', () => {
  it('suppress a rule inside a window crossing midnight, then fire the first minute after', () => {
    // Relaxing since 20:00 AEDT. 60 minute session rule, quiet 21:30 to 07:00.
    const start = Date.parse('2026-10-06T09:00:00.000Z');
    const r = rule('r', { thresholdMin: 60, quietStart: '21:30', quietEnd: '07:00' });
    const run = (nowMs: number, log: NotificationLogEntry[] = []) =>
      evaluateRules(input({ nowMs, openSegment: openSeg(relaxing, start), rules: [r], log }));
    // 21:00: over threshold, outside the window.
    expect(run(start + 60 * MIN)).toHaveLength(1);
    // 21:30 to 06:59: suppressed, and nothing is logged, so nothing is due later either.
    for (const m of [90, 120, 4 * 60, 10 * 60 + 59]) expect(run(start + m * MIN)).toEqual([]);
    // 07:00, the first minute after the window: fires.
    const out = run(start + 11 * 60 * MIN);
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('Relaxing for 11h 0m');
  });

  it('a window within one day', () => {
    // START is 11:00 AEDT. Quiet 12:00 to 13:00.
    const r = rule('r', { thresholdMin: 60, quietStart: '12:00', quietEnd: '13:00' });
    expect(evaluateRules(input({ nowMs: START + 60 * MIN, rules: [r] }))).toEqual([]);
    expect(evaluateRules(input({ nowMs: START + 119 * MIN, rules: [r] }))).toEqual([]);
    expect(evaluateRules(input({ nowMs: START + 120 * MIN, rules: [r] }))).toHaveLength(1);
  });

  it('is evaluated in the settings timezone', () => {
    // 12:00 to 13:00 in New York is 16:00 to 17:00 UTC.
    const ny: Settings = { ...settings, timezone: 'America/New_York', staleEnabled: false };
    const r = rule('r', { thresholdMin: 1, quietStart: '12:00', quietEnd: '13:00' });
    const at = (iso: string) =>
      evaluateRules(input({ nowMs: Date.parse(iso), settings: ny, rules: [r] }));
    expect(at('2026-10-06T16:30:00.000Z')).toEqual([]);
    expect(at('2026-10-06T17:00:00.000Z')).toHaveLength(1);
  });

  it('applies per rule: a quiet rule does not silence another', () => {
    const quietOne = rule('q', { thresholdMin: 60, quietStart: '00:00', quietEnd: '23:59' });
    const loud = rule('l', { thresholdMin: 60 });
    const out = evaluateRules(input({ nowMs: START + 61 * MIN, rules: [quietOne, loud] }));
    expect(out.map((n) => n.ruleId)).toEqual(['l']);
  });
});

describe('evaluateRules with the seeded defaults', () => {
  it('Relaxing: session at 60 min, daily at 180 min, stale at 300 min', () => {
    const on = { ...settings };
    const run = (min: number) =>
      evaluateRules(
        input({ nowMs: START + min * MIN, settings: on, rules: SEED_RULES, todayMs: min * MIN }),
      ).map((n) => n.kind);
    expect(run(59)).toEqual([]);
    expect(run(60)).toEqual(['session']);
    expect(run(180)).toEqual(['session', 'daily']);
    expect(run(300)).toEqual(['session', 'daily', 'stale']);
  });
});
