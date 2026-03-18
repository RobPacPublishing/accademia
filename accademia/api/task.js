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

const OPENAI_SYSTEM_OVERLAY = `Indicazioni specifiche per provider:
- privilegia risposte stabili, ordinate e con struttura controllata;
- evita creatività superflua o riformulazioni decorative;
- mantieni alta aderenza al task e al formato richiesto.`;

const ANTHROPIC_SYSTEM_OVERLAY = `Indicazioni specifiche per provider:
- privilegia profondità argomentativa e precisione redazionale;
- evita espansioni speculative o interpretazioni non sostenute dai dati;
- mantieni continuità logica e sobrietà stilistica.`;

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
    isUsableValue(safe.input) ? safe.input :
    isUsableValue(safe.payload) ? safe.payload :
    isUsableValue(safe.content) ? safe.content :
    {};

  return { task, input };
}

function isUsableValue(value) {
  return (typeof value === 'string' && value.trim()) || (value && typeof value === 'object');
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
  if (task === 'chapter_draft') return 7000;
  if (task === 'chapter_review' || task === 'tutor_revision' || task === 'final_consistency_review') {
    return 6000;
  }
  return 4000;
}

function composeSystemPrompt(provider, task, input) {
  const normalized = normalizeAcademicInput(input);
  const overlay = provider === 'anthropic' ? ANTHROPIC_SYSTEM_OVERLAY : OPENAI_SYSTEM_OVERLAY;

  return [
    GENERAL_SYSTEM_PROMPT,
    '',
    overlay,
    '',
    'Contesto accademico sintetico:',
    normalized.context,
    '',
    'Gestione lacune dati:',
    normalized.dataGaps,
    '',
    'Disciplina e metodo:',
    normalized.disciplineGuidance,
    '',
    'Stile e lunghezza:',
    normalized.styleGuidance,
    '',
    'Task corrente:',
    getTaskObjective(task)
  ].join('\n');
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
        instructions: composeSystemPrompt('openai', task, input),
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
        system: composeSystemPrompt('anthropic', task, input),
        max_tokens: getAnthropicMaxTokens(task),
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
  const taskData = getTaskPrompt(task);

  return [
    'OBIETTIVO:',
    taskData.objective,
    '',
    'ISTRUZIONI SPECIFICHE:',
    taskData.instructions,
    '',
    'FORMATO DI USCITA:',
    taskData.outputFormat,
    '',
    'CONTESTO GENERALE:',
    normalized.context,
    '',
    'GESTIONE LACUNE DATI:',
    normalized.dataGaps,
    '',
    'PROFILO DISCIPLINARE:',
    normalized.disciplineGuidance,
    '',
    'STILE E LUNGHEZZA:',
    normalized.styleGuidance,
    '',
    'DATI OPERATIVI:',
    normalized.rawPayload
  ].join('\n');
}

function getTaskPrompt(task) {
  const prompts = {
    outline_draft: {
      objective: 'Genera un indice accademico coerente, difendibile e ben strutturato.',
      instructions: [
        '- costruisci una progressione logica chiara;',
        '- evita titoli generici, vaghi o ornamentali;',
        '- mantieni equilibrio tra capitoli e sottosezioni;',
        '- non introdurre sezioni non sostenute dai dati.'
      ].join('\n'),
      outputFormat: [
        '- restituisci solo l’indice finale;',
        '- usa una gerarchia chiara;',
        '- niente note introduttive o finali.'
      ].join('\n')
    },
    abstract_draft: {
      objective: 'Genera un abstract accademico chiaro, compatto e coerente.',
      instructions: [
        '- chiarisci oggetto, focus e perimetro del lavoro;',
        '- esplicita obiettivo e metodo solo se sostenuti dai dati;',
        '- evita vaghezze, slogan e risultati inventati.'
      ].join('\n'),
      outputFormat: [
        '- restituisci solo il testo dell’abstract;',
        '- usa prosa continua;',
        '- niente elenchi.'
      ].join('\n')
    },
    chapter_draft: {
      objective: 'Scrivi il capitolo richiesto con rigore accademico, coerenza logica e densità controllata.',
      instructions: [
        '- sviluppa il testo solo entro il perimetro dei dati ricevuti;',
        '- mantieni progressione argomentativa e transizioni pulite;',
        '- evita ripetizioni, riempitivi e pseudo-accademismo;',
        '- non inventare fonti, risultati o riferimenti.'
      ].join('\n'),
      outputFormat: [
        '- restituisci solo il testo del capitolo;',
        '- usa paragrafi ben costruiti;',
        '- mantieni eventuali titoli interni solo se coerenti con i dati.'
      ].join('\n')
    },
    outline_review: {
      objective: 'Revisiona l’indice ricevuto migliorandone coerenza e difendibilità.',
      instructions: [
        '- individua lacune, squilibri e ridondanze reali;',
        '- conserva ciò che è già valido;',
        '- correggi solo ciò che migliora davvero la struttura.'
      ].join('\n'),
      outputFormat: [
        '- scrivi prima “Criticità rilevate”;',
        '- poi scrivi “Indice revisionato”;',
        '- niente chiusure superflue.'
      ].join('\n')
    },
    abstract_review: {
      objective: 'Revisiona l’abstract migliorando precisione, densità e chiarezza.',
      instructions: [
        '- correggi vaghezze e ridondanze;',
        '- non introdurre contenuti nuovi non supportati dai dati.'
      ].join('\n'),
      outputFormat: [
        '- scrivi prima “Criticità rilevate”;',
        '- poi scrivi “Abstract revisionato”.'
      ].join('\n')
    },
    chapter_review: {
      objective: 'Revisiona criticamente il capitolo sul piano logico, stilistico e argomentativo.',
      instructions: [
        '- individua incoerenze, ripetizioni e salti logici;',
        '- migliora il testo in modo conservativo;',
        '- non rifondare inutilmente il capitolo.'
      ].join('\n'),
      outputFormat: [
        '- scrivi “Criticità rilevate”;',
        '- poi “Interventi prioritari”;',
        '- poi “Testo revisionato”.'
      ].join('\n')
    },
    tutor_revision: {
      objective: 'Applica in modo rigoroso le osservazioni del relatore o tutor.',
      instructions: [
        '- dai priorità alle osservazioni ricevute;',
        '- modifica solo ciò che è necessario;',
        '- conserva l’impianto valido del testo.'
      ].join('\n'),
      outputFormat: [
        '- scrivi “Osservazioni recepite”;',
        '- poi “Testo aggiornato”.'
      ].join('\n')
    },
    final_consistency_review: {
      objective: 'Esegui un controllo finale di coerenza complessiva sull’elaborato.',
      instructions: [
        '- segnala solo criticità concrete e prioritarie;',
        '- distingui problemi sostanziali da semplici rifiniture;',
        '- non riscrivere integralmente l’elaborato.'
      ].join('\n'),
      outputFormat: [
        '- scrivi “Criticità ad alta priorità”;',
        '- poi “Criticità secondarie”;',
        '- poi “Interventi consigliati”.'
      ].join('\n')
    }
  };

  return prompts[task] || {
    objective: 'Elabora il contenuto ricevuto in modo utile e coerente.',
    instructions: '- resta aderente ai dati ricevuti.',
    outputFormat: '- restituisci solo il contenuto utile.'
  };
}

