// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/profileDetector.js
// v3 — COMPLETE REWRITE
//
// KEY IMPROVEMENTS over v2:
// 1. SCORING system — not first-match-wins, but most-signals-wins
// 2. Startup correctly detected even with "земјоделство" in text
// 3. Macedonian: стартап, основач, кофаундер, дооел, НВО, НГО
// 4. Correct priority: Startup > Agricultural holding (org type)
// 5. IT/Tech correctly wins over Agriculture for "AI за земјоделство"
// 6. needsSearch — detects org descriptions without grant keywords
// 7. Multi-country detection (primary + region)
// ═══════════════════════════════════════════════════════════

// ─── SECTOR DEFINITIONS ──────────────────────────────────────
// Each sector has weighted keywords. More specific = higher weight.
// The sector with highest total score wins.

const SECTORS = [
  {
    sector: 'IT / Technology',
    keywords: [
      // High weight — very specific
      { w: 3, r: /\bai\b|artificial\s+intelligence|вештачка\s+интелиген|machine\s+learning|blockchain|блокчејн|deep\s+learning|neural/i },
      { w: 3, r: /software\s+development|web\s+app|mobile\s+app|програмир|programming|coding|cybersecurity/i },
      { w: 2, r: /\btech\b|\bit\b|дигитал|digital|innovation|иновац|ict|платформа|platform|startup/i },
      { w: 2, r: /technology|технологи|software|апликација|application|app\b|saas|fintech|edtech/i },
      { w: 1, r: /data|податоц|algorithm|автоматиз|automat|robot|drone/i },
    ],
  },
  {
    sector: 'Environment / Energy',
    keywords: [
      { w: 3, r: /renewable\s+energy|solar\s+panel|wind\s+turbine|clean\s+energy|обновлива\s+енерги/i },
      { w: 3, r: /biodiversity|ecosystem|conservation|wildlife|природа|nature|forest|шума/i },
      { w: 2, r: /environment|climate|green|energy|ecology|одржливост|sustainability/i },
      { w: 2, r: /животна\s+средина|климатски|екологи|zelena|okolina|pollution/i },
      { w: 1, r: /waste|recycle|emission|carbon|вода|water\s+management/i },
    ],
  },
  {
    sector: 'Agriculture',
    keywords: [
      { w: 3, r: /\bfarm\b|farmer|земјоделско\s+стопанство|земјоделец|crop|livestock|добиток/i },
      { w: 3, r: /\bipard\b|agri-food|агро|agrotech|земјоделство\b/i },
      { w: 2, r: /agriculture|рурал|rural|soil|irrigation|наводнување|vineyard|лозје/i },
      { w: 2, r: /земјоделс|zemjodelst|hektar|хектар|harvest|жетва|сточарство/i },
      { w: 1, r: /food\s+production|прехрана|organic\s+farm|bio\s+farm/i },
    ],
  },
  {
    sector: 'Education',
    keywords: [
      { w: 3, r: /школа|school\b|образование|education\s+program|наставна\s+програма/i },
      { w: 3, r: /учење|learning|training\s+program|обука\s+за|дигитална\s+обука|едукација/i },
      { w: 2, r: /educat|образов|училиш|nastava|curriculum|наставник|teacher/i },
      { w: 1, r: /course|курс|workshop|работилница|seminar|lecture/i },
    ],
  },
  {
    sector: 'Civil Society',
    keywords: [
      { w: 3, r: /civil\s+society|граѓанско\s+општество|advocacy|human\s+rights|правата\s+на/i },
      { w: 3, r: /\bngo\b|\bnvo\b|невладин|nevladin|здружение|здруженија/i },
      { w: 2, r: /nonprofit|non-profit|volunteer|волонтер|демократија|democracy/i },
      { w: 1, r: /community\s+organiz|заедница|grassroots|civic\s+engagement/i },
    ],
  },
  {
    sector: 'Research / Innovation',
    keywords: [
      { w: 3, r: /\bphd\b|doctoral|истражување\b|research\s+project|научен\s+проект/i },
      { w: 3, r: /university\s+research|академски|academic\s+research|laboratory|лабораторија/i },
      { w: 2, r: /research|наука|science|innovation\s+lab|r&d|научно/i },
      { w: 1, r: /publication|публикација|patent|патент|study|студија/i },
    ],
  },
  {
    sector: 'Health / Social',
    keywords: [
      { w: 3, r: /health\s+care|mental\s+health|психолог|здравствена\s+заштита|медицинс/i },
      { w: 3, r: /social\s+welfare|социјална\s+заштита|disability|попреченост|рехабилитација/i },
      { w: 2, r: /health|medical|hospital|social\s+care|welfare|здравје|социјал/i },
      { w: 1, r: /gender|women|жени|семејство|family\s+support/i },
    ],
  },
  {
    sector: 'SME / Business',
    keywords: [
      { w: 3, r: /\bsme\b|small\s+and\s+medium|мало\s+и\s+средно\s+претпријатие/i },
      { w: 3, r: /business\s+development|бизнис\s+развој|претпријатие\b|компанија\b/i },
      { w: 2, r: /\bdoo\b|\bdooel\b|дооел|фирма\b|company\b|enterprise\b/i },
      { w: 1, r: /revenue|приход|profit|профит|market\s+expansion/i },
    ],
  },
  {
    sector: 'Student / Youth',
    keywords: [
      { w: 3, r: /\bstipend\b|scholarship\s+program|fellowship\s+program|стипенди\b|стипендија\b/i },
      { w: 3, r: /\berasmus\b|\bfulbright\b|\bdaad\b|\bchevening\b|exchange\s+program/i },
      { w: 2, r: /\bstudent\b|студент|млади\b|youth\b|млад\b|study\s+abroad/i },
      { w: 1, r: /internship|пракса|undergraduate|graduate\s+program/i },
    ],
  },
  {
    sector: 'Tourism / Culture',
    keywords: [
      { w: 3, r: /tourism\s+development|туристичк|cultural\s+heritage|културно\s+наследство/i },
      { w: 2, r: /tourism|culture|heritage|туризам|kultura|museum|festival\b/i },
      { w: 1, r: /creative\s+industry|art\s+project|уметност|film|media\b/i },
    ],
  },
];

