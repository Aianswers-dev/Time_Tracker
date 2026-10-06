import {
  DAY_MS,
  HOUR_MS,
  dayKeyOf,
  evaluateRules,
  todayMsFor,
  toIso,
  toMs,
  uuidv7,
  type PendingNotification,
} from '@time-tracker/shared';
import { and, isNull, lt, ne, or } from 'drizzle-orm';
import { runBatch, type Db, type Statement } from '../db/client';
import {
  categoryFromRow,
  notificationLogFromRow,
  ruleFromRow,
  segmentFromRow,
} from '../db/mapping';
import { firstSegment, firstSettings, orDefaultSettings, select } from '../db/queries';
import { notificationLog } from '../db/schema';
import {
  deliver,
  MAX_PUSH_SENDS_PER_INVOCATION,
  NUDGE_PUSH_OPTIONS,
  pickTargets,
  pushPayload,
  type DeliveryReport,
} from '../push/deliver';
import type { PushSender } from '../push/sender';
import { resolveVapid, type Vapid, type VapidEnv } from '../push/vapid';
import type { Clock } from '../sync/ops';

/**
 * The once-a-minute nudge job (docs/02 "Nudge evaluation"). All rule logic is
 * the shared `evaluateRules`; this module gathers its inputs, logs what it
 * returns and sends it.
 *
 * D1 calls per run (the Free plan allows 50):
 * 1. One read batch with everything the rule engine needs, plus the push
 *    subscriptions and `server_config`. With no open segment, no
 *    subscriptions or nothing due, the run ends here.
 * 2. Only the first time ever, and only without VAPID secrets: store a new
 *    key pair. (Registering a subscription fetches the key first, so this
 *    has normally happened already.)
 * 3. One write batch: a `notification_log` row per notification, written
 *    before anything is sent so a crash mid-send cannot cause a duplicate next
 *    minute, plus pruning log rows older than LOG_RETENTION_DAYS.
 * 4. One batch recording each subscription's outcome.
 *
 * Sends (subrequests) are capped at MAX_PUSH_SENDS_PER_INVOCATION. When more
 * notifications are due than fit, the rest are neither logged nor sent, so the
 * next minute picks them up.
 */

/** Log rows older than this are deleted when new ones are written. */
export const LOG_RETENTION_DAYS = 60;

/**
 * How far back the read looks for today's segments. A logical day is at most
 * 25 hours long and contains now, so it starts less than this long ago.
 */
const TODAY_LOOKBACK_MS = 2 * DAY_MS;

/**
 * Every logical day key `nowMs` can have under any settings: offsets run from
 * UTC-12 to UTC+14 and the day can start at any hour, so the key is a UTC date
 * between 35 hours before and 14 hours after now. The read uses these before
 * it knows the settings; the rule engine ignores rows for other days.
 */
export function possibleDayKeys(nowMs: number): string[] {
  const keys = new Set<string>();
  for (let h = -35; h <= 14; h++) keys.add(toIso(nowMs + h * HOUR_MS).slice(0, 10));
  return [...keys];
}

export type NudgeOutcome =
  | 'no_open_segment'
  | 'no_subscriptions'
  | 'nothing_due'
  | 'no_vapid_subject'
  | 'sent';

/** The structured line each run logs. No tokens, keys or endpoints. */
export interface NudgeRunReport {
  event: 'nudges';
  outcome: NudgeOutcome;
  now: string;
  openSegmentId: string | null;
  /** Tags of the notifications logged and sent: "session:<ruleId>", "daily:<ruleId>", "stale". */
  fired: string[];
  /** Tags that were due but over this run's send budget; tried again next minute. */
  deferred: string[];
  subscriptions: number;
  sent: number;
  failed: number;
  removed: number;
  errors: string[];
}

export interface NudgeRunDeps {
  db: Db;
  env: VapidEnv;
  /** The sender for this run, given the resolved VAPID keys and subject. */
  senderFor: (vapid: Vapid) => PushSender;
  clock: Clock;
  /** Where the run's report goes. Default: one JSON line on stdout. */
  log?: (report: NudgeRunReport) => void;
}

function logRow(p: PendingNotification, now: string, nowMs: number) {
  return {
    id: uuidv7(nowMs),
    kind: p.kind,
    ruleId: p.ruleId,
    segmentId: p.segmentId,
    dayKey: p.dayKey,
    sentAt: now,
    title: p.title,
    body: p.body,
  };
}

