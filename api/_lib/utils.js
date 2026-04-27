// MARGINOVA — api/_lib/llmRouter.js
// v3 — FIXED: language in system prompt, not user.
//       deterministic prob/risks/match, no hallucination.

const { gemini, LANG_NAMES } = require('./utils');

console.log('[llmRouter] v3 loaded — language in system prompt');

// Map from language code to native name (for prompt)
const NATIVE_NAMES = {
  mk: 'македонски', sr: 'српски', hr: 'hrvatski', bs: 'bosanski',
  sq: 'shqip', bg: 'български', ro: 'română', sl: 'slovenščina',
  en: 'English', de: 'Deutsch', fr: 'français', es: 'español',
  it: 'italiano', pl: 'polski', tr: 'Türkçe', nl: 'Nederlands',
  pt: 'português', cs: 'čeština', hu: 'magyar', el: 'ελληνικά',
  ru: 'русский', uk: 'українська', ar: 'العربية', ko: '한국어',
  ja: '日本語', zh: '中文',
};

// ─── DETERMINISTIC PROBABILITY ───────────────────────────────
function calcProbability(p, profile, roleIndex = 0) {
  let prob = Math.round((p.score || 0) * 0.55) + [0, -8, -16][roleIndex];
  const elig = (p.eligibility || '').toLowerCase();
  const ctry = (p.country     || '').toLowerCase();
  const desc = (p.description || '').toLowerCase();
  const org  = (profile.orgType || '').toLowerCase().split('/')[0].trim();

  if (org && elig.length > 10) {
    if (elig.includes(org))                              prob += 8;
    else if (!/all|global/.test(elig))                   prob -= 10;
  }
  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (ctry.includes(pc))                               prob += 8;
    else if (/global|europe|western balkans/.test(ctry)) prob += 4;
    else                                                 prob -= 8;
  }
  if (/global|worldwide/.test(desc))                     prob -= 10;
  if (p.source === 'serper_extracted')                   prob -= 8;
  if (p.application_deadline) {
    const days = Math.round((new Date(p.application_deadline) - new Date()) / 86400000);
    if (days > 0 && days < 45) prob += 4;
    if (days < 0)              prob -= 20;
  }
  return Math.max(10, Math.min(76, prob));
}

// ─── DETERMINISTIC RISKS ─────────────────────────────────────
function analyzeRisks(p, profile) {
  const risks = [];
  const elig  = (p.eligibility || '').toLowerCase();
  const ctry  = (p.country     || '').toLowerCase();
  const desc  = ((p.description || '') + ' ' + (p.focus_areas || '')).toLowerCase();
  const org   = (profile.orgType || '').toLowerCase().split('/')[0].trim();

  if (elig.length > 10 && org && !elig.includes(org) && !/all|global/.test(elig))
    risks.push(`Eligibility: verify org type — program targets "${elig.slice(0,50)}..."`);

  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (ctry.length > 0 && !ctry.includes(pc) && !/global|europe|western balkans/.test(ctry))
      risks.push(`Region: confirm ${profile.country} is eligible — listed: "${p.country}"`);
  }
  if (profile.budget && p.award_amount) {
    const R = { 'up to €30k':[0,30000], '€30k–€150k':[30000,150000], '€150k–€500k':[150000,500000], 'above €500k':[500000,Infinity] };
    const [mn, mx] = R[profile.budget] || [0, Infinity];
    const amt = Number(p.award_amount);
    if (amt < mn * 0.5 || amt > mx * 2)
      risks.push(`Budget: need ${profile.budget}, program offers ${amt.toLocaleString()} ${p.currency || 'EUR'}`);
  }
  if (/global|international|worldwide/.test(desc)) risks.push('Competition: high — global applicant pool');
  else if (/western balkans|regional/.test(desc))  risks.push('Competition: medium — regional applicants');
  if (!p.application_deadline) risks.push('Deadline: not confirmed — verify on source');
  if (p.source === 'serper_extracted') risks.push('Web result: verify all details on official source');

  if (!risks.length) {
    const on = (p.organization_name || '').toLowerCase();
    if (/usaid/.test(on))                         risks.push('USAID prioritizes established local organizations');
    else if (/undp|world bank|eu |european/.test(on)) risks.push('International program — prepare strong application');
    else                                          risks.push('Strong match — write a detailed project description');
  }
  return risks;
}

