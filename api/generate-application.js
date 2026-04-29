// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/generate-application.js
// v2.2 — CHANGES vs v2.1:
//   safeGemini() now takes maxTokens as parameter (default 8000)
//   narrative: 8000 (long prose)
//   plan:      4000 (compact JSON)
//   budget:    2000 (tabular JSON)
//   scholarship: 6000
//   Promise.all wall time = ~25s → well within 60s Vercel limit
// ═══════════════════════════════════════════════════════════

const { setCors, gemini, supabase } = require('./_lib/utils');

console.log('[generate-application] v2.2 loaded — differentiated token limits, parallel calls ~25s');

// ─── LANGUAGE MAP ────────────────────────────────────────────
const LANG_NAMES = {
  mk:'македонски (Macedonian)', en:'English', sr:'српски (Serbian)',
  hr:'hrvatski (Croatian)',     bg:'български (Bulgarian)', ro:'română (Romanian)',
  de:'Deutsch (German)',        fr:'français (French)',     es:'español (Spanish)',
  it:'italiano (Italian)',      pl:'polski (Polish)',       tr:'Türkçe (Turkish)',
  nl:'Nederlands (Dutch)',      pt:'português (Portuguese)',ru:'русский (Russian)',
  ar:'العربية (Arabic)',        zh:'中文 (Chinese)',        ja:'日本語 (Japanese)',
  ko:'한국어 (Korean)',          uk:'українська (Ukrainian)',
};

// ─── MAIN HANDLER ────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // ── JWT Auth (soft — logs but allows in test mode) ──────────
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

  // ── Parse body ────────────────────────────────────────────
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

