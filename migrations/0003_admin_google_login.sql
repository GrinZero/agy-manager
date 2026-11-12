CREATE TABLE admin_identity (
  id INTEGER PRIMARY KEY CHECK(id=1),
  email TEXT NOT NULL,
  google_id TEXT
);
INSERT INTO admin_identity (id,email) SELECT 1,lower(email) FROM mother_account WHERE id=1;
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  google_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
ALTER TABLE oauth_sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'mother';
ALTER TABLE oauth_sessions ADD COLUMN browser_hash TEXT NOT NULL DEFAULT '';
