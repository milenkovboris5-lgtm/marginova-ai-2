// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/generate-application.js
// v3.0 — FIXED: co_financing_rate from DB, correct budget split,
//         robust budgetNum parsing, 10% validation tolerance,
//         timeout guard, sanitize-safe JSON repair
// ═══════════════════════════════════════════════════════════

const { setCors, deepseek, supabase, LANG_NAMES } = require('./_lib/utils');

console.log('[generate-application] v3.0 loaded');

// ─── CONSTANTS ───────────────────────────────────────────────────────
const DEFAULT_CO_FIN_RATE = 20;   // % paid by beneficiary if DB has no value
const BUDGET_TOLERANCE    = 0.10; // ±10% acceptable deviation
const DEEPSEEK_TIMEOUT_MS = 25000;

// ─── ENTRY POINT ─────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (token && supabase) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error) console.warn('[auth] invalid token:', error.message);
      else       console.log('[auth] user:', user?.email);
    } catch (e) {
      console.warn('[auth] check error:', e.message);
    }
  }

  const {
    type            = 'grant',
    profile         = {},
    selectedProgram = {},
    language        = 'en',
  } = req.body || {};

  const langName = LANG_NAMES[language] || 'English';
  console.log(`[generate-application] type=${type} lang=${language}`);

  try {
    const content = type === 'scholarship'
      ? await generateScholarship(profile, selectedProgram, language, langName)
      : await generateGrant(profile, selectedProgram, language, langName);

    return res.status(200).json({
      success:      true,
      type,
      language,
      profile,
      program:      selectedProgram,
      content,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[generate-application] error:', err.message);
    return res.status(500).json({ error: 'Generation failed', detail: err.message });
  }
};

// ─── GRANT GENERATOR ─────────────────────────────────────────────────
async function generateGrant(profile, program, lang, langName) {
  const org         = profile.organization || profile.name || 'Our Organization';
  const sector      = profile.sector       || 'Technology / Innovation';
  const country     = profile.country      || 'North Macedonia';
  const description = profile.description  || '';
  const donor       = program.donor        || program.organization_name || 'Funding Organization';
  const title       = program.title        || 'Funding Program';

  // FIX #1: read co_financing_rate from DB record, fall back to DEFAULT
  const coFinRate  = parseFloat(program.co_financing_rate) || DEFAULT_CO_FIN_RATE;

  // FIX #4: robust budget parsing — handles ranges, "up to X", plain numbers
 const budgetNum = parseBudgetAmount(profile.budget || program.award_amount || '60000');
  const ownTarget  = Math.round(budgetNum * coFinRate / 100);
  const grantTarget = budgetNum - ownTarget;

  console.log(`[grant] budget=${budgetNum} coFinRate=${coFinRate}% own=${ownTarget} grant=${grantTarget}`);

  // ─── PROMPTS ──────────────────────────────────────────────────────
  const narrativePrompt = buildNarrativePrompt(org, sector, country, title, donor, budgetNum, coFinRate, ownTarget, grantTarget, description, langName);
  const planPrompt      = buildPlanPrompt(sector, country, budgetNum, description, langName);
  const budgetPrompt    = buildBudgetPrompt(sector, country, donor, budgetNum, coFinRate, ownTarget, grantTarget, description, langName);

  // FIX #7: parallel calls with individual timeouts
  const [narrativeRaw, planRaw, budgetRaw] = await Promise.all([
    safeDeepSeek(narrativePrompt, lang, 6000),
    safeDeepSeek(planPrompt,      lang, 6000),
    safeDeepSeek(budgetPrompt,    lang, 6000),
  ]);

  const narrative = parseJSON(narrativeRaw, narrativeFallback(org, sector, country, description, lang));
  const plan      = parseJSON(planRaw,      planFallback(sector, country, description, lang));
  const budget    = validateAndFixBudget(
    parseJSON(budgetRaw, null),
    budgetNum, coFinRate, ownTarget, lang
  );

  const lfm   = buildLFM(plan, lang);
  const gantt = buildGantt(plan.activities || []);

  const lines          = budget.budget_lines || [];
  const totalGrant     = lines.reduce((s, l) => s + parseLocaleNumber(l.grant_amount),    0);
  const totalOwn       = lines.reduce((s, l) => s + parseLocaleNumber(l.own_contribution), 0);
  const totalBudget    = totalGrant + totalOwn;
  const coFinPct       = totalBudget > 0 ? Math.round((totalOwn / totalBudget) * 100) : 0;

  // FIX #6: perBeneficiary from plan results, not hardcoded 150
  const beneficiaryCount = extractBeneficiaryCount(plan.results) || 150;
  const perBeneficiary   = totalBudget > 0 ? Math.round(totalBudget / beneficiaryCount) : 0;

  return {
    project_title:      narrative.project_title    || `${sector} Project in ${country}`,
    abstract:           narrative.abstract         || '',
    problem_analysis:   narrative.problem_analysis || '',
    innovation:         narrative.innovation       || '',
    sustainability:     narrative.sustainability   || '',
    team_capacity:      narrative.team_capacity    || '',
    communication:      narrative.communication    || '',
    overall_objective:  plan.overall_objective     || '',
    specific_objective: plan.specific_objective    || '',
    results:            plan.results               || [],
    activities:         plan.activities            || [],
    risks:              plan.risks                 || [],
    budget_lines:       lines,
    budget_totals:      { totalGrant, totalOwn, totalBudget, coFinPct, perBeneficiary },
    budget_notes:       budget.notes               || '',
    lfm,
    gantt,
  };
}

// ─── PROMPT BUILDERS ──────────────────────────────────────────────────
function buildNarrativePrompt(org, sector, country, title, donor, budgetNum, coFinRate, ownTarget, grantTarget, description, langName) {
  return `You are a senior EU grant writer. Write a professional, DETAILED grant application in ${langName}.
ALL string values must be in ${langName}. Keep ALL JSON keys in ENGLISH.

Organization: ${org}
Sector: ${sector}
Country: ${country}
Program: ${title}
Donor: ${donor}
Total budget: €${budgetNum.toLocaleString()}
Grant requested: €${grantTarget.toLocaleString()} (${100 - coFinRate}% of total)
Own contribution: €${ownTarget.toLocaleString()} (${coFinRate}% of total — MANDATORY)

PROJECT DESCRIPTION:
${description || 'Not provided — focus on general sector challenges'}

Return ONLY valid JSON with ENGLISH keys:
{
  "project_title": "compelling title in ${langName} (12-15 words)",
  "abstract": "400-500 words in ${langName}. Cover: problem scale, who is affected, specific solution, 3 measurable outcomes with numbers, budget split (grant €${grantTarget.toLocaleString()} + own contribution €${ownTarget.toLocaleString()}), long-term impact.",
  "problem_analysis": "400-500 words in ${langName}. Cover: 2 real statistics (Eurostat/World Bank), micro-level impact, cost of inaction, gap analysis, why this project addresses root causes.",
  "innovation": "200-250 words in ${langName}. What is novel, specific technology or method, how it differs from standard practice, transferability.",
  "sustainability": "250-300 words in ${langName}. Financial sustainability after grant, institutional embedding, 2 post-project milestones with timeframes.",
  "team_capacity": "200-250 words in ${langName}. Track record, key roles (PM, Technical Expert, Finance, Field Coordinator), why uniquely qualified.",
  "communication": "150-200 words in ${langName}. Target audiences, channels, EU visibility requirements, knowledge products."
}`;
}

function buildPlanPrompt(sector, country, budgetNum, description, langName) {
  return `EU grant writer. Create project plan in ${langName}. ALL JSON keys stay in English.

PROJECT DESCRIPTION:
${description || 'General innovation project'}

Sector: ${sector}, Country: ${country}, Budget: €${budgetNum.toLocaleString()}, Duration: 18 months.

Return ONLY valid JSON:
{
  "overall_objective": "1 sentence — broad development goal at sector + country level",
  "specific_objective": "1 SMART sentence — target group size, measurable change, 18-month timeframe",
  "results": [
    {"number":1,"title":"Result title","description":"2-3 sentences on deliverable","beneficiaries":50,"indicators":["Primary: number + baseline + target","Secondary: quality measure"],"verification":"document/survey/certificate"},
    {"number":2,"title":"...","description":"...","beneficiaries":100,"indicators":["...","..."],"verification":"..."},
    {"number":3,"title":"...","description":"...","beneficiaries":150,"indicators":["...","..."],"verification":"..."}
  ],
  "activities": [
    {"id":"A1.1","result":1,"title":"activity title","months":"1-3","responsible":"role"},
    {"id":"A1.2","result":1,"title":"...","months":"3-6","responsible":"..."},
    {"id":"A1.3","result":1,"title":"...","months":"5-8","responsible":"..."},
    {"id":"A2.1","result":2,"title":"...","months":"6-10","responsible":"..."},
    {"id":"A2.2","result":2,"title":"...","months":"8-13","responsible":"..."},
    {"id":"A2.3","result":2,"title":"...","months":"11-15","responsible":"..."},
    {"id":"A3.1","result":3,"title":"...","months":"13-16","responsible":"..."},
    {"id":"A3.2","result":3,"title":"...","months":"16-18","responsible":"..."},
    {"id":"A0.1","result":0,"title":"Project management and reporting","months":"1-18","responsible":"Project Manager"},
    {"id":"A0.2","result":0,"title":"Monitoring and evaluation","months":"1-18","responsible":"M&E Coordinator"}
  ],
  "risks": [
    {"risk":"specific risk in ${langName}","probability":"Low","impact":"High","mitigation":"mitigation in ${langName}"},
    {"risk":"...","probability":"Medium","impact":"Medium","mitigation":"..."},
    {"risk":"...","probability":"Low","impact":"Medium","mitigation":"..."},
    {"risk":"...","probability":"Medium","impact":"Low","mitigation":"..."}
  ]
}`;
}

function buildBudgetPrompt(sector, country, donor, budgetNum, coFinRate, ownTarget, grantTarget, description, langName) {
  return `Senior EU grant accountant. Create budget in ${langName}. ALL JSON keys in English.

PROJECT DESCRIPTION:
${description || 'General innovation project'}

Sector: ${sector}, Country: ${country}, Donor: ${donor}

BUDGET REQUIREMENTS — MANDATORY:
- TOTAL budget: exactly €${budgetNum} (integer, no commas)
- Grant amount: €${grantTarget} (${100 - coFinRate}% of total)
- Own contribution: €${ownTarget} (${coFinRate}% of total — this is NON-NEGOTIABLE, required by the program)
- Distribute own contribution across 2-3 budget lines (not all in one line)

Allocation ratios:
- Human Resources: 40% of total
- Equipment: 22%
- Services: 11%
- Training: 9%
- Travel: 4%
- Communication: 2%
- Indirect costs (7% of direct costs): calculate automatically

Return ONLY valid JSON:
{
  "budget_lines": [
    {"category":"Human Resources","item":"Project Coordinator","unit":"month","quantity":18,"unit_cost":INTEGER,"total":INTEGER,"grant_amount":INTEGER,"own_contribution":INTEGER},
    {"category":"Human Resources","item":"Technical Expert","unit":"month","quantity":12,"unit_cost":INTEGER,"total":INTEGER,"grant_amount":INTEGER,"own_contribution":INTEGER},
    {"category":"Equipment","item":"Project equipment","unit":"set","quantity":2,"unit_cost":INTEGER,"total":INTEGER,"grant_amount":INTEGER,"own_contribution":INTEGER},
    {"category":"Services","item":"Specialist services","unit":"lump sum","quantity":1,"unit_cost":INTEGER,"total":INTEGER,"grant_amount":INTEGER,"own_contribution":INTEGER},
    {"category":"Training","item":"Training and workshops","unit":"participant","quantity":50,"unit_cost":INTEGER,"total":INTEGER,"grant_amount":INTEGER,"own_contribution":INTEGER},
    {"category":"Travel","item":"Field visits","unit":"trip","quantity":10,"unit_cost":INTEGER,"total":INTEGER,"grant_amount":INTEGER,"own_contribution":INTEGER},
    {"category":"Communication","item":"Visibility and communication","unit":"lump sum","quantity":1,"unit_cost":INTEGER,"total":INTEGER,"grant_amount":INTEGER,"own_contribution":INTEGER},
    {"category":"Indirect costs","item":"Indirect costs (7%)","unit":"lump sum","quantity":1,"unit_cost":INTEGER,"total":INTEGER,"grant_amount":INTEGER,"own_contribution":INTEGER}
  ],
  "notes": "Budget justification in ${langName}. Explain the ${coFinRate}% own contribution (€${ownTarget}) and how it is distributed."
}

VALIDATION RULES (ALL must hold):
1. Every line: grant_amount + own_contribution = total (exactly)
2. Sum of all totals = ${budgetNum} (±5%)
3. Sum of all own_contributions = ${ownTarget} (±5%)
4. All values are plain integers — no commas, no dots, no currency symbols`;
}

// ─── SCHOLARSHIP GENERATOR ───────────────────────────────────────────
async function generateScholarship(profile, program, lang, langName) {
  const name    = profile.name    || profile.email?.split('@')[0] || 'Applicant';
  const sector  = profile.sector  || 'Research';
  const country = profile.country || 'North Macedonia';
  const title   = program.title   || 'Scholarship Program';

  const prompt = `Expert scholarship advisor. Write in ${langName}.

Applicant: ${name}, Field: ${sector}, Country: ${country}, Program: ${title}

Return ONLY valid JSON:
{
  "personal_statement": "400-500 words, first person, compelling motivation letter",
  "academic_background": "120-150 words, education, research, publications",
  "professional_experience": "100-120 words, work, internships, volunteer",
  "research_proposal": "200 words total: Title + Abstract (60w) + Methodology (80w) + Expected outcomes (40w + measurable results with numbers)",
  "return_plan": "100-120 words, specific plan for applying knowledge after returning to ${country}",
  "why_this_program": "80-100 words, why THIS specific scholarship",
  "references_guidance": ["point 1", "point 2", "point 3"],
  "cv_structure": ["Education entry", "Experience entry", "Skills entry", "Publications/Awards entry"]
}`;

  const raw     = await safeDeepSeek(prompt, lang, 6000);
  return parseJSON(raw, scholarshipFallback(name, sector, country, lang));
}

// ─── BUDGET VALIDATION & FALLBACK ────────────────────────────────────
function validateAndFixBudget(budget, budgetNum, coFinRate, ownTarget, lang) {
  const lines = budget?.budget_lines;

  if (!Array.isArray(lines) || lines.length === 0) {
    console.warn('[budget] No budget_lines — using scaled fallback');
    return scaledBudgetFallback(budgetNum, coFinRate, ownTarget, lang);
  }

  const parsedTotal = lines.reduce((s, l) => s + parseLocaleNumber(l.total), 0);
  const parsedOwn   = lines.reduce((s, l) => s + parseLocaleNumber(l.own_contribution), 0);
  const totalOk     = Math.abs(parsedTotal - budgetNum) <= budgetNum * BUDGET_TOLERANCE;
  const ownOk       = Math.abs(parsedOwn   - ownTarget) <= ownTarget  * BUDGET_TOLERANCE;

  // FIX #5: validate BOTH total AND own_contribution
  if (totalOk && ownOk) {
    console.log(`[budget] Validation PASSED total=${parsedTotal} own=${parsedOwn}`);
    return budget;
  }

  console.warn(`[budget] Validation FAILED total=${parsedTotal}/${budgetNum} own=${parsedOwn}/${ownTarget} — using scaled fallback`);
  return scaledBudgetFallback(budgetNum, coFinRate, ownTarget, lang);
}

// FIX #2: scaledBudgetFallback respects coFinRate from DB
function scaledBudgetFallback(budgetNum, coFinRate, ownTarget, lang) {
  const mk = lang === 'mk';

  const direct   = Math.round(budgetNum / 1.07); // strip 7% indirect
  const indirect = budgetNum - direct;

  const hrTotal  = Math.round(direct * 0.40);
  const hr1Total = Math.round(hrTotal * 0.60);
  const hr2Total = hrTotal - hr1Total;
  const eqTotal  = Math.round(direct * 0.22);
  const svTotal  = Math.round(direct * 0.11);
  const trTotal  = Math.round(direct * 0.09);
  const tvTotal  = Math.round(direct * 0.04);
  const cmTotal  = Math.round(direct * 0.02);

  // Distribute ownTarget across HR2, Equipment, Services
  const ownHr2  = Math.round(ownTarget * 0.50);
  const ownEq   = Math.round(ownTarget * 0.30);
  const ownSv   = ownTarget - ownHr2 - ownEq;

  return {
    budget_lines: [
      { category: mk?'Човечки ресурси':'Human Resources',   item: mk?'Проект координатор':'Project Coordinator',     unit:'month',       quantity:18, unit_cost:Math.round(hr1Total/18),   total:hr1Total,  grant_amount:hr1Total,           own_contribution:0        },
      { category: mk?'Човечки ресурси':'Human Resources',   item: mk?'Технички експерт':'Technical Expert',           unit:'month',       quantity:12, unit_cost:Math.round(hr2Total/12),   total:hr2Total,  grant_amount:hr2Total - ownHr2,  own_contribution:ownHr2   },
      { category: mk?'Опрема':'Equipment',                  item: mk?'Опрема за проектот':'Project equipment',        unit:'set',         quantity:2,  unit_cost:Math.round(eqTotal/2),     total:eqTotal,   grant_amount:eqTotal  - ownEq,   own_contribution:ownEq    },
      { category: mk?'Услуги':'Services',                   item: mk?'Специјализирани услуги':'Specialist services',  unit:'lump sum',    quantity:1,  unit_cost:svTotal,                   total:svTotal,   grant_amount:svTotal  - ownSv,   own_contribution:ownSv    },
      { category: mk?'Обука':'Training',                    item: mk?'Обука и работилници':'Training and workshops',  unit:'participant', quantity:50, unit_cost:Math.round(trTotal/50),    total:trTotal,   grant_amount:trTotal,            own_contribution:0        },
      { category: mk?'Патување':'Travel',                   item: mk?'Теренски посети':'Field visits',                unit:'trip',        quantity:10, unit_cost:Math.round(tvTotal/10),    total:tvTotal,   grant_amount:tvTotal,            own_contribution:0        },
      { category: mk?'Комуникација':'Communication',        item: mk?'Видливост и комуникација':'Visibility & comms', unit:'lump sum',    quantity:1,  unit_cost:cmTotal,                   total:cmTotal,   grant_amount:cmTotal,            own_contribution:0        },
      { category: mk?'Индиректни трошоци':'Indirect costs', item: mk?'Индиректни трошоци (7%)':'Indirect costs (7%)', unit:'lump sum',    quantity:1,  unit_cost:indirect,                  total:indirect,  grant_amount:indirect,           own_contribution:0        },
    ],
    notes: mk
      ? `Буџет пресметан според стандардна ЕУ распределба. Вкупен грант: €${(budgetNum - ownTarget).toLocaleString()}. Сопствено учество: €${ownTarget.toLocaleString()} (${coFinRate}%) — задолжителен услов на програмата.`
      : `Budget calculated using standard EU allocation ratios. Grant: €${(budgetNum - ownTarget).toLocaleString()}. Own contribution: €${ownTarget.toLocaleString()} (${coFinRate}%) — mandatory program requirement.`,
  };
}

// ─── UTILITY: parse budget amount from string ─────────────────────────
// FIX #4: handles "€50,000 - €100,000" (takes lower bound), "up to €500k", plain numbers
function parseBudgetAmount(raw) {
  if (!raw) return 60000;
  const s = String(raw).toLowerCase();

  // strip currency symbols and spaces
  let clean = s.replace(/[€$£¥₹\s]/g, '');

  // expand shorthand: 500k → 500000, 1.5m → 1500000
  clean = clean.replace(/(\d+(?:\.\d+)?)\s*k\b/g,  (_, n) => String(Math.round(parseFloat(n) * 1000)));
  clean = clean.replace(/(\d+(?:\.\d+)?)\s*m\b/g,  (_, n) => String(Math.round(parseFloat(n) * 1000000)));

  // remove thousands separators (both , and .)
  clean = clean.replace(/(\d)[,.](\d{3})(?=[,.\d]|\b)/g, '$1$2');
  clean = clean.replace(/(\d)[,.](\d{3})(?=[,.\d]|\b)/g, '$1$2');

  // extract all candidate numbers
  const nums = (clean.match(/\d+/g) || [])
    .map(Number)
    .filter(n => n >= 1000 && n <= 50_000_000);

  if (nums.length === 0) return 60000;

  // if range (e.g. "50000-100000"), take the LOWER bound (safer for budget planning)
  return nums[0];
}

// ─── UTILITY: extract beneficiary count from results ─────────────────
// FIX #6: reads from plan data, not hardcoded
function extractBeneficiaryCount(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  // take max beneficiaries across all results
  const counts = results.map(r => parseLocaleNumber(r.beneficiaries)).filter(n => n > 0);
  return counts.length > 0 ? Math.max(...counts) : null;
}

// ─── UTILITY: parse locale numbers ───────────────────────────────────
function parseLocaleNumber(val) {
  if (val === null || val === undefined) return 0;
  let s = String(val).trim().replace(/[€$£¥₹\s]/g, '');
  // European format: 1.234,56 → 1234.56
  if (/^\d{1,3}(\.\d{3})+(,\d*)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  // US format with comma thousands: 1,234,567
  else if (/,\d{3}/.test(s)) s = s.replace(/,(\d{3})/g, '$1');
  else s = s.replace(',', '.');
  s = s.replace(/[^0-9.-]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n);
}

// ─── DEEPSEEK CALLER WITH TIMEOUT ────────────────────────────────────
// FIX #7: wraps each call with a timeout so one slow call doesn't block all
async function safeDeepSeek(prompt, lang, maxTokens = 16000) {
  const system = [
    'You are a professional grant writer.',
    'OUTPUT RULES: Return ONLY a valid JSON object — nothing else.',
    'No markdown fences (no ```json), no explanation, no preamble.',
    'No trailing commas. No comments inside JSON.',
    'String values use double quotes. Never put unescaped double quotes inside string values — use single quotes or parentheses instead.',
    'Do NOT translate JSON keys — only translate string values.',
    'ALL numeric fields must be plain integers — no commas, no dots, no currency symbols.',
    'Write DETAILED, SPECIFIC content based on the project description.',
  ].join('\n');

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`DeepSeek timeout after ${DEEPSEEK_TIMEOUT_MS}ms`)), DEEPSEEK_TIMEOUT_MS)
  );

  try {
    const result = await Promise.race([
      deepseek(system, prompt, { maxTokens, temperature: 0.35 }),
      timeout,
    ]);
    console.log(`[safeDeepSeek] maxTokens:${maxTokens} preview:`, (result || '').slice(0, 200));
    return result;
  } catch (e) {
    console.warn('[safeDeepSeek] error:', e.message);
    return '{}';
  }
}

