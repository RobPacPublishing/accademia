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
const SESSION_TTL_SECONDS = 60 * 24 * 60 * 60;
const SNAPSHOT_LIMIT = 15;
const EVENT_LIMIT = 50;

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
        const owner = await resolveOwner(input);
        assert(owner, 'syncKey o sessionToken mancanti');
        await putJson(owner.stateKey, { state: input?.payload || null, savedAt: new Date().toISOString() });
        await recordEvent('state_save', { scope: owner.scope });
        return sendJson(res, 200, { ok: true });
      }

      case '__state_load': {
        const owner = await resolveOwner(input);
        assert(owner, 'syncKey o sessionToken mancanti');
        const record = await getJson(owner.stateKey);
        return sendJson(res, 200, { state: record?.state || null, savedAt: record?.savedAt || null });
      }

      case '__snapshot_create': {
        const owner = await resolveOwner(input);
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
        const owner = await resolveOwner(input);
        assert(owner, 'syncKey o sessionToken mancanti');
        const snapshots = (await getJson(owner.snapshotsKey)) || [];
        return sendJson(res, 200, { snapshots });
      }

      case '__recovery_save': {
        const owner = await resolveOwner(input);
        assert(owner, 'syncKey o sessionToken mancanti');
        const record = input?.record || null;
        assert(record && record.payload, 'record mancante');
        await putJson(owner.recoveryKey, record);
        await recordEvent('recovery_save', { scope: owner.scope, reason: String(record?.reason || 'manuale') });
        return sendJson(res, 200, { ok: true });
      }

      case '__recovery_load': {
        const owner = await resolveOwner(input);
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
        const sessionToken = makeId('sess');
        await putJson(accountSessionKey(sessionToken), { email, createdAt: new Date().toISOString() }, SESSION_TTL_SECONDS);
        await recordStat('account_verify_ok', { email: redactEmail(email) });
        return sendJson(res, 200, { ok: true, sessionToken, email });
      }

      case '__account_load': {
        const owner = await resolveOwner(input);
        assert(owner && owner.scope === 'account', 'sessionToken mancante o non valido');
        const record = await getJson(owner.stateKey);
        return sendJson(res, 200, { state: record?.state || null, savedAt: record?.savedAt || null });
      }

      case '__account_save': {
        const owner = await resolveOwner(input);
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
        const text = await generateText(canonicalTask, input);
        await recordStat('provider_success', { task: canonicalTask, requestedTask: task });
        return sendJson(res, 200, { text, task: canonicalTask });
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
  const id = hashEmail(email);
  return {
    scope: 'account',
    email,
    sessionToken,
    stateKey: `accademia:account:${id}:state`,
    snapshotsKey: `accademia:account:${id}:snapshots`,
    recoveryKey: `accademia:account:${id}:recovery`,
  };
}

function safeKey(value) {
  return String(value || '').replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 180);
}

