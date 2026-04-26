// ═════════════════════════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// v22 — Cleaned: gemini/quota from utils, cache key fixed,
//        profile patch only on change, sanitizeField on input
// ═════════════════════════════════════════════════════════════

const {
  supabase, getTable, ft, detectLang, LANG_NAMES,
  sanitizeField, checkIP, checkAndDeductQuota, gemini, setCors
} = require('./_lib/utils');

const SERPER_KEY = process.env.SERPER_API_KEY;

console.log('[chat.js v22] SUPABASE:', supabase ? 'OK' : 'MISSING');
console.log('[chat.js v22] SERPER:', SERPER_KEY ? 'OK' : 'MISSING');

const CACHE_TTL_HOURS = 24;
const DB_MIN_RESULTS  = 3;
const DB_MIN_SCORE    = 55;

// ═══ HASH ═══

function hashQuery(str) {
  const n = str.toLowerCase().trim().replace(/\s+/g, ' ');
  let h = 0;
  for (let i = 0; i < n.length; i++) {
    h = ((h << 5) - h) + n.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

// ═══ DB SEARCH ═══

async function searchFundingDB(profile) {
  if (!supabase) return [];

  try {
    const today = new Date().toISOString().split('T')[0];

    // SQL-first approach: separate sector query + general query
    // Sector query: strict ilike filter on focus_areas — only relevant records
    // General query: fills remaining slots for country/budget matching

    const sectorKeywords = {
      'Environment / Energy':   ['environment','climate','renewable','green energy','biodiversity','ecosystem','conservation','clean energy','pollution','nature','wildlife','forest','water','sustainability','pont','gef','geff','wwf','envsec','life programme'],
      'Civil Society':          ['civil society','ngo','nonprofit','advocacy','democracy','community','grassroots','rights','governance'],
      'Agriculture':            ['agriculture','farmer','rural','food','farm','ipard','agri'],
      'Education':              ['education','school','learning','training','youth','student','scholarship','fellowship','erasmus'],
      'IT / Technology':        ['technology','digital','software','ai','innovation','ict','startup','tech'],
      'Health / Social':        ['health','social','welfare','care','women','gender'],
      'Research / Innovation':  ['research','science','innovation','university','academic','phd'],
      'SME / Business':         ['business','enterprise','sme','company','entrepreneur'],
      'Tourism / Culture':      ['tourism','culture','heritage','creative','art'],
      'Student / Youth':        ['student','scholarship','fellowship','youth','erasmus','fulbright','daad','stipend'],
      'Individual / Entrepreneur': ['individual','entrepreneur','founder','creator','freelance','startup']
    };

    const kwList = profile.sector ? (sectorKeywords[profile.sector] || []) : [];

    let sectorData = [];
    let generalData = [];

    if (kwList.length > 0) {
      // Try first 3 keywords with OR filter
      const kw1 = kwList[0];
      const kw2 = kwList[1] || kwList[0];
      const kw3 = kwList[2] || kwList[0];

      const { data: sr } = await getTable('funding_opportunities')
        .select('id,title,organization_name,opportunity_type,funding_range,award_amount,currency,focus_areas,eligibility,application_deadline,country,description,source_url,status')
        .in('status', ['Open'])
        .or(`focus_areas.ilike.%${kw1}%,focus_areas.ilike.%${kw2}%,focus_areas.ilike.%${kw3}%,description.ilike.%${kw1}%`)
        .gte('application_deadline', today)
        .limit(60);

      sectorData = sr || [];
      console.log(`[DB] sector query (${profile.sector}): ${sectorData.length} records`);
    }

    // General query: country + all open (for budget/country matching)
    const countryKw = profile.country || '';
    const { data: gr } = await getTable('funding_opportunities')
      .select('id,title,organization_name,opportunity_type,funding_range,award_amount,currency,focus_areas,eligibility,application_deadline,country,description,source_url,status')
      .in('status', ['Open'])
      .or(`country.ilike.%${countryKw || 'Balkans'}%,country.ilike.%global%,country.ilike.%Western Balkans%`)
      .limit(60);

    generalData = gr || [];

    // Merge: sector records first (they are pre-filtered as relevant)
    const sectorIds = new Set(sectorData.map(r => r.id));
    const merged = [
      ...sectorData,
      ...(generalData).filter(r => !sectorIds.has(r.id))
    ].filter(g => !g.application_deadline || g.application_deadline >= today);

    if (!merged.length) return [];

    // Scoring
    const kwsForScore = kwList;

    const scored = merged.map(g => {
      let score = 0;
      const focus   = String(g.focus_areas   || '').toLowerCase();
      const desc    = String(g.description   || '').toLowerCase();
      const elig    = String(g.eligibility   || '').toLowerCase();
      const country = String(g.country       || '').toLowerCase();

      // Sector score — primary driver
      if (kwsForScore.length > 0) {
        const hay  = `${focus} ${desc}`;
        const hits = kwsForScore.filter(k => hay.includes(k)).length;
        if (hits > 0) score += Math.min(50, hits * 15); // boosted weight
      }

      // Keywords from conversation
      if (profile.keywords?.length) {
        const hay  = `${focus} ${desc} ${elig}`;
        const hits = profile.keywords.filter(k => hay.includes(k)).length;
        if (hits > 0) score += Math.min(15, hits * 5);
      }

      // Country score
      if (profile.country) {
        const pc = profile.country.toLowerCase();
        if (country.includes(pc)) score += 20;
        else if (country.includes('global') || country.includes('europe') || country.includes('western balkans')) score += 12;
        else score -= 5;
      }

      // Budget match
      if (profile.budget && g.award_amount != null) {
        const amt = Number(g.award_amount);
        const budgetRanges = {
          'up to €30k':   [0, 30000],
          '€30k–€150k':   [30000, 150000],
          '€150k–€500k':  [150000, 500000],
          'above €500k':  [500000, Infinity]
        };
        const [minB, maxB] = budgetRanges[profile.budget] || [0, Infinity];
        if (amt >= minB && amt <= maxB) score += 15;
      }

      // Org type match
      if (profile.orgType) {
        const orgMap = {
          'NGO / Association':         ['ngo','nonprofit','association','civil society','foundation'],
          'Startup':                   ['startup','early stage','venture','founder'],
          'Agricultural holding':      ['farmer','agricultural','holding','ipard'],
          'SME':                       ['sme','enterprise','company','business'],
          'Municipality / Public body':['municipality','local government','public body'],
          'University / Research':     ['university','research','academic','institute'],
          'Individual / Entrepreneur': ['individual','entrepreneur','founder','self-employed','freelance','creator','person','applicant']
        };
        const kws  = orgMap[profile.orgType] || [];
        const hay  = `${elig} ${desc}`;
        const hits = kws.filter(k => hay.includes(k)).length;
        if (hits > 0) score += Math.min(15, hits * 8);
        else score -= 5;
      }

      // Deadline bonus
      if (g.application_deadline) score += 5;

      return {
        ...g,
        score: Math.max(0, Math.min(100, score)),
        score_type: 'match',
        source: 'db',
        snippet: [
          g.organization_name,
          g.award_amount ? `${g.award_amount} ${g.currency || ''}`.trim() : g.funding_range,
          g.eligibility,
          g.application_deadline ? `Deadline: ${g.application_deadline}` : null
        ].filter(Boolean).join(' | '),
        link: g.source_url || ''
      };
    });

    const ranked = scored
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    console.log('[DB] matched:', ranked.length, 'top score:', ranked[0]?.score ?? 0);
    if (ranked.length > 0) {
      console.log('[DB] top 3:', ranked.slice(0,3).map(r => `${r.title?.slice(0,30)} (${r.score})`).join(' | '));
    }
    return ranked;
  } catch (e) {
    console.log('[DB SEARCH] error:', e.message);
    return [];
  }
}

// ═══ SERPER LIVE SEARCH ═══

async function searchSerper(query) {
  if (!SERPER_KEY) { console.log('[SERPER] No API key'); return []; }

  try {
    const r = await ft('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 8, gl: 'us', hl: 'en' })
    }, 8000);

    if (!r.ok) { console.log('[SERPER] error:', r.status); return []; }

    const data = await r.json();
    const results = (data.organic || [])
      .filter(item => item.title && item.link)
      .map(item => ({
        title: item.title, snippet: item.snippet || '',
        link: item.link, score: 40, score_type: 'web', source: 'serper'
      }))
      .slice(0, 5);

    console.log('[SERPER] results:', results.length);
    return results;
  } catch (e) {
    console.log('[SERPER] error:', e.message);
    return [];
  }
}

// ═══ HYBRID SEARCH ═══

function buildSerperQuery(userText, profile) {
  const parts = ['grant funding'];
  if (profile.sector)  parts.push(profile.sector.split('/')[0].trim());
  if (profile.country) parts.push(profile.country);
  if (profile.orgType) parts.push(profile.orgType.split('/')[0].trim());

  const keywords = userText.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !['about','where','which','would','could','their','there','what'].includes(w))
    .slice(0, 3);

  parts.push(...keywords);
  return parts.join(' ');
}

