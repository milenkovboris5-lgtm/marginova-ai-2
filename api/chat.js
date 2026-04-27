// ═══════════════════════════════════════════════════════════════════════════
// MARGINOVA v5 — REWRITTEN FILES
// Copy each section to its respective file in api/_lib/
// ═══════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════
// FILE 1: api/_lib/fundingScorer.js
// ════════════════════════════════════════════════════════════
/*
CHANGES vs v4:
- REMOVED: score calculation (we don't rank, donor decides)
- REMOVED: probability estimation
- ADDED: matchSignals[] — informational, tells user WHY it may be relevant
- ADDED: riskFactors[] — what user must verify before applying
- CHANGED: returns up to 6 results (was 6 top-scored)
- CHANGED: sorted by deadline soonest first, not by score
- CHANGED: needsSerper() exported for chat.js to use
- REMOVED: BUDGET_RANGES used for scoring — kept only for risk detection
*/

const { getTable } = require('./utils');

const SECTOR_SQL_KEYWORDS = {
  'Environment / Energy':      ['environment','climate','renewable','biodiversity','ecosystem','conservation','clean energy','pollution','nature','wildlife','forest','sustainability','green agenda','pont','gef','geff','wwf','life programme'],
  'Civil Society':             ['civil society','ngo','nonprofit','advocacy','democracy','community','grassroots','rights','governance'],
  'Agriculture':               ['agriculture','farmer','rural','food','farm','ipard','agri'],
  'Education':                 ['education','school','learning','training','youth','student','scholarship','fellowship','erasmus'],
  'IT / Technology':           ['technology','digital','software','ai','innovation','ict','startup','tech'],
  'Health / Social':           ['health','social','welfare','care','women','gender'],
  'Research / Innovation':     ['research','science','innovation','university','academic','phd'],
  'SME / Business':            ['business','enterprise','sme','company','entrepreneur'],
  'Tourism / Culture':         ['tourism','culture','heritage','creative','art'],
  'Student / Youth':           ['student','scholarship','fellowship','youth','erasmus','fulbright','daad','stipend'],
  'Individual / Entrepreneur': ['individual','entrepreneur','founder','creator','freelance','startup'],
};

const ORG_ELIGIBILITY = {
  'NGO / Association':          ['ngo','nonprofit','association','civil society','foundation'],
  'Startup':                    ['startup','early stage','venture','founder'],
  'Agricultural holding':       ['farmer','agricultural','holding','ipard'],
  'SME':                        ['sme','enterprise','company','business'],
  'Municipality / Public body': ['municipality','local government','public body'],
  'University / Research':      ['university','research','academic','institute'],
  'Individual / Entrepreneur':  ['individual','entrepreneur','founder','self-employed','freelance','creator','person','applicant'],
};

const BUDGET_RANGES = {
  'up to €30k':   [0, 30000],
  '€30k–€150k':   [30000, 150000],
  '€150k–€500k':  [150000, 500000],
  'above €500k':  [500000, Infinity],
};

const SELECT_COLS     = 'id,title,organization_name,opportunity_type,funding_range,award_amount,currency,focus_areas,eligibility,application_deadline,country,description,source_url,status';
const DB_FETCH_LIMIT  = 80;
const MIN_RESULTS     = 3;   // below this → trigger Serper fallback
const RESULTS_TO_SHOW = 6;   // show user this many options

