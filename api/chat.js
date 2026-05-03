// ═══════════════════════════════════════════════════════════════════════
// MARGINOVA — api/chat.js  v8 — Funding Decision Engine
//
// PIPELINE:
// 1. detectUserProfile()    — enhance profile with type flags
// 2. searchDB()             — DB-first search
// 3. serperFallback()       — only if DB < 2 results + SERPER_API_KEY set
// 4. normalizeOpportunity() — uniform structure for all results
// 5. parseEligibility()     — extract requirement flags from eligibility text
// 6. scoreOpportunity()     — score formula: eligibility×0.5 + region×0.2 + sector×0.2 + risk×0.1
// 7. mergeDuplicates()      — collapse near-identical programs
// 8. rankResults()          — top 3 main paths + eliminated list
// 9. formatDecisionOutput() — Gemini formats in user language
// ═══════════════════════════════════════════════════════════════════════

console.log('[chat.js] v8 loaded — Decision Engine');
console.log('[chat.js] GEMINI_API_KEY:',        process.env.GEMINI_API_KEY        ? 'SET ✓' : 'MISSING ✗');
console.log('[chat.js] SUPABASE_URL:',          process.env.SUPABASE_URL          ? 'SET ✓' : 'MISSING ✗');
console.log('[chat.js] SUPABASE_SERVICE_KEY:',  process.env.SUPABASE_SERVICE_KEY  ? 'SET ✓' : 'MISSING ✗');
console.log('[chat.js] DEEPSEEK_API_KEY:',      process.env.DEEPSEEK_API_KEY      ? 'SET ✓' : 'MISSING ✗');
console.log('[chat.js] SERPER_API_KEY:',        process.env.SERPER_API_KEY        ? 'SET ✓' : 'not set (optional)');

// ─── SAFE MODULE IMPORTS ─────────────────────────────────────────────
let utils, profileDetector, fundingScorer, llmRouter;

try {
  utils = require('./_lib/utils');
  console.log('[chat.js] utils loaded ✓');
} catch (e) {
  console.error('[chat.js] FAILED to load utils:', e.message);
  module.exports = async (req, res) => res.status(500).json({ error: { message: 'Server config error: ' + e.message } });
  return;
}

try { profileDetector = require('./_lib/profileDetector'); console.log('[chat.js] profileDetector loaded ✓'); } catch (e) { console.error('[chat.js] profileDetector failed:', e.message); }
try { fundingScorer   = require('./_lib/fundingScorer');   console.log('[chat.js] fundingScorer loaded ✓');   } catch (e) { console.error('[chat.js] fundingScorer failed:', e.message); }
try { llmRouter       = require('./_lib/llmRouter');       console.log('[chat.js] llmRouter loaded ✓');       } catch (e) { console.error('[chat.js] llmRouter failed:', e.message); }

const { ft, detectLang, sanitizeField, checkIP, gemini, setCors, supabase, getTable } = utils;
const { detectProfile, needsSearch } = profileDetector || {
  detectProfile: () => ({ sector: null, orgType: null, country: null, budget: null, keywords: [] }),
  needsSearch:   () => false,
};
const { searchDB, RESULTS_TO_SHOW = 6 } = fundingScorer || { searchDB: async () => [], RESULTS_TO_SHOW: 6 };
const { extractFromSerper } = llmRouter || { extractFromSerper: async () => [] };

// ─── CONSTANTS ───────────────────────────────────────────────────────
const CACHE_TTL_HOURS = 6;
const SERPER_FALLBACK_THRESHOLD = 2;

const NATIVE_NAMES = {
  mk:'македонски', sr:'српски', hr:'hrvatski', bs:'bosanski',
  sq:'shqip', bg:'български', en:'English', de:'Deutsch',
  fr:'français', es:'español', it:'italiano', pl:'polski',
  tr:'Türkçe', nl:'Nederlands', pt:'português', cs:'čeština',
  hu:'magyar', el:'ελληνικά', ru:'русский', uk:'українська',
  ar:'العربية',
};

// ═══════════════════════════════════════════════════════════
// DECISION ENGINE FUNCTIONS
// ═══════════════════════════════════════════════════════════

