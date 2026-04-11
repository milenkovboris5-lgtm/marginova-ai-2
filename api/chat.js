// ═══════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// Верзија: Hybrid v6 — Gemini + Grounding + Serper + TED API
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
  leo:         { model: 'gemma-4-27b-it',   grounding: false, serper: false },
  liber:       { model: 'gemma-4-27b-it',   grounding: false, serper: false },
  creativeai:  { model: 'gemma-4-27b-it',   grounding: false, serper: false },
  developer:   { model: 'gemma-4-27b-it',   grounding: false, serper: false },
  sophie:      { model: 'gemma-4-e4b-it',   grounding: false, serper: false },
  hanna:       { model: 'gemma-4-e4b-it',   grounding: false, serper: false },
  fitness:     { model: 'gemma-4-e4b-it',   grounding: false, serper: false },
  default:     { model: 'gemini-2.5-flash', grounding: false, serper: false },
};

function getAvatarConfig(avatar) {
  return AVATAR_MODEL_MAP[avatar] || AVATAR_MODEL_MAP.default;
}

// ═══════════════════════════════════════════
// TED API — EU ТЕНДЕРИ (ted.europa.eu)
// ═══════════════════════════════════════════

// Country codes for TED API
const TED_COUNTRY_MAP = {
  'македонија': 'MK', 'македон': 'MK', 'north macedonia': 'MK', 'mk': 'MK',
  'србија': 'RS', 'srbija': 'RS', 'serbia': 'RS',
  'хрватска': 'HR', 'hrvatska': 'HR', 'croatia': 'HR',
  'босна': 'BA', 'bosna': 'BA', 'bosnia': 'BA',
  'бугарија': 'BG', 'bulgaria': 'BG',
  'албанија': 'AL', 'albanija': 'AL', 'albania': 'AL',
  'турција': 'TR', 'türkiye': 'TR', 'turkey': 'TR',
  'полска': 'PL', 'polska': 'PL', 'poland': 'PL',
  'словенија': 'SI', 'slovenija': 'SI', 'slovenia': 'SI',
  'германија': 'DE', 'deutschland': 'DE', 'germany': 'DE',
};

// CPV codes for common sectors
const CPV_MAP = {
  'градеж': '45000000', 'construction': '45000000', 'bau': '45000000', 'inşaat': '45000000', 'budowl': '45000000',
  'it': '72000000', 'software': '72000000', 'digital': '72000000', 'yazılım': '72000000',
  'медицин': '33000000', 'health': '33000000', 'medical': '33000000', 'sağlık': '33000000', 'medyczn': '33000000',
  'образован': '80000000', 'education': '80000000', 'school': '80000000', 'eğitim': '80000000', 'edukacja': '80000000',
  'храна': '15000000', 'food': '15000000', 'gıda': '15000000', 'żywność': '15000000',
  'транспорт': '60000000', 'transport': '60000000', 'ulaşım': '60000000',
  'консалтинг': '73000000', 'consulting': '73000000', 'danışmanlık': '73000000',
  'опрема': '38000000', 'equipment': '38000000', 'ekipman': '38000000',
};

