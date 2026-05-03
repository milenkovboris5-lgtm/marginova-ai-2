// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/generate-application.js
// v2.5 — FIXED: sends profile.description to DeepSeek, larger output (16k tokens)
// ═══════════════════════════════════════════════════════════

const { setCors, deepseek, supabase, LANG_NAMES } = require('./_lib/utils');

console.log('[generate-application] v2.5 loaded — DeepSeek writer, profile.description included, larger output');

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
  const org         = profile.organization  || profile.name       || 'Our Organization';
  const sector      = profile.sector        || 'Technology / Innovation';
  const country     = profile.country       || 'North Macedonia';
  const budgetAmt   = program.amount        || program.award_amount || '€60,000';
  const donor       = program.donor         || program.organization_name || 'Funding Organization';
  const title       = program.title         || 'Funding Program';
  const description = profile.description   || '';

  // ─── NARRATIVE PROMPT ─────────────────────────────────────────────
  const narrativePrompt = `You are a senior EU grant writer. Write a professional, DETAILED grant application in ${langName}.

ALL string values must be in ${langName}.
Keep ALL JSON keys in ENGLISH (project_title, abstract, problem_analysis, etc.).

Organization: ${org}
Sector: ${sector}
Country: ${country}
Program: ${title}
Donor: ${donor}
Budget requested: ${budgetAmt}

PROJECT DESCRIPTION (use this to make the application SPECIFIC and CONCRETE):
${description || 'Not provided — focus on general sector challenges'}

Return ONLY valid JSON with ENGLISH keys:
{
  "project_title": "compelling project title in ${langName} (12-15 words, specific to the project description)",
  "abstract": "Executive summary in ${langName}, 400-500 words. Structure: (1) Hook sentence — state the core problem and its scale. (2) Who is affected and why current solutions fail. (3) What this project does — specific solution from the project description, concrete methodology. (4) Expected results: at least 3 measurable outcomes with numbers (beneficiaries, % improvement, units produced). (5) Budget and co-financing. (6) Closing sentence on long-term impact. Every sentence must be specific to the project description — NO generic phrases.",
  "problem_analysis": "In-depth root cause analysis in ${langName}, 400-500 words. Structure: (1) Macro context — cite at least 2 real statistics (Eurostat, World Bank, national agency) relevant to the sector in ${country}. (2) Micro level — who exactly is affected, how many people, what are the direct consequences. (3) Economic/social/environmental cost of inaction — use numbers. (4) Gap analysis — what interventions exist and why they are insufficient. (5) Why this project addresses the root cause, not symptoms. Base every claim on the project description. Do NOT write generic text.",
  "innovation": "Innovation and added value in ${langName}, 200-250 words. (1) What is novel about the approach compared to standard practice in the sector. (2) Specific technology, method, or partnership model introduced — reference the project description. (3) How it differs from what ${donor} has funded before (if known). (4) Transferability — can it be replicated in other regions or sectors?",
  "sustainability": "Sustainability plan in ${langName}, 250-300 words. Cover three dimensions: (1) Financial — revenue model after grant ends (fees, public funding, earned income), with realistic projections. (2) Institutional — which organizations will absorb the results, signed letters of intent or MOUs planned. (3) Impact — how results will continue to benefit the target group without project staff. Include at least 2 concrete post-project milestones with timeframes.",
  "team_capacity": "Team capacity in ${langName}, 200-250 words. (1) Organization's track record — years of operation, number of projects managed, total funding managed (use plausible estimates based on ${sector} in ${country}). (2) Key roles: Project Manager (qualifications, relevant experience), Technical Expert (domain expertise), Financial Manager (compliance experience), Field Coordinator (local knowledge). (3) Why this team is uniquely qualified for THIS project — link to the project description. Do NOT invent specific names.",
  "communication": "Communication and visibility plan in ${langName}, 150-200 words. (1) Target audiences: primary (beneficiaries, partners), secondary (policy makers, media, public). (2) Channels and tools: project website, social media strategy (platforms, posting frequency), press releases, events. (3) EU visibility requirements: logo placement, acknowledgment in publications, final public event. (4) Knowledge products: at least 1 policy brief, 1 good-practice guide, final conference proceedings."
}`;

  // ─── PLAN PROMPT ───────────────────────────────────────────────────
  const planPrompt = `EU grant writer. Create project plan in ${langName}. ALL JSON keys stay in English.

PROJECT DESCRIPTION:
${description || 'General innovation project'}

Sector: ${sector}, Country: ${country}, Budget: ${budgetAmt}, Duration: 18 months.

Return ONLY valid JSON (minified) with ENGLISH keys:
{
  "overall_objective": "1 sentence in ${langName} — the broad development goal this project contributes to (sector + country level)",
  "specific_objective": "1 SMART sentence in ${langName} — specific, measurable, achievable, relevant, time-bound. Must contain: target group size, measurable change, and timeframe (18 months)",
  "results": [
    {"number":1,"title":"Result title in ${langName}","description":"2-3 sentences describing the specific deliverable based on the project description","indicators":["Primary indicator: number + baseline + target","Secondary indicator: quality measure"],"verification":"how this will be verified (document, survey, certificate, report)"},
    {"number":2,"title":"...","description":"2-3 sentences...","indicators":["...","..."],"verification":"..."},
    {"number":3,"title":"...","description":"2-3 sentences...","indicators":["...","..."],"verification":"..."}
  ],
  "activities": [
    {"id":"A1.1","result":1,"title":"specific activity title in ${langName}","months":"1-3","responsible":"role"},
    {"id":"A1.2","result":1,"title":"...","months":"3-6","responsible":"..."},
    {"id":"A1.3","result":1,"title":"...","months":"5-8","responsible":"..."},
    {"id":"A2.1","result":2,"title":"...","months":"6-10","responsible":"..."},
    {"id":"A2.2","result":2,"title":"...","months":"8-13","responsible":"..."},
    {"id":"A2.3","result":2,"title":"...","months":"11-15","responsible":"..."},
    {"id":"A3.1","result":3,"title":"...","months":"13-16","responsible":"..."},
    {"id":"A3.2","result":3,"title":"...","months":"16-18","responsible":"..."},
    {"id":"A0.1","result":0,"title":"Project management & reporting","months":"1-18","responsible":"Project Manager"},
    {"id":"A0.2","result":0,"title":"Monitoring & evaluation","months":"1-18","responsible":"M&E Coordinator"}
  ],
  "risks": [
    {"risk":"risk specific to project in ${langName}","probability":"Low/Medium/High","impact":"Low/Medium/High","mitigation":"specific 1-2 sentence mitigation measure in ${langName}"},
    {"risk":"...","probability":"Medium","impact":"Medium","mitigation":"..."},
    {"risk":"...","probability":"Low","impact":"High","mitigation":"..."},
    {"risk":"...","probability":"Medium","impact":"Low","mitigation":"..."}
  ]
}`;

  // ─── BUDGET ─────────────────────────────────────────────────────────
  const budgetNum = (() => {
    const s = String(budgetAmt);
    let c = s.replace(/(\d)[,.](\d{3})(?=[,\.\d]|\b)/g, '$1$2');
    c = c.replace(/(\d)[,.](\d{3})(?=[,\.\d]|\b)/g, '$1$2');
    const nums = (c.match(/[0-9]+/g) || []).map(Number).filter(n => n > 999 && n <= 50000000);
    if (nums.length === 0) return 60000;
    return Math.max(...nums);
  })();

  const budgetPrompt = `Senior EU grant accountant. Create budget in ${langName}. ALL JSON keys in English.

PROJECT DESCRIPTION:
${description || 'General innovation project'}

Total budget target: ${budgetNum} EUR (${budgetAmt}).

Allocate using:
- Human Resources: 40%
- Equipment/Infrastructure: 22%
- Services: 11%
- Training: 9%
- Travel: 4%
- Communication: 2%
- Indirect costs (7% of direct): calculate automatically

Create 7-8 budget lines. Each line: unit_cost × quantity = total.
Return ONLY valid JSON:
{
  "budget_lines": [
    {"category":"Human Resources","item":"Project Coordinator","unit":"month","quantity":18,"unit_cost":NUMBER,"total":NUMBER,"grant_amount":NUMBER,"own_contribution":NUMBER},
    ...
  ],
  "notes": "budget justification in ${langName}"
}

RULES: All numbers are integers. No commas. No currency symbols. grant_amount + own_contribution = total. Make one line with small own_contribution (2-5%).`;

  console.log('[generate-application] calling DeepSeek 3x in parallel, budget target:', budgetNum);
  const [narrativeRaw, planRaw, budgetRaw] = await Promise.all([
    safeDeepSeek(narrativePrompt, lang, 16000),
    safeDeepSeek(planPrompt,      lang, 8000),
    safeDeepSeek(budgetPrompt,    lang, 8000),
  ]);

  const narrative = parseJSON(narrativeRaw, narrativeFallback(org, sector, country, description, lang));
  const plan      = parseJSON(planRaw,      planFallback(sector, country, description, lang));

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

