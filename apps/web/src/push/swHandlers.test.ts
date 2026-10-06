import { describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_BODY,
  FALLBACK_TITLE,
  handleNotificationClick,
  handlePush,
  NOTIFICATION_ICON,
  notificationFromPush,
  safeUrl,
  type ClientsLike,
  type PushDataLike,
  type WindowClientLike,
} from './swHandlers';

const ORIGIN = 'https://time.example.workers.dev';

function data(json: () => unknown, text = ''): PushDataLike {
  return { json, text: () => text };
}

function jsonData(value: unknown): PushDataLike {
  const raw = JSON.stringify(value);
  return data(() => JSON.parse(raw) as unknown, raw);
}

function textData(raw: string): PushDataLike {
  return data(() => JSON.parse(raw) as unknown, raw);
}

function target() {
  return {
    showNotification: vi.fn((_title: string, _options?: NotificationOptions) => Promise.resolve()),
  };
}

describe('push handler', () => {
  it('shows a well-formed payload as sent', async () => {
    const reg = target();
    await handlePush(
      jsonData({
        title: 'Relaxing for 1h 0m',
        body: "You've been on Relaxing for 1h 0m straight. Time to switch it up.",
        tag: 'session:abc',
        data: { url: '/' },
      }),
      reg,
      ORIGIN,
    );
    expect(reg.showNotification).toHaveBeenCalledWith('Relaxing for 1h 0m', {
      body: "You've been on Relaxing for 1h 0m straight. Time to switch it up.",
      tag: 'session:abc',
      data: { url: '/' },
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
    });
  });

  it.each([
    ['no data at all', null],
    ['invalid JSON with empty text', textData('')],
    ['JSON null', jsonData(null)],
    ['a JSON array', jsonData([1, 2])],
    ['a JSON string', jsonData('hello')],
    ['wrong field types', jsonData({ title: 42, body: { x: 1 }, tag: [], data: 'x' })],
    ['blank strings', jsonData({ title: '   ', body: '' })],
    [
      'json() and text() both throwing',
      data(() => {
        throw new Error('bad');
      }, ''),
    ],
  ])('still shows a notification for %s', async (_name, payload) => {
    const reg = target();
    await handlePush(payload, reg, ORIGIN);
    expect(reg.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = reg.showNotification.mock.calls[0] ?? [];
    expect(title).toBe(FALLBACK_TITLE);
    expect(options?.body).toBe(FALLBACK_BODY);
    expect(options?.data).toEqual({ url: '/' });
    expect(options?.tag).toBeUndefined();
  });

  it('shows plain text as the body', () => {
    const shown = notificationFromPush(textData('Still on Relaxing?'), ORIGIN);
    expect(shown.title).toBe(FALLBACK_TITLE);
    expect(shown.options.body).toBe('Still on Relaxing?');
  });

  it('keeps the valid fields of a partial payload', () => {
    const shown = notificationFromPush(jsonData({ title: 'Still on Housework?' }), ORIGIN);
    expect(shown.title).toBe('Still on Housework?');
    expect(shown.options.body).toBe(FALLBACK_BODY);
    expect(shown.options.data.url).toBe('/');
  });

  it('caps very long text', () => {
    const shown = notificationFromPush(
      jsonData({ title: 't'.repeat(500), body: 'b'.repeat(5000) }),
      ORIGIN,
    );
    expect(shown.title.length).toBeLessThanOrEqual(120);
    expect(shown.options.body?.length).toBeLessThanOrEqual(400);
  });

  it('falls back to a plain notification when showing the payload fails', async () => {
    const reg = target();
    reg.showNotification.mockRejectedValueOnce(new TypeError('bad options'));
    await handlePush(
      jsonData({ title: 'x', body: 'y', tag: 't', data: { url: '/' } }),
      reg,
      ORIGIN,
    );
    expect(reg.showNotification).toHaveBeenCalledTimes(2);
    expect(reg.showNotification.mock.calls[1]?.[0]).toBe(FALLBACK_TITLE);
  });
});

describe('safeUrl', () => {
  it('keeps same-origin paths and drops everything else', () => {
    expect(safeUrl('/today?d=2026-10-06#x', ORIGIN)).toBe('/today?d=2026-10-06#x');
    expect(safeUrl(`${ORIGIN}/stats`, ORIGIN)).toBe('/stats');
    expect(safeUrl('https://evil.example/', ORIGIN)).toBe('/');
    expect(safeUrl('//evil.example/x', ORIGIN)).toBe('/');
    expect(safeUrl('javascript:alert(1)', ORIGIN)).toBe('/');
    expect(safeUrl(undefined, ORIGIN)).toBe('/');
    expect(safeUrl(42, ORIGIN)).toBe('/');
  });
});

describe('notificationclick handler', () => {
  function client(url: string, focused = false) {
    return {
      url,
      focused,
      focus: vi.fn(() => Promise.resolve<unknown>(undefined)),
      navigate: vi.fn((_url: string) => Promise.resolve<unknown>(undefined)),
    };
  }

  function clients(windows: WindowClientLike[]) {
    return {
      matchAll: vi.fn(() => Promise.resolve(windows)),
      openWindow: vi.fn(() => Promise.resolve(undefined)),
    } satisfies ClientsLike;
  }

  it('closes the notification, focuses the open app and navigates it', async () => {
    const close = vi.fn();
    const app = client(`${ORIGIN}/settings`);
    const all = clients([app]);
    await handleNotificationClick({ data: { url: '/' }, close }, all, ORIGIN);
    expect(close).toHaveBeenCalled();
    expect(all.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(app.focus).toHaveBeenCalled();
    expect(app.navigate).toHaveBeenCalledWith(`${ORIGIN}/`);
    expect(all.openWindow).not.toHaveBeenCalled();
  });

  it('prefers the focused window and does not reload it when already there', async () => {
    const background = client(`${ORIGIN}/today`);
    const front = client(`${ORIGIN}/`, true);
    await handleNotificationClick(
      { data: { url: '/' }, close: vi.fn() },
      clients([background, front]),
      ORIGIN,
    );
    expect(front.focus).toHaveBeenCalled();
    expect(front.navigate).not.toHaveBeenCalled();
    expect(background.focus).not.toHaveBeenCalled();
  });

  it('opens the app when no window is open', async () => {
    const all = clients([]);
    await handleNotificationClick({ data: { url: '/today' }, close: vi.fn() }, all, ORIGIN);
    expect(all.openWindow).toHaveBeenCalledWith(`${ORIGIN}/today`);
  });

  it('opens the Now screen for missing or foreign urls', async () => {
    const all = clients([]);
    await handleNotificationClick({ data: null, close: vi.fn() }, all, ORIGIN);
    await handleNotificationClick(
      { data: { url: 'https://evil.example' }, close: vi.fn() },
      all,
      ORIGIN,
    );
    expect(all.openWindow.mock.calls).toEqual([[`${ORIGIN}/`], [`${ORIGIN}/`]]);
  });

  it('opens a window when focusing fails, and survives a failed navigate', async () => {
    const stuck = client(`${ORIGIN}/settings`);
    stuck.focus.mockRejectedValueOnce(new Error('not allowed'));
    const all = clients([stuck]);
    await handleNotificationClick({ data: { url: '/' }, close: vi.fn() }, all, ORIGIN);
    expect(all.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);

    const uncontrolled = client(`${ORIGIN}/settings`);
    uncontrolled.navigate.mockRejectedValueOnce(new TypeError('not controlled'));
    await expect(
      handleNotificationClick(
        { data: { url: '/' }, close: vi.fn() },
        clients([uncontrolled]),
        ORIGIN,
      ),
    ).resolves.toBeUndefined();
  });
});