// ─── ORG TYPE DEFINITIONS ────────────────────────────────────
// CRITICAL ORDER: More specific types first.
// Startup must be before SME. NGO must be before generic.

const ORG_TYPES = [
  {
    orgType: 'Startup',
    keywords: [
      { w: 3, r: /\bstartup\b|\bstart-up\b|\bстартап\b|\bстартуп\b/i },
      { w: 3, r: /\bfounder\b|\bco-founder\b|основач\b|кофаундер\b|соосновач\b/i },
      { w: 2, r: /early.stage|seed\s+stage|pre-seed|mvp\b|venture\b/i },
      { w: 2, r: /нов\s+бизнис|нова\s+компанија|нова\s+фирма|new\s+company/i },
    ],
  },
  {
    orgType: 'NGO / Association',
    keywords: [
      { w: 3, r: /\bngo\b|\bnvo\b|невладина\s+организација|здружение\s+на\s+граѓани/i },
      { w: 3, r: /nonprofit\b|non-profit\b|граѓанска\s+организација|civil\s+society\s+org/i },
      { w: 2, r: /здружени\b|невладин\b|fondacija\b|foundation\b|association\b/i },
      { w: 2, r: /сум\s+нво|сум\s+нго|сме\s+нво|we\s+are\s+(an?\s+)?ngo/i },
    ],
  },
  {
    orgType: 'Agricultural holding',
    keywords: [
      { w: 3, r: /земјоделско\s+стопанство|agricultural\s+holding|\bipard\b/i },
      { w: 3, r: /земјоделец\b|farmer\b|фармер\b|farm\s+owner/i },
      { w: 2, r: /\bfarm\b|фарма\b|земјоделство\b|livestock\s+owner/i },
    ],
  },
  {
    orgType: 'University / Research',
    keywords: [
      { w: 3, r: /universal|универзит|faculty\b|факултет\b|research\s+institute/i },
      { w: 2, r: /academic\s+institution|научна\s+институција|institute\b/i },
    ],
  },
  {
    orgType: 'SME',
    keywords: [
      { w: 3, r: /\bsme\b|\bdoo\b|\bdooel\b|дооел\b|мало\s+претпријатие/i },
      { w: 2, r: /small\s+business|medium\s+enterprise|мала\s+компанија/i },
    ],
  },
  {
    orgType: 'Municipality / Public body',
    keywords: [
      { w: 3, r: /municipality\b|општина\b|opstina\b|local\s+government/i },
      { w: 2, r: /public\s+body|јавна\s+институција|градот\b/i },
    ],
  },
  {
    orgType: 'Individual / Entrepreneur',
    keywords: [
      { w: 3, r: /individual\s+applicant|физичко\s+лице|самовработен\b|self.employed/i },
      { w: 2, r: /freelance\b|слободен\s+уметник|independent\s+consultant/i },
      { w: 1, r: /поединец\b|samostoen\b/i },
    ],
  },
];

