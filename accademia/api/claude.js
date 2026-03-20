export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const forwardedBody = normalizeLegacyBody(req.body);

    const response = await fetch(`${origin}/api/task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(forwardedBody)
    });

    const data = await response.json().catch(() => ({}));
    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({
      error: 'Proxy legacy fallita',
      details: error?.message || 'Errore sconosciuto'
    });
  }
}

function normalizeLegacyBody(body) {
  if (typeof body === 'string') {
    return {
      task: 'chapter_draft',
      input: body.trim()
    };
  }

  const safe = body && typeof body === 'object' ? { ...body } : {};
  const task = typeof safe.task === 'string' && safe.task.trim() ? safe.task.trim() : 'chapter_draft';

  if (safe.input !== undefined || safe.payload !== undefined || safe.content !== undefined) {
    return {
      ...safe,
      task
    };
  }

  return {
    task,
    input: JSON.stringify(safe)
  };
}
