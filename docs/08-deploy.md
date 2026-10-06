# 08 · Deploy and install

How to get the app onto your iPhone. Everything here works from a phone
browser; no computer is needed. It is free: the app runs inside Cloudflare's
free tier.

You do this once. After that, every change merged into `main` deploys itself.

## What you need

- A free Cloudflare account.
- This GitHub repository.
- About 15 minutes.

## 1. Set up Cloudflare

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
2. In the dashboard, open **Workers & Pages** once. The first visit asks you
   to pick your `workers.dev` subdomain (for example `yourname`). Pick one.
   Your app will live at `https://time-tracker.<subdomain>.workers.dev`.
3. Find your **Account ID**: on the **Workers & Pages** overview it is in the
   right-hand column (or on the account home page under the account name).
   Copy it somewhere for step 3.
4. Create an **API token** for GitHub to deploy with:
   1. Open **My Profile → API Tokens → Create Token**.
   2. Next to **Edit Cloudflare Workers**, tap **Use template**.
   3. Under **Permissions**, tap **Add more** and add
      **Account → D1 → Edit**. The app's database needs it.
   4. Under **Account Resources**, choose your account.
   5. Under **Zone Resources**, **All zones** is fine (the app uses no
      domains of its own).
   6. **Continue to summary → Create Token**, then copy the token. Cloudflare
      shows it only once.

## 2. Choose your app password

The app has one password, called the token. The phone app, Shortcuts and the
widget all send it, and the server rejects anything without it.

Generate a long random one with your password manager (32 characters or more)
and save it there. You will paste it into the app later.

## 3. Add three secrets to GitHub

In this repository on GitHub: **Settings → Secrets and variables → Actions →
New repository secret**. Add:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the API token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | the Account ID from step 1 |
| `APP_TOKEN` | your app password from step 2 |

## 4. Deploy

1. Open the **Actions** tab, pick **Deploy** on the left, tap **Run workflow**
   and run it on `main`.
2. It takes about two minutes. It builds the app, creates the database on the
   first run, applies database updates, deploys, and checks the app answers.
3. When it finishes, open the run. The summary shows your app's address.

From now on the **Deploy** workflow also runs by itself after every merge into
`main`. If the three secrets are missing it skips quietly instead of failing.

## 5. Install on your iPhone

1. Open the app's address in **Safari** (not another browser).
2. Tap **Share → Add to Home Screen → Add**.
3. Open **Time** from your Home Screen. Always use this icon, not Safari:
   notifications only work in the installed app.
4. Go to **Settings → Sync**, paste your app password and tap **Connect**.
5. Go to **Settings → Notifications**, turn on **Nudges on this phone** and
   allow notifications. Tap **Send test notification** to check.
6. Pick what you are doing on the **Now** screen. Tracking has started.

## 6. Optional extras

- **Siri and automations** ("I'm relaxing", switch to Sleep when Sleep Focus
  turns on): see the Shortcuts recipes in [06-ios.md](06-ios.md).
- **Home Screen and Lock Screen widget** with Scriptable: also in
  [06-ios.md](06-ios.md).

## Changing your app password

1. Update the `APP_TOKEN` secret on GitHub.
2. Run the **Deploy** workflow again.
3. Paste the new password in the app (**Settings → Sync**), in each Shortcut
   and in the widget script.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Deploy says "Deploy skipped: add these repository secrets" | One of the three secrets is missing or misspelled. Names must match exactly. |
| Deploy fails at "Find or create the database" | The API token lacks **D1 → Edit**. Edit the token in Cloudflare and add it. |
| Deploy fails mentioning a `workers.dev` subdomain | Open **Workers & Pages** in the Cloudflare dashboard once and pick a subdomain, then run Deploy again. |
| Deploy fails with an authentication error | The API token or Account ID is wrong, or the token was deleted. Create a new token and update the secret. |
| The app says "token rejected" | The password in the app differs from `APP_TOKEN`. Paste it again. |
| No "Nudges on this phone" switch | The app was opened in Safari. Open it from the Home Screen icon. |
| Notifications were denied | iOS will not ask again. Turn them on in **iOS Settings → Notifications → Time**. |

## Deploying from a computer instead

If you prefer the command line (Node 22 and pnpm 10):

```sh
pnpm install
pnpm --filter @time-tracker/server exec wrangler login
pnpm --filter @time-tracker/server exec wrangler d1 create time-tracker
# Paste the printed database_id into apps/server/wrangler.toml
pnpm --filter @time-tracker/server exec wrangler secret put AUTH_TOKEN
pnpm --filter @time-tracker/server db:migrate:remote
pnpm run deploy
```
