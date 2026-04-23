// ═════════════════════════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// Clean version — DB first + real Serper fallback + Gemini synthesis
// ═════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const SERPER_KEY = process.env.SERPER_API_KEY;

const DAILY_LIMIT = 200;
const PLANS = { free: 20, starter: 500, pro: 2000, business: -1 };
const CACHE_TTL_HOURS = 24;
const DB_STRONG_SCORE = 75;
const MAX_DB_RESULTS = 6;
const MAX_WEB_RESULTS = 5;

const supabase = (SUPA_URL && SUPA_KEY)
  ? createClient(SUPA_URL, SUPA_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

function ft(url, opts = {}, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function getTable(name) {
  if (!supabase) throw new Error('Supabase client not initialized');
  return supabase.from(name);
}

function safeText(value) {
  return String(value || '').trim();
}

function hashQuery(str) {
  const n = String(str || '').toLowerCase().trim().replace(/\s+/g, ' ');
  let h = 0;
  for (let i = 0; i < n.length; i++) {
    h = ((h << 5) - h) + n.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

async function checkIP(req) {
  if (!supabase) return true;

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const today = new Date().toISOString().split('T')[0];

  try {
    const { data: row, error } = await getTable('ip_limits')
      .select('ip,count,reset_date')
      .eq('ip', ip)
      .maybeSingle();

    if (error) {
      console.log('[DB GET ip_limits]', error.message);
      return true;
    }

    if (!row || row.reset_date !== today) {
      const { error: upsertError } = await getTable('ip_limits').upsert(
        { ip, count: 1, reset_date: today },
        { onConflict: 'ip' }
      );
      if (upsertError) console.log('[IP UPSERT]', upsertError.message);
      return true;
    }

    if ((row.count || 0) >= DAILY_LIMIT) return false;

    const { error: updateError } = await getTable('ip_limits')
      .update({ count: (row.count || 0) + 1 })
      .eq('ip', ip);

    if (updateError) console.log('[IP UPDATE]', updateError.message);
    return true;
  } catch (e) {
    console.log('[IP CHECK]', e.message);
    return true;
  }
}

async function checkQuota(userId) {
  if (!userId || !supabase) return true;

  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: p, error } = await getTable('profiles')
      .select('plan,daily_msgs,last_msg_date')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.log('[QUOTA] error:', error.message);
      return true;
    }

    if (!p) return true;

    const limit = PLANS[p.plan] ?? 20;
    if (limit === -1) return true;

    const used = p.last_msg_date === today ? (p.daily_msgs || 0) : 0;
    return used < limit;
  } catch (e) {
    console.log('[QUOTA]', e.message);
    return true;
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
  } catch (e) {
    console.log('[PROFILE]', e.message);
    return null;
  }
}

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

function needsSearch(text, conversationText) {
  const t = `${text} ${conversationText}`.toLowerCase();
  return /grant|fund|funding|finance|financ|subsid|fellowship|scholarship|award|donor|ngo|program|open call|call for proposal|support|money|euros|invest|tender|procurement/i.test(t);
}

function detectProfile(text, supaProfile) {
  const t = String(text || '').toLowerCase();

  const sector =
    /\bit\b|tech|software|digital|technology|ai|saas/.test(t) ? 'IT / Technology' :
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
    /individual|freelance|self-employed|creator/.test(t) ? 'Individual / Entrepreneur' :
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

function buildSearchQuery(userText, profile) {
  const parts = [safeText(userText)];
  if (profile?.sector) parts.push(profile.sector);
  if (profile?.orgType) parts.push(profile.orgType);
  if (profile?.country) parts.push(profile.country);
  if (profile?.budget) parts.push(profile.budget);
  return parts.filter(Boolean).join(' | ').slice(0, 280);
}

function scoreDbRow(row, profile) {
  let score = 0;

  const focus = safeText(row.focus_areas).toLowerCase();
  const desc = safeText(row.description).toLowerCase();
  const elig = safeText(row.eligibility).toLowerCase();
  const type = safeText(row.opportunity_type).toLowerCase();
  const country = safeText(row.country).toLowerCase();
  const hay = `${focus} ${desc} ${elig} ${type}`;

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

    const hits = (sectorMap[profile.sector] || []).filter(k => hay.includes(k)).length;
    if (hits > 0) score += Math.min(35, hits * 12);
  }

  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (!country || country.includes('global') || country.includes('europe') || country.includes(pc) || (pc.includes('north macedonia') && country.includes('western balkans'))) {
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

    const hits = (orgMap[profile.orgType] || []).filter(k => hay.includes(k)).length;
    if (hits > 0) score += Math.min(20, hits * 10);
  }

  if (profile.budget && row.award_amount != null) {
    const amount = Number(row.award_amount);
    const budgetRanges = {
      'up to €30k': [0, 30000],
      '€30k–€150k': [30000, 150000],
      '€150k–€500k': [150000, 500000],
      'above €500k': [500000, Infinity]
    };
    const [minB, maxB] = budgetRanges[profile.budget] || [0, Infinity];
    if (amount >= minB && amount <= maxB) score += 15;
  }

  if (row.application_deadline) score += 5;

  return Math.max(0, Math.min(100, score));
}

async function searchFundingDB(profile) {
  if (!supabase) return [];

  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: allRows, error } = await getTable('funding_opportunities')
      .select('title,organization_name,opportunity_type,funding_range,award_amount,currency,focus_areas,eligibility,application_deadline,country,description,source_url,status')
      .eq('status', 'Open')
      .limit(100);

    if (error) {
      console.log('[DB SEARCH]', error.message);
      return [];
    }

    const rows = (allRows || []).filter(row => !row.application_deadline || row.application_deadline >= today);

    return rows
      .map(row => {
        const score = scoreDbRow(row, profile);
        return {
          ...row,
          score,
          score_type: 'match',
          source: 'db',
          snippet: [
            row.organization_name,
            row.award_amount ? `${row.award_amount} ${row.currency || ''}`.trim() : row.funding_range,
            row.eligibility,
            row.application_deadline ? `Deadline: ${row.application_deadline}` : null
          ].filter(Boolean).join(' | '),
          link: row.source_url || ''
        };
      })
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_DB_RESULTS);
  } catch (e) {
    console.log('[DB SEARCH]', e.message);
    return [];
  }
}

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
      console.log('[CACHE GET]', error.message);
      return null;
    }

    if (data?.length) return { results: data[0].results, created_at: data[0].created_at };
    return null;
  } catch (e) {
    console.log('[CACHE GET]', e.message);
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

    if (error) console.log('[CACHE SAVE]', error.message);
  } catch (e) {
    console.log('[CACHE SAVE]', e.message);
  }
}

