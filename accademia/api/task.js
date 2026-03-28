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
  const context = parseChapterContext(input);
  const system = buildSystemPrompt('chapter_draft', input);
  const targetWords = resolveChapterTargetWords(input, context);

  if (!context.subsections.length) {
    const prompt = buildChapterFallbackPrompt(input, context, targetWords);
    let raw = await generateWithProviders({
      prompt,
      system,
      maxTokens: wordsToMaxTokens(targetWords),
      primaryTimeoutMs: 60_000,
      fallbackTimeoutMs: 45_000,
      openaiTimeoutMs: 50_000,
    });
    let chapterText = postProcessChapterText(raw, context);
    chapterText = await completeChapterIfNeeded({ input, context, system, targetWords, sectionTargetWords: 0, chapterText });
    return chapterText;
  }

  const sectionTargetWords = resolveSubsectionTargetWords(targetWords, context.subsections.length, input);
  const parts = [];

  for (let i = 0; i < context.subsections.length; i += 1) {
    const subsection = context.subsections[i];
    const nextSubsection = context.subsections[i + 1] || null;
    const prompt = buildChapterSubsectionPrompt(input, context, subsection, i, context.subsections.length, sectionTargetWords);
    let raw = await generateWithProviders({
      prompt,
      system,
      maxTokens: wordsToMaxTokens(sectionTargetWords),
      primaryTimeoutMs: 60_000,
      fallbackTimeoutMs: 45_000,
      openaiTimeoutMs: 50_000,
    });

    let sectionText = postProcessChapterSectionText(raw, subsection, nextSubsection);
    if (countWords(sectionText) < Math.max(520, Math.floor(sectionTargetWords * 0.78))) {
      const retryPrompt = buildChapterSubsectionRetryPrompt(input, context, subsection, i, context.subsections.length, Math.max(sectionTargetWords + 120, 920), sectionText);
      raw = await generateWithProviders({
        prompt: retryPrompt,
        system,
        maxTokens: wordsToMaxTokens(Math.max(sectionTargetWords + 180, 980)),
        primaryTimeoutMs: 60_000,
        fallbackTimeoutMs: 45_000,
        openaiTimeoutMs: 50_000,
      });
      sectionText = postProcessChapterSectionText(raw, subsection, nextSubsection);
    }

    sectionText = await completeSubsectionIfNeeded({
      input,
      context,
      subsection,
      nextSubsection,
      index: i,
      total: context.subsections.length,
      system,
      targetWords: sectionTargetWords,
      sectionText,
    });

    parts.push(sectionText);
  }

  let finalParts = [...parts];
  let chapterText = postProcessChapterText(`${context.chapterHeading}

${finalParts.join('\n\n')}`, context);
  if (countWords(chapterText) < Math.max(1400, Math.floor(targetWords * 0.86))) {
    const expandedParts = [];
    for (let i = 0; i < finalParts.length; i += 1) {
      const subsection = context.subsections[i];
      const nextSubsection = context.subsections[i + 1] || null;
      let sectionText = finalParts[i];
      const diagnostics = inspectSubsectionCompletion(sectionText, subsection, sectionTargetWords);
      if (countWords(sectionText) < Math.max(620, Math.floor(sectionTargetWords * 0.9)) || diagnostics.suspiciousEnding) {
        const expandPrompt = buildChapterSubsectionRetryPrompt(input, context, subsection, i, context.subsections.length, Math.max(sectionTargetWords + 180, 980), sectionText);
        const expandedRaw = await generateWithProviders({
          prompt: expandPrompt,
          system,
          maxTokens: wordsToMaxTokens(Math.max(sectionTargetWords + 260, 1100)),
          primaryTimeoutMs: 60_000,
          fallbackTimeoutMs: 45_000,
          openaiTimeoutMs: 50_000,
        });
        sectionText = postProcessChapterSectionText(expandedRaw, subsection, nextSubsection);
        sectionText = await completeSubsectionIfNeeded({
          input,
          context,
          subsection,
          nextSubsection,
          index: i,
          total: context.subsections.length,
          system,
          targetWords: Math.max(sectionTargetWords, 980),
          sectionText,
        });
      }
      expandedParts.push(sectionText);
    }
    finalParts = expandedParts;
    chapterText = postProcessChapterText(`${context.chapterHeading}

${finalParts.join('\n\n')}`, context);
  }

  chapterText = await completeChapterIfNeeded({ input, context, system, targetWords, sectionTargetWords, chapterText });
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

  const currentTitleRaw = String(obj.currentChapterTitle || '').trim();
  let chapterHeading = currentTitleRaw || `Capitolo ${currentChapterNumber}`;
  let inside = false;
  const subsections = [];
  const fallbackSubsections = [];

  for (const line of normalizedLines) {
    const chapterMatch = line.match(/^(?:capitolo\s+)?(\d+)\s*[—\-:–]?\s*(.*)$/i);
    if (chapterMatch) {
      const n = Number(chapterMatch[1]);
      const looksLikeChapterHeading = /capitolo/i.test(line) || !/^\d+\.\d+/.test(line);
      if (looksLikeChapterHeading) {
        if (n === currentChapterNumber) {
          inside = true;
          chapterHeading = /^capitolo\s+/i.test(line)
            ? line
            : `Capitolo ${currentChapterNumber}${chapterMatch[2] ? ' — ' + chapterMatch[2].trim() : ''}`;
          continue;
        }
        if (inside && n !== currentChapterNumber) break;
      }
    }

    const subsectionMatch = line.match(/^(\d+\.\d+)\s*[—\-:–]?\s*(.+)$/);
    if (!subsectionMatch) continue;
    const sectionChapterNumber = Number(subsectionMatch[1].split('.')[0]);
    if (sectionChapterNumber !== currentChapterNumber) continue;

    const item = { code: subsectionMatch[1], title: subsectionMatch[2].trim() };
    if (inside) subsections.push(item);
    fallbackSubsections.push(item);
  }

  const mergedSubsections = uniqueSubsections(subsections.length ? subsections : fallbackSubsections);

  if (!/^capitolo\s+/i.test(chapterHeading)) {
    const cleanedTitle = chapterHeading.replace(/^\d+\s*[—\-:–]?\s*/, '').trim();
    chapterHeading = cleanedTitle
      ? `Capitolo ${currentChapterNumber} — ${cleanedTitle}`
      : `Capitolo ${currentChapterNumber}`;
  }

  chapterHeading = cleanChapterHeading(chapterHeading, currentChapterNumber);

  return {
    currentChapterIndex,
    currentChapterNumber,
    chapterHeading,
    chapterCount: countDistinctChapters(normalizedLines),
    subsections: mergedSubsections,
  };
}

