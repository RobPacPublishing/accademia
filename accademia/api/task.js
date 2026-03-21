const DEFAULT_OPENAI_TIMEOUT_MS = 90000;
const DEFAULT_ANTHROPIC_TIMEOUT_MS = 120000;

const GENERAL_SYSTEM_PROMPT = `Sei un assistente accademico universitario rigoroso, prudente e professionale.

Regole permanenti:
- lavora solo sui dati effettivamente forniti;
- non inventare fonti, autori, date, studi, enti, statistiche, risultati di ricerca, teorie specifiche, citazioni, riferimenti normativi o bibliografici non presenti nei dati ricevuti;
- se i dati sono incompleti o ambigui, non colmare i vuoti per inferenza: usa formulazioni prudenti, generali e difendibili;
- non simulare ricerche esterne e non dichiarare di aver consultato letteratura o database se non sono stati forniti;
- mantieni tono universitario sobrio, chiaro, rigoroso e non enfatico;
- evita formule scolastiche o meta come “nel prossimo capitolo”, “di seguito”, “ecco il testo”, “analisi critica” come intestazione separata, salvo richiesta esplicita;
- non aggiungere sezioni artificiali che rendano evidente la generazione automatica;
- privilegia coerenza logica, controllo terminologico, progressione argomentativa e precisione formale.

Regole aggiuntive per i testi lunghi:
- sviluppa davvero i sottocapitoli, evitando paragrafi troppo brevi o schematici;
- non trasformare il testo in una lista di autori o teorie se i dati non li contengono;
- chiudi in modo naturale, senza raccordi espliciti al capitolo successivo.`;

const TASK_ALIASES = {
  outline: 'outline_draft',
  indice: 'outline_draft',
  index: 'outline_draft',
  outline_draft: 'outline_draft',
  outline_review: 'outline_review',
  review_outline: 'outline_review',
  abstract: 'abstract_draft',
  abstract_draft: 'abstract_draft',
  abstract_review: 'abstract_review',
  review_abstract: 'abstract_review',
  chapter: 'chapter_draft',
  chapter_draft: 'chapter_draft',
  draft_chapter: 'chapter_draft',
  chapter_review: 'chapter_review',
  review_chapter: 'chapter_review',
  tutor_revision: 'tutor_revision',
  tutor_review: 'tutor_revision',
  relator_revision: 'tutor_revision',
  final_check: 'final_consistency_review',
  final_review: 'final_consistency_review',
  final_consistency_review: 'final_consistency_review',
  title: 'title_suggestions',
  titles: 'title_suggestions',
  title_suggestion: 'title_suggestions',
  title_suggestions: 'title_suggestions'
};