async function searchDB(profile) {
  const today     = new Date().toISOString().split('T')[0];
  const sectorKws = SECTOR_SQL_KEYWORDS[profile.sector] || [];
  const queries   = [];

  // Query 1: sector keywords
  if (sectorKws.length > 0) {
    const [k1, k2, k3, k4] = sectorKws;
    const orParts = [
      `focus_areas.ilike.%${k1}%`,
      k2 ? `focus_areas.ilike.%${k2}%` : null,
      k3 ? `focus_areas.ilike.%${k3}%` : null,
      k4 ? `focus_areas.ilike.%${k4}%` : null,
      `description.ilike.%${k1}%`,
    ].filter(Boolean).join(',');

    queries.push(
      getTable('funding_opportunities')
        .select(SELECT_COLS)
        .eq('status', 'Open')
        .or(orParts)
        .gte('application_deadline', today)
        .order('application_deadline', { ascending: true })
        .limit(DB_FETCH_LIMIT)
    );
  }

  // Query 2: country/region
  const countryKw = profile.country || 'Balkans';
  queries.push(
    getTable('funding_opportunities')
      .select(SELECT_COLS)
      .eq('status', 'Open')
      .or(`country.ilike.%${countryKw}%,country.ilike.%global%,country.ilike.%Western Balkans%,country.ilike.%Europe%`)
      .gte('application_deadline', today)
      .order('application_deadline', { ascending: true })
      .limit(DB_FETCH_LIMIT)
  );

  const results = await Promise.all(queries);

  const seen   = new Set();
  const merged = [];
  for (const { data, error } of results) {
    if (error) console.warn('[DB query error]', error.message);
    for (const row of (data || [])) {
      if (!seen.has(row.id) && (!row.application_deadline || row.application_deadline >= today)) {
        seen.add(row.id);
        merged.push(row);
      }
    }
  }

  if (!merged.length) return [];

  const annotated = merged.map(g => annotate(g, profile, sectorKws));

  // Sort: soonest deadline first, then by matchCount as tiebreaker
  annotated.sort((a, b) => {
    const da = a.application_deadline || '9999-12-31';
    const db = b.application_deadline || '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    return b._matchCount - a._matchCount;
  });

  const final = annotated.slice(0, RESULTS_TO_SHOW);
  console.log('[DB] returned:', final.length, 'opportunities for user to browse');
  return final;
}

function annotate(g, profile, sectorKws) {
  const focus   = (g.focus_areas || '').toLowerCase();
  const desc    = (g.description || '').toLowerCase();
  const elig    = (g.eligibility || '').toLowerCase();
  const country = (g.country     || '').toLowerCase();
  const hay     = `${focus} ${desc}`;

  // --- Match signals (informational) ---
  const matchSignals = [];

  const sectorHits = sectorKws.filter(k => hay.includes(k));
  if (sectorHits.length > 0)
    matchSignals.push(`Sector keywords: ${sectorHits.slice(0, 3).join(', ')}`);

  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (country.includes(pc))
      matchSignals.push(`${profile.country} explicitly listed`);
    else if (/global|europe|western balkans|southeast/.test(country))
      matchSignals.push(`Open regionally (${g.country})`);
  }

  if (profile.orgType) {
    const kws  = ORG_ELIGIBILITY[profile.orgType] || [];
    const hits = kws.filter(k => `${elig} ${desc}`.includes(k));
    if (hits.length > 0) matchSignals.push(`Org type signal: ${hits[0]}`);
  }

  if (profile.budget && g.award_amount != null) {
    const [min, max] = BUDGET_RANGES[profile.budget] || [0, Infinity];
    const amt = Number(g.award_amount);
    if (amt >= min && amt <= max)
      matchSignals.push(`Amount ${amt.toLocaleString()} ${g.currency || 'EUR'} fits your budget range`);
  }

  if (profile.keywords?.length) {
    const kwHits = profile.keywords.filter(k => `${hay} ${elig}`.includes(k));
    if (kwHits.length > 0) matchSignals.push(`Topic overlap: ${kwHits.slice(0, 2).join(', ')}`);
  }

  // --- Risk factors (what to verify) ---
  const riskFactors = [];

  if (profile.orgType && elig.length > 10) {
    const kws  = ORG_ELIGIBILITY[profile.orgType] || [];
    const hits = kws.filter(k => elig.includes(k));
    if (hits.length === 0 && !/all|global|any/.test(elig))
      riskFactors.push(`Verify org type — eligibility: "${elig.slice(0, 80)}..."`);
  }

  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (country.length > 0 && !country.includes(pc) && !/global|europe|western balkans/.test(country))
      riskFactors.push(`Confirm ${profile.country} eligibility — listed: "${g.country}"`);
  }

  if (profile.budget && g.award_amount != null) {
    const [mn, mx] = BUDGET_RANGES[profile.budget] || [0, Infinity];
    const amt      = Number(g.award_amount);
    if (amt < mn * 0.5 || amt > mx * 2)
      riskFactors.push(`Budget gap: you need ${profile.budget}, program offers ${Math.round(amt).toLocaleString()} ${g.currency || 'EUR'}`);
  }

  if (/global|international|worldwide/.test(desc))
    riskFactors.push('Global competition — large applicant pool');
  else if (/western balkans|regional/.test(desc))
    riskFactors.push('Regional competition — moderate applicant pool');

  if (!g.application_deadline)
    riskFactors.push('Deadline not confirmed — check official source');
  else {
    const days = Math.round((new Date(g.application_deadline) - new Date()) / 86400000);
    if (days < 14) riskFactors.push(`Deadline soon — ${days} days remaining`);
  }

  if (g.source === 'serper_extracted')
    riskFactors.push('Web result — verify ALL details on official source');

  if (!riskFactors.length)
    riskFactors.push('Review full eligibility criteria before applying');

  const amt = g.award_amount
    ? `${Number(g.award_amount).toLocaleString()} ${g.currency || 'EUR'}`.trim()
    : (g.funding_range || '—');

  return {
    ...g,
    _matchCount: matchSignals.length,
    matchSignals,
    riskFactors,
    source: g.source || 'db',
    snippet: [
      g.organization_name,
      amt,
      g.eligibility?.slice(0, 80),
      g.application_deadline ? `Deadline: ${g.application_deadline}` : null,
    ].filter(Boolean).join(' | '),
    link: g.source_url || '',
  };
}

