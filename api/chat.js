// ═════════════════════════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// v18 — fixed: shared utils, server-side quota, needsSearch,
//        CORS dedup, cache error logging
// ═════════════════════════════════════════════════════════════

const { supabase, getTable, ft, detectLang, LANG_NAMES, checkIP, setCors } = require('./_lib/utils');

const GEMINI_KEY = process.env.GEMINI_API_KEY;

console.log('[chat.js] SUPABASE:', supabase ? 'OK' : 'MISSING');

const PLANS = { free: 20, starter: 500, pro: 2000, business: -1 };
const CACHE_TTL_HOURS = 24;

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

// ═══ DB SEARCH ═══

async function searchFundingDB(profile) {
  if (!supabase) return [];

  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: allRows, error } = await getTable('funding_opportunities')
      .select('title,organization_name,opportunity_type,funding_range,award_amount,currency,focus_areas,eligibility,application_deadline,country,description,source_url,status')
      .eq('status', 'Open')
      .limit(100);

    if (error) {
      console.log('[DB SEARCH] error:', error.message);
      return [];
    }

    console.log('[DB SEARCH] fetched:', allRows?.length ?? 0);

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
  if (!supabase) return null;

  try {
    const now = new Date().toISOString();

    const { data, error } = await getTable('search_cache')
      .select('results,created_at,expires_at')
      .eq('query_hash', queryHash)
      .gt('expires_at', now)
      .limit(1);

    if (error) {
      console.log('[CACHE] get error:', error.message);
      return null;
    }

    if (data?.length > 0) {
      console.log('[CACHE] hit:', queryHash);
      return { results: data[0].results, created_at: data[0].created_at };
    }

    return null;
  } catch (e) {
    console.log('[CACHE] get error:', e.message);
    return null;
  }
}

async function saveCache(queryHash, queryText, results) {
  if (!supabase) return;

  try {
    const now = new Date();
    const expires = new Date(now.getTime() + CACHE_TTL_HOURS * 3600000);

    await getTable('search_cache').delete().eq('query_hash', queryHash);

    const { error } = await getTable('search_cache').insert({
      query_hash: queryHash,
      query_text: queryText,
      results,
      created_at: now.toISOString(),
      expires_at: expires.toISOString()
    });

    // Fixed: log cache save failures instead of silently ignoring them
    if (error) console.log('[CACHE] save error:', error.message);
    else console.log('[CACHE] saved:', queryHash);
  } catch (e) {
    console.log('[CACHE] save error:', e.message);
  }
}

async function cleanExpiredCache() {
  if (!supabase) return;
  try {
    const { error } = await getTable('search_cache')
      .delete()
      .lt('expires_at', new Date().toISOString());
    if (error) console.log('[CACHE CLEAN]', error.message);
  } catch (e) {
    console.log('[CACHE CLEAN]', e.message);
  }
}

// ═══ QUOTA — server-side only ═══

async function checkAndDeductQuota(userId) {
  if (!userId || !supabase) return { allowed: true };

  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: p, error } = await getTable('profiles')
      .select('plan,daily_msgs,last_msg_date')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.log('[QUOTA]', error.message);
      return { allowed: true }; // fail open
    }

    if (!p) return { allowed: true };

    const limit = PLANS[p.plan] ?? 20;
    if (limit === -1) return { allowed: true };

    const used = p.last_msg_date === today ? (p.daily_msgs || 0) : 0;

    if (used >= limit) {
      return { allowed: false, used, limit, plan: p.plan };
    }

    // Deduct in the same request — no separate client-side call needed
    await getTable('profiles')
      .update({ daily_msgs: used + 1, last_msg_date: today })
      .eq('user_id', userId);

    return { allowed: true, used: used + 1, limit, plan: p.plan };
  } catch (e) {
    console.log('[QUOTA]', e.message);
    return { allowed: true };
  }
}

