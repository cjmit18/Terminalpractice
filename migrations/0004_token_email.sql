-- The address a one-time link was sent to. A confirm link verifies only that exact address, even if the
-- account's address changes between issuing the link and opening it. NULL for links not tied to an address.
ALTER TABLE auth_tokens ADD COLUMN email TEXT;