// ─── JSON PARSER ─────────────────────────────────────────────────────
// FIX #8: safer quote handling — avoids breaking Macedonian apostrophes
function parseJSON(raw, fallback) {
  if (!raw) return fallback;

  // normalize only typographic quotes (not all apostrophes)
  let clean = raw
    .replace(/\u201C|\u201D/g, '"')  // " " → "
    .replace(/\u2018|\u2019/g, "'")  // ' ' → '  (apostrophe, not quote)
    .replace(/\u00AB|\u00BB/g, '"')  // « » → "
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return fallback;

  let candidate = clean.slice(start, end + 1);

  try {
    const parsed = JSON.parse(candidate);
    return fallback ? { ...fallback, ...parsed } : parsed;
  } catch (_) {
    try {
      let repaired = candidate
        .replace(/,\s*([}\]])/g, '$1')                              // trailing commas
        .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":'); // unquoted keys

      // balance brackets
      const opens  = (repaired.match(/\[/g) || []).length;
      const closes = (repaired.match(/\]/g) || []).length;
      const openB  = (repaired.match(/\{/g) || []).length;
      const closeB = (repaired.match(/\}/g) || []).length;
      for (let i = 0; i < opens  - closes; i++) repaired += ']';
      for (let i = 0; i < openB  - closeB; i++) repaired += '}';

      const parsed = JSON.parse(repaired);
      return fallback ? { ...fallback, ...parsed } : parsed;
    } catch (e2) {
      console.warn('[parseJSON] repair failed:', e2.message);
      return fallback;
    }
  }
}

