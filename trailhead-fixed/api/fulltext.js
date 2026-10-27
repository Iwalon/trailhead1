// GET /api/fulltext?doi=...&title=...
// Returns { text, source } when a legal open-access full text can be found, else { text: null }.
// Tries, in order: Europe PMC (life sciences), arXiv (physics/CS/maths), CORE (everything else).
// All of these serve open-access content only. Paywalled papers stay abstract-only.

const UA = { "User-Agent": `Trailhead/1.0 (${process.env.CONTACT_EMAIL || "unknown@example.org"})` };
const TIMEOUT = 12000;

async function get(url, headers) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { ...UA, ...(headers || {}) } });
    return r.ok ? r : null;
  } catch { return null; }
  finally { clearTimeout(t); }
}

const strip = (xml) =>
  xml.replace(/<(script|style|ref-list|back)[\s\S]*?<\/\1>/gi, " ")
     .replace(/<[^>]+>/g, " ")
     .replace(/&[a-z]+;|&#\d+;/gi, " ")
     .replace(/\s+/g, " ")
     .trim();

async function europePmc(doi) {
  if (!doi) return null;
  const s = await get(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:%22${encodeURIComponent(doi)}%22&format=json&resultType=core`);
  if (!s) return null;
  const j = await s.json().catch(() => null);
  const hit = j?.resultList?.result?.[0];
  if (!hit || hit.isOpenAccess !== "Y" || !hit.pmcid) return null;
  const f = await get(`https://www.ebi.ac.uk/europepmc/webservices/rest/${hit.pmcid}/fullTextXML`);
  if (!f) return null;
  const text = strip(await f.text());
  return text.length > 2000 ? { text, source: "Europe PMC" } : null;
}

async function arxiv(title) {
  if (!title) return null;
  const q = `ti:"${title.replace(/["]/g, "")}"`;
  const s = await get(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&max_results=1`);
  if (!s) return null;
  const xml = await s.text();
  const id = (xml.match(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/) || [])[1];
  const got = (xml.match(/<title>([\s\S]*?)<\/title>/g) || [])[1];
  if (!id || !got) return null;
  const norm = (t) => t.replace(/<[^>]+>/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (norm(got) !== norm(title)) return null;        // wrong paper; don't guess
  // arXiv asks that you not scrape PDFs; the abstract page carries the abstract only.
  const summary = (xml.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1];
  return summary ? { text: strip(summary), source: `arXiv:${id} (abstract)` } : null;
}

async function core(doi, title) {
  const key = process.env.CORE_API_KEY;
  if (!key) return null;
  const q = doi ? `doi:"${doi}"` : `title:"${String(title).replace(/"/g, "")}"`;
  const r = await get(`https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(q)}&limit=1`, {
    Authorization: `Bearer ${key}`,
  });
  if (!r) return null;
  const j = await r.json().catch(() => null);
  const hit = j?.results?.[0];
  const text = hit?.fullText;
  return text && text.length > 2000 ? { text: String(text), source: "CORE" } : null;
}

export default async function handler(req, res) {
  const doi = String(req.query?.doi || "").trim();
  const title = String(req.query?.title || "").trim();
  if (!doi && !title) return res.status(400).json({ code: "invalid_request", message: "doi or title required" });

  try {
    const got = (await europePmc(doi)) || (await core(doi, title)) || (await arxiv(title));
    // Cache hard: a paper's text does not change.
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json(got ? { text: got.text.slice(0, 60000), source: got.source } : { text: null });
  } catch (err) {
    console.error("fulltext failed", err);
    return res.status(200).json({ text: null });
  }
}
