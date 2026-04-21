// ═══════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// VERSION: v11 — Grants DB First + Supabase IP + File Upload + Retry
// ═══════════════════════════════════════════

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const SERPER_KEY = process.env.SERPER_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const DAILY_LIMIT = 200;
const PLANS = { free: 20, starter: 500, pro: 2000, business: -1 };
const CACHE_TTL_HOURS = 24;
const MIN_DB_RESULTS = 3; // Ако базата врати помалку → повикај Serper

// ═══ HELPERS ═══

function ft(url, opts = {}, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

// ═══ SUPABASE ═══

async function dbGet(path) {
  if (!SUPA_URL || !SUPA_KEY) return null;
  try {
    const r = await ft(`${SUPA_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, Prefer: '' }
    }, 6000);
    if (!r.ok) { console.log('[DB]', r.status); return null; }
    return r.json();
  } catch (e) { console.log('[DB]', e.message); return null; }
}

async function dbPost(path, body) {
  if (!SUPA_URL || !SUPA_KEY) return false;
  try {
    const r = await ft(`${SUPA_URL}/rest/v1/${path}`, {
      method: 'POST',
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(body)
    }, 6000);
    return r.ok;
  } catch (e) { console.log('[DB POST]', e.message); return false; }
}

async function dbPatch(path, body) {
  if (!SUPA_URL || !SUPA_KEY) return;
  try {
    await ft(`${SUPA_URL}/rest/v1/${path}`, {
      method: 'PATCH',
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(body)
    }, 5000);
  } catch {}
}

async function dbDelete(path) {
  if (!SUPA_URL || !SUPA_KEY) return;
  try {
    await ft(`${SUPA_URL}/rest/v1/${path}`, {
      method: 'DELETE',
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    }, 5000);
  } catch {}
}

// ═══════════════════════════════════════════
// IP RATE LIMIT — Supabase (не memory!)
// Таблица: ip_limits(ip text PK, count int, reset_date date)
// ═══════════════════════════════════════════

async function checkIP(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const today = new Date().toISOString().split('T')[0];

  try {
    // Земи постоечки record
    const rows = await dbGet(`ip_limits?ip=eq.${encodeURIComponent(ip)}&select=count,reset_date`);
    const row = rows?.[0];

    if (!row || row.reset_date !== today) {
      // Новден или прв пат — креирај/ресетирај
      await ft(`${SUPA_URL}/rest/v1/ip_limits`, {
        method: 'POST',
        headers: {
          apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify({ ip, count: 1, reset_date: today })
      }, 4000);
      return true;
    }

    if (row.count >= DAILY_LIMIT) return false;

    // Зголеми бројач
    await dbPatch(`ip_limits?ip=eq.${encodeURIComponent(ip)}`, { count: row.count + 1 });
    return true;
  } catch (e) {
    console.log('[IP CHECK]', e.message);
    return true; // Fail open — не блокирај ако базата е недостапна
  }
}

// ═══ HASH ═══
function hashQuery(str) {
  const n = str.toLowerCase().trim().replace(/\s+/g, ' ');
  let h = 0;
  for (let i = 0; i < n.length; i++) { h = ((h << 5) - h) + n.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}

// ═══════════════════════════════════════════
// GRANTS DATABASE SEARCH — Суpabase прво!
// Пребарува по сектор, земја, буџет, active
// ═══════════════════════════════════════════

async function searchGrantsDB(profile) {
  try {
    // Базично: само активни грантови
    let query = 'grants?active=eq.true&select=name,funder,sector,country,min_amount,max_amount,co_finance_percent,deadline,eligibility,portal_url&limit=10';

    // Додај deadline филтер — само идни или без deadline
    const today = new Date().toISOString().split('T')[0];
    query += `&or=(deadline.gte.${today},deadline.is.null)`;

    const rows = await dbGet(query);
    if (!rows || rows.length === 0) return [];

    // Score секој резултат врз основа на профилот
    const scored = rows.map(g => {
      let score = 0;
      const sectorArr = Array.isArray(g.sector) ? g.sector : [];
      const countryArr = Array.isArray(g.country) ? g.country : [];

      // Sector match (+40)
      if (profile.sector && sectorArr.some(s => s.toLowerCase().includes(profile.sector.toLowerCase()) || profile.sector.toLowerCase().includes(s.toLowerCase()))) {
        score += 40;
      }

      // Country match (+30)
      if (profile.country && (countryArr.length === 0 || countryArr.some(c => c.toLowerCase().includes(profile.country.toLowerCase()) || c.includes('Western Balkans') || c.includes('Global')))) {
        score += 30;
      }

      // Budget match (+20)
      if (profile.budget && g.min_amount && g.max_amount) {
        const budgetRanges = {
          'up to €30k':   [0, 30000],
          '€30k–€150k':  [30000, 150000],
          '€150k–€500k': [150000, 500000],
          'above €500k': [500000, Infinity]
        };
        const [minB, maxB] = budgetRanges[profile.budget] || [0, Infinity];
        if (g.max_amount >= minB && g.min_amount <= maxB) score += 20;
      }

      // Org type via eligibility text (+10)
      if (profile.orgType && g.eligibility) {
        const eli = g.eligibility.toLowerCase();
        const orgMap = {
          'NGO / Association': ['ngo', 'nonprofit', 'association', 'civil', 'нво', 'здружение'],
          'Startup': ['startup', 'early stage'],
          'Agricultural holding': ['farmer', 'agricultural', 'земјодел', 'ipard'],
          'SME': ['sme', 'enterprise', 'company', 'business'],
          'Municipality / Public body': ['municipality', 'local government', 'public'],
          'University / Research': ['university', 'research', 'academic'],
          'Individual / Entrepreneur': ['individual', 'entrepreneur', 'freelance'],
        };
        const kws = orgMap[profile.orgType] || [];
        if (kws.some(kw => eli.includes(kw))) score += 10;
      }

      return {
        ...g,
        score,
        source: 'db',
        // Форматирај за Gemini
        title: g.name,
        snippet: `${g.funder} | ${g.min_amount ? '€' + g.min_amount.toLocaleString() : '?'} – ${g.max_amount ? '€' + g.max_amount.toLocaleString() : '?'} | Co-financing: ${g.co_finance_percent || '?'}% | ${g.eligibility || ''}`,
        link: g.portal_url || ''
      };
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, 6);
  } catch (e) {
    console.log('[DB SEARCH]', e.message);
    return [];
  }
}

// ═══════════════════════════════════════════
// RELEVANCE SCORING — за Serper резултати
// ═══════════════════════════════════════════
function scoreResult(result, profile) {
  const text = (result.title + ' ' + result.snippet).toLowerCase();
  let score = 0;

  const sectorKeywords = {
    'Agriculture':           ['agri', 'farm', 'rural', 'ipard', 'crop', 'food', 'земјодел'],
    'IT / Technology':       ['tech', 'digital', 'software', 'startup', 'innovation', 'ai', 'ict'],
    'Civil Society':         ['ngo', 'civil', 'society', 'nonprofit', 'community', 'граѓанск'],
    'Education':             ['education', 'youth', 'school', 'erasmus', 'learning', 'training'],
    'Environment / Energy':  ['environment', 'climate', 'green', 'energy', 'renewable', 'solar'],
    'Health / Social':       ['health', 'social', 'welfare', 'care', 'medical'],
    'Research / Innovation': ['research', 'innovation', 'university', 'horizon', 'science'],
    'SME / Business':        ['sme', 'business', 'enterprise', 'company', 'entrepreneur'],
    'Tourism / Culture':     ['tourism', 'culture', 'heritage', 'creative', 'art'],
  };
  if (profile.sector && sectorKeywords[profile.sector]) {
    const hits = sectorKeywords[profile.sector].filter(kw => text.includes(kw));
    if (hits.length > 0) score += Math.min(25, hits.length * 10);
  }

  const countryKeywords = {
    'North Macedonia': ['macedonia', 'makedon', 'mkd', 'western balkans', 'balkans', 'ipa', 'ipard'],
    'Serbia':          ['serbia', 'srbija', 'western balkans', 'balkans'],
    'Croatia':         ['croatia', 'hrvatska', 'western balkans'],
    'Bosnia':          ['bosnia', 'western balkans', 'balkans'],
    'Bulgaria':        ['bulgaria', 'bulgar'],
    'Albania':         ['albania', 'shqip'],
    'Kosovo':          ['kosovo'],
  };
  if (profile.country && countryKeywords[profile.country]) {
    const hits = countryKeywords[profile.country].filter(kw => text.includes(kw));
    if (hits.length > 0) score += Math.min(20, hits.length * 10);
  }
  if (!profile.country || score < 10) {
    if (/\b(eu|european|global|international|worldwide|undp|usaid|giz|un\b)/i.test(text)) score += 10;
  }

  const currentYear = new Date().getFullYear();
  if (text.includes(String(currentYear))) score += 15;
  if (text.includes(String(currentYear + 1))) score += 10;
  if (/open call|apply now|deadline|applications open|call for proposal/i.test(text)) score += 10;

  if (/€|eur|usd|\$|grant amount|funding|million|thousand/i.test(text)) score += 5;
  if (/\d+[\.,]?\d*\s*(eur|usd|€|\$|million|thousand)/i.test(text)) score += 5;

  // ПОСТРОГИ negative signals
  if (/closed|expired|deadline passed/i.test(text)) score -= 50;
  if (/2022|2023|2024 grant/i.test(text)) score -= 30;
  if (/login required|subscription|paywall/i.test(text)) score -= 15;

  return Math.max(0, Math.min(100, score));
}

function rankResults(results, profile, topN = 6) {
  return results
    .map(r => ({ ...r, score: scoreResult(r, profile) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

// ═══ CACHE ═══

async function getCached(queryHash) {
  try {
    const now = new Date().toISOString();
    const rows = await dbGet(`search_cache?query_hash=eq.${queryHash}&expires_at=gt.${encodeURIComponent(now)}&select=results,created_at&limit=1`);
    if (rows && rows.length > 0) {
      console.log('[CACHE] HIT:', queryHash);
      return { results: rows[0].results, created_at: rows[0].created_at };
    }
    console.log('[CACHE] MISS:', queryHash);
    return null;
  } catch (e) { console.log('[CACHE] get err:', e.message); return null; }
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
    console.log('[CACHE] SAVED:', queryHash);
  } catch (e) { console.log('[CACHE] save err:', e.message); }
}

async function cleanExpiredCache() {
  try {
    const now = new Date().toISOString();
    await dbDelete(`search_cache?expires_at=lt.${encodeURIComponent(now)}`);
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
  } catch { return true; }
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
  } catch { return null; }
}

// ═══ LANGUAGE ═══

function detectLang(text) {
  if (/ќ|ѓ|ѕ|љ|њ|џ/i.test(text)) return 'mk';
  if (/ћ|ђ/i.test(text)) return 'sr';
  if (/јас|сум|македонија|барам|грант|работам|НВО|фонд/i.test(text)) return 'mk';
  if (/[а-шА-Ш]/.test(text)) return 'mk';
  if (/\b(jas|sum|makedonija|zdravo|zemja|proekt|grant|fond|poedinec|zemjodelie|hektar)\b/.test(text.toLowerCase())) return 'mk';
  if (/\b(und|oder|ich|nicht|sie|wir)\b/.test(text)) return 'de';
  if (/\b(est|une|les|des|pour|nous|vous)\b/.test(text)) return 'fr';
  if (/\b(para|una|los|las|que|con)\b/.test(text)) return 'es';
  if (/\b(sam|smo|nije|nisu|brate)\b/.test(text)) return 'sr';
  return 'en';
}

const LANG_NAMES = {
  mk: 'Macedonian', sr: 'Serbian', en: 'English', de: 'German',
  fr: 'French', es: 'Spanish', it: 'Italian', pl: 'Polish', tr: 'Turkish'
};

// ═══ INTENT ═══

function needsSearch(text, conversationText) {
  const t = (text + ' ' + conversationText).toLowerCase();
  return /grant|fund|financ|помош|финансир|грант|фонд|нво|ngo|субвенц|повик|donor|money|euros|program|subsid|award|fellowship|scholarship|call for|open call|барам|средства|поддршка|funding|invest/i.test(t);
}

function detectProfile(text, supaProfile) {
  const t = text.toLowerCase();

  const sector =
    /\bit\b|tech|software|digital|дигитал|технолог/.test(t) ? 'IT / Technology' :
    /agri|farm|земјодел|rural|овошт|насади|hektar|добиток/.test(t) ? 'Agriculture' :
    /educat|school|youth|образован|млади/.test(t) ? 'Education' :
    /environment|climate|green|еколог|energy|renewable/.test(t) ? 'Environment / Energy' :
    /civil|ngo|нво|граѓанск|невладин|здружение/.test(t) ? 'Civil Society' :
    /tourism|туриз|cultur/.test(t) ? 'Tourism / Culture' :
    /health|здравств|social|социјалн/.test(t) ? 'Health / Social' :
    /research|наука|innovation|иновац|university/.test(t) ? 'Research / Innovation' :
    /sme|small business|компанија|фирма|бизнис/.test(t) ? 'SME / Business' :
    supaProfile?.sector || null;

  const orgType =
    /startup/.test(t) ? 'Startup' :
    /нво|НВО|ngo|NGO|здружение|невладин|фондација/.test(t) ? 'NGO / Association' :
    /агри|земјодел|farmer|farm|hektar|насади|добиток/.test(t) ? 'Agricultural holding' :
    /поединец|individual|freelance/.test(t) ? 'Individual / Entrepreneur' :
    /sme|фирма|компанија|doo|ltd/.test(t) ? 'SME' :
    /општина|municipality|локалн/.test(t) ? 'Municipality / Public body' :
    /универзитет|university|институт/.test(t) ? 'University / Research' :
    supaProfile?.organization_type || null;

  const country =
    /македон|makedon|north macedon/.test(t) ? 'North Macedonia' :
    /србиј|serbia/.test(t) ? 'Serbia' :
    /хрватск|croatia/.test(t) ? 'Croatia' :
    /босн|bosnia/.test(t) ? 'Bosnia' :
    /бугар|bulgaria/.test(t) ? 'Bulgaria' :
    supaProfile?.country || null;

  const budget =
    /1\.?000\.?000|1 million/.test(t) ? 'above €500k' :
    /500\.?000|500k/.test(t) ? '€150k–€500k' :
    /100\.?000|100k/.test(t) ? '€30k–€150k' :
    /[5-9]\d\.?000/.test(t) ? '€30k–€150k' :
    /[1-4]\d\.?000/.test(t) ? 'up to €30k' :
    supaProfile?.goals || null;

  return { sector, orgType, country, budget };
}

// ═══ SERPER — подобрени queries ═══

function buildSearchQueries(userText, profile) {
  const year = new Date().getFullYear();
  const sector = profile.sector || 'funding';
  const country = profile.country || 'Western Balkans';
  const queries = [];

  // 1. Програмски-специфичен match
  const pm = userText.match(/\b(ipard|fitr|erasmus|horizon|interreg|civica|undp|usaid|giz|world bank|open society|eu4business|eidhr|wbif)\b/i);
  if (pm) queries.push(`${pm[0]} open call ${year} apply`);

  // 2. Таргетирани domain queries за Балкан
  if (profile.country === 'North Macedonia') {
    queries.push(`${sector} grant ${year} Macedonia site:eufunds.mk OR site:usaid.gov OR site:undp.org`);
  } else {
    queries.push(`${sector} grant ${year} "${country}" open call`);
  }

  // 3. Глобален fallback
  queries.push(`${sector} ${profile.orgType || ''} grant ${year} open call apply now`.trim());

  return [...new Set(queries)].slice(0, 3);
}

async function serperSearch(query) {
  if (!SERPER_KEY) return [];
  try {
    const r = await ft('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 6 })
    }, 8000);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.organic || []).slice(0, 6).map(item => ({
      title: item.title || '',
      snippet: item.snippet || '',
      link: item.link || '',
      source: 'serper'
    }));
  } catch (e) { console.log('[SERPER]', e.message); return []; }
}

// ═══════════════════════════════════════════
// ГЛАВНА SEARCH ЛОГИКА
// 1. Grants DB → 2. Serper (ако < MIN_DB_RESULTS)
// ═══════════════════════════════════════════

async function getSearchResults(userText, profile) {
  let dbResults = [];
  let serperResults = [];
  let cachedAt = null;
  let fromCache = false;

  // 1. Пребарај во grants базата
  dbResults = await searchGrantsDB(profile);
  console.log(`[DB SEARCH] found ${dbResults.length} grants`);

  // 2. Ако базата нема доволно → Serper со cache
  if (dbResults.length < MIN_DB_RESULTS && SERPER_KEY) {
    const queries = buildSearchQueries(userText, profile);
    const cacheKey = hashQuery(queries.join('|'));

    const cached = await getCached(cacheKey);
    if (cached) {
      serperResults = rankResults(cached.results, profile);
      cachedAt = cached.created_at;
      fromCache = true;
      console.log('[SERPER] from cache');
    } else {
      console.log('[SERPER] live search:', queries.length, 'queries');
      const raw = await Promise.all(queries.map(q => serperSearch(q)));
      let webResults = raw.flat().filter(r => r.title && r.link);

      // Deduplicate
      const seen = new Set();
      webResults = webResults.filter(r => {
        if (seen.has(r.link)) return false;
        seen.add(r.link); return true;
      });

      serperResults = rankResults(webResults, profile);

      if (webResults.length > 0) {
        saveCache(cacheKey, queries.join(' | '), webResults).catch(() => {});
      }
    }
  }

  // Комбинирај: DB резултати прво, потоа Serper
  const combined = [...dbResults, ...serperResults].slice(0, 8);

  console.log(`[v11] db:${dbResults.length} serper:${serperResults.length} cache:${fromCache} top:${combined[0]?.score || 0}`);

  return { results: combined, cachedAt, fromCache };
}

// ═══ SYSTEM PROMPT ═══

function buildSystemPrompt(lang, today, profile, webResults) {
  const L = LANG_NAMES[lang] || 'English';

  const profileText = profile.sector || profile.orgType || profile.country
    ? `\nOrganization: ${profile.orgType || 'not specified'}
Sector: ${profile.sector || 'not specified'}
Country: ${profile.country || 'not specified'}
Budget: ${profile.budget || 'not specified'}`
    : '\nProfile not set yet.';

  let webText = '';
  if (webResults.length > 0) {
    webText = '\n\nGRANT RESULTS (DB results first, then web — ranked by relevance):\n' +
      webResults.map((r, i) => {
        const src = r.source === 'db' ? '✅ DB' : '🌐 Web';
        return `[${i + 1}] ${src} SCORE:${r.score || '?'} | ${r.title}\n${r.snippet}\nURL: ${r.link}`;
      }).join('\n\n');
  }

  return `LANGUAGE: Respond ONLY in ${L}. Always match the user's language.

You are MARGINOVA — a global funding strategist.
Your mission: find unused money for this user — grants, funds, NGO programs, subsidies, fellowships — anywhere in the world, no geographic limits.

Today: ${today}

USER PROFILE:${profileText}

INSTRUCTIONS:
- ✅ DB results are verified grants from our database — PRIORITIZE THESE
- 🌐 Web results are from live search — use as supplement
- If profile is incomplete, ask ONE specific question
- Be direct and specific — no Wikipedia answers
- Format:

📋 [Program name]
💰 Amount range | Co-financing %
✅ Why you qualify: [specific reason]
⚠️ Main risk: [one obstacle]
🔗 [URL]

- End with ONE concrete action the user can take TODAY
- Never say "I cannot help" — always find something${webText}`;
}

// ═══════════════════════════════════════════
// GEMINI — со retry логика
// ═══════════════════════════════════════════

async function geminiCall(systemPrompt, messages, imageData, imageType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }]
  }));

  // File upload — додај слика/документ на последната порака
  if (imageData && imageType && contents.length > 0) {
    const last = contents[contents.length - 1];
    last.parts.push({
      inline_data: { mime_type: imageType, data: imageData }
    });
  }

  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Hello' }] });

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { maxOutputTokens: 4096, temperature: 0.65 }
  });

  const r = await ft(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  }, 30000);

  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

async function gemini(systemPrompt, messages, imageData, imageType) {
  // Retry 1 пат при failure
  try {
    return await geminiCall(systemPrompt, messages, imageData, imageType);
  } catch (e) {
    console.log('[GEMINI] retry after error:', e.message);
    await new Promise(r => setTimeout(r, 1500));
    try {
      return await geminiCall(systemPrompt, messages, imageData, imageType);
    } catch (e2) {
      throw new Error('Сервисот е momentalno недостапен. Обиди се повторно за момент.');
    }
  }
}

// ═══ MAIN HANDLER ═══

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

  // IP check — Supabase
  if (!(await checkIP(req))) {
    return res.status(429).json({ error: { message: 'Daily limit reached. Try again tomorrow.' } });
  }

  try {
    const body = req.body;
    const userId = body.userId || null;
    const userText = body.messages?.[body.messages.length - 1]?.content || '';
    const imageData = body.image || null;     // base64
    const imageType = body.imageType || null; // mime type

    if (userText.length > 2000) return res.status(400).json({ error: { message: 'Max 2000 chars.' } });

    if (userId && !(await checkQuota(userId))) {
      return res.status(429).json({ error: { message: 'Limit reached. Upgrade your plan.' }, quota_exceeded: true });
    }

    const lang = body.lang || detectLang(userText);
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const conversationText = (body.messages || []).map(m => m.content || '').join(' ');

    // Load profile
    const supaProfile = userId ? await loadProfile(userId) : null;
    const profile = detectProfile(conversationText, supaProfile);

    // Save detected profile async
    if (userId && (profile.sector || profile.orgType || profile.country)) {
      dbPatch('profiles?user_id=eq.' + userId, {
        detected_sector: profile.sector,
        detected_org_type: profile.orgType,
        detected_country: profile.country
      }).catch(() => {});
    }

    // Clean expired cache ~5%
    if (Math.random() < 0.05) cleanExpiredCache().catch(() => {});

    // Search: DB прво, Serper ако треба
    const shouldSearch = needsSearch(userText, conversationText) || !!imageData;
    let webResults = [];
    let cachedAt = null;
    let fromCache = false;

    if (shouldSearch && !imageData) {
      // Текстуално пребарување
      const searchData = await getSearchResults(userText, profile);
      webResults = searchData.results;
      cachedAt = searchData.cachedAt;
      fromCache = searchData.fromCache;
    }

    const messages = (body.messages || []).slice(-8).map(m => ({
      role: m.role,
      content: String(m.content || '')
    }));

    const systemPrompt = buildSystemPrompt(lang, today, profile, webResults);
    const text = await gemini(systemPrompt, messages, imageData, imageType);

    return res.status(200).json({
      content: [{ type: 'text', text }],
      intent: shouldSearch ? 'grant' : 'general',
      cached: fromCache,
      cached_at: cachedAt,
      db_results: webResults.filter(r => r.source === 'db').length,
      web_results: webResults.filter(r => r.source === 'serper').length
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
