// ═════════════════════════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// v20 — Scholarship/student support + limit 150 + improved scoring
// ═════════════════════════════════════════════════════════════

const { supabase, getTable, ft, detectLang, LANG_NAMES, checkIP, setCors } = require('./_lib/utils');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const SERPER_KEY = process.env.SERPER_API_KEY;

console.log('[chat.js v20] SUPABASE:', supabase ? 'OK' : 'MISSING');
console.log('[chat.js v20] SERPER:', SERPER_KEY ? 'OK' : 'MISSING');

const PLANS = { free: 20, starter: 500, pro: 2000, business: -1 };
const CACHE_TTL_HOURS = 24;
const DB_MIN_RESULTS = 3;      // if DB returns fewer than this → trigger Serper
const DB_MIN_SCORE   = 30;     // if top score is below this → trigger Serper

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
      .select('id,title,organization_name,opportunity_type,funding_range,award_amount,currency,focus_areas,eligibility,application_deadline,country,description,source_url,status')
      .in('status', ['Open'])
      .limit(150);

    if (error) { console.log('[DB SEARCH] error:', error.message); return []; }

    const rows = (allRows || []).filter(g => !g.application_deadline || g.application_deadline >= today);
    if (!rows.length) return [];

    const scored = rows.map(g => {
      let score = 0;
      const focus   = String(g.focus_areas   || '').toLowerCase();
      const desc    = String(g.description   || '').toLowerCase();
      const elig    = String(g.eligibility   || '').toLowerCase();
      const type    = String(g.opportunity_type || '').toLowerCase();
      const country = String(g.country       || '').toLowerCase();

      const sectorMap = {
        'IT / Technology':        ['ai','technology','digital','software','startup','innovation','ict','tech'],
        'Agriculture':            ['agriculture','farmer','rural','food','farm','ipard'],
        'Education':              ['education','school','learning','training','youth','student','scholarship','fellowship','mobility','erasmus','study','academic'],
        'Environment / Energy':   ['climate','environment','green','energy','renewable'],
        'Civil Society':          ['ngo','civil society','community','rights','nonprofit','social'],
        'Health / Social':        ['health','social','welfare','care','women','gender','single parent','family'],
        'Research / Innovation':  ['research','science','innovation','academic','university','phd','postgraduate'],
        'SME / Business':         ['business','enterprise','sme','company','entrepreneur','startup','digital','technology'],
        'Tourism / Culture':      ['tourism','culture','heritage','creative','art'],
        'Student / Youth':        ['student','scholarship','fellowship','youth','young','study','mobility','erasmus','fulbright','daad','chevening','stipend','postgraduate','phd','exchange']
      };

      if (profile.sector) {
        const kws  = sectorMap[profile.sector] || [];
        const hay  = `${focus} ${desc}`;
        const hits = kws.filter(k => hay.includes(k)).length;
        if (hits > 0) score += Math.min(35, hits * 12);
      }

      // Also check raw conversation keywords regardless of sector
      if (profile.keywords?.length) {
        const hay  = `${focus} ${desc} ${elig}`;
        const hits = profile.keywords.filter(k => hay.includes(k)).length;
        if (hits > 0) score += Math.min(20, hits * 7);
      }

      if (profile.country) {
        const pc = profile.country.toLowerCase();
        if (!country || country.includes('global') || country.includes('europe') ||
            country.includes(pc) ||
            (pc.includes('north macedonia') && country.includes('western balkans'))) {
          score += 25;
        }
      }

      if (profile.orgType) {
        const orgMap = {
          'NGO / Association':        ['ngo','nonprofit','association','civil society','foundation'],
          'Startup':                  ['startup','early stage','venture','founder'],
          'Agricultural holding':     ['farmer','agricultural','holding','ipard'],
          'SME':                      ['sme','enterprise','company','business'],
          'Municipality / Public body':['municipality','local government','public body'],
          'University / Research':    ['university','research','academic','institute'],
          'Individual / Entrepreneur':['individual','entrepreneur','founder','self-employed','freelance','creator']
        };
        const kws  = orgMap[profile.orgType] || [];
        const hay  = `${elig} ${desc} ${type}`;
        const hits = kws.filter(k => hay.includes(k)).length;
        if (hits > 0) score += Math.min(20, hits * 10);
      }

      if (profile.budget && g.award_amount != null) {
        const amt = Number(g.award_amount);
        const budgetRanges = {
          'up to €30k':    [0, 30000],
          '€30k–€150k':    [30000, 150000],
          '€150k–€500k':   [150000, 500000],
          'above €500k':   [500000, Infinity]
        };
        const [minB, maxB] = budgetRanges[profile.budget] || [0, Infinity];
        if (amt >= minB && amt <= maxB) score += 15;
      }

      if (g.application_deadline) score += 5;

      // Bonus for scholarship/fellowship type matching student queries
      if (g.opportunity_type === 'scholarship' || g.opportunity_type === 'fellowship') {
        if (profile.keywords?.some(k => ['student','scholarship','stipend','study','fellowship','erasmus','fulbright','daad','youth','young','university','phd'].includes(k))) {
          score += 25;
        }
      }

      return {
        ...g,
        score: Math.max(0, Math.min(100, score)),
        score_type: 'match',
        source: 'db',
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

    console.log('[DB] matched:', ranked.length, 'top score:', ranked[0]?.score ?? 0);
    return ranked;
  } catch (e) {
    console.log('[DB SEARCH] error:', e.message);
    return [];
  }
}

// ═══ SERPER LIVE SEARCH ═══

async function searchSerper(query) {
  if (!SERPER_KEY) {
    console.log('[SERPER] No API key — skipping');
    return [];
  }

  try {
    const r = await ft('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 8, gl: 'us', hl: 'en' })
    }, 8000);

    if (!r.ok) {
      console.log('[SERPER] error:', r.status);
      return [];
    }

    const data = await r.json();
    const items = data.organic || [];

    const results = items
      .filter(item => item.title && item.link)
      .map(item => ({
        title:      item.title,
        snippet:    item.snippet || '',
        link:       item.link,
        score:      40,
        score_type: 'web',
        source:     'serper'
      }))
      .slice(0, 5);

    console.log('[SERPER] results:', results.length);
    return results;
  } catch (e) {
    console.log('[SERPER] error:', e.message);
    return [];
  }
}

