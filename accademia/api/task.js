const OPENAI_TIMEOUT_MS = 90000;
const ANTHROPIC_TIMEOUT_MS = 90000;

const TASK_CONFIG = {
  outline_draft: { provider: 'openai', openaiMaxOutputTokens: 2400 },
  outline_review: { provider: 'openai', openaiMaxOutputTokens: 2600 },
  abstract_draft: { provider: 'openai', openaiMaxOutputTokens: 1400 },
  abstract_review: { provider: 'openai', openaiMaxOutputTokens: 1600 },
  title_suggestions: { provider: 'openai', openaiMaxOutputTokens: 1200 },
  chapter_draft: { provider: 'anthropic', anthropicMaxTokens: 6000 },
  chapter_review: { provider: 'anthropic', anthropicMaxTokens: 6000 },
  tutor_revision: { provider: 'anthropic', anthropicMaxTokens: 6000 },
  final_consistency_review: { provider: 'anthropic', anthropicMaxTokens: 2800 }
};

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

function normalizeTaskName(task) {
  const raw = typeof task === 'string' ? task.trim().toLowerCase() : '';
  const aliases = {
    outline: 'outline_draft',
    indice: 'outline_draft',
    index: 'outline_draft',
    outline_review: 'outline_review',
    indice_review: 'outline_review',
    index_review: 'outline_review',
    abstract: 'abstract_draft',
    chapter: 'chapter_draft',
    final_check: 'final_consistency_review',
    title: 'title_suggestions',
    titles: 'title_suggestions',
    title_suggestion: 'title_suggestions'
  };
  return aliases[raw] || raw;
}

function normalizeBody(body) {
  const safe = body && typeof body === 'object' ? body : {};
  const task = normalizeTaskName(safe.task);
  const rawInput = safe.input ?? safe.payload ?? safe.content ?? {};
  const input =
    typeof rawInput === 'string'
      ? rawInput
      : JSON.stringify(rawInput || {});

  return { task, input };
}

function getTaskConfig(task) {
  return TASK_CONFIG[task] || { provider: 'openai', openaiMaxOutputTokens: 1800 };
}

function pickProvider(task) {
  return getTaskConfig(task).provider;
}

async function handleOpenAI({ task, input, res }) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const config = getTaskConfig(task);
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
        max_output_tokens: config.openaiMaxOutputTokens || 1800
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
    task,
    text
  });
}

async function handleAnthropic({ task, input, res }) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const config = getTaskConfig(task);
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
        max_tokens: config.anthropicMaxTokens || 6000,
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
    task,
    text: text || 'Nessun contenuto restituito'
  });
}

function buildPrompt(task, input) {
  const payload = typeof input === 'string' ? input : JSON.stringify(input || {});

  const map = {
    outline_draft: `Genera un indice di tesi universitario rigoroso, plausibile e ben gerarchizzato sulla base dei soli dati ricevuti.
- Costruisci una struttura progressiva: dai fondamenti teorici o definitori verso analisi, applicazioni, discussione e chiusura, senza salti logici.
- Usa un numero di capitoli davvero proporzionato al tema: in via ordinaria 5 capitoli principali oltre a introduzione, conclusioni e bibliografia; riduci o aumenta solo se i dati lo rendono chiaramente più appropriato.
- Ogni capitolo deve avere una funzione distinta e riconoscibile; evita capitoli duplicati, speculari o semplicemente parafrasati.
- I titoli devono essere accademici, sobri, specifici e credibili davanti a un relatore; evita formule vaghe, decorative o troppo simili tra loro.
- I sottocapitoli devono risultare equilibrati, non ornamentali, non eccessivamente minuti e non ridondanti rispetto al titolo del capitolo.
- Se nei dati compaiono facoltà, corso di laurea o approccio metodologico, l'indice deve rifletterli davvero nel lessico e nell'impostazione.
- Non inserire autori, teorie, norme, casi di studio, metodi o riferimenti specialistici non presenti nei dati ricevuti.
- Restituisci solo l'indice finale, già pronto da usare, in forma ordinata e pulita.`,

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

    outline_review: `Revisiona criticamente l'indice ricevuto come farebbe un supervisore accademico esigente ma sobrio.
- Valuta solo aspetti strutturali reali: progressione logica, equilibrio tra capitoli, chiarezza dei titoli, coerenza dei sottocapitoli, aderenza a facoltà/corso/metodologia e assenza di sovrapposizioni.
- Non segnalare pseudo-problemi o micro-ritocchi irrilevanti.
- Individua con precisione se l'indice è troppo generico, troppo ripetitivo, troppo frammentato oppure sbilanciato tra parti introduttive e parti analitiche.
- Se il problema riguarda singoli titoli, correggi i titoli; se riguarda l'architettura, correggi l'architettura.
- Non introdurre contenuti disciplinari, autori, norme, casi o riferimenti non presenti nei dati.
- Struttura l'output in due parti nette: "Criticità rilevate" e "Indice revisionato".
- Nella seconda parte restituisci l'indice completo già migliorato, non semplici suggerimenti sparsi.`,

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
- Struttura l'output in: criticità ad alta priorità, criticità medie, osservazioni finali.`,

    title_suggestions: `Valuta la compatibilità tra argomento, facoltà, corso di laurea, tipo di laurea, approccio metodologico ed eventuale titolo già proposto.
- Se la combinazione è sostanzialmente incoerente in termini accademici, restituisci solo una riga che inizi con "AVVISO:" e spieghi perché.
- Se la combinazione è parzialmente compatibile ma recuperabile, restituisci prima l'eventuale riga "AVVISO:" e poi 5 titoli disciplinari credibili, uno per riga.
- Se la combinazione è coerente, restituisci direttamente 5 titoli disciplinari credibili, uno per riga.
- Non ripetere meccanicamente la stessa locuzione centrale in tutti i titoli: la stessa espressione chiave dell'argomento non può comparire in più di 2 titoli su 5.
- Negli altri titoli usa parafrasi, perifrasi o focalizzazioni concettuali disciplinari sobrie e credibili.
- Differenzia incipit, struttura sintattica e taglio interpretativo dei titoli.
- Evita titoli fotocopia che cambiano solo poche parole.
- Se è presente un titolo già proposto, puoi valutarlo e ottimizzarlo, ma senza limitarti a minime variazioni lessicali.
- Restituisci solo l'eventuale riga "AVVISO:" e poi i 5 titoli finali.`
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