async function searchTED(userText) {
  try {
    const lower = userText.toLowerCase();

    // Detect country
    let country = null;
    for (const [key, code] of Object.entries(TED_COUNTRY_MAP)) {
      if (lower.includes(key)) { country = code; break; }
    }

    // Detect CPV sector
    let cpv = null;
    for (const [key, code] of Object.entries(CPV_MAP)) {
      if (lower.includes(key)) { cpv = code; break; }
    }

    // Build TED API query
    // TED API v3 — free, no auth needed
    const today = new Date();
    const fromDate = new Date(today);
    fromDate.setDate(today.getDate() - 30); // last 30 days

    let queryParts = [];
    if (country) queryParts.push(`buyers.country=${country}`);
    if (cpv) queryParts.push(`cpvs.code=${cpv}`);
    queryParts.push(`publicationDate>=${fromDate.toISOString().split('T')[0]}`);
    queryParts.push('query=*');

    const tedUrl = `https://ted.europa.eu/api/v3.0/notices/search?fields=publicationNumber,title,buyers,publicationDate,deadline,estimatedValue,cpvs,documents&pageSize=5&page=1&scope=ACTIVE&${queryParts.join('&')}`;

    const response = await fetch(tedUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Marginova-AI/1.0' }
    });

    if (!response.ok) {
      console.warn('TED API error:', response.status);
      return null;
    }

    const data = await response.json();
    if (!data.notices || data.notices.length === 0) return null;

    return data.notices.map(n => ({
      id: n.publicationNumber || '',
      title: (n.title && n.title.text) ? n.title.text : (typeof n.title === 'string' ? n.title : 'EU Tender'),
      buyer: (n.buyers && n.buyers[0] && n.buyers[0].officialName) ? n.buyers[0].officialName : 'EU Institution',
      country: (n.buyers && n.buyers[0] && n.buyers[0].country) ? n.buyers[0].country : country || 'EU',
      date: n.publicationDate || '',
      deadline: n.deadline || '',
      value: (n.estimatedValue && n.estimatedValue.value) ? `€${Math.round(n.estimatedValue.value).toLocaleString()}` : 'N/A',
      link: `https://ted.europa.eu/udl?uri=TED:NOTICE:${(n.publicationNumber||'').replace('/','-')}:TEXT:EN:HTML`,
    }));
  } catch (e) {
    console.warn('TED API fetch error:', e.message);
    return null;
  }
}

function formatTEDResults(results) {
  if (!results || results.length === 0) return '';
  const today = new Date().toLocaleDateString('mk-MK', { day:'2-digit', month:'2-digit', year:'numeric' });

  let ctx = `\n\n═══════════════════════════════════════\n`;
  ctx += `EU ТЕНДЕРИ — TED (ted.europa.eu) — ${today}\n`;
  ctx += `═══════════════════════════════════════\n`;
  ctx += `КРИТИЧНО: Ги имаш следниве РЕАЛНИ активни EU тендери.\n`;
  ctx += `МОРА да ги прикажеш во структуриран формат со линкови!\n\n`;

  results.forEach((r, i) => {
    ctx += `ТЕНДЕР ${i+1}:\n`;
    ctx += `  Наслов: ${r.title}\n`;
    ctx += `  Купувач: ${r.buyer}\n`;
    ctx += `  Земја: ${r.country}\n`;
    ctx += `  Објавен: ${r.date}\n`;
    if (r.deadline) ctx += `  Рок: ${r.deadline}\n`;
    ctx += `  Проценета вредност: ${r.value}\n`;
    ctx += `  Линк: ${r.link}\n\n`;
  });

  ctx += `═══════════════════════════════════════\n`;
  ctx += `Презентирај ги во формат:\n`;
  ctx += `🎯 [Наслов] — [Купувач] — [Вредност] — [Рок]\n`;
  ctx += `Линк: [url]\n`;
  ctx += `Секогаш завршувај со ⚠️ disclaimer.\n`;
  ctx += `═══════════════════════════════════════\n`;
  return ctx;
}

// ═══════════════════════════════════════════
// SERPER — ЛИЦИТАЦИИ И ЛИЗИНГ
// ═══════════════════════════════════════════

const TENDER_KEYWORDS = [
  'тендер','тендери','набавка','набавки','оглас','огласи','конкурс','аплицира',
  'tender','tenderi','nabavka','oglas','konkurs','aplicira',
  'procurement','bid','rfp','rfq','ausschreibung','ihale','przetarg',
];

const AUCTION_KEYWORDS = [
  'лицитација','лицитации','аукција','аукции','судска продажба',
  'licitacija','licitacije','aukcija','sudska prodaja',
  'auction','auctions','court sale','gerichtsauktion',
  'açık artırma','licytacja','търг','съдебна продан',
];

const LEASING_KEYWORDS = [
  'лизинг','лизинг откуп','финансиски лизинг',
  'lizing','lizing otkup','finansijski lizing',
  'leasing','lease','mietkauf','finansal kiralama','leasing finansowy',
];

