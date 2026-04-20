// ═══════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// Grant Acquisition Engine
// VERSION: v6 — Supabase + Serper + Gemini
// ═══════════════════════════════════════════

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const SERPER_KEY = process.env.SERPER_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const DAILY_LIMIT = 200;
const PLANS = { free: 20, starter: 500, pro: 2000, business: -1 };
const ipStore = {};

// ═══ HELPERS ═══

function ft(url, opts = {}, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

function checkIP(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const key = ip + '_' + new Date().toISOString().split('T')[0];
  const now = Date.now();
  for (const k in ipStore) if (ipStore[k].t < now) delete ipStore[k];
  if (!ipStore[key]) {
    const e = new Date(); e.setHours(23, 59, 59, 999);
    ipStore[key] = { n: 0, t: e.getTime() };
  }
  ipStore[key].n++;
  return ipStore[key].n <= DAILY_LIMIT;
}

// ═══ SUPABASE ═══

async function dbGet(path) {
  if (!SUPA_URL || !SUPA_KEY) return null;
  try {
    const r = await ft(`${SUPA_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, Prefer: '' }
    }, 6000);
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function dbPatch(path, body) {
  if (!SUPA_URL || !SUPA_KEY) return;
  try {
    await ft(`${SUPA_URL}/rest/v1/${path}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(body)
    }, 5000);
  } catch {}
}

async function checkQuota(userId) {
  if (!userId) return true;
  try {
    const today = new Date().toISOString().split('T')[0];
    const rows = await dbGet(`profiles?user_id=eq.${userId}&select=plan,daily_msgs,last_msg_date`);
    const p = rows?.[0];
    if (!p) return true;
    const limit = PLANS[p.plan] ?? 20;
    if (limit === -1) return true;
    const used = p.last_msg_date === today ? (p.daily_msgs || 0) : 0;
    return used < limit;
  } catch { return true; }
}

async function loadProfile(userId) {
  if (!userId) return null;
  try {
    const rows = await dbGet(
      `profiles?user_id=eq.${userId}&select=sector,country,organization_type,goals,plan,detected_sector,detected_org_type,detected_country`
    );
    const p = rows?.[0];
    if (!p) return null;
    return {
      ...p,
      sector: p.sector || p.detected_sector || null,
      organization_type: p.organization_type || p.detected_org_type || null,
      country: p.country || p.detected_country || 'mk',
    };
  } catch { return null; }
}

// ═══ SERPER — live web пребарување ═══

async function serperSearch(query) {
  if (!SERPER_KEY) return [];
  try {
    const r = await ft('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: query, gl: 'mk', hl: 'mk', num: 5 })
    }, 8000);
    if (!r.ok) return [];
    const d = await r.json();
    // Земи organic резултати — title, snippet, link
    return (d.organic || []).slice(0, 5).map(item => ({
      title: item.title || '',
      snippet: item.snippet || '',
      link: item.link || ''
    }));
  } catch (e) {
    console.error('[SERPER] Error:', e.message);
    return [];
  }
}

// Гради паметен Serper query врз основа на профилот и прашањето
function buildSerperQuery(userText, profile, grantFocus) {
  const year = new Date().getFullYear();
  const country = profile?.country === 'mk' ? 'Македонија' :
                  profile?.country === 'rs' ? 'Србија' :
                  profile?.country === 'hr' ? 'Хрватска' : 'Балкан';

  // Ако корисникот прашува за конкретна програма
  if (grantFocus && !['NGO', 'FOND'].includes(grantFocus)) {
    return `${grantFocus} повик ${year} ${country} услови апликација`;
  }

  // Ако прашува за земјоделство
  if (profile?.sector === 'agriculture' || profile?.organization_type === 'agri') {
    return `IPARD АФПЗРР грант земјоделство ${year} ${country} отворен повик`;
  }

  // Ако е НВО
  if (profile?.organization_type === 'ngo' || profile?.sector === 'civil society') {
    return `грант НВО граѓанско општество ${year} ${country} отворен повик`;
  }

  // Општо пребарување по сектор
  const sectorMap = {
    'it': 'ИТ технологија дигитализација',
    'education': 'образование млади',
    'environment': 'животна средина зелена економија',
    'tourism': 'туризам култура',
    'energy': 'енергетика обновливи извори',
    'research': 'истражување иновации',
    'sme': 'мали средни претпријатија',
  };
  const sectorTerm = sectorMap[profile?.sector] || 'грант фонд';

  return `${sectorTerm} грант финансирање ${year} ${country} отворен повик`;
}

