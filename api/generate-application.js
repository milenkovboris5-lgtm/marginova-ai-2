// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/generate-application.js
// v2.3 — CHANGES over v2.2:
//   Budget scaling: Gemini calculates amounts to match actual program budget
//   narrative: 8000 (long prose)
//   plan:      4000 (compact JSON)
//   Budget tokens: 2000 → 3000 (space for calculations)
//   scholarship: 6000
//   Promise.all wall time = ~25s → well within 60s Vercel limit
// ═══════════════════════════════════════════════════════════

const { setCors, gemini, supabase } = require('./_lib/utils');

console.log('[generate-application] v2.2 loaded — differentiated token limits, parallel calls ~25s');

const LANG_NAMES = {
  mk:'македонски (Macedonian)', en:'English', sr:'српски (Serbian)',
  hr:'hrvatski (Croatian)',     bg:'български (Bulgarian)', ro:'română (Romanian)',
  de:'Deutsch (German)',        fr:'français (French)',     es:'español (Spanish)',
  it:'italiano (Italian)',      pl:'polski (Polish)',       tr:'Türkçe (Turkish)',
  nl:'Nederlands (Dutch)',      pt:'português (Portuguese)',ru:'русский (Russian)',
  ar:'العربية (Arabic)',        zh:'中文 (Chinese)',        ja:'日本語 (Japanese)',
  ko:'한국어 (Korean)',          uk:'українська (Ukrainian)',
};

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (token && supabase) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error) console.warn('[auth] token invalid:', error.message);
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
    let content;
    if (type === 'scholarship') {
      content = await generateScholarship(profile, selectedProgram, language, langName);
    } else {
      content = await generateGrant(profile, selectedProgram, language, langName);
    }

    return res.status(200).json({
      success:  true,
      type,
      language,
      profile,
      program:  selectedProgram,
      content,
      generated_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[generate-application] error:', err.message);
    return res.status(500).json({ error: 'Generation failed', detail: err.message });
  }
};