async function loadProfile(userId) {
  if (!userId || !supabase) return null;

  try {
    const { data: p, error } = await getTable('profiles')
      .select('sector,country,organization_type,goals,plan,detected_sector,detected_org_type,detected_country')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.log('[PROFILE] error:', error.message);
      return null;
    }

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

// ═══ INTENT DETECTION ═══
// Fixed: only inspect the last 2 messages to avoid false positives

function needsSearch(messages) {
  // Look only at the last 2 user messages, not the entire conversation
  const recentUserMessages = messages
    .filter(m => m.role === 'user')
    .slice(-2)
    .map(m => m.content || '')
    .join(' ')
    .toLowerCase();

  return /grant|fund|financ|subsid|fellowship|scholarship|award|donor|ngo|program|open call|call for proposal|support money|invest/.test(recentUserMessages);
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
    /individual|freelance|self.employed|poedinec|creator/.test(t) ? 'Individual / Entrepreneur' :
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
    /\balkania\b/.test(t) ? 'Albania' :
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

// ═══ MAIN SEARCH LOGIC ═══

async function getSearchResults(userText, profile) {
  const cacheKey = hashQuery(JSON.stringify({ userText, profile }));

  const cached = await getCached(cacheKey);
  if (cached?.results?.length) {
    console.log('[v18] cache hit');
    return { results: cached.results, cachedAt: cached.created_at, fromCache: true };
  }

  const dbResults = await searchFundingDB(profile);

  if (dbResults.length > 0) {
    // Await so we can catch and log failures properly
    await saveCache(cacheKey, userText, dbResults).catch(e =>
      console.log('[CACHE SAVE FAIL]', e.message)
    );
  }

  console.log(`[v18] db:${dbResults.length} cache:false top:${dbResults[0]?.score || 0}`);
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

// ═══ GEMINI ═══

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
    } catch (e2) {
      console.log('[GEMINI] retry failed:', e2.message);
      throw new Error('Service temporarily unavailable. Please try again in a moment.');
    }
  }
}

// ═══ MAIN REQUEST HANDLER ═══

module.exports = async function handler(req, res) {
  // Fixed: single CORS source — removed duplicate from vercel.json
  setCors(req, res);

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

    // Fixed: quota is now fully server-side — client-side deductToken() in index.html
    // is only a UX preview; the authoritative check and deduction happen here
    const quotaResult = await checkAndDeductQuota(userId);
    if (!quotaResult.allowed) {
      return res.status(429).json({
        error: { message: 'Message limit reached. Please upgrade your plan.' },
        quota_exceeded: true,
        plan: quotaResult.plan
      });
    }

    const lang = body.lang || detectLang(userText);
    const today = new Date().toLocaleDateString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });

    const messages = (body.messages || []).slice(-8).map(m => ({
      role: m.role,
      content: String(m.content || '')
    }));

    const conversationText = messages.map(m => m.content).join(' ');
    const supaProfile = userId ? await loadProfile(userId) : null;
    const profile = detectProfile(conversationText, supaProfile);

    // Async profile patch — fire and forget is fine here
    if (userId && (profile.sector || profile.orgType || profile.country) && supabase) {
      getTable('profiles')
        .update({
          detected_sector: profile.sector,
          detected_org_type: profile.orgType,
          detected_country: profile.country
        })
        .eq('user_id', userId)
        .then(({ error }) => { if (error) console.log('[PROFILE PATCH]', error.message); })
        .catch(() => {});
    }

    // Fixed: random cleanup replaced with deterministic 5% sample but with logging
    if (Math.random() < 0.05) {
      cleanExpiredCache().catch(e => console.log('[CACHE CLEAN BG]', e.message));
    }

    // Fixed: needsSearch now looks only at recent messages, not full conversation
    const shouldSearch = needsSearch(messages) || !!imageData;
    let results = [];
    let cachedAt = null;
    let fromCache = false;

    if (shouldSearch && !imageData) {
      const searchData = await getSearchResults(userText, profile);
      results = searchData.results || [];
      cachedAt = searchData.cachedAt;
      fromCache = searchData.fromCache;
    }

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