async function hybridSearch(userText, profile) {
  const dbResults = await searchFundingDB(profile);
  const topScore  = dbResults[0]?.score ?? 0;
  const needsSerper = dbResults.length < DB_MIN_RESULTS || topScore < DB_MIN_SCORE;

  console.log(`[HYBRID] db:${dbResults.length} topScore:${topScore} needsSerper:${needsSerper}`);

  if (!needsSerper) {
    return { results: dbResults, sources: { db: dbResults.length, serper: 0 } };
  }

  const query      = buildSerperQuery(userText, profile);
  const webResults = await searchSerper(query);
  const merged     = [...dbResults, ...webResults].slice(0, 8);

  return { results: merged, sources: { db: dbResults.length, serper: webResults.length } };
}

// ═══ CACHE ═══
// FIX: cache key excludes volatile keywords[] — uses only stable profile fields

function buildCacheKey(userText, profile) {
  return hashQuery(JSON.stringify({
    q:       userText.toLowerCase().trim(),
    sector:  profile.sector  || '',
    country: profile.country || '',
    orgType: profile.orgType || '',
    budget:  profile.budget  || ''
  }));
}

async function getCached(cacheKey) {
  if (!supabase) return null;
  try {
    const { data, error } = await getTable('search_cache')
      .select('results,created_at,expires_at')
      .eq('query_hash', cacheKey)
      .gt('expires_at', new Date().toISOString())
      .limit(1);

    if (error) { console.log('[CACHE] get error:', error.message); return null; }
    if (data?.length > 0) { console.log('[CACHE] hit:', cacheKey); return { results: data[0].results, created_at: data[0].created_at }; }
    return null;
  } catch (e) { console.log('[CACHE] get error:', e.message); return null; }
}