async function generateGrant(profile, program, lang, langName) {
  const org       = profile.organization  || profile.name       || 'Our Organization';
  const sector    = profile.sector        || 'Education / IT';
  const country   = profile.country       || 'North Macedonia';
  const budgetAmt = program.amount        || program.award_amount || '€60,000';
  const donor     = program.donor         || program.organization_name || 'Funding Organization';
  const title     = program.title         || 'Funding Program';

  const narrativePrompt = `You are a senior EU grant writer. Write a professional grant application in ${langName}.
ALL string values must be in ${langName}.

CRITICAL JSON KEY RULE — NON-NEGOTIABLE:
Keep ALL JSON keys EXACTLY in English as shown. NEVER translate keys.
Wrong: "наслов_на_проект", "резиме" — FORBIDDEN
Right: "project_title", "abstract" — always use these exact English keys.

Organization: ${org}
Sector: ${sector}
Country: ${country}
Program: ${title}
Donor: ${donor}
Budget requested: ${budgetAmt}

Return ONLY valid JSON with ENGLISH keys and ${langName} string values:
{
  "project_title": "compelling project title in ${langName} (max 12 words)",
  "abstract": "Executive summary in ${langName}, 180-220 words. Problem + solution + target group + expected impact + budget. First sentence must hook the reader.",
  "problem_analysis": "Root cause analysis in ${langName} with statistics (cite sources like Eurostat, World Bank, national statistics). 200-250 words. Include: scale of problem, who is affected, why existing solutions fail.",
  "innovation": "What makes this project different from existing approaches. 80-100 words in ${langName}.",
  "sustainability": "Financial sustainability (revenue model or follow-up funding), institutional sustainability, impact sustainability. 120-150 words in ${langName}.",
  "team_capacity": "Organization track record, key team members roles, relevant previous projects. 100-120 words in ${langName}.",
  "communication": "How results will be disseminated: reports, social media, policy briefs, events. 60-80 words in ${langName}."
}`;

  const planPrompt = `EU grant writer. String values in ${langName}. ALL JSON keys stay in English.

CRITICAL JSON KEY RULE: NEVER translate JSON keys.
Keep: "overall_objective", "specific_objective", "results", "number", "title",
"description", "indicators", "verification", "activities", "id", "result",
"months", "responsible", "risks", "risk", "probability", "impact", "mitigation"
These key names must NEVER be translated — only their string values.

Project: ${sector} in ${country}. Budget: ${budgetAmt}. Duration: 18 months.
Donor: ${donor}. Program: ${title}.

Return ONLY minified valid JSON with English keys and ${langName} values:
{"overall_objective":"1 sentence in ${langName}","specific_objective":"1 SMART sentence in ${langName}","results":[{"number":1,"title":"title in ${langName}","description":"brief in ${langName}","indicators":["indicator with target in ${langName}"],"verification":"how in ${langName}"},{"number":2,"title":"title","description":"brief","indicators":["indicator"],"verification":"how"},{"number":3,"title":"title","description":"brief","indicators":["indicator"],"verification":"how"}],"activities":[{"id":"A1.1","result":1,"title":"title in ${langName}","months":"1-2","responsible":"role in ${langName}"},{"id":"A1.2","result":1,"title":"title","months":"3-5","responsible":"role"},{"id":"A2.1","result":2,"title":"title","months":"4-9","responsible":"role"},{"id":"A2.2","result":2,"title":"title","months":"7-14","responsible":"role"},{"id":"A3.1","result":3,"title":"title","months":"12-16","responsible":"role"},{"id":"A3.2","result":3,"title":"title","months":"16-18","responsible":"role"},{"id":"A0.1","result":0,"title":"Project management in ${langName}","months":"1-18","responsible":"Project Manager in ${langName}"}],"risks":[{"risk":"risk in ${langName}","probability":"Low","impact":"High","mitigation":"measure in ${langName}"},{"risk":"risk","probability":"Medium","impact":"Medium","mitigation":"measure"},{"risk":"risk","probability":"Low","impact":"Medium","mitigation":"measure"}]}`;

  const budgetNum = (() => {
    const s = String(budgetAmt).replace(/[^0-9]/g, '');
    const n = parseInt(s, 10);
    return isNaN(n) ? 60000 : n;
  })();

  const budgetPrompt = `You are a senior EU grant accountant.
Language for string VALUES only: ${langName}.

CRITICAL: ALL JSON keys stay in English exactly as shown. NEVER translate keys.

BUDGET MATH RULE — NON-NEGOTIABLE:
Total budget = ${budgetNum} EUR (${budgetAmt}).
Allocate using these percentages:
- Human Resources: ${Math.round(budgetNum * 0.40)} EUR (40%)
- Equipment: ${Math.round(budgetNum * 0.22)} EUR (22%)
- Services: ${Math.round(budgetNum * 0.11)} EUR (11%)
- Training: ${Math.round(budgetNum * 0.09)} EUR (9%)
- Travel: ${Math.round(budgetNum * 0.04)} EUR (4%)
- Communication: ${Math.round(budgetNum * 0.02)} EUR (2%)
- Indirect costs (7% of direct costs): ${Math.round(budgetNum * 0.96 * 0.07)} EUR

Context: ${sector} project in ${country}. 18 months. Donor: ${donor}.

Return ONLY valid JSON — no markdown fences, no explanation, no preamble:
{
  "budget_lines": [
    {
      "category": "Human Resources",
      "item": "describe the role in ${langName}",
      "unit": "month",
      "quantity": NUMBER,
      "unit_cost": NUMBER,
      "total": NUMBER,
      "grant_amount": NUMBER,
      "own_contribution": NUMBER
    }
  ],
  "notes": "brief budget justification note in ${langName}"
}

STRICT RULES:
1. ALL numeric fields must be plain integers — NO commas, NO dots as thousands separators, NO currency symbols, NO quotes around numbers
2. Create exactly 7-8 budget lines covering the categories above
3. Each line: unit_cost × quantity MUST equal total exactly
4. Sum of ALL total fields MUST equal approximately ${budgetNum} EUR (within 5%)
5. grant_amount + own_contribution = total for each line
6. own_contribution is 0 for most lines; one line can have small co-financing`;

  console.log('[generate-application] calling Gemini 3x in parallel, budget target:', budgetAmt, budgetNum);
  const [narrativeRaw, planRaw, budgetRaw] = await Promise.all([
    safeGemini(narrativePrompt, lang, 8000),
    safeGemini(planPrompt,      lang, 4000),
    safeGemini(budgetPrompt,    lang, 4000),
  ]);

  const narrative = parseJSON(narrativeRaw, narrativeFallback(org, sector, country, lang));
  const plan      = parseJSON(planRaw,      planFallback(sector, country, lang));

  // Budget: parse then VALIDATE totals
  let budget = parseJSON(budgetRaw, null);
  budget = await validateAndFixBudget(budget, budgetNum, lang, sector, country, donor, langName);

  const lfm   = buildLFM(narrative, plan, lang);
  const gantt = buildGantt(plan.activities || []);

  const budgetLines    = budget.budget_lines || [];
  const totalGrant     = budgetLines.reduce((s, l) => s + parseLocaleNumber(l.grant_amount), 0);
  const totalOwn       = budgetLines.reduce((s, l) => s + parseLocaleNumber(l.own_contribution), 0);
  const totalBudget    = totalGrant + totalOwn;
  const coFinPct       = totalBudget > 0 ? Math.round((totalOwn / totalBudget) * 100) : 0;
  const perBeneficiary = Math.round(totalBudget / 150);

  return {
    project_title:    narrative.project_title    || `${sector} Project in ${country}`,
    abstract:         narrative.abstract         || '',
    problem_analysis: narrative.problem_analysis || '',
    innovation:       narrative.innovation       || '',
    sustainability:   narrative.sustainability   || '',
    team_capacity:    narrative.team_capacity    || '',
    communication:    narrative.communication    || '',
    overall_objective:  plan.overall_objective   || '',
    specific_objective: plan.specific_objective  || '',
    results:            plan.results             || [],
    activities:         plan.activities          || [],
    risks:              plan.risks               || [],
    budget_lines:  budgetLines,
    budget_totals: { totalGrant, totalOwn, totalBudget, coFinPct, perBeneficiary },
    budget_notes:  budget.notes || '',
    lfm,
    gantt,
  };
}

