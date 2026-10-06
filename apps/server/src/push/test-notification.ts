import type { PushTestResponse } from '@time-tracker/shared';
import type { Db } from '../db/client';
import { select } from '../db/queries';
import { deliver, NUDGE_PUSH_OPTIONS, pickTargets, pushPayload } from './deliver';
import type { PushSender } from './sender';
import { recordOrigin, resolveVapid, type Vapid, type VapidEnv } from './vapid';

export const TEST_PAYLOAD = pushPayload({
  title: 'Test notification',
  body: 'Notifications from Time Tracker are working.',
  tag: 'test',
});

export interface TestNotificationDeps {
  db: Db;
  env: VapidEnv;
  senderFor: (vapid: Vapid) => PushSender;
  /** The request's URL, recorded as the origin (the default VAPID subject). */
  requestUrl: string;
  now: string;
}

/**
 * `POST /api/push/test`: one "Test notification" to every subscription (at
 * most MAX_PUSH_SENDS_PER_INVOCATION of them). Two D1 calls, three the very
 * first time keys are generated: read, (keys), record outcomes.
 */
export async function sendTestNotification(deps: TestNotificationDeps): Promise<PushTestResponse> {
  const { db, now } = deps;
  const [, configRows, subscriptionRows] = await db.batch([
    recordOrigin(db, deps.requestUrl, now),
    select.serverConfig(db),
    select.pushSubscriptions(db),
  ]);
  if (subscriptionRows.length === 0) return { sent: 0, failed: 0 };

  const vapid = await resolveVapid(db, deps.env, configRows, now);
  // The origin was recorded in the same batch, so there is always a subject.
  if (!vapid) throw new Error('No VAPID subject');

  const report = await deliver(
    db,
    deps.senderFor(vapid),
    pickTargets(subscriptionRows),
    [TEST_PAYLOAD],
    NUDGE_PUSH_OPTIONS,
    now,
  );
  console.log(
    JSON.stringify({
      event: 'push_test',
      subscriptions: subscriptionRows.length,
      sent: report.sent,
      failed: report.failed,
      removed: report.removed,
      errors: report.errors,
    }),
  );
  return { sent: report.sent, failed: report.failed };
}
