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
const CHAPTER_DRAFT_TTL_SECONDS = 6 * 60 * 60;
const SUBSECTION_MIN_WORDS_FLOOR = 260;
const SUBSECTION_MAX_WORDS_HARD_CAP = 980;
const SUBSECTION_MAX_ATTEMPTS = 3;
const SUBSECTION_CONTINUE_MAX_TOKENS = 520;
const SUBSECTION_MIN_PARAGRAPHS = 2;
const SUBSECTION_CLOSURE_MAX_TOKENS = 260;
const INCOMPLETE_TAIL_PATTERNS = [
  /in questo senso$/i,
  /questo implica che$/i,
  /la questione riguarda$/i,
  /da questo punto di vista$/i,
  /restituisce una$/i,
  /contribuisce a$/i,
  /si traduce in$/i,
  /pu[oò] essere letta come$/i,
];
const LOGICALLY_OPEN_ENDING_PATTERNS = [
  /\b(?:come|cos[iì])\s+vedremo\b/i,
  /\b(?:nel|nei|nelle)\s+prossim[oi]\b/i,
  /\b(?:sar[aà]|verr[aà])\s+approfondit[ao]\b/i,
  /\b(?:resta|rimane)\s+da\b/i,
  /\bin\s+attesa\s+di\b/i,
  /\bda\s+completare\b/i,
];

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
      case 'chapter_review':
      case 'tutor_revision':
      case 'revisione_relatore':
      case 'revisione_capitolo': {
        const canonicalTask = normalizeGenerationTask(task);
        const generated = await generateText(canonicalTask, input);
        await recordStat('provider_success', { task: canonicalTask, requestedTask: task });
        if (generated && typeof generated === 'object' && typeof generated.text === 'string') {
          return sendJson(res, 200, { ...generated, task: canonicalTask });
        }
        return sendJson(res, 200, { text: String(generated || ''), task: canonicalTask });
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
    case 'tutor_revision':
    case 'revisione_relatore':
      return 'tutor_revision';
    default:
      return String(task || '').trim();
  }
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
  const progressKey = buildChapterDraftProgressKey(input, context);
  const draftControl = parseChapterDraftControl(input);

  if (draftControl.resetRequested) {
    await clearChapterDraftProgress(progressKey);
  }

  const savedProgress = await loadChapterDraftProgress(progressKey, context);
  const progressCompatible = savedProgress ? isSavedProgressCompatible(savedProgress, context, draftControl.runId, draftControl.mode) : false;
  if (savedProgress && !progressCompatible) {
    await clearChapterDraftProgress(progressKey);
  }
  const effectiveSavedProgress = (savedProgress && progressCompatible) ? savedProgress : null;
  const effectiveRunId = String(
    draftControl.mode === 'resume'
      ? (effectiveSavedProgress?.runId || draftControl.runId || `run_${Date.now()}_${randomBytes(3).toString('hex')}`)
      : (draftControl.runId || `run_${Date.now()}_${randomBytes(3).toString('hex')}`)
  ).trim();

  if (!context.subsections.length) {
    const prompt = buildProviderPrompt('chapter_draft', input);
    const raw = await generateWithProviders({
      prompt,
      system,
      maxTokens: 2200,
      primaryTimeoutMs: 34_000,
      fallbackTimeoutMs: 24_000,
      openaiTimeoutMs: 26_000,
    });
    return {
      text: postProcessChapterText(raw, context),
      done: true,
      chapterComplete: true,
      runId: effectiveRunId,
      status: 'complete',
      resumeRequired: false,
      progress: null,
    };
  }

  const targets = deriveChapterTargets(input, context);
  const byCode = new Map((effectiveSavedProgress?.subsections || []).map((x) => [x.code, x]));
  const savedIntegrity = evaluateSavedProgressIntegrity(context, effectiveSavedProgress, targets.sectionWords);
  let targetIndex = -1;

  for (let i = 0; i < context.subsections.length; i += 1) {
    const subsection = context.subsections[i];
    const saved = byCode.get(subsection.code);
    if (!saved) {
      targetIndex = i;
      break;
    }
    const consideredComplete = isStoredSubsectionComplete(saved, targets.sectionWords, subsection);
    if (!consideredComplete) {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex === -1) {
    const completedParts = savedIntegrity.canonicalEntries;
    const allSubsectionsComplete = savedIntegrity.allExpectedPresentOnce
      && savedIntegrity.noDuplicates
      && savedIntegrity.inExpectedOrder
      && completedParts.length === context.subsections.length
      && completedParts.every((x, idx) => isStoredSubsectionComplete(x, targets.sectionWords, context.subsections[idx]));
    if (!allSubsectionsComplete) {
      targetIndex = Math.max(0, context.subsections.findIndex((subsection) => !isStoredSubsectionComplete(byCode.get(subsection.code), targets.sectionWords, subsection)));
    } else {
      const orderedText = completedParts.map((x) => x.text);
      const chapterText = postProcessChapterText(`${context.chapterHeading}\n\n${orderedText.join('\n\n')}`, context);
      await clearChapterDraftProgress(progressKey);
      return {
        text: chapterText,
        done: true,
        chapterComplete: true,
        runId: effectiveRunId,
        status: 'complete',
        resumeRequired: false,
        progress: {
          chapterNumber: context.currentChapterNumber,
          completedSubsections: context.subsections.length,
          totalSubsections: context.subsections.length,
          currentSubsection: null,
        },
      };
    }
  }

  const subsection = context.subsections[targetIndex];
  const previousSaved = byCode.get(subsection.code);
  const previousComplete = targetIndex > 0 ? byCode.get(context.subsections[targetIndex - 1].code) : null;
  const previousSectionText = previousComplete?.text || '';
  const previousAttempts = Number(previousSaved?.attempts || 0);
  const canContinueCurrent = !!previousSaved?.text;
  const previousAnalysis = canContinueCurrent
    ? analyzeSubsectionCompletion(previousSaved.text, subsection)
    : null;
  const resumeForClosureOnly = !!(
    previousAnalysis
    && previousAnalysis.hasEnoughBodyWords
    && previousAnalysis.hasMinimumParagraphs
    && previousAnalysis.hasValidHeading
    && previousAnalysis.noNestedHeading
    && previousAnalysis.needsTailClosure
  );

  const result = canContinueCurrent
    ? await continueOneSubsection({
        input,
        context,
        subsection,
        system,
        existingText: previousSaved.text,
        targetWords: targets.sectionWords,
        hardCapWords: targets.sectionHardCapWords,
        closeOnly: resumeForClosureOnly,
      })
    : (previousSaved?.text
      ? { text: previousSaved.text, complete: false, forcedByCap: false }
    : await generateOneSubsection({
        input,
        context,
        subsection,
        index: targetIndex,
        total: context.subsections.length,
        system,
        targetWords: targets.sectionWords,
        previousSectionText,
      }));

  const attempts = Number(previousSaved?.attempts || 0) + 1;
  const normalized = enforceSubsectionHardCap(postProcessChapterSectionText(result.text, subsection, context), subsection, targets.sectionHardCapWords);
  const sectionEvaluation = evaluateSubsectionReadiness(normalized, subsection, targets, {
    providerMarkedComplete: result.complete,
    attempts,
    forcedByCap: result.forcedByCap,
  });
  const isComplete = sectionEvaluation.complete;
  const subsectionStatus = isComplete
    ? 'complete'
    : (sectionEvaluation.resumeRequired ? 'resume_required' : 'in_progress');
  await saveChapterDraftProgress(
    progressKey,
    context,
    subsection,
    { text: normalized, complete: isComplete, attempts, status: subsectionStatus },
    effectiveRunId,
  );

  return {
    text: '',
    done: false,
    chapterComplete: false,
    runId: effectiveRunId,
    status: subsectionStatus,
    resumeRequired: !isComplete,
    progress: {
      chapterNumber: context.currentChapterNumber,
      completedSubsections: countCompletedSubsections(context, { ...effectiveSavedProgress, subsections: mergeSavedSubsections(effectiveSavedProgress?.subsections || [], { ...subsection, text: normalized, complete: isComplete, attempts }) }, targets.sectionWords),
      totalSubsections: context.subsections.length,
      currentSubsection: {
        index: targetIndex,
        code: subsection.code,
        title: subsection.title,
        complete: isComplete,
      },
      currentText: normalized,
      canResume: !isComplete,
      completion: {
        words: sectionEvaluation.words,
        integrityOk: sectionEvaluation.integrityOk,
        enoughWords: sectionEvaluation.enoughWords,
        hitHardCap: sectionEvaluation.hitHardCap,
        hitAttemptCap: sectionEvaluation.hitAttemptCap,
      },
    },
  };
}