// ═══ LOCALE-SAFE NUMBER PARSER ═══════════════════════════════
// Handles: 19800, "19800", "19,800", "19.800", "€19,800", "19 800"
function parseLocaleNumber(val) {
  if (val === null || val === undefined) return 0;
  const s = String(val).trim();
  // Remove currency symbols and spaces
  let clean = s.replace(/[€$£¥₹\s]/g, '');
  // European format: dots as thousands, optional comma decimal → 1.234,56 or 19.800
  if (/^\d{1,3}(\.\d{3})+(,\d*)?$/.test(clean)) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else if (/,\d{3}/.test(clean)) {
    // US format: comma thousands separators → 1,234 or 1,234.56
    clean = clean.replace(/,(\d{3})/g, '$1');
  } else {
    // Plain decimal comma → replace with dot
    clean = clean.replace(',', '.');
  }
  // Remove any remaining non-numeric except decimal point and minus
  clean = clean.replace(/[^0-9.-]/g, '');
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : Math.round(n);
}

// ═══ BUDGET VALIDATION + FALLBACK REPAIR ════════════════════
async function validateAndFixBudget(budget, budgetNum, lang, sector, country, donor, langName) {
  const lines = budget?.budget_lines;

  if (!lines || !Array.isArray(lines) || lines.length === 0) {
    console.warn('[budget] No budget_lines — using scaled fallback');
    return scaledBudgetFallback(budgetNum, lang);
  }

  const parsedTotal = lines.reduce((s, l) => s + parseLocaleNumber(l.total), 0);
  const tolerance   = budgetNum * 0.25; // 25% tolerance

  console.log(`[budget] Parsed total: ${parsedTotal}, expected: ${budgetNum}, diff: ${Math.abs(parsedTotal - budgetNum)}`);

  if (Math.abs(parsedTotal - budgetNum) <= tolerance) {
    console.log('[budget] Validation PASSED');
    return budget;
  }

  console.warn(`[budget] Validation FAILED (${parsedTotal} vs ${budgetNum}) — using scaled fallback`);
  // Use deterministic scaled fallback instead of retry (faster, more reliable)
  return scaledBudgetFallback(budgetNum, lang);
}

