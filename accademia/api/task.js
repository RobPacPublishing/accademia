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
  const sanitized = sanitizeChapterDraftInput(input);
  const context = parseChapterContext(sanitized);
  const system = buildSystemPrompt('chapter_draft', sanitized);

  if (!context.subsections.length) {
    const prompt = buildWholeChapterPrompt(sanitized, context);
    const raw = await generateChapterFastText({ system, prompt, maxTokens: 2200 });
    let chapterText = postProcessChapterText(raw, context);
    if (countWords(chapterText) < 1800 || isSuspiciousEnding(chapterText)) {
      const extra = await safeGenerateChapterContinuation({
        system,
        prompt: buildChapterFinalContinuationPrompt(sanitized, context, chapterText),
        maxTokens: 650,
      });
      if (extra) {
        chapterText = postProcessChapterText(`${chapterText}\n\n${stripDuplicateIntro(extra, context.chapterHeading)}`, context);
      }
    }
    return chapterText;
  }

  const sectionPromises = context.subsections.map((subsection, index) =>
    generateChapterSubsectionRobust(sanitized, context, subsection, index, context.subsections.length, system)
  );

  const settled = await Promise.allSettled(sectionPromises);
  const sections = settled.map((item, index) => {
    if (item.status === 'fulfilled' && item.value) return item.value;
    return buildSectionFallback(context.subsections[index]);
  });

  let chapterText = postProcessChapterText(
    `${context.chapterHeading}\n\n${sections.join('\n\n')}`,
    context
  );

  if (countWords(chapterText) < context.chapterTargetWords * 0.82 || isSuspiciousEnding(chapterText)) {
    const extra = await safeGenerateChapterContinuation({
      system,
      prompt: buildChapterFinalContinuationPrompt(sanitized, context, chapterText),
      maxTokens: 700,
    });
    if (extra) {
      chapterText = postProcessChapterText(`${chapterText}\n\n${stripDuplicateIntro(extra, context.chapterHeading)}`, context);
    }
  }

  return chapterText;
}

function sanitizeChapterDraftInput(input) {
  const obj = input && typeof input === 'object' ? { ...input } : {};
  obj.previousChaptersText = extractPreviousChaptersText(obj.previousChapters);
  obj.approvedChaptersText = extractApprovedChaptersText(obj.approvedChapters);
  return obj;
}

async function generateChapterSubsectionRobust(input, context, subsection, index, total, system) {
  const targetWords = getSubsectionTargetWords(context);
  let sectionText = '';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prompt = attempt === 0
      ? buildChapterSubsectionPrompt(input, context, subsection, index, total)
      : buildChapterSubsectionContinuationPrompt(input, context, subsection, sectionText, attempt);

    const maxTokens = attempt === 0 ? 1100 : 520;
    const raw = await generateChapterFastText({ system, prompt, maxTokens });
    const nextChunk = postProcessChapterSectionText(raw, subsection, attempt > 0);

    sectionText = attempt === 0
      ? nextChunk
      : mergeSectionContinuation(sectionText, nextChunk, subsection);

    const enoughWords = countWords(sectionText) >= targetWords * 0.78;
    if (enoughWords && !isSuspiciousEnding(sectionText)) break;
  }

  return sectionText;
}

