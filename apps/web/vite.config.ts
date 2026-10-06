import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      // The service worker is only exercised in production builds.
      devOptions: { enabled: false },
      manifest: {
        name: 'Time Tracker',
        short_name: 'Time',
        description: 'Single-user time tracker',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        theme_color: '#0b0d12',
        background_color: '#0b0d12',
        // TODO(M1): real PNG icons (192, 512, maskable) and the Apple touch icon.
        // Until then the SVG is the only icon.
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
    }),
  ],
  build: {
    // docs/02: the PWA builds into the Worker's assets directory.
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