// ═══ DETERMINISTIC SCALED BUDGET FALLBACK ═══════════════════
// Replaces the old hardcoded budgetFallback — always correct for any budgetNum
function scaledBudgetFallback(budgetNum, lang) {
  const mk = lang === 'mk';
  const hr  = Math.round(budgetNum * 0.24); // HR coordinator
  const hr2 = Math.round(budgetNum * 0.16); // HR expert
  const eq  = Math.round(budgetNum * 0.22); // Equipment
  const sv  = Math.round(budgetNum * 0.11); // Services
  const tr  = Math.round(budgetNum * 0.09); // Training
  const tv  = Math.round(budgetNum * 0.04); // Travel
  const cm  = Math.round(budgetNum * 0.02); // Communication
  const ic  = Math.round(budgetNum * 0.96 * 0.07); // Indirect 7%

  // co-financing on expert line only (~2%)
  const hr2own  = Math.round(hr2 * 0.15);
  const hr2grant = hr2 - hr2own;

  return {
    budget_lines: [
      { category: mk?'Човечки ресурси':'Human Resources',   item: mk?'Проект координатор':'Project Coordinator', unit:'month',    quantity:18, unit_cost:Math.round(hr/18),    total:hr,   grant_amount:hr,        own_contribution:0       },
      { category: mk?'Човечки ресурси':'Human Resources',   item: mk?'Технички експерт':'Technical Expert',       unit:'month',    quantity:12, unit_cost:Math.round(hr2/12),   total:hr2,  grant_amount:hr2grant,  own_contribution:hr2own  },
      { category: mk?'Опрема':'Equipment',                  item: mk?'Опрема за проектот':'Project equipment',    unit:'unit',     quantity:4,  unit_cost:Math.round(eq/4),     total:eq,   grant_amount:eq,        own_contribution:0       },
      { category: mk?'Услуги':'Services',                   item: mk?'Специјализирани услуги':'Specialist services', unit:'lump sum', quantity:1, unit_cost:sv,               total:sv,   grant_amount:sv,        own_contribution:0       },
      { category: mk?'Обука':'Training',                    item: mk?'Обука и работилници':'Training & workshops', unit:'participant', quantity:50, unit_cost:Math.round(tr/50), total:tr, grant_amount:tr,        own_contribution:0       },
      { category: mk?'Патување':'Travel',                   item: mk?'Теренски посети':'Field visits',             unit:'trip',     quantity:10, unit_cost:Math.round(tv/10),    total:tv,   grant_amount:tv,        own_contribution:0       },
      { category: mk?'Комуникација':'Communication',        item: mk?'Видливост и комуникација':'Visibility & comms', unit:'lump sum', quantity:1, unit_cost:cm,               total:cm,   grant_amount:cm,        own_contribution:0       },
      { category: mk?'Индиректни трошоци':'Indirect costs', item: mk?'Индиректни трошоци (7%)':'Indirect costs (7%)', unit:'lump sum', quantity:1, unit_cost:ic,             total:ic,   grant_amount:ic,        own_contribution:0       },
    ],
    notes: mk
      ? `Буџетот е пресметан врз основа на стандардна EU распределба. Вкупен грант: €${(hr+hr2grant+eq+sv+tr+tv+cm+ic).toLocaleString()}. Ко-финансирање: €${hr2own.toLocaleString()} (${Math.round(hr2own/(budgetNum)*100)}%).`
      : `Budget calculated using standard EU allocation ratios. Total grant: €${(hr+hr2grant+eq+sv+tr+tv+cm+ic).toLocaleString()}. Co-financing: €${hr2own.toLocaleString()} (${Math.round(hr2own/(budgetNum)*100)}%).`,
  };
}