// ═══ HYBRID SEARCH ═══

function buildSerperQuery(userText, profile) {
  const parts = ['grant funding'];
  if (profile.sector)  parts.push(profile.sector.split('/')[0].trim());
  if (profile.country) parts.push(profile.country);
  if (profile.orgType) parts.push(profile.orgType.split('/')[0].trim());

  // Add key terms from user message
  const keywords = userText.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !['about','where','which','would','could','their','there','what'].includes(w))
    .slice(0, 3);

  parts.push(...keywords);
  return parts.join(' ');
}

async function hybridSearch(userText, profile) {
  // Always try DB first
  const dbResults = await searchFundingDB(profile);

  const topScore    = dbResults[0]?.score ?? 0;
  const needsSerper = dbResults.length < DB_MIN_RESULTS || topScore < DB_MIN_SCORE;

  console.log(`[HYBRID] db:${dbResults.length} topScore:${topScore} needsSerper:${needsSerper}`);

  if (!needsSerper) {
    return { results: dbResults, sources: { db: dbResults.length, serper: 0 } };
  }

  // DB is thin or low confidence — enrich with Serper
  const query       = buildSerperQuery(userText, profile);
  const webResults  = await searchSerper(query);

  // Merge: DB results first (higher trust), then Serper fills gaps
  const merged = [...dbResults, ...webResults].slice(0, 8);

  return {
    results: merged,
    sources: { db: dbResults.length, serper: webResults.length }
  };
}

// ═══ CACHE ═══

async function getCached(queryHash) {
  if (!supabase) return null;
  try {
    const { data, error } = await getTable('search_cache')
      .select('results,created_at,expires_at')
      .eq('query_hash', queryHash)
      .gt('expires_at', new Date().toISOString())
      .limit(1);

    if (error) { console.log('[CACHE] get error:', error.message); return null; }
    if (data?.length > 0) { console.log('[CACHE] hit:', queryHash); return { results: data[0].results, created_at: data[0].created_at }; }
    return null;
  } catch (e) { console.log('[CACHE] get error:', e.message); return null; }
}

