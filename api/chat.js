// ═══════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// Верзија: Hybrid v7 — Gemini + Grounding + Serper + TED API
// ═══════════════════════════════════════════

const rateLimitStore = {};
const DAILY_LIMIT = 150;

function getRateLimitKey(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
  const today = new Date().toISOString().split('T')[0];
  return ip + '_' + today;
}

function checkRateLimit(req) {
  const key = getRateLimitKey(req);
  const now = Date.now();
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  for (const k in rateLimitStore) {
    if (rateLimitStore[k].resetAt < now) delete rateLimitStore[k];
  }
  if (!rateLimitStore[key]) {
    rateLimitStore[key] = { count: 0, resetAt: end.getTime() };
  }
  rateLimitStore[key].count += 1;
  return { allowed: rateLimitStore[key].count <= DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - rateLimitStore[key].count) };
}

// ═══════════════════════════════════════════
// МОДЕЛ ROUTING
// ═══════════════════════════════════════════
const AVATAR_MODEL_MAP = {
  eva:         { model: 'gemini-2.5-flash', grounding: true,  serper: true  },
  tenderai:    { model: 'gemini-2.5-flash', grounding: true,  serper: true  },
  dropshipper: { model: 'gemini-2.5-flash', grounding: true,  serper: false },
  businessai:  { model: 'gemini-2.5-flash', grounding: true,  serper: false },
  justinian:   { model: 'gemini-2.5-flash', grounding: true,  serper: false },
  leo:         { model: 'gemma-3-27b-it',   grounding: false, serper: false },
  liber:       { model: 'gemma-3-27b-it',   grounding: false, serper: false },
  creativeai:  { model: 'gemma-3-27b-it',   grounding: false, serper: false },
  default:     { model: 'gemini-2.5-flash', grounding: false, serper: false },
};

function getAvatarConfig(avatar) {
  return AVATAR_MODEL_MAP[avatar] || AVATAR_MODEL_MAP.default;
}

// ═══════════════════════════════════════════
// TED API — EU ТЕНДЕРИ
// ═══════════════════════════════════════════
const TED_COUNTRY_MAP = {
  'македонија': 'MK', 'македон': 'MK', 'north macedonia': 'MK', 'mk': 'MK',
  'србија': 'RS', 'srbija': 'RS', 'serbia': 'RS',
  'хрватска': 'HR', 'hrvatska': 'HR', 'croatia': 'HR',
  'босна': 'BA', 'bosna': 'BA', 'bosnia': 'BA',
  'бугарија': 'BG', 'bulgaria': 'BG',
  'албанија': 'AL', 'albanija': 'AL', 'albania': 'AL',
  'турција': 'TR', 'türkiye': 'TR', 'turkey': 'TR',
  'полска': 'PL', 'polska': 'PL', 'poland': 'PL',
  'германија': 'DE', 'deutschland': 'DE', 'germany': 'DE',
};

const CPV_MAP = {
  'градеж': '45000000', 'фасад': '45000000', 'construction': '45000000', 'fasad': '45000000',
  'it': '72000000', 'software': '72000000',
  'медицин': '33000000', 'health': '33000000',
  'образован': '80000000', 'education': '80000000',
  'транспорт': '60000000', 'transport': '60000000',
};