function mergeWithWeb(dbResults, webResults) {
  const dbIds  = new Set(dbResults.map(r => r.id));
  const merged = [
    ...dbResults,
    ...webResults.filter(r => !dbIds.has(r.id)),
  ].slice(0, RESULTS_TO_SHOW);
  console.log(`[mergeWithWeb] db:${dbResults.length} web:${webResults.length} final:${merged.length}`);
  return merged;
}

// KEY: Serper triggered ONLY when DB is insufficient
function needsSerper(dbResults) {
  return dbResults.length < MIN_RESULTS;
}

module.exports = { searchDB, mergeWithWeb, needsSerper, RESULTS_TO_SHOW };


// ════════════════════════════════════════════════════════════
// FILE 2: api/_lib/llmRouter.js
// ════════════════════════════════════════════════════════════
/*
CHANGES vs v4:
- REMOVED: calcProbability() — no fake % shown to user
- REMOVED: analyzeRisks() returning hardcoded donor advice
- REMOVED: APPLY / CONDITIONAL / BACKUP labels
- REMOVED: TOP 3 restriction
- CHANGED: synthesize() shows ALL programs (up to 6), user chooses
- CHANGED: Gemini role = formatter/translator only, not decision maker
- CHANGED: extractFromSerper() cleaner, returns riskFactors/matchSignals
*/

const { gemini: _gemini, LANG_NAMES: _LANG_NAMES } = require('./utils');

const NATIVE_NAMES_V2 = {
  mk:'македонски', sr:'српски', hr:'hrvatski', bs:'bosanski',
  sq:'shqip', bg:'български', ro:'română', sl:'slovenščina',
  en:'English', de:'Deutsch', fr:'français', es:'español',
  it:'italiano', pl:'polski', tr:'Türkçe', nl:'Nederlands',
  pt:'português', cs:'čeština', hu:'magyar', el:'ελληνικά',
  ru:'русский', uk:'українська', ar:'العربية', ko:'한국어',
  ja:'日本語', zh:'中文',
};

