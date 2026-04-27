// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/llmRouter.js
// v5 — REPLACE THE ENTIRE FILE WITH THIS
// No TOP3. No score. No YES/NO. Gemini formats, user chooses.
// Serper only when DB < 3. Safe error handling throughout.
// ═══════════════════════════════════════════════════════════

const { gemini, LANG_NAMES } = require('./utils');

console.log('[llmRouter] v5 loaded — no score, user chooses, safe parsing');

const NATIVE_NAMES = {
  mk:'македонски', sr:'српски',   hr:'hrvatski',  bs:'bosanski',
  sq:'shqip',      bg:'български', ro:'română',    sl:'slovenščina',
  en:'English',    de:'Deutsch',   fr:'français',  es:'español',
  it:'italiano',   pl:'polski',    tr:'Türkçe',    nl:'Nederlands',
  pt:'português',  cs:'čeština',   hu:'magyar',    el:'ελληνικά',
  ru:'русский',    uk:'українська', ar:'العربية',  ko:'한국어',
  ja:'日本語',     zh:'中文',
};

// ─── SAFE AMOUNT PARSER ─────────────────────────────────────
function parseAmount(val) {
  if (!val) return null;
  const n = parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

// ─── MATCH SIGNAL TEXT ──────────────────────────────────────
function buildMatchText(p, profile) {
  // Use pre-computed signals from fundingScorer if available
  if (Array.isArray(p.matchSignals) && p.matchSignals.length > 0) {
    return p.matchSignals.slice(0, 4).map(s => `• ${s}`).join('\n');
  }

  // Fallback: derive from raw fields
  const parts = [];
  const hay   = `${p.focus_areas || ''} ${p.description || ''}`.toLowerCase();
  const ctry  = (p.country || '').toLowerCase();

  const KWS = {
    'Environment / Energy':  ['environment','climate','renewable','biodiversity','conservation','clean energy'],
    'Civil Society':         ['civil society','ngo','nonprofit','advocacy','democracy'],
    'Agriculture':           ['agriculture','farmer','rural','food','farm','ipard'],
    'Education':             ['education','school','learning','scholarship','erasmus'],
    'IT / Technology':       ['technology','digital','software','ai','innovation','startup'],
    'Health / Social':       ['health','social','welfare','care','gender'],
    'Research / Innovation': ['research','science','innovation','university','academic'],
    'SME / Business':        ['business','enterprise','sme','entrepreneur'],
    'Student / Youth':       ['student','scholarship','fellowship','youth','erasmus'],
  };

  const sector  = profile?.sector || 'General';
  const kwList  = KWS[sector] || ['funding','grant','support'];
  const matched = kwList.filter(k => hay.includes(k));
  if (matched.length) parts.push(`Sector topics found: ${matched.slice(0, 3).join(', ')}`);

  if (profile?.country) {
    const pc = profile.country.toLowerCase();
    if (ctry.includes(pc))                       parts.push(`${profile.country} explicitly listed`);
    else if (ctry.includes('western balkans'))    parts.push('Western Balkans region eligible');
    else if (/global|europe/.test(ctry))          parts.push('Open internationally');
  }

  return parts.length
    ? parts.map(s => `• ${s}`).join('\n')
    : '• Check eligibility on official source';
}

// ─── RISK FACTOR TEXT ───────────────────────────────────────
function buildRiskText(p, profile) {
  // Use pre-computed risks from fundingScorer if available
  if (Array.isArray(p.riskFactors) && p.riskFactors.length > 0) {
    return p.riskFactors.slice(0, 4).map(r => `• ${r}`).join('\n');
  }

  // Fallback
  const risks = [];
  const ctry  = (p.country || '').toLowerCase();
  const desc  = `${p.description || ''} ${p.focus_areas || ''}`.toLowerCase();

  if (profile?.country) {
    const pc = profile.country.toLowerCase();
    if (ctry.length > 0 && !ctry.includes(pc) && !/global|europe|western balkans/.test(ctry)) {
      risks.push(`Confirm ${profile.country} is eligible — listed: "${p.country}"`);
    }
  }

  if (!p.application_deadline) {
    risks.push('Deadline not confirmed — verify on official source');
  } else {
    const days = Math.round((new Date(p.application_deadline) - new Date()) / 86400000);
    if (days < 14) risks.push(`Deadline soon — ${days} days remaining`);
  }

  if (/global|international|worldwide/.test(desc)) risks.push('Global competition — many applicants expected');
  if (p.source === 'serper_extracted')              risks.push('Web result — verify ALL details on official source');
  if (!risks.length)                                risks.push('Review full eligibility criteria before applying');

  return risks.map(r => `• ${r}`).join('\n');
}

// ─── BUILD DATA ROWS FOR GEMINI ─────────────────────────────
function buildDataRows(programs, profile) {
  return programs.map((p, i) => {
    const amtNum = parseAmount(p.award_amount);
    const amt    = amtNum
      ? `${Math.round(amtNum).toLocaleString()} ${p.currency || 'EUR'}`
      : (p.funding_range || '—');

    const src = p.source === 'serper_extracted' ? '[WEB — verify]' : '[DB]';

    return `---
[${i + 1}] ${src}
NAME: ${p.title || 'Unknown'}
ORG: ${p.organization_name || '—'}
AMOUNT: ${amt}
DEADLINE: ${p.application_deadline || 'verify on source'}
COUNTRY: ${p.country || '—'}
ELIGIBILITY: ${(p.eligibility || '—').slice(0, 150)}
URL: ${p.link || p.source_url || '—'}
MATCH SIGNALS:
${buildMatchText(p, profile)}
RISK FACTORS:
${buildRiskText(p, profile)}`;
  }).join('\n\n');
}

// ─── MAIN SYNTHESIZE ────────────────────────────────────────
/**
 * synthesize(lang, today, profile, programs, sources)
 *
 * Gemini presents all programs (up to 6).
 * NO probability %. NO YES/NO/APPLY labels. NO score.
 * User reads and picks what suits them.
 */
async function synthesize(lang, today, profile, programs, sources) {
  // Safe type coercion
  const safeLang     = typeof lang === 'string' ? lang : 'en';
  const safeToday    = typeof today === 'string' ? today : new Date().toLocaleDateString('en-GB');
  const safePrograms = Array.isArray(programs) ? programs : [];
  const safeSources  = sources && typeof sources === 'object' ? sources : { db: 0, serper: 0 };

  const nativeName = NATIVE_NAMES[safeLang] || 'English';
  const langName   = LANG_NAMES[safeLang]   || 'English';

  // No results case
  if (safePrograms.length === 0) {
    return safeLang === 'mk'
      ? 'Нема пронајдени програми за вашиот профил. Додадете повеќе детали — сектор, земја, тип на организација.'
      : 'No funding programs found. Please add more details — sector, country, organization type.';
  }

  const profileLine = [profile?.sector, profile?.orgType, profile?.country, profile?.budget]
    .filter(Boolean).join(' | ') || 'not specified';

  const dataRows = buildDataRows(safePrograms, profile || {});

  const langInstruction = safeLang === 'mk'
    ? 'Задолжително одговори САМО на македонски јазик. Сите секции мора да бидат на македонски.'
    : `You MUST respond entirely in ${nativeName} (${langName}).`;

  const systemPrompt = `You are MARGINOVA, a funding opportunities assistant. ${langInstruction}
Today: ${safeToday}. User profile: ${profileLine}.
DB results: ${safeSources.db}. Web results: ${safeSources.serper}.

STRICT RULES — follow exactly:
1. You are NOT a decision-maker. The donor/funder decides eligibility — not you.
2. Do NOT assign probability %, scores, or rankings of any kind.
3. Do NOT label programs YES / NO / CONDITIONAL / APPLY / BACKUP or any similar label.
4. Show ALL programs. The user makes their own choice.
5. Translate the match signals and risk factors into the user's language.
6. Keep amounts, dates, and URLs character-for-character as given in the data.
7. [WEB — verify] tagged results: add a short note that the user must verify details on the official website.

Format EACH program exactly like this (no deviations):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[N]. [PROGRAM NAME]
🏛 [ORGANIZATION]
💰 [AMOUNT]
📅 Deadline: [DEADLINE]
🌍 [COUNTRY / REGION]

✅ Why this may be relevant to you:
[MATCH SIGNALS — translated, keep bullet format]

⚠️ What to verify before applying:
[RISK FACTORS — translated, keep bullet format]

🔗 [URL]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After ALL programs add exactly one line:
▶ NEXT STEP: [one concrete action today — e.g. "Open link 1 and check if your organization type appears in the official eligibility section"]`;

  const userMsg  = `Present these ${safePrograms.length} funding opportunities to the user:\n\n${dataRows}`;
  const contents = [{ role: 'user', parts: [{ text: userMsg }] }];

  try {
    const result = await gemini(systemPrompt, contents, { maxTokens: 3500, temperature: 0.1 });
    if (!result || typeof result !== 'string') {
      throw new Error('Gemini returned empty or non-string result');
    }
    return result;
  } catch (err) {
    console.error('[SYNTHESIZE] Gemini call failed:', err.message);

    // Safe fallback — still useful to the user
    const fallback = safePrograms.map((p, i) => {
      const amtNum = parseAmount(p.award_amount);
      const amt    = amtNum ? `${Math.round(amtNum).toLocaleString()} ${p.currency || 'EUR'}` : (p.funding_range || '—');
      return `${i + 1}. ${p.title || 'Unknown'}\n   ${p.organization_name || ''} | ${amt} | ${p.application_deadline || 'TBD'}\n   ${p.link || p.source_url || ''}`;
    }).join('\n\n');

    return safeLang === 'mk'
      ? `Грешка при генерирање на одговор: ${err.message}\n\nПронајдени програми:\n${fallback}`
      : `Error generating formatted response: ${err.message}\n\nPrograms found:\n${fallback}`;
  }
}

// ─── SERPER EXTRACTION ──────────────────────────────────────
/**
 * extractFromSerper(serperResults, profile)
 * Called ONLY when DB returns fewer than MIN_RESULTS (3).
 * Gemini extracts structured data from raw Serper snippets.
 */
async function extractFromSerper(serperResults, profile) {
  if (!Array.isArray(serperResults) || serperResults.length === 0) return [];

  const snippets = serperResults
    .slice(0, 8)
    .map((r, i) => `[${i + 1}] ${r.title || ''}\n${r.snippet || ''}\n${r.link || ''}`)
    .join('\n\n');

  const safeProfile = profile || {};
  const prompt = `Extract funding program data from web search results.
Return a JSON array ONLY — no markdown fences, no explanation, no preamble.
Only extract fields that are explicitly stated. Use null for anything not mentioned.
User profile: sector=${safeProfile.sector || 'unknown'}, country=${safeProfile.country || 'unknown'}

Return exactly this shape for each relevant result:
[{"index":1,"title":"...","organization":"...or null","amount":"...or null","deadline":"YYYY-MM-DD or null","eligibility":"...or null","focus":"...","url":"...","relevance_notes":"brief note or null"}]

Web search results:
${snippets}`;

  try {
    const raw = await gemini(
      'Extract structured data from web results. Return JSON array only.',
      [{ role: 'user', parts: [{ text: prompt }] }],
      { maxTokens: 1400, temperature: 0.05 }
    );

    if (!raw || typeof raw !== 'string') return [];

    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed  = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) {
      console.warn('[EXTRACT] Gemini returned non-array:', typeof parsed);
      return [];
    }

    return parsed
      .filter(r => r && r.title && r.url)
      .map(r => ({
        title:                String(r.title),
        organization_name:    r.organization ? String(r.organization) : '',
        award_amount:         r.amount ? parseAmount(r.amount) : null,
        currency:             r.amount && String(r.amount).includes('$') ? 'USD' : 'EUR',
        funding_range:        r.amount ? String(r.amount) : null,
        application_deadline: r.deadline || null,
        eligibility:          r.eligibility || null,
        description:          r.focus ? String(r.focus) : '',
        source_url:           String(r.url),
        country:              safeProfile.country || '',
        focus_areas:          safeProfile.sector  || '',
        matchSignals:         r.relevance_notes ? [`Web: ${r.relevance_notes}`] : [],
        riskFactors:          ['Web result — verify ALL details on official source before applying'],
        _matchCount:          0,
        source:               'serper_extracted',
        link:                 String(r.url),
      }));
  } catch (e) {
    console.error('[EXTRACT] Failed to parse Gemini response:', e.message);
    return [];
  }
}

module.exports = { extractFromSerper, synthesize };
