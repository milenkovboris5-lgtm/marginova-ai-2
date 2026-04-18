// ═══════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// BRAIN v2 — Serper + TED API + Grounding + Gemini
// SCAN → ANALYZE → EXECUTE
// ═══════════════════════════════════════════

const DAILY_LIMIT = 200;
const rateLimitStore = {};

// ═══ RATE LIMIT ═══
function getRateLimitKey(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip'] || 'unknown';
  const today = new Date().toISOString().split('T')[0];
  return ip + '_' + today;
}

function checkRateLimit(req) {
  const key = getRateLimitKey(req);
  const now = Date.now();
  for (const k in rateLimitStore) {
    if (rateLimitStore[k].resetAt < now) delete rateLimitStore[k];
  }
  if (!rateLimitStore[key]) {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    rateLimitStore[key] = { count: 0, resetAt: end.getTime() };
  }
  rateLimitStore[key].count += 1;
  return {
    allowed: rateLimitStore[key].count <= DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - rateLimitStore[key].count)
  };
}

// ═══ FETCH WITH TIMEOUT ═══
function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ═══ SUPABASE ═══
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabaseRequest(path, options = {}) {
  return fetchWithTimeout(
    `${SUPA_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
        ...(options.headers || {})
      }
    },
    5000
  );
}

// ═══ USER QUOTA ═══
const PLAN_LIMITS = { free: 20, starter: 500, pro: 2000, business: -1 };

async function checkUserQuota(userId) {
  if (!SUPA_URL || !SUPA_KEY || !userId) return { allowed: true, remaining: 999 };
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await supabaseRequest(
      `profiles?user_id=eq.${userId}&select=plan,daily_msgs,last_msg_date`,
      { headers: { Prefer: '' } }
    );
    if (!res.ok) return { allowed: true, remaining: 999 };
    const rows = await res.json();
    const profile = rows?.[0];
    if (!profile) return { allowed: true, remaining: 20 };
    const plan = profile.plan || 'free';
    const limit = PLAN_LIMITS[plan] ?? 20;
    if (limit === -1) return { allowed: true, remaining: -1 };
    const used = profile.last_msg_date === today ? (profile.daily_msgs || 0) : 0;
    return { allowed: Math.max(0, limit - used) > 0, remaining: Math.max(0, limit - used), plan, used };
  } catch (e) {
    return { allowed: true, remaining: 999 };
  }
}

async function incrementUserQuota(userId) {
  if (!SUPA_URL || !SUPA_KEY || !userId) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await supabaseRequest(
      `profiles?user_id=eq.${userId}&select=daily_msgs,last_msg_date`,
      { headers: { Prefer: '' } }
    );
    if (!res.ok) return;
    const rows = await res.json();
    const profile = rows?.[0];
    const currentUsed = profile?.last_msg_date === today ? (profile?.daily_msgs || 0) : 0;
    await supabaseRequest(`profiles?user_id=eq.${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ daily_msgs: currentUsed + 1, last_msg_date: today })
    });
  } catch (e) {}
}

// ═══ MEMORY ═══
async function generateSummary(messages, apiKey) {
  try {
    const text = messages.map(m => `${m.role}: ${m.message}`).join('\n');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `Summarize in 3 sentences. Keep: decisions, numbers, deadlines, agreements.\n\n${text.slice(0, 3000)}` }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.1 }
      })
    }, 8000);
    if (!res.ok) return null;
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (e) { return null; }
}

async function loadMemory(userId, avatar, apiKey) {
  if (!SUPA_URL || !SUPA_KEY || !userId) return { summary: null, recent: [] };
  try {
    const res = await supabaseRequest(
      `conversations?user_id=eq.${userId}&avatar=eq.${avatar}&order=created_at.desc&limit=30`,
      { headers: { Prefer: '' } }
    );
    if (!res.ok) return { summary: null, recent: [] };
    const rows = await res.json();
    if (!rows || rows.length === 0) return { summary: null, recent: [] };
    const recent = rows.slice(0, 6).reverse().map(r => ({
      role: r.role === 'assistant' ? 'assistant' : 'user',
      content: r.message
    }));
    let summary = null;
    if (rows.length > 6) {
      const older = rows.slice(6).reverse();
      const sumText = await generateSummary(older, apiKey);
      summary = sumText
        ? `Previous context: ${sumText}`
        : `Previous: ${older.map(r => `${r.role}: ${r.message}`).join(' ').slice(0, 400)}`;
    }
    return { summary, recent };
  } catch (e) { return { summary: null, recent: [] }; }
}

