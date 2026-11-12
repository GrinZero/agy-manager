-- Migrate member and family budgets from synthetic points to percentage shares (0..100%).
-- Preserve accounts, encrypted OAuth credentials, sessions, and member tokens, and reset point-era counters.
ALTER TABLE members RENAME COLUMN gemini_5h_limit TO prev_g5;
ALTER TABLE members RENAME COLUMN gemini_wk_limit TO prev_gw;
ALTER TABLE members RENAME COLUMN tp_5h_limit TO prev_t5;
ALTER TABLE members RENAME COLUMN tp_wk_limit TO prev_tw;

ALTER TABLE members ADD COLUMN gemini_5h_limit REAL NOT NULL DEFAULT 25 CHECK(gemini_5h_limit >= 0 AND gemini_5h_limit <= 100);
ALTER TABLE members ADD COLUMN gemini_wk_limit REAL NOT NULL DEFAULT 25 CHECK(gemini_wk_limit >= 0 AND gemini_wk_limit <= 100);
ALTER TABLE members ADD COLUMN tp_5h_limit REAL NOT NULL DEFAULT 25 CHECK(tp_5h_limit >= 0 AND tp_5h_limit <= 100);
ALTER TABLE members ADD COLUMN tp_wk_limit REAL NOT NULL DEFAULT 25 CHECK(tp_wk_limit >= 0 AND tp_wk_limit <= 100);

UPDATE members SET
  gemini_5h_limit = COALESCE((SELECT CASE
    WHEN p.gemini_5h_limit <= 0 THEN 0
    WHEN p.gemini_5h_limit = 250 AND prev_g5 = 62 THEN 25
    WHEN p.gemini_5h_limit = 250 AND prev_g5 = 37 THEN 15
    ELSE MIN(100, ROUND(prev_g5 * 100.0 / p.gemini_5h_limit, 2)) END FROM policy p WHERE p.id = 1), 25),
  gemini_wk_limit = COALESCE((SELECT CASE
    WHEN p.gemini_wk_limit <= 0 THEN 0
    ELSE MIN(100, ROUND(prev_gw * 100.0 / p.gemini_wk_limit, 2)) END FROM policy p WHERE p.id = 1), 25),
  tp_5h_limit = COALESCE((SELECT CASE
    WHEN p.tp_5h_limit <= 0 THEN 0
    WHEN p.tp_5h_limit = 250 AND prev_t5 = 62 THEN 25
    WHEN p.tp_5h_limit = 250 AND prev_t5 = 37 THEN 15
    ELSE MIN(100, ROUND(prev_t5 * 100.0 / p.tp_5h_limit, 2)) END FROM policy p WHERE p.id = 1), 25),
  tp_wk_limit = COALESCE((SELECT CASE
    WHEN p.tp_wk_limit <= 0 THEN 0
    ELSE MIN(100, ROUND(prev_tw * 100.0 / p.tp_wk_limit, 2)) END FROM policy p WHERE p.id = 1), 25);

ALTER TABLE members DROP COLUMN prev_g5;
ALTER TABLE members DROP COLUMN prev_gw;
ALTER TABLE members DROP COLUMN prev_t5;
ALTER TABLE members DROP COLUMN prev_tw;

