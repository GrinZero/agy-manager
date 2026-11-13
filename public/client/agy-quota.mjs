#!/usr/bin/env node
// Intentionally has no npm dependencies. Only a minimal invocation envelope leaves the machine.
import {readFile, mkdir, writeFile, readdir, unlink, open, chmod, rename, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';

const REQUEST_TIMEOUT_MS = 10000;
const REQUEST_BUDGET_MS = 16000;

async function scanLatestPlannerStep(transcriptPath, minStepIndex = 0, stopAtUserInput = true) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  let handle;
  try {
    handle = await open(transcriptPath, 'r');
    const {size} = await handle.stat();
    if (!size) return null;
    const chunkSize = 262144, minOffset = Math.max(0, size - 2 * 1024 * 1024);
    let pos = size, carry = Buffer.alloc(0);
    while (pos > minOffset) {
      const readLen = Math.min(chunkSize, pos - minOffset);
      pos -= readLen;
      const chunk = Buffer.alloc(readLen);
      const {bytesRead} = await handle.read(chunk, 0, readLen, pos);
      const combined = carry.length ? Buffer.concat([chunk.subarray(0, bytesRead), carry]) : chunk.subarray(0, bytesRead);
      const firstNewline = pos > minOffset ? combined.indexOf(0x0a) : -1;
      if (pos > minOffset && firstNewline === -1) { carry = combined; continue; }
      const slice = firstNewline >= 0 ? combined.subarray(firstNewline + 1) : combined;
      carry = firstNewline >= 0 ? combined.subarray(0, firstNewline) : Buffer.alloc(0);
      const lines = slice.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let step;
        try { step = JSON.parse(line); } catch { continue; }
        if (Number.isSafeInteger(minStepIndex) && minStepIndex > 0 && Number.isSafeInteger(step?.step_index) && step.step_index < minStepIndex) return null;
        if (step?.type === 'PLANNER_RESPONSE' && (Number.isSafeInteger(step.input_tokens) || Number.isSafeInteger(step.output_tokens))) {
          const clamp = v => Number.isSafeInteger(v) && v >= 0 ? Math.min(v, 100_000_000) : 0;
          return {
            inputTokens: clamp(step.input_tokens),
            cacheReadTokens: clamp(step.cache_read_tokens),
            outputTokens: clamp(step.output_tokens),
            toolCalls: Array.isArray(step.tool_calls) ? Math.min(step.tool_calls.length, 1000) : 0
          };
        }
        if (stopAtUserInput && step?.type === 'USER_INPUT') return null;
      }
    }
  } catch { /* Missing or unreadable local transcript falls back to base model weight. */ }
  finally { await handle?.close().catch(() => {}); }
  return null;
}

export async function readTelemetry(transcriptPath, minStepIndex = 0) {
  return (await scanLatestPlannerStep(transcriptPath, minStepIndex, true)) ?? {};
}

export async function readContextTelemetry(transcriptPath) {
  const step = await scanLatestPlannerStep(transcriptPath, 0, false);
  if (!step) return {};
  const contextTokens = Math.min(100_000_000, step.inputTokens + step.cacheReadTokens + step.outputTokens);
  return contextTokens > 0 ? {contextTokens} : {};
}

