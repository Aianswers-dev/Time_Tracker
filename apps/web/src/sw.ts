/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { handleNotificationClick, handlePush } from './push/swHandlers';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

// registerType 'autoUpdate': a new worker activates immediately and takes over open pages.
void self.skipWaiting();
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// App shell for offline navigations. Both routes live on workbox's single router, so each
// request gets exactly one handler. /api/* is never answered from the cache.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }),
);

// Push (docs/06): every push shows a notification, even a malformed one, because
// iOS punishes a push that shows nothing. The logic lives in push/swHandlers.ts.
self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event.data, self.registration, self.location.origin));
});

// Tapping a nudge focuses the app (or opens it) on the payload's data.url.
// No action buttons: iOS ignores them.
self.addEventListener('notificationclick', (event) => {
  event.waitUntil(handleNotificationClick(event.notification, self.clients, self.location.origin));
});