async function generateScholarship(profile, program, lang, langName) {
  const name    = profile.name    || profile.email?.split('@')[0] || 'Applicant';
  const sector  = profile.sector  || 'Research';
  const country = profile.country || 'North Macedonia';
  const title   = program.title   || 'Scholarship Program';

  const prompt = `You are an expert scholarship application advisor. Write in ${langName}.
ALL text must be in ${langName}.

Applicant: ${name}
Field: ${sector}
Home country: ${country}
Scholarship: ${title}

Return ONLY valid JSON:
{
  "personal_statement": "Compelling motivation letter, 400-500 words, first person. Structure: 1) Hook opening about your journey 2) Academic/professional background 3) Specific goals for this scholarship 4) How you will use knowledge back home 5) Strong closing. Must be personal and specific, not generic.",
  "academic_background": "Education history, research experience, publications if any, GPA context. 120-150 words.",
  "professional_experience": "Relevant work, internships, volunteer work. Concrete achievements with numbers. 100-120 words.",
  "research_proposal": "Title + Abstract (60 words) + Methodology (80 words) + Expected outcomes (40 words). Total 200 words.",
  "return_plan": "Specific plan for applying knowledge after returning: institution to join, project to launch, people to impact. Numbers and timeline. 100-120 words.",
  "why_this_program": "Specific reasons why THIS scholarship/program is the right fit. Reference program specific features. 80-100 words.",
  "references_guidance": "What to ask from reference letter writers (3 bullet points)",
  "cv_structure": ["Education entry", "Experience entry", "Skills entry", "Publications/Awards entry"]
}`;

  const raw     = await safeGemini(prompt, lang, 6000);
  const content = parseJSON(raw, scholarshipFallback(name, sector, country, lang));
  return content;
}

// ═══ GEMINI OUTPUT SANITIZER ════════════════════════════════
// Runs BEFORE parseJSON — fixes curly/smart quotes Gemini sometimes outputs
function sanitizeGeminiJSON(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  // Fix curly/smart quotes — these are always wrong in JSON (100% reliable)
  // Straight unescaped quotes inside strings are fundamentally ambiguous —
  // we rely on temp=0.0 + prompt rule to prevent them at source
  return raw
    .replace(/\u201C|\u201D/g, "'")
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u00AB|\u00BB/g, "'");
}

async function safeGemini(prompt, lang, maxTokens = 8000) {
  const system = [
    'You are a professional grant writer.',
    'OUTPUT RULES (non-negotiable):',
    '1. Return ONLY a valid JSON object — nothing else.',
    '2. No markdown fences (no ```json), no explanation, no preamble.',
    '3. No trailing commas. No comments inside JSON.',
    '4. All string values must use double quotes on the OUTSIDE only.',
    '5. CRITICAL: NEVER place double quote characters (" ") inside string values.',
    '   They break JSON parsing. Use single quotes or remove them instead.',
    '   WRONG: {"text": "The \"ERP\" system"}   RIGHT: {"text": "The ERP system"}',
    '6. Do NOT translate JSON keys — only translate string values.',
    '7. ALL numeric fields must be plain integers — no commas, no dots as thousands, no currency symbols.',
    '8. If a value would be very long, shorten it to fit valid JSON.',
  ].join('\n');

  try {
    const result = await gemini(system, [{ role: 'user', parts: [{ text: prompt }] }], {
      maxTokens,
      temperature: 0.0,  // 0.0 reduces hallucination and quote violations
    });
    console.log(`[safeGemini] maxTokens:${maxTokens} raw preview:`, (result || '').slice(0, 300));
    return result;
  } catch (e) {
    console.warn('[safeGemini] gemini call error:', e.message);
    return '{}';
  }
}

function parseJSON(raw, fallback) {
  if (!raw) return fallback;

  // Run sanitizer first — fixes curly quotes and other Gemini artifacts
  raw = sanitizeGeminiJSON(raw);

  let clean = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    console.warn('[parseJSON] no JSON object found, using fallback');
    return fallback;
  }
  let candidate = clean.slice(start, end + 1);

  try {
    return fallback ? { ...fallback, ...JSON.parse(candidate) } : JSON.parse(candidate);
  } catch (_) {}

  try {
    let repaired = candidate
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"')
      .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"[^"]*$/, '"[truncated]"')
      .replace(/[\x00-\x1F\x7F]/g, ' ');

    const opens  = (repaired.match(/\[/g) || []).length;
    const closes = (repaired.match(/\]/g) || []).length;
    const openB  = (repaired.match(/\{/g) || []).length;
    const closeB = (repaired.match(/\}/g) || []).length;
    for (let i = 0; i < opens  - closes; i++) repaired += ']';
    for (let i = 0; i < openB  - closeB; i++) repaired += '}';

    const parsed = JSON.parse(repaired);
    console.log('[parseJSON] repaired successfully');
    return fallback ? { ...fallback, ...parsed } : parsed;
  } catch (e2) {
    console.warn('[parseJSON] all repair attempts failed:', e2.message.slice(0, 80));
    return fallback;
  }
}