async function searchTED(userText) {
  try {
    const lower = userText.toLowerCase();
    let country = null;
    for (const [key, code] of Object.entries(TED_COUNTRY_MAP)) {
      if (lower.includes(key)) { country = code; break; }
    }
    let cpv = null;
    for (const [key, code] of Object.entries(CPV_MAP)) {
      if (lower.includes(key)) { cpv = code; break; }
    }
    const today = new Date();
    const fromDate = new Date(today);
    fromDate.setDate(today.getDate() - 30);
    let queryParts = [];
    if (country) queryParts.push(`buyers.country=${country}`);
    if (cpv) queryParts.push(`cpvs.code=${cpv}`);
    queryParts.push(`publicationDate>=${fromDate.toISOString().split('T')[0]}`);
    queryParts.push('query=*');
    const tedUrl = `https://ted.europa.eu/api/v3.0/notices/search?fields=publicationNumber,title,buyers,publicationDate,deadline,estimatedValue,cpvs&pageSize=5&page=1&scope=ACTIVE&${queryParts.join('&')}`;
    const response = await fetch(tedUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Marginova-AI/1.0' }
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.notices || data.notices.length === 0) return null;
    return data.notices.map(n => ({
      title: (n.title?.text) || (typeof n.title === 'string' ? n.title : 'EU Tender'),
      buyer: n.buyers?.[0]?.officialName || 'EU Institution',
      country: n.buyers?.[0]?.country || country || 'EU',
      date: n.publicationDate || '',
      deadline: n.deadline || '',
      value: n.estimatedValue?.value ? `€${Math.round(n.estimatedValue.value).toLocaleString()}` : 'N/A',
      link: `https://ted.europa.eu/udl?uri=TED:NOTICE:${(n.publicationNumber||'').replace('/','-')}:TEXT:EN:HTML`,
    }));
  } catch (e) {
    console.warn('TED error:', e.message);
    return null;
  }
}

function formatTEDResults(results) {
  if (!results || results.length === 0) return '';
  const today = new Date().toLocaleDateString('mk-MK', { day:'2-digit', month:'2-digit', year:'numeric' });
  let ctx = `\n\n═══ РЕАЛНИ EU ТЕНДЕРИ — TED — ${today} ═══\n`;
  ctx += `КРИТИЧНО: Прикажи ги САМО овие реални тендери. НЕ измислувај нови.\n\n`;
  results.forEach((r, i) => {
    ctx += `ТЕНДЕР ${i+1}:\n  Наслов: ${r.title}\n  Купувач: ${r.buyer}\n  Земја: ${r.country}\n`;
    ctx += `  Објавен: ${r.date}\n`;
    if (r.deadline) ctx += `  Рок: ${r.deadline}\n`;
    ctx += `  Вредност: ${r.value}\n  Линк: ${r.link}\n\n`;
  });
  ctx += `═══ КРАЈ НА РЕАЛНИ РЕЗУЛТАТИ ═══\n`;
  ctx += `Прикажи ги горните тендери со нивните ТОЧНИ линкови. НЕ додавај фиктивни линкови.\n`;
  return ctx;
}

// ═══════════════════════════════════════════
// SERPER
// ═══════════════════════════════════════════
const TENDER_KEYWORDS = ['тендер','тендери','набавка','tender','tenderi','nabavka','procurement','bid','rfp','ausschreibung','ihale','przetarg','јавна набавка','javna nabavka'];
const AUCTION_KEYWORDS = ['лицитација','аукција','судска продажба','licitacija','aukcija','auction','licytacja','търг'];
const LEASING_KEYWORDS = ['лизинг','lizing','leasing','lease'];
const EVA_KEYWORDS = ['грант','грантови','фонд','eu фонд','ipard','grant','grantovi','fond','grants','funds','subsidy'];

function detectIntent(userText) {
  const lower = userText.toLowerCase();
  if (AUCTION_KEYWORDS.some(k => lower.includes(k))) return 'auction';
  if (LEASING_KEYWORDS.some(k => lower.includes(k))) return 'leasing';
  if (EVA_KEYWORDS.some(k => lower.includes(k))) return 'grants';
  if (TENDER_KEYWORDS.some(k => lower.includes(k))) return 'tender';
  return null;
}

