// ═══════════════════════════════════════════════════════════════════════
// MARGINOVA — api/chat.js  v9.1 — Universal Funding Decision Engine
//
// FIXED v9.1:
// - scoreOpportunity() теперь принимает lang (риски, nextStep, whyFits на языках)
// - RISK_STRINGS за mk/en/sr
// - nextStep преку LANG[lang]
// - sectorScore: null sector → 0.0 (не 0.50)
// - probability cap 85% (не 97%)
// ═══════════════════════════════════════════════════════════════════════

console.log('[chat.js] v9.1 loaded — Universal Decision Engine (fixed lang, risks, scoring)');
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

// ─── LANGUAGE LABEL MAPS ─────────────────────────────────────────────
const LANG = {
  mk: {
    header:        'Еве ја евалуацијата според вашиот профил:',
    topSection:    '🎯 ТОП ПАТИШТА ЗА ВАС',
    org:           'Организација',
    funding:       'Финансирање',
    deadline:      'Краен рок',
    region:        'Регион',
    decision:      'Одлука',
    probability:   'Веројатност',
    riskLbl:       'Ризик',
    low:           'Низок',
    medium:        'Среден',
    high:          'Висок',
    whyFits:       'Зошто одговара',
    mainRisks:     'Главни ризици',
    nextStep:      'Следен чекор',
    link:          'Линк',
    eliminated:    '🚫 ОТСТРАНЕТИ / НИЗОК ПРИОРИТЕТ',
    finalSection:  '📋 КОНЕЧНА ОДЛУКА',
    bestPath:      'Најдобра патека',
    action:        'Препорачана акција',
    noResults:     'Нема програми кои ги исполнуваат критериумите. Додај повеќе детали — сектор, земја, тип на организација.',
    noMoreDetail:  'Нема пронајдени програми за вашиот профил. Додај повеќе детали — сектор, земја, тип на организација, и буџет — за да добиеш подобри резултати.',
    notConfirmed:  'Не е потврдено',
    yes:           '✅ ДА',
    conditional:   '⚠️ УСЛОВНО',
    no:            '❌ НЕ',
    elim:          '🚫 ЕЛИМИНИРАНО',
    nextStepUrl:   (url)   => `Отвори ја официјалната страница и провери го повикот за предлози: ${url}`,
    nextStepSearch:(title) => `Пребарај "${title}" на официјалната веб-страница на донаторот`,
    nextStepApply: (days)  => `⚡ Аплицирај во следните ${days} дена. `,
  },
  en: {
    header:        'Here is the evaluation based on your profile:',
    topSection:    '🎯 TOP FUNDING PATHS FOR YOU',
    org:           'Organization',
    funding:       'Funding',
    deadline:      'Deadline',
    region:        'Region',
    decision:      'Decision',
    probability:   'Probability',
    riskLbl:       'Risk',
    low:           'Low',
    medium:        'Medium',
    high:          'High',
    whyFits:       'Why it fits',
    mainRisks:     'Main risks',
    nextStep:      'Next step',
    link:          'Link',
    eliminated:    '🚫 ELIMINATED / LOW PRIORITY',
    finalSection:  '📋 FINAL DECISION',
    bestPath:      'Best path',
    action:        'Recommended action',
    noResults:     'No programs passed the eligibility filter. Please add more details — sector, country, organization type.',
    noMoreDetail:  'No funding programs found for your profile. Please add more details — sector, country, organization type, and budget.',
    notConfirmed:  'Not confirmed',
    yes:           '✅ YES',
    conditional:   '⚠️ CONDITIONAL',
    no:            '❌ NO',
    elim:          '🚫 ELIMINATED',
    nextStepUrl:   (url)   => `Open the official page and check the call for proposals: ${url}`,
    nextStepSearch:(title) => `Search for "${title}" on the donor's official website`,
    nextStepApply: (days)  => `⚡ Apply within ${days} days. `,
  },
  sr: {
    header:        'Evo evaluacije prema vašem profilu:',
    topSection:    '🎯 TOP PUTEVI ZA VAS',
    org:           'Organizacija',
    funding:       'Finansiranje',
    deadline:      'Rok',
    region:        'Region',
    decision:      'Odluka',
    probability:   'Verovatnoća',
    riskLbl:       'Rizik',
    low:           'Nizak',
    medium:        'Srednji',
    high:          'Visok',
    whyFits:       'Zašto odgovara',
    mainRisks:     'Glavni rizici',
    nextStep:      'Sledeći korak',
    link:          'Link',
    eliminated:    '🚫 ELIMINISANI / NIZAK PRIORITET',
    finalSection:  '📋 KONAČNA ODLUKA',
    bestPath:      'Najbolji put',
    action:        'Preporučena akcija',
    noResults:     'Nema programa koji ispunjavaju kriterijume. Dodajte više detalja — sektor, zemlja, tip organizacije.',
    noMoreDetail:  'Nisu pronađeni programi za vaš profil. Dodajte više detalja — sektor, zemlja, tip organizacije i budžet.',
    notConfirmed:  'Nije potvrđeno',
    yes:           '✅ DA',
    conditional:   '⚠️ USLOVNO',
    no:            '❌ NE',
    elim:          '🚫 ELIMINISANO',
    nextStepUrl:   (url)   => `Otvori zvaničnu stranicu i proveri poziv za predloge: ${url}`,
    nextStepSearch:(title) => `Pretraži "${title}" na zvaničnom sajtu donatora`,
    nextStepApply: (days)  => `⚡ Apliciraj u narednih ${days} dana. `,
  },
};

