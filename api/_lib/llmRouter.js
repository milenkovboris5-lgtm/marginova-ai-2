// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/llmRouter.js
// v8 — DECISION-FIRST: eliminates ineligible, recommends best, concrete action
//
// KEY CHANGE over v7:
// System prompt rewritten from "show options" → "give decisions"
// - RULE 1: Eliminate programs where org type is incompatible
// - RULE 2: Recommend best eligible program with 🏆
// - RULE 3: Specific risks, not generic "verify criteria"
// - RULE 4: Concrete action today, not "open the link"
// ═══════════════════════════════════════════════════════════

const { gemini, LANG_NAMES } = require('./utils');

console.log('[llmRouter] v8 loaded — decision-first, elimination, Bug#5 sanitizer');

// ═══ GEMINI JSON SANITIZER — Bug #5 fix ══════════════════
// Macedonian/Cyrillic text with unescaped quotes crashes JSON.
// State machine approach — only reliable fix for unicode-heavy Gemini output.
function sanitizeGeminiJSON(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let s = raw
    .replace(/\u201C|\u201D/g, "'")
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u00AB|\u00BB/g, "'");
  let out = '', inStr = false, escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') {
      if (!inStr) { inStr = true; out += ch; continue; }
      let j = i + 1;
      while (j < s.length && ' \n\r\t'.includes(s[j])) j++;
      const next = j < s.length ? s[j] : '';
      if (next === ':' || next === ',' || next === '}' || next === ']' || next === '') {
        inStr = false; out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

const NATIVE_NAMES = {
  mk:'македонски', sr:'српски',   hr:'hrvatski',  bs:'bosanski',
  sq:'shqip',      bg:'български', ro:'română',    sl:'slovenščina',
  en:'English',    de:'Deutsch',   fr:'français',  es:'español',
  it:'italiano',   pl:'polski',    tr:'Türkçe',    nl:'Nederlands',
  pt:'português',  cs:'čeština',   hu:'magyar',    el:'ελληνικά',
  ru:'русский',    uk:'українська', ar:'العربية',  ko:'한국어',
  ja:'日本語',     zh:'中文',
};

const TIER_LABELS = {
  en: { strong: 'Strong match',  possible: 'Possible match',  broad: 'Broad match',  low: 'Low match — verify eligibility' },
  mk: { strong: 'Силен мач',     possible: 'Можен мач',       broad: 'Широк мач',    low: 'Слаб мач — провери подобност' },
  sr: { strong: 'Jak match',     possible: 'Moguć match',     broad: 'Širok match',  low: 'Slab match — proveri podobnost' },
  de: { strong: 'Starke Passung',possible: 'Mögliche Passung',broad: 'Breite Passung',low: 'Geringe Passung — Berechtigung prüfen' },
  fr: { strong: 'Bonne correspondance', possible: 'Correspondance possible', broad: 'Correspondance large', low: 'Faible correspondance — vérifier éligibilité' },
  tr: { strong: 'Güçlü eşleşme', possible: 'Olası eşleşme', broad: 'Geniş eşleşme', low: 'Düşük eşleşme — uygunluğu kontrol edin' },
};

function getTierLabel(score, lang) {
  const labels = TIER_LABELS[lang] || TIER_LABELS['en'];
  const s      = Number(score) || 0;
  if (s >= 7)  return labels.strong;
  if (s >= 4)  return labels.possible;
  if (s >= 1)  return labels.broad;
  return labels.low;
}

function parseAmount(val) {
  if (!val) return null;
  const n = parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function buildMatchText(p, profile) {
  if (Array.isArray(p.matchSignals) && p.matchSignals.length > 0) {
    return p.matchSignals.slice(0, 4).map(s => `• ${s}`).join('\n');
  }
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
    if (ctry.includes(pc))                     parts.push(`${profile.country} explicitly listed`);
    else if (ctry.includes('western balkans')) parts.push('Western Balkans region eligible');
    else if (/global|europe/.test(ctry))       parts.push('Open internationally');
  }
  return parts.length
    ? parts.map(s => `• ${s}`).join('\n')
    : '• Check eligibility on official source';
}

function buildRiskText(p, profile) {
  if (Array.isArray(p.riskFactors) && p.riskFactors.length > 0) {
    return p.riskFactors.slice(0, 4).map(r => `• ${r}`).join('\n');
  }
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

function buildDataRows(programs, profile, lang) {
  return programs.map((p, i) => {
    const amtNum = parseAmount(p.award_amount);
    const amt    = amtNum
      ? `${Math.round(amtNum).toLocaleString()} ${p.currency || 'EUR'}`
      : (p.funding_range || '—');
    const src   = p.source === 'serper_extracted' ? '[WEB — verify]' : '[DB]';
    const tier  = getTierLabel(p._relevanceScore, lang);
    const score = Number(p._relevanceScore) || 0;
    return `---
[${i + 1}] ${src} | TIER: ${tier} | SCORE: ${score}
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

async function synthesize(lang, today, profile, programs, sources) {
  const safeLang     = typeof lang === 'string' ? lang : 'en';
  const safeToday    = typeof today === 'string' ? today : new Date().toLocaleDateString('en-GB');
  const safePrograms = Array.isArray(programs) ? programs : [];
  const safeSources  = sources && typeof sources === 'object' ? sources : { db: 0, serper: 0 };

  const nativeName = NATIVE_NAMES[safeLang] || 'English';
  const langName   = LANG_NAMES[safeLang]   || 'English';

  if (safePrograms.length === 0) {
    return safeLang === 'mk'
      ? 'Нема пронајдени програми за вашиот профил. Додадете повеќе детали — сектор, земја, тип на организација.'
      : 'No funding programs found. Please add more details — sector, country, organization type.';
  }

  const profileLine = [profile?.sector, profile?.orgType, profile?.country, profile?.budget]
    .filter(Boolean).join(' | ') || 'not specified';

  const dataRows = buildDataRows(safePrograms, profile || {}, safeLang);

  const langInstruction = safeLang === 'mk'
    ? 'Задолжително одговори САМО на македонски јазик. Сите секции мора да бидат на македонски.'
    : `You MUST respond entirely in ${nativeName} (${langName}).`;

  const systemPrompt = `You are MARGINOVA, a senior grant consultant who gives DECISIONS, not lists. ${langInstruction}
Today: ${safeToday}. User profile: ${profileLine}.
DB results: ${safeSources.db}. Web results: ${safeSources.serper}.

CONTEXT: Programs are sorted best-match-first by relevance score.
TIER labels: STRONG / POSSIBLE / BROAD / LOW MATCH.

CORE PHILOSOPHY:
You give DECISIONS. "If the user has to think again after reading your response — you have not finished your job."
Eliminate what does not fit. Recommend the best. Tell them exactly what to do.

RULE 1 — ELIMINATION (apply to EVERY program before writing anything else):
Check each program's eligibility text against the user org type.
If user org type = Individual / Sole trader / Поединец / Трговец поединец / самовработен / физичко лице / freelancer / sole proprietor:
  → Programs requiring SME / registered company / legal entity / компанија / претпријатие / правно лице = ❌ ELIMINATED
  → Write ONE line only: ❌ [NAME] — Поединци не се подобни, бара регистрирана компанија. 🔗 [URL]
If user org type = NGO/Association and program requires company/SME = ❌ ELIMINATED similarly.
When eligibility text is vague → keep the program but flag in ⚠️.
DO NOT write full format for eliminated programs.

RULE 2 — RECOMMENDATION:
The highest-scoring ELIGIBLE (non-eliminated) program = 🏆 prefix, shown FIRST.
Write directly: "Ова е најдобрата опција за тебе бидејќи [specific reason in 1 sentence]."
No hedging. The user wants a decision.

RULE 3 — SPECIFIC RISKS (never generic):
FORBIDDEN: "• Review full eligibility criteria before applying"
FORBIDDEN: "• Verify country eligibility"
REQUIRED: Write the ACTUAL specific problem:
  "• Бара партнер од друга земја — треба да најдеш компанија-соработник од ЕУ"
  "• Рокот е за [X] дена — итно"
  "• Бара R&D трошоци — маркетинг не е подобен"
  "• Глобална конкуренција — 14.000+ апликанти, 5% success rate"

RULE 4 — CONCRETE ACTION (never "open the link"):
FORBIDDEN: "▶ NEXT STEP: Open link 1 and check eligibility"
REQUIRED — one of these:
  "▶ АКЦИЈА ДЕНЕС: Аплицирај на [specific URL/platform] — рокот е [date]. Процесот трае ~[time]."
  "▶ АКЦИЈА ДЕНЕС: Регистрирај ДООЕЛ преку centralen-registar.mk (7 работни дена, ~3.000 ден) → потоа аплицирај за [program name]."
  "▶ АКЦИЈА ДЕНЕС: Контактирај [org] на [email/phone] за да потврдиш подобноста пред аплицирање."

RULE 5 — BUDGET: Show 💰 amount as-is. Never write "fits your budget."
If program amount >> user budget: write in ⚠️: "Програмата нуди до [X] — провери минималниот износ на аплицирање."

RULE 6 — LANGUAGE: Entire response in ${nativeName}. Zero language switching.

RULE 7 — FORMAT BY TIER:
STRONG + POSSIBLE eligible = full format below.
BROAD + LOW eligible = short format (1 signal, 1 risk, URL).
ELIMINATED = one line only (❌).

FORMAT FOR ELIGIBLE PROGRAMS (STRONG/POSSIBLE):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[🏆 or N]. [PROGRAM NAME]
🏛 [ORGANIZATION]
💰 [AMOUNT]
📅 Deadline: [DEADLINE]
🌍 [COUNTRY / REGION]

✅ Зошто е ова за тебе:
[Translated specific match signals — NOT keyword lists — WHY specifically for this user]

⚠️ Конкретен ризик:
[ONE specific problem in plain language — see Rule 3]

🔗 [URL]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FORMAT FOR ELIMINATED:
❌ [NAME] — [specific reason] — 🔗 [URL]

After ALL programs write exactly one line:
▶ АКЦИЈА ДЕНЕС: [specific action — see Rule 4]`;

  const userMsg  = `Present these ${safePrograms.length} funding opportunities to the user:\n\n${dataRows}`;
  const contents = [{ role: 'user', parts: [{ text: userMsg }] }];

  try {
    const rawResult = await gemini(systemPrompt, contents, { maxTokens: 3500, temperature: 0.1 });
    // Bug #5: sanitize Gemini output before returning — handles MK/Cyrillic quote issues
    const result = sanitizeGeminiJSON(rawResult);
    if (!rawResult || typeof rawResult !== 'string') {
      throw new Error('Gemini returned empty or non-string result');
    }
    return result;
  } catch (err) {
    console.error('[SYNTHESIZE] Gemini call failed:', err.message);
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
        _relevanceScore:      0,
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
