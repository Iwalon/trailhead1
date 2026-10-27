# Trailhead

An AI research explorer: pick a field, follow papers by plain-language headlines, build a
vocabulary as you go, collect what the literature can't do yet, and turn one of those gaps
into an idea of your own.

This is the deployable version. Unlike the artifact, it can reach the internet, so every
paper is checked against a real database before you see it.

---

## What runs where

| Piece | Where it runs | Needs a key? |
|---|---|---|
| The app (`index.html`) | The browser | No |
| Paper lookup — OpenAlex | Browser, direct | No, just a contact email |
| Full text — Europe PMC, CORE, arXiv | `api/fulltext.js` | CORE only, free |
| The AI (summaries, Scout, idea chat) | `api/ask.js` | Yes — Groq or Anthropic |

OpenAlex sends permissive CORS headers, so the browser calls it directly and **no backend is
involved in verifying papers**. The backend exists for two reasons only: to hold your
Anthropic key where visitors can't read it, and to fetch full text from services that don't
allow browser calls.

## Deploy it

1. **Get an API key.** Either works:
   - **Groq** — <https://console.groq.com> → API Keys. Free tier, very fast, no card needed.
   - **Claude** — <https://console.anthropic.com> → API Keys. Costs a few cents per article; set a
     monthly spend cap while you're there.
2. **Put this folder on GitHub** (a private repo is fine).
3. **Import it at <https://vercel.com/new>.** Vercel detects the layout; no build settings needed.
4. **Add environment variables** in Vercel → Settings → Environment Variables. Copy the names
   from `.env.example`. For Groq that is `GROQ_API_KEY` and `AI_PROVIDER=groq`; for Claude it is
   `ANTHROPIC_API_KEY`. Nothing else is required.
5. **Edit `config.js`** and put your email in `TRAILHEAD_CONTACT`. OpenAlex and Crossref
   ask callers to identify themselves, and doing so puts you in their faster pool.
6. **Deploy.** The app checks `/api/health` on load; when it answers, the top bar stops saying
   "No database access" and papers start getting verified.

Netlify and Cloudflare Pages work too — the handlers are standard
`export default function (req, res)`; adjust the folder name their functions runtime expects.

## Run it locally

```bash
npm i -g vercel
vercel dev          # reads .env
```

Create `.env` from `.env.example` first. Never commit it.

## Costs and limits

- **Groq** — free tier with per-minute and per-day limits. Nothing to pay, but a busy day can hit
  the ceiling.
- **Anthropic** — a few cents per article opened. `RATE_PER_MIN` caps requests per IP per minute;
  the console spend cap is your real backstop.
- **OpenAlex** — free, ~100k calls/day, no key.
- **CORE** — free key at <https://core.ac.uk/services/api>, unlocks open-access full text.
- **Europe PMC, arXiv** — free, no key.

## Locking it down

The API is open by default so it works the moment you deploy. Before sharing the link:

- Set `ALLOWED_ORIGINS` to your own domain so other sites can't spend your key.
- Lower `RATE_PER_MIN`.
- Set a hard spend cap in the Anthropic console.

If it goes beyond friends and classmates, add real accounts — the IP rate limit is a speed
bump, not a lock, and serverless instances reset it when they recycle.

## What's still true after deploying

Verification fixes a lot: real titles, authors, venues, DOIs, citation counts, peer-review
status and retraction flags, plus the real abstract feeding every summary, and open-access
full text where it exists.

It does not fix everything:

- **Paywalled papers stay abstract-only.** Publishers license full-text mining to
  institutions, not individuals. Open access covers roughly half of recent work and most of
  arXiv's fields.
- **Claude can still misread a paper** it has in full.
- **"Is this idea new?" stays hard.** Searching 250M papers helps enormously, but absence of
  evidence is not proof. The app is written to show its work rather than promise novelty.

## Layout

```
index.html          the whole app, one file — Vercel serves this at /
config.js           your contact email
api/ask.js          AI proxy — your key lives here, never in the browser
api/fulltext.js     Europe PMC / CORE / arXiv full text
api/health.js       tells the app a backend exists
puter/index.html    the standalone build, also served at /puter/
```

`index.html` must stay at the repository root. Vercel has no build step here, so it serves the
root directory; moving the app into a subfolder makes `/` return 404.

`public/index.html` still runs unchanged as a Claude artifact: it uses the artifact's own AI
when it's there and falls back to `/api/ask` when it isn't. One file, both homes.


## Why the key belongs here, not in the page

On this site the key sits in a Vercel environment variable. The browser never sees it; it calls
`/api/ask`, and the function adds the key server-side. Someone reading your page source finds
nothing.

The single-file Puter build is the opposite: whatever key it carries is readable by anyone who
opens it. That is fine for a free-tier key you expect to lose, and wrong for anything else. If a
key starts getting abused, rotate it in the provider's console and the old one dies instantly.

## The Puter build

`puter/index.html` is the whole app in one file, for <https://puter.com> — free hosting, free AI,
no server. Upload it there and you get a `*.puter.site` address.

It ships with **no API key**, so it uses Puter's own AI: free, and billed to whoever is using the
app rather than to you. Nothing of yours is exposed and there is nothing to pay for.

If you want it to use your own provider instead, open **AI settings** in the app and paste a key —
it is stored in that browser only. There is also a `DEFAULT_AI` block near the top of the file if
you want to bake one into a copy you keep to yourself. Never commit a key to this repository: it
is public, and keys in public repos are found by scrapers within hours.

Both builds come from the same code. `index.html` is the version that talks to `api/`.