export function envelope(body, action, telemetry = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Invalid payload');
  const conversationId = body.conversationId;
  if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 200) throw Error('Missing conversationId');
  if (action === 'release') return {conversationId, fullyIdle: body.fullyIdle === true};
  if (typeof body.modelName !== 'string' || !body.modelName || !Number.isSafeInteger(body.invocationNum) || body.invocationNum < 0) throw Error('Missing invocation fields');
  const stepOffset = Number.isSafeInteger(body.initialNumSteps) && body.initialNumSteps > 0 ? body.initialNumSteps * 10000 : 0;
  const invocationNum = stepOffset + body.invocationNum;
  const opt = k => Number.isSafeInteger(telemetry[k]) && telemetry[k] >= 0 ? {[k]: telemetry[k]} : Number.isSafeInteger(body[k]) && body[k] >= 0 ? {[k]: body[k]} : {};
  return {
    modelName: body.modelName, conversationId, invocationNum,
    ...(action === 'check' ? {...opt('contextTokens')} : {}),
    ...(action === 'commit' ? {...opt('inputTokens'), ...opt('cacheReadTokens'), ...opt('outputTokens'), ...opt('toolCalls')} : {}),
    ...(body.success === false ? {success: false} : {}), ...(typeof body.error === 'string' && body.error ? {success: false} : {})
  };
}
async function readInput() {
  let raw = '', size = 0;
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > 8 * 1024 * 1024) throw Error('Payload too large');
    raw += chunk;
  }
  return JSON.parse(raw);
}
export function validateUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Use a service origin URL');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('HTTPS is required');
  return url.origin;
}
export async function send(config, action, payload, timeout = REQUEST_TIMEOUT_MS, retries = 2, meta = null) {
  const url = `${validateUrl(config.url)}/${action}`, requestBody = JSON.stringify(payload);
  const deadline = performance.now() + Math.min(REQUEST_BUDGET_MS, timeout * (retries + 1) + 1000);
  // All actions are idempotent. Keep the exact invocation identity and body on retries.
  for (let attempt = 0; attempt <= retries; attempt++) {
    let retryAfter = 0;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${config.token}`},
        // Cold proxy/TLS connections can take more than five seconds. Later attempts
        // use only the remaining budget, so retries cannot extend the hook deadline.
        body: requestBody, signal: AbortSignal.timeout(Math.max(1, Math.min(timeout, Math.floor(deadline - performance.now()))))
      });
      if (!response.ok) {
        const retryable = [408, 429].includes(response.status) || response.status >= 500 && response.status <= 599;
        const hint = response.headers.get('retry-after');
        if (hint) retryAfter = /^\d+$/.test(hint) ? Number(hint) * 1000 : Math.max(0, Date.parse(hint) - Date.now()) || 0;
        await response.body?.cancel().catch(() => {});
        throw Object.assign(Error(`Service HTTP ${response.status}`), {retryable, status: response.status});
      }
      const clientHash = response.headers.get('x-agy-client-sha256')?.trim().toLowerCase();
      if (meta && typeof meta === 'object' && clientHash && /^[a-f0-9]{64}$/.test(clientHash)) meta.clientSha256 = clientHash;
      const body = await response.json();
      // Business denials and invalid responses are final, not transport retries.
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Invalid service response');
      return {
        ...(Array.isArray(body.injectSteps) ? {injectSteps: body.injectSteps} : {}),
        ...(body.terminationBehavior === 'terminate' ? {terminationBehavior: 'terminate'} : {})
      };
    } catch (error) {
      const transient = error.retryable === true || error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name);
      if (!transient || attempt === retries) throw error;
      const delay = Math.max(200 * 2 ** attempt + Math.floor(Math.random() * 100), retryAfter);
      // Respect Retry-After and leave enough time for a useful final attempt.
      if (performance.now() + delay + Math.min(timeout, 1000) > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
function checkSyntax(filePath) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--check', filePath], {timeout: 1500}, error => error ? reject(error) : resolve());
  });
}
export async function selfUpdate(root, config, expectedSha256, timeout = REQUEST_TIMEOUT_MS) {
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) return false;
  const targetPath = join(root, 'agy-quota.mjs');
  const current = await readFile(targetPath, 'utf8').catch(() => '');
  if (current && createHash('sha256').update(current).digest('hex') === expectedSha256) return false;
  const res = await fetch(`${validateUrl(config.url)}/client/agy-quota.mjs`, {signal: AbortSignal.timeout(timeout)});
  if (!res.ok) return false;
  const next = await res.text();
  if (!next.startsWith('#!/usr/bin/env node') || createHash('sha256').update(next).digest('hex') !== expectedSha256) return false;
  await mkdir(root, {recursive: true, mode: 0o700});
  const tempPath = join(root, `.agy-quota.${process.pid}-${Date.now()}.mjs`);
  try {
    await writeFile(tempPath, next, {mode: 0o700});
    await chmod(tempPath, 0o700);
    await checkSyntax(tempPath);
    await rename(tempPath, targetPath);
    return true;
  } catch {
    await unlink(tempPath).catch(() => {});
    return false;
  }
}
function destination(config) { return createHash('sha256').update(`${config.url}\n${config.token}`).digest('hex'); }
async function spool(root, config, payload) {
  await mkdir(join(root, 'pending'), {recursive: true, mode: 0o700});
  const key = createHash('sha256').update(JSON.stringify([destination(config), payload.conversationId, payload.invocationNum])).digest('hex');
  const path = join(root, 'pending', `${key}.json`);
  await writeFile(path, JSON.stringify({destination: destination(config), payload}), {mode: 0o600});
  return path;
}
async function flush(root, config) {
  const files = await readdir(join(root, 'pending')).catch(() => []);
  // Bound total work by the process deadline. Idempotency makes concurrent retries safe.
  for (const file of files.slice(0, 10)) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const path = join(root, 'pending', file);
    let saved;
    try { saved = JSON.parse(await readFile(path, 'utf8')); }
    catch { await unlink(path).catch(() => {}); continue; }
    if (!saved?.payload || typeof saved.destination !== 'string') { await unlink(path).catch(() => {}); continue; }
    if (saved.destination !== destination(config)) continue;
    try {
      await send(config, 'commit', saved.payload, REQUEST_TIMEOUT_MS, 0);
      await unlink(path).catch(() => {});
    } catch (e) {
      if (e.retryable === false && ![401, 403].includes(e.status)) { await unlink(path).catch(() => {}); continue; }
      throw e;
    }
  }
}
let emitted = false;
function unavailable() {
  return process.argv[2] === 'check' ? {injectSteps: [{errorMessage: {userMessage: '【额度检查失败】无法确认家庭与成员配额，本次调用已暂停。请检查网络或联系管理员。'}}], terminationBehavior: 'terminate'} : {};
}
export async function main() {
  const action = process.argv[2];
  if (!['check', 'commit', 'release'].includes(action)) throw Error('Unknown hook action');
  const root = process.env.AGY_QUOTA_CONFIG_DIR || join(homedir(), '.gemini', 'config', 'agy-family-quota');
  const config = JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8'));
  const input = await readInput();
  const telemetry = action === 'commit'
    ? await readTelemetry(input?.transcriptPath, input?.initialNumSteps)
    : action === 'check' ? await readContextTelemetry(input?.transcriptPath) : {};
  const payload = envelope(input, action, telemetry);
  if (action === 'release' && !payload.fullyIdle) return {};
  // Persist completions before network access so a crashed/offline process can retry later.
  const pendingPath = action === 'commit' ? await spool(root, config, payload) : null;
  const meta = {};
  let response;
  try { response = await send(config, action, payload, REQUEST_TIMEOUT_MS, 2, meta); }
  catch (e) {
    if (pendingPath && e.retryable === false && ![401, 403].includes(e.status)) await unlink(pendingPath).catch(() => {});
    process.stderr.write(`[agy-quota] ${e.message}; 额度检查失败时暂停新调用\n`);
    return unavailable();
  }
  process.stdout.write(JSON.stringify(response) + '\n');
  emitted = true;
  if (pendingPath) await unlink(pendingPath).catch(() => {});
  // Apply updates before replay so a slow outbox cannot indefinitely starve updates.
  if (meta.clientSha256) await selfUpdate(root, config, meta.clientSha256).catch(() => {});
  // Retry AFTER today's check; never extend admission latency with an offline queue.
  if (action !== 'release') await flush(root, config).catch(() => {});
  return null;
}
const isMain = process.argv[1] && await realpath(process.argv[1]).catch(() => process.argv[1]) === await realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url));
if (isMain) {
  // Hard wall-clock deadline includes stdin, disk, network and retries.
  const timer = setTimeout(() => { if (!emitted) process.stdout.write(JSON.stringify(unavailable()) + '\n'); process.exit(0); }, 16500);
  try { const out = await main(); if (out !== null) { process.stdout.write(JSON.stringify(out) + '\n'); emitted = true; } }
  catch (e) { process.stderr.write(`[agy-quota] ${e.message}\n`); if (!emitted) process.stdout.write(JSON.stringify(unavailable()) + '\n'); }
  // Undici can retain sockets after abort; explicitly exit so cleanup cannot exceed the hook budget.
  finally { clearTimeout(timer); process.exit(0); }
}