const EVA_KEYWORDS = [
  'грант','грантови','фонд','фондови','eu фонд','ipard','ipa',
  'grant','grantovi','fond','fondovi','eu fond',
  'grants','funds','subsidy','förderung','hibe','dotacja',
];

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
    // Auction sites by country
    const auctionSites = {
      'македонија': 'site:e-aukcii.ujp.gov.mk OR site:sud.mk',
      'македон': 'site:e-aukcii.ujp.gov.mk OR site:sud.mk',
      'mk': 'site:e-aukcii.ujp.gov.mk OR site:sud.mk',
      'srbija': 'site:uisug.rs OR site:sud.rs',
      'србија': 'site:uisug.rs OR site:sud.rs',
      'hrvatska': 'site:fine.hr OR site:e-aukcija.hr',
      'хрватска': 'site:fine.hr OR site:e-aukcija.hr',
      'bosna': 'site:pravosudje.ba',
      'bугарија': 'site:bcpea.com OR site:justice.bg',
    };

    let siteFilter = 'site:e-aukcii.ujp.gov.mk OR site:fine.hr OR site:uisug.rs';
    for (const [key, val] of Object.entries(auctionSites)) {
      if (lower.includes(key)) { siteFilter = val; break; }
    }

    let assetType = 'лицитација имот возило опрема';
    if (lower.match(/недвижност|апартман|куќа|имот|real estate|nekretnina|stan/)) assetType = 'лицитација недвижност';
    else if (lower.match(/возило|автомобил|камион|vehicle|auto|vozilo/)) assetType = 'лицитација возила';
    else if (lower.match(/опрема|машина|equipment|oprema/)) assetType = 'лицитација опрема';

    return `${assetType} ${month} ${siteFilter}`;
  }

  if (intent === 'leasing') {
    const lower = userText.toLowerCase();
    let assetType = 'лизинг понуда';
    if (lower.match(/автомобил|vozilo|auto|car/)) assetType = 'лизинг автомобил понуда';
    else if (lower.match(/опрема|машина|equipment/)) assetType = 'лизинг опрема понуда';
    else if (lower.match(/недвижност|имот|real estate/)) assetType = 'лизинг недвижност';

    return `${assetType} ${month} site:sparkasse.mk OR site:stopanska.mk OR site:nlb.mk OR site:unicredit-leasing.mk`;
  }

  if (intent === 'grants' && avatar === 'eva') {
    let grantType = 'EU грант фонд отворен конкурс';
    if (lower.match(/ipard|земјоделств|agri/)) grantType = 'IPARD грант земјоделство';
    else if (lower.match(/стартап|startup|иновац/)) grantType = 'EU грант стартап иновации';
    else if (lower.match(/нго|ngo|невладин/)) grantType = 'EU грант НВО';
    return `${grantType} ${month} рок за аплицирање Западен Балкан`;
  }

  // Regular tender — use Serper on national portals
  const countryMap = {
    'македонија': 'site:e-nabavki.gov.mk OR site:ujp.gov.mk',
    'македон': 'site:e-nabavki.gov.mk OR site:ujp.gov.mk',
    'srbija': 'site:portal.ujn.gov.rs',
    'србија': 'site:portal.ujn.gov.rs',
    'hrvatska': 'site:eojn.hr',
    'хрватска': 'site:eojn.hr',
    'bosna': 'site:ejn.ba',
    'bугарија': 'site:appalti.bg',
    'albanija': 'site:pprc.rks-gov.net',
  };

  let siteFilter = 'site:e-nabavki.gov.mk OR site:portal.ujn.gov.rs';
  for (const [key, val] of Object.entries(countryMap)) {
    if (lower.includes(key)) { siteFilter = val; break; }
  }

  let sector = 'јавна набавка';
  if (lower.match(/градеж|construction|bau|inşaat|budowl/)) sector = 'градежни работи';
  else if (lower.match(/ит|software|digital/)) sector = 'IT услуги';
  else if (lower.match(/медицин|health|болниц/)) sector = 'медицинска опрема';
  else if (lower.match(/образован|school|училишт/)) sector = 'образование';
  else if (lower.match(/транспорт|transport/)) sector = 'транспорт';

  return `${sector} тендер ${month} ${siteFilter}`;
}