// ─── MATCH REASON ────────────────────────────────────────────
function buildMatchReason(p, profile) {
  const parts = [];
  const hay   = `${p.focus_areas || ''} ${p.description || ''}`.toLowerCase();
  const ctry  = (p.country      || '').toLowerCase();
  const elig  = (p.eligibility  || '').toLowerCase();
  const KWS   = {
    'Environment / Energy':  ['environment','climate','renewable','biodiversity','conservation','clean energy','ecosystem','pollution','nature','wildlife','forest'],
    'Civil Society':         ['civil society','ngo','nonprofit','advocacy','democracy','grassroots'],
    'Agriculture':           ['agriculture','farmer','rural','food','farm','ipard'],
    'Education':             ['education','school','learning','scholarship','erasmus'],
    'IT / Technology':       ['technology','digital','software','ai','innovation','startup'],
    'Health / Social':       ['health','social','welfare','care','women','gender'],
    'Research / Innovation': ['research','science','innovation','university','academic'],
    'SME / Business':        ['business','enterprise','sme','company','entrepreneur'],
    'Student / Youth':       ['student','scholarship','fellowship','youth','erasmus','fulbright'],
  };
  const matched = (KWS[profile.sector] || []).filter(k => hay.includes(k));
  if (matched.length) parts.push(`Covers: ${matched.slice(0,3).join(', ')}`);

  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (ctry.includes(pc))                    parts.push(`${profile.country} listed as eligible`);
    else if (ctry.includes('western balkans')) parts.push(`Western Balkans eligible (includes ${profile.country})`);
    else if (/global|europe/.test(ctry))       parts.push(`Open internationally — ${profile.country} eligible`);
  }
  const orgKw = (profile.orgType || '').toLowerCase().split('/')[0].trim();
  const SYN   = { ngo:['ngo','nonprofit','civil society','foundation','association'], sme:['sme','company','enterprise'], individual:['individual','person','applicant'] };
  if (elig.length > 10 && (SYN[orgKw] || [orgKw]).some(k => elig.includes(k)))
    parts.push(`Eligible: "${elig.slice(0,60).trim()}..."`);

  if (profile.budget && p.award_amount) {
    const R = { 'up to €30k':[0,30000], '€30k–€150k':[30000,150000], '€150k–€500k':[150000,500000], 'above €500k':[500000,Infinity] };
    const [mn, mx] = R[profile.budget] || [0, Infinity];
    const amt = Number(p.award_amount);
    if (amt >= mn && amt <= mx) parts.push(`Amount ${amt.toLocaleString()} ${p.currency||'EUR'} fits budget`);
  }
  return parts.length ? parts.join(' · ') : 'Partial match — verify eligibility on source';
}