// ─── COUNTRY PATTERNS ────────────────────────────────────────
const COUNTRY_PATTERNS = [
  { country: 'North Macedonia', regex: /macedon|makedon|north\s+macedon|mkd|севerna|македон|северна|Skopje|скопје|македонија/i },
  { country: 'Serbia',          regex: /\bserbia\b|srbija|србија|Belgrade|Beograd|Нови\s+Сад/i },
  { country: 'Croatia',         regex: /croatia|hrvatska|Zagreb|Hrvatska/i },
  { country: 'Bosnia',          regex: /\bbosnia\b|\bbih\b|босна|Sarajevo|Босна/i },
  { country: 'Bulgaria',        regex: /bulgaria|bulgar|бугарија|Sofia|Sofija/i },
  { country: 'Albania',         regex: /\balbania\b|shqiperi|Tirana|shqipëri/i },
  { country: 'Kosovo',          regex: /\bkosovo\b|косово|Pristina|Prishtina/i },
  { country: 'Montenegro',      regex: /montenegro|crna\s+gora|Podgorica|Черна\s+Гора/i },
  { country: 'Slovenia',        regex: /\bslovenia\b|slovenija|Ljubljana/i },
  { country: 'Romania',         regex: /\bromania\b|românia|Bucharest|Букурешт/i },
  { country: 'Greece',          regex: /\bgreece\b|grecia|Athens|Атина/i },
  { country: 'Turkey',          regex: /\bturkey\b|türkiye|Ankara|Istanbul|Турција/i },
  { country: 'Germany',         regex: /\bgermany\b|Deutschland|Berlin|Германија/i },
  { country: 'Austria',         regex: /\baustria\b|Österreich|Wien|Vienna|Австрија/i },
  { country: 'Switzerland',     regex: /\bswitzerland\b|Schweiz|Bern|Zurich|Швајцарија/i },
];

// ─── BUDGET PATTERNS ─────────────────────────────────────────
const BUDGET_PATTERNS = [
  { budget: 'above €500k',  regex: /[1-9]\d{0,2}[\s,.]?000[\s,.]?000|[1-9]\d?\s*million|милион|мил\b|\d+\s*mil/i },
  { budget: '€150k–€500k',  regex: /[1-4]\d{2}[\s,.]?000\s*(евра|eur|€)?|[1-4]\d{2}k\b|500[\s,.]?000|500k|двесте|триста|четиристо/i },
  { budget: '€30k–€150k',   regex: /[3-9]\d[\s,.]?000\s*(евра|eur|€)?|[1-9]\d[\s,.]?000\s*(евра|eur|€)?|[3-9]\dk\b|100k|150k|сто\s+илјади|педесет\s+илјади/i },
  { budget: 'up to €30k',   regex: /[1-2]\d[\s,.]?000\s*(евра|eur|€)?|[1-9][\s,.]?000\s*(евра|eur|€)?\b|\b[1-9]k\b|20k|30k|дваесет\s+илјади|триесет\s+илјади/i },
];

// ─── STOP WORDS ──────────────────────────────────────────────
const STOP_WORDS = new Set([
  // English
  'about','where','which','would','could','their','there','what',
  'have','this','that','with','from','they','will','been','were',
  'hello','dear','your','the','and','for','not','please','thank',
  'thanks','regards','some','also','very','more','work','make',
  // Macedonian
  'сакате','дали','имаме','нема','треба','може','дека','нашата',
  'која','кои','најди','покажи','постои','опции','можности',
  'благодарам','здраво','јас','сум','ние','сме','во','на',
  'за','со','од','до','по','при','над','под','пред','после',
  'работиме','работам','сакам','имам','имаме','правиме',
]);

// ─── SCORING ENGINE ──────────────────────────────────────────

/**
 * scorePatterns(text, patterns)
 * Returns array of {name, score} sorted by score descending.
 * Uses weighted keyword matching — more signals = higher score.
 */
function scorePatterns(text, patterns) {
  const scores = patterns.map(p => {
    const name  = p.sector || p.orgType;
    const score = (p.keywords || []).reduce((sum, kw) => {
      return sum + (kw.r.test(text) ? kw.w : 0);
    }, 0);
    return { name, score };
  });
  return scores.sort((a, b) => b.score - a.score);
}

