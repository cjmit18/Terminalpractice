-- Accounts for optional sign-in. Progress sync tables come in a later migration.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,              -- random UUID
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    INTEGER NOT NULL               -- Unix ms
);

-- One user can later link more sign-in methods (Google, email, passkeys)
CREATE TABLE identities (
  provider      TEXT NOT NULL,                 -- 'github'
  provider_id   TEXT NOT NULL,                 -- the provider's stable numeric user id, as text
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login         TEXT,                          -- e.g. GitHub username, shown in the account menu
  PRIMARY KEY (provider, provider_id)
);
CREATE INDEX identities_user ON identities(user_id);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,              -- SHA-256 of the cookie value; the raw token is never stored
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    INTEGER NOT NULL,              -- Unix ms
  created_at    INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
