// ═══════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// Верзија: Hybrid v3 — Gemini + Gemma 4 + Grounding
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
  // Gemini 2.5 Flash + Search Grounding
  eva:         { model: 'gemini-2.5-flash', grounding: true  },
  tenderai:    { model: 'gemini-2.5-flash', grounding: true  },
  dropshipper: { model: 'gemini-2.5-flash', grounding: true  },
  businessai:  { model: 'gemini-2.5-flash', grounding: true  },
  justinian:   { model: 'gemini-2.5-flash', grounding: true  },

  // Gemma 4 27B (fallback: Gemini Flash)
  leo:         { model: 'gemma-4-27b-it',   grounding: false },
  liber:       { model: 'gemma-4-27b-it',   grounding: false },
  creativeai:  { model: 'gemma-4-27b-it',   grounding: false },
  developer:   { model: 'gemma-4-27b-it',   grounding: false },

  // Gemma 4 E4B (fallback: Gemini Flash)
  sophie:      { model: 'gemma-4-e4b-it',   grounding: false },
  hanna:       { model: 'gemma-4-e4b-it',   grounding: false },
  fitness:     { model: 'gemma-4-e4b-it',   grounding: false },

  default:     { model: 'gemini-2.5-flash', grounding: false },
};

function getAvatarConfig(avatar) {
  return AVATAR_MODEL_MAP[avatar] || AVATAR_MODEL_MAP.default;
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
  const previewPrompt = systemPrompt + '\n\nВАЖНО: Дај само КРАТОК почеток на одговорот (максимум 3 реченици, 20% од целосниот одговор). Не завршувај го одговорот. Запри на интересно место.';
  const preview = await callGemini('gemini-2.5-flash', false, previewPrompt, messages, false, null, null, null, apiKey);

  const locked = isMK
    ? `\n\n---\n🔒 **За целосен одговор потребен е Premium план**\n\nОвој одговор содржи:\n• Листа на активни грантови/тендери\n• Чекор-по-чекор водич за апликација\n• Конкретни суми и рокови\n\n**[⚡ Отклучи Premium →](#upgrade)**`
    : `\n\n---\n🔒 **Full answer requires Premium plan**\n\nThis answer includes:\n• List of active grants/tenders\n• Step-by-step application guide\n• Specific amounts and deadlines\n\n**[⚡ Unlock Premium →](#upgrade)**`;

  return preview + locked;
}

// ═══ ROUTER ═══
const ROUTER_AVATARS = ['marginova'];

const ADVANCED_INTENT_KEYWORDS = [
  'strategy','plan','analysis','analyze','step by step','detailed',
  'стратегија','план','анализа','чекор по чекор','детално',
  'strategija','analiza','korak po korak','detaljno',
  'how to grow','how to scale','invest','инвестиција','раст',
  'compete','конкуренција','market','пазар','revenue','приход'
];

const BUSINESS_KEYWORDS = [
  'business','money','marketing','startup','strategy','revenue','profit',
  'бизнис','пари','маркетинг','стартап','стратегија','приход','профит',
  'invest','инвестиција','brand','sales','продажба','клиент','client',
  'dropship','ecommerce','shop','продавница','закон','law','legal',
  'eu fond','grant','договор','contract'
];

const EDUCATION_KEYWORDS = [
  'learn','study','language','english','course','skill','knowledge',
  'учи','јазик','курс','вештина','знаење','образование','essay',
  'book','книга','quiz','тест','exam','испит','german','deutsch',
  'write','пишувај','homework','домашна','school','училиште'
];

const HEALTH_KEYWORDS = [
  'health','fitness','diet','stress','sleep','workout','wellness',
  'здравје','фитнес','диета','стрес','спиење','тренинг',
  'food','храна','meditation','медитација','anxiety','анксиозност'
];

function buildRouterResponse(category, userText) {
  const isMK = /[а-шА-Ш]/.test(userText);
  const msgs = {
    Business: isMK
      ? '📊 **Категорија: Бизнис**\n\n➡️ Зборувај со **Business AI**, **Justinian**, **Eva** или **Creative AI**.'
      : '📊 **Category: Business**\n\n➡️ Talk to **Business AI**, **Justinian**, **Eva** or **Creative AI**.',
    Education: isMK
      ? '🎓 **Категорија: Едукација**\n\n➡️ Зборувај со **Sophie**, **Leo** или **LIBER**.'
      : '🎓 **Category: Education**\n\n➡️ Talk to **Sophie**, **Leo** or **LIBER**.',
    Health: isMK
      ? '🌿 **Категорија: Здравје**\n\n➡️ Зборувај со **Viktor**.'
      : '🌿 **Category: Health**\n\n➡️ Talk to **Viktor**.'
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
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
    generationConfig: {
      maxOutputTokens: 1500,
      temperature: 0.7
    }
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
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text
  ) || 'No response generated.';

  // Grounding sources
  if (useGrounding && data.candidates && data.candidates[0] && data.candidates[0].groundingMetadata) {
    const meta = data.candidates[0].groundingMetadata;
    if (meta.groundingChunks && meta.groundingChunks.length > 0) {
      const sources = meta.groundingChunks
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
      if (sources) {
        return text + '\n\n🔍 **Извори:**\n' + sources;
      }
    }
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
    return res.status(429).json({
      error: { message: 'Дневниот лимит е достигнат. Обидете се утре.' }
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'Server misconfiguration: missing GEMINI_API_KEY.' } });
  }

  try {
    const body = req.body;
    const avatar = body.avatar || 'marginova';
    const hasImage = !!body.image;
    const systemPrompt = body.system || '';
    const userPlan = body.plan || 'free';

    const avatarConfig = getAvatarConfig(avatar);
    const model = avatarConfig.model;
    const useGrounding = avatarConfig.grounding;

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

    console.log('[' + avatar + '] → ' + model + (useGrounding ? ' + Grounding' : '') + ' | plan:' + userPlan);

    const text = await callGemini(
      model, useGrounding, systemPrompt, messages,
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
