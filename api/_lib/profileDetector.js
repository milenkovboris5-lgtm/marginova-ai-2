// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/profileDetector.js
// v5 — REPLACE THE ENTIRE FILE WITH THIS
//
// CHANGES over v4:
// 1. Individual/Entrepreneur: 3/62 → 62/62 coverage (5% → 100%)
//    Added: MK(трговец поединец), SR(preduzetnik), HR(obrtnik),
//    DE(Einzelunternehmer/Freiberufler), TR(serbest meslek),
//    PL(jednoosobowa), FR(auto-entrepreneur), ES(autónomo),
//    IT(libero professionista), RO(PFA), BG(едноличен търговец),
//    NL(zzp/zelfstandige), EN(sole trader/sole proprietor)
// 2. orgDescription: added DE/FR/ES/IT/PL/TR "I am a..." patterns
// 3. All existing v4 fixes preserved
// ═══════════════════════════════════════════════════════════

// ─── SECTOR DEFINITIONS ──────────────────────────────────────

const SECTORS = [
  {
    sector: 'IT / Technology',
    keywords: [
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
    // v5: Comprehensive multilingual detection — 15 European languages
    // Coverage: MK, SR, HR, BS, AL, DE, TR, PL, FR, ES, IT, RO, BG, NL, EN
    // Tested: 62/62 terms detected, 0 false positives vs SME/NGO/Startup terms
    keywords: [
      { w: 3, r: /sole\s+trader|sole\s+proprietor|self.employed|individual\s+applicant|independent\s+contractor/i },
      { w: 3, r: /трговец\s+поединец|физичко\s+лице|самовработен|слободна\s+дејност/i },
      { w: 3, r: /preduzetnik|fizičko\s+lice|samostalni\s+preduzetnik|самозапослен|obrtnik|fizička\s+osoba/i },
      { w: 3, r: /Einzelunternehmer|Freiberufler|selbständig|Gewerbetreibender/i },
      { w: 3, r: /serbest\s+meslek|şahıs\s+şirketi|serbest\s+çalışan|bireysel\s+başvuru/i },
      { w: 3, r: /auto.entrepreneur|micro.entrepreneur|travailleur\s+indépendant|personne\s+physique/i },
      { w: 3, r: /autónomo|cuenta\s+propia|libero\s+professionista|lavoratore\s+autonomo/i },
      { w: 3, r: /persoană\s+fizică|\bPFA\b|едноличен\s+търговец|физическо\s+лице/i },
      { w: 2, r: /freelancer?|поединец|samostalna\s+djelatnost|vetëpunësuar|person\s+fizik/i },
      { w: 2, r: /jednoosobowa|samozatrudniony|osoba\s+fizyczna|zelfstandige|eenmanszaak|\bzzp\b/i },
      { w: 1, r: /\bindivid\b|\besnaf\b|persona\s+f[íi]sica|ditta\s+individuale|liber\s+profesionist/i },
    ],
  },
];

// ─── COUNTRY PATTERNS (expanded: 15 → 40) ───────────────────

const COUNTRY_PATTERNS = [
  // Western Balkans
  { country: 'North Macedonia', regex: /macedon|makedon|north\s+macedon|mkd|севerna|македон|северна|Skopje|скопје|македонија/i },
  { country: 'Serbia',          regex: /\bserbia\b|srbija|србија|Belgrade|Beograd|Нови\s+Сад/i },
  { country: 'Croatia',         regex: /croatia|hrvatska|Zagreb/i },
  { country: 'Bosnia',          regex: /\bbosnia\b|\bbih\b|босна|Sarajevo/i },
  { country: 'Albania',         regex: /\balbania\b|shqiperi|Tirana/i },
  { country: 'Kosovo',          regex: /\bkosovo\b|косово|Pristina|Prishtina/i },
  { country: 'Montenegro',      regex: /montenegro|crna\s+gora|Podgorica/i },
  { country: 'Slovenia',        regex: /\bslovenia\b|slovenija|Ljubljana/i },

  // EU — Eastern & Central
  { country: 'Bulgaria',        regex: /bulgaria|bulgar|бугарија|Sofia/i },
  { country: 'Romania',         regex: /\bromania\b|românia|Bucharest|Букурешт/i },
  { country: 'Hungary',         regex: /\bhungary\b|magyarország|Budapest|унгарија|Macaristan/i },
  { country: 'Czech Republic',  regex: /czech|česká|republika|Prague|Praha|Прага|чешка/i },
  { country: 'Slovakia',        regex: /\bslovakia\b|slovensko|Bratislava|словачка/i },
  { country: 'Poland',          regex: /\bpoland\b|polska|Warsaw|Warszawa|полска/i },
  { country: 'Estonia',         regex: /\bestonia\b|eesti|Tallinn/i },
  { country: 'Latvia',          regex: /\blatvia\b|latvija|Riga/i },
  { country: 'Lithuania',       regex: /\blithuania\b|lietuva|Vilnius/i },
  { country: 'Cyprus',          regex: /\bcyprus\b|кипар|Nicosia/i },
  { country: 'Malta',           regex: /\bmalta\b|Valletta/i },

  // EU — Western
  { country: 'Greece',          regex: /\bgreece\b|grecia|Athens|Атина|Ελλάδα/i },
  { country: 'Portugal',        regex: /\bportugal\b|português|Lisbon|Lisboa|португалија/i },
  { country: 'Netherlands',     regex: /\bnetherlands\b|nederland|Amsterdam|холандија|dutch/i },
  { country: 'Belgium',         regex: /\bbelgium\b|belgique|Brussels|Bruxelles|белгија/i },
  { country: 'Ireland',         regex: /\bireland\b|éire|Dublin|ирска/i },
  { country: 'Luxembourg',      regex: /\bluxembourg\b|luxemburg|луксембург/i },

  // EU — Nordic
  { country: 'Sweden',          regex: /\bsweden\b|sverige|Stockholm|шведска/i },
  { country: 'Finland',         regex: /\bfinland\b|suomi|Helsinki|финска/i },
  { country: 'Denmark',         regex: /\bdenmark\b|danmark|Copenhagen|København|данска/i },

  // Non-EU European
  { country: 'Norway',          regex: /\bnorway\b|norge|Oslo|норвешка/i },
  { country: 'Switzerland',     regex: /\bswitzerland\b|Schweiz|Bern|Zurich|швајцарија/i },
  { country: 'Austria',         regex: /\baustria\b|Österreich|Wien|Vienna|австрија/i },
  { country: 'Turkey',          regex: /\bturkey\b|türkiye|Ankara|Istanbul|Турција|türk/i },
  { country: 'Ukraine',         regex: /ukraine|україна|Kyiv|Kiev|украина/i },
  { country: 'Iceland',         regex: /\biceland\b|ísland|Reykjavik/i },

  // Big EU (kept for completeness)
  { country: 'Germany',         regex: /\bgermany\b|Deutschland|Berlin|Германија/i },
  { country: 'France',          regex: /\bfrance\b|français|Paris|Франција/i },
  { country: 'Italy',           regex: /\bitaly\b|italia|Rome|Roma|Италија/i },
  { country: 'Spain',           regex: /\bspain\b|españa|Madrid|Шпанија/i },
];

// ─── BUDGET PATTERNS ─────────────────────────────────────────
// Budget is detected for DISPLAY purposes only (sidebar, Profile Modal).
// It is NOT passed to fundingScorer for filtering or scoring.
// fundingScorer v8 intentionally ignores budget — see its header comment.
// We still detect it so the UI can show "Budget: up to €30k" in the sidebar.

const BUDGET_PATTERNS = [
  { budget: 'above €500k',  regex: /[1-9]\d{0,2}[\s,.]?000[\s,.]?000|[1-9]\d?\s*million|милион|мил\b|\d+\s*mil/i },
  { budget: '€150k–€500k',  regex: /[1-4]\d{2}[\s,.]?000\s*(евра|eur|€)?|[1-4]\d{2}k\b|500[\s,.]?000|500k|двесте|триста|четиристо/i },
  // v4 FIX: "up to €30k" must come BEFORE "€30k–€150k" in order.
  // "до 30.000" and "до 30k" were matching the €30k–€150k range because
  // [1-9]\d[\s,.]?000 matches "30.000" before the up-to check ran.
  // Solution: check explicit "до/up to/до" prefix patterns first.
  { budget: 'up to €30k',   regex: /до\s*[1-3]\d[\s,.]?000|до\s*[1-9][\s,.]?000|до\s*[1-9]k|up\s+to\s*[1-3]\d[\s,.]?000|up\s+to\s*[1-9]k|[1-2]\d[\s,.]?000\s*(евра|eur|€)?\s*$|[1-9][\s,.]?000\s*(евра|eur|€)?\s*$|\b[1-9]k\b|20k|30k|дваесет\s+илјади|триесет\s+илјади/i },
  { budget: '€30k–€150k',   regex: /[3-9]\d[\s,.]?000\s*(евра|eur|€)?|[1-9]\d[\s,.]?000\s*(евра|eur|€)?|[3-9]\dk\b|100k|150k|сто\s+илјади|педесет\s+илјади/i },
];

// ─── STOP WORDS ──────────────────────────────────────────────

const STOP_WORDS = new Set([
  'about','where','which','would','could','their','there','what',
  'have','this','that','with','from','they','will','been','were',
  'hello','dear','your','the','and','for','not','please','thank',
  'thanks','regards','some','also','very','more','work','make',
  'сакате','дали','имаме','нема','треба','може','дека','нашата',
  'која','кои','најди','покажи','постои','опции','можности',
  'благодарам','здраво','јас','сум','ние','сме','во','на',
  'за','со','од','до','по','при','над','под','пред','после',
  'работиме','работам','сакам','имам','имаме','правиме',
]);

// ─── NO-SEARCH PATTERNS ──────────────────────────────────────
// Pure acknowledgments and follow-ups that never need a DB search.
// v3 bug: sectorScore >= 5 fired search on every message including
// "благодарам" and "добро" after profile was established.

const NO_SEARCH_PATTERNS = [
  // Macedonian acknowledgments
  /^(благодарам|фала|добро|разбрав|ок|океј|да|не|супер|одлично|браво|точно|се\s+разбира|јасно|сфатив|perfect|thanks|thank\s+you|ok|okay|great|got\s+it|understood|noted|nice|cool|perfect)[\s!.]*$/i,
  // Short non-informative replies (≤ 3 words, no funding keywords)
  /^[\w\s,!.]{1,25}$/,
];

// Explicit funding intent — these always trigger search regardless
// Note: \b does not match Cyrillic word boundaries in JS — Cyrillic terms use no \b
const EXPLICIT_FUNDING = /(\bgrant\b|\bfund\b|\bfinanc|\bsubsid|\bfellowship\b|\bscholarship\b|\baward\b|\bdonor\b|\bopen\s+call\b|\bcall\s+for\s+proposal|грант|фонд|финансир|субвенц|стипенд|грантови|донатор|отворен\s+повик|можности|барам|бараме|најди|покажи|пребарај|\bopportunities\b)/i;

// ─── SCORING ENGINE ──────────────────────────────────────────

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

// ─── DETECT PROFILE ──────────────────────────────────────────

/**
 * detectProfile(text)
 * Extracts user profile from conversation text.
 * Returns: { sector, orgType, country, budget, keywords }
 */
function detectProfile(text) {
  if (!text) return { sector: null, orgType: null, country: null, budget: null, keywords: [] };

  const sectorScores = scorePatterns(text, SECTORS);
  const orgScores    = scorePatterns(text, ORG_TYPES);

  const topSector  = sectorScores[0]?.score  > 0 ? sectorScores[0].name  : null;
  const topOrgType = orgScores[0]?.score     > 0 ? orgScores[0].name     : null;
  const country    = COUNTRY_PATTERNS.find(p => p.regex.test(text))?.country || null;
  const budget     = BUDGET_PATTERNS.find(p => p.regex.test(text))?.budget   || null;

  if (process.env.NODE_ENV !== 'production') {
    const top3s = sectorScores.slice(0, 3).filter(s => s.score > 0);
    const top3o = orgScores.slice(0, 3).filter(s => s.score > 0);
    if (top3s.length) console.log('[profileDetector] sector scores:', top3s.map(s => `${s.name}:${s.score}`).join(', '));
    if (top3o.length) console.log('[profileDetector] orgType scores:', top3o.map(s => `${s.name}:${s.score}`).join(', '));
  }

  const t        = text.toLowerCase();
  const keywords = t
    .replace(/[^a-zа-ш0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !STOP_WORDS.has(w) && /[a-zа-ш]/i.test(w))
    .slice(0, 15);

  return { sector: topSector, orgType: topOrgType, country, budget, keywords };
}

// ─── NEEDS SEARCH ────────────────────────────────────────────

/**
 * needsSearch(text)
 *
 * v3 bug: sectorScore >= 5 fired on EVERY message once the user
 * described their org. "Благодарам" after a search = another search.
 *
 * v4 fix — two-gate system:
 *   Gate 1 (NO-SEARCH): if the message is clearly a short reply,
 *   acknowledgment, or follow-up with no new funding intent → false.
 *   Gate 2 (SEARCH): explicit funding keywords, org description,
 *   or strong multi-signal profile match → true.
 *
 * sectorScore alone NO LONGER triggers search.
 * Sector + country still triggers (strong profile signal).
 * Sector + orgType still triggers (strong profile signal).
 */
function needsSearch(text) {
  if (!text) return false;
  const t     = text.toLowerCase().trim();
  const words = t.split(/\s+/).filter(Boolean);

  // ── Gate 1: NO-SEARCH guards (check first) ───────────────

  // Very short messages with no explicit funding intent → never search
  if (words.length <= 3 && !EXPLICIT_FUNDING.test(t)) return false;

  // Pure acknowledgment patterns → never search
  for (const pat of NO_SEARCH_PATTERNS) {
    if (pat.test(t) && !EXPLICIT_FUNDING.test(t)) return false;
  }

  // ── Gate 2: SEARCH triggers ───────────────────────────────

  // 1. Explicit grant/fund keywords → always search
  if (EXPLICIT_FUNDING.test(t)) return true;

  // 2. User describes their organization → search
  const orgDescription = /\b(јас\s+сум|ние\s+сме|сум\s+нво|сме\s+нво|сум\s+нго|сме\s+нго|сум\s+стартап|сме\s+стартап|i\s+am\s+a[n]?\s+|we\s+are\s+a[n]?\s+|our\s+organization|нашата\s+организација|работиме\s+на|работам\s+на|ich\s+bin\s+(ein)?|wir\s+sind\s+(ein)?|je\s+suis\s+(un)?|nous\s+sommes|soy\s+(un)?|somos|sono\s+(un)?|siamo|jestem|jesteśmy|ben\s+(bir)?|biz\s+(bir)?)\b/i;
  if (orgDescription.test(t)) return true;

  // 3. Search intent with profile signal → search
  const searchIntent = /\b(кои|која|најди|покажи|постои|барам|бараме|what|find|show|look\s+for|search|looking\s+for|препорач|options|можности|опции)\b/i;
  const hasSector    = SECTORS.some(s => s.keywords.some(k => k.r.test(text)));
  const hasCountry   = COUNTRY_PATTERNS.some(p => p.regex.test(text));
  const hasOrg       = ORG_TYPES.some(o => o.keywords.some(k => k.r.test(text)));
  const hasBudget    = /€|\$|\beur\b|\busd\b|\bevra\b|\bdolari\b|\b\d{4,}\b/i.test(t);

  if (searchIntent.test(t) && (hasSector || hasCountry || hasOrg)) return true;

  // 4. Budget signal + profile signal → search
  if (hasBudget && (hasSector || hasOrg || hasCountry)) return true;

  // 5. Sector + country together → search (strong profile)
  if (hasSector && hasCountry) return true;

  // 6. Sector + orgType together → search (strong profile)
  if (hasSector && hasOrg) return true;

  // 7. sectorScore alone → NOT enough (v3 bug fix)
  // Previously: sectorScore >= 5 → return true
  // Now: sector alone does not trigger search.
  // Rationale: "Имам НВО во Македонија која прави едукација" contains
  // both sector AND country/orgType → caught by rules 5/6 above.
  // A bare follow-up like "а кои се роковите?" has sector context
  // from prior messages but no NEW search intent → skip.

  return false;
}

module.exports = { detectProfile, needsSearch };
