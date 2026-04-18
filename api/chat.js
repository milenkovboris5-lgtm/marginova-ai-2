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

// Supabase REST helper
async function supabaseRequest(path, options = {}) {
  return fetchWithTimeout(
    `${SUPA_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
        ...(options.headers || {})
      }
    },
    5000
  );
}

// ═══ USER QUOTA (Supabase) ═══
const PLAN_LIMITS = { free: 20, starter: 500, pro: 2000, business: -1 };

async function checkUserQuota(userId) {
  if (!SUPA_URL || !SUPA_KEY || !userId) return { allowed: true, remaining: 999 };
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await supabaseRequest(
      `profiles?user_id=eq.${userId}&select=plan,daily_msgs,last_msg_date`,
      { headers: { Prefer: '' } }
    );
    if (!res.ok) return { allowed: true, remaining: 999 };
    const rows = await res.json();
    const profile = rows?.[0];
    if (!profile) return { allowed: true, remaining: 20 };

    const plan = profile.plan || 'free';
    const limit = PLAN_LIMITS[plan] ?? 20;
    if (limit === -1) return { allowed: true, remaining: -1 }; // unlimited

    const used = profile.last_msg_date === today ? (profile.daily_msgs || 0) : 0;
    const remaining = Math.max(0, limit - used);

    return { allowed: remaining > 0, remaining, plan, used };
  } catch (e) {
    console.warn('Quota check error:', e.message);
    return { allowed: true, remaining: 999 };
  }
}

async function incrementUserQuota(userId) {
  if (!SUPA_URL || !SUPA_KEY || !userId) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    // Прво земи тековна состојба
    const res = await supabaseRequest(
      `profiles?user_id=eq.${userId}&select=daily_msgs,last_msg_date`,
      { headers: { Prefer: '' } }
    );
    if (!res.ok) return;
    const rows = await res.json();
    const profile = rows?.[0];
    const currentUsed = profile?.last_msg_date === today ? (profile?.daily_msgs || 0) : 0;

    await supabaseRequest(
      `profiles?user_id=eq.${userId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ daily_msgs: currentUsed + 1, last_msg_date: today })
      }
    );
  } catch (e) {
    console.warn('Quota increment error:', e.message);
  }
}

// ═══ GEMINI SUMMARIZATION ═══
async function generateSummary(messages, apiKey) {
  try {
    const text = messages.map(m => `${m.role}: ${m.message}`).join('\n');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `Summarize this business conversation in 3-5 sentences. Keep: key decisions, business context, specific numbers/deadlines mentioned, what was agreed.\n\n${text.slice(0, 3000)}` }] }],
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