function L(lang) { return LANG[lang] || LANG.en; }

// ─── RISK STRINGS (Macedonian / English / Serbian) ──────────────────
const RISK_STRINGS = {
  mk: {
    deadlineUrgent: (d) => `Рок за ${d} дена — аплицирај веднаш`,
    deadlineSoon:   (d) => `Рок за ${d} дена — започни со апликацијата сега`,
    noFarmer:       'Наведовте дека немате земјоделско стопанство/земјиште — оваа програма го бара тоа',
    noNGO:          'Наведовте дека немате НВО — оваа програма бара регистрирана организација',
    noCompany:      'Наведовте дека немате регистрирана компанија — оваа програма бара правно лице',
    noStudent:      'Наведовте дека не сте студент — оваа програма бара активен студентски статус',
    noPartner:      'Наведовте дека немате партнерски организации — оваа програма бара конзорциум',
    noResearch:     'Наведовте дека немате афилијација со истражувачка институција — оваа програма го бара тоа',
    noDeadline:     'Рокот не е потврден — проверете го на официјалниот извор пред да аплицирате',
    noUrl:          'Нема линк до извор — пребарајте ја официјалната веб-страница на донаторот',
    webResult:      'Веб резултат — проверете ги СИТЕ детали (износ, рок, подобност) на официјален извор',
    globalComp:     'Глобална конкуренција — многу голем број апликанти',
    verifyDefault:  'Проверете ги целосните критериуми за подобност на официјален извор пред поднесување',
    requireNGO:     'Бара регистрирана НВО — поединци не се подобни',
    requireCompany: 'Бара регистрирана компанија — НВО обично не се подобни за оваа програма',
    requireLegal:   'Бара регистриран правен субјект — поединци не се подобни',
    requireFarmer:  'Бара регистрирано земјоделско стопанство + сопственост на земјиште — не е применливо за вашиот профил',
    requireStudent: 'Бара активен студентски статус — не е применливо за вашиот профил',
    consortium:     'Бара конзорциум/партнерство — мора да идентификувате барем еден партнер',
    regionMismatch: (region, country) => `Потврди дека ${country} е подобна — програмата е наменета за: "${region}"`,
    elFarmer:       'Потребно е документирано земјоделско искуство',
    elExperience:   'Потребен е докажан работен стаж — подгответе примери од претходни проекти',
    elInnovation:   'Бара иновативен пристап — нагласете ја уникатноста на проектот',
  },
  en: {
    deadlineUrgent: (d) => `Deadline in ${d} days — apply immediately`,
    deadlineSoon:   (d) => `Deadline in ${d} days — start the application now`,
    noFarmer:       'You stated you do not have an agricultural holding or land — this program requires it',
    noNGO:          'You stated you do not have an NGO — this program requires a registered civil society organization',
    noCompany:      'You stated you do not have a registered company — this program requires a legal entity',
    noStudent:      'You stated you are not a student — this program requires active student enrollment',
    noPartner:      'You stated you have no partner organizations — this program requires a consortium',
    noResearch:     'You stated you have no research institution affiliation — this program requires one',
    noDeadline:     'Deadline not confirmed — verify on official source before starting application',
    noUrl:          'No source URL — search for the official donor website to find application instructions',
    webResult:      'Web result — verify ALL details (amount, deadline, eligibility) on official source before applying',
    globalComp:     'Global competition — very large applicant pool, highly competitive',
    verifyDefault:  'Verify full eligibility criteria on official source before submitting',
    requireNGO:     'Requires registered NGO — individuals are not eligible',
    requireCompany: 'Requires registered company — NGOs are typically not eligible for this program',
    requireLegal:   'Requires registered legal entity — sole individuals are not eligible',
    requireFarmer:  'Requires registered agricultural holding + land ownership — not applicable to your profile',
    requireStudent: 'Requires current student status — not applicable to your profile',
    consortium:     'Requires consortium/partnership — you must identify at least one partner organization',
    regionMismatch: (region, country) => `Confirm ${country} is eligible — program targets: "${region}"`,
    elFarmer:       'Documented farming experience required',
    elExperience:   'Documented track record required — prepare examples of previous projects or grants',
    elInnovation:   'Innovation required — highlight the uniqueness of your project',
  },
  sr: {
    deadlineUrgent: (d) => `Rok za ${d} dana — apliciraj odmah`,
    deadlineSoon:   (d) => `Rok za ${d} dana — započni sa aplikacijom sada`,
    noFarmer:       'Naveli ste da nemate poljoprivredno gazdinstvo/zemljište — ovaj program to zahteva',
    noNGO:          'Naveli ste da nemate NVO — ovaj program zahteva registrovanu organizaciju',
    noCompany:      'Naveli ste da nemate registrovanu kompaniju — ovaj program zahteva pravno lice',
    noStudent:      'Naveli ste da niste student — ovaj program zahteva aktivan studentski status',
    noPartner:      'Naveli ste da nemate partnerske organizacije — ovaj program zahteva konzorcijum',
    noResearch:     'Naveli ste da nemate afilijaciju sa istraživačkom institucijom — ovaj program to zahteva',
    noDeadline:     'Rok nije potvrđen — proverite na zvaničnom izvoru',
    noUrl:          'Nema link ka izvoru — potražite zvanični sajt donatora',
    webResult:      'Web rezultat — proverite SVE detalje (iznos, rok, podobnost) na zvaničnom izvoru',
    globalComp:     'Globalna konkurencija — veoma veliki broj aplikanata',
    verifyDefault:  'Proverite kriterijume podobnosti na zvaničnom izvoru',
    requireNGO:     'Zahteva registrovanu NVO — pojedinci nisu podobni',
    requireCompany: 'Zahteva registrovanu kompaniju — NVO nisu podobne za ovaj program',
    requireLegal:   'Zahteva registrovano pravno lice — pojedinci nisu podobni',
    requireFarmer:  'Zahteva registrovano poljoprivredno gazdinstvo + zemljište — nije primenljivo za vaš profil',
    requireStudent: 'Zahteva aktivan studentski status — nije primenljivo za vaš profil',
    consortium:     'Zahteva konzorcijum/partnerstvo — morate imati bar jednog partnera',
    regionMismatch: (region, country) => `Potvrdite da ${country} je podobna — program je namenjen za: "${region}"`,
    elFarmer:       'Dokumentovano poljoprivredno iskustvo potrebno',
    elExperience:   'Dokumentovano iskustvo potrebno — pripremite primere prethodnih projekata',
    elInnovation:   'Inovacija potrebna — naglasite jedinstvenost projekta',
  },
};

