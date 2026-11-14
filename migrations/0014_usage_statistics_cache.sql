-- Cache raw units only. Rates, cycle boundaries and reservation expiry stay live.
CREATE TABLE usage_statistics (
  pool_group TEXT PRIMARY KEY CHECK(pool_group IN ('gemini','third_party')),
  revision INTEGER NOT NULL DEFAULT 0,
  cached_revision INTEGER,
  five_hour_start INTEGER,
  week_start INTEGER,
  computed_at INTEGER,
  next_expiry INTEGER,
  totals_json TEXT
);
INSERT INTO usage_statistics(pool_group) VALUES ('gemini'),('third_party');

-- Invalidation is atomic with every ledger write, across all Worker isolates.
CREATE TRIGGER usage_statistics_insert AFTER INSERT ON usage_logs BEGIN
  UPDATE usage_statistics SET revision=revision+1 WHERE pool_group=NEW.pool_group;
END;
CREATE TRIGGER usage_statistics_delete AFTER DELETE ON usage_logs BEGIN
  UPDATE usage_statistics SET revision=revision+1 WHERE pool_group=OLD.pool_group;
END;
CREATE TRIGGER usage_statistics_update AFTER UPDATE ON usage_logs
WHEN OLD.member_id IS NOT NEW.member_id OR OLD.pool_group IS NOT NEW.pool_group
  OR OLD.weight IS NOT NEW.weight OR OLD.status IS NOT NEW.status
  OR OLD.committed_at IS NOT NEW.committed_at OR OLD.expires_at IS NOT NEW.expires_at
BEGIN
  UPDATE usage_statistics SET revision=revision+1 WHERE pool_group IN (OLD.pool_group,NEW.pool_group);
END;

-- Member history should seek the latest 80 rows instead of sorting all history.
CREATE INDEX idx_member_history ON usage_logs(member_id,id DESC);
