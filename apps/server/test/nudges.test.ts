import {
  dayKeyOf,
  pushSubscriptionResponseSchema,
  toMs,
  uuidv7,
  type PushPayload,
} from '@time-tracker/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { select } from '../src/db/queries';
import { notificationLog, pushSubscriptions, serverConfig } from '../src/db/schema';
import {
  LOG_RETENTION_DAYS,
  possibleDayKeys,
  pruneLog,
  runNudges,
  type NudgeRunReport,
} from '../src/nudges/run';
import { decodeBase64Url } from '../src/push/base64url';
import { MAX_PUSH_SENDS_PER_INVOCATION, PUSH_TTL_SECONDS } from '../src/push/deliver';
import type { PushOptions, PushOutcome, PushSender } from '../src/push/sender';
import { VAPID_KEYS_CONFIG_KEY, type Vapid, type VapidEnv } from '../src/push/vapid';
import { computeSwitch, writeSwitch } from '../src/sync/switch';
import {
  HOUR,
  MIN,
  allSegments,
  countingD1,
  insertCategories,
  insertRules,
  insertSegments,
  insertSettings,
  iso,
  makeCategory,
  makeRule,
  makeSegment,
  makeSettings,
  useTestServer,
} from './harness';
import { makeBrowserSubscription } from './push-helpers';

/**
 * The scheduled nudge job end to end against the real D1, with a fake push
 * sender and a fixed clock. The last block runs the Worker's real
 * `scheduled` export.
 */

const server = useTestServer();

const DAY = 24 * HOUR;
/** Noon UTC on a weekday; with day start 04:00 UTC the logical day is 2026-03-10. */
const T = Date.parse('2026-03-10T12:00:00.000Z');
const ORIGIN = 'https://tracker.example.com';

interface SentMessage {
  endpoint: string;
  payload: PushPayload;
  options: PushOptions;
}

const ok: PushOutcome = { status: 'sent', httpStatus: 201 };

function fakeSender(answer: (endpoint: string) => PushOutcome | Promise<PushOutcome> = () => ok) {
  const sent: SentMessage[] = [];
  const sender: PushSender = {
    async send(target, payload, options) {
      sent.push({ endpoint: target.endpoint, payload, options });
      return answer(target.endpoint);
    },
  };
  return { sender, sent };
}

interface RunOptions {
  sender?: PushSender;
  env?: VapidEnv;
  d1?: D1Database;
}

/** Run the job at `nowMs` against the test database. */
async function runAt(nowMs: number, opts: RunOptions = {}) {
  const fake = fakeSender();
  const vapids: Vapid[] = [];
  const logs: NudgeRunReport[] = [];
  const report = await runNudges({
    db: createDb(opts.d1 ?? server.rawDb()),
    env: opts.env ?? {},
    senderFor: (vapid) => {
      vapids.push(vapid);
      return opts.sender ?? fake.sender;
    },
    clock: () => iso(nowMs),
    log: (r) => logs.push(r),
  });
  return { report, vapids, logs, sent: fake.sent };
}

/** Register a subscription through the API, as the app does, from ORIGIN. */
async function subscribe(endpoint?: string): Promise<{ id: string; endpoint: string }> {
  const sub = await makeBrowserSubscription(endpoint);
  const res = await server.request('POST', `${ORIGIN}/api/push/subscriptions`, {
    body: { endpoint: sub.endpoint, expirationTime: null, keys: sub.keys },
  });
  expect(res.status).toBe(201);
  return { id: pushSubscriptionResponseSchema.parse(res.json).id, endpoint: sub.endpoint };
}

async function logRows() {
  return server.db().select().from(notificationLog).orderBy(notificationLog.sentAt);
}

async function subscriptionRows() {
  return server.db().select().from(pushSubscriptions);
}

/** Switch at `atMs` with the server's own switch code, as if the request arrived then. */
async function switchAt(categoryId: string, atMs: number): Promise<string> {
  const current = (await allSegments(server.db()))
    .filter((s) => s.deletedAt === null)
    .map(({ syncedAt: _syncedAt, ...s }) => s);
  const result = computeSwitch(current, { categoryId, source: 'app' }, iso(atMs));
  await writeSwitch(server.db(), result, iso(atMs));
  if (!result.opened) throw new Error('Switch was a no-op');
  return result.opened.id;
}

