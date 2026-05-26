const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const EVENT_LIMIT = 100;
const STATS_TTL_SECONDS = 30 * 24 * 60 * 60;
const EVENTS_TTL_SECONDS = 30 * 24 * 60 * 60;

function hasRedis() {
  return !!(REDIS_URL && REDIS_TOKEN);
}

async function redisCommand(command) {
  if (!hasRedis()) return null;
  const resp = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.error) {
    throw new Error(data?.error || `Redis HTTP ${resp.status}`);
  }
  return data?.result;
}

async function getJson(key) {
  const raw = await redisCommand(['GET', key]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function putJson(key, value, exSeconds) {
  const cmd = ['SET', key, JSON.stringify(value)];
  if (Number.isFinite(exSeconds) && exSeconds > 0) {
    cmd.push('EX', String(exSeconds));
  }
  await redisCommand(cmd);
}

export function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function statsKey(day) {
  return `accademia:stats:${day}`;
}

function eventsKey() {
  return 'accademia:events';
}

function normalizeKind(kind) {
  return String(kind || 'event')
    .trim()
    .replace(/[^a-z0-9_:-]/gi, '_')
    .slice(0, 64) || 'event';
}

function safePayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (/key|token|secret|password|admin/i.test(key)) continue;
    if (value === undefined || typeof value === 'function') continue;
    if (typeof value === 'string') out[key] = value.slice(0, 240);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else out[key] = JSON.parse(JSON.stringify(value)).toString?.().slice?.(0, 240) || '';
  }
  return out;
}

export function defaultStats(day = todayKey()) {
  return {
    date: day,
    updatedAt: new Date().toISOString(),
    counts: {
      home_visit: 0,
      app_access: 0,
      app_link_click: 0,
      compatibility_click: 0,
      plan_click: 0,
      checkout_click: 0,
      access_key_ok: 0,
      access_key_invalid: 0,
      provider_success: 0,
      provider_timeout: 0,
      provider_partial: 0,
      account_verify_ok: 0,
    },
  };
}

export async function recordStat(kind, payload = {}) {
  try {
    if (!hasRedis()) return false;
    const normalizedKind = normalizeKind(kind);
    const day = todayKey();
    const key = statsKey(day);
    const stats = (await getJson(key)) || defaultStats(day);
    stats.date = day;
    stats.updatedAt = new Date().toISOString();
    stats.counts = stats.counts || {};
    stats.counts[normalizedKind] = (Number(stats.counts[normalizedKind]) || 0) + 1;
    await putJson(key, stats, STATS_TTL_SECONDS);
    await recordEvent(normalizedKind, payload);
    return true;
  } catch (_) {
    return false;
  }
}

export async function recordEvent(kind, payload = {}) {
  try {
    if (!hasRedis()) return false;
    const normalizedKind = normalizeKind(kind);
    const current = (await getJson(eventsKey())) || [];
    current.unshift({
      kind: normalizedKind,
      at: new Date().toISOString(),
      payload: safePayload(payload),
    });
    await putJson(eventsKey(), current.slice(0, EVENT_LIMIT), EVENTS_TTL_SECONDS);
    return true;
  } catch (_) {
    return false;
  }
}

export async function getStatsSnapshot({ days = 7, eventsLimit = 80 } = {}) {
  const safeDays = Math.max(1, Math.min(30, Number(days) || 7));
  const safeEventsLimit = Math.max(1, Math.min(100, Number(eventsLimit) || 80));

  if (!hasRedis()) {
    return {
      configured: false,
      totals: {},
      daily: [],
      events: [],
      message: 'Upstash non configurato: impossibile leggere le statistiche.',
    };
  }

  const daily = [];
  const totals = {};
  const now = new Date();

  for (let i = 0; i < safeDays; i += 1) {
    const d = new Date(now);
    d.setUTCDate(now.getUTCDate() - i);
    const day = todayKey(d);
    const stats = (await getJson(statsKey(day))) || defaultStats(day);
    const counts = stats.counts || {};
    daily.push({ date: day, counts, updatedAt: stats.updatedAt || null });
    for (const [key, value] of Object.entries(counts)) {
      totals[key] = (Number(totals[key]) || 0) + (Number(value) || 0);
    }
  }

  const events = ((await getJson(eventsKey())) || []).slice(0, safeEventsLimit);

  return {
    configured: true,
    days: safeDays,
    totals,
    daily,
    events,
  };
}