async function cleanExpiredCache() {
  if (!supabase) return;
  try {
    await getTable('search_cache').delete().lt('expires_at', new Date().toISOString());
  } catch {}
}

function shouldUseWebFallback(dbResults) {
  if (!dbResults.length) return true;
  return (dbResults[0]?.score || 0) < DB_STRONG_SCORE;
}

async function searchWebSerper(query) {
  if (!SERPER_KEY) {
    console.log('[SERPER] missing SERPER_API_KEY');
    return [];
  }

  try {
    const r = await ft('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': SERPER_KEY
      },
      body: JSON.stringify({
        q: query,
        num: MAX_WEB_RESULTS,
        gl: 'mk',
        hl: 'en',
        autocorrect: true
      })
    }, 15000);

    if (!r.ok) {
      const msg = await r.text();
      console.log('[SERPER]', r.status, msg.slice(0, 200));
      return [];
    }

    const data = await r.json();
    const organic = Array.isArray(data?.organic) ? data.organic : [];

    return organic.slice(0, MAX_WEB_RESULTS).map((item, index) => ({
      source: 'web',
      rank: index + 1,
      title: safeText(item.title),
      link: safeText(item.link),
      snippet: safeText(item.snippet),
      position: item.position || index + 1
    })).filter(item => item.title || item.link || item.snippet);
  } catch (e) {
    console.log('[SERPER]', e.message);
    return [];
  }
}

async function getSearchResults(userText, profile) {
  const query = buildSearchQuery(userText, profile);
  const cacheKey = hashQuery(JSON.stringify({ query, profile }));

  const cached = await getCached(cacheKey);
  if (cached?.results) {
    return {
      dbResults: cached.results.dbResults || [],
      webResults: cached.results.webResults || [],
      cachedAt: cached.created_at,
      fromCache: true,
      usedWebFallback: !!(cached.results.webResults || []).length
    };
  }

  const dbResults = await searchFundingDB(profile);
  let webResults = [];

  if (shouldUseWebFallback(dbResults)) {
    webResults = await searchWebSerper(query);
  }

  const payload = { dbResults, webResults };
  if (dbResults.length || webResults.length) {
    saveCache(cacheKey, query, payload).catch(() => {});
  }

  return {
    dbResults,
    webResults,
    cachedAt: null,
    fromCache: false,
    usedWebFallback: webResults.length > 0
  };
}