async function saveCache(cacheKey, queryText, results) {
  if (!supabase) return;
  try {
    const now     = new Date();
    const expires = new Date(now.getTime() + CACHE_TTL_HOURS * 3600000);
    await getTable('search_cache').delete().eq('query_hash', cacheKey);
    const { error } = await getTable('search_cache').insert({
      query_hash: cacheKey, query_text: queryText, results,
      created_at: now.toISOString(), expires_at: expires.toISOString()
    });
    if (error) console.log('[CACHE] save error:', error.message);
    else console.log('[CACHE] saved:', cacheKey);
  } catch (e) { console.log('[CACHE] save error:', e.message); }
}

async function cleanExpiredCache() {
  if (!supabase) return;
  try {
    await getTable('search_cache').delete().lt('expires_at', new Date().toISOString());
  } catch (e) { console.log('[CACHE CLEAN]', e.message); }
}

// ═══ PROFILE LOADER ═══

async function loadProfile(userId) {
  if (!userId || !supabase) return null;
  try {
    const { data: p, error } = await getTable('profiles')
      .select('sector,country,organization_type,goals,plan,detected_sector,detected_org_type,detected_country')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) { console.log('[PROFILE] error:', error.message); return null; }
    if (!p) return null;

    return {
      ...p,
      sector:            p.sector            || p.detected_sector   || null,
      organization_type: p.organization_type || p.detected_org_type || null,
      country:           p.country           || p.detected_country  || null,
    };
  } catch { return null; }
}

