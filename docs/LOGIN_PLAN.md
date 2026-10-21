# Plan: user accounts and login

Status: Phase 1 (Worker API skeleton) and Phase 2 (GitHub sign-in) are built and deployed on `https://terminuscli.com`; sign-in stays hidden until the GitHub App is created and configured (see `docs/GITHUB_SIGNIN_SETUP.md`). Phases 3 to 5 are planned. The sections below describe the whole design; the parts that exist are marked as built.

## Goal

Let learners sign in so their progress follows them between devices (phone on the bus, laptop at home). Signing in stays **optional**: everything works signed out and offline, exactly as today. An account adds sync and nothing else at first.

Out of scope for the first version: leaderboards, social features, teacher/class dashboards, paid plans. The design should not block them later.

## What exists today

- The Worker `terminuscli` (`worker/index.ts`, `worker/api.ts`) on `https://terminuscli.com`: static files are served straight from the edge, and only `/api/*` runs Worker code, with a D1 database for accounts (`migrations/0001_accounts.sql`). GitHub Pages serves a signed-out copy (`VITE_ACCOUNTS=off`).
- Built API: `GET /api/health`, GitHub sign-in (`/api/auth/github/start`, `/api/auth/github/callback`), `GET /api/me`, `POST /api/logout`. No progress is stored on the server yet.
- Progress lives in this browser only. Storage keys:

  | Key | Storage | Holds |
  |---|---|---|
  | `certsim:progress:v1` | localStorage | lab objectives completed, plus a reset marker per module |
  | `certsim:journey:v1` | localStorage | learning paths: lessons read, best quiz scores, last step |
  | `certsim:activity:v1` | localStorage | activity facts, practice days, earned badges, and the badge and celebration settings |
  | `certsim:theme` | localStorage | chosen theme (absent means "follow the system") |
  | `certsim:firststeps-dismissed` | localStorage | the first-steps banner was dismissed |
  | `certsim:chunk-reload` | sessionStorage | time of the last reload after a deploy (stops a reload loop) |

- A service worker caches the app for offline use and never caches or answers `/api/*`.

## Recommendation in one paragraph

Turn the existing Worker into a small API next to the static files: `/api/*` runs Worker code, everything else stays static. Store users, sessions and progress in **Cloudflare D1** (SQLite). Sign in with **GitHub and Google (OAuth)** first, because it needs no passwords and no email sending, then add **email one-time codes** and **passkeys**. Keep sessions in a secure, HTTP-only cookie. Progress syncs by merging, never overwriting, so offline work is never lost.

## Options considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Own Worker API + D1 + OAuth** | Everything on one Cloudflare account; no third-party scripts; data stays ours; free tier likely enough for a study app | We write and maintain the auth code (OAuth flow, sessions) | **Recommended** |
| Hosted auth service (Auth0, Clerk, Supabase Auth, Firebase Auth) | Fastest to a polished sign-in UI; handles email, MFA | Third-party scripts and accounts; vendor lock-in; cost grows with users; conflicts with the "nothing fetched from third parties" choice | Fallback if speed matters more than control |
| Cloudflare Access | Zero code, strong security | Built to restrict an internal app to known people; it gates the whole site and has no idea of "progress" | Not for a public learning site |
| Username + password stored by us | Familiar | Password hashing, resets, breach liability, email needed anyway for resets | No |

## Architecture

```
Browser (React app, service worker)
   │  static files (/, /assets/*)        ─────►  Workers static assets (as today)
   │  /api/* (fetch, cookie)             ─────►  Worker script (worker/index.ts)
                                                    ├── D1: users, identities, sessions, progress
                                                    └── Secrets: OAuth client IDs/secrets
```

`wrangler.jsonc` has the Worker entry point and `"run_worker_first": ["/api/*"]` (built), so only API calls reach the script; static files are served straight from the edge.

### Data model (D1)

`users`, `identities` and `sessions` are built, as in `migrations/0001_accounts.sql`; the two progress tables are Phase 3.

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,            -- random UUID
  display_name  TEXT NOT NULL,               -- GitHub name, or the username when the name is empty
  avatar_url    TEXT,                        -- from the provider (not displayed yet; no third-party images)
  created_at    INTEGER NOT NULL             -- Unix ms
);

CREATE TABLE identities (                    -- one user can later link Google, email, passkeys
  provider      TEXT NOT NULL,               -- 'github' today; later 'google' | 'email' | 'passkey'
  provider_id   TEXT NOT NULL,               -- the provider's stable user id, as text
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login         TEXT,                        -- e.g. GitHub username, shown in the account menu
  PRIMARY KEY (provider, provider_id)
);
CREATE INDEX identities_user ON identities(user_id);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,            -- SHA-256 of the cookie token; the raw token is never stored
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    INTEGER NOT NULL,            -- Unix ms
  created_at    INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Phase 3. One row per earned item, so each one carries the reset epoch it was earned under
