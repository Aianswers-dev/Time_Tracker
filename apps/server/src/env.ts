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
  /**
   * Optional Web Push VAPID public key, base64url (raw 65-byte point). Used only
   * when VAPID_PRIVATE_KEY is set too; otherwise the Worker generates a pair
   * once and keeps it in `server_config` (src/push/vapid.ts).
   */
  VAPID_PUBLIC_KEY?: string;
  /** Optional VAPID private key, base64url (32-byte scalar). Never leaves the Worker. */
  VAPID_PRIVATE_KEY?: string;
  /**
   * Optional VAPID subject, a `mailto:` or `https:` URL. Default: `https://` plus
   * the host the app registered its subscription from.
   */
  VAPID_SUBJECT?: string;
}

export interface AppEnv {
  Bindings: Env;
}
