import { useEffect, useState } from 'react';

/**
 * The current time in epoch ms, refreshed every `intervalMs` so clocks
 * re-render. It only drives rendering: elapsed time is always computed from
 * timestamps, never counted. Ticks align to interval boundaries (so a 1 s clock
 * changes on the second) and pause while the page is hidden; the value is
 * refreshed immediately when the page becomes visible again, and whenever
 * `syncKey` changes (for example the running entry's start), so a clock never
 * shows a stale value after an action.
 */
export function useNow(intervalMs = 1000, syncKey?: unknown): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      setNow(Date.now());
      schedule();
    };

    function schedule(delay?: number) {
      clearTimeout(timer);
      if (document.hidden) return;
      timer = setTimeout(tick, delay ?? intervalMs - (Date.now() % intervalMs) + 5);
    }

    const onVisibility = () => {
      if (!document.hidden) schedule(0);
      else clearTimeout(timer);
    };

    schedule(0);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, [intervalMs, syncKey]);

  return now;
}
