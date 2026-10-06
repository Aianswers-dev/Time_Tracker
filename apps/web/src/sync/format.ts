/** "just now", "5 min ago", "today 14:05", "Mon 5 Oct, 14:05", in the device's local time. */
export function formatAgo(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  const ms = nowMs - at;
  if (ms < 45_000) return 'just now';
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} min ago`;
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date(nowMs).toDateString()) return `today ${time}`;
  const day = date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${time}`;
}

export function changesLabel(n: number): string {
  return `${n} ${n === 1 ? 'change' : 'changes'}`;
}