// ═══ FIT ENGINE ═══

function calcFitScore(grant, profile) {
  if (!profile) return 50;

  let score = 0;

  // SECTOR MATCH (35 points)
  if (grant.sector && profile.sector) {
    const grantSectors = grant.sector.map(s => s.toLowerCase().trim());
    const userSector = profile.sector.toLowerCase().trim();

    const sectorAliases = {
      'it': ['it', 'tech', 'digital', 'software', 'innovation', 'иновации', 'дигитал', 'дигитализација', 'истражување', 'research', 'технологија', 'sme'],
      'agriculture': ['agriculture', 'agri', 'rural', 'рурален развој', 'земјоделство', 'food', 'храна', 'овоштарство', 'лозарство'],
      'education': ['education', 'образование', 'млади', 'youth', 'training', 'обука'],
      'environment': ['environment', 'животна средина', 'green', 'зелена', 'еколог', 'energy', 'енерг'],
      'civil society': ['civil society', 'граѓанско општество', 'граѓанск', 'ngo', 'нво', 'демократ', 'human rights', 'невладин', 'здружение'],
      'tourism': ['tourism', 'туризам', 'туриз', 'culture', 'култур', 'регионален развој'],
      'energy': ['energy', 'енергетика', 'енерг', 'renewable', 'обновлив', 'environment'],
      'health': ['health', 'здравство', 'здравств', 'social', 'социјалн'],
      'research': ['research', 'истражување', 'innovation', 'иновации', 'it', 'tech', 'university'],
      'sme': ['sme', 'it', 'tech', 'иновации', 'дигитализација', 'економски развој', 'претпријатија'],
    };

    const aliases = sectorAliases[userSector] || [userSector];
    const matched = grantSectors.some(gs => aliases.some(a => gs.includes(a) || a.includes(gs)));

    if (matched) score += 35;
    else if (grantSectors.some(s => s.includes('сите') || s.includes('all') || s.includes('general'))) score += 20;
    else score += 5;
  } else {
    score += 20;
  }

  // COUNTRY MATCH (30 points)
  if (grant.country && profile.country) {
    const grantCountries = grant.country.map(c => c.toLowerCase().trim());
    const userCountry = (profile.country || 'mk').toLowerCase().trim();

    if (grantCountries.includes(userCountry)) score += 30;
    else if (grantCountries.some(c => ['eu', 'balkans', 'europe', 'европ', 'western balkans'].includes(c))) score += 22;
    else if (grantCountries.length > 3) score += 15;
  } else {
    score += 15;
  }

  // ORG TYPE MATCH (25 points)
  if (grant.eligibility && profile.organization_type) {
    const eligLower = grant.eligibility.toLowerCase();
    const orgMap = {
      startup:      ['стартап', 'startup', 'претпријатија', 'иновативни', 'нови'],
      sme:          ['мало', 'средно', 'претпријатија', 'sme', 'компании', 'бизнис'],
      ngo:          ['нво', 'здружение', 'фондација', 'граѓански', 'ngo', 'организации', 'civil', 'невладин', 'непрофитн'],
      agri:         ['земјоделск', 'рурал', 'agri', 'стопанства', 'физички лица', 'фармер', 'земјоделец', 'овоштар'],
      municipality: ['општини', 'јавни', 'институции', 'municipality', 'локалн'],
      university:   ['универзитет', 'истражувач', 'university', 'research', 'институт'],
      individual:   ['физички', 'лица', 'individual', 'претприемач', 'граѓани', 'трговец']
    };
    const keywords = orgMap[profile.organization_type] || [];
    if (keywords.some(k => eligLower.includes(k))) score += 25;
    else score += 8;
  } else {
    score += 12;
  }

  // BUDGET MATCH (10 points)
  if (grant.min_amount && grant.max_amount && profile.goals) {
    const budgetMap = { small: 25000, medium: 90000, large: 300000, xlarge: 1000000 };
    const userBudget = budgetMap[profile.goals] || 90000;
    if (userBudget >= grant.min_amount && userBudget <= grant.max_amount) score += 10;
    else if (userBudget >= grant.min_amount * 0.3) score += 5;
  } else {
    score += 5;
  }

  return Math.min(score, 100);
}

