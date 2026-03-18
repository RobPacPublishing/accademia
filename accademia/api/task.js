const OPENAI_TIMEOUT_MS = 90000;
const ANTHROPIC_TIMEOUT_MS = 90000;

const GENERAL_SYSTEM_PROMPT = `Sei un assistente accademico rigoroso, prudente e professionale.

Obiettivi generali:
- produci testi chiari, coerenti, formalmente corretti e adatti a un contesto universitario;
- rispetta strettamente i dati ricevuti;
- non inventare fonti, citazioni, riferimenti bibliografici, dati, norme, autori, risultati di ricerca o dettagli fattuali non presenti nei dati forniti;
- se i dati sono insufficienti, incompleti o ambigui, non colmare i vuoti con invenzioni: lavora solo su ciò che è disponibile e mantieni formulazioni prudenti;
- evita tono enfatico, promozionale, colloquiale o assertivo oltre il giustificabile;
- privilegia precisione, rigore logico, coerenza interna e chiarezza espositiva.

Vincoli permanenti:
- non dichiarare di aver consultato fonti esterne se non sono state fornite nei dati;
- non usare formule meta come “ecco il testo”, “di seguito”, “ho revisionato”, salvo richiesta esplicita;
- restituisci solo l'output utile al task richiesto;
- conserva, per quanto possibile, il significato del materiale fornito dall'utente senza alterarlo arbitrariamente.`;

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
  const task = typeof safe.task === 'string' ? safe.task.trim() : '';
  const input =
    safe.input ??
    safe.payload ??
    safe.content ??
    {};

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

function getAnthropicMaxTokens(task) {
  const largeTasks = new Set(['chapter_draft', 'chapter_review', 'final_consistency_review']);
  return largeTasks.has(task) ? 7000 : 4000;
}

async function handleOpenAI({ task, input, res }) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL || 'gpt-5.4';

  if (!openaiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY non configurata' });
  }

  const prompt = buildUserPrompt(task, input);

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

  const text = data?.output_text || extractOpenAIText(data) || 'Nessun contenuto restituito';

  return res.status(200).json({ ok: true, provider: 'openai', task, text });
}

async function handleAnthropic({ task, input, res }) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  if (!anthropicKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurata' });
  }

  const prompt = buildUserPrompt(task, input);

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
        max_tokens: getAnthropicMaxTokens(task),
        messages: [{ role: 'user', content: prompt }]
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

  const text = Array.isArray(data?.content)
    ? data.content.map(part => part?.text || '').join('\n').trim()
    : '';

  return res.status(200).json({
    ok: true,
    provider: 'anthropic',
    task,
    text: text || 'Nessun contenuto restituito'
  });
}

function buildUserPrompt(task, input) {
  const normalized = normalizeAcademicInput(input);
  const taskPrompt = getTaskPrompt(task);

  return [
    taskPrompt.objective,
    '',
    'ISTRUZIONI SPECIFICHE:',
    taskPrompt.instructions,
    '',
    'FORMATO DI USCITA OBBLIGATORIO:',
    taskPrompt.outputFormat,
    '',
    'CONTESTO GENERALE:',
    normalized.context,
    '',
    'DATI OPERATIVI:',
    normalized.rawPayload
  ].join('\n');
}

