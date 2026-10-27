// GET /api/health — the app calls this once to decide whether a backend is available.
export default function handler(req, res) {
  res.status(200).json({
    ok: Boolean(process.env.ANTHROPIC_API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || process.env.AI_API_KEY),
    fulltext: Boolean(process.env.CORE_API_KEY),
  });
}