async function generateChapterFastText({ system, prompt, maxTokens }) {
  const attempts = [];
  if (OPENAI_API_KEY) {
    attempts.push(() => callOpenAI({
      model: OPENAI_MODEL,
      system,
      prompt: shrinkPrompt(prompt),
      maxTokens: Math.min(maxTokens, 1400),
      timeoutMs: 18_000,
    }));
  }
  if (ANTHROPIC_API_KEY) {
    attempts.push(() => callAnthropic({
      model: ANTHROPIC_FALLBACK_MODEL,
      system,
      prompt: shrinkPrompt(prompt),
      maxTokens: Math.min(maxTokens, 1400),
      timeoutMs: 18_000,
    }));
    attempts.push(() => callAnthropic({
      model: ANTHROPIC_PRIMARY_MODEL,
      system,
      prompt: shrinkPrompt(prompt),
      maxTokens: Math.min(maxTokens, 1500),
      timeoutMs: 24_000,
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
        /rate limit|overloaded|temporarily unavailable|bad request|invalid/i.test(String(err?.message || ''));
      if (!recoverable) break;
    }
  }

  throw lastError || new Error('Generazione capitolo non riuscita');
}

async function safeGenerateChapterContinuation({ system, prompt, maxTokens }) {
  try {
    return await generateChapterFastText({ system, prompt, maxTokens });
  } catch (_) {
    return '';
  }
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
    const chapterMatch = line.match(/^(?:capitolo\s+)?(\d+)\s*[—\-:]?\s*(.*)$/i);
    if (chapterMatch && /capitolo/i.test(line)) {
      const n = Number(chapterMatch[1]);
      if (n === currentChapterNumber) {
        inside = true;
        chapterHeading = line;
        continue;
      }
      if (inside && n !== currentChapterNumber) break;
    }

    if (!inside) continue;
    const subsectionMatch = line.match(/^(\d+\.\d+)\s+(.+)$/);
    if (subsectionMatch && Number(subsectionMatch[1].split('.')[0]) === currentChapterNumber) {
      subsections.push({ code: subsectionMatch[1], title: subsectionMatch[2].trim() });
    }
  }

  return {
    currentChapterIndex,
    currentChapterNumber,
    chapterHeading: normalizeChapterHeading(chapterHeading, currentChapterNumber),
    subsections,
    chapterTargetWords: getChapterTargetWords(obj, subsections.length),
  };
}

function normalizeChapterHeading(value, n) {
  const cleaned = normalizeOutlineLine(value || '').replace(/^\.\s*/, '').trim();
  if (/^capitolo\s+\d+/i.test(cleaned)) return cleaned;
  if (cleaned) return `Capitolo ${n} — ${cleaned}`;
  return `Capitolo ${n}`;
}

function normalizeOutlineLine(line) {
  return String(line || '')
    .replace(/^#+\s*/, '')
    .replace(/^[-–—*•]+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/__+/g, '')
    .trim();
}

function buildWholeChapterPrompt(input, context) {
  const obj = input && typeof input === 'object' ? input : {};
  const subsectionList = context.subsections.map((x) => `${x.code} ${x.title}`).join('\n');
  return [
    'TASK: chapter_draft',
    `SVILUPPA IL CAPITOLO: ${context.chapterHeading}`,
    `OBIETTIVO INDICATIVO: circa ${context.chapterTargetWords} parole.`,
    'REGOLE OBBLIGATORIE:',
    `- Inizia con l\'intestazione esatta del capitolo: ${context.chapterHeading}`,
    '- Mantieni tono accademico, formale, chiaro e continuo.',
    '- Non usare markdown, asterischi, elenchi puntati o formule scolastiche.',
    '- Non annunciare il capitolo successivo e non commentare artificialmente il capitolo appena scritto.',
    subsectionList ? `SOTTOSEZIONI DA INCLUDERE\n${subsectionList}` : '',
    obj.theme ? `ARGOMENTO\n${clip(String(obj.theme), 900)}` : '',
    buildAcademicContextBlock(obj),
    obj.approvedAbstract ? `ABSTRACT APPROVATO\n${clip(String(obj.approvedAbstract), 1200)}` : '',
    obj.previousChaptersText ? `CAPITOLI PRECEDENTI (SINTESI)\n${clip(obj.previousChaptersText, 1400)}` : '',
  ].filter(Boolean).join('\n\n');
}

function buildChapterSubsectionPrompt(input, context, subsection, index, total) {
  const obj = input && typeof input === 'object' ? input : {};
  const subsectionTargetWords = getSubsectionTargetWords(context);
  const subsectionPlan = context.subsections.map((x) => `${x.code} ${x.title}`).join('\n');
  return [
    'TASK: chapter_draft_section',
    `SVILUPPA SOLO QUESTA SOTTOSEZIONE: ${subsection.code} ${subsection.title}`,
    `CAPITOLO DI RIFERIMENTO: ${context.chapterHeading}`,
    `POSIZIONE: ${index + 1} di ${total}`,
    `LUNGHEZZA INDICATIVA: circa ${subsectionTargetWords} parole.`,
    'REGOLE OBBLIGATORIE:',
    `- Inizia esattamente con: ${subsection.code} ${subsection.title}`,
    '- Produci solo la sottosezione richiesta, senza introdurre quelle successive.',
    '- Non usare markdown, asterischi, elenchi puntati o conclusioni artificiali.',
    '- Chiudi con una frase completa e compiuta.',
    obj.theme ? `ARGOMENTO DELLA TESI\n${clip(String(obj.theme), 800)}` : '',
    buildAcademicContextBlock(obj),
    `PIANO DEL CAPITOLO\n${subsectionPlan}`,
    obj.approvedAbstract ? `ABSTRACT APPROVATO\n${clip(String(obj.approvedAbstract), 900)}` : '',
    obj.previousChaptersText ? `CAPITOLI PRECEDENTI (SINTESI)\n${clip(obj.previousChaptersText, 1100)}` : '',
  ].filter(Boolean).join('\n\n');
}

function buildChapterSubsectionContinuationPrompt(input, context, subsection, currentText, pass) {
  return [
    'TASK: chapter_draft_section_continuation',
    `PROSEGUI LA STESSA SOTTOSEZIONE: ${subsection.code} ${subsection.title}`,
    `CAPITOLO: ${context.chapterHeading}`,
    `PASSAGGIO DI COMPLETAMENTO: ${pass}`,
    'REGOLE OBBLIGATORIE:',
    '- Non ripetere il titolo della sottosezione.',
    '- Continua dal punto raggiunto, senza ripartenze e senza riepiloghi.',
    '- Mantieni lo stesso registro accademico.',
    '- Concludi con frase completa e senza anticipare il capitolo successivo.',
    `TESTO GIÀ SCRITTO\n${clip(currentText, 1800)}`,
  ].join('\n\n');
}

function buildChapterFinalContinuationPrompt(input, context, chapterText) {
  const lastSub = context.subsections[context.subsections.length - 1];
  return [
    'TASK: chapter_draft_final_continuation',
    `COMPLETA IL CAPITOLO: ${context.chapterHeading}`,
    lastSub ? `FOCALIZZATI SOPRATTUTTO SULLA CHIUSURA DI: ${lastSub.code} ${lastSub.title}` : '',
    'REGOLE OBBLIGATORIE:',
    '- Non riscrivere l’inizio del capitolo.',
    '- Aggiungi solo la parte mancante finale.',
    '- Non introdurre il capitolo successivo.',
    '- Chiudi con un paragrafo completo e naturale.',
    `TESTO ATTUALE DEL CAPITOLO\n${clip(chapterText, 2600)}`,
  ].filter(Boolean).join('\n\n');
}

function buildAcademicContextBlock(obj) {
  if (!(obj.faculty || obj.degreeCourse || obj.degreeType || obj.methodology)) return '';
  return [
    'CONTESTO ACCADEMICO',
    `Facoltà: ${clip(String(obj.faculty || ''), 220)}`,
    `Corso: ${clip(String(obj.degreeCourse || ''), 260)}`,
    `Tipo laurea: ${clip(String(obj.degreeType || ''), 120)}`,
    `Metodologia: ${clip(String(obj.methodology || ''), 120)}`,
  ].join('\n');
}

function extractPreviousChaptersText(value) {
  if (!value) return '';
  if (typeof value === 'string') return clip(value, 1800);
  if (!Array.isArray(value)) return '';
  return value
    .filter((item) => item && (item.summary || item.content || item.title))
    .slice(0, 3)
    .map((item, idx) => {
      const title = String(item.title || `Capitolo ${idx + 1}`).trim();
      const summary = clip(String(item.summary || item.content || '').replace(/\s+/g, ' ').trim(), 450);
      return `${title}: ${summary}`;
    })
    .filter(Boolean)
    .join('\n');
}

function extractApprovedChaptersText(value) {
  if (!Array.isArray(value)) return '';
  return value
    .map((flag, idx) => (flag ? `Capitolo ${idx + 1} approvato` : ''))
    .filter(Boolean)
    .slice(0, 6)
    .join('; ');
}

function getChapterTargetWords(obj, subsectionCount) {
  const explicit = Number(obj?.constraints?.minWordsChapter || obj?.minWordsChapter || obj?.targetWords || 0);
  if (Number.isFinite(explicit) && explicit >= 1800) return explicit;
  const degree = String(obj?.degreeType || '').toLowerCase();
  const base = /magistrale|ciclo unico|master/.test(degree) ? 4200 : 3200;
  return Math.max(base, Math.max(1, subsectionCount || 4) * 800);
}

function getSubsectionTargetWords(context) {
  const count = Math.max(1, context.subsections.length || 1);
  return Math.max(650, Math.round(context.chapterTargetWords / count));
}

function countWords(text) {
  return cleanModelText(text).split(/\s+/).filter(Boolean).length;
}

function isSuspiciousEnding(text) {
  const cleaned = cleanModelText(text).trim();
  if (!cleaned) return true;
  if (/[,:;(\-–—]\s*$/.test(cleaned)) return true;
  if (/\b(e|ed|o|oppure|ma|che|di|del|della|dei|degli|delle|per|con|tra|fra|come|mentre|non|nel|nella|nelle|negli|sul|sulla|sui|sugli)\s*$/i.test(cleaned)) return true;
  if (countWords(cleaned) > 80 && !/[.!?)]$/.test(cleaned)) return true;
  return false;
}

function stripDuplicateIntro(text, heading) {
  return cleanModelText(text)
    .replace(new RegExp(`^${escapeRegExp(normalizeOutlineLine(heading))}\\s*`, 'i'), '')
    .trim();
}

function mergeSectionContinuation(existing, continuation, subsection) {
  const heading = `${subsection.code} ${subsection.title}`;
  const tail = cleanModelText(continuation)
    .replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, 'i'), '')
    .trim();
  return cleanModelText(`${existing}\n\n${tail}`);
}

function buildSectionFallback(subsection) {
  return `${subsection.code} ${subsection.title}\n\nQuesta sottosezione richiede una nuova generazione, poiché il completamento automatico non è riuscito a restituire un testo sufficientemente stabile.`;
}

function postProcessChapterSectionText(text, subsection, isContinuation = false) {
  let cleaned = cleanModelText(text)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const heading = `${subsection.code} ${subsection.title}`;
  if (!isContinuation) {
    cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, 'i'), '').trim();
    cleaned = `${heading}\n\n${cleaned}`.trim();
  } else {
    cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, 'i'), '').trim();
  }
  return cleaned;
}

function postProcessChapterText(text, context) {
  let cleaned = cleanModelText(text)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const chapterHeading = normalizeChapterHeading(context.chapterHeading || `Capitolo ${context.currentChapterNumber}`, context.currentChapterNumber);
  cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(chapterHeading)}\\s*`, 'i'), '').trim();
  return `${chapterHeading}\n\n${cleaned}`.trim();
}

function escapeRegExp(value) {
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
