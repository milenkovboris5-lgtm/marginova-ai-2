// ═══════════════════════════════════════════════════════════════════════
// MARGINOVA — api/chat.js  v5.1 — DIAGNOSTIC + PRODUCTION READY
// 500 error fix: wrapped every module load in try/catch,
// added startup self-test, safe fallbacks for missing env vars.
// ═══════════════════════════════════════════════════════════════════════

// ─── STARTUP DIAGNOSTICS ─────────────────────────────────────────────
console.log('[chat.js] === STARTUP ===');
console.log('[chat.js] NODE_ENV:', process.env.NODE_ENV);
console.log('[chat.js] GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'SET ✓' : 'MISSING ✗');
console.log('[chat.js] SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET ✓' : 'MISSING ✗');
console.log('[chat.js] SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? 'SET ✓' : 'MISSING ✗');
console.log('[chat.js] SERPER_API_KEY:', process.env.SERPER_API_KEY ? 'SET ✓' : 'MISSING ✗');

// ─── SAFE MODULE IMPORTS ─────────────────────────────────────────────
let utils, profileDetector, fundingScorer, llmRouter;

try {
  utils = require('./_lib/utils');
  console.log('[chat.js] utils loaded ✓');
} catch (e) {
  console.error('[chat.js] FAILED to load utils:', e.message);
  // Export a minimal handler that explains the problem
  module.exports = async (req, res) => {
    res.status(500).json({ error: { message: 'Server config error: utils module failed to load. ' + e.message } });
  };
  return;
}

try {
  profileDetector = require('./_lib/profileDetector');
  console.log('[chat.js] profileDetector loaded ✓');
} catch (e) {
  console.error('[chat.js] FAILED to load profileDetector:', e.message);
}

try {
  fundingScorer = require('./_lib/fundingScorer');
  console.log('[chat.js] fundingScorer loaded ✓');
} catch (e) {
  console.error('[chat.js] FAILED to load fundingScorer:', e.message);
}

try {
  llmRouter = require('./_lib/llmRouter');
  console.log('[chat.js] llmRouter loaded ✓');
} catch (e) {
  console.error('[chat.js] FAILED to load llmRouter:', e.message);
}

// Destructure from utils (safe)
const {
  ft,
  detectLang,
  sanitizeField,
  checkIP,
  gemini,
  setCors,
  supabase,
  getTable,
} = utils;

// Safe destructure from optional modules
const { detectProfile, needsSearch } = profileDetector || {
  detectProfile: () => ({ sector: null, orgType: null, country: null, budget: null, keywords: [] }),
  needsSearch:   () => false,
};

const {
  searchDB,
  mergeWithWeb,
  needsSerper,
  RESULTS_TO_SHOW = 6,
} = fundingScorer || {
  searchDB:       async () => [],
  mergeWithWeb:   (a, b) => [...a, ...b].slice(0, 6),
  needsSerper:    () => false,
  RESULTS_TO_SHOW: 6,
};

const { extractFromSerper, synthesize } = llmRouter || {
  extractFromSerper: async () => [],
  synthesize: async (lang) => lang === 'mk'
    ? 'Системот е во одржување. Обидете се повторно.'
    : 'System is under maintenance. Please try again.',
};

// ─── CONSTANTS ───────────────────────────────────────────────────────
const SERPER_KEY      = process.env.SERPER_API_KEY;
const CACHE_TTL_HOURS = 24;

// ─── CACHE HELPERS ───────────────────────────────────────────────────
function hashQuery(str) {
  const n = (str || '').toLowerCase().trim().replace(/\s+/g, ' ');
  let h = 0;
  for (let i = 0; i < n.length; i++) { h = ((h << 5) - h) + n.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}

function buildCacheKey(userText, profile) {
  return hashQuery(JSON.stringify({
    q:       (userText || '').toLowerCase().trim().slice(0, 200),
    sector:  profile.sector  || '',
    country: profile.country || '',
    orgType: profile.orgType || '',
    budget:  profile.budget  || '',
  }));
}

async function getCached(key) {
  if (!supabase) return null;
  try {
    const { data, error } = await getTable('search_cache')
      .select('results,created_at')
      .eq('query_hash', key)
      .gt('expires_at', new Date().toISOString())
      .limit(1);
    if (error) { console.warn('[CACHE GET]', error.message); return null; }
    if (data?.length) { console.log('[CACHE] hit:', key); return data[0]; }
    return null;
  } catch (e) {
    console.warn('[CACHE GET] exception:', e.message);
    return null;
  }
}

async function saveCache(key, queryText, results) {
  if (!supabase) return;
  try {
    const now     = new Date();
    const expires = new Date(now.getTime() + CACHE_TTL_HOURS * 3600000);
    await getTable('search_cache').delete().eq('query_hash', key);
    await getTable('search_cache').insert({
      query_hash: key,
      query_text: queryText,
      results,
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
    });
  } catch (e) {
    console.log('[CACHE SAVE]', e.message);
  }
}

async function cleanCache() {
  if (!supabase) return;
  try {
    await getTable('search_cache').delete().lt('expires_at', new Date().toISOString());
  } catch (e) {
    console.log('[CACHE CLEAN]', e.message);
  }
}

// ─── SERPER SEARCH ───────────────────────────────────────────────────
async function searchSerper(query) {
  if (!SERPER_KEY) {
    console.log('[SERPER] No API key — web fallback disabled');
    return [];
  }
  try {
    const r = await ft('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 8, gl: 'us', hl: 'en' }),
    }, 8000);
    if (!r.ok) {
      console.log('[SERPER] HTTP error:', r.status);
      return [];
    }
    const data = await r.json();
    return (data.organic || [])
      .filter(item => item.title && item.link)
      .map(item => ({
        title:   item.title,
        snippet: item.snippet || '',
        link:    item.link,
        source:  'serper',
      }))
      .slice(0, 6);
  } catch (e) {
    console.log('[SERPER] error:', e.message);
    return [];
  }
}

function buildSerperQuery(userText, profile) {
  const parts = ['grant funding open call'];
  if (profile.sector)  parts.push(profile.sector.split('/')[0].trim());
  if (profile.country) parts.push(profile.country);
  if (profile.orgType) parts.push(profile.orgType.split('/')[0].trim());
  const kws = (userText || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 4 && !['about','where','which','would','could'].includes(w))
    .slice(0, 3);
  return [...parts, ...kws].join(' ');
}

// ─── HYBRID SEARCH ───────────────────────────────────────────────────
async function hybridSearch(userText, profile) {
  console.log('[HYBRID] profile:', JSON.stringify({
    sector: profile.sector, country: profile.country,
    orgType: profile.orgType, budget: profile.budget,
  }));

  // Step 1: DB always first
  let dbResults = [];
  try {
    dbResults = await searchDB(profile);
    console.log('[HYBRID] DB returned:', dbResults.length);
  } catch (e) {
    console.error('[HYBRID] searchDB error:', e.message);
  }

  // Step 2: Serper ONLY if DB is insufficient
  const doSerper = needsSerper(dbResults);
  console.log('[HYBRID] Serper needed:', doSerper);

  if (!doSerper) {
    return { results: dbResults, sources: { db: dbResults.length, serper: 0 } };
  }

  const rawWeb = await searchSerper(buildSerperQuery(userText, profile));
  let extractedWeb = [];
  if (rawWeb.length > 0) {
    try {
      extractedWeb = await extractFromSerper(rawWeb, profile);
      console.log('[HYBRID] Serper extracted:', extractedWeb.length);
    } catch (e) {
      console.error('[HYBRID] extractFromSerper error:', e.message);
    }
  }

  return {
    results: mergeWithWeb(dbResults, extractedWeb),
    sources: { db: dbResults.length, serper: extractedWeb.length },
  };
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS first — always
  try { setCors(req, res); } catch (e) { console.error('[CORS]', e.message); }

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  }

  // ── ENV CHECK ──────────────────────────────────────────────
  if (!process.env.GEMINI_API_KEY) {
    console.error('[handler] GEMINI_API_KEY not set');
    return res.status(500).json({ error: { message: 'Server configuration error: missing AI API key.' } });
  }

  // ── IP RATE LIMIT ──────────────────────────────────────────
  try {
    const allowed = await checkIP(req);
    if (!allowed) {
      return res.status(429).json({ error: { message: 'Daily IP limit reached. Try again tomorrow.' } });
    }
  } catch (e) {
    console.warn('[IP CHECK] error (allowing):', e.message);
    // Don't block on IP check error in test mode
  }

  try {
    // ── PARSE BODY ────────────────────────────────────────────
    const body = req.body || {};
    console.log('[handler] body keys:', Object.keys(body));

    const imageData = body.image     || null;
    const imageType = body.imageType || null;

    const rawMessage = body.messages?.[body.messages.length - 1]?.content
      || body.message
      || '';

    const userText = sanitizeField(rawMessage, 2000);
    console.log('[handler] userText length:', userText.length, 'imageData:', !!imageData);

    if (!userText && !imageData) {
      return res.status(400).json({ error: { message: 'No message provided.' } });
    }

    // ── LANGUAGE DETECTION ────────────────────────────────────
    const langText = (body.messages || []).slice(-3).map(m => m.content || '').join(' ') + ' ' + userText;
    const lang     = body.lang || detectLang(langText);
    const today    = new Date().toLocaleDateString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });
    console.log('[handler] lang:', lang, 'today:', today);

    // ── PROFILE DETECTION ─────────────────────────────────────
    const conversationText = (body.messages || [])
      .slice(-4).map(m => m.content || '').join(' ') + ' ' + userText;

    let profile = { sector: null, orgType: null, country: null, budget: null, keywords: [] };
    try {
      profile = detectProfile(conversationText);
      console.log('[handler] profile:', JSON.stringify(profile));
    } catch (e) {
      console.warn('[handler] detectProfile error:', e.message);
    }

    // Periodic cache cleanup
    if (Math.random() < 0.05) cleanCache().catch(() => {});

    // ── SEARCH DECISION ───────────────────────────────────────
    let shouldSearch = false;
    try {
      shouldSearch = needsSearch(conversationText)
        || !!imageData
        || !!(profile.sector && profile.country);
    } catch (e) {
      console.warn('[handler] needsSearch error:', e.message);
    }
    console.log('[handler] shouldSearch:', shouldSearch);

    let results   = [];
    let sources   = { db: 0, serper: 0 };
    let fromCache = false;
    let cachedAt  = null;

    if (shouldSearch && !imageData) {
      const cacheKey = buildCacheKey(userText, profile) + '_' + lang;

      // Try cache first
      try {
        const cached = await getCached(cacheKey);
        if (cached?.results?.length) {
          results   = cached.results;
          cachedAt  = cached.created_at;
          fromCache = true;
          console.log('[handler] Serving from cache:', results.length, 'results');
        }
      } catch (e) {
        console.warn('[handler] cache lookup error:', e.message);
      }

      // DB + optional Serper if no cache
      if (!fromCache) {
        try {
          const hybrid = await hybridSearch(userText, profile);
          results  = hybrid.results;
          sources  = hybrid.sources;
          if (results.length) {
            saveCache(cacheKey, userText, results).catch(e =>
              console.warn('[handler] saveCache error:', e.message)
            );
          }
        } catch (e) {
          console.error('[handler] hybridSearch error:', e.message);
          // Continue — Gemini will handle no-results case gracefully
        }
      }
    }

    // ── GEMINI SYNTHESIS ──────────────────────────────────────
    console.log('[handler] calling synthesize with', results.length, 'results');
    let text = '';
    try {
      text = await synthesize(lang, today, profile, results, sources);
    } catch (e) {
      console.error('[handler] synthesize error:', e.message);
      text = lang === 'mk'
        ? `Се случи грешка при генерирање на одговорот: ${e.message}`
        : `Error generating response: ${e.message}`;
    }

    // ── RESPONSE ──────────────────────────────────────────────
    return res.status(200).json({
      content:     [{ type: 'text', text }],
      intent:      shouldSearch ? 'funding' : 'general',
      cached:      fromCache,
      cached_at:   cachedAt,
      db_results:  sources.db,
      web_results: sources.serper,
      top_matches: results.slice(0, RESULTS_TO_SHOW).map(r => ({
        title:        r.title             || '',
        organization: r.organization_name || '',
        deadline:     r.application_deadline || '',
        amount:       r.award_amount
          ? `${Number(r.award_amount).toLocaleString()} ${r.currency || 'EUR'}`
          : (r.funding_range || ''),
        country:      r.country      || '',
        matchSignals: r.matchSignals || [],
        riskFactors:  r.riskFactors  || [],
        source:       r.source       || 'db',
        link:         r.link         || '',
        snippet:      r.snippet      || '',
      })),
    });

  } catch (err) {
    // Top-level catch — should never reach here, but if it does log everything
    console.error('[handler] UNHANDLED ERROR:', err.message);
    console.error('[handler] stack:', err.stack);
    return res.status(500).json({
      error: {
        message: 'Internal server error. Check server logs for details.',
        // Only expose details in non-production
        detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
      },
    });
  }
};
