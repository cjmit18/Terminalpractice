# Accounts: API contract (portal work)

The shared contract for the login portal. Server work lives in `worker/`, the app side in `src/`.
Everything stays optional: signed out and offline, the app works exactly as today.

## Decisions

- Sign-in methods: **email + password** (the site's own accounts), **Google**, **GitHub** (built).
- Progress **syncs to the account** (LOGIN_PLAN.md Phase 3: per-item rows, reset epochs, account-scoped
  browser keys, explicit "Add this browser's progress" import).
- Minimum age 13, confirmed with a checkbox when creating an account.

## Security rules (all routes)

- Sessions: `__Host-session` cookie, HttpOnly, Secure, SameSite=Lax, 30-day sliding, and an absolute
  lifetime of 90 days from sign-in however often it is used; D1 stores only SHA-256 of the token. A new
  session token on every sign-in, password change and password reset. Signing in or creating an account
  ends the session the browser's cookie named before. A daily cron (`scheduled()` in
  `worker/index.ts`) deletes expired sessions, one-time tokens and rate-limit rows.
- Every state-changing request (POST/PUT/PATCH/DELETE) must send an `Origin` listed in `APP_ORIGINS`
  (or, when that var is empty, as on previews, equal to the request's origin), otherwise 403. JSON
  bodies only (`Content-Type: application/json`), size-capped (64 KB; sync 512 KB).
- `APP_ORIGINS` (var, comma-separated, `https://terminuscli.com` in production): email links and OAuth
  redirect URIs use the request's origin when it is listed, otherwise the first entry.
  `workers_dev` is off, so production answers only on its custom domain.
- Every API answer carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
  `Content-Security-Policy: frame-ancestors 'none'`.
- Passwords: PBKDF2-SHA256 via WebCrypto, 100000 iterations (the Workers maximum), 16-byte random salt,
  32-byte key, stored as `pbkdf2$sha256$100000$<salt b64>$<hash b64>`; constant-time compare. Length
  10–128; reject about 1000 common passwords of 10+ characters (`common_password`), passwords equal to
  the email (`password_equals_email`), and passwords containing "terminus", "certsim", the display name
  (with or without spaces) or the email's local part (`password_contains_name`; names and local parts
  shorter than 4 characters are not checked). No composition rules.
- Emails: NFC-normalized, trimmed and lowercased, unique per email identity. The local part is ASCII
  only (dot-atom: letters, digits and ``!#$%&'*+/=?^_`{|}~-``, dots between them); `<>"(),;:[]\`,
  spaces, control characters and format characters (`\p{Cf}`, e.g. zero-width) are refused. An
  internationalized domain is converted to punycode (`a@bücher.example` is stored as
  `a@xn--bcher-kva.example`); IP-address domains are refused. Never reveal whether an email exists:
  sign-in failures and "forgot password" always give the same generic answer.
- Unverified addresses: an account's email holds its address for 24 hours after it was set
  (`users.email_set_at`) until it is verified. After that, a new sign-up for the address, or another
  account adding it, takes it over: the old holder loses the address, its password and its pending
  links. Email + password sign-in with a lapsed unverified address answers `invalid_credentials`.
  While the account's email is unverified, `?link=1` is refused and no password can be set on an
  account that has none. A password reset proves the inbox: when it is used on an account whose email
  was unverified, every non-email sign-in method, every session and all synced data (`progress_items`,
  `progress_epochs`, `user_settings`) are deleted first, then the email is marked verified.
- One-time tokens (email verification, password reset): 32 random bytes, only SHA-256 stored, single use,
  expire (verify 24 h, reset 1 h); a password reset ends all sessions.
- Rate limits (D1 table, fixed windows): sign-in 30 per 15 min per IP and 50 per hour per email (both
  hard), plus 10 per 15 min per email, which is soft: past it, a wrong password gets 429 but a correct
  one still signs in, so strangers cannot lock an owner out; sign-up 5 per hour per IP; forgot-password
  3 per hour per email and 10 per hour per IP (over either, it still answers 202 and sends nothing).
  Over a limit: 429 with Retry-After. "Per IP" is an IPv4 address, or an IPv6 /64; only
  `CF-Connecting-IP` is trusted. Keys are `<limit>:<HMAC-SHA256(subject)>` under the
  `RATE_LIMIT_PEPPER` secret (plain SHA-256 with a logged warning when it is unset; see
  `docs/SECURITY_SETUP.md`). Deleting an account deletes its rows keyed by its email or user id.
- Re-authentication: delete account, add or change the email, set or change the password, and link or
  unlink a sign-in method need a recent proof of identity:
  - Account **with a password**: `currentPassword` in the body, every time (10 wrong tries per 15 min
    per user, then 429). Missing: 400 `current_password_required`; wrong: 403 `wrong_password`.
  - Account **without a password**: the session's `authenticated_at` (set at sign-in, registration,
    reset and OAuth sign-in) must be within the last 10 minutes, otherwise 403
    `{ error: "reauth_required", message, providers: ["github" | "google", …] }`, listing the linked
    providers to re-authenticate with: `GET /api/auth/<provider>/start?reauth=1&return=#/…`.
  - Linking is a navigation (`start?link=1`), so it always checks `authenticated_at` (10 minutes): an
    account with a password calls `POST /api/account/reauth { currentPassword }` right before
    navigating; one without uses `start?reauth=1` first.
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
| `POST /api/auth/password/forgot` | `{ email }` | always 202, also when rate-limited (then nothing is sent) |
| `POST /api/auth/password/reset` | `{ token, password }` | 200 `{ user }` + new cookie; all other sessions ended |
| `GET /api/auth/google/start?return=#/…` | | 302 to Google |
| `GET /api/auth/google/callback` | | 302 back to the app |
| `GET /api/auth/github/start`, `/callback` | | built; when signed in, `?link=1` links GitHub to the current user instead of signing in |
| `GET /api/auth/google/start?link=1` | | same, for Google |
| `GET /api/auth/<provider>/start?reauth=1&return=#/…` | | signed in: signs the same identity in again and refreshes this session's `authenticated_at`; back to `return` (see below) |
| `POST /api/logout` | | ends this session (built) |
| `POST /api/account/logout-all` | | ends every session of the user |
| `POST /api/account/reauth` | `{ currentPassword }` | 200 `{ ok: true, authenticatedAt }`, refreshes this session's `authenticated_at`; 403 `reauth_required` (with `providers`) when the account has no password |
| `GET /api/account` | | `{ user, identities: [{ provider, label, linkedAt }], hasPassword, emailVerified }` |
| `PATCH /api/account` | `{ displayName? }` | 200 `{ user }` |
| `POST /api/account/password` | `{ currentPassword?, newPassword }` | 200; `currentPassword` required when one exists, otherwise a recent sign-in and a verified email; other sessions ended |
| `POST /api/account/email` | `{ email, currentPassword?, password? }` | 202; adds or changes the email identity (verification sent) |
| `DELETE /api/account/identities/:provider` | `{ currentPassword? }` (body optional without a password) | 204; refused (409 `last_method`) if it is the only way to sign in |
| `GET /api/account/export` | | the user's data as a JSON download, synced progress included (`progress: { items, epochs, settings }`) |
| `DELETE /api/account` | `{ confirm: "delete", currentPassword? }` | 204; deletes the user and everything linked, synced progress included |
| `GET /api/progress` | | `{ items, epochs, settings }` (see "Progress sync" below) |
| `PUT /api/progress` | `{ items?, settings? }` (an `epochs` field is accepted and ignored: each item carries its own) | 200, the stored `{ items, epochs, settings }` after the merge |
| `POST /api/progress/reset` | `{ scope, epoch? }` or `{ resets: [{ scope, epoch? }] }` | 200 `{ epochs }` |

