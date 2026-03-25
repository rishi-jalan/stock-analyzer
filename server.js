const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Load .env if present (no external dependencies needed)
// ---------------------------------------------------------------------------
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8")
    .split("\n")
    .forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const [key, ...rest] = trimmed.split("=");
      if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
    });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT             = process.env.PORT || 3000;
const HOST             = "127.0.0.1";
const PUBLIC_DIR       = path.join(__dirname, "public");
const AI_PROVIDER      = (process.env.AI_PROVIDER || "").trim().toLowerCase();
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL  = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
const OPENAI_KEY       = process.env.OPENAI_API_KEY;
const OPENAI_MODEL     = process.env.OPENAI_MODEL || "gpt-4.1";

// ---------------------------------------------------------------------------
// Cache (in-memory, keyed by normalised stock name)
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_HOURS) || 24) * 60 * 60 * 1000;

const cache = new Map(); // key -> { data, expiresAt }

function cacheKey(stock) {
  return stock.toLowerCase().replace(/\s+/g, " ").trim();
}

function cacheGet(stock) {
  const entry = cache.get(cacheKey(stock));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(cacheKey(stock)); return null; }
  return entry.data;
}

function cacheSet(stock, data) {
  cache.set(cacheKey(stock), { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheStats() {
  const now = Date.now();
  const entries = [...cache.entries()].map(([k, v]) => ({
    key:       k,
    expiresIn: Math.round((v.expiresAt - now) / 60000) + "m",
  }));
  return { size: cache.size, ttlHours: CACHE_TTL_MS / 3600000, entries };
}

// ---------------------------------------------------------------------------
// System prompt (single source of truth — shared by both providers)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a senior equity research analyst. Research stocks and commodities thoroughly and return a structured JSON scorecard.

Respond with valid JSON only — no markdown fences, no preamble.

Scoring rules:
- Each factor scored as rawPct (0–100), then weightedScore = (rawPct / 100) * maxWeight
- moat: max 20 | business: max 15 | industry: max 5 | management: max 5
- fcf: max 15 | profit: max 10 | debt: max 5 | growth: max 5
- intrinsic: max 10 | pe_pb: max 5 | yield: max 3 | peer: max 2
- finalScore = sum of all weightedScores divided by 10

For commodities: moat = supply concentration, business = demand drivers,
management = N/A (neutral score), intrinsic = fair value vs spot.

Return exactly:
{
  "name": "Full company name",
  "ticker": "TICKER",
  "exchange": "NSE/BSE/NASDAQ/etc",
  "sector": "Sector name",
  "marketCap": "e.g. Rs 2.1L Cr / $180B",
  "type": "stock",
  "factors": {
    "moat":       { "rawPct": 0, "weightedScore": 0.0, "synopsis": "" },
    "business":   { "rawPct": 0, "weightedScore": 0.0, "synopsis": "" },
    "industry":   { "rawPct": 0, "weightedScore": 0.0, "synopsis": "" },
    "management": { "rawPct": 0, "weightedScore": 0.0, "synopsis": "" },
    "fcf":        { "rawPct": 0, "weightedScore": 0.0, "synopsis": "" },
    "profit":     { "rawPct": 0, "weightedScore": 0.0, "synopsis": "" },
    "debt":       { "rawPct": 0, "weightedScore": 0.0, "synopsis": "" },
    "growth":     { "rawPct": 0, "weightedScore": 0.0, "synopsis": "" },
    "intrinsic":  { "rawPct": 0, "weightedScore": 0.0, "synopsis": "" },
    "pe_pb":      { "rawPct": 0, "weightedScore": 0.0, "synopsis": "" },
    "yield":      { "rawPct": 0, "weightedScore": 0.0, "synopsis": "" },
    "peer":       { "rawPct": 0, "weightedScore": 0.0, "synopsis": "" }
  },
  "finalScore": 0.0,
  "verdictLabel": "Strong Buy",
  "verdictColor": "#4ade80",
  "verdictTitle": "One punchy sentence title for the verdict",
  "verdictBody": "3-4 sentences. Mention actual numbers, moat characteristics, and risks."
}

Each synopsis: 3–5 bullet lines starting with •, real numbers where available, prefix red flags with ⚠.`;

const USER_PROMPT = stock =>
  `Analyse for a 5+ year investment horizon: "${stock}". Use current public data and recent news. Return the JSON scorecard only.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
};

function writeCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, payload) {
  writeCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function serveStatic(res, urlPath) {
  // Default to index.html for root
  const filePath = path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath);

  // Prevent path traversal outside public/
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || "application/octet-stream";
    writeCorsHeaders(res);
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 500_000) { reject(new Error("Request too large")); req.destroy(); }
    });
    req.on("end",   () => resolve(body));
    req.on("error", reject);
  });
}