// ═══ INTENT DETECTION ═══

function needsSearch(messages) {
  // Look at last 4 user messages (not just 2) to catch multi-turn profile setup
  const recentUserMessages = messages
    .filter(m => m.role === 'user')
    .slice(-4)
    .map(m => m.content || '')
    .join(' ')
    .toLowerCase();

  // FIX: Trigger search when:
  // 1. Explicit grant/fund keywords (original)
  // 2. User describes org type + sector + budget (profile-style query = they want matches)
  // 3. User asks "which", "what", "find", "show" without explicit grant word
  // 4. Macedonian/Serbian profile keywords

  const hasGrantKeyword = /grant|fund|financ|subsid|fellowship|scholarship|award|donor|ngo|program|open call|call for proposal|support money|invest|subvenc|finansi|podrsk|stipend|student|youth|erasmus|fulbright|daad|chevening|stud|mlad|grant|fond|subvencij|stipendij/.test(recentUserMessages);

  const hasProfileKeyword = /nvo|ngo|zdruzen|asocijacij|organizacij|sektor|budzet|budget|okolina|ekolog|environment|civil|nevladin|opstina|firma|startup|pretprijatie|makedonija|srbija|kosovo|bosna|hrvatska|albanija/.test(recentUserMessages);

  const hasSearchIntent = /koja|koi|najdi|pokazi|ima li|postoi|which|what|find|show|give|look|search|дали|кои|која|најди|покажи|има/.test(recentUserMessages);

  const hasBudget = /€|\$|eur|usd|mkd|000|budzet|budget|iznos|amount/.test(recentUserMessages);

  // Profile query: has org/sector info + budget = user wants funding matches
  const isProfileQuery = hasProfileKeyword && hasBudget;

  // Multi-turn: last AI message asked a clarifying question (kraj/country/sector)
  const lastAiMsg = (messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '').toLowerCase();
  const aiAskedClarification = /земја|country|сектор|sector|организација|organization|буџет|budget|тип/.test(lastAiMsg);

  return hasGrantKeyword || isProfileQuery || (hasSearchIntent && hasProfileKeyword) || (aiAskedClarification && recentUserMessages.length > 5);
}

