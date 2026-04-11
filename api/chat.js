// ═══════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// Верзија: Hybrid v5 — Gemini + Gemma 4 + Grounding + Serper Real-Time
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
  const count = rateLimitStore[key].count;
  return {
    allowed: count <= DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - count)
  };
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
// SERPER REAL-TIME SEARCH
// ═══════════════════════════════════════════
const SERPER_TRIGGER_KEYWORDS = [
  'тендер','тендери','лицитација','лицитации','оглас','огласи','набавка','набавки',
  'грант','грантови','фонд','фондови','конкурс','аплицира',
  'tender','tenderi','licitacija','licitacije','oglas','oglasi','nabavka',
  'grant','grantovi','fond','fondovi','konkurs','aplicira',
  'auction','auctions','procurement','grants','funds','bid','rfp','apply',
  'ausschreibung','auktion','förderung','fördermittel',
  'ihale','ihaleler','hibe','fon','tedarik',
  'przetarg','licytacja','dotacja','fundusze',
];

function needsSerperSearch(userText, avatar) {
  if (!['tenderai', 'eva'].includes(avatar)) return false;
  const lower = userText.toLowerCase();
  return SERPER_TRIGGER_KEYWORDS.some(k => lower.includes(k));
}

function buildSerperQuery(userText, avatar) {
  const lower = userText.toLowerCase();
  const today = new Date().toISOString().split('T')[0];
  const month = today.slice(0, 7);

  if (avatar === 'tenderai') {
    const countryMap = {
      'македонија': 'site:e-nabavki.gov.mk OR site:ujp.gov.mk',
      'македон': 'site:e-nabavki.gov.mk OR site:ujp.gov.mk',
      'mk': 'site:e-nabavki.gov.mk OR site:ujp.gov.mk',
      'srbija': 'site:portal.ujn.gov.rs OR site:e-javnenabavke.gov.rs',
      'србија': 'site:portal.ujn.gov.rs OR site:e-javnenabavke.gov.rs',
      'hrvatska': 'site:eojn.hr',
      'хрватска': 'site:eojn.hr',
      'bosna': 'site:ejn.ba',
      'босна': 'site:ejn.ba',
      'bугарија': 'site:appalti.bg OR site:rop.bg',
      'albanija': 'site:pprc.rks-gov.net',
      'eu': 'site:ted.europa.eu',
      'европ': 'site:ted.europa.eu',
      'europe': 'site:ted.europa.eu',
      'türkiye': 'site:ekap.kik.gov.tr',
      'turkey': 'site:ekap.kik.gov.tr',
      'polska': 'site:ted.europa.eu',
      'poland': 'site:ted.europa.eu',
    };

    let siteFilter = 'site:e-nabavki.gov.mk OR site:ted.europa.eu OR site:portal.ujn.gov.rs';
    for (const [key, val] of Object.entries(countryMap)) {
      if (lower.includes(key)) { siteFilter = val; break; }
    }

    let sector = 'јавна набавка';
    if (lower.match(/градеж|construction|bau|inşaat|budowl/)) sector = 'градежни работи';
    else if (lower.match(/ит|software|digital|yazılım/)) sector = 'IT услуги';
    else if (lower.match(/медицин|health|болниц|sağlık|zdrowie/)) sector = 'медицинска опрема';
    else if (lower.match(/образован|school|училишт|eğitim|edukacja/)) sector = 'образование';
    else if (lower.match(/храна|food|gıda|żywność/)) sector = 'прехранбени производи';
    else if (lower.match(/транспорт|transport|ulaşım|transport/)) sector = 'транспорт';
    else if (lower.match(/лицитаци|auction|açık artırma|licytacja/)) sector = 'лицитација имот возила';

    return `${sector} тендер ${month} ${siteFilter}`;
  }

  if (avatar === 'eva') {
    let grantType = 'EU грант фонд отворен конкурс';
    if (lower.match(/ipard|земјоделств|agri|tarım|rolnic/)) grantType = 'IPARD грант земјоделство';
    else if (lower.match(/ipa|претпристапн/)) grantType = 'IPA фонд';
    else if (lower.match(/стартап|startup|иновац|girişim|startup/)) grantType = 'EU грант стартап иновации';
    else if (lower.match(/нго|ngo|невладин|sivil toplum/)) grantType = 'EU грант НВО';
    else if (lower.match(/мал.*бизнис|sme|küçük işletme|małe firmy/)) grantType = 'EU фонд МСП';
    else if (lower.match(/жен|women|kadın|kobiety/)) grantType = 'EU грант жени претприемачи';
    return `${grantType} ${month} рок за аплицирање Западен Балкан Македонија`;
  }

  return userText + ' тендер ' + month;
}