/** UTC settings with the stale check off unless asked for. */
async function setup(settings: Parameters<typeof makeSettings>[0] = {}) {
  await insertSettings(server.db(), makeSettings({ staleEnabled: false, ...settings }));
  const relax = makeCategory({ name: 'Relaxing' });
  const work = makeCategory({ name: 'Contract work' });
  const sleep = makeCategory({ name: 'Sleep', exemptFromStaleCheck: true });
  await insertCategories(server.db(), [relax, work, sleep]);
  return { relax, work, sleep };
}

describe('session rules', () => {
  it('fire at the threshold, log before sending, and reach every subscription', async () => {
    const { relax } = await setup();
    const rule = makeRule(relax.id, { kind: 'session', thresholdMin: 60, repeatEveryMin: null });
    await insertRules(server.db(), [rule]);
    const open = makeSegment(relax.id, iso(T - 60 * MIN), null);
    await insertSegments(server.db(), [open]);
    const [a, b] = [await subscribe(), await subscribe()];

    const early = await runAt(T - MIN);
    expect(early.report).toMatchObject({ outcome: 'nothing_due', openSegmentId: open.id });
    expect(early.sent).toHaveLength(0);
    expect(await logRows()).toHaveLength(0);

    const due = await runAt(T);
    expect(due.report).toMatchObject({
      outcome: 'sent',
      fired: [`session:${rule.id}`],
      deferred: [],
      subscriptions: 2,
      sent: 2,
      failed: 0,
    });
    const payload = {
      title: 'Relaxing for 1h 0m',
      body: "You've been on Relaxing for 1h 0m straight. Time to switch it up.",
      tag: `session:${rule.id}`,
      data: { url: '/' },
    };
    expect(due.sent.map((m) => m.endpoint).sort()).toEqual([a.endpoint, b.endpoint].sort());
    for (const m of due.sent) {
      expect(m.payload).toEqual(payload);
      expect(m.options).toEqual({ ttlSeconds: PUSH_TTL_SECONDS, urgency: 'high' });
    }
    expect(await logRows()).toEqual([
      {
        id: expect.any(String) as string,
        kind: 'session',
        ruleId: rule.id,
        segmentId: open.id,
        dayKey: null,
        sentAt: iso(T),
        title: payload.title,
        body: payload.body,
      },
    ]);
    // Signed with the generated keys, subject from the origin the app registered from.
    expect(due.vapids).toHaveLength(1);
    expect(due.vapids[0]?.subject).toBe(ORIGIN);
    expect(decodeBase64Url(due.vapids[0]?.publicKey ?? '')?.length).toBe(65);
    for (const row of await subscriptionRows()) {
      expect(row).toMatchObject({ lastSuccessAt: iso(T), failureCount: 0 });
    }
    expect(due.logs).toEqual([due.report]);
  });

  it('do not fire twice without repeatEveryMin', async () => {
    const { relax } = await setup();
    const rule = makeRule(relax.id, { thresholdMin: 60, repeatEveryMin: null });
    await insertRules(server.db(), [rule]);
    await insertSegments(server.db(), [makeSegment(relax.id, iso(T - 60 * MIN), null)]);
    await subscribe();

    expect((await runAt(T)).report.fired).toEqual([`session:${rule.id}`]);
    for (const later of [T + MIN, T + 30 * MIN, T + 5 * HOUR]) {
      const run = await runAt(later);
      expect(run.report.outcome).toBe('nothing_due');
      expect(run.sent).toHaveLength(0);
    }
    expect(await logRows()).toHaveLength(1);
  });

  it('repeat every repeatEveryMin while still over the threshold', async () => {
    const { relax } = await setup();
    const rule = makeRule(relax.id, { thresholdMin: 60, repeatEveryMin: 30 });
    await insertRules(server.db(), [rule]);
    await insertSegments(server.db(), [makeSegment(relax.id, iso(T - 60 * MIN), null)]);
    await subscribe();

    expect((await runAt(T)).sent).toHaveLength(1);
    expect((await runAt(T + 29 * MIN)).sent).toHaveLength(0);
    const repeat = await runAt(T + 30 * MIN);
    expect(repeat.sent.map((m) => m.payload.title)).toEqual(['Relaxing for 1h 30m']);
    expect((await runAt(T + 31 * MIN)).sent).toHaveLength(0);
    expect((await logRows()).map((r) => r.sentAt)).toEqual([iso(T), iso(T + 30 * MIN)]);
  });

  it('stop after a switch, and start over for the next segment', async () => {
    const { relax, work } = await setup();
    const rule = makeRule(relax.id, { thresholdMin: 60, repeatEveryMin: 30 });
    await insertRules(server.db(), [rule]);
    const first = makeSegment(relax.id, iso(T - 60 * MIN), null);
    await insertSegments(server.db(), [first]);
    await subscribe();

    expect((await runAt(T)).sent).toHaveLength(1);
    const workId = await switchAt(work.id, T + 5 * MIN);
    const afterSwitch = await runAt(T + 30 * MIN);
    expect(afterSwitch.report).toMatchObject({ outcome: 'nothing_due', openSegmentId: workId });
    expect(afterSwitch.sent).toHaveLength(0);

    // Back to Relaxing: a new segment, so the 60 minutes start again.
    const second = await switchAt(relax.id, T + 40 * MIN);
    expect((await runAt(T + 99 * MIN)).sent).toHaveLength(0);
    const again = await runAt(T + 100 * MIN);
    expect(again.report.fired).toEqual([`session:${rule.id}`]);
    expect(again.sent[0]?.payload.title).toBe('Relaxing for 1h 0m');
    expect((await logRows()).map((r) => r.segmentId)).toEqual([first.id, second]);
  });
});