function _buildMatchText(p, profile) {
  if (p.matchSignals?.length) return '• ' + p.matchSignals.slice(0, 4).join('\n• ');
  const hay  = `${p.focus_areas || ''} ${p.description || ''}`.toLowerCase();
  const ctry = (p.country || '').toLowerCase();
  const parts = [];
  const KWS = {
    'Environment / Energy':  ['environment','climate','renewable','biodiversity','conservation'],
    'Civil Society':         ['civil society','ngo','nonprofit','advocacy'],
    'Agriculture':           ['agriculture','farmer','rural','food','farm'],
    'Education':             ['education','school','learning','scholarship','erasmus'],
    'IT / Technology':       ['technology','digital','software','ai','innovation','startup'],
    'Health / Social':       ['health','social','welfare','care','gender'],
    'Research / Innovation': ['research','science','innovation','university'],
    'SME / Business':        ['business','enterprise','sme','entrepreneur'],
    'Student / Youth':       ['student','scholarship','fellowship','youth'],
    'General':               ['funding','grant','support','program'],
  };
  const matched = (KWS[profile?.sector] || KWS['General']).filter(k => hay.includes(k));
  if (matched.length) parts.push(`Sector topics: ${matched.slice(0, 3).join(', ')}`);
  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (ctry.includes(pc))                       parts.push(`${profile.country} explicitly listed`);
    else if (ctry.includes('western balkans'))    parts.push('Western Balkans eligible');
    else if (/global|europe/.test(ctry))          parts.push('Open internationally');
  }
  return parts.length ? '• ' + parts.join('\n• ') : '• Check eligibility on official source';
}

function _buildRiskText(p, profile) {
  if (p.riskFactors?.length) return '• ' + p.riskFactors.slice(0, 4).join('\n• ');
  const risks = [];
  const ctry  = (p.country || '').toLowerCase();
  const desc  = ((p.description || '') + ' ' + (p.focus_areas || '')).toLowerCase();
  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (ctry.length > 0 && !ctry.includes(pc) && !/global|europe|western balkans/.test(ctry))
      risks.push(`Confirm ${profile.country} is eligible — listed: "${p.country}"`);
  }
  if (!p.application_deadline)          risks.push('Deadline not confirmed — check official source');
  if (/global|international/.test(desc)) risks.push('Global competition expected');
  if (p.source === 'serper_extracted')  risks.push('Web result — verify on official source');
  if (!risks.length)                    risks.push('Review full eligibility before applying');
  return '• ' + risks.join('\n• ');
}

