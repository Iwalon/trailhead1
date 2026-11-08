// GET /api/health — the app calls this once to decide whether a backend is available.
// Every key ask.js knows how to use has to be listed here too, or the app switches
// the AI off before it ever makes a request.
export default function handler(req, res) {
  const gemini    = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  const anthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const openaiish = Boolean(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || process.env.AI_API_KEY);
  const wants = (process.env.AI_PROVIDER || "").toLowerCase();
  res.status(200).json({
    ok: gemini || anthropic || openaiish,
    // which one ask.js will actually pick, so a misconfigured key is visible
    provider: wants || (gemini ? "gemini" : anthropic ? "anthropic" : openaiish ? "groq" : "none"),
    keys: { gemini, anthropic, openaiish },
    fulltext: Boolean(process.env.CORE_API_KEY),
  });
}