CREATE TABLE policy_pct (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  gemini_5h_limit REAL NOT NULL DEFAULT 100 CHECK(gemini_5h_limit >= 0 AND gemini_5h_limit <= 100),
  gemini_wk_limit REAL NOT NULL DEFAULT 100 CHECK(gemini_wk_limit >= 0 AND gemini_wk_limit <= 100),
  tp_5h_limit REAL NOT NULL DEFAULT 100 CHECK(tp_5h_limit >= 0 AND tp_5h_limit <= 100),
  tp_wk_limit REAL NOT NULL DEFAULT 100 CHECK(tp_wk_limit >= 0 AND tp_wk_limit <= 100),
  buffer_percent INTEGER NOT NULL DEFAULT 0 CHECK(buffer_percent BETWEEN 0 AND 99),
  reservation_seconds INTEGER NOT NULL DEFAULT 900 CHECK(reservation_seconds BETWEEN 30 AND 3600),
  flash_weight REAL NOT NULL DEFAULT 1 CHECK(flash_weight > 0),
  gemini_weight REAL NOT NULL DEFAULT 3 CHECK(gemini_weight > 0),
  tp_weight REAL NOT NULL DEFAULT 3 CHECK(tp_weight > 0),
  opus_weight REAL NOT NULL DEFAULT 8 CHECK(opus_weight > 0),
  real_quota_guard INTEGER NOT NULL DEFAULT 1 CHECK(real_quota_guard IN (0,1)),
  real_quota_floor INTEGER NOT NULL DEFAULT 0 CHECK(real_quota_floor BETWEEN 0 AND 99),
  calibration_enabled INTEGER NOT NULL DEFAULT 1 CHECK(calibration_enabled IN (0,1))
);
INSERT INTO policy_pct SELECT id,
  CASE WHEN gemini_5h_limit <= 0 THEN 0 ELSE 100 END,
  CASE WHEN gemini_wk_limit <= 0 THEN 0 ELSE 100 END,
  CASE WHEN tp_5h_limit <= 0 THEN 0 ELSE 100 END,
  CASE WHEN tp_wk_limit <= 0 THEN 0 ELSE 100 END,
  buffer_percent, reservation_seconds, flash_weight, gemini_weight, tp_weight, opus_weight,
  1, 0, calibration_enabled FROM policy;
DROP TABLE policy;
ALTER TABLE policy_pct RENAME TO policy;

DROP TABLE usage_logs;
CREATE TABLE usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL REFERENCES members(member_id),
  pool_group TEXT NOT NULL CHECK(pool_group IN ('gemini','third_party')),
  model_name TEXT NOT NULL,
  weight REAL NOT NULL CHECK(weight > 0),
  conversation_id TEXT NOT NULL CHECK(length(conversation_id) > 0),
  invocation_num INTEGER NOT NULL CHECK(invocation_num >= 0),
  status TEXT NOT NULL CHECK(status IN ('reserved','committed','released')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  committed_at INTEGER,
  source TEXT NOT NULL DEFAULT 'check' CHECK(source IN ('check','offline_commit')),
  input_tokens INTEGER CHECK(input_tokens >= 0),
  cache_read_tokens INTEGER CHECK(cache_read_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens >= 0),
  tool_calls INTEGER CHECK(tool_calls >= 0),
  UNIQUE(member_id, conversation_id, invocation_num)
);
CREATE INDEX idx_member_window ON usage_logs(member_id, pool_group, created_at);
CREATE INDEX idx_pool_window ON usage_logs(pool_group, created_at);
CREATE INDEX idx_committed_window ON usage_logs(pool_group, committed_at);
CREATE INDEX idx_calibration_usage ON usage_logs(pool_group, status, committed_at);
CREATE INDEX idx_conversation_latest ON usage_logs(member_id, conversation_id, status, id DESC);

DROP TABLE quota_calibration;
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
  lower_fraction_per_unit REAL CHECK(lower_fraction_per_unit >= 0 AND lower_fraction_per_unit <= 1),
  fraction_per_point REAL CHECK(fraction_per_point > 0 AND fraction_per_point <= 1),
  upper_fraction_per_unit REAL CHECK(upper_fraction_per_unit > 0 AND upper_fraction_per_unit <= 1),
  hist_units REAL NOT NULL DEFAULT 0,
  hist_fraction REAL NOT NULL DEFAULT 0,
  cycle_units REAL NOT NULL DEFAULT 0,
  cycle_drop REAL NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  total_points REAL NOT NULL DEFAULT 0,
  updated_at INTEGER,
  status TEXT NOT NULL,
  initial_fraction REAL NOT NULL DEFAULT 1 CHECK(initial_fraction BETWEEN 0 AND 1),
  initial_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(pool_group, window_name)
);

DROP TABLE quota_samples;
CREATE TABLE quota_samples (
  pool_group TEXT NOT NULL,
  window_name TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  points REAL NOT NULL CHECK(points > 0),
  fraction_used REAL NOT NULL CHECK(fraction_used > 0),
  fraction_per_point REAL NOT NULL CHECK(fraction_per_point > 0),
  upper_fraction_per_unit REAL NOT NULL CHECK(upper_fraction_per_unit > 0),
  PRIMARY KEY(pool_group, window_name, observed_at)
);

UPDATE real_quota_budgets SET expires_at = snapshot_at + 900 WHERE expires_at < snapshot_at + 900;
