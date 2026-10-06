import { checkPushHealth, type PushHealth } from './push';

/**
 * The latest `checkPushHealth` result, shared by the launch and foreground
 * checks (`watch.ts`) and Settings, so Settings can show a failure the
 * background check could not fix. One check at a time.
 */

let last: PushHealth | null = null;
let running: Promise<PushHealth> | null = null;
const listeners = new Set<() => void>();

export function runPushHealthCheck(): Promise<PushHealth> {
  running ??= checkPushHealth()
    .then((health) => {
      last = health;
      for (const listener of listeners) listener();
      return health;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/** The latest result, or null before the first check finished. */
export function lastPushHealth(): PushHealth | null {
  return last;
}

export function subscribePushHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
