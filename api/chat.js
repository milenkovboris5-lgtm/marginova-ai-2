// ═══════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// Верзија: Premium Strategy v2
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

// ═══ PREMIUM TRIGGER ЗБОРОВИ ═══
const PREMIUM_TRIGGERS = [
  // MK
  'најди грант','најди тендер','направи договор','правен совет','eu фонд',
  'аплицирај','апликација за тендер','бизнис план','финансиска проекција',
  'dropshipping производ','last minute','патување понуда',
  // SR
  'nađi grant','nađi tender','napravi ugovor','pravni savet','eu fond',
  'aplikacija za tender','biznis plan','finansijska projekcija',
  // EN
  'find grant','find tender','make contract','legal advice','eu fund',
  'tender application','business plan','financial projection',
  'find me a grant','apply for','dropshipping product'
];

// ═══ АВАТАРИ КОИ БАРААТ PREMIUM ═══
const PREMIUM_AVATARS = ['eva','tenderai','justinian','businessai','dropshipper','travelai'];

// ═══ ПЛАНОВИ И ЛИМИТИ ═══
const PLAN_LIMITS = {
  free:    { monthly: 50,   daily: null },
  pro:     { monthly: 1500, daily: null },
  premium: { monthly: 5000, daily: null },
  ultra:   { monthly: null, daily: null } // неограничено
};

// ═══ ПРОВЕРИ ДАЛИ Е PREMIUM TRIGGER ═══
function isPremiumTrigger(message, avatar) {
  const lower = (message || '').toLowerCase();
  if (PREMIUM_AVATARS.includes(avatar)) {
    return PREMIUM_TRIGGERS.some(t => lower.includes(t));
  }
  return false;
}

// ═══ ГЕНЕРИРАЈ 20% PREVIEW ОДГОВОР ═══
async function generatePreview(systemPrompt, messages, apiKey, isMK) {
  const previewPrompt = systemPrompt + '\n\nВАЖНО: Дај само КРАТОК почеток на одговорот (максимум 3 реченици, 20% од целосниот одговор). Не завршувај го одговорот. Запри на интересно место.';
  const preview = await callGemini(previewPrompt, messages, false, null, null, null, apiKey);

  const locked = isMK
    ? `\n\n---\n🔒 **За целосен одговор потребен е Premium план**\n\nОвој одговор содржи:\n• Листа на активни грантови/тендери\n• Чекор-по-чекор водич за апликација\n• Конкретни суми и рокови\n\n**[⚡ Отклучи Premium →](#upgrade)** &nbsp; *или* &nbsp; **[Продолжи бесплатно ↓](#continue)**`
    : `\n\n---\n🔒 **Full answer requires Premium plan**\n\nThis answer includes:\n• List of active grants/tenders\n• Step-by-step application guide\n• Specific amounts and deadlines\n\n**[⚡ Unlock Premium →](#upgrade)** &nbsp; *or* &nbsp; **[Continue free ↓](#continue)**`;

  return preview + locked;
}

// ═══ ROUTER АВАТАРИ ═══
const ROUTER_AVATARS = ['marginova'];

const ADVANCED_INTENT_KEYWORDS = [
  'strategy', 'plan', 'analysis', 'analyze', 'step by step', 'detailed',
  'стратегија', 'план', 'анализа', 'чекор по чекор', 'детално',
  'strategija', 'analiza', 'korak po korak', 'detaljno',
  'how to grow', 'how to scale', 'invest', 'инвестиција', 'раст',
  'compete', 'конкуренција', 'market', 'пазар', 'revenue', 'приход'
];

const BUSINESS_KEYWORDS = [
  'business','money','marketing','startup','strategy','revenue','profit',
  'бизнис','пари','маркетинг','стартап','стратегија','приход','профит',
  'invest','инвестиција','brand','sales','продажба','клиент','client',
  'dropship','ecommerce','shop','продавница','закон','law','legal',
  'eu fond','grant','договор','contract','travel deal','туризам'
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
  'food','храна','recipe','рецепт','meditation','медитација',
  'dream','сон','mindfulness','anxiety','анксиозност'
];

