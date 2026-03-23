const OPENAI_TIMEOUT_MS = 120000;
const ANTHROPIC_TIMEOUT_MS = 120000;

const GENERAL_SYSTEM_PROMPT = `Sei un assistente accademico italiano per tesi universitarie.

REGOLE VINCOLANTI:
- scrivi sempre in italiano accademico formale, chiaro e sobrio;
- non inventare mai autori, titoli, anni, DOI, dati, enti, norme, sentenze o riferimenti bibliografici non presenti nei materiali forniti;
- se i materiali non contengono riferimenti verificabili sufficienti, mantieni formulazioni prudenti o neutre;
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
  if (req.method === 'GET' && req.query?.config === 'supabase') {
    return handleSupabaseConfig(res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const task = typeof body.task === 'string' ? body.task.trim() : '';

    if (!task) {
      return res.status(400).json({ error: 'Task mancante' });
    }

    if (task === 'cloud_save_state') {
      return await handleCloudSave({ req, res, body });
    }

    if (task === 'cloud_load_state') {
      return await handleCloudLoad({ req, res });
    }

    const { input } = normalizeBody(body);
    const provider = pickProvider(task);

    if (provider === 'openai') {
      return await handleOpenAI({ task, input, res });
    }

    return await handleAnthropic({ task, input, res });
  } catch (error) {
    return res.status(500).json({
      error: 'Errore interno',
      details: error?.message || 'Errore sconosciuto'
    });
  }
}

function handleSupabaseConfig(res) {
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !publishableKey) {
    return res.status(500).json({ error: 'Configurazione Supabase mancante' });
  }

  return res.status(200).json({ url, publishableKey });
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

async function handleOpenAI({ task, input, res }) {
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
    sources: []
  });
}

async function handleAnthropic({ task, input, res }) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  if (!anthropicKey) {
    return await handleOpenAIFallback({ task, input, res, reason: 'ANTHROPIC_API_KEY non configurata' });
  }

  const prompt = buildPrompt(task, input);

  try {
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
      const details = simplifyProviderError(data);
      if (shouldFallbackToOpenAI(response.status, details, task)) {
        return await handleOpenAIFallback({ task, input, res, reason: details });
      }

      return res.status(response.status).json({
        error: 'Errore Anthropic',
        details
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
      text: text || 'Nessun contenuto restituito',
      sources: []
    });
  } catch (error) {
    if (shouldFallbackToOpenAI(504, error?.message || '', task)) {
      return await handleOpenAIFallback({ task, input, res, reason: error?.message || 'Timeout provider' });
    }
    throw error;
  }
}

async function handleOpenAIFallback({ task, input, res, reason }) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return res.status(504).json({
      error: 'Timeout provider',
      details: reason || 'Il provider principale non ha risposto in tempo e il fallback non è disponibile.'
    });
  }
  return await handleOpenAI({ task, input, res });
}

function shouldFallbackToOpenAI(status, details, task) {
  const fallbackTasks = new Set(['chapter_draft', 'chapter_review', 'tutor_revision']);
  if (!fallbackTasks.has(task)) return false;
  const text = (details || '').toLowerCase();
  return status >= 500 || text.includes('timeout') || text.includes('overloaded') || text.includes('rate limit') || text.includes('capacity');
}

async function handleCloudSave({ req, res, body }) {
  const state = body?.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return res.status(400).json({ error: 'State mancante o non valida' });
  }

  const runtime = getSupabaseRuntime();
  const auth = await resolveSupabaseUser(req, runtime);
  const tables = getStateTableCandidates();
  let lastFailure = null;

  for (const table of tables) {
    const result = await upsertUserState({ runtime, auth, table, state });
    if (result.ok) {
      return res.status(200).json({ ok: true, table, updated_at: new Date().toISOString() });
    }
    lastFailure = result;
    if (!result.retryable) break;
  }

  return res.status(lastFailure?.status || 500).json({
    error: 'Salvataggio cloud non riuscito',
    details: lastFailure?.details || 'Verifica tabella/policy Supabase per lo stato utente.'
  });
}

async function handleCloudLoad({ req, res }) {
  const runtime = getSupabaseRuntime();
  const auth = await resolveSupabaseUser(req, runtime);
  const tables = getStateTableCandidates();
  let lastFailure = null;

  for (const table of tables) {
    const result = await loadUserState({ runtime, auth, table });
    if (result.ok) {
      return res.status(200).json({ ok: true, table, state: result.state || null, updated_at: result.updatedAt || null });
    }
    lastFailure = result;
    if (!result.retryable) break;
  }

  if (lastFailure?.status === 404) {
    return res.status(200).json({ ok: true, state: null, updated_at: null });
  }

  return res.status(lastFailure?.status || 500).json({
    error: 'Lettura cloud non riuscita',
    details: lastFailure?.details || 'Verifica tabella/policy Supabase per lo stato utente.'
  });
}

function getSupabaseRuntime() {
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

  if (!url || !publishableKey) {
    throw new Error('Configurazione Supabase mancante');
  }

  return { url, publishableKey, serviceRoleKey };
}

function getStateTableCandidates() {
  const raw = [
    process.env.SUPABASE_STATE_TABLE,
    'accademia_user_states',
    'accademia_states',
    'thesis_states',
    'user_states'
  ].filter(Boolean);
  return [...new Set(raw)];
}

async function resolveSupabaseUser(req, runtime) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  if (!match) {
    throw new HttpError(401, 'Token account mancante');
  }

  const token = match[1].trim();
  const response = await fetchWithTimeout(
    `${runtime.url}/auth/v1/user`,
    {
      method: 'GET',
      headers: {
        apikey: runtime.publishableKey,
        Authorization: `Bearer ${token}`
      }
    },
    20000
  );

  const data = await safeJson(response);
  if (!response.ok || !data?.id) {
    throw new HttpError(401, simplifyProviderError(data) || 'Sessione account non valida');
  }

  return { token, user: data };
}

async function upsertUserState({ runtime, auth, table, state }) {
  const url = `${runtime.url}/rest/v1/${encodeURIComponent(table)}?on_conflict=user_id`;
  const headers = buildRestHeaders(runtime, auth.token, true);
  headers.Prefer = 'resolution=merge-duplicates,return=representation';

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify([{ user_id: auth.user.id, state, updated_at: new Date().toISOString() }])
    },
    30000
  );

  const data = await safeJson(response);
  if (response.ok) {
    return { ok: true };
  }

  return classifyStateFailure(response.status, data);
}

async function loadUserState({ runtime, auth, table }) {
  const url = `${runtime.url}/rest/v1/${encodeURIComponent(table)}?user_id=eq.${encodeURIComponent(auth.user.id)}&select=state,updated_at&limit=1`;
  const response = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: buildRestHeaders(runtime, auth.token, true)
    },
    30000
  );

  const data = await safeJson(response);
  if (response.ok) {
    const row = Array.isArray(data) ? data[0] : null;
    return { ok: true, state: row?.state || null, updatedAt: row?.updated_at || null };
  }

  return classifyStateFailure(response.status, data, true);
}

function buildRestHeaders(runtime, token, preferService = false) {
  const useService = preferService && !!runtime.serviceRoleKey;
  return {
    'Content-Type': 'application/json',
    apikey: useService ? runtime.serviceRoleKey : runtime.publishableKey,
    Authorization: `Bearer ${useService ? runtime.serviceRoleKey : token}`
  };
}

function classifyStateFailure(status, data, isLoad = false) {
  const details = simplifyProviderError(data);
  const low = (details || '').toLowerCase();
  const retryable =
    status === 404 ||
    low.includes('relation') ||
    low.includes('schema cache') ||
    low.includes('does not exist') ||
    low.includes('column') ||
    low.includes('not found');

  if (isLoad && status === 406) {
    return { ok: true, state: null, updatedAt: null };
  }

  return {
    ok: false,
    status,
    details,
    retryable
  };
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
- Intervieni in modo conservativo ma reale: recepisci le osservazioni e riscrivi dove serve.
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
  if (typeof data.error === 'string') return data.error;

  try {
    return JSON.stringify(data);
  } catch {
    return 'Errore provider non serializzabile';
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