function parseChapterDraftControl(input) {
  const obj = input && typeof input === 'object' ? input : {};
  const extra = obj.extra && typeof obj.extra === 'object' ? obj.extra : {};
  const modeRaw = String(extra.chapterDraftMode || obj.chapterDraftMode || '').trim().toLowerCase();
  const mode = modeRaw === 'resume' ? 'resume' : 'new';
  const incomingRunId = String(extra.chapterDraftRunId || extra.chapterRunId || obj.chapterDraftRunId || '').trim();
  const runId = incomingRunId || '';
  const resetRequested = mode === 'new' && !!(extra.chapterDraftReset || obj.chapterDraftReset);
  return { runId, resetRequested, mode };
}

function deriveChapterTargets(input, context) {
  const obj = input && typeof input === 'object' ? input : {};
  const degree = String(obj.degreeType || '').toLowerCase();
  const explicit = Number(obj?.constraints?.minWordsChapter || obj?.minWordsChapter || obj?.targetWords || 0);
  let chapterWords = Number.isFinite(explicit) && explicit >= 1800
    ? explicit
    : Math.max(3000, context.subsections.length * (degree.includes('magistr') ? 1000 : 820));
  chapterWords = Math.min(chapterWords, 6200);
  const sectionWords = Math.max(720, Math.ceil(chapterWords / Math.max(context.subsections.length, 1)));
  const sectionSufficientWords = Math.max(SUBSECTION_MIN_WORDS_FLOOR, Math.min(sectionWords, sectionWords - 180));
  const sectionHardCapWords = Math.max(sectionSufficientWords + 120, Math.min(SUBSECTION_MAX_WORDS_HARD_CAP, sectionWords + 120));
  return { chapterWords, sectionWords, sectionSufficientWords, sectionHardCapWords };
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
    const chapterMatch = line.match(/^capitolo\s+(\d+)\s*[—\-:.]?\s*(.*)$/i) || line.match(/^(\d+)\.\s+(.+)$/);
    if (chapterMatch) {
      const n = Number(chapterMatch[1]);
      if (Number.isFinite(n) && n >= 1) {
        if (n === currentChapterNumber) {
          inside = true;
          chapterHeading = cleanChapterHeading(line, currentChapterNumber);
          continue;
        }
        if (inside) break;
      }
    }

    if (!inside) continue;
    const subsectionMatch = line.match(/^(\d+\.\d+)(?:\s*[—\-:.]\s*|\s+)(.+)$/);
    if (subsectionMatch && Number(subsectionMatch[1].split('.')[0]) === currentChapterNumber) {
      subsections.push({ code: subsectionMatch[1], title: subsectionMatch[2].trim() });
    }
  }

  return { currentChapterIndex, currentChapterNumber, chapterHeading, subsections };
}

