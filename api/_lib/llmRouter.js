// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/llmRouter.js
// v8 — Balanced advisor: shows all programs, honest risks, user decides
// ═══════════════════════════════════════════════════════════

const { gemini, LANG_NAMES } = require('./utils');

console.log('[llmRouter] v8 loaded — balanced advisor, honest risks, user decides');

// ═══ GEMINI JSON SANITIZER — Bug #5 fix ══════════════════
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
  en: { strong: 'Strong match',   possible: 'Possible match',       broad: 'Broad match',   low: 'Low match' },
  mk: { strong: 'Силен мач',      possible: 'Можен мач',            broad: 'Широк мач',     low: 'Слаб мач' },
  sr: { strong: 'Jak match',      possible: 'Moguć match',          broad: 'Širok match',   low: 'Slab match' },
  de: { strong: 'Starke Passung', possible: 'Mögliche Passung',     broad: 'Breite Passung',low: 'Geringe Passung' },
  fr: { strong: 'Bonne correspondance', possible: 'Correspondance possible', broad: 'Large correspondance', low: 'Faible correspondance' },
  tr: { strong: 'Güçlü eşleşme', possible: 'Olası eşleşme',        broad: 'Geniş eşleşme', low: 'Düşük eşleşme' },
};

function getTierLabel(score, lang) {
  const labels = TIER_LABELS[lang] || TIER_LABELS['en'];
  const s = Number(score) || 0;
  if (s >= 7) return labels.strong;
  if (s >= 4) return labels.possible;
  if (s >= 1) return labels.broad;
  return labels.low;
}

