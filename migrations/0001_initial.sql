CREATE TABLE members (
  member_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  gemini_5h_limit INTEGER NOT NULL DEFAULT 75 CHECK(gemini_5h_limit >= 0),
  gemini_wk_limit INTEGER NOT NULL DEFAULT 375 CHECK(gemini_wk_limit >= 0),
  tp_5h_limit INTEGER NOT NULL DEFAULT 45 CHECK(tp_5h_limit >= 0),
  tp_wk_limit INTEGER NOT NULL DEFAULT 225 CHECK(tp_wk_limit >= 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE policy (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  gemini_5h_limit INTEGER NOT NULL DEFAULT 300 CHECK(gemini_5h_limit >= 0),
  gemini_wk_limit INTEGER NOT NULL DEFAULT 1500 CHECK(gemini_wk_limit >= 0),
  tp_5h_limit INTEGER NOT NULL DEFAULT 300 CHECK(tp_5h_limit >= 0),
  tp_wk_limit INTEGER NOT NULL DEFAULT 1500 CHECK(tp_wk_limit >= 0),
  buffer_percent INTEGER NOT NULL DEFAULT 10 CHECK(buffer_percent BETWEEN 0 AND 99),
  reservation_seconds INTEGER NOT NULL DEFAULT 900 CHECK(reservation_seconds BETWEEN 30 AND 3600),
  flash_weight INTEGER NOT NULL DEFAULT 1 CHECK(flash_weight > 0),
  gemini_weight INTEGER NOT NULL DEFAULT 3 CHECK(gemini_weight > 0),
  tp_weight INTEGER NOT NULL DEFAULT 3 CHECK(tp_weight > 0),
  opus_weight INTEGER NOT NULL DEFAULT 8 CHECK(opus_weight > 0)
);
INSERT INTO policy (id) VALUES (1);

CREATE TABLE usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL REFERENCES members(member_id),
  pool_group TEXT NOT NULL CHECK(pool_group IN ('gemini','third_party')),
  model_name TEXT NOT NULL,
  weight INTEGER NOT NULL CHECK(weight > 0),
  conversation_id TEXT NOT NULL CHECK(length(conversation_id) > 0),
  invocation_num INTEGER NOT NULL CHECK(invocation_num >= 0),
  status TEXT NOT NULL CHECK(status IN ('reserved','committed','released')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  committed_at INTEGER,
  source TEXT NOT NULL DEFAULT 'check' CHECK(source IN ('check','offline_commit')),
  UNIQUE(member_id, conversation_id, invocation_num)
);
CREATE INDEX idx_member_window ON usage_logs(member_id, pool_group, created_at);
CREATE INDEX idx_pool_window ON usage_logs(pool_group, created_at);
CREATE INDEX idx_committed_window ON usage_logs(pool_group, committed_at);
