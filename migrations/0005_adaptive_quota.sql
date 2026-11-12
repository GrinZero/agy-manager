CREATE TABLE policy_next (
  id INTEGER PRIMARY KEY CHECK(id=1),
  gemini_5h_limit INTEGER NOT NULL DEFAULT 250 CHECK(gemini_5h_limit>=0),
  gemini_wk_limit INTEGER NOT NULL DEFAULT 2000 CHECK(gemini_wk_limit>=0),
  tp_5h_limit INTEGER NOT NULL DEFAULT 250 CHECK(tp_5h_limit>=0),
  tp_wk_limit INTEGER NOT NULL DEFAULT 2000 CHECK(tp_wk_limit>=0),
  buffer_percent INTEGER NOT NULL DEFAULT 0 CHECK(buffer_percent BETWEEN 0 AND 99),
  reservation_seconds INTEGER NOT NULL DEFAULT 900 CHECK(reservation_seconds BETWEEN 30 AND 3600),
  flash_weight INTEGER NOT NULL DEFAULT 1 CHECK(flash_weight>0),
  gemini_weight INTEGER NOT NULL DEFAULT 3 CHECK(gemini_weight>0),
  tp_weight INTEGER NOT NULL DEFAULT 3 CHECK(tp_weight>0),
  opus_weight INTEGER NOT NULL DEFAULT 8 CHECK(opus_weight>0),
  real_quota_guard INTEGER NOT NULL DEFAULT 0 CHECK(real_quota_guard IN (0,1)),
  real_quota_floor INTEGER NOT NULL DEFAULT 0 CHECK(real_quota_floor BETWEEN 0 AND 99),
  calibration_enabled INTEGER NOT NULL DEFAULT 1 CHECK(calibration_enabled IN (0,1))
);
INSERT INTO policy_next SELECT id,
  CASE WHEN gemini_5h_limit=300 THEN 250 ELSE gemini_5h_limit END,
  CASE WHEN gemini_wk_limit=1500 THEN 2000 ELSE gemini_wk_limit END,
  CASE WHEN tp_5h_limit=300 THEN 250 ELSE tp_5h_limit END,
  CASE WHEN tp_wk_limit=1500 THEN 2000 ELSE tp_wk_limit END,
  CASE WHEN buffer_percent=10 THEN 0 ELSE buffer_percent END,
  reservation_seconds,flash_weight,gemini_weight,tp_weight,opus_weight,real_quota_guard,real_quota_floor,1 FROM policy;
DROP TABLE policy;
ALTER TABLE policy_next RENAME TO policy;

CREATE TABLE quota_calibration (
  pool_group TEXT NOT NULL CHECK(pool_group IN ('gemini','third_party')),
  window_name TEXT NOT NULL CHECK(window_name IN ('fiveHour','week')),
  account_email TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  cycle_started_at INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  last_fraction REAL NOT NULL,
  anchor_at INTEGER NOT NULL,
  anchor_fraction REAL NOT NULL,
  anchor_clear INTEGER NOT NULL CHECK(anchor_clear IN (0,1)),
  fraction_per_point REAL CHECK(fraction_per_point>0 AND fraction_per_point<=1),
  weighted_points REAL NOT NULL DEFAULT 0,
  weighted_fraction REAL NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  total_points INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  status TEXT NOT NULL,
  PRIMARY KEY(pool_group,window_name)
);
CREATE TABLE quota_samples (
  pool_group TEXT NOT NULL,
  window_name TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  points INTEGER NOT NULL CHECK(points>0),
  fraction_used REAL NOT NULL CHECK(fraction_used>0),
  fraction_per_point REAL NOT NULL CHECK(fraction_per_point>0),
  PRIMARY KEY(pool_group,window_name,observed_at)
);
CREATE INDEX idx_calibration_usage ON usage_logs(pool_group,status,committed_at);
