import { ApiError } from '../api/client';

/**
 * Every way turning on or keeping push notifications can fail, each with a
 * message the Settings screen shows as is. Nothing in src/push fails silently.
 */
export type PushErrorCode =
  | 'unsupported'
  | 'denied'
  | 'dismissed'
  | 'not_connected'
  | 'no_worker'
  | 'bad_key'
  | 'subscribe_failed'
  | 'unsubscribe_failed'
  | 'server';

const MESSAGES: Record<Exclude<PushErrorCode, 'server'>, string> = {
  unsupported: 'This browser can’t receive push notifications.',
  denied:
    'Notifications are blocked. Turn them on in iOS Settings → Notifications → Time Tracker, then come back here.',
  dismissed: 'Notifications weren’t allowed. Tap the switch again and choose Allow.',
  not_connected: 'Connect to your server first, in Sync.',
  no_worker:
    'The app’s background worker isn’t running yet. Close the app completely, reopen it and try again.',
  bad_key:
    'The server’s push key doesn’t look right. Check VAPID_PUBLIC_KEY on the server (docs/07, owner setup).',
  subscribe_failed: 'This phone refused to set up push notifications.',
  unsubscribe_failed: 'This phone couldn’t turn push notifications off. Try again.',
};

export class PushError extends Error {
  readonly code: PushErrorCode;
  constructor(code: PushErrorCode, message?: string) {
    super(message ?? (code === 'server' ? 'The server refused the request.' : MESSAGES[code]));
    this.name = 'PushError';
    this.code = code;
  }
}

/** Turn an API failure on a push route into a message about notifications. */
export function pushErrorFromApi(err: unknown): PushError {
  if (err instanceof PushError) return err;
  if (!(err instanceof ApiError)) {
    return new PushError('server', err instanceof Error ? err.message : 'Something went wrong.');
  }
  switch (err.code) {
    case 'not_connected':
      return new PushError('not_connected');
    case 'network':
      return new PushError('server', 'Can’t reach your server. Try again when you’re online.');
    case 'unauthorized':
      return new PushError('server', 'Your server rejected the token. Check it in Sync.');
    case 'not_found':
      return new PushError(
        'server',
        'Your server doesn’t have notifications yet. Deploy the latest version, then try again.',
      );
    case 'bad_response':
      return new PushError('server', 'Your server sent something unexpected.');
    default:
      return new PushError(
        'server',
        err.retryable ? `Your server had a problem (${err.message}). Try again.` : err.message,
      );
  }
}
