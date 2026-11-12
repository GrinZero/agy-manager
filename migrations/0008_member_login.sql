ALTER TABLE members ADD COLUMN email TEXT;
ALTER TABLE members ADD COLUMN google_id TEXT;
CREATE UNIQUE INDEX members_active_email ON members(email) WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE TABLE member_sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(member_id),
  email TEXT NOT NULL,
  google_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX member_sessions_expiry ON member_sessions(expires_at);
