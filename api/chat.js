// ═══════════════════════════════════════════
// MARGINOVA ROUTER — chat.js
// ═══════════════════════════════════════════

// Rate limiting
const rateLimitStore = {};
const DAILY_LIMIT = 9999;

function getRateLimitKey(req) {
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown';
  const today = new Date().toISOString().split('T')[0];
  return `${ip}_${today}`;
}

function checkRateLimit(req) {
  const key = getRateLimitKey(req);
  const now = Date.now();
  if (!rateLimitStore[key]) {
    rateLimitStore[key] = { count: 0, resetAt: getEndOfDay() };
  }
  for (const k in rateLimitStore) {
    if (rateLimitStore[k].resetAt < now) delete rateLimitStore[k];
  }
  const record = rateLimitStore[key];
  record.count += 1;
  return {
    allowed: record.count <= DAILY_LIMIT,
    count: record.count,
    remaining: Math.max(0, DAILY_LIMIT - record.count),
    resetAt: record.resetAt
  };
}

function getEndOfDay() {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}

// ═══════════════════════════════════════════
// ROUTER CONFIG
// ═══════════════════════════════════════════

// Avatars that use the Router system (only Marginova)
const ROUTER_AVATARS = ['marginova'];

// Advanced intent keywords — trigger upsell
const ADVANCED_INTENT_KEYWORDS = [
  'strategy', 'plan', 'analysis', 'analyze', 'step by step', 'detailed',
  'стратегија', 'план', 'анализа', 'чекор по чекор', 'детално',
  'strategija', 'analiza', 'korak po korak', 'detaljno',
  'how to grow', 'how to scale', 'invest', 'инвестиција', 'раст',
  'compete', 'конкуренција', 'market', 'пазар', 'revenue', 'приход'
];

// Category routing keywords
const BUSINESS_KEYWORDS = [
  'business', 'money', 'marketing', 'startup', 'strategy', 'revenue', 'profit',
  'бизнис', 'пари', 'маркетинг', 'стартап', 'стратегија', 'приход', 'профит',
  'biznis', 'pare', 'marketing', 'prihod', 'profit', 'strategija',
  'invest', 'инвестиција', 'brand', 'sales', 'продажба', 'клиент', 'client',
  'dropship', 'ecommerce', 'shop', 'продавница', 'закон', 'law', 'legal',
  'eu fond', 'grant', 'договор', 'contract', 'travel deal', 'туризам'
];

const EDUCATION_KEYWORDS = [
  'learn', 'study', 'language', 'english', 'course', 'skill', 'knowledge',
  'учи', 'јазик', 'курс', 'вештина', 'знаење', 'образование', 'essay',
  'uci', 'jezik', 'kurs', 'vestina', 'znanje', 'esej', 'book', 'книга',
  'quiz', 'тест', 'exam', 'испит', 'german', 'deutsch', 'write', 'пишувај',
  'homework', 'домашна', 'school', 'училиште', 'university', 'факултет'
];

const HEALTH_KEYWORDS = [
  'health', 'fitness', 'diet', 'stress', 'sleep', 'workout', 'wellness',
  'здравје', 'фитнес', 'диета', 'стрес', 'спиење', 'тренинг', 'wellbeing',
  'zdravje', 'fitnes', 'dijeta', 'stres', 'spavanje', 'trening',
  'food', 'храна', 'recipe', 'рецепт', 'meditation', 'медитација',
  'dream', 'сон', 'mindfulness', 'anxiety', 'анксиозност', 'mood', 'расположение'
];

// ═══════════════════════════════════════════
// ROUTER LOGIC
// ═══════════════════════════════════════════

function detectCategory(text) {
  const lower = text.toLowerCase();

  let businessScore = 0;
  let educationScore = 0;
  let healthScore = 0;

  BUSINESS_KEYWORDS.forEach(k => { if (lower.includes(k)) businessScore++; });
  EDUCATION_KEYWORDS.forEach(k => { if (lower.includes(k)) educationScore++; });
  HEALTH_KEYWORDS.forEach(k => { if (lower.includes(k)) healthScore++; });

  const max = Math.max(businessScore, educationScore, healthScore);
  if (max === 0) return null; // unclear

  if (businessScore === max) return 'Business';
  if (educationScore === max) return 'Education';
  return 'Health';
}

function detectAdvancedIntent(text) {
  const lower = text.toLowerCase();
  return ADVANCED_INTENT_KEYWORDS.some(k => lower.includes(k));
}

