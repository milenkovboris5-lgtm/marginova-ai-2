// ═══════════════════════════════════════════════════════════════════════
// MARGINOVA — api/chat.js  v7 — DB-only search, Serper removed from chat
//
// ARCHITECTURE CHANGE (v7):
// Serper is NO LONGER used in real-time chat. It runs ONLY in the weekly
// cron job (api/cron/update-opportunities.js) which keeps the Supabase DB
// fresh. This removes latency, Serper quota burn, and web-result noise.
//
// FIXES over v6:
// 1. Serper removed — searchSerper, buildSerperQuery, extractFromSerper deleted
// 2. sources cache bug fixed — cached response now reflects real db count
// 3. hybridSearch simplified to DB-only searchDB call
// ═══════════════════════════════════════════════════════════════════════

// ─── STARTUP DIAGNOSTICS ─────────────────────────────────────────────
console.log('[chat.js] === STARTUP ===');
console.log('[chat.js] NODE_ENV:', process.env.NODE_ENV);
console.log('[chat.js] GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'SET ✓' : 'MISSING ✗');
console.log('[chat.js] SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET ✓' : 'MISSING ✗');
console.log('[chat.js] SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? 'SET ✓' : 'MISSING ✗');
console.log('[chat.js] DEEPSEEK_API_KEY:', process.env.DEEPSEEK_API_KEY ? 'SET ✓' : 'MISSING ✗');

// ─── SAFE MODULE IMPORTS ─────────────────────────────────────────────
let utils, profileDetector, fundingScorer, llmRouter;

try {
  utils = require('./_lib/utils');
  console.log('[chat.js] utils loaded ✓');
} catch (e) {
  console.error('[chat.js] FAILED to load utils:', e.message);
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

const { detectProfile, needsSearch } = profileDetector || {
  detectProfile: () => ({ sector: null, orgType: null, country: null, budget: null, keywords: [] }),
  needsSearch:   () => false,
};

const {
  searchDB,
  RESULTS_TO_SHOW = 6,
} = fundingScorer || {
  searchDB:        async () => [],
  RESULTS_TO_SHOW: 6,
};

const { synthesize } = llmRouter || {
  synthesize: async (lang) => lang === 'mk'
    ? 'Системот е во одржување. Обидете се повторно.'
    : 'System is under maintenance. Please try again.',
};

// ─── CONSTANTS ───────────────────────────────────────────────────────
const CACHE_TTL_HOURS = 6;

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
      .select('results,created_at,db_count')
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

async function saveCache(key, queryText, results, dbCount) {
  if (!supabase) return;
  try {
    const now     = new Date();
    const expires = new Date(now.getTime() + CACHE_TTL_HOURS * 3600000);
    await getTable('search_cache').delete().eq('query_hash', key);
    await getTable('search_cache').insert({
      query_hash: key,
      query_text: queryText,
      results,
      db_count:   dbCount,
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

// ─── DB-ONLY SEARCH ──────────────────────────────────────────────────
// Serper is NOT used here. It runs only in api/cron/update-opportunities.js
// which refreshes the Supabase DB weekly. The DB is the single source of truth.
async function dbSearch(profile) {
  console.log('[DB SEARCH] profile:', JSON.stringify({
    sector: profile.sector, country: profile.country,
    orgType: profile.orgType, budget: profile.budget,
  }));

  try {
    const results = await searchDB(profile);
    console.log('[DB SEARCH] returned:', results.length);
    return { results, sources: { db: results.length, serper: 0 } };
  } catch (e) {
    console.error('[DB SEARCH] error:', e.message);
    return { results: [], sources: { db: 0, serper: 0 } };
  }
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  try { setCors(req, res); } catch (e) { console.error('[CORS]', e.message); }

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error('[handler] GEMINI_API_KEY not set');
    return res.status(500).json({ error: { message: 'Server configuration error: missing AI API key.' } });
  }

  try {
    const allowed = await checkIP(req);
    if (!allowed) {
      return res.status(429).json({ error: { message: 'Daily IP limit reached. Try again tomorrow.' } });
    }
  } catch (e) {
    console.warn('[IP CHECK] error (allowing):', e.message);
  }

  try {
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

    // ── Language detection ────────────────────────────────
    const allMsgsText = (body.messages || []).map(m => m.content || '').join(' ') + ' ' + userText;

    const explicitMk = /на македонски|по македонски|in macedonian|makedonski/i.test(userText);
    const explicitEn = /in english|на англиски|по английски/i.test(userText);

    const lang = explicitMk ? 'mk'
               : explicitEn ? 'en'
               : body.lang  || detectLang(allMsgsText);

    const today = new Date().toLocaleDateString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });
    console.log('[handler] lang:', lang, 'today:', today);

    // ── Profile detection ─────────────────────────────────
    const conversationText = (body.messages || [])
      .slice(-4).map(m => m.content || '').join(' ') + ' ' + userText;

    let profile = { sector: null, orgType: null, country: null, budget: null, keywords: [] };
    try {
      profile = detectProfile(conversationText);
      console.log('[handler] profile:', JSON.stringify(profile));
    } catch (e) {
      console.warn('[handler] detectProfile error:', e.message);
    }

    cleanCache().catch(() => {});

    // ── Search decision ───────────────────────────────────
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

      try {
        const cached = await getCached(cacheKey);
        if (cached?.results?.length) {
          results   = cached.results;
          cachedAt  = cached.created_at;
          fromCache = true;
          // v7 fix: restore real db count from cache, not 0
          sources   = { db: cached.db_count ?? results.length, serper: 0 };
          console.log('[handler] Serving from cache:', results.length, 'results, db:', sources.db);
        }
      } catch (e) {
        console.warn('[handler] cache lookup error:', e.message);
      }

      if (!fromCache) {
        const searched = await dbSearch(profile);
        results = searched.results;
        sources = searched.sources;
        if (results.length) {
          saveCache(cacheKey, userText, results, sources.db).catch(e =>
            console.warn('[handler] saveCache error:', e.message)
          );
        }
      }
    }

    // ── Gemini synthesis ──────────────────────────────────
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

    // ── Response ──────────────────────────────────────────
    return res.status(200).json({
      content:     [{ type: 'text', text }],
      intent:      shouldSearch ? 'funding' : 'general',
      cached:      fromCache,
      cached_at:   cachedAt,
      db_results:  sources.db,
      web_results: sources.serper,
      top_matches: results.slice(0, RESULTS_TO_SHOW).map(r => ({
        title:          r.title             || '',
        organization:   r.organization_name || '',
        deadline:       r.application_deadline || '',
        amount:         r.award_amount
          ? `${Number(r.award_amount).toLocaleString()} ${r.currency || 'EUR'}`
          : (r.funding_range || ''),
        country:        r.country      || '',
        matchSignals:   r.matchSignals || [],
        riskFactors:    r.riskFactors  || [],
        relevanceScore: r._relevanceScore || 0,
        source:         r.source       || 'db',
        link:           r.link         || '',
        snippet:        r.snippet      || '',
      })),
    });

  } catch (err) {
    console.error('[handler] UNHANDLED ERROR:', err.message);
    console.error('[handler] stack:', err.stack);
    return res.status(500).json({
      error: {
        message: 'Internal server error. Check server logs for details.',
        detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
      },
    });
  }
};