describe('daily rules', () => {
  it('count all of today including the open segment, dedupe by day, and fire again the next day', async () => {
    const { relax, work } = await setup();
    const rule = makeRule(relax.id, { kind: 'daily', thresholdMin: 90, repeatEveryMin: null });
    await insertRules(server.db(), [rule]);
    const open = makeSegment(relax.id, '2026-03-10T11:30:00.000Z', null);
    await insertSegments(server.db(), [
      // Yesterday evening: another logical day.
      makeSegment(relax.id, '2026-03-09T20:00:00.000Z', '2026-03-09T23:00:00.000Z'),
      // Started before today's 04:00 start: only 04:00 to 05:00 counts.
      makeSegment(relax.id, '2026-03-10T03:00:00.000Z', '2026-03-10T05:00:00.000Z'),
      makeSegment(work.id, '2026-03-10T05:00:00.000Z', '2026-03-10T11:30:00.000Z'),
      open,
    ]);
    await subscribe();

    // 60 + 29 minutes.
    expect((await runAt(Date.parse('2026-03-10T11:59:00.000Z'))).sent).toHaveLength(0);
    const due = await runAt(Date.parse('2026-03-10T12:00:00.000Z'));
    expect(due.report.fired).toEqual([`daily:${rule.id}`]);
    expect(due.sent[0]?.payload).toEqual({
      title: '1h 30m of Relaxing today',
      body: "That's past your 1h 30m budget for today.",
      tag: `daily:${rule.id}`,
      data: { url: '/' },
    });
    expect(await logRows()).toMatchObject([
      { kind: 'daily', ruleId: rule.id, segmentId: null, dayKey: '2026-03-10' },
    ]);
    expect((await runAt(Date.parse('2026-03-10T18:00:00.000Z'))).sent).toHaveLength(0);

    // Still relaxing the next logical day: 04:00 to 05:30 is 90 minutes of it.
    expect((await runAt(Date.parse('2026-03-11T05:29:00.000Z'))).sent).toHaveLength(0);
    const nextDay = await runAt(Date.parse('2026-03-11T05:30:00.000Z'));
    expect(nextDay.sent[0]?.payload.title).toBe('1h 30m of Relaxing today');
    expect((await logRows()).map((r) => r.dayKey)).toEqual(['2026-03-10', '2026-03-11']);
  });

  it('use the settings timezone and day start, even when the logical day is ahead of UTC', async () => {
    // Sydney is UTC+11 in March; 20:00 UTC is 07:00 the next morning there.
    const { relax } = await setup({ timezone: 'Australia/Sydney', dayStartHour: 4 });
    const rule = makeRule(relax.id, { kind: 'daily', thresholdMin: 120, repeatEveryMin: null });
    await insertRules(server.db(), [rule]);
    await insertSegments(server.db(), [
      // 02:00 to 03:30 local: the previous logical day.
      makeSegment(relax.id, '2026-03-10T15:00:00.000Z', '2026-03-10T16:30:00.000Z'),
      // From 05:00 local.
      makeSegment(relax.id, '2026-03-10T18:00:00.000Z', null),
    ]);
    await subscribe();

    expect((await runAt(Date.parse('2026-03-10T19:59:00.000Z'))).sent).toHaveLength(0);
    const due = await runAt(Date.parse('2026-03-10T20:00:00.000Z'));
    expect(due.sent).toHaveLength(1);
    expect(await logRows()).toMatchObject([{ dayKey: '2026-03-11' }]);
    expect((await runAt(Date.parse('2026-03-10T20:01:00.000Z'))).sent).toHaveLength(0);
  });
});