function detectProfile(text, supaProfile) {
  const t = text.toLowerCase();

  const sector =
    /\bit\b|tech|software|digital|technology|ai|veshtacka/.test(t)    ? 'IT / Technology' :
    /agri|farm|rural|crop|livestock|hektar|ipard|zemjo/.test(t)        ? 'Agriculture' :
    /student|stipend|scholarship|fellowship|erasmus|fulbright|daad|chevening|mlad|youth|exchange|study abroad/.test(t) ? 'Student / Youth' :
    /educat|school|youth|training|learning|obrazov/.test(t)            ? 'Education' :
    /environment|climate|green|energy|renewable|solar|biodiversity|ecosystem|conservation|pollution|nature|wildlife|forest|water|sustainability|животна средина|klimatski|obnovlivi|зелена/.test(t) ? 'Environment / Energy' :
    /civil|ngo|nonprofit|association|society|zdruzen/.test(t)          ? 'Civil Society' :
    /tourism|culture|heritage|creative|art/.test(t)                    ? 'Tourism / Culture' :
    /health|medical|social|welfare|majki|semejst|gender|women/.test(t) ? 'Health / Social' :
    /research|science|innovation|university|academic|phd/.test(t)      ? 'Research / Innovation' :
    /sme|small business|company|enterprise|startup/.test(t)            ? 'SME / Business' :
    supaProfile?.sector || null;

  const orgType =
    /startup/.test(t)                                                          ? 'Startup' :
    /\bngo\b|nonprofit|association|foundation|civil society|zdruzen/.test(t)  ? 'NGO / Association' :
    /farmer|farm|agricultural|holding|ipard/.test(t)                          ? 'Agricultural holding' :
    /individual|freelance|self.employed|poedinec|creator|samostoen|poedinecen|физичко|fizicko/.test(t)   ? 'Individual / Entrepreneur' :
    /\bsme\b|\bltd\b|\bdoo\b|small business/.test(t)                          ? 'SME' :
    /municipality|local government|public body/.test(t)                       ? 'Municipality / Public body' :
    /university|research institute|academic/.test(t)                          ? 'University / Research' :
    supaProfile?.organization_type || null;

  const country =
    /macedon|makedon|north macedon|mkd|севerna|македон/.test(t) ? 'North Macedonia' :
    /\bserbia\b|srbija/.test(t)                                  ? 'Serbia' :
    /croatia|hrvatska/.test(t)                                   ? 'Croatia' :
    /\bbosnia\b/.test(t)                                         ? 'Bosnia' :
    /bulgaria|bulgar/.test(t)                                    ? 'Bulgaria' :
    /\balkania\b/.test(t)                                        ? 'Albania' :
    /\bkosovo\b/.test(t)                                         ? 'Kosovo' :
    supaProfile?.country || null;

  const budget =
    /1[\s,.]?000[\s,.]?000|1\s*million/.test(t) ? 'above €500k'  :
    /500[\s,.]?000|500k/.test(t)                 ? '€150k–€500k'  :
    /100[\s,.]?000|100k/.test(t)                 ? '€30k–€150k'   :
    /[5-9]\d[\s,.]?000/.test(t)                  ? '€30k–€150k'   :
    /[1-4]\d[\s,.]?000/.test(t)                  ? 'up to €30k'   :
    supaProfile?.goals || null;

  const keywords = t
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !['about','where','which','would','could','their','there','what'].includes(w))
    .slice(0, 10);

  return { sector, orgType, country, budget, keywords };
}

// ═══ PROBABILITY + DECISION ENGINE ═══

function calcProbability(score, result, profile) {
  let prob = Math.round(score * 0.55);
  const elig    = String(result.eligibility  || '').toLowerCase();
  const country = String(result.country      || '').toLowerCase();
  const desc    = String(result.description  || '').toLowerCase();

  if (profile.orgType) {
    const orgLower = profile.orgType.toLowerCase().split('/')[0].trim();
    if (elig.includes(orgLower))                                              prob += 8;
    else if (elig.includes('ngo') && profile.orgType.toLowerCase().includes('ngo')) prob += 8;
    else if (elig.includes('sme') && profile.orgType.toLowerCase().includes('sme')) prob += 8;
    else                                                                      prob -= 10;
  }

  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (country.includes(pc))                                            prob += 8;
    else if (country.includes('global') || country.includes('europe'))  prob += 4;
    else                                                                 prob -= 8;
  }

  if (desc.includes('horizon') || desc.includes('eic') || desc.includes('google')) prob -= 12;
  else if (desc.includes('open') || desc.includes('all'))                           prob -= 4;

  if (result.application_deadline) {
    const daysLeft = Math.round((new Date(result.application_deadline) - new Date()) / 86400000);
    if (daysLeft > 0 && daysLeft < 45) prob += 4;
  }

  return Math.max(10, Math.min(76, prob));
}

function getRisks(result, profile) {
  const risks   = [];
  const elig    = String(result.eligibility  || '').toLowerCase();
  const country = String(result.country      || '').toLowerCase();
  const desc    = String(result.description  || '').toLowerCase();
  const orgLower = (profile.orgType || '').toLowerCase();

  if (elig.length > 0 && !elig.includes(orgLower.split('/')[0].trim()))
    risks.push('eligibility mismatch — verify org type requirement');

  if (profile.country && !country.includes('global') && !country.includes(profile.country.toLowerCase()))
    risks.push('region limitation — check country eligibility');

  if (desc.includes('horizon') || desc.includes('eic') || desc.includes('google'))
    risks.push('competition level: high — strong global applicants');
  else if (desc.includes('open') || desc.includes('all'))
    risks.push('competition level: medium');

  if (!result.application_deadline)
    risks.push('deadline not confirmed — verify on source');

  if (risks.length === 0) risks.push('no major risks identified — strong match');
  return risks;
}

