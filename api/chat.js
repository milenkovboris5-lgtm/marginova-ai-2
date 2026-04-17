// ═══════════════════════════════════════════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// Business COO — Gemini Flash 2.5 + Serper
// VERZIJA 3.0 — POPRAVENA (retry, JWT, transaction, bugfixes)
// ═══════════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const pLimit = require('p-limit'); // npm install p-limit

// ═══════════════════════════════════════════════════════════════════════════════
// KONSTANTI I GLOBALNI PROMENLIVI
// ═══════════════════════════════════════════════════════════════════════════════

const DAILY_LIMIT = 200;
const rateLimitStore = {};
const CONCURRENT_LIMIT = 5; // max 5 paralelni zahtevi po instanca
const limit = pLimit(CONCURRENT_LIMIT);

const PLAN_LIMITS = { free: 20, starter: 500, pro: 2000, business: -1 };

// Cleanup interval za rate limit (sekoj saat)
setInterval(() => {
  const now = Date.now();
  for (const k in rateLimitStore) {
    if (rateLimitStore[k].resetAt < now) delete rateLimitStore[k];
  }
}, 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNKCIJI
// ═══════════════════════════════════════════════════════════════════════════════

function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ═══ RATE LIMIT (IP based) ═══
function getRateLimitKey(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || 'unknown';
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

// ═══ SUPABASE KLIENT ═══
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ═══ SUPABASE REQUEST SO RETRY (FIX 1) ═══
async function supabaseRequest(path, options = {}, retries = 2) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchWithTimeout(
        url,
        { ...options, headers },
        i === retries ? 5000 : 4000
      );
      
      if (res.ok || i === retries) return res;
      await new Promise(r => setTimeout(r, 500 * (i + 1))); // eksponencijalan backoff
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

// ═══ JWT VERIFIKACIJA (FIX 4) ═══
async function verifyUser(userId, authToken) {
  if (!userId || !authToken) return false;
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(authToken);
    if (error || !user) return false;
    return user.id === userId;
  } catch (e) {
    console.warn('JWT verification error:', e.message);
    return false;
  }
}

// ═══ USER QUOTA (SO RPC TRANSACTION — FIX 3) ═══
async function checkUserQuota(userId) {
  if (!userId) return { allowed: true, remaining: 999 };
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await supabaseRequest(
      `profiles?user_id=eq.${userId}&select=plan,daily_msgs,last_msg_date`,
      { headers: { Prefer: 'return=representation' } }
    );
    if (!res.ok) return { allowed: true, remaining: 999 };
    const rows = await res.json();
    const profile = rows?.[0];
    if (!profile) return { allowed: true, remaining: 20 };

    const plan = profile.plan || 'free';
    const limit = PLAN_LIMITS[plan] ?? 20;
    if (limit === -1) return { allowed: true, remaining: -1 };

    const used = profile.last_msg_date === today ? (profile.daily_msgs || 0) : 0;
    const remaining = Math.max(0, limit - used);

    return { allowed: remaining > 0, remaining, plan, used };
  } catch (e) {
    console.warn('Quota check error:', e.message);
    return { allowed: true, remaining: 999 };
  }
}