function normalise(data) {
  const keys = ["moat","business","industry","management","fcf","profit","debt","growth","intrinsic","pe_pb","yield","peer"];
  const factors = {};
  for (const k of keys) {
    const f = (data.factors && data.factors[k]) || {};
    factors[k] = {
      rawPct:        Number(f.rawPct)        || 0,
      weightedScore: Number(f.weightedScore) || 0,
      synopsis:      String(f.synopsis       || "• No analysis returned"),
    };
  }
  return {
    name:         String(data.name         || "Unknown"),
    ticker:       String(data.ticker       || "N/A"),
    exchange:     String(data.exchange     || "Unknown"),
    sector:       String(data.sector       || ""),
    marketCap:    String(data.marketCap    || ""),
    type:         String(data.type         || "stock"),
    factors,
    finalScore:   Number(data.finalScore)  || 0,
    verdictLabel: String(data.verdictLabel || "Hold"),
    verdictColor: String(data.verdictColor || "#fbbf24"),
    verdictTitle: String(data.verdictTitle || "Mixed investment case"),
    verdictBody:  String(data.verdictBody  || "No verdict provided."),
  };
}

function stripFences(text) {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
}

// ---------------------------------------------------------------------------
// AI providers
// ---------------------------------------------------------------------------
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname, port: 443, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
    };
    const req = https.request(options, res => {
      let raw = "";
      res.on("data", c => { raw += c; });
      res.on("end", () => resolve({ status: res.statusCode, raw }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function callAnthropic(stock) {
  if (!ANTHROPIC_KEY) throw new Error("Set ANTHROPIC_API_KEY in .env before starting.");

  const body = JSON.stringify({
    model: ANTHROPIC_MODEL,
    max_tokens: 3000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: USER_PROMPT(stock) }],
  });

  const { status, raw } = await httpsPost(
    "api.anthropic.com", "/v1/messages",
    { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body
  );

  const parsed = JSON.parse(raw);
  if (status < 200 || status >= 300) throw new Error(parsed.error?.message || "Anthropic error");

  const text = (parsed.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  if (!text) throw new Error("Empty response from Anthropic");
  return normalise(JSON.parse(stripFences(text)));
}

async function callOpenAi(stock) {
  if (!OPENAI_KEY) throw new Error("Set OPENAI_API_KEY in .env before starting.");

  const body = JSON.stringify({
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: USER_PROMPT(stock) },
    ],
  });

  const { status, raw } = await httpsPost(
    "api.openai.com", "/v1/chat/completions",
    { Authorization: `Bearer ${OPENAI_KEY}` },
    body
  );

  const parsed = JSON.parse(raw);
  if (status < 200 || status >= 300) throw new Error(parsed.error?.message || "OpenAI error");

  const content = parsed.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : (content || []).map(p => p.text || "").join("\n");
  if (!text.trim()) throw new Error("Empty response from OpenAI");
  return normalise(JSON.parse(stripFences(text)));
}

function getProvider() {
  if (AI_PROVIDER === "anthropic" || AI_PROVIDER === "openai") return AI_PROVIDER;
  if (ANTHROPIC_KEY) return "anthropic";
  if (OPENAI_KEY)    return "openai";
  return null;
}

function analyse(stock) {
  const provider = getProvider();
  if (provider === "anthropic") return callAnthropic(stock);
  if (provider === "openai")    return callOpenAi(stock);
  throw new Error("Set ANTHROPIC_API_KEY or OPENAI_API_KEY in your .env file.");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    writeCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, provider: getProvider() || "none" });
    return;
  }

  // API — analyse
  if (req.method === "POST" && req.url === "/api/analyse") {
    try {
      const body      = await readBody(req);
      const { stock, force } = JSON.parse(body || "{}");
      if (!stock?.trim()) { sendJson(res, 400, { error: "Missing stock field." }); return; }

      const key    = stock.trim();
      const cached = !force && cacheGet(key);

      if (cached) {
        console.log(`  [cache] HIT  — ${key}`);
        sendJson(res, 200, { ...cached, _cached: true });
        return;
      }

      console.log(`  [cache] MISS — ${key} — calling AI`);
      const result = await analyse(key);
      cacheSet(key, result);
      sendJson(res, 200, { ...result, _cached: false });
    } catch (err) {
      sendJson(res, 500, { error: err.message || "Unexpected error." });
    }
    return;
  }

  // API — cache stats
  if (req.method === "GET" && req.url === "/api/cache") {
    sendJson(res, 200, cacheStats());
    return;
  }

  // API — clear cache
  if (req.method === "DELETE" && req.url === "/api/cache") {
    cache.clear();
    console.log("  [cache] Cleared");
    sendJson(res, 200, { ok: true, message: "Cache cleared." });
    return;
  }

  // Static files
  if (req.method === "GET") {
    serveStatic(res, req.url.split("?")[0]);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  const provider = getProvider();
  console.log(`\n  Stock Analyser  →  http://${HOST}:${PORT}`);
  console.log(`  Provider        →  ${provider || "⚠ no API key found"}`);
  console.log(`  Model           →  ${provider === "openai" ? OPENAI_MODEL : ANTHROPIC_MODEL}\n`);
});
