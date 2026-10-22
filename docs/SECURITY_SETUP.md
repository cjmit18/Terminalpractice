# Security settings for the account Worker

Two settings protect the account API beyond the code itself: the **`RATE_LIMIT_PEPPER` secret** and the
**`APP_ORIGINS` var**. Set the secret once per Cloudflare Worker. The var is already in `wrangler.jsonc`.

## RATE_LIMIT_PEPPER (secret)

Rate limits are counted in the D1 table `rate_limits`, keyed by a hash of what they count: an email
address, an IP address (IPv4, or an IPv6 /64) or a user id. The Worker hashes them with
**HMAC-SHA256 under this secret**. Without the secret, someone who obtains a copy of the table could
hash a list of candidate emails, or the whole IPv4 space, and see who tried to sign in. With it, the
keys mean nothing without the secret.

Generate a random value (32 bytes, base64) with this one-line command:

```sh
openssl rand -base64 32
```

(Without OpenSSL: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.)

Give it to the Worker, never to the repository:

- in a terminal in this repository: `npx wrangler secret put RATE_LIMIT_PEPPER`, then paste the value
  when it asks; or
- in the Cloudflare dashboard: **Workers & Pages → terminuscli → Settings → Variables and Secrets →
  Add**, type **Secret**, name `RATE_LIMIT_PEPPER`, paste the value, **Deploy**.

Without the secret the Worker still works. It falls back to plain SHA-256 and logs
`ratelimit: RATE_LIMIT_PEPPER is not set…` once per isolate. That is fine for local runs and
pull-request previews, but production should have the secret.

Changing the value resets the current rate-limit windows (old rows no longer match and the daily
sweep removes them within a day). That is harmless, so you can rotate it whenever you like.

## APP_ORIGINS (var)

`APP_ORIGINS` is a comma-separated list of the origins the app is served from. In `wrangler.jsonc` it is
`"https://terminuscli.com"`. It does three things:

- Links in emails (verify, reset) and OAuth redirect URIs use the request's origin when it is in the
  list, otherwise the **first** entry.
- Only listed origins pass the `Origin` check on state-changing requests (POST, PUT, PATCH, DELETE).
- An empty list means "use the request's own origin". The `previews` block sets it to `""`, so
  pull-request previews work on their own preview URLs.

If the site gets another domain (say `www.terminuscli.com`), add it after the main one, for example
`"https://terminuscli.com,https://www.terminuscli.com"`. Also add its callback URLs to the GitHub App
and the Google OAuth client.

`wrangler.jsonc` also sets `"workers_dev": false`, so production is not also served on
`terminuscli.<account>.workers.dev` against the production database. `"preview_urls": true` keeps
pull-request preview URLs working.

## Daily sweep

`triggers.crons` in `wrangler.jsonc` runs the Worker's `scheduled()` handler once a day. It deletes
expired sessions (and those past the 90-day absolute lifetime), expired one-time tokens, and rate-limit
rows whose window has ended. Nothing needs to be configured. The **Triggers** tab of the Worker in the
dashboard shows the cron after a deploy.

## After deploying these changes

1. Apply the migration: `npx wrangler d1 migrations apply DB --remote` (`npm run deploy` does it).
   `0004_security.sql` adds `users.email_set_at` and `sessions.authenticated_at`. Existing unverified
   addresses get 24 hours from the migration. Existing sessions count as signed in at their creation,
   so a sensitive action on an account without a password will ask for a fresh sign-in.
2. Set `RATE_LIMIT_PEPPER` as above.
3. Check that `https://terminuscli.com` still works and that `https://terminuscli.<account>.workers.dev`
   no longer does.