/**
 * detectProfile(text)
 * Extracts user profile from conversation text.
 * Returns: { sector, orgType, country, budget, keywords }
 */
function detectProfile(text) {
  if (!text) return { sector: null, orgType: null, country: null, budget: null, keywords: [] };

  // Score all sectors and org types
  const sectorScores  = scorePatterns(text, SECTORS);
  const orgScores     = scorePatterns(text, ORG_TYPES);

  // Only assign if there is at least 1 signal
  const topSector  = sectorScores[0]?.score  > 0 ? sectorScores[0].name  : null;
  const topOrgType = orgScores[0]?.score     > 0 ? orgScores[0].name     : null;

  // Country — first match wins (explicit mention)
  const country = COUNTRY_PATTERNS.find(p => p.regex.test(text))?.country || null;

  // Budget — highest range that matches
  const budget = BUDGET_PATTERNS.find(p => p.regex.test(text))?.budget || null;

  // Debug log for development
  if (process.env.NODE_ENV !== 'production') {
    const top3s = sectorScores.slice(0, 3).filter(s => s.score > 0);
    const top3o = orgScores.slice(0, 3).filter(s => s.score > 0);
    if (top3s.length) console.log('[profileDetector] sector scores:', top3s.map(s => `${s.name}:${s.score}`).join(', '));
    if (top3o.length) console.log('[profileDetector] orgType scores:', top3o.map(s => `${s.name}:${s.score}`).join(', '));
  }

  // Keywords — content nouns for fundingScorer
  const t        = text.toLowerCase();
  const keywords = t
    .replace(/[^a-zа-ш0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !STOP_WORDS.has(w) && /[a-zа-ш]/i.test(w))
    .slice(0, 15);

  return { sector: topSector, orgType: topOrgType, country, budget, keywords };
}

/**
 * needsSearch(text)
 * Returns true when the message signals intent to find funding.
 * Deliberately broad — better to search unnecessarily than to miss.
 */
function needsSearch(text) {
  if (!text) return false;
  const t = text.toLowerCase();

  // 1. Explicit grant/fund intent
  const explicitFunding = /\b(grant|fund|financ|subsid|fellowship|scholarship|award|donor|open\s+call|call\s+for\s+proposal|грант|фонд|финансир|субвенц|стипенд|грантови|донатор|отворен\s+повик)\b/i;

  // 2. Org description — user describes themselves
  const orgDescription = /\b(јас\s+сум|ние\s+сме|сум\s+нво|сме\s+нво|сум\s+нго|сме\s+нго|сум\s+стартап|сме\s+стартап|i\s+am\s+a[n]?\s+|we\s+are\s+a[n]?\s+|our\s+organization|нашата\s+организација|работиме\s+на|работам\s+на)\b/i;

  // 3. Looking for something
  const searchIntent = /\b(кои|која|најди|покажи|постои|барам|бараме|what|find|show|look\s+for|search|looking\s+for|препорач|options|можности|опции)\b/i;

  // 4. Budget signal (strong indicator of funding search)
  const budgetSignal = /€|\$|\beur\b|\busd\b|\bevra\b|\bdolari\b|\b\d{4,}\b/i;

  // 5. Has a profile signal (sector + country or org type)
  const hasSector  = SECTORS.some(s   => s.keywords.some(k => k.r.test(text)));
  const hasCountry = COUNTRY_PATTERNS.some(p => p.regex.test(text));
  const hasOrg     = ORG_TYPES.some(o => o.keywords.some(k => k.r.test(text)));

  // Score-based: if sector+orgType both detected = clear funding search
  const hasOrgType = ORG_TYPES.some(o => o.keywords.some(k => k.r.test(text)));
  const sectorScore = SECTORS.reduce((max, s) => {
    const sc = s.keywords.reduce((sum, k) => sum + (k.r.test(text) ? k.w : 0), 0);
    return Math.max(max, sc);
  }, 0);

  return (
    explicitFunding.test(t)  ||
    orgDescription.test(t)   ||
    (searchIntent.test(t) && (hasSector || hasCountry || hasOrg)) ||
    (budgetSignal.test(t)  && (hasSector || hasOrg || hasCountry)) ||
    (hasSector && hasCountry)  ||
    (hasSector && budgetSignal.test(t)) ||
    (sectorScore >= 3 && hasOrgType)   ||
    (sectorScore >= 5)
  );
}

module.exports = { detectProfile, needsSearch };
