import { randomBytes, createHash } from 'node:crypto';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM_EMAIL || process.env.RESEND_FROM || 'AccademIA <noreply@accademia-tesi.it>';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ADMIN_DASH_KEY = process.env.ADMIN_DASH_KEY || process.env.ACC_ADMIN_DASH_KEY || '';
const ANTHROPIC_PRIMARY_MODEL = process.env.ANTHROPIC_MODEL_PRIMARY || 'claude-sonnet-4-6';
const ANTHROPIC_FALLBACK_MODEL = process.env.ANTHROPIC_MODEL_FALLBACK || 'claude-haiku-4-5-20251001';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const OTP_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 180 * 24 * 60 * 60;
const SNAPSHOT_LIMIT = 15;
const EVENT_LIMIT = 50;
const SECTION_COMPLETE_MARKER = '[[SECTION_COMPLETE]]';
const CHAPTER_DRAFT_TOTAL_TIMEOUT_MS = 230_000;
const CHAPTER_DRAFT_LOCK_TTL_SECONDS = 5 * 60;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }

  const task = String(body?.task || '').trim();
  const input = body?.input ?? {};

  try {
    switch (task) {
      case '__visit_ping': {
        await recordStat('visit_ping', { page: String(input?.page || 'app') });
        return sendJson(res, 200, { ok: true });
      }

      case '__state_save': {
        const owner = await ensureOwnerStorageReady(await resolveOwner(input));
        assert(owner, 'syncKey o sessionToken mancanti');
        await putJson(owner.stateKey, { state: input?.payload || null, savedAt: new Date().toISOString() });
        await recordEvent('state_save', { scope: owner.scope });
        return sendJson(res, 200, { ok: true });
      }

      case '__state_load': {
        const owner = await ensureOwnerStorageReady(await resolveOwner(input));
        assert(owner, 'syncKey o sessionToken mancanti');
        const record = await getJson(owner.stateKey);
        return sendJson(res, 200, { state: record?.state || null, savedAt: record?.savedAt || null });
      }

      case '__snapshot_create': {
        const owner = await ensureOwnerStorageReady(await resolveOwner(input));
        assert(owner, 'syncKey o sessionToken mancanti');
        const current = (await getJson(owner.snapshotsKey)) || [];
        const snapshot = {
          id: String(input?.snapshotId || makeId('snap')),
          label: String(input?.label || 'Versione'),
          reason: String(input?.reason || 'manuale'),
          savedAt: new Date().toISOString(),
          payload: input?.payload || null,
          scope: owner.scope,
        };
        const next = [snapshot, ...current.filter((x) => x && x.id !== snapshot.id)].slice(0, SNAPSHOT_LIMIT);
        await putJson(owner.snapshotsKey, next);
        await recordEvent('snapshot_create', { scope: owner.scope, reason: snapshot.reason });
        return sendJson(res, 200, { ok: true, snapshot });
      }

      case '__snapshot_list': {
        const owner = await ensureOwnerStorageReady(await resolveOwner(input));
        assert(owner, 'syncKey o sessionToken mancanti');
        const snapshots = (await getJson(owner.snapshotsKey)) || [];
        return sendJson(res, 200, { snapshots });
      }

      case '__recovery_save': {
        const owner = await ensureOwnerStorageReady(await resolveOwner(input));
        assert(owner, 'syncKey o sessionToken mancanti');
        const record = input?.record || null;
        assert(record && record.payload, 'record mancante');
        await putJson(owner.recoveryKey, record);
        await recordEvent('recovery_save', { scope: owner.scope, reason: String(record?.reason || 'manuale') });
        return sendJson(res, 200, { ok: true });
      }

      case '__recovery_load': {
        const owner = await ensureOwnerStorageReady(await resolveOwner(input));
        assert(owner, 'syncKey o sessionToken mancanti');
        const record = await getJson(owner.recoveryKey);
        return sendJson(res, 200, { record: record || null });
      }

      case '__account_send_code': {
        const email = normalizeEmail(input?.email);
        assert(email, 'Email non valida');
        assert(RESEND_API_KEY, 'Resend non configurato');
        const code = generateOtp();
        await putJson(accountOtpKey(email), { code, email, createdAt: new Date().toISOString() }, OTP_TTL_SECONDS);
        await sendOtpEmail(email, code);
        await recordEvent('account_send_code', { email: redactEmail(email) });
        return sendJson(res, 200, { ok: true });
      }

      case '__account_verify_code': {
        const email = normalizeEmail(input?.email);
        const code = String(input?.code || '').trim();
        assert(email, 'Email non valida');
        assert(code, 'Codice mancante');
        const stored = await getJson(accountOtpKey(email));
        if (!stored || String(stored?.code || '') !== code) {
          await recordEvent('account_verify_fail', { email: redactEmail(email) });
          return sendJson(res, 400, { error: 'invalid_code', details: 'Codice non valido o scaduto' });
        }
        await delKey(accountOtpKey(email));
        const profile = await ensureAccountProfile(email);
        const sessionToken = makeId('sess');
        await putJson(accountSessionKey(sessionToken), {
          email,
          accountId: profile.accountId,
          thesisId: profile.thesisId,
          createdAt: new Date().toISOString(),
        }, SESSION_TTL_SECONDS);
        await recordStat('account_verify_ok', { email: redactEmail(email) });
        return sendJson(res, 200, {
          ok: true,
          sessionToken,
          email,
          accountId: profile.accountId,
          thesisId: profile.thesisId,
        });
      }

      case '__account_load': {
        const owner = await ensureOwnerStorageReady(await resolveOwner(input));
        assert(owner && owner.scope === 'account', 'sessionToken mancante o non valido');
        const record = await getJson(owner.stateKey);
        return sendJson(res, 200, { state: record?.state || null, savedAt: record?.savedAt || null });
      }

      case '__account_save': {
        const owner = await ensureOwnerStorageReady(await resolveOwner(input));
        assert(owner && owner.scope === 'account', 'sessionToken mancante o non valido');
        await putJson(owner.stateKey, { state: input?.payload || null, savedAt: new Date().toISOString() });
        await recordEvent('account_save', { scope: owner.scope, email: redactEmail(owner.email) });
        return sendJson(res, 200, { ok: true });
      }

      case '__admin_stats': {
        if (!ADMIN_DASH_KEY || String(input?.adminKey || '') !== ADMIN_DASH_KEY) {
          return sendJson(res, 403, { error: 'forbidden', details: 'Chiave dashboard non valida' });
        }
        const stats = (await getJson(statsKey(todayKey()))) || defaultStats();
        const events = ((await getJson(eventsKey())) || []).slice(0, 20);
        return sendJson(res, 200, { stats, events });
      }

      case '__verify_unlock': {
        const code = String(input?.code || '').trim().toUpperCase();
        if (!code) return sendJson(res, 200, { valid: false, reason: 'invalid' });
        const unlock = await verifyUnlockCode(code, input?.sessionToken);
        return sendJson(res, 200, unlock);
      }

      case 'outline_draft':
      case 'outline_review':
      case 'abstract_draft':
      case 'abstract_review':
      case 'chapter_draft':
      case 'chapter_resume':
      case 'chapter_review':
      case 'tutor_revision':
      case 'revisione_relatore':
      case 'revisione_capitolo': {
        const canonicalTask = normalizeGenerationTask(task);
        const chapterLock = canonicalTask === 'chapter_draft'
          ? await acquireChapterLock(input, CHAPTER_DRAFT_LOCK_TTL_SECONDS)
          : null;
        if (canonicalTask === 'chapter_draft' && !chapterLock?.ok) {
          return sendJson(res, 409, {
            error: 'chapter_already_running',
            details: 'È già in corso una generazione per questo capitolo. Attendi la chiusura prima di riprovare.',
          });
        }
        let text;
        try {
          text = await generateText(canonicalTask, input);
        } finally {
          if (chapterLock?.ok) await releaseChapterLock(chapterLock.key);
        }
        const partial = !!(text && typeof text === 'object' && text.partial);
        const payloadText = partial ? String(text?.text || '') : text;
        await recordStat(partial ? 'provider_partial' : 'provider_success', { task: canonicalTask, requestedTask: task });
        return sendJson(res, 200, {
          text: payloadText,
          task: canonicalTask,
          partial,
          partialReason: partial ? String(text?.reason || 'timeout') : '',
        });
      }

      default:
        return sendJson(res, 400, { error: 'unknown_task', details: `Task non supportato: ${task}` });
    }
  } catch (err) {
    const payload = normalizeError(err);
    if (payload.code === 'provider_timeout') {
      await recordStat('provider_timeout', { task, details: payload.details.slice(0, 140) });
      return sendJson(res, 504, payload);
    }
    await recordEvent('server_error', { task, details: payload.details.slice(0, 140) });
    return sendJson(res, payload.statusCode || 500, payload);
  }
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const raw = await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_500_000) reject(new Error('Body troppo grande'));
    });
    req.on('end', () => resolve(data || '{}'));
    req.on('error', reject);
  });
  return JSON.parse(raw || '{}');
}

