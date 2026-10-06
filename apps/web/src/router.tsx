import { createBrowserRouter } from 'react-router';
import { Layout } from './components/Layout';
import { Now } from './pages/Now';
import { NotFound } from './pages/NotFound';

/**
 * Now is in the main bundle so a cold start renders it at once. The other
 * screens load on first visit; the service worker precaches their chunks, so
 * that works offline too.
 */
export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Now /> },
      {
        path: '/today',
        lazy: async () => ({ Component: (await import('./pages/Today')).Today }),
      },
      {
        path: '/stats',
        lazy: async () => ({ Component: (await import('./pages/Stats')).Stats }),
      },
      {
        path: '/settings',
        lazy: async () => ({ Component: (await import('./pages/Settings')).Settings }),
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