async function loadProcesses(grantId) {
  if (!grantId) return [];
  try {
    const rows = await dbGet(`processes?grant_id=eq.${grantId}&order=step_number.asc&select=*`);
    return rows || [];
  } catch { return []; }
}

// ═══ DETECTION ═══

function detectLang(text) {
  if (/ќ|ѓ|ѕ|љ|њ|џ/i.test(text)) return 'mk';
  if (/ћ|ђ/i.test(text)) return 'sr';
  if (/јас|сум|македонија|барам|грант|работам|организација|НВО|невладина|фонд/i.test(text)) return 'mk';
  if (/[а-шА-Ш]/.test(text)) return 'mk';
  if (/\b(jas|sum|makedonija|macedonija|zdravo|mozes|mozam|sakam|imam|sektor|zemja|organizacija|proekt|grant|fond|makedonski|zemjodelie|ovostar|hektar|severna|poedinec|trgovec)\b/.test(text.toLowerCase())) return 'mk';
  if (/\b(und|oder|ich|nicht|sie|wir)\b/.test(text)) return 'de';
  if (/\b(sam|smo|nije|nisu|brate|bre|jeste|jesam)\b/.test(text)) return 'sr';
  return 'en';
}

function getIntent(text) {
  const t = text.toLowerCase();
  if (/фонд|fond|фондација|foundation|fund|светски фонд|билатерал/.test(t)) return 'fund';
  if (/нво|невладин|граѓанск|здружение|civil society|ngo|nonprofit/.test(t)) return 'ngo';
  if (/грант|grant|финансир|ipard|fitr|субвенц|повик|erasmus|horizon|civica|undp|interreg/.test(t)) return 'grant';
  if (/закон|право|договор|legal|даноц|gdpr/.test(t)) return 'legal';
  if (/анализ|swot|споредба/.test(t)) return 'analysis';
  return 'general';
}

function detectGrantFocus(text) {
  const t = text.toLowerCase();
  if (/fitr|фитр/.test(t)) return 'FITR';
  if (/ipard|ипард/.test(t)) return 'IPARD';
  if (/erasmus|еразмус/.test(t)) return 'ERASMUS';
  if (/horizon|хоризон/.test(t)) return 'Horizon Europe';
  if (/interreg|интеррег/.test(t)) return 'INTERREG';
  if (/civica|цивика/.test(t)) return 'Civica Mobilitas';
  if (/undp|ундп/.test(t)) return 'UNDP';
  if (/western balkans|западен балкан|wbf/.test(t)) return 'WBF';
  if (/eu4business|еу4бизнис/.test(t)) return 'EU4Business';
  if (/usaid|усаид/.test(t)) return 'USAID';
  if (/giz|гиз/.test(t)) return 'GIZ';
  if (/open society|отворено општество|soros/.test(t)) return 'Open Society';
  if (/world bank|светска банка/.test(t)) return 'World Bank';
  if (/нво|ngo|невладин|граѓанск|здружение/.test(t)) return 'NGO';
  if (/фонд|fond|fund/.test(t)) return 'FOND';
  return null;
}