async function searchSerper(query, serperKey) {
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': serperKey,
      },
      body: JSON.stringify({ q: query, num: 8, gl: 'mk', hl: 'mk' }),
    });

    if (!response.ok) {
      console.warn('Serper error:', response.status);
      return null;
    }

    const data = await response.json();
    const results = [];

    if (data.organic) {
      data.organic.slice(0, 6).forEach(r => {
        results.push({ title: r.title||'', snippet: r.snippet||'', link: r.link||'', date: r.date||'' });
      });
    }
    if (data.news) {
      data.news.slice(0, 3).forEach(r => {
        results.push({ title: r.title||'', snippet: r.snippet||'', link: r.link||'', date: r.date||'' });
      });
    }

    return results.length > 0 ? results : null;
  } catch (e) {
    console.warn('Serper fetch error:', e.message);
    return null;
  }
}

function formatSerperContext(results, avatar) {
  if (!results || results.length === 0) return '';
  const today = new Date().toLocaleDateString('mk-MK', { day:'2-digit', month:'2-digit', year:'numeric' });

  let ctx = `\n\n═══════════════════════════════════════\n`;
  ctx += `REAL-TIME ПРЕБАРУВАЊЕ — ${today}\n`;
  ctx += `═══════════════════════════════════════\n`;
  ctx += `КРИТИЧНО: Ги имаш следниве РЕАЛНИ резултати од интернет пребарување.\n`;
  ctx += `МОРА да ги прикажеш овие конкретни резултати во твојот одговор.\n`;
  ctx += `НЕ генерирај генерички одговор — користи ги ОВИЕ реални податоци!\n\n`;

  results.forEach((r, i) => {
    ctx += `РЕЗУЛТАТ ${i+1}:\n`;
    ctx += `  Наслов: ${r.title}\n`;
    if (r.date) ctx += `  Датум: ${r.date}\n`;
    if (r.snippet) ctx += `  Опис: ${r.snippet}\n`;
    ctx += `  Линк: ${r.link}\n\n`;
  });

  ctx += `═══════════════════════════════════════\n`;

  if (avatar === 'tenderai') {
    ctx += `ИНСТРУКЦИИ ЗА ОДГОВОР:\n`;
    ctx += `1. Прикажи ги горните резултати во формат 🎯 Можности\n`;
    ctx += `2. За секој резултат наведи: Назив — Институција — Линк\n`;
    ctx += `3. Ако резултатите се стари или нема активни, кажи тоа ЈАСНО\n`;
    ctx += `4. Секогаш завршувај со ⚠️ disclaimer\n`;
    ctx += `НЕ измислувај тендери кои не се во горните резултати!\n`;
  } else if (avatar === 'eva') {
    ctx += `ИНСТРУКЦИИ ЗА ОДГОВОР:\n`;
    ctx += `1. Прикажи ги горните резултати во формат 🎯 Достапни грантови\n`;
    ctx += `2. За секој грант наведи: Назив — Донатор — Линк — Датум\n`;
    ctx += `3. Ако резултатите се стари, кажи тоа ЈАСНО\n`;
    ctx += `4. Секогаш завршувај со ⚠️ disclaimer\n`;
    ctx += `НЕ измислувај грантови кои не се во горните резултати!\n`;
  }

  ctx += `═══════════════════════════════════════\n`;
  return ctx;
}