const TASK_CONFIG = {
  title_suggestions: {
    provider: 'openai',
    maxOutputTokens: 900,
    timeoutMs: DEFAULT_OPENAI_TIMEOUT_MS,
    prompt: `Valuta l'argomento e proponi titoli di tesi universitari disciplinarmente coerenti.
- Tratta facoltà, corso di laurea, approccio metodologico e eventuale titolo già proposto come vincoli sostanziali, non decorativi.
- Se l'argomento è chiaramente incompatibile con facoltà o corso, non fingere coerenza: restituisci una prima riga che inizi con "AVVISO:" spiegando in modo sobrio l'incompatibilità o la compatibilità parziale.
- Se la compatibilità è debole ma recuperabile, dopo l'avviso proponi comunque 5 titoli rifocalizzati nel dominio corretto.
- Se la compatibilità è alta, non inserire avvisi e proponi direttamente 5 titoli.
- I 5 titoli devono essere tra loro realmente distinti per taglio e non semplici parafrasi reciproche.
- Non ripetere meccanicamente la stessa espressione chiave in tutti i titoli; usa parafrasi, focalizzazioni concettuali e incipit diversi.
- Non limitarti a sostituire il nome della disciplina o del corso a un titolo nato per un'altra area.
- Non promettere raccolta dati originale, analisi statistica proprietaria o risultati empirici reali se tali elementi non sono presenti nei dati.
- Restituisci solo l'avviso eventuale e poi 5 titoli, uno per riga, senza commenti aggiuntivi.`
  },
  outline_draft: {
    provider: 'openai',
    maxOutputTokens: 2200,
    timeoutMs: DEFAULT_OPENAI_TIMEOUT_MS,
    prompt: `Costruisci un indice di tesi accademicamente solido, progressivo e difendibile sulla base dei soli dati ricevuti.
- Ogni capitolo deve avere una funzione distinta e riconoscibile; evita capitoli-filtro, capitoli-cerniera e giustapposizioni deboli.
- Non limitarti a cambiare il lessico: cambia davvero l'architettura quando cambiano disciplina, corso o approccio metodologico.
- Non usare come schema implicito sempre la sequenza “quadro teorico → oggetto di analisi → ruolo/funzione → contesti/implicazioni” se non è davvero la migliore per i dati ricevuti.
- Per Filosofia privilegia chiarificazione concettuale, statuto teorico delle categorie, confronto critico e implicazioni sul soggetto o sul riconoscimento; evita impianti psicosociali travestiti.
- Per Psicologia privilegia costrutti, processi, dinamiche relazionali, contesti e implicazioni psicologico-sociali; evita strutture puramente speculative.
- Per Giurisprudenza privilegia fonti, quadro normativo, problemi interpretativi, confronto tra orientamenti e ricadute applicative; evita impianti sociologici generici.
- Per aree tecniche o economiche privilegia parametri, criteri di valutazione, quadri regolativi o di settore, applicazioni e casi; evita impianti da scienze umane.
- L'approccio metodologico deve incidere davvero sulla struttura quando rilevante: comparativa = assi e criteri di confronto; caso studio = delimitazione del caso e quadro di analisi; revisione sistematica = logica di selezione e sintesi della letteratura.
- Evita titoli ornamentali o elastici come “aspetti”, “profili”, “riflessioni”, “considerazioni” se non delimitano un contenuto preciso.
- Evita sottocapitoli che ripetano il titolo del capitolo con minime variazioni lessicali.
- Mantieni un equilibrio realistico: né pochi blocchi troppo generici né una frammentazione artificiale.
- Se i dati non giustificano una sezione metodologica autonoma, non inserirla per automatismo.
- Restituisci solo l'indice finale, pronto da usare.`
  },
  outline_review: {
    provider: 'openai',
    maxOutputTokens: 2400,
    timeoutMs: DEFAULT_OPENAI_TIMEOUT_MS,
    prompt: `Revisiona criticamente l'indice ricevuto come farebbe un relatore esigente.
- Individua solo criticità reali di struttura, progressione, equilibrio, sovrapposizione o tenuta disciplinare.
- Verifica che i capitoli facciano davvero avanzare il lavoro e non ripetano lo stesso nucleo in forma diversa.
- Controlla se l'indice cambia davvero architettura al cambiare della disciplina o se si limita a rifilosofizzare/ri-lessicalizzare uno stesso schema generico.
- Se l'impianto è troppo stabile o scolastico, rifondalo in modo più disciplinare.
- Controlla che i sottocapitoli non siano formule deboli, ripetitive o puramente descrittive.
- Mantieni ciò che funziona e modifica solo ciò che indebolisce davvero l'impianto.
- Non introdurre contenuti disciplinari non presenti nei dati.
- Organizza l'output in due sezioni con questi titoli esatti: Criticità rilevate | Versione migliorata.
- Nella seconda sezione restituisci l'indice completo revisionato, pronto da usare.`
  },
  abstract_draft: {
    provider: 'openai',
    maxOutputTokens: 1100,
    timeoutMs: DEFAULT_OPENAI_TIMEOUT_MS,
    prompt: `Genera un abstract universitario realmente credibile e accademicamente sobrio sulla base dei soli dati ricevuti.
- Scrivi un unico testo compatto di circa 170-230 parole, seguito da una sola riga finale con "Parole chiave:".
- L'abstract deve far capire con chiarezza: tema del lavoro, problema o domanda di fondo, obiettivo, perimetro dell'analisi, impostazione metodologica solo se davvero dichiarata, e fuoco conclusivo del percorso.
- L'ordine deve essere logico: contesto del tema, obiettivo del lavoro, impostazione del percorso, nucleo dell'analisi, chiusura sobria sulla rilevanza del lavoro.
- Non trasformarlo in introduzione estesa, premessa narrativa, presentazione commerciale o riassunto scolastico.
- Non usare formule vuote o standardizzate come "la presente tesi si propone di", "nel primo capitolo", "nel secondo capitolo", "verranno analizzati", "si cercherà di dimostrare" se non strettamente inevitabili.
- Non elencare capitoli, non usare punti elenco, non scrivere sottotitoli interni.
- Non promettere risultati, verifiche, evidenze o conferme che i dati non consentono di sostenere.
- Non introdurre fonti, autori, dati, risultati empirici, riferimenti normativi o bibliografici non presenti nei materiali forniti.
- Mantieni lessico disciplinare coerente con facoltà, corso e tipo di tesi.
- Le parole chiave devono essere 4-6, pertinenti, non ridondanti e separate da virgole.
- Restituisci solo l'abstract finale.`
  },
  abstract_review: {
    provider: 'openai',
    maxOutputTokens: 1400,
    timeoutMs: DEFAULT_OPENAI_TIMEOUT_MS,
    prompt: `Revisiona criticamente l'abstract ricevuto come farebbe un relatore attento alla qualità formale e alla tenuta accademica.
- Migliora ordine logico, compattezza, precisione disciplinare, pulizia sintattica e tono universitario.
- Elimina formule scolastiche, enfasi superflua, ripetizioni, aperture troppo generiche e promesse non sostenibili.
- Verifica che l'abstract non sia un mini-indice mascherato e non contenga la sequenza dei capitoli.
- Se il testo è troppo vago, rendilo più preciso; se è troppo assertivo, rendilo più prudente.
- Mantieni coerenza con titolo, argomento, indice, approccio metodologico e tipo di tesi descritti nei dati.
- Non introdurre fonti, dati, risultati, autori, norme o riferimenti non forniti.
- Mantieni la riga finale "Parole chiave:" come ultima riga, con 4-6 parole chiave pertinenti e non ripetitive.
- Restituisci solo la versione revisionata finale.`
  },
  chapter_draft: {
    provider: 'anthropic',
    maxTokens: 7000,
    timeoutMs: DEFAULT_ANTHROPIC_TIMEOUT_MS,
    prompt: `Scrivi il capitolo richiesto in modo accademico, realmente sviluppato e coerente con l'impianto complessivo della tesi.
- Rispetta con precisione titolo del capitolo, eventuali sottocapitoli, posizione del capitolo nell'indice, facoltà, corso di laurea e approccio dichiarato.
- Ogni sottocapitolo deve avere una funzione riconoscibile: fondazione teorica, chiarimento concettuale, sviluppo del nucleo argomentativo, applicazione interpretativa o chiusura interna del capitolo. Evita sottosezioni che dicano quasi la stessa cosa con parole diverse.
- Sviluppa davvero il ragionamento: non limitarti a riformulare l'indice, non procedere per definizioni generiche ripetute e non riempire con frasi ornamentali.
- Mantieni progressione e densità: ogni paragrafo deve aggiungere un passaggio logico, una distinzione, una conseguenza o una precisazione utile.
- Se i materiali non contengono autori, studi, dati, sentenze o riferimenti specifici, non inventarli: mantieni il discorso su un piano concettuale generale ma rigoroso.
- Non trasformare il capitolo in un elenco di formule astratte o in una sequenza di titoletti mascherati da prosa.
- Evita ripetizioni ravvicinate della stessa espressione chiave, frasi ridondanti e chiusure prevedibili.
- Non aggiungere sezioni artificiali come “Analisi critica”, “Sintesi finale”, “Considerazioni conclusive” o raccordi espliciti verso il capitolo successivo, salvo richiesta esplicita.
- Il testo deve sembrare un vero capitolo universitario: sobrio, continuo, argomentato e difendibile.
- Restituisci solo il capitolo finale.`
  },
  chapter_review: {
    provider: 'anthropic',
    maxTokens: 7500,
    timeoutMs: DEFAULT_ANTHROPIC_TIMEOUT_MS,
    prompt: `Revisiona criticamente il capitolo ricevuto con impostazione da supervisore accademico esigente.
- Valuta anzitutto se il capitolo sviluppa davvero la funzione assegnata nell'indice o se resta descrittivo, ripetitivo o genericamente corretto.
- Controlla coerenza logica, chiarezza espositiva, densità argomentativa, precisione terminologica, continuità stilistica e differenziazione reale tra i sottocapitoli.
- Individua ridondanze, parafrasi interne, accumuli descrittivi, passaggi troppo generici, slittamenti di registro e chiusure artificiali.
- Segnala se il testo introduce riferimenti, dati, autori, sentenze, norme o informazioni non supportati dai materiali di partenza.
- Intervieni in modo conservativo ma sostanziale: elimina il superfluo, rafforza i passaggi deboli e rendi il testo più universitario senza riscriverlo inutilmente da zero.
- Se il capitolo è troppo scolastico, troppo schematico o troppo simile all'indice in forma discorsiva, correggilo apertamente.
- Struttura l'output in tre parti con questi titoli esatti: Criticità rilevate | Interventi prioritari | Testo revisionato.`
  },
  tutor_revision: {
    provider: 'anthropic',
    maxTokens: 7500,
    timeoutMs: DEFAULT_ANTHROPIC_TIMEOUT_MS,
    prompt: `Applica in modo rigoroso le osservazioni del relatore o tutor al testo ricevuto.
- Dai priorità alle richieste del relatore rispetto a preferenze stilistiche secondarie.
- Intervieni in modo conservativo ma effettivo: modifica il minimo necessario per risolvere davvero le criticità indicate.
- Se un'osservazione richiede più precisione, maggiore profondità o minore ridondanza, adegua il testo in quella direzione senza allontanarti dai materiali disponibili.
- Se un'osservazione è ambigua, scegli l'interpretazione più prudente e difendibile, senza introdurre contenuti non supportati.
- Non aggiungere fonti, dati, autori, norme, sentenze o riferimenti non presenti nei materiali.
- Mantieni tono, livello accademico, coerenza interna e continuità con titolo, indice e abstract.
- Restituisci solo il testo revisionato.`
  },
  final_consistency_review: {
    provider: 'anthropic',
    maxTokens: 5500,
    timeoutMs: DEFAULT_ANTHROPIC_TIMEOUT_MS,
    prompt: `Esegui un controllo finale di coerenza complessiva dell'elaborato con criterio accademico severo.
- Verifica coerenza tra titolo, indice, abstract, capitoli, terminologia, taglio disciplinare e approccio dichiarato.
- Individua ripetizioni strutturali, capitoli troppo simili tra loro, promesse non mantenute, slittamenti disciplinari, incoerenze terminologiche e riferimenti non supportati dai dati.
- Distingui chiaramente i problemi che compromettono la tenuta accademica dell'elaborato dalle criticità secondarie o solo stilistiche.
- Non riscrivere la tesi e non proporre soluzioni decorative: segnala ciò che conta davvero per una revisione finale seria.
- Struttura l'output in tre sezioni con questi titoli esatti: Criticità ad alta priorità | Criticità medie | Osservazioni finali.`
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

    const canonicalTask = canonicalizeTask(task);
    if (!canonicalTask || !TASK_CONFIG[canonicalTask]) {
      return res.status(400).json({ error: 'Task non supportato', details: task });
    }

    const config = TASK_CONFIG[canonicalTask];

    if (config.provider === 'openai') {
      return await handleOpenAI({ task: canonicalTask, input, config, res });
    }

    return await handleAnthropic({ task: canonicalTask, input, config, res });
  } catch (error) {
    return res.status(500).json({
      error: 'Errore interno',
      details: error?.message || 'Errore sconosciuto'
    });
  }
}