function detectProfile(conversationText, supaProfile) {
  const t = conversationText.toLowerCase();

  const detectedSector =
    /\bit\b|tech|software|дигитал|web|app|платформ|дигитализација/.test(t) ? 'it' :
    /земјоделст|земјоделие|земјоделец|земјоделск|agri|рурал|фарм|farm|сточар|овошт|круш|јаболк|лозар|пченк|житар|нива|хектар|насади|добиток|млеко|zemjodelie|zemjodel|ovos|ovostar|krus|hektar|nasad|lozar|dobitok/.test(t) ? 'agriculture' :
    /образован|education|учење|learning|школ|school|студент/.test(t) ? 'education' :
    /животна средина|environment|зелен|green|еколог|climate/.test(t) ? 'environment' :
    /нво|ngo|здружение|граѓанск|civil society|невладин|фондација/.test(t) ? 'civil society' :
    /туриз|tourism|хотел|hotel|угостител/.test(t) ? 'tourism' :
    /енерг|energy|сончев|solar|обновлив|renewable/.test(t) ? 'energy' :
    null;

  const detectedOrg =
    /стартап|startup|нова компанија|новооснован|spin.?off/.test(t) ? 'startup' :
    /земјоделец|земјоделие|фармер|farmer|аграр|стопанство|хектар|круш|овошт|лозар|добиток|zemjodel|farmer|hektar|krus|ovos|ovostar|lozar|dobitok|trgovec poedinec|трговец поединец|физичко лице земјоделец|zemjodelie|zemjodel/.test(t) ? 'agri' :
    /нво|НВО|ngo|NGO|здружение|фондација|граѓанск|невладин/.test(t) ? 'ngo' :
    /физичко лице|поединец|претприемач|individual|entrepreneur/.test(t) ? 'individual' :
    /мало претпријатие|средно претпријатие|sme|фирма|компанија|dooел|ооd/.test(t) ? 'sme' :
    /општина|municipality|јавна институција/.test(t) ? 'municipality' :
    /универзитет|university|институт|истражув/.test(t) ? 'university' :
    null;

  const detectedCountry =
    /македониј|makedon|северна македониј|north macedon/.test(t) ? 'mk' :
    /србиј|srbij/.test(t) ? 'rs' :
    /хрватск|hrvat/.test(t) ? 'hr' :
    /босн|bosn/.test(t) ? 'ba' :
    (supaProfile?.country) || 'mk';

  const detectedGoals =
    /1\.?000\.?000|1 милион|1m\b/.test(t) ? 'xlarge' :
    /500\.?000|500k|петстотини/.test(t) ? 'large' :
    /[2-9]\d{2}\.?000|[2-9]\d\dk/.test(t) ? 'large' :
    /100\.?000|100k|сто илјади/.test(t) ? 'medium' :
    /[5-9]\d\.?000|[5-9]\dk/.test(t) ? 'medium' :
    /[1-4]\d\.?000|[1-4]\dk/.test(t) ? 'small' :
    null;

  return { detectedSector, detectedOrg, detectedCountry, detectedGoals };
}

// ═══ PROMPT BUILDER ═══

const LANG_NAMES = {
  mk: 'македонски', sr: 'српски', hr: 'хрватски', bs: 'босански',
  en: 'English', de: 'Deutsch', sq: 'shqip', bg: 'български', tr: 'Türkçe'
};

