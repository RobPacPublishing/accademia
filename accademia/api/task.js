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
- se viene richiesto o implicato uno stile citazionale, rispettalo solo nei limiti dei materiali ricevuti;
- se mancano fonti verificabili, non simulare apparati bibliografici completi;
- in caso di dubbio tra fluidità e correttezza, privilegia la correttezza;
- non usare formule meta come “ecco il testo”, “di seguito”, “ho revisionato”, salvo richiesta esplicita;
- restituisci solo l'output utile al task richiesto;
- conserva, per quanto possibile, il significato del materiale fornito dall'utente senza alterarlo arbitrariamente.`;


const OPENAI_PROVIDER_PROMPT = `Indicazioni operative per provider OpenAI:
- privilegia chiarezza strutturale, aderenza al formato richiesto e buona organizzazione dell'output;
- se il task richiede revisione, separa con precisione diagnosi e testo revisionato;
- non aggiungere spiegazioni esterne al formato richiesto.`;

const ANTHROPIC_PROVIDER_PROMPT = `Indicazioni operative per provider Anthropic:
- privilegia profondità argomentativa, continuità logica e coerenza editoriale tra sezioni;
- se il task riguarda capitoli o revisioni estese, mantieni forte conservazione della tesi centrale e del lessico stabile;
- non trasformare una revisione in riscrittura integrale salvo necessità evidente.`;

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


function composeSystemPrompt(provider, task, input) {
  const normalized = normalizeAcademicInput(input, task);
  const providerPrompt = provider === 'anthropic' ? ANTHROPIC_PROVIDER_PROMPT : OPENAI_PROVIDER_PROMPT;
  const taskOverlay = getTaskSystemOverlay(task);

  return [
    GENERAL_SYSTEM_PROMPT,
    '',
    providerPrompt,
    '',
    'Vincoli del task corrente:',
    taskOverlay,
    '',
    'Contesto disciplinare sintetico:',
    normalized.disciplinaryProfile,
    '',
    'Politica fonti sintetica:',
    normalized.sourcePolicy
  ].join('
');
}

function getTaskSystemOverlay(task) {
  const overlays = {
    outline_draft: '- costruisci una struttura difendibile e non decorativa.',
    abstract_draft: '- concentra il testo su oggetto, obiettivo, metodo e perimetro reale dei dati.',
    chapter_draft: '- sviluppa il testo con continuità argomentativa e densità accademica controllata.',
    outline_review: '- correggi l'indice in modo conservativo ma netto dove necessario.',
    abstract_review: '- migliora precisione e compattezza senza introdurre contenuti nuovi.',
    chapter_review: '- distingui chiaramente criticità, interventi e testo revisionato.',
    tutor_revision: '- applica le osservazioni in modo fedele, proporzionato e tracciabile.',
    final_consistency_review: '- comportati come controllo finale redazionale, non come autore ex novo.'
  };

  return overlays[task] || '- resta aderente al task richiesto e ai dati forniti.';
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
        system: composeSystemPrompt('anthropic', task, input),
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
  const normalized = normalizeAcademicInput(input, task);
  const taskPrompt = getTaskPrompt(task);

  return [
    taskPrompt.objective,
    '',
    'ISTRUZIONI SPECIFICHE:',
    taskPrompt.instructions,
    '',
    'POLITICA FONTI E CITAZIONI:',
    normalized.sourcePolicy,
    '',
    'POLITICA DI COERENZA TERMINOLOGICA E CONSERVAZIONE:',
    normalized.consistencyPolicy,
    '',
    'POLITICA DI LUNGHEZZA E DENSITÀ:',
    normalized.lengthPolicy,
    '',
    'RUBRICA DI QUALITÀ DEL TASK:',
    getTaskQualityRubric(task),
    '',
    'FORMATO DI USCITA OBBLIGATORIO:',
    taskPrompt.outputFormat,
    '',
    'PROFILO DISCIPLINARE:',
    normalized.disciplinaryProfile,
    '',
    'CONTESTO GENERALE:',
    normalized.context,
    '',
    'CONTINUITA EDITORIALE E MATERIALI DI SUPPORTO:',
    normalized.continuity,
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
        '- non introdurre risultati o fonti non presenti nei dati;',
        '- se i dati includono fonti, non alterarne attribuzione o forma in modo arbitrario.'
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
        '- non inventare riferimenti bibliografici o risultati di ricerca;',
        '- se sono presenti fonti nei dati, richiamale solo con prudenza e coerenza formale.'
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
      objective: 'Revisiona criticamente il capitolo ricevuto sul piano logico, stilistico e argomentativo, intervenendo in modo conservativo e tracciabile.',
      instructions: [
        '- individua incoerenze, ripetizioni, salti logici o passaggi deboli;',
        '- migliora chiarezza e compattezza senza cambiare inutilmente il significato;',
        '- non riscrivere da zero se il testo è già sostanzialmente valido;',
        '- conserva terminologia, tesi centrale e allineamento con i materiali già approvati, se presenti;',
        '- non inserire dati o riferimenti non presenti nei materiali ricevuti.'
      ].join('\n'),
      outputFormat: [
        '- prima scrivi “Criticità rilevate” con punti sintetici;',
        '- poi scrivi “Interventi effettuati” con indicazione breve dei cambiamenti;',
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
        '- prima scrivi “Osservazioni recepite” con sintesi essenziale;',
        '- poi scrivi “Scelte conservative” indicando cosa è stato volutamente lasciato invariato, se rilevante;',
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
        '- scrivi le sezioni: “Incongruenze”, “Ripetizioni”, “Punti da rifinire”, “Priorita di intervento”, “Versione coerentizzata se necessaria”;',
        '- se il testo è già coerente, dichiaralo in modo sobrio e restituisci solo minimi aggiustamenti;',
        '- non trasformare il controllo finale in una riscrittura integrale salvo necessità evidente.'
      ].join('\n')
    }
  };

  return prompts[task] || {
    objective: 'Elabora il contenuto ricevuto in modo utile e coerente.',
    instructions: '- lavora solo sui dati forniti.',
    outputFormat: '- restituisci solo il contenuto utile al task.'
  };
}