// ─── HELPER: parse numbers from strings ─────────────────────────────
function parseLocaleNumber(val) {
  if (val === null || val === undefined) return 0;
  const s = String(val).trim();
  let clean = s.replace(/[€$£¥₹\s]/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d*)?$/.test(clean)) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else if (/,\d{3}/.test(clean)) {
    clean = clean.replace(/,(\d{3})/g, '$1');
  } else {
    clean = clean.replace(',', '.');
  }
  clean = clean.replace(/[^0-9.-]/g, '');
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : Math.round(n);
}

async function validateAndFixBudget(budget, budgetNum, lang, sector, country, donor, langName) {
  const lines = budget?.budget_lines;
  if (!lines || !Array.isArray(lines) || lines.length === 0) {
    console.warn('[budget] No budget_lines — using scaled fallback');
    return scaledBudgetFallback(budgetNum, lang);
  }
  const parsedTotal = lines.reduce((s, l) => s + parseLocaleNumber(l.total), 0);
  const tolerance   = budgetNum * 0.25;
  if (Math.abs(parsedTotal - budgetNum) <= tolerance) {
    console.log('[budget] Validation PASSED');
    return budget;
  }
  console.warn(`[budget] Validation FAILED (${parsedTotal} vs ${budgetNum}) — using scaled fallback`);
  return scaledBudgetFallback(budgetNum, lang);
}