function cleanChapterHeading(line, chapterNumber) {
  const cleaned = normalizeOutlineLine(line)
    .replace(new RegExp(`^(?:capitolo\\s+)?${chapterNumber}\\s*[—:.-]?\\s*`, 'i'), '')
    .replace(/^\.\s*/, '')
    .trim();
  return cleaned ? `Capitolo ${chapterNumber} — ${cleaned}` : `Capitolo ${chapterNumber}`;
}

function buildChapterDraftProgressKey(input, context) {
  const obj = input && typeof input === 'object' ? input : {};
  const syncKey = String(obj.syncKey || '').trim();
  const sessionToken = String(obj.sessionToken || '').trim();
  const ownerKey = syncKey ? `sync:${safeKey(syncKey)}` : (sessionToken ? `session:${safeKey(sessionToken)}` : '');
  if (!ownerKey) return '';
  return `accademia:chapter:draft:${ownerKey}:${context.currentChapterNumber}`;
}

async function loadChapterDraftProgress(progressKey, context) {
  if (!progressKey) return null;
  try {
    const saved = await getJson(progressKey);
    if (!saved || typeof saved !== 'object') return null;
    const byCode = new Map((Array.isArray(saved.subsections) ? saved.subsections : [])
      .filter((x) => x && x.code && typeof x.text === 'string')
      .map((x) => [String(x.code), {
        text: String(x.text),
        complete: !!x.complete,
        attempts: Number(x.attempts || 0),
        status: String(x.status || ''),
        signature: String(x.signature || ''),
        completedAt: x.completedAt ? String(x.completedAt) : null,
      }]));

    const subsections = [];
    for (const subsection of context.subsections) {
      const item = byCode.get(subsection.code);
      if (!item) break;
      const normalized = postProcessChapterSectionText(item.text, subsection, context);
      subsections.push({
        code: subsection.code,
        title: subsection.title,
        text: normalized,
        complete: !!item.complete,
        attempts: item.attempts,
        status: String(item.status || (item.complete ? 'complete' : 'in_progress')),
        signature: String(item.signature || ''),
        completedAt: item.completedAt ? String(item.completedAt) : null,
      });
    }
    return {
      chapterNumber: Number(saved.chapterNumber || 0),
      chapterHeading: String(saved.chapterHeading || ''),
      runId: String(saved.runId || '').trim(),
      subsectionSignature: String(saved.subsectionSignature || ''),
      subsections,
    };
  } catch (_) {
    return null;
  }
}