// ─── 1. detectUserProfile ────────────────────────────────────────────
function detectUserProfile(text, baseProfile) {
  const p    = { ...baseProfile };
  const low  = (text || '').toLowerCase();

  if (!p.orgType) {
    if (/\b(ngo|нво|civil society|здружение|association|nonprofit|невладина)\b/i.test(text))
      p.orgType = 'NGO / Association';
    else if (/\b(дооел|ад|llc|ltd|фирма|компанија|претпријатие|sme|startup|стартап|enterprise|company)\b/i.test(text))
      p.orgType = 'SME';
    else if (/\b(поединец|физичко лице|individual|freelance|самовработен|sole trader|sole proprietor)\b/i.test(text))
      p.orgType = 'Individual / Entrepreneur';
    else if (/\b(земјоделец|земјоделско стопанство|farmer|agricultural holding|ipard|фармер)\b/i.test(text))
      p.orgType = 'Agricultural holding';
    else if (/\b(студент|student|scholarship|стипендија|fellowship|phd|doctoral|undergraduate)\b/i.test(text))
      p.orgType = 'Student / Youth';
    else if (/\b(municipality|општини|локалнa власт|local government|јавно тело|public body)\b/i.test(text))
      p.orgType = 'Municipality / Public body';
    else if (/\b(university|универзитет|институт|institute|академска|research institution)\b/i.test(text))
      p.orgType = 'University / Research';
  }

  if (!p.country) {
    const COUNTRY_MAP = [
      [/\b(македонија|macedonia|north macedonia|mk|скопје|битола|охрид|тетово)\b/i, 'North Macedonia'],
      [/\b(srbija|serbia|beograd|novi sad|sr)\b/i,                                   'Serbia'],
      [/\b(hrvatska|croatia|zagreb|hr)\b/i,                                           'Croatia'],
      [/\b(shqipëri|albania|tirana|al)\b/i,                                           'Albania'],
      [/\b(kosovo|kosovë|prishtina|pristina|xk)\b/i,                                  'Kosovo'],
      [/\b(bosna|bosnia|sarajevo|ba)\b/i,                                              'Bosnia'],
      [/\b(bugarska|bulgaria|sofia|bg)\b/i,                                            'Bulgaria'],
      [/\b(crna gora|montenegro|podgorica|me)\b/i,                                     'Montenegro'],
      [/\b(slovenija|slovenia|ljubljana|si)\b/i,                                       'Slovenia'],
    ];
    for (const [re, name] of COUNTRY_MAP) {
      if (re.test(text)) { p.country = name; break; }
    }
  }

  p._isNGO          = /ngo|association/i.test(p.orgType || '');
  p._isCompany      = /sme|startup|enterprise/i.test(p.orgType || '');
  p._isIndividual   = /individual|entrepreneur/i.test(p.orgType || '');
  p._isFarmer       = /agricultural/i.test(p.orgType || '');
  p._isStudent      = /student|youth/i.test(p.orgType || '');
  p._isMunicipality = /municipality|public body/i.test(p.orgType || '');
  p._isResearcher   = /university|research/i.test(p.orgType || '');

  return p;
}

// ─── 2. parseEligibility ─────────────────────────────────────────────
function parseEligibility(eligText, descText) {
  const hay = ((eligText || '') + ' ' + (descText || '')).toLowerCase();
  return {
    requiresNGO:         /\b(ngo|nonprofit|civil society|association|нво|здружение|граѓанско општество|non-profit)\b/.test(hay),
    requiresCompany:     /\b(sme|small.and.medium|enterprise|company|legal entity|фирма|компанија|претпријатие|дооел|registered company|incorporated|правно лице|трговско друштво|innovative sme)\b/.test(hay),
    requiresFarmer:      /\b(farmer|agricultural holding|земјоделец|земјоделско стопанство|ipard|agri-holding)\b/.test(hay),
    requiresLand:        /\b(land|hectare|хектар|земјиште|парцела|cadastral|land ownership)\b/.test(hay),
    requiresStudent:     /\b(student|scholarship|студент|стипендија|fellowship|undergraduate|graduate|phd candidate|doctoral)\b/.test(hay),
    requiresPartners:    /\b(consortium|co-applicant|partner organization|partnership|партнер|конзорциум|lead partner|multi-country)\b/.test(hay),
    requiresLegalEntity: /\b(registered entity|legal entity|правно лице|регистрирана|incorporated|registration proof)\b/.test(hay),
    requiresResearch:    /\b(research institution|university|academic institution|научна институција)\b/.test(hay),
    requiresMunicipality:/\b(municipality|local authority|local government|јавна институција|public body)\b/.test(hay),
  };
}