function normalizeOutlineLine(line) {
  return String(line || '')
    .replace(/^#+\s*/, '')
    .replace(/^[-–—*]+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/__+/g, '')
    .replace(/\t+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueSubsections(items) {
  const map = new Map();
  for (const item of items || []) {
    const code = String(item?.code || '').trim();
    const title = String(item?.title || '').trim();
    if (!code || !title) continue;
    if (!map.has(code)) map.set(code, { code, title });
  }
  return Array.from(map.values()).sort((a, b) => compareSectionCodes(a.code, b.code));
}

function compareSectionCodes(a, b) {
  const aa = String(a || '').split('.').map((n) => Number(n) || 0);
  const bb = String(b || '').split('.').map((n) => Number(n) || 0);
  return (aa[0] - bb[0]) || (aa[1] - bb[1]);
}

function resolveChapterTargetWords(input, context) {
  const explicit = Number(input?.constraints?.minWordsChapter || input?.minWordsChapter || input?.targetWords);
  if (Number.isFinite(explicit) && explicit >= 1200) return Math.floor(explicit);

  const degree = normalizeDegreeType(input?.degreeType);
  const chapterCount = Math.max(1, context.chapterCount || 0);
  const subsectionCount = Math.max(1, context.subsections.length || 0);
  const base = degree === 'magistrale' ? 5200 : 3600;
  const perSubsection = degree === 'magistrale' ? 1200 : 900;
  let target = Math.max(base, subsectionCount * perSubsection);

  if (chapterCount >= 6) target -= degree === 'magistrale' ? 400 : 250;
  if (chapterCount <= 3) target += degree === 'magistrale' ? 600 : 350;

  return Math.max(degree === 'magistrale' ? 4200 : 3200, target);
}

function resolveSubsectionTargetWords(totalWords, subsectionCount, input) {
  const degree = normalizeDegreeType(input?.degreeType);
  if (!subsectionCount) return Math.max(degree === 'magistrale' ? 1400 : 1100, totalWords);
  const floorValue = degree === 'magistrale' ? 1050 : 850;
  return Math.max(floorValue, Math.floor(totalWords / subsectionCount));
}

function wordsToMaxTokens(words) {
  const safeWords = Math.max(300, Number(words) || 0);
  return Math.min(5200, Math.max(1500, Math.ceil(safeWords * 1.95)));
}

function countWords(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean).length;
}

function normalizeDegreeType(value) {
  const v = String(value || '').toLowerCase();
  if (/magistr|specialistic|master|lm\b/.test(v)) return 'magistrale';
  return 'triennale';
}

function countDistinctChapters(lines) {
  const set = new Set();
  for (const line of lines || []) {
    const match = String(line || '').match(/^(?:capitolo\s+)?(\d+)\s*[—\-:–]?\s*(.*)$/i);
    if (!match) continue;
    if (/^\d+\.\d+/.test(String(line || ''))) continue;
    set.add(Number(match[1]));
  }
  return set.size;
}

async function completeChapterIfNeeded({ input, context, system, targetWords, sectionTargetWords, chapterText }) {
  let current = postProcessChapterText(chapterText, context);
  const maxPasses = 2;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const diagnostics = inspectChapterCompletion(current, context, targetWords, sectionTargetWords);
    if (!diagnostics.needsCompletion) return current;

    const completionPrompt = buildChapterCompletionPrompt(input, context, targetWords, diagnostics, current, pass);
    const completionRaw = await generateWithProviders({
      prompt: completionPrompt,
      system,
      maxTokens: wordsToMaxTokens(Math.max(900, diagnostics.missingWords)),
      primaryTimeoutMs: 60_000,
      fallbackTimeoutMs: 45_000,
      openaiTimeoutMs: 50_000,
    });

    const merged = mergeChapterContinuation(current, completionRaw, diagnostics);
    const normalized = postProcessChapterText(merged, context);
    if (normalized === current) break;
    current = normalized;
  }

  return current;
}

function inspectChapterCompletion(chapterText, context, targetWords, sectionTargetWords) {
  const text = String(chapterText || '');
  const words = countWords(text);
  const missingHeadings = [];
  const thinSections = [];
  const suspiciousSections = [];

  for (let i = 0; i < (context.subsections || []).length; i += 1) {
    const subsection = context.subsections[i];
    const next = context.subsections[i + 1] || null;
    const block = extractSubsectionBlock(text, subsection, next);
    if (!block) {
      missingHeadings.push(subsection);
      continue;
    }
    const sectionDiagnostics = inspectSubsectionCompletion(block, subsection, sectionTargetWords || 0);
    if (sectionDiagnostics.tooShort) thinSections.push(subsection);
    if (sectionDiagnostics.suspiciousEnding) suspiciousSections.push(subsection);
  }

  const missingWords = Math.max(0, targetWords - words);
  const needsCompletion = missingHeadings.length > 0 || suspiciousSections.length > 0 || thinSections.length > 0 || words < Math.floor(targetWords * 0.9);

  return {
    needsCompletion,
    words,
    missingWords,
    missingHeadings,
    thinSections,
    suspiciousSections,
  };
}

function extractSubsectionBlock(chapterText, subsection, nextSubsection) {
  const text = String(chapterText || '');
  const heading = `${subsection.code} ${subsection.title}`;
  const headingRegex = new RegExp(`(^|\\n)${escapeRegExp(heading)}(?=\\n|$)`, 'i');
  const match = headingRegex.exec(text);
  if (!match || typeof match.index !== 'number') return '';
  const start = match.index + (match[1] ? match[1].length : 0);
  let end = text.length;
  if (nextSubsection) {
    const nextHeading = `${nextSubsection.code} ${nextSubsection.title}`;
    const nextRegex = new RegExp(`(^|\\n)${escapeRegExp(nextHeading)}(?=\\n|$)`, 'i');
    const tail = text.slice(start + heading.length);
    const nextMatch = nextRegex.exec(tail);
    if (nextMatch && typeof nextMatch.index === 'number') {
      end = start + heading.length + nextMatch.index;
    }
  }
  return text.slice(start, end).trim();
}

function inspectSubsectionCompletion(sectionText, subsection, targetWords) {
  const text = String(sectionText || '').trim();
  const heading = `${subsection.code} ${subsection.title}`;
  const body = text.replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, 'i'), '').trim();
  const words = countWords(body);
  return {
    words,
    tooShort: words < Math.max(520, Math.floor((targetWords || 800) * 0.78)),
    suspiciousEnding: hasLikelyTruncatedEnding(body),
  };
}

