// Dev server for the bus preview only (no HMR, so other subsystems' edits
// don't reload the page mid-screenshot):
//   npx vite --config src/bus/vite.preview.config.mjs --port 5176 --strictPort
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  server: { hmr: false, watch: { ignored: ['**/src/world/**', '**/src/game/**', '**/src/sim/**', '**/public/**'] } },
});
