CREATE TABLE manual_week_resets (
  pool_group TEXT PRIMARY KEY CHECK(pool_group IN ('gemini','third_party')),
  cycle_started_at INTEGER NOT NULL,
  account_email TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,
  remaining_fraction REAL NOT NULL CHECK(remaining_fraction BETWEEN 0 AND 1),
  reset_id TEXT NOT NULL
);

CREATE TABLE manual_week_usage (
  pool_group TEXT NOT NULL REFERENCES manual_week_resets(pool_group) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  units_milli INTEGER NOT NULL,
  PRIMARY KEY(pool_group,member_id)
);
