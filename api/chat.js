
// MARGINOVA.AI — api/chat.js
// VERSION: v16 — funding_opportunities only, DB-first strict mode
// Global scope, English comments
// ═══════════════════════════════════════════

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const SERPER_KEY = process.env.SERPER_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

console.log('SUPA_KEY:', SUPA_KEY ? 'OK' : 'MISSING');
// Anon key — public, safe to hardcode, used for public read
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpZGFsdmVldHdrY3Jqa3Z6YnNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4MjA2OTgsImV4cCI6MjA4OTM5NjY5OH0.PwvEZzVuzTqS9wtAQYqmCbYMc_H7ZuTCaI5OixWHF7M';

const DAILY_LIMIT = 200;
const PLANS = { free: 20, starter: 500, pro: 2000, business: -1 };
const CACHE_TTL_HOURS = 24;

// ═══ FETCH WITH TIMEOUT ═══

function ft(url, opts = {}, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

// ═══ SUPABASE HELPERS ═══

async function dbGet(path) {
  if (!SUPA_URL) return null;
  const key = SUPA_KEY || SUPA_ANON;
  try {
    const r = await ft(`${SUPA_URL}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: '' }
    }, 6000);
    if (!r.ok) {
      console.log('[DB GET]', r.status, path);
      return null;
    }
    return r.json();
  } catch (e) {
    console.log('[DB GET]', e.message);
    return null;
  }
}

async function dbPost(path, body) {
  if (!SUPA_URL) return false;
  const key = SUPA_KEY || SUPA_ANON;
  try {
    const r = await ft(`${SUPA_URL}/rest/v1/${path}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(body)
    }, 6000);
    return r.ok;
  } catch (e) {
    console.log('[DB POST]', e.message);
    return false;
  }
}

async function dbPatch(path, body) {
  if (!SUPA_URL) return;
  const key = SUPA_KEY || SUPA_ANON;
  try {
    await ft(`${SUPA_URL}/rest/v1/${path}`, {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(body)
    }, 5000);
  } catch {}
}

async function dbDelete(path) {
  if (!SUPA_URL) return;
  const key = SUPA_KEY || SUPA_ANON;
  try {
    await ft(`${SUPA_URL}/rest/v1/${path}`, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    }, 5000);
  } catch {}
}

// ═══ IP RATE LIMIT — Stored in Supabase, not memory ═══

async function checkIP(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const today = new Date().toISOString().split('T')[0];
  const key = SUPA_KEY || SUPA_ANON;

  try {
    const rows = await dbGet(`ip_limits?ip=eq.${encodeURIComponent(ip)}&select=count,reset_date`);
    const row = rows?.[0];

    if (!row || row.reset_date !== today) {
      await ft(`${SUPA_URL}/rest/v1/ip_limits`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify({ ip, count: 1, reset_date: today })
      }, 4000);
      return true;
    }

    if (row.count >= DAILY_LIMIT) return false;

    await dbPatch(`ip_limits?ip=eq.${encodeURIComponent(ip)}`, { count: row.count + 1 });
    return true;
  } catch (e) {
    console.log('[IP CHECK]', e.message);
    return true;
  }
}

// ═══ HASH ═══