function parseAmount(val) {
  if (!val) return null;
  const n = parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function buildMatchText(p, profile) {
  if (Array.isArray(p.matchSignals) && p.matchSignals.length > 0) {
    return p.matchSignals.slice(0, 4).map(s => '• ' + s).join('\n');
  }
  const parts = [];
  const hay  = ((p.focus_areas || '') + ' ' + (p.description || '')).toLowerCase();
  const ctry = (p.country || '').toLowerCase();
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
  const sector  = profile && profile.sector ? profile.sector : 'General';
  const kwList  = KWS[sector] || ['funding','grant','support'];
  const matched = kwList.filter(k => hay.includes(k));
  if (matched.length) parts.push('Sector topics found: ' + matched.slice(0, 3).join(', '));
  if (profile && profile.country) {
    const pc = profile.country.toLowerCase();
    if (ctry.includes(pc))                     parts.push(profile.country + ' explicitly listed');
    else if (ctry.includes('western balkans')) parts.push('Western Balkans region eligible');
    else if (/global|europe/.test(ctry))       parts.push('Open internationally');
  }
  return parts.length
    ? parts.map(s => '• ' + s).join('\n')
    : '• Check eligibility on official source';
}

function buildRiskText(p, profile) {
  if (Array.isArray(p.riskFactors) && p.riskFactors.length > 0) {
    return p.riskFactors.slice(0, 4).map(r => '• ' + r).join('\n');
  }
  const risks = [];
  const ctry  = (p.country || '').toLowerCase();
  const desc  = ((p.description || '') + ' ' + (p.focus_areas || '')).toLowerCase();
  if (profile && profile.country) {
    const pc = profile.country.toLowerCase();
    if (ctry.length > 0 && !ctry.includes(pc) && !/global|europe|western balkans/.test(ctry)) {
      risks.push('Confirm ' + profile.country + ' is eligible — listed: "' + p.country + '"');
    }
  }
  if (!p.application_deadline) {
    risks.push('Deadline not confirmed — verify on official source');
  } else {
    const days = Math.round((new Date(p.application_deadline) - new Date()) / 86400000);
    if (days < 14) risks.push('Deadline soon — ' + days + ' days remaining');
  }
  if (/global|international|worldwide/.test(desc)) risks.push('Global competition — many applicants expected');
  if (p.source === 'serper_extracted')              risks.push('Web result — verify ALL details on official source');
  if (!risks.length)                                risks.push('Review full eligibility criteria before applying');
  return risks.map(r => '• ' + r).join('\n');
}

function buildDataRows(programs, profile, lang) {
  return programs.map((p, i) => {
    const amtNum = parseAmount(p.award_amount);
    const amt    = amtNum
      ? Math.round(amtNum).toLocaleString() + ' ' + (p.currency || 'EUR')
      : (p.funding_range || '—');
    const src  = p.source === 'serper_extracted' ? '[WEB — verify]' : '[DB]';
    const tier = getTierLabel(p._relevanceScore, lang);
    const score = Number(p._relevanceScore) || 0;
    return '---\n' +
      '[' + (i+1) + '] ' + src + ' | TIER: ' + tier + ' | SCORE: ' + score + '\n' +
      'NAME: ' + (p.title || 'Unknown') + '\n' +
      'ORG: ' + (p.organization_name || '—') + '\n' +
      'AMOUNT: ' + amt + '\n' +
      'DEADLINE: ' + (p.application_deadline || 'verify on source') + '\n' +
      'COUNTRY: ' + (p.country || '—') + '\n' +
      'ELIGIBILITY: ' + ((p.eligibility || '—').slice(0, 150)) + '\n' +
      'URL: ' + (p.link || p.source_url || '—') + '\n' +
      'MATCH SIGNALS:\n' + buildMatchText(p, profile) + '\n' +
      'RISK FACTORS:\n' + buildRiskText(p, profile);
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
      ? 'Нема пронајдени програми. Додај повеќе детали — сектор, земја, тип на организација.'
      : 'No funding programs found. Please add more details — sector, country, organization type.';
  }

  const profileLine = [profile && profile.sector, profile && profile.orgType, profile && profile.country, profile && profile.budget]
    .filter(Boolean).join(' | ') || 'not specified';

  const dataRows = buildDataRows(safePrograms, profile || {}, safeLang);

  const langInstruction = safeLang === 'mk'
    ? 'Задолжително одговори САМО на македонски јазик.'
    : 'You MUST respond entirely in ' + nativeName + ' (' + langName + ').';

  const systemPrompt = 'You are MARGINOVA, a funding opportunities assistant. ' + langInstruction + '\n' +
    'Today: ' + safeToday + '. User profile: ' + profileLine + '.\n' +
    'DB results: ' + safeSources.db + '. Web results: ' + safeSources.serper + '.\n\n' +
    'CONTEXT: Programs are sorted best-match-first. TIER: STRONG / POSSIBLE / BROAD / LOW.\n\n' +
    'YOUR ROLE:\n' +
    'You are an informed advisor — not a decision maker.\n' +
    'Show the user what exists, be honest about risks, let them decide.\n' +
    'Never eliminate programs. Never tell the user what they cannot do.\n\n' +
    'RULE 1 — SHOW ALL PROGRAMS with honest risks:\n' +
    'If there is an eligibility concern for the user profile, state it clearly in one sentence in the risk section.\n' +
    'Examples of good risk notes:\n' +
    '  "Бара регистрирана компанија — провери дали поединци се подобни"\n' +
    '  "Бара завршен докторат — не е за веб девелопери без PhD"\n' +
    '  "Рокот е за 13 дена — итно"\n' +
    'Keep risks SHORT and SPECIFIC. Maximum 2 bullets per program.\n\n' +
    'RULE 2 — BEST MATCH FIRST:\n' +
    'The highest-scoring program gets a trophy prefix. Write one sentence why it fits best.\n\n' +
    'RULE 3 — AMOUNTS AND DATES: Copy exactly as given in the data.\n\n' +
    'RULE 4 — LANGUAGE: Respond entirely in ' + nativeName + '. No switching mid-response.\n\n' +
    'RULE 5 — FORMAT:\n' +
    'STRONG + POSSIBLE tiers = full format below.\n' +
    'BROAD + LOW tiers = shorter (1 match signal, 1 risk, URL only).\n\n' +
    'FORMAT FOR EACH PROGRAM:\n' +
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n' +
    '[trophy or N]. [PROGRAM NAME]\n' +
    'institution [ORGANIZATION]\n' +
    'money [AMOUNT]\n' +
    'calendar Deadline: [DEADLINE]\n' +
    'globe [COUNTRY]\n\n' +
    'checkmark Зошто може да одговара:\n' +
    '[1-2 specific reasons for this user]\n\n' +
    'warning Провери пред да аплицираш:\n' +
    '[1-2 specific things — not generic]\n\n' +
    'link [URL]\n' +
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n' +
    'After ALL programs, write exactly one line:\n' +
    'arrow СЛЕДЕН ЧЕКОР: [one specific action — a specific link, contact, or thing to check]';

  const userMsg  = 'Present these ' + safePrograms.length + ' funding opportunities to the user:\n\n' + dataRows;
  const contents = [{ role: 'user', parts: [{ text: userMsg }] }];

  try {
    const rawResult = await gemini(systemPrompt, contents, { maxTokens: 3500, temperature: 0.1 });
    const result    = sanitizeGeminiJSON(rawResult);
    if (!rawResult || typeof rawResult !== 'string') {
      throw new Error('Gemini returned empty or non-string result');
    }
    return result;
  } catch (err) {
    console.error('[SYNTHESIZE] Gemini call failed:', err.message);
    const fallback = safePrograms.map((p, i) => {
      const amtNum = parseAmount(p.award_amount);
      const amt    = amtNum
        ? Math.round(amtNum).toLocaleString() + ' ' + (p.currency || 'EUR')
        : (p.funding_range || '—');
      return (i+1) + '. ' + (p.title || 'Unknown') + '\n   ' +
        (p.organization_name || '') + ' | ' + amt + ' | ' + (p.application_deadline || 'TBD') + '\n   ' +
        (p.link || p.source_url || '');
    }).join('\n\n');
    return safeLang === 'mk'
      ? 'Грешка: ' + err.message + '\n\nПрограми:\n' + fallback
      : 'Error: ' + err.message + '\n\nPrograms found:\n' + fallback;
  }
}

async function extractFromSerper(serperResults, profile) {
  if (!Array.isArray(serperResults) || serperResults.length === 0) return [];
  const snippets = serperResults
    .slice(0, 8)
    .map((r, i) => '[' + (i+1) + '] ' + (r.title || '') + '\n' + (r.snippet || '') + '\n' + (r.link || ''))
    .join('\n\n');
  const safeProfile = profile || {};
  const prompt = 'Extract funding program data from web search results.\n' +
    'Return a JSON array ONLY — no markdown fences, no explanation, no preamble.\n' +
    'Only extract fields that are explicitly stated. Use null for anything not mentioned.\n' +
    'User profile: sector=' + (safeProfile.sector || 'unknown') + ', country=' + (safeProfile.country || 'unknown') + '\n\n' +
    'Return exactly this shape for each relevant result:\n' +
    '[{"index":1,"title":"...","organization":"...or null","amount":"...or null","deadline":"YYYY-MM-DD or null","eligibility":"...or null","focus":"...","url":"...","relevance_notes":"brief note or null"}]\n\n' +
    'Web search results:\n' + snippets;
  try {
    const raw = await gemini(
      'Extract structured data from web results. Return JSON array only.',
      [{ role: 'user', parts: [{ text: prompt }] }],
      { maxTokens: 1400, temperature: 0.05 }
    );
    if (!raw || typeof raw !== 'string') return [];
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed  = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
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
        matchSignals:         r.relevance_notes ? ['Web: ' + r.relevance_notes] : [],
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
