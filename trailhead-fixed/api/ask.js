// POST /api/ask  — the only place your Anthropic key lives.
// Body: { input: string | [{role,content}], modelTier?: "quick"|"default"|"complex" }
// Returns: { text, truncated }

// Two providers. Set ANTHROPIC_API_KEY for Claude, or GROQ_API_KEY for Groq.
// If both are set, ANTHROPIC wins unless you set AI_PROVIDER=groq.
function provider() {
  const wants = (process.env.AI_PROVIDER || "").toLowerCase();
  const hasClaude = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAIish = !!(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || process.env.AI_API_KEY);
  if (wants === "groq" || wants === "openai" || (!hasClaude && hasOpenAIish)) {
    return {
      kind: "openai",
      key: process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || process.env.AI_API_KEY,
      base: process.env.AI_BASE_URL || (process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1" : "https://api.openai.com/v1"),
      models: {
        quick:   process.env.MODEL_QUICK   || "llama-3.1-8b-instant",
        default: process.env.MODEL_DEFAULT || "llama-3.3-70b-versatile",
        complex: process.env.MODEL_COMPLEX || "llama-3.3-70b-versatile",
      },
    };
  }
  if (hasClaude) {
    return {
      kind: "anthropic",
      key: process.env.ANTHROPIC_API_KEY,
      base: "https://api.anthropic.com",
      models: {
        quick:   process.env.MODEL_QUICK   || "claude-haiku-4-5-20251001",
        default: process.env.MODEL_DEFAULT || "claude-sonnet-4-5-20250929",
        complex: process.env.MODEL_COMPLEX || "claude-sonnet-4-5-20250929",
      },
    };
  }
  return null;
}

const MAX_INPUT_BYTES = 64 * 1024;   // same cap the app budgets against
const MAX_OUTPUT_TOKENS = 4096;

// Crude per-instance rate limit. Serverless instances are recycled, so this
// slows abuse rather than stopping it — set a spend cap in the Anthropic console too.
const hits = new Map();
function rateLimited(ip, perMinute = 20) {
  const now = Date.now();
  const win = hits.get(ip) || [];
  const recent = win.filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > perMinute;
}

function originAllowed(req) {
  const allow = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allow.length) return true;                       // not configured: allow all
  const origin = req.headers.origin || "";
  if (!origin) return true;                             // same-origin fetches often send none
  return allow.includes(origin);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ code: "bad_method", message: "POST only" });

  const P = provider();
  if (!P) {
    return res.status(500).json({ code: "no_key", message: "Set ANTHROPIC_API_KEY or GROQ_API_KEY on the server" });
  }
  if (!originAllowed(req)) {
    return res.status(403).json({ code: "forbidden", message: "Origin not allowed" });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";
  if (rateLimited(ip, Number(process.env.RATE_PER_MIN || 20))) {
    return res.status(429).json({ code: "rate_limited", message: "Slow down a moment." });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || !body.input) return res.status(400).json({ code: "invalid_request", message: "input required" });

  // Normalise to Anthropic's messages format
  const messages = typeof body.input === "string"
    ? [{ role: "user", content: body.input }]
    : (Array.isArray(body.input) ? body.input : []).filter(
        (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()
      );
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ code: "invalid_request", message: "input must end with a user turn" });
  }

  const bytes = Buffer.byteLength(messages.map((m) => m.content).join(""), "utf8");
  if (bytes > MAX_INPUT_BYTES) {
    return res.status(413).json({ code: "prompt_too_large", message: `Input is ${bytes} bytes; cap is ${MAX_INPUT_BYTES}.` });
  }

  const model = P.models[body.modelTier] || P.models.default;

  const url = P.kind === "anthropic" ? `${P.base}/v1/messages` : `${P.base}/chat/completions`;
  const headers = P.kind === "anthropic"
    ? { "content-type": "application/json", "x-api-key": P.key, "anthropic-version": "2023-06-01" }
    : { "content-type": "application/json", authorization: `Bearer ${P.key}` };
  const payload = { model, max_tokens: MAX_OUTPUT_TOKENS, messages };

  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    const data = await r.json().catch(() => null);

    if (!r.ok) {
      const msg = data?.error?.message || "Upstream error";
      const code =
        r.status === 429 ? "rate_limited" :
        r.status === 401 || r.status === 403 ? "session_expired" :
        r.status === 400 ? "invalid_request" : "upstream_error";
      console.error(`${P.kind} error`, r.status, msg);
      return res.status(r.status === 429 ? 429 : 502).json({ code, message: msg });
    }

    if (P.kind === "anthropic") {
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      return res.status(200).json({ text, truncated: data.stop_reason === "max_tokens" });
    }
    const choice = (data.choices || [])[0] || {};
    return res.status(200).json({
      text: String(choice.message?.content || ""),
      truncated: choice.finish_reason === "length",
    });
  } catch (err) {
    console.error("ask failed", err);
    return res.status(502).json({ code: "upstream_error", message: "Could not reach the model." });
  }
}