async function saveChapterDraftProgress(progressKey, context, subsection, result, runId = '') {
  if (!progressKey) return;
  try {
    const current = (await getJson(progressKey)) || {};
    const subsections = Array.isArray(current.subsections) ? current.subsections : [];
    const entry = {
      code: subsection.code,
      title: subsection.title,
      text: postProcessChapterSectionText(result.text, subsection, context),
      complete: !!result.complete,
      status: String(result.status || (result.complete ? 'complete' : 'in_progress')),
      signature: createSubsectionSignature(context, subsection, result.text),
      attempts: Number(result.attempts || 0),
      completedAt: result.complete ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    };
    const next = [...subsections.filter((x) => x && x.code !== subsection.code), entry]
      .sort((a, b) => context.subsections.findIndex((x) => x.code === a.code) - context.subsections.findIndex((x) => x.code === b.code));
    await putJson(progressKey, {
      chapterHeading: context.chapterHeading,
      chapterNumber: context.currentChapterNumber,
      runId: String(runId || '').trim(),
      subsectionSignature: buildSubsectionSignature(context),
      subsections: next,
      completedParts: next.filter((x) => x.complete).length,
      updatedAt: new Date().toISOString(),
    }, CHAPTER_DRAFT_TTL_SECONDS);
  } catch (_) {}
}

function mergeSavedSubsections(saved, latest) {
  return [...saved.filter((x) => x && x.code !== latest.code), latest];
}

function countCompletedSubsections(context, savedProgress, targetWords) {
  const byCode = new Map((savedProgress?.subsections || []).map((x) => [x.code, x]));
  let count = 0;
  for (const subsection of context.subsections) {
    const saved = byCode.get(subsection.code);
    if (!saved) break;
    if (!isStoredSubsectionComplete(saved, targetWords, subsection)) break;
    count += 1;
  }
  return count;
}

function isStoredSubsectionComplete(saved, targetWords, expectedSubsection = null) {
  if (!saved || typeof saved.text !== 'string') return false;
  if (!saved.complete || String(saved.status || '') !== 'complete') return false;
  const expected = expectedSubsection || saved;
  if (!expected?.code || !expected?.title) return false;
  return !needsMoreSectionText(saved.text, targetWords) && passesSubsectionIntegrityChecks(saved.text, expected);
}

function buildSubsectionSignature(context) {
  const list = Array.isArray(context?.subsections)
    ? context.subsections.map((x) => `${x.code}|${x.title}`).join('||')
    : '';
  return `${context?.currentChapterNumber || 0}::${list}`;
}

function isSavedProgressCompatible(savedProgress, context, runId, mode = 'new') {
  if (!savedProgress || typeof savedProgress !== 'object') return false;
  if (Number(savedProgress.chapterNumber || 0) !== Number(context.currentChapterNumber || 0)) return false;
  const expectedSignature = buildSubsectionSignature(context);
  if (savedProgress.subsectionSignature && savedProgress.subsectionSignature !== expectedSignature) return false;
  const normalizedRunId = String(runId || '').trim();
  const savedRunId = String(savedProgress.runId || '').trim();
  if (mode === 'resume' && savedRunId) return true;
  if (normalizedRunId && savedRunId && normalizedRunId !== savedRunId) return false;
  if (!normalizedRunId && savedRunId) return false;
  return true;
}

async function clearChapterDraftProgress(progressKey) {
  if (!progressKey) return;
  try {
    await delKey(progressKey);
  } catch (_) {}
}

function normalizeOutlineLine(line) {
  return String(line || '')
    .replace(/^#+\s*/, '')
    .replace(/^[-–—*]+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/__+/g, '')
    .trim();
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
    `LIMITE MASSIMO ASSOLUTO: non superare ${SUBSECTION_MAX_WORDS_HARD_CAP} parole complessive`,
    prevSummary,
    'REGOLE OBBLIGATORIE:',
    `- Inizia esattamente con l'intestazione: ${subsection.code} ${subsection.title}`,
    '- Produci solo la sottosezione richiesta.',
    '- Nessun markdown, nessun elenco puntato, nessuna conclusione sul capitolo successivo.',
    '- Usa paragrafi continui, tono accademico, lessico naturale.',
    `- Quando la sottosezione è davvero completa, chiudi l'ultima riga con il marcatore esatto ${SECTION_COMPLETE_MARKER}`,
    '- Non usare il marcatore se la sottosezione non è completa.',
    obj.theme ? `ARGOMENTO DELLA TESI:\n${clip(String(obj.theme), 700)}` : '',
    obj.faculty || obj.degreeCourse || obj.degreeType
      ? `CONTESTO ACCADEMICO:\nFacoltà: ${clip(String(obj.faculty || ''), 120)}\nCorso: ${clip(String(obj.degreeCourse || ''), 160)}\nTipo laurea: ${clip(String(obj.degreeType || ''), 60)}\nMetodologia: ${clip(String(obj.methodology || ''), 60)}`
      : '',
    obj.approvedAbstract ? `ABSTRACT APPROVATO:\n${clip(String(obj.approvedAbstract), 520)}` : '',
    summarizePreviousContext(obj.previousChapters) ? `CAPITOLI PRECEDENTI (SINTESI):\n${summarizePreviousContext(obj.previousChapters)}` : '',
    previousSectionText ? `ULTIMA SOTTOSEZIONE GIÀ SVILUPPATA (ESTRATTO):\n${clip(String(previousSectionText), 260)}` : '',
  ].filter(Boolean).join('\n\n');
}

