# Accounts: API contract (portal work)

The shared contract for the login portal. Server work lives in `worker/`, the app side in `src/`.
Everything stays optional: signed out and offline, the app works exactly as today.

## Decisions

- Sign-in methods: **email + password** (the site's own accounts), **Google**, **GitHub** (built).
- Progress **syncs to the account** (LOGIN_PLAN.md Phase 3: per-item rows, reset epochs, account-scoped
  browser keys, explicit "Add this browser's progress" import).
- Minimum age 13, confirmed with a checkbox when creating an account.

## Security rules (all routes)

- Sessions: `__Host-session` cookie, HttpOnly, Secure, SameSite=Lax, 30-day sliding; D1 stores only
  SHA-256 of the token. A new session token on every sign-in, password change and password reset.
- Every state-changing request (POST/PUT/PATCH/DELETE) must send `Origin` equal to the site's origin,
  otherwise 403. JSON bodies only (`Content-Type: application/json`), size-capped (64 KB; sync 512 KB).
- Passwords: PBKDF2-SHA256 via WebCrypto, 100000 iterations (the Workers maximum), 16-byte random salt,
  32-byte key, stored as `pbkdf2$sha256$100000$<salt b64>$<hash b64>`; constant-time compare. Length
  10–128; reject the 1000 most common passwords and passwords equal to the email. No composition rules.
- Emails: trimmed and lowercased, unique per email identity. Never reveal whether an email exists:
  sign-in failures and "forgot password" always give the same generic answer.
- One-time tokens (email verification, password reset): 32 random bytes, only SHA-256 stored, single use,
  expire (verify 24 h, reset 1 h); a password reset ends all sessions.
- Rate limits (D1 table, fixed windows): sign-in 10 per 15 min per email and 30 per 15 min per IP;
  sign-up 5 per hour per IP; forgot-password 3 per hour per email. Over the limit: 429 with Retry-After.
- Email sending: Resend HTTP API when the `RESEND_API_KEY` secret and `EMAIL_FROM` var are set. Without
  them, accounts still work, but verification and reset emails are not sent and `/api/me` reports
  `emailSending: false` so the app can say so.
- Google: OAuth 2.0 authorization-code flow with `state` (and PKCE), scopes `openid email profile`,
  callback `/api/auth/google/callback`, secrets `GOOGLE_CLIENT_SECRET` (secret) + `GOOGLE_CLIENT_ID` (var).
  Identity is Google's `sub`. Accounts are never merged automatically by email; a signed-in user links
  another method from Account settings.
- Logs never contain passwords, tokens, or emails.
- No progress or account data in localStorage under the signed-out keys; account data uses
  `certsim:acct:<userId>:*` keys and is removed on sign-out.

## Endpoints

All JSON. Errors: `{ "error": "<code>", "message": "<plain sentence>" }` with a 4xx status.

| Method, path | Body | Result |
|---|---|---|
| `GET /api/me` | | `{ user: PublicUser \| null, providers: { github, google, email: boolean }, emailSending: boolean }` |
| `POST /api/auth/email/register` | `{ email, password, displayName, ageConfirmed: true }` | 201 `{ user }` + session cookie; sends the verification email |
| `POST /api/auth/email/login` | `{ email, password }` | 200 `{ user }` + cookie, or 401 `invalid_credentials` |
| `POST /api/auth/email/verify` | `{ token }` | 200 `{ user }` |
| `POST /api/auth/email/resend-verification` | | 202 (signed in) |
| `POST /api/auth/password/forgot` | `{ email }` | always 202 |
| `POST /api/auth/password/reset` | `{ token, password }` | 200 `{ user }` + new cookie; all other sessions ended |
| `GET /api/auth/google/start?return=#/…` | | 302 to Google |
| `GET /api/auth/google/callback` | | 302 back to the app |
| `GET /api/auth/github/start`, `/callback` | | built; when signed in, `?link=1` links GitHub to the current user instead of signing in |
| `GET /api/auth/google/start?link=1` | | same, for Google |
| `POST /api/logout` | | ends this session (built) |
| `POST /api/account/logout-all` | | ends every session of the user |
| `GET /api/account` | | `{ user, identities: [{ provider, label, linkedAt }], hasPassword, emailVerified }` |
| `PATCH /api/account` | `{ displayName? }` | 200 `{ user }` |
| `POST /api/account/password` | `{ currentPassword?, newPassword }` | 200; `currentPassword` required when one exists; other sessions ended |
| `POST /api/account/email` | `{ email, password? }` | 202; adds or changes the email identity (verification sent) |
| `DELETE /api/account/identities/:provider` | | 204; refused (409 `last_method`) if it is the only way to sign in |
| `GET /api/account/export` | | the user's data as a JSON download, synced progress included (`progress: { items, epochs, settings }`) |
| `DELETE /api/account` | `{ confirm: "delete" }` | 204; deletes the user and everything linked, synced progress included |
| `GET /api/progress` | | `{ items, epochs, settings }` (see "Progress sync" below) |
| `PUT /api/progress` | `{ items?, settings? }` (an `epochs` field is accepted and ignored: each item carries its own) | 200, the stored `{ items, epochs, settings }` after the merge |
| `POST /api/progress/reset` | `{ scope, epoch? }` or `{ resets: [{ scope, epoch? }] }` | 200 `{ epochs }` |

`PublicUser`: `{ id, name, login: string | null, email: string | null, emailVerified: boolean, avatarUrl: string | null }`
(`avatarUrl` is kept from the built API; the app does not display it).
Email links point to the app: `#/account/verify?token=…` and `#/account/reset?token=…`.

### Details settled while building the server

- `POST /api/account/email`: when the account has a password, `password` is the **current** password
  (required). When it has none, an optional `password` becomes the account's password. The new
  address starts unverified.
- `POST /api/account/password` needs an email on the account (`email_required` otherwise).
- `POST /api/account/logout-all` answers 200 `{ ok: true }` and clears the cookie;
  `POST /api/account/password` answers 200 `{ ok: true }` with a new session cookie.
- `GET /api/account`: `linkedAt` is Unix milliseconds. The email method appears as
  `{ provider: "email", label: <email> }`. "Ways to sign in" for `last_method` counts GitHub, Google,
  and email only when the account has both an email and a password.
- Sign-up with an address that already has an account answers 409 `email_taken`. This reveals that
  the address is registered; it is accepted on sign-up only, because sign-up signs in at once and
  returns the user (a "check your email" flow would need accounts created only after verification).
  Sign-up is limited to 5 per hour per IP; sign-in and "forgot password" never reveal it.
- OAuth link failures return to the saved route with `?error=<code>` added to the hash, e.g.
  `#/account/security?error=identity_in_use`: `identity_in_use` (that Google/GitHub account belongs
  to another user), `provider_already_linked` (another account of that provider is already linked),
  `not_signed_in`. `?link=1` without a session answers 401 (plain text).
- Google sign-in never fills `PublicUser.email`; the Google address is only the identity's label.
- A later GitHub or Google sign-in no longer overwrites the display name (it is editable now).

### Progress sync

`worker/sync.ts` stores the rules of `src/lib/syncRules.ts` (shared with the app). All three routes
need a session (401 `not_signed_in`); PUT and POST follow the shared rules above with a 512 KB body cap.

- **Item**: `{ kind, key, scope, epoch, earnedAt, correct?, total? }`.
  - `kind` is `objective` (key `<moduleId>/<objectiveId>`), `lesson` or `quiz` (key `<pathId>/<stepId>`).
    Each id matches `[a-z0-9][a-z0-9._-]{0,63}`.
  - `scope` is derived from the key and never taken from the client: `lab:<moduleId>` for objectives,
    `path:<pathId>` for lessons and quizzes.
  - `epoch` is the scope's epoch as the sending device knew it. The server keeps an uploaded item only
    when that equals the scope's current epoch.
  - `earnedAt` is client time in ms (0 when unknown), for display only.
  - Quiz only: `correct` and `total`, integers with `0 <= correct <= total <= 1000`. The best score is
    kept: the higher fraction, or the same fraction out of more questions.
- **Epochs**: `{ "<scope>": n }`. A scope that is missing is at epoch 0. Epochs only go up and are never
  removed.
- **Reset**: `{ scope, epoch? }` for one scope, or `{ resets: [{ scope, epoch? }, …] }` for several.
  - A reset raises the scope's epoch by one and deletes its items.
  - With `epoch`, the reset applies only while the scope is still at that epoch, so a retried or
    repeated reset does not reset twice.
  - Answers `{ epochs }` with every scope of the user.
- **Settings**: `{ "<field>": { value, updatedAt } }`. `updatedAt` is client time in ms, and for each
  field the newest write wins. The fields are:
  - `prefs`: activity prefs. Unknown pref fields are dropped. The allowed values are:
    - `celebrations`: `quiet | off | lively`
    - `showBadges`: boolean
    - `weeklyGoal`: 0–7
    - `sandboxHost`: hostname or `''`
    - `promptStyle`: `standard | bracket | short | host-first`
    - `bannerLine`: `none | calm | tip | loopback`
    - `storyNotes`: boolean
    - `defaultShell`: `bash | cmd | powershell`
    - `termFontSize`: `s | m | l`
  - `theme`: `system | light | dark`.
  - `badges`: `{ badgeId: earnedAt }`.
  - `practice`: YYYY-MM-DD days.
  - `goalWeeks`: YYYY-MM-DD week starts.
  - `cleared`: the time in ms of the last "Clear badges and activity".

  Any other field or value outside these lists answers 400 `invalid_settings`.
- **Caps**:
  - 2000 items per PUT (413 `too_many_items`).
  - 5000 items stored per user (413 `too_many_items`).
  - 100 resets per request (413 `too_many_resets`).
  - 2000 scopes with an epoch per user (413 `too_many_scopes`).
  - In settings: 500 badges, 400 practice days and 2000 goal weeks.
- **Errors**:
  - `invalid_items` (400, a malformed item).
  - `invalid_settings` (400).
  - `invalid_scope` (400, a malformed scope or epoch, or no scope named).
  - `conflict` (409, settings changed by another request at the same moment; retry).

### Error codes

`invalid_request` (400, malformed body or field), `unsupported_media_type` (415),
`payload_too_large` (413), `forbidden_origin` (403), `not_signed_in` (401), `not_found` /
`method_not_allowed`, `rate_limited` (429 + `Retry-After`), `unavailable` (503, database without the
account tables), `invalid_credentials` (401), `invalid_email`, `invalid_display_name`, `age_required`,
`password_too_short`, `password_too_long`, `common_password`, `password_equals_email`,
`email_taken` (409, sign-up), `email_in_use` (409, adding or changing an email),
`current_password_required` (400), `wrong_password` (403), `email_required`, `no_email`
(resend-verification without an email), `invalid_token` / `token_expired` (400), `not_linked` (404),
`last_method` (409), `confirm_required` (400, delete without `{ confirm: "delete" }`).

## App routes

`#/account` (sign in / create account when signed out; dashboard when signed in), `#/account/settings`,
`#/account/security` (password, email, linked methods, sessions, export, delete), `#/account/verify`,
`#/account/reset`, `#/account/forgot`.