describe('stale check', () => {
  it('fires after staleAfterMin and repeats, but never for an exempt category', async () => {
    const { work, sleep } = await setup({
      staleEnabled: true,
      staleAfterMin: 300,
      staleRepeatMin: 60,
    });
    const open = makeSegment(work.id, iso(T - 300 * MIN), null);
    await insertSegments(server.db(), [open]);
    await subscribe();

    expect((await runAt(T - MIN)).sent).toHaveLength(0);
    const due = await runAt(T);
    expect(due.report.fired).toEqual(['stale']);
    expect(due.sent[0]?.payload).toEqual({
      title: 'Still on Contract work?',
      body: "It's been 5h 0m. Tap to update if you've moved on.",
      tag: 'stale',
      data: { url: '/' },
    });
    expect(await logRows()).toMatchObject([
      { kind: 'stale', ruleId: null, segmentId: open.id, dayKey: null },
    ]);
    expect((await runAt(T + 59 * MIN)).sent).toHaveLength(0);
    expect((await runAt(T + 60 * MIN)).sent).toHaveLength(1);

    await switchAt(sleep.id, T + 61 * MIN);
    expect((await runAt(T + 61 * MIN + 10 * HOUR)).report.outcome).toBe('nothing_due');
  });
});

describe('quiet hours', () => {
  it('suppress a rule without logging, and it fires the first minute after the window', async () => {
    const { relax } = await setup();
    const rule = makeRule(relax.id, {
      thresholdMin: 60,
      repeatEveryMin: null,
      quietStart: '11:00',
      quietEnd: '12:30',
    });
    await insertRules(server.db(), [rule]);
    await insertSegments(server.db(), [makeSegment(relax.id, iso(T - 90 * MIN), null)]);
    await subscribe();

    expect((await runAt(T)).report.outcome).toBe('nothing_due');
    expect((await runAt(T + 29 * MIN)).sent).toHaveLength(0);
    expect(await logRows()).toHaveLength(0);
    const after = await runAt(T + 30 * MIN);
    expect(after.report.fired).toEqual([`session:${rule.id}`]);
  });

  it('stale quiet hours can cross midnight', async () => {
    const { work } = await setup({
      staleEnabled: true,
      staleAfterMin: 300,
      staleRepeatMin: 60,
      staleQuietStart: '22:00',
      staleQuietEnd: '07:00',
    });
    await insertSegments(server.db(), [makeSegment(work.id, '2026-03-10T18:00:00.000Z', null)]);
    await subscribe();

    expect((await runAt(Date.parse('2026-03-10T23:00:00.000Z'))).sent).toHaveLength(0);
    expect((await runAt(Date.parse('2026-03-11T06:59:00.000Z'))).sent).toHaveLength(0);
    expect((await runAt(Date.parse('2026-03-11T07:00:00.000Z'))).report.fired).toEqual(['stale']);
  });
});

