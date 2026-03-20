const OPENAI_TIMEOUT_MS = 90000;
const ANTHROPIC_TIMEOUT_MS = 90000;

const GENERAL_SYSTEM_PROMPT = `Sei un assistente accademico rigoroso, prudente e professionale.

Regole permanenti:
- lavora solo sui dati effettivamente forniti;
- quando nei dati compaiono facoltà, corso di laurea, settore disciplinare, area scientifica o taglio metodologico, trattali come vincoli sostanziali e non come semplici etichette decorative;
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

const TASK_ALIASES = {
  title_suggestion: 'title_suggestions',
  title: 'title_suggestions',
  titles: 'title_suggestions',
  thesis_title_suggestions: 'title_suggestions',
  thesis_titles: 'title_suggestions'
};

const OPENAI_TASK_CONFIG = {
  title_suggestions: {
    max_output_tokens: 900
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
    const { task, input } = normalizeBody(req.body);

    if (!task) {
      return res.status(400).json({ error: 'Task mancante' });
    }

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

function normalizeBody(body) {
  const safe = body && typeof body === 'object' ? body : {};
  const rawTask = typeof safe.task === 'string' ? safe.task.trim() : '';
  const task = normalizeTask(rawTask);

  const rawInput =
    safe.input !== undefined
      ? safe.input
      : safe.payload !== undefined
        ? safe.payload
        : safe.content !== undefined
          ? safe.content
          : {};

  const input = normalizeInput(rawInput);

  return { task, input };
}

function normalizeInput(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const parsed = tryParseJson(trimmed);
    return parsed ?? value;
  }
  if (typeof value === 'object') {
    return value;
  }
  return String(value);
}

function tryParseJson(value) {
  if (!value || typeof value !== 'string') return null;
  const first = value[0];
  if (first !== '{' && first !== '[') return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeTask(task) {
  if (!task) return '';
  const normalized = task.trim().toLowerCase();
  return TASK_ALIASES[normalized] || normalized;
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
  const taskConfig = OPENAI_TASK_CONFIG[task] || {};

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
        input: prompt,
        ...(taskConfig.max_output_tokens ? { max_output_tokens: taskConfig.max_output_tokens } : {})
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
    text
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
  const parsedInput = coerceObject(input);
  const payload = typeof input === 'string' ? input : serializeInput(input);

  const map = {
    title_suggestions: buildTitleSuggestionsPrompt(parsedInput, payload),

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

    chapter_review: `Revisiona criticamente il capitolo ricevuto.
- Controlla coerenza logica, chiarezza, precisione terminologica e densità argomentativa.
- Segnala se il testo introduce autori, teorie, dati, enti o riferimenti non presenti nei materiali di partenza.
- Elimina eventuali chiusure artificiali o raccordi espliciti al capitolo successivo.
- Mantieni un'impostazione conservativa: modifica solo ciò che è necessario.
- Struttura l'output in tre parti: criticità rilevate, interventi prioritari, testo revisionato.`,

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