function getTaskObjective(task) {
  return getTaskPrompt(task).objective;
}

function normalizeAcademicInput(input) {
  if (typeof input === 'string') {
    return {
      context: formatContextBlock({}),
      dataGaps: formatDataGapBlock({}),
      disciplineGuidance: getDisciplineGuidance({}),
      styleGuidance: getStyleGuidance({}, 'generic'),
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
    dataGaps: formatDataGapBlock(meta),
    disciplineGuidance: getDisciplineGuidance(meta),
    styleGuidance: getStyleGuidance(meta, safe.task),
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

function formatDataGapBlock(meta) {
  const gaps = [];

  if (!meta.titolo) gaps.push('titolo o tema non specificato');
  if (!meta.corsoDiLaurea) gaps.push('corso di laurea non specificato');
  if (!meta.livello) gaps.push('livello accademico non specificato');
  if (!meta.disciplina) gaps.push('disciplina o area non specificata');
  if (!meta.stileCitazionale) gaps.push('stile citazionale non specificato');

  if (!gaps.length) {
    return [
      '- dati minimi di contesto presenti;',
      '- puoi mantenere un livello di specificità normale senza inventare elementi esterni.'
    ].join('\n');
  }

  const severity = gaps.length >= 4 ? 'alta' : gaps.length >= 2 ? 'media' : 'bassa';

  return [
    `- severità lacune: ${severity};`,
    `- lacune rilevate: ${gaps.join('; ')};`,
    '- riduci il livello di dettaglio non sostenibile dai dati;',
    '- non simulare completezza metodologica, disciplinare o bibliografica;',
    '- mantieni output utile ma prudente.'
  ].join('\n');
}

function getDisciplineGuidance(meta) {
  const area = (meta.disciplina || '').toLowerCase();

  if (area.includes('giurisprud')) {
    return [
      '- privilegia lessico giuridico sobrio e preciso;',
      '- evita affermazioni normative non supportate dai dati;',
      '- mantieni argomentazione ordinata e difendibile.'
    ].join('\n');
  }

  if (area.includes('psicolog')) {
    return [
      '- usa lessico psicologico preciso ma leggibile;',
      '- evita diagnosi, dati clinici o risultati di ricerca non presenti;',
      '- mantieni distinzione tra concetti, modelli e interpretazioni.'
    ].join('\n');
  }

  if (area.includes('econom') || area.includes('aziendal')) {
    return [
      '- privilegia chiarezza analitica e linearità espositiva;',
      '- non introdurre dati quantitativi non forniti;',
      '- mantieni nesso chiaro tra concetti, variabili e implicazioni.'
    ].join('\n');
  }

  if (area.includes('letter') || area.includes('filolog') || area.includes('storia')) {
    return [
      '- privilegia analisi testuale e contestualizzazione sobria;',
      '- evita attribuzioni o interpretazioni non sostenute dai dati;',
      '- mantieni rigore terminologico e chiarezza argomentativa.'
    ].join('\n');
  }

  return [
    '- adotta un registro universitario sobrio e professionale;',
    '- mantieni rigore logico e chiarezza espositiva;',
    '- evita specialismi non giustificati dai dati.'
  ].join('\n');
}

function getStyleGuidance(meta) {
  const target = (meta.targetLunghezza || '').toLowerCase();
  const style = meta.stileCitazionale || 'non specificato';

  return [
    `- stile citazionale: ${style};`,
    `- target di lunghezza dichiarato: ${target || 'non specificato'};`,
    '- privilegia densità informativa, paragrafi puliti e progressione logica;',
    '- se la lunghezza non è specificata, evita sia eccessiva sintesi sia dilatazione artificiale.'
  ].join('\n');
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
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