describe('subscription outcomes', () => {
  it('410 removes a subscription, 500 counts a failure, and neither stops the others', async () => {
    const { relax } = await setup();
    const rule = makeRule(relax.id, { thresholdMin: 60, repeatEveryMin: 30 });
    await insertRules(server.db(), [rule]);
    await insertSegments(server.db(), [makeSegment(relax.id, iso(T - 60 * MIN), null)]);
    const gone = await subscribe();
    const flaky = await subscribe();
    const good = await subscribe();

    const first = fakeSender((endpoint) => {
      if (endpoint === gone.endpoint) return { status: 'gone', httpStatus: 410 };
      if (endpoint === flaky.endpoint) {
        return { status: 'failed', httpStatus: 500, reason: 'HTTP 500' };
      }
      return ok;
    });
    const run = await runAt(T, { sender: first.sender });
    expect(first.sent).toHaveLength(3);
    expect(run.report).toMatchObject({ outcome: 'sent', sent: 1, failed: 2, removed: 1 });
    expect(run.report.errors.sort()).toEqual(['HTTP 410 (subscription removed)', 'HTTP 500']);
    expect(await logRows()).toHaveLength(1);
    const rows = new Map((await subscriptionRows()).map((r) => [r.id, r]));
    expect(rows.has(gone.id)).toBe(false);
    expect(rows.get(flaky.id)).toMatchObject({ failureCount: 1, lastSuccessAt: null });
    expect(rows.get(good.id)).toMatchObject({ failureCount: 0, lastSuccessAt: iso(T) });

    // A sender that throws for one subscription still reaches the other.
    const second = fakeSender((endpoint) => {
      if (endpoint === flaky.endpoint) throw new Error('boom');
      return ok;
    });
    const repeat = await runAt(T + 30 * MIN, { sender: second.sender });
    expect(repeat.report).toMatchObject({ sent: 1, failed: 1, removed: 0, errors: ['boom'] });
    expect((await subscriptionRows()).find((r) => r.id === flaky.id)).toMatchObject({
      failureCount: 2,
      lastSuccessAt: null,
    });

    // A success resets the count.
    await runAt(T + 60 * MIN);
    expect((await subscriptionRows()).find((r) => r.id === flaky.id)).toMatchObject({
      failureCount: 0,
      lastSuccessAt: iso(T + 60 * MIN),
    });
  });
});

