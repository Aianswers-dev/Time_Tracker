import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * wrangler.toml points `[assets]` at `public/`, which only exists after the web
 * build. Wrangler refuses to start without it, so make sure it exists.
 */
export default function setup(): void {
  mkdirSync(join(import.meta.dirname, '..', 'public'), { recursive: true });
}
