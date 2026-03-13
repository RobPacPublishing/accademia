export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const origin =
      req.headers.origin ||
      `https://${req.headers.host}`;

    const response = await fetch(`${origin}/api/task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        task: 'chapter_draft',
        input: typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}, null, 2)
      })
    });

    const data = await response.json().catch(() => ({}));

    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({
      error: 'Proxy claude fallita',
      details: error?.message || 'Errore sconosciuto'
    });
  }
}
