// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/profileDetector.js
// v2 — Improved accuracy. More sector patterns.
//      Better IT/Tech, NGO, Education, multi-language support.
//      needsSearch() more precise to reduce false positives.
// ═══════════════════════════════════════════════════════════

// ─── SECTOR PATTERNS ─────────────────────────────────────────
// Order matters — first match wins. More specific patterns first.

const SECTOR_PATTERNS = [
  {
    sector: 'Student / Youth',
    regex: /\bstudent\b|stipend|scholarship|fellowship|erasmus|fulbright|daad|chevening|mlad|youth|exchange\s+program|study\s+abroad|стипенд|студент|млад|stipendij/i,
  },
  {
    sector: 'IT / Technology',
    regex: /\bit\b|\btech\b|software|digital|ai\b|artificial\s+intelligence|вештачка\s+интелиген|blockchain|блокчејн|platform|aplikacija|web\s+app|mobile\s+app|startup|програмир|programming|coding|innovation|ict|дигитал|inovacij/i,
  },
  {
    sector: 'Environment / Energy',
    regex: /environment|climate|green|energy|renewable|solar|wind|biodiversity|ecosystem|conservation|природа|nature|wildlife|forest|water|sustainability|животна\s+средина|климатски|обновлив|екологи|zelena|okolina|ekolog/i,
  },
  {
    sector: 'Agriculture',
    regex: /agri|farm|rural|crop|livestock|hektar|ipard|земјоделс|земјоделство|фарм|рурал|zemjodelst|ipard|soil|irrigation/i,
  },
  {
    sector: 'Education',
    regex: /educat|school|youth\s+train|training\s+program|learning|образов|училиш|nastava|obrazov|учење|наставa|обука\s+за/i,
  },
  {
    sector: 'Civil Society',
    regex: /civil\s+society|ngo\b|nvo\b|nonprofit|non-profit|association|здружени|nevladin|невладин|здруж|граѓанско\s+општество|advocacy|human\s+rights/i,
  },
  {
    sector: 'Tourism / Culture',
    regex: /tourism|culture|heritage|creative|art\b|туризам|туризм|kultura|cultural|museum|festival/i,
  },
  {
    sector: 'Health / Social',
    regex: /health|medical|hospital|social\s+care|welfare|majki|семејст|gender|women|здравје|социјал|психолог|disability/i,
  },
  {
    sector: 'Research / Innovation',
    regex: /research|science|innovation\s+lab|university|academic|phd|истражув|иновац|наука|r&d|laboratory/i,
  },
  {
    sector: 'SME / Business',
    regex: /\bsme\b|small\s+business|company|enterprise|претпријати|фирма|компани|doo|dooel|дооел|бизнис|business\s+plan|revenue/i,
  },
];

// ─── ORG TYPE PATTERNS ───────────────────────────────────────
const ORG_PATTERNS = [
  {
    orgType: 'NGO / Association',
    regex: /\bngo\b|\bnvo\b|nonprofit|non-profit|association|foundation|civil\s+society|здруженије|здружени|невладин|fondacija/i,
  },
  {
    orgType: 'Agricultural holding',
    regex: /farmer|farm\b|agricultural|holding|ipard|земјоделс|фарм|земјоделско\s+стопанство/i,
  },
  {
    orgType: 'Individual / Entrepreneur',
    regex: /individual|freelance|self.employed|poedinec|creator|samostoen|поединец|самостоен|физичко\s+лице|fyzicko|personal\s+project/i,
  },
  {
    orgType: 'Startup',
    regex: /startup|start-up|early.stage|founder\b|co-founder/i,
  },
  {
    orgType: 'SME',
    regex: /\bsme\b|\bltd\b|\bdoo\b|\bdooel\b|small\s+business|дoo|дооел|medium\s+enterprise/i,
  },
  {
    orgType: 'Municipality / Public body',
    regex: /municipality|local\s+government|public\s+body|Општина|opstina|градот|grad\b/i,
  },
  {
    orgType: 'University / Research',
    regex: /university|research\s+institute|academic\s+institution|универзит|fakultet|institut/i,
  },
];

// ─── COUNTRY PATTERNS ────────────────────────────────────────
const COUNTRY_PATTERNS = [
  { country: 'North Macedonia', regex: /macedon|makedon|north\s+macedon|mkd|севerna|македон|северна|Skopje|скопје/i },
  { country: 'Serbia',          regex: /\bserbia\b|srbija|србија|Belgrade|Beograd/i },
  { country: 'Croatia',         regex: /croatia|hrvatska|Zagreb/i },
  { country: 'Bosnia',          regex: /\bbosnia\b|\bbih\b|босна|Sarajevo/i },
  { country: 'Bulgaria',        regex: /bulgaria|bulgar|бугарија|Sofia/i },
  { country: 'Albania',         regex: /\balkania\b|shqiperi|Tirana/i },
  { country: 'Kosovo',          regex: /\bkosovo\b|косово|Pristina/i },
  { country: 'Montenegro',      regex: /montenegro|crna\s+gora|Podgorica/i },
  { country: 'Slovenia',        regex: /\bslovenia\b|slovenija|Ljubljana/i },
  { country: 'Romania',         regex: /\bromania\b|românia|Bucharest/i },
  { country: 'Greece',          regex: /\bgreece\b|ελλάδα|Athens/i },
];