// ─── WHY-FITS STRINGS (Macedonian / English / Serbian) ──────────────
const WHY_FITS_STRINGS = {
  mk: {
    ngo:      'одговара на вашиот тип НВО',
    company:  'одговара на вашата регистрирана компанија',
    farmer:   'наменето за земјоделски стопанства',
    student:  'отворено за студенти / млади',
    researcher: 'насочено кон истражувачки институции',
    country:  'отворено за',
    balkans:  'отворено за земји на Западен Балкан',
    sector:   'се усогласува со вашиот сектор',
    fallback: 'Општо совпаѓање — проверете ги критериумите на официјален извор',
    noMatch:  'Не ги исполнува критериумите за подобност',
  },
  en: {
    ngo:      'matches your NGO type',
    company:  'matches your company registration',
    farmer:   'designed for agricultural holdings',
    student:  'open to students / young professionals',
    researcher: 'targets research institutions',
    country:  'open to',
    balkans:  'open to Western Balkans countries',
    sector:   'aligns with your sector',
    fallback: 'General match — verify eligibility criteria on official source',
    noMatch:  'Does not match eligibility criteria',
  },
  sr: {
    ngo:      'odgovara vašem tipu NVO',
    company:  'odgovara vašoj registrovanoj kompaniji',
    farmer:   'namenjeno za poljoprivredna gazdinstva',
    student:  'otvoreno za studente / mlade',
    researcher: 'usmereno ka istraživačkim institucijama',
    country:  'otvoreno za',
    balkans:  'otvoreno za zemlje Zapadnog Balkana',
    sector:   'usklađeno sa vašim sektorom',
    fallback: 'Opšte poklapanje — proverite kriterijume na zvaničnom izvoru',
    noMatch:  'Ne ispunjava kriterijume podobnosti',
  },
};

function buildWhyFits(opp, profile, lang) {
  const s = WHY_FITS_STRINGS[lang] || WHY_FITS_STRINGS.en;
  const req = opp.requirements;
  const reasons = [];

  if (profile._isNGO && req.requiresNGO) reasons.push(s.ngo);
  if (profile._isCompany && req.requiresCompany) reasons.push(s.company);
  if (profile._isFarmer && req.requiresFarmer) reasons.push(s.farmer);
  if (profile._isStudent && req.requiresStudent) reasons.push(s.student);
  if (profile._isResearcher && req.requiresResearch) reasons.push(s.researcher);
  if (profile.country && opp.region && opp.region.toLowerCase().includes(profile.country.toLowerCase())) {
    reasons.push(`${s.country} ${profile.country}`);
  } else if (/western balkans|balkans/i.test(opp.region)) {
    reasons.push(s.balkans);
  }
  if (profile.sector) {
    const hay = (opp.sectorText + ' ' + opp.description).toLowerCase();
    const kw = profile.sector.split(/[/ ]/)[0].toLowerCase();
    if (kw && hay.includes(kw)) reasons.push(`${s.sector} (${profile.sector})`);
  }

  if (reasons.length === 0) {
    if (opp.eliminated) return opp.eliminationReason || s.noMatch;
    return s.fallback;
  }
  return reasons.join(', ').replace(/^\w/, c => c.toUpperCase()) + '.';
}