function buildLFM(narrative, plan, lang) {
  const isMk = lang === 'mk';
  return {
    goal: {
      description: plan.overall_objective  || (isMk ? 'Придонес кон регионалниот развој' : 'Contribute to regional development'),
      ovi:         isMk ? 'Регионален индекс на развој' : 'Regional development index',
      mov:         isMk ? 'Национална статистика'       : 'National statistics',
      assumptions: isMk ? 'Политичка стабилност во регионот' : 'Political stability in the region',
    },
    purpose: {
      description: plan.specific_objective || (isMk ? 'Подобрување на условите за целната група' : 'Improved conditions for target group'),
      ovi:         isMk ? 'Број на корисници со подобрени услови' : 'Number of beneficiaries with improved conditions',
      mov:         isMk ? 'Анкета пред/после проектот'            : 'Pre/post project survey',
      assumptions: isMk ? 'Целната група ќе учествува активно'    : 'Target group actively participates',
    },
    results: (plan.results || []).map(r => ({
      number:      r.number,
      description: r.title,
      ovi:         (r.indicators || []).join('; ') || (isMk ? 'Индикатор за верификација' : 'Verification indicator'),
      mov:         r.verification || (isMk ? 'Финален извештај' : 'Final report'),
      assumptions: isMk ? 'Партнерите соработуваат' : 'Partners cooperate as planned',
    })),
    activities: (plan.activities || []).map(a => ({
      id:          a.id,
      description: a.title,
      inputs:      isMk ? `Буџет, тим, опрема (Месеци ${a.months})` : `Budget, team, equipment (Months ${a.months})`,
      assumptions: isMk ? 'Достапност на ресурси' : 'Resources available as planned',
    })),
  };
}

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

function narrativeFallback(org, sector, country, lang) {
  const mk = lang === 'mk';
  return {
    project_title:    mk ? `Дигитална иновација за ${country}` : `Digital Innovation for ${country}`,
    abstract:         mk ? `Проектот ќе изгради капацитети во секторот ${sector} во ${country}, со директна корист за 150 корисници.` : `This project will build capacity in the ${sector} sector in ${country}, directly benefiting 150 people.`,
    problem_analysis: mk ? `Недостатокот на дигитални вештини во ${country} е клучна пречка за економски развој.` : `The lack of digital skills in ${country} is a key barrier to economic development.`,
    innovation:       mk ? 'Иновативен пристап кој комбинира онлајн и офлајн обука.' : 'Innovative blended learning approach combining online and offline training.',
    sustainability:   mk ? 'По завршувањето на проектот, платформата ќе продолжи со работа преку членарини.' : 'After the project, the platform will continue through membership fees.',
    team_capacity:    mk ? `Организацијата ${org} има докажано искуство во секторот.` : `${org} has proven experience in the sector.`,
    communication:    mk ? 'Резултатите ќе бидат споделени преку веб-сајт, социјални мрежи и јавни настани.' : 'Results will be shared via website, social media, and public events.',
  };
}