function hasLikelyTruncatedEnding(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/[,:;\-–—(]$/.test(t)) return true;
  if (!/[.!?)]$/.test(t)) return true;
  const tail = t.split(/\s+/).slice(-5).join(' ').toLowerCase();
  if (/\b(e|ed|o|od|oppure|ma|mentre|come|con|per|tra|fra|nei|nelle|negli|degli|delle|dei|del|della|dello|degli|degli|sui|sulle|sul|sulla)\s*$/.test(tail)) return true;
  if (/\b(in particolare|ad esempio|quali|come ad esempio)\s*[.:;,-]?$/i.test(t)) return true;
  return false;
}

function buildChapterCompletionPrompt(input, context, targetWords, diagnostics, currentText, pass) {
  return [
    buildChapterFallbackPrompt(input, context, targetWords),
    `PASSAGGIO DI COMPLETAMENTO CAPITOLO: ${pass + 1}`,
    diagnostics.missingHeadings.length ? `SOTTOSEZIONI MANCANTI O DA RECUPERARE:\n${diagnostics.missingHeadings.map((s) => `${s.code} ${s.title}`).join('\n')}` : '',
    diagnostics.thinSections.length ? `SOTTOSEZIONI TROPPO DEBOLI DA RINFORZARE:\n${diagnostics.thinSections.map((s) => `${s.code} ${s.title}`).join('\n')}` : '',
    diagnostics.suspiciousSections.length ? `SOTTOSEZIONI CON CHIUSURA SOSPETTA O TRONCA:\n${diagnostics.suspiciousSections.map((s) => `${s.code} ${s.title}`).join('\n')}` : '',
    `TESTO ATTUALE DEL CAPITOLO:\n${clip(currentText, 12000)}`,
    'REGOLE OBBLIGATORIE:',
    '- Restituisci solo il testo mancante o integrativo necessario a completare il capitolo.',
    '- Non ricominciare da capo il capitolo.',
    '- Se una sottosezione è tronca, riprendi da lì e chiudila con frasi complete.',
    '- Non inserire frasi di raccordo artificiale sul capitolo successivo o sul capitolo appena svolto.',
    '- Non usare markdown, non usare asterischi, non usare elenchi puntati.',
  ].filter(Boolean).join('\n\n');
}

