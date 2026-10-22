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
| `GET /api/account/export` | | the user's data as a JSON download |
| `DELETE /api/account` | `{ confirm: "delete" }` | 204; deletes the user and everything linked |
| `GET /api/progress` | | `{ items, epochs, settings }` (Phase 3 sync) |
| `PUT /api/progress` | `{ items, epochs, settings? }` | merged `{ items, epochs, settings }` |
| `POST /api/progress/reset` | `{ scope }` | `{ epochs }` |

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
