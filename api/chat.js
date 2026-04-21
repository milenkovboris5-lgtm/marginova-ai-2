// ═══════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// VERSION: v9 — Smart Cache (Supabase cache + Serper on demand)
// ═══════════════════════════════════════════

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const SERPER_KEY = process.env.SERPER_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const DAILY_LIMIT = 200;
const PLANS = { free: 20, starter: 500, pro: 2000, business: -1 };
const CACHE_TTL_HOURS = 24;
const ipStore = {};

// ═══ HELPERS ═══

function ft(url, opts = {}, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

function checkIP(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const key = ip + '_' + new Date().toISOString().split('T')[0];
  const now = Date.now();
  for (const k in ipStore) if (ipStore[k].t < now) delete ipStore[k];
  if (!ipStore[key]) {
    const e = new Date(); e.setHours(23, 59, 59, 999);
    ipStore[key] = { n: 0, t: e.getTime() };
  }
  ipStore[key].n++;
  return ipStore[key].n <= DAILY_LIMIT;
}

// ═══ HASH ═══
function hashQuery(str) {
  const n = str.toLowerCase().trim().replace(/\s+/g, ' ');
  let h = 0;
  for (let i = 0; i < n.length; i++) { h = ((h << 5) - h) + n.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
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

// ═══ CACHE ═══

async function getCached(queryHash) {
  try {
    const now = new Date().toISOString();
    const rows = await dbGet(`search_cache?query_hash=eq.${queryHash}&expires_at=gt.${encodeURIComponent(now)}&select=results&limit=1`);
    if (rows && rows.length > 0) { console.log('[CACHE] HIT:', queryHash); return rows[0].results; }
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
    console.log('[CACHE] cleaned expired');
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
    return { ...p, sector: p.sector || p.detected_sector || null, organization_type: p.organization_type || p.detected_org_type || null, country: p.country || p.detected_country || null };
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
  if (/\b(jestem|jest|nie|dla)\b/.test(text)) return 'pl';
  if (/\b(bir|için|ile|bu|ve)\b/.test(text)) return 'tr';
  return 'en';
}

const LANG_NAMES = { mk:'Macedonian', sr:'Serbian', en:'English', de:'German', fr:'French', es:'Spanish', it:'Italian', pl:'Polish', tr:'Turkish' };

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

// ═══ SERPER ═══

async function serperSearch(query) {
  if (!SERPER_KEY) return [];
  try {
    const r = await ft('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 5 })
    }, 8000);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.organic || []).slice(0, 5).map(item => ({ title: item.title || '', snippet: item.snippet || '', link: item.link || '' }));
  } catch (e) { console.log('[SERPER]', e.message); return []; }
}

function buildSearchQueries(userText, profile) {
  const year = new Date().getFullYear();
  const sector = profile.sector || 'funding';
  const country = profile.country || '';
  const queries = [];
  const pm = userText.match(/\b(ipard|fitr|erasmus|horizon|interreg|civica|undp|usaid|giz|world bank|open society)\b/i);
  if (pm) queries.push(`${pm[0]} grant ${year} open call`);
  queries.push(`${sector} grant fund ${year} open call ${country}`.trim());
  queries.push(`${sector} funding ${year} global international grant`);
  return [...new Set(queries)].slice(0, 3);
}

// ═══ CACHED SEARCH ═══

async function getSearchResults(userText, profile) {
  if (!SERPER_KEY) return [];
  const queries = buildSearchQueries(userText, profile);
  const cacheKey = hashQuery(queries.join('|'));

  // 1. Провери cache прво
  const cached = await getCached(cacheKey);
  if (cached) {
    console.log('[SEARCH] from cache, Serper NOT called');
    return cached;
  }

  // 2. Cache miss → повикај Serper
  console.log('[SEARCH] cache miss, calling Serper:', queries.length, 'queries');
  const results = await Promise.all(queries.map(q => serperSearch(q)));
  let webResults = results.flat().filter(r => r.title && r.link);

  const seen = new Set();
  webResults = webResults.filter(r => {
    if (seen.has(r.link)) return false;
    seen.add(r.link); return true;
  }).slice(0, 10);

  // 3. Зачувај во cache
  if (webResults.length > 0) {
    saveCache(cacheKey, queries.join(' | '), webResults).catch(() => {});
  }

  return webResults;
}

// ═══ SYSTEM PROMPT ═══

function buildSystemPrompt(lang, today, profile, webResults) {
  const L = LANG_NAMES[lang] || 'English';
  const profileText = profile.sector || profile.orgType || profile.country
    ? `\nOrganization: ${profile.orgType || 'not specified'}\nSector: ${profile.sector || 'not specified'}\nCountry: ${profile.country || 'not specified'}\nBudget: ${profile.budget || 'not specified'}`
    : '\nProfile not set yet.';

  let webText = '';
  if (webResults.length > 0) {
    webText = '\n\nLIVE SEARCH RESULTS:\n' + webResults.map((r, i) => `[${i+1}] ${r.title}\n${r.snippet}\nURL: ${r.link}`).join('\n\n');
  }

  return `LANGUAGE: Respond ONLY in ${L}. Always match the user's language.

You are MARGINOVA — a global funding strategist.
Your mission: find unused money for this user — grants, funds, NGO programs, subsidies, fellowships — anywhere in the world, no geographic limits.

Today: ${today}

USER PROFILE:${profileText}

INSTRUCTIONS:
- If profile is incomplete, ask ONE specific question
- Be direct and specific — no Wikipedia answers
- Format for recommendations:

📋 [Program name]
💰 Amount range | Co-financing %
✅ Why you qualify: [specific reason]
⚠️ Main risk: [one obstacle]
🔗 [URL]

- End every response with ONE concrete action the user can take TODAY
- Never say "I cannot help" — always find something${webText}`;
}

// ═══ GEMINI ═══

async function gemini(systemPrompt, messages) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] }));
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
  const r = await ft(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt }] }, contents, generationConfig: { maxOutputTokens: 4096, temperature: 0.65 } })
  }, 30000);
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
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

  if (!checkIP(req)) return res.status(429).json({ error: { message: 'Daily limit reached.' } });
  if (!GEMINI_KEY) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY.' } });

  try {
    const body = req.body;
    const userId = body.userId || null;
    const userText = body.messages?.[body.messages.length - 1]?.content || '';

    if (userText.length > 2000) return res.status(400).json({ error: { message: 'Max 2000 chars.' } });
    if (userId && !(await checkQuota(userId))) {
      return res.status(429).json({ error: { message: 'Limit reached. Upgrade.' }, quota_exceeded: true });
    }

    const lang = body.lang || detectLang(userText);
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
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

    // Чисти expired cache на секои ~20 барања
    if (Math.random() < 0.05) cleanExpiredCache().catch(() => {});

    const shouldSearch = needsSearch(userText, conversationText);
    let webResults = [];
    if (shouldSearch) {
      webResults = await getSearchResults(userText, profile);
    }

    console.log(`[v9] lang:${lang} search:${shouldSearch} results:${webResults.length} user:${userId?.slice(0,8)||'anon'}`);

    const messages = (body.messages || []).slice(-8).map(m => ({ role: m.role, content: String(m.content || '') }));
    const systemPrompt = buildSystemPrompt(lang, today, profile, webResults);
    const text = await gemini(systemPrompt, messages);

    return res.status(200).json({
      content: [{ type: 'text', text }],
      intent: shouldSearch ? 'grant' : 'general'
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
