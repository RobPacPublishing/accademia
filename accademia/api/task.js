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

function buildAcademicDepthGuidance(input) {
  const obj = input && typeof input === 'object' ? input : {};
  const degreeType = String(obj.degreeType || '').toLowerCase();
  const methodology = String(obj.methodology || '').toLowerCase();
  const parts = [];

  if (/magistr|master|specialistic/.test(degreeType)) {
    parts.push('Livello atteso: laurea magistrale. Aumenta densità teorica, confronto critico tra posizioni, precisione concettuale e profondità argomentativa.');
  } else if (/trienn|bachelor/.test(degreeType)) {
    parts.push('Livello atteso: laurea triennale. Mantieni rigore accademico, chiarezza espositiva, buona densità teorica e sviluppo ordinato dei nessi concettuali.');
  } else {
    parts.push('Mantieni livello accademico pieno, con sviluppo sostanziale, terminologia precisa e coerenza teorica.');
  }

  if (/empir|speriment|ricerca/.test(methodology)) {
    parts.push('Se l’impianto richiama una metodologia empirica, usa lessico coerente con ipotesi, variabili, procedura, risultati attesi, discussione e limiti, senza inventare dati.');
  } else if (/teoric|compilat|bibliogra/.test(methodology)) {
    parts.push('Se l’impianto è teorico-compilativo, privilegia definizioni, confronto tra autori, chiarificazione dei concetti e articolazione dei nessi teorici.');
  }

  if (obj.facultyGuidance) {
    parts.push(`Indicazioni di facoltà da rispettare: ${clip(String(obj.facultyGuidance), 1200)}`);
  }

  return parts.join(' ');
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function sanitizeParagraphEdges(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripArtificialTransitions(text) {
  let cleaned = String(text || '');

  const paragraphPatterns = [
    /^\s*(?:Nel prossimo capitolo|Nel capitolo successivo|Nei capitoli successivi)\b[\s\S]*$/i,
    /^\s*(?:Quanto analizzato|Quanto esposto|Quanto emerso)\s+(?:in questo capitolo|nel presente capitolo|in questa sezione|nel presente paragrafo)\b[\s\S]*$/i,
    /^\s*(?:Il capitolo successivo|La sezione successiva|Il paragrafo successivo)\b[\s\S]*$/i,
  ];

  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((paragraph) => !paragraphPatterns.some((pattern) => pattern.test(paragraph)));

  return paragraphs.join('\n\n');
}

function finalizeAcademicText(text) {
  let cleaned = cleanModelText(text)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n([a-zà-ÿ])/gi, ' $1')
    .replace(/([,:;])\n+/g, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();

  cleaned = stripArtificialTransitions(cleaned);
  cleaned = sanitizeParagraphEdges(cleaned);
  return cleaned;
}

function normalizeHeadingTitle(title) {
  return String(title || '')
    .replace(/^capitolo\s+\d+\s*[—\-:]?\s*/i, '')
    .replace(/^\.\s*/, '')
    .trim()
    .toLowerCase();
}

function resolveChapterTargetWords(input, context) {
  const obj = input && typeof input === 'object' ? input : {};
  const explicit = Number(
    obj?.constraints?.minWordsChapter ||
    obj?.minWordsChapter ||
    obj?.targetWords ||
    0
  );
  if (Number.isFinite(explicit) && explicit >= 1200) return Math.round(explicit);

  const degreeType = String(obj.degreeType || '').toLowerCase();
  let base = /magistr|master|specialistic/.test(degreeType) ? 5200 : (/trienn|bachelor/.test(degreeType) ? 3800 : 4200);
  if (context.subsections.length) {
    base = Math.max(base, context.subsections.length * 900);
  }
  return base;
}

function subsectionBody(text, subsection) {
  const heading = `${subsection.code} ${subsection.title}`.trim();
  let cleaned = String(text || '').trim();
  if (cleaned.startsWith(heading)) {
    cleaned = cleaned.slice(heading.length).trim();
  }
  cleaned = cleaned.replace(/^\d+\.\d+\s+.+?(?:\n|$)/, '').trim();
  return cleaned;
}

function isSuspiciousEnding(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return true;
  const tail = cleaned.slice(-180);
  if (/[,:;(\-–—]$/.test(cleaned)) return true;
  if (!/[.!?…"”»]$/.test(cleaned)) return true;
  if (/\b(?:e|ed|o|oppure|ma|con|per|tra|fra|di|del|della|dei|degli|delle|in|nel|nella|nelle|che|come|dove|quale|quali|mentre|poiché|perché)$/i.test(tail)) return true;
  return false;
}

function needsSectionContinuation(text, subsection, minWords) {
  const body = subsectionBody(text, subsection);
  const words = countWords(body);
  return words < minWords || isSuspiciousEnding(body);
}

function buildSectionContinuationPrompt(input, context, subsection, currentText, minWords) {
  const obj = input && typeof input === 'object' ? input : {};
  const body = subsectionBody(currentText, subsection);

  return [
    'TASK: chapter_draft_section_continue',
    `CONTINUA SOLO LA SOTTOSEZIONE: ${subsection.code} ${subsection.title}`,
    `CAPITOLO DI RIFERIMENTO: ${context.chapterHeading}`,
    'NON ripetere l’intestazione della sottosezione se è già presente nel testo esistente.',
    'NON ricominciare da capo, NON riassumere quanto già scritto, NON passare alla sottosezione successiva.',
    'Completa in modo naturale il ragionamento rimasto in sospeso e chiudi la sottosezione con una conclusione pienamente compiuta sul contenuto trattato.',
    `Porta questa sottosezione ad almeno ${minWords} parole di corpo testuale effettivo, con paragrafi continui e densi di contenuto.`,
    obj.theme ? `ARGOMENTO DELLA TESI: ${clip(String(obj.theme), 1200)}` : '',
    `TESTO ESISTENTE DELLA SOTTOSEZIONE:\n${clip(body, 3200)}`,
  ].filter(Boolean).join('\n\n');
}

function mergeSectionContinuation(baseText, continuationText, subsection) {
  const heading = `${subsection.code} ${subsection.title}`.trim();
  let continuation = finalizeAcademicText(continuationText)
    .replace(new RegExp(`^${escapeRegex(heading)}\\s*`, 'i'), '')
    .replace(/^\d+\.\d+\s+.+?(?:\n|$)/, '')
    .trim();

  if (!continuation) return finalizeAcademicText(baseText);
  return finalizeAcademicText(`${finalizeAcademicText(baseText)}\n\n${continuation}`);
}

function needsChapterCompletion(text, context, targetWords) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return true;
  if (countWords(cleaned) < Math.max(2600, Math.floor(targetWords * 0.88))) return true;
  if (isSuspiciousEnding(cleaned)) return true;
  const lastCode = context.subsections.length ? context.subsections[context.subsections.length - 1].code : '';
  if (lastCode && !cleaned.includes(lastCode)) return true;
  return false;
}

function buildChapterCompletionPrompt(input, context, chapterText, targetWords) {
  const obj = input && typeof input === 'object' ? input : {};
  const lastSub = context.subsections.length ? context.subsections[context.subsections.length - 1] : null;
  const excerpt = clip(String(chapterText || '').slice(-4200), 4200);

  return [
    'TASK: chapter_draft_complete',
    `COMPLETA IL CAPITOLO: ${context.chapterHeading}`,
    'Continua solo dal punto in cui il testo si è interrotto.',
    'NON ripetere il titolo del capitolo.',
    lastSub ? `Se necessario, completa la sottosezione finale ${lastSub.code} ${lastSub.title} prima di chiudere il capitolo.` : '',
    'NON introdurre il capitolo successivo e NON usare formule metatestuali artificiali.',
    `Porta il capitolo verso una forma compiuta e coerente, orientativamente non inferiore a ${targetWords} parole complessive, salvo saturazione del contenuto realmente pertinente.`,
    obj.theme ? `ARGOMENTO DELLA TESI: ${clip(String(obj.theme), 1200)}` : '',
    `ESTRATTO FINALE DEL CAPITOLO GIÀ SCRITTO:\n${excerpt}`,
  ].filter(Boolean).join('\n\n');
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    attempts.push(() => callAnthropic({ model: ANTHROPIC_FALLBACK_MODEL, system, prompt: shrinkPrompt(prompt), maxTokens: Math.min(2000, maxTokens), timeoutMs: fallbackTimeoutMs }));
  }
  if (OPENAI_API_KEY) {
    attempts.push(() => callOpenAI({ model: OPENAI_MODEL, system, prompt: shrinkPrompt(prompt), maxTokens: Math.min(2400, maxTokens), timeoutMs: openaiTimeoutMs }));
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
    const prompt = buildProviderPrompt('chapter_draft', input);
    const raw = await generateWithProviders({
      prompt,
      system,
      maxTokens: 4200,
      primaryTimeoutMs: 60_000,
      fallbackTimeoutMs: 45_000,
      openaiTimeoutMs: 50_000,
    });
    let chapterText = postProcessChapterText(raw, context);
    if (needsChapterCompletion(chapterText, context, targetWords)) {
      const completionPrompt = buildChapterCompletionPrompt(input, context, chapterText, targetWords);
      const continuation = await generateWithProviders({
        prompt: completionPrompt,
        system,
        maxTokens: 1800,
        primaryTimeoutMs: 50_000,
        fallbackTimeoutMs: 40_000,
        openaiTimeoutMs: 42_000,
      });
      chapterText = postProcessChapterText(`${chapterText}\n\n${continuation}`, context);
    }
    return chapterText;
  }

  const parts = [];
  const minWordsPerSection = Math.max(760, Math.floor(targetWords / context.subsections.length * 0.82));
  const sectionMaxTokens = Math.min(2600, Math.max(1700, Math.round(minWordsPerSection * 1.55)));

  for (let i = 0; i < context.subsections.length; i += 1) {
    const subsection = context.subsections[i];
    const prompt = buildChapterSubsectionPrompt(input, context, subsection, i, context.subsections.length, minWordsPerSection);
    let sectionText = postProcessChapterSectionText(await generateWithProviders({
      prompt,
      system,
      maxTokens: sectionMaxTokens,
      primaryTimeoutMs: 58_000,
      fallbackTimeoutMs: 42_000,
      openaiTimeoutMs: 46_000,
    }), subsection);

    for (let pass = 0; pass < 2; pass += 1) {
      if (!needsSectionContinuation(sectionText, subsection, minWordsPerSection)) break;
      const continuationPrompt = buildSectionContinuationPrompt(input, context, subsection, sectionText, minWordsPerSection);
      const continuationRaw = await generateWithProviders({
        prompt: continuationPrompt,
        system,
        maxTokens: 1700,
        primaryTimeoutMs: 52_000,
        fallbackTimeoutMs: 40_000,
        openaiTimeoutMs: 42_000,
      });
      sectionText = mergeSectionContinuation(sectionText, continuationRaw, subsection);
    }

    parts.push(sectionText);
  }

  let chapterText = postProcessChapterText(`${context.chapterHeading}\n\n${parts.join('\n\n')}`, context);

  if (needsChapterCompletion(chapterText, context, targetWords)) {
    const completionPrompt = buildChapterCompletionPrompt(input, context, chapterText, targetWords);
    const continuation = await generateWithProviders({
      prompt: completionPrompt,
      system,
      maxTokens: 1900,
      primaryTimeoutMs: 54_000,
      fallbackTimeoutMs: 40_000,
      openaiTimeoutMs: 44_000,
    });
    chapterText = postProcessChapterText(`${chapterText}\n\n${continuation}`, context);
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

  let chapterHeading = String(obj.currentChapterTitle || '').trim() || `Capitolo ${currentChapterNumber}`;
  const subsections = [];
  let inside = false;

  for (const line of normalizedLines) {
    const chapterPatterns = [
      new RegExp(`^capitolo\\s+${currentChapterNumber}\\b`, 'i'),
      new RegExp(`^${currentChapterNumber}\\s*[—\\-:.]\\s+`, 'i'),
      new RegExp(`^${currentChapterNumber}\\.\\s+`, 'i'),
    ];
    const isCurrentChapterHeading = chapterPatterns.some((pattern) => pattern.test(line));
    const isAnyChapterHeading = /^(capitolo\s+\d+\b|\d+\s*[—\-:.]\s+.+|\d+\.\s+.+)$/i.test(line) && !/^\d+\.\d+\b/.test(line);

    if (isCurrentChapterHeading) {
      inside = true;
      chapterHeading = line;
      continue;
    }
    if (inside && isAnyChapterHeading) break;

    if (!inside) continue;
    const subsectionMatch = line.match(/^(\d+\.\d+)\s+(.+)$/);
    if (subsectionMatch && Number(subsectionMatch[1].split('.')[0]) === currentChapterNumber) {
      const title = subsectionMatch[2].trim();
      if (!subsections.some((item) => item.code === subsectionMatch[1])) {
        subsections.push({ code: subsectionMatch[1], title });
      }
    }
  }

  if (!subsections.length) {
    for (const line of normalizedLines) {
      const subsectionMatch = line.match(/^(\d+\.\d+)\s+(.+)$/);
      if (subsectionMatch && Number(subsectionMatch[1].split('.')[0]) === currentChapterNumber) {
        const title = subsectionMatch[2].trim();
        if (!subsections.some((item) => item.code === subsectionMatch[1])) {
          subsections.push({ code: subsectionMatch[1], title });
        }
      }
    }
  }

  const headingTitle = normalizeHeadingTitle(chapterHeading);
  const currentTitle = normalizeHeadingTitle(obj.currentChapterTitle || '');
  if (currentTitle && headingTitle && currentTitle !== headingTitle && !headingTitle.includes(currentTitle) && !currentTitle.includes(headingTitle)) {
    chapterHeading = `Capitolo ${currentChapterNumber} — ${String(obj.currentChapterTitle || '').trim()}`;
  }

  return { currentChapterIndex, currentChapterNumber, chapterHeading, subsections };
}

function normalizeOutlineLine(line) {
  return String(line || '')
    .replace(/^#+\s*/, '')
    .replace(/^[-–—*]+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/__+/g, '')
    .trim();
}

function buildChapterSubsectionPrompt(input, context, subsection, index, total, minWordsPerSection = 760) {
  const obj = input && typeof input === 'object' ? input : {};
  const prevSummary = index > 0
    ? `La sottosezione precedente sviluppata è: ${context.subsections[index - 1].code} ${context.subsections[index - 1].title}. Mantieni continuità logica senza ripetizioni e senza riassunti ridondanti.`
    : 'Apri il capitolo con una sottosezione già sostanziale, evitando preamboli generici o dichiarazioni metatestuali.';
  const depthGuidance = buildAcademicDepthGuidance(obj);

  return [
    'TASK: chapter_draft_section',
    `SVILUPPA SOLO QUESTA SOTTOSEZIONE DEL CAPITOLO: ${subsection.code} ${subsection.title}`,
    `CAPITOLO DI RIFERIMENTO: ${context.chapterHeading}`,
    `POSIZIONE: ${index + 1} di ${total}`,
    prevSummary,
    depthGuidance ? `LIVELLO ATTESO\n${depthGuidance}` : '',
    'REGOLE OBBLIGATORIE:',
    `- Inizia esattamente con l'intestazione: ${subsection.code} ${subsection.title}`,
    '- Non usare markdown, non usare asterischi, non usare elenchi puntati.',
    `- Produci solo la sottosezione richiesta, completa e autosufficiente, con paragrafi continui e densi di contenuto, non inferiori orientativamente a ${minWordsPerSection} parole di corpo testuale.`,
    '- Evita frasi automatiche come “in questo paragrafo”, “nel presente capitolo”, “nel capitolo successivo” o formule scolastiche equivalenti.',
    '- Chiudi la sottosezione sul contenuto trattato, senza annunciare esplicitamente la sezione o il capitolo seguente.',
    '- Mantieni stile accademico, rigore terminologico, naturalezza espressiva e coerenza con la tesi.',
    '- Inserisci confronti teorici, definizioni e nessi concettuali quando pertinenti, senza inventare citazioni puntuali o bibliografie.',
    obj.theme ? `ARGOMENTO DELLA TESI: ${clip(String(obj.theme), 1200)}` : '',
    obj.faculty || obj.degreeCourse || obj.degreeType
      ? `CONTESTO ACCADEMICO\nFacoltà: ${clip(String(obj.faculty || ''), 300)}\nCorso: ${clip(String(obj.degreeCourse || ''), 400)}\nTipo laurea: ${clip(String(obj.degreeType || ''), 120)}\nMetodologia: ${clip(String(obj.methodology || ''), 120)}`
      : '',
    obj.approvedAbstract ? `ABSTRACT APPROVATO\n${clip(String(obj.approvedAbstract), 2500)}` : '',
    obj.previousChapters ? `CAPITOLI PRECEDENTI (SINTESI)\n${clip(String(obj.previousChapters), 3500)}` : '',
  ].filter(Boolean).join('\n\n');
}

function postProcessChapterSectionText(text, subsection) {
  let cleaned = finalizeAcademicText(text);
  const heading = `${subsection.code} ${subsection.title}`;
  if (!cleaned.startsWith(heading)) {
    const body = cleaned.replace(/^\d+\.\d+\s+.+?(?:\n|$)/, '').trim();
    cleaned = `${heading}\n\n${body}`.trim();
  }
  return finalizeAcademicText(cleaned);
}

function postProcessChapterText(text, context) {
  let cleaned = finalizeAcademicText(text).replace(/\n{3,}/g, '\n\n').trim();

  const rawHeading = normalizeOutlineLine(context.chapterHeading || `Capitolo ${context.currentChapterNumber}`);
  const chapterHeading = rawHeading
    .replace(/^(Capitolo\s+\d+\s*[—\-:]?)\s*\.\s*/i, '$1 ')
    .trim();

  if (!cleaned.startsWith(chapterHeading)) {
    cleaned = `${chapterHeading}\n\n${cleaned}`;
  }

  return finalizeAcademicText(cleaned);
}

function buildProviderPrompt(task, input) {
  if (typeof input === 'string') return clip(input, 30000);
  const obj = input && typeof input === 'object' ? input : {};
  const sections = [];
  const depthGuidance = buildAcademicDepthGuidance(obj);
  sections.push(`TASK: ${task}`);
  if (obj.prompt) sections.push(`RICHIESTA\n${clip(String(obj.prompt), 14000)}`);
  if (obj.theme) sections.push(`ARGOMENTO\n${clip(String(obj.theme), 1200)}`);
  if (depthGuidance) sections.push(`LIVELLO ATTESO\n${depthGuidance}`);
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
  const depthGuidance = buildAcademicDepthGuidance(input);
  const base = [
    'Scrivi in italiano accademico, chiaro, formale e coerente.',
    'Non inventare fonti, dati empirici, citazioni puntuali o risultati non verificabili.',
    'Evita tono giornalistico, slogan, elenchi inutili e formule artificiali di raccordo.',
    'Mantieni continuità logica, rigore terminologico e pertinenza disciplinare.',
    depthGuidance,
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
  return base.filter(Boolean).join(' ');
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