// ═══ GRANT APPLICATION ═══════════════════════════════════════
async function generateGrant(profile, program, lang, langName) {
  const org       = profile.organization  || profile.name       || 'Our Organization';
  const sector    = profile.sector        || 'Education / IT';
  const country   = profile.country       || 'North Macedonia';
  const budgetAmt = program.amount        || program.award_amount || '€60,000';
  const donor     = program.donor         || program.organization_name || 'Funding Organization';
  const title     = program.title         || 'Funding Program';

  // ── Prompt 1: Narrative sections ──────────────────────────
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

  // ── Prompt 2: Results, Activities, Risks ─────────────────
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

  // ── Prompt 3: Budget with unit costs ──────────────────────
  const budgetPrompt = `You are a senior EU grant accountant.
Language for string VALUES only: ${langName}.

CRITICAL JSON KEY RULE — NON-NEGOTIABLE:
Keep ALL JSON keys EXACTLY in English as shown in the template below.
NEVER translate JSON keys. Only translate string values (category names, item names, notes).
Wrong: "буџетски_линии", "категорија", "ставка" — these are FORBIDDEN
Right: "budget_lines", "category", "item" — always use these exact English keys.

Total budget: ${budgetAmt}
Duration: 18 months
Sector: ${sector}
Country: ${country}
Donor: ${donor}

Return ONLY valid JSON with ENGLISH keys and ${langName} string values:
{
  "budget_lines": [
    {"category": "Human Resources", "item": "Project Coordinator", "unit": "month", "quantity": 18, "unit_cost": 1200, "total": 21600, "grant_amount": 21600, "own_contribution": 0},
    {"category": "Human Resources", "item": "Technical Expert", "unit": "month", "quantity": 12, "unit_cost": 900, "total": 10800, "grant_amount": 8640, "own_contribution": 2160},
    {"category": "Travel", "item": "Local travel (field visits)", "unit": "trip", "quantity": 24, "unit_cost": 80, "total": 1920, "grant_amount": 1920, "own_contribution": 0},
    {"category": "Equipment", "item": "Laptops for training", "unit": "unit", "quantity": 10, "unit_cost": 600, "total": 6000, "grant_amount": 6000, "own_contribution": 0},
    {"category": "Services", "item": "Platform development", "unit": "lump sum", "quantity": 1, "unit_cost": 8000, "total": 8000, "grant_amount": 8000, "own_contribution": 0},
    {"category": "Training", "item": "Training materials & printing", "unit": "participant", "quantity": 150, "unit_cost": 25, "total": 3750, "grant_amount": 3750, "own_contribution": 0},
    {"category": "Communication", "item": "Visibility & communication", "unit": "lump sum", "quantity": 1, "unit_cost": 2000, "total": 2000, "grant_amount": 2000, "own_contribution": 0},
    {"category": "Indirect costs", "item": "Indirect costs (7%)", "unit": "lump sum", "quantity": 1, "unit_cost": 3785, "total": 3785, "grant_amount": 3785, "own_contribution": 0}
  ],
  "notes": "Budget note in ${langName} explaining co-financing and cost efficiency"
}`;

  // ── Call Gemini 3x in parallel — differentiated token limits ─
  // narrative: 8000 (long prose — abstract, problem analysis, sustainability)
  // plan:      4000 (compact JSON — results, activities, risks)
  // budget:    2000 (tabular JSON — 8 budget lines with numbers)
  // Promise.all wall time = slowest = narrative ~25s → within 60s limit
  console.log('[generate-application] calling Gemini 3x in parallel...');
  const [narrativeRaw, planRaw, budgetRaw] = await Promise.all([
    safeGemini(narrativePrompt, lang, 8000),
    safeGemini(planPrompt,      lang, 4000),
    safeGemini(budgetPrompt,    lang, 2000),
  ]);

  const narrative = parseJSON(narrativeRaw, narrativeFallback(org, sector, country, lang));
  const plan      = parseJSON(planRaw,      planFallback(sector, country, lang));
  const budget    = parseJSON(budgetRaw,    budgetFallback(lang));

  // ── Build LFM matrix ──────────────────────────────────────
  const lfm = buildLFM(narrative, plan, lang);

  // ── Build Gantt data ──────────────────────────────────────
  const gantt = buildGantt(plan.activities || []);

  // ── Compute budget totals ─────────────────────────────────
  const budgetLines    = budget.budget_lines || [];
  const totalGrant     = budgetLines.reduce((s, l) => s + (Number(l.grant_amount)      || 0), 0);
  const totalOwn       = budgetLines.reduce((s, l) => s + (Number(l.own_contribution)  || 0), 0);
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

// ═══ SCHOLARSHIP APPLICATION ════════════════════════════════
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
  "why_this_program": "Specific reasons why THIS scholarship/program is the right fit. Reference program's specific features. 80-100 words.",
  "references_guidance": "What to ask from reference letter writers (3 bullet points)",
  "cv_structure": ["Education entry", "Experience entry", "Skills entry", "Publications/Awards entry"]
}`;

  const raw     = await safeGemini(prompt, lang, 6000);
  const content = parseJSON(raw, scholarshipFallback(name, sector, country, lang));
  return content;
}

// ═══ HELPERS ════════════════════════════════════════════════

// ─── safeGemini ──────────────────────────────────────────────
// v2.2 FIX: maxTokens is now a parameter, not hardcoded.
// Each call gets exactly what it needs — no more, no less:
//   narrative → 8000 (long prose sections)
//   plan      → 4000 (compact JSON: results + activities + risks)
//   budget    → 2000 (tabular JSON: 8 budget lines)
//   scholarship→ 6000 (personal statement + structured fields)
// Promise.all wall time = max(narrative) = ~25s → well within 60s.
async function safeGemini(prompt, lang, maxTokens = 8000) {
  const system = [
    'You are a professional grant writer.',
    'OUTPUT RULES (non-negotiable):',
    '1. Return ONLY a valid JSON object — nothing else.',
    '2. No markdown fences (no ```json), no explanation, no preamble.',
    '3. No trailing commas. No comments inside JSON.',
    '4. All string values must use double quotes.',
    '5. Do NOT translate JSON keys — only translate string values.',
    '6. If a value would be very long, shorten it to fit valid JSON.',
  ].join('\n');

  try {
    const result = await gemini(system, [{ role: 'user', parts: [{ text: prompt }] }], {
      maxTokens,
      temperature: 0.1,
    });
    console.log(`[safeGemini] maxTokens:${maxTokens} raw preview:`, (result || '').slice(0, 200));
    return result;
  } catch (e) {
    console.warn('[safeGemini] gemini call error:', e.message);
    return '{}';
  }
}

