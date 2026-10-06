/** Labels for the notifications status in Settings. */

const dateFmt = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** "just now", "5 min ago", "3 h ago", or a date and time for anything older than a day. */
export function timeAgo(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'unknown';
  const min = Math.floor((nowMs - ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return dateFmt.format(ms);
}

/** "iPhone", "Chrome on Mac" and so on, from a subscription's user agent. */
export function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  const os = /Android/.test(ua)
    ? 'Android'
    : /Mac OS X|Macintosh/.test(ua)
      ? 'Mac'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Linux|CrOS/.test(ua)
          ? 'Linux'
          : null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'Unknown device';
}

/** iPhone or iPad, where permission is managed in the iOS Settings app. */
export function isAppleMobile(userAgent: string): boolean {
  return /iPhone|iPad|iPod/.test(userAgent);
}
