-- Portal part 9: when each account last signed in, for the admin dashboard's activity total. Adds to 0001-0006 only.
-- Sessions are deleted on sign-out, so they cannot tell who signed in recently; this column survives that.
ALTER TABLE users ADD COLUMN last_sign_in_at INTEGER;   -- Unix ms
UPDATE users SET last_sign_in_at = (
  SELECT MAX(COALESCE(authenticated_at, created_at)) FROM sessions WHERE sessions.user_id = users.id
);
