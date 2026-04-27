// ═════════════════════════════════════════════════════════════
// MARGINOVA — api/chat.js
// v23 — Clean router. No auth, no profiles, no chatHistory.
// Every session is a clean slate.
// Modules: profileDetector → fundingScorer → serper → gemini
// ═════════════════════════════════════════════════════════════

const { ft, detectLang, sanitizeField, checkIP, gemini, setCors, supabase, getTable } = require('./_lib/utils');
const { detectProfile, needsSearch }          = require('./_lib/profileDetector');
const { searchDB, mergeWithWeb }              = require('./_lib/fundingScorer');
const { extractFromSerper, synthesize }        = require('./_lib/llmRouter');

const SERPER_KEY      = process.env.SERPER_API_KEY;
const CACHE_TTL_HOURS = 24;
const DB_MIN_RESULTS  = 3;
const DB_MIN_SCORE    = 55;

console.log('[chat.js v23] SUPABASE:', supabase ? 'OK' : 'MISSING');
console.log('[chat.js v23] SERPER:',   SERPER_KEY ? 'OK' : 'MISSING');

function hashQuery(str) {
  const n = str.toLowerCase().trim().replace(/\s+/g, ' ');
  let h = 0;
  for (let i = 0; i < n.length; i++) { h = ((h << 5) - h) + n.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}

function buildCacheKey(userText, profile) {
  return hashQuery(JSON.stringify({
    q:       userText.toLowerCase().trim().slice(0, 200),
    sector:  profile.sector  || '',
    country: profile.country || '',
    orgType: profile.orgType || '',
    budget:  profile.budget  || '',
  }));
}

async function getCached(key) {
  if (!supabase) return null;
  try {
    const { data } = await getTable('search_cache')
      .select('results,created_at')
      .eq('query_hash', key)
      .gt('expires_at', new Date().toISOString())
      .limit(1);
    if (data?.length) { console.log('[CACHE] hit:', key); return data[0]; }
    return null;
  } catch { return null; }
}

async function saveCache(key, queryText, results) {
  if (!supabase) return;
  try {
    const now     = new Date();
    const expires = new Date(now.getTime() + CACHE_TTL_HOURS * 3600000);
    await getTable('search_cache').delete().eq('query_hash', key);
    await getTable('search_cache').insert({
      query_hash: key, query_text: queryText, results,
      created_at: now.toISOString(), expires_at: expires.toISOString(),
    });
  } catch (e) { console.log('[CACHE SAVE]', e.message); }
}

async function cleanCache() {
  if (!supabase) return;
  try { await getTable('search_cache').delete().lt('expires_at', new Date().toISOString()); }
  catch (e) { console.log('[CACHE CLEAN]', e.message); }
}

async function searchSerper(query) {
  if (!SERPER_KEY) { console.log('[SERPER] No key'); return []; }
  try {
    const r = await ft('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 8, gl: 'us', hl: 'en' }),
    }, 8000);
    if (!r.ok) { console.log('[SERPER] error:', r.status); return []; }
    const data = await r.json();
    return (data.organic || [])
      .filter(item => item.title && item.link)
      .map(item => ({
        title: item.title, snippet: item.snippet || '',
        link: item.link, score: 40, score_type: 'web', source: 'serper',
      }))
      .slice(0, 5);
  } catch (e) { console.log('[SERPER]', e.message); return []; }
}

function buildSerperQuery(userText, profile) {
  const parts = ['grant funding'];
  if (profile.sector)  parts.push(profile.sector.split('/')[0].trim());
  if (profile.country) parts.push(profile.country);
  if (profile.orgType) parts.push(profile.orgType.split('/')[0].trim());
  const kws = userText.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 4 && !['about','where','which','would','could'].includes(w))
    .slice(0, 3);
  return [...parts, ...kws].join(' ');
}

async function hybridSearch(userText, profile) {
  const dbResults   = await searchDB(profile);
  const topScore    = dbResults[0]?.score ?? 0;
  const needsSerper = dbResults.length < DB_MIN_RESULTS || topScore < DB_MIN_SCORE;

  console.log(`[HYBRID] db:${dbResults.length} topScore:${topScore} needsSerper:${needsSerper}`);

  if (!needsSerper) return { results: dbResults, sources: { db: dbResults.length, serper: 0 } };

  // Serper: get live web results
  const rawWeb = await searchSerper(buildSerperQuery(userText, profile));

  // Gemini Call 1: extract structured data from Serper snippets
  let extractedWeb = [];
  if (rawWeb.length > 0) {
    console.log('[HYBRID] Extracting structured data from', rawWeb.length, 'web results...');
    extractedWeb = await extractFromSerper(rawWeb, profile);
    console.log('[HYBRID] Extracted:', extractedWeb.length, 'relevant web programs');
  }

  return {
    results: mergeWithWeb(dbResults, extractedWeb),
    sources: { db: dbResults.length, serper: extractedWeb.length },
  };
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY.' } });

  if (!(await checkIP(req))) {
    return res.status(429).json({ error: { message: 'Daily limit reached. Try again tomorrow.' } });
  }

  try {
    const body      = req.body || {};
    const imageData = body.image     || null;
    const imageType = body.imageType || null;

    const userText = sanitizeField(
      body.messages?.[body.messages.length - 1]?.content || body.message || '',
      2000
    );

    if (!userText && !imageData) {
      return res.status(400).json({ error: { message: 'No message provided.' } });
    }

    // FIX: detect lang from full conversation — catches "на македонски", "in english" etc.
    const langText = (body.messages || []).slice(-3).map(m => m.content || '').join(' ') + ' ' + userText;
    const lang = body.lang || detectLang(langText);
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

    // Detect profile from current conversation ONLY — no Supabase profiles
    const conversationText = (body.messages || [])
      .slice(-4).map(m => m.content || '').join(' ') + ' ' + userText;

    const profile = detectProfile(conversationText);

    if (Math.random() < 0.05) cleanCache().catch(() => {});

    const shouldSearch = needsSearch(conversationText) || !!imageData || !!(profile.sector && profile.country);
    let results   = [];
    let sources   = { db: 0, serper: 0 };
    let fromCache = false;
    let cachedAt  = null;

    if (shouldSearch && !imageData) {
      const cacheKey = buildCacheKey(userText, profile);
      const cached   = await getCached(cacheKey);

      if (cached?.results?.length) {
        results   = cached.results;
        cachedAt  = cached.created_at;
        fromCache = true;
      } else {
        const hybrid = await hybridSearch(userText, profile);
        results  = hybrid.results;
        sources  = hybrid.sources;
        if (results.length) await saveCache(cacheKey, userText, results).catch(() => {});
        console.log(`[v23] db:${sources.db} serper:${sources.serper} total:${results.length}`);
      }
    }

    // Gemini Call 2: synthesize final answer from verified data only
    // (Call 1 = extractFromSerper, already done in hybridSearch if needed)
    const text = await synthesize(lang, today, profile, results, sources);

    return res.status(200).json({
      content:     [{ type: 'text', text }],
      intent:      shouldSearch ? 'grant' : 'general',
      cached:      fromCache,
      cached_at:   cachedAt,
      db_results:  sources.db,
      web_results: sources.serper,
      top_matches: results.slice(0, 5).map(r => ({
        title:      r.title      || '',
        score:      Number.isFinite(r.score) ? r.score : 0,
        score_type: r.score_type || 'match',
        source:     r.source     || 'db',
        link:       r.link       || '',
        snippet:    r.snippet    || '',
      })),
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
