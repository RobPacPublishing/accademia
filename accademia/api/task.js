const OPENAI_DEFAULT_TIMEOUT_MS = 70000;
const ANTHROPIC_DEFAULT_TIMEOUT_MS = 100000;

const TASK_ALIASES = {
  outline: 'outline_draft',
  outline_generate: 'outline_draft',
  index_draft: 'outline_draft',
  thesis_outline: 'outline_draft',
  abstract: 'abstract_draft',
  abstract_generate: 'abstract_draft',
  thesis_abstract: 'abstract_draft',
  chapter: 'chapter_draft',
  chapter_generate: 'chapter_draft',
  chapter_revision: 'chapter_review',
  chapter_edit: 'chapter_review',
  tutor_review: 'tutor_revision',
  supervisor_revision: 'tutor_revision',
  final_check: 'final_consistency_review',
  final_review: 'final_consistency_review',
  title_suggestion: 'title_suggestions',
  suggested_titles: 'title_suggestions',
  thesis_title_suggestions: 'title_suggestions'
};

const ACADEMIC_SYSTEM_PROMPT = `Sei un assistente accademico per la redazione di tesi universitarie.

Regole permanenti:
- lavora esclusivamente sui materiali ricevuti dal frontend;
- non inventare fonti, autori, dati, teorie, anni, citazioni, risultati empirici, riferimenti normativi o bibliografici non presenti nei dati;
- se i materiali sono incompleti o ambigui, mantieni formulazioni prudenti e non colmare i vuoti per inferenza;
- non dichiarare verifiche esterne, ricerche in letteratura o consultazioni di banche dati se non sono state fornite nei materiali;
- non usare formule meta che svelino la generazione automatica;
- mantieni tono universitario sobrio, preciso, coerente, non enfatico;
- privilegia rigore argomentativo, chiarezza logica, continuità espositiva e controllo terminologico;
- se devi revisionare un testo, intervieni in modo conservativo e non riscrivere inutilmente ciò che è già adeguato;
- se nei materiali sono presenti titoli o intestazioni da mantenere, rispettali.`;

