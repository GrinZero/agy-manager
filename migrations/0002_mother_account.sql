CREATE TABLE mother_account (
  id INTEGER PRIMARY KEY CHECK(id=1),
  email TEXT NOT NULL,
  credentials TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  snapshot_json TEXT,
  checked_at INTEGER,
  attempted_at INTEGER,
  last_error TEXT,
  refresh_lock INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE oauth_sessions (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
ALTER TABLE policy ADD COLUMN real_quota_guard INTEGER NOT NULL DEFAULT 0 CHECK(real_quota_guard IN (0,1));
ALTER TABLE policy ADD COLUMN real_quota_floor INTEGER NOT NULL DEFAULT 5 CHECK(real_quota_floor BETWEEN 0 AND 99);
CREATE TABLE real_quota_budgets (
  pool_group TEXT NOT NULL CHECK(pool_group IN ('gemini','third_party')),
  window_name TEXT NOT NULL CHECK(window_name IN ('fiveHour','week')),
  remaining_fraction REAL NOT NULL CHECK(remaining_fraction BETWEEN 0 AND 1),
  snapshot_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(pool_group,window_name)
);
