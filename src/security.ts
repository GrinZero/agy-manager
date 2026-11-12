export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function hashToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function newToken(): string {
  return 'agy_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
}
export function bearer(req: Request): string {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.get('authorization') || '');
  if (!match || match[1].length > 256) throw new HttpError(401, '请提供有效令牌');
  return match[1];
}
export async function requireAdmin(req: Request, expected: string): Promise<void> {
  if (!expected || expected.length < 32) throw new HttpError(503, '请先配置 ADMIN_TOKEN（至少 32 个字符）');
  const [actual, wanted] = await Promise.all([hashToken(bearer(req)), hashToken(expected)]);
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ wanted.charCodeAt(i);
  if (diff) throw new HttpError(401, '管理员令牌无效');
}
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  // Stream with a byte cap: Content-Length can be absent or untrusted.
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, '请求体不能为空');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16_384) { await reader.cancel(); throw new HttpError(413, '请求体过大'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(400, 'JSON 格式错误'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '需要 JSON 对象');
  return body as Record<string, unknown>;
}
export function integer(value: unknown, name: string, min = 0, max = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new HttpError(400, `${name} 必须是 ${min} 至 ${max} 的整数`);
  return value;
}
export function real(value: unknown, name: string, min = 0.01, max = 10_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new HttpError(400, `${name} 必须是 ${min} 至 ${max} 的数值`);
  return Math.round(value * 100) / 100;
}
export function string(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value))
    throw new HttpError(400, `${name} 格式错误`);
  return value.trim();
}
export function json(data: unknown, status = 200): Response {
  return Response.json(data, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
}