function scaledBudgetFallback(budgetNum, lang) {
  const mk = lang === 'mk';
  const hr  = Math.round(budgetNum * 0.24);
  const hr2 = Math.round(budgetNum * 0.16);
  const eq  = Math.round(budgetNum * 0.22);
  const sv  = Math.round(budgetNum * 0.11);
  const tr  = Math.round(budgetNum * 0.09);
  const tv  = Math.round(budgetNum * 0.04);
  const cm  = Math.round(budgetNum * 0.02);
  const ic  = Math.round(budgetNum * 0.96 * 0.07);
  const hr2own   = Math.round(hr2 * 0.15);
  const hr2grant = hr2 - hr2own;

  return {
    budget_lines: [
      { category: mk?'Човечки ресурси':'Human Resources',   item: mk?'Проект координатор':'Project Coordinator',    unit:'month',       quantity:18, unit_cost:Math.round(hr/18),    total:hr,   grant_amount:hr,        own_contribution:0       },
      { category: mk?'Човечки ресурси':'Human Resources',   item: mk?'Технички експерт':'Technical Expert',          unit:'month',       quantity:12, unit_cost:Math.round(hr2/12),   total:hr2,  grant_amount:hr2grant,  own_contribution:hr2own  },
      { category: mk?'Опрема':'Equipment',                  item: mk?'Опрема за проектот':'Project equipment',       unit:'unit',        quantity:4,  unit_cost:Math.round(eq/4),     total:eq,   grant_amount:eq,        own_contribution:0       },
      { category: mk?'Услуги':'Services',                   item: mk?'Специјализирани услуги':'Specialist services', unit:'lump sum',    quantity:1,  unit_cost:sv,                   total:sv,   grant_amount:sv,        own_contribution:0       },
      { category: mk?'Обука':'Training',                    item: mk?'Обука и работилници':'Training & workshops',   unit:'participant', quantity:50, unit_cost:Math.round(tr/50),    total:tr,   grant_amount:tr,        own_contribution:0       },
      { category: mk?'Патување':'Travel',                   item: mk?'Теренски посети':'Field visits',               unit:'trip',        quantity:10, unit_cost:Math.round(tv/10),    total:tv,   grant_amount:tv,        own_contribution:0       },
      { category: mk?'Комуникација':'Communication',        item: mk?'Видливост и комуникација':'Visibility & comms',unit:'lump sum',    quantity:1,  unit_cost:cm,                   total:cm,   grant_amount:cm,        own_contribution:0       },
      { category: mk?'Индиректни трошоци':'Indirect costs', item: mk?'Индиректни трошоци (7%)':'Indirect costs (7%)',unit:'lump sum',    quantity:1,  unit_cost:ic,                   total:ic,   grant_amount:ic,        own_contribution:0       },
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
  "personal_statement": "Compelling motivation letter, 400-500 words, first person.",
  "academic_background": "Education history, research experience, publications. 120-150 words.",
  "professional_experience": "Relevant work, internships, volunteer work. 100-120 words.",
  "research_proposal": "Title + Abstract (60 words) + Methodology (80 words) + Expected outcomes (40 words). Total 200 words.",
  "return_plan": "Specific plan for applying knowledge after returning. 100-120 words.",
  "why_this_program": "Why THIS scholarship/program. 80-100 words.",
  "references_guidance": ["Guidance point 1", "Guidance point 2", "Guidance point 3"],
  "cv_structure": ["Education entry", "Experience entry", "Skills entry", "Publications/Awards entry"]
}`;

  const raw = await safeDeepSeek(prompt, lang, 6000);
  const content = parseJSON(raw, scholarshipFallback(name, sector, country, lang));
  return content;
}

function sanitizeGeminiJSON(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  return raw
    .replace(/\u201C|\u201D/g, "'")
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u00AB|\u00BB/g, "'");
}

async function safeDeepSeek(prompt, lang, maxTokens = 16000) {
  const system = [
    'You are a professional grant writer.',
    'OUTPUT RULES: Return ONLY a valid JSON object — nothing else.',
    'No markdown fences (no ```json), no explanation, no preamble.',
    'No trailing commas. No comments inside JSON.',
    'All string values must use double quotes on the OUTSIDE only.',
    'NO double quotes inside string values — use parentheses instead: (МСП) not "МСП".',
    'Do NOT translate JSON keys — only translate string values.',
    'ALL numeric fields must be plain integers — no commas, no dots.',
    'Write DETAILED, SPECIFIC content based on the project description.',
  ].join('\n');

  try {
    const result = await deepseek(system, prompt, { maxTokens, temperature: 0.35 });
    console.log(`[safeDeepSeek] maxTokens:${maxTokens} raw preview:`, (result || '').slice(0, 300));
    return result;
  } catch (e) {
    console.warn('[safeDeepSeek] deepseek call error:', e.message);
    return '{}';
  }
}

