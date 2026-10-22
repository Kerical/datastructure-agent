import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const windows = new Map();
const usage = new Map();
const receipts = new Set();
const ipAggregateWindows = new Map(); // P2 FIX: IP 聚合防 sessionId 轮换绕过
const defaultLedger = fileURLToPath(new URL('../../../data/private/agent-budget.json', import.meta.url));

function positive(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function source(req) {
  // No proxy is configured: forwarded headers and browser session IDs are untrusted.
  return createHash('sha256').update(req?.socket?.remoteAddress || 'internal').digest('hex');
}

function day() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); }

function sessionKey(req, sid) { return `${day()}|${source(req)}|${typeof sid === 'string' ? sid : 'anon'}`; }

function record(req, sid) {
  const key = sessionKey(req, sid);
  for (const old of usage.keys()) if (!old.startsWith(day() + '|')) usage.delete(old);
  if (!usage.has(key)) usage.set(key, { requests: 0, failures: 0, tokens: 0, cost: 0, unknown: 0, unknownTokens: 0, unknownCost: 0, elapsedMs: 0 });
  return usage.get(key);
}

function ledgerPath() { return resolve(process.env.AGENT_BUDGET_FILE || defaultLedger); }

function loadLedger() {
  const path = ledgerPath();
  if (!existsSync(path)) return { version: 1, totalCommitted: 0, days: {} };
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.version !== 1 || !Number.isFinite(data.totalCommitted) || data.totalCommitted < 0 || !data.days || typeof data.days !== 'object') {
    throw new Error('INVALID_BUDGET_LEDGER');
  }
  return data;
}

function saveLedger(data) {
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + '.tmp';
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
  renameSync(temp, path);
}

// P2 FIX: 限流增加 sessionId 参数，加 IP 聚合上限防绕过
export function checkRateLimit(req, sessionId) {
  const now = Date.now();
  for (const [key, item] of windows) if (now >= item.resetAt) windows.delete(key);

  const key = source(req);
  if (!windows.has(key)) windows.set(key, { count: 0, resetAt: now + positive('RATE_LIMIT_WINDOW_MS', 60000) });
  const item = windows.get(key);
  const allowed = item.count < positive('RATE_LIMIT_MAX', 20);
  if (allowed) item.count++;

  // P2 FIX: IP 聚合上限，防止 sessionId 轮换绕过
  // 每个 IP 在窗口内总请求数不超过 RATE_LIMIT_MAX × 5
  if (sessionId) {
    const ipKey = `ip-agg:${key}`;
    for (const [k, v] of ipAggregateWindows) if (now >= v.resetAt) ipAggregateWindows.delete(k);
    let ipItem = ipAggregateWindows.get(ipKey);
    if (!ipItem || now >= ipItem.resetAt) {
      ipItem = { count: 0, resetAt: now + positive('RATE_LIMIT_WINDOW_MS', 60000) };
      ipAggregateWindows.set(ipKey, ipItem);
    }
    const ipCap = positive('RATE_LIMIT_MAX', 20) * 5;
    if (ipItem.count >= ipCap) {
      return { allowed: false, resetIn: Math.max(0, ipItem.resetAt - now) };
    }
    ipItem.count++;
  }

  return { allowed, resetIn: Math.max(0, item.resetAt - now) };
}

export function recordMockCall(req, sid) { record(req, sid).requests++; }

// Synchronous allocation before any await makes reservations atomic in one Node process.
// Pending, failed or unknown-price calls retain their reservation across restarts.
export function reserveModelCall(req, sid, maximumTokens) {
  try {
    // 收尾 FIX: BUDGET_ENABLED 默认关（需显式设为 'true' 才启用）
    if (process.env.BUDGET_ENABLED !== 'true') {
      // 预算关闭时仍记录请求，但不做额度预留
      record(req, sid).requests++;
      return { allowed: true, receipt: null };
    }

    const data = loadLedger();
    const date = day();
    const daily = data.days[date] ||= { committed: 0, tokens: {} };
    const key = source(req);
    const prices = [Number(process.env.MODEL_INPUT_CNY_PER_MILLION), Number(process.env.MODEL_OUTPUT_CNY_PER_MILLION)];
    const estimatedMaximum = prices.every(n => Number.isFinite(n) && n >= 0) ? maximumTokens * Math.max(...prices) / 1000000 : 0;
    const amount = Math.max(positive('MODEL_CALL_RESERVE_CNY', 0.05), estimatedMaximum);
    const tokenLimit = positive('RATE_LIMIT_DAILY_TOKENS', 1000000);
    if ((daily.tokens[key] || 0) + maximumTokens > tokenLimit) return { allowed: false, code: 'TOKEN_LIMIT_EXCEEDED' };
    if (data.totalCommitted + amount > positive('MODEL_TEST_BUDGET_CNY', 30) + 1e-9 ||
         daily.committed + amount > positive('BUDGET_DAILY_YUAN', 5) + 1e-9) {
      return { allowed: false, code: 'BUDGET_EXCEEDED' };
    }
    daily.committed += amount;
    data.totalCommitted += amount;
    daily.tokens[key] = (daily.tokens[key] || 0) + maximumTokens;
    saveLedger(data);
    const receipt = { id: randomUUID(), date, key, amount, maximumTokens, stats: record(req, sid), path: ledgerPath() };
    receipt.stats.requests++;
    receipts.add(receipt);
    return { allowed: true, receipt };
  } catch {
    return { allowed: false, code: 'BUDGET_UNAVAILABLE' };
  }
}

export function finishModelCall(receipt, { tokens = null, cost = null, elapsedMs = 0, failed = false } = {}) {
  if (!receipt || !receipts.delete(receipt)) return;
  const stats = receipt.stats;
  stats.elapsedMs += elapsedMs;
  stats.failures += Number(failed);
  if (tokens === null || cost === null) stats.unknown++;
  if (tokens === null) stats.unknownTokens++;
  if (cost === null) stats.unknownCost++;
  if (tokens !== null) stats.tokens += tokens;
  if (cost !== null) stats.cost += cost;
  try {
    if (ledgerPath() !== receipt.path) return;
    const data = loadLedger();
    const daily = data.days[receipt.date];
    if (!daily) return;
    // Missing usage must not release budget as if the request were free.
    if (cost !== null) {
      daily.committed = Math.max(0, daily.committed + cost - receipt.amount);
      data.totalCommitted = Math.max(0, data.totalCommitted + cost - receipt.amount);
    }
    if (tokens !== null) daily.tokens[receipt.key] = Math.max(0, daily.tokens[receipt.key] + tokens - receipt.maximumTokens);
    saveLedger(data);
  } catch {
    // The allocation is already on disk; keep it rather than undercounting a call.
  }
}

export function getUsage(req, sid) {
  const item = record(req, sid);
  return { requests: item.requests, failures: item.failures, tokensUsed: item.unknownTokens ? null : item.tokens,
    costUsed: item.unknownCost ? null : item.cost, unknownCalls: item.unknown, elapsedMs: item.elapsedMs,
    accounting: 'session-since-start', costBasis: 'configured-estimate-not-bill' };
}