function buildSerperQuery(userText, avatar, intent) {
  const lower = userText.toLowerCase();
  const month = new Date().toISOString().slice(0, 7);

  if (intent === 'auction') {
    const auctionSites = {
      'македонија': 'site:e-aukcii.ujp.gov.mk OR site:sud.mk',
      'македон': 'site:e-aukcii.ujp.gov.mk OR site:sud.mk',
      'srbija': 'site:uisug.rs OR site:sud.rs',
      'србија': 'site:uisug.rs OR site:sud.rs',
      'hrvatska': 'site:fine.hr OR site:e-aukcija.hr',
      'хрватска': 'site:fine.hr OR site:e-aukcija.hr',
    };
    let siteFilter = 'site:e-aukcii.ujp.gov.mk OR site:fine.hr OR site:uisug.rs';
    for (const [key, val] of Object.entries(auctionSites)) {
      if (lower.includes(key)) { siteFilter = val; break; }
    }
    let assetType = 'лицитација имот возило опрема';
    if (lower.match(/недвижност|апартман|куќа|имот|nekretnina|stan/)) assetType = 'лицитација недвижност';
    else if (lower.match(/возило|автомобил|камион|vozilo/)) assetType = 'лицитација возила';
    return `${assetType} ${month} ${siteFilter}`;
  }

  if (intent === 'leasing') {
    return `лизинг понуда ${month} site:sparkasse.mk OR site:stopanska.mk OR site:nlb.mk`;
  }

  if (intent === 'grants') {
    let grantType = 'EU грант фонд отворен конкурс';
    if (lower.match(/ipard|земјоделств|agri/)) grantType = 'IPARD грант земјоделство';
    else if (lower.match(/стартап|startup|иновац/)) grantType = 'EU грант стартап иновации';
    else if (lower.match(/нго|ngo|невладин/)) grantType = 'EU грант НВО';
    return `${grantType} ${month} рок за аплицирање Западен Балкан`;
  }

  // Tender — detect countries
  const countryMap = {
    'македонија': 'site:e-nabavki.gov.mk',
    'македон': 'site:e-nabavki.gov.mk',
    'srbija': 'site:portal.ujn.gov.rs',
    'србија': 'site:portal.ujn.gov.rs',
    'hrvatska': 'site:eojn.hr',
    'хрватска': 'site:eojn.hr',
    'bosna': 'site:ejn.ba',
  };

  // Multiple countries
  const siteFilters = [];
  for (const [key, val] of Object.entries(countryMap)) {
    if (lower.includes(key)) siteFilters.push(val);
  }
  const siteFilter = siteFilters.length > 0
    ? siteFilters.join(' OR ')
    : 'site:e-nabavki.gov.mk OR site:portal.ujn.gov.rs';

  let sector = 'јавна набавка';
  if (lower.match(/градеж|фасад|construction|fasad/)) sector = 'градежни работи фасада';
  else if (lower.match(/ит|software|digital/)) sector = 'IT услуги';
  else if (lower.match(/медицин|health|болниц/)) sector = 'медицинска опрема';

  return `${sector} тендер ${month} ${siteFilter}`;
}

async function searchSerper(query, serperKey) {
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey },
      body: JSON.stringify({ q: query, num: 8, gl: 'mk', hl: 'mk' }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const results = [];
    if (data.organic) data.organic.slice(0, 6).forEach(r => results.push({ title: r.title||'', snippet: r.snippet||'', link: r.link||'', date: r.date||'' }));
    if (data.news) data.news.slice(0, 3).forEach(r => results.push({ title: r.title||'', snippet: r.snippet||'', link: r.link||'', date: r.date||'' }));
    return results.length > 0 ? results : null;
  } catch (e) { return null; }
}

function formatSerperContext(results, intent) {
  if (!results || results.length === 0) return '';
  const today = new Date().toLocaleDateString('mk-MK', { day:'2-digit', month:'2-digit', year:'numeric' });
  const label = intent === 'auction' ? 'ЛИЦИТАЦИИ' : intent === 'leasing' ? 'ЛИЗИНГ' : intent === 'grants' ? 'ГРАНТОВИ' : 'ТЕНДЕРИ';
  let ctx = `\n\n═══ РЕАЛНИ ${label} — ${today} ═══\n`;
  ctx += `КРИТИЧНО: Прикажи САМО овие реални резултати со ТОЧНИТЕ линкови.\n`;
  ctx += `ЗАБРАНЕТО: Не додавај фиктивни линкови, не измислувај тендери, не генерирај примери.\n\n`;
  results.forEach((r, i) => {
    ctx += `РЕЗУЛТАТ ${i+1}:\n  Наслов: ${r.title}\n`;
    if (r.date) ctx += `  Датум: ${r.date}\n`;
    if (r.snippet) ctx += `  Опис: ${r.snippet}\n`;
    ctx += `  Линк: ${r.link}\n\n`;
  });
  ctx += `═══ КРАЈ НА РЕАЛНИ РЕЗУЛТАТИ ═══\n`;
  ctx += `Анализирај ги горните резултати. Ако некој резултат не е директно релевантен, кажи тоа.\n`;
  ctx += `Секогаш завршувај со ⚠️ disclaimer и линк до официјален портал.\n`;
  return ctx;
}

