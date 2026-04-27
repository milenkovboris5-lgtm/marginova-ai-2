// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/llmRouter.js
// Two-call hybrid AI pipeline:
//   Call 1: Extract structured data from Serper snippets
//   Call 2: Synthesize final decision from verified data only
//
// Zero hallucinations — Gemini only works with data it receives.
// If data is missing → explicitly says "verify on source".
// ═══════════════════════════════════════════════════════════

const { gemini } = require('./utils');

// ═══ CALL 1: EXTRACTION ═══
// Extracts structured program data from raw Serper snippets.
// Returns JSON array — only fields that are explicitly found.

async function extractFromSerper(serperResults, profile) {
  if (!serperResults?.length) return [];

  const snippetsText = serperResults.map((r, i) =>
    `[${i+1}] Title: ${r.title}\nSnippet: ${r.snippet}\nURL: ${r.link}`
  ).join('\n\n');

  const extractPrompt = `You are a data extraction engine. Extract funding program details from search snippets.

STRICT RULES:
- Only extract information EXPLICITLY stated in the snippet
- If a field is not mentioned → use null
- Never invent amounts, dates, or eligibility criteria
- For deadlines: only extract if a specific date is mentioned (format: YYYY-MM-DD)
- For amounts: only extract if a specific number with currency is mentioned

USER PROFILE:
Sector: ${profile.sector || 'not specified'}
Country: ${profile.country || 'not specified'}
Org type: ${profile.orgType || 'not specified'}
Budget: ${profile.budget || 'not specified'}

SEARCH RESULTS TO EXTRACT FROM:
${snippetsText}

Return a JSON array. For each result that seems relevant to the user profile, return:
{
  "index": <number from snippet>,
  "title": "<program name>",
  "organization": "<donor/funder name or null>",
  "amount": "<specific amount with currency or null>",
  "deadline": "<YYYY-MM-DD or null>",
  "eligibility": "<who can apply, 1 sentence, or null>",
  "focus": "<what it funds, 1 sentence>",
  "url": "<url>",
  "relevance_score": <0-100, how well it matches the profile>,
  "relevance_reason": "<1 sentence why it matches or does not match>"
}

Return ONLY the JSON array. No explanation. No markdown. No code blocks.`;

  try {
    const contents = [{ role: 'user', parts: [{ text: 'Extract now.' }] }];
    const raw = await gemini(extractPrompt, contents, { maxTokens: 1500, temperature: 0.1 });

    // Parse JSON — strip any accidental markdown
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed  = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];

    // Map back to our result format, filter by relevance
    return parsed
      .filter(r => r.relevance_score >= 30)
      .map(r => ({
        title:             r.title       || 'Unknown program',
        organization_name: r.organization || '',
        award_amount:      parseAmount(r.amount),
        currency:          parseCurrency(r.amount),
        funding_range:     r.amount      || null,
        application_deadline: r.deadline || null,
        eligibility:       r.eligibility || null,
        description:       r.focus       || '',
        source_url:        r.url         || '',
        country:           profile.country || '',
        focus_areas:       profile.sector  || '',
        score:             Math.min(60, Math.round(r.relevance_score * 0.6)),
        score_type:        'web_extracted',
        source:            'serper_extracted',
        snippet:           r.relevance_reason || '',
        link:              r.url || '',
        _raw_reason:       r.relevance_reason,
      }));

  } catch (e) {
    console.log('[EXTRACT] Parse error:', e.message);
    return [];
  }
}

function parseAmount(str) {
  if (!str) return null;
  const match = str.match(/[\d,\.]+/);
  if (!match) return null;
  const num = parseFloat(match[0].replace(/,/g, ''));
  return isNaN(num) ? null : num;
}

function parseCurrency(str) {
  if (!str) return 'EUR';
  if (str.includes('$') || str.toUpperCase().includes('USD')) return 'USD';
  if (str.includes('£') || str.toUpperCase().includes('GBP')) return 'GBP';
  return 'EUR';
}

