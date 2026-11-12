ALTER TABLE quota_calibration ADD COLUMN initial_fraction REAL NOT NULL DEFAULT 1 CHECK(initial_fraction BETWEEN 0 AND 1);
ALTER TABLE quota_calibration ADD COLUMN initial_at INTEGER NOT NULL DEFAULT 0;

UPDATE quota_calibration SET initial_fraction=last_fraction,initial_at=observed_at;