// ═══ NO RESULTS — кога нема наоди ═══
function formatNoResults(intent, lang) {
  const portals = {
    tender: 'e-nabavki.gov.mk · portal.ujn.gov.rs · ted.europa.eu',
    auction: 'e-aukcii.ujp.gov.mk · fine.hr · uisug.rs',
    grants: 'mk.undp.org · ec.europa.eu/info/funding-tenders · ipard.gov.mk',
    leasing: 'sparkasse.mk · stopanska.mk · nlb.mk',
  };
  const portal = portals[intent] || portals.tender;
  return `\n\n═══ НЕМА РЕАЛНИ РЕЗУЛТАТИ ═══\n` +
    `Пребарувањето не врати активни огласи за ова барање.\n` +
    `ЗАДОЛЖИТЕЛНО: Кажи му на корисникот дека нема реални резултати.\n` +
    `НЕ ИЗМИСЛУВАЈ тендери, линкови или примери!\n` +
    `Препорачај ги следниве официјални портали: ${portal}\n` +
    `═══════════════════════════════════════\n`;
}

// ═══ PREMIUM TRIGGERS ═══
const PREMIUM_TRIGGERS = [
  'најди грант','најди тендер','направи договор','правен совет','аплицирај',
  'nađi grant','nađi tender','napravi ugovor','pravni savet',
  'find grant','find tender','make contract','legal advice',
  'business plan','financial projection','find me a grant','apply for',
];
const PREMIUM_AVATARS = ['eva','tenderai','justinian','businessai','dropshipper'];

function isPremiumTrigger(message, avatar) {
  const lower = (message || '').toLowerCase();
  if (PREMIUM_AVATARS.includes(avatar)) {
    return PREMIUM_TRIGGERS.some(t => lower.includes(t));
  }
  return false;
}

async function generatePreview(systemPrompt, messages, apiKey, isMK) {
  const previewPrompt = systemPrompt + '\n\nВАЖНО: Дај само КРАТОК почеток (максимум 3 реченици). Не завршувај го одговорот.';
  const preview = await callGemini('gemini-2.5-flash', false, previewPrompt, messages, false, null, null, null, apiKey);
  const locked = isMK
    ? `\n\n---\n🔒 **За целосен одговор потребен е Premium план**\n\n**[⚡ Отклучи Premium →](#upgrade)**`
    : `\n\n---\n🔒 **Full answer requires Premium plan**\n\n**[⚡ Unlock Premium →](#upgrade)**`;
  return preview + locked;
}

// ═══ GEMINI API ═══
async function callGemini(model, useGrounding, systemPrompt, messages, hasImage, imageData, imageType, imageText, apiKey) {
  const isGemma = model.startsWith('gemma');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : String(m.content || '') }]
  }));

  if (hasImage && imageData) {
    const lastText = imageText || 'Please analyze this image carefully and respond helpfully.';
    const historyWithoutLast = contents.slice(0, -1);
    contents.length = 0;
    contents.push(...historyWithoutLast);
    contents.push({ role: 'user', parts: [{ inline_data: { mime_type: imageType || 'image/jpeg', data: imageData } }, { text: lastText }] });
  }

  const requestBody = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
    generationConfig: { maxOutputTokens: 2000, temperature: 0.4 }
  };

  if (useGrounding && !isGemma) requestBody.tools = [{ googleSearch: {} }];

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text();
    if (isGemma && (response.status === 404 || response.status === 400)) {
      console.warn('Gemma unavailable, fallback to Flash');
      return callGemini('gemini-2.5-flash', false, systemPrompt, messages, hasImage, imageData, imageType, imageText, apiKey);
    }
    throw new Error('API error ' + response.status + ': ' + errText.slice(0, 200));
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Gemini API error');

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';

  if (useGrounding && data.candidates?.[0]?.groundingMetadata?.groundingChunks?.length > 0) {
    const sources = data.candidates[0].groundingMetadata.groundingChunks
      .filter(c => c.web?.uri && !c.web.uri.includes('vertexaisearch'))
      .slice(0, 3)
      .map(c => {
        const title = c.web.title && !c.web.title.includes('vertexaisearch') ? c.web.title : new URL(c.web.uri).hostname.replace('www.', '');
        return '• [' + title + '](' + c.web.uri + ')';
      }).join('\n');
    if (sources) return text + '\n\n🔍 **Извори:**\n' + sources;
  }

  return text;
}

