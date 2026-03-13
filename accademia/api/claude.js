export default async function handler(req, res) {
  return res.status(410).json({
    error: 'Endpoint legacy disattivato',
    message: 'Usa /api/task'
  });
}