function mergeChapterContinuation(existingText, continuationText, diagnostics) {
  const existing = String(existingText || '').trim();
  let continuation = cleanModelText(continuationText)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*[-–—*]\s+/gm, '')
    .trim();

  if (!continuation) return existing;

  const duplicateHeadingRegex = /^(Capitolo\s+\d+\s*[—\-:–]?.*)$/i;
  continuation = continuation.replace(duplicateHeadingRegex, '').trim();

  return normalizeChapterLayout(stripArtificialTransitions(`${existing}\n\n${continuation}`));
}

async function completeSubsectionIfNeeded({ input, context, subsection, nextSubsection, index, total, system, targetWords, sectionText }) {
  let current = postProcessChapterSectionText(sectionText, subsection, nextSubsection);
  const maxPasses = 2;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const diagnostics = inspectSubsectionCompletion(current, subsection, targetWords);
    if (!diagnostics.tooShort && !diagnostics.suspiciousEnding) return current;

    const continuationPrompt = buildSubsectionContinuationPrompt(input, context, subsection, index, total, targetWords, current, diagnostics, pass);
    const continuationRaw = await generateWithProviders({
      prompt: continuationPrompt,
      system,
      maxTokens: wordsToMaxTokens(Math.max(700, targetWords - diagnostics.words)),
      primaryTimeoutMs: 60_000,
      fallbackTimeoutMs: 45_000,
      openaiTimeoutMs: 50_000,
    });

    const merged = mergeSectionContinuation(current, continuationRaw, subsection, nextSubsection);
    const normalized = postProcessChapterSectionText(merged, subsection, nextSubsection);
    if (normalized === current) break;
    current = normalized;
  }

  return current;
}

