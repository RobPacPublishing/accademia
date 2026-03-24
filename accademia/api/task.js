import crypto from 'node:crypto';

const OPENAI_TIMEOUT_MS = 180000;
const ANTHROPIC_TIMEOUT_MS = 180000;

const GENERAL_SYSTEM_PROMPT = `Sei un assistente accademico rigoroso, prudente e professionale.

Regole permanenti:
- lavora solo sui dati effettivamente forniti;
- non inventare fonti, autori, date, studi, enti, statistiche, risultati di ricerca, teorie specifiche, citazioni, riferimenti normativi o bibliografici non presenti nei dati ricevuti;
- se nei dati compaiono riferimenti incompleti o dubbi, non completarli per inferenza: mantieni formulazioni prudenti o neutre;
- non simulare verifiche esterne e non dichiarare di aver consultato letteratura o database se tali fonti non sono state fornite;
- evita formule meta o scolastiche come “raccordo verso il capitolo successivo”, “nel prossimo capitolo”, “analisi critica” come intestazione separata, “di seguito”, “ecco il testo”, salvo richiesta esplicita;
- non aggiungere sezioni finali artificiali che svelino la generazione automatica;
- mantieni tono universitario sobrio, chiaro, rigoroso e non enfatico;
- privilegia coerenza logica, sviluppo argomentativo e densità espositiva.

Per i capitoli:
- sviluppa davvero i sottocapitoli, evitando paragrafi troppo brevi o schematici;
- non trasformare il capitolo in una lista di teorie o autori se non sono presenti nei dati;
- chiudi il testo in modo naturale, senza ponti espliciti al capitolo successivo.`;


export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { task, input, rawInput } = normalizeBody(req.body);

    if (!task) {
      return res.status(400).json({ error: 'Task mancante' });
    }

    if (task === '__state_save') {
      return await handleStateSave({ input: rawInput || {}, res });
    }
    if (task === '__state_load') {
      return await handleStateLoad({ input: rawInput || {}, res });
    }
    if (task === '__visit_ping') {
      return await handleVisitPing({ input: rawInput || {}, res });
    }
    if (task === '__verify_unlock') {
      return await handleVerifyUnlock({ input: rawInput || {}, res });
    }
    if (task === '__account_send_code') {
      return await handleAccountSendCode({ input: rawInput || {}, res });
    }
    if (task === '__account_verify_code') {
      return await handleAccountVerifyCode({ input: rawInput || {}, res });
    }
    if (task === '__account_load') {
      return await handleAccountLoad({ input: rawInput || {}, res });
    }
    if (task === '__account_save') {
      return await handleAccountSave({ input: rawInput || {}, res });
    }
    if (task === '__snapshot_create') {
      return await handleSnapshotCreate({ input: rawInput || {}, res });
    }
    if (task === '__snapshot_list') {
      return await handleSnapshotList({ input: rawInput || {}, res });
    }

    const provider = pickProvider(task);

    try {
      if (provider === 'openai') {
        return await handleOpenAI({ task, input, res });
      }

      return await handleAnthropic({ task, input, res });
    } catch (error) {
      if (provider === 'anthropic' && shouldFallbackToOpenAI(task, error)) {
        return await handleOpenAI({
          task,
          input,
          res,
          fallbackMeta: {
            fallbackFrom: 'anthropic',
            fallbackReason: error?.message || 'Timeout provider Anthropic'
          }
        });
      }

      if (isTimeoutLikeError(error)) {
        return res.status(504).json({
          error: 'Errore provider timeout',
          code: 'provider_timeout',
          details: error?.message || 'Timeout provider'
        });
      }

      throw error;
    }
  } catch (error) {
    return res.status(500).json({
      error: 'Errore interno',
      details: error?.message || 'Errore sconosciuto'
    });
  }
}


function normalizeBody(body) {
  const safe = body && typeof body === 'object' ? body : {};
  const task = typeof safe.task === 'string' ? safe.task.trim() : '';
  const rawInput = safe.input ?? safe.payload ?? safe.content ?? null;
  const input =
    typeof rawInput === 'string'
      ? rawInput
      : JSON.stringify(rawInput ?? {}, null, 2);

  return { task, input, rawInput };
}



function getUpstashConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Configurazione Upstash mancante');
  }
  return { url: url.replace(/\/$/, ''), token };
}

function stateRedisKey(syncKey) {
  const digest = crypto.createHash('sha256').update(String(syncKey)).digest('hex');
  return `accademia:state:${digest}`;
}