// ─── LFM BUILDER ─────────────────────────────────────────────────────
function buildLFM(plan, lang) {
  const mk = lang === 'mk';
  return {
    goal: {
      description: plan.overall_objective  || (mk ? 'Придонес кон регионалниот развој' : 'Contribute to regional development'),
      ovi:         mk ? 'Регионален индекс на развој'       : 'Regional development index',
      mov:         mk ? 'Национална статистика'             : 'National statistics',
      assumptions: mk ? 'Политичка стабилност во регионот'  : 'Political stability in the region',
    },
    purpose: {
      description: plan.specific_objective || (mk ? 'Подобрување на условите за целната група' : 'Improved conditions for target group'),
      ovi:         mk ? 'Број на корисници со подобрени услови' : 'Number of beneficiaries with improved conditions',
      mov:         mk ? 'Анкета пред/после проектот'            : 'Pre/post project survey',
      assumptions: mk ? 'Целната група ќе учествува активно'    : 'Target group actively participates',
    },
    results: (plan.results || []).map(r => ({
      number:      r.number,
      description: r.title,
      ovi:         (r.indicators || []).join('; ') || (mk ? 'Индикатор за верификација' : 'Verification indicator'),
      mov:         r.verification || (mk ? 'Финален извештај' : 'Final report'),
      assumptions: mk ? 'Партнерите соработуваат' : 'Partners cooperate as planned',
    })),
  };
}