// ─── PROGRAM FAMILY CLUSTERS ─────────────────────────────────────────
const PROGRAM_FAMILIES = [
  { re: /ipard/i,                           family: 'IPARD' },
  { re: /erasmus\+?/i,                      family: 'Erasmus+' },
  { re: /horizon\s*(europe|2020)?/i,        family: 'Horizon Europe' },
  { re: /creative\s*europe/i,               family: 'Creative Europe' },
  { re: /life\s*(program|programme)?/i,     family: 'LIFE Programme' },
  { re: /interreg/i,                        family: 'Interreg' },
  { re: /eu4business|eu\s*for\s*business/i, family: 'EU4Business' },
  { re: /wbif|western\s*balkans\s*invest/i, family: 'WBIF' },
];

function getFamily(title) {
  for (const { re, family } of PROGRAM_FAMILIES) {
    if (re.test(title || '')) return family;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// DECISION ENGINE FUNCTIONS
// ═══════════════════════════════════════════════════════════

// ─── 0. detectNegatives ──────────────────────────────────────────────
function detectNegatives(text) {
  const negates = {
    farmer:   false,
    land:     false,
    company:  false,
    ngo:      false,
    student:  false,
    partner:  false,
    research: false,
  };
  const t = text || '';

  if (/(?:do\s+not|don['']?t|not\s+have|нема[мт]?|без|не\s+поседувам|немам|не\s+сум\s+земјоделец|нисам\s+farmer|nisam\s+farmer)\s+(?:an?\s+)?(?:agricultural\s+holding|farm(?:er)?|земјоделск[ао]\s+стопанство|земјоделец|agri[- ]?holding)/i.test(t)) {
    negates.farmer = true;
  }
  if (/(?:do\s+not|don['']?t|not\s+own|not\s+have|нема[мт]?|без|не\s+поседувам|немам)\s+(?:any\s+)?(?:land|земјиште|hectares?|хектар|парцела|cadastral\s+plot)/i.test(t)) {
    negates.land = true;
  }
  if (/(?:do\s+not|don['']?t|not\s+have|нема[мт]?|без|не\s+поседувам|немам)\s+(?:a\s+)?(?:company|registered\s+company|llc|ltd|дооел|фирма|претпријатие|legal\s+entity|правно\s+лице)/i.test(t)) {
    negates.company = true;
  }
  if (/(?:do\s+not|don['']?t|not\s+have|нема[мт]?|без|не\s+поседувам|немам)\s+(?:an?\s+)?(?:ngo|association|нво|здружение|nonprofit|civil\s+society\s+org)/i.test(t)) {
    negates.ngo = true;
  }
  if (/(?:not\s+a\s+student|not\s+enrolled|do\s+not\s+have\s+student|нема[мт]?\s+студентски\s+статус|не\s+сум\s+студент|nisam\s+student)/i.test(t)) {
    negates.student = true;
  }
  if (/(?:do\s+not|don['']?t|нема[мт]?|немам|без)\s+(?:any\s+)?(?:partners?|partner\s+org|конзорциум|конзорц|consortium)/i.test(t)) {
    negates.partner = true;
  }
  if (/(?:do\s+not|don['']?t|not\s+affiliated|нема[мт]?|немам|без)\s+(?:a\s+)?(?:research\s+institution|university\s+affiliation|научна\s+институција|универзитет)/i.test(t)) {
    negates.research = true;
  }

  return negates;
}

// ─── 1. detectUserProfile ────────────────────────────────────────────
function detectUserProfile(text, baseProfile) {
  const p = { ...baseProfile };

  if (!p.orgType) {
    if (/\b(ngo|нво|civil society|здружение|association|nonprofit|невладина)\b/i.test(text))
      p.orgType = 'NGO / Association';
    else if (/\b(дооел|ад|llc|ltd|фирма|компанија|претпријатие|sme|startup|стартап|enterprise|company)\b/i.test(text))
      p.orgType = 'SME';
    else if (/\b(поединец|физичко лице|individual|freelance|самовработен|sole trader|sole proprietor)\b/i.test(text))
      p.orgType = 'Individual / Entrepreneur';
    else if (/\b(земјоделец|земјоделско стопанство|farmer|agricultural holding|ipard|фармер)\b/i.test(text))
      p.orgType = 'Agricultural holding';
    else if (/\b(студент|student|стипендија|scholarship|fellowship|phd|doctoral|undergraduate)\b/i.test(text))
      p.orgType = 'Student / Youth';
    else if (/\b(municipality|општини|локална власт|local government|јавно тело|public body)\b/i.test(text))
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

  p.negates = detectNegatives(text);

  if (p.negates.farmer)  p._isFarmer  = false;
  if (p.negates.ngo)     p._isNGO     = false;
  if (p.negates.company) p._isCompany = false;
  if (p.negates.student) p._isStudent = false;

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
    requiresExperience:  /\b(proven experience|track record|minimum \d+ years|at least \d+ years|prior project experience|demonstrated capacity|previous grants|искуство|докажан капацитет)\b/.test(hay),
    requiresInnovation:  /\b(innovative|innovation|breakthrough|novel|novelty|proof of concept|inovativ|иновациј)\b/.test(hay),
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
    score:              0,
    probability:        0,
    decision:           null,
    riskLevel:          null,
    risks:              [],
    nextStep:           null,
    eliminated:         false,
    eliminationReason:  null,
    whyFits:            '',
    family:             getFamily(raw.title),
    co_financing_rate:  raw.co_financing_rate  ?? null,
  };
}

// ─── 4. scoreOpportunity (with lang) ─────────────────────────────────
function scoreOpportunity(opp, profile, lang) {
  const RS = RISK_STRINGS[lang] || RISK_STRINGS.en;
  const req   = opp.requirements;
  const neg   = profile.negates || {};
  const today = new Date();
  const risks = [];

  if (opp.deadline) {
    const deadDate = new Date(opp.deadline);
    if (!isNaN(deadDate) && deadDate < today) {
      return Object.assign(opp, {
        eliminated: true, eliminationReason: 'Expired deadline',
        decision: '🚫 ELIMINATED', probability: 0, riskLevel: 'High',
        risks: [RS.noDeadline],
        nextStep: 'Look for the next call for proposals from this donor',
        whyFits:  'Program is closed — deadline has passed',
      });
    }
    const daysLeft = Math.round((deadDate - today) / 86400000);
    if (daysLeft < 7)       risks.push(RS.deadlineUrgent(daysLeft));
    else if (daysLeft < 21) risks.push(RS.deadlineSoon(daysLeft));
  }

  let negativeConflict = false;
  let negativeReason   = null;

  if ((neg.farmer || neg.land) && (req.requiresFarmer || req.requiresLand)) {
    negativeConflict = true;
    negativeReason   = RS.noFarmer;
    risks.push(RS.noFarmer);
  }
  if (neg.ngo && req.requiresNGO) {
    negativeConflict = true;
    negativeReason   = RS.noNGO;
    risks.push(RS.noNGO);
  }
  if (neg.company && req.requiresCompany && !req.requiresNGO) {
    negativeConflict = true;
    negativeReason   = RS.noCompany;
    risks.push(RS.noCompany);
  }
  if (neg.student && req.requiresStudent) {
    negativeConflict = true;
    negativeReason   = RS.noStudent;
    risks.push(RS.noStudent);
  }
  if (neg.partner && req.requiresPartners) {
    negativeConflict = true;
    negativeReason   = RS.noPartner;
    risks.push(RS.noPartner);
  }
  if (neg.research && req.requiresResearch) {
    negativeConflict = true;
    negativeReason   = RS.noResearch;
    risks.push(RS.noResearch);
  }

  if (negativeConflict) {
    opp.eliminated        = true;
    opp.eliminationReason = negativeReason;
    opp.risks             = risks;
    opp.riskLevel         = 'High';
    opp.decision          = '🚫 ELIMINATED';
    opp.probability       = 0;
    opp.whyFits           = negativeReason;
    opp.nextStep          = 'This program does not match your stated profile. Check the donor\'s other programs.';
    return opp;
  }

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
        risks.push(RS.requireNGO);
        opp.eliminationReason = RS.requireNGO;
      } else if (profile._isCompany) {
        eligScore = 0.15; hardConflict = true;
        risks.push(RS.requireCompany);
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
        risks.push(RS.requireCompany);
      } else if (profile._isIndividual) {
        eligScore = 0.08; hardConflict = true;
        risks.push(RS.requireLegal);
        opp.eliminationReason = RS.requireLegal;
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
        opp.eliminated        = true;
        opp.eliminationReason = RS.requireFarmer;
        risks.push(RS.requireFarmer);
      }
    }

    if (req.requiresStudent) {
      if (profile._isStudent) {
        eligScore = 0.92;
      } else {
        eligScore = 0.03; hardConflict = true;
        opp.eliminated        = true;
        opp.eliminationReason = RS.requireStudent;
        risks.push(RS.requireStudent);
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
    risks.push(RS.consortium);
  }

  if (req.requiresLegalEntity && profile._isIndividual && !req.requiresStudent) {
    risks.push(RS.requireLegal);
    eligScore = Math.min(eligScore, 0.35);
  }

  if (req.requiresExperience) risks.push(RS.elExperience);
  if (req.requiresInnovation)  risks.push(RS.elInnovation);

  if (hardConflict && eligScore < 0.15) {
    opp.eliminated        = true;
    opp.eliminationReason = opp.eliminationReason || 'Eligibility conflict with your organization type';
  }

  const hasConflict = hardConflict || opp.eliminated;

  if (opp.eliminated) {
    return Object.assign(opp, {
      decision:    '🚫 ELIMINATED',
      probability: Math.min(Math.round(eligScore * 30), 35),
      riskLevel:   'High',
      risks,
      nextStep:    'This program does not match your organization type. Check the donor\'s other programs.',
      whyFits:     opp.eliminationReason || 'Eligibility conflict',
    });
  }

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
      risks.push(RS.regionMismatch(opp.region, profile.country));
      opp.eliminated        = true;
      opp.eliminationReason = `Region mismatch — program targets ${opp.region}, not ${profile.country}`;
    }
  }

  if (opp.eliminated) {
    return Object.assign(opp, {
      decision:    '🚫 ELIMINATED',
      probability: Math.min(Math.round(eligScore * regionScore * 50), 35),
      riskLevel:   'High',
      risks,
      nextStep:    'This program is not open to your country. Check the donor\'s regional programs.',
      whyFits:     opp.eliminationReason || 'Region mismatch',
    });
  }

  let sectorScore = profile.sector ? 0.0 : 0.50;
  if (profile.sector) {
    const hay = (opp.sectorText + ' ' + opp.description + ' ' + opp.eligibilityText).toLowerCase();
    const SECTOR_KWS = {
      'it / technology':           ['technology','digital','software','ai','ict','innovation','startup','fintech','cybersecurity','data'],
      'agriculture':               ['agriculture','farmer','rural','food','farm','ipard','agri','crop','livestock','organic'],
      'education':                 ['education','school','learning','training','erasmus','scholarship','curriculum','teacher'],
      'environment / energy':      ['environment','climate','renewable','biodiversity','conservation','clean energy','emission','sustainability'],
      'civil society':             ['civil society','ngo','nonprofit','advocacy','democracy','community','rights','governance'],
      'health / social':           ['health','social','welfare','care','women','gender','disability','mental health'],
      'research / innovation':     ['research','science','innovation','university','academic','phd','r&d','laboratory','patent'],
      'sme / business':            ['business','enterprise','sme','entrepreneur','revenue','market','investment','startup'],
      'tourism / culture':         ['tourism','culture','heritage','creative','art','film','media','festival'],
      'student / youth':           ['student','scholarship','fellowship','youth','erasmus','exchange','internship','undergraduate'],
      'individual / entrepreneur': ['individual','entrepreneur','founder','creator','freelance','startup','self-employed'],
    };
    const kws  = SECTOR_KWS[profile.sector.toLowerCase()] || [];
    const hits = kws.filter(k => hay.includes(k)).length;
    sectorScore = hits >= 3 ? 0.95 : hits === 2 ? 0.80 : hits === 1 ? 0.65 : 0.25;
  }

  let riskScore = 0.85;
  if (!opp.deadline) {
    riskScore -= 0.10;
    risks.push(RS.noDeadline);
  }
  if (!opp.sourceUrl) {
    riskScore -= 0.15;
    risks.push(RS.noUrl);
  }
  if (opp.sourceType === 'serper_extracted') {
    riskScore -= 0.20;
    risks.push(RS.webResult);
  }
  if (/global|international|worldwide/.test(opp.region.toLowerCase()) && !/europe/.test(opp.region.toLowerCase())) {
    riskScore -= 0.08;
    risks.push(RS.globalComp);
  }
  riskScore = Math.max(riskScore, 0.10);

  if (!risks.length) risks.push(RS.verifyDefault);

  const boost      = Math.min((opp._relevanceScore || 0) / 12, 0.05);
  const finalScore = eligScore * 0.50 + regionScore * 0.20 + sectorScore * 0.20 + riskScore * 0.10 + boost;

  let probability = Math.min(Math.round(finalScore * 100), 85);
  if (hasConflict) probability = Math.min(probability, 35);

  let decision, riskLevel;
  if (hasConflict) {
    decision  = probability >= 25 ? '❌ NO' : '🚫 ELIMINATED';
    riskLevel = 'High';
    if (decision === '🚫 ELIMINATED') {
      opp.eliminated        = true;
      opp.eliminationReason = opp.eliminationReason || 'Score below threshold — poor overall fit';
    }
  } else if (probability >= 75) {
    decision = '✅ YES'; riskLevel = 'Low';
  } else if (probability >= 50) {
    decision = '⚠️ CONDITIONAL'; riskLevel = 'Medium';
  } else if (probability >= 35) {
    decision = '❌ NO'; riskLevel = 'High';
  } else {
    decision = '🚫 ELIMINATED'; riskLevel = 'High';
    opp.eliminated        = true;
    opp.eliminationReason = opp.eliminationReason || 'Score below threshold — poor overall fit';
  }

  const lbl = L(lang);
  let nextStep = opp.sourceUrl
    ? lbl.nextStepUrl(opp.sourceUrl)
    : lbl.nextStepSearch(opp.title);

  if (opp.deadline && !opp.eliminated) {
    const daysLeft = Math.round((new Date(opp.deadline) - new Date()) / 86400000);
    if (daysLeft <= 30) nextStep = lbl.nextStepApply(daysLeft) + nextStep;
  }

  opp.whyFits = buildWhyFits(opp, profile, lang);

  return Object.assign(opp, { score: parseFloat(finalScore.toFixed(3)), probability, decision, riskLevel, risks, nextStep });
}