CREATE TABLE progress_items (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,               -- 'objective' | 'lesson' | 'quiz'
  item_key      TEXT NOT NULL,               -- 'moduleId/objectiveId' or 'pathId/stepId'
  scope         TEXT NOT NULL,               -- reset scope it belongs to, e.g. 'track:linux', 'path:lpic1-101'
  epoch         INTEGER NOT NULL,            -- the scope's reset epoch when it was earned (see Syncing)
  correct       INTEGER,                     -- quiz only: best score
  total         INTEGER,
  earned_at     INTEGER NOT NULL,            -- client time, for display only, never for conflict decisions
  PRIMARY KEY (user_id, kind, item_key)
);

-- Persistent reset markers: one counter per scope, raised by each reset and never removed
CREATE TABLE progress_epochs (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,
  epoch         INTEGER NOT NULL,
  PRIMARY KEY (user_id, scope)
);
```

Progress is stored as one row per earned item, not as JSON documents, because each item has to carry the reset epoch it was earned under (see Syncing). Per-item rows also allow per-objective views, such as teacher dashboards, later without a migration.

### API

| Method and path | Purpose |
|---|---|
| `GET /api/health` | `{ "ok": true }` (built) |
| `GET /api/auth/:provider/start` | Starts OAuth: creates `state` (short-lived cookie together with the page to return to), redirects to the provider (built for `github`) |
| `GET /api/auth/:provider/callback` | Verifies `state`, exchanges the code, finds or creates the user, sets the session cookie, and redirects back to the page saved at start, or to `#/learn` when none was saved or it is not an in-app route (built for `github`) |
| `GET /api/me` | Always 200 with `{ user, providers }`: the signed-in user, or `user: null` when signed out, and which sign-in methods are configured (built) |
| `POST /api/logout` | Deletes the session row and clears the cookie; same-origin requests only (built) |
| `GET /api/progress` | The user's stored progress items and current epochs |
| `PUT /api/progress` | Sends queued items with their epochs; the server keeps those matching the current epochs, merges, and returns the result plus current epochs |
| `POST /api/progress/reset` | Raises a scope's epoch and deletes its items (same-origin only) |
| `GET /api/account/export` | All of the user's data as JSON |
| `DELETE /api/account` | Deletes the user and everything linked (cascade) |

### Sessions

- Cookie `__Host-session`: `HttpOnly; Secure; SameSite=Lax; Path=/`, 30-day sliding expiry.
- The value is 32 random bytes; D1 stores only its SHA-256, so a database leak does not leak sessions.
- Rotate the token on sign-in; delete expired rows on a schedule (Cron Trigger).

### Syncing progress (the important part)

Two rules make sync safe: progress belongs to exactly one owner (an account, or "this browser, signed out"), and a reset is a persistent marker that later uploads cannot undo.

**Merging (within one owner).** Progress only grows between resets, so no conflict screen is needed:

- Lab objectives and lessons read: **union**.
- Quiz scores: keep the **best** per quiz.
- "Last visited" step: the most recent wins (it is a convenience, not progress).

**Resets: epochs, not timestamps.** A timestamped reset flag is not enough: device A resets, offline device B still holds the old snapshot, and B's next upload would bring everything back through the union. Comparing client clocks does not fix it either, because clocks drift.

- Each reset scope (`all`, `track:linux`, `path:lpic1-101`, …) has an **epoch** counter on the server (`progress_epochs`). A reset raises it by one and the server deletes that scope's items. Epochs are never lowered or removed, so the marker persists.
- Every item records the epoch of its scope at the moment it was earned, as last known by that device.
- On upload, the server keeps an item only if its epoch equals the scope's current epoch. B's pre-reset items carry the old epoch and are dropped; work done after B has synced the reset carries the new one and is kept.
- Consequence, stated in the UI: a reset wins over work done offline on another device at the same time. Resetting is rare and explicit, so this is the predictable choice.
- Responses always include the current epochs, so every device learns about a reset on its next sync.

**Who owns local progress (one browser, several people).** Today's `certsim:progress:v1` and `certsim:journey:v1` keys belong to whoever uses the browser signed out. Account data never mixes with them:

- Signed-out progress stays in the existing keys. Each account gets its own keys, `certsim:acct:<userId>:progress`, `…:journey` and `…:queue` (its offline queue).
- Signing in switches the app to that account's data, downloaded from the server. It never uploads the signed-out data automatically.
- If the browser has signed-out progress, the app asks once per account: "Add the progress saved in this browser to your account?" (Add / Not now). Only Add imports it, stamped with the account's current epochs at that moment, because importing is a deliberate choice.
- Signing out stops sync, drops that account's queue from memory and removes its cached keys from the browser (the server keeps the data), so the next person on a shared computer starts from the signed-out data, not the previous account's.
- Every sync request carries the user id it was started for and an `AbortController`. A response that arrives after the account changed is discarded, and switching accounts aborts requests still in flight. The server always takes the user from the session cookie, never from the request body.