function buildRouterResponse(category, userText) {
  const isMK = /[а-шА-Ш]/.test(userText);
  const msgs = {
    Business: isMK
      ? '📊 **Категорија: Бизнис**\n\n➡️ За најдобар одговор, зборувај со **Business AI**, **Justinian**, **Eva** или **Creative AI**.'
      : '📊 **Category: Business**\n\n➡️ Talk to **Business AI**, **Justinian**, **Eva** or **Creative AI** for the best answer.',
    Education: isMK
      ? '🎓 **Категорија: Едукација**\n\n➡️ За најдобар одговор, зборувај со **AI Mentor**, **Sophie**, **Leo** или **LIBER**.'
      : '🎓 **Category: Education**\n\n➡️ Talk to **AI Mentor**, **Sophie**, **Leo** or **LIBER** for the best answer.',
    Health: isMK
      ? '🌿 **Категорија: Здравје**\n\n➡️ За најдобар одговор, зборувај со **Ana**, **Viktor** или **Luna**.'
      : '🌿 **Category: Health**\n\n➡️ Talk to **Ana**, **Viktor** or **Luna** for the best answer.'
  };
  const upsell = isMK
    ? '\n\n🔒 **Отклучи детален план** со надградба на Pro.'
    : '\n\n🔒 **Unlock full plan** by upgrading to Pro.';
  return (msgs[category] || msgs.Business) + upsell;
}

async function callGemini(systemPrompt, messages, hasImage, imageData, imageType, imageText, apiKey) {
  const model = 'gemini-2.5-flash';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;

  const contents = messages.map(function(m) {
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : String(m.content || '') }]
    };
  });

  if (hasImage) {
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

  var contentsWithSystem;
  if (contents.length > 0) {
    contentsWithSystem = [
      { role: 'user', parts: [{ text: systemPrompt + '\n\n' }].concat(contents[0].parts) }
    ].concat(contents.slice(1));
  } else {
    contentsWithSystem = [{ role: 'user', parts: [{ text: systemPrompt }] }];
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: contentsWithSystem,
      generationConfig: { maxOutputTokens: 1500, temperature: 0.7 }
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Gemini API error');
  return (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text) || 'No response generated.';
}

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
    return res.status(500).json({ error: { message: 'Server misconfiguration.' } });
  }

  try {
    const body = req.body;
    const avatar = body.avatar || 'marginova';
    const hasImage = !!body.image;
    const systemPrompt = body.system || '';
    const userPlan = body.plan || 'free'; // ќе дојде од Supabase преку index.html

    const messages = (body.messages || []).slice(-20).map(function(m) {
      return {
        role: m.role,
        content: typeof m.content === 'string' ? m.content :
          Array.isArray(m.content) ? m.content.filter(function(c) { return c.type === 'text'; }).map(function(c) { return c.text; }).join(' ') :
          String(m.content)
      };
    });

    // ═══ ПРОВЕРИ ДАЛИ Е PREMIUM TRIGGER ═══
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const userText = (lastUserMsg && lastUserMsg.content) || '';
    const isMK = /[а-шА-Ш]/.test(userText);

    if (userPlan === 'free' && isPremiumTrigger(userText, avatar)) {
      // Генерирај 20% preview + locked порака
      const previewText = await generatePreview(systemPrompt, messages, apiKey, isMK);
      return res.status(200).json({
        content: [{ type: 'text', text: previewText }],
        premium_required: true,
        trigger: 'upgrade_popup',
        remaining_messages: limit.remaining
      });
    }

    // ═══ ROUTER ЛОГИКА ═══
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

    // ═══ НОРМАЛЕН ОДГОВОР ═══
    const text = await callGemini(
      systemPrompt, messages, hasImage,
      body.image, body.imageType, body.imageText, apiKey
    );

    return res.status(200).json({
      content: [{ type: 'text', text: text }],
      remaining_messages: limit.remaining
    });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
};