// ═══════════════════════════════════════════
// ГЛАВЕН HANDLER
// ═══════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
    const avatar = body.avatar || 'default';
    const hasImage = !!body.image;
    const systemPrompt = body.system || '';
    const userPlan = body.plan || 'free';

    const avatarConfig = getAvatarConfig(avatar);
    const model = avatarConfig.model;
    const useGrounding = avatarConfig.grounding;
    const useSerper = avatarConfig.serper && !!serperKey;

    const messages = (body.messages || []).slice(-20).map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content :
        Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ') :
        String(m.content)
    }));

    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const userText = (lastUserMsg && lastUserMsg.content) || '';
    const isMK = /[а-шА-Ш]/.test(userText);

    // Premium check
    if (userPlan === 'free' && isPremiumTrigger(userText, avatar)) {
      const previewText = await generatePreview(systemPrompt, messages, apiKey, isMK);
      return res.status(200).json({ content: [{ type: 'text', text: previewText }], premium_required: true, remaining_messages: limit.remaining });
    }

    let enrichedSystemPrompt = systemPrompt;

    // ═══ TENDER AI ═══
    if (useSerper && avatar === 'tenderai') {
      const intent = detectIntent(userText);
      if (intent) {
        let found = false;

        // TED first for tenders
        if (intent === 'tender') {
          const tedResults = await searchTED(userText);
          if (tedResults && tedResults.length > 0) {
            enrichedSystemPrompt = systemPrompt + formatTEDResults(tedResults);
            found = true;
            console.log('[tenderai] TED:', tedResults.length, 'results');
          }
        }

        // Serper for all intents or if TED failed
        if (!found) {
          const query = buildSerperQuery(userText, avatar, intent);
          console.log('[tenderai] Serper query:', query);
          const serperResults = await searchSerper(query, serperKey);
          if (serperResults && serperResults.length > 0) {
            enrichedSystemPrompt = systemPrompt + formatSerperContext(serperResults, intent);
            found = true;
            console.log('[tenderai] Serper:', serperResults.length, 'results');
          }
        }

        // No results found — tell Gemini explicitly
        if (!found) {
          enrichedSystemPrompt = systemPrompt + formatNoResults(intent, isMK ? 'mk' : 'en');
          console.log('[tenderai] No results found for intent:', intent);
        }
      }
    }

    // ═══ EVA ═══
    if (useSerper && avatar === 'eva') {
      const intent = detectIntent(userText);
      if (intent === 'grants' || intent === 'tender') {
        const query = buildSerperQuery(userText, 'eva', 'grants');
        const serperResults = await searchSerper(query, serperKey);
        if (serperResults && serperResults.length > 0) {
          enrichedSystemPrompt = systemPrompt + formatSerperContext(serperResults, 'grants');
          console.log('[eva] Serper:', serperResults.length, 'results');
        } else {
          enrichedSystemPrompt = systemPrompt + formatNoResults('grants', isMK ? 'mk' : 'en');
        }
      }
    }

    console.log(`[${avatar} + ${model}${useGrounding ? ' + Grounding' : ''}]`);

    const text = await callGemini(model, useGrounding, enrichedSystemPrompt, messages, hasImage, body.image, body.imageType, body.imageText, apiKey);

    return res.status(200).json({
      content: [{ type: 'text', text }],
      model_used: model,
      remaining_messages: limit.remaining
    });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
};