function assert(condition, message) {
  if (!condition) {
    const err = new Error(message);
    err.statusCode = 400;
    throw err;
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function redactEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return '';
  return `${user.slice(0, 2)}***@${domain}`;
}

function makeId(prefix) {
  return `${prefix}-${randomBytes(12).toString('hex')}`;
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashEmail(email) {
  return createHash('sha256').update(email).digest('hex').slice(0, 24);
}

async function resolveOwner(input) {
  const syncKey = String(input?.syncKey || '').trim();
  if (syncKey) {
    const safe = safeKey(syncKey);
    return {
      scope: 'sync',
      syncKey,
      stateKey: `accademia:sync:${safe}:state`,
      snapshotsKey: `accademia:sync:${safe}:snapshots`,
      recoveryKey: `accademia:sync:${safe}:recovery`,
    };
  }

  const sessionToken = String(input?.sessionToken || '').trim();
  if (!sessionToken) return null;
  const session = await getJson(accountSessionKey(sessionToken));
  if (!session?.email) return null;
  const email = normalizeEmail(session.email);
  const profile = await ensureAccountProfile(email);
  return {
    scope: 'account',
    email,
    sessionToken,
    accountId: profile.accountId,
    thesisId: profile.thesisId,
    profileKey: accountProfileKey(email),
    stateKey: accountStateKey(email, profile.thesisId),
    snapshotsKey: accountSnapshotsKey(email, profile.thesisId),
    recoveryKey: accountRecoveryKey(email, profile.thesisId),
    legacyStateKey: accountLegacyStateKey(email),
    legacySnapshotsKey: accountLegacySnapshotsKey(email),
    legacyRecoveryKey: accountLegacyRecoveryKey(email),
  };
}

async function ensureOwnerStorageReady(owner) {
  if (!owner || owner.scope !== 'account') return owner;
  await ensureAccountStorageMigrated(owner);
  return owner;
}

async function ensureAccountStorageMigrated(owner) {
  if (!owner || owner.scope !== 'account') return;
  await migrateJsonIfMissing(owner.legacyStateKey, owner.stateKey);
  await migrateJsonIfMissing(owner.legacySnapshotsKey, owner.snapshotsKey);
  await migrateJsonIfMissing(owner.legacyRecoveryKey, owner.recoveryKey);
}

async function migrateJsonIfMissing(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const existing = await getJson(toKey);
  if (existing !== null) return;
  const legacy = await getJson(fromKey);
  if (legacy !== null) {
    await putJson(toKey, legacy);
  }
}

async function ensureAccountProfile(email) {
  const normalized = normalizeEmail(email);
  assert(normalized, 'Email account non valida');
  const key = accountProfileKey(normalized);
  const now = new Date().toISOString();
  const accountId = hashEmail(normalized);
  const stored = await getJson(key);
  const profile = stored && typeof stored === 'object' ? { ...stored } : {};
  if (!profile.accountId) profile.accountId = accountId;
  if (!profile.email) profile.email = normalized;
  if (!profile.thesisId) profile.thesisId = makeId('thesis');
  if (!profile.createdAt) profile.createdAt = now;
  profile.updatedAt = now;
  await putJson(key, profile);
  return profile;
}

function safeKey(value) {
  return String(value || '').replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 180);
}

function accountOtpKey(email) {
  return `accademia:otp:${hashEmail(email)}`;
}

function accountNamespace(email) {
  return `accademia:account:${hashEmail(normalizeEmail(email))}`;
}

function accountProfileKey(email) {
  return `${accountNamespace(email)}:profile`;
}

function accountStateKey(email, thesisId) {
  return `${accountNamespace(email)}:thesis:${safeKey(thesisId)}:state`;
}

function accountSnapshotsKey(email, thesisId) {
  return `${accountNamespace(email)}:thesis:${safeKey(thesisId)}:snapshots`;
}

function accountRecoveryKey(email, thesisId) {
  return `${accountNamespace(email)}:thesis:${safeKey(thesisId)}:recovery`;
}

function accountLegacyStateKey(email) {
  return `${accountNamespace(email)}:state`;
}

function accountLegacySnapshotsKey(email) {
  return `${accountNamespace(email)}:snapshots`;
}

function accountLegacyRecoveryKey(email) {
  return `${accountNamespace(email)}:recovery`;
}

function accountSessionKey(sessionToken) {
  return `accademia:session:${safeKey(sessionToken)}`;
}

async function redisCommand(command) {
  assert(REDIS_URL && REDIS_TOKEN, 'Upstash non configurato');
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

async function delKey(key) {
  await redisCommand(['DEL', key]);
}

async function setIfNotExists(key, value, exSeconds) {
  const cmd = ['SET', key, JSON.stringify(value), 'NX'];
  if (Number.isFinite(exSeconds) && exSeconds > 0) {
    cmd.push('EX', String(exSeconds));
  }
  return await redisCommand(cmd);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function statsKey(day) {
  return `accademia:stats:${day}`;
}

function eventsKey() {
  return 'accademia:events';
}

function defaultStats() {
  return {
    date: todayKey(),
    updatedAt: new Date().toISOString(),
    counts: {
      visit_ping: 0,
      provider_success: 0,
      provider_timeout: 0,
      account_verify_ok: 0,
    },
  };
}

async function recordStat(kind, payload = {}) {
  try {
    const key = statsKey(todayKey());
    const stats = (await getJson(key)) || defaultStats();
    stats.date = todayKey();
    stats.updatedAt = new Date().toISOString();
    stats.counts = stats.counts || {};
    stats.counts[kind] = (Number(stats.counts[kind]) || 0) + 1;
    await putJson(key, stats, 8 * 24 * 60 * 60);
    await recordEvent(kind, payload);
  } catch (_) {}
}

async function recordEvent(kind, payload = {}) {
  try {
    const current = (await getJson(eventsKey())) || [];
    current.unshift({ kind, at: new Date().toISOString(), payload });
    await putJson(eventsKey(), current.slice(0, EVENT_LIMIT), 14 * 24 * 60 * 60);
  } catch (_) {}
}

async function sendOtpEmail(email, code) {
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h2>AccademIA — codice di accesso</h2>
      <p>Usa questo codice per collegare il tuo account:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:4px">${escapeHtml(code)}</p>
      <p>Il codice scade tra 10 minuti.</p>
    </div>
  `;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [email],
      subject: 'AccademIA — codice di accesso',
      html,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.message || data?.error || `Resend HTTP ${resp.status}`);
  }
}

async function verifyUnlockCode(code, sessionToken) {
  const config = parseUnlockConfig();
  const usedKey = `accademia:unlock:used:${safeKey(code)}`;
  const alreadyUsed = await getJson(usedKey);
  if (alreadyUsed) return { valid: false, reason: 'already_used' };

  let type = null;
  if (config.premium.has(code)) type = 'premium';
  else if (config.base.has(code)) type = 'base';
  if (!type) return { valid: false, reason: 'invalid' };

  await putJson(usedKey, { code, type, usedAt: new Date().toISOString(), sessionToken: String(sessionToken || '') }, 365 * 24 * 60 * 60);
  await recordEvent('unlock_code_ok', { type });
  return { valid: true, type };
}

function parseUnlockConfig() {
  const premium = new Set();
  const base = new Set();

  const premiumCsv = String(process.env.PREMIUM_UNLOCK_CODES || process.env.ACC_PREMIUM_UNLOCK_CODES || '');
  const baseCsv = String(process.env.BASE_UNLOCK_CODES || process.env.ACC_BASE_UNLOCK_CODES || '');
  premiumCsv.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean).forEach((x) => premium.add(x));
  baseCsv.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean).forEach((x) => base.add(x));

  const jsonRaw = process.env.UNLOCK_CODES_JSON || process.env.ACC_UNLOCK_CODES_JSON || '';
  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw);
      (parsed?.premium || []).forEach((x) => premium.add(String(x).trim().toUpperCase()));
      (parsed?.base || []).forEach((x) => base.add(String(x).trim().toUpperCase()));
    } catch (_) {}
  }

  return { premium, base };
}


function normalizeGenerationTask(task) {
  switch (String(task || '').trim()) {
    case 'outline_review':
      return 'outline_draft';
    case 'abstract_draft':
    case 'abstract_review':
      return 'abstract_draft';
    case 'chapter_review':
    case 'revisione_capitolo':
      return 'chapter_review';
    case 'chapter_resume':
      return 'chapter_draft';
    case 'tutor_revision':
    case 'revisione_relatore':
      return 'tutor_revision';
    default:
      return String(task || '').trim();
  }
}

async function acquireChapterLock(input, ttlSeconds) {
  const scope = resolveChapterLockScope(input);
  if (!scope) return { ok: true, key: '' };
  const key = `accademia:chapter:lock:${scope}`;
  const acquired = await setIfNotExists(key, { startedAt: new Date().toISOString() }, ttlSeconds);
  return { ok: String(acquired || '').toUpperCase() === 'OK', key };
}

async function releaseChapterLock(key) {
  if (!key) return;
  await delKey(key);
}

function resolveChapterLockScope(input) {
  const obj = input && typeof input === 'object' ? input : {};
  const chapterIndex = Number.isFinite(Number(obj.currentChapterIndex)) ? Number(obj.currentChapterIndex) : -1;
  if (chapterIndex < 0) return '';
  const sessionToken = safeKey(String(obj.sessionToken || '').trim());
  if (sessionToken) return `sess:${sessionToken}:ch:${chapterIndex}`;
  const syncKey = safeKey(String(obj.syncKey || '').trim());
  if (syncKey) return `sync:${syncKey}:ch:${chapterIndex}`;
  const thesisKey = safeKey(String(obj.thesisId || obj.thesisTitle || '').trim());
  if (thesisKey) return `th:${thesisKey}:ch:${chapterIndex}`;
  return '';
}

async function generateText(task, input) {
  if (task === 'chapter_draft') {
    return await generateChapterDraftStructured(input);
  }

  const prompt = buildProviderPrompt(task, input);
  const system = buildSystemPrompt(task, input);
  const maxTokens = task === 'outline_draft' ? 1400 : (task === 'abstract_draft' ? 1200 : 2600);
  return await generateWithProviders({ prompt, system, maxTokens });
}

async function generateWithProviders({ prompt, system, maxTokens, primaryTimeoutMs = 45_000, fallbackTimeoutMs = 30_000, openaiTimeoutMs = 35_000 }) {
  const attempts = [];
  if (ANTHROPIC_API_KEY) {
    attempts.push(() => callAnthropic({ model: ANTHROPIC_PRIMARY_MODEL, system, prompt, maxTokens, timeoutMs: primaryTimeoutMs }));
    attempts.push(() => callAnthropic({ model: ANTHROPIC_FALLBACK_MODEL, system, prompt: shrinkPrompt(prompt), maxTokens: Math.min(1800, maxTokens), timeoutMs: fallbackTimeoutMs }));
  }
  if (OPENAI_API_KEY) {
    attempts.push(() => callOpenAI({ model: OPENAI_MODEL, system, prompt: shrinkPrompt(prompt), maxTokens: Math.min(2200, maxTokens), timeoutMs: openaiTimeoutMs }));
  }

  if (!attempts.length) {
    const err = new Error('Nessun provider configurato');
    err.statusCode = 500;
    throw err;
  }

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const text = await attempt();
      const cleaned = cleanModelText(text);
      if (!cleaned) throw new Error('Provider ha restituito testo vuoto');
      return cleaned;
    } catch (err) {
      lastError = err;
      const isRecoverable = isProviderTimeout(err) || isProviderOverload(err) || /rate limit|overloaded|temporarily unavailable/i.test(String(err?.message || ''));
      if (!isRecoverable) break;
    }
  }

  if (isProviderTimeout(lastError)) {
    const err = new Error('Timeout provider. Nessuna modifica applicata: riprova.');
    err.code = 'provider_timeout';
    throw err;
  }
  throw lastError || new Error('Generazione non riuscita');
}


async function generateChapterDraftStructured(input) {
  const context = parseChapterContext(input);
  const system = buildSystemPrompt('chapter_draft', input);
  const startedAt = Date.now();
  const remainingMs = () => Math.max(0, CHAPTER_DRAFT_TOTAL_TIMEOUT_MS - (Date.now() - startedAt));
  const ensureTimeBudget = (parts = []) => {
    if (remainingMs() > 0) return;
    if (parts.length) {
      const partialText = postProcessChapterText(`${context.chapterHeading}\n\n${parts.join('\n\n')}`, context);
      return {
        partial: true,
        text: partialText,
        reason: 'chapter_timeout_partial',
      };
    }
    const err = new Error('Timeout provider. Nessuna modifica applicata: riprova.');
    err.code = 'provider_timeout';
    throw err;
  };

  if (!context.subsections.length) {
    ensureTimeBudget();
    const callBudget = Math.max(8_000, Math.min(remainingMs() - 1_000, 52_000));
    const prompt = buildProviderPrompt('chapter_draft', input);
    const raw = await generateWithProviders({
      prompt,
      system,
      maxTokens: 2200,
      primaryTimeoutMs: callBudget,
      fallbackTimeoutMs: Math.max(8_000, Math.min(callBudget - 1_000, 38_000)),
      openaiTimeoutMs: Math.max(8_000, Math.min(callBudget - 1_000, 40_000)),
    });
    const chapterText = postProcessChapterText(raw, context);
    return await appendChapterNotesIfNeeded(input, context, chapterText, system);
  }

  const targets = deriveChapterTargets(input, context);
  const parts = [];
  const buildTimeoutPartial = (fallbackText = '') => {
    const merged = [
      ...parts,
      String(fallbackText || '').trim(),
    ].filter(Boolean);
    if (!merged.length) return null;
    return {
      partial: true,
      text: postProcessChapterText(`${context.chapterHeading}\n\n${merged.join('\n\n')}`, context),
      reason: 'chapter_timeout_partial',
    };
  };

  for (let i = 0; i < context.subsections.length; i += 1) {
    const timeoutPartial = ensureTimeBudget(parts);
    if (timeoutPartial) return timeoutPartial;
    const subsection = context.subsections[i];
    let result = await generateOneSubsection({
      input,
      context,
      subsection,
      index: i,
      total: context.subsections.length,
      system,
      targetWords: targets.firstPassSectionWords,
      previousSectionText: parts[i - 1] || '',
    });
    let currentSectionText = postProcessChapterSectionText(result.text, subsection);

    let attempts = 0;
    while (attempts < 6 && (!result.complete || needsMoreSectionText(currentSectionText, targets.sectionWords))) {
      const timeoutPartialLoop = ensureTimeBudget(parts);
      if (timeoutPartialLoop) return buildTimeoutPartial(currentSectionText) || timeoutPartialLoop;
      result = await continueOneSubsection({
        input,
        context,
        subsection,
        system,
        existingText: currentSectionText,
        targetWords: targets.sectionWords,
      });
      currentSectionText = postProcessChapterSectionText(result.text, subsection);
      attempts += 1;
    }

    parts.push(currentSectionText);
  }

  let chapterText = postProcessChapterText(`${context.chapterHeading}\n\n${parts.join('\n\n')}`, context);
  let finalAttempts = 0;
  while (finalAttempts < 3 && chapterNeedsCompletion(chapterText, targets.chapterWords, context)) {
    const timeoutPartialFinal = ensureTimeBudget(parts);
    if (timeoutPartialFinal) return timeoutPartialFinal;
    const lastSubsection = context.subsections[context.subsections.length - 1];
    const continued = await continueOneSubsection({
      input,
      context,
      subsection: lastSubsection,
      system,
      existingText: parts[parts.length - 1],
      targetWords: targets.sectionWords,
    });
    parts[parts.length - 1] = postProcessChapterSectionText(continued.text, lastSubsection);
    chapterText = postProcessChapterText(`${context.chapterHeading}\n\n${parts.join('\n\n')}`, context);
    finalAttempts += 1;
  }

  ensureTimeBudget(parts);
  chapterText = await appendChapterNotesIfNeeded(input, context, chapterText, system);
  return chapterText;
}

function deriveChapterTargets(input, context) {
  const obj = input && typeof input === 'object' ? input : {};
  const degree = String(obj.degreeType || '').toLowerCase();
  const explicit = Number(obj?.constraints?.minWordsChapter || obj?.minWordsChapter || obj?.targetWords || 0);
  let chapterWords = Number.isFinite(explicit) && explicit >= 1800
    ? explicit
    : Math.max(3000, context.subsections.length * (degree.includes('magistr') ? 1000 : 820));
  chapterWords = Math.min(chapterWords, 6200);
  const sectionWords = Math.max(560, Math.ceil(chapterWords / Math.max(context.subsections.length, 1)));
  const firstPassSectionWords = Math.max(360, Math.min(520, Math.round(sectionWords * 0.62)));
  return { chapterWords, sectionWords, firstPassSectionWords };
}

function parseChapterContext(input) {
  const obj = input && typeof input === 'object' ? input : {};
  const outline = String(obj.approvedOutline || '');
  const currentChapterIndex = Number.isFinite(Number(obj.currentChapterIndex)) ? Number(obj.currentChapterIndex) : 0;
  const currentChapterNumber = currentChapterIndex + 1;
  const normalizedLines = outline
    .split(/\r?\n/)
    .map((line) => normalizeOutlineLine(line))
    .filter(Boolean);

  let chapterHeading = String(obj.currentChapterTitle || '').trim() || `Capitolo ${currentChapterNumber}`;
  const subsections = [];
  let inside = false;

  for (const line of normalizedLines) {
    const chapterNamedMatch = line.match(/^(?:capitolo\s+)(\d+)\s*[—\-:.]?\s*(.*)$/i);
    const chapterPlainMatch = line.match(/^(\d+)\.\s+(.+)$/);
    const chapterMatch = chapterNamedMatch || chapterPlainMatch;
    if (chapterMatch) {
      const n = Number(chapterMatch[1]);
      if (n === currentChapterNumber) {
        inside = true;
        chapterHeading = cleanChapterHeading(line, currentChapterNumber);
        continue;
      }
      if (inside) break;
    }

    if (!inside) continue;
    const subsectionMatch = line.match(/^(\d+\.\d+)\s+(.+)$/);
    if (subsectionMatch && Number(subsectionMatch[1].split('.')[0]) === currentChapterNumber) {
      subsections.push({ code: subsectionMatch[1], title: subsectionMatch[2].trim() });
    }
  }

  return { currentChapterIndex, currentChapterNumber, chapterHeading, subsections };
}

function cleanChapterHeading(line, chapterNumber) {
  const cleaned = normalizeOutlineLine(line)
    .replace(new RegExp(`^capitolo\\s+${chapterNumber}\\s*[—:.-]?\\s*`, 'i'), '')
    .replace(new RegExp(`^${chapterNumber}\\.\\s*`, 'i'), '')
    .replace(/^\.\s*/, '')
    .trim();
  return cleaned ? `Capitolo ${chapterNumber} — ${cleaned}` : `Capitolo ${chapterNumber}`;
}

function normalizeOutlineLine(line) {
  return String(line || '')
    .replace(/^#+\s*/, '')
    .replace(/^[-–—*]+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/__+/g, '')
    .trim();
}

function wantsFootnoteApparatus(input) {
  const obj = input && typeof input === 'object' ? input : {};
  return obj?.constraints?.includeFootnotes !== false;
}

async function appendChapterNotesIfNeeded(input, context, chapterText, system) {
  if (!wantsFootnoteApparatus(input) || !String(chapterText || '').trim()) return chapterText;
  if (/\nNote\s*\n/i.test(String(chapterText))) return chapterText;
  try {
    const notes = await generateChapterNotes(input, context, chapterText, system);
    return notes ? `${chapterText.trim()}\n\n${notes}`.trim() : chapterText;
  } catch (_) {
    return chapterText;
  }
}

async function generateChapterNotes(input, context, chapterText, system) {
  const obj = input && typeof input === 'object' ? input : {};
  const prompt = [
    'TASK: chapter_notes',
    `CAPITOLO: ${context.chapterHeading}`,
    'Genera solo una sezione finale intitolata Note.',
    'REGOLE OBBLIGATORIE:',
    '- Scrivi da 3 a 6 note numerate.',
    '- Ogni nota deve essere utile, accademica, prudente e pertinente al capitolo.',
    '- Non inventare fonti, autori, anni, pagine, citazioni dirette o dati empirici.',
    '- Se richiami autori o tradizioni teoriche, fallo solo in modo generale e non puntuale.',
    '- Non ripetere il testo del capitolo: usa le note per precisazioni concettuali, cautele metodologiche o chiarimenti terminologici.',
    '- Restituisci solo la sezione finale Note.',
    obj.theme ? `ARGOMENTO DELLA TESI:
${clip(String(obj.theme), 500)}` : '',
    obj.faculty || obj.degreeCourse || obj.degreeType
      ? `CONTESTO ACCADEMICO:
Facoltà: ${clip(String(obj.faculty || ''), 120)}
Corso: ${clip(String(obj.degreeCourse || ''), 160)}
Tipo laurea: ${clip(String(obj.degreeType || ''), 60)}
Metodologia: ${clip(String(obj.methodology || ''), 60)}`
      : '',
    `TESTO DEL CAPITOLO:
${clip(String(chapterText), 5500)}`,
  ].filter(Boolean).join('\n\n');

  const raw = await generateWithProviders({
    prompt,
    system,
    maxTokens: 700,
    primaryTimeoutMs: 22_000,
    fallbackTimeoutMs: 18_000,
    openaiTimeoutMs: 20_000,
  });
  return postProcessChapterNotes(raw);
}

function postProcessChapterNotes(text) {
  let cleaned = cleanModelText(text)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^(?:APPARATO\s+)?NOTE\s*:?/i, 'Note')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned) return '';
  if (!/^Note\b/i.test(cleaned)) cleaned = `Note\n\n${cleaned}`;
  return cleaned;
}

function buildChapterSubsectionPrompt(input, context, subsection, index, total, targetWords, previousSectionText) {
  const obj = input && typeof input === 'object' ? input : {};
  const prevSummary = index > 0
    ? `La sottosezione precedente è ${context.subsections[index - 1].code} ${context.subsections[index - 1].title}. Mantieni continuità logica senza ripetizioni.`
    : 'Apri il capitolo con una sottosezione introduttiva ma già analitica.';

  return [
    'TASK: chapter_draft_section',
    `SVILUPPA SOLO QUESTA SOTTOSEZIONE: ${subsection.code} ${subsection.title}`,
    `CAPITOLO: ${context.chapterHeading}`,
    `POSIZIONE NEL CAPITOLO: ${index + 1} di ${total}`,
    `TARGET INDICATIVO: circa ${targetWords}-${targetWords + 120} parole`,
    prevSummary,
    'REGOLE OBBLIGATORIE:',
    `- Inizia esattamente con l'intestazione: ${subsection.code} ${subsection.title}`,
    '- Produci solo la sottosezione richiesta.',
    '- Nessun markdown, nessun elenco puntato, nessuna conclusione sul capitolo successivo.',
    '- Non usare formule meta come "questo capitolo", "nel prossimo capitolo" o chiuse scolastiche equivalenti.',
    '- Usa paragrafi continui, tono accademico, lessico naturale.',
    wantsFootnoteApparatus(obj) ? '- Non inserire ancora la sezione finale Note dentro questa sottosezione.' : '',
    `- Quando la sottosezione è davvero completa, chiudi l'ultima riga con il marcatore esatto ${SECTION_COMPLETE_MARKER}`,
    '- Non usare il marcatore se la sottosezione non è completa.',
    obj.theme ? `ARGOMENTO DELLA TESI:\n${clip(String(obj.theme), 700)}` : '',
    obj.faculty || obj.degreeCourse || obj.degreeType
      ? `CONTESTO ACCADEMICO:\nFacoltà: ${clip(String(obj.faculty || ''), 120)}\nCorso: ${clip(String(obj.degreeCourse || ''), 160)}\nTipo laurea: ${clip(String(obj.degreeType || ''), 60)}\nMetodologia: ${clip(String(obj.methodology || ''), 60)}`
      : '',
    obj.approvedAbstract ? `ABSTRACT APPROVATO:\n${clip(String(obj.approvedAbstract), 900)}` : '',
    summarizePreviousContext(obj.previousChapters) ? `CAPITOLI PRECEDENTI (SINTESI):\n${summarizePreviousContext(obj.previousChapters)}` : '',
    previousSectionText ? `ULTIMA SOTTOSEZIONE GIÀ SVILUPPATA (ESTRATTO):\n${clip(String(previousSectionText), 420)}` : '',
  ].filter(Boolean).join('\n\n');
}

async function generateOneSubsection({ input, context, subsection, index, total, system, targetWords, previousSectionText }) {
  const prompt = buildChapterSubsectionPrompt(input, context, subsection, index, total, targetWords, previousSectionText);
  const raw = await generateWithProviders({
    prompt,
    system,
    maxTokens: Math.min(1000, Math.max(520, Math.round(targetWords * 0.95))),
    primaryTimeoutMs: 28_000,
    fallbackTimeoutMs: 20_000,
    openaiTimeoutMs: 22_000,
  });
  return {
    text: stripCompletionMarker(raw),
    complete: hasCompletionMarker(raw),
  };
}

async function continueOneSubsection({ input, context, subsection, system, existingText, targetWords }) {
  const obj = input && typeof input === 'object' ? input : {};
  const prompt = [
    'TASK: chapter_draft_section_continue',
    `CONTINUA SOLO LA SOTTOSEZIONE: ${subsection.code} ${subsection.title}`,
    `CAPITOLO: ${context.chapterHeading}`,
    `TARGET MINIMO DESIDERATO: circa ${targetWords} parole complessive`,
    'REGOLE OBBLIGATORIE:',
    '- Non ripetere il titolo della sottosezione.',
    '- Non ricominciare da capo.',
    '- Continua esattamente dal punto in cui il testo si è fermato.',
    '- Aggiungi solo il testo mancante per completare la sottosezione in modo pieno e naturale.',
    '- Non inserire formule come "nel prossimo capitolo", "questo capitolo" o riepiloghi scolastici.',
    wantsFootnoteApparatus(obj) ? '- Non inserire ancora la sezione finale Note in questa continuazione.' : '',
    `- Quando la sottosezione è davvero completa, chiudi l'ultima riga con il marcatore esatto ${SECTION_COMPLETE_MARKER}`,
    '- Se non è ancora completa, non usare il marcatore.',
    obj.approvedAbstract ? `ABSTRACT APPROVATO:\n${clip(String(obj.approvedAbstract), 700)}` : '',
    `TESTO GIÀ GENERATO:\n${clip(String(existingText), 1700)}`,
  ].filter(Boolean).join('\n\n');

  const addition = await generateWithProviders({
    prompt,
    system,
    maxTokens: 620,
    primaryTimeoutMs: 24_000,
    fallbackTimeoutMs: 18_000,
    openaiTimeoutMs: 20_000,
  });

  const cleanedAddition = cleanContinuationText(addition, subsection);
  return {
    text: `${stripCompletionMarker(existingText).trim()}\n\n${cleanedAddition}`.trim(),
    complete: hasCompletionMarker(addition),
  };
}

function summarizePreviousContext(previousChapters) {
  const text = String(previousChapters || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return clip(text, 900);
}

function hasCompletionMarker(text) {
  return String(text || '').includes(SECTION_COMPLETE_MARKER);
}

function stripCompletionMarker(text) {
  return cleanModelText(text)
    .replace(new RegExp(`${escapeRegex(SECTION_COMPLETE_MARKER)}\\s*$`), '')
    .trim();
}

function postProcessChapterSectionText(text, subsection) {
  let cleaned = cleanModelText(text)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .trim();

  const heading = `${subsection.code} ${subsection.title}`;
  if (!cleaned.startsWith(heading)) {
    cleaned = `${heading}\n\n${cleaned.replace(/^\d+\.\d+\s+.+?(\n|$)/, '').trim()}`.trim();
  }
  return cleaned;
}

function postProcessChapterText(text, context) {
  let cleaned = cleanModelText(text)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const chapterHeading = cleanChapterHeading(context.chapterHeading || `Capitolo ${context.currentChapterNumber}`, context.currentChapterNumber);
  if (!cleaned.startsWith(chapterHeading)) {
    cleaned = `${chapterHeading}\n\n${cleaned}`;
  }
  return cleaned;
}

function needsMoreSectionText(sectionText, targetWords) {
  const words = wordCount(sectionText);
  return words < Math.max(320, targetWords - 180) || endsSuspiciously(sectionText);
}

function chapterNeedsCompletion(chapterText, targetWords, context) {
  if (wordCount(chapterText) < Math.max(1800, targetWords - 180)) return true;
  if (endsSuspiciously(chapterText)) return true;
  const last = context.subsections[context.subsections.length - 1];
  return last ? !chapterText.includes(last.code) : false;
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function endsSuspiciously(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  return /(?:\b(?:e|ed|o|oppure|ma|perché|poiché|mentre|quando|dove|come|con|senza|tra|fra|di|a|da|in|su|per)\s*$|[:;,\-–—]\s*$|\b(?:infatti|inoltre|tuttavia|pertanto|quindi)\s*$)$/i.test(s);
}

function cleanContinuationText(text, subsection) {
  return stripCompletionMarker(text)
    .replace(new RegExp(`^${escapeRegex(subsection.code)}\\s+${escapeRegex(subsection.title)}\\s*`, 'i'), '')
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .trim();
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildProviderPrompt(task, input) {
  if (typeof input === 'string') return clip(input, 30000);
  const obj = input && typeof input === 'object' ? input : {};
  const sections = [];
  sections.push(`TASK: ${task}`);
  if (obj.prompt) sections.push(`RICHIESTA\n${clip(String(obj.prompt), 14000)}`);
  if (obj.theme) sections.push(`ARGOMENTO\n${clip(String(obj.theme), 1200)}`);
  if (obj.faculty || obj.degreeCourse || obj.degreeType) {
    sections.push(`CONTESTO ACCADEMICO\nFacoltà: ${clip(String(obj.faculty || ''), 300)}\nCorso: ${clip(String(obj.degreeCourse || ''), 400)}\nTipo laurea: ${clip(String(obj.degreeType || ''), 120)}\nMetodologia: ${clip(String(obj.methodology || ''), 120)}`);
  }
  if (obj.approvedOutline) sections.push(`INDICE APPROVATO\n${clip(String(obj.approvedOutline), 7000)}`);
  if (obj.approvedAbstract) sections.push(`ABSTRACT APPROVATO\n${clip(String(obj.approvedAbstract), 4000)}`);
  if (Array.isArray(obj.chapterTitles) && obj.chapterTitles.length) sections.push(`TITOLI CAPITOLI\n${clip(obj.chapterTitles.join('\n'), 2500)}`);
  if (obj.currentChapterTitle || Number.isFinite(obj.currentChapterIndex)) {
    sections.push(`CAPITOLO CORRENTE\nIndice: ${Number(obj.currentChapterIndex || 0) + 1}\nTitolo: ${clip(String(obj.currentChapterTitle || ''), 500)}`);
  }
  if (obj.previousChapters) sections.push(`CAPITOLI PRECEDENTI (SINTESI)\n${clip(String(obj.previousChapters), 6000)}`);
  if (Array.isArray(obj.approvedChapters) && obj.approvedChapters.length) {
    const compact = obj.approvedChapters.map((ch, i) => `Capitolo ${i + 1}: ${(ch && ch.title) || ''}\n${clip(String(ch?.content || ''), 1200)}`).join('\n\n');
    sections.push(`CAPITOLI APPROVATI (ESTRATTO)\n${clip(compact, 5000)}`);
  }
  if (obj.facultyGuidance) sections.push(`GUIDA FACOLTÀ\n${clip(String(obj.facultyGuidance), 3000)}`);
  if (obj.constraints) sections.push(`VINCOLI\n${clip(JSON.stringify(obj.constraints, null, 2), 1500)}`);
  if (wantsFootnoteApparatus(obj) && /^chapter_|tutor_revision$/.test(String(task || ''))) sections.push('APPARATO NOTE\nChiudi il capitolo con una sezione finale autonoma intitolata Note, distinta dal corpo del testo.');
  return sections.join('\n\n');
}

function buildSystemPrompt(task, input) {
  const base = [
    'Scrivi in italiano accademico, chiaro, formale e coerente.',
    'Non inventare fonti, dati empirici, citazioni puntuali o risultati non verificabili.',
    'Evita tono giornalistico, slogan, elenchi inutili, auto-commenti sul testo e formule artificiali di raccordo.',
    'Mantieni continuità logica, rigore terminologico e pertinenza disciplinare.',
    'Non usare chiuse standardizzate come "questo capitolo", "nel prossimo capitolo" o riepiloghi scolastici intercambiabili.',
  ];
  if (task === 'outline_draft') {
    base.push('Genera un indice universitario plausibile, ben strutturato, con capitoli e sottosezioni coerenti con il tema e la metodologia.');
  } else {
    base.push('Produci testo di capitolo o revisione teorica sostanziale, con forte coerenza interna e visibilità dei cambiamenti richiesti.');
    base.push('Se l’input contiene osservazioni del relatore, applicale davvero in modo riconoscibile e non cosmetico.');
  }
  if (wantsFootnoteApparatus(input) && task !== 'outline_draft' && task !== 'abstract_draft') {
    base.push('Se stai scrivendo o riscrivendo un capitolo, chiudilo con una sezione finale autonoma intitolata Note, sobria e senza fonti inventate.');
  }
  if (input && typeof input === 'object' && input.facultyGuidance) {
    base.push(`Tieni conto anche di questa guida di facoltà: ${clip(String(input.facultyGuidance), 1600)}`);
  }
  return base.join(' ');
}

function shrinkPrompt(prompt) {
  return clip(String(prompt || ''), 16000);
}

function clip(value, max) {
  const str = String(value || '');
  if (str.length <= max) return str;
  const keepHead = Math.floor(max * 0.72);
  const keepTail = max - keepHead - 24;
  return `${str.slice(0, keepHead)}\n\n[...contenuto abbreviato...]\n\n${str.slice(-Math.max(keepTail, 0))}`;
}

async function callAnthropic({ model, system, prompt, maxTokens, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        system,
        max_tokens: maxTokens,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const message = data?.error?.message || `Anthropic HTTP ${resp.status}`;
      const err = new Error(message);
      err.statusCode = resp.status;
      throw err;
    }
    return Array.isArray(data?.content)
      ? data.content.filter((x) => x?.type === 'text').map((x) => x.text).join('').trim()
      : '';
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutErr = new Error('Timeout provider Anthropic');
      timeoutErr.code = 'provider_timeout';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI({ model, system, prompt, maxTokens, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const message = data?.error?.message || `OpenAI HTTP ${resp.status}`;
      const err = new Error(message);
      err.statusCode = resp.status;
      throw err;
    }
    return data?.choices?.[0]?.message?.content?.trim() || '';
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutErr = new Error('Timeout provider OpenAI');
      timeoutErr.code = 'provider_timeout';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isProviderTimeout(err) {
  return err?.code === 'provider_timeout' || /timeout/i.test(String(err?.message || ''));
}

function isProviderOverload(err) {
  const msg = String(err?.message || '');
  return /overload|overloaded|529|503|temporarily unavailable|rate limit/i.test(msg);
}

function stripArtificialAcademicTail(text) {
  return String(text || '')
    .replace(/\n(?:In conclusione,?\s*)?(?:nel|nei) prossim[oi] capitol[oi][\s\S]*$/i, '')
    .replace(/\n(?:In conclusione,?\s*)?questo capitolo (?:ha analizzato|si è proposto(?: di)?|ha mostrato|ha evidenziato|ha esaminato|ha consentito di)[\s\S]*$/i, '')
    .replace(/\n(?:Per concludere|In sintesi|In conclusione),?\s+(?:si può affermare|si può osservare|emerge che|si evidenzia che)[^\n]{0,260}$/i, '')
    .trim();
}

function cleanModelText(text) {
  return stripArtificialAcademicTail(
    String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^\s*(?:Ecco(?:\s+il)?(?:\s+capitolo|\s+testo)?(?:\s+revisionato)?[:.]\s*)/i, '')
      .replace(/^\s*(?:Di seguito(?:\s+trovi)?(?:\s+il\s+testo)?[:.]\s*)/i, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function normalizeError(err) {
  const details = String(err?.message || 'Errore interno');
  const payload = {
    error: err?.error || 'server_error',
    code: err?.code || '',
    details,
    statusCode: err?.statusCode || 500,
  };
  if (payload.code === 'provider_timeout') payload.statusCode = 504;
  return payload;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
