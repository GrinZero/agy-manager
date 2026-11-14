-- Read only live reservations and relevant committed ranges. Preserve all history.
CREATE INDEX idx_live_reservations ON usage_logs(pool_group,expires_at) WHERE status='reserved';
CREATE INDEX idx_member_committed ON usage_logs(member_id,pool_group,committed_at) WHERE status='committed';
