export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  ADMIN_TOKEN?: string;
  ADMIN_GOOGLE_EMAIL?: string;
  ACCOUNT_ENCRYPTION_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
}
export interface Limits {
  gemini_5h_limit: number;
  gemini_wk_limit: number;
  tp_5h_limit: number;
  tp_wk_limit: number;
}
export interface Member extends Limits {
  member_id: string;
  name: string;
  email: string | null;
  google_id: string | null;
  token_hash: string;
  enabled: number;
  created_at: number;
  deleted_at: number | null;
}
export interface Policy extends Limits {
  id: number;
  buffer_percent: number;
  reservation_seconds: number;
  flash_weight: number;
  gemini_weight: number;
  tp_weight: number;
  opus_weight: number;
  real_quota_guard: number;
  real_quota_floor: number;
  calibration_enabled: number;
}
export type Pool = 'gemini' | 'third_party';
export type QuotaWindow = 'fiveHour' | 'week';
export interface Invocation {
  modelName: string;
  conversationId: string;
  invocationNum: number;
  contextTokens?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
}
export interface UsageRow {
  member_id: string;
  pool_group: Pool;
  model_name: string;
  weight: number;
  status: 'reserved' | 'committed' | 'released';
  expires_at: number;
  input_tokens?: number | null;
  cache_read_tokens?: number | null;
  output_tokens?: number | null;
  tool_calls?: number | null;
}