const TASK_PROFILES = {
  outline_draft: {
    provider: 'openai',
    maxOutputTokens: 2200,
    timeoutMs: 65000,
    temperature: 0.2,
    prompt: `Compito: costruire un indice di tesi accademicamente solido.

Obiettivo:
- proporre una struttura ordinata, progressiva e difendibile in sede universitaria;
- evitare capitoli sovrapposti, titoli vaghi, duplicazioni semantiche e sequenze poco logiche;
- fare emergere con chiarezza la traiettoria dell'elaborato: quadro teorico, sviluppo analitico, eventuale parte metodologica o applicativa, chiusura finale.

Istruzioni operative:
- usa solo le informazioni contenute nei materiali ricevuti;
- se i materiali forniscono già nuclei tematici o capitoli abbozzati, riorganizzali senza tradirne il senso;
- se il tema lo consente, includi introduzione, capitoli principali, conclusioni e bibliografia; non forzare però una struttura standard quando i materiali indicano chiaramente un'altra soluzione;
- assegna ai capitoli e ai sottoparagrafi titoli specifici, professionali e non ridondanti;
- mantieni un equilibrio realistico tra ampiezza dei capitoli e granularità dei sottoparagrafi;
- non inserire note esplicative, commenti, premesse o giustificazioni.

Output richiesto:
- restituisci solo l'indice finale, già pulito e pronto da usare.`
  },
  outline_review: {
    provider: 'openai',
    maxOutputTokens: 2600,
    timeoutMs: 65000,
    temperature: 0.15,
    prompt: `Compito: revisionare criticamente un indice di tesi.

Obiettivo:
- verificare coerenza, equilibrio, progressione logica e tenuta accademica della struttura proposta.

Istruzioni operative:
- segnala solo criticità reali: ridondanze, lacune, salti logici, squilibri tra capitoli, titoli troppo generici o troppo simili;
- non introdurre contenuti disciplinari non supportati dai materiali;
- non trasformare la revisione in una spiegazione teorica del tema.

Output richiesto:
- organizza la risposta in due sezioni con questi titoli esatti:
Criticità rilevate
Versione migliorata
- nella seconda sezione restituisci l'indice revisionato, pronto da usare.`
  },
  abstract_draft: {
    provider: 'openai',
    maxOutputTokens: 1200,
    timeoutMs: 60000,
    temperature: 0.2,
    prompt: `Compito: redigere un abstract accademico professionale.

Obiettivo:
- sintetizzare in forma continua tema, fuoco dell'elaborato, eventuale domanda di ricerca, percorso argomentativo e valore del lavoro senza enfasi e senza formule pubblicitarie.

Istruzioni operative:
- usa esclusivamente i dati ricevuti;
- se i materiali non contengono metodo, risultati o corpus specifici, non inventarli;
- mantieni uno stile compatto, chiaro e universitario;
- evita elenchi puntati, titoletti interni, formule meta o chiusure scolastiche.

Output richiesto:
- restituisci solo l'abstract finale;
- su una nuova riga finale aggiungi: Parole chiave: ...` 
  },
  abstract_review: {
    provider: 'openai',
    maxOutputTokens: 1400,
    timeoutMs: 60000,
    temperature: 0.15,
    prompt: `Compito: revisionare un abstract di tesi.

Obiettivo:
- migliorarne chiarezza, ordine logico, precisione lessicale e pulizia formale.

Istruzioni operative:
- conserva il contenuto sostanziale già valido;
- elimina ridondanze, vaghezze, enfasi improprie e formulazioni poco accademiche;
- non aggiungere fonti, dati o riferimenti non forniti;
- assicurati che la riga finale "Parole chiave:" sia separata dal corpo del testo.

Output richiesto:
- restituisci solo la versione revisionata dell'abstract.`
  },
  title_suggestions: {
    provider: 'openai',
    maxOutputTokens: 700,
    timeoutMs: 45000,
    temperature: 0.35,
    prompt: `Compito: generare titoli di tesi credibili, distinti e accademicamente maturi.

Obiettivo:
- proporre titoli che suonino universitari, specifici e non banali;
- evitare titoli quasi identici tra loro o mera ripetizione dell'argomento grezzo.

Istruzioni operative:
- usa solo i materiali forniti;
- se i dati non impongono un sottotitolo, valuta liberamente se usarlo oppure no;
- varia davvero taglio, fuoco e costruzione sintattica;
- evita titoli sensazionalistici, vaghi, generici o eccessivamente creativi;
- ogni titolo deve iniziare con la maiuscola corretta.

Output richiesto:
- restituisci 10 proposte, una per riga, senza numerazione e senza commenti.`
  },
  chapter_draft: {
    provider: 'anthropic',
    maxOutputTokens: 7000,
    timeoutMs: 120000,
    prompt: `Compito: redigere un capitolo o sottocapitolo di tesi con qualità accademica alta e andamento espositivo maturo.

Obiettivo:
- produrre un testo realmente sviluppato, non schematico, con progressione logica interna, paragrafi sostanziosi e continuità argomentativa;
- mantenere coerenza con i materiali ricevuti e con l'eventuale titolo o sottotitolo della sezione.

Istruzioni operative:
- sviluppa il contenuto richiesto in forma discorsiva e rigorosa;
- non inventare apparati teorici, riferimenti bibliografici o dati empirici;
- se i materiali forniscono riferimenti incompleti, mantieni formulazioni prudenti senza completarli arbitrariamente;
- non trasformare il capitolo in una lista di definizioni o autori;
- evita aperture scolastiche, chiusure artificiali, promesse sul capitolo successivo, formule come "in conclusione" usate in modo meccanico o sezioni-cuscinetto prive di valore;
- se i materiali contengono una struttura interna precisa, rispettala;
- se il task riguarda una sola sezione, scrivi solo quella sezione;
- non aggiungere bibliografia, note, appendici o titoli ulteriori non richiesti.

Output richiesto:
- restituisci solo il testo finale del capitolo o della sezione richiesta.`
  },
  chapter_review: {
    provider: 'anthropic',
    maxOutputTokens: 6500,
    timeoutMs: 110000,
    prompt: `Compito: revisionare un capitolo di tesi in modo professionale.

Obiettivo:
- migliorare tenuta argomentativa, pulizia formale, coerenza terminologica e qualità accademica senza alterare inutilmente il testo.

Istruzioni operative:
- individua incoerenze logiche, ridondanze, passaggi deboli, slittamenti di registro, ripetizioni e formulazioni poco precise;
- segnala se compaiono autori, teorie, dati, citazioni o riferimenti specifici non supportati dai materiali di base;
- elimina raccordi artificiali e chiusure meccaniche;
- intervieni in modo conservativo: non fare una riscrittura cosmetica totale se non necessaria.

Output richiesto:
- organizza la risposta in tre sezioni con questi titoli esatti:
Criticità rilevate
Interventi prioritari
Testo revisionato` 
  },
  tutor_revision: {
    provider: 'anthropic',
    maxOutputTokens: 6500,
    timeoutMs: 110000,
    prompt: `Compito: applicare le osservazioni del relatore o tutor a un testo accademico.

Obiettivo:
- recepire le indicazioni in modo rigoroso, puntuale e non arbitrario;
- migliorare il testo senza introdurre aggiunte estranee alle richieste.

Istruzioni operative:
- distingui chiaramente tra ciò che è chiesto dal tutor e ciò che non lo è;
- intervieni solo dove serve;
- mantieni struttura, ordine e impostazione del testo salvo indicazioni contrarie presenti nei materiali;
- non introdurre nuove fonti, nuovi dati o nuove attribuzioni non fornite.

Output richiesto:
- restituisci solo il testo revisionato finale.`
  },
  final_consistency_review: {
    provider: 'anthropic',
    maxOutputTokens: 3200,
    timeoutMs: 110000,
    prompt: `Compito: eseguire il controllo finale di coerenza di un elaborato di tesi.

Obiettivo:
- verificare tenuta complessiva tra indice, abstract, capitoli e conclusioni, intercettando criticità che compromettono qualità, continuità o credibilità accademica.

Istruzioni operative:
- controlla coerenza tra promessa iniziale e sviluppo reale del testo;
- segnala ripetizioni importanti, sovrapposizioni tra capitoli, salti logici, oscillazioni terminologiche, incongruenze tra indice e contenuto;
- evidenzia eventuali riferimenti specifici non supportati dai dati forniti;
- non proporre micro-correzioni di stile irrilevanti: concentrati su problemi reali e prioritari.

Output richiesto:
- organizza la risposta in tre sezioni con questi titoli esatti:
Criticità ad alta priorità
Criticità medie
Osservazioni finali` 
  }
};