async function saveCache(queryHash, queryText, results) {
  if (!supabase) return;
  try {
    const now     = new Date();
    const expires = new Date(now.getTime() + CACHE_TTL_HOURS * 3600000);
    await getTable('search_cache').delete().eq('query_hash', queryHash);
    const { error } = await getTable('search_cache').insert({
      query_hash: queryHash, query_text: queryText, results,
      created_at: now.toISOString(), expires_at: expires.toISOString()
    });
    if (error) console.log('[CACHE] save error:', error.message);
    else console.log('[CACHE] saved:', queryHash);
  } catch (e) { console.log('[CACHE] save error:', e.message); }
}

async function cleanExpiredCache() {
  if (!supabase) return;
  try {
    const { error } = await getTable('search_cache').delete().lt('expires_at', new Date().toISOString());
    if (error) console.log('[CACHE CLEAN]', error.message);
  } catch (e) { console.log('[CACHE CLEAN]', e.message); }
}

// ═══ QUOTA ═══

async function checkAndDeductQuota(userId) {
  if (!userId || !supabase) return { allowed: true };
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: p, error } = await getTable('profiles')
      .select('plan,daily_msgs,last_msg_date')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) { console.log('[QUOTA]', error.message); return { allowed: true }; }
    if (!p) return { allowed: true };

    const limit = PLANS[p.plan] ?? 20;
    if (limit === -1) return { allowed: true };

    const used = p.last_msg_date === today ? (p.daily_msgs || 0) : 0;
    if (used >= limit) return { allowed: false, used, limit, plan: p.plan };

    await getTable('profiles')
      .update({ daily_msgs: used + 1, last_msg_date: today })
      .eq('user_id', userId);

    return { allowed: true, used: used + 1, limit, plan: p.plan };
  } catch (e) { console.log('[QUOTA]', e.message); return { allowed: true }; }
}

async function loadProfile(userId) {
  if (!userId || !supabase) return null;
  try {
    const { data: p, error } = await getTable('profiles')
      .select('sector,country,organization_type,goals,plan,detected_sector,detected_org_type,detected_country')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) { console.log('[PROFILE] error:', error.message); return null; }
    if (!p) return null;

    return {
      ...p,
      sector:            p.sector            || p.detected_sector   || null,
      organization_type: p.organization_type || p.detected_org_type || null,
      country:           p.country           || p.detected_country  || null,
    };
  } catch { return null; }
}

// ═══ INTENT DETECTION ═══

function needsSearch(messages) {
  const recentUserMessages = messages
    .filter(m => m.role === 'user')
    .slice(-2)
    .map(m => m.content || '')
    .join(' ')
    .toLowerCase();

  return /grant|fund|financ|subsid|fellowship|scholarship|award|donor|ngo|program|open call|call for proposal|support money|invest|subvenc|finansi|podrsk|stipend|student|youth|erasmus|fulbright|daad|chevening|stud|mlad/.test(recentUserMessages);
}