async function saveMemory(userId, avatar, role, message) {
  if (!SUPA_URL || !SUPA_KEY || !userId) return;
  try {
    await supabaseRequest('conversations', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId, avatar, role,
        message: message.slice(0, 2000),
        created_at: new Date().toISOString()
      })
    });
  } catch (e) {}
}

// ═══ DETECT LANGUAGE ═══
function detectLang(text) {
  if (/ќ|ѓ|ѕ|љ|њ|џ/i.test(text)) return 'mk';
  if (/ћ|ђ/i.test(text)) return 'sr';
  if (/[а-шА-Ш]/.test(text)) return 'mk';
  if (/\b(und|oder|ist|ich|sie|wir|nicht)\b/.test(text)) return 'de';
  if (/\b(jest|są|się|nie|dla)\b/.test(text)) return 'pl';
  if (/\b(ve|bir|bu|için|ile)\b/.test(text)) return 'tr';
  if (/\b(dhe|është|për|nga)\b/.test(text)) return 'sq';
  if (/\b(sam|smo|ste|su|ili)\b/.test(text)) return 'sr';
  return 'en';
}

// ═══ INTENT DETECTION ═══
const INTENT_PATTERNS = {
  tender: ['тендер','набавка','оглас','конкурс','јавна набавка','licitaci',
    'tender','nabavka','oglas','javna nabavka','procurement','ausschreibung','ihale','przetarg','appalto'],
  grant: ['грант','фонд','ipard','ipa','финансирање','финансиска','финансир',
    'grant','grand','grantovi','fond','fondovi','finansiranje','finansiska','subsidy',
    'förderung','hibe','dotacja','subvencija','horizon','erasmus','undp','usaid','wbif','fitr',
    'startup','стартап','повик','povikot','аплицира','aplicira'],
  legal: ['договор','право','gdpr','закон','трудово','даноци','правни',
    'ugovor','pravo','zakon','radno','porezi','pravni','contract','legal','recht','gesetz',
    'licenca','dozvola','registracija','osnivanje','statut'],
  analysis: ['анализа','споредба','swot','извештај','analiza','swot','izvestaj','analysis'],
  business: ['бизнис','стратегија','план','раст','biznis','strategija','plan','rast','business']
};

function classifyIntent(text) {
  const lower = text.toLowerCase();
  const scores = {};
  for (const [intent, keywords] of Object.entries(INTENT_PATTERNS)) {
    scores[intent] = keywords.filter(k => lower.includes(k)).length;
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const second = sorted[1];
  if (top[1] >= 2) return { intent: top[0], confident: true };
  if (top[1] === 1 && second[1] === 0) return { intent: top[0], confident: true };
  return { intent: 'business', confident: false };
}

async function classifyWithLLM(text, apiKey) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `Classify into ONE word: tender, grant, legal, analysis, business.\nQuery: "${text}"\nReturn ONLY one word.` }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 10 }
      })
    }, 5000);
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase() || 'business';
    return ['tender','grant','legal','analysis','business'].includes(raw) ? raw : 'business';
  } catch (e) { return 'business'; }
}

// ═══ EXTRACT KEYWORDS ═══
function extractKeywords(text) {
  const stopWords = new Set([
    'и','или','на','во','за','од','со','до','по','при','над','дека','дали','ми','си','ги','го',
    'the','and','or','for','in','of','to','a','an','is','are','was','were','be','been',
    'i','ili','za','od','sa','da','je','su','se','na','u','o','po','mozes','imam','treba',
    'und','oder','für','von','zu','die','der','das','можеш','барам','сакам','имам'
  ]);
  return text.toLowerCase()
    .replace(/[^\w\s\u0400-\u04FF]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 5)
    .join(' ');
}