function usedCodeRedisKey(code) {
  return `accademia:unlock:used:${String(code).trim().toUpperCase()}`;
}

function emailHash(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

function accountOtpRedisKey(email) {
  return `accademia:account:otp:${emailHash(email)}`;
}

function accountStateRedisKey(email) {
  return `accademia:account:state:${emailHash(email)}`;
}

function accountSessionRedisKey(sessionToken) {
  return `accademia:account:session:${crypto.createHash('sha256').update(String(sessionToken)).digest('hex')}`;
}

function createOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function createSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}


function snapshotSyncRedisKey(syncKey) {
  const digest = crypto.createHash('sha256').update(String(syncKey)).digest('hex');
  return `accademia:snapshots:sync:${digest}`;
}

function snapshotAccountRedisKey(email) {
  return `accademia:account:snapshots:${emailHash(email)}`;
}

async function loadSnapshotArray(key) {
  const raw = await upstashGet(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function appendSnapshotRecord(key, record) {
  const list = await loadSnapshotArray(key);
  const next = [record, ...list.filter(item => item?.id !== record.id)].slice(0, 15);
  await upstashSet(key, JSON.stringify(next));
}

function buildSnapshotRecord(input) {
  const payload = input?.payload;
  return {
    id: String(input?.snapshotId || crypto.randomUUID()),
    label: String(input?.label || 'Versione').trim(),
    reason: String(input?.reason || 'manuale').trim(),
    savedAt: payload?.savedAt || new Date().toISOString(),
    payload
  };
}


function getResendConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ACC_LOGIN_FROM || process.env.RESEND_FROM_EMAIL || process.env.RESEND_FROM || '';
  if (!apiKey) throw new Error('RESEND_API_KEY non configurata');
  if (!from) throw new Error('ACC_LOGIN_FROM non configurata');
  return { apiKey, from };
}

async function sendResendEmail({ to, subject, html, text }) {
  const { apiKey, from } = getResendConfig();
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to: [to], subject, html, text })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || data?.error || 'Invio email account non riuscito');
  }
  return data;
}

async function resolveAccountEmailFromSession(sessionToken) {
  if (!sessionToken) return null;
  const raw = await upstashGet(accountSessionRedisKey(sessionToken));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.email || null;
  } catch {
    return null;
  }
}

async function upstashCall(path, { method = 'GET', body = null } = {}) {
  const { url, token } = getUpstashConfig();
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== null ? { 'Content-Type': 'text/plain;charset=utf-8' } : {})
    },
    body
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || data?.result || 'Errore Upstash');
  }
  return data;
}

async function upstashGet(key) {
  const data = await upstashCall(`/get/${encodeURIComponent(key)}`);
  return data?.result ?? null;
}

async function upstashSet(key, value) {
  await upstashCall(`/set/${encodeURIComponent(key)}`, { method: 'POST', body: value });
}

async function upstashIncr(key) {
  await upstashCall(`/incr/${encodeURIComponent(key)}`, { method: 'POST' });
}

function parseUnlockCodesEnv() {
  const raw = process.env.ACC_UNLOCK_CODES_JSON || '[]';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }

  const map = new Map();
  if (Array.isArray(parsed)) {
    for (const row of parsed) {
      if (!row) continue;
      const code = String(row.code || '').trim().toUpperCase();
      const type = String(row.type || '').trim().toLowerCase();
      if (code && type) map.set(code, type);
    }
  } else if (parsed && typeof parsed === 'object') {
    for (const [code, type] of Object.entries(parsed)) {
      if (code && type) map.set(String(code).trim().toUpperCase(), String(type).trim().toLowerCase());
    }
  }
  return map;
}

async function handleStateSave({ input, res }) {
  const syncKey = String(input?.syncKey || '').trim();
  const payload = input?.payload;
  if (!syncKey || !payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Dati sync mancanti' });
  }
  const record = {
    ...payload,
    savedAt: payload.savedAt || new Date().toISOString()
  };
  await upstashSet(stateRedisKey(syncKey), JSON.stringify(record));
  return res.status(200).json({ ok: true, savedAt: record.savedAt });
}

