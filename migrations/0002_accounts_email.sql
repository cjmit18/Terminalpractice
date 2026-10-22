-- Email + password accounts, Google sign-in, account linking, one-time tokens and rate limits.
-- Adds to 0001 only: existing GitHub users, identities and sessions keep working unchanged.

-- The site's own sign-in: a trimmed, lowercased email and a PBKDF2 hash (see worker/password.ts).
-- SQLite cannot add a UNIQUE column, so uniqueness comes from the index below (NULLs never clash).
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;   -- Unix ms; NULL until the link in the email is used
ALTER TABLE users ADD COLUMN password_hash TEXT;          -- pbkdf2$sha256$<iterations>$<salt b64>$<hash b64>
ALTER TABLE users ADD COLUMN updated_at INTEGER;          -- Unix ms of the last change made from account settings
CREATE UNIQUE INDEX users_email ON users(email);

-- When a sign-in method was added to the account. Rows from 0001 get their user's creation time.
ALTER TABLE identities ADD COLUMN linked_at INTEGER;
UPDATE identities SET linked_at = (SELECT created_at FROM users WHERE users.id = identities.user_id) WHERE linked_at IS NULL;

-- Email verification and password reset links. Only the SHA-256 of the token is stored.
CREATE TABLE auth_tokens (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose       TEXT NOT NULL,                 -- 'verify' | 'reset'
  expires_at    INTEGER NOT NULL,              -- Unix ms
  used_at       INTEGER,                       -- Unix ms; set once, the token never works again
  created_at    INTEGER NOT NULL
);
CREATE INDEX auth_tokens_user ON auth_tokens(user_id, purpose);
CREATE INDEX auth_tokens_expires ON auth_tokens(expires_at);

-- Fixed-window counters. The key names the limit and a hashed subject, e.g. 'login-email:<sha256>'.
CREATE TABLE rate_limits (
  key           TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,              -- Unix ms, start of the current window
  count         INTEGER NOT NULL
);
CREATE INDEX rate_limits_window ON rate_limits(window_start);