describe('D1 and send budgets', () => {
  it('no open segment: one D1 call, nothing sent', async () => {
    await setup();
    await subscribe();
    const { d1, calls } = countingD1(server.rawDb());
    const run = await runAt(T, { d1 });
    expect(run.report).toMatchObject({ outcome: 'no_open_segment', openSegmentId: null, sent: 0 });
    expect(run.sent).toHaveLength(0);
    expect(calls()).toBe(1);
  });

  it('no subscriptions: one D1 call, nothing logged or sent', async () => {
    const { relax } = await setup();
    await insertRules(server.db(), [makeRule(relax.id, { thresholdMin: 1 })]);
    await insertSegments(server.db(), [makeSegment(relax.id, iso(T - HOUR), null)]);
    const { d1, calls } = countingD1(server.rawDb());
    const run = await runAt(T, { d1 });
    expect(run.report.outcome).toBe('no_subscriptions');
    expect(calls()).toBe(1);
    expect(await logRows()).toHaveLength(0);
  });

  it('nothing due: one D1 call', async () => {
    const { relax } = await setup();
    await insertRules(server.db(), [makeRule(relax.id, { thresholdMin: 600 })]);
    await insertSegments(server.db(), [makeSegment(relax.id, iso(T - HOUR), null)]);
    await subscribe();
    const { d1, calls } = countingD1(server.rawDb());
    expect((await runAt(T, { d1 })).report.outcome).toBe('nothing_due');
    expect(calls()).toBe(1);
  });

  it('a run that sends makes at most 4 D1 calls, 3 once the keys exist', async () => {
    const { relax } = await setup();
    await insertRules(server.db(), [
      makeRule(relax.id, { kind: 'session', thresholdMin: 60, repeatEveryMin: 30 }),
      makeRule(relax.id, { kind: 'daily', thresholdMin: 60, repeatEveryMin: 30 }),
    ]);
    await insertSegments(server.db(), [makeSegment(relax.id, iso(T - 60 * MIN), null)]);
    for (let i = 0; i < 3; i++) await subscribe();

    // First send ever: the key pair is generated and stored (one extra call).
    const first = countingD1(server.rawDb());
    const run = await runAt(T, { d1: first.d1 });
    expect(run.report).toMatchObject({ outcome: 'sent', sent: 6, deferred: [] });
    expect(first.calls()).toBe(4);
    expect(
      await server
        .db()
        .select()
        .from(serverConfig)
        .where(eq(serverConfig.key, VAPID_KEYS_CONFIG_KEY)),
    ).toHaveLength(1);

    const second = countingD1(server.rawDb());
    const repeat = await runAt(T + 30 * MIN, { d1: second.d1 });
    expect(repeat.report.sent).toBe(6);
    expect(second.calls()).toBe(3);
    // Same keys both times.
    expect(repeat.vapids[0]?.publicKey).toBe(run.vapids[0]?.publicKey);
  });

  it(`never sends more than ${MAX_PUSH_SENDS_PER_INVOCATION} messages; the rest wait a minute unlogged`, async () => {
    const { relax } = await setup({ staleEnabled: true, staleAfterMin: 60, staleRepeatMin: null });
    const session = makeRule(relax.id, { kind: 'session', thresholdMin: 60, repeatEveryMin: null });
    const daily = makeRule(relax.id, { kind: 'daily', thresholdMin: 60, repeatEveryMin: null });
    await insertRules(server.db(), [session, daily]);
    await insertSegments(server.db(), [makeSegment(relax.id, iso(T - 60 * MIN), null)]);
    for (let i = 0; i < 4; i++) await subscribe();

    // Three notifications due, four subscriptions: one notification per run.
    const fired: string[] = [];
    for (let minute = 0; minute < 3; minute++) {
      const run = await runAt(T + minute * MIN);
      expect(run.sent).toHaveLength(4);
      expect(run.report.fired).toHaveLength(1);
      expect(run.report.deferred).toHaveLength(2 - minute);
      expect(await logRows()).toHaveLength(minute + 1);
      fired.push(...run.report.fired);
    }
    expect(fired.sort()).toEqual([`daily:${daily.id}`, `session:${session.id}`, 'stale'].sort());
    expect((await runAt(T + 3 * MIN)).report.outcome).toBe('nothing_due');

    // More subscriptions than the budget: only the budget's worth are tried.
    for (let i = 0; i < 4; i++) await subscribe();
    await insertRules(server.db(), [makeRule(relax.id, { thresholdMin: 1, repeatEveryMin: null })]);
    const crowded = await runAt(T + 4 * MIN);
    expect(crowded.report.subscriptions).toBe(8);
    expect(crowded.sent).toHaveLength(MAX_PUSH_SENDS_PER_INVOCATION);
  });

  it('the per-minute reads use indexes, not table scans', async () => {
    const db = server.db();
    const plans: string[] = [];
    const queries = [
      select.openSegmentLog(db).toSQL(),
      select.dailyLog(db, possibleDayKeys(T)).toSQL(),
      select.segmentsEndingAfter(db, T - 2 * DAY).toSQL(),
      select.openSegment(db).toSQL(),
      select.openSegmentCategory(db).toSQL(),
      pruneLog(db, T, uuidv7()).toSQL(),
    ];
    for (const q of queries) {
      const rows = await server
        .rawDb()
        .prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
        .bind(...q.params)
        .all<{ detail: string }>();
      plans.push(...rows.results.map((r) => r.detail));
    }
    expect(plans.filter((d) => /USING (COVERING )?INDEX notif_kind_day/.test(d))).toHaveLength(1);
    expect(plans.filter((d) => /USING (COVERING )?INDEX notif_kind_segment/.test(d))).toHaveLength(
      1,
    );
    expect(plans.filter((d) => /USING (COVERING )?INDEX notif_sent/.test(d))).toHaveLength(1);
    for (const table of ['notification_log', 'segments', 'categories']) {
      expect(plans.filter((d) => new RegExp(`^SCAN ${table}\\b`).test(d))).toEqual([]);
    }
  });
});