// ═══ SYSTEM PROMPT ═══

function buildSystemPrompt(lang, today, profile, results, sources) {
  const L = LANG_NAMES[lang] || 'English';

  const profileText = profile.sector || profile.orgType || profile.country
    ? `\nOrganization type: ${profile.orgType || 'not specified'}
Sector: ${profile.sector || 'not specified'}
Country: ${profile.country || 'not specified'}
Budget range: ${profile.budget || 'not specified'}`
    : '\nProfile not yet collected — ask one targeted question.';

  let decisionsText = '';
  if (results.length > 0) {
    const top3 = results.slice(0, 3);
    const roles = ['APPLY', 'CONDITIONAL', 'BACKUP'];

    decisionsText = '\n\nDECISION RESULTS (TOP 3 ONLY):\n';
    top3.forEach((r, i) => {
      const prob     = calcProbability(r.score ?? 0, r, profile);
      const decision = roles[i];
      const risks    = getRisks(r, profile);
      const src      = r.source === 'serper' ? '[WEB — verify directly]' : '[VERIFIED]';

      decisionsText += `
[${i + 1}] ${decision} ${src}
Program: ${r.title}
Decision: ${decision === 'APPLY' ? 'YES' : decision === 'CONDITIONAL' ? 'CONDITIONAL' : 'BACKUP'}
Probability of success: ${prob}%
Amount: ${r.award_amount ? `${r.award_amount} ${r.currency || ''}`.trim() : (r.funding_range || 'varies')}
Deadline: ${r.application_deadline || 'verify on source'}
Risks:
${risks.map(risk => `  - ${risk}`).join('\n')}
URL: ${r.link}
`;
    });
  }

  const dbCount     = sources?.db     ?? 0;
  const serperCount = sources?.serper ?? 0;
  let sourceNote = '';
  if (serperCount > 0 && dbCount === 0) {
    sourceNote = '\n\nNOTE: Results are from live web search — verify all details directly on source URLs.';
  } else if (serperCount > 0) {
    sourceNote = `\n\nNOTE: ${dbCount} verified + ${serperCount} web results included.`;
  }

  return `LANGUAGE: Always respond in ${L}. Match the user's language exactly.

You are MARGINOVA — a funding decision and application system.
You turn funding discovery into executable decisions.
NEVER reveal technical details. NEVER invent programs, URLs, amounts or deadlines.
NEVER mention other tools or platforms by name.

Today: ${today}
USER PROFILE:${profileText}

FORMAT — use exactly this structure for each of the 3 results:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[ROLE: APPLY / CONDITIONAL / BACKUP]
📋 [Program name]
📊 Decision: YES / CONDITIONAL / BACKUP
🎯 Probability of success: X%
💰 [Amount]
📅 Deadline: [date or "verify on source"]
✅ Why you qualify: [1-2 specific reasons based only on profile data]
⚠️ Risks:
  • [risk 1]
  • [risk 2]
🔗 [URL]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After the 3 results:
▶ NEXT STEP: One concrete action the user can take TODAY.

RULES:
- Present exactly 3 results — no more, no less
- First = highest probability = APPLY
- Second = medium = CONDITIONAL
- Third = lowest = BACKUP
- If profile incomplete — ask exactly ONE question before results
- If ZERO results — say clearly, do not invent${sourceNote}${decisionsText}`;
}