function buildTitleSuggestionsPrompt(parsedInput, payload) {
  const disciplineBlock = buildDisciplineSummary(parsedInput);
  const existingTitle = extractFirstString(parsedInput, [
    'existingTitle',
    'existing_title',
    'proposedTitle',
    'proposed_title',
    'workingTitle',
    'working_title',
    'titleDraft',
    'title_draft',
    'candidateTitle',
    'candidate_title',
    'titolo',
    'titoloProposto',
    'titolo_proposto'
  ]);

  const topic = extractFirstString(parsedInput, [
    'topic',
    'thesisTopic',
    'thesis_topic',
    'subject',
    'argomento',
    'argomentoTesi',
    'argomento_tesi'
  ]);

  const methodology = extractFirstString(parsedInput, [
    'methodology',
    'methodologicalApproach',
    'methodological_approach',
    'approach',
    'approccioMetodologico',
    'approccio_metodologico'
  ]);

  return `Devi valutare in modo rigoroso la compatibilità tra argomento della tesi, facoltà, corso di laurea e eventuale taglio metodologico, e solo dopo decidere se proporre titoli.

Regole vincolanti:
- Facoltà e corso di laurea sono vincoli disciplinari sostanziali, non etichette decorative.
- Non trasformare un titolo nato in un dominio in un titolo di un altro dominio sostituendo solo il nome della disciplina o del corso.
- Se l'argomento appartiene in modo prevalente a una disciplina diversa da quella selezionata e non è ragionevolmente riformulabile nel dominio indicato, non generare titoli fittizi.
- Se la compatibilità è debole ma recuperabile, puoi generare titoli solo dopo avere rifocalizzato davvero il problema di ricerca nella prospettiva disciplinare selezionata.
- Se è presente un titolo già pronto, trattalo come proposta preliminare da valutare criticamente: non assumerlo come corretto in automatico.
- Ogni titolo proposto deve essere plausibile davanti a un relatore della facoltà selezionata e deve far percepire davvero l'ancoraggio disciplinare.
- Evita lessico di discipline estranee al percorso selezionato, salvo che sia motivato da un reale approccio interdisciplinare emergente dai dati.
- Evita titoli sensazionalistici, editoriali, vaghi, ridondanti o costruiti per semplice sostituzione terminologica.
- Ogni titolo deve iniziare con la maiuscola corretta.

Criterio di uscita obbligatorio:
- Se la combinazione tra argomento e percorso di studi è sostanzialmente incompatibile, restituisci una sola riga che inizi esattamente con: "AVVISO:".
  In quella riga spiega in modo chiaro e breve perché la combinazione non è coerente e invita a riformulare l'argomento oppure a modificare facoltà/corso.
- Se la combinazione è solo parzialmente compatibile ma recuperabile, restituisci prima una riga che inizi esattamente con: "AVVISO:" e poi 5 titoli realmente rifocalizzati nel dominio corretto.
- Se la combinazione è coerente, restituisci 5 titoli, uno per riga, senza numerazione e senza commenti.
- Non restituire mai titoli quasi identici tra loro.
- Non restituire mai titoli che potrebbero funzionare quasi uguali in una facoltà molto diversa.

Vincoli da usare per la valutazione:
${disciplineBlock}
Argomento dichiarato: ${topic || 'non specificato'}
Approccio metodologico dichiarato: ${methodology || 'non specificato'}
Titolo già proposto: ${existingTitle || 'non presente'}

Restituisci solo il risultato finale nel formato richiesto.`;
}

function buildDisciplineSummary(input) {
  const degreeType = extractFirstString(input, [
    'degreeType',
    'degree_type',
    'tipoLaurea',
    'tipo_laurea',
    'laurea'
  ]);

  const faculty = extractFirstString(input, [
    'faculty',
    'facolta',
    'facoltà',
    'department',
    'area'
  ]);

  const course = extractFirstString(input, [
    'degreeCourse',
    'degree_course',
    'course',
    'corsoDiLaurea',
    'corso_di_laurea',
    'corso'
  ]);

  const field = extractFirstString(input, [
    'disciplinaryField',
    'disciplinary_field',
    'sector',
    'ssd',
    'settoreDisciplinare',
    'settore_disciplinare'
  ]);

  return [
    `Tipo di laurea: ${degreeType || 'non specificato'}`,
    `Facoltà: ${faculty || 'non specificata'}`,
    `Corso di laurea: ${course || 'non specificato'}`,
    `Settore disciplinare: ${field || 'non specificato'}`
  ].join('\n');
}

function coerceObject(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  if (typeof input === 'string') {
    const parsed = tryParseJson(input.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }
  return null;
}

function extractFirstString(input, keys) {
  if (!input || typeof input !== 'object') return '';

  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function serializeInput(input) {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input ?? {}, null, 2);
  } catch {
    return String(input ?? '');
  }
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
