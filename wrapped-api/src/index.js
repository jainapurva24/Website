// Onchain Wrapped API — Cloudflare Worker
// Routes:
//   GET  /pm/{activity|closed-positions|positions}?...  Polymarket data-api proxy (CORS)
//   POST /share?a=0x..&p=Persona   body: 1200x630 PNG   -> { id, url }
//   GET  /og/:id.png                                    stored preview image
//   GET  /s/:id                                         HTML with X/OG tags, redirects to the site
//   GET  /board                                         leaderboard JSON
//   POST /board  { address, volume, persona, topCoin, pmRealized }  opt-in, verified against Hyperliquid

const PM = "https://data-api.polymarket.com";
const HL = "https://api.hyperliquid.xyz/info";
const YEAR_START = Date.UTC(2026, 0, 1);
const ADDR = /^0x[0-9a-f]{40}$/;
const MAX_PNG = 2 * 1024 * 1024;
const BOARD_SIZE = 50;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const p = url.pathname;

      if (req.method === "GET" && p.startsWith("/pm/")) return pmProxy(url, cors, env);

      if (req.method === "POST" && p === "/share") {
        if (!originAllowed(origin, env)) return json({ error: "origin not allowed" }, 403, cors);
        return share(req, url, env, cors);
      }

      let m;
      if (req.method === "GET" && (m = p.match(/^\/og\/([a-z0-9]{12})\.png$/))) return ogImage(m[1], env);
      if (req.method === "GET" && (m = p.match(/^\/s\/([a-z0-9]{12})$/))) return sharePage(m[1], url, env);

      if (p === "/board" && req.method === "GET") return getBoard(env, cors);
      if (p === "/board" && req.method === "POST") {
        if (!originAllowed(origin, env)) return json({ error: "origin not allowed" }, 403, cors);
        return joinBoard(req, env, cors);
      }

      if (p === "/" ) return new Response("onchain wrapped api", { headers: cors });
      return json({ error: "not found" }, 404, cors);
    } catch (e) {
      return json({ error: "server error", detail: String(e && e.message || e) }, 500, cors);
    }
  },
};