function getTaskPrompt(task) {
  const prompts = {
    outline_draft: {
      objective: 'Crea un indice accademico solido, coerente e difendibile sulla base dei dati ricevuti.',
      instructions: [
        '- organizza i contenuti in una progressione logica chiara;',
        '- evita titoli generici, ripetitivi o ridondanti;',
        '- mantieni coerenza tra titolo dell’elaborato, obiettivo e articolazione interna;',
        '- non inserire sezioni non giustificate dai dati disponibili.'
      ].join('\n'),
      outputFormat: [
        '- restituisci solo l’indice finale;',
        '- usa una gerarchia chiara tra capitoli e sottosezioni;',
        '- non aggiungere commenti esplicativi esterni all’indice.'
      ].join('\n')
    },
    abstract_draft: {
      objective: 'Scrivi un abstract accademico chiaro, denso e coerente con i dati ricevuti.',
      instructions: [
        '- formula l’oggetto della tesi in modo preciso;',
        '- esplicita, quando possibile dai dati forniti, obiettivo, taglio, metodo e focus;',
        '- evita enfasi, slogan o formulazioni vaghe;',
        '- non introdurre risultati o fonti non presenti nei dati.'
      ].join('\n'),
      outputFormat: [
        '- restituisci un abstract compatto in prosa continua;',
        '- non usare elenchi puntati;',
        '- non aggiungere note introduttive o finali.'
      ].join('\n')
    },
    chapter_draft: {
      objective: 'Scrivi il capitolo richiesto in stile accademico, con rigore argomentativo e coerenza interna.',
      instructions: [
        '- sviluppa il capitolo seguendo il perimetro dei dati forniti;',
        '- mantieni coerenza con tesi centrale, indice approvato, lessico già impostato e materiali precedenti se presenti;',
        '- mantieni progressione logica tra paragrafi e transizioni pulite;',
        '- evita ripetizioni meccaniche e affermazioni apodittiche non sostenute dai dati;',
        '- non inventare riferimenti bibliografici o risultati di ricerca.'
      ].join('\n'),
      outputFormat: [
        '- restituisci solo il testo del capitolo;',
        '- usa paragrafi ben costruiti;',
        '- mantieni eventuali titoli interni solo se coerenti con i dati ricevuti.'
      ].join('\n')
    },
    outline_review: {
      objective: 'Revisiona criticamente l’indice ricevuto e miglioralo senza snaturarne l’impianto utile.',
      instructions: [
        '- individua lacune, squilibri, ridondanze o passaggi poco difendibili;',
        '- correggi la struttura in funzione di maggiore coerenza e linearità;',
        '- preserva ciò che è già valido.'
      ].join('\n'),
      outputFormat: [
        '- prima scrivi “Criticità rilevate” con osservazioni sintetiche;',
        '- poi scrivi “Indice revisionato” e riporta la nuova struttura;',
        '- niente premessa o chiusura.'
      ].join('\n')
    },
    abstract_review: {
      objective: 'Revisiona l’abstract ricevuto migliorandone coerenza, densità e chiarezza accademica.',
      instructions: [
        '- correggi vaghezze, ridondanze e passaggi deboli;',
        '- rafforza la precisione terminologica senza appesantire il testo;',
        '- non introdurre contenuti nuovi non supportati dai dati.'
      ].join('\n'),
      outputFormat: [
        '- prima scrivi “Criticità rilevate” in forma sintetica;',
        '- poi scrivi “Abstract revisionato” e riporta la versione migliorata.'
      ].join('\n')
    },
    chapter_review: {
      objective: 'Revisiona criticamente il capitolo ricevuto sul piano logico, stilistico e argomentativo.',
      instructions: [
        '- individua incoerenze, ripetizioni, salti logici o passaggi deboli;',
        '- migliora chiarezza e compattezza senza cambiare inutilmente il significato;',
        '- conserva terminologia, tesi centrale e allineamento con i materiali già approvati, se presenti;',
        '- non inserire dati o riferimenti non presenti nei materiali ricevuti.'
      ].join('\n'),
      outputFormat: [
        '- prima scrivi “Criticità rilevate” con punti sintetici;',
        '- poi scrivi “Capitolo revisionato” e riporta il testo migliorato.'
      ].join('\n')
    },
    tutor_revision: {
      objective: 'Applica con rigore le osservazioni del relatore o tutor modificando solo ciò che è necessario.',
      instructions: [
        '- recepisci le osservazioni in modo fedele e proporzionato;',
        '- evita riscritture invasive se non richieste;',
        '- mantieni tono, terminologia e coerenza del testo di partenza;',
        '- preserva la continuità con indice, capitoli e scelte lessicali già approvate, se disponibili.'
      ].join('\n'),
      outputFormat: [
        '- prima scrivi “Modifiche applicate” con sintesi essenziale;',
        '- poi scrivi “Testo aggiornato” e riporta la versione aggiornata.'
      ].join('\n')
    },
    final_consistency_review: {
      objective: 'Esegui un controllo finale di coerenza complessiva sull’elaborato ricevuto.',
      instructions: [
        '- verifica coerenza terminologica, continuità argomentativa, assenza di ripetizioni evidenti e allineamento tra le parti;',
        '- controlla anche coerenza con tesi centrale, indice approvato e lessico stabile, se presenti nei dati;',
        '- segnala solo problemi reali e rilevanti;',
        '- non formulare controlli fattuali che richiedano fonti esterne non fornite.'
      ].join('\n'),
      outputFormat: [
        '- scrivi le sezioni: “Incongruenze”, “Ripetizioni”, “Punti da rifinire”, “Versione coerentizzata se necessaria”;',
        '- se il testo è già coerente, dichiaralo in modo sobrio e restituisci solo minimi aggiustamenti.'
      ].join('\n')
    }
  };

  return prompts[task] || {
    objective: 'Elabora il contenuto ricevuto in modo utile e coerente.',
    instructions: '- lavora solo sui dati forniti.',
    outputFormat: '- restituisci solo il contenuto utile al task.'
  };
}

function normalizeAcademicInput(input) {
  if (typeof input === 'string') {
    return {
      context: formatContextBlock({}),
      rawPayload: input
    };
  }

  const safe = input && typeof input === 'object' ? input : {};

  const meta = {
    titolo: pickFirstString(safe.titolo, safe.title, safe.projectTitle, safe.thesisTitle),
    corsoDiLaurea: pickFirstString(safe.corsoDiLaurea, safe.degreeCourse, safe.corso, safe.course),
    livello: pickFirstString(safe.livello, safe.degreeLevel, safe.tipoLaurea, safe.academicLevel),
    disciplina: pickFirstString(safe.disciplina, safe.subjectArea, safe.subject, safe.area),
    metodologia: pickFirstString(safe.metodologia, safe.methodology, safe.metodo, safe.method),
    lingua: pickFirstString(safe.lingua, safe.language),
    stileCitazionale: pickFirstString(safe.stileCitazionale, safe.citationStyle, safe.style),
    targetLunghezza: pickFirstString(safe.targetLunghezza, safe.lengthTarget, safe.wordTarget)
  };

  return {
    context: formatContextBlock(meta),
    rawPayload: JSON.stringify(safe, null, 2)
  };
}

function formatContextBlock(meta) {
  const rows = [
    ['Titolo o tema', meta.titolo],
    ['Corso di laurea', meta.corsoDiLaurea],
    ['Livello accademico', meta.livello],
    ['Disciplina o area', meta.disciplina],
    ['Metodologia dichiarata', meta.metodologia],
    ['Lingua richiesta', meta.lingua],
    ['Stile citazionale', meta.stileCitazionale],
    ['Target di lunghezza', meta.targetLunghezza]
  ];

  return rows.map(([label, value]) => `- ${label}: ${value || 'non specificato'}`).join('\n');
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
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