async function synthesize(lang, today, profile, programs, sources) {
  const nativeName = NATIVE_NAMES_V2[lang] || 'English';
  const langName   = _LANG_NAMES[lang]     || 'English';

  if (!programs?.length) {
    return lang === 'mk'
      ? 'Нема пронајдени програми. Додадете повеќе детали — сектор, земја, тип на организација.'
      : 'No programs found. Please add more details — sector, country, organization type.';
  }

  const dataRows = programs.map((p, i) => {
    const amt = p.award_amount
      ? `${Number(p.award_amount).toLocaleString()} ${p.currency || 'EUR'}`
      : (p.funding_range || '—');
    return `---
[${i + 1}] ${p.source === 'serper_extracted' ? '[WEB]' : '[DB]'}
NAME: ${p.title}
ORG: ${p.organization_name || '—'}
AMOUNT: ${amt}
DEADLINE: ${p.application_deadline || 'verify on source'}
COUNTRY: ${p.country || '—'}
ELIGIBILITY: ${(p.eligibility || '—').slice(0, 150)}
URL: ${p.link || p.source_url || '—'}
MATCH SIGNALS:
${_buildMatchText(p, profile)}
RISK FACTORS:
${_buildRiskText(p, profile)}`;
  }).join('\n\n');

  const profileLine = [profile.sector, profile.orgType, profile.country, profile.budget]
    .filter(Boolean).join(' | ') || 'not specified';

  const langInstruction = lang === 'mk'
    ? 'Задолжително одговори САМО на македонски јазик.'
    : `You MUST respond entirely in ${nativeName} (${langName}).`;

  const system = `You are MARGINOVA, a funding opportunities assistant. ${langInstruction}
Today: ${today}. User profile: ${profileLine}.
DB results: ${sources?.db || 0}. Web results: ${sources?.serper || 0}.

STRICT RULES:
1. You are NOT a decision-maker. The donor/funder decides eligibility — never you.
2. Do NOT assign probability %, scores, or rankings.
3. Do NOT label programs YES / NO / APPLY / BACKUP / CONDITIONAL or similar.
4. Show ALL programs. Let the user choose what suits them.
5. Translate match signals and risk factors into the user's language.
6. Keep amounts, dates, URLs character-for-character as given.
7. [WEB] tagged results: add note to verify on official source.

Format EACH program exactly:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[N]. [PROGRAM NAME]
🏛 [ORGANIZATION]
💰 [AMOUNT]
📅 Deadline: [DEADLINE]
🌍 [COUNTRY / REGION]

✅ Why this may be relevant:
[MATCH SIGNALS — translated, bullet list]

⚠️ What to verify before applying:
[RISK FACTORS — translated, bullet list]

🔗 [URL]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After all programs:
▶ NEXT STEP: [one concrete action today — e.g. "Open link 1 and check if your organization type is listed in the eligibility section"]`;

  const contents = [{ role: 'user', parts: [{ text: `Present these ${programs.length} opportunities:\n\n${dataRows}` }] }];

  try {
    return await _gemini(system, contents, { maxTokens: 3500, temperature: 0.1 });
  } catch (err) {
    console.error('[SYNTHESIZE] Gemini error:', err.message);
    const fallback = programs.map((p, i) =>
      `${i + 1}. ${p.title} | ${p.organization_name || ''} | ${p.application_deadline || 'TBD'} | ${p.link || ''}`
    ).join('\n');
    return lang === 'mk' ? `Грешка: ${err.message}\n\n${fallback}` : `Error: ${err.message}\n\n${fallback}`;
  }
}

async function extractFromSerper(serperResults, profile) {
  if (!serperResults?.length) return [];

  const snippets = serperResults
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet || ''}\n${r.link}`)
    .join('\n\n');

  const prompt = `Extract funding program data. Return JSON array only — no markdown, no preamble.
Only extract explicitly stated fields. Use null if not mentioned.
Profile: sector=${profile.sector}, country=${profile.country}

Return: [{"index":N,"title":"...","organization":"...or null","amount":"...or null","deadline":"YYYY-MM-DD or null","eligibility":"...or null","focus":"...","url":"...","relevance_notes":"brief or null"}]

