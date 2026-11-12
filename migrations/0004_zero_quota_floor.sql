-- Replace the old 5% default and retain explicitly customized thresholds.
ALTER TABLE policy RENAME COLUMN real_quota_floor TO previous_real_quota_floor;
ALTER TABLE policy ADD COLUMN real_quota_floor INTEGER NOT NULL DEFAULT 0 CHECK(real_quota_floor BETWEEN 0 AND 99);
UPDATE policy SET real_quota_floor = CASE WHEN previous_real_quota_floor = 5 THEN 0 ELSE previous_real_quota_floor END;
ALTER TABLE policy DROP COLUMN previous_real_quota_floor;