// ═══ CALL 2: SYNTHESIS ═══
// Synthesizes final TOP 3 decision from verified DB + extracted web data.
// Gemini ONLY uses data from the provided programs — zero invention.

async function synthesize(lang, today, profile, programs, sources) {
  const LANG_NAMES = {
    mk:'Macedonian', sr:'Serbian', en:'English',
    de:'German', fr:'French', es:'Spanish', it:'Italian', pl:'Polish', tr:'Turkish'
  };
  const L = LANG_NAMES[lang] || 'English';

  if (!programs?.length) {
    return buildNoResultsPrompt(L, profile);
  }

  const top3 = programs.slice(0, 3);
  const roles = ['APPLY', 'CONDITIONAL', 'BACKUP'];

  // Build verified program data blocks for Gemini
  const programBlocks = top3.map((p, i) => {
    const role = roles[i];
    const prob = calcProbability(p, profile);
    const risks = analyzeRisks(p, profile);

    return `
PROGRAM ${i+1} — ${role}
Name: ${p.title}
Organization: ${p.organization_name || 'Unknown'}
Amount: ${p.award_amount ? `${p.award_amount} ${p.currency || 'EUR'}` : (p.funding_range || 'Not specified')}
Deadline: ${p.application_deadline || 'Not specified — tell user to verify'}
Eligibility: ${p.eligibility || 'Not specified — tell user to verify'}
Focus areas: ${p.focus_areas || p.description?.slice(0, 150) || 'Not specified'}
Country/Region: ${p.country || 'Not specified'}
URL: ${p.link || p.source_url || 'Not available'}
Match score: ${p.score}/100
Calculated probability: ${prob}%
Source: ${p.source === 'serper_extracted' ? 'WEB SEARCH — user must verify details' : 'VERIFIED DATABASE'}

RISK ANALYSIS (use these exact risks, do not invent others):
${risks.map(r => `- ${r}`).join('\n')}

WHY IT MATCHES (base only on profile vs program data above):
${buildMatchReason(p, profile)}
`.trim();
  }).join('\n\n---\n\n');

  const profileText = [
    profile.sector  ? `Sector: ${profile.sector}`   : null,
    profile.orgType ? `Org type: ${profile.orgType}` : null,
    profile.country ? `Country: ${profile.country}`  : null,
    profile.budget  ? `Budget: ${profile.budget}`    : null,
  ].filter(Boolean).join('\n') || 'Profile not fully specified';

  const sourceNote = sources?.serper > 0
    ? `\nNOTE: ${sources.serper} result(s) from web search — those must be verified directly on source URLs.`
    : '';

  const synthesisPrompt = `LANGUAGE: Always respond in ${L}. Match the user's language exactly.

You are MARGINOVA — a funding evaluation system.
Today: ${today}

USER PROFILE:
${profileText}

YOUR TASK:
Present exactly 3 funding decisions using ONLY the program data provided below.
Do NOT invent any amounts, dates, eligibility criteria, or URLs.
If a field says "Not specified" → write "verify on source" in your response.
If source is "WEB SEARCH" → add a note that details must be verified.${sourceNote}

USE EXACTLY THIS FORMAT for each program:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[ROLE: APPLY / CONDITIONAL / BACKUP]
📋 [Program name]
📊 Decision: YES / CONDITIONAL / BACKUP
🎯 Probability of success: X%
💰 [Amount — use ONLY what is in the data, never invent]
📅 Deadline: [date or "verify on source"]
✅ Why you qualify: [Use ONLY the match reason provided — 1-2 sentences]
⚠️ Risks:
  • [Use ONLY the risks listed — do not add new ones]
🔗 [URL — use ONLY what is provided]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After all 3 programs:
▶ NEXT STEP: One concrete action today — specific to the top program.

PROGRAM DATA (use ONLY this, nothing else):

${programBlocks}`;

  const contents = [{ role: 'user', parts: [{ text: 'Present the 3 funding decisions now.' }] }];
  return await gemini(synthesisPrompt, contents, { maxTokens: 2000, temperature: 0.2 });
}