// ─── GANTT BUILDER ───────────────────────────────────────────────────
function buildGantt(activities) {
  return activities.map(a => {
    const parts = (a.months || '1-1').split('-').map(Number);
    const start = parts[0] || 1;
    const end   = parts[1] || start;
    const bars  = [];
    for (let m = 1; m <= 18; m++) bars.push(m >= start && m <= end);
    return { id: a.id, title: a.title, result: a.result, responsible: a.responsible, bars };
  });
}

// ─── FALLBACKS ───────────────────────────────────────────────────────
function narrativeFallback(org, sector, country, description, lang) {
  const mk      = lang === 'mk';
  const hasDesc = description && description.length > 10;
  const base    = hasDesc ? description.slice(0, 80) : (mk ? `Иновации во ${sector}` : `Innovation in ${sector}`);
  return {
    project_title:    mk ? `${base} во ${country}` : `${base} in ${country}`,
    abstract:         hasDesc ? description.slice(0, 400) : (mk ? `Проектот ќе изгради капацитети во ${sector} во ${country}.` : `This project will build capacity in ${sector} in ${country}.`),
    problem_analysis: mk ? `Недостатокот на иновативни решенија во ${country} е клучна пречка за развој.` : `Lack of innovative solutions in ${country} is a key barrier to development.`,
    innovation:       mk ? 'Иновативен пристап кој комбинира современи технологии и локална експертиза.' : 'Innovative approach combining modern technology and local expertise.',
    sustainability:   mk ? 'По завршувањето, активностите продолжуваат преку одржлив бизнис модел.' : 'After completion, activities continue through a sustainable business model.',
    team_capacity:    mk ? `${org} има докажано искуство во ${sector} секторот.` : `${org} has proven experience in the ${sector} sector.`,
    communication:    mk ? 'Резултатите ќе бидат споделени преку веб-сајт, социјални мрежи и јавни настани.' : 'Results shared via website, social media, and public events.',
  };
}