function buildSubsectionContinuationPrompt(input, context, subsection, index, total, targetWords, currentText, diagnostics, pass) {
  return [
    buildChapterSubsectionPrompt(input, context, subsection, index, total, Math.max(targetWords, 900)),
    `PASSAGGIO DI COMPLETAMENTO SOTTOSEZIONE: ${pass + 1}`,
    `TESTO ATTUALE DELLA SOTTOSEZIONE:\n${clip(currentText, 9000)}`,
    diagnostics?.suspiciousEnding ? 'ATTENZIONE: la sottosezione attuale sembra chiudersi in modo troncato o sospetto.' : '',
    'REGOLE OBBLIGATORIE:',
    '- Restituisci solo la prosecuzione mancante di questa stessa sottosezione.',
    '- Non riscrivere l’intestazione se è già presente.',
    '- Non iniziare la sottosezione successiva e non inserire altre numerazioni.',
    '- Non usare markdown, non usare asterischi, non usare elenchi puntati.',
    '- Chiudi con una frase completa, non tronca.',
    '- Non inserire annunci del capitolo successivo o commenti metadiscorsivi sul capitolo appena svolto.',
  ].filter(Boolean).join('\n\n');
}

function mergeSectionContinuation(existingText, continuationText, subsection, nextSubsection) {
  const existing = String(existingText || '').trim();
  let continuation = cleanModelText(continuationText)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*[-–—*]\s+/gm, '')
    .trim();

  const currentHeading = `${subsection.code} ${subsection.title}`;
  continuation = continuation.replace(new RegExp(`^${escapeRegExp(currentHeading)}\\s*`, 'i'), '').trim();

  if (nextSubsection) {
    const nextHeading = `${nextSubsection.code} ${nextSubsection.title}`;
    const nextRegex = new RegExp(`(^|\\n)${escapeRegExp(nextHeading)}(?=\\n|$)`, 'i');
    const match = continuation.match(nextRegex);
    if (match && typeof match.index === 'number') {
      continuation = continuation.slice(0, match.index).trim();
    }
  }

  if (!continuation) return existing;
  return normalizeChapterLayout(stripArtificialTransitions(`${existing}\n\n${continuation}`));
}