/**
 * Delete log rows older than LOG_RETENTION_DAYS (index notif_sent), except
 * the open segment's: a segment left running for months still dedupes.
 */
export function pruneLog(db: Db, nowMs: number, openSegmentId: string) {
  return db
    .delete(notificationLog)
    .where(
      and(
        lt(notificationLog.sentAt, toIso(nowMs - LOG_RETENTION_DAYS * DAY_MS)),
        or(isNull(notificationLog.segmentId), ne(notificationLog.segmentId, openSegmentId)),
      ),
    );
}

export async function runNudges(deps: NudgeRunDeps): Promise<NudgeRunReport> {
  const { db } = deps;
  const now = deps.clock();
  const nowMs = toMs(now);
  const report: NudgeRunReport = {
    event: 'nudges',
    outcome: 'nothing_due',
    now,
    openSegmentId: null,
    fired: [],
    deferred: [],
    subscriptions: 0,
    sent: 0,
    failed: 0,
    removed: 0,
    errors: [],
  };
  const finish = (outcome: NudgeOutcome): NudgeRunReport => {
    report.outcome = outcome;
    (deps.log ?? ((r) => console.log(JSON.stringify(r))))(report);
    return report;
  };

  // 1. One read batch: one consistent view, one D1 call.
  const [
    settingsRows,
    openRows,
    categoryRows,
    ruleRows,
    segmentLogRows,
    dailyLogRows,
    recentRows,
    subscriptionRows,
    configRows,
  ] = await db.batch([
    select.settings(db),
    select.openSegment(db),
    select.openSegmentCategory(db),
    select.openSegmentRules(db),
    select.openSegmentLog(db),
    select.dailyLog(db, possibleDayKeys(nowMs)),
    select.segmentsEndingAfter(db, nowMs - TODAY_LOOKBACK_MS),
    select.pushSubscriptions(db),
    select.serverConfig(db),
  ]);

  const open = firstSegment(openRows);
  report.openSegmentId = open?.id ?? null;
  report.subscriptions = subscriptionRows.length;
  if (!open) return finish('no_open_segment');
  if (subscriptionRows.length === 0) return finish('no_subscriptions');

  const settings = orDefaultSettings(firstSettings(settingsRows));
  const categoryRow = categoryRows[0];
  const dayKey = dayKeyOf(nowMs, settings);
  const pending = evaluateRules({
    now,
    settings,
    openSegment: open,
    category: categoryRow ? categoryFromRow(categoryRow) : null,
    rules: ruleRows.map(ruleFromRow),
    todayMs: todayMsFor(recentRows.map(segmentFromRow), open.categoryId, dayKey, settings, nowMs),
    log: [...segmentLogRows, ...dailyLogRows].map(notificationLogFromRow),
  });
  if (pending.length === 0) return finish('nothing_due');

  // 2. Keys and subject. Without a subject nothing is logged, so the
  // notifications fire once the app has registered from a known origin.
  const vapid = await resolveVapid(db, deps.env, configRows, now);
  if (!vapid) {
    report.deferred = pending.map((p) => p.tag);
    return finish('no_vapid_subject');
  }

  // Stay within the send budget: every target gets the same notifications.
  const targets = pickTargets(subscriptionRows);
  const perTarget = Math.max(1, Math.floor(MAX_PUSH_SENDS_PER_INVOCATION / targets.length));
  const toSend = pending.slice(0, perTarget);
  report.fired = toSend.map((p) => p.tag);
  report.deferred = pending.slice(perTarget).map((p) => p.tag);

  // 3. Log first, prune in the same batch.
  const writes: Statement[] = toSend.map((p) =>
    db.insert(notificationLog).values(logRow(p, now, nowMs)),
  );
  writes.push(pruneLog(db, nowMs, open.id));
  await runBatch(db, writes);

  // 4. Send, then record each subscription's outcome.
  const delivery: DeliveryReport = await deliver(
    db,
    deps.senderFor(vapid),
    targets,
    toSend.map(pushPayload),
    NUDGE_PUSH_OPTIONS,
    now,
  );
  report.sent = delivery.sent;
  report.failed = delivery.failed;
  report.removed = delivery.removed;
  report.errors = delivery.errors;
  return finish('sent');
}