// ─── 3. normalizeOpportunity ─────────────────────────────────────────
function normalizeOpportunity(raw, profile) {
  const amtNum = Number(raw.award_amount);
  const amount = (!isNaN(amtNum) && raw.award_amount != null)
    ? `${Math.round(amtNum).toLocaleString()} ${raw.currency || 'EUR'}`
    : (raw.funding_range || '—');

  return {
    id:              raw.id              || null,
    title:           (raw.title          || 'Unknown').trim(),
    organization:    (raw.organization_name || raw.organization || '').trim(),
    amount,
    amountNum:       isNaN(amtNum) ? null : amtNum,
    deadline:        raw.application_deadline || null,
    region:          (raw.country        || '').trim(),
    eligibilityText: (raw.eligibility    || '').trim(),
    sectorText:      (raw.focus_areas    || '').trim(),
    sourceUrl:       (raw.source_url || raw.link || '').trim(),
    sourceType:      raw.source          || 'db',
    description:     (raw.description   || '').trim(),
    requirements:    parseEligibility(raw.eligibility, raw.description),
    _relevanceScore: raw._relevanceScore || 0,
    matchSignals:    raw.matchSignals    || [],
    riskFactors:     raw.riskFactors     || [],
    score:           0,
    probability:     0,
    decision:        null,
    riskLevel:       null,
    risks:           [],
    nextStep:        null,
    eliminated:      false,
    eliminationReason: null,
  };
}

