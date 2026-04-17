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

async function loadMemory(userId, avatar) {
  if (!SUPA_URL || !SUPA_KEY || !userId) return { summary: null, recent: [] };
  try {
    const res = await fetchWithTimeout(
      `${SUPA_URL}/rest/v1/conversations?user_id=eq.${userId}&avatar=eq.${avatar}&order=created_at.desc&limit=20`,
      { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } },
      5000
    );
    if (!res.ok) return { summary: null, recent: [] };
    const rows = await res.json();
    if (!rows || rows.length === 0) return { summary: null, recent: [] };

    // Last 3 messages за context
    const recent = rows.slice(0, 6).reverse().map(r => ({
      role: r.role === 'assistant' ? 'assistant' : 'user',
      content: r.message
    }));

    // Summary од постарите ако има повеќе од 6
    let summary = null;
    if (rows.length > 6) {
      const older = rows.slice(6).reverse().map(r => `${r.role}: ${r.message}`).join('\n');
      summary = `Претходен разговор (резиме): ${older.slice(0, 500)}`;
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
    await fetchWithTimeout(
      `${SUPA_URL}/rest/v1/conversations`,
      {
        method: 'POST',
        headers: {
          apikey: SUPA_KEY,
          Authorization: `Bearer ${SUPA_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          user_id: userId,
          avatar,
          role,
          message: message.slice(0, 2000), // max 2000 chars per message
          created_at: new Date().toISOString()
        })
      },
      5000
    );
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
    'договор','право','gdpr','закон','трудово','даноци',
    'ugovor','pravo','zakon','radno','porezi','contract',
    'legal','recht','gesetz','hukuk','prawo'
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

function classifyIntent(text) {
  const lower = text.toLowerCase();
  const scores = {};
  for (const [intent, keywords] of Object.entries(INTENT_PATTERNS)) {
    scores[intent] = keywords.filter(k => lower.includes(k)).length;
  }
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return top[1] > 0 ? top[0] : 'business';
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
    generationConfig: { maxOutputTokens: 2000, temperature: 0.5 }
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
📋 **[Naziv]**
🏛 Naracuvac: [ime]
💰 Vrednost: [iznos]
📅 Rok: [datum]
📎 Dokumenti: [sto treba]
✅ Kako da apliciraj: [cekor 1, 2, 3]
🔗 [link]
Prebaraj na: e-nabavki.gov.mk, portal.ujn.gov.rs, ted.europa.eu, eojn.hr, ejn.ba`,

    grant: `Si EU funds specialist. Koga nekoj bara grant — TI GO NAOGJAS I GO PREZENTIRAS.
FORMAT za sekoja najdena moznost:
🎯 **[Naziv]**
💶 Iznos: [min-max]
📊 Kofinansiranje: [%]
🎯 Koj moze: [tip]
📅 Rok: [datum ili "povtoruvacka — sledni povik: [portal]"]
📎 Dokumenti: [sto treba]
✅ Kako da apliciraj: [cekor 1, 2, 3]
🔗 [link]
Prebaraj na: fitr.mk, funding.mk, ipard.gov.mk, mk.undp.org, ec.europa.eu/funding-tenders`,

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
— Za privatni ponudi prebaraj: pazar3.mk, biznis.mk, oglasi.mk, halo.rs, njuskalo.hr, linkedin.com`
  };

  return `Ti si Business COO — specialist koj DEJSTVUVA, ne analizira i ne se opravduva.

JAZIK: SAMO ${langName}. Nikogash ne mesaj jazici.

DENES E: ${todayStr}.

${modeInstructions[intent] || modeInstructions.business}

OSNOVNO PRAVILO:
— Nikogash NE kazuvash "ne mozam da prebaruvam" — sekogash naogjas resenie
— Nikogash NE davash samo linkovi bez upatstvo kako da se aplicira
— Nikogash NE si defanziven — si specialist koj resava
— Ako live search ne vratio rezultati — koristej sopstveno znaeenje za programite i portalite
— Maksimum 300 zbora — direktno, bez uvod
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
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

    // Вчитај Supabase memory
    const memory = await loadMemory(userId, avatar);

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
    const intent = classifyIntent(userText);

    console.log(`[COO] lang:${lang} | intent:${intent} | memory:${memory.recent.length} msgs | text:${userText.slice(0, 60)}`);

    // Додај summary во system prompt ако постои
    let enrichedSystem = buildSystemPrompt(intent, lang, today);
    if (memory.summary) {
      enrichedSystem += `\n\n${memory.summary}`;
    }

    if (serperKey && (intent === 'tender' || intent === 'grant')) {
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

    const text = await callGemini(
      enrichedSystem,
      messages,
      hasImage,
      body.image,
      body.imageType,
      body.imageText,
      apiKey
    );

    // Зачувај во Supabase memory
    if (userId) {
      await saveMemory(userId, avatar, 'user', userText);
      await saveMemory(userId, avatar, 'assistant', text);
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
