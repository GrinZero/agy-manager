ALTER TABLE usage_logs ADD COLUMN input_tokens INTEGER CHECK(input_tokens >= 0);
ALTER TABLE usage_logs ADD COLUMN cache_read_tokens INTEGER CHECK(cache_read_tokens >= 0);
ALTER TABLE usage_logs ADD COLUMN output_tokens INTEGER CHECK(output_tokens >= 0);
ALTER TABLE usage_logs ADD COLUMN tool_calls INTEGER CHECK(tool_calls >= 0);