// ─── 4. scoreOpportunity ─────────────────────────────────────────────
function scoreOpportunity(opp, profile) {
  const req   = opp.requirements;
  const today = new Date();
  const risks = [];

  // Hard elimination: expired deadline
  if (opp.deadline) {
    const deadDate = new Date(opp.deadline);
    if (!isNaN(deadDate) && deadDate < today) {
      return Object.assign(opp, {
        eliminated: true, eliminationReason: 'Expired deadline',
        decision: '🚫 ELIMINATED', probability: 0, riskLevel: 'High',
        risks: ['Deadline has passed — this program is closed'],
        nextStep: 'Look for the next call for proposals from this donor',
      });
    }
    const daysLeft = Math.round((deadDate - today) / 86400000);
    if (daysLeft < 7)       risks.push(`Deadline in ${daysLeft} days — apply immediately`);
    else if (daysLeft < 21) risks.push(`Deadline in ${daysLeft} days — start the application now`);
  }

  // ── Eligibility score (0–1) ───────────────────────────
  let eligScore    = 0.50;
  let hardConflict = false;

  const anyReq = req.requiresNGO || req.requiresCompany || req.requiresFarmer ||
                 req.requiresStudent || req.requiresMunicipality || req.requiresResearch;

  if (anyReq) {
    if (req.requiresNGO) {
      if (profile._isNGO) {
        eligScore = 0.95;
      } else if (profile._isIndividual) {
        eligScore = 0.05; hardConflict = true;
        risks.push('Requires registered NGO — individuals are not eligible');
        opp.eliminationReason = 'Requires NGO — user is an individual';
      } else if (profile._isCompany) {
        eligScore = 0.15; hardConflict = true;
        risks.push('Requires NGO/association — companies are typically not eligible');
      } else if (profile._isFarmer) {
        eligScore = 0.10; hardConflict = true;
        risks.push('Requires civil society NGO — agricultural holdings are not eligible');
      } else {
        eligScore = 0.40;
        risks.push('Verify: program requires NGO or civil society organization');
      }
    }

    if (req.requiresCompany && !req.requiresNGO) {
      if (profile._isCompany) {
        eligScore = 0.92;
      } else if (profile._isNGO) {
        eligScore = 0.20; hardConflict = true;
        risks.push('Requires registered company — NGOs are typically not eligible for this program');
      } else if (profile._isIndividual) {
        eligScore = 0.08; hardConflict = true;
        risks.push('Requires registered legal entity — sole individuals are not eligible');
        opp.eliminationReason = 'Requires registered company — user is an individual';
      } else if (profile._isFarmer) {
        eligScore = 0.30;
        risks.push('Verify: requires registered company — check if agricultural holding qualifies');
      } else {
        eligScore = 0.40;
        risks.push('Verify: requires registered company or legal entity');
      }
    }

    if (req.requiresFarmer || req.requiresLand) {
      if (profile._isFarmer) {
        eligScore = req.requiresLand ? 0.80 : 0.92;
        if (req.requiresLand) risks.push('Confirm: land ownership/lease documentation will be required');
      } else {
        eligScore = 0.03; hardConflict = true;
        opp.eliminated = true;
        opp.eliminationReason = 'Requires active agricultural holding or land ownership';
        risks.push('Requires registered agricultural holding + land ownership — not applicable to your profile');
      }
    }

    if (req.requiresStudent) {
      if (profile._isStudent) {
        eligScore = 0.92;
      } else {
        eligScore = 0.03; hardConflict = true;
        opp.eliminated = true;
        opp.eliminationReason = 'Requires active student enrollment';
        risks.push('Requires current student status — not applicable to your profile');
      }
    }

    if (req.requiresMunicipality) {
      if (profile._isMunicipality) {
        eligScore = 0.90;
      } else {
        eligScore = Math.min(eligScore, 0.30);
        risks.push('Verify: program may be targeted at municipalities/public bodies');
      }
    }

    if (req.requiresResearch) {
      if (profile._isResearcher) {
        eligScore = Math.max(eligScore, 0.85);
      } else if (profile._isNGO || profile._isCompany) {
        eligScore = Math.min(eligScore, 0.40);
        risks.push('Verify: program may require university or research institution affiliation');
      }
    }
  }

  if (req.requiresPartners) {
    risks.push('Requires consortium/partnership — you must identify at least one partner organization');
  }

  if (req.requiresLegalEntity && profile._isIndividual && !req.requiresStudent) {
    risks.push('Requires registered legal entity — sole traders may qualify in some jurisdictions, verify locally');
    eligScore = Math.min(eligScore, 0.35);
  }

  if (hardConflict && eligScore < 0.15) {
    opp.eliminated = true;
    opp.eliminationReason = opp.eliminationReason || 'Eligibility conflict with your organization type';
  }

  if (opp.eliminated) {
    return Object.assign(opp, {
      decision: '🚫 ELIMINATED', probability: Math.round(eligScore * 30),
      riskLevel: 'High', risks,
      nextStep: "This program does not match your organization type. Check the donor's other programs.",
    });
  }

  // ── Region score (0–1) ──────────────────────────────────
  let regionScore = 0.50;
  if (profile.country) {
    const pc  = profile.country.toLowerCase();
    const reg = opp.region.toLowerCase();
    if (reg.includes(pc)) {
      regionScore = 1.0;
    } else if (/western balkans|southeast europe|balkans/.test(reg)) {
      regionScore = 0.80;
    } else if (/european union|europe\b/.test(reg)) {
      regionScore = 0.60;
    } else if (/global|international|worldwide/.test(reg)) {
      regionScore = 0.45;
    } else if (reg.length > 3 && !reg.includes(pc)) {
      regionScore = 0.08;
      risks.push(`Confirm ${profile.country} is eligible — program targets: "${opp.region}"`);
      opp.eliminated = true;
      opp.eliminationReason = `Region mismatch — program targets ${opp.region}, not ${profile.country}`;
    }
  }

  if (opp.eliminated) {
    return Object.assign(opp, {
      decision: '🚫 ELIMINATED', probability: Math.round(eligScore * regionScore * 50),
      riskLevel: 'High', risks,
      nextStep: "This program is not open to your country. Check the donor's regional programs.",
    });
  }

  // ── Sector score (0–1) ──────────────────────────────────
  let sectorScore = 0.50;
  if (profile.sector) {
    const hay = (opp.sectorText + ' ' + opp.description + ' ' + opp.eligibilityText).toLowerCase();
    const SECTOR_KWS = {
      'it / technology':       ['technology','digital','software','ai','ict','innovation','startup','fintech','cybersecurity','data'],
      'agriculture':           ['agriculture','farmer','rural','food','farm','ipard','agri','crop','livestock','organic'],
      'education':             ['education','school','learning','training','erasmus','scholarship','curriculum','teacher'],
      'environment / energy':  ['environment','climate','renewable','biodiversity','conservation','clean energy','emission','sustainability'],
      'civil society':         ['civil society','ngo','nonprofit','advocacy','democracy','community','rights','governance'],
      'health / social':       ['health','social','welfare','care','women','gender','disability','mental health'],
      'research / innovation': ['research','science','innovation','university','academic','phd','r&d','laboratory','patent'],
      'sme / business':        ['business','enterprise','sme','entrepreneur','revenue','market','investment','startup'],
      'tourism / culture':     ['tourism','culture','heritage','creative','art','film','media','festival'],
      'student / youth':       ['student','scholarship','fellowship','youth','erasmus','exchange','internship','undergraduate'],
      'individual / entrepreneur': ['individual','entrepreneur','founder','creator','freelance','startup','self-employed'],
    };
    const kws  = SECTOR_KWS[profile.sector.toLowerCase()] || [];
    const hits = kws.filter(k => hay.includes(k)).length;
    sectorScore = hits >= 3 ? 0.95 : hits === 2 ? 0.80 : hits === 1 ? 0.65 : 0.25;
  }

  // ── Risk score (0–1) ────────────────────────────────────
  let riskScore = 0.85;
  if (!opp.deadline) {
    riskScore -= 0.10;
    risks.push('Deadline not confirmed — verify on official source before starting application');
  }
  if (!opp.sourceUrl) {
    riskScore -= 0.15;
    risks.push('No source URL — search for the official donor website to find application instructions');
  }
  if (opp.sourceType === 'serper_extracted') {
    riskScore -= 0.20;
    risks.push('Web result — verify ALL details (amount, deadline, eligibility) on official source before applying');
  }
  if (/global|international|worldwide/.test(opp.region.toLowerCase()) && !/europe/.test(opp.region.toLowerCase())) {
    riskScore -= 0.08;
    risks.push('Global competition — very large applicant pool, highly competitive');
  }
  riskScore = Math.max(riskScore, 0.10);

  if (!risks.length) {
    risks.push('Verify full eligibility criteria on official source before submitting');
  }

  // ── Final score ──────────────────────────────────────────
  const boost      = Math.min((opp._relevanceScore || 0) / 12, 0.05);
  const finalScore = eligScore * 0.50 + regionScore * 0.20 + sectorScore * 0.20 + riskScore * 0.10 + boost;
  const probability = Math.min(Math.round(finalScore * 100), 97);

  let decision, riskLevel;
  if (probability >= 75) {
    decision = '✅ YES'; riskLevel = 'Low';
  } else if (probability >= 50) {
    decision = '⚠️ CONDITIONAL'; riskLevel = 'Medium';
  } else if (probability >= 35) {
    decision = '❌ NO'; riskLevel = 'High';
  } else {
    decision = '🚫 ELIMINATED'; riskLevel = 'High';
    opp.eliminated = true;
    opp.eliminationReason = opp.eliminationReason || 'Score below threshold — poor overall fit';
  }

  let nextStep = opp.sourceUrl
    ? `Open the official page and check the call for proposals: ${opp.sourceUrl}`
    : `Search for "${opp.title}" on the donor's official website`;

  if (opp.deadline && !opp.eliminated) {
    const daysLeft = Math.round((new Date(opp.deadline) - today) / 86400000);
    if (daysLeft <= 30) nextStep = `⚡ Apply within ${daysLeft} days. ` + nextStep;
  }

  return Object.assign(opp, { score: parseFloat(finalScore.toFixed(3)), probability, decision, riskLevel, risks, nextStep });
}