// ─── MAIN SYNTHESIZE — SINGLE GEMINI CALL ────────────────────
async function synthesize(lang, today, profile, programs, sources) {
  const nativeName = NATIVE_NAMES[lang] || 'English';
  const langName = LANG_NAMES[lang] || 'English';

  if (!programs?.length) {
    return lang === 'mk'
      ? `Нема пронајдени програми за вашиот профил. Додајте повеќе детали за проектот.`
      : `No funding programs found for your profile. Please add more project details.`;
  }

  const roles = ['APPLY', 'CONDITIONAL', 'BACKUP'];

  // Build compact data rows — numbers/dates/URLs stay as-is
  const dataRows = programs.slice(0, 3).map((p, i) => {
    const prob  = calcProbability(p, profile, i);
    const risks = analyzeRisks(p, profile).map(r => '• ' + r).join('\n');
    const why   = buildMatchReason(p, profile);
    const amt   = p.award_amount ? `${Number(p.award_amount).toLocaleString()} ${p.currency || 'EUR'}` : (p.funding_range || '—');
    const src   = p.source === 'serper_extracted' ? '[WEB — verify]' : '[DB]';
    return `---
ROLE: ${roles[i]} ${src}
NAME: ${p.title}
ORG: ${p.organization_name || '—'}
AMOUNT: ${amt}
DEADLINE: ${p.application_deadline || 'verify on source'}
URL: ${p.link || p.source_url || '—'}
PROB: ${prob}%
WHY: ${why}
RISKS:
${risks}`;
  }).join('\n\n');

  const profileLine = [
    profile.sector  && profile.sector,
    profile.orgType && profile.orgType,
    profile.country && profile.country,
    profile.budget  && profile.budget,
  ].filter(Boolean).join(' | ') || 'not specified';

  // ✅ FIX: Language instruction goes into SYSTEM prompt, not user
  const langInstruction = (lang === 'mk')
    ? `You MUST respond in Macedonian (македонски јазик). All sections (Why you qualify, Risks, Next Step) must be in Macedonian.`
    : `You MUST respond in ${nativeName} (${langName}). All sections (Why you qualify, Risks, Next Step) must be in ${nativeName}.`;

  const system = `You are MARGINOVA, a funding evaluation assistant. ${langInstruction}
Today: ${today}. Profile: ${profileLine}.

Format each of the 3 programs exactly like this:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[ROLE: APPLY / CONDITIONAL / BACKUP]
📋 [NAME]
📊 Decision: YES / CONDITIONAL / BACKUP
🎯 Probability of success: [PROB]%
💰 [AMOUNT]
📅 Deadline: [DEADLINE]
✅ Why you qualify: [WHY — translated]
⚠️ Risks:
  [RISKS — translated, keep bullet format]
🔗 [URL]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After all 3: ▶ NEXT STEP: one concrete action today that the user can take.

Keep amounts, dates, URLs exactly as given.
The user message below contains the raw data. Use it to fill the template above.`;

  // User message contains ONLY the data (no language instruction)
  const userMsg = `Generate the 3 decisions using this data:\n\n${dataRows}`;

  const contents = [{ role: 'user', parts: [{ text: userMsg }] }];
  
  try {
    return await gemini(system, contents, { maxTokens: 2000, temperature: 0.15 });
  } catch (err) {
    console.error('[SYNTHESIZE] Gemini error:', err.message);
    // Fallback: return raw data in requested language
    if (lang === 'mk') {
      return `Грешка при генерирање: ${err.message}\n\nКористете ги овие податоци:\n${dataRows}`;
    }
    return `Error generating response: ${err.message}\n\nUse this raw data:\n${dataRows}`;
  }
}

// ─── SERPER EXTRACTION (only when DB < 3 results) ────────────
async function extractFromSerper(serperResults, profile) {
  if (!serperResults?.length) return [];
  const snippets = serperResults.map((r, i) => `[${i+1}] ${r.title}\n${r.snippet}\n${r.link}`).join('\n\n');
  const prompt = `Extract funding program data. Return JSON array only, no markdown.
Only extract fields explicitly stated. Use null if not mentioned.
Profile: sector=${profile.sector}, country=${profile.country}
For each relevant result: {"index":N,"title":"...","organization":"...or null","amount":"...or null","deadline":"YYYY-MM-DD or null","eligibility":"...or null","focus":"...","url":"...","relevance_score":0-100}
Results:\n${snippets}`;
  try {
    const raw    = await gemini(prompt, [{ role:'user', parts:[{ text:'Extract.' }] }], { maxTokens:1000, temperature:0.1 });
    const parsed = JSON.parse(raw.replace(/```json|```/g,'').trim());
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(r => r.relevance_score >= 30).map(r => ({
      title: r.title || 'Unknown', organization_name: r.organization || '',
      award_amount: r.amount ? parseFloat(r.amount.replace(/[^0-9.]/g,'')) || null : null,
      currency: r.amount?.includes('$') ? 'USD' : 'EUR',
      funding_range: r.amount || null, application_deadline: r.deadline || null,
      eligibility: r.eligibility || null, description: r.focus || '',
      source_url: r.url || '', country: profile.country || '', focus_areas: profile.sector || '',
      score: Math.min(60, Math.round((r.relevance_score || 0) * 0.6)),
      score_type: 'web_extracted', source: 'serper_extracted', link: r.url || '',
    }));
  } catch (e) { console.log('[EXTRACT]', e.message); return []; }
}

module.exports = { extractFromSerper, synthesize, analyzeRisks, calcProbability };