function buildPrompt(lang, today, profile, matchedGrants, processes, grantFocus, intent, webResults) {
  const L = LANG_NAMES[lang] || 'English';

  // ── Профил ──
  const profileText = profile
    ? `\nOrganization type: ${profile.organization_type || 'not specified'}
Sector: ${profile.sector || 'not specified'}
Country: ${profile.country || 'mk'}
Budget range: ${profile.goals || 'not specified'}`
    : 'Profile not set — ask ONE question to get sector + org type.';

  // ── Програми од базата ──
  let dbText = '';
  if (matchedGrants.length > 0) {
    dbText = matchedGrants.map(g => `
---
Program: ${g.name}
Type: ${g.type || 'grant'}
Funder: ${g.funder}
Fit Score: ${g.fitScore}%
Amount: €${g.min_amount?.toLocaleString() || '?'} — €${g.max_amount?.toLocaleString() || '?'}
Co-financing: ${g.co_finance_percent || '?'}%
Sectors: ${g.sector?.join(', ') || 'various'}
Countries: ${g.country?.join(', ') || 'various'}
Eligibility: ${g.eligibility || 'see portal'}
Portal: ${g.portal_url || 'N/A'}
Active: ${g.active ? 'Yes' : 'No'}`).join('\n');
  } else {
    dbText = 'No programs in database matched — use web results below to advise the user.';
  }

  // ── Application process чекори ──
  let processText = '';
  if (processes.length > 0) {
    const grant = matchedGrants.find(g => processes[0]?.grant_id === g.id);
    processText = `\n\nAPPLICATION PROCESS${grant ? ` FOR ${grant.name.toUpperCase()}` : ''}:\n` +
      processes.map(p =>
        `Step ${p.step_number}/${processes.length}: ${p.title}
  What to do: ${p.description}
  Documents: ${p.documents?.join(', ') || 'none'}
  Duration: ${p.duration_days ? p.duration_days + ' days' : 'variable'}
  Where: ${p.institution || 'N/A'}
  Link: ${p.url || 'N/A'}`
      ).join('\n\n');
  }

  // ── Serper web резултати ──
  let webText = '';
  if (webResults && webResults.length > 0) {
    webText = '\n\n═══ LIVE WEB RESULTS (current open calls, deadlines, news) ═══\n' +
      webResults.map((r, i) =>
        `[${i + 1}] ${r.title}\n    ${r.snippet}\n    Source: ${r.link}`
      ).join('\n\n');
  }

  return `=== MANDATORY LANGUAGE: ${L.toUpperCase()} ===
Respond ONLY in ${L}. If user switches language, follow immediately.
mk = македонски | sr = српски | en = English
=== END LANGUAGE ===

You are MARGINOVA — Grant & Fund Acquisition Engine for the Balkans and Europe.
You are a funding strategist. You have TWO data sources:
1. INTERNAL DATABASE — verified programs with fit scores
2. LIVE WEB RESULTS — current open calls, deadlines, news from today

Today: ${today}
${grantFocus ? `User is asking about: ${grantFocus}` : ''}
Intent: ${intent}

═══ USER PROFILE ═══${profileText}

If profile is incomplete → ask ONE specific question. Never assume missing fields.

═══ INTERNAL DATABASE — MATCHED PROGRAMS ═══${dbText}
${processText}
${webText}

═══ HOW TO USE BOTH SOURCES ═══
- Use DATABASE programs as primary recommendations with fit scores
- Use WEB RESULTS to add: current deadlines, open/closed status, new calls not in database
- If database has no matches but web shows relevant results → recommend from web with note "found online, verify details"
- NEVER say "no matches found" — always give the best available options from both sources
- NEVER hallucinate amounts or deadlines not in the data above

═══ RESPONSE FORMAT ═══

For program recommendations:
📋 [Program name]
🏆 Fit Score: [X%] | Source: [Database / Web]
💰 €[min] — €[max] | [co-finance]% co-financing
✅ Why you qualify: [specific reason]
⚠️ Main risk: [one concrete obstacle]
🔗 [link]

For application guides:
Step [N]/[total]: [title]
→ [action]
→ [institution] | [duration]
→ Documents: [list]

═══ RULES ═══
- Be direct and specific. No Wikipedia answers.
- Max 250 words for general answers, no limit for step-by-step guides
- Always end with ONE concrete next action the user can take TODAY
- Use informal address (ти/твој in Macedonian/Serbian)
- If user is agri/farmer → always show IPARD + АФПЗРР programs first
- If user is NGO → show all NGO-eligible programs regardless of type
- Fit score below 30%? Still show it — explain what's needed to qualify`;
}

// ═══ GEMINI ═══

async function gemini(systemPrompt, messages) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }]
  }));
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Hello' }] });

  const r = await ft(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 4096, temperature: 0.65 }
    })
  }, 30000);

  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ═══ MAIN HANDLER ═══

