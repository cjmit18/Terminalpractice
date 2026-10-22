-- Security fixes: unverified email claims expire, sessions record when the user last signed in. Adds to 0001-0002 only.

-- When the account's current email was set. An unverified email holds its address for 24 hours after
-- this; after that a new sign-up, or another account adding the address, takes it over.
-- Existing unverified addresses get 24 hours from this migration.
ALTER TABLE users ADD COLUMN email_set_at INTEGER;        -- Unix ms
UPDATE users SET email_set_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE email IS NOT NULL AND email_verified_at IS NULL;
UPDATE users SET email_set_at = COALESCE(email_verified_at, updated_at, created_at)
  WHERE email IS NOT NULL AND email_verified_at IS NOT NULL;

-- When the session's user last proved who they are (sign-in, or re-authentication for a sensitive
-- action). Existing sessions count from their creation, so they need a fresh sign-in for those actions.
ALTER TABLE sessions ADD COLUMN authenticated_at INTEGER; -- Unix ms
UPDATE sessions SET authenticated_at = created_at WHERE authenticated_at IS NULL;

-- For the daily sweep of ended sessions (worker/maintenance.ts)
CREATE INDEX sessions_expires ON sessions(expires_at);
CREATE INDEX sessions_created ON sessions(created_at);
