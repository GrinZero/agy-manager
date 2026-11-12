CREATE TABLE family_connection (
  id INTEGER PRIMARY KEY CHECK(id=1),
  generation INTEGER NOT NULL DEFAULT 0,
  email TEXT,
  google_id TEXT,
  client_id TEXT,
  credentials TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  snapshot_json TEXT,
  checked_at INTEGER,
  attempted_at INTEGER,
  last_error TEXT,
  refresh_lock INTEGER NOT NULL DEFAULT 0
);
INSERT INTO family_connection (id) VALUES (1);
CREATE TABLE family_oauth_sessions (
  state_hash TEXT PRIMARY KEY,
  proof TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX family_oauth_expiry ON family_oauth_sessions(expires_at);