function parseJSON(raw, fallback) {
  if (!raw) return fallback;
  raw = sanitizeGeminiJSON(raw);
  let clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return fallback;
  let candidate = clean.slice(start, end + 1);
  try {
    return fallback ? { ...fallback, ...JSON.parse(candidate) } : JSON.parse(candidate);
  } catch (_) {
    try {
      let repaired = candidate
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"')
        .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
      const opens  = (repaired.match(/\[/g) || []).length;
      const closes = (repaired.match(/\]/g) || []).length;
      const openB  = (repaired.match(/\{/g) || []).length;
      const closeB = (repaired.match(/\}/g) || []).length;
      for (let i = 0; i < opens - closes; i++) repaired += ']';
      for (let i = 0; i < openB - closeB; i++) repaired += '}';
      const parsed = JSON.parse(repaired);
      return fallback ? { ...fallback, ...parsed } : parsed;
    } catch (e2) {
      return fallback;
    }
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

function narrativeFallback(org, sector, country, description, lang) {
  const mk = lang === 'mk';
  const hasDesc = description && description.length > 10;
  return {
    project_title:    hasDesc ? (mk ? `${description.slice(0, 60)} во ${country}` : `${description.slice(0, 60)} in ${country}`) : (mk ? `Дигитална иницијатива за ${country}` : `Digital Initiative for ${country}`),
    abstract:         hasDesc ? description.slice(0, 400) : (mk ? `Проектот ќе изгради капацитети во секторот ${sector} во ${country}, со директна корист за 150 корисници.` : `This project will build capacity in the ${sector} sector in ${country}, directly benefiting 150 people.`),
    problem_analysis: mk ? `Недостатокот на иновативни решенија во ${country} е клучна пречка за развој.` : `The lack of innovative solutions in ${country} is a key barrier to development.`,
    innovation:       mk ? 'Иновативен пристап кој комбинира најнови технологии.' : 'Innovative approach combining cutting-edge technologies.',
    sustainability:   mk ? 'По завршувањето, активностите ќе продолжат преку одржлив бизнис модел.' : 'After completion, activities will continue through a sustainable business model.',
    team_capacity:    mk ? `Организацијата ${org} има докажано искуство во секторот ${sector}.` : `${org} has proven experience in the ${sector} sector.`,
    communication:    mk ? 'Резултатите ќе бидат споделени преку веб-сајт, социјални мрежи и јавни настани.' : 'Results will be shared via website, social media, and public events.',
  };
}

function planFallback(sector, country, description, lang) {
  const mk = lang === 'mk';
  const hasDesc = description && description.length > 10;
  return {
    overall_objective:  mk ? `Унапредување на иновациите во ${sector} секторот во ${country}` : `Advancing innovation in the ${sector} sector in ${country}`,
    specific_objective: mk ? (hasDesc ? `${description.slice(0, 100)} до крајот на проектот` : `Зголемен пристап до иновативни решенија за 150 корисници`) : (hasDesc ? `${description.slice(0, 100)} by project end` : `Improved access to innovative solutions for 150 beneficiaries`),
    results: [
      { number: 1, title: mk ? 'Развиено иновативно решение' : 'Innovative solution developed', description: '', indicators: ['1 prototype/platform developed', '5 staff trained'], verification: mk ? 'Технички извештај' : 'Technical report' },
      { number: 2, title: mk ? '150 корисници вклучени' : '150 beneficiaries engaged', description: '', indicators: ['150 certificates issued', '80% satisfaction rate'], verification: mk ? 'Анкети и сертификати' : 'Surveys and certificates' },
      { number: 3, title: mk ? 'Одржливост обезбедена' : 'Sustainability ensured', description: '', indicators: ['Partnership agreement signed', 'Revenue model defined'], verification: mk ? 'Договори за партнерство' : 'Partnership agreements' },
    ],
    activities: [
      { id: 'A1.1', result: 1, title: mk ? 'Анализа и дизајн'            : 'Analysis & design',           months: '1-4',   responsible: mk ? 'Технички тим'   : 'Technical team' },
      { id: 'A1.2', result: 1, title: mk ? 'Развој и тестирање'          : 'Development & testing',       months: '5-10',  responsible: mk ? 'Технички тим'   : 'Technical team' },
      { id: 'A2.1', result: 2, title: mk ? 'Регрутација на корисници'    : 'Beneficiary recruitment',     months: '6-8',   responsible: mk ? 'Координатор'    : 'Coordinator' },
      { id: 'A2.2', result: 2, title: mk ? 'Спроведување на активности'  : 'Activity implementation',     months: '9-15',  responsible: mk ? 'Тим'            : 'Team' },
      { id: 'A3.1', result: 3, title: mk ? 'Партнерства'                 : 'Partnerships',                months: '12-16', responsible: mk ? 'Директор'       : 'Director' },
      { id: 'A3.2', result: 3, title: mk ? 'Финален извештај'            : 'Final report',                months: '17-18', responsible: mk ? 'Тим'            : 'Team' },
      { id: 'A0.1', result: 0, title: mk ? 'Управување со проект'        : 'Project management',          months: '1-18',  responsible: mk ? 'Проект менаџер' : 'Project Manager' },
    ],
    risks: [
      { risk: mk ? 'Низок интерес на целната група' : 'Low target group interest', probability: 'Low',    impact: 'High',   mitigation: mk ? 'Рана комуникација и пилот' : 'Early communication and pilot' },
      { risk: mk ? 'Доцнење на набавките'           : 'Procurement delays',        probability: 'Medium', impact: 'Medium', mitigation: mk ? 'Резервни добавувачи'     : 'Backup suppliers' },
      { risk: mk ? 'Технички предизвици'            : 'Technical challenges',      probability: 'Low',    impact: 'Medium', mitigation: mk ? 'Агилен развој'           : 'Agile development' },
    ],
  };
}

function scholarshipFallback(name, sector, country, lang) {
  const mk = lang === 'mk';
  return {
    personal_statement:      mk ? `Растев во ${country} сведочејќи на предизвиците во ${sector}.` : `Growing up in ${country}, I witnessed the challenges in ${sector}.`,
    academic_background:     mk ? 'Дипломиран со одличен успех.' : 'Graduated with distinction.',
    professional_experience: mk ? 'Работев на проекти поврзани со секторот.' : 'Worked on sector-related projects.',
    research_proposal:       mk ? `Наслов: Иновации во ${sector}` : `Title: Innovations in ${sector}`,
    return_plan:             mk ? `По враќањето во ${country}, ќе работам со националните институции.` : `After returning to ${country}, I will work with national institutions.`,
    why_this_program:        mk ? 'Овој програм е идеален поради неговата репутација.' : 'This program is ideal due to its reputation.',
    references_guidance:     [mk?'Нагласете ги лидерските квалитети':'Emphasize leadership qualities', mk?'Споменете конкретни постигнувања':'Mention specific achievements', mk?'Опишете го потенцијалот за влијание':'Describe impact potential'],
    cv_structure:            [mk?'Образование: Универзитет, степен, година':'Education: University, degree, year', mk?'Искуство: Позиција, организација':'Experience: Position, organization', mk?'Вештини: Јазици, технички вештини':'Skills: Languages, technical skills', mk?'Признанија: Награди, сертификати':'Recognition: Awards, certificates'],
  };
}
