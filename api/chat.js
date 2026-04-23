// ═══════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// VERSION: v15 — DB Match vs Web Relevance separated
// Global scope, English comments, DB-first search
// ═══════════════════════════════════════════

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const SERPER_KEY = process.env.SERPER_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// Anon key — public, safe to hardcode, used for grants public read
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpZGFsdmVldHdrY3Jqa3Z6YnNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4MjA2OTgsImV4cCI6MjA4OTM5NjY5OH0.PwvEZzVuzTqS9wtAQYqmCbYMc_H7ZuTCaI5OixWHF7M';

const DAILY_LIMIT = 200;
const PLANS = { free: 20, starter: 500, pro: 2000, business: -1 };
const CACHE_TTL_HOURS = 24;
const MIN_DB_RESULTS = 3;

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

  try {
    const rows = await dbGet(`ip_limits?ip=eq.${encodeURIComponent(ip)}&select=count,reset_date`);
    const row = rows?.[0];

    if (!row || row.reset_date !== today) {
      await ft(`${SUPA_URL}/rest/v1/ip_limits`, {
        method: 'POST',
        headers: {
          apikey: SUPA_KEY,
          Authorization: `Bearer ${SUPA_KEY}`,
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

// ═══ GRANTS DATABASE SEARCH — DB first, Serper as fallback ═══

async function searchGrantsDB(profile) {
  try {
    const query = 'grants?active=eq.true&select=name,funder,sector,country,min_amount,max_amount,co_finance_percent,deadline,eligibility,portal_url&limit=50';
    const today = new Date().toISOString().split('T')[0];

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

    const rows = allRows.filter(g => !g.deadline || g.deadline >= today);
    if (rows.length === 0) return [];

    const scored = rows.map(g => {
      let score = 0;
      const sectorArr = Array.isArray(g.sector) ? g.sector.map(s => String(s).toLowerCase()) : [];
      const countryArr = Array.isArray(g.country) ? g.country : [];

      if (profile.sector) {
        const ps = profile.sector.toLowerCase();
        if (sectorArr.some(s => s.includes(ps) || ps.includes(s))) score += 40;
      }

      if (profile.country) {
        const pc = profile.country.toLowerCase();
        if (
          countryArr.length === 0 ||
          countryArr.some(c =>
            String(c).toLowerCase().includes(pc) ||
            String(c).toLowerCase().includes('western balkans') ||
            String(c).toLowerCase().includes('global')
          )
        ) {
          score += 30;
        }
      }

      if (profile.budget && g.min_amount != null && g.max_amount != null) {
        const budgetRanges = {
          'up to €30k': [0, 30000],
          '€30k–€150k': [30000, 150000],
          '€150k–€500k': [150000, 500000],
          'above €500k': [500000, Infinity]
        };
        const [minB, maxB] = budgetRanges[profile.budget] || [0, Infinity];
        if (g.max_amount >= minB && g.min_amount <= maxB) score += 20;
      }

      if (profile.orgType && g.eligibility) {
        const eli = String(g.eligibility).toLowerCase();
        const orgMap = {
          'NGO / Association': ['ngo', 'nonprofit', 'association', 'civil society', 'foundation'],
          'Startup': ['startup', 'early stage', 'seed'],
          'Agricultural holding': ['farmer', 'agricultural', 'holding', 'ipard'],
          'SME': ['sme', 'enterprise', 'company', 'business'],
          'Municipality / Public body': ['municipality', 'local government', 'public body', 'public institution'],
          'University / Research': ['university', 'research', 'academic', 'institute'],
          'Individual / Entrepreneur': ['individual', 'entrepreneur', 'freelance', 'self-employed'],
        };
        const kws = orgMap[profile.orgType] || [];
        if (kws.some(kw => eli.includes(kw))) score += 10;
      }

      return {
        ...g,
        score: Math.max(0, Math.min(100, score)),
        score_type: 'match',
        source: 'db',
        title: g.name,
        snippet: [
          g.funder,
          g.min_amount ? `€${Number(g.min_amount).toLocaleString()} – €${g.max_amount != null ? Number(g.max_amount).toLocaleString() : '?'}` : null,
          g.co_finance_percent ? `Co-financing: ${g.co_finance_percent}%` : null,
          g.eligibility
        ].filter(Boolean).join(' | '),
        link: g.portal_url || ''
      };
    });

    const ranked = scored.sort((a, b) => b.score - a.score).slice(0, 6);
    console.log('[DB SEARCH] matched:', ranked.length, 'top score:', ranked[0]?.score ?? 0);
    return ranked;
  } catch (e) {
    console.log('[DB SEARCH] error:', e.message);
    return [];
  }
}

// ═══ RELEVANCE SCORING — for Serper web results ═══

function scoreResult(result, profile) {
  const text = `${result.title} ${result.snippet}`.toLowerCase();
  let score = 0;

  const sectorKeywords = {
    'Agriculture': ['agri', 'farm', 'rural', 'ipard', 'crop', 'food'],
    'IT / Technology': ['tech', 'digital', 'software', 'startup', 'innovation', 'ai', 'ict'],
    'Civil Society': ['ngo', 'civil society', 'nonprofit', 'community', 'association'],
    'Education': ['education', 'youth', 'school', 'erasmus', 'learning', 'training'],
    'Environment / Energy': ['environment', 'climate', 'green', 'energy', 'renewable', 'solar'],
    'Health / Social': ['health', 'social', 'welfare', 'care', 'medical'],
    'Research / Innovation': ['research', 'innovation', 'university', 'horizon', 'science'],
    'SME / Business': ['sme', 'business', 'enterprise', 'company', 'entrepreneur'],
    'Tourism / Culture': ['tourism', 'culture', 'heritage', 'creative', 'art'],
  };

  if (profile.sector && sectorKeywords[profile.sector]) {
    const hits = sectorKeywords[profile.sector].filter(kw => text.includes(kw));
    if (hits.length > 0) score += Math.min(25, hits.length * 10);
  }

  const countryKeywords = {
    'North Macedonia': ['macedonia', 'makedon', 'mkd', 'western balkans', 'balkans', 'ipa'],
    'Serbia': ['serbia', 'srbija', 'western balkans', 'balkans'],
    'Croatia': ['croatia', 'hrvatska', 'western balkans'],
    'Bosnia': ['bosnia', 'western balkans', 'balkans'],
    'Bulgaria': ['bulgaria', 'bulgar'],
    'Albania': ['albania'],
    'Kosovo': ['kosovo'],
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

  if (/closed|expired|deadline passed/i.test(text)) score -= 50;
  if (/2022|2023/i.test(text)) score -= 30;
  if (/login required|subscription|paywall/i.test(text)) score -= 15;

  return Math.max(0, Math.min(75, score));
}

function rankResults(results, profile, topN = 6) {
  return results
    .map(r => ({
      ...r,
      score: scoreResult(r, profile),
      score_type: 'relevance'
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
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

// ═══ SERPER SEARCH — Targeted queries ═══

function buildSearchQueries(userText, profile) {
  const year = new Date().getFullYear();
  const sector = profile.sector || 'funding';
  const country = profile.country || 'Western Balkans';
  const queries = [];

  const pm = userText.match(/\b(ipard|fitr|erasmus|horizon|interreg|civica|undp|usaid|giz|world bank|open society|eu4business|eidhr|wbif|ryco)\b/i);
  if (pm) queries.push(`${pm[0]} open call ${year} apply`);

  if (profile.country === 'North Macedonia') {
    queries.push(`${sector} grant ${year} North Macedonia open call apply`);
  } else {
    queries.push(`${sector} grant ${year} "${country}" open call`);
  }

  queries.push(`${sector} ${profile.orgType || ''} grant ${year} open call apply now`.trim());

  return [...new Set(queries)].slice(0, 3);
}

async function serperSearch(query) {
  if (!SERPER_KEY) return [];
  try {
    const r = await ft('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_KEY,
        'Content-Type': 'application/json'
      },
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
  } catch (e) {
    console.log('[SERPER]', e.message);
    return [];
  }
}

// ═══ MAIN SEARCH LOGIC — DB first, Serper as fallback ═══

async function getSearchResults(userText, profile) {
  let serperResults = [];
  let cachedAt = null;
  let fromCache = false;

  const dbResults = await searchGrantsDB(profile);

  if (dbResults.length < MIN_DB_RESULTS && SERPER_KEY) {
    const queries = buildSearchQueries(userText, profile);
    const cacheKey = hashQuery(queries.join('|'));

    const cached = await getCached(cacheKey);
    if (cached) {
      serperResults = rankResults(cached.results, profile);
      cachedAt = cached.created_at;
      fromCache = true;
    } else {
      const raw = await Promise.all(queries.map(q => serperSearch(q)));
      let webResults = raw.flat().filter(r => r.title && r.link);

      const seen = new Set();
      webResults = webResults.filter(r => {
        if (seen.has(r.link)) return false;
        seen.add(r.link);
        return true;
      });

      serperResults = rankResults(webResults, profile);
      if (webResults.length > 0) {
        saveCache(cacheKey, queries.join(' | '), webResults).catch(() => {});
      }
    }
  }

  const combined = [...dbResults, ...serperResults].slice(0, 8);
  console.log(`[v15] db:${dbResults.length} serper:${serperResults.length} cache:${fromCache} top:${combined[0]?.score || 0}`);
  return { results: combined, cachedAt, fromCache };
}

// ═══ SYSTEM PROMPT ═══

function buildSystemPrompt(lang, today, profile, webResults) {
  const L = LANG_NAMES[lang] || 'English';

  const profileText = profile.sector || profile.orgType || profile.country
    ? `\nOrganization type: ${profile.orgType || 'not specified'}
Sector: ${profile.sector || 'not specified'}
Country: ${profile.country || 'not specified'}
Budget range: ${profile.budget || 'not specified'}`
    : '\nProfile not yet collected — ask one targeted question.';

  let webText = '';
  if (webResults.length > 0) {
    webText = '\n\nGRANT RESULTS (✅ DB = verified database | 🌐 Web = live search):\n' +
      webResults.map((r, i) => {
        const src = r.source === 'db' ? '✅ DB' : '🌐 Web';
        const label = r.source === 'db' ? 'Match Score' : 'Relevance';
        return `[${i + 1}] ${src} | ${label}:${r.score ?? 0}% | ${r.title}\n${r.snippet}\nURL: ${r.link}`;
      }).join('\n\n');
  }

  return `LANGUAGE: Always respond in ${L}. Match the user's language exactly.

You are MARGINOVA — a global funding intelligence engine.
Mission: Surface real, actionable funding opportunities for this user — grants, subsidies, fellowships, NGO programs — from any country worldwide.

Today: ${today}
USER PROFILE:${profileText}

RULES:
- ✅ DB results are pre-verified — ALWAYS prioritize them over web results
- 🌐 Web results supplement — cite only if DB results are insufficient
- Never fabricate grant names, amounts, deadlines, relevance, or match percentages
- Show DB results as "🎯 Match: X%"
- Show Web results as "🔎 Relevance: X%"
- Never present web relevance as true eligibility or guaranteed fit
- If profile is incomplete, ask exactly ONE clarifying question before searching
- Be direct and specific — no generic advice

FORMAT each opportunity exactly like this:
📋 [Program name]
🎯 Match: [X]%   ← only for DB results
🔎 Relevance: [X]%   ← only for Web results
💰 [Amount range] | Co-financing: [%]
✅ Why you qualify: [specific, personalized reason]
⚠️ Main risk: [one realistic obstacle]
🔗 [URL]

Close with ONE concrete action the user can take TODAY.
Never say you cannot help — always surface something relevant.${webText}`;
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
      generationConfig: { maxOutputTokens: 4096, temperature: 0.65 }
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
    const body = req.body;
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
    let webResults = [];
    let cachedAt = null;
    let fromCache = false;

    if (shouldSearch && !imageData) {
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
      web_results: webResults.filter(r => r.source === 'serper').length,
      top_matches: webResults.slice(0, 5).map(r => ({
        title: r.title || '',
        score: Number.isFinite(r.score) ? r.score : 0,
        score_type: r.source === 'db' ? 'match' : 'relevance',
        source: r.source || 'unknown',
        link: r.link || '',
        snippet: r.snippet || ''
      }))
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