// ═══ DETECT COUNTRY/REGION ═══
function detectCountry(text) {
  const lower = text.toLowerCase();
  const map = {
    'македон|makedon': 'mk',
    'србиј|srbij': 'rs',
    'хрват|hrvat': 'hr',
    'босн|bosn': 'ba',
    'бугар|bulgar': 'bg',
    'романиј|roman': 'ro',
    'грциј|greec|grci': 'gr',
    'турциј|turk': 'tr',
    'германиј|german|deutsch': 'de',
    'франциј|franc': 'fr',
    'шпаниј|spain|spanij': 'es',
    'европ|europ|\\beu\\b': 'eu',
  };
  for (const [pattern, code] of Object.entries(map)) {
    if (new RegExp(pattern).test(lower)) return code;
  }
  return 'mk'; // default
}

// ═══ BRAIN STEP 1: SCAN — Serper ═══
async function scanSerper(query, serperKey, country = 'mk') {
  if (!query || !serperKey) return [];
  try {
    const gl = ['mk','rs','hr','ba','bg','ro','gr','tr','de','fr','es'].includes(country) ? country : 'mk';
    const res = await fetchWithTimeout('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey },
      body: JSON.stringify({ q: query, num: 5, gl }),
    }, 8000);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.organic || []).slice(0, 3).map(r => ({
      title: r.title || '',
      snippet: r.snippet || '',
      link: r.link || '',
      date: r.date || ''
    }));
  } catch (e) {
    console.warn('Serper error:', e.message);
    return [];
  }
}

// ═══ BRAIN STEP 1b: SCAN — TED API ═══
async function scanTED(keywords, country = '') {
  try {
    const scope = country && country !== 'mk' ? `&scope=EU` : `&scope=EU`;
    const url = `https://ted.europa.eu/api/v3.0/notices/search?fields=ND,TI,DT,TD,CY&q=${encodeURIComponent(keywords)}&limit=3${scope}`;
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    }, 8000);
    if (!res.ok) return [];
    const data = await res.json();
    const notices = data?.notices || data?.results || [];
    return notices.slice(0, 3).map(n => ({
      title: n.TI?.text || n.title || 'EU Tender',
      snippet: n.TD?.text || '',
      link: `https://ted.europa.eu/udl?uri=TED:NOTICE:${n.ND}:TEXT:EN:HTML`,
      date: n.DT || '',
      country: n.CY?.text || 'EU'
    }));
  } catch (e) {
    console.warn('TED error:', e.message);
    return [];
  }
}

// ═══ BUILD SEARCH QUERIES ═══
function buildQueries(userText, intent, country) {
  const kw = extractKeywords(userText);
  const queries = [];

  if (intent === 'tender' || intent === 'business') {
    const siteMap = {
      mk: 'site:e-nabavki.gov.mk OR site:pazar3.mk',
      rs: 'site:portal.ujn.gov.rs OR site:halo.rs',
      hr: 'site:eojn.nn.hr OR site:njuskalo.hr',
      ba: 'site:ejn.ba',
      bg: 'site:app.eop.bg',
      ro: 'site:e-licitatie.ro',
      gr: 'site:promitheus.gov.gr',
      tr: 'site:ekap.kik.gov.tr',
      de: 'site:ted.europa.eu',
      fr: 'site:ted.europa.eu OR site:boamp.fr',
      es: 'site:contrataciondelestado.es',
      eu: 'site:ted.europa.eu',
    };
    const site = siteMap[country] || siteMap.mk;
    queries.push({ q: `${kw} tender nabavka licitacija ${site}`, type: 'serper', intent });
  }

  if (intent === 'grant') {
    const sectorMap = {
      'it|tech|software|дигитал': 'IT digital',
      'gradez|construction|градеж': 'construction',
      'zemjodelst|agri|земјоделст': 'agriculture',
      'turiz|tourism|туриз': 'tourism',
      'energi|energy|енерги': 'energy',
      'startup|стартап': 'startup innovation',
      'mladi|youth|млади': 'youth',
    };
    let sector = 'business';
    const lower = userText.toLowerCase();
    for (const [pattern, val] of Object.entries(sectorMap)) {
      if (new RegExp(pattern).test(lower)) { sector = val; break; }
    }
    const grantSiteMap = {
      mk: 'site:fitr.mk OR site:ipard.gov.mk OR site:mk.undp.org OR site:westernbalkansfund.org',
      rs: 'site:inovacionifond.rs OR site:apr.gov.rs',
      de: 'site:foerderdatenbank.de OR site:bmbf.de',
      fr: 'site:bpifrance.fr',
      eu: 'site:ec.europa.eu OR site:interreg.eu',
    };
    const grantSite = grantSiteMap[country] || grantSiteMap.mk;
    queries.push({ q: `${sector} grant funding 2025 ${grantSite}`, type: 'serper', intent: 'grant' });
    // TED за EU грантови
    if (['eu','de','fr','es','hr','bg','ro'].includes(country)) {
      queries.push({ q: `${sector} ${kw}`, type: 'ted' });
    }
  }

  // Секогаш додај TED за тендери ако е EU регион
  if (intent === 'tender' && ['eu','de','fr','es','hr','bg','ro','gr'].includes(country)) {
    queries.push({ q: `${kw}`, type: 'ted' });
  }

  return queries;
}

