import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { ensureSeeded } from './data/seed';
import './index.css';
import { router } from './router';

if (import.meta.env.PROD) {
  void import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}

// First-run seed. Idempotent, so it runs on every start; screens render once
// their live queries see the seeded rows.
ensureSeeded().catch((err: unknown) => {
  console.error('Seeding failed', err);
});

// M3: keep this phone's push subscription registered (iOS can drop it). Lazy, off the Now chunk.
void import('./push/watch').then((m) => m.watchPushHealth(), console.error);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