// ─── BUDGET PATTERNS ─────────────────────────────────────────
const BUDGET_PATTERNS = [
  { budget: 'above €500k',  regex: /[1-9]\d{0,2}[\s,.]?000[\s,.]?000|[1-9]\d?\s*million|милион|мил\b/i },
  { budget: '€150k–€500k',  regex: /[1-4]\d{2}[\s,.]?000|[1-4]\d{2}k\b|500[\s,.]?000|500k/i },
  { budget: '€30k–€150k',   regex: /[3-9]\d[\s,.]?000|[1-9]\d[\s,.]?000|[3-9]\dk\b|100k|150k/i },
  { budget: 'up to €30k',   regex: /[1-2]\d[\s,.]?000|[1-9][\s,.]?000\b|\b[1-9]k\b|20k|30k|мала\s+грант/i },
];

// ─── STOP WORDS (filtered from keywords) ─────────────────────
const STOP_WORDS = new Set([
  'about','where','which','would','could','their','there','what',
  'have','this','that','with','from','they','will','been','were',
  'сакате','дали','имаме','нема','треба','може','дека','нашата',
  'која','кои','најди','покажи','дали','постои','опции','можности',
  'hello','здраво','dear','from','your','the','and','for','not',
  'please','thank','благодарам','thanks','regards',
]);

/**
 * detectProfile(text)
 * Extracts user profile from current conversation text only.
 * Returns: { sector, orgType, country, budget, keywords }
 */
function detectProfile(text) {
  if (!text) return { sector: null, orgType: null, country: null, budget: null, keywords: [] };

  const t = text.toLowerCase();

  const sector  = SECTOR_PATTERNS.find(p => p.regex.test(text))?.sector   || null;
  const orgType = ORG_PATTERNS.find(p => p.regex.test(text))?.orgType     || null;
  const country = COUNTRY_PATTERNS.find(p => p.regex.test(text))?.country || null;
  const budget  = BUDGET_PATTERNS.find(p => p.regex.test(text))?.budget   || null;

  // Extract meaningful keywords (length > 4, not stop words, alphanumeric)
  const keywords = t
    .replace(/[^a-zа-ш0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !STOP_WORDS.has(w) && /[a-zа-ш]/i.test(w))
    .slice(0, 15);

  return { sector, orgType, country, budget, keywords };
}

/**
 * needsSearch(text)
 * Returns true when user is clearly asking for funding information.
 * More precise than v1 to reduce false positives on general chat.
 */
function needsSearch(text) {
  if (!text) return false;
  const t = text.toLowerCase();

  // Explicit funding/grant keywords
  const grantKeywords = /\b(grant|fund|financ|subsid|fellowship|scholarship|award|donor|program|open\s+call|call\s+for\s+proposal|invest|subvencij|finansi|podrsk|stipend|стипенд|грант|фонд|финансир|субвенц|грантови|програм)\b/;

  // Profile/context keywords
  const profileKeywords = /\b(nvo|ngo|здружени|organizacij|sektor|budzet|budget|okolina|ekolog|environment|civil|nevladin|opstina|firma|startup|pretprijatie|makedonija|srbija|kosovo|bosna|hrvatska)\b/;

  // Budget signals
  const hasBudget = /€|\$|eur|usd|mkd|\b\d{4,}\b|budzet|budget|iznos|amount|евра|долари/;

  // Search intent
  const searchIntent = /\b(која|кои|најди|покажи|има\s+ли|постои|which|what|find|show|give|look|search|дали|опции|options|можности|препорач)\b/;

  // Org description (user describing their org = likely wants funding)
  const orgDescription = /\b(јас\s+сум|we\s+are|our\s+organization|нашата\s+организација|работам\s+во|работаме|сум\s+нво|сум\s+нго|i\s+am\s+(a|an)\s+(ngo|startup|farmer|student|researcher))\b/i;

  return (
    grantKeywords.test(t) ||
    orgDescription.test(t) ||
    (profileKeywords.test(t) && hasBudget.test(t)) ||
    (searchIntent.test(t) && profileKeywords.test(t))
  );
}

module.exports = { detectProfile, needsSearch };
