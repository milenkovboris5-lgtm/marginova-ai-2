// ═══════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// Grant Acquisition Engine
// Supabase 80% | Gemini 90% | Serper 10%
// ═══════════════════════════════════════════

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const DAILY_LIMIT = 200;
const PLANS = { free: 20, starter: 500, pro: 2000, business: -1 };
const ipStore = {};

// ═══ FETCH WITH TIMEOUT ═══
function ft(url, opts = {}, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

// ═══ IP RATE LIMIT ═══
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

// ═══ SUPABASE HELPER ═══
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
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(body)
    }, 5000);
  } catch {}
}

// ═══ QUOTA ═══
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

async function incQuota(userId) {
  if (!userId) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    const rows = await dbGet(`profiles?user_id=eq.${userId}&select=daily_msgs,last_msg_date`);
    const p = rows?.[0];
    const used = p?.last_msg_date === today ? (p?.daily_msgs || 0) : 0;
    await dbPatch(`profiles?user_id=eq.${userId}`, { daily_msgs: used + 1, last_msg_date: today });
  } catch {}
}

// ═══ LOAD USER PROFILE ═══
async function loadProfile(userId) {
  if (!userId) return null;
  try {
    const rows = await dbGet(`profiles?user_id=eq.${userId}&select=sector,country,organization_type,goals,plan`);
    return rows?.[0] || null;
  } catch { return null; }
}

// ═══ FIT ENGINE — Supabase grant matching ═══
function calcFitScore(grant, profile) {
  if (!profile) return 0;
  let score = 0;

  // Sector match (40 points)
  if (grant.sector && profile.sector) {
    const grantSectors = grant.sector.map(s => s.toLowerCase());
    const userSector = profile.sector.toLowerCase();
    if (grantSectors.some(s => s.includes(userSector) || userSector.includes(s))) {
      score += 40;
    } else if (grantSectors.some(s => s.includes('сите') || s.includes('all') || s.includes('general'))) {
      score += 25;
    }
  }

  // Country match (30 points)
  if (grant.country && profile.country) {
    const grantCountries = grant.country.map(c => c.toLowerCase());
    const userCountry = profile.country.toLowerCase();
    if (grantCountries.includes(userCountry)) {
      score += 30;
    } else if (grantCountries.includes('eu') || grantCountries.includes('balkans')) {
      score += 20;
    }
  }

  // Budget match (20 points)
  if (grant.min_amount && grant.max_amount && profile.goals) {
    const budgetMap = { small: 30000, medium: 150000, large: 500000, xlarge: 2000000 };
    const userBudget = budgetMap[profile.goals] || 30000;
    if (userBudget >= grant.min_amount && userBudget <= grant.max_amount) {
      score += 20;
    } else if (userBudget >= grant.min_amount * 0.5 && userBudget <= grant.max_amount * 2) {
      score += 10;
    }
  } else {
    score += 10; // No budget constraint
  }

  // Organization type match (10 points)
  if (grant.eligibility && profile.organization_type) {
    const eligLower = grant.eligibility.toLowerCase();
    const orgMap = {
      startup: ['стартап', 'startup', 'претпријатија', 'компании'],
      sme: ['мало', 'средно', 'претпријатија', 'sme', 'компании'],
      ngo: ['нво', 'здружение', 'фондација', 'граѓански', 'ngo', 'организации'],
      agri: ['земјоделск', 'рурал', 'agri', 'стопанства'],
      municipality: ['општини', 'јавни', 'институции', 'municipality'],
      university: ['универзитет', 'истражувач', 'university', 'research'],
      individual: ['физички', 'лица', 'individual', 'претприемач']
    };
    const keywords = orgMap[profile.organization_type] || [];
    if (keywords.some(k => eligLower.includes(k))) {
      score += 10;
    }
  }

  return Math.min(score, 100);
}