export default async function handler(req, res) {
  if (req.method === 'GET' && req.query?.config === 'supabase') {
    const url = process.env.SUPABASE_URL;
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!url || !publishableKey) {
      return res.status(500).json({ error: 'Configurazione Supabase mancante' });
    }

    return res.status(200).json({ url, publishableKey });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const normalized = normalizeRequest(req.body);

    if (!normalized.task) {
      return res.status(400).json({ error: 'Task mancante' });
    }

    if (!normalized.input) {
      return res.status(400).json({ error: 'Input mancante' });
    }

    const canonicalTask = canonicalizeTask(normalized.task);
    const profile = TASK_PROFILES[canonicalTask];

    if (!profile) {
      return res.status(400).json({
        error: 'Task non supportato',
        details: `Task ricevuto: ${normalized.task}`
      });
    }

    const prompt = buildPrompt(canonicalTask, normalized.input);

    if (profile.provider === 'openai') {
      return await handleOpenAI({ res, canonicalTask, prompt, profile });
    }

    return await handleAnthropic({ res, canonicalTask, prompt, profile });
  } catch (error) {
    return res.status(500).json({
      error: 'Errore interno',
      details: error?.message || 'Errore sconosciuto'
    });
  }
}

function normalizeRequest(body) {
  const safe = body && typeof body === 'object' ? body : {};
  const task = typeof safe.task === 'string' ? safe.task.trim() : '';
  const rawInput = pickFirstDefined([
    safe.input,
    safe.payload,
    safe.content,
    typeof body === 'string' ? body : undefined
  ]);

  return {
    task,
    input: serializeInput(rawInput)
  };
}