function accountOtpKey(email) {
  return `accademia:otp:${hashEmail(email)}`;
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

async function generateWithProviders({
  prompt,
  system,
  maxTokens,
  primaryTimeoutMs = 34_000,
  fallbackTimeoutMs = 22_000,
  openaiTimeoutMs = 24_000
}) {
  const attempts = [];
  if (ANTHROPIC_API_KEY) {
    attempts.push(() => callAnthropic({
      model: ANTHROPIC_PRIMARY_MODEL,
      system,
      prompt,
      maxTokens,
      timeoutMs: primaryTimeoutMs
    }));
    attempts.push(() => callAnthropic({
      model: ANTHROPIC_FALLBACK_MODEL,
      system,
      prompt: shrinkPrompt(prompt),
      maxTokens: Math.min(1800, maxTokens),
      timeoutMs: fallbackTimeoutMs
    }));
  }
  if (OPENAI_API_KEY) {
    attempts.push(() => callOpenAI({
      model: OPENAI_MODEL,
      system,
      prompt: shrinkPrompt(prompt),
      maxTokens: Math.min(1800, maxTokens),
      timeoutMs: openaiTimeoutMs
    }));
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
      const recoverable =
        isProviderTimeout(err) ||
        isProviderOverload(err) ||
        /rate limit|overloaded|temporarily unavailable|connection|socket/i.test(String(err?.message || ''));
      if (!recoverable) break;
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
  const targetChapterWords = deriveTargetChapterWords(input, context);
  const subsectionCount = Math.max(context.subsections.length || 1, 1);
  const minimumSectionWords = Math.max(750, Math.floor(targetChapterWords / subsectionCount));

  if (!context.subsections.length) {
    const prompt = buildProviderPrompt('chapter_draft', input);
    let raw = await generateWithProviders({
      prompt,
      system,
      maxTokens: 3000,
      primaryTimeoutMs: 36_000,
      fallbackTimeoutMs: 24_000,
      openaiTimeoutMs: 26_000
    });
    let chapterText = postProcessChapterText(raw, context);

    for (let pass = 0; pass < 2 && needsChapterCompletion(chapterText, targetChapterWords, context); pass += 1) {
      const completionPrompt = buildChapterFinalCompletionPrompt(input, context, chapterText, targetChapterWords);
      const completion = await generateWithProviders({
        prompt: completionPrompt,
        system,
        maxTokens: 1100,
        primaryTimeoutMs: 20_000,
        fallbackTimeoutMs: 15_000,
        openaiTimeoutMs: 17_000
      });
      chapterText = postProcessChapterText(`${chapterText}\n\n${completion}`, context);
    }

    return chapterText;
  }

  const parts = [];
  for (let i = 0; i < context.subsections.length; i += 1) {
    const subsection = context.subsections[i];
    const prompt = buildChapterSubsectionPrompt(input, context, subsection, i, context.subsections.length, minimumSectionWords);
    let raw = await generateWithProviders({
      prompt,
      system,
      maxTokens: estimateSectionMaxTokens(minimumSectionWords),
      primaryTimeoutMs: 34_000,
      fallbackTimeoutMs: 22_000,
      openaiTimeoutMs: 24_000
    });

    let sectionText = postProcessChapterSectionText(raw, subsection);

    for (let pass = 0; pass < 2 && needsSectionContinuation(sectionText, minimumSectionWords); pass += 1) {
      const continuationPrompt = buildChapterContinuationPrompt(input, context, subsection, sectionText, minimumSectionWords);
      const continued = await generateWithProviders({
        prompt: continuationPrompt,
        system,
        maxTokens: Math.min(1600, estimateSectionMaxTokens(Math.max(520, Math.floor(minimumSectionWords * 0.62)))),
        primaryTimeoutMs: 24_000,
        fallbackTimeoutMs: 18_000,
        openaiTimeoutMs: 20_000
      });
      sectionText = mergeSectionContinuation(sectionText, continued, subsection);
    }

    parts.push(sectionText);
  }

  let chapterText = `${context.chapterHeading}\n\n${parts.join('\n\n')}`;
  chapterText = postProcessChapterText(chapterText, context);

  for (let pass = 0; pass < 2 && needsChapterCompletion(chapterText, targetChapterWords, context); pass += 1) {
    const completionPrompt = buildChapterFinalCompletionPrompt(input, context, chapterText, targetChapterWords);
    const completion = await generateWithProviders({
      prompt: completionPrompt,
      system,
      maxTokens: 1100,
      primaryTimeoutMs: 20_000,
      fallbackTimeoutMs: 15_000,
      openaiTimeoutMs: 17_000
    });
    chapterText = postProcessChapterText(`${chapterText}\n\n${completion}`, context);
  }

  return chapterText;
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

  let chapterHeading = cleanChapterHeading(String(obj.currentChapterTitle || '').trim(), currentChapterNumber);
  const subsections = [];
  let insideCurrentChapter = false;

  for (const line of normalizedLines) {
    const chapterLineMatch = line.match(/^(?:capitolo\s+)?(\d+)\s*[—\-:\.]?\s*(.+)?$/i);
    const isChapterLine = /^capitolo\s+/i.test(line) || /^\d+\.\s+/.test(line) || /^(\d+)\s*[—\-:]/.test(line);

    if (chapterLineMatch && isChapterLine) {
      const chapterNum = Number(chapterLineMatch[1]);
      if (chapterNum === currentChapterNumber) {
        insideCurrentChapter = true;
        chapterHeading = cleanChapterHeading(line, currentChapterNumber);
        continue;
      }
      if (insideCurrentChapter && chapterNum > currentChapterNumber) {
        break;
      }
    }

    if (!insideCurrentChapter) continue;

    const subsectionMatch = line.match(/^(\d+\.\d+)\s+(.+)$/);
    if (subsectionMatch) {
      const major = Number(String(subsectionMatch[1]).split('.')[0]);
      if (major === currentChapterNumber) {
        subsections.push({ code: subsectionMatch[1], title: subsectionMatch[2].trim() });
      }
    }
  }

  return {
    currentChapterIndex,
    currentChapterNumber,
    chapterHeading: chapterHeading || `Capitolo ${currentChapterNumber}`,
    subsections
  };
}

function normalizeOutlineLine(line) {
  return String(line || '')
    .replace(/^#+\s*/, '')
    .replace(/^[-–—*]+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/__+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanChapterHeading(value, chapterNumber) {
  let cleaned = normalizeOutlineLine(value || '');
  cleaned = cleaned.replace(/^capitolo\s+(\d+)\s*[—\-:\.]?\s*\.\s*/i, 'Capitolo $1 — ');
  cleaned = cleaned.replace(/^(\d+)\.\s+(.+)$/, 'Capitolo $1 — $2');
  if (!cleaned) return `Capitolo ${chapterNumber}`;
  if (!/^capitolo\s+\d+/i.test(cleaned)) {
    cleaned = `Capitolo ${chapterNumber} — ${cleaned}`;
  }
  return cleaned.replace(/\s+[—\-]\s+[—\-]\s+/g, ' — ').replace(/\s{2,}/g, ' ').trim();
}

function deriveTargetChapterWords(input, context) {
  const obj = input && typeof input === 'object' ? input : {};
  const direct =
    Number(obj?.constraints?.minWordsChapter) ||
    Number(obj?.minWordsChapter) ||
    Number(obj?.targetWords) ||
    0;
  if (Number.isFinite(direct) && direct >= 1800) return direct;

  const degree = String(obj.degreeType || '').toLowerCase();
  const subsectionCount = Math.max(context.subsections.length, 1);
  const basePerSection = degree.includes('magistr') ? 980 : 820;
  return Math.max(subsectionCount * basePerSection, degree.includes('magistr') ? 4200 : 3200);
}

function estimateSectionMaxTokens(minWords) {
  return Math.min(2200, Math.max(1250, Math.round(minWords * 1.55)));
}

function buildChapterSubsectionPrompt(input, context, subsection, index, total, minimumSectionWords) {
  const obj = input && typeof input === 'object' ? input : {};
  const previous = index > 0 ? `${context.subsections[index - 1].code} ${context.subsections[index - 1].title}` : '';
  const approvedAbstract = obj.approvedAbstract ? clip(String(obj.approvedAbstract), 1600) : '';
  const chapterContext = sectionContextExcerpt(obj, context, index);

  return [
    'TASK: chapter_draft_section',
    `SVILUPPA SOLO LA SOTTOSEZIONE ${subsection.code} ${subsection.title}.`,
    `CAPITOLO: ${context.chapterHeading}`,
    `POSIZIONE NEL CAPITOLO: ${index + 1} di ${total}.`,
    previous ? `SOTTOSEZIONE PRECEDENTE: ${previous}. Mantieni continuità logica senza ripetizioni.` : 'Apri il capitolo in modo accademico e già sostanziale.',
    `LUNGHEZZA MINIMA DESIDERATA: circa ${minimumSectionWords} parole.`,
    'REGOLE OBBLIGATORIE:',
    `- Inizia esattamente con: ${subsection.code} ${subsection.title}`,
    '- Scrivi solo la sottosezione richiesta.',
    '- Non usare markdown, asterischi, elenchi puntati o frasi metatestuali.',
    '- Non annunciare il capitolo successivo e non commentare esplicitamente la struttura della tesi.',
    '- Chiudi la sottosezione in modo pieno, senza frase sospesa o finale troncato.',
    obj.theme ? `ARGOMENTO DELLA TESI:\n${clip(String(obj.theme), 900)}` : '',
    obj.faculty || obj.degreeCourse || obj.degreeType
      ? `CONTESTO ACCADEMICO:\nFacoltà: ${clip(String(obj.faculty || ''), 200)}\nCorso: ${clip(String(obj.degreeCourse || ''), 280)}\nTipo laurea: ${clip(String(obj.degreeType || ''), 120)}\nMetodologia: ${clip(String(obj.methodology || ''), 120)}`
      : '',
    approvedAbstract ? `ABSTRACT APPROVATO:\n${approvedAbstract}` : '',
    chapterContext ? `CONTESTO UTILE GIÀ DISPONIBILE:\n${chapterContext}` : ''
  ].filter(Boolean).join('\n\n');
}

function buildChapterContinuationPrompt(input, context, subsection, currentSectionText, minimumSectionWords) {
  const obj = input && typeof input === 'object' ? input : {};
  return [
    'TASK: chapter_draft_section_continuation',
    `COMPLETA LA SOTTOSEZIONE ${subsection.code} ${subsection.title} senza riscriverla da capo.`,
    `CAPITOLO: ${context.chapterHeading}`,
    `TESTO GIÀ PRODOTTO:\n${clip(currentSectionText, 2200)}`,
    `OBIETTIVO: portare la sottosezione a una forma piena e naturale, con circa ${minimumSectionWords} parole complessive.`,
    'REGOLE OBBLIGATORIE:',
    '- Non ripetere l’intestazione della sottosezione.',
    '- Non ricominciare da zero e non duplicare paragrafi già scritti.',
    '- Prosegui esattamente da dove il testo si interrompe.',
    '- Chiudi con un finale compiuto e accademico, senza frasi sospese.',
    obj.theme ? `ARGOMENTO DELLA TESI:\n${clip(String(obj.theme), 700)}` : ''
  ].filter(Boolean).join('\n\n');
}

function buildChapterFinalCompletionPrompt(input, context, chapterText, targetChapterWords) {
  const obj = input && typeof input === 'object' ? input : {};
  const lastSubsection = context.subsections[context.subsections.length - 1];
  return [
    'TASK: chapter_draft_final_completion',
    `COMPLETA SOLO LA PARTE FINALE DEL CAPITOLO ${context.currentChapterNumber}.`,
    `CAPITOLO: ${context.chapterHeading}`,
    lastSubsection ? `ULTIMA SOTTOSEZIONE: ${lastSubsection.code} ${lastSubsection.title}` : '',
    `TESTO GIÀ PRODOTTO:\n${clip(chapterText, 3200)}`,
    `OBIETTIVO: chiudere il capitolo in modo compiuto e portarlo più vicino a circa ${targetChapterWords} parole complessive, senza ripetizioni.`,
    'REGOLE OBBLIGATORIE:',
    '- Non riscrivere le parti già presenti.',
    '- Non aggiungere titoli nuovi diversi dalle sottosezioni già esistenti.',
    '- Non inserire formule tipo "nel prossimo capitolo".',
    '- Restituisci solo testo utile da appendere in coda.'
  ].filter(Boolean).join('\n\n');
}

function sectionContextExcerpt(input, context, index) {
  const obj = input && typeof input === 'object' ? input : {};
  const chunks = [];

  if (index > 0 && context.subsections[index - 1]) {
    chunks.push(`Ultima sottosezione già prevista prima di questa: ${context.subsections[index - 1].code} ${context.subsections[index - 1].title}.`);
  }

  if (Array.isArray(obj.approvedChapters) && obj.approvedChapters.length) {
    const compact = obj.approvedChapters
      .slice(-2)
      .map((ch, i) => `Capitolo precedente ${i + 1}: ${(ch && ch.title) || ''}\n${clip(String(ch?.content || ''), 600)}`)
      .join('\n\n');
    if (compact) chunks.push(compact);
  } else if (obj.previousChapters) {
    chunks.push(clip(String(obj.previousChapters), 1200));
  }

  return clip(chunks.join('\n\n').trim(), 1800);
}

function needsSectionContinuation(sectionText, minimumSectionWords) {
  const words = countWords(sectionText);
  return words < Math.max(420, Math.floor(minimumSectionWords * 0.72)) || endsSuspiciously(sectionText);
}

function needsChapterCompletion(chapterText, targetChapterWords, context) {
  const words = countWords(chapterText);
  if (words < Math.floor(targetChapterWords * 0.88)) return true;
  const lastCode = context.subsections.length ? context.subsections[context.subsections.length - 1].code : '';
  if (lastCode && !chapterText.includes(lastCode)) return true;
  return endsSuspiciously(chapterText);
}

function mergeSectionContinuation(sectionText, continuation, subsection) {
  const heading = `${subsection.code} ${subsection.title}`;
  let extra = cleanModelText(continuation)
    .replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, 'i'), '')
    .trim();
  if (!extra) return sectionText;
  const merged = `${sectionText}\n\n${extra}`;
  return postProcessChapterSectionText(merged, subsection);
}

function postProcessChapterSectionText(text, subsection) {
  const heading = `${subsection.code} ${subsection.title}`;
  let cleaned = cleanModelText(text)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(heading)}\\s*${escapeRegExp(heading)}\\s*`, 'i'), `${heading}\n\n`);

  if (!cleaned.startsWith(heading)) {
    cleaned = `${heading}\n\n${cleaned.replace(/^\d+\.\d+\s+.+?(?:\n|$)/, '').trim()}`.trim();
  }

  return normalizeAcademicParagraphs(cleaned);
}

function postProcessChapterText(text, context) {
  const chapterHeading = cleanChapterHeading(context.chapterHeading || `Capitolo ${context.currentChapterNumber}`, context.currentChapterNumber);

  let cleaned = cleanModelText(text)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned.startsWith(chapterHeading)) {
    cleaned = `${chapterHeading}\n\n${cleaned}`;
  }

  cleaned = cleaned.replace(/^([^\n]+)\n+\1\b/m, '$1');
  cleaned = cleaned.replace(/Capitolo\s+(\d+)\s*[—\-:\.]?\s*\.\s*/gi, 'Capitolo $1 — ');
  cleaned = removeArtificialTransitions(cleaned);

  return normalizeAcademicParagraphs(cleaned);
}

function removeArtificialTransitions(text) {
  return String(text || '')
    .replace(/\b(?:nel|nei)\s+(?:prossimo|successivi?)\s+capitol[oi][^.\n]*[.\n]/gi, ' ')
    .replace(/\bin\s+questo\s+capitolo\s+(?:si\s+è\s+visto|si\s+è\s+mostrato|è\s+emerso)[^.\n]*[.\n]/gi, ' ')
    .replace(/\bcome\s+emerso\s+nel\s+(?:presente|precedente)\s+capitol[oi][^.\n]*[.\n]/gi, ' ');
}

function normalizeAcademicParagraphs(text) {
  const protectedText = String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = protectedText.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (/^Capitolo\s+\d+/i.test(line) || /^\d+\.\d+\s+/.test(line)) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(line);
      out.push('');
      continue;
    }
    if (out.length && out[out.length - 1] && !/[:;]$/.test(out[out.length - 1])) {
      out[out.length - 1] = `${out[out.length - 1]} ${line}`.replace(/\s+/g, ' ').trim();
    } else {
      out.push(line);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function endsSuspiciously(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  if (/[,:;(\-–—]$/.test(trimmed)) return true;
  if (/\b(e|ed|o|oppure|ma|perché|poiché|mentre|come|con|di|da|in|a|su|tra|fra|per)\s*$/i.test(trimmed)) return true;
  if (!/[.!?]$/.test(trimmed) && countWords(trimmed) > 120) return true;
  return false;
}

function buildProviderPrompt(task, input) {
  if (typeof input === 'string') return clip(input, 30000);
  const obj = input && typeof input === 'object' ? input : {};
  const sections = [];
  sections.push(`TASK: ${task}`);
  if (obj.prompt) sections.push(`RICHIESTA\n${clip(String(obj.prompt), 12000)}`);
  if (obj.theme) sections.push(`ARGOMENTO\n${clip(String(obj.theme), 1200)}`);
  if (obj.faculty || obj.degreeCourse || obj.degreeType) {
    sections.push(
      `CONTESTO ACCADEMICO\nFacoltà: ${clip(String(obj.faculty || ''), 300)}\nCorso: ${clip(String(obj.degreeCourse || ''), 400)}\nTipo laurea: ${clip(String(obj.degreeType || ''), 120)}\nMetodologia: ${clip(String(obj.methodology || ''), 120)}`
    );
  }
  if (obj.approvedOutline) sections.push(`INDICE APPROVATO\n${clip(String(obj.approvedOutline), 5000)}`);
  if (obj.approvedAbstract) sections.push(`ABSTRACT APPROVATO\n${clip(String(obj.approvedAbstract), 2200)}`);
  if (Array.isArray(obj.chapterTitles) && obj.chapterTitles.length) sections.push(`TITOLI CAPITOLI\n${clip(obj.chapterTitles.join('\n'), 1800)}`);
  if (obj.currentChapterTitle || Number.isFinite(obj.currentChapterIndex)) {
    sections.push(`CAPITOLO CORRENTE\nIndice: ${Number(obj.currentChapterIndex || 0) + 1}\nTitolo: ${clip(String(obj.currentChapterTitle || ''), 500)}`);
  }
  if (obj.previousChapters) sections.push(`CAPITOLI PRECEDENTI (SINTESI)\n${clip(String(obj.previousChapters), 2000)}`);
  if (Array.isArray(obj.approvedChapters) && obj.approvedChapters.length) {
    const compact = obj.approvedChapters
      .slice(-2)
      .map((ch, i) => `Capitolo ${i + 1}: ${(ch && ch.title) || ''}\n${clip(String(ch?.content || ''), 700)}`)
      .join('\n\n');
    sections.push(`CAPITOLI APPROVATI (ESTRATTO)\n${clip(compact, 1800)}`);
  }
  if (obj.facultyGuidance) sections.push(`GUIDA FACOLTÀ\n${clip(String(obj.facultyGuidance), 1800)}`);
  if (obj.constraints) sections.push(`VINCOLI\n${clip(JSON.stringify(obj.constraints, null, 2), 1200)}`);
  return sections.join('\n\n');
}

function buildSystemPrompt(task, input) {
  const base = [
    'Scrivi in italiano accademico, chiaro, formale e coerente.',
    'Non inventare fonti, dati empirici, citazioni puntuali o risultati non verificabili.',
    'Evita tono giornalistico, slogan, elenchi inutili e formule artificiali di raccordo.',
    'Mantieni continuità logica, rigore terminologico e pertinenza disciplinare.',
    'Non aggiungere markup markdown o asterischi.',
    'Chiudi sempre i paragrafi e le sezioni in modo compiuto.'
  ];
  if (task === 'outline_draft') {
    base.push('Genera un indice universitario plausibile, ben strutturato, con capitoli e sottosezioni coerenti con il tema e la metodologia.');
  } else if (task === 'abstract_draft') {
    base.push('Produci un abstract accademico sintetico, credibile e coerente con una tesi universitaria.');
  } else {
    base.push('Produci testo di capitolo o revisione teorica sostanziale, con forte coerenza interna e struttura naturale.');
    base.push('Se l’input contiene osservazioni del relatore, applicale davvero in modo riconoscibile e non cosmetico.');
  }
  if (input && typeof input === 'object' && input.facultyGuidance) {
    base.push(`Tieni conto anche di questa guida di facoltà: ${clip(String(input.facultyGuidance), 1200)}`);
  }
  return base.join(' ');
}

function shrinkPrompt(prompt) {
  return clip(String(prompt || ''), 12000);
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
        'content-type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        system,
        max_tokens: maxTokens,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }]
      })
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
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ]
      })
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
    statusCode: err?.statusCode || 500
  };
  if (payload.code === 'provider_timeout') payload.statusCode = 504;
  return payload;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