function buildChapterFallbackPrompt(input, context, targetWords) {
  const basePrompt = buildProviderPrompt('chapter_draft', input);
  return [
    basePrompt,
    `OBIETTIVO DI LUNGHEZZA: almeno ${targetWords} parole complessive.`,
    `CAPITOLO DA SVILUPPARE: ${context.chapterHeading}`,
    context.subsections.length
      ? `SOTTOSEZIONI DA INCLUDERE OBBLIGATORIAMENTE:\n${context.subsections.map((s) => `${s.code} ${s.title}`).join('\n')}`
      : '',
    'REGOLE OBBLIGATORIE:',
    '- Mantieni il capitolo completo e non troncarlo.',
    '- Inserisci i titoli delle sottosezioni con numerazione esplicita, esattamente come nell’indice.',
    '- Non usare markdown, non usare asterischi, non usare elenchi puntati.',
    '- Non fermarti a metà capitolo e non saltare le ultime sottosezioni.',
    '- Evita frasi come "nel capitolo successivo", "nei capitoli successivi" o "in questo capitolo" usate come raccordo artificiale.',
  ].filter(Boolean).join('\n\n');
}

function buildChapterSubsectionPrompt(input, context, subsection, index, total, targetWords) {
  const obj = input && typeof input === 'object' ? input : {};
  const prevSummary = index > 0
    ? `La sottosezione precedente sviluppata è: ${context.subsections[index - 1].code} ${context.subsections[index - 1].title}. Mantieni continuità logica senza ripetizioni.`
    : 'Apri il capitolo con una sottosezione pienamente introduttiva ma già analitica.';

  return [
    'TASK: chapter_draft_section',
    `SVILUPPA SOLO QUESTA SOTTOSEZIONE DEL CAPITOLO: ${subsection.code} ${subsection.title}`,
    `CAPITOLO DI RIFERIMENTO: ${context.chapterHeading}`,
    `POSIZIONE: ${index + 1} di ${total}`,
    `OBIETTIVO DI LUNGHEZZA: almeno ${targetWords} parole per questa singola sottosezione.`,
    prevSummary,
    'REGOLE OBBLIGATORIE:',
    `- Inizia esattamente con l'intestazione: ${subsection.code} ${subsection.title}`,
    '- Produci solo la sottosezione richiesta, senza anticipare né sviluppare la successiva.',
    '- Mantieni 7-10 paragrafi continui, densi e argomentativi.',
    '- Non usare markdown, non usare asterischi, non usare elenchi puntati.',
    '- Non chiudere in modo sbrigativo e non restare generico.',
    '- Evita anticipazioni del capitolo successivo e chiuse metadiscorsive sul capitolo appena svolto.',
    '- Mantieni stile accademico, rigore terminologico e coerenza con la tesi.',
    obj.theme ? `ARGOMENTO DELLA TESI: ${clip(String(obj.theme), 1200)}` : '',
    obj.faculty || obj.degreeCourse || obj.degreeType
      ? `CONTESTO ACCADEMICO\nFacoltà: ${clip(String(obj.faculty || ''), 300)}\nCorso: ${clip(String(obj.degreeCourse || ''), 400)}\nTipo laurea: ${clip(String(obj.degreeType || ''), 120)}\nMetodologia: ${clip(String(obj.methodology || ''), 120)}`
      : '',
    obj.approvedAbstract ? `ABSTRACT APPROVATO\n${clip(String(obj.approvedAbstract), 2500)}` : '',
    obj.previousChapters ? `CAPITOLI PRECEDENTI (SINTESI)\n${clip(String(obj.previousChapters), 3500)}` : '',
  ].filter(Boolean).join('\n\n');
}

function buildChapterSubsectionRetryPrompt(input, context, subsection, index, total, targetWords, existingText) {
  return [
    buildChapterSubsectionPrompt(input, context, subsection, index, total, targetWords),
    'ATTENZIONE: la bozza precedente era troppo breve o insufficiente.',
    `TESTO PRECEDENTE DA SUPERARE E AMPLIARE:\n${clip(String(existingText || ''), 3500)}`,
    'RISCRIVI INTEGRALMENTE LA SOTTOSEZIONE, più ampia, più argomentata e più completa.',
    'Non limitarti ad aggiungere poche frasi finali: ricostruisci l’intera sottosezione in modo pieno.',
  ].filter(Boolean).join('\n\n');
}