async function generateOneSubsection({ input, context, subsection, index, total, system, targetWords, previousSectionText }) {
  const prompt = buildChapterSubsectionPrompt(input, context, subsection, index, total, targetWords, previousSectionText);
  const raw = await generateWithProviders({
    prompt,
    system,
    maxTokens: Math.min(1500, Math.max(850, Math.round(targetWords * 1.1))),
    primaryTimeoutMs: 30_000,
    fallbackTimeoutMs: 22_000,
    openaiTimeoutMs: 24_000,
  });
  return {
    text: stripCompletionMarker(raw),
    complete: hasCompletionMarker(raw),
  };
}

async function continueOneSubsection({ input, context, subsection, system, existingText, targetWords, hardCapWords, closeOnly = false }) {
  const obj = input && typeof input === 'object' ? input : {};
  const currentWords = wordCount(existingText);
  if (currentWords >= Math.max(320, hardCapWords - 25)) {
    return { text: existingText, complete: false, forcedByCap: true };
  }
  const prompt = [
    'TASK: chapter_draft_section_continue',
    `CONTINUA SOLO LA SOTTOSEZIONE: ${subsection.code} ${subsection.title}`,
    `CAPITOLO: ${context.chapterHeading}`,
    `TARGET MINIMO DESIDERATO: circa ${targetWords} parole complessive`,
    'REGOLE OBBLIGATORIE:',
    '- Non ripetere il titolo della sottosezione.',
    '- Non ricominciare da capo.',
    '- Continua esattamente dal punto in cui il testo si è fermato.',
    closeOnly
      ? '- Il testo è quasi completo: aggiungi solo il minimo indispensabile per chiudere il ragionamento finale in modo pieno, senza riespandere la sezione.'
      : '- Aggiungi solo il testo mancante per completare la sottosezione in modo pieno e naturale.',
    `- Mantieniti entro il limite assoluto di ${hardCapWords} parole complessive.`,
    '- Non inserire formule come "nel prossimo capitolo" o riepiloghi scolastici.',
    `- Quando la sottosezione è davvero completa, chiudi l'ultima riga con il marcatore esatto ${SECTION_COMPLETE_MARKER}`,
    '- Se non è ancora completa, non usare il marcatore.',
    obj.approvedAbstract ? `ABSTRACT APPROVATO (estratto):\n${clip(String(obj.approvedAbstract), 360)}` : '',
    `TESTO GIÀ GENERATO (estratto finale):\n${clip(tailWords(String(existingText), 260), 1200)}`,
  ].filter(Boolean).join('\n\n');

  const addition = await generateWithProviders({
    prompt,
    system,
    maxTokens: closeOnly ? SUBSECTION_CLOSURE_MAX_TOKENS : SUBSECTION_CONTINUE_MAX_TOKENS,
    primaryTimeoutMs: 22_000,
    fallbackTimeoutMs: 18_000,
    openaiTimeoutMs: 20_000,
  });

  const cleanedAddition = cleanContinuationText(addition, subsection);
  return {
    text: `${stripCompletionMarker(existingText).trim()}\n\n${cleanedAddition}`.trim(),
    complete: hasCompletionMarker(addition),
    forcedByCap: false,
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

function postProcessChapterSectionText(text, subsection, context = null) {
  let cleaned = cleanModelText(text)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .trim();

  const heading = `${subsection.code} ${subsection.title}`;
  if (!cleaned.startsWith(heading)) {
    cleaned = `${heading}\n\n${cleaned.replace(/^\d+\.\d+\s+.+?(\n|$)/, '').trim()}`.trim();
  }
  cleaned = trimSectionAfterUnexpectedHeading(cleaned, subsection, context);
  cleaned = preserveSectionNumbering(cleaned, subsection);
  cleaned = normalizeSectionFormatting(cleaned, subsection);
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
  const closure = hasIncompleteTail(sectionText);
  return words < Math.max(520, targetWords - 120)
    || endsSuspiciously(sectionText)
    || closure.incomplete
    || hasOpenStructures(sectionText)
    || !hasMinimumParagraphs(sectionText, SUBSECTION_MIN_PARAGRAPHS);
}

function evaluateSubsectionReadiness(text, subsection, targets, meta = {}) {
  const words = wordCount(text);
  const providerMarkedComplete = !!meta.providerMarkedComplete;
  const attempts = Number(meta.attempts || 0);
  const forcedByCap = !!meta.forcedByCap;
  const analysis = analyzeSubsectionCompletion(text, subsection);
  const integrityOk = analysis.complete;
  const enoughWords = words >= Number(targets?.sectionSufficientWords || SUBSECTION_MIN_WORDS_FLOOR);
  const hitHardCap = words >= Number(targets?.sectionHardCapWords || SUBSECTION_MAX_WORDS_HARD_CAP);
  const hitAttemptCap = attempts >= SUBSECTION_MAX_ATTEMPTS;
  const completeByContent = integrityOk && enoughWords;
  const complete = completeByContent || (providerMarkedComplete && integrityOk && enoughWords);
  const resumeRequired = !complete && (integrityOk || words >= Math.max(SUBSECTION_MIN_WORDS_FLOOR, Number(targets?.sectionSufficientWords || SUBSECTION_MIN_WORDS_FLOOR) - 120));
  return { complete, resumeRequired, words, integrityOk, enoughWords, hitHardCap, hitAttemptCap, needsTailClosure: analysis.needsTailClosure, forcedByCap };
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

function normalizeSectionFormatting(text, subsection) {
  const normalized = preserveSectionNumbering(String(text || ''), subsection);
  const lines = normalized.split(/\r?\n/);
  const heading = lines.shift() || `${subsection.code} ${subsection.title}`;
  let body = lines.join('\n').trim();
  body = body
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/([A-Za-zÀ-ÖØ-öø-ÿ])-\s*\n\s*([A-Za-zÀ-ÖØ-öø-ÿ])/g, '$1$2')
    .replace(/([A-Za-zÀ-ÖØ-öø-ÿ])\s+\n\s*([A-Za-zÀ-ÖØ-öø-ÿ])/g, '$1 $2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  body = enforceSubsectionParagraphing(body);
  return body ? `${heading}\n\n${body}`.trim() : heading;
}

function enforceSubsectionParagraphing(bodyText) {
  const body = String(bodyText || '').trim();
  if (!body) return '';
  const paragraphs = body.split(/\n{2,}/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (paragraphs.length >= SUBSECTION_MIN_PARAGRAPHS) return paragraphs.join('\n\n');
  const compact = paragraphs.join(' ').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const sentences = compact.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [compact];
  const rebuilt = [];
  let bucket = [];
  let bucketWords = 0;
  const targetWords = Math.max(80, Math.ceil(wordCount(compact) / SUBSECTION_MIN_PARAGRAPHS));
  for (const sentence of sentences) {
    const cleanSentence = sentence.replace(/\s+/g, ' ').trim();
    if (!cleanSentence) continue;
    const sentenceWords = wordCount(cleanSentence);
    if (bucketWords >= targetWords && rebuilt.length < SUBSECTION_MIN_PARAGRAPHS - 1) {
      rebuilt.push(bucket.join(' ').trim());
      bucket = [cleanSentence];
      bucketWords = sentenceWords;
      continue;
    }
    bucket.push(cleanSentence);
    bucketWords += sentenceWords;
  }
  if (bucket.length) rebuilt.push(bucket.join(' ').trim());
  const cleanedRebuilt = rebuilt.filter(Boolean);
  if (cleanedRebuilt.length >= SUBSECTION_MIN_PARAGRAPHS) return cleanedRebuilt.join('\n\n');
  const midpoint = Math.ceil(sentences.length / 2);
  const first = sentences.slice(0, midpoint).join(' ').replace(/\s+/g, ' ').trim();
  const second = sentences.slice(midpoint).join(' ').replace(/\s+/g, ' ').trim();
  return [first, second].filter(Boolean).join('\n\n');
}

function enforceSubsectionHardCap(text, subsection, hardCapWords) {
  const normalized = preserveSectionNumbering(String(text || ''), subsection);
  const lines = normalized.split(/\r?\n/);
  const heading = lines.shift() || `${subsection.code} ${subsection.title}`;
  const body = lines.join('\n').trim();
  if (!body) return heading;
  const maxWords = Math.max(320, Number(hardCapWords || SUBSECTION_MAX_WORDS_HARD_CAP));
  const bodyWords = body.split(/\s+/).filter(Boolean);
  if (bodyWords.length <= maxWords) return `${heading}\n\n${body}`.trim();
  const truncated = bodyWords.slice(0, maxWords).join(' ').replace(/[,:;()\-\u2013\u2014]+$/g, '').trim();
  const safeEnding = /[.!?)]$/.test(truncated) ? truncated : `${truncated}.`;
  return `${heading}\n\n${safeEnding}`.trim();
}

function tailWords(text, maxWords) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(words.length - maxWords).join(' ');
}

function preserveSectionNumbering(text, subsection) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return `${subsection.code} ${subsection.title}`;
  const lines = cleaned.split(/\r?\n/);
  const heading = `${subsection.code} ${subsection.title}`;
  lines[0] = heading;
  return lines.join('\n').trim();
}

function trimSectionAfterUnexpectedHeading(text, subsection, context) {
  const lines = String(text || '').split(/\r?\n/);
  const ownHeading = new RegExp(`^${escapeRegex(subsection.code)}\\s+`, 'i');
  const expectedCodes = new Set(Array.isArray(context?.subsections) ? context.subsections.map((x) => x.code) : []);
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const headingMatch = line.match(/^(\d+\.\d+)\s+/);
    if (headingMatch) {
      const code = headingMatch[1];
      if (i > 0 && !ownHeading.test(line) && (!expectedCodes.size || expectedCodes.has(code))) {
        break;
      }
    }
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function passesSubsectionIntegrityChecks(text, subsection) {
  return analyzeSubsectionCompletion(text, subsection).complete;
}

function analyzeSubsectionCompletion(text, subsection) {
  const content = String(text || '').trim();
  if (!content) return defaultSubsectionAnalysis();
  const heading = `${subsection.code} ${subsection.title}`;
  const hasValidHeading = content.startsWith(heading);
  if (!hasValidHeading) {
    return defaultSubsectionAnalysis();
  }
  const withoutHeading = content.slice(heading.length).trim();
  const hasEnoughBodyWords = wordCount(withoutHeading) >= 160;
  const bodyParagraphs = getBodyParagraphs(withoutHeading);
  const hasEnoughParagraphs = bodyParagraphs.length >= SUBSECTION_MIN_PARAGRAPHS;
  const closure = hasIncompleteTail(withoutHeading);
  const noSuspiciousEnding = !endsSuspiciously(withoutHeading);
  const noOpenStructures = !hasOpenStructures(withoutHeading);
  const finalSentence = extractFinalSentence(withoutHeading);
  const punctuationClosed = finalSentence.punctuationClosed;
  const lastParagraphClosed = isLastParagraphClosed(bodyParagraphs);
  const grammarClosed = punctuationClosed && !finalSentence.suspiciousTail;
  const logicClosed = !finalSentence.logicallyOpen;
  const lines = content.split(/\r?\n/).slice(1);
  const noNestedHeading = !lines.some((line) => /^\d+\.\d+\s+/.test(line.trim()));
  const complete = hasEnoughBodyWords
    && hasEnoughParagraphs
    && lastParagraphClosed
    && grammarClosed
    && logicClosed
    && noSuspiciousEnding
    && noOpenStructures
    && !closure.incomplete
    && noNestedHeading;
  const needsTailClosure = noNestedHeading
    && hasEnoughBodyWords
    && hasEnoughParagraphs
    && (!lastParagraphClosed || !grammarClosed || !logicClosed || closure.incomplete || !noSuspiciousEnding || !noOpenStructures);
  return {
    complete,
    hasValidHeading,
    hasEnoughBodyWords,
    hasMinimumParagraphs: hasEnoughParagraphs,
    noNestedHeading,
    hasText: withoutHeading.length > 0,
    lastParagraphClosed,
    grammarClosed,
    logicClosed,
    needsTailClosure,
  };
}

function defaultSubsectionAnalysis() {
  return {
    complete: false,
    hasValidHeading: false,
    hasEnoughBodyWords: false,
    hasMinimumParagraphs: false,
    noNestedHeading: false,
    hasText: false,
    lastParagraphClosed: false,
    grammarClosed: false,
    logicClosed: false,
    needsTailClosure: true,
  };
}

function hasMinimumParagraphs(text, minParagraphs) {
  const body = String(text || '').trim();
  if (!body) return false;
  const paragraphs = getBodyParagraphs(body);
  return paragraphs.length >= Math.max(1, Number(minParagraphs || 1));
}

function getBodyParagraphs(text) {
  return String(text || '')
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => wordCount(p) >= 20);
}

function extractFinalSentence(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return { sentence: '', punctuationClosed: false, suspiciousTail: true, logicallyOpen: true };
  const punctuationClosed = /[.!?)]$/.test(normalized);
  const chunks = normalized.match(/[^.!?]+[.!?)]|[^.!?]+$/g) || [normalized];
  const sentence = String(chunks[chunks.length - 1] || normalized).trim();
  const suspiciousTail = /(?:\b(?:e|ed|o|oppure|ma|perché|poiché|mentre|quando|dove|come|con|senza|tra|fra|di|a|da|in|su|per|nel|nella|nelle|negli|degli|delle)\s*$|[:;,\-–—]\s*$)$/i.test(sentence);
  const logicallyOpen = LOGICALLY_OPEN_ENDING_PATTERNS.some((pattern) => pattern.test(sentence));
  return { sentence, punctuationClosed, suspiciousTail, logicallyOpen };
}

