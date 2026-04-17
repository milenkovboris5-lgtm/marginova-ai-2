// ═══════════════════════════════════════════════════════════════════════════════
// MARGINOVA.AI — MULTILINGUAL BUSINESS COO v5.0
// 10 jazici: MK, SR, HR, BS, EN, DE, SQ, BG, TR, PL
// Avtonomen | Proaktiven | Samoučeski | Akcion
// ═══════════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const pLimit = require('p-limit');

// ═══════════════════════════════════════════════════════════════════════════════
// KONSTANTI
// ═══════════════════════════════════════════════════════════════════════════════

const DAILY_LIMIT = 200;
const rateLimitStore = {};
const CONCURRENT_LIMIT = 5;
const limit = pLimit(CONCURRENT_LIMIT);

const PLAN_LIMITS = { free: 20, starter: 500, pro: 2000, business: -1 };

// Cleanup rate limit sekoj saat
setInterval(() => {
  const now = Date.now();
  for (const k in rateLimitStore) {
    if (rateLimitStore[k].resetAt < now) delete rateLimitStore[k];
  }
}, 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// LANGUAGE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const LANGUAGES = {
  mk: { name: 'македонски', code: 'mk', flag: '🇲🇰', serper_gl: 'mk', direction: 'ltr' },
  sr: { name: 'српски', code: 'sr', flag: '🇷🇸', serper_gl: 'rs', direction: 'ltr' },
  hr: { name: 'hrvatski', code: 'hr', flag: '🇭🇷', serper_gl: 'hr', direction: 'ltr' },
  bs: { name: 'bosanski', code: 'bs', flag: '🇧🇦', serper_gl: 'ba', direction: 'ltr' },
  en: { name: 'English', code: 'en', flag: '🇬🇧', serper_gl: 'us', direction: 'ltr' },
  de: { name: 'Deutsch', code: 'de', flag: '🇩🇪', serper_gl: 'de', direction: 'ltr' },
  sq: { name: 'shqip', code: 'sq', flag: '🇦🇱', serper_gl: 'al', direction: 'ltr' },
  bg: { name: 'български', code: 'bg', flag: '🇧🇬', serper_gl: 'bg', direction: 'ltr' },
  tr: { name: 'Türkçe', code: 'tr', flag: '🇹🇷', serper_gl: 'tr', direction: 'ltr' },
  pl: { name: 'polski', code: 'pl', flag: '🇵🇱', serper_gl: 'pl', direction: 'ltr' }
};

// ═══════════════════════════════════════════════════════════════════════════════
// LANGUAGE DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