// ─── 5. mergeDuplicates ──────────────────────────────────────────────
function mergeDuplicates(opps) {
  const familyBest = {};
  const noFamily   = [];

  for (const opp of opps) {
    if (opp.family) {
      if (!familyBest[opp.family] || (opp.score || 0) > (familyBest[opp.family].score || 0)) {
        familyBest[opp.family] = opp;
      }
    } else {
      noFamily.push(opp);
    }
  }

  const merged = Object.values(familyBest);
  for (const opp of noFamily) {
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
    .replace(/[-–—]\s*\d{4}.*/,'').replace(/\(.*?\)/g,'').replace(/[^\w\s]/g,'').replace(/\s+/g,' ').trim().slice(0, 55);
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

// ─── 7. buildOutputText ──────────────────────────────────────────────
function buildOutputText(lang, today, profile, top, lowPriority) {
  const lbl = L(lang);
  const SEP = '━━━━━━━━━━━━━━━━━━━━';
  const BIG = '════════════════════════════════════';
  let out = '';

  out += lbl.header + '\n' + BIG + '\n';
  out += lbl.topSection + '\n' + BIG + '\n\n';

  if (!top.length) {
    out += lbl.noResults + '\n';
  } else {
    for (const [i, o] of top.entries()) {
      const riskLabel = o.riskLevel === 'Low' ? lbl.low : o.riskLevel === 'Medium' ? lbl.medium : lbl.high;
      out += SEP + '\n';
      out += `${i + 1}. ${o.title}\n`;
      out += `🏛 ${lbl.org}: ${o.organization || '—'}\n`;
      out += `💰 ${lbl.funding}: ${o.amount}\n`;
      out += `📅 ${lbl.deadline}: ${o.deadline || lbl.notConfirmed}\n`;
      out += `🌍 ${lbl.region}: ${o.region || '—'}\n`;
      out += `🎯 ${lbl.decision}: ${o.decision}   📊 ${lbl.probability}: ${o.probability}%   ⚠️ ${lbl.riskLbl}: ${riskLabel}\n`;
      if (o.whyFits) out += `\n${lbl.whyFits}: ${o.whyFits}\n`;
      if (o.risks?.length) {
        out += `${lbl.mainRisks}:\n`;
        o.risks.slice(0, 3).forEach(r => { out += `  • ${r}\n`; });
      }
      out += `${lbl.nextStep}: ${o.nextStep || '—'}\n`;
      if (o.sourceUrl) out += `🔗 ${lbl.link}: ${o.sourceUrl}\n`;
      out += SEP + '\n\n';
    }
  }

  out += BIG + '\n' + lbl.eliminated + '\n' + BIG + '\n';
  if (!lowPriority.length) {
    out += '—\n';
  } else {
    lowPriority.slice(0, 6).forEach(o => {
      out += `• ${o.title} | ${o.decision} | ${o.eliminationReason || 'Low fit score'}\n`;
    });
  }

  out += '\n' + BIG + '\n' + lbl.finalSection + '\n' + BIG + '\n';
  if (top.length > 0) {
    const best = top[0];
    out += `${lbl.bestPath}: ${best.title}\n`;
    out += `${lbl.action}: ${best.nextStep || '—'}\n`;
  } else {
    out += lbl.noResults + '\n';
  }

  return out;
}

// ─── 8. formatDecisionOutput ─────────────────────────────────────────
async function formatDecisionOutput(lang, today, profile, top, lowPriority) {
  const nativeName  = NATIVE_NAMES[lang] || 'English';
  const profileLine = [profile.sector, profile.orgType, profile.country, profile.budget]
    .filter(Boolean).join(' | ') || 'not specified';

  const jsOutput = buildOutputText(lang, today, profile, top, lowPriority);

  if (lang === 'en' || !top.length) return jsOutput;

  const systemPrompt =
`You are MARGINOVA, a funding decision advisor. RESPOND ENTIRELY IN ${nativeName}. DO NOT switch language.
Today: ${today}. User profile: ${profileLine}.

STRICT RULES:
1. Translate ALL narrative text into ${nativeName}. Keep structure, emojis, and separators EXACTLY as given.
2. Keep amounts, percentages, dates, URLs, and program names EXACTLY as given — do NOT translate them.
3. Do NOT invent programs, amounts, or URLs.
4. Do NOT add or remove programs from the list.
5. Keep the exact structure with ━ and ═ separators.
6. Every word of running text must be in ${nativeName}.
7. CRITICAL: The decision labels (✅ YES, ⚠️ CONDITIONAL, ❌ NO, 🚫 ELIMINATED) must be translated to ${nativeName}.

INPUT TEXT TO TRANSLATE AND REFINE:
${jsOutput}`;

  try {
    const result = await gemini(systemPrompt, [{ role: 'user', parts: [{ text: 'Translate the above output to ' + nativeName + '. Keep all structure and data exactly.' }] }], { maxTokens: 3200, temperature: 0.1 });
    if (result && typeof result === 'string' && result.length > 80) return result;
    throw new Error('Empty Gemini response');
  } catch (e) {
    console.error('[formatDecisionOutput] Gemini error:', e.message);
    return jsOutput;
  }
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

    const allText    = (body.messages || []).map(m => m.content || '').join(' ') + ' ' + userText;
    const explicitMk = /на македонски|по македонски|in macedonian|makedonski/i.test(userText);
    const explicitEn = /in english|на англиски|по английски/i.test(userText);
    const lang       = explicitMk ? 'mk' : explicitEn ? 'en' : (body.lang || detectLang(allText));

    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    console.log('[handler] lang:', lang, 'today:', today);

    const convText = (body.messages || []).slice(-4).map(m => m.content || '').join(' ') + ' ' + userText;
    let baseProfile = { sector: null, orgType: null, country: null, budget: null, keywords: [] };
    try { baseProfile = detectProfile(convText); } catch (e) { console.warn('[detectProfile]', e.message); }

    const profile = detectUserProfile(convText, baseProfile);
    console.log('[handler] profile:', JSON.stringify({
      sector: profile.sector, orgType: profile.orgType, country: profile.country,
      _isNGO: profile._isNGO, _isCompany: profile._isCompany,
      negates: profile.negates,
    }));

    cleanCache().catch(() => {});

    let shouldSearch = false;
    try {
      shouldSearch = needsSearch(convText) || !!imageData || !!(profile.sector && profile.country);
    } catch (e) { console.warn('[needsSearch]', e.message); }
    console.log('[handler] shouldSearch:', shouldSearch);

    let rawResults = [];
    let sources    = { db: 0, serper: 0 };
    let fromCache  = false;
    let cachedAt   = null;

    if (shouldSearch && !imageData) {
      const cacheKey = buildCacheKey(userText, profile) + '_' + lang;

      const cached = await getCached(cacheKey);
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

        if (rawResults.length < SERPER_FALLBACK_THRESHOLD && process.env.SERPER_API_KEY && !imageData) {
          console.log('[handler] DB weak — trying Serper fallback');
          try {
            const query   = buildSerperQuery(profile, userText);
            const webRaw  = await serperSearch(query);
            if (webRaw.length > 0) {
              const extracted = await extractFromSerper(webRaw, profile);
              rawResults      = [...rawResults, ...extracted];
              sources.serper  = extracted.length;
              console.log('[handler] Serper added:', extracted.length, 'results');
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

    let text = '';
    let top  = [];
    let lowPriority = [];

    if (rawResults.length > 0) {
      const normalized = rawResults.map(r => normalizeOpportunity(r, profile));
      const scored     = normalized.map(o => scoreOpportunity(o, profile, lang));
      const deduped    = mergeDuplicates(scored);
      const ranked     = rankResults(deduped);
      top         = ranked.top;
      lowPriority = ranked.lowPriority;

      console.log('[handler] decision: top=', top.length, 'eliminated=', lowPriority.length);

      text = await formatDecisionOutput(lang, today, profile, top, lowPriority);
    } else {
      const lbl = L(lang);
      text = lbl.noMoreDetail;
    }

    const allScored  = [...top, ...lowPriority];
    const topMatches = allScored.slice(0, RESULTS_TO_SHOW).map(o => ({
      title:              o.title,
      organization:       o.organization,
      deadline:           o.deadline          || '',
      amount:             o.amount,
      country:            o.region,
      matchSignals:       o.matchSignals       || [],
      riskFactors:        o.riskFactors?.length ? o.riskFactors : o.risks || [],
      relevanceScore:     o.score             || 0,
      probability:        o.probability       || 0,
      decision:           o.decision          || '',
      riskLevel:          o.riskLevel         || '',
      source:             o.sourceType        || 'db',
      link:               o.sourceUrl         || '',
      snippet:            [o.organization, o.amount, o.deadline ? `Deadline: ${o.deadline}` : null].filter(Boolean).join(' | '),
      opportunityId:      o.id                || null,
      opportunityType:    o.eligibilityText   || '',
      whyFits:            o.whyFits           || '',
      co_financing_rate:  o.co_financing_rate ?? null,
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
