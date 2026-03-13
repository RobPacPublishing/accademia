export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { task, input } = req.body || {};

    if (!task) {
      return res.status(400).json({ error: 'Task mancante' });
    }

    let provider = 'openai';

    if (
      task === 'outline_review' ||
      task === 'abstract_review' ||
      task === 'chapter_review' ||
      task === 'tutor_revision' ||
      task === 'final_consistency_review'
    ) {
      provider = 'anthropic';
    }

    if (provider === 'openai') {
      const openaiKey = process.env.OPENAI_API_KEY;
      const openaiModel = process.env.OPENAI_MODEL || 'gpt-5.4';

      if (!openaiKey) {
        return res.status(500).json({ error: 'OPENAI_API_KEY non configurata' });
      }

      const prompt = buildPrompt(task, input);

      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`
        },
        body: JSON.stringify({
          model: openaiModel,
          input: prompt
        })
      });

      const data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json({
          error: 'Errore OpenAI',
          details: data
        });
      }

      const text =
        data.output_text ||
        extractOpenAIText(data) ||
        'Nessun contenuto restituito';

      return res.status(200).json({
        ok: true,
        provider: 'openai',
        task,
        text
      });
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const anthropicModel =
      process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

    if (!anthropicKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurata' });
    }

    const prompt = buildPrompt(task, input);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
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
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Errore Anthropic',
        details: data
      });
    }

    const text =
      data?.content?.map(part => part?.text || '').join('\n').trim() ||
      'Nessun contenuto restituito';

    return res.status(200).json({
      ok: true,
      provider: 'anthropic',
      task,
      text
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Errore interno',
      details: error.message
    });
  }
}

function buildPrompt(task, input) {
  const payload = typeof input === 'string' ? input : JSON.stringify(input || {}, null, 2);

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
      'Applica in modo rigoroso le osservazioni del relatore/tutor al testo ricevuto, modificando solo ciò che è necessario.',
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