// ═══ PREMIUM TRIGGERS ═══
const PREMIUM_TRIGGERS = [
  'најди грант','најди тендер','направи договор','правен совет','eu фонд',
  'аплицирај','апликација за тендер','бизнис план','финансиска проекција',
  'dropshipping производ','last minute','патување понуда',
  'nađi grant','nađi tender','napravi ugovor','pravni savet','eu fond',
  'aplikacija za tender','biznis plan','finansijska projekcija',
  'find grant','find tender','make contract','legal advice','eu fund',
  'tender application','business plan','financial projection',
  'find me a grant','apply for','dropshipping product'
];

const PREMIUM_AVATARS = ['eva','tenderai','justinian','businessai','dropshipper','travelai'];

function isPremiumTrigger(message, avatar) {
  const lower = (message || '').toLowerCase();
  if (PREMIUM_AVATARS.includes(avatar)) {
    return PREMIUM_TRIGGERS.some(t => lower.includes(t));
  }
  return false;
}

// ═══ PREVIEW ═══
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
const ADVANCED_INTENT_KEYWORDS = [
  'strategy','plan','analysis','analyze','стратегија','план','анализа',
  'how to grow','invest','инвестиција','раст','пазар','revenue','приход'
];
const BUSINESS_KEYWORDS = [
  'business','money','marketing','startup','бизнис','пари','маркетинг',
  'invest','brand','sales','dropship','ecommerce','закон','law','grant','договор'
];
const EDUCATION_KEYWORDS = [
  'learn','study','language','english','учи','јазик','essay','book','quiz','german'
];
const HEALTH_KEYWORDS = [
  'health','fitness','diet','stress','здравје','фитнес','диета','тренинг','food'
];

function buildRouterResponse(category, userText) {
  const isMK = /[а-шА-Ш]/.test(userText);
  const msgs = {
    Business: isMK ? '📊 **Категорија: Бизнис**\n\n➡️ Зборувај со **Business AI**, **Justinian**, **Eva** или **Creative AI**.' : '📊 **Category: Business**\n\n➡️ Talk to **Business AI**, **Justinian**, **Eva** or **Creative AI**.',
    Education: isMK ? '🎓 **Категорија: Едукација**\n\n➡️ Зборувај со **Sophie**, **Leo** или **LIBER**.' : '🎓 **Category: Education**\n\n➡️ Talk to **Sophie**, **Leo** or **LIBER**.',
    Health: isMK ? '🌿 **Категорија: Здравје**\n\n➡️ Зборувај со **Viktor**.' : '🌿 **Category: Health**\n\n➡️ Talk to **Viktor**.'
  };
  return (msgs[category] || msgs.Business);
}

