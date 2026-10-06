import { runPushHealthCheck } from './health';

/**
 * Check the push subscription at launch and whenever the app comes back to
 * the foreground (docs/06, step 5). main.tsx loads this lazily, which keeps
 * the push code out of the Now screen's bundle.
 */
export function watchPushHealth(): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible') void runPushHealthCheck();
  };
  void runPushHealthCheck();
  document.addEventListener('visibilitychange', onVisible);
  return () => document.removeEventListener('visibilitychange', onVisible);
}