function planFallback(sector, country, lang) {
  const mk = lang === 'mk';
  return {
    overall_objective:  mk ? `Придонес кон одржливиот развој на ${sector} секторот во ${country}` : `Contribute to sustainable development of the ${sector} sector in ${country}`,
    specific_objective: mk ? 'Зголемен пристап до квалитетни услуги за 150 корисници до крајот на проектот' : '150 beneficiaries have improved access to quality services by end of project',
    results: [
      { number: 1, title: mk ? 'Зајакнат институционален капацитет' : 'Strengthened institutional capacity', description: '', indicators: ['1 platform developed', '5 staff trained'], verification: mk ? 'Договори и извештаи' : 'Contracts and reports' },
      { number: 2, title: mk ? '150 корисници обучени' : '150 beneficiaries trained', description: '', indicators: ['150 certificates issued', '80% satisfaction rate'], verification: mk ? 'Сертификати и анкети' : 'Certificates and surveys' },
      { number: 3, title: mk ? 'Одржливост обезбедена' : 'Sustainability ensured', description: '', indicators: ['Partnership agreement signed', 'Revenue model operational'], verification: mk ? 'Договори за партнерство' : 'Partnership agreements' },
    ],
    activities: [
      { id: 'A1.1', result: 1, title: mk ? 'Развој на платформа'     : 'Platform development',    months: '1-5',   responsible: mk ? 'Технички тим'   : 'Technical team' },
      { id: 'A1.2', result: 1, title: mk ? 'Обука на персонал'       : 'Staff training',          months: '2-3',   responsible: mk ? 'Координатор'    : 'Coordinator' },
      { id: 'A2.1', result: 2, title: mk ? 'Регрутација'             : 'Participant recruitment', months: '3-4',   responsible: mk ? 'Координатор'    : 'Coordinator' },
      { id: 'A2.2', result: 2, title: mk ? 'Спроведување на обуки'   : 'Training delivery',      months: '5-14',  responsible: mk ? 'Тренери'        : 'Trainers' },
      { id: 'A3.1', result: 3, title: mk ? 'Партнерски договори'     : 'Partnership agreements', months: '12-15', responsible: mk ? 'Директор'       : 'Director' },
      { id: 'A3.2', result: 3, title: mk ? 'Финален извештај'        : 'Final report',           months: '17-18', responsible: mk ? 'Тим'            : 'Team' },
      { id: 'A0.1', result: 0, title: mk ? 'Управување со проект'    : 'Project management',     months: '1-18',  responsible: mk ? 'Проект менаџер' : 'Project Manager' },
    ],
    risks: [
      { risk: mk ? 'Низок интерес на корисниците' : 'Low beneficiary interest', probability: 'Low',    impact: 'High',   mitigation: mk ? 'Рана комуникација' : 'Early communication' },
      { risk: mk ? 'Доцнење на плаќања'           : 'Payment delays',           probability: 'Medium', impact: 'Medium', mitigation: mk ? 'Резервен фонд'     : 'Reserve fund' },
      { risk: mk ? 'Технички проблеми'            : 'Technical issues',         probability: 'Low',    impact: 'Medium', mitigation: mk ? 'Тестирање'         : 'Pre-launch testing' },
    ],
  };
}

function scholarshipFallback(name, sector, country, lang) {
  const mk = lang === 'mk';
  return {
    personal_statement:      mk ? `Растев во ${country} гледајќи ги предизвиците во секторот ${sector}.` : `Growing up in ${country}, I witnessed firsthand the challenges in the ${sector} sector.`,
    academic_background:     mk ? 'Дипломиран со одличен успех.' : 'Graduated with distinction.',
    professional_experience: mk ? 'Работев на проекти поврзани со секторот.' : 'Worked on sector-related projects.',
    research_proposal:       mk ? 'Наслов: Иновации во секторот.' : 'Title: Innovations in the sector.',
    return_plan:             mk ? 'По враќањето, ќе работам со националните институции.' : 'After returning, I will work with national institutions.',
    why_this_program:        mk ? 'Овој програм е идеален поради репутацијата.' : 'This program is ideal due to its reputation.',
    references_guidance:     [mk?'Нагласете ги лидерските квалитети':'Emphasize leadership qualities', mk?'Споменете конкретни постигнувања':'Mention specific achievements', mk?'Опишете го потенцијалот':'Describe impact potential'],
    cv_structure:            [mk?'Образование: Универзитет, степен, година':'Education: University, degree, year', mk?'Искуство: Позиција, организација':'Experience: Position, org', mk?'Вештини: Јазици':'Skills: Languages', mk?'Признанија':'Recognition: Awards'],
  };
}