Results:\n${snippets}`;

  try {
    const raw    = await _gemini(prompt, [{ role: 'user', parts: [{ text: 'Extract.' }] }], { maxTokens: 1400, temperature: 0.05 });
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(r => r.title && r.url).map(r => ({
      title:                r.title,
      organization_name:    r.organization || '',
      award_amount:         r.amount ? parseFloat(r.amount.replace(/[^0-9.]/g, '')) || null : null,
      currency:             r.amount?.includes('$') ? 'USD' : 'EUR',
      funding_range:        r.amount || null,
      application_deadline: r.deadline || null,
      eligibility:          r.eligibility || null,
      description:          r.focus || '',
      source_url:           r.url || '',
      country:              profile.country || '',
      focus_areas:          profile.sector  || '',
      matchSignals:         r.relevance_notes ? [`Web relevance: ${r.relevance_notes}`] : [],
      riskFactors:          ['Web result — verify ALL details on official source before applying'],
      _matchCount:          0,
      source:               'serper_extracted',
      link:                 r.url || '',
    }));
  } catch (e) {
    console.log('[EXTRACT] parse error:', e.message);
    return [];
  }
}

module.exports = { extractFromSerper, synthesize };


// ════════════════════════════════════════════════════════════
// FILE 3: api/chat.js
// ════════════════════════════════════════════════════════════
/*
CHANGES vs v23:
- REMOVED: message plan limits (200/500/2000) — test mode, no limits
- REMOVED: DB_MIN_SCORE threshold logic
- CHANGED: uses needsSerper() from fundingScorer instead of hardcoded threshold
- CHANGED: top_matches returns matchSignals + riskFactors (not score)
- CHANGED: RESULTS_TO_SHOW imported from fundingScorer
- FIXED: hybridSearch now correctly gates Serper on needsSerper(dbResults)
*/

const { ft, detectLang, sanitizeField, checkIP, gemini: __gemini, setCors, supabase, getTable } = require('./_lib/utils');
const { detectProfile, needsSearch }    = require('./_lib/profileDetector');
const { searchDB, mergeWithWeb, needsSerper, RESULTS_TO_SHOW } = require('./_lib/fundingScorer');
const { extractFromSerper, synthesize } = require('./_lib/llmRouter');

const SERPER_KEY      = process.env.SERPER_API_KEY;
const CACHE_TTL_HOURS = 24;

console.log('[chat.js v5] SUPABASE:', supabase ? 'OK' : 'MISSING');
console.log('[chat.js v5] SERPER:',   SERPER_KEY ? 'OK' : 'MISSING (fallback disabled)');

function hashQuery(str) {
  const n = str.toLowerCase().trim().replace(/\s+/g, ' ');
  let h = 0;
  for (let i = 0; i < n.length; i++) { h = ((h << 5) - h) + n.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}

function buildCacheKey(userText, profile) {
  return hashQuery(JSON.stringify({
    q:       userText.toLowerCase().trim().slice(0, 200),
    sector:  profile.sector  || '',
    country: profile.country || '',
    orgType: profile.orgType || '',
    budget:  profile.budget  || '',
  }));
}

async function getCached(key) {
  if (!supabase) return null;
  try {
    const { data } = await getTable('search_cache')
      .select('results,created_at')
      .eq('query_hash', key)
      .gt('expires_at', new Date().toISOString())
      .limit(1);
    if (data?.length) { console.log('[CACHE] hit:', key); return data[0]; }
    return null;
  } catch { return null; }
}

async function saveCache(key, queryText, results) {
  if (!supabase) return;
  try {
    const now     = new Date();
    const expires = new Date(now.getTime() + CACHE_TTL_HOURS * 3600000);
    await getTable('search_cache').delete().eq('query_hash', key);
    await getTable('search_cache').insert({
      query_hash: key, query_text: queryText, results,
      created_at: now.toISOString(), expires_at: expires.toISOString(),
    });
  } catch (e) { console.log('[CACHE SAVE]', e.message); }
}

async function cleanCache() {
  if (!supabase) return;
  try { await getTable('search_cache').delete().lt('expires_at', new Date().toISOString()); }
  catch (e) { console.log('[CACHE CLEAN]', e.message); }
}

async function searchSerper(query) {
  if (!SERPER_KEY) { console.log('[SERPER] No API key — skipping web fallback'); return []; }
  try {
    const r = await ft('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 8, gl: 'us', hl: 'en' }),
    }, 8000);
    if (!r.ok) { console.log('[SERPER] error:', r.status); return []; }
    const data = await r.json();
    return (data.organic || [])
      .filter(item => item.title && item.link)
      .map(item => ({
        title: item.title, snippet: item.snippet || '',
        link: item.link, source: 'serper',
      }))
      .slice(0, 6);
  } catch (e) { console.log('[SERPER]', e.message); return []; }
}

function buildSerperQuery(userText, profile) {
  const parts = ['grant funding open call'];
  if (profile.sector)  parts.push(profile.sector.split('/')[0].trim());
  if (profile.country) parts.push(profile.country);
  if (profile.orgType) parts.push(profile.orgType.split('/')[0].trim());
  const kws = userText.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 4 && !['about','where','which','would','could'].includes(w))
    .slice(0, 3);
  return [...parts, ...kws].join(' ');
}

async function hybridSearch(userText, profile) {
  // Step 1: DB query always runs first
  const dbResults = await searchDB(profile);

  // Step 2: Serper ONLY if DB is insufficient
  if (!needsSerper(dbResults)) {
    console.log(`[HYBRID] DB sufficient (${dbResults.length} results) — skipping Serper`);
    return { results: dbResults, sources: { db: dbResults.length, serper: 0 } };
  }

  console.log(`[HYBRID] DB insufficient (${dbResults.length}) — triggering Serper fallback`);
  const rawWeb = await searchSerper(buildSerperQuery(userText, profile));

  let extractedWeb = [];
  if (rawWeb.length > 0) {
    extractedWeb = await extractFromSerper(rawWeb, profile);
    console.log('[HYBRID] Serper extracted:', extractedWeb.length, 'programs');
  }

  return {
    results: mergeWithWeb(dbResults, extractedWeb),
    sources: { db: dbResults.length, serper: extractedWeb.length },
  };
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY.' } });

  if (!(await checkIP(req))) {
    return res.status(429).json({ error: { message: 'Daily IP limit reached. Try again tomorrow.' } });
  }

  try {
    const body      = req.body || {};
    const imageData = body.image     || null;
    const imageType = body.imageType || null;

    const userText = sanitizeField(
      body.messages?.[body.messages.length - 1]?.content || body.message || '',
      2000
    );

    if (!userText && !imageData) {
      return res.status(400).json({ error: { message: 'No message provided.' } });
    }

    const langText = (body.messages || []).slice(-3).map(m => m.content || '').join(' ') + ' ' + userText;
    const lang     = body.lang || detectLang(langText);
    const today    = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const conversationText = (body.messages || [])
      .slice(-4).map(m => m.content || '').join(' ') + ' ' + userText;

    const profile = detectProfile(conversationText);

    // Periodic cache cleanup (5% of requests)
    if (Math.random() < 0.05) cleanCache().catch(() => {});

    const shouldSearch = needsSearch(conversationText) || !!imageData || !!(profile.sector && profile.country);
    let results   = [];
    let sources   = { db: 0, serper: 0 };
    let fromCache = false;
    let cachedAt  = null;

    if (shouldSearch && !imageData) {
      const cacheKey = buildCacheKey(userText, profile) + '_' + lang;
      const cached   = await getCached(cacheKey);

      if (cached?.results?.length) {
        results   = cached.results;
        cachedAt  = cached.created_at;
        fromCache = true;
        console.log('[chat.js] Cache hit —', results.length, 'results');
      } else {
        const hybrid = await hybridSearch(userText, profile);
        results  = hybrid.results;
        sources  = hybrid.sources;
        if (results.length) await saveCache(cacheKey, userText, results).catch(() => {});
        console.log(`[chat.js v5] db:${sources.db} serper:${sources.serper} total:${results.length}`);
      }
    }

    // Gemini synthesizes the final response
    const text = await synthesize(lang, today, profile, results, sources);

    return res.status(200).json({
      content:     [{ type: 'text', text }],
      intent:      shouldSearch ? 'funding' : 'general',
      cached:      fromCache,
      cached_at:   cachedAt,
      db_results:  sources.db,
      web_results: sources.serper,
      // Return all results for frontend display (no score, has matchSignals + riskFactors)
      top_matches: results.slice(0, RESULTS_TO_SHOW).map(r => ({
        title:        r.title        || '',
        organization: r.organization_name || '',
        deadline:     r.application_deadline || '',
        amount:       r.award_amount ? `${Number(r.award_amount).toLocaleString()} ${r.currency || 'EUR'}` : (r.funding_range || ''),
        country:      r.country      || '',
        matchSignals: r.matchSignals || [],
        riskFactors:  r.riskFactors  || [],
        source:       r.source       || 'db',
        link:         r.link         || '',
        snippet:      r.snippet      || '',
      })),
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