**Flow (signed in).** Changes save locally first (as now), go into that account's queue and are sent with a short debounce. Offline, the queue waits and sends when back online. Nothing waits on the network.

**Existing data.** No server data exists before Phase 3, so there is nothing to migrate on the server. Signed-out snapshots have no epochs; they enter an account only through the explicit Add, which stamps them.

The merge and epoch rules are pure TypeScript shared by the app and the Worker, so one set of unit tests covers both sides.

### App changes

- `src/lib/account.ts`: `useAccount()` hook (`/api/me`), sign-in links, sign-out (built).
- Header: a "Sign in" button (or the user's name with a small menu: Sync status, Export data, Sign out, Delete account). Built so far: the button, and a menu with the name, the GitHub username and Sign out.
- `src/lib/progress.ts` / `journey.ts`: call the sync after each local save when signed in.
- A small account page (`#/account`): linked sign-in methods, export, delete, and a plain-language privacy note.
- Service worker: never cache or intercept `/api/*` (built in Phase 1).

## Security and privacy checklist

- OAuth with `state`; exact redirect URIs registered with each provider. PKCE is left out: it protects clients that cannot keep a secret, and here the client secret never leaves the Worker.
- Cookies as above; additionally check the `Origin` header on every state-changing request (`PUT`, `POST`, `DELETE`).
- Rate-limit sign-in and API routes (Workers rate limiting binding or a WAF rule).
- Secrets (`GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`) via `wrangler secret put`, never in the repo; `.dev.vars` for local development is already git-ignored.
- Collect the minimum: provider id, username and display name. No email, no passwords, no tracking.
- Export and delete available to every user from day one.
- Audience: learners may be under 18. State a minimum age of 13 in the privacy note, because collecting data from children under 13 brings extra legal duties (COPPA in the US).
- Add security headers for the static site (Content-Security-Policy, Referrer-Policy) via a `_headers` file.

## Testing

- Unit: merge rules (union, best score), session token hashing, OAuth state checks.
- Sync cases, as unit tests on the shared rules and as Worker route tests: **reset then reconnect** (A resets, offline B uploads its old snapshot, nothing comes back; B's work after syncing the reset is kept), **two accounts in one browser** (A signs out, B signs in: none of A's progress reaches B), **late response after an account switch** is discarded, **signed-out progress is imported only after Add**.
- Worker: route tests in `worker/api.test.ts`, run by `npm test` with Node's test runner against Node's built-in SQLite (`node:sqlite`) with the real migration and a fake GitHub (built for Phases 1 and 2).
- E2E (Playwright): a fake OAuth provider route in test builds, then sign in, sync between two browser contexts, sign out, delete account. Existing signed-out tests keep passing unchanged.

## Phases

| Phase | Status | Delivers | Done when |
|---|---|---|---|
| 1. Worker API skeleton | **Built** | `main` Worker, `/api/health`, D1 database and migrations, service worker ignores `/api` | Deployed; static site unchanged; e2e green |
| 2. GitHub sign-in | **Built** (waits for the GitHub App) | OAuth flow, sessions, `/api/me`, Sign in / Sign out in the header | A user can sign in and out on production |
| 3. Progress sync | Planned | Account-scoped storage, merge and epoch rules, `GET/PUT /api/progress`, reset endpoint, opt-in import, per-account offline queue | Progress made on one device appears on another; offline work survives; the reset and shared-browser cases above pass |
| 4. Account page | Planned | Export, delete, privacy note, Google sign-in | A user can export and delete everything |
| 5. More sign-in options | Planned | Email one-time codes (needs an email provider), passkeys | Optional, based on demand |

Each phase is a separate PR with its own tests.

## Decisions (made)

1. **Sign-in:** GitHub first, through a **GitHub App** rather than an OAuth App, because a GitHub App takes up to 10 callback URLs: the custom domain, the `workers.dev` address and `localhost`, and more domains later without removing the old ones.
2. **Domain:** `https://terminuscli.com`, a custom domain on the `terminuscli` Worker. The Worker builds the callback URL from the address it was reached on, so another domain needs no code change (steps in `docs/GITHUB_SIGNIN_SETUP.md`, "Adding another domain").
3. **Minimum age:** 13, stated in the privacy note when the account page arrives (Phase 4).
4. **Email:** not collected. Sign-in reads only the public GitHub profile (id, username, name), which needs no GitHub permissions.
5. **GitHub Pages:** stays as a signed-out copy for now (`VITE_ACCOUNTS=off` hides sign-in there).
6. **The GitHub App** is created under the repo owner's GitHub account (it holds the client secret); `docs/GITHUB_SIGNIN_SETUP.md` has the steps.