function buildSystemPrompt(lang, today, profile, dbResults, webResults) {
  const languageName = LANG_NAMES[lang] || 'English';

  const profileText = profile?.sector || profile?.orgType || profile?.country
    ? `\nOrganization type: ${profile.orgType || 'not specified'}\nSector: ${profile.sector || 'not specified'}\nCountry: ${profile.country || 'not specified'}\nBudget range: ${profile.budget || 'not specified'}`
    : '\nProfile not yet collected — ask exactly ONE focused question.';

  const dbText = dbResults.length
    ? '\n\nDATABASE RESULTS:\n' + dbResults.map((r, i) => (
      `[${i + 1}] Match:${r.score}% | ${r.title}\n${r.snippet}\nURL: ${r.link || 'N/A'}`
    )).join('\n\n')
    : '\n\nDATABASE RESULTS:\nNone';

  const webText = webResults.length
    ? '\n\nLIVE WEB RESULTS (SERPER):\n' + webResults.map((r, i) => (
      `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.link || 'N/A'}`
    )).join('\n\n')
    : '\n\nLIVE WEB RESULTS (SERPER):\nNone';

  return `LANGUAGE: Always respond in ${languageName}. Match the user's language exactly.

You are MARGINOVA — a global funding intelligence engine.
Today: ${today}
USER PROFILE:${profileText}

SOURCE PRIORITY:
1. Database results are highest priority
2. Live web results are secondary fallback
3. Never invent opportunities, deadlines, or amounts

RESPONSE RULES:
- If strong database matches exist, show them first
- If live web results exist, put them in a separate section called External / Live results
- Never present web results as if they came from the database
- Use only the actual data provided below
- If profile is incomplete and results are weak, ask exactly ONE focused follow-up question
- Be direct, practical, and concise
- If something is uncertain, say what must be verified on the official source

FORMAT FOR DATABASE RESULTS:
📋 [Program name]
🏷️ Source: Database
🎯 Match: [X]%
💰 [Amount / range if available]
✅ Why you qualify: [only from provided DB fields]
⚠️ Main risk: [eligibility / country / deadline / org type / budget mismatch]
🔗 [URL]

FORMAT FOR LIVE RESULTS:
📋 [Program name]
🏷️ Source: External / Live
🎯 Estimated fit: [Low / Medium / Strong]
💰 [Amount / range if known, otherwise say Not clearly stated]
✅ Why it may fit
⚠️ What must be verified
🔗 [URL]
${dbText}${webText}`;
}

async function geminiCall(systemPrompt, messages, imageData, imageType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: safeText(m.content) }]
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
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.35
      }
    })
  }, 30000);

  if (!r.ok) {
    throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }

  const data = await r.json();
  if (data.error) throw new Error(data.error.message);

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

async function gemini(systemPrompt, messages, imageData, imageType) {
  try {
    return await geminiCall(systemPrompt, messages, imageData, imageType);
  } catch (e) {
    console.log('[GEMINI RETRY]', e.message);
    await new Promise(resolve => setTimeout(resolve, 1500));
    try {
      return await geminiCall(systemPrompt, messages, imageData, imageType);
    } catch {
      throw new Error('Service temporarily unavailable. Please try again in a moment.');
    }
  }
}

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
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userText = safeText(messages[messages.length - 1]?.content);
    const imageData = body.image || null;
    const imageType = body.imageType || null;

    if (!userText && !imageData) {
      return res.status(400).json({ error: { message: 'Empty message.' } });
    }

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

    const conversationText = messages.map(m => safeText(m.content)).join(' ');
    const supaProfile = userId ? await loadProfile(userId) : null;
    const profile = detectProfile(conversationText, supaProfile);

    if (userId && (profile.sector || profile.orgType || profile.country) && supabase) {
      getTable('profiles')
        .update({
          detected_sector: profile.sector,
          detected_org_type: profile.orgType,
          detected_country: profile.country
        })
        .eq('user_id', userId)
        .then(({ error }) => {
          if (error) console.log('[PROFILE PATCH]', error.message);
        })
        .catch(() => {});
    }

    if (Math.random() < 0.05) cleanExpiredCache().catch(() => {});

    const shouldSearch = (needsSearch(userText, conversationText) || !!imageData) && !imageData;

    let dbResults = [];
    let webResults = [];
    let cachedAt = null;
    let fromCache = false;
    let usedWebFallback = false;

    if (shouldSearch) {
      const searchData = await getSearchResults(userText, profile);
      dbResults = searchData.dbResults || [];
      webResults = searchData.webResults || [];
      cachedAt = searchData.cachedAt;
      fromCache = searchData.fromCache;
      usedWebFallback = searchData.usedWebFallback;
    }

    const systemPrompt = buildSystemPrompt(lang, today, profile, dbResults, webResults);

    const llmMessages = messages.slice(-8).map(m => ({
      role: m.role,
      content: safeText(m.content)
    }));

    const text = await gemini(systemPrompt, llmMessages, imageData, imageType);

    return res.status(200).json({
      content: [{ type: 'text', text }],
      intent: shouldSearch ? 'grant' : 'general',
      cached: fromCache,
      cached_at: cachedAt,
      db_results: dbResults.length,
      web_results: webResults.length,
      web_fallback_used: usedWebFallback,
      top_matches: dbResults.slice(0, 5).map(r => ({
        title: r.title || '',
        score: Number.isFinite(r.score) ? r.score : 0,
        score_type: 'match',
        source: 'db',
        link: r.link || '',
        snippet: r.snippet || ''
      })),
      live_results: webResults.slice(0, 5),
      debug_results: {
        dbResults,
        webResults
      }
    });
  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
