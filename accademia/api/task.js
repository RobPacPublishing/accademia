const OPENAI_TIMEOUT_MS = 90000;
const ANTHROPIC_TIMEOUT_MS = 90000;

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
        max_tokens: 4000,
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
  const payload =
    typeof input === 'string'
      ? input
      : JSON.stringify(input || {}, null, 2);

  const map = {
    outline_draft:
      'Genera un indice accademico coerente, difendibile e ben strutturato sulla base dei dati ricevuti. Restituisci solo il contenuto utile.',
    abstract_draft:
      'Genera un abstract accademico chiaro e coerente sulla base dei dati ricevuti. Restituisci solo il contenuto utile.',
    chapter_draft:
      'Scrivi il capitolo richiesto in modo accademico, chiaro e coerente, sulla base dei dati ricevuti. Restituisci solo il contenuto utile.',
    outline_review:
      'Revisiona criticamente l’indice ricevuto, evidenziando problemi e proponendo una versione migliorata coerente con il contesto accademico.',
    abstract_review:
      'Revisiona criticamente l’abstract ricevuto, correggendo debolezze e incoerenze.',
    chapter_review:
      'Revisiona criticamente il capitolo ricevuto, controllando coerenza, chiarezza e robustezza argomentativa.',
    tutor_revision:
      'Applica in modo rigoroso le osservazioni del relatore o tutor al testo ricevuto, modificando solo ciò che è necessario.',
    final_consistency_review:
      'Esegui un controllo finale di coerenza complessiva sull’elaborato ricevuto.'
  };

  return `${map[task] || 'Elabora il contenuto ricevuto in modo utile e coerente.'}\n\nDATI:\n${payload}`;
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
