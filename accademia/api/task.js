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
  const system = buildSystemPrompt(task, input);
  const prompt = buildProviderPrompt(task, input);
  const maxTokens = getTaskMaxTokens(task);

  const attempts = [];
  if (ANTHROPIC_API_KEY) {
    attempts.push((customPrompt = prompt, customMaxTokens = maxTokens, timeoutMs = getTaskTimeout(task)) =>
      callAnthropic({ model: ANTHROPIC_PRIMARY_MODEL, system, prompt: customPrompt, maxTokens: customMaxTokens, timeoutMs })
    );
    attempts.push((customPrompt = shrinkPrompt(prompt), customMaxTokens = Math.min(2600, maxTokens), timeoutMs = 35_000) =>
      callAnthropic({ model: ANTHROPIC_FALLBACK_MODEL, system, prompt: customPrompt, maxTokens: customMaxTokens, timeoutMs })
    );
  }
  if (OPENAI_API_KEY) {
    attempts.push((customPrompt = shrinkPrompt(prompt), customMaxTokens = Math.min(4200, maxTokens), timeoutMs = 40_000) =>
      callOpenAI({ model: OPENAI_MODEL, system, prompt: customPrompt, maxTokens: customMaxTokens, timeoutMs })
    );
  }

  if (!attempts.length) {
    const err = new Error('Nessun provider configurato');
    err.statusCode = 500;
    throw err;
  }

  let lastError = null;
  for (const attempt of attempts) {
    try {
      let text = cleanModelText(await attempt());
      if (!text) throw new Error('Provider ha restituito testo vuoto');

      if (taskRequiresContinuation(task) && chapterLooksIncomplete(text, input)) {
        const continuationPrompt = buildContinuationPrompt(task, input, text);
        const continuation = cleanModelText(await attempt(continuationPrompt, Math.min(2600, getContinuationMaxTokens(task)), getContinuationTimeout(task)));
        if (continuation) {
          text = mergeContinuationText(text, continuation);
        }
      }

      if (taskRequiresContinuation(task) && chapterLooksIncomplete(text, input)) {
        const err = new Error('Contenuto capitolo incompleto: provider ha restituito una versione troncata');
        err.statusCode = 502;
        throw err;
      }

      return text;
    } catch (err) {
      lastError = err;
      const isRecoverable =
        isProviderTimeout(err) ||
        isProviderOverload(err) ||
        /rate limit|overloaded|temporarily unavailable|troncata|incompleto/i.test(String(err?.message || ''));
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

function getTaskMaxTokens(task) {
  if (task === 'outline_draft' || task === 'outline_review') return 1800;
  if (task === 'abstract_draft' || task === 'abstract_review') return 1600;
  if (task === 'chapter_draft') return 5200;
  if (task === 'chapter_review' || task === 'tutor_revision') return 4800;
  return 2600;
}

function getTaskTimeout(task) {
  if (task === 'chapter_draft' || task === 'chapter_review' || task === 'tutor_revision') return 70_000;
  return 45_000;
}

function getContinuationMaxTokens(task) {
  if (task === 'chapter_draft') return 2600;
  if (task === 'chapter_review' || task === 'tutor_revision') return 2200;
  return 1800;
}

function getContinuationTimeout(task) {
  if (task === 'chapter_draft' || task === 'chapter_review' || task === 'tutor_revision') return 45_000;
  return 30_000;
}

function taskRequiresContinuation(task) {
  return task === 'chapter_draft' || task === 'chapter_review' || task === 'tutor_revision';
}

function buildContinuationPrompt(task, input, partialText) {
  const obj = input && typeof input === 'object' ? input : {};
  const expected = getExpectedChapterSubsections(obj);
  const expectedText = expected.length
    ? `Sottosezioni attese per questo capitolo:\n${expected.map((x) => `- ${x}`).join('\n')}`
    : '';
  const partialTail = clip(String(partialText || ''), 5000);
  return [
    `TASK: ${task}_continuation`,
    'Il testo precedente risulta interrotto. Devi continuare ESATTAMENTE dal punto in cui si è fermato, senza ricominciare da capo.',
    'Non ripetere il testo già scritto. Prosegui in continuità logica e stilistica.',
    'Completa tutte le sottosezioni mancanti del capitolo corrente, se non ancora sviluppate.',
    expectedText,
    `TESTO GIÀ GENERATO (PARTE FINALE)\n${partialTail}`
  ].filter(Boolean).join('\n\n');
}

function mergeContinuationText(baseText, continuationText) {
  const base = cleanModelText(baseText);
  let continuation = cleanModelText(continuationText);
  if (!continuation) return base;
  continuation = continuation.replace(/^continua(?:zione)?[:\s-]*/i, '').trim();

  const tail = base.slice(-700);
  let overlap = '';
  for (let size = Math.min(220, tail.length, continuation.length); size >= 40; size -= 10) {
    const candidate = tail.slice(-size).trim();
    if (candidate && continuation.startsWith(candidate)) {
      overlap = candidate;
      break;
    }
  }
  if (overlap) continuation = continuation.slice(overlap.length).trim();
  return cleanModelText(`${base}\n\n${continuation}`);
}

function chapterLooksIncomplete(text, input) {
  const body = cleanModelText(text);
  if (!body) return true;
  if (body.length < 1800) return true;

  const expected = getExpectedChapterSubsections(input);
  if (expected.length) {
    let found = 0;
    for (const item of expected) {
      const key = normalizeHeadingKey(item);
      if (key && body.toLowerCase().includes(key)) found += 1;
    }
    const minimum = Math.max(1, Math.min(expected.length, Math.ceil(expected.length * 0.6)));
    if (found < minimum) return true;
  }

  const lower = body.toLowerCase();
  const endingLooksBroken =
    /(?:\bteoria\b|\bconcett|\bidentit|\bmercat|\bcomunicaz|\bpolitic|\bcontest|\bsocial|\bprocess)/i.test(body.slice(-20)) &&
    !/[.!?”»)]\s*$/.test(body);
  if (endingLooksBroken) return true;

  const choppedPatterns = [
    /\b(?:il|la|le|i|gli|di|del|della|delle|dei|degli|nel|nella|nelle|con|per|tra|come|che|dove|quale|quali)\s*$/i,
    /\b\d+(?:\.\d+){1,2}\s*$/i
  ];
  if (choppedPatterns.some((rx) => rx.test(body))) return true;

  return false;
}

function getExpectedChapterSubsections(input) {
  const obj = input && typeof input === 'object' ? input : {};
  const outline = String(obj.approvedOutline || '').replace(/\r/g, '');
  if (!outline) return [];
  const currentIndex = Number.isFinite(Number(obj.currentChapterIndex)) ? Number(obj.currentChapterIndex) : 0;
  const chapterNo = currentIndex + 1;
  const lines = outline.split('\n').map((x) => x.trim()).filter(Boolean);
  const expected = [];
  let inChapter = false;
  for (const line of lines) {
    const chapterMatch =
      line.match(new RegExp(`^(?:#+\s*)?(?:capitolo\s*)?${chapterNo}(?:\b|\s|[—:-])`, 'i')) ||
      line.match(new RegExp(`^(?:#+\s*)?${chapterNo}[\.)\s—:-]`, 'i'));
    const anotherChapter =
      line.match(/^(?:#+\s*)?(?:capitolo\s*)?(\d+)(?:|\s|[—:-])/i) ||
      line.match(/^(?:#+\s*)?(\d+)[\.)\s—:-]/);

    if (chapterMatch) {
      inChapter = true;
      continue;
    }
    if (inChapter && anotherChapter) {
      const num = Number(anotherChapter[1]);
      if (num !== chapterNo) break;
    }
    if (inChapter && new RegExp(`^${chapterNo}\.\d+`).test(line)) {
      expected.push(line.replace(/^#+\s*/, '').trim());
    }
  }
  return expected.slice(0, 12);
}

function normalizeHeadingKey(line) {
  return String(line || '')
    .toLowerCase()
    .replace(/^#+\s*/, '')
    .replace(/^\d+(?:\.\d+)+\s*/, '')
    .replace(/[–—:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
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
  const expectedSubsections = getExpectedChapterSubsections(obj);
  if (expectedSubsections.length) {
    sections.push(`SOTTOSEZIONI ATTESE DEL CAPITOLO CORRENTE\n${clip(expectedSubsections.join('\n'), 2500)}`);
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
    base.push('Per i capitoli, sviluppa il contenuto in modo completo e non interrompere la risposta prima di aver coperto le sottosezioni richieste dall’indice del capitolo corrente.');
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