function planFallback(sector, country, description, lang) {
  const mk      = lang === 'mk';
  const hasDesc = description && description.length > 10;
  return {
    overall_objective:  mk ? `Унапредување на ${sector} секторот во ${country}` : `Advancing the ${sector} sector in ${country}`,
    specific_objective: mk ? (hasDesc ? `${description.slice(0, 100)} до крајот на проектот` : `Зголемен пристап за 150 корисници`) : (hasDesc ? `${description.slice(0, 100)} by project end` : `Improved access for 150 beneficiaries`),
    results: [
      { number:1, title: mk?'Развиено решение':'Solution developed',       beneficiaries:50,  description:'', indicators:['1 solution developed','5 staff trained'],       verification: mk?'Технички извештај':'Technical report' },
      { number:2, title: mk?'Корисници вклучени':'Beneficiaries engaged',  beneficiaries:100, description:'', indicators:['100 participants trained','80% satisfaction'],   verification: mk?'Анкети':'Surveys' },
      { number:3, title: mk?'Одржливост':'Sustainability ensured',          beneficiaries:150, description:'', indicators:['Partnership signed','Revenue model defined'],   verification: mk?'Договори':'Agreements' },
    ],
    activities: [
      { id:'A1.1', result:1, title: mk?'Анализа и дизајн':'Analysis and design',                   months:'1-4',   responsible: mk?'Технички тим':'Technical team' },
      { id:'A1.2', result:1, title: mk?'Развој и тестирање':'Development and testing',             months:'5-10',  responsible: mk?'Технички тим':'Technical team' },
      { id:'A2.1', result:2, title: mk?'Регрутација на корисници':'Beneficiary recruitment',       months:'6-8',   responsible: mk?'Координатор':'Coordinator' },
      { id:'A2.2', result:2, title: mk?'Спроведување активности':'Activity implementation',        months:'9-15',  responsible: mk?'Тим':'Team' },
      { id:'A3.1', result:3, title: mk?'Партнерства и одржливост':'Partnerships and sustainability',months:'12-16', responsible: mk?'Директор':'Director' },
      { id:'A3.2', result:3, title: mk?'Финален извештај':'Final report',                          months:'17-18', responsible: mk?'Тим':'Team' },
      { id:'A0.1', result:0, title: mk?'Управување со проект':'Project management',                months:'1-18',  responsible: mk?'Проект менаџер':'Project Manager' },
      { id:'A0.2', result:0, title: mk?'Мониторинг и евалуација':'Monitoring and evaluation',      months:'1-18',  responsible: mk?'М&Е координатор':'M&E Coordinator' },
    ],
    risks: [
      { risk: mk?'Низок интерес на целната група':'Low target group interest', probability:'Low',    impact:'High',   mitigation: mk?'Рана комуникација и пилот фаза':'Early communication and pilot phase' },
      { risk: mk?'Доцнење на набавките':'Procurement delays',                  probability:'Medium', impact:'Medium', mitigation: mk?'Резервни добавувачи':'Backup suppliers' },
      { risk: mk?'Технички предизвици':'Technical challenges',                 probability:'Low',    impact:'Medium', mitigation: mk?'Агилна методологија':'Agile methodology' },
    ],
  };
}