// ═══ BRAIN STEP 2: ANALYZE (Gemini) ═══
async function analyzeOpportunities(opportunities, userText, lang, apiKey) {
  if (!opportunities || opportunities.length === 0) return null;
  try {
    const langNames = { mk:'македонски', sr:'српски', en:'English', de:'Deutsch', hr:'хрватски', bs:'босански' };
    const langName = langNames[lang] || 'English';
    const opText = opportunities.map((o, i) =>
      `${i+1}. ${o.title}\n   ${o.snippet}\n   Link: ${o.link}\n   Date: ${o.date || 'unknown'}`
    ).join('\n\n');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: `You are a business analyst. User needs: "${userText}"

Analyze these opportunities and keep ONLY the best 1-2:
${opText}

For each kept opportunity, calculate in ${langName}:
- Is it relevant? (yes/no + why in 1 sentence)
- Estimated value/contract size (€ range based on sector norms)
- Time to first action (days)
- Main risk (1 sentence)

Kill irrelevant ones. Be brutal. Output only the winners with numbers.` }]
        }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.3 }
      })
    }, 10000);
    if (!res.ok) return null;
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (e) {
    console.warn('Analyze error:', e.message);
    return null;
  }
}

// ═══ REGION LABEL ═══
function detectRegionFromLink(link) {
  if (!link) return '';
  if (link.includes('e-nabavki.gov.mk') || link.includes('pazar3.mk') || link.includes('.mk')) return 'Македонија';
  if (link.includes('portal.ujn.gov.rs') || link.includes('halo.rs') || link.includes('.rs')) return 'Србија';
  if (link.includes('eojn.nn.hr') || link.includes('.hr')) return 'Хрватска';
  if (link.includes('ejn.ba') || link.includes('.ba')) return 'БиХ';
  if (link.includes('app.eop.bg')) return 'Бугарија';
  if (link.includes('e-licitatie.ro')) return 'Романија';
  if (link.includes('promitheus.gov.gr')) return 'Грција';
  if (link.includes('ekap.kik.gov.tr')) return 'Турција';
  if (link.includes('ted.europa.eu') || link.includes('ec.europa.eu')) return 'ЕУ';
  if (link.includes('foerderdatenbank.de') || link.includes('bmbf.de')) return 'Германија';
  if (link.includes('contrataciondelestado.es')) return 'Шпанија';
  if (link.includes('bpifrance.fr')) return 'Франција';
  return '';
}