async function handleStateLoad({ input, res }) {
  const syncKey = String(input?.syncKey || '').trim();
  if (!syncKey) {
    return res.status(400).json({ error: 'Chiave sync mancante' });
  }
  const raw = await upstashGet(stateRedisKey(syncKey));
  if (!raw) {
    return res.status(200).json({ ok: true, state: null });
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return res.status(200).json({ ok: true, state: parsed });
}

async function handleVisitPing({ input, res }) {
  const page = String(input?.page || 'app').trim().toLowerCase();
  await upstashIncr(`accademia:visits:${page}`);
  return res.status(200).json({ ok: true });
}

async function handleVerifyUnlock({ input, res }) {
  const code = String(input?.code || '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ valid: false, reason: 'empty' });
  }
  const codes = parseUnlockCodesEnv();
  const type = codes.get(code);
  if (!type) {
    return res.status(200).json({ valid: false, reason: 'not_found' });
  }
  const usedKey = usedCodeRedisKey(code);
  const alreadyUsed = await upstashGet(usedKey);
  if (alreadyUsed) {
    return res.status(200).json({ valid: false, reason: 'already_used' });
  }
  await upstashSet(usedKey, JSON.stringify({ usedAt: new Date().toISOString(), type }));
  return res.status(200).json({ valid: true, type });
}

async function handleAccountSendCode({ input, res }) {
  const email = String(input?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email non valida' });
  }

  const otpKey = accountOtpRedisKey(email);
  const code = createOtpCode();
  const now = Date.now();
  const expiresAt = new Date(now + 15 * 60 * 1000).toISOString();
  await upstashSet(otpKey, JSON.stringify({ code, email, expiresAt, sentAt: new Date(now).toISOString() }));

  await sendResendEmail({
    to: email,
    subject: 'AccademIA — codice di accesso account',
    text: `Il tuo codice di accesso è ${code}. Scade tra 15 minuti.`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111"><h2>AccademIA</h2><p>Il tuo codice di accesso è:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>Il codice scade tra 15 minuti.</p></div>`
  });

  return res.status(200).json({ ok: true, sent: true });
}

async function handleAccountVerifyCode({ input, res }) {
  const email = String(input?.email || '').trim().toLowerCase();
  const code = String(input?.code || '').trim();
  if (!email || !code) {
    return res.status(400).json({ error: 'Email o codice mancanti' });
  }
  const raw = await upstashGet(accountOtpRedisKey(email));
  if (!raw) {
    return res.status(400).json({ error: 'Codice assente o scaduto' });
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed?.code || parsed.code !== code) {
    return res.status(400).json({ error: 'Codice non valido' });
  }
  if (parsed?.expiresAt && new Date(parsed.expiresAt).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Codice scaduto' });
  }

  const sessionToken = createSessionToken();
  await upstashSet(accountSessionRedisKey(sessionToken), JSON.stringify({ email, createdAt: new Date().toISOString() }));
  return res.status(200).json({ ok: true, email, sessionToken });
}

async function handleAccountLoad({ input, res }) {
  const sessionToken = String(input?.sessionToken || '').trim();
  if (!sessionToken) {
    return res.status(400).json({ error: 'Sessione account mancante' });
  }
  const email = await resolveAccountEmailFromSession(sessionToken);
  if (!email) {
    return res.status(401).json({ error: 'Sessione account non valida' });
  }
  const raw = await upstashGet(accountStateRedisKey(email));
  if (!raw) {
    return res.status(200).json({ ok: true, state: null });
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return res.status(200).json({ ok: true, state: parsed, email });
}

async function handleAccountSave({ input, res }) {
  const sessionToken = String(input?.sessionToken || '').trim();
  const payload = input?.payload;
  if (!sessionToken || !payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Dati account mancanti' });
  }
  const email = await resolveAccountEmailFromSession(sessionToken);
  if (!email) {
    return res.status(401).json({ error: 'Sessione account non valida' });
  }
  const record = {
    ...payload,
    savedAt: payload.savedAt || new Date().toISOString(),
    accountEmail: email
  };
  await upstashSet(accountStateRedisKey(email), JSON.stringify(record));
  return res.status(200).json({ ok: true, savedAt: record.savedAt, email });
}


async function handleSnapshotCreate({ input, res }) {
  const payload = input?.payload;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Payload snapshot mancante' });
  }
  const sessionToken = String(input?.sessionToken || '').trim();
  const syncKey = String(input?.syncKey || '').trim();
  const record = buildSnapshotRecord(input);

  if (sessionToken) {
    const email = await resolveAccountEmailFromSession(sessionToken);
    if (!email) return res.status(401).json({ error: 'Sessione account non valida' });
    await appendSnapshotRecord(snapshotAccountRedisKey(email), { ...record, accountEmail: email });
    return res.status(200).json({ ok: true, id: record.id, savedAt: record.savedAt, scope: 'account' });
  }

  if (syncKey) {
    await appendSnapshotRecord(snapshotSyncRedisKey(syncKey), record);
    return res.status(200).json({ ok: true, id: record.id, savedAt: record.savedAt, scope: 'sync' });
  }

  return res.status(400).json({ error: 'Identità snapshot mancante' });
}

async function handleSnapshotList({ input, res }) {
  const sessionToken = String(input?.sessionToken || '').trim();
  const syncKey = String(input?.syncKey || '').trim();

  if (sessionToken) {
    const email = await resolveAccountEmailFromSession(sessionToken);
    if (!email) return res.status(401).json({ error: 'Sessione account non valida' });
    const snapshots = await loadSnapshotArray(snapshotAccountRedisKey(email));
    return res.status(200).json({ ok: true, snapshots, scope: 'account' });
  }

  if (syncKey) {
    const snapshots = await loadSnapshotArray(snapshotSyncRedisKey(syncKey));
    return res.status(200).json({ ok: true, snapshots, scope: 'sync' });
  }

  return res.status(400).json({ error: 'Identità snapshot mancante' });
}

function pickProvider(task) {
  const anthropicTasks = new Set([
    'chapter_draft',
    'chapter_review',
    'tutor_revision',
    'final_consistency_review'
  ]);

  return anthropicTasks.has(task) ? 'anthropic' : 'openai';
}

function isTimeoutLikeError(error) {
  const message = error?.message || '';
  return error?.name === 'AbortError' || /timeout/i.test(message);
}

function shouldFallbackToOpenAI(task, error) {
  const fallbackTasks = new Set(['chapter_review', 'tutor_revision']);
  return fallbackTasks.has(task) && isTimeoutLikeError(error);
}

async function handleOpenAI({ task, input, res, fallbackMeta = null }) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL || 'gpt-5.4';

  if (!openaiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY non configurata' });
  }

  const prompt = buildPrompt(task, input);

  const response = await fetchWithTimeout(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiKey}`
      },
      body: JSON.stringify({
        model: openaiModel,
        instructions: GENERAL_SYSTEM_PROMPT,
        input: prompt
      })
    },
    OPENAI_TIMEOUT_MS
  );

  const data = await safeJson(response);

  if (!response.ok) {
    return res.status(response.status).json({
      error: 'Errore OpenAI',
      details: simplifyProviderError(data)
    });
  }

  const text =
    data?.output_text ||
    extractOpenAIText(data) ||
    'Nessun contenuto restituito';

  return res.status(200).json({
    ok: true,
    provider: 'openai',
    task,
    text,
    ...(fallbackMeta ? { fallback: fallbackMeta } : {})
  });
}

async function handleAnthropic({ task, input, res }) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  if (!anthropicKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurata' });
  }

  const prompt = buildPrompt(task, input);

  const response = await fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: anthropicModel,
        system: GENERAL_SYSTEM_PROMPT,
        max_tokens: 6000,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    },
    ANTHROPIC_TIMEOUT_MS
  );

  const data = await safeJson(response);

  if (!response.ok) {
    return res.status(response.status).json({
      error: 'Errore Anthropic',
      details: simplifyProviderError(data)
    });
  }

  const text =
    Array.isArray(data?.content)
      ? data.content.map(part => part?.text || '').join('\n').trim()
      : '';

  return res.status(200).json({
    ok: true,
    provider: 'anthropic',
    task,
    text: text || 'Nessun contenuto restituito'
  });
}

function buildPrompt(task, input) {
  const payload = typeof input === 'string' ? input : JSON.stringify(input || {}, null, 2);

  const map = {
    outline_draft: `Genera un indice accademico coerente e ben strutturato sulla base dei soli dati ricevuti.
- Prevedi, se appropriato al tema, 5 capitoli principali oltre a introduzione, conclusioni e bibliografia.
- Evita formulazioni ridondanti o generiche.
- Restituisci solo l'indice finale.`,

    abstract_draft: `Genera un abstract accademico chiaro, continuo e formalmente pulito sulla base dei soli dati ricevuti.
- Non inserire riferimenti, autori o dati non presenti nei materiali forniti.
- Inserisci le parole chiave su una nuova riga finale con la formula: "Parole chiave:".
- Restituisci solo l'abstract finale.`,

    chapter_draft: `Scrivi il capitolo richiesto in modo accademico, chiaro e sviluppato sulla base dei soli dati ricevuti.
- Non inventare autori, teorie, anni, enti, statistiche o riferimenti bibliografici non inclusi nei dati.
- Se i dati non forniscono riferimenti specifici, mantieni il discorso su piano concettuale generale senza attribuzioni puntuali.
- Sviluppa davvero ogni sottocapitolo con paragrafi sostanziosi, evitando sezioni scarne o solo introduttive.
- Non aggiungere sezioni finali artificiali come "Analisi critica", "Raccordo verso il capitolo successivo", "Sintesi finale" o titoli simili, salvo richiesta esplicita.
- Non chiudere con formule che anticipano esplicitamente il capitolo successivo.
- Restituisci solo il capitolo finale.`,

    outline_review: `Revisiona criticamente l'indice ricevuto.
- Evidenzia solo problemi reali di struttura, equilibrio o coerenza.
- Proponi poi una versione migliorata.
- Non introdurre contenuti disciplinari non presenti nei dati.`,

    abstract_review: `Revisiona criticamente l'abstract ricevuto.
- Migliora chiarezza, ordine logico e pulizia formale.
- Assicurati che la riga "Parole chiave:" sia separata dal corpo del testo.
- Non introdurre fonti, dati o riferimenti non forniti.`,

    chapter_review: `Revisiona il capitolo ricevuto come farebbe un correttore accademico esigente, non cosmetico.
- Devi produrre una revisione percepibilmente migliore del testo di partenza, non una semplice ripulitura stilistica.
- Intervieni con decisione quando il testo appare troppo introduttivo, manualistico, descrittivo, ridondante o eccessivamente vicino all'indice in prosa.
- Taglia o riscrivi i passaggi che spiegano soltanto cosa farà il capitolo; sostituiscili con sviluppo effettivo del contenuto.
- Riduci parafrasi interne, ripetizioni concettuali, frasi gemelle e richiami inutili agli stessi nuclei teorici.
- Rafforza la funzione specifica di ciascun sottocapitolo: ogni sezione deve far avanzare il ragionamento, non solo esporre nozioni corrette.
- Se il testo resta troppo generale, rendilo più analitico e più aderente al problema specifico della tesi senza inventare contenuti non presenti nei materiali.
- Elimina aperture enfatiche, formulazioni da manuale, chiusure generiche, conclusioni intercambiabili e raccordi deboli.
- Preferisci formulazioni più sobrie, più dense e più argomentative; evita di diluire il testo in spiegazioni ovvie o scolastiche.
- Mantieni contenuto sostanziale, struttura generale, disciplina e headings, ma non essere conservativo quando la qualità richiede una riscrittura più netta di frasi o paragrafi.
- Se trovi affermazioni troppo ampie, indimostrabili o non supportate dai materiali ricevuti, rendile più prudenti invece di ampliarle.
- Non aggiungere fonti, autori, date, norme, sentenze, dati o riferimenti bibliografici non presenti nei materiali forniti.
- Non mostrare diagnosi, commenti redazionali, intestazioni di servizio o spiegazioni del lavoro svolto.
- Restituisci solo il capitolo revisionato finale, pronto da usare.`,

    tutor_revision: `Applica in modo rigoroso le osservazioni del relatore o tutor al testo ricevuto.
- Intervieni in modo conservativo.
- Non aggiungere contenuti non richiesti.
- Non introdurre fonti o riferimenti non presenti nei dati.
- Restituisci solo il testo revisionato.`,

    final_consistency_review: `Esegui un controllo finale di coerenza complessiva sull'elaborato ricevuto.
- Verifica coerenza tra indice, abstract e capitoli.
- Segnala ripetizioni, salti logici, incongruenze terminologiche e raccordi artificiali.
- Evidenzia se compaiono riferimenti specifici non supportati dai dati forniti.
- Struttura l'output in: criticità ad alta priorità, criticità medie, osservazioni finali.`
  };

  return `${map[task] || 'Elabora il contenuto ricevuto in modo utile, coerente e prudente.'}\n\nDATI FORNITI DALL'UTENTE:\n${payload}`;
}

function extractOpenAIText(data) {
  try {
    if (!data || !Array.isArray(data.output)) return '';

    return data.output
      .flatMap(item => item.content || [])
      .map(part => part.text || '')
      .join('\n')
      .trim();
  } catch {
    return '';
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Timeout provider dopo ${Math.round(timeoutMs / 1000)} secondi`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function simplifyProviderError(data) {
  if (!data) return 'Errore provider non dettagliato';
  if (typeof data === 'string') return data;
  if (data.error?.message) return data.error.message;
  if (data.message) return data.message;

  try {
    return JSON.stringify(data);
  } catch {
    return 'Errore provider non serializzabile';
  }
}
