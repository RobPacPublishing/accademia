const OPENAI_TIMEOUT_MS = 90000;
const ANTHROPIC_TIMEOUT_MS = 90000;
const DEFAULT_UNLOCK_CODE_RECIPIENT = process.env.UNLOCK_CODE_EMAIL || 'robpacpublishing@gmail.com';
const PERSONAL_FREE_TEST_CODE = process.env.FREE_UNLOCK_TEST_CODE || 'TESIA-ROBP-TEST';
const PERSONAL_PREMIUM_TEST_CODE = process.env.PREMIUM_UNLOCK_TEST_CODE || 'TESIA-ROBP-PREM';
const UNLOCK_CODE_TASKS = new Set([
  'issue_unlock_code',
  'request_unlock_code',
  'send_unlock_code',
  'create_unlock_code',
  'free_unlock_code',
  'unlock_code_request'
]);

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
    const normalized = normalizeBody(req.body);
    const { task, input } = normalized;

    if (!task) {
      return res.status(400).json({ error: 'Task mancante' });
    }

    if (UNLOCK_CODE_TASKS.has(task)) {
      return await handleUnlockCodeRequest({ task, normalized, res });
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
  const rawInput =
    typeof safe.input === 'string'
      ? safe.input
      : typeof safe.payload === 'string'
        ? safe.payload
        : typeof safe.content === 'string'
          ? safe.content
          : JSON.stringify(safe.input ?? safe.payload ?? safe.content ?? {}, null, 2);

  return {
    task,
    input: rawInput,
    body: safe,
    parsedInput: parseMaybeJson(rawInput)
  };
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
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

async function handleUnlockCodeRequest({ task, normalized, res }) {
  const plan = pickUnlockPlan(normalized, task);
  const recipient = pickUnlockRecipient(normalized);
  const codeType = plan === 'premium' ? 'premium' : 'base';
  const planLabel = codeType === 'premium' ? 'Pacchetto Premium' : 'Pacchetto Base';
  const code = codeType === 'premium' ? PERSONAL_PREMIUM_TEST_CODE : PERSONAL_FREE_TEST_CODE;

  await sendUnlockCodeEmail({ recipient, code, planLabel });

  return res.status(200).json({
    ok: true,
    task,
    text: `Codice ${planLabel} inviato via email.`,
    recipient,
    plan: codeType
  });
}

function pickUnlockPlan(normalized, task) {
  const sources = [
    normalized.body,
    normalized.body?.input,
    normalized.parsedInput
  ];

  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const raw = source.plan || source.package || source.tier || source.type;
    if (typeof raw === 'string') {
      const value = raw.trim().toLowerCase();
      if (value === 'premium') return 'premium';
      if (value === 'base' || value === 'free' || value === 'gratuito') return 'base';
    }
  }

  return task === 'free_unlock_code' ? 'base' : 'base';
}

function pickUnlockRecipient(normalized) {
  const sources = [
    normalized.body,
    normalized.body?.input,
    normalized.parsedInput
  ];

  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const raw = source.email || source.recipient || source.to;
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
  }

  return DEFAULT_UNLOCK_CODE_RECIPIENT;
}

async function sendUnlockCodeEmail({ recipient, code, planLabel }) {

  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;

  if (!resendKey) {
    throw new Error('RESEND_API_KEY non configurata');
  }

  if (!from) {
    throw new Error('RESEND_FROM_EMAIL non configurata');
  }

  const subject = `${planLabel} AccademIA - Codice di attivazione`;
  const text = [
    `È stato generato un nuovo codice per ${planLabel}.`,
    '',
    `Codice: ${code}`,
    '',
    'Inseriscilo nella sezione "Inserisci codice" dell’app AccademIA per sbloccare le revisioni aggiuntive.'
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#1f1f1f">
      <h2 style="margin:0 0 12px">${escapeHtml(planLabel)} AccademIA</h2>
      <p style="margin:0 0 10px">È stato generato un nuovo codice di attivazione.</p>
      <p style="margin:0 0 16px"><strong>Codice:</strong> <span style="font-size:18px;letter-spacing:2px">${escapeHtml(code)}</span></p>
      <p style="margin:0">Inseriscilo nella sezione <strong>Inserisci codice</strong> dell’app AccademIA per sbloccare le revisioni aggiuntive.</p>
    </div>
  `;

  const response = await fetchWithTimeout(
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject,
        text,
        html
      })
    },
    30000
  );

  const data = await safeJson(response);

  if (!response.ok) {
    throw new Error(`Errore invio email Resend: ${simplifyProviderError(data)}`);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

    tutor_revision: `Applica in modo rigoroso e prioritario le osservazioni del relatore o tutor al testo ricevuto.
- Tratta le osservazioni come istruzioni vincolanti di revisione del capitolo, non come semplice prompt di rigenerazione generica.
- Mantieni struttura, funzione del capitolo e coerenza con indice e abstract, salvo correzione esplicitamente richiesta.
- Intervieni in modo mirato ma sostanziale dove le osservazioni lo richiedono.
- Non aggiungere contenuti non richiesti.
- Non introdurre fonti o riferimenti non presenti nei dati.
- Restituisci solo il testo revisionato finale.`,

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
      .filter(part => part?.type === 'output_text' && part?.text)
      .map(part => part.text)
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