function buildNoResultsPrompt(L, profile) {
  const LANG_NAMES = { mk:'Macedonian', sr:'Serbian', en:'English', de:'German', fr:'French' };
  // Return a structured no-results message
  return `No verified funding programs found matching your profile (${profile.sector || 'unspecified sector'}, ${profile.country || 'unspecified country'}). Please refine your search or provide more details about your project.`;
}

// ═══ RISK ANALYZER ═══
// Pure logic — no Gemini, no hallucination possible

function analyzeRisks(program, profile) {
  const risks = [];
  const elig    = (program.eligibility || '').toLowerCase();
  const country = (program.country     || '').toLowerCase();
  const desc    = (program.description || program.focus_areas || '').toLowerCase();
  const org     = (profile.orgType || '').toLowerCase().split('/')[0].trim();

  // Eligibility mismatch
  if (elig.length > 10 && org && !elig.includes(org)) {
    if (!elig.includes('all') && !elig.includes('global') && !elig.includes('any')) {
      risks.push(`Eligibility mismatch — program targets "${elig.slice(0, 60)}..." — verify your org type qualifies`);
    }
  }

  // Country/region mismatch
  if (profile.country && country.length > 0) {
    const pc = profile.country.toLowerCase();
    if (!country.includes(pc) && !country.includes('global') &&
        !country.includes('europe') && !country.includes('western balkans')) {
      risks.push(`Regional limitation — program covers "${program.country}" — confirm ${profile.country} is eligible`);
    }
  }

  // Budget mismatch
  if (profile.budget && program.award_amount) {
    const RANGES = {
      'up to €30k':   [0, 30000],
      '€30k–€150k':   [30000, 150000],
      '€150k–€500k':  [150000, 500000],
      'above €500k':  [500000, Infinity],
    };
    const [min, max] = RANGES[profile.budget] || [0, Infinity];
    if (program.award_amount < min * 0.5 || program.award_amount > max * 2) {
      risks.push(`Budget mismatch — you need ${profile.budget} but program offers ${program.award_amount} ${program.currency || 'EUR'}`);
    }
  }

  // Competition level
  if (desc.includes('global') || desc.includes('international') || desc.includes('worldwide')) {
    risks.push('High competition — global applicant pool expected');
  } else if (desc.includes('western balkans') || desc.includes('regional')) {
    risks.push('Medium competition — regional applicants');
  }

  // Missing deadline
  if (!program.application_deadline) {
    risks.push('Deadline not confirmed — verify directly on source URL before applying');
  }

  // Web source warning
  if (program.source === 'serper_extracted') {
    risks.push('Web result — verify all details (amount, deadline, eligibility) on the official source');
  }

  if (!risks.length) risks.push('No major risks identified — strong match based on available data');
  return risks;
}

// ═══ PROBABILITY CALCULATOR ═══
// Deterministic — no AI, pure math

function calcProbability(program, profile) {
  let prob = Math.round((program.score || 0) * 0.55);

  const elig    = (program.eligibility  || '').toLowerCase();
  const country = (program.country      || '').toLowerCase();
  const desc    = (program.description  || '').toLowerCase();
  const org     = (profile.orgType || '').toLowerCase().split('/')[0].trim();

  // Eligibility bonus/penalty
  if (org && elig.length > 10) {
    if (elig.includes(org)) prob += 8;
    else if (!elig.includes('all') && !elig.includes('global')) prob -= 10;
  }

  // Country bonus/penalty
  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (country.includes(pc))                                            prob += 8;
    else if (country.includes('global') || country.includes('europe') ||
             country.includes('western balkans'))                        prob += 4;
    else                                                                 prob -= 8;
  }

  // Competition penalty
  if (desc.includes('global') || desc.includes('worldwide'))  prob -= 10;
  else if (desc.includes('open') || desc.includes('all'))      prob -= 4;

  // Web source penalty (less reliable)
  if (program.source === 'serper_extracted') prob -= 8;

  // Deadline proximity bonus
  if (program.application_deadline) {
    const days = Math.round((new Date(program.application_deadline) - new Date()) / 86400000);
    if (days > 0 && days < 45) prob += 4;
    if (days < 0) prob -= 20; // expired
  }

  return Math.max(10, Math.min(76, prob));
}

