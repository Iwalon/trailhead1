// POST /api/ask  — the only place your model keys live.
// Body: { input: string | [{role,content}], modelTier?: "quick"|"default"|"complex" }
// Returns: { text, truncated, provider, model }
//
// Set any of GEMINI_API_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY. Every key you set
// becomes a link in a chain: if the first provider is rate limited, down, or
// refuses the key, the request moves to the next one and the page never notices.
// AI_PROVIDER = gemini | groq | anthropic just decides who goes first.

// A key pasted into a dashboard picks up stray whitespace, newlines, quotes, and
// sometimes the whole value twice. Any of those make an invalid header, and the
// request dies before it leaves this server. Clean it up rather than fail.
function cleanKey(raw) {
  let k = String(raw || "").trim().replace(/^["']|["']$/g, "");
  k = k.replace(/\s+/g, " ").trim();
  if (k.includes(" ")) {
    const parts = k.split(" ").filter(Boolean);
    // "<key> <key>" from a double paste: keep one. Anything else is unusable.
    k = parts.every((p) => p === parts[0]) ? parts[0] : "";
  }
  return /[^\x21-\x7e]/.test(k) ? "" : k;   // headers are printable ASCII only
}

// Never let a secret reach the browser. Upstream errors quote the header they
// rejected, which means the key itself ends up in the message.
function redact(msg, keys) {
  let s = String(msg || "");
  for (const k of keys) {
    if (k && k.length > 7) s = s.split(k).join(`${k.slice(0, 4)}…${k.slice(-2)}`);
  }
  return s.replace(/(Bearer\s+)[A-Za-z0-9._\-]{12,}/gi, "$1[key]");
}

function buildChain() {
  const out = [];
  const env = process.env;

  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) out.push({
    kind: "openai",                      // Gemini speaks OpenAI's chat/completions shape
    name: "gemini",
    key: cleanKey(env.GEMINI_API_KEY || env.GOOGLE_API_KEY),
    base: env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
    models: {
      quick:   env.GEMINI_MODEL_QUICK   || "gemini-3.5-flash-lite",
      default: env.GEMINI_MODEL_DEFAULT || "gemini-3.8-flash",
      complex: env.GEMINI_MODEL_COMPLEX || "gemini-3.8-flash",
    },
    fallbacks: ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"],
    // Gemini 3 always thinks, and thinking tokens come out of the same budget as
    // the answer. Keep thinking short and give the budget real room, or a long
    // JSON reply gets cut off mid-object.
    extra: { reasoning_effort: env.GEMINI_REASONING || "low" },
    maxOutput: Number(env.GEMINI_MAX_TOKENS || 16384),
  });

  if (env.GROQ_API_KEY) out.push({
    kind: "openai",
    name: "groq",
    key: cleanKey(env.GROQ_API_KEY),
    base: env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    models: {
      quick:   env.GROQ_MODEL_QUICK   || "openai/gpt-oss-20b",
      default: env.GROQ_MODEL_DEFAULT || "openai/gpt-oss-120b",
      complex: env.GROQ_MODEL_COMPLEX || "openai/gpt-oss-120b",
    },
    // Groq retires models regularly. If the one we ask for is gone, try these.
    fallbacks: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
    maxOutput: Number(env.GROQ_MAX_TOKENS || 8192),
  });

  if (env.OPENAI_API_KEY || env.AI_API_KEY) out.push({
    kind: "openai",
    name: "openai",
    key: cleanKey(env.OPENAI_API_KEY || env.AI_API_KEY),
    base: env.AI_BASE_URL || "https://api.openai.com/v1",
    models: {
      quick:   env.MODEL_QUICK   || "gpt-4.1-mini",
      default: env.MODEL_DEFAULT || "gpt-4.1",
      complex: env.MODEL_COMPLEX || "gpt-4.1",
    },
    maxOutput: Number(env.OPENAI_MAX_TOKENS || 8192),
  });

  if (env.ANTHROPIC_API_KEY) out.push({
    kind: "anthropic",
    name: "anthropic",
    key: cleanKey(env.ANTHROPIC_API_KEY),
    base: "https://api.anthropic.com",
    models: {
      quick:   env.ANTHROPIC_MODEL_QUICK   || "claude-haiku-4-5-20251001",
      default: env.ANTHROPIC_MODEL_DEFAULT || "claude-sonnet-4-5-20250929",
      complex: env.ANTHROPIC_MODEL_COMPLEX || "claude-sonnet-4-5-20250929",
    },
    maxOutput: Number(env.ANTHROPIC_MAX_TOKENS || 8192),
  });

  // A key we couldn't clean into a usable header is dropped here, with a loud
  // log line, so it can't take down a provider that would otherwise have worked.
  for (const p of out.filter((p) => !p.key)) {
    console.error(`${p.name}: its API key isn't usable as a header — check for a stray space, newline, quote, or a value pasted in twice.`);
  }
  const usable = out.filter((p) => p.key);

  // Whoever the operator named goes first; the rest stay as backups.
  const wants = (process.env.AI_PROVIDER || "").toLowerCase().replace("google", "gemini");
  if (wants) usable.sort((a, b) => (b.name === wants) - (a.name === wants));
  return usable;
}

const MAX_INPUT_BYTES = 64 * 1024;   // same cap the app budgets against

// Crude per-instance rate limit. Serverless instances are recycled, so this
// slows abuse rather than stopping it — set a spend cap with your provider too.
// One reader branching through papers makes a burst of calls, so keep this
// well above what a single person does in a minute.
const hits = new Map();
function rateLimited(ip, perMinute) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
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

// A retired model id shouldn't take the whole app down with it.
const deadModel = (status, msg) =>
  status === 400 &&
  /decommission|deprecat|does not exist|not found|no longer|unknown model|invalid model/i.test(msg || "");

// Worth walking to the next provider? Rate limits, outages and bad keys yes;
// a malformed request of our own would fail identically everywhere.
const worthSwitching = (status) => status === 429 || status === 401 || status === 403 || status >= 500 || status === 0;

// One call to one provider with one model. Never throws.
async function callOnce(P, model, messages, maxTokens) {
  const url = P.kind === "anthropic" ? `${P.base}/v1/messages` : `${P.base}/chat/completions`;
  const headers = P.kind === "anthropic"
    ? { "content-type": "application/json", "x-api-key": P.key, "anthropic-version": "2023-06-01" }
    : { "content-type": "application/json", authorization: `Bearer ${P.key}` };
  const payload = Object.assign({ model, max_tokens: maxTokens, messages }, P.extra || {});

  let r, data;
  try {
    r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    data = await r.json().catch(() => null);
  } catch (err) {
    return { status: 0, message: String(err && err.message || err), text: "", truncated: false };
  }
  if (!r.ok) {
    return { status: r.status, message: data?.error?.message || `HTTP ${r.status}`, text: "", truncated: false };
  }
  if (P.kind === "anthropic") {
    return {
      status: 200, message: "",
      text: (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""),
      truncated: data.stop_reason === "max_tokens",
    };
  }
  const choice = (data.choices || [])[0] || {};
  return {
    status: 200, message: "",
    text: String(choice.message?.content || ""),
    truncated: choice.finish_reason === "length",
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ code: "bad_method", message: "POST only" });

  const chain = buildChain();
  if (!chain.length) {
    const anySet = ["GEMINI_API_KEY","GOOGLE_API_KEY","GROQ_API_KEY","OPENAI_API_KEY","AI_API_KEY","ANTHROPIC_API_KEY"]
      .some((n) => process.env[n]);
    return res.status(500).json({
      code: "no_key",
      message: anySet
        ? "A key is set but isn't a usable header value — check for a stray space, newline, quote, or the key pasted in twice."
        : "Set GEMINI_API_KEY, GROQ_API_KEY or ANTHROPIC_API_KEY on the server",
    });
  }
  const secrets = chain.map((p) => p.key);
  if (!originAllowed(req)) {
    return res.status(403).json({ code: "forbidden", message: "Origin not allowed" });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";
  if (rateLimited(ip, Number(process.env.RATE_PER_MIN || 90))) {
    return res.status(429).json({ code: "rate_limited", message: "This page is sending requests faster than its own limit allows. Wait a few seconds." });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || !body.input) return res.status(400).json({ code: "invalid_request", message: "input required" });

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

  const tier = body.modelTier;
  const tried = [];                 // breadcrumbs, so a failure says what it actually tried
  let last = { status: 502, message: "No provider answered." };

  for (const P of chain) {
    const first = P.models[tier] || P.models.default;
    const models = [first, ...(P.fallbacks || [])].filter((m, i, a) => m && a.indexOf(m) === i);
    let switchProvider = false;

    for (const model of models) {
      let budget = P.maxOutput;

      // Up to two goes at this model: if it ran out of room, give it more.
      for (let attempt = 0; attempt < 2; attempt++) {
        const out = await callOnce(P, model, messages, budget);
        tried.push(`${P.name}/${model}${attempt ? `@${budget}` : ""}:${out.status}`);

        if (out.status === 200 && out.text.trim() && !out.truncated) {
          return res.status(200).json({ text: out.text, truncated: false, provider: P.name, model });
        }

        // Ran out of room — thinking models can spend the lot before writing a word.
        if (out.status === 200 && (out.truncated || !out.text.trim())) {
          if (attempt === 0) { budget = Math.min(budget * 2, 32768); continue; }
          // Still short after a doubled budget. A partial answer beats nothing:
          // the page knows how to repair a cut-off reply.
          if (out.text.trim()) {
            return res.status(200).json({ text: out.text, truncated: true, provider: P.name, model });
          }
          last = { status: 502, message: `${P.name}/${model} spent its whole budget thinking and returned nothing.` };
          switchProvider = true;
          break;
        }

        last = { status: out.status, message: out.message, provider: P.name, model };
        if (deadModel(out.status, out.message)) { console.warn(`model "${model}" is gone, trying the next`); break; }
        if (worthSwitching(out.status)) { switchProvider = true; break; }
        // A request this provider considers malformed will look the same everywhere.
        console.error(`${P.name} error`, out.status, model, out.message);
        return res.status(400).json({ code: "invalid_request", message: redact(out.message, secrets), provider: P.name, model });
      }
      if (switchProvider) break;
    }
    if (chain.length > 1) console.warn(`${P.name} did not answer (${last.message}); falling back`);
  }

  const code =
    last.status === 429 ? "rate_limited" :
    last.status === 401 || last.status === 403 ? "session_expired" : "upstream_error";
  console.error("every provider failed:", tried.join(" | "));
  return res.status(last.status === 429 ? 429 : 502).json({
    code,
    message: redact(
      chain.length > 1 ? `All ${chain.length} providers failed. Last: ${last.message}` : last.message,
      secrets
    ),
    tried,
  });
}