function isLastParagraphClosed(paragraphs) {
  const lastParagraph = Array.isArray(paragraphs) && paragraphs.length ? String(paragraphs[paragraphs.length - 1] || '').trim() : '';
  if (!lastParagraph) return false;
  if (wordCount(lastParagraph) < 20) return false;
  if (hasIncompleteTail(lastParagraph).incomplete) return false;
  const finalSentence = extractFinalSentence(lastParagraph);
  return finalSentence.punctuationClosed && !finalSentence.suspiciousTail && !finalSentence.logicallyOpen;
}

function hasOpenStructures(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  if (/[,:;(\[\{«“"'\-–—]\s*$/.test(normalized)) return true;
  const delimiters = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
    ['«', '»'],
    ['“', '”'],
    ['"', '"'],
  ];
  for (const [open, close] of delimiters) {
    if (open === close) {
      const count = (normalized.match(new RegExp(escapeRegex(open), 'g')) || []).length;
      if (count % 2 !== 0) return true;
    } else {
      const openCount = (normalized.match(new RegExp(escapeRegex(open), 'g')) || []).length;
      const closeCount = (normalized.match(new RegExp(escapeRegex(close), 'g')) || []).length;
      if (openCount > closeCount) return true;
    }
  }
  const trimmedTail = tailWords(normalized, 18);
  if (/\b(?:e|ed|o|oppure|ma|perché|poiché|mentre|quando|dove|come|con|senza|tra|fra|di|a|da|in|su|per|nel|nella|nelle|negli|degli|delle)\s*$/i.test(trimmedTail)) return true;
  return false;
}

function hasIncompleteTail(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return { incomplete: true, reason: 'empty' };
  const compactTail = tailWords(normalized, 16).toLowerCase().replace(/[.!?…]+$/g, '').trim();
  if (!compactTail) return { incomplete: true, reason: 'empty_tail' };
  if (INCOMPLETE_TAIL_PATTERNS.some((pattern) => pattern.test(compactTail))) {
    return { incomplete: true, reason: 'known_open_formula' };
  }
  if (/(?:\b(?:una|un|il|lo|la|i|gli|le)\s+[a-zà-öø-ÿ]+)$/.test(compactTail) && /(?:restituisce|implica|riguarda)\s+(?:una|un|il|lo|la|i|gli|le)\s+[a-zà-öø-ÿ]+$/i.test(compactTail)) {
    return { incomplete: true, reason: 'dangling_object' };
  }
  if (/^(?:in|da|per|con|senza|tra|fra|su|a|di)\b/i.test(compactTail) && compactTail.split(/\s+/).length <= 4) {
    return { incomplete: true, reason: 'short_prep_tail' };
  }
  return { incomplete: false, reason: '' };
}

function createSubsectionSignature(context, subsection, text) {
  const base = `${context.currentChapterNumber}|${subsection.code}|${subsection.title}|${String(text || '').trim()}`;
  return createHash('sha256').update(base).digest('hex').slice(0, 20);
}

function evaluateSavedProgressIntegrity(context, savedProgress, targetWords) {
  const savedSubsections = Array.isArray(savedProgress?.subsections) ? savedProgress.subsections : [];
  const counts = new Map();
  for (const item of savedSubsections) {
    const code = String(item?.code || '');
    if (!code) continue;
    counts.set(code, Number(counts.get(code) || 0) + 1);
  }
  const canonicalEntries = context.subsections.map((subsection) => savedSubsections.find((x) => x && x.code === subsection.code)).filter(Boolean);
  const allExpectedPresentOnce = context.subsections.every((subsection) => Number(counts.get(subsection.code) || 0) === 1);
  const noDuplicates = [...counts.values()].every((count) => count <= 1);
  const expectedOrder = context.subsections.map((subsection) => subsection.code);
  const savedOrder = savedSubsections
    .filter((item) => item && expectedOrder.includes(item.code))
    .map((item) => item.code);
  const inExpectedOrder = savedOrder.length === expectedOrder.length
    && savedOrder.every((code, idx) => code === expectedOrder[idx]);
  const allComplete = context.subsections.every((subsection) => isStoredSubsectionComplete(savedSubsections.find((x) => x && x.code === subsection.code), targetWords, subsection));
  return { canonicalEntries, allExpectedPresentOnce, noDuplicates, inExpectedOrder, allComplete };
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
  return sections.join('\n\n');
}

function buildSystemPrompt(task, input) {
  const base = [
    'Scrivi in italiano accademico, chiaro, formale e coerente.',
    'Non inventare fonti, dati empirici, citazioni puntuali o risultati non verificabili.',
    'Evita tono giornalistico, slogan, elenchi inutili e formule artificiali di raccordo.',
    'Mantieni continuità logica, rigore terminologico e pertinenza disciplinare.',
  ];
  if (task === 'outline_draft') {
    base.push('Genera un indice universitario plausibile, ben strutturato, con capitoli e sottosezioni coerenti con il tema e la metodologia.');
  } else {
    base.push('Produci testo di capitolo o revisione teorica sostanziale, con forte coerenza interna e visibilità dei cambiamenti richiesti.');
    base.push('Se l’input contiene osservazioni del relatore, applicale davvero in modo riconoscibile e non cosmetico.');
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

function cleanModelText(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
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
