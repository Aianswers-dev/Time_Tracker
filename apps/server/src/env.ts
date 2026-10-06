/**
 * Bindings and secrets of the Worker (wrangler.toml, `wrangler secret put`,
 * `.dev.vars` locally). Secrets are optional in the type because a missing
 * secret is a deploy mistake the code must handle, not assume away.
 */
export interface Env {
  /** D1 database (wrangler.toml `[[d1_databases]]`). */
  DB: D1Database;
  /** The built PWA (wrangler.toml `[assets]`). */
  ASSETS: Fetcher;
  /** Bearer token for every /api route except /api/health. Unset or empty rejects every request. */
  AUTH_TOKEN?: string;
  /** Web Push VAPID public key, base64url (M3). */
  VAPID_PUBLIC_KEY?: string;
  /** Web Push VAPID private key, base64url (M3). Never leaves the Worker. */
  VAPID_PRIVATE_KEY?: string;
  /** Contact for push services, a `mailto:` URL (M3). */
  VAPID_SUBJECT?: string;
}

export interface AppEnv {
  Bindings: Env;
}
