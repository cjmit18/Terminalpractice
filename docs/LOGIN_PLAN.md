# Plan: user accounts and login

Status: proposal for review. Nothing here is built yet.

## Goal

Let learners sign in so their progress follows them between devices (phone on the bus, laptop at home). Signing in stays **optional**: everything works signed out and offline, exactly as today. An account adds sync and nothing else at first.

Out of scope for the first version: leaderboards, social features, teacher/class dashboards, paid plans. The design should not block them later.

## What exists today

- A static site (no server code) on Cloudflare Workers static assets, also on GitHub Pages.
- Progress lives in `localStorage`: lab objectives (`certsim:progress:v1`) and the learning paths journey (`certsim:journey:v1`: lessons read, best quiz scores, last step), plus the theme.
- A service worker caches the whole app for offline use.

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
   │  /api/* (fetch, cookie)             ─────►  Worker script (new)
                                                    ├── D1: users, identities, sessions, progress
                                                    └── Secrets: OAuth client IDs/secrets
```

`wrangler.jsonc` gains a Worker entry point and `"run_worker_first": ["/api/*"]` so only API calls reach the script; static files keep being served straight from the edge.

### Data model (D1)

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,            -- random UUID
  display_name  TEXT,
  email         TEXT,                        -- from the provider, used only for account recovery/contact
  created_at    INTEGER NOT NULL
);

CREATE TABLE identities (                    -- one user can link GitHub, Google, email, passkeys
  provider      TEXT NOT NULL,               -- 'github' | 'google' | 'email' | 'passkey'
  provider_id   TEXT NOT NULL,               -- the provider's stable user id
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, provider_id)
);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,            -- SHA-256 of the cookie token; the raw token is never stored
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE progress (                      -- one row per user; documents mirror the localStorage shapes
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  labs_json     TEXT NOT NULL,               -- { moduleId: objectiveId[] }
  journey_json  TEXT NOT NULL,               -- { lessonsRead, quizBest, last }
  updated_at    INTEGER NOT NULL
);
```

Storing progress as JSON documents keeps the server simple and matches what the app already saves. If teacher dashboards come later, normalise into per-objective rows then.

### API

| Method and path | Purpose |
|---|---|
| `GET /api/auth/:provider/start` | Starts OAuth: creates `state` and a PKCE verifier (short-lived cookie), redirects to the provider |
| `GET /api/auth/:provider/callback` | Verifies `state`, exchanges the code, finds or creates the user, sets the session cookie, redirects to `/#/learn` |
| `GET /api/me` | Who is signed in (or 401) |
| `POST /api/logout` | Deletes the session row and clears the cookie |
| `GET /api/progress` | The stored progress documents |
| `PUT /api/progress` | Sends local progress; the server merges and returns the merged result |
| `GET /api/account/export` | All of the user's data as JSON |
| `DELETE /api/account` | Deletes the user and everything linked (cascade) |

### Sessions

- Cookie `__Host-session`: `HttpOnly; Secure; SameSite=Lax; Path=/`, 30-day sliding expiry.
- The value is 32 random bytes; D1 stores only its SHA-256, so a database leak does not leak sessions.
- Rotate the token on sign-in; delete expired rows on a schedule (Cron Trigger).

### Syncing progress (the important part)

Progress only ever grows, so merging is safe and needs no conflict screen:

- Lab objectives and lessons read: **union** of both sides.
- Quiz scores: keep the **best** per quiz.
- "Last visited" step: keep the most recent by timestamp.
- Reset progress: a reset is an explicit action, so it sends a `reset` flag with a timestamp; the server clears what was reset before that time. (Without this, a reset on one device would be undone by another device's union.)

Flow:
1. On sign-in, the app sends its local progress; the server merges with the stored copy and returns the result; the app saves it locally.
2. While signed in, changes are saved locally first (as now), then sent with a short debounce.
3. Offline: changes queue locally and send when back online. Nothing waits on the network.

The merge function is pure TypeScript shared by the app and the Worker, so one set of unit tests covers both sides.

### App changes

- `src/lib/account.ts`: `useAccount()` hook (`/api/me`), sign-in links, sign-out.
- Header: a "Sign in" button (or the user's name with a small menu: Sync status, Export data, Sign out, Delete account).
- `src/lib/progress.ts` / `journey.ts`: call the sync after each local save when signed in.
- A small account page (`#/account`): linked sign-in methods, export, delete, and a plain-language privacy note.
- Service worker: never cache or intercept `/api/*` (today it caches every same-origin GET).

## Security and privacy checklist

- OAuth with `state` and PKCE; exact redirect URIs registered with each provider.
- Cookies as above; additionally check the `Origin` header on every state-changing request (`PUT`, `POST`, `DELETE`).
- Rate-limit sign-in and API routes (Workers rate limiting binding or a WAF rule).
- Secrets (`GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`) via `wrangler secret put`, never in the repo; `.dev.vars` for local development is already git-ignored.
- Collect the minimum: provider id, display name, email. No passwords, no tracking.
- Export and delete available to every user from day one.
- Audience: learners may be under 18. State a minimum age of 13 in the privacy note, because collecting data from children under 13 brings extra legal duties (COPPA in the US).
- Add security headers for the static site (Content-Security-Policy, Referrer-Policy) via a `_headers` file.

## Testing

- Unit: merge rules (union, best score, reset), session token hashing, OAuth state checks.
- Worker: route tests with Cloudflare's Vitest integration against a local D1.
- E2E (Playwright): a fake OAuth provider route in test builds, then sign in, sync between two browser contexts, sign out, delete account. Existing signed-out tests keep passing unchanged.

## Phases

| Phase | Delivers | Done when |
|---|---|---|
| 1. Worker API skeleton | `main` Worker, `/api/health`, D1 database and migrations, service worker ignores `/api` | Deployed; static site unchanged; e2e green |
| 2. GitHub sign-in | OAuth flow, sessions, `/api/me`, Sign in / Sign out in the header | A user can sign in and out on production |
| 3. Progress sync | Merge function, `GET/PUT /api/progress`, sync on sign-in and on change, offline queue | Progress made on one device appears on another; offline work survives |
| 4. Account page | Export, delete, privacy note, Google sign-in | A user can export and delete everything |
| 5. More sign-in options | Email one-time codes (needs an email provider), passkeys | Optional, based on demand |

Each phase is a separate PR with its own tests.

## Decisions needed from you

1. **Sign-in providers to start with:** GitHub only, GitHub and Google, or email codes too? GitHub suits IT learners and needs no email service; Google covers people without GitHub.
2. **Domain:** keep `*.workers.dev`, or a custom domain? OAuth redirect URIs are registered per domain, so decide before Phase 2.
3. **GitHub Pages:** keep it as a signed-out mirror, or retire it so there is one site? Sign-in only works on the Cloudflare host because the API lives there.
4. **Minimum age** for accounts (recommendation: 13).
5. **Who owns the OAuth apps:** they are registered under your GitHub and Google accounts; you will need to create them (I can walk you through it) and add the secrets with `wrangler secret put`.