async function searchSerper(query, serperKey) {
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey },
      body: JSON.stringify({ q: query, num: 8, gl: 'mk', hl: 'mk' }),
    });
    if (!response.ok) { console.warn('Serper error:', response.status); return null; }
    const data = await response.json();
    const results = [];
    if (data.organic) data.organic.slice(0, 6).forEach(r => results.push({ title: r.title||'', snippet: r.snippet||'', link: r.link||'', date: r.date||'' }));
    if (data.news) data.news.slice(0, 3).forEach(r => results.push({ title: r.title||'', snippet: r.snippet||'', link: r.link||'', date: r.date||'' }));
    return results.length > 0 ? results : null;
  } catch (e) { console.warn('Serper error:', e.message); return null; }
}

function formatSerperContext(results, intent) {
  if (!results || results.length === 0) return '';
  const today = new Date().toLocaleDateString('mk-MK', { day:'2-digit', month:'2-digit', year:'numeric' });
  const label = intent === 'auction' ? 'ЛИЦИТАЦИИ' : intent === 'leasing' ? 'ЛИЗИНГ ПОНУДИ' : intent === 'grants' ? 'ГРАНТОВИ' : 'ТЕНДЕРИ';

  let ctx = `\n\n═══════════════════════════════════════\n`;
  ctx += `REAL-TIME ${label} — ${today}\n`;
  ctx += `═══════════════════════════════════════\n`;
  ctx += `КРИТИЧНО: Ги имаш следниве РЕАЛНИ резултати.\n`;
  ctx += `МОРА да ги прикажеш — НЕ генерирај генерички одговор!\n\n`;

  results.forEach((r, i) => {
    ctx += `РЕЗУЛТАТ ${i+1}:\n`;
    ctx += `  Наслов: ${r.title}\n`;
    if (r.date) ctx += `  Датум: ${r.date}\n`;
    if (r.snippet) ctx += `  Опис: ${r.snippet}\n`;
    ctx += `  Линк: ${r.link}\n\n`;
  });

  ctx += `═══════════════════════════════════════\n`;
  if (intent === 'auction') {
    ctx += `Анализирај ги резултатите и за секоја лицитација прикажи:\n`;
    ctx += `🏠 Имот/возило — 💵 Почетна цена — 📊 Вкупен трошок (цена+такси) — ⚠️ Due diligence — 🎯 Препорака\n`;
  } else if (intent === 'leasing') {
    ctx += `За секоја лизинг понуда прикажи:\n`;
    ctx += `📊 Месечна рата — 💰 Вкупен трошок — 🔄 vs Купување — ✅ Препорака\n`;
  } else {
    ctx += `За секој тендер прикажи: 🎯 Наслов — Институција — Вредност — Рок — Линк\n`;
  }
  ctx += `Секогаш завршувај со ⚠️ disclaimer.\n`;
  ctx += `═══════════════════════════════════════\n`;
  return ctx;
}