describe('VAPID subject and keys', () => {
  it('without a known subject nothing is logged or sent, and it fires once one is set', async () => {
    const { relax } = await setup();
    const rule = makeRule(relax.id, { thresholdMin: 60, repeatEveryMin: null });
    await insertRules(server.db(), [rule]);
    await insertSegments(server.db(), [makeSegment(relax.id, iso(T - 60 * MIN), null)]);
    const sub = await makeBrowserSubscription();
    // Inserted directly: no request recorded an origin.
    await server
      .db()
      .insert(pushSubscriptions)
      .values({
        id: uuidv7(),
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: null,
        createdAt: iso(T - DAY),
        lastSuccessAt: null,
        failureCount: 0,
      });

    const blocked = await runAt(T);
    expect(blocked.report).toMatchObject({
      outcome: 'no_vapid_subject',
      fired: [],
      deferred: [`session:${rule.id}`],
    });
    expect(blocked.sent).toHaveLength(0);
    expect(await logRows()).toHaveLength(0);

    const env = { VAPID_SUBJECT: 'mailto:owner@example.com' };
    const sent = await runAt(T + MIN, { env });
    expect(sent.report.fired).toEqual([`session:${rule.id}`]);
    expect(sent.vapids[0]?.subject).toBe('mailto:owner@example.com');
  });

  it('VAPID secrets override the stored pair', async () => {
    const { relax } = await setup();
    await insertRules(server.db(), [
      makeRule(relax.id, { thresholdMin: 60, repeatEveryMin: null }),
    ]);
    await insertSegments(server.db(), [makeSegment(relax.id, iso(T - 60 * MIN), null)]);
    await subscribe();
    // Stores a generated pair.
    await server.get(`${ORIGIN}/api/push/vapid-public-key`);
    // RFC 8291 Appendix A's application server pair, a valid P-256 key pair.
    const env = {
      VAPID_PUBLIC_KEY:
        'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
      VAPID_PRIVATE_KEY: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    };
    const run = await runAt(T, { env });
    expect(run.vapids[0]).toEqual({
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: ORIGIN,
    });
  });
});

describe('notification log', () => {
  it('two overlapping runs (a cron delivered twice) send each notification once', async () => {
    const { relax } = await setup();
    const session = makeRule(relax.id, { kind: 'session', thresholdMin: 60, repeatEveryMin: 30 });
    const daily = makeRule(relax.id, { kind: 'daily', thresholdMin: 60, repeatEveryMin: null });
    await insertRules(server.db(), [session, daily]);
    await insertSegments(server.db(), [makeSegment(relax.id, iso(T - 60 * MIN), null)]);
    await subscribe();

    const [a, b] = await Promise.all([runAt(T), runAt(T)]);
    expect([...a.sent, ...b.sent].map((m) => m.payload.tag).sort()).toEqual(
      [`daily:${daily.id}`, `session:${session.id}`].sort(),
    );
    expect(await logRows()).toHaveLength(2);
    expect([...a.report.fired, ...b.report.fired].sort()).toEqual(
      [`daily:${daily.id}`, `session:${session.id}`].sort(),
    );

    // The repeat 30 minutes later is claimed once too.
    const [c, d] = await Promise.all([runAt(T + 30 * MIN), runAt(T + 30 * MIN)]);
    expect([...c.sent, ...d.sent].map((m) => m.payload.tag)).toEqual([`session:${session.id}`]);
    expect(await logRows()).toHaveLength(3);
  });

  it(`prunes rows older than ${LOG_RETENTION_DAYS} days when it writes, but keeps the open segment's`, async () => {
    const { relax } = await setup();
    const rule = makeRule(relax.id, { thresholdMin: 60, repeatEveryMin: null });
    await insertRules(server.db(), [rule]);
    const open = makeSegment(relax.id, iso(T - 60 * MIN), null);
    await insertSegments(server.db(), [open]);
    await subscribe();

    const old = iso(T - (LOG_RETENTION_DAYS + 1) * DAY);
    const recent = iso(T - (LOG_RETENTION_DAYS - 1) * DAY);
    const row = (
      id: string,
      sentAt: string,
      fields: { kind: 'session' | 'daily' | 'stale'; segmentId?: string; dayKey?: string },
    ) => ({
      id,
      kind: fields.kind,
      ruleId: fields.kind === 'stale' ? null : uuidv7(),
      segmentId: fields.segmentId ?? null,
      dayKey: fields.dayKey ?? null,
      sentAt,
      title: 't',
      body: 'b',
    });
    await server
      .db()
      .insert(notificationLog)
      .values([
        row('old-other-segment', old, { kind: 'session', segmentId: uuidv7() }),
        row('old-daily', old, { kind: 'daily', dayKey: '2026-01-07' }),
        row('old-open-segment', old, { kind: 'stale', segmentId: open.id }),
        row('recent-other-segment', recent, { kind: 'session', segmentId: uuidv7() }),
      ]);

    expect((await runAt(T)).report.outcome).toBe('sent');
    const ids = (await logRows()).map((r) => r.id);
    expect(ids).toContain('old-open-segment');
    expect(ids).toContain('recent-other-segment');
    expect(ids).not.toContain('old-other-segment');
    expect(ids).not.toContain('old-daily');
    expect(ids).toHaveLength(3);
  });

  it('the run report carries no endpoints or keys', async () => {
    const { relax } = await setup();
    await insertRules(server.db(), [makeRule(relax.id, { thresholdMin: 60 })]);
    await insertSegments(server.db(), [makeSegment(relax.id, iso(T - 60 * MIN), null)]);
    await subscribe();
    const failing = fakeSender(() => ({ status: 'failed', httpStatus: 403, reason: 'HTTP 403' }));
    const run = await runAt(T, { sender: failing.sender });
    const line = JSON.stringify(run.report);
    const [sub] = await subscriptionRows();
    for (const secret of [
      sub!.endpoint,
      sub!.p256dh,
      sub!.auth,
      run.vapids[0]!.privateKey,
      run.vapids[0]!.publicKey,
    ]) {
      expect(line).not.toContain(secret);
    }
  });
});