// ═══ MAIN HANDLER ═══

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: { message: 'Method Not Allowed' } });

  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY.' } });

  if (!(await checkIP(req))) {
    return res.status(429).json({ error: { message: 'Daily limit reached. Try again tomorrow.' } });
  }

  try {
    const body     = req.body || {};
    const userId   = body.userId || null;
    // Sanitize user message before processing
    const userText = sanitizeField(body.messages?.[body.messages.length - 1]?.content || '', 2000);

    if (userText.length > 2000) {
      return res.status(400).json({ error: { message: 'Message too long. Max 2000 characters.' } });
    }

    const imageData = body.image     || null;
    const imageType = body.imageType || null;

    const quotaResult = await checkAndDeductQuota(userId);
    if (!quotaResult.allowed) {
      return res.status(429).json({
        error: { message: 'Message limit reached. Please upgrade your plan.' },
        quota_exceeded: true,
        plan: quotaResult.plan
      });
    }

    const lang    = body.lang || detectLang(userText);
    const today   = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const messages = (body.messages || []).slice(-8).map(m => ({
      role:    m.role,
      content: sanitizeField(String(m.content || ''), 2000)
    }));

    const conversationText = messages.map(m => m.content).join(' ');
    const supaProfile      = userId ? await loadProfile(userId) : null;
    const profile          = detectProfile(conversationText, supaProfile);

    // FIX: Only patch profile when something actually changed
    if (userId && supabase) {
      const changed =
        (profile.sector  && profile.sector  !== supaProfile?.sector)  ||
        (profile.country && profile.country !== supaProfile?.country) ||
        (profile.orgType && profile.orgType !== supaProfile?.organization_type);

      if (changed) {
        getTable('profiles')
          .update({
            detected_sector:   profile.sector,
            detected_org_type: profile.orgType,
            detected_country:  profile.country
          })
          .eq('user_id', userId)
          .then(({ error }) => { if (error) console.log('[PROFILE PATCH]', error.message); })
          .catch(() => {});
      }
    }

    if (Math.random() < 0.05) {
      cleanExpiredCache().catch(e => console.log('[CACHE CLEAN BG]', e.message));
    }

    // FIX: Also trigger search when user has a profile with sector+country
    // (they logged in with profile = they want funding matches, not general chat)
    const hasCompleteProfile = !!(profile.sector && profile.country);
    const shouldSearch = needsSearch(messages) || !!imageData || hasCompleteProfile;
    let results   = [];
    let sources   = { db: 0, serper: 0 };
    let fromCache = false;
    let cachedAt  = null;

    if (shouldSearch && !imageData) {
      // FIX: stable cache key — no volatile keywords[]
      const cacheKey = buildCacheKey(userText, profile);
      const cached   = await getCached(cacheKey);

      if (cached?.results?.length) {
        results   = cached.results;
        cachedAt  = cached.created_at;
        fromCache = true;
        console.log('[v22] cache hit');
      } else {
        const hybrid = await hybridSearch(userText, profile);
        results  = hybrid.results;
        sources  = hybrid.sources;

        if (results.length > 0) {
          await saveCache(cacheKey, userText, results).catch(e =>
            console.log('[CACHE SAVE FAIL]', e.message)
          );
        }
        console.log(`[v22] db:${sources.db} serper:${sources.serper} total:${results.length}`);
      }
    }

    const systemPrompt = buildSystemPrompt(lang, today, profile, results, sources);

    // Build Gemini contents array
    const contents = messages.map(m => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }]
    }));

    if (imageData && imageType && contents.length > 0) {
      contents[contents.length - 1].parts.push({
        inline_data: { mime_type: imageType, data: imageData }
      });
    }

    if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Hello' }] });

    const text = await gemini(systemPrompt, contents);

    return res.status(200).json({
      content:      [{ type: 'text', text }],
      intent:       shouldSearch ? 'grant' : 'general',
      cached:       fromCache,
      cached_at:    cachedAt,
      db_results:   sources.db,
      web_results:  sources.serper,
      top_matches:  results.slice(0, 5).map(r => ({
        title:      r.title || '',
        score:      Number.isFinite(r.score) ? r.score : 0,
        score_type: r.score_type || 'match',
        source:     r.source    || 'db',
        link:       r.link      || '',
        snippet:    r.snippet   || ''
      })),
      debug_results: results
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