`PublicUser`: `{ id, name, login: string | null, email: string | null, emailVerified: boolean, avatarUrl: string | null }`
(`avatarUrl` is kept from the built API; the app does not display it).
Email links point to the app: `#/account/verify?token=…` and `#/account/reset?token=…`.

### Details settled while building the server

- `POST /api/account/email`: when the account has a password, `currentPassword` is the current
  password (required; the older `password` field is still read as the current password). When it has
  none, a recent sign-in is required, and an optional `password` becomes the account's password, but
  only when `email` is the account's own, already verified address: otherwise 409 `email_unverified`
  (add the address, verify it, then set the password). The new address starts unverified.
- `POST /api/account/password` needs an email on the account (`email_required` otherwise). Setting a
  first password also needs that email verified (409 `email_unverified`) and a recent sign-in.
- `DELETE /api/account/identities/:provider` and `DELETE /api/account`: with a password, send
  `currentPassword` in a JSON body.
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
  `not_signed_in`. `?link=1` without a session answers 401 (plain text). Since the security fixes:
  - At start, `?link=1` and `?reauth=1` return to the route right away (302, nothing started) with
    `email_unverified` (link while the account's email is unverified), `reauth_required` (link more
    than 10 minutes after the last sign-in or reauth) or `not_linked` (reauth with a provider that is
    not linked). `?reauth=1` without a session answers 401 (plain text).
  - Link and reauth are bound to the session that started them. At the callback: `session_changed`
    (another session, or none, is now signed in in this browser), `reauth_mismatch` (reauth came back
    with a different Google/GitHub account than the one linked), `email_unverified`.
  - Any `/api/auth/<provider>/start` with `Sec-Fetch-Site` other than `same-origin` or `none` answers
    403 (plain text), so a cross-site page cannot start a sign-in or link. A missing header is allowed.
  - Google reauth sends `prompt=login&max_age=0`. GitHub has no way to force a fresh sign-in, so a
    GitHub reauth proves the browser's current GitHub session.
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
`last_method` (409), `confirm_required` (400, delete without `{ confirm: "delete" }`),
`password_contains_name` (400), `email_unverified` (409, setting a password, or linking, while the
email is unverified), `reauth_required` (403, with `providers: string[]`: sign in again; see
"Re-authentication").

## App routes

`#/account` (sign in / create account when signed out; dashboard when signed in), `#/account/settings`,
`#/account/security` (password, email, linked methods, sessions, export, delete), `#/account/verify`,
`#/account/reset`, `#/account/forgot`.
