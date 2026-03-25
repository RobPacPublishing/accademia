const OPENAI_TIMEOUT_MS = 90000;
const ANTHROPIC_TIMEOUT_MS = 90000;

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


    if (task === 'send_access_key_email') {
      return await handleAccessKeyEmail({ input, req, res });
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


async function handleAccessKeyEmail({ input, req, res }) {
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.ACC_LOGIN_FROM || process.env.RESEND_FROM_EMAIL;
  const appUrl = process.env.ACC_APP_URL || 'https://www.accademia-tesi.it/app/app-index.html';
  const accessKey = process.env.ACC_APP_ACCESS_KEY || 'robpac-accademia-2026';
  const expectedSecret = process.env.ACC_PURCHASE_MAIL_SECRET || '';

  if (!resendKey) {
    return res.status(500).json({ error: 'RESEND_API_KEY non configurata' });
  }
  if (!from) {
    return res.status(500).json({ error: 'ACC_LOGIN_FROM non configurata' });
  }

  const raw = safeParseJson(input);
  const email = typeof raw?.email === 'string' ? raw.email.trim() : '';
  const plan = typeof raw?.plan === 'string' ? raw.plan.trim() : 'AccademIA';
  const supportEmail = typeof raw?.supportEmail === 'string' ? raw.supportEmail.trim() : 'accademia-tesi@gmail.com';
  const providedSecret =
    (req.headers['x-acc-purchase-secret'] || req.headers['x-acc-mail-secret'] || raw?.secret || '').toString().trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email non valida' });
  }

  if (expectedSecret && providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Secret acquisto non valido' });
  }

  const subject = 'La tua chiave di accesso AccademIA';
  const text = [
    'Ciao,',
    '',
    'grazie per aver scelto AccademIA.',
    '',
    'La tua chiave di accesso personale è:',
    '',
    accessKey,
    '',
    'Con questa chiave puoi:',
    '- accedere all’app',
    '- riprendere il lavoro sullo stesso dispositivo',
    '- continuare anche da un altro dispositivo usando la stessa chiave',
    '',
    'Per iniziare:',
    '1. apri AccademIA',
    '2. clicca su "Accedi all’app"',
    '3. inserisci la chiave qui sopra',
    '4. conferma le tre caselle richieste',
    '',
    `Piano associato: ${plan}`,
    '',
    `Accesso app: ${appUrl}`,
    '',
    'Importante: conserva questa chiave con attenzione. È il riferimento principale per accedere al tuo lavoro e riprenderlo.',
    '',
    `Supporto: ${supportEmail}`,
    '',
    'Team AccademIA'
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#1e1e1e;">
      <h2 style="margin:0 0 12px;">La tua chiave di accesso AccademIA</h2>
      <p>Ciao,</p>
      <p>grazie per aver scelto <strong>AccademIA</strong>.</p>
      <p>La tua chiave di accesso personale è:</p>
      <div style="margin:16px 0;padding:14px 18px;border-radius:10px;background:#f7f2df;border:1px solid #e2c977;font-size:20px;font-weight:700;letter-spacing:.6px;">
        ${escapeHtml(accessKey)}
      </div>
      <p><strong>Piano associato:</strong> ${escapeHtml(plan)}</p>
      <p>Con questa chiave puoi accedere all’app, riprendere il lavoro sullo stesso dispositivo e continuare anche da un altro dispositivo usando la stessa chiave.</p>
      <p><strong>Per iniziare:</strong><br>
      1. apri AccademIA<br>
      2. clicca su “Accedi all’app”<br>
      3. inserisci la chiave qui sopra<br>
      4. conferma le tre caselle richieste</p>
      <p><a href="${escapeHtml(appUrl)}" style="display:inline-block;padding:10px 16px;background:#c9a84c;color:#140f02;text-decoration:none;border-radius:8px;font-weight:700;">Apri AccademIA</a></p>
      <p>Importante: conserva questa chiave con attenzione. È il riferimento principale per accedere al tuo lavoro e riprenderlo.</p>
      <p>Supporto: <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a></p>
      <p>Team AccademIA</p>
    </div>`;

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
        to: [email],
        subject,
        html,
        text
      })
    },
    30000
  );

  const data = await safeJson(response);

  if (!response.ok) {
    return res.status(response.status).json({
      error: 'Errore Resend',
      details: simplifyProviderError(data)
    });
  }

  return res.status(200).json({
    ok: true,
    task: 'send_access_key_email',
    provider: 'resend',
    email,
    id: data?.id || null
  });
}

function safeParseJson(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