async function loadMatchingGrants(profile) {
  try {
    // Земи сите активни грантови
    const grants = await dbGet(`grants?active=eq.true&select=*`);
    if (!grants || grants.length === 0) return [];

    // Пресметај fit score за секој грант
    const scored = grants.map(g => ({
      ...g,
      fitScore: calcFitScore(g, profile)
    }));

    // Врати само оние со score > 40%, сортирани
    return scored
      .filter(g => g.fitScore > 40)
      .sort((a, b) => b.fitScore - a.fitScore)
      .slice(0, 4);
  } catch { return []; }
}

async function loadProcesses(grantId) {
  if (!grantId) return [];
  try {
    const rows = await dbGet(`processes?grant_id=eq.${grantId}&order=step_number.asc&select=*`);
    return rows || [];
  } catch { return []; }
}

// ═══ DETECT LANGUAGE ═══
function detectLang(text) {
  if (/ќ|ѓ|ѕ|љ|њ|џ/i.test(text)) return 'mk';
  if (/ћ|ђ/i.test(text)) return 'sr';
  if (/[а-шА-Ш]/.test(text)) return 'mk';
  if (/\b(und|oder|ich|nicht)\b/.test(text)) return 'de';
  if (/\b(jest|się|nie|dla)\b/.test(text)) return 'pl';
  if (/\b(ve|bir|için|ile)\b/.test(text)) return 'tr';
  if (/\b(dhe|është|për)\b/.test(text)) return 'sq';
  if (/\b(sam|smo|ili)\b/.test(text)) return 'sr';
  return 'en';
}

// ═══ DETECT INTENT ═══
function getIntent(text) {
  const t = text.toLowerCase();
  if (/грант|фонд|grant|fond|финансир|ipard|fitr|субвенц|повик|erasmus|horizon|civica|undp|interreg/.test(t)) return 'grant';
  if (/закон|право|договор|legal|zakon|ugovor|даноц|gdpr/.test(t)) return 'legal';
  if (/анализ|swot|analiz|споредба/.test(t)) return 'analysis';
  return 'business';
}

// ═══ DETECT IF ASKING ABOUT SPECIFIC GRANT ═══
function detectGrantFocus(text) {
  const t = text.toLowerCase();
  if (/fitr|фитр/.test(t)) return 'FITR';
  if (/ipard|ипард/.test(t)) return 'IPARD';
  if (/erasmus|еразмус/.test(t)) return 'ERASMUS';
  if (/horizon|хоризон/.test(t)) return 'Horizon';
  if (/interreg|интеррег/.test(t)) return 'INTERREG';
  if (/civica|цивика/.test(t)) return 'Civica';
  if (/undp|ундп/.test(t)) return 'UNDP';
  if (/western balkans|западен балкан|wbf/.test(t)) return 'WBF';
  return null;
}

// ═══ BUILD SYSTEM PROMPT ═══
const LANG_NAMES = {
  mk: 'македонски', sr: 'српски', hr: 'хрватски', bs: 'босански',
  en: 'English', de: 'Deutsch', sq: 'shqip', bg: 'български', tr: 'Türkçe', pl: 'polski'
};