/* ---------------- helpers ---------------- */
function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
}
function originAllowed(origin, env) {
  return allowedOrigins(env).includes(origin);
}
function corsHeaders(origin, env) {
  const h = { "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
  h["Access-Control-Allow-Origin"] = originAllowed(origin, env) ? origin : "*";
  return h;
}
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
function esc(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function cleanText(s, n) {
  return String(s || "").replace(/[^\p{L}\p{N} .,'!?&$+\-%¢·]/gu, "").slice(0, n);
}
function shortAddr(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
function newId() {
  const b = new Uint8Array(6); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

/* ---------------- Polymarket proxy ---------------- */
async function pmProxy(url, cors, env) {
  const path = url.pathname.slice(3); // "/activity" etc
  if (!/^\/(activity|closed-positions|positions)$/.test(path)) return json({ error: "bad path" }, 400, cors);
  const user = (url.searchParams.get("user") || "").toLowerCase();
  if (!ADDR.test(user)) return json({ error: "bad user" }, 400, cors);
  const upstream = await fetch((env.PM_URL || PM) + path + url.search, { cf: { cacheTtl: 120, cacheEverything: true } });
  const body = await upstream.text();
  return new Response(body, { status: upstream.status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=120" } });
}

/* ---------------- share images ---------------- */
async function share(req, url, env, cors) {
  const a = (url.searchParams.get("a") || "").toLowerCase();
  if (!ADDR.test(a)) return json({ error: "bad address" }, 400, cors);
  const persona = cleanText(url.searchParams.get("p"), 40);

  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_PNG) return json({ error: "image too large" }, 413, cors);
  const v = new DataView(buf);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.byteLength < 24 || sig.some((b, i) => v.getUint8(i) !== b)) return json({ error: "not a png" }, 400, cors);
  if (v.getUint32(16) !== 1200 || v.getUint32(20) !== 630) return json({ error: "png must be 1200x630" }, 400, cors);

  const id = newId();
  await env.KV.put("img:" + id, buf, {
    expirationTtl: 60 * 60 * 24 * 180,
    metadata: { a, p: persona, t: Date.now() },
  });
  return json({ id, url: `${url.origin}/s/${id}` }, 200, cors);
}

async function ogImage(id, env) {
  const r = await env.KV.get("img:" + id, { type: "arrayBuffer", cacheTtl: 3600 });
  if (!r) return new Response("not found", { status: 404 });
  return new Response(r, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400, immutable" } });
}

async function sharePage(id, url, env) {
  const { metadata } = await env.KV.getWithMetadata("img:" + id, { type: "stream" });
  const site = env.SITE_URL;
  if (!metadata) return Response.redirect(site, 302);
  const dest = `${site}?w=${metadata.a}`;
  const title = metadata.p ? `${metadata.p} · Onchain Wrapped 2026` : "Onchain Wrapped 2026";
  const desc = "My 2026 on Hyperliquid and Polymarket, wrapped. Get yours.";
  const img = `${url.origin}/og/${id}.png`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${url.origin}/s/${id}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${img}">
<meta http-equiv="refresh" content="0;url=${esc(dest)}">
</head><body style="background:#07070a;color:#f4f1ea;font-family:sans-serif">
<p>Opening <a style="color:#c6ff3d" href="${esc(dest)}">Onchain Wrapped</a>…</p>
<script>location.replace(${JSON.stringify(dest)})</script></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}

/* ---------------- leaderboard ---------------- */
async function readBoard(env) {
  return (await env.KV.get("board", { type: "json" })) || { entries: {}, updated: 0 };
}

async function getBoard(env, cors) {
  const b = await readBoard(env);
  const list = Object.values(b.entries);
  const top = (key) => list.filter(e => typeof e[key] === "number").sort((x, y) => y[key] - x[key]).slice(0, BOARD_SIZE);
  return json({ volume: top("volume"), pnl: top("pnl"), count: list.length, updated: b.updated }, 200,
    { ...cors, "Cache-Control": "public, max-age=60" });
}

// Pull the wallet's Hyperliquid portfolio and derive verifiable numbers:
//  - all-time volume (upper bound for the claimed 2026 volume)
//  - 2026 PnL from the all-time pnl history (value now minus value at Jan 1)
async function hlVerify(address, env) {
  const r = await fetch(env.HL_URL || HL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "portfolio", user: address }) });
  if (!r.ok) throw new Error("hyperliquid " + r.status);
  const data = await r.json();
  const all = Array.isArray(data) ? (data.find(w => w[0] === "allTime") || [])[1] : null;
  if (!all) return null;
  const pts = (all.pnlHistory || []).map(([t, v]) => [Number(t), Number(v)]).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return { vlm: Number(all.vlm) || 0, pnl: 0 };
  let base = 0;
  for (const [t, v] of pts) { if (t <= YEAR_START) base = v; else break; }
  return { vlm: Number(all.vlm) || 0, pnl: pts[pts.length - 1][1] - base };
}

async function joinBoard(req, env, cors) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400, cors); }
  const address = String(body.address || "").toLowerCase();
  if (!ADDR.test(address)) return json({ error: "bad address" }, 400, cors);

  let claimed = Number(body.volume);
  if (!isFinite(claimed) || claimed < 0) claimed = 0;

  const v = await hlVerify(address, env);
  if (!v || v.vlm <= 0) return json({ error: "No Hyperliquid history found for this wallet." }, 400, cors);
  // Volume can't exceed lifetime volume. Clamp instead of rejecting so honest rounding never fails.
  const volume = Math.min(claimed, v.vlm);

  const b = await readBoard(env);
  b.entries[address] = {
    a: shortAddr(address),
    address,
    volume: Math.round(volume),
    pnl: Math.round(v.pnl),
    persona: cleanText(body.persona, 40),
    topCoin: cleanText(body.topCoin, 12),
    t: Date.now(),
  };
  // keep the stored board bounded
  const list = Object.values(b.entries);
  if (list.length > 2000) {
    const keep = new Set([
      ...list.sort((x, y) => y.volume - x.volume).slice(0, 800).map(e => e.address),
      ...list.sort((x, y) => y.pnl - x.pnl).slice(0, 800).map(e => e.address),
    ]);
    for (const k of Object.keys(b.entries)) if (!keep.has(k)) delete b.entries[k];
  }
  b.updated = Date.now();
  try { await env.KV.put("board", JSON.stringify(b)); }
  catch { return json({ error: "Busy, try again in a few seconds." }, 429, cors); }

  const all = Object.values(b.entries);
  const rank = (key) => all.filter(e => e[key] > b.entries[address][key]).length + 1;
  return json({ ok: true, entry: b.entries[address], rank: { volume: rank("volume"), pnl: rank("pnl") }, total: all.length }, 200, cors);
}