function normalizeAcademicInput(input, task = 'generic') {
  if (typeof input === 'string') {
    return {
      disciplinaryProfile: formatDisciplinaryProfile(inferDisciplinaryProfile({}, {})),
      context: formatContextBlock({}),
      sourcePolicy: formatSourcePolicy({}),
      consistencyPolicy: formatConsistencyPolicy({}, task),
      lengthPolicy: formatLengthPolicy(task, {}),
      continuity: formatContinuityBlock({}),
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
    targetLunghezza: pickFirstString(safe.targetLunghezza, safe.lengthTarget, safe.wordTarget),
    usaFontiSoloFornite: pickFirstBoolean(safe.usaFontiSoloFornite, safe.sourcesOnly, safe.onlyProvidedSources),
    bibliografiaPresente: detectBibliographyPresence(safe)
  };

  const continuity = {
    tesiCentrale: pickFirstString(safe.tesiCentrale, safe.mainThesis, safe.centralThesis),
    indiceApprovato: pickStructuredValue(safe.indiceApprovato, safe.approvedOutline, safe.outlineApproved),
    sintesiCapitoliPrecedenti: pickStructuredValue(safe.sintesiCapitoliPrecedenti, safe.previousChaptersSummary, safe.chapterHistory),
    glossario: pickStructuredValue(safe.glossario, safe.glossary, safe.terminiChiave),
    terminologiaStabile: pickStructuredValue(safe.terminologiaStabile, safe.fixedTerminology, safe.keyTerms),
    osservazioniRelatore: pickStructuredValue(safe.osservazioniRelatore, safe.tutorNotes, safe.supervisorNotes),
    testoDaRevisionare: pickStructuredValue(safe.testoDaRevisionare, safe.textToReview, safe.draftText)
  };

  return {
    disciplinaryProfile: formatDisciplinaryProfile(inferDisciplinaryProfile(meta, safe)),
    context: formatContextBlock(meta),
    sourcePolicy: formatSourcePolicy(meta),
    consistencyPolicy: formatConsistencyPolicy(continuity, task),
    lengthPolicy: formatLengthPolicy(task, meta),
    continuity: formatContinuityBlock(continuity),
    rawPayload: JSON.stringify(safe, null, 2)
  };
}


function inferDisciplinaryProfile(meta, safe) {
  const facultyRaw = pickFirstString(
    safe.facolta,
    safe.facoltà,
    safe.faculty,
    safe.school,
    safe.areaDidattica,
    meta.corsoDiLaurea,
    meta.disciplina
  ).toLowerCase();

  const profiles = [
    {
      match: ['giurisprudenza', 'law', 'diritto', 'giuridic'],
      label: 'Area giuridica',
      method: 'argomentazione normativa, interpretazione di fonti, distinzione tra principi, disciplina positiva e orientamenti',
      style: 'registro sobrio, tecnico, preciso, con attenzione a definizioni, qualificazioni e nessi logico-giuridici',
      priorities: 'evitare formule vaghe; distinguere dati, interpretazioni e conseguenze applicative; non simulare riferimenti normativi non forniti'
    },
    {
      match: ['psicologia', 'psychology', 'psicologic'],
      label: 'Area psicologica',
      method: 'impianto concettuale chiaro, prudenza terminologica, distinzione tra modelli teorici, evidenze e limiti interpretativi',
      style: 'lessico scientifico accessibile, evitando assolutizzazioni e semplificazioni non giustificate',
      priorities: 'non presentare ipotesi come fatti acquisiti; non inventare studi, scale o risultati empirici'
    },
    {
      match: ['economia', 'economics', 'econom', 'management', 'aziendal'],
      label: 'Area economico-aziendale',
      method: 'struttura analitica, definizione del problema, relazioni causali esplicite e chiarezza tra quadro teorico e applicazioni',
      style: 'linguaggio lineare, tecnico e orientato alla leggibilità professionale',
      priorities: 'non inventare dati quantitativi, benchmark o riferimenti di mercato'
    },
    {
      match: ['lettere', 'filologia', 'storia', 'filosofia', 'humanities', 'umanist'],
      label: 'Area umanistica',
      method: 'analisi concettuale e testuale, ricostruzione coerente del contesto, attenzione alla precisione interpretativa',
      style: 'registro formale ma non gonfio, con progressione argomentativa pulita',
      priorities: 'evitare parafrasi decorative, generalizzazioni vaghe e attribuzioni testuali non fondate'
    },
    {
      match: ['medicina', 'medicine', 'medic', 'sanitaria', 'infermier', 'biomed'],
      label: 'Area medico-sanitaria',
      method: 'massima prudenza fattuale, linguaggio tecnico controllato, distinzione chiara tra descrizione, evidenza e implicazioni',
      style: 'scrittura accurata, precisa, senza semplificazioni rischiose',
      priorities: 'non inventare linee guida, studi clinici, dati epidemiologici o indicazioni operative'
    },
    {
      match: ['ingegneria', 'engineering', 'informatica', 'computer science', 'stem', 'matemat', 'fisica'],
      label: 'Area tecnico-scientifica',
      method: 'sequenza logica esplicita, definizioni operative chiare, attenzione a passaggi metodologici e assunzioni',
      style: 'linguaggio preciso, asciutto, non retorico',
      priorities: 'non inventare risultati sperimentali, formule, metriche o riferimenti tecnici non forniti'
    },
    {
      match: ['scienze della formazione', 'pedagogia', 'education', 'didattic'],
      label: 'Area pedagogico-formativa',
      method: 'chiarezza concettuale, attenzione ai modelli educativi, legame tra teoria, contesto e implicazioni formative',
      style: 'registro formale, leggibile e ben scandito',
      priorities: 'evitare normatività astratta e riferimenti teorici non supportati dai dati'
    }
  ];

  const found = profiles.find(profile => profile.match.some(token => facultyRaw.includes(token)));

  return found || {
    label: 'Profilo disciplinare non specificato',
    method: 'impostazione accademica generale, con rigore logico e prudenza',
    style: 'registro universitario chiaro, sobrio e coerente',
    priorities: 'non inventare fonti o dati; evitare genericità e sovra-asserzioni'
  };
}

function formatDisciplinaryProfile(profile) {
  return [
    `- Profilo riconosciuto: ${profile.label}`,
    `- Metodo argomentativo da privilegiare: ${profile.method}`,
    `- Registro da mantenere: ${profile.style}`,
    `- Priorità critiche: ${profile.priorities}`
  ].join('\n');
}

function formatContinuityBlock(data) {
  const rows = [
    ['Tesi centrale', data.tesiCentrale],
    ['Indice approvato', data.indiceApprovato],
    ['Sintesi capitoli precedenti', data.sintesiCapitoliPrecedenti],
    ['Glossario o termini chiave', data.glossario],
    ['Terminologia stabile', data.terminologiaStabile],
    ['Osservazioni relatore/tutor', data.osservazioniRelatore],
    ['Testo da revisionare', data.testoDaRevisionare]
  ];

  return rows
    .map(([label, value]) => `${label}:\n${value || 'non fornito'}`)
    .join('\n\n');
}

function formatSourcePolicy(meta) {
  const citationStyle = meta.stileCitazionale || 'non specificato';
  const sourcesOnly = meta.usaFontiSoloFornite ? 'sì' : 'non specificato';
  const bibliographyPresent = meta.bibliografiaPresente ? 'sì' : 'no o non chiaro';

  return [
    `- Stile citazionale richiesto: ${citationStyle}`,
    `- Usa solo fonti fornite: ${sourcesOnly}`,
    `- Bibliografia o fonti nei dati: ${bibliographyPresent}`,
    '- se le fonti nei dati sono assenti o insufficienti, non inventare riferimenti;',
    '- se citi autori o opere già presenti nei dati, mantieni coerenza formale e prudenza;',
    '- non costruire bibliografie fittizie per rendere il testo più accademico.'
  ].join('\n');
}


function formatLengthPolicy(task, meta) {
  const declaredTarget = meta.targetLunghezza || 'non specificato';

  const defaults = {
    outline_draft: {
      focus: 'struttura completa ma asciutta, evitando articolazioni decorative',
      target: 'estensione proporzionata a un indice universitario leggibile'
    },
    abstract_draft: {
      focus: 'alta densità informativa e forte sintesi',
      target: 'abstract breve o medio, salvo diverso target esplicito nei dati'
    },
    chapter_draft: {
      focus: 'sviluppo argomentativo pieno, con paragrafi sostanziali e progressione logica continua',
      target: 'lunghezza ampia e coerente con un vero capitolo di tesi, salvo target diverso nei dati'
    },
    outline_review: {
      focus: 'diagnosi sintetica + struttura revisionata',
      target: 'intervento concentrato, senza espansioni superflue'
    },
    abstract_review: {
      focus: 'massima sintesi nelle criticità e revisione compatta',
      target: 'output breve e operativo'
    },
    chapter_review: {
      focus: 'diagnosi breve ma utile + testo revisionato completo quando richiesto',
      target: 'output medio o ampio a seconda del testo ricevuto'
    },
    tutor_revision: {
      focus: 'recepimento selettivo delle osservazioni con conservazione del testo',
      target: 'output proporzionato al numero di modifiche richieste'
    },
    final_consistency_review: {
      focus: 'controllo mirato, ordinato per priorità, con eventuale coerentizzazione minima',
      target: 'output medio, salvo elaborati molto estesi'
    },
    generic: {
      focus: 'completezza proporzionata e nessuna dilatazione artificiale',
      target: 'lunghezza coerente con il task e con i dati disponibili'
    }
  };

  const current = defaults[task] || defaults.generic;

  return [
    `- Target dichiarato nei dati: ${declaredTarget}`,
    `- Criterio di profondità: ${current.focus}`,
    `- Criterio di estensione: ${current.target}`,
    '- evita sia il sottosviluppo sia l’espansione riempitiva;',
    '- se il target dichiarato è assente, regola la lunghezza in funzione del task e della qualità dei dati, non della sola verbosità.'
  ].join('\n');
}

function formatConsistencyPolicy(continuity, task) {
  const revisionTasks = new Set(['chapter_review', 'tutor_revision', 'final_consistency_review', 'abstract_review', 'outline_review']);
  const hasStableTerms = !!continuity.terminologiaStabile || !!continuity.glossario;
  const hasCentralThesis = !!continuity.tesiCentrale;

  const lines = [
    `- Task di revisione o controllo: ${revisionTasks.has(task) ? 'sì' : 'no'}`,
    `- Tesi centrale disponibile: ${hasCentralThesis ? 'sì' : 'no'}`,
    `- Terminologia stabile o glossario disponibile: ${hasStableTerms ? 'sì' : 'no'}`,
    '- preserva la terminologia già stabile quando è presente nei dati;',
    '- evita sinonimi impropri che spostino il significato teorico o metodologico;',
    '- non modificare la tesi centrale, l’asse argomentativo o le definizioni chiave salvo richiesta esplicita o necessità logica evidente;',
    '- se intervieni su passaggi deboli, fallo in modo conservativo e localizzato, senza rifondare il testo;',
    '- se noti incoerenze terminologiche reali, uniformale scegliendo la forma più coerente con i materiali già forniti.'
  ];

  if (revisionTasks.has(task)) {
    lines.push('- nelle revisioni distingui sempre tra miglioramento e alterazione: migliora la forma e la tenuta logica, non cambiare inutilmente l’impianto.');
  }

  return lines.join('\n');
}


function getTaskQualityRubric(task) {
  const rubrics = {
    outline_draft: [
      '- i titoli devono essere specifici e non ornamentali;',
      '- la progressione deve essere difendibile davanti a un relatore;',
      '- ogni sezione deve avere una funzione riconoscibile nell'impianto.'
    ],
    abstract_draft: [
      '- il testo deve rendere chiari oggetto, obiettivo e perimetro;',
      '- nessuna promessa di risultati non presenti nei dati;',
      '- ogni frase deve avere alta utilità informativa.'
    ],
    chapter_draft: [
      '- ogni paragrafo deve far avanzare davvero l'argomentazione;',
      '- le transizioni devono essere esplicite ma sobrie;',
      '- evitare ripetizioni, digressioni e riempitivi pseudo-accademici.'
    ],
    outline_review: [
      '- le criticità devono essere reali e non pretestuose;',
      '- la revisione deve migliorare la difendibilità senza appesantire;'
    ],
    abstract_review: [
      '- correggere vaghezze e ridondanze con interventi mirati;',
      '- preservare il nucleo informativo già valido.'
    ],
    chapter_review: [
      '- migliorare logica e stile senza rifondare inutilmente il testo;',
      '- ogni intervento deve avere una giustificazione leggibile.'
    ],
    tutor_revision: [
      '- le osservazioni del relatore hanno priorità alta;',
      '- ogni modifica deve restare proporzionata alla richiesta.'
    ],
    final_consistency_review: [
      '- segnalare solo incongruenze concrete e prioritarie;',
      '- distinguere bene difetti sostanziali e semplici rifiniture.'
    ],
    generic: [
      '- output sobrio, utile, coerente e privo di riempitivi.'
    ]
  };

  const selected = rubrics[task] || rubrics.generic;
  return selected.join('\n');
}

function detectBibliographyPresence(safe) {
  const candidates = [
    safe.bibliografia,
    safe.bibliography,
    safe.fonti,
    safe.sources,
    safe.references,
    safe.referenceList
  ];

  return candidates.some(value => {
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return false;
  });
}

function pickFirstBoolean(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return false;
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

function pickStructuredValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length) return JSON.stringify(value, null, 2);
    if (value && typeof value === 'object' && Object.keys(value).length) return JSON.stringify(value, null, 2);
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
