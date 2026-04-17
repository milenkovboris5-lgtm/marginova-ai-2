// ═══════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// Business COO — Gemini Flash 2.5 + Serper
// ═══════════════════════════════════════════

const DAILY_LIMIT = 200;
const rateLimitStore = {};

// ═══ RATE LIMIT ═══
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

// ═══ FETCH WITH TIMEOUT ═══
function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ═══ SUPABASE MEMORY ═══
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

// Supabase REST helper
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

// ═══ USER QUOTA (Supabase) ═══
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
    if (limit === -1) return { allowed: true, remaining: -1 }; // unlimited

    const used = profile.last_msg_date === today ? (profile.daily_msgs || 0) : 0;
    const remaining = Math.max(0, limit - used);

    return { allowed: remaining > 0, remaining, plan, used };
  } catch (e) {
    console.warn('Quota check error:', e.message);
    return { allowed: true, remaining: 999 };
  }
}

async function incrementUserQuota(userId) {
  if (!SUPA_URL || !SUPA_KEY || !userId) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    // Прво земи тековна состојба
    const res = await supabaseRequest(
      `profiles?user_id=eq.${userId}&select=daily_msgs,last_msg_date`,
      { headers: { Prefer: '' } }
    );
    if (!res.ok) return;
    const rows = await res.json();
    const profile = rows?.[0];
    const currentUsed = profile?.last_msg_date === today ? (profile?.daily_msgs || 0) : 0;

    await supabaseRequest(
      `profiles?user_id=eq.${userId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ daily_msgs: currentUsed + 1, last_msg_date: today })
      }
    );
  } catch (e) {
    console.warn('Quota increment error:', e.message);
  }
}

// ═══ GEMINI SUMMARIZATION ═══
async function generateSummary(messages, apiKey) {
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

// ═══ MEMORY ═══
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

    // Последни 6 пораки за директен context
    const recent = rows.slice(0, 6).reverse().map(r => ({
      role: r.role === 'assistant' ? 'assistant' : 'user',
      content: r.message
    }));

    // Постари пораки → Real Gemini summary
    let summary = null;
    if (rows.length > 6) {
      const older = rows.slice(6).reverse();
      const sumText = await generateSummary(older, apiKey);
      if (sumText) {
        summary = `Претходен контекст (резиме): ${sumText}`;
      } else {
        // Fallback на truncate ако Gemini не одговори
        summary = `Претходен разговор: ${older.map(r => `${r.role}: ${r.message}`).join(' ').slice(0, 400)}`;
      }
    }

    return { summary, recent };
  } catch (e) {
    console.warn('Memory load error:', e.message);
    return { summary: null, recent: [] };
  }
}

async function saveMemory(userId, avatar, role, message) {
  if (!SUPA_URL || !SUPA_KEY || !userId) return;
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


const INTENT_PATTERNS = {
  tender: [
    'тендер','набавка','оглас','конкурс','јавна набавка',
    'tender','nabavka','oglas','javna nabavka','procurement',
    'ausschreibung','ihale','przetarg','appalto'
  ],
  grant: [
    'грант','фонд','ipard','ipa','eu фонд','финансирање','финансиска поддршка',
    'grant','grantovi','fond','fondovi','finansiranje','finansiska','subsidy','podrska',
    'förderung','hibe','dotacja','subvencija','eu grant','eu fond',
    'horizon','erasmus','undp','usaid','wbif','fitr'
  ],
  legal: [
    'договор','право','gdpr','закон','трудово','даноци','правни','регулатив',
    'ugovor','pravo','zakon','radno','porezi','pravni','regulativ','aplikacija pravna',
    'contract','legal','recht','gesetz','hukuk','prawo',
    'licenca','dozvola','registracija','osnivanje','statut'
  ],
  analysis: [
    'анализа','споредба','swot','извештај','проекција',
    'analiza','swot','izvestaj','projekcija','analysis',
    'analyse','analiz','analiza'
  ],
  business: [
    'бизнис','стратегија','план','раст','партнерство','маркетинг',
    'biznis','strategija','plan','rast','partnerstvo','marketing',
    'business','strategie','strategi','iş','biznes'
  ]
};

// ═══ HYBRID INTENT CLASSIFIER ═══
// Прво keyword matching (0ms, бесплатно)
// Ако score = 0 → LLM fallback (само кога е нејасно)

function classifyIntent(text) {
  const lower = text.toLowerCase();
  const scores = {};
  for (const [intent, keywords] of Object.entries(INTENT_PATTERNS)) {
    scores[intent] = keywords.filter(k => lower.includes(k)).length;
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const second = sorted[1];

  // Јасен winner — врати веднаш
  if (top[1] >= 2) return { intent: top[0], confident: true };
  if (top[1] === 1 && second[1] === 0) return { intent: top[0], confident: true };

  // Нема match или tie — потребен LLM
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

// ═══ SERPER SEARCH ═══

// FIX 1: Extract keywords od userText za podobri query
function extractKeywords(text) {
  const stopWords = new Set([
    'и','или','на','во','за','од','со','до','по','при','над','под','меѓу','дека','дали',
    'the','and','or','for','in','of','to','a','an','is','are','was','were','be','been',
    'i','ili','za','od','sa','da','je','su','se','na','u','o','po',
    'und','oder','für','in','von','zu','die','der','das'
  ]);
  return text.toLowerCase()
    .replace(/[^\w\s\u0400-\u04FF]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 6)
    .join(' ');
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

  if (intent === 'tender') {
    let site = 'site:e-nabavki.gov.mk OR site:portal.ujn.gov.rs OR site:ted.europa.eu';
    for (const [key, val] of Object.entries(countryMap)) {
      if (lower.includes(key)) { site = val; break; }
    }
    // FIX 1: Користи keywords наместо генеричко "tender javna nabavka"
    return `${keywords} tender nabavka ${site}`;
  }

  if (intent === 'grant') {
    // FIX 1: Додај keywords за поконкретни резултати
    let grantSite = 'site:mk.undp.org OR site:westernbalkansfund.org OR site:ec.europa.eu OR site:ipard.gov.mk OR site:fitr.mk OR site:funding.mk';
    return `${keywords} grant fond finansiranje ${grantSite}`;
  }

  if (intent === 'business') {
    // Приватни понуди — pazar3, oglasi, halo
    let site = 'site:pazar3.mk OR site:oglasi.mk OR site:halo.rs OR site:njuskalo.hr';
    for (const [key, val] of Object.entries({
      'македон': 'site:pazar3.mk OR site:biznis.mk OR site:oglasi.mk',
      'makedon': 'site:pazar3.mk OR site:biznis.mk OR site:oglasi.mk',
      'srbij': 'site:halo.rs OR site:oglasi.rs',
      'србиј': 'site:halo.rs OR site:oglasi.rs',
      'hrvat': 'site:njuskalo.hr OR site:oglasnik.hr',
    })) {
      if (lower.includes(key)) { site = val; break; }
    }
    return `${keywords} ${site}`;
  }

  return null;
}

async function searchSerper(query, apiKey) {
  if (!query || !apiKey) return null;
  try {
    const res = await fetchWithTimeout('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      // FIX 2: Барај само 5, земи само 3
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

// FIX 2: Summary наместо raw — пократок prompt
function formatSearchResults(results, intent) {
  if (!results || results.length === 0) return '';
  const today = new Date().toLocaleDateString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const label = intent === 'grant' ? 'ГРАНТОВИ' : 'ТЕНДЕРИ';
  let ctx = `\n\n═══ LIVE РЕЗУЛТАТИ — ${label} — ${today} ═══\n`;
  ctx += `Прикажи САМО овие резултати со точните линкови. НЕ измислувај.\n\n`;
  results.forEach((r, i) => {
    // Summary: само наслов + клучен дел од snippet (max 100 chars) + линк
    const snippet = r.snippet ? r.snippet.slice(0, 100) + (r.snippet.length > 100 ? '...' : '') : '';
    ctx += `${i + 1}. **${r.title}**\n`;
    if (r.date) ctx += `   Датум: ${r.date}\n`;
    if (snippet) ctx += `   ${snippet}\n`;
    ctx += `   🔗 ${r.link}\n\n`;
  });
  ctx += `═══ КРАЈ ═══\n`;
  return ctx;
}

// ═══ GEMINI CALL ═══
async function callGemini(systemPrompt, messages, hasImage, imageData, imageType, imageText, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }]
  }));

  if (hasImage && imageData) {
    const text = imageText || 'Analyze this carefully.';
    contents.pop();
    contents.push({
      role: 'user',
      parts: [
        { inline_data: { mime_type: imageType || 'image/jpeg', data: imageData } },
        { text }
      ]
    });
  }

  // FIX 3: Без Google Grounding — само Serper за search
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
    generationConfig: { maxOutputTokens: 3000, temperature: 0.5 }
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

  const modeInstructions = {
    tender: `Si procurement specialist. Koga nekoj bara tender — TI GO NAOGJAS I GO PREZENTIRAS.
FORMAT za sekoja najdena moznost:
📋 **[Naziv od search]**
🏛 Naracuvac: [ime od search]
💰 Vrednost: [SAMO od search — inaku "Proveri na portalot"]
📅 Rok: [SAMO od search — inaku "Proveri na portalot"]
📎 Dokumenti: [sto treba]
✅ Kako da apliciraj: [cekor 1, 2, 3]
🔗 [SAMO realen link od search]

KRITICNO: NIKOGASH ne izmisluvaj tenderi, iznosi, rokovi.
Ako search ne nashol → kazi: "Nema najdeni tenderi za [query]. Proveri direktno na: e-nabavki.gov.mk · portal.ujn.gov.rs · ted.europa.eu"`,

    grant: `Si EU funds specialist. Koga nekoj bara grant — TI GO NAOGJAS I GO PREZENTIRAS.
FORMAT za sekoja najdena moznost:
🎯 **[Naziv]**
💶 Iznos: [SAMO ako e poznat od search — inaku "Proveri na portalot"]
📊 Kofinansiranje: [SAMO ako e poznat — inaku ne navodi]
🎯 Koj moze: [tip]
📅 Rok: [datum od search ili "Proveri na [portal]"]
📎 Dokumenti: [sto treba]
✅ Kako da apliciraj: [cekor 1, 2, 3]
🔗 [SAMO realni linkovi od search]

KRITICNO: NIKOGASH ne izmisluvaj iznosi, protsenti, rokovi.
Ako nemas live podatoci za iznos — NE go navodi.
Ako search ne nashol aktivni povici → kazi: "Nema aktivni povici momentalno. Sledni otvoruvanja na: fitr.mk · funding.mk · ipard.gov.mk · mk.undp.org"`,

    legal: `Si biznis pravnik. Davaj konkretni odgovori — ne opsti soveti.
— Identifikuvaj tocno kade e rizikot
— Reci sto TOCNO treba da se promeni ili doda
— Ako treba notarizacija/licenca — kazi koja, kade, kolku chini
— Zavrsuvaj so: Sledni cekor: [1, 2, 3]`,

    analysis: `Si McKinsey partner. Davaj odluki — ne izvestai.
— Oceni 1-10 so obrazlozenie
— Tabela koga sporeduvash
— Zakljucok: PREPORAKA: [DA/NE/CEKAI] + zosto
— Top 3 akcii: [1, 2, 3]`,

    business: `Si COO koj izgradil kompanii. Davaj planovi — ne listi na zelbi.
— Sekoj cekor: KOJ + STO + DO KOGA + KOLKU CHINI
— Top 3 rizici i top 3 moznosti
— Zavrsuvaj so: Prviot cekor utrede: [konkretna akcija]
— Za privatni ponudi: prикажи SAMO realni rezultati od search so tocni linkovi
— NIKOGASH ne izmisluvaj firmi, ceni, linkovi — ako nemas realni rezultati kazi toa direktno`
  };

  return `Ti si Business COO — specialist koj DEJSTVUVA, ne analizira i ne se opravduva.

JAZIK: SAMO ${langName}. Nikogash ne mesaj jazici.

DENES E: ${todayStr}.

${modeInstructions[intent] || modeInstructions.business}

OSNOVNO PRAVILO:
— Sekogash prebaruvash i davash rezultat — ako nema, kazi ednas direktno i predlozi alternativa
— NIKOGASH ne se povtoruvash — ako vec si odgovoril na isto prasanje, dodaj novo ili prasaj za detali
— Ako korisnikot kaze "ne mozesh da prebaruvash" — ne se opravduvaj, samo pokazi nov rezultat ili alternativa
— NIKOGASH NE generiras "tipicni" iznosi — SAMO realni od search
— Maksimum 150 zbora — direktno, bez uvod, bez "kako COO..."
— Nikogash ne kazuvash deka si AI`;
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
  if (!limit.allowed) return res.status(429).json({ error: { message: 'Дневниот лимит е достигнат. Обидете се утре.' } });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY' } });
  const serperKey = process.env.SERPER_API_KEY;

  try {
    const body = req.body;
    const hasImage = !!body.image;
    const userId = body.userId || null;
    const avatar = 'cooai';

    // Anti-spam
    const rawText = body.messages?.[body.messages.length - 1]?.content || '';
    if (rawText.length > 2000) {
      return res.status(400).json({ error: { message: 'Пораката е предолга. Максимум 2000 знаци.' } });
    }
    if (!userId && limit.remaining < DAILY_LIMIT - 10) {
      return res.status(429).json({ error: { message: 'Потребна е регистрација за повеќе пораки.' } });
    }

    // ═══ USER QUOTA CHECK (Supabase) ═══
    if (userId) {
      const quota = await checkUserQuota(userId);
      if (!quota.allowed) {
        return res.status(429).json({
          error: { message: 'Го достигнавте дневниот лимит. Надградете го планот за повеќе пораки.' },
          quota_exceeded: true
        });
      }
      console.log(`[Quota] plan:${quota.plan} | remaining:${quota.remaining}`);
    }

    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

    // Memory со real Gemini summarization
    const memory = await loadMemory(userId, avatar, apiKey);

    // Комбинирај: memory.recent + нови пораки од frontend
    const frontendMessages = (body.messages || []).slice(-4).map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content || '')
    }));

    // Спречи дупликати — земи само нови пораки кои ги нема во memory
    const memoryContents = memory.recent.map(m => m.content);
    const newMessages = frontendMessages.filter(m => !memoryContents.includes(m.content));

    const messages = [...memory.recent, ...newMessages];

    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const userText = lastUserMsg?.content || '';
    const lang = body.lang || detectLang(userText);

    // Hybrid intent: keyword прво, LLM само ако е нејасно
    const keywordResult = classifyIntent(userText);
    const intent = keywordResult.confident
      ? keywordResult.intent
      : await classifyWithLLM(userText, apiKey);

    console.log(`[COO] lang:${lang} | intent:${intent} | confident:${keywordResult.confident} | memory:${memory.recent.length} msgs | text:${userText.slice(0, 60)}`);

    // Додај summary во system prompt ако постои
    let enrichedSystem = buildSystemPrompt(intent, lang, today);
    if (memory.summary) {
      enrichedSystem += `\n\n${memory.summary}`;
    }

    if (serperKey && (intent === 'tender' || intent === 'grant' || intent === 'business')) {
      const query = buildSearchQuery(userText, intent);
      console.log(`[Serper] query: ${query}`);
      if (query) {
        const results = await searchSerper(query, serperKey);
        console.log(`[Serper] results: ${results?.length || 0}`);
        if (results?.length > 0) {
          enrichedSystem += formatSearchResults(results, intent);
        } else {
          enrichedSystem += `\n\n═══ НЕМА РЕАЛНИ РЕЗУЛТАТИ ═══\nНе се пронајдени активни огласи. Кажи му на корисникот и препорачај официјални портали.\n═══════════════════════════\n`;
        }
      }
    }

    // Serper за приватни понуди во business intent
    if (serperKey && intent === 'business') {
      const lower = userText.toLowerCase();
      const isPrivateOffer = ['понуда','оглас','изведба','приватна','услуга','фасад','кров','градеж',
        'ponuda','oglas','izvedba','privatna','usluga','fasad','krov','gradez','raboti'].some(k => lower.includes(k));
      if (isPrivateOffer) {
        const keywords = extractKeywords(userText);
        const query = `${keywords} site:pazar3.mk OR site:biznis.mk OR site:oglasi.mk OR site:halo.rs OR site:njuskalo.hr`;
        console.log(`[Serper private] query: ${query}`);
        const results = await searchSerper(query, serperKey);
        console.log(`[Serper private] results: ${results?.length || 0}`);
        if (results?.length > 0) {
          enrichedSystem += formatSearchResults(results, 'private');
        } else {
          enrichedSystem += `\n\n═══ НЕМА РЕАЛНИ ПОНУДИ ═══\nНе се пронајдени огласи. НЕ ИЗМИСЛУВАЈ понуди, цени или контакти. Кажи директно дека нема резултати и препорачај: pazar3.mk · biznis.mk · oglasi.mk\n═══════════════════════════\n`;
        }
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

    // Зачувај memory + зголеми quota
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
