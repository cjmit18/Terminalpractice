-- Portal part 9: admins. Adds to 0001-0005 only.
-- The owner is named by the OWNER_EMAIL secret (never stored here); the owner adds admins by email.
-- A row counts only for an account whose email is that address and confirmed.
CREATE TABLE admins (
  email     TEXT PRIMARY KEY,       -- normalized (lowercase, trimmed), as users.email
  added_by  TEXT,                   -- the owner's user id when added
  added_at  INTEGER NOT NULL        -- Unix ms
);