// ═══ MEMORY ═══
async function loadMemory(userId, avatar, apiKey) {
  if (!SUPA_URL || !SUPA_KEY || !userId) return { summary: null, recent: [] };
  try {
    const res = await supabaseRequest(
      `conversations?user_id=eq.${userId}&avatar=eq.${avatar}&order=created_at.desc&limit=30`,
      { headers: { Prefer: '' } }
    );
    if (!res.ok) return { summary: null, recent: [] };
    const rows = await res.json();
    if (!rows || rows.length === 0) return { summary: null, recent: [] };

    // Последни 6 пораки за директен context
    const recent = rows.slice(0, 6).reverse().map(r => ({
      role: r.role === 'assistant' ? 'assistant' : 'user',
      content: r.message
    }));

    // Постари пораки → Real Gemini summary
    let summary = null;
    if (rows.length > 6) {
      const older = rows.slice(6).reverse();
      const sumText = await generateSummary(older, apiKey);
      if (sumText) {
        summary = `Претходен контекст (резиме): ${sumText}`;
      } else {
        // Fallback на truncate ако Gemini не одговори
        summary = `Претходен разговор: ${older.map(r => `${r.role}: ${r.message}`).join(' ').slice(0, 400)}`;
      }
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


const INTENT_PATTERNS = {
  tender: [
    'тендер','набавка','оглас','конкурс','јавна набавка',
    'tender','nabavka','oglas','javna nabavka','procurement',
    'ausschreibung','ihale','przetarg','appalto'
  ],
  grant: [
    'грант','фонд','ipard','ipa','eu фонд','финансирање','финансиска поддршка','финансиска помош',
    'grant','grand','grantovi','fond','fondovi','finansiranje','finansiska','finansiska podrska',
    'subsidy','podrska','subvencija','eu grant','eu fond','eu fonds',
    'förderung','hibe','dotacja','horizon','erasmus','undp','usaid','wbif','fitr',
    'startup','стартап','povikot','повик','аплицира','aplicira','aplikacija',
    'финансиска','финансис','podrska za','support za','финансир'
  ],
  legal: [
    'договор','право','gdpr','закон','трудово','даноци','правни','регулатив',
    'ugovor','pravo','zakon','radno','porezi','pravni','regulativ','aplikacija pravna',
    'contract','legal','recht','gesetz','hukuk','prawo',
    'licenca','dozvola','registracija','osnivanje','statut'
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

// ═══ HYBRID INTENT CLASSIFIER ═══
// Прво keyword matching (0ms, бесплатно)
// Ако score = 0 → LLM fallback (само кога е нејасно)

function classifyIntent(text) {
  const lower = text.toLowerCase();
  const scores = {};
  for (const [intent, keywords] of Object.entries(INTENT_PATTERNS)) {
    scores[intent] = keywords.filter(k => lower.includes(k)).length;
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const second = sorted[1];

  // Јасен winner — врати веднаш
  if (top[1] >= 2) return { intent: top[0], confident: true };
  if (top[1] === 1 && second[1] === 0) return { intent: top[0], confident: true };

  // Нема match или tie — потребен LLM
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
    // Macedonia
    'македон': 'site:e-nabavki.gov.mk',
    'makedon': 'site:e-nabavki.gov.mk',
    // Serbia
    'srbij': 'site:portal.ujn.gov.rs',
    'србиј': 'site:portal.ujn.gov.rs',
    // Croatia
    'hrvat': 'site:eojn.nn.hr',
    'хрват': 'site:eojn.nn.hr',
    // Bosnia
    'bosn': 'site:ejn.ba',
    'босн': 'site:ejn.ba',
    // Bulgaria
    'bulgar': 'site:app.eop.bg',
    'бугар': 'site:app.eop.bg',
    // Romania
    'roman': 'site:e-licitatie.ro',
    'романиј': 'site:e-licitatie.ro',
    // Greece
    'greec': 'site:promitheus.gov.gr',
    'grci': 'site:promitheus.gov.gr',
    'грциј': 'site:promitheus.gov.gr',
    // Turkey
    'turk': 'site:ekap.kik.gov.tr',
    'турциј': 'site:ekap.kik.gov.tr',
    // Germany
    'german': 'site:ted.europa.eu',
    'deutsch': 'site:ted.europa.eu',
    'германиј': 'site:ted.europa.eu',
    // France
    'franc': 'site:ted.europa.eu',
    'франциј': 'site:ted.europa.eu',
    // Spain
    'spain': 'site:contrataciondelestado.es',
    'spanij': 'site:contrataciondelestado.es',
    'шпаниј': 'site:contrataciondelestado.es',
    // EU general
    'eu': 'site:ted.europa.eu',
    'европ': 'site:ted.europa.eu',
    'europ': 'site:ted.europa.eu',
  };

  if (intent === 'tender') {
    let site = 'site:e-nabavki.gov.mk OR site:portal.ujn.gov.rs OR site:eojn.nn.hr OR site:ejn.ba OR site:ted.europa.eu';
    for (const [key, val] of Object.entries(countryMap)) {
      if (lower.includes(key)) { site = val; break; }
    }
    return `${keywords} tender nabavka ${site}`;
  }

  if (intent === 'grant') {
    const sectorMap = {
      'it': 'IT', 'tech': 'technology', 'software': 'software',
      'gradez': 'construction', 'zemjodelst': 'agriculture', 'agri': 'agriculture',
      'turiz': 'tourism', 'tourism': 'tourism', 'energi': 'energy',
      'startup': 'startup', 'mladi': 'youth', 'youth': 'youth',
      'inovacij': 'innovation', 'innov': 'innovation',
    };
    let sector = '';
    for (const [key, val] of Object.entries(sectorMap)) {
      if (lower.includes(key)) { sector = val; break; }
    }
    let grantSite = 'site:fitr.mk OR site:ipard.gov.mk OR site:mk.undp.org OR site:westernbalkansfund.org OR site:ec.europa.eu';
    for (const [key, val] of Object.entries({
      'german': 'site:foerderdatenbank.de OR site:bmbf.de',
      'franc': 'site:bpifrance.fr OR site:ec.europa.eu',
      'eu': 'site:ec.europa.eu OR site:interreg.eu',
      'европ': 'site:ec.europa.eu OR site:interreg.eu',
      'srbij': 'site:inovacionifond.rs OR site:apr.gov.rs',
    })) {
      if (lower.includes(key)) { grantSite = val; break; }
    }
    const grantKeyword = sector || keywords.split(' ').slice(0, 2).join(' ');
    return `${grantKeyword} grant funding 2025 ${grantSite}`;
  }

  if (intent === 'business') {
    let site = 'site:pazar3.mk OR site:oglasi.mk OR site:halo.rs OR site:njuskalo.hr';
    for (const [key, val] of Object.entries({
      'македон': 'site:pazar3.mk OR site:biznis.mk OR site:oglasi.mk',
      'makedon': 'site:pazar3.mk OR site:biznis.mk OR site:oglasi.mk',
      'srbij': 'site:halo.rs OR site:oglasi.rs',
      'србиј': 'site:halo.rs OR site:oglasi.rs',
      'hrvat': 'site:njuskalo.hr OR site:oglasnik.hr',
      'german': 'site:ebay-kleinanzeigen.de OR site:wlw.de',
      'германиј': 'site:ebay-kleinanzeigen.de OR site:wlw.de',
    })) {
      if (lower.includes(key)) { site = val; break; }
    }
    return `${keywords} ${site}`;
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
function detectRegionFromLink(link) {
  if (!link) return '';
  if (link.includes('e-nabavki.gov.mk') || link.includes('pazar3.mk')) return 'Македонија';
  if (link.includes('portal.ujn.gov.rs') || link.includes('halo.rs')) return 'Србија';
  if (link.includes('eojn.nn.hr') || link.includes('njuskalo.hr')) return 'Хрватска';
  if (link.includes('ejn.ba')) return 'БиХ';
  if (link.includes('app.eop.bg')) return 'Бугарија';
  if (link.includes('e-licitatie.ro')) return 'Романија';
  if (link.includes('promitheus.gov.gr')) return 'Грција';
  if (link.includes('ekap.kik.gov.tr')) return 'Турција';
  if (link.includes('ted.europa.eu') || link.includes('ec.europa.eu')) return 'ЕУ';
  if (link.includes('foerderdatenbank.de') || link.includes('bmbf.de')) return 'Германија';
  if (link.includes('contrataciondelestado.es')) return 'Шпанија';
  if (link.includes('bpifrance.fr')) return 'Франција';
  return '';
}

function formatSearchResults(results, intent) {
  if (!results || results.length === 0) return '';
  const today = new Date().toLocaleDateString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const label = intent === 'grant' ? 'ГРАНТОВИ' : intent === 'business' ? 'ОГЛАСИ' : 'ТЕНДЕРИ';
  let ctx = `\n\n═══ LIVE РЕЗУЛТАТИ — ${label} — ${today} ═══\n`;
  ctx += `Прикажи САМО овие резултати со точните линкови. НЕ измислувај.\n\n`;
  results.forEach((r, i) => {
    const snippet = r.snippet ? r.snippet.slice(0, 120) + (r.snippet.length > 120 ? '...' : '') : '';
    const region = detectRegionFromLink(r.link);
    ctx += `${i + 1}. **${r.title}**\n`;
    if (region) ctx += `   🌍 ${region}\n`;
    if (r.date) ctx += `   📅 ${r.date}\n`;
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
    generationConfig: { maxOutputTokens: 800, temperature: 0.75 }
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

  return `You are the Business COO of Marginova.AI — an elite business intelligence advisor operating across the Balkans, Mediterranean, and Europe.

## IDENTITY
You are not an AI assistant. You are a senior COO with 20+ years of experience in business strategy, tenders, EU grants, legal frameworks, and market analysis across Macedonia, Serbia, Croatia, Bosnia, Slovenia, Albania, Bulgaria, Romania, Greece, Turkey, France, Germany, Spain, Italy, Austria, and the broader EU.

You think independently. You challenge weak ideas. You protect the user from bad decisions. You always think one step ahead of the user.

Today is ${todayStr}.

## LANGUAGE
Respond EXCLUSIVELY in: ${langName}. This is absolute — never switch languages unless the user explicitly asks. Never mention that you detected the language. Never apologize for language choice.

## LIVE SEARCH SYSTEM — CRITICAL
You have real-time search results injected into your context before every response via Serper.
- NEVER say "I cannot search the internet"
- NEVER say "I don't have access to real-time data"
- NEVER ask permission to search — results are already in your context
- If the context contains "LIVE РЕЗУЛТАТИ" — present them using the format below
- If the context contains "НЕМА РЕАЛНИ РЕЗУЛТАТИ" — give ONE concrete alternative action, never list generic portals

When presenting search results, use exactly this format:
📋 [Title]
💰 [Value — only if known, skip otherwise]
📅 [Deadline — only if known]
🌍 [Country/Region]
✅ Step 1 → Step 2 → Step 3
🔗 [Link]

## THINKING PROTOCOL
Before every response, silently run this analysis:
1. What does this user ACTUALLY need? (beyond what they typed)
2. What risk or obstacle have they NOT mentioned?
3. What is the single most valuable insight right now?
4. What is the ONE action they should take immediately?

Never show this analysis. Only show the result.

## BUSINESS DNA
Deep expertise in:
→ Macedonian Law on Public Procurement (ЗЈН)
→ EU Directives 2014/24/EU, 2014/25/EU, 2014/23/EU
→ IPARD III, IPA III, Horizon Europe, INTERREG, ERASMUS+, CEF, WBIF
→ Western Balkans EU accession frameworks and business culture
→ Corporate law across MK, RS, HR, BA, BG, RO, GR, TR
→ Cross-border partnerships, joint ventures, subcontracting
→ Grant application structures: narrative, budget, indicators, eligibility
→ Business culture nuances: Balkans, DACH, Southern Europe, CEE
→ Negotiation dynamics across the region

## RESPONSE RULES
- Maximum 180 words per response (exception: legal/financial/contract analysis → 350 words)
- Every sentence carries value. Zero filler. Zero repetition.
- Never open two consecutive responses with the same structure
- Never use: "I can help you with..." / "Great question" / "As an AI" / "I understand your concern" / "Certainly" / "Of course"
- Never hallucinate: companies, prices, links, names, contacts, phone numbers, law numbers
- If uncertain about a specific law/regulation → say exactly what you don't know + name the specific institution to verify (not generic advice)
- End every response with ONE concrete action the user can take immediately

## BEHAVIORAL INTELLIGENCE
When user presents weak plan → tell them directly + offer a stronger path
When user is frustrated → completely change approach, new angle, never repeat same advice
When user repeats same question → you haven't been clear enough — try a different explanation
When user asks for something impossible → explain precisely why + give realistic alternative
When no search data exists → admit it precisely + point to exact institution or channel
When user asks about your capabilities → tell them what you can do FOR THEM specifically, not a feature list

## CRITICAL RESPONSE STYLE
You are a COO, not a consultant writing a report. Talk like a sharp executive in a meeting:
- SHORT. Maximum 5 sentences unless detailed analysis is explicitly requested.
- If you don't have data → ONE sentence + ONE real next move. Done.
- NEVER write bullet lists longer than 3 items
- NEVER explain why you can't do something for more than one sentence
- NEVER defend yourself or justify your limitations
- NEVER use: "мојата вредност е...", "мојата цел е...", "разбирам дека...", "разбирам"
- If user is frustrated → pivot completely, new angle, no apology
- If user asks for numbers → give numbers, or name the exact source in one sentence
- If user says your answer is useless → they are right, try a completely different approach

## ANTI-PATTERNS — NEVER DO THESE
✗ Generic lists of websites without context
✗ "You can check..." without specifics
✗ Same sentence structure in consecutive responses
✗ Multiple clarifying questions at once — ask maximum ONE
✗ Confirming you understood before answering
✗ Restating what the user just said
✗ Padding with encouragement before the actual answer
✗ Saying you will search — results are already there
✗ "I cannot search the internet"
✗ Revealing AI identity
✗ Hallucinating any factual data whatsoever
✗ Repeating the same recommendation if the user already tried it

## SCENARIOS

TENDER/GRANT/OGLAS request:
→ If LIVE РЕЗУЛТАТИ in context: present them with format above + one action step
→ If НЕМА РЕАЛНИ РЕЗУЛТАТИ: give ONE concrete next action specific to their sector and region

NO CLIENTS / BUSINESS NOT GROWING:
→ Never give a generic plan. Ask ONE concrete question relevant to their target market.
→ Build on their answer.

FRUSTRATION / REPEATING:
→ Change approach completely — new angle, new solution, never the same advice twice.

LEGAL / FINANCIAL / ANALYSIS:
→ Give concrete answers. If you don't know the exact law or number, say so and name the specific institution.

ASKS ABOUT YOUR CAPABILITIES:
→ Tell them what you can do for THEIR specific situation — not a feature list.`;
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

    // Anti-spam
    const rawText = body.messages?.[body.messages.length - 1]?.content || '';
    if (rawText.length > 2000) {
      return res.status(400).json({ error: { message: 'Пораката е предолга. Максимум 2000 знаци.' } });
    }
    if (!userId && limit.remaining < DAILY_LIMIT - 10) {
      return res.status(429).json({ error: { message: 'Потребна е регистрација за повеќе пораки.' } });
    }

    // ═══ USER QUOTA CHECK (Supabase) ═══
    if (userId) {
      const quota = await checkUserQuota(userId);
      if (!quota.allowed) {
        return res.status(429).json({
          error: { message: 'Го достигнавте дневниот лимит. Надградете го планот за повеќе пораки.' },
          quota_exceeded: true
        });
      }
      console.log(`[Quota] plan:${quota.plan} | remaining:${quota.remaining}`);
    }

    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

    // Memory со real Gemini summarization
    const memory = await loadMemory(userId, avatar, apiKey);

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

    // Hybrid intent: keyword прво, LLM само ако е нејасно
    const keywordResult = classifyIntent(userText);
    const intent = keywordResult.confident
      ? keywordResult.intent
      : await classifyWithLLM(userText, apiKey);

    console.log(`[COO] lang:${lang} | intent:${intent} | confident:${keywordResult.confident} | memory:${memory.recent.length} msgs | text:${userText.slice(0, 60)}`);

    // Додај summary во system prompt ако постои
    let enrichedSystem = buildSystemPrompt(intent, lang, today);
    if (memory.summary) {
      enrichedSystem += `\n\n${memory.summary}`;
    }

    // ═══ SERPER SEARCH — паметна детекција ═══
    const lower = userText.toLowerCase();

    // Дали бара приватни понуди
    const wantsPrivate = ['приватна','приватни','понуда','понуди','privatna','privatni','ponuda','ponudi',
      'oglas','oglasi','оглас','изведба','izvedba','fasad','фасад','krov','кров','gradez','градеж',
      'raboti','работи','услуга','usluga','поdizvrsitel','podizvrsitel'].some(k => lower.includes(k));

    // Дали бара државни/јавни тендери
    const wantsTender = intent === 'tender' || ['тендер','tender','јавна набавка','javna nabavka',
      'државна','drzavna','državna','javna','јавна','nabavka','набавка','ponuda','понуда'].some(k => lower.includes(k));

    // Дали бара грантови — keyword check + intent
    const wantsGrant = intent === 'grant' || [
      'grant','grand','грант','fond','фонд','finansiranje','финансирање',
      'finansiska','финансиска','subvencija','субвенција','fitr','ipard',
      'startup','стартап','podrska','поддршка','eu fond','eu фонд',
      'horizon','erasmus','undp','повик','povikot','aplicira','аплицира'
    ].some(k => lower.includes(k));

    if (serperKey) {
      const allResults = [];

      // Приватни понуди
      if (wantsPrivate) {
        const keywords = extractKeywords(userText);
        const privateQuery = `${keywords} site:pazar3.mk OR site:biznis.mk OR site:oglasi.mk OR site:halo.rs`;
        console.log(`[Serper private] ${privateQuery}`);
        const privateResults = await searchSerper(privateQuery, serperKey);
        console.log(`[Serper private] results: ${privateResults?.length || 0}`);
        if (privateResults?.length > 0) allResults.push(...privateResults);
      }

      // Јавни тендери
      if (wantsTender) {
        const tenderQuery = buildSearchQuery(userText, 'tender');
        console.log(`[Serper tender] ${tenderQuery}`);
        const tenderResults = await searchSerper(tenderQuery, serperKey);
        console.log(`[Serper tender] results: ${tenderResults?.length || 0}`);
        if (tenderResults?.length > 0) allResults.push(...tenderResults);
      }

      // Грантови
      if (wantsGrant) {
        const grantQuery = buildSearchQuery(userText, 'grant');
        console.log(`[Serper grant] ${grantQuery}`);
        const grantResults = await searchSerper(grantQuery, serperKey);
        console.log(`[Serper grant] results: ${grantResults?.length || 0}`);
        if (grantResults?.length > 0) allResults.push(...grantResults);
      }

      if (allResults.length > 0) {
        // Дедупликација по линк
        const seen = new Set();
        const unique = allResults.filter(r => { if (seen.has(r.link)) return false; seen.add(r.link); return true; }).slice(0, 4);
        enrichedSystem += formatSearchResults(unique, wantsPrivate ? 'business' : intent);
      } else if (wantsPrivate || wantsTender || wantsGrant) {
        enrichedSystem += `

═══ НЕМА РЕАЛНИ РЕЗУЛТАТИ ═══
LIVE SEARCH не врати ниту еден резултат за ова барање.

КРИТИЧНО — ЗАДОЛЖИТЕЛНО:
- НЕ измислувај линкови, URL-адреси, имиња на програми, износи или рокови
- НЕ пишувај пример линкови со забелешка дека се примери — тоа е халуцинација
- НЕ се извинувај за ограничувања на системот
- НЕ објаснувај зошто нема резултати

НАМЕСТО ТОА — направи ЕДНО:
1. Предложи конкретна следна акција (директен контакт, специфична организација по ime)
2. Постави едно прецизно прашање за подобро насочување на корисникот
3. Објасни кој е вистинскиот канал (не листа — само еден конкретен)
═══`;
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

    // Зачувај memory + зголеми quota
    if (userId) {
      await Promise.all([
        saveMemory(userId, avatar, 'user', userText),
        saveMemory(userId, avatar, 'assistant', text),
        incrementUserQuota(userId)
      ]);
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