// ─── parseJSON ───────────────────────────────────────────────
function parseJSON(raw, fallback) {
  if (!raw) return fallback;

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
    return { ...fallback, ...JSON.parse(candidate) };
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
    return { ...fallback, ...parsed };
  } catch (e2) {
    console.warn('[parseJSON] all repair attempts failed:', e2.message.slice(0, 80));
    return fallback;
  }
}

// ─── buildLFM ────────────────────────────────────────────────
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

// ─── buildGantt ──────────────────────────────────────────────
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

// ═══ FALLBACKS ══════════════════════════════════════════════
function narrativeFallback(org, sector, country, lang) {
  const mk = lang === 'mk';
  return {
    project_title:    mk ? `Дигитална иновација за ${country}` : `Digital Innovation for ${country}`,
    abstract:         mk ? `Проектот ќе изгради капацитети во секторот ${sector} во ${country}, со директна корист за 150 корисници. Преку иновативен пристап, организацијата ${org} ќе спроведе обуки, ќе развие дигитална платформа и ќе обезбеди долгорочна одржливост преку партнерства со локалните институции.` : `This project will build capacity in the ${sector} sector in ${country}, directly benefiting 150 people. Through an innovative approach, ${org} will deliver training, develop a digital platform, and ensure long-term sustainability through partnerships with local institutions.`,
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
      { id: 'A1.1', result: 1, title: mk ? 'Развој на платформа'        : 'Platform development',      months: '1-5',   responsible: mk ? 'Технички тим'    : 'Technical team' },
      { id: 'A1.2', result: 1, title: mk ? 'Обука на персонал'          : 'Staff training',            months: '2-3',   responsible: mk ? 'Координатор'     : 'Coordinator' },
      { id: 'A2.1', result: 2, title: mk ? 'Регрутација на учесници'    : 'Participant recruitment',   months: '3-4',   responsible: mk ? 'Координатор'     : 'Coordinator' },
      { id: 'A2.2', result: 2, title: mk ? 'Спроведување на обуки'      : 'Training delivery',         months: '5-14',  responsible: mk ? 'Тренери'         : 'Trainers' },
      { id: 'A3.1', result: 3, title: mk ? 'Партнерски договори'        : 'Partnership agreements',    months: '12-15', responsible: mk ? 'Директор'        : 'Director' },
      { id: 'A3.2', result: 3, title: mk ? 'Финален извештај'           : 'Final report',              months: '17-18', responsible: mk ? 'Тим'             : 'Team' },
      { id: 'A0.1', result: 0, title: mk ? 'Управување со проект'       : 'Project management',        months: '1-18',  responsible: mk ? 'Проект менаџер'  : 'Project Manager' },
    ],
    risks: [
      { risk: mk ? 'Низок интерес на корисниците' : 'Low beneficiary interest',       probability: 'Low',    impact: 'High',   mitigation: mk ? 'Рана комуникација и пилот фаза' : 'Early communication and pilot phase' },
      { risk: mk ? 'Доцнење на плаќања'           : 'Payment delays',                 probability: 'Medium', impact: 'Medium', mitigation: mk ? 'Резервен фонд'                  : 'Reserve fund' },
      { risk: mk ? 'Технички проблеми'            : 'Technical platform issues',      probability: 'Low',    impact: 'Medium', mitigation: mk ? 'Тестирање пред лансирање'       : 'Pre-launch testing' },
    ],
  };
}