function postProcessChapterSectionText(text, subsection, nextSubsection) {
  let cleaned = cleanModelText(text)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*[-–—*]\s+/gm, '')
    .trim();

  const heading = `${subsection.code} ${subsection.title}`;
  cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, 'i'), `${heading}\n\n`);
  cleaned = cleaned.replace(/^\d+\.\d+\s+.+?(?:\n|$)/, '').trim();

  if (!cleaned.startsWith(heading)) {
    cleaned = `${heading}\n\n${cleaned}`.trim();
  }

  if (nextSubsection) {
    const nextHeading = `${nextSubsection.code} ${nextSubsection.title}`;
    const nextRegex = new RegExp(`(^|\\n)${escapeRegExp(nextHeading)}(?=\\n|$)`, 'i');
    const nextMatch = cleaned.match(nextRegex);
    if (nextMatch && typeof nextMatch.index === 'number') {
      cleaned = cleaned.slice(0, nextMatch.index).trim();
    }
  }

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

function postProcessChapterText(text, context) {
  let cleaned = cleanModelText(text)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*[-–—*]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const chapterHeading = cleanChapterHeading(normalizeOutlineLine(context.chapterHeading || `Capitolo ${context.currentChapterNumber}`), context.currentChapterNumber);
  cleaned = stripDuplicateLeadingChapterTitle(cleaned, chapterHeading);
  cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(chapterHeading)}\\s*`, 'i'), `${chapterHeading}\n\n`);

  if (!cleaned.startsWith(chapterHeading)) {
    cleaned = `${chapterHeading}\n\n${cleaned}`;
  }

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

function stripArtificialTransitions(text) {
  let cleaned = String(text || '');
  const sentencePatterns = [
    /\b(?:nel|in)\s+(?:prossimo|successivo)\s+capitolo\b[^.!?]*[.!?]/gi,
    /\b(?:nei\s+capitoli\s+successivi|nei\s+successivi\s+paragrafi)\b[^.!?]*[.!?]/gi,
    /\b(?:come\s+si\s+è\s+(?:visto|osservato|emerso)|alla\s+luce\s+di\s+quanto\s+emerso)\s+(?:in|nel)\s+(?:presente|questo)\s+capitolo\b[^.!?]*[.!?]/gi,
    /\b(?:è\s+su\s+questa\s+base\s+che|su\s+questa\s+base)\s+(?:il\s+capitolo\s+successivo|i\s+capitoli\s+successivi)\b[^.!?]*[.!?]/gi,
    /\b(?:il|questo|tale)\s+(?:capitolo|paragrafo|quadro|percorso|punto)\b[^.!?]*(?:prossimo\s+capitolo|capitoli\s+successivi)\b[^.!?]*[.!?]/gi,
    /\b(?:in|nel)\s+(?:presente|questo)\s+capitolo\b[^.!?]*(?:si\s+vedrà|si\s+analizzerà|si\s+esaminerà|verrà\s+affrontato|sarà\s+affrontato)[^.!?]*[.!?]/gi,
  ];

  for (const pattern of sentencePatterns) {
    cleaned = cleaned.replace(pattern, ' ');
  }

  return cleaned
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeChapterLayout(text) {
  const source = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!source) return '';

  const rawLines = source.split('\n').map((line) => line.trim());
  const blocks = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', text: paragraph.join(' ').replace(/\s+/g, ' ').trim() });
    paragraph = [];
  };

  for (const line of rawLines) {
    if (!line) {
      flushParagraph();
      continue;
    }
    if (isStructuralHeadingLine(line)) {
      flushParagraph();
      blocks.push({ type: 'heading', text: line });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();

  const merged = [];
  for (const block of blocks) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === 'paragraph' && block.type === 'paragraph' && shouldMergeParagraphBlocks(prev.text, block.text)) {
      prev.text = smartJoinParagraphs(prev.text, block.text);
    } else {
      merged.push({ ...block });
    }
  }

  return merged
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isStructuralHeadingLine(line) {
  const value = String(line || '').trim();
  return /^Capitolo\s+\d+\b/i.test(value) || /^\d+\.\d+\s+\S+/.test(value);
}

function shouldMergeParagraphBlocks(previous, next) {
  const prev = String(previous || '').trim();
  const curr = String(next || '').trim();
  if (!prev || !curr) return false;
  if (!/[.!?)]$/.test(prev)) return true;
  if (/[,:;]$/.test(prev)) return true;
  if (/^[a-zàèéìòù]/.test(curr)) return true;
  if (/^(e|ed|o|od|oppure|ma|mentre|come|con|per|tra|fra|nei|nelle|negli|dei|degli|delle|del|della|dello|di|da|a|ad|che)\b/i.test(curr)) return true;
  return false;
}

function smartJoinParagraphs(previous, next) {
  const prev = String(previous || '').trim();
  const curr = String(next || '').trim();
  if (!prev) return curr;
  if (!curr) return prev;

  const prevLastWord = prev.split(/\s+/).slice(-1)[0] || '';
  const nextFirstWord = curr.split(/\s+/)[0] || '';
  const joinWithoutSpace = !/[.!?)]$/.test(prev)
    && /^[A-ZÀ-Ý][a-zà-ÿ]{2,5}$/.test(prevLastWord)
    && /^[a-zà-ÿ]{2,}$/.test(nextFirstWord);

  return `${prev}${joinWithoutSpace ? '' : ' '}${curr}`.replace(/\s+/g, ' ').trim();
}

function cleanChapterHeading(heading, currentChapterNumber) {
  let cleaned = String(heading || '').trim();
  cleaned = cleaned.replace(/\s+/g, ' ');
  cleaned = cleaned.replace(/^capitolo\s+(\d+)\s*[—\-:–]?\s*[\.·•]\s*/i, 'Capitolo $1 — ');
  cleaned = cleaned.replace(/^capitolo\s+(\d+)\s*[—\-:–]?\s*/i, 'Capitolo $1 — ');
  cleaned = cleaned.replace(/^Capitolo\s+(\d+)\s+—\s+Capitolo\s+(\d+)\s+—\s+/i, 'Capitolo $1 — ');
  cleaned = cleaned.replace(/^Capitolo\s+(\d+)\s+—\s+[\.·•]\s*/i, 'Capitolo $1 — ');
  cleaned = cleaned.replace(/^Capitolo\s+(\d+)\s+—\s*$/i, 'Capitolo $1');
  cleaned = cleaned.trim();

  if (!/^Capitolo\s+\d+/i.test(cleaned)) {
    const titleOnly = cleaned.replace(/^[\.·•\-–—:\s]+/, '').trim();
    return titleOnly ? `Capitolo ${currentChapterNumber} — ${titleOnly}` : `Capitolo ${currentChapterNumber}`;
  }

  return cleaned;
}

function stripDuplicateLeadingChapterTitle(text, chapterHeading) {
  const cleaned = String(text || '').trim();
  const titleOnly = String(chapterHeading || '').replace(/^Capitolo\s+\d+\s*[—\-:–]?\s*/i, '').trim();
  if (!titleOnly) return cleaned;
  const lines = cleaned.split('\n');
  if (lines.length < 2) return cleaned;
  const firstLine = lines[0].trim().replace(/[.]+$/, '').trim();
  const secondLine = lines[1].trim();
  if (firstLine.toLowerCase() === titleOnly.toLowerCase() && /^Capitolo\s+\d+/i.test(secondLine)) {
    return lines.slice(1).join('\n').trim();
  }
  return cleaned;
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
    'Evita formule metadiscorsive artificiali come "nel prossimo capitolo", "nei capitoli successivi", "in questo capitolo si vedrà" o "come emerso nel presente capitolo".',
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