// ─── 5. mergeDuplicates ──────────────────────────────────────────────
function mergeDuplicates(opps) {
  const merged = [];
  for (const opp of opps) {
    const keyA = normTitle(opp.title);
    const dup  = merged.findIndex(m => normTitle(m.title) === keyA || tokenSim(normTitle(m.title), keyA) > 0.78);
    if (dup >= 0) {
      if ((opp.score || 0) > (merged[dup].score || 0)) merged[dup] = opp;
    } else {
      merged.push(opp);
    }
  }
  return merged;
}

function normTitle(t) {
  return (t || '').toLowerCase()
    .replace(/[-–—]\s*\d{4}.*/,'').replace(/\(.*?\)/g,'').replace(/[^\w\s]/g,'').replace(/\s+/g,' ').trim().slice(0,55);
}

function tokenSim(a, b) {
  if (!a || !b) return 0;
  const sa = new Set(a.split(' ').filter(w => w.length > 3));
  const sb = new Set(b.split(' ').filter(w => w.length > 3));
  const ix = [...sa].filter(w => sb.has(w)).length;
  const un = new Set([...sa, ...sb]).size;
  return un > 0 ? ix / un : 0;
}

// ─── 6. rankResults ──────────────────────────────────────────────────
function rankResults(opps) {
  const active     = opps.filter(o => !o.eliminated).sort((a, b) => (b.score || 0) - (a.score || 0));
  const eliminated = opps.filter(o => o.eliminated).sort((a, b) => (b.probability || 0) - (a.probability || 0));
  return { top: active.slice(0, 3), lowPriority: [...active.slice(3), ...eliminated] };
}