// ═══ FORMAT RAW RESULTS ═══
function formatRawResults(results) {
  if (!results || results.length === 0) return '';
  const today = new Date().toLocaleDateString('mk-MK', { day:'2-digit', month:'2-digit', year:'numeric' });
  let ctx = `\n\n═══ LIVE SCAN RESULTS — ${today} ═══\n`;
  ctx += `Use ONLY these real results. Do NOT invent links or data.\n\n`;
  results.forEach((r, i) => {
    const region = r.country || detectRegionFromLink(r.link);
    ctx += `${i+1}. **${r.title}**\n`;
    if (region) ctx += `   🌍 ${region}\n`;
    if (r.date) ctx += `   📅 ${r.date}\n`;
    if (r.snippet) ctx += `   ${r.snippet.slice(0, 150)}\n`;
    ctx += `   🔗 ${r.link}\n\n`;
  });
  ctx += `═══ END SCAN ═══\n`;
  return ctx;
}

// ═══ BUILD FINAL SYSTEM PROMPT ═══
function buildSystemPrompt(lang, today, scanResults, analysis) {
  const langNames = {
    mk:'македонски', sr:'српски', hr:'хрватски', bs:'босански',
    en:'English', de:'Deutsch', sq:'shqip', bg:'български', tr:'Türkçe', pl:'polski'
  };
  const langName = langNames[lang] || 'English';

  let prompt = `You are MARGINOVA — Autonomous Business Money Engine.
Mission: find money, validate fast, execute.

LANGUAGE: Respond EXCLUSIVELY in ${langName}. Absolute. No exceptions.
Today: ${today}

## OUTPUT FORMAT — ALWAYS USE THIS STRUCTURE:

[OPPORTUNITY] What exactly, where, for whom
[NUMBERS] Cost €, revenue €, margin %, time to cash
[ACTION] 3 concrete steps with links/contacts
[RISK] Main risk in 1 sentence

## RULES — NON-NEGOTIABLE:
- Numbers first. Always. (€, %, days)
- NO theory. NO strategy talk. NO explanations of your limitations.
- Fastest path to cash, always.
- If data is missing → say "No live data" in ONE word, then give best alternative action
- NEVER hallucinate links, companies, prices, program names
- NEVER apologize. NEVER explain why you can't do something.
- NEVER say "I understand" or "My goal is" or "As a COO"
- Ask ONE question max if truly unclear
- Maximum 200 words total

## LIVE SEARCH SYSTEM:
Results are pre-loaded below. Present them directly.
If no results → state "0 live results" + give ONE concrete offline action.`;

  if (scanResults && scanResults.length > 0) {
    prompt += formatRawResults(scanResults);
  }

  if (analysis) {
    prompt += `\n\n═══ ANALYSIS ═══\n${analysis}\n═══ END ANALYSIS ═══\n`;
    prompt += `\nUse the analysis above to present the BEST opportunity with exact numbers and 3 action steps.`;
  } else if (scanResults && scanResults.length > 0) {
    prompt += `\nPresent the best result above with [OPPORTUNITY][NUMBERS][ACTION][RISK] format.`;
  } else {
    prompt += `\n\n═══ NO LIVE RESULTS ═══
ZERO results from all search sources.
DO NOT invent data. DO NOT list portals.
Give ONE concrete offline action specific to their sector.
═══`;
  }

  return prompt;
}

// ═══ GEMINI FINAL CALL ═══
async function callGemini(systemPrompt, messages, hasImage, imageData, imageType, imageText, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }]
  }));

  if (hasImage && imageData) {
    contents.pop();
    contents.push({
      role: 'user',
      parts: [
        { inline_data: { mime_type: imageType || 'image/jpeg', data: imageData } },
        { text: imageText || 'Analyze this document.' }
      ]
    });
  }

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: 'Start.' }] }],
    generationConfig: { maxOutputTokens: 600, temperature: 0.7 }
  };

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 25000);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
}