function pickFirstDefined(values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function serializeInput(value) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return '';
}

function canonicalizeTask(task) {
  return TASK_ALIASES[task] || task;
}

function buildPrompt(task, input) {
  const profile = TASK_PROFILES[task];

  return [
    profile.prompt,
    'Materiali forniti dal frontend:',
    input
  ].join('\n\n');
}

async function handleOpenAI({ res, canonicalTask, prompt, profile }) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL_ACADEMIC || process.env.OPENAI_MODEL || 'gpt-5.4';

  if (!openaiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY non configurata' });
  }

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
        instructions: ACADEMIC_SYSTEM_PROMPT,
        input: prompt,
        text: {
          format: {
            type: 'text'
          }
        },
        max_output_tokens: profile.maxOutputTokens,
        temperature: profile.temperature,
        truncation: 'disabled',
        prompt_cache_key: `accademia:${canonicalTask}:v2`
      })
    },
    profile.timeoutMs || OPENAI_DEFAULT_TIMEOUT_MS
  );

  const data = await safeJson(response);

  if (!response.ok) {
    return res.status(response.status).json({
      error: 'Errore OpenAI',
      details: simplifyProviderError(data)
    });
  }

  const text = data?.output_text || extractOpenAIText(data) || '';

  return res.status(200).json(buildSuccessPayload({
    task: canonicalTask,
    text: text || 'Nessun contenuto restituito',
    provider: 'openai',
    model: openaiModel
  }));
}

async function handleAnthropic({ res, canonicalTask, prompt, profile }) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const anthropicModel = process.env.ANTHROPIC_MODEL_LONGFORM || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  if (!anthropicKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurata' });
  }

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
        system: ACADEMIC_SYSTEM_PROMPT,
        max_tokens: profile.maxOutputTokens,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    },
    profile.timeoutMs || ANTHROPIC_DEFAULT_TIMEOUT_MS
  );

  const data = await safeJson(response);

  if (!response.ok) {
    return res.status(response.status).json({
      error: 'Errore Anthropic',
      details: simplifyProviderError(data)
    });
  }

  const text = Array.isArray(data?.content)
    ? data.content.map(part => part?.text || '').join('\n').trim()
    : '';

  return res.status(200).json(buildSuccessPayload({
    task: canonicalTask,
    text: text || 'Nessun contenuto restituito',
    provider: 'anthropic',
    model: anthropicModel
  }));
}

function buildSuccessPayload({ task, text, provider, model }) {
  const payload = {
    ok: true,
    task,
    text
  };

  if (process.env.EXPOSE_TASK_DEBUG === '1') {
    payload.debug = {
      provider,
      model
    };
  }

  return payload;
}

function extractOpenAIText(data) {
  try {
    if (!data || !Array.isArray(data.output)) return '';

    return data.output
      .flatMap(item => Array.isArray(item?.content) ? item.content : [])
      .map(part => {
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.output_text === 'string') return part.output_text;
        return '';
      })
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
  if (data.error?.type && data.error?.error?.message) return data.error.error.message;
  if (data.message) return data.message;

  try {
    return JSON.stringify(data);
  } catch {
    return 'Errore provider non serializzabile';
  }
}