// ─── 7. formatDecisionOutput ─────────────────────────────────────────
async function formatDecisionOutput(lang, today, profile, top, lowPriority) {
  const nativeName  = NATIVE_NAMES[lang] || 'English';
  const profileLine = [profile.sector, profile.orgType, profile.country, profile.budget]
    .filter(Boolean).join(' | ') || 'not specified';

  const topBlock = top.map((o, i) =>
    `[${i+1}] ${o.title}
DECISION: ${o.decision}  PROBABILITY: ${o.probability}%  RISK: ${o.riskLevel}
Organization: ${o.organization}
Amount: ${o.amount}
Deadline: ${o.deadline || 'Not confirmed'}
Region: ${o.region || '—'}
Risks: ${o.risks.slice(0,3).join(' || ')}
Next step: ${o.nextStep}
URL: ${o.sourceUrl || '—'}`
  ).join('\n\n---\n\n');

  const lowBlock = lowPriority.slice(0, 6).map((o, i) =>
    `${i+1}. ${o.title} | ${o.decision} | ${o.eliminationReason || 'Low fit score'}`
  ).join('\n');

  const systemPrompt =
`You are MARGINOVA, a funding decision advisor. RESPOND ENTIRELY IN ${nativeName}. DO NOT switch language.
Today: ${today}. User profile: ${profileLine}.

STRICT RULES:
1. Translate ALL labels, decisions, risk text, and next steps into ${nativeName}.
2. Keep amounts, percentages, dates, URLs, and program names EXACTLY as given.
3. Do NOT invent programs, amounts, or URLs.
4. Do NOT add programs not in the data.
5. Risk descriptions must be specific — never write generic "check eligibility".
6. LANGUAGE: every word must be in ${nativeName}.

OUTPUT FORMAT (use EXACTLY this structure):

═══════════════════════════════════════
🎯 ТОП ПАТИШТА / TOP FUNDING PATHS
═══════════════════════════════════════

For each top result:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[N]. [PROGRAM NAME]
[DECISION LABEL in ${nativeName}] | [PROBABILITY]% | [RISK LEVEL in ${nativeName}]
🏛 [ORGANIZATION]
💰 [AMOUNT]
📅 [DEADLINE LABEL]: [DEADLINE]
🌍 [REGION]

⚠️ [RISKS LABEL in ${nativeName}]:
• [risk 1 — translated]
• [risk 2 — translated]

▶ [NEXT STEP LABEL in ${nativeName}]: [next step — translated]
🔗 [URL]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Then:
═══════════════════════════════════════
🚫 [ELIMINATED LABEL in ${nativeName}]
═══════════════════════════════════════
[One line per eliminated program: name | decision | reason in ${nativeName}]

Then:
═══════════════════════════════════════
📋 [FINAL DECISION LABEL in ${nativeName}]
═══════════════════════════════════════
[2 sentences: best program + immediate next action — in ${nativeName}]`;

  const userMsg =
`Present these funding decisions. TOP PATHS (${top.length}):
${topBlock || 'No programs passed the decision filter.'}

ELIMINATED / LOW PRIORITY (${lowPriority.length}):
${lowBlock || 'None.'}`;

  try {
    const result = await gemini(systemPrompt, [{ role: 'user', parts: [{ text: userMsg }] }], { maxTokens: 3200, temperature: 0.1 });
    if (result && typeof result === 'string' && result.length > 50) return result;
    throw new Error('Empty Gemini response');
  } catch (e) {
    console.error('[formatDecisionOutput] Gemini error:', e.message);
    return buildFallbackText(lang, top, lowPriority);
  }
}

function buildFallbackText(lang, top, lowPriority) {
  const mk = lang === 'mk';
  let out = mk ? '🎯 ТОП ФИНАНСИСКИ ПАТИШТА\n\n' : '🎯 TOP FUNDING PATHS FOR YOU\n\n';
  for (const [i, o] of top.entries()) {
    out += `${i+1}. ${o.title}\n   ${o.decision} | ${o.probability}%\n   ${o.organization} | ${o.amount}\n`;
    if (o.deadline) out += `   ${mk ? 'Рок' : 'Deadline'}: ${o.deadline}\n`;
    if (o.sourceUrl) out += `   ${o.sourceUrl}\n`;
    out += '\n';
  }
  if (lowPriority.length) {
    out += mk ? '\n🚫 ЕЛИМИНИРАНИ\n' : '\n🚫 ELIMINATED\n';
    lowPriority.slice(0, 4).forEach(o => { out += `• ${o.title} — ${o.decision}\n`; });
  }
  if (!top.length) {
    out = mk
      ? 'Нема програми кои ги исполнуваат критериумите. Додај повеќе детали — сектор, земја, тип на организација.'
      : 'No programs passed the eligibility filter. Please add more details — sector, country, organization type.';
  }
  return out;
}