function budgetFallback(lang) {
  const mk = lang === 'mk';
  return {
    budget_lines: [
      { category: mk?'Човечки ресурси':'Human Resources', item: mk?'Проект координатор':'Project Coordinator', unit:'month', quantity:18, unit_cost:1100, total:19800, grant_amount:19800, own_contribution:0 },
      { category: mk?'Човечки ресурси':'Human Resources', item: mk?'Технички експерт':'Technical Expert',      unit:'month', quantity:12, unit_cost:900,  total:10800, grant_amount:8640,  own_contribution:2160 },
      { category: mk?'Патување':'Travel',                  item: mk?'Локални посети':'Local field visits',      unit:'trip',  quantity:20, unit_cost:75,   total:1500,  grant_amount:1500,  own_contribution:0 },
      { category: mk?'Опрема':'Equipment',                 item: mk?'Лаптопи за обука':'Training laptops',      unit:'unit',  quantity:10, unit_cost:550,  total:5500,  grant_amount:5500,  own_contribution:0 },
      { category: mk?'Услуги':'Services',                  item: mk?'Развој на платформа':'Platform dev',       unit:'lump',  quantity:1,  unit_cost:7000, total:7000,  grant_amount:7000,  own_contribution:0 },
      { category: mk?'Обука':'Training',                   item: mk?'Материјали за обука':'Training materials',  unit:'pax',   quantity:150,unit_cost:22,   total:3300,  grant_amount:3300,  own_contribution:0 },
      { category: mk?'Комуникација':'Communication',       item: mk?'Видливост':'Visibility & comms',           unit:'lump',  quantity:1,  unit_cost:1800, total:1800,  grant_amount:1800,  own_contribution:0 },
      { category: mk?'Индиректни трошоци':'Indirect costs',item: mk?'Индиректни трошоци (7%)':'Indirect (7%)',  unit:'lump',  quantity:1,  unit_cost:3457, total:3457,  grant_amount:3457,  own_contribution:0 },
    ],
    notes: mk ? 'Буџетот вклучува co-financing од 2,160 EUR (4%) од страна на организацијата.' : 'Budget includes co-financing of €2,160 (4%) from the organization.',
  };
}

function scholarshipFallback(name, sector, country, lang) {
  const mk = lang === 'mk';
  return {
    personal_statement:      mk ? `Растев во ${country} гледајќи ги предизвиците во секторот ${sector}. Оваа стипендија ќе ми даде можност да придонесам конкретно кон развојот на мојата заедница.` : `Growing up in ${country}, I witnessed firsthand the challenges in the ${sector} sector. This scholarship will give me the opportunity to contribute concretely to my community's development.`,
    academic_background:     mk ? 'Дипломиран со одличен успех. Учествував во истражувачки проекти.' : 'Graduated with distinction. Participated in research projects.',
    professional_experience: mk ? 'Работев на проекти поврзани со секторот. Волонтерска работа во НВО.' : 'Worked on sector-related projects. Volunteered with NGOs.',
    research_proposal:       mk ? 'Наслов: Иновации во секторот. Методологија: мешани методи. Очекувани резултати: публикација и препорака.' : 'Title: Innovations in the sector. Methodology: mixed methods. Expected outcomes: publication and policy recommendation.',
    return_plan:             mk ? 'По враќањето, ќе работам со националните институции за да ги применам стекнатите знаења.' : 'After returning, I will work with national institutions to apply the acquired knowledge.',
    why_this_program:        mk ? 'Овој програм е идеален поради репутацијата, мрежата на алумни и фокусот на мојот сектор.' : 'This program is ideal due to its reputation, alumni network, and focus on my sector.',
    references_guidance:     [mk?'Нагласете ги лидерските квалитети':'Emphasize leadership qualities', mk?'Споменете конкретни постигнувања':'Mention specific achievements', mk?'Опишете го потенцијалот за влијание':'Describe impact potential'],
    cv_structure:            [mk?'Образование: Универзитет, степен, година':'Education: University, degree, year', mk?'Искуство: Позиција, организација, период':'Experience: Position, org, period', mk?'Вештини: Јазици, технологии':'Skills: Languages, tech', mk?'Признанија: Награди, публикации':'Recognition: Awards, publications'],
  };
}
