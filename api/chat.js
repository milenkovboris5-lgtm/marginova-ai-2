// ═══ MARGINOVA.AI — api/chat.js ═══
// 1 Gemini повик. Serper само по потреба. Без memory акумулација.

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

// ═══ SUPABASE — само quota ═══
async function dbGet(path) {
  if (!SUPA_URL || !SUPA_KEY) return null;
  try {
    const r = await ft(`${SUPA_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, Prefer: '' }
    }, 5000);
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

// ═══ LANGUAGE DETECTION ═══
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

// ═══ SEARCH TRIGGER DETECTION ═══
const SEARCH_TRIGGERS = [
  'тендер','набавка','оглас','грант','фонд','финансир','понуда','licitaci','откуп','купи','продава',
  'tender','nabavka','oglas','grant','fond','finansir','ponuda','startup','licitati',
  'повик','аплицир','субвенц','ipard','fitr','horizon','erasmus','prebaruvam','prebaraj',
  'дотација','subvencij','инвестиц','invest','аукциј','auction','javen povik'
];

function needsSearch(text) {
  const t = text.toLowerCase();
  return SEARCH_TRIGGERS.some(k => t.includes(k));
}

function getIntent(text) {
  const t = text.toLowerCase();
  if (/тендер|набавка|tender|nabavka|licitaci|јавна набавка|javen povik za nabavka/.test(t)) return 'tender';
  if (/грант|фонд|grant|fond|финансир|ipard|fitr|субвенц|повик|erasmus|horizon/.test(t)) return 'grant';
  if (/закон|право|договор|legal|zakon|ugovor|даноц|gdpr/.test(t)) return 'legal';
  if (/анализ|swot|analiz|споредба/.test(t)) return 'analysis';
  return 'business';
}

// ═══ SERPER SEARCH ═══
function extractKw(text) {
  const stop = new Set([
    'и','или','на','во','за','од','со','да','се','ми','си','ги','го','сакам','барам','имам','можеш','треба','кои','каде','кога','што','дали',
    'kako','sto','koja','mozes','imam','treba','the','and','for','in','of','to','a','an','is','i','ili','za','od','sa','da','je','su','na'
  ]);
  return text.toLowerCase()
    .replace(/[^\w\s\u0400-\u04FF]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w))
    .slice(0, 4).join(' ');
}

function getCountry(text) {
  const t = text.toLowerCase();
  if (/македон|makedon|северна македониј|north macedon/.test(t)) return { code: 'mk', gl: 'en' };
  if (/србиј|srbij/.test(t)) return { code: 'rs', gl: 'rs' };
  if (/хрват|hrvat/.test(t)) return { code: 'hr', gl: 'hr' };
  if (/босн|bosn/.test(t)) return { code: 'ba', gl: 'en' };
  if (/бугар|bulgar/.test(t)) return { code: 'bg', gl: 'bg' };
  if (/романиј|roman/.test(t)) return { code: 'ro', gl: 'ro' };
  if (/германиј|german|deutsch/.test(t)) return { code: 'de', gl: 'de' };
  if (/франциј|franc/.test(t)) return { code: 'fr', gl: 'fr' };
  if (/\beu\b|европ|europ/.test(t)) return { code: 'eu', gl: 'en' };
  return { code: 'mk', gl: 'en' };
}

async function serperSearch(query, key, gl = 'en') {
  try {
    const r = await ft('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
      body: JSON.stringify({ q: query, num: 5, gl })
    }, 8000);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.organic || []).slice(0, 4).map(x => ({
      title: x.title || '',
      snippet: (x.snippet || '').slice(0, 200),
      link: x.link || '',
      date: x.date || ''
    }));
  } catch { return []; }
}

async function doSearch(userText, intent, serperKey) {
  const kw = extractKw(userText);
  const { code, gl } = getCountry(userText);

  const GRANT_SITES = {
    mk: 'site:fitr.mk OR site:ipard.gov.mk OR site:westernbalkansfund.org OR site:mk.undp.org OR site:civicamobilitas.mk',
    rs: 'site:inovacionifond.rs OR site:apr.gov.rs',
    eu: 'site:ec.europa.eu OR site:interreg.eu OR site:eismea.eu',
    de: 'site:foerderdatenbank.de OR site:bmbf.de',
    fr: 'site:bpifrance.fr',
  };
  const TENDER_SITES = {
    mk: 'site:e-nabavki.gov.mk',
    rs: 'site:portal.ujn.gov.rs',
    hr: 'site:eojn.nn.hr',
    ba: 'site:ejn.ba',
    eu: 'site:ted.europa.eu',
  };

  const seen = new Set();
  const results = [];
  const add = (arr) => arr.forEach(r => {
    if (r.link && !seen.has(r.link)) { seen.add(r.link); results.push(r); }
  });

  if (intent === 'grant') {
    const site = GRANT_SITES[code] || GRANT_SITES.mk;
    const [r1, r2] = await Promise.all([
      serperSearch(`${kw} грант финансирање 2025`, serperKey, 'mk'),
      serperSearch(`${kw} grant fund 2025 ${site}`, serperKey, 'en'),
    ]);
    add(r1); add(r2);
  } else if (intent === 'tender') {
    const site = TENDER_SITES[code] || TENDER_SITES.mk;
    const [r1, r2] = await Promise.all([
      serperSearch(`${kw} тендер набавка ${site}`, serperKey, gl),
      serperSearch(`${kw} tender 2025 site:ted.europa.eu`, serperKey, 'en'),
    ]);
    add(r1); add(r2);
  } else {
    add(await serperSearch(`${kw} Македонија оглас понуда 2025`, serperKey, 'mk'));
  }

  console.log(`[SEARCH] intent:${intent} country:${code} kw:"${kw}" results:${results.length}`);
  return results.slice(0, 5);
}

// ═══ SYSTEM PROMPT ═══
const LANG_NAMES = {
  mk: 'македонски', sr: 'српски', hr: 'хрватски', bs: 'босански',
  en: 'English', de: 'Deutsch', sq: 'shqip', bg: 'български', tr: 'Türkçe', pl: 'polski'
};

function buildPrompt(lang, today, searchResults) {
  const L = LANG_NAMES[lang] || 'English';
  const hasResults = searchResults && searchResults.length > 0;

  let p = `You are MARGINOVA — a senior business operator with 20 years across the Balkans and Europe.
You have closed deals, written grant applications, read procurement laws, negotiated contracts,
and watched businesses succeed and fail. You think in outcomes, not processes.

LANGUAGE: Respond exclusively in ${L}. Auto-detect if unclear. Never switch. Today: ${today}.

═══ HOW YOU THINK ═══
Before every response, silently ask:
1. What does this person actually need right now?
2. What do they not know that they should?
3. What is the single most valuable thing I can say?
Then speak only the answer — never show the thinking.

═══ WHO YOU ARE ═══
You are not a search engine. You are not a portal directory.
You are the person in the room who has seen this before.
When someone asks about tenders — you know which ones are worth pursuing.
When someone asks about grants — you know which programs actually pay out.
When someone asks about a business idea — you know if it will work.
You have opinions. You share them directly.

═══ KNOWLEDGE YOU CARRY ═══
Macedonia:
→ FITR: startup grants €5k-€30k, R&D up to €200k, calls 2-3x/year → fitr.mk
→ IPARD III: 40-65% co-financing for agriculture/rural, min project €10k → ipard.gov.mk
→ IPA III: infrastructure, SME support, cross-border programs
→ Western Balkans Fund: regional cooperation, culture, youth → westernbalkansfund.org
→ UNDP Macedonia: social enterprise, green economy → mk.undp.org
→ Civica Mobilitas: civil society grants up to €150k → civicamobilitas.mk
→ Public tenders: e-nabavki.gov.mk (all public procurement MK)
→ Private market: mkizvrsiteli.mk (executor auctions), Centralen Registar (company financials)

EU & Global:
→ Horizon Europe: €95B total, R&D and innovation, WB candidates eligible
→ INTERREG: cross-border cooperation, up to €2M per project
→ ERASMUS+: education/youth, €10k-€400k depending on action
→ COSME/InvestEU: SME financing, loan guarantees via local banks
→ World Bank: infrastructure, public sector reform, private sector lending
→ EBRD: direct investment and loans for private companies in transition economies
→ IFC: World Bank Group equity and debt for private sector
→ EIF: venture capital and SME guarantees through local banks
→ EU tenders: ted.europa.eu

Balkans tender portals:
→ Serbia: portal.ujn.gov.rs | Croatia: eojn.nn.hr | BiH: ejn.ba | Bulgaria: app.eop.bg

═══ RESPONSE RULES ═══
- Max 180 words. Every sentence earns its place.
- Conversational questions → plain answer, no format tags
- Opportunity requests → use structured format below
- Never say "I cannot search" or "I don't have access" or "немам во базата"
- Never list portals without context — explain why that specific portal matters
- Never ask more than ONE clarifying question
- Never repeat yourself
- Never apologize for limitations
- Never start with "I understand" / "Разбирам" / "Great question"
- Never invent specific open call deadlines or grant amounts you are not certain about
- When no live data → answer from knowledge: name real programs, real amounts, real next step
- Challenge weak plans directly — then offer a better path

═══ OPPORTUNITY FORMAT ═══
(use ONLY when presenting real found opportunities or concrete recommendations)
[OPPORTUNITY] what exactly, where, for whom
[NUMBERS] €cost | €revenue or grant size | margin% or co-finance% | days to first action
[ACTION] step 1 → step 2 → step 3
[RISK] the one thing that kills this

═══ PERSONALITY ═══
Confident but not arrogant. Direct but not cold.
Honest about uncertainty — but always knows something useful.
Challenges weak thinking. Protects people from bad decisions.
The advisor they wish they had in the room.`;

  if (hasResults) {
    const d = new Date().toLocaleDateString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric' });
    p += `\n\n═══ LIVE DATA (${d}) ═══\nUse ONLY these verified results. Never invent links or data.\n`;
    searchResults.forEach((r, i) => {
      p += `${i + 1}. ${r.title}${r.date ? ' | ' + r.date : ''}\n   ${r.snippet}\n   🔗 ${r.link}\n`;
    });
    p += `\nPresent the best result using the format above.`;
  } else if (searchResults !== undefined) {
    p += `\n\n0 live results from search. Answer from your knowledge base — give ONE concrete opportunity with real program name, realistic amount range, and immediate next step. Do not mention that search returned nothing.`;
  }

  return p;
}

// ═══ GEMINI — 1 ПОВИК ═══
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
      generationConfig: { maxOutputTokens: 1024, temperature: 0.75 }
    })
  }, 25000);

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
  const serperKey = process.env.SERPER_API_KEY;
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

    console.log(`[CHAT] lang:${lang} intent:${intent} text:"${userText.slice(0, 60)}"`);

    // Serper — само ако треба
    let searchResults = undefined;
    if (serperKey && needsSearch(userText)) {
      searchResults = await doSearch(userText, intent, serperKey);
    }

    // Frontend пораки — тековна сесија
    const messages = (body.messages || []).slice(-6).map(m => ({
      role: m.role,
      content: String(m.content || '')
    }));

    const systemPrompt = buildPrompt(lang, today, searchResults);
    const text = await gemini(systemPrompt, messages, apiKey);

    // Quota async — не го блокира одговорот
    if (userId) incQuota(userId).catch(() => {});

    return res.status(200).json({ content: [{ type: 'text', text }], intent });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
