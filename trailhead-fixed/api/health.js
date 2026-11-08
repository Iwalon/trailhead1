// GET /api/health — the app calls this once to decide whether a backend is available.
// Every key ask.js knows how to use has to be listed here too, or the app switches
// the AI off before it ever makes a request.
export default function handler(req, res) {
  const gemini    = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  const anthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const openaiish = Boolean(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || process.env.AI_API_KEY);
  const wants = (process.env.AI_PROVIDER || "").toLowerCase();
  // ask.js walks these in order, falling through on a rate limit or an outage,
  // so showing the whole chain makes a missing key obvious at a glance.
  const prefer = wants.replace("google", "gemini");
  const chain = [];
  if (gemini) chain.push("gemini");
  if (process.env.GROQ_API_KEY) chain.push("groq");
  if (process.env.OPENAI_API_KEY || process.env.AI_API_KEY) chain.push("openai");
  if (anthropic) chain.push("anthropic");
  if (prefer) chain.sort((a, b) => (b === prefer) - (a === prefer));

  res.status(200).json({
    ok: chain.length > 0,
    provider: chain[0] || "none",
    chain,
    keys: { gemini, anthropic, openaiish },
    fulltext: Boolean(process.env.CORE_API_KEY),
  });
}