// ═══ MATCH REASON BUILDER ═══
// Pure logic — explains WHY based on data, no invention

function buildMatchReason(program, profile) {
  const parts = [];
  const focus   = (program.focus_areas || '').toLowerCase();
  const desc    = (program.description || '').toLowerCase();
  const country = (program.country     || '').toLowerCase();
  const elig    = (program.eligibility || '').toLowerCase();
  const hay     = `${focus} ${desc}`;

  // 1. WHAT specifically matched in focus_areas/description
  const SECTOR_WORDS = {
    'Environment / Energy':  ['environment','climate','renewable','biodiversity','conservation','clean energy','ecosystem','pollution','nature','wildlife','forest','sustainability'],
    'Civil Society':         ['civil society','ngo','nonprofit','advocacy','democracy','grassroots','rights','governance'],
    'Agriculture':           ['agriculture','farmer','rural','food','farm','ipard'],
    'Education':             ['education','school','learning','scholarship','training','erasmus'],
    'IT / Technology':       ['technology','digital','software','ai','innovation','ict','startup'],
    'Health / Social':       ['health','social','welfare','care','women','gender'],
    'Research / Innovation': ['research','science','innovation','university','academic'],
    'SME / Business':        ['business','enterprise','sme','company','entrepreneur'],
    'Student / Youth':       ['student','scholarship','fellowship','youth','erasmus','fulbright'],
  };
  const kws = SECTOR_WORDS[profile.sector] || [];
  const matched = kws.filter(k => hay.includes(k));
  if (matched.length > 0) {
    parts.push(`Covers: ${matched.slice(0,3).join(', ')}`);
  }

  // 2. Country — show exact match type
  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (country.includes(pc)) {
      parts.push(`${profile.country} listed as eligible`);
    } else if (country.includes('western balkans')) {
      parts.push(`Western Balkans eligible (includes ${profile.country})`);
    } else if (country.includes('global') || country.includes('europe')) {
      parts.push(`Open to ${profile.country} (global/Europe-wide)`);
    }
  }

  // 3. Org type — show eligibility snippet if matched
  if (profile.orgType && elig.length > 10) {
    const orgKw = (profile.orgType || '').toLowerCase().split('/')[0].trim();
    const synonyms = { 'ngo':['ngo','nonprofit','civil society','foundation','association'],
                       'sme':['sme','company','enterprise','business'],
                       'individual':['individual','person','applicant','citizen','creator'] };
    const checks = synonyms[orgKw] || [orgKw];
    if (checks.some(k => elig.includes(k))) {
      const snippet = elig.replace(/\s+/g,' ').slice(0, 70);
      parts.push(`Eligible: "${snippet}..."`);
    }
  }

  // 4. Budget fit — concrete numbers only
  if (profile.budget && program.award_amount) {
    const RANGES = { 'up to €30k':[0,30000], '€30k–€150k':[30000,150000],
                     '€150k–€500k':[150000,500000], 'above €500k':[500000,Infinity] };
    const [mn, mx] = RANGES[profile.budget] || [0, Infinity];
    const amt = Number(program.award_amount);
    if (amt >= mn && amt <= mx) {
      parts.push(`Amount ${amt.toLocaleString()} ${program.currency||'EUR'} fits your budget`);
    }
  }

  return parts.length
    ? parts.join(' · ')
    : 'Partial match — verify eligibility on source';
}

module.exports = { extractFromSerper, synthesize, analyzeRisks, calcProbability };