// ═══════════════════════════════════════════
// GEMINI/GEMMA API
// ═══════════════════════════════════════════
async function callGemini(model, useGrounding, systemPrompt, messages, hasImage, imageData, imageType, imageText, apiKey) {
  const isGemma = model.startsWith('gemma');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;

  const contents = messages.map(function(m) {
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : String(m.content || '') }]
    };
  });

  if (hasImage && imageData) {
    const lastText = imageText || 'Please analyze this image carefully and respond helpfully.';
    const historyWithoutLast = contents.slice(0, -1);
    contents.length = 0;
    contents.push.apply(contents, historyWithoutLast);
    contents.push({
      role: 'user',
      parts: [
        { inline_data: { mime_type: imageType || 'image/jpeg', data: imageData } },
        { text: lastText }
      ]
    });
  }

  const requestBody = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
    generationConfig: { maxOutputTokens: 2000, temperature: 0.5 }
  };

  if (useGrounding && !isGemma) {
    requestBody.tools = [{ googleSearch: {} }];
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text();
    if (isGemma && (response.status === 404 || response.status === 400)) {
      console.warn('Gemma model unavailable, falling back to gemini-2.5-flash:', model);
      return callGemini('gemini-2.5-flash', false, systemPrompt, messages, hasImage, imageData, imageType, imageText, apiKey);
    }
    throw new Error('API error ' + response.status + ': ' + errText.slice(0, 200));
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Gemini API error');

  const text = (
    data.candidates?.[0]?.content?.parts?.[0]?.text
  ) || 'No response generated.';

  if (useGrounding && data.candidates?.[0]?.groundingMetadata?.groundingChunks?.length > 0) {
    const sources = data.candidates[0].groundingMetadata.groundingChunks
      .filter(c => c.web && c.web.uri)
      .filter(c => !c.web.uri.includes('vertexaisearch') && !c.web.title?.toLowerCase().includes('current time'))
      .slice(0, 3)
      .map(c => {
        const title = c.web.title && !c.web.title.includes('vertexaisearch')
          ? c.web.title
          : new URL(c.web.uri).hostname.replace('www.', '');
        return '• [' + title + '](' + c.web.uri + ')';
      })
      .join('\n');
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
  if (!limit.allowed) {
    return res.status(429).json({ error: { message: 'Дневниот лимит е достигнат. Обидете се утре.' } });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'Server misconfiguration: missing GEMINI_API_KEY.' } });

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

    const messages = (body.messages || []).slice(-20).map(function(m) {
      return {
        role: m.role,
        content: typeof m.content === 'string' ? m.content :
          Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ') :
          String(m.content)
      };
    });

    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const userText = (lastUserMsg && lastUserMsg.content) || '';
    const isMK = /[а-шА-Ш]/.test(userText);

    // Premium check
    if (userPlan === 'free' && isPremiumTrigger(userText, avatar)) {
      const previewText = await generatePreview(systemPrompt, messages, apiKey, isMK);
      return res.status(200).json({
        content: [{ type: 'text', text: previewText }],
        premium_required: true,
        trigger: 'upgrade_popup',
        remaining_messages: limit.remaining
      });
    }

    // Router
    if (ROUTER_AVATARS.includes(avatar) && messages.length > 0) {
      const wordCount = userText.trim().split(/\s+/).length;
      if (wordCount >= 8) {
        const lower = userText.toLowerCase();
        const isAdvanced = ADVANCED_INTENT_KEYWORDS.some(k => lower.includes(k));
        if (isAdvanced) {
          let biz = 0, edu = 0, health = 0;
          BUSINESS_KEYWORDS.forEach(k => { if (lower.includes(k)) biz++; });
          EDUCATION_KEYWORDS.forEach(k => { if (lower.includes(k)) edu++; });
          HEALTH_KEYWORDS.forEach(k => { if (lower.includes(k)) health++; });
          const max = Math.max(biz, edu, health);
          if (max >= 2) {
            const category = biz === max ? 'Business' : edu === max ? 'Education' : 'Health';
            return res.status(200).json({
              content: [{ type: 'text', text: buildRouterResponse(category, userText) }],
              routed: true,
              remaining_messages: limit.remaining
            });
          }
        }
      }
    }

    // ═══ SERPER REAL-TIME SEARCH ═══
    let enrichedSystemPrompt = systemPrompt;
    let serperUsed = false;

    if (useSerper && needsSerperSearch(userText, avatar)) {
      const query = buildSerperQuery(userText, avatar);
      console.log('[' + avatar + '] Serper query:', query);
      const serperResults = await searchSerper(query, serperKey);
      if (serperResults && serperResults.length > 0) {
        enrichedSystemPrompt = systemPrompt + formatSerperContext(serperResults, avatar);
        serperUsed = true;
        console.log('[' + avatar + '] Serper: ' + serperResults.length + ' results injected');
      } else {
        console.log('[' + avatar + '] Serper: no results');
      }
    }

    const logLabel = [
      avatar,
      model,
      useGrounding ? 'Grounding' : null,
      serperUsed ? 'Serper' : null,
      'plan:' + userPlan
    ].filter(Boolean).join(' + ');
    console.log('[' + logLabel + ']');

    const text = await callGemini(
      model, useGrounding, enrichedSystemPrompt, messages,
      hasImage, body.image, body.imageType, body.imageText, apiKey
    );

    return res.status(200).json({
      content: [{ type: 'text', text: text }],
      model_used: model,
      remaining_messages: limit.remaining
    });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
};