function hashQuery(str) {
  const n = str.toLowerCase().trim().replace(/\s+/g, ' ');
  let h = 0;
  for (let i = 0; i < n.length; i++) {
    h = ((h << 5) - h) + n.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

// ═══ DB SEARCH — funding_opportunities only ═══

async function searchFundingDB(profile) {
  try {
    const today = new Date().toISOString().split('T')[0];

    const query =
      'funding_opportunities?' +
      'status=eq.Open' +
      '&select=title,organization_name,opportunity_type,funding_range,award_amount,currency,focus_areas,eligibility,application_deadline,country,description,source_url' +
      '&limit=100';

    let allRows = null;
    try {
      const r = await ft(`${SUPA_URL}/rest/v1/${query}`, {
        headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` }
      }, 6000);

      if (r.ok) allRows = await r.json();
      else console.log('[DB SEARCH] status:', r.status);
    } catch (e) {
      console.log('[DB SEARCH] fetch error:', e.message);
    }

    console.log('[DB SEARCH] fetched:', allRows?.length ?? 'null');
    if (!allRows || allRows.length === 0) return [];

    const rows = allRows.filter(g => !g.application_deadline || g.application_deadline >= today);
    if (rows.length === 0) return [];

    const scored = rows.map(g => {
      let score = 0;

      const focus = String(g.focus_areas || '').toLowerCase();
      const desc = String(g.description || '').toLowerCase();
      const elig = String(g.eligibility || '').toLowerCase();
      const type = String(g.opportunity_type || '').toLowerCase();
      const country = String(g.country || '').toLowerCase();

      // Sector match (+35)
      if (profile.sector) {
        const sectorMap = {
          'IT / Technology': ['ai', 'technology', 'digital', 'software', 'startup', 'innovation', 'ict', 'tech'],
          'Agriculture': ['agriculture', 'farmer', 'rural', 'food', 'farm', 'ipard'],
          'Education': ['education', 'school', 'learning', 'training', 'youth'],
          'Environment / Energy': ['climate', 'environment', 'green', 'energy', 'renewable'],
          'Civil Society': ['ngo', 'civil society', 'community', 'rights', 'nonprofit'],
          'Health / Social': ['health', 'social', 'welfare', 'care'],
          'Research / Innovation': ['research', 'science', 'innovation', 'academic', 'university'],
          'SME / Business': ['business', 'enterprise', 'sme', 'company', 'entrepreneur'],
          'Tourism / Culture': ['tourism', 'culture', 'heritage', 'creative', 'art']
        };

        const kws = sectorMap[profile.sector] || [];
        const hay = `${focus} ${desc}`;
        const hits = kws.filter(k => hay.includes(k)).length;
        if (hits > 0) score += Math.min(35, hits * 12);
      }

      // Country match (+25)
      if (profile.country) {
        const pc = profile.country.toLowerCase();
        if (
          !country ||
          country.includes('global') ||
          country.includes('europe') ||
          country.includes(pc) ||
          (pc.includes('north macedonia') && country.includes('western balkans'))
        ) {
          score += 25;
        }
      }

      // Org type match (+20)
      if (profile.orgType) {
        const orgMap = {
          'NGO / Association': ['ngo', 'nonprofit', 'association', 'civil society', 'foundation'],
          'Startup': ['startup', 'early stage', 'venture', 'founder'],
          'Agricultural holding': ['farmer', 'agricultural', 'holding', 'ipard'],
          'SME': ['sme', 'enterprise', 'company', 'business'],
          'Municipality / Public body': ['municipality', 'local government', 'public body', 'public institution'],
          'University / Research': ['university', 'research', 'academic', 'institute'],
          'Individual / Entrepreneur': ['individual', 'entrepreneur', 'founder', 'self-employed', 'freelance']
        };

        const kws = orgMap[profile.orgType] || [];
        const hay = `${elig} ${desc} ${type}`;
        const hits = kws.filter(k => hay.includes(k)).length;
        if (hits > 0) score += Math.min(20, hits * 10);
      }

      // Budget match (+15)
      if (profile.budget && g.award_amount != null) {
        const amt = Number(g.award_amount);
        const budgetRanges = {
          'up to €30k': [0, 30000],
          '€30k–€150k': [30000, 150000],
          '€150k–€500k': [150000, 500000],
          'above €500k': [500000, Infinity]
        };
        const [minB, maxB] = budgetRanges[profile.budget] || [0, Infinity];
        if (amt >= minB && amt <= maxB) score += 15;
      }

      // Deadline present (+5)
      if (g.application_deadline) score += 5;

      return {
        ...g,
        score: Math.max(0, Math.min(100, score)),
        score_type: 'match',
        source: 'db',
        title: g.title,
        snippet: [
          g.organization_name,
          g.award_amount ? `${g.award_amount} ${g.currency || ''}`.trim() : g.funding_range,
          g.eligibility,
          g.application_deadline ? `Deadline: ${g.application_deadline}` : null
        ].filter(Boolean).join(' | '),
        link: g.source_url || ''
      };
    });

    const ranked = scored
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    console.log('[DB SEARCH] matched:', ranked.length, 'top score:', ranked[0]?.score ?? 0);
    return ranked;
  } catch (e) {
    console.log('[DB SEARCH] error:', e.message);
    return [];
  }
}

// ═══ CACHE ═══

async function getCached(queryHash) {
  try {
    const now = new Date().toISOString();
    const rows = await dbGet(`search_cache?query_hash=eq.${queryHash}&expires_at=gt.${encodeURIComponent(now)}&select=results,created_at&limit=1`);
    if (rows?.length > 0) {
      console.log('[CACHE] hit:', queryHash);
      return { results: rows[0].results, created_at: rows[0].created_at };
    }
    return null;
  } catch (e) {
    console.log('[CACHE] get error:', e.message);
    return null;
  }
}

async function saveCache(queryHash, queryText, results) {
  try {
    const now = new Date();
    const expires = new Date(now.getTime() + CACHE_TTL_HOURS * 3600000);
    await dbDelete(`search_cache?query_hash=eq.${queryHash}`);
    await dbPost('search_cache', {
      query_hash: queryHash,
      query_text: queryText,
      results,
      created_at: now.toISOString(),
      expires_at: expires.toISOString()
    });
  } catch (e) {
    console.log('[CACHE] save error:', e.message);
  }
}

async function cleanExpiredCache() {
  try {
    await dbDelete(`search_cache?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`);
  } catch {}
}

// ═══ QUOTA ═══

async function checkQuota(userId) {
  if (!userId) return true;
  try {
    const today = new Date().toISOString().split('T')[0];
    const rows = await dbGet(`profiles?user_id=eq.${userId}&select=plan,daily_msgs,last_msg_date`);
    const p = rows?.[0];
    if (!p) return true;
    const limit = PLANS[p.plan] ?? 20;
    if (limit === -1) return true;
    const used = p.last_msg_date === today ? (p.daily_msgs || 0) : 0;
    return used < limit;
  } catch {
    return true;
  }
}

async function loadProfile(userId) {
  if (!userId) return null;
  try {
    const rows = await dbGet(`profiles?user_id=eq.${userId}&select=sector,country,organization_type,goals,plan,detected_sector,detected_org_type,detected_country`);
    const p = rows?.[0];
    if (!p) return null;
    return {
      ...p,
      sector: p.sector || p.detected_sector || null,
      organization_type: p.organization_type || p.detected_org_type || null,
      country: p.country || p.detected_country || null,
    };
  } catch {
    return null;
  }
}

// ═══ LANGUAGE DETECTION ═══

function detectLang(text) {
  if (/ќ|ѓ|ѕ|љ|њ|џ/i.test(text)) return 'mk';
  if (/ћ|ђ/i.test(text)) return 'sr';
  if (/јас|сум|македонија|барам|грант|работам|НВО|фонд/i.test(text)) return 'mk';
  if (/[а-шА-Ш]/.test(text)) return 'mk';
  if (/\b(jas|sum|makedonija|zdravo|zemja|proekt|grant|fond)\b/i.test(text)) return 'mk';
  if (/\b(und|oder|ich|nicht|sie|wir)\b/i.test(text)) return 'de';
  if (/\b(est|une|les|des|pour|nous|vous)\b/i.test(text)) return 'fr';
  if (/\b(para|una|los|las|que|con)\b/i.test(text)) return 'es';
  if (/\b(sam|smo|nije|nisu)\b/i.test(text)) return 'sr';
  if (/\b(jestem|jest|nie|dla)\b/i.test(text)) return 'pl';
  if (/\b(bir|için|ile|bu|ve)\b/i.test(text)) return 'tr';
  return 'en';
}

const LANG_NAMES = {
  mk: 'Macedonian',
  sr: 'Serbian',
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pl: 'Polish',
  tr: 'Turkish'
};

// ═══ INTENT DETECTION ═══

function needsSearch(text, conversationText) {
  const t = `${text} ${conversationText}`.toLowerCase();
  return /grant|fund|financ|subsid|fellowship|scholarship|award|donor|ngo|program|open call|call for proposal|support|money|euros|invest/i.test(t);
}

function detectProfile(text, supaProfile) {
  const t = text.toLowerCase();

  const sector =
    /\bit\b|tech|software|digital|technology/.test(t) ? 'IT / Technology' :
    /agri|farm|rural|crop|livestock|hektar|ipard/.test(t) ? 'Agriculture' :
    /educat|school|youth|training|learning/.test(t) ? 'Education' :
    /environment|climate|green|energy|renewable|solar/.test(t) ? 'Environment / Energy' :
    /civil|ngo|nonprofit|association|society/.test(t) ? 'Civil Society' :
    /tourism|culture|heritage|creative|art/.test(t) ? 'Tourism / Culture' :
    /health|medical|social|welfare/.test(t) ? 'Health / Social' :
    /research|science|innovation|university|academic/.test(t) ? 'Research / Innovation' :
    /sme|small business|company|enterprise|startup/.test(t) ? 'SME / Business' :
    supaProfile?.sector || null;

  const orgType =
    /startup/.test(t) ? 'Startup' :
    /\bngo\b|nonprofit|association|foundation|civil society/.test(t) ? 'NGO / Association' :
    /farmer|farm|agricultural|holding|ipard/.test(t) ? 'Agricultural holding' :
    /individual|freelance|self.employed/.test(t) ? 'Individual / Entrepreneur' :
    /\bsme\b|\bltd\b|\bdoo\b|small business/.test(t) ? 'SME' :
    /municipality|local government|public body/.test(t) ? 'Municipality / Public body' :
    /university|research institute|academic/.test(t) ? 'University / Research' :
    supaProfile?.organization_type || null;

  const country =
    /macedon|makedon|north macedon|mkd/.test(t) ? 'North Macedonia' :
    /\bserbia\b|srbija/.test(t) ? 'Serbia' :
    /croatia|hrvatska/.test(t) ? 'Croatia' :
    /\bbosnia\b/.test(t) ? 'Bosnia' :
    /bulgaria|bulgar/.test(t) ? 'Bulgaria' :
    /\balbania\b/.test(t) ? 'Albania' :
    /\bkosovo\b/.test(t) ? 'Kosovo' :
    supaProfile?.country || null;

  const budget =
    /1[\s,.]?000[\s,.]?000|1\s*million/.test(t) ? 'above €500k' :
    /500[\s,.]?000|500k/.test(t) ? '€150k–€500k' :
    /100[\s,.]?000|100k/.test(t) ? '€30k–€150k' :
    /[5-9]\d[\s,.]?000/.test(t) ? '€30k–€150k' :
    /[1-4]\d[\s,.]?000/.test(t) ? 'up to €30k' :
    supaProfile?.goals || null;

  return { sector, orgType, country, budget };
}

// ═══ MAIN SEARCH LOGIC — DB only for stability ═══

async function getSearchResults(userText, profile) {
  const cacheKey = hashQuery(JSON.stringify({ userText, profile }));

  const cached = await getCached(cacheKey);
  if (cached?.results?.length) {
    console.log('[v16] cache hit');
    return { results: cached.results, cachedAt: cached.created_at, fromCache: true };
  }

  const dbResults = await searchFundingDB(profile);

  if (dbResults.length > 0) {
    saveCache(cacheKey, userText, dbResults).catch(() => {});
  }

  console.log(`[v16] db:${dbResults.length} cache:false top:${dbResults[0]?.score || 0}`);
  return { results: dbResults, cachedAt: null, fromCache: false };
}

// ═══ SYSTEM PROMPT ═══

function buildSystemPrompt(lang, today, profile, results) {
  const L = LANG_NAMES[lang] || 'English';

  const profileText = profile.sector || profile.orgType || profile.country
    ? `\nOrganization type: ${profile.orgType || 'not specified'}
Sector: ${profile.sector || 'not specified'}
Country: ${profile.country || 'not specified'}
Budget range: ${profile.budget || 'not specified'}`
    : '\nProfile not yet collected — ask one targeted question.';

  let dbText = '';
  if (results.length > 0) {
    dbText = '\n\nDATABASE RESULTS:\n' +
      results.map((r, i) =>
        `[${i + 1}] Match:${r.score ?? 0}% | ${r.title}\n${r.snippet}\nURL: ${r.link}`
      ).join('\n\n');
  }

  return `LANGUAGE: Always respond in ${L}. Match the user's language exactly.

You are MARGINOVA — a global funding intelligence engine.

Today: ${today}
USER PROFILE:${profileText}

RULES:
- Use ONLY the provided DB results unless there are zero DB results
- Do NOT invent programs, deadlines, amounts, co-financing, or eligibility
- If DB results exist, do not add external opportunities from memory
- Rank results strictly by provided Match score
- If profile is incomplete, ask exactly ONE clarifying question before searching
- Be direct and specific — no generic advice

FORMAT each opportunity exactly like this:
📋 [Program name]
🎯 Match: [X]%
💰 [Amount / range if available]
✅ Why you qualify: [based only on provided DB fields]
⚠️ Main risk: [based only on eligibility, country, budget, deadline, or org type mismatch]
🔗 [URL]

If there are no DB results, say clearly that no strong database matches were found and ask one focused follow-up question.
Close with ONE concrete action the user can take TODAY.${dbText}`;
}

// ═══ GEMINI — with retry ═══

async function geminiCall(systemPrompt, messages, imageData, imageType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }]
  }));

  if (imageData && imageType && contents.length > 0) {
    contents[contents.length - 1].parts.push({
      inline_data: { mime_type: imageType, data: imageData }
    });
  }

  if (!contents.length) {
    contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  const r = await ft(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 4096, temperature: 0.35 }
    })
  }, 30000);

  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const d = await r.json();
  if (d.error) throw new Error(d.error.message);

  const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

async function gemini(systemPrompt, messages, imageData, imageType) {
  try {
    return await geminiCall(systemPrompt, messages, imageData, imageType);
  } catch (e) {
    console.log('[GEMINI] retry:', e.message);
    await new Promise(r => setTimeout(r, 1500));
    try {
      return await geminiCall(systemPrompt, messages, imageData, imageType);
    } catch {
      throw new Error('Service temporarily unavailable. Please try again in a moment.');
    }
  }
}

// ═══ MAIN REQUEST HANDLER ═══

module.exports = async function handler(req, res) {
  const ORIGINS = ['https://marginova.tech', 'https://www.marginova.tech', 'http://localhost:3000'];
  const origin = req.headers.origin || '';

  res.setHeader('Access-Control-Allow-Origin', ORIGINS.includes(origin) ? origin : ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  if (!GEMINI_KEY) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY.' } });

  if (!(await checkIP(req))) {
    return res.status(429).json({ error: { message: 'Daily limit reached. Try again tomorrow.' } });
  }

  try {
    const body = req.body || {};
    const userId = body.userId || null;
    const userText = body.messages?.[body.messages.length - 1]?.content || '';
    const imageData = body.image || null;
    const imageType = body.imageType || null;

    if (userText.length > 2000) {
      return res.status(400).json({ error: { message: 'Message too long. Max 2000 characters.' } });
    }

    if (userId && !(await checkQuota(userId))) {
      return res.status(429).json({
        error: { message: 'Message limit reached. Please upgrade your plan.' },
        quota_exceeded: true
      });
    }

    const lang = body.lang || detectLang(userText);
    const today = new Date().toLocaleDateString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
    const conversationText = (body.messages || []).map(m => m.content || '').join(' ');

    const supaProfile = userId ? await loadProfile(userId) : null;
    const profile = detectProfile(conversationText, supaProfile);

    if (userId && (profile.sector || profile.orgType || profile.country)) {
      dbPatch('profiles?user_id=eq.' + userId, {
        detected_sector: profile.sector,
        detected_org_type: profile.orgType,
        detected_country: profile.country
      }).catch(() => {});
    }

    if (Math.random() < 0.05) cleanExpiredCache().catch(() => {});

    const shouldSearch = needsSearch(userText, conversationText) || !!imageData;
    let results = [];
    let cachedAt = null;
    let fromCache = false;

    if (shouldSearch && !imageData) {
      const searchData = await getSearchResults(userText, profile);
      results = searchData.results || [];
      cachedAt = searchData.cachedAt;
      fromCache = searchData.fromCache;
    }

    const messages = (body.messages || []).slice(-8).map(m => ({
      role: m.role,
      content: String(m.content || '')
    }));

    const systemPrompt = buildSystemPrompt(lang, today, profile, results);
    const text = await gemini(systemPrompt, messages, imageData, imageType);

   return res.status(200).json({
  content: [{ type: 'text', text }],
  intent: shouldSearch ? 'grant' : 'general',
  cached: fromCache,
  cached_at: cachedAt,
  db_results: results.length,
  web_results: 0,
  top_matches: results.slice(0, 5).map(r => ({
    title: r.title || '',
    score: Number.isFinite(r.score) ? r.score : 0,
    score_type: 'match',
    source: 'db',
    link: r.link || '',
    snippet: r.snippet || ''
  })),
  debug_results: results
});

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