function detectProfile(text, supaProfile) {
  const t = text.toLowerCase();

  const sector =
    /\bit\b|tech|software|digital|technology|ai|veshtacka/.test(t)    ? 'IT / Technology' :
    /agri|farm|rural|crop|livestock|hektar|ipard|zemjo/.test(t)        ? 'Agriculture' :
    /student|stipend|scholarship|fellowship|erasmus|fulbright|daad|chevening|mlad|youth|exchange|study abroad/.test(t) ? 'Student / Youth' :
    /educat|school|youth|training|learning|obrazov/.test(t)            ? 'Education' :
    /environment|climate|green|energy|renewable|solar/.test(t)         ? 'Environment / Energy' :
    /civil|ngo|nonprofit|association|society|zdruzen/.test(t)          ? 'Civil Society' :
    /tourism|culture|heritage|creative|art/.test(t)                    ? 'Tourism / Culture' :
    /health|medical|social|welfare|majki|semejst|gender|women/.test(t) ? 'Health / Social' :
    /research|science|innovation|university|academic|phd/.test(t)      ? 'Research / Innovation' :
    /sme|small business|company|enterprise|startup/.test(t)            ? 'SME / Business' :
    supaProfile?.sector || null;

  const orgType =
    /startup/.test(t)                                                           ? 'Startup' :
    /\bngo\b|nonprofit|association|foundation|civil society|zdruzen/.test(t)   ? 'NGO / Association' :
    /farmer|farm|agricultural|holding|ipard/.test(t)                           ? 'Agricultural holding' :
    /individual|freelance|self.employed|poedinec|creator|samostoen/.test(t)    ? 'Individual / Entrepreneur' :
    /\bsme\b|\bltd\b|\bdoo\b|small business/.test(t)                           ? 'SME' :
    /municipality|local government|public body/.test(t)                        ? 'Municipality / Public body' :
    /university|research institute|academic/.test(t)                           ? 'University / Research' :
    supaProfile?.organization_type || null;

  const country =
    /macedon|makedon|north macedon|mkd|севerna|македон/.test(t) ? 'North Macedonia' :
    /\bserbia\b|srbija/.test(t)                                  ? 'Serbia' :
    /croatia|hrvatska/.test(t)                                   ? 'Croatia' :
    /\bbosnia\b/.test(t)                                         ? 'Bosnia' :
    /bulgaria|bulgar/.test(t)                                    ? 'Bulgaria' :
    /\balkania\b/.test(t)                                        ? 'Albania' :
    /\bkosovo\b/.test(t)                                         ? 'Kosovo' :
    supaProfile?.country || null;

  const budget =
    /1[\s,.]?000[\s,.]?000|1\s*million/.test(t) ? 'above €500k'  :
    /500[\s,.]?000|500k/.test(t)                 ? '€150k–€500k'  :
    /100[\s,.]?000|100k/.test(t)                 ? '€30k–€150k'   :
    /[5-9]\d[\s,.]?000/.test(t)                  ? '€30k–€150k'   :
    /[1-4]\d[\s,.]?000/.test(t)                  ? 'up to €30k'   :
    supaProfile?.goals || null;

  // Extract raw keywords from conversation for DB scoring bonus
  const keywords = t
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !['about','where','which','would','could','their','there','what','sакате','дали'].includes(w))
    .slice(0, 10);

  return { sector, orgType, country, budget, keywords };
}

// ═══ SYSTEM PROMPT ═══