function buildPrompt(lang, today, profile, matchedGrants, processes, grantFocus) {
  const L = LANG_NAMES[lang] || 'English';

  // Format profile
  const profileText = profile ? `
Organization type: ${profile.organization_type || 'not specified'}
Sector: ${profile.sector || 'not specified'}
Country: ${profile.country || 'mk'}
Budget range: ${profile.goals || 'not specified'}` : 'Profile not set — ask user for sector, country, and organization type.';

  // Format matched grants
  let grantsText = '';
  if (matchedGrants.length > 0) {
    grantsText = matchedGrants.map(g => `
---
Grant: ${g.name}
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
    grantsText = 'No grants matched the user profile above 40% fit score.';
  }

  // Format processes
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

  return `You are MARGINOVA — Grant Acquisition Engine for the Balkans and Europe.
You are not an assistant. You are a grant strategist who has helped organizations win millions in funding.
You think like an investor: ruthless about fit, honest about chances, concrete about next steps.

Language: ${L} — respond EXCLUSIVELY in this language. Never switch.
Today: ${today}
${grantFocus ? `User is asking about: ${grantFocus}` : ''}

═══ USER PROFILE ═══${profileText}

═══ MATCHED GRANTS FROM DATABASE ═══${grantsText}
${processText}

═══ YOUR MISSION ═══

ASSESS FIT — For each matched grant, the Fit Score is already calculated above.
Use it to rank and recommend grants.

Fit Score interpretation:
- 90-100%: Perfect match → recommend immediately
- 70-89%: Strong match → recommend with minor notes
- 50-69%: Partial match → recommend with clear conditions
- Below 50%: Do not recommend

RECOMMEND FORMAT (use for grant recommendations):
📋 [Grant name]
🏆 Fit Score: [X%]
💰 €[min] — €[max] | [co-finance]% co-financing
✅ Why you qualify: [specific reason based on profile]
⚠️ Main risk: [one concrete obstacle]
🔗 [portal_url]

GUIDE FORMAT (use when explaining application steps):
Step [N]/[total]: [title]
→ [what to do concisely]
→ [institution]
→ [duration]
→ Documents: [list]

═══ BEHAVIORAL RULES ═══
- General answers: max 200 words
- Step-by-step guides: as detailed as needed, no word limit
- Never hallucinate amounts, deadlines or links not in the database
- Never say "I cannot help" — always give best available advice
- If profile is incomplete → ask ONE specific question to complete it
- Use informal address (ти/твој in Macedonian/Serbian, tu in others)
- Challenge weak applications directly — protect users from wasting time on low-fit grants
- If no grants match → explain exactly why and what to change to become eligible
- End every response with ONE concrete next action the user can take today`;
}

// ═══ GEMINI CALL ═══
async function gemini(systemPrompt, messages, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
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
      generationConfig: { maxOutputTokens: 4096, temperature: 0.7 }
    })
  }, 30000);

  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 100)}`);
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY.' } });

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

    console.log(`[GAE] lang:${lang} intent:${intent} focus:${grantFocus || 'none'} user:${userId?.slice(0,8) || 'anon'}`);

    // ═══ SUPABASE — Load profile + matching grants ═══
    const [profile, allGrants] = await Promise.all([
      loadProfile(userId),
      dbGet('grants?active=eq.true&select=*')
    ]);

    // Fit Engine
    let matchedGrants = [];
    if (allGrants && allGrants.length > 0) {
      const scored = allGrants.map(g => ({ ...g, fitScore: calcFitScore(g, profile) }));
      matchedGrants = scored.filter(g => g.fitScore > 40).sort((a, b) => b.fitScore - a.fitScore).slice(0, 4);
    }

    // Load processes for top grant or focused grant
    let processes = [];
    if (grantFocus || userText.toLowerCase().includes('процес') || userText.toLowerCase().includes('process') || userText.toLowerCase().includes('чекор') || userText.toLowerCase().includes('step') || userText.toLowerCase().includes('апликација') || userText.toLowerCase().includes('application')) {
      const targetGrant = grantFocus
        ? matchedGrants.find(g => g.name.toLowerCase().includes(grantFocus.toLowerCase()) || g.funder.toLowerCase().includes(grantFocus.toLowerCase()))
        : matchedGrants[0];
      if (targetGrant) {
        processes = await loadProcesses(targetGrant.id);
        console.log(`[GAE] Loaded ${processes.length} process steps for ${targetGrant.name}`);
      }
    }

    console.log(`[GAE] Profile:${profile ? 'yes' : 'no'} | Matched grants:${matchedGrants.length} | Processes:${processes.length}`);

    // Build messages for Gemini
    const messages = (body.messages || []).slice(-6).map(m => ({
      role: m.role,
      content: String(m.content || '')
    }));

    const systemPrompt = buildPrompt(lang, today, profile, matchedGrants, processes, grantFocus);
    const text = await gemini(systemPrompt, messages, apiKey);

    // Increment quota async
    if (userId) incQuota(userId).catch(() => {});

    return res.status(200).json({ content: [{ type: 'text', text }], intent });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