describe('possibleDayKeys', () => {
  it('always contains the logical day key, whatever the timezone and day start', () => {
    const zones = [
      'UTC',
      'Pacific/Kiritimati',
      'Etc/GMT+12',
      'Pacific/Chatham',
      'America/St_Johns',
      'Australia/Sydney',
      'America/Los_Angeles',
    ];
    for (let hour = 0; hour < 48; hour += 1) {
      const now = Date.parse('2026-03-28T00:17:00.000Z') + hour * HOUR;
      const keys = possibleDayKeys(now);
      expect(keys.length).toBeLessThanOrEqual(4);
      for (const timezone of zones) {
        for (let dayStartHour = 0; dayStartHour < 24; dayStartHour++) {
          expect(keys).toContain(dayKeyOf(now, { timezone, dayStartHour }));
        }
      }
    }
  });
});

describe('the Worker scheduled handler', () => {
  it('runs the job on the cron trigger', async () => {
    server.clearLogs();
    const idle = await server.worker().scheduled({ cron: '* * * * *', scheduledTime: new Date() });
    expect(idle.outcome).toBe('ok');
    const reports = () =>
      server
        .logs()
        .map((l) => l.message)
        .filter((m) => m.includes('"event":"nudges"'))
        .map((m) => JSON.parse(m) as NudgeRunReport);
    expect(reports().at(-1)).toMatchObject({ outcome: 'no_open_segment' });

    // Now with something due and a subscription the Worker really encrypts for.
    // Nothing listens on port 1, so the send itself fails.
    const relax = makeCategory({ name: 'Relaxing' });
    await insertCategories(server.db(), [relax]);
    const rule = makeRule(relax.id, { thresholdMin: 1, repeatEveryMin: null });
    await insertRules(server.db(), [rule]);
    const open = makeSegment(relax.id, iso(Date.now() - 2 * MIN), null);
    await insertSegments(server.db(), [open]);
    const sub = await subscribe('https://127.0.0.1:1/push');

    const busy = await server.worker().scheduled({ cron: '* * * * *', scheduledTime: new Date() });
    expect(busy.outcome).toBe('ok');
    expect(reports().at(-1)).toMatchObject({
      outcome: 'sent',
      openSegmentId: open.id,
      fired: [`session:${rule.id}`],
      sent: 0,
      failed: 1,
    });
    expect(await logRows()).toMatchObject([
      { kind: 'session', ruleId: rule.id, segmentId: open.id },
    ]);
    expect(await subscriptionRows()).toMatchObject([{ id: sub.id, failureCount: 1 }]);

    // Logged before sending, so the next minute does not send it again.
    await server.worker().scheduled({ cron: '* * * * *', scheduledTime: new Date() });
    expect(reports().at(-1)).toMatchObject({ outcome: 'nothing_due' });
    expect(toMs((await logRows())[0]!.sentAt)).toBeLessThanOrEqual(Date.now());
  });
});