// ═══ PREMIUM TRIGGERS ═══
const PREMIUM_TRIGGERS = [
  'најди грант','најди тендер','направи договор','правен совет',
  'аплицирај','апликација за тендер','бизнис план','финансиска проекција',
  'nađi grant','nađi tender','napravi ugovor','pravni savet',
  'find grant','find tender','make contract','legal advice',
  'tender application','business plan','financial projection',
  'find me a grant','apply for','dropshipping product'
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

// ═══ ROUTER ═══
const ROUTER_AVATARS = ['marginova'];
const ADVANCED_INTENT_KEYWORDS = ['strategy','plan','analysis','стратегија','план','анализа','invest','инвестиција','раст','пазар'];
const BUSINESS_KEYWORDS = ['business','money','marketing','startup','бизнис','пари','маркетинг','invest','brand','sales','dropship','закон','law','grant'];
const EDUCATION_KEYWORDS = ['learn','study','language','english','учи','јазик','essay','book','quiz','german'];
const HEALTH_KEYWORDS = ['health','fitness','diet','stress','здравје','фитнес','диета','тренинг','food'];

function buildRouterResponse(category, userText) {
  const isMK = /[а-шА-Ш]/.test(userText);
  const msgs = {
    Business: isMK ? '📊 **Категорија: Бизнис**\n\n➡️ Зборувај со **Business AI**, **Justinian**, **Eva** или **Creative AI**.' : '📊 **Category: Business**\n\n➡️ Talk to **Business AI**, **Justinian**, **Eva** or **Creative AI**.',
    Education: isMK ? '🎓 **Категорија: Едукација**\n\n➡️ Зборувај со **Sophie**, **Leo** или **LIBER**.' : '🎓 **Category: Education**\n\n➡️ Talk to **Sophie**, **Leo** or **LIBER**.',
    Health: isMK ? '🌿 **Категорија: Здравје**\n\n➡️ Зборувај со **Viktor**.' : '🌿 **Category: Health**\n\n➡️ Talk to **Viktor**.'
  };
  return msgs[category] || msgs.Business;
}

// ═══════════════════════════════════════════
// GEMINI/GEMMA API
// ═══════════════════════════════════════════
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
    generationConfig: { maxOutputTokens: 2000, temperature: 0.5 }
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
    const avatar = body.avatar || 'marginova';
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

    // Router
    if (ROUTER_AVATARS.includes(avatar) && messages.length > 0) {
      const wordCount = userText.trim().split(/\s+/).length;
      if (wordCount >= 8) {
        const lower = userText.toLowerCase();
        if (ADVANCED_INTENT_KEYWORDS.some(k => lower.includes(k))) {
          let biz = 0, edu = 0, health = 0;
          BUSINESS_KEYWORDS.forEach(k => { if (lower.includes(k)) biz++; });
          EDUCATION_KEYWORDS.forEach(k => { if (lower.includes(k)) edu++; });
          HEALTH_KEYWORDS.forEach(k => { if (lower.includes(k)) health++; });
          const max = Math.max(biz, edu, health);
          if (max >= 2) {
            const category = biz === max ? 'Business' : edu === max ? 'Education' : 'Health';
            return res.status(200).json({ content: [{ type: 'text', text: buildRouterResponse(category, userText) }], routed: true, remaining_messages: limit.remaining });
          }
        }
      }
    }

    // ═══ TENDER AI — SMART ROUTING ═══
    let enrichedSystemPrompt = systemPrompt;
    let sourceUsed = null;

    if (useSerper && avatar === 'tenderai') {
      const intent = detectIntent(userText);

      if (intent === 'tender' || intent === 'auction' || intent === 'leasing' || intent === 'grants') {

        // Try TED API first for EU tenders
        if (intent === 'tender') {
          const tedResults = await searchTED(userText);
          if (tedResults && tedResults.length > 0) {
            enrichedSystemPrompt = systemPrompt + formatTEDResults(tedResults);
            sourceUsed = 'TED';
            console.log('[tenderai] TED API: ' + tedResults.length + ' results');
          }
        }

        // Use Serper for auctions, leasing, grants, or if TED found nothing
        if (!sourceUsed) {
          const query = buildSerperQuery(userText, avatar, intent);
          console.log('[tenderai] Serper query:', query);
          const serperResults = await searchSerper(query, serperKey);
          if (serperResults && serperResults.length > 0) {
            enrichedSystemPrompt = systemPrompt + formatSerperContext(serperResults, intent);
            sourceUsed = 'Serper';
            console.log('[tenderai] Serper: ' + serperResults.length + ' results (' + intent + ')');
          }
        }
      }
    }

    // Eva — grants search
    if (useSerper && avatar === 'eva') {
      const intent = detectIntent(userText);
      if (intent === 'grants' || intent === 'tender') {
        const query = buildSerperQuery(userText, 'eva', intent || 'grants');
        const serperResults = await searchSerper(query, serperKey);
        if (serperResults && serperResults.length > 0) {
          enrichedSystemPrompt = systemPrompt + formatSerperContext(serperResults, 'grants');
          sourceUsed = 'Serper';
          console.log('[eva] Serper: ' + serperResults.length + ' results');
        }
      }
    }

    const logLabel = [avatar, model, useGrounding ? 'Grounding' : null, sourceUsed, 'plan:' + userPlan].filter(Boolean).join(' + ');
    console.log('[' + logLabel + ']');

    const text = await callGemini(model, useGrounding, enrichedSystemPrompt, messages, hasImage, body.image, body.imageType, body.imageText, apiKey);

    return res.status(200).json({ content: [{ type: 'text', text: text }], model_used: model, remaining_messages: limit.remaining });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
};
