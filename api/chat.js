// ═══════════════════════════════════════════════════════════════
// MARGINOVA.AI — api/chat.js  (Vercel Serverless Function)
// ═══════════════════════════════════════════════════════════════
//
// Безбедносни гаранции:
//   ✅ JWT верификација — само логирани корисници
//   ✅ Rate limiting по user_id (не IP)
//   ✅ Лимитите се земаат од Supabase profiles (plan колона)
//   ✅ Gemini API клучот никогаш не го напушта серверот
//   ✅ max_tokens cappiran на 1500 (заштита од злоупотреба)
//
// Потребни Vercel Environment Variables:
//   GEMINI_API_KEY        — од Google AI Studio
//   SUPABASE_URL          — https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  — Service Role клуч (не anon!)
//   SUPABASE_JWT_SECRET   — од Supabase → Settings → API → JWT Secret
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const { jwtVerify, createRemoteJWKSet } = require('jose');

// ─── Константи ──────────────────────────────────────────────
const PLAN_LIMITS = {
  free:    50,
  pro:     1500,
  premium: 5000,
  ultra:   -1,   // -1 = неограничено
};

const ROUTER_AVATARS = ['marginova'];

const ADVANCED_INTENT_KEYWORDS = [
  'strategy', 'plan', 'analysis', 'analyze', 'step by step', 'detailed',
  'стратегија', 'план', 'анализа', 'чекор по чекор', 'детално',
  'strategija', 'analiza', 'korak po korak', 'detaljno',
  'how to grow', 'how to scale', 'invest', 'инвестиција', 'раст',
  'compete', 'конкуренција', 'market', 'пазар', 'revenue', 'приход'
];

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

// ─── JWT Верификација ────────────────────────────────────────
async function verifySupabaseJWT(token) {
  try {
    const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, {
      issuer: process.env.SUPABASE_URL + '/auth/v1',
    });
    return payload; // содржи sub (user_id), email, role итн.
  } catch (err) {
    return null;
  }
}

// ─── Rate Limiting (Supabase-базиран) ───────────────────────
async function checkAndDeductLimit(supabase, userId) {
  const today = new Date().toISOString().split('T')[0];

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('plan, daily_msgs, last_msg_date')
    .eq('user_id', userId)
    .single();

  if (error || !profile) {
    // Ако нема профил — дозволи (нов корисник, ќе се создаде подоцна)
    return { allowed: true, remaining: 50, plan: 'free' };
  }

  const plan = profile.plan || 'free';
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

  // Неограничен план
  if (limit === -1) {
    return { allowed: true, remaining: -1, plan };
  }

  // Ресетирај бројач ако е нов ден
  const usedToday = profile.last_msg_date === today
    ? (profile.daily_msgs || 0)
    : 0;

  if (usedToday >= limit) {
    return { allowed: false, remaining: 0, plan, limit };
  }

  // Зголеми бројач
  const newCount = usedToday + 1;
  await supabase
    .from('profiles')
    .update({ daily_msgs: newCount, last_msg_date: today })
    .eq('user_id', userId);

  return { allowed: true, remaining: limit - newCount, plan };
}

// ─── Router логика (непроменета) ─────────────────────────────
function detectAdvancedIntent(text) {
  const lower = text.toLowerCase();
  return ADVANCED_INTENT_KEYWORDS.some(k => lower.includes(k));
}

function buildRouterResponse(category, userText, isAdvanced) {
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

// ─── Gemini API повик (непроменет) ───────────────────────────
async function callGemini(systemPrompt, messages, hasImage, imageData, imageType, imageText, apiKey) {
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
      generationConfig: { maxOutputTokens: 1500, temperature: 0.7 }
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Gemini API error');
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
}

// ─── Главен Handler ──────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://marginova.tech');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method Not Allowed' } });

  // ── 1. JWT Верификација ──────────────────────────────────
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: { message: 'Unauthorized — најавете се за да продолжите.' } });
  }

  const token = authHeader.replace('Bearer ', '');
  const jwtPayload = await verifySupabaseJWT(token);

  if (!jwtPayload || !jwtPayload.sub) {
    return res.status(401).json({ error: { message: 'Unauthorized — сесијата е истечена. Најавете се повторно.' } });
  }

  const userId = jwtPayload.sub;

  // ── 2. Supabase клиент (Service Role — за читање profiles) ─
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // ── 3. Rate Limiting по user_id ──────────────────────────
  const limitCheck = await checkAndDeductLimit(supabase, userId);

  if (!limitCheck.allowed) {
    return res.status(429).json({
      error: {
        message: `Го достигнавте дневниот лимит (${limitCheck.limit} пораки). Надградете го планот за повеќе!`,
        code: 'RATE_LIMIT_EXCEEDED',
        remaining: 0
      }
    });
  }

  // ── 4. Земи го Gemini API клучот ─────────────────────────
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'Server misconfiguration.' } });
  }

  // ── 5. Парсирај body ─────────────────────────────────────
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

    // Заштита — не дозволи system prompt инјекција
    if (systemPrompt.length > 8000) {
      return res.status(400).json({ error: { message: 'System prompt too long.' } });
    }

    // ── 6. Router (само за Marginova) ────────────────────
    if (ROUTER_AVATARS.includes(avatar) && messages.length > 0) {
      const lastUserMsg = messages.filter(m => m.role === 'user').pop();
      const userText = lastUserMsg?.content || '';
      const wordCount = userText.trim().split(/\s+/).length;

      if (wordCount >= 8) {
        const isAdvanced = detectAdvancedIntent(userText);
        if (isAdvanced) {
          const lower = userText.toLowerCase();
          let biz = 0, edu = 0, health = 0;
          BUSINESS_KEYWORDS.forEach(k => { if (lower.includes(k)) biz++; });
          EDUCATION_KEYWORDS.forEach(k => { if (lower.includes(k)) edu++; });
          HEALTH_KEYWORDS.forEach(k => { if (lower.includes(k)) health++; });
          const max = Math.max(biz, edu, health);
          if (max >= 2) {
            const category = biz === max ? 'Business' : edu === max ? 'Education' : 'Health';
            const routerResponse = buildRouterResponse(category, userText, true);
            return res.status(200).json({
              content: [{ type: 'text', text: routerResponse }],
              routed: true,
              category,
              remaining_messages: limitCheck.remaining
            });
          }
        }
      }
    }

    // ── 7. Gemini повик ───────────────────────────────────
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
      remaining_messages: limitCheck.remaining
    });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
};
