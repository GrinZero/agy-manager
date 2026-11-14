-- Replace the page cache with transactionally maintained usage totals.
DROP TRIGGER usage_statistics_insert;
DROP TRIGGER usage_statistics_update;
DROP TRIGGER usage_statistics_delete;
DROP TABLE usage_statistics;

CREATE TABLE usage_cycles (
  pool_group TEXT NOT NULL,
  window_name TEXT NOT NULL CHECK(window_name IN ('fiveHour','week')),
  cycle_started_at INTEGER NOT NULL,
  PRIMARY KEY(pool_group,window_name)
);
CREATE TABLE usage_totals (
  pool_group TEXT NOT NULL,
  window_name TEXT NOT NULL,
  member_id TEXT NOT NULL,
  units_milli INTEGER NOT NULL CHECK(units_milli>=0),
  PRIMARY KEY(pool_group,window_name,member_id)
);
CREATE TABLE usage_activity (
  pool_group TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO usage_activity(pool_group,last_activity_at)
  SELECT p.pool_group,COALESCE(MAX(MAX(u.created_at,COALESCE(u.committed_at,0))),0)
  FROM (SELECT 'gemini' AS pool_group UNION ALL SELECT 'third_party') p
  LEFT JOIN usage_logs u ON u.pool_group=p.pool_group GROUP BY p.pool_group;

-- Calibration checkpoints advance only after a successful official observation.
CREATE TABLE calibration_totals (
  pool_group TEXT NOT NULL,
  window_name TEXT NOT NULL,
  anchor_at INTEGER NOT NULL,
  through_at INTEGER NOT NULL,
  done_milli INTEGER NOT NULL,
  span_milli INTEGER NOT NULL,
  PRIMARY KEY(pool_group,window_name)
);
CREATE TRIGGER usage_totals_insert AFTER INSERT ON usage_logs BEGIN

  INSERT INTO usage_totals(pool_group,window_name,member_id,units_milli)
    SELECT NEW.pool_group,c.window_name,NEW.member_id,CAST(ROUND(NEW.weight*1000) AS INTEGER)
    FROM usage_cycles c WHERE c.pool_group=NEW.pool_group
      AND NEW.status='committed' AND NEW.committed_at>=c.cycle_started_at
    ON CONFLICT(pool_group,window_name,member_id) DO UPDATE SET units_milli=units_milli+excluded.units_milli;
  UPDATE calibration_totals SET
    done_milli=done_milli+CASE WHEN NEW.created_at>=anchor_at THEN CAST(ROUND(NEW.weight*1000) AS INTEGER) ELSE 0 END,
    span_milli=span_milli+CASE WHEN NEW.created_at<anchor_at THEN CAST(ROUND(NEW.weight*1000) AS INTEGER) ELSE 0 END
    WHERE pool_group=NEW.pool_group AND NEW.status='committed' AND NEW.source!='offline_commit'
      AND NEW.committed_at>=anchor_at AND NEW.committed_at<=through_at;

  UPDATE usage_activity SET revision=revision+1,
    last_activity_at=MAX(last_activity_at,NEW.created_at,COALESCE(NEW.committed_at,0)) WHERE pool_group=NEW.pool_group;
END;
CREATE TRIGGER usage_totals_delete AFTER DELETE ON usage_logs BEGIN

  UPDATE usage_totals SET units_milli=units_milli-CAST(ROUND(OLD.weight*1000) AS INTEGER)
    WHERE pool_group=OLD.pool_group AND member_id=OLD.member_id AND OLD.status='committed'
      AND EXISTS(SELECT 1 FROM usage_cycles c WHERE c.pool_group=usage_totals.pool_group
        AND c.window_name=usage_totals.window_name AND OLD.committed_at>=c.cycle_started_at);
  UPDATE calibration_totals SET
    done_milli=done_milli-CASE WHEN OLD.created_at>=anchor_at THEN CAST(ROUND(OLD.weight*1000) AS INTEGER) ELSE 0 END,
    span_milli=span_milli-CASE WHEN OLD.created_at<anchor_at THEN CAST(ROUND(OLD.weight*1000) AS INTEGER) ELSE 0 END
    WHERE pool_group=OLD.pool_group AND OLD.status='committed' AND OLD.source!='offline_commit'
      AND OLD.committed_at>=anchor_at AND OLD.committed_at<=through_at;

  UPDATE usage_activity SET revision=revision+1 WHERE pool_group=OLD.pool_group;
END;
CREATE TRIGGER usage_totals_update AFTER UPDATE ON usage_logs
WHEN OLD.member_id IS NOT NEW.member_id OR OLD.pool_group IS NOT NEW.pool_group OR OLD.weight IS NOT NEW.weight
  OR OLD.status IS NOT NEW.status OR OLD.created_at IS NOT NEW.created_at OR OLD.committed_at IS NOT NEW.committed_at
  OR OLD.expires_at IS NOT NEW.expires_at OR OLD.source IS NOT NEW.source
BEGIN

  UPDATE usage_totals SET units_milli=units_milli-CAST(ROUND(OLD.weight*1000) AS INTEGER)
    WHERE pool_group=OLD.pool_group AND member_id=OLD.member_id AND OLD.status='committed'
      AND EXISTS(SELECT 1 FROM usage_cycles c WHERE c.pool_group=usage_totals.pool_group
        AND c.window_name=usage_totals.window_name AND OLD.committed_at>=c.cycle_started_at);
  UPDATE calibration_totals SET
    done_milli=done_milli-CASE WHEN OLD.created_at>=anchor_at THEN CAST(ROUND(OLD.weight*1000) AS INTEGER) ELSE 0 END,
    span_milli=span_milli-CASE WHEN OLD.created_at<anchor_at THEN CAST(ROUND(OLD.weight*1000) AS INTEGER) ELSE 0 END
    WHERE pool_group=OLD.pool_group AND OLD.status='committed' AND OLD.source!='offline_commit'
      AND OLD.committed_at>=anchor_at AND OLD.committed_at<=through_at;


  INSERT INTO usage_totals(pool_group,window_name,member_id,units_milli)
    SELECT NEW.pool_group,c.window_name,NEW.member_id,CAST(ROUND(NEW.weight*1000) AS INTEGER)
    FROM usage_cycles c WHERE c.pool_group=NEW.pool_group
      AND NEW.status='committed' AND NEW.committed_at>=c.cycle_started_at
    ON CONFLICT(pool_group,window_name,member_id) DO UPDATE SET units_milli=units_milli+excluded.units_milli;
  UPDATE calibration_totals SET
    done_milli=done_milli+CASE WHEN NEW.created_at>=anchor_at THEN CAST(ROUND(NEW.weight*1000) AS INTEGER) ELSE 0 END,
    span_milli=span_milli+CASE WHEN NEW.created_at<anchor_at THEN CAST(ROUND(NEW.weight*1000) AS INTEGER) ELSE 0 END
    WHERE pool_group=NEW.pool_group AND NEW.status='committed' AND NEW.source!='offline_commit'
      AND NEW.committed_at>=anchor_at AND NEW.committed_at<=through_at;

  UPDATE usage_activity SET revision=revision+1,
    last_activity_at=MAX(last_activity_at,NEW.created_at,COALESCE(NEW.committed_at,0))
    WHERE pool_group IN (OLD.pool_group,NEW.pool_group);
END;