function buildSystemPrompt(lang, today, profile, results, sources) {
  const L = LANG_NAMES[lang] || 'English';

  const profileText = profile.sector || profile.orgType || profile.country
    ? `\nOrganization type: ${profile.orgType || 'not specified'}
Sector: ${profile.sector || 'not specified'}
Country: ${profile.country || 'not specified'}
Budget range: ${profile.budget || 'not specified'}`
    : '\nProfile not yet collected — ask one targeted question.';

  const dbCount     = sources?.db     ?? 0;
  const serperCount = sources?.serper ?? 0;

  let sourceNote = '';
  if (serperCount > 0 && dbCount === 0) {
    sourceNote = '\n\nNOTE: No database matches found. Results below are from live web search — verify deadlines and eligibility directly on the source URL.';
  } else if (serperCount > 0) {
    sourceNote = `\n\nNOTE: ${dbCount} verified DB results + ${serperCount} live web results. DB results are pre-verified; web results need direct verification.`;
  }

  let resultsText = '';
  if (results.length > 0) {
    resultsText = '\n\nRESULTS:\n' + results.map((r, i) => {
      const sourceLabel = r.source === 'serper' ? '[WEB]' : '[DB]';
      return `[${i + 1}] ${sourceLabel} Match:${r.score ?? 0}% | ${r.title}\n${r.snippet}\nURL: ${r.link}`;
    }).join('\n\n');
  }

  return `LANGUAGE: Always respond in ${L}. Match the user's language exactly.

You are MARGINOVA — a global funding intelligence engine.
You have access to a verified funding database (200+ active programs) and real-time web search via Serper.
Before this conversation reached you, the system already searched both sources and injected the results below.
Results marked [DB] are from the verified Marginova database.
Results marked [WEB] are from a live web search conducted moments ago.
NEVER say you cannot search or access external data — the search already happened.
NEVER reveal technical details like Supabase, Serper, Gemini, or API keys.
If asked how you work: say you are powered by a verified funding database and real-time web intelligence.

Today: ${today}
USER PROFILE:${profileText}

CRITICAL RULES:
- NEVER invent programs, URLs, deadlines, amounts, or eligibility criteria
- If a result has source [DB] — it is verified, present it with confidence
- If a result has source [WEB] — present it but add: "Verify directly on the source link"
- If there are ZERO results — say clearly no matches found, do NOT invent anything
- Rank results strictly by provided Match score
- If profile is incomplete, ask exactly ONE clarifying question before searching
- Be direct and specific

FORMAT each opportunity exactly like this:
📋 [Program name]
🎯 Match: [X]%
💰 [Amount / range if available]
✅ Why you qualify: [based only on provided fields]
⚠️ Main risk: [based only on eligibility, country, budget, deadline, or org type]
🔗 [URL]

Close with ONE concrete action the user can take TODAY.${sourceNote}${resultsText}`;
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

  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Hello' }] });

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

// ═══ MAIN HANDLER ═══

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  if (!GEMINI_KEY)             return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY.' } });

  if (!(await checkIP(req))) {
    return res.status(429).json({ error: { message: 'Daily limit reached. Try again tomorrow.' } });
  }

  try {
    const body      = req.body || {};
    const userId    = body.userId || null;
    const userText  = body.messages?.[body.messages.length - 1]?.content || '';
    const imageData = body.image     || null;
    const imageType = body.imageType || null;

    if (userText.length > 2000) {
      return res.status(400).json({ error: { message: 'Message too long. Max 2000 characters.' } });
    }

    const quotaResult = await checkAndDeductQuota(userId);
    if (!quotaResult.allowed) {
      return res.status(429).json({
        error: { message: 'Message limit reached. Please upgrade your plan.' },
        quota_exceeded: true,
        plan: quotaResult.plan
      });
    }

    const lang    = body.lang || detectLang(userText);
    const today   = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const messages = (body.messages || []).slice(-8).map(m => ({
      role:    m.role,
      content: String(m.content || '')
    }));

    const conversationText = messages.map(m => m.content).join(' ');
    const supaProfile      = userId ? await loadProfile(userId) : null;
    const profile          = detectProfile(conversationText, supaProfile);

    // Async profile patch
    if (userId && (profile.sector || profile.orgType || profile.country) && supabase) {
      getTable('profiles')
        .update({ detected_sector: profile.sector, detected_org_type: profile.orgType, detected_country: profile.country })
        .eq('user_id', userId)
        .then(({ error }) => { if (error) console.log('[PROFILE PATCH]', error.message); })
        .catch(() => {});
    }

    if (Math.random() < 0.05) {
      cleanExpiredCache().catch(e => console.log('[CACHE CLEAN BG]', e.message));
    }

    const shouldSearch = needsSearch(messages) || !!imageData;
    let results  = [];
    let sources  = { db: 0, serper: 0 };
    let fromCache = false;
    let cachedAt  = null;

    if (shouldSearch && !imageData) {
      const cacheKey = hashQuery(JSON.stringify({ userText, profile }));
      const cached   = await getCached(cacheKey);

      if (cached?.results?.length) {
        results   = cached.results;
        cachedAt  = cached.created_at;
        fromCache = true;
        console.log('[v20] cache hit');
      } else {
        const hybrid = await hybridSearch(userText, profile);
        results  = hybrid.results;
        sources  = hybrid.sources;

        if (results.length > 0) {
          await saveCache(cacheKey, userText, results).catch(e =>
            console.log('[CACHE SAVE FAIL]', e.message)
          );
        }
        console.log(`[v20] db:${sources.db} serper:${sources.serper} total:${results.length}`);
      }
    }

    const systemPrompt = buildSystemPrompt(lang, today, profile, results, sources);
    const text         = await gemini(systemPrompt, messages, imageData, imageType);

    return res.status(200).json({
      content:      [{ type: 'text', text }],
      intent:       shouldSearch ? 'grant' : 'general',
      cached:       fromCache,
      cached_at:    cachedAt,
      db_results:   sources.db,
      web_results:  sources.serper,
      top_matches:  results.slice(0, 5).map(r => ({
        title:      r.title || '',
        score:      Number.isFinite(r.score) ? r.score : 0,
        score_type: r.score_type || 'match',
        source:     r.source    || 'db',
        link:       r.link      || '',
        snippet:    r.snippet   || ''
      })),
      debug_results: results
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