function scholarshipFallback(name, sector, country, lang) {
  const mk = lang === 'mk';
  return {
    personal_statement:      mk ? `Растев во ${country} сведочејќи на предизвиците во ${sector} секторот.` : `Growing up in ${country}, I witnessed the challenges in the ${sector} sector.`,
    academic_background:     mk ? 'Дипломиран со одличен успех, со фокус на релевантни истражувачки области.' : 'Graduated with distinction, focusing on relevant research areas.',
    professional_experience: mk ? 'Работев на проекти директно поврзани со секторот и целната заедница.' : 'Worked on projects directly related to the sector and target community.',
    research_proposal:       mk ? `Наслов: Иновации во ${sector} во ${country}` : `Title: Innovations in ${sector} in ${country}`,
    return_plan:             mk ? `По враќањето во ${country}, ќе работам со национални институции и НВО.` : `After returning to ${country}, I will collaborate with national institutions and NGOs.`,
    why_this_program:        mk ? 'Овој програм е идеален поради академската репутација и мрежата на алумни.' : 'This program is ideal due to its academic reputation and alumni network.',
    references_guidance:     [
      mk?'Нагласете ги лидерските квалитети и конкретни постигнувања':'Emphasize leadership qualities and specific achievements',
      mk?'Споменете директна врска со полето на студии':'Mention direct relevance to the field of study',
      mk?'Опишете го потенцијалот за влијание по враќањето':'Describe the potential impact upon return',
    ],
    cv_structure: [
      mk?'Образование: Универзитет, степен, година, просек':'Education: University, degree, year, GPA',
      mk?'Искуство: Позиција, организација, период, достигнувања':'Experience: Position, organization, period, achievements',
      mk?'Вештини: Јазици (ниво), технички вештини, алатки':'Skills: Languages (level), technical skills, tools',
      mk?'Признанија: Награди, стипендии, сертификати, публикации':'Recognition: Awards, scholarships, certificates, publications',
    ],
  };
}