// ═══ MAIN HANDLER ═══
module.exports = async function handler(req, res) {
  const ALLOWED_ORIGINS = [
    'https://marginova.tech',
    'https://www.marginova.tech',
    'http://localhost:3000',
  ];
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : 'https://marginova.tech';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method Not Allowed' } });

  const limit = checkRateLimit(req);
  if (!limit.allowed) return res.status(429).json({ error: { message: 'Daily limit reached.' } });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY' } });
  const serperKey = process.env.SERPER_API_KEY;

  try {
    const body = req.body;
    const hasImage = !!body.image;
    const userId = body.userId || null;
    const avatar = 'cooai';

    const rawText = body.messages?.[body.messages.length - 1]?.content || '';
    if (rawText.length > 2000) return res.status(400).json({ error: { message: 'Message too long. Max 2000 chars.' } });
    if (!userId && limit.remaining < DAILY_LIMIT - 10) return res.status(429).json({ error: { message: 'Registration required.' } });

    if (userId) {
      const quota = await checkUserQuota(userId);
      if (!quota.allowed) return res.status(429).json({
        error: { message: 'Daily limit reached. Upgrade plan.' },
        quota_exceeded: true
      });
      console.log(`[Quota] plan:${quota.plan} | remaining:${quota.remaining}`);
    }

    const today = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric' });
    const memory = await loadMemory(userId, avatar, apiKey);

    const frontendMessages = (body.messages || []).slice(-4).map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content || '')
    }));
    const memoryContents = memory.recent.map(m => m.content);
    const newMessages = frontendMessages.filter(m => !memoryContents.includes(m.content));
    const messages = [...memory.recent, ...newMessages];

    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const userText = lastUserMsg?.content || '';
    const lang = body.lang || detectLang(userText);

    // Intent + Country
    const keywordResult = classifyIntent(userText);
    const intent = keywordResult.confident
      ? keywordResult.intent
      : await classifyWithLLM(userText, apiKey);
    const country = detectCountry(userText);

    console.log(`[BRAIN] lang:${lang} | intent:${intent} | country:${country} | text:${userText.slice(0, 60)}`);

    // ═══ BRAIN STEP 1: SCAN ═══
    const needsScan = ['tender','grant','business'].includes(intent) ||
      ['tender','grant','nabavka','oglas','licitaci','fond','grant','startup','ponuda'].some(k => userText.toLowerCase().includes(k));

    let allResults = [];

    if (needsScan && serperKey) {
      const queries = buildQueries(userText, intent, country);
      console.log(`[BRAIN] Queries: ${JSON.stringify(queries.map(q => q.type + ':' + q.q.slice(0,50)))}`);

      // Паралелно скенирање
      const scanPromises = queries.map(async q => {
        if (q.type === 'serper') {
          const r = await scanSerper(q.q, serperKey, country);
          console.log(`[Serper] results: ${r.length} | query: ${q.q.slice(0,50)}`);
          return r;
        } else if (q.type === 'ted') {
          const r = await scanTED(q.q, country);
          console.log(`[TED] results: ${r.length} | query: ${q.q.slice(0,50)}`);
          return r;
        }
        return [];
      });

      const scanArrays = await Promise.all(scanPromises);
      const rawResults = scanArrays.flat();

      // Дедупликација
      const seen = new Set();
      allResults = rawResults.filter(r => {
        if (!r.link || seen.has(r.link)) return false;
        seen.add(r.link);
        return true;
      }).slice(0, 5);

      console.log(`[BRAIN] Total unique results: ${allResults.length}`);
    }

    // ═══ BRAIN STEP 2: ANALYZE ═══
    let analysis = null;
    if (allResults.length > 0) {
      analysis = await analyzeOpportunities(allResults, userText, lang, apiKey);
      console.log(`[BRAIN] Analysis: ${analysis ? 'done' : 'failed'}`);
    }

    // ═══ BRAIN STEP 3: EXECUTE (Gemini final) ═══
    let systemPrompt = buildSystemPrompt(lang, today, allResults, analysis);
    if (memory.summary) systemPrompt += `\n\nContext: ${memory.summary}`;

    const text = await callGemini(systemPrompt, messages, hasImage, body.image, body.imageType, body.imageText, apiKey);

    if (userId) {
      await Promise.all([
        saveMemory(userId, avatar, 'user', userText),
        saveMemory(userId, avatar, 'assistant', text),
        incrementUserQuota(userId)
      ]);
    }

    return res.status(200).json({
      content: [{ type: 'text', text }],
      intent,
      remaining: limit.remaining
    });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