module.exports = async function handler(req, res) {
  const ORIGINS = ['https://marginova.tech', 'https://www.marginova.tech', 'http://localhost:3000'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ORIGINS.includes(origin) ? origin : ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method Not Allowed' } });

  if (!checkIP(req)) return res.status(429).json({ error: { message: 'Daily limit reached.' } });
  if (!GEMINI_KEY) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY.' } });

  try {
    const body = req.body;
    const userId = body.userId || null;
    const userText = body.messages?.[body.messages.length - 1]?.content || '';

    if (userText.length > 2000) return res.status(400).json({ error: { message: 'Max 2000 chars.' } });
    if (userId && !(await checkQuota(userId))) {
      return res.status(429).json({ error: { message: 'Limit reached. Upgrade.' }, quota_exceeded: true });
    }

    const lang = body.lang || detectLang(userText);
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const intent = getIntent(userText);
    const grantFocus = detectGrantFocus(userText);

    console.log(`[GAE v6] lang:${lang} intent:${intent} focus:${grantFocus || 'none'} user:${userId?.slice(0,8) || 'anon'}`);

    // ── Паралелно: Supabase профил + сите гранти ──
    const [supaProfile, allGrants] = await Promise.all([
      loadProfile(userId),
      dbGet('grants?active=eq.true&select=*')
    ]);

    // ── Детектирај профил од разговорот ──
    const conversationText = (body.messages || []).map(m => m.content || '').join(' ');
    let profile = supaProfile;

    const { detectedSector, detectedOrg, detectedCountry, detectedGoals } = detectProfile(conversationText, supaProfile);

    if (!profile || !profile.sector || !profile.organization_type) {
      if (detectedSector || detectedOrg || detectedGoals) {
        profile = {
          ...supaProfile,
          sector: detectedSector || supaProfile?.sector || null,
          organization_type: detectedOrg || supaProfile?.organization_type || null,
          country: detectedCountry,
          goals: detectedGoals || supaProfile?.goals || 'medium'
        };
        console.log(`[GAE] Auto-detected — sector:${profile.sector} org:${profile.organization_type} country:${profile.country}`);

        // Зачувај детекциите во Supabase за следниот пат
        if (userId) {
          dbPatch('profiles?user_id=eq.' + userId, {
            detected_sector: profile.sector,
            detected_org_type: profile.organization_type,
            detected_country: profile.country
          }).catch(() => {});
        }
      }
    }

    // ── Fit scoring ──
    let matchedGrants = [];
    if (allGrants && allGrants.length > 0) {
      const isAgri = profile?.sector === 'agriculture' || profile?.organization_type === 'agri';
      const isNgoFund = intent === 'fund' || intent === 'ngo' || ['NGO', 'FOND'].includes(grantFocus);
      const threshold = (isAgri || isNgoFund) ? 15 : 25;
      const maxResults = (isAgri || isNgoFund) ? 8 : 6;

      const scored = allGrants.map(g => ({ ...g, fitScore: calcFitScore(g, profile) }));
      scored.forEach(g => console.log(`[FIT] ${g.name}: ${g.fitScore}%`));

      matchedGrants = scored
        .filter(g => g.fitScore >= threshold)
        .sort((a, b) => b.fitScore - a.fitScore)
        .slice(0, maxResults);

      // Секогаш прикажи барем нешто
      if (matchedGrants.length === 0) {
        matchedGrants = scored.sort((a, b) => b.fitScore - a.fitScore).slice(0, 4);
        console.log('[GAE] No matches above threshold — showing top 4 fallback');
      }
    }

    // ── Application process чекори ──
    let processes = [];
    const wantsProcess = grantFocus || /процес|process|чекор|step|апликација|application|водич|guide|kako da|how to/i.test(userText);
    if (wantsProcess && !['NGO', 'FOND'].includes(grantFocus)) {
      const target = grantFocus
        ? matchedGrants.find(g =>
            g.name.toLowerCase().includes(grantFocus.toLowerCase()) ||
            g.funder?.toLowerCase().includes(grantFocus.toLowerCase())
          )
        : matchedGrants[0];
      if (target) {
        processes = await loadProcesses(target.id);
        console.log(`[GAE] Process steps loaded: ${processes.length} for ${target.name}`);
      }
    }

    // ── Serper web пребарување — паралелно ──
    const serperQuery = buildSerperQuery(userText, profile, grantFocus);
    console.log(`[SERPER] Query: "${serperQuery}"`);
    const webResults = await serperSearch(serperQuery);
    console.log(`[SERPER] Results: ${webResults.length}`);

    // ── Генерирај одговор со Gemini ──
    const messages = (body.messages || []).slice(-8).map(m => ({
      role: m.role,
      content: String(m.content || '')
    }));

    const systemPrompt = buildPrompt(lang, today, profile, matchedGrants, processes, grantFocus, intent, webResults);
    const text = await gemini(systemPrompt, messages);

    console.log(`[GAE] Done — db:${matchedGrants.length} web:${webResults.length} intent:${intent}`);

    return res.status(200).json({ content: [{ type: 'text', text }], intent });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