function normalizeBody(body) {
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = { input: body };
    }
  }

  const safe = body && typeof body === 'object' ? body : {};
  const rawTask = typeof safe.task === 'string' ? safe.task.trim() : '';
  const candidateInput = safe.input ?? safe.payload ?? safe.content ?? {};

  return {
    task: rawTask,
    input: stringifyInput(candidateInput)
  };
}

function stringifyInput(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function canonicalizeTask(task) {
  const normalized = String(task || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  return TASK_ALIASES[normalized] || normalized;
}

async function handleOpenAI({ task, input, config, res }) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL_ACADEMIC || process.env.OPENAI_MODEL || 'gpt-5.4';

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
        input: prompt,
        max_output_tokens: config.maxOutputTokens,
        prompt_cache_key: `accademia:${task}`
      })
    },
    config.timeoutMs || DEFAULT_OPENAI_TIMEOUT_MS
  );

  const data = await safeJson(response);

  if (!response.ok) {
    return res.status(response.status).json({
      error: 'Errore OpenAI',
      details: simplifyProviderError(data)
    });
  }

  const text = data?.output_text || extractOpenAIText(data) || 'Nessun contenuto restituito';
  return res.status(200).json({ ok: true, task, text });
}

async function handleAnthropic({ task, input, config, res }) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const anthropicModel = process.env.ANTHROPIC_MODEL_LONGFORM || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

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
        max_tokens: config.maxTokens || 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    },
    config.timeoutMs || DEFAULT_ANTHROPIC_TIMEOUT_MS
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

  return res.status(200).json({ ok: true, task, text: text || 'Nessun contenuto restituito' });
}

function buildPrompt(task, input) {
  return `${TASK_CONFIG[task].prompt}\n\nDATI FORNITI DALL'UTENTE:\n${input}`;
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
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
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
  return data?.error?.message || data?.message || JSON.stringify(data);
}
