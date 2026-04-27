// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/responseFormatter.js
// Decision engine: calculates probability, decision label,
// risks. Builds Gemini system prompt from scored results.
// ═══════════════════════════════════════════════════════════

const { LANG_NAMES } = require('./utils');

// ═══ PROBABILITY ENGINE ═══

function calcProbability(result, profile) {
  let prob = Math.round((result.score || 0) * 0.55);
  const elig    = (result.eligibility  || '').toLowerCase();
  const country = (result.country      || '').toLowerCase();
  const desc    = (result.description  || '').toLowerCase();

  // Eligibility alignment
  if (profile.orgType) {
    const org = profile.orgType.toLowerCase().split('/')[0].trim();
    if (elig.includes(org) || elig.includes('ngo') && org.includes('ngo') || elig.includes('sme') && org.includes('sme')) prob += 8;
    else prob -= 10;
  }

  // Country alignment
  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (country.includes(pc))                                            prob += 8;
    else if (country.includes('global') || country.includes('europe'))  prob += 4;
    else                                                                 prob -= 8;
  }

  // Competition level
  if (desc.includes('horizon') || desc.includes('eic') || desc.includes('google')) prob -= 12;
  else if (desc.includes('open') || desc.includes('all'))                           prob -= 4;

  // Deadline proximity bonus
  if (result.application_deadline) {
    const days = Math.round((new Date(result.application_deadline) - new Date()) / 86400000);
    if (days > 0 && days < 45) prob += 4;
  }

  return Math.max(10, Math.min(76, prob));
}

function getRisks(result, profile) {
  const risks   = [];
  const elig    = (result.eligibility  || '').toLowerCase();
  const country = (result.country      || '').toLowerCase();
  const desc    = (result.description  || '').toLowerCase();
  const org     = (profile.orgType || '').toLowerCase().split('/')[0].trim();

  if (elig.length > 0 && !elig.includes(org) && !elig.includes('global') && !elig.includes('all'))
    risks.push('eligibility mismatch — verify org type requirement');

  if (profile.country && !country.includes('global') && !country.includes(profile.country.toLowerCase()))
    risks.push('region limitation — check country eligibility');

  if (desc.includes('horizon') || desc.includes('eic') || desc.includes('google'))
    risks.push('competition level: high — strong global applicants');
  else if (desc.includes('open') || desc.includes('all'))
    risks.push('competition level: medium');

  if (!result.application_deadline)
    risks.push('deadline not confirmed — verify on source');

  if (!risks.length) risks.push('no major risks identified — strong match');
  return risks;
}

// ═══ SYSTEM PROMPT BUILDER ═══

function buildSystemPrompt(lang, today, profile, results, sources) {
  const L = LANG_NAMES[lang] || 'English';

  const profileText = (profile.sector || profile.orgType || profile.country)
    ? `\nOrganization type: ${profile.orgType || 'not specified'}
Sector: ${profile.sector || 'not specified'}
Country: ${profile.country || 'not specified'}
Budget range: ${profile.budget || 'not specified'}`
    : '\nProfile not yet collected — ask exactly ONE targeted question.';

  // Build decision blocks for top 3
  let decisionsText = '';
  if (results.length > 0) {
    const top3 = results.slice(0, 3);
    const roles = ['APPLY', 'CONDITIONAL', 'BACKUP'];
    decisionsText = '\n\nDECISION RESULTS (TOP 3 ONLY):\n';

    top3.forEach((r, i) => {
      const prob  = calcProbability(r, profile);
      const role  = roles[i];
      const risks = getRisks(r, profile);
      const src   = r.source === 'serper' ? '[WEB — verify directly]' : '[VERIFIED]';

      decisionsText += `
[${i + 1}] ${role} ${src}
Program: ${r.title}
Decision: ${role === 'APPLY' ? 'YES' : role}
Probability of success: ${prob}%
Amount: ${r.award_amount ? `${r.award_amount} ${r.currency || ''}`.trim() : (r.funding_range || 'varies')}
Deadline: ${r.application_deadline || 'verify on source'}
Risks:
${risks.map(k => `  - ${k}`).join('\n')}
URL: ${r.link || 'verify on source'}
`;
    });
  }

  const sourceNote = sources?.serper > 0
    ? (sources.db === 0
      ? '\n\nNOTE: Results from live web search — verify all details on source URLs.'
      : `\n\nNOTE: ${sources.db} verified + ${sources.serper} web results included.`)
    : '';

  return `LANGUAGE: Always respond in ${L}. Match the user's language exactly.

You are MARGINOVA — a funding evaluation and decision system.
You turn funding discovery into executable decisions.
NEVER reveal technical details. NEVER invent programs, URLs, amounts or deadlines.
NEVER mention other tools or platforms by name.

Today: ${today}
USER PROFILE:${profileText}

FORMAT — use exactly this structure for each result:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[ROLE: APPLY / CONDITIONAL / BACKUP]
📋 [Program name]
📊 Decision: YES / CONDITIONAL / BACKUP
🎯 Probability of success: X%
💰 [Amount]
📅 Deadline: [date or "verify on source"]
✅ Why you qualify: [1-2 specific reasons based on profile]
⚠️ Risks:
  • [risk 1]
  • [risk 2]
🔗 [URL]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After the 3 results:
▶ NEXT STEP: One concrete action the user can take TODAY.

RULES:
- Present exactly 3 results (unless fewer exist)
- APPLY = highest probability, CONDITIONAL = medium, BACKUP = lowest
- If profile is incomplete — ask exactly ONE question before results
- If ZERO results — say clearly, do not invent${sourceNote}${decisionsText}`;
}

module.exports = { buildSystemPrompt, calcProbability, getRisks };