// ─── SERPER FALLBACK ─────────────────────────────────────────────────
async function serperSearch(query) {
  const KEY = process.env.SERPER_API_KEY;
  if (!KEY) return [];
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 6, gl: 'us', hl: 'en' }),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    return d.organic || [];
  } catch (e) {
    console.warn('[SERPER]', e.message);
    return [];
  }
}

function buildSerperQuery(profile, userText) {
  const parts = ['grant funding open call 2025 2026'];
  if (profile.sector)  parts.push(profile.sector);
  if (profile.country) parts.push(profile.country);
  if (profile.orgType) parts.push(profile.orgType);
  if (userText)        parts.push(userText.replace(/\s+/g, ' ').slice(0, 80));
  return parts.join(' ');
}

// ═══════════════════════════════════════════════════════════
// CACHE HELPERS
// ═══════════════════════════════════════════════════════════

function hashQuery(str) {
  const n = (str || '').toLowerCase().trim().replace(/\s+/g, ' ');
  let h = 0;
  for (let i = 0; i < n.length; i++) { h = ((h << 5) - h) + n.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}

function buildCacheKey(userText, profile) {
  return hashQuery(JSON.stringify({
    q:       (userText || '').toLowerCase().trim().slice(0, 200),
    sector:  profile.sector  || '',
    country: profile.country || '',
    orgType: profile.orgType || '',
    budget:  profile.budget  || '',
  }));
}

async function getCached(key) {
  if (!supabase) return null;
  try {
    const { data, error } = await getTable('search_cache')
      .select('results,created_at,db_count')
      .eq('query_hash', key)
      .gt('expires_at', new Date().toISOString())
      .limit(1);
    if (error) { console.warn('[CACHE GET]', error.message); return null; }
    return data?.length ? data[0] : null;
  } catch (e) { console.warn('[CACHE GET]', e.message); return null; }
}

async function saveCache(key, queryText, results, dbCount) {
  if (!supabase) return;
  try {
    const now     = new Date();
    const expires = new Date(now.getTime() + CACHE_TTL_HOURS * 3600000);
    await getTable('search_cache').delete().eq('query_hash', key);
    await getTable('search_cache').insert({
      query_hash: key, query_text: queryText, results, db_count: dbCount,
      created_at: now.toISOString(), expires_at: expires.toISOString(),
    });
  } catch (e) { console.log('[CACHE SAVE]', e.message); }
}

async function cleanCache() {
  if (!supabase) return;
  try { await getTable('search_cache').delete().lt('expires_at', new Date().toISOString()); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════

module.exports = async function handler(req, res) {
  try { setCors(req, res); } catch (e) { console.error('[CORS]', e.message); }

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: { message: 'Method Not Allowed' } });

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: { message: 'Server configuration error: missing GEMINI_API_KEY.' } });
  }

  try {
    const allowed = await checkIP(req);
    if (!allowed) return res.status(429).json({ error: { message: 'Daily IP limit reached. Try again tomorrow.' } });
  } catch (e) { console.warn('[IP CHECK]', e.message); }

  try {
    const body      = req.body || {};
    const imageData = body.image     || null;
    const imageType = body.imageType || null;
    const rawMsg    = body.messages?.[body.messages.length - 1]?.content || body.message || '';
    const userText  = sanitizeField(rawMsg, 2000);

    if (!userText && !imageData) {
      return res.status(400).json({ error: { message: 'No message provided.' } });
    }

    // Language detection
    const allText    = (body.messages || []).map(m => m.content || '').join(' ') + ' ' + userText;
    const explicitMk = /на македонски|по македонски|in macedonian|makedonski/i.test(userText);
    const explicitEn = /in english|на англиски|по английски/i.test(userText);
    const lang = explicitMk ? 'mk' : explicitEn ? 'en' : (body.lang || detectLang(allText));

    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    console.log('[handler] lang:', lang, 'today:', today);

    // Profile detection
    const convText   = (body.messages || []).slice(-4).map(m => m.content || '').join(' ') + ' ' + userText;
    let baseProfile  = { sector: null, orgType: null, country: null, budget: null, keywords: [] };
    try { baseProfile = detectProfile(convText); } catch (e) { console.warn('[detectProfile]', e.message); }

    const profile = detectUserProfile(convText, baseProfile);
    console.log('[handler] profile:', JSON.stringify({ sector: profile.sector, orgType: profile.orgType, country: profile.country }));

    cleanCache().catch(() => {});

    // Search decision
    let shouldSearch = false;
    try {
      shouldSearch = needsSearch(convText) || !!imageData || !!(profile.sector && profile.country);
    } catch (e) { console.warn('[needsSearch]', e.message); }

    let rawResults = [];
    let sources    = { db: 0, serper: 0 };
    let fromCache  = false;
    let cachedAt   = null;

    if (shouldSearch && !imageData) {
      const cacheKey = buildCacheKey(userText, profile) + '_' + lang;
      const cached   = await getCached(cacheKey);

      if (cached?.results?.length) {
        rawResults = cached.results;
        cachedAt   = cached.created_at;
        fromCache  = true;
        sources    = { db: cached.db_count ?? rawResults.length, serper: 0 };
        console.log('[handler] cache hit:', rawResults.length);
      }

      if (!fromCache) {
        try {
          rawResults = await searchDB(profile);
          sources.db = rawResults.length;
          console.log('[handler] DB results:', rawResults.length);
        } catch (e) {
          console.error('[handler] searchDB error:', e.message);
        }

        // Serper fallback: only if DB is weak and key is configured
        if (rawResults.length < SERPER_FALLBACK_THRESHOLD && process.env.SERPER_API_KEY && !imageData) {
          console.log('[handler] DB weak — trying Serper fallback');
          try {
            const query     = buildSerperQuery(profile, userText);
            const webRaw    = await serperSearch(query);
            if (webRaw.length > 0) {
              const extracted = await extractFromSerper(webRaw, profile);
              rawResults      = [...rawResults, ...extracted];
              sources.serper  = extracted.length;
              console.log('[handler] Serper added:', extracted.length);
            }
          } catch (e) {
            console.warn('[handler] Serper fallback error:', e.message);
          }
        }

        if (rawResults.length) {
          saveCache(cacheKey, userText, rawResults, sources.db).catch(e =>
            console.warn('[handler] saveCache error:', e.message)
          );
        }
      }
    }

    // Decision pipeline
    let text        = '';
    let top         = [];
    let lowPriority = [];

    if (rawResults.length > 0) {
      const normalized = rawResults.map(r => normalizeOpportunity(r, profile));
      const scored     = normalized.map(o => scoreOpportunity(o, profile));
      const deduped    = mergeDuplicates(scored);
      const ranked     = rankResults(deduped);
      top         = ranked.top;
      lowPriority = ranked.lowPriority;
      console.log('[handler] top:', top.length, 'eliminated:', lowPriority.length);
      text = await formatDecisionOutput(lang, today, profile, top, lowPriority);
    } else {
      text = lang === 'mk'
        ? 'Нема пронајдени програми за вашиот профил. Додај повеќе детали — сектор, земја, тип на организација, и буџет.'
        : 'No funding programs found. Please add more details — sector, country, organization type, and budget.';
    }

    // Build top_matches for frontend sidebar panel
    const allScored = [...top, ...lowPriority];
    const topMatches = allScored.slice(0, RESULTS_TO_SHOW).map(o => ({
      title:           o.title,
      organization:    o.organization,
      deadline:        o.deadline        || '',
      amount:          o.amount,
      country:         o.region,
      matchSignals:    o.matchSignals    || [],
      riskFactors:     o.riskFactors?.length ? o.riskFactors : o.risks || [],
      relevanceScore:  o.score           || 0,
      probability:     o.probability     || 0,
      decision:        o.decision        || '',
      riskLevel:       o.riskLevel       || '',
      source:          o.sourceType      || 'db',
      link:            o.sourceUrl       || '',
      snippet:         [o.organization, o.amount, o.deadline ? `Deadline: ${o.deadline}` : null].filter(Boolean).join(' | '),
      opportunityId:   o.id              || null,
      opportunityType: o.eligibilityText || '',
    }));

    return res.status(200).json({
      content:     [{ type: 'text', text }],
      intent:      shouldSearch ? 'funding' : 'general',
      cached:      fromCache,
      cached_at:   cachedAt,
      db_results:  sources.db,
      web_results: sources.serper,
      top_matches: topMatches,
    });

  } catch (err) {
    console.error('[handler] UNHANDLED ERROR:', err.message);
    console.error('[handler] stack:', err.stack);
    return res.status(500).json({
      error: {
        message: 'Internal server error.',
        detail:  process.env.NODE_ENV !== 'production' ? err.message : undefined,
      },
    });
  }
};