function detectLanguage(text) {
  if (!text) return 'en';
  
  const patterns = {
    mk: /[ќѓѕљњџ]/i,
    sr: /[ћђ]/i,
    hr: /[čćšž]/i,
    bs: /[čćšž]/i,
    de: /\b(der|die|das|und|oder|ist|ich|sie|wir|nicht|mit|auf|bei)\b/i,
    sq: /\b(dhe|është|për|nga|me|të|në|një|i|u|po)\b/i,
    bg: /[ъьѝ]/i,
    tr: /\b(ve|bir|bu|için|ile|de|da|mi|sen|o)\b/i,
    pl: /\b(się|nie|i|na|po|za|do|od|jest|są)\b/i,
    en: /\b(the|and|of|to|in|for|is|on|that|by|this|with)\b/i
  };
  
  const scores = {};
  for (const [lang, pattern] of Object.entries(patterns)) {
    const matches = text.match(pattern);
    scores[lang] = matches ? matches.length : 0;
  }
  
  const cyrillic = /[а-яА-Я]/.test(text);
  if (cyrillic) {
    if (scores.mk > 0 || scores.sr > 0 || scores.bg > 0) {
      const topCyrillic = Object.entries(scores)
        .filter(([l]) => ['mk', 'sr', 'bg'].includes(l))
        .sort((a, b) => b[1] - a[1]);
      if (topCyrillic[0] && topCyrillic[0][1] > 0) return topCyrillic[0][0];
    }
    return 'mk';
  }
  
  const topLang = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (topLang[0] && topLang[0][1] > 0) return topLang[0][0];
  
  return 'en';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSLATIONS
// ═══════════════════════════════════════════════════════════════════════════════

const TRANSLATIONS = {
  tender: {
    mk: 'тендер набавка', sr: 'tender nabavka', hr: 'natječaj nabava',
    bs: 'tender nabavka', en: 'tender procurement', de: 'ausschreibung beschaffung',
    sq: 'tender prokurimi', bg: 'търг обществена поръчка', tr: 'ihale satın alma',
    pl: 'przetarg zamówienie'
  },
  grant: {
    mk: 'грант финансирање', sr: 'grant finansiranje', hr: 'grant financiranje',
    bs: 'grant finansiranje', en: 'grant funding', de: 'förderung finanzierung',
    sq: 'grant financim', bg: 'грант финансиране', tr: 'hibe finansman',
    pl: 'dotacja finansowanie'
  },
  business: {
    mk: 'бизнис понуда', sr: 'biznis ponuda', hr: 'poslovna ponuda',
    bs: 'poslovna ponuda', en: 'business offer', de: 'geschäftsangebot',
    sq: 'ofertë biznesi', bg: 'бизнес оферта', tr: 'iş teklifi',
    pl: 'oferta biznesowa'
  }
};

const LOCAL_SITES = {
  mk: { tender: 'site:e-nabavki.gov.mk', grant: 'site:fitr.mk OR site:ipard.gov.mk', business: 'site:pazar3.mk' },
  sr: { tender: 'site:portal.ujn.gov.rs', grant: 'site:ec.europa.eu', business: 'site:halo.rs' },
  hr: { tender: 'site:eojn.hr', grant: 'site:ec.europa.eu', business: 'site:njuskalo.hr' },
  bs: { tender: 'site:ejn.ba', grant: 'site:ec.europa.eu', business: 'site:olx.ba' },
  en: { tender: 'site:ted.europa.eu', grant: 'site:ec.europa.eu', business: '' },
  de: { tender: 'site:bund.de', grant: 'site:foerderdatenbank.de', business: 'site:kleinanzeigen.de' },
  sq: { tender: 'site:app.prokurimi.gov.al', grant: 'site:ec.europa.eu', business: 'site:merrjep.al' },
  bg: { tender: 'site:app.eop.bg', grant: 'site:ec.europa.eu', business: 'site:alo.bg' },
  tr: { tender: 'site:ekap.kik.gov.tr', grant: 'site:ec.europa.eu', business: 'site:sahibinden.com' },
  pl: { tender: 'site:ezamowienia.gov.pl', grant: 'site:ec.europa.eu', business: 'site:olx.pl' }
};

const STOP_WORDS = {
  mk: ['и', 'или', 'на', 'во', 'за', 'од', 'со', 'до', 'по', 'при', 'над', 'под', 'меѓу', 'дека', 'дали'],
  sr: ['и', 'или', 'на', 'у', 'за', 'од', 'са', 'до', 'по', 'при', 'изнад', 'испод', 'између', 'да', 'ли'],
  hr: ['i', 'ili', 'na', 'u', 'za', 'od', 's', 'do', 'po', 'pri', 'iznad', 'ispod', 'između', 'da', 'li'],
  bs: ['i', 'ili', 'na', 'u', 'za', 'od', 'sa', 'do', 'po', 'pri', 'iznad', 'ispod', 'između', 'da', 'li'],
  en: ['the', 'and', 'of', 'to', 'in', 'for', 'on', 'with', 'by', 'at', 'from', 'is', 'are', 'was', 'were'],
  de: ['der', 'die', 'das', 'und', 'oder', 'von', 'zu', 'in', 'für', 'auf', 'mit', 'bei', 'ist', 'sind'],
  sq: ['dhe', 'ose', 'në', 'për', 'nga', 'me', 'të', 'i', 'u', 'po', 'është', 'janë', 'ka', 'kishin'],
  bg: ['и', 'или', 'на', 'в', 'за', 'от', 'с', 'до', 'по', 'при', 'над', 'под', 'между', 'че', 'дали'],
  tr: ['ve', 'veya', 'için', 'ile', 'de', 'da', 'mi', 'mu', 'mı', 'mü', 'bir', 'bu', 'şu', 'o'],
  pl: ['i', 'lub', 'na', 'w', 'dla', 'z', 'do', 'po', 'przy', 'nad', 'pod', 'między', 'że', 'czy']
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNKCIJI
// ═══════════════════════════════════════════════════════════════════════════════

function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

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

function extractKeywordsMultilingual(text, lang) {
  const words = text.toLowerCase()
    .replace(/[^\w\s\u0400-\u04FF]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
  
  const stopWords = STOP_WORDS[lang] || STOP_WORDS.en;
  const keywords = words.filter(w => !stopWords.includes(w));
  
  return keywords.slice(0, 5).join(' ');
}

function translateQuery(text, targetLang, intent) {
  const keywords = extractKeywordsMultilingual(text, targetLang);
  const intentWord = TRANSLATIONS[intent]?.[targetLang] || TRANSLATIONS.business[targetLang];
  const sites = LOCAL_SITES[targetLang]?.[intent] || '';
  
  let query = `${keywords} ${intentWord}`;
  if (sites) query += ` ${sites}`;
  
  return query;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPABASE (so retry)
// ═══════════════════════════════════════════════════════════════════════════════

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function supabaseRequest(path, options = {}, retries = 2) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchWithTimeout(
        url,
        { ...options, headers },
        i === retries ? 5000 : 4000
      );
      if (res.ok || i === retries) return res;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

async function verifyUser(userId, authToken) {
  if (!userId || !authToken) return false;
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(authToken);
    if (error || !user) return false;
    return user.id === userId;
  } catch (e) {
    console.warn('JWT verification error:', e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER QUOTA
// ═══════════════════════════════════════════════════════════════════════════════

async function checkUserQuota(userId) {
  if (!userId) return { allowed: true, remaining: 999 };
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await supabaseRequest(
      `profiles?user_id=eq.${userId}&select=plan,daily_msgs,last_msg_date`,
      { headers: { Prefer: 'return=representation' } }
    );
    if (!res.ok) return { allowed: true, remaining: 999 };
    const rows = await res.json();
    const profile = rows?.[0];
    if (!profile) return { allowed: true, remaining: 20 };

    const plan = profile.plan || 'free';
    const limit = PLAN_LIMITS[plan] ?? 20;
    if (limit === -1) return { allowed: true, remaining: -1 };

    const used = profile.last_msg_date === today ? (profile.daily_msgs || 0) : 0;
    const remaining = Math.max(0, limit - used);

    return { allowed: remaining > 0, remaining, plan, used };
  } catch (e) {
    console.warn('Quota check error:', e.message);
    return { allowed: true, remaining: 999 };
  }
}

async function incrementUserQuota(userId) {
  if (!userId) return;
  try {
    await supabaseRequest('rpc/increment_user_quota', {
      method: 'POST',
      body: JSON.stringify({ user_id_param: userId })
    });
  } catch (e) {
    console.warn('Quota increment error:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEARNING MODULE
// ═══════════════════════════════════════════════════════════════════════════════

async function learnOutcome(userId, recommendationType, outcome, details = {}) {
  if (!userId) return;
  try {
    await supabaseRequest('learning', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        recommendation_type: recommendationType,
        outcome: outcome,
        context: details,
        created_at: new Date().toISOString()
      })
    });
  } catch (e) {
    console.warn('Learn outcome error:', e.message);
  }
}

async function predictWinProbability(userId, tenderValue, industry) {
  if (!userId) return 0.5;
  try {
    const res = await supabaseRequest(
      `tender_history?user_id=eq.${userId}&industry=eq.${industry}&select=won,value`,
      { headers: { Prefer: 'return=representation' } }
    );
    const history = await res.json();
    
    if (!history || history.length === 0) return 0.5;
    
    const wins = history.filter(t => t.won === true).length;
    const total = history.length;
    const baseRate = wins / total;
    
    return Math.round(baseRate * 100);
  } catch (e) {
    return 0.5;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY
// ═══════════════════════════════════════════════════════════════════════════════

async function generateSummary(messages, apiKey, lang) {
  if (!messages || messages.length === 0) return null;
  try {
    const text = messages.map(m => `${m.role}: ${m.message}`).join('\n');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `Summarize this business conversation in 3-5 sentences in ${LANGUAGES[lang]?.name || 'English'}. Keep: key decisions, business context, specific numbers/deadlines.\n\n${text.slice(0, 3000)}` }] }],
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

async function loadMemory(userId, avatar, apiKey, lang) {
  if (!userId) return { summary: null, recent: [] };
  try {
    const res = await supabaseRequest(
      `conversations?user_id=eq.${userId}&avatar=eq.${avatar}&order=created_at.desc&limit=20`,
      { headers: { Prefer: 'return=representation' } }
    );
    if (!res.ok) return { summary: null, recent: [] };
    const rows = await res.json();
    if (!rows || rows.length === 0) return { summary: null, recent: [] };

    const recent = rows.slice(0, 6).reverse().map(r => ({
      role: r.role === 'assistant' ? 'assistant' : 'user',
      content: r.message
    }));

    let summary = null;
    if (rows.length > 6) {
      const olderMessages = rows.slice(6).reverse().map(r => ({ role: r.role, message: r.message }));
      const sumText = await generateSummary(olderMessages, apiKey, lang);
      if (sumText) {
        summary = sumText;
      }
    }

    return { summary, recent };
  } catch (e) {
    console.warn('Memory load error:', e.message);
    return { summary: null, recent: [] };
  }
}

async function saveMemory(userId, avatar, role, message) {
  if (!userId) return;
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

// ═══════════════════════════════════════════════════════════════════════════════
// INTENT CLASSIFIER
// ═══════════════════════════════════════════════════════════════════════════════

const INTENT_PATTERNS = {
  tender: ['тендер', 'набавка', 'оглас', 'конкурс', 'tender', 'nabavka', 'oglas', 'ausschreibung', 'ihale', 'przetarg'],
  grant: ['грант', 'фонд', 'ipard', 'grant', 'fond', 'förderung', 'hibe', 'dotacja'],
  legal: ['договор', 'право', 'gdpr', 'закон', 'contract', 'legal', 'recht', 'hukuk', 'prawo'],
  analysis: ['анализа', 'споредба', 'swot', 'analiza', 'analysis', 'analyse'],
  business: ['бизнис', 'стратегија', 'план', 'biznis', 'strategija', 'business', 'strategie', 'iş']
};

function classifyIntent(text) {
  const lower = text.toLowerCase();
  const scores = {};
  
  for (const [intent, keywords] of Object.entries(INTENT_PATTERNS)) {
    scores[intent] = keywords.filter(k => lower.includes(k)).length;
  }
  
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  
  const hasNegation = /\b(не|ne|nema|без|without|nicht|pa|jo)\b/i.test(lower);
  if (hasNegation && top[0] !== 'business') {
    return { intent: 'business', confident: false };
  }
  
  if (top[1] >= 1) return { intent: top[0], confident: top[1] >= 2 };
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

// ═══════════════════════════════════════════════════════════════════════════════
// MULTILINGUAL SERPER SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

async function searchSerperMultilingual(query, lang, apiKey) {
  if (!query || !apiKey) return null;
  
  const langData = LANGUAGES[lang] || LANGUAGES.en;
  const gl = langData.serper_gl;
  
  try {
    const res = await fetchWithTimeout('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({ q: query, num: 5, gl: gl, hl: lang }),
    }, 8000);
    
    if (!res.ok) return null;
    const data = await res.json();
    const results = [];
    
    if (data.organic) {
      data.organic.slice(0, 3).forEach(r => {
        results.push({
          title: r.title || '',
          snippet: r.snippet || '',
          link: r.link || '',
          date: r.date || ''
        });
      });
    }
    
    return results.length > 0 ? results : null;
  } catch (e) {
    console.warn(`Serper error (${lang}):`, e.message);
    return null;
  }
}

function formatSearchResultsMultilingual(results, intent, lang) {
  if (!results || results.length === 0) return '';
  
  const today = new Date().toLocaleDateString(lang === 'mk' ? 'mk-MK' : 'en-GB');
  
  const headers = {
    mk: { tender: 'ТЕНДЕРИ', grant: 'ГРАНТОВИ', business: 'ПОНУДИ' },
    sr: { tender: 'TENDERI', grant: 'GRANTOVI', business: 'PONUDE' },
    en: { tender: 'TENDERS', grant: 'GRANTS', business: 'OFFERS' },
    de: { tender: 'AUSSCHREIBUNGEN', grant: 'FÖRDERUNGEN', business: 'ANGEBOTE' },
    sq: { tender: 'TENDERAT', grant: 'GRANTET', business: 'OFERTAT' },
    bg: { tender: 'ТЪРГОВЕ', grant: 'ГРАНТОВЕ', business: 'ОФЕРТИ' },
    tr: { tender: 'İHALELER', grant: 'HİBELER', business: 'TEKLİFLER' },
    pl: { tender: 'PRZETARGI', grant: 'DOTACJE', business: 'OFERTY' }
  };
  
  const label = headers[lang]?.[intent] || headers.en[intent] || 'RESULTS';
  let ctx = `\n\n═══ ${label} — ${today} ═══\n`;
  
  results.forEach((r, i) => {
    let snippet = r.snippet || '';
    if (snippet.length > 100) {
      snippet = snippet.slice(0, 97);
      const lastSpace = snippet.lastIndexOf(' ');
      if (lastSpace > 0) snippet = snippet.slice(0, lastSpace);
      snippet += '...';
    }
    
    ctx += `${i + 1}. **${r.title}**\n`;
    if (r.date) ctx += `   📅 ${r.date}\n`;
    if (snippet) ctx += `   ${snippet}\n`;
    ctx += `   🔗 ${r.link}\n\n`;
  });
  
  return ctx;
}

async function proactiveScanMultilingual(userId, industry, lang, serperKey) {
  const alerts = [];
  if (!serperKey) return alerts;
  
  const tenderQuery = translateQuery(industry, lang, 'tender');
  const grantQuery = translateQuery(industry, lang, 'grant');
  
  try {
    const [tenderResults, grantResults] = await Promise.all([
      searchSerperMultilingual(tenderQuery, lang, serperKey),
      searchSerperMultilingual(grantQuery, lang, serperKey)
    ]);
    
    if (tenderResults && tenderResults.length > 0) {
      alerts.push({
        type: 'tender',
        title: tenderResults[0].title,
        link: tenderResults[0].link,
        message: `🔔 ${LANGUAGES[lang]?.name === 'македонски' ? 'НОВ ТЕНДЕР' : 'NEW TENDER'}: ${tenderResults[0].title.slice(0, 60)}`
      });
    }
    
    if (grantResults && grantResults.length > 0) {
      alerts.push({
        type: 'grant',
        title: grantResults[0].title,
        link: grantResults[0].link,
        message: `🎯 ${LANGUAGES[lang]?.name === 'македонски' ? 'НОВ ГРАНТ' : 'NEW GRANT'}: ${grantResults[0].title.slice(0, 60)}`
      });
    }
  } catch (e) {
    console.warn('Proactive scan error:', e.message);
  }
  
  return alerts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MULTILINGUAL SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════════════════

function getMultilingualSystemPrompt(intent, lang, todayStr, alerts = [], probability = null) {
  const alertsText = alerts.length > 0 
    ? `\n\n🔔 ${lang === 'mk' ? 'ПРОАКТИВНИ АЛЕРТИ' : 'PROACTIVE ALERTS'}:\n${alerts.map(a => `• ${a.message}`).join('\n')}\n`
    : '';
  
  const predictionText = probability !== null 
    ? `\n🎯 ${lang === 'mk' ? 'ПРЕДИКЦИЈА' : 'PREDICTION'}: ${lang === 'mk' ? 'Веројатност за успех е' : 'Probability of success is'} ${probability}%.\n`
    : '';
  
  const prompts = {
    mk: `Ti si Business COO — avtonomen, proaktiven, samoučeski asistent.

JAZIK: makedonski. DENES E: ${todayStr}
${alertsText}
${predictionText}

═══════════════════════════════════════════════════════════
TVOJA MISIJA
═══════════════════════════════════════════════════════════

1. PROAKTIVNOST — nudi rešenija PRED da bidat pobarani
2. PREDIKCIJA — kaži verojatnost za uspeh (0-100%)
3. AKCIJA — završuvaj so konkretna akcija
4. UČENJE — sekoja interakcija te pravi podobar

═══════════════════════════════════════════════════════════
FORMAT NA ODGOVOR
═══════════════════════════════════════════════════════════

[ODGOVOR] direkten odgovor
[PREDIKCIJA] verojatnost X%
[AKCIJA] "Sakas da [kreiraš task / zakazham / generiraš]?"`,

    en: `You are Business COO — autonomous, proactive, self-learning assistant.

LANGUAGE: English. TODAY IS: ${todayStr}
${alertsText}
${predictionText}

═══════════════════════════════════════════════════════════
YOUR MISSION
═══════════════════════════════════════════════════════════

1. PROACTIVITY — offer solutions BEFORE they are requested
2. PREDICTION — state probability of success (0-100%)
3. ACTION — end with a concrete action
4. LEARNING — every interaction makes you better

═══════════════════════════════════════════════════════════
RESPONSE FORMAT
═══════════════════════════════════════════════════════════

[ANSWER] direct answer
[PREDICTION] probability X%
[ACTION] "Do you want me to [create task / schedule / generate]?"`,

    de: `Du bist Business COO — autonomer, proaktiver, selbstlernender Assistent.

SPRACHE: Deutsch. HEUTE IST: ${todayStr}
${alertsText}
${predictionText}

═══════════════════════════════════════════════════════════
DEINE MISSION
═══════════════════════════════════════════════════════════

1. PROAKTIVITÄT — biete Lösungen BEVOR sie angefragt werden
2. VORHERSAGE — nenne Erfolgswahrscheinlichkeit (0-100%)
3. AKTION — beende mit konkreter Aktion
4. LERNEN — jede Interaktion macht dich besser`,

    sq: `Ti je Business COO — asistent autonom, proaktiv, që mëson vetë.

GJUHA: shqip. SOT ËSHTË: ${todayStr}
${alertsText}
${predictionText}

═══════════════════════════════════════════════════════════
MISIONI YT
═══════════════════════════════════════════════════════════

1. PROAKTIVITET — ofro zgjidhje PARA se të kërkohen
2. PARASHIKIM — thuaj probabilitetin e suksesit (0-100%)
3. VEPRIM — përfundo me një veprim konkret
4. MËSIM — çdo ndërveprim të bën më të mirë`
  };
  
  let prompt = prompts[lang] || prompts.en;
  
  // Intent-specific instructions
  const intentInstructions = {
    tender: lang === 'mk' ? '\n\nТЕНДЕРИ: Прикажи резултати со линк, пресметај веројатност за добивка.' : '\n\nTENDERS: Show results with links, calculate win probability.',
    grant: lang === 'mk' ? '\n\nГРАНТОВИ: Прикажи активни повици, провери елигибилност.' : '\n\nGRANTS: Show active calls, check eligibility.',
    legal: lang === 'mk' ? '\n\nПРАВНИ: Дај конкретен одговор, предложи консултација со адвокат.' : '\n\nLEGAL: Give specific answer, suggest lawyer consultation.',
    business: lang === 'mk' ? '\n\nБИЗНИС: Дај конкретен план, фокус на акции.' : '\n\nBUSINESS: Give concrete plan, focus on actions.'
  };
  
  prompt += intentInstructions[intent] || intentInstructions.business;
  
  return prompt;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GEMINI CALL
// ═══════════════════════════════════════════════════════════════════════════════

async function callGemini(systemPrompt, messages, hasImage, imageData, imageType, imageText, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  let contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }]
  }));
  
  if (hasImage && imageData) {
    const text = imageText || 'Analyze this carefully.';
    const newContents = contents.slice(0, -1);
    newContents.push({
      role: 'user',
      parts: [
        { inline_data: { mime_type: imageType || 'image/jpeg', data: imageData } },
        { text }
      ]
    });
    contents = newContents;
  }
  
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
    generationConfig: { maxOutputTokens: 2000, temperature: 0.5 }
  };
  
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 20000);
  
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error ${res.status}: ${err.slice(0, 200)}`);
  }
  
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════════

async function healthCheck() {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '5.0',
    languages: Object.keys(LANGUAGES).length,
    supabase: process.env.SUPABASE_URL ? 'configured' : 'missing',
    gemini: process.env.GEMINI_API_KEY ? 'configured' : 'missing',
    serper: process.env.SERPER_API_KEY ? 'configured' : 'missing'
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  
  if (req.method === 'GET' && req.url === '/api/health') {
    return res.status(200).json(await healthCheck());
  }
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  
  const rateLimitResult = checkRateLimit(req);
  if (!rateLimitResult.allowed) {
    return res.status(429).json({ error: { message: 'Daily limit reached. Try tomorrow.' } });
  }
  
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY' } });
  const serperKey = process.env.SERPER_API_KEY;
  
  try {
    const body = req.body;
    const hasImage = !!body.image;
    const userId = body.userId || null;
    const authToken = req.headers.authorization || body.authToken || null;
    const avatar = 'cooai';
    
    const rawText = body.messages?.[body.messages.length - 1]?.content || '';
    if (rawText.length > 2000) {
      return res.status(400).json({ error: { message: 'Message too long. Max 2000 characters.' } });
    }
    
    // JWT verification
    if (userId) {
      const isValid = await verifyUser(userId, authToken);
      if (!isValid) {
        return res.status(401).json({ error: { message: 'Unauthorized. Please login again.' } });
      }
    } else if (rateLimitResult.remaining < DAILY_LIMIT - 10) {
      return res.status(429).json({ error: { message: 'Registration required for more messages.' } });
    }
    
    // User quota
    if (userId) {
      const quota = await checkUserQuota(userId);
      if (!quota.allowed) {
        return res.status(429).json({
          error: { message: 'Daily limit reached. Upgrade your plan.' },
          quota_exceeded: true
        });
      }
      console.log(`[Quota] user:${userId.slice(0,8)} | plan:${quota.plan} | remaining:${quota.remaining}`);
    }
    
    // Detect language
    const lang = body.lang || detectLanguage(rawText);
    console.log(`[Language] detected: ${lang} (${LANGUAGES[lang]?.name})`);
    
    const today = new Date().toLocaleDateString(lang === 'mk' ? 'mk-MK' : 'en-GB');
    
    // Load memory
    const memory = await loadMemory(userId, avatar, apiKey, lang);
    
    // Combine messages
    const frontendMessages = (body.messages || []).slice(-4).map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content || '')
    }));
    
    const memoryContents = memory.recent.map(m => m.content);
    const newMessages = frontendMessages.filter(m => !memoryContents.includes(m.content));
    const messages = [...memory.recent, ...newMessages];
    
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const userText = lastUserMsg?.content || '';
    
    // Intent classification
    const keywordResult = classifyIntent(userText);
    const intent = keywordResult.confident
      ? keywordResult.intent
      : await classifyWithLLM(userText, apiKey);
    
    console.log(`[COO v5] user:${userId?.slice(0,8) || 'anon'} | lang:${lang} | intent:${intent} | text:${userText.slice(0, 50)}`);
    
    // Get industry from business DNA
    let industry = 'business';
    if (userId) {
      try {
        const res = await supabaseRequest(
          `profiles?user_id=eq.${userId}&select=business_dna`,
          { headers: { Prefer: 'return=representation' } }
        );
        const data = await res.json();
        industry = data[0]?.business_dna?.industrija || 'business';
      } catch (e) {}
    }
    
    // Proactive scan
    let alerts = [];
    if (serperKey && userId) {
      alerts = await proactiveScanMultilingual(userId, industry, lang, serperKey);
    }
    
    // Prediction probability
    let probability = null;
    if (intent === 'tender') {
      probability = await predictWinProbability(userId, null, industry);
    }
    
    // Build system prompt
    let systemPrompt = getMultilingualSystemPrompt(intent, lang, today, alerts, probability);
    if (memory.summary) {
      systemPrompt += `\n\n${memory.summary}`;
    }
    
    // Serper search for live data
    if (serperKey && (intent === 'tender' || intent === 'grant' || intent === 'business')) {
      const translatedQuery = translateQuery(userText, lang, intent);
      console.log(`[Serper ${lang}] query: ${translatedQuery}`);
      
      const searchResults = await searchSerperMultilingual(translatedQuery, lang, serperKey);
      if (searchResults && searchResults.length > 0) {
        systemPrompt += formatSearchResultsMultilingual(searchResults, intent, lang);
      }
    }
    
    // Call Gemini
    const text = await callGemini(
      systemPrompt,
      messages,
      hasImage,
      body.image,
      body.imageType,
      body.imageText,
      apiKey
    );
    
    // Save memory and quota
    if (userId) {
      await Promise.all([
        saveMemory(userId, avatar, 'user', userText),
        saveMemory(userId, avatar, 'assistant', text),
        incrementUserQuota(userId)
      ]);
    }
    
    // Learning from outcome
    const wantsToRecord = /добив|изгубив|успеа|не успеа|won|lost|success|failure|gewonnen|verloren/i.test(userText);
    if (wantsToRecord && userId && intent === 'tender') {
      const outcome = /добив|успеа|won|success|gewonnen/i.test(userText) ? 'success' : 'failure';
      await learnOutcome(userId, intent, outcome, { query: userText });
      console.log(`[Learning] Recorded ${outcome} for ${intent}`);
    }
    
    return res.status(200).json({
      content: [{ type: 'text', text }],
      intent,
      lang,
      remaining: rateLimitResult.remaining,
      alerts: alerts.length > 0 ? alerts : null,
      probability: probability
    });
    
  } catch (err) {
    console.error('Handler error:', err.message, err.stack);
    return res.status(500).json({ error: { message: 'Internal error. Please try again.' } });
  }
};