function buildRouterResponse(category, userText, isAdvanced) {
  // Category routing messages (multilingual basic detection)
  const isMK = /[а-шА-Ш]/.test(userText);

  const routingMessages = {
    Business: isMK
      ? `📊 **Категорија: Бизнис**\nОвоа прашање е за нашиот Business тим.\n\n➡️ За најдобар одговор, зборувај со **Business AI**, **Justinian**, **Eva** или **Creative AI** — специјалисти за твојата тема.`
      : `📊 **Category: Business**\nThis is a Business question.\n\n➡️ For the best answer, talk to **Business AI**, **Justinian**, **Eva** or **Creative AI** — specialists in your topic.`,
    Education: isMK
      ? `🎓 **Категорија: Едукација**\nОвоа прашање е за нашиот Education тим.\n\n➡️ За најдобар одговор, зборувај со **AI Mentor**, **Sophie**, **Leo** или **LIBER** — специјалисти за учење.`
      : `🎓 **Category: Education**\nThis is an Education question.\n\n➡️ For the best answer, talk to **AI Mentor**, **Sophie**, **Leo** or **LIBER** — learning specialists.`,
    Health: isMK
      ? `🌿 **Категорија: Здравје**\nОвоа прашање е за нашиот Health тим.\n\n➡️ За најдобар одговор, зборувај со **Ana**, **Viktor**, **Marko** или **Luna** — специјалисти за здравје.`
      : `🌿 **Category: Health**\nThis is a Health & Wellness question.\n\n➡️ For the best answer, talk to **Ana**, **Viktor**, **Marko** or **Luna** — wellness specialists.`
  };

  const upsellSuffix = isMK
    ? `\n\n---\n💡 Го детектирав сложено прашање кое бара **детална стратегија**.\n🔒 **Отклучи го целосниот план** со надградба на Pro планот.`
    : `\n\n---\n💡 I detected a complex question that requires a **full strategy**.\n🔒 **Unlock the full plan** by upgrading to Pro.`;

  let response = routingMessages[category] || routingMessages['Business'];
  if (isAdvanced) response += upsellSuffix;

  return response;
}

// ═══════════════════════════════════════════
// GEMINI API CALL
// ═══════════════════════════════════════════

async function callGemini(systemPrompt, messages, hasImage, imageData, imageType, imageText, apiKey) {
  const maxTokens = 1000;
  const model = 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : String(m.content || '') }]
  }));

  if (hasImage) {
    const lastText = imageText || 'Please analyze this image carefully and respond helpfully.';
    const historyWithoutLast = contents.slice(0, -1);
    const visionMsg = {
      role: 'user',
      parts: [
        { inline_data: { mime_type: imageType || 'image/jpeg', data: imageData } },
        { text: lastText }
      ]
    };
    contents.length = 0;
    contents.push(...historyWithoutLast, visionMsg);
  }

  // Prepend system prompt to first message
  let contentsWithSystem;
  if (contents.length > 0) {
    contentsWithSystem = [
      { role: 'user', parts: [{ text: systemPrompt + '\n\n' }, ...contents[0].parts] },
      ...contents.slice(1)
    ];
  } else {
    contentsWithSystem = [{ role: 'user', parts: [{ text: systemPrompt }] }];
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: contentsWithSystem,
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Gemini API error');

  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
}

// ═══════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  }

  // Rate limit
  const limit = checkRateLimit(req);
  res.setHeader('X-RateLimit-Limit', DAILY_LIMIT);
  res.setHeader('X-RateLimit-Remaining', limit.remaining);

  if (!limit.allowed) {
    return res.status(429).json({
      error: {
        message: 'Daily limit reached. Resets at midnight.',
        code: 'RATE_LIMIT_EXCEEDED',
        remaining: 0
      }
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'Gemini API key not configured.' } });
  }

  try {
    const body = req.body;
    const avatar = body.avatar || 'marginova';
    const hasImage = !!body.image;
    const systemPrompt = body.system || '';
    const messages = (body.messages || []).slice(-20).map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content :
               Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ') :
               String(m.content)
    }));

    // ═══ ROUTER — only for Marginova ═══
    // Only routes when user has a CLEAR, SPECIFIC specialist need
    // NOT for general conversation, greetings, or simple questions
    if (ROUTER_AVATARS.includes(avatar) && messages.length > 0) {
      const lastUserMsg = messages.filter(m => m.role === 'user').pop();
      const userText = lastUserMsg?.content || '';
      const wordCount = userText.trim().split(/\s+/).length;

      // Minimum conditions to even consider routing:
      // 1. Message must be at least 8 words (not casual chat)
      // 2. Must contain advanced intent keywords (strategy, plan, analysis...)
      // 3. Must have a clear category match (2+ keyword hits)
      if (wordCount >= 8) {
        const isAdvanced = detectAdvancedIntent(userText);
        
        if (isAdvanced) {
          const lower = userText.toLowerCase();
          let businessScore = 0, educationScore = 0, healthScore = 0;
          BUSINESS_KEYWORDS.forEach(k => { if (lower.includes(k)) businessScore++; });
          EDUCATION_KEYWORDS.forEach(k => { if (lower.includes(k)) educationScore++; });
          HEALTH_KEYWORDS.forEach(k => { if (lower.includes(k)) healthScore++; });

          const max = Math.max(businessScore, educationScore, healthScore);

          // Only route if there are 2+ keyword hits — strong signal
          if (max >= 2) {
            let category = null;
            if (businessScore === max) category = 'Business';
            else if (educationScore === max) category = 'Education';
            else if (healthScore === max) category = 'Health';

            if (category) {
              const routerResponse = buildRouterResponse(category, userText, true);
              return res.status(200).json({
                content: [{ type: 'text', text: routerResponse }],
                routed: true,
                category: category,
                remaining_messages: limit.remaining - 1
              });
            }
          }
        }
      }
    }

    // ═══ STANDARD GEMINI CALL ═══
    const text = await callGemini(
      systemPrompt,
      messages,
      hasImage,
      body.image,
      body.imageType,
      body.imageText,
      apiKey
    );

    return res.status(200).json({
      content: [{ type: 'text', text }],
      remaining_messages: limit.remaining - 1
    });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
};
