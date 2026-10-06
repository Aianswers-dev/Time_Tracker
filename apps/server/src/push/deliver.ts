import { pushPayloadSchema, type PushPayload } from '@time-tracker/shared';
import { eq, sql } from 'drizzle-orm';
import { runBatch, type Db, type Statement } from '../db/client';
import { pushSubscriptions, type PushSubscriptionRow } from '../db/schema';
import type { PushOptions, PushOutcome, PushSender } from './sender';

/**
 * Sending payloads to stored subscriptions and recording how each went.
 *
 * Budget: each send is one subrequest and costs about 3 ms of CPU for the
 * ECDH, AES-GCM and ECDSA work. The Workers Free plan allows 50 subrequests
 * and 10 ms of CPU per invocation, so one invocation makes at most
 * MAX_PUSH_SENDS_PER_INVOCATION sends. With one phone subscribed that is every
 * nudge a minute can produce (session, daily and stale); anything beyond waits
 * a minute.
 */
export const MAX_PUSH_SENDS_PER_INVOCATION = 3;

/** Nudges are stale after a while; a push service drops them after this. */
export const PUSH_TTL_SECONDS = 15 * 60;

export const NUDGE_PUSH_OPTIONS: PushOptions = { ttlSeconds: PUSH_TTL_SECONDS, urgency: 'high' };

/** Every notification opens the app at its root. */
export function pushPayload(n: { title: string; body: string; tag: string }): PushPayload {
  return pushPayloadSchema.parse({ title: n.title, body: n.body, tag: n.tag, data: { url: '/' } });
}

/**
 * At most `max` subscriptions, the ones most likely to work first: fewest
 * recent failures, then most recent success, then newest. In practice there
 * are one or two and all are kept.
 */
export function pickTargets(
  subscriptions: readonly PushSubscriptionRow[],
  max: number = MAX_PUSH_SENDS_PER_INVOCATION,
): PushSubscriptionRow[] {
  return [...subscriptions]
    .sort(
      (a, b) =>
        a.failureCount - b.failureCount ||
        (b.lastSuccessAt ?? '').localeCompare(a.lastSuccessAt ?? '') ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, Math.max(0, max));
}

export interface DeliveryReport {
  /** Messages a push service accepted. */
  sent: number;
  /** Messages that were not accepted, including ones to removed subscriptions. */
  failed: number;
  /** Subscriptions deleted because the push service answered 404 or 410. */
  removed: number;
  /** One line per failed message, e.g. "HTTP 403 {\"reason\":\"BadJwtToken\"}". No endpoints or keys. */
  errors: string[];
}

/**
 * The bookkeeping for one subscription after this invocation's sends:
 * - 404 or 410: delete it.
 * - Otherwise `failure_count` counts failed sends since the last success, and
 *   `last_success_at` is set when any send succeeded.
 */
function recordOutcomes(
  db: Db,
  sub: PushSubscriptionRow,
  outcomes: readonly PushOutcome[],
  now: string,
): Statement[] {
  if (outcomes.length === 0) return [];
  const byId = eq(pushSubscriptions.id, sub.id);
  if (outcomes.some((o) => o.status === 'gone')) {
    return [db.delete(pushSubscriptions).where(byId)];
  }
  const lastSuccess = outcomes.findLastIndex((o) => o.status === 'sent');
  if (lastSuccess === -1) {
    return [
      db
        .update(pushSubscriptions)
        .set({ failureCount: sql`${pushSubscriptions.failureCount} + ${outcomes.length}` })
        .where(byId),
    ];
  }
  return [
    db
      .update(pushSubscriptions)
      .set({ lastSuccessAt: now, failureCount: outcomes.length - 1 - lastSuccess })
      .where(byId),
  ];
}

/**
 * Send every payload to every target and record the results in one D1 batch.
 * Targets are served in parallel, payloads to one target in order. One bad
 * subscription never stops the others; a gone one gets nothing further.
 * The caller keeps `targets.length * payloads.length` within the budget.
 */
export async function deliver(
  db: Db,
  sender: PushSender,
  targets: readonly PushSubscriptionRow[],
  payloads: readonly PushPayload[],
  options: PushOptions,
  now: string,
): Promise<DeliveryReport> {
  const results = await Promise.all(
    targets.map(async (sub) => {
      const outcomes: PushOutcome[] = [];
      for (const payload of payloads) {
        let outcome: PushOutcome;
        try {
          outcome = await sender.send(
            { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
            payload,
            options,
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          outcome = { status: 'failed', httpStatus: null, reason };
        }
        outcomes.push(outcome);
        if (outcome.status === 'gone') break;
      }
      return { sub, outcomes };
    }),
  );

  const report: DeliveryReport = { sent: 0, failed: 0, removed: 0, errors: [] };
  for (const { outcomes } of results) {
    // Payloads skipped after a 404/410 were not delivered either.
    const skipped = payloads.length - outcomes.length;
    report.failed += skipped;
    for (const o of outcomes) {
      if (o.status === 'sent') report.sent += 1;
      else report.failed += 1;
      if (o.status === 'gone') report.removed += 1;
      if (o.status === 'failed') report.errors.push(o.reason);
      if (o.status === 'gone') report.errors.push(`HTTP ${o.httpStatus} (subscription removed)`);
    }
  }

  await runBatch(
    db,
    results.flatMap(({ sub, outcomes }) => recordOutcomes(db, sub, outcomes, now)),
  );
  return report;
}
