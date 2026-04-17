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

// ═══ INTENT CLASSIFICATION ═══
const INTENT_PATTERNS = {
  tender: [
    'тендер','набавка','оглас','конкурс','јавна набавка',
    'tender','nabavka','oglas','javna nabavka','procurement',
    'ausschreibung','ihale','przetarg','appalto'
  ],
  grant: [
    'грант','фонд','ipard','ipa','eu фонд','финансирање',
    'grant','fond','fondovi','finansiranje','subsidy',
    'förderung','hibe','dotacja','subvencija'
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
function buildSearchQuery(text, intent) {
  const lower = text.toLowerCase();
  const month = new Date().toISOString().slice(0, 7);

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
    return `tender javna nabavka ${site}`;
  }

  if (intent === 'grant') {
    return `grant fond program site:mk.undp.org OR site:westernbalkansfund.org OR site:ec.europa.eu OR site:ipard.gov.mk`;
  }

  return null;
}

async function searchSerper(query, apiKey) {
  if (!query || !apiKey) return null;
  try {
    const res = await fetchWithTimeout('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({ q: query, num: 8, gl: 'mk' }),
    }, 8000);
    if (!res.ok) return null;
    const data = await res.json();
    const results = [];
    if (data.organic) data.organic.slice(0, 6).forEach(r =>
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
  const label = intent === 'grant' ? 'ГРАНТОВИ/ФОНДОВИ' : 'ТЕНДЕРИ/НАБАВКИ';
  let ctx = `\n\n═══ РЕАЛНИ РЕЗУЛТАТИ — ${label} — ${today} ═══\n`;
  ctx += `КРИТИЧНО: Прикажи САМО овие резултати со ТОЧНИТЕ линкови. НЕ измислувај.\n\n`;
  results.forEach((r, i) => {
    ctx += `[${i + 1}] ${r.title}\n`;
    if (r.date) ctx += `    Датум: ${r.date}\n`;
    if (r.snippet) ctx += `    ${r.snippet}\n`;
    ctx += `    Линк: ${r.link}\n\n`;
  });
  ctx += `═══ КРАЈ НА РЕЗУЛТАТИ ═══\n`;
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

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
    generationConfig: { maxOutputTokens: 3000, temperature: 0.7 },
    tools: [{ googleSearch: {} }]
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

  // Append grounding sources if available
  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = chunks
    .filter(c => c.web?.uri && !c.web.uri.includes('vertexaisearch'))
    .slice(0, 3)
    .map(c => {
      const host = (() => { try { return new URL(c.web.uri).hostname.replace('www.', ''); } catch { return c.web.uri; } })();
      const title = c.web.title || host;
      return `• [${title}](${c.web.uri})`;
    }).join('\n');

  return sources ? `${text}\n\n🔍 **Извори:**\n${sources}` : text;
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
    tender: `— Анализирај јавни набавки, B2B понуди, лицитации
— Прикажи реални резултати со точни линкови
— Пресметај вредност, рокови, ризици
— Препорачај следни чекори за апликација`,

    grant: `— Идентификувај релевантни EU фондови, IPARD, UNDP, донатори
— Наведи услови за подобност и потребна документација
— Ако нема активни огласи — кажи тоа директно и препорачај портали`,

    legal: `— Анализирај правни ризици и договорни обврски
— Идентификувај GDPR, трудово право, даночни импликации
— Формулирај препораки конкретно и прецизно
— Ако не си сигурен — препорачај консултација со правник`,

    analysis: `— Структурирај податоци во јасна форма (табели, SWOT, споредби)
— Базирај се на реални бројки, не измислувај
— Дај конкретни заклучоци и препораки
— Оцени можноста 1-10 кога е релевантно`,

    business: `— Анализирај пазар, конкуренција, финансии
— Дај конкретен план со приоритетни чекори
— Идентификувај ризици и можности
— Препорачај партнерства, канали, стратегија за раст`
  };

  return `Ti si Business COO — senior AI sovetnik. Odgovaras direktno i konkretno.

JAZIK: Sekogash odgovori SAMO na ${langName}. Apsolutno zadolzitelno.

DENES E: ${todayStr}.
ZA GRANTOVI I PROGRAMI:
— Prikazuvaj gi SITE relevantni programi — bez razlika na datumot na objava.
— Nekoi programi trazat godini (IPARD, Horizon, UNDP) i seuste se aktivni.
— Proceni: dali programata se POVTORUVA ili e ednokatna?
— Ako rokot e poznat i pominat → "Prethoden ciklus — sledat nov povik".
— Ako rokot ne e poznat → "Proveri tekovni rokovi direktno na portalot".

${modeInstructions[intent] || modeInstructions.business}

— Nikogash ne kazuvash sto pravis vo pozadina — samo odgovaraj direktno
— Nikogash ne kazuvash deka si AI
— Vazni brojki, rokovi, sumi → **bold**
— Strukturiraj: Analiza → Rizici → Preporaka → Sledni cekor
— Maksimum 250 zbora osven ako ne se bara podrobno`;
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
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const messages = (body.messages || []).slice(-10).map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content || '')
    }));

    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const userText = lastUserMsg?.content || '';
    const lang = body.lang || detectLang(userText);
    const intent = classifyIntent(userText);

    console.log(`[COO] lang:${lang} | intent:${intent} | text:${userText.slice(0, 60)}`);

    // Live search за tender и grant
    let enrichedSystem = buildSystemPrompt(intent, lang, today);

    if (serperKey && (intent === 'tender' || intent === 'grant')) {
      const query = buildSearchQuery(userText, intent);
      if (query) {
        const results = await searchSerper(query, serperKey);
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
