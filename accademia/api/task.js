const OPENAI_TIMEOUT_MS = 180000;
const ANTHROPIC_TIMEOUT_MS = 180000;
const STATE_TTL_SECONDS = 60 * 60 * 24 * 180;
const VISIT_GUARD_TTL_SECONDS = 60 * 60 * 24 * 2;
const CODE_TTL_SECONDS = 60 * 60 * 24 * 365;

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
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = getAction(req, body);

    if (action) {
      return await handleAction({ action, req, res, body });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { task, input } = normalizeBody(body);

    if (!task) {
      return res.status(400).json({ error: 'Task mancante' });
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

function getAction(req, body) {
  const queryAction = typeof req.query?.action === 'string' ? req.query.action.trim() : '';
  const bodyAction = typeof body.action === 'string' ? body.action.trim() : '';
  return bodyAction || queryAction || '';
}

async function handleAction({ action, req, res, body }) {
  switch (action) {
    case 'state_save': {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const workspaceId = normalizeWorkspaceId(body.workspaceId);
      const state = body.state;
      if (!workspaceId || !state || typeof state !== 'object') {
        return res.status(400).json({ error: 'workspaceId o state mancanti' });
      }
      const payload = {
        ...state,
        workspaceId,
        savedAt: state.savedAt || new Date().toISOString(),
        serverSavedAt: new Date().toISOString()
      };
      await saveWorkspaceState(workspaceId, payload);
      return res.status(200).json({ ok: true, workspaceId, savedAt: payload.serverSavedAt });
    }

    case 'state_load': {
      const workspaceId = normalizeWorkspaceId(body.workspaceId || req.query?.workspaceId);
      if (!workspaceId) {
        return res.status(400).json({ error: 'workspaceId mancante' });
      }
      const state = await loadWorkspaceState(workspaceId);
      return res.status(200).json({ ok: true, workspaceId, state });
    }

    case 'track_visit': {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const path = normalizePath(body.path);
      const sessionKey = normalizeVisitKey(body.sessionKey);
      const tracked = await trackVisit(path, sessionKey);
      return res.status(200).json({ ok: true, tracked });
    }

    case 'unlock_verify': {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const code = String(body.code || '').trim().toUpperCase();
      if (!code) {
        return res.status(400).json({ valid: false, reason: 'missing_code' });
      }
      const result = await verifyAndConsumeUnlockCode(code);
      const status = result.valid ? 200 : 400;
      return res.status(status).json(result);
    }

    default:
      return res.status(400).json({ error: 'Azione non supportata' });
  }
}

function normalizeWorkspaceId(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizePath(value) {
  const path = String(value || '/').trim();
  return path.startsWith('/') ? path : `/${path}`;
}

function normalizeVisitKey(value) {
  return String(value || '').trim().slice(0, 120);
}

async function saveWorkspaceState(workspaceId, state) {
  const key = `accademia:workspace:${workspaceId}:state`;
  await upstashCommand(['SET', key, JSON.stringify(state), 'EX', String(STATE_TTL_SECONDS)]);
}

async function loadWorkspaceState(workspaceId) {
  const key = `accademia:workspace:${workspaceId}:state`;
  const raw = await upstashCommand(['GET', key]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function trackVisit(path, sessionKey) {
  let shouldCount = true;

  if (sessionKey) {
    const guardKey = `accademia:visitguard:${sessionKey}`;
    const guardResult = await upstashCommand(['SET', guardKey, '1', 'EX', String(VISIT_GUARD_TTL_SECONDS), 'NX']);
    shouldCount = guardResult === 'OK';
  }

  if (!shouldCount) return false;

  await upstashCommand(['INCR', 'accademia:visits:total']);
  await upstashCommand(['INCR', `accademia:visits:path:${path}`]);
  return true;
}

async function verifyAndConsumeUnlockCode(code) {
  const catalog = parseUnlockCatalog(process.env.ACC_UNLOCK_CODES_JSON || process.env.UNLOCK_CODES_JSON || '');
  const match = catalog[code];

  if (!match) {
    return { valid: false, reason: 'not_found' };
  }

  const usedKey = `accademia:unlock:used:${code}`;
  const setResult = await upstashCommand(['SET', usedKey, '1', 'EX', String(CODE_TTL_SECONDS), 'NX']);

  if (setResult !== 'OK') {
    return { valid: false, reason: 'already_used' };
  }

  return { valid: true, type: match.type || 'premium' };
}

function parseUnlockCatalog(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.reduce((acc, item) => {
        if (!item) return acc;
        const code = String(item.code || '').trim().toUpperCase();
        if (!code) return acc;
        acc[code] = { type: String(item.type || 'premium').trim().toLowerCase() || 'premium' };
        return acc;
      }, {});
    }
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed).reduce((acc, [key, value]) => {
        const code = String(key || '').trim().toUpperCase();
        if (!code) return acc;
        if (value && typeof value === 'object') {
          acc[code] = { type: String(value.type || 'premium').trim().toLowerCase() || 'premium' };
        } else {
          acc[code] = { type: String(value || 'premium').trim().toLowerCase() || 'premium' };
        }
        return acc;
      }, {});
    }
  } catch {
    return {};
  }
  return {};
}

async function upstashCommand(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL o UPSTASH_REDIS_REST_TOKEN mancanti');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(command)
  });

  const data = await safeJson(response);

  if (!response.ok) {
    throw new Error(data?.error || `Errore Upstash HTTP ${response.status}`);
  }

  if (data?.error) {
    throw new Error(data.error);
  }

  return data?.result ?? null;
}

function normalizeBody(body) {
  const safe = body && typeof body === 'object' ? body : {};
  const task = typeof safe.task === 'string' ? safe.task.trim() : '';
  const input =
    typeof safe.input === 'string'
      ? safe.input
      : typeof safe.payload === 'string'
        ? safe.payload
        : typeof safe.content === 'string'
          ? safe.content
          : JSON.stringify(safe.input ?? safe.payload ?? safe.content ?? {}, null, 2);

  return { task, input };
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
