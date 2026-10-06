import { app } from './app';
import { createDb } from './db/client';
import type { Env } from './env';
import { runNudges } from './nudges/run';
import { webPushSender } from './push/sender';
import { systemClock } from './sync/ops';

export { app };
export type { Env };

export default {
  fetch: app.fetch,

  /** The once-a-minute cron (wrangler.toml `crons`): evaluate nudge rules and send pushes. */
  async scheduled(_controller, env) {
    try {
      await runNudges({
        db: createDb(env.DB),
        env,
        senderFor: (vapid) => webPushSender(vapid),
        clock: systemClock,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(
        JSON.stringify({
          event: 'nudges',
          level: 'error',
          message: error.message,
          stack: error.stack,
        }),
      );
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