async function incrementUserQuota(userId) {
  if (!userId) return;
  try {
    // Koristi RPC funkcija za atomic increment (treba da ja kreirate vo Supabase)
    // CREATE OR REPLACE FUNCTION increment_user_quota(user_id_param UUID)
    // RETURNS void AS $$
    // DECLARE today TEXT := to_char(NOW(), 'YYYY-MM-DD');
    // BEGIN
    //   UPDATE profiles 
    //   SET daily_msgs = daily_msgs + 1, last_msg_date = today 
    //   WHERE user_id = user_id_param AND last_msg_date = today;
    //   IF NOT FOUND THEN
    //     UPDATE profiles 
    //     SET daily_msgs = 1, last_msg_date = today 
    //     WHERE user_id = user_id_param;
    //   END IF;
    // END;
    // $$ LANGUAGE plpgsql;
    
    await supabaseRequest('rpc/increment_user_quota', {
      method: 'POST',
      body: JSON.stringify({ user_id_param: userId })
    });
  } catch (e) {
    console.warn('Quota increment error:', e.message);
    // Fallback: direkten update (neatomic, no podobro od nisto)
    const today = new Date().toISOString().split('T')[0];
    await supabaseRequest(
      `profiles?user_id=eq.${userId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ 
          daily_msgs: supabaseAdmin.rpc('increment', { row_id: userId, amount: 1 }),
          last_msg_date: today 
        })
      }
    );
  }
}

// ═══ GEMINI SUMMARIZATION (POPRAVENA) ═══
async function generateSummary(messages, apiKey) {
  if (!messages || messages.length === 0) return null;
  try {
    const text = messages.map(m => `${m.role}: ${m.message}`).join('\n');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `Summarize this business conversation in 3-5 sentences. Keep: key decisions, business context, specific numbers/deadlines mentioned, what was agreed.\n\n${text.slice(0, 3000)}` }] }],
        generationConfig: { maxOutputTokens: 250, temperature: 0.2 }
      })
    }, 8000);
    if (!res.ok) return null;
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (e) {
    console.warn('Summary error:', e.message);
    return null;
  }
}

// ═══ MEMORY (POPRAVENA — FIX 1b) ═══
async function loadMemory(userId, avatar, apiKey) {
  if (!userId) return { summary: null, recent: [] };
  try {
    const res = await supabaseRequest(
      `conversations?user_id=eq.${userId}&avatar=eq.${avatar}&order=created_at.desc&limit=20`,
      { headers: { Prefer: 'return=representation' } }
    );
    if (!res.ok) return { summary: null, recent: [] };
    const rows = await res.json();
    if (!rows || rows.length === 0) return { summary: null, recent: [] };

    // Posledni 6 poraki za direkten context (najnovite, pravilen redosled)
    const recent = rows.slice(0, 6).reverse().map(r => ({
      role: r.role === 'assistant' ? 'assistant' : 'user',
      content: r.message
    }));

    // PoStari poraki → Real Gemini summary (POPRAVENO)
    let summary = null;
    if (rows.length > 6) {
      const olderMessages = rows.slice(6).reverse().map(r => ({
        role: r.role,
        message: r.message
      }));
      const sumText = await generateSummary(olderMessages, apiKey);
      if (sumText) {
        summary = `Претходен контекст (резиме): ${sumText}`;
      } else {
        // Fallback na truncate
        summary = `Претходен разговор: ${olderMessages.map(r => `${r.role}: ${r.message}`).join(' ').slice(0, 400)}`;
      }
    }

    return { summary, recent };
  } catch (e) {
    console.warn('Memory load error:', e.message);
    return { summary: null, recent: [] };
  }
}

async function saveMemory(userId, avatar, role, message) {
  if (!userId) return;
  try {
    await supabaseRequest('conversations', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        avatar,
        role,
        message: message.slice(0, 2000),
        created_at: new Date().toISOString()
      })
    });
  } catch (e) {
    console.warn('Memory save error:', e.message);
  }
}

// ═══ HYBRID INTENT CLASSIFIER (POPRAVEN — FIX 9) ═══
const INTENT_PATTERNS = {
  tender: [
    'тендер','набавка','оглас','конкурс','јавна набавка',
    'tender','nabavka','oglas','javna nabavka','procurement'
  ],
  grant: [
    'грант','фонд','ipard','ipa','eu фонд','финансирање',
    'grant','grantovi','fond','fondovi','eu grant'
  ],
  legal: [
    'договор','право','gdpr','закон','трудово','даноци','правни',
    'ugovor','pravo','zakon','radno','porezi','pravni','contract','legal'
  ],
  analysis: [
    'анализа','споредба','swot','извештај','проекција',
    'analiza','swot','izvestaj','projekcija','analysis'
  ],
  business: [
    'бизнис','стратегија','план','раст','партнерство','маркетинг',
    'biznis','strategija','plan','rast','partnerstvo','marketing'
  ]
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
  
  // Proveri dali e negacija ("nemam tender" → ne e tender)
  const hasNegation = /\b(не|ne|nema|nemaм|bez|without|no)\b/i.test(lower);
  if (hasNegation && top[0] !== 'business') {
    // Ako kaze "nemam tender", ne e tender intent
    return { intent: 'business', confident: false };
  }
  
  // Jasen winner
  if (top[1] >= 2) return { intent: top[0], confident: true };
  if (top[1] === 1 && second[1] === 0) return { intent: top[0], confident: true };
  
  // Nema match ili tie → treba LLM
  return { intent: 'business', confident: false };
}

async function classifyWithLLM(text, apiKey) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `Classify this business query into ONE word: tender, grant, legal, analysis, or business.\nQuery: "${text}"\nReturn ONLY one word.` }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 10 }
      })
    }, 6000);
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase() || 'business';
    const valid = ['tender', 'grant', 'legal', 'analysis', 'business'];
    return valid.includes(raw) ? raw : 'business';
  } catch (e) {
    return 'business';
  }
}

// ═══ SERPER SEARCH (POPRAVEN — FIX 5, 10) ═══
function extractKeywords(text) {
  const stopWords = new Set([
    'и','или','на','во','за','од','со','до','по','при','над','под','меѓу','дека','дали',
    'the','and','or','for','in','of','to','a','an','is','are','was','were','be','been',
    'i','ili','za','od','sa','da','je','su','se','na','u','o','po'
  ]);
  
  const words = text.toLowerCase()
    .replace(/[^\w\s\u0400-\u04FF]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
  
  // Kirilica posebno
  const cyrillic = words.filter(w => /[а-яА-Я]/.test(w));
  const latin = words.filter(w => /[a-z]/.test(w));
  
  const result = [...cyrillic, ...latin].slice(0, 6);
  return result.length > 0 ? result.join(' ') : text.slice(0, 30);
}

function buildSearchQuery(text, intent) {
  const lower = text.toLowerCase();
  const keywords = extractKeywords(text);
  
  const countryMap = {
    'македон': 'site:e-nabavki.gov.mk',
    'makedon': 'site:e-nabavki.gov.mk',
    'srbij': 'site:portal.ujn.gov.rs',
    'србиј': 'site:portal.ujn.gov.rs',
    'hrvat': 'site:eojn.hr',
    'хрват': 'site:eojn.hr',
    'bosn': 'site:ejn.ba',
    'босн': 'site:ejn.ba',
    'bulgar': 'site:app.eop.bg',
    'бугар': 'site:app.eop.bg',
    'eu': 'site:ted.europa.eu',
  };
  
  let countrySite = '';
  for (const [key, val] of Object.entries(countryMap)) {
    if (lower.includes(key)) { countrySite = val; break; }
  }
  
  if (intent === 'tender') {
    const baseSite = countrySite || 'site:e-nabavki.gov.mk OR site:portal.ujn.gov.rs OR site:ted.europa.eu';
    return `${keywords} tender nabavka ${baseSite}`;
  }
  
  if (intent === 'grant') {
    // Dinamicki query spored klučni zborovi (FIX 5)
    let grantFocus = '';
    if (lower.includes('ipard')) grantFocus = 'IPARD rural development';
    else if (lower.includes('fitr')) grantFocus = 'FITR innovation';
    else if (lower.includes('horizon')) grantFocus = 'Horizon Europe research';
    else grantFocus = 'EU grant business';
    
    const baseSite = countrySite || 'site:ec.europa.eu OR site:fitr.mk OR site:ipard.gov.mk';
    return `${keywords} ${grantFocus} ${baseSite}`;
  }
  
  if (intent === 'business') {
    let site = countrySite || 'site:pazar3.mk OR site:oglasi.mk';
    // Ako ima specificni klučni zborovi, dodaj gi (FIX 10)
    if (keywords && keywords.length > 0) {
      return `${keywords} ${site}`;
    }
    return site;
  }
  
  return null;
}

async function searchSerper(query, apiKey) {
  if (!query || !apiKey) return null;
  try {
    const res = await fetchWithTimeout('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({ q: query, num: 5, gl: 'mk' }),
    }, 8000);
    if (!res.ok) return null;
    const data = await res.json();
    const results = [];
    if (data.organic) data.organic.slice(0, 3).forEach(r =>
      results.push({ title: r.title || '', snippet: r.snippet || '', link: r.link || '', date: r.date || '' })
    );
    return results.length > 0 ? results : null;
  } catch (e) {
    console.warn('Serper error:', e.message);
    return null;
  }
}

function formatSearchResults(results, intent) {
  if (!results || results.length === 0) return '';
  const today = new Date().toLocaleDateString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const label = intent === 'grant' ? 'ГРАНТОВИ' : (intent === 'business' ? 'ПРИВАТНИ ПОНУДИ' : 'ТЕНДЕРИ');
  let ctx = `\n\n═══ LIVE РЕЗУЛТАТИ — ${label} — ${today} ═══\n`;
  ctx += `Прикажи САМО овие резултати со точните линкови. НЕ измислувај.\n\n`;
  
  results.forEach((r, i) => {
    // Popraveno: ne seče usred reči (FIX 6)
    let snippet = r.snippet || '';
    if (snippet.length > 100) {
      snippet = snippet.slice(0, 97);
      const lastSpace = snippet.lastIndexOf(' ');
      if (lastSpace > 0) snippet = snippet.slice(0, lastSpace);
      snippet += '...';
    }
    
    ctx += `${i + 1}. **${r.title}**\n`;
    if (r.date) ctx += `   Датум: ${r.date}\n`;
    if (snippet) ctx += `   ${snippet}\n`;
    ctx += `   🔗 ${r.link}\n\n`;
  });
  ctx += `═══ КРАЈ ═══\n`;
  return ctx;
}

// ═══ GEMINI CALL (POPRAVEN — FIX 7) ═══
async function callGemini(systemPrompt, messages, hasImage, imageData, imageType, imageText, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  let contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }]
  }));
  
  // Popraveno: ne modificiraj originalna niza (FIX 7)
  if (hasImage && imageData) {
    const text = imageText || 'Analyze this carefully.';
    const newContents = contents.slice(0, -1);
    newContents.push({
      role: 'user',
      parts: [
        { inline_data: { mime_type: imageType || 'image/jpeg', data: imageData } },
        { text }
      ]
    });
    contents = newContents;
  }
  
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
    generationConfig: { maxOutputTokens: 2000, temperature: 0.5 }
  };
  
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 20000); // smaneto od 25s na 20s
  
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error ${res.status}: ${err.slice(0, 200)}`);
  }
  
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
  return text;
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

// ═══ BUILD SYSTEM PROMPT ═══
function buildSystemPrompt(intent, lang, todayStr) {
  const langNames = {
    mk: 'македонски', sr: 'српски', hr: 'хрватски', bs: 'босански',
    en: 'English', de: 'Deutsch', sq: 'shqip', bg: 'български',
    tr: 'Türkçe', pl: 'polski'
  };
  const langName = langNames[lang] || 'English';
  
  return `Ti si Business COO — iskusen sovetnik koj razbira sto korisnikot NAVISTINA bara.

JAZIK: SAMO ${langName}. Denes e ${todayStr}.

KRITICNO: Imam LIVE SEARCH. Ako ima rezultati vo kontekstot, prikazi gi. Ako nema, daj KONKRETNA ALTERNATIVA.

═══ SCENARIJA ═══

PRIVATNI PONUDI / BARANJA ZA RABOTA:
→ Prikazi gi rezultatite so: 📋 Naslov | 📅 Datum | 📍 Lokacija | 🔗 Link
→ Ako nema: "Nema aktivni oglasi. Probaj na LinkedIn grupite ili direktno kontaktiraj firmi."

TENDERI:
→ Prikazi gi so: 📋 Naslov | 💰 Vrednost (ako e poznata) | 📅 Rok | 🔗 Link
→ Ako nema: "Nema aktivni tenderi. Proveri na e-nabavki.gov.mk ili prati direktno baranje do opstini."

GRANTOVI:
→ Prikazi gi so: 🎯 Naslov | 💶 Iznos | 📅 Rok | 🔗 Link
→ Ako nema: "Nema aktivni povici. Sledi gi fitr.mk i funding.mk."

PRAVNI PRASANJA:
→ Daj konkreten odgovor. Ako ne znaes tocen zakon, kazi i predlozi advokat.

FINANSISKI PRESMETKI:
→ Daj tabela so brojki, ne samo tekst.

ANALIZA:
→ Daj preporaka (DA/NE/CEKAI) + obrazlozenie.

OPSTO PRAVILO:
— Maksimum 200 zbora
— Zavrsuvaj so EDNA konkretna akcija
— Nikogash ne kazuvas deka si AI`;
}

// ═══ HEALTH CHECK ENDPOINT ═══
async function healthCheck() {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '3.0',
    supabase: process.env.SUPABASE_URL ? 'configured' : 'missing',
    gemini: process.env.GEMINI_API_KEY ? 'configured' : 'missing',
    serper: process.env.SERPER_API_KEY ? 'configured' : 'missing'
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  
  // Health check endpoint
  if (req.method === 'GET' && req.url === '/api/health') {
    return res.status(200).json(await healthCheck());
  }
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  
  // Rate limit (IP)
  const limit = checkRateLimit(req);
  if (!limit.allowed) {
    return res.status(429).json({ error: { message: 'Дневниот лимит е достигнат. Обидете се утре.' } });
  }
  
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY' } });
  const serperKey = process.env.SERPER_API_KEY;
  
  try {
    const body = req.body;
    const hasImage = !!body.image;
    const userId = body.userId || null;
    const authToken = req.headers.authorization || body.authToken || null;
    const avatar = 'cooai';
    
    // Anti-spam
    const rawText = body.messages?.[body.messages.length - 1]?.content || '';
    if (rawText.length > 2000) {
      return res.status(400).json({ error: { message: 'Пораката е предолга. Максимум 2000 знаци.' } });
    }
    
    // JWT verifikacija (FIX 4)
    if (userId) {
      const isValid = await verifyUser(userId, authToken);
      if (!isValid) {
        return res.status(401).json({ error: { message: 'Неавторизиран пристап. Најавете се повторно.' } });
      }
    } else if (limit.remaining < DAILY_LIMIT - 10) {
      return res.status(429).json({ error: { message: 'Потребна е регистрација за повеќе пораки.' } });
    }
    
    // User quota check
    if (userId) {
      const quota = await checkUserQuota(userId);
      if (!quota.allowed) {
        return res.status(429).json({
          error: { message: 'Го достигнавте дневниот лимит. Надградете го планот за повеќе пораки.' },
          quota_exceeded: true
        });
      }
      console.log(`[Quota] user:${userId.slice(0,8)} | plan:${quota.plan} | remaining:${quota.remaining}`);
    }
    
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    
    // Load memory so retry
    const memory = await loadMemory(userId, avatar, apiKey);
    
    // Kombiniraj poraki
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
    
    // Hybrid intent (so negacija detekcija)
    const keywordResult = classifyIntent(userText);
    const intent = keywordResult.confident
      ? keywordResult.intent
      : await classifyWithLLM(userText, apiKey);
    
    console.log(`[COO] user:${userId?.slice(0,8) || 'anon'} | lang:${lang} | intent:${intent} | text:${userText.slice(0, 50)}`);
    
    // Build system prompt so memory summary
    let enrichedSystem = buildSystemPrompt(intent, lang, today);
    if (memory.summary) {
      enrichedSystem += `\n\n${memory.summary}`;
    }
    
    // Serper search (so konkurentnost limit)
    const lower = userText.toLowerCase();
    const wantsPrivate = ['приватна','понуда','оглас','izvedba','fasad','градеж','usluga'].some(k => lower.includes(k));
    const wantsTender = intent === 'tender' || ['тендер','tender','јавна','nabavka','набавка'].some(k => lower.includes(k));
    const wantsGrant = intent === 'grant';
    
    if (serperKey && (wantsPrivate || wantsTender || wantsGrant)) {
      const searchTasks = [];
      const allResults = [];
      
      if (wantsPrivate) {
        searchTasks.push(limit(async () => {
          const keywords = extractKeywords(userText);
          const q = `${keywords} site:pazar3.mk OR site:oglasi.mk`;
          return { type: 'private', results: await searchSerper(q, serperKey) };
        }));
      }
      
      if (wantsTender) {
        searchTasks.push(limit(async () => {
          const q = buildSearchQuery(userText, 'tender');
          return { type: 'tender', results: await searchSerper(q, serperKey) };
        }));
      }
      
      if (wantsGrant) {
        searchTasks.push(limit(async () => {
          const q = buildSearchQuery(userText, 'grant');
          return { type: 'grant', results: await searchSerper(q, serperKey) };
        }));
      }
      
      const searchResults = await Promise.all(searchTasks);
      for (const sr of searchResults) {
        if (sr.results?.length) allResults.push(...sr.results);
      }
      
      if (allResults.length > 0) {
        const seen = new Set();
        const unique = allResults.filter(r => {
          if (seen.has(r.link)) return false;
          seen.add(r.link);
          return true;
        }).slice(0, 4);
        enrichedSystem += formatSearchResults(unique, wantsPrivate ? 'business' : intent);
      } else if (wantsPrivate || wantsTender || wantsGrant) {
        const alternatives = [];
        if (wantsPrivate) alternatives.push('pazar3.mk · biznis.mk');
        if (wantsTender) alternatives.push('e-nabavki.gov.mk');
        if (wantsGrant) alternatives.push('fitr.mk · funding.mk');
        enrichedSystem += `\n\n═══ НЕМА РЕЗУЛТАТИ ═══\nПровери на: ${alternatives.join(' | ')}\nАко нема ни таму, контактирај директно фирми во твојот регион.\n═══\n`;
      }
    }
    
    const text = await callGemini(
      enrichedSystem,
      messages,
      hasImage,
      body.image,
      body.imageType,
      body.imageText,
      apiKey
    );
    
    // Save memory i quota (paralelno)
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
    console.error('Handler error:', err.message, err.stack);
    return res.status(500).json({ error: { message: 'Внатрешна грешка. Обидете се повторно.' } });
  }
};
