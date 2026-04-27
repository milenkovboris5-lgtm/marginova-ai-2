// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/profileDetector.js
// Extracts user profile ONLY from current conversation text.
// Zero Supabase. Zero history. Every session is a clean slate.
// ═══════════════════════════════════════════════════════════

const SECTOR_PATTERNS = [
  { sector: 'Environment / Energy',   regex: /environment|climate|green|energy|renewable|solar|wind|biodiversity|ecosystem|conservation|природа|nature|wildlife|forest|water|sustainability|животна средина|климатски|обновлив|екологи|zelena|okolina|ekolog/ },
  { sector: 'Student / Youth',        regex: /student|stipend|scholarship|fellowship|erasmus|fulbright|daad|chevening|mlad|youth|exchange|study abroad|стипенд|студент|млад/ },
  { sector: 'Agriculture',            regex: /agri|farm|rural|crop|livestock|hektar|ipard|земјоделс|земјоделство|фарм|рурал|zemjodelst|ipard/ },
  { sector: 'Education',              regex: /educat|school|youth|training|learning|образов|училиш|nastava|obrazov/ },
  { sector: 'Civil Society',          regex: /civil|ngo|nonprofit|association|society|здружени|nevladin|nvo|здруж/ },
  { sector: 'Tourism / Culture',      regex: /tourism|culture|heritage|creative|art|туризам|туризм|kultura/ },
  { sector: 'Health / Social',        regex: /health|medical|social|welfare|majki|семејст|gender|women|здравје|социјал/ },
  { sector: 'Research / Innovation',  regex: /research|science|innovation|university|academic|phd|истражув|иновац/ },
  { sector: 'IT / Technology',        regex: /\bit\b|tech|software|digital|technology|ai|вештачка|aplikacija|веб|web|platform|систем/ },
  { sector: 'SME / Business',         regex: /sme|small business|company|enterprise|startup|претпријати|фирма|компани/ },
];

const ORG_PATTERNS = [
  { orgType: 'NGO / Association',         regex: /\bngo\b|nonprofit|association|foundation|civil society|здруженије|здружени|nvo|невладин/ },
  { orgType: 'Agricultural holding',      regex: /farmer|farm|agricultural|holding|ipard|земјоделс|фарм/ },
  { orgType: 'Individual / Entrepreneur', regex: /individual|freelance|self.employed|poedinec|creator|samostoen|поединец|самостоен|физичко|fizicko/ },
  { orgType: 'Startup',                   regex: /startup/ },
  { orgType: 'SME',                       regex: /\bsme\b|\bltd\b|\bdoo\b|small business|дoo|дооел/ },
  { orgType: 'Municipality / Public body',regex: /municipality|local government|public body|општина|opstina/ },
  { orgType: 'University / Research',     regex: /university|research institute|academic|универзит/ },
];

const COUNTRY_PATTERNS = [
  { country: 'North Macedonia', regex: /macedon|makedon|north macedon|mkd|севerna|македон|северна/ },
  { country: 'Serbia',          regex: /\bserbia\b|srbija|србија/ },
  { country: 'Croatia',         regex: /croatia|hrvatska/ },
  { country: 'Bosnia',          regex: /\bbosnia\b|босна/ },
  { country: 'Bulgaria',        regex: /bulgaria|bulgar|бугарија/ },
  { country: 'Albania',         regex: /\balkania\b|shqiperi/ },
  { country: 'Kosovo',          regex: /\bkosovo\b|косово/ },
  { country: 'Montenegro',      regex: /montenegro|crna gora/ },
];

const BUDGET_PATTERNS = [
  { budget: 'above €500k',  regex: /1[\s,.]?000[\s,.]?000|1\s*million|милион/ },
  { budget: '€150k–€500k',  regex: /500[\s,.]?000|500k/ },
  { budget: '€30k–€150k',   regex: /100[\s,.]?000|100k|[5-9]\d[\s,.]?000/ },
  { budget: 'up to €30k',   regex: /[1-4]\d[\s,.]?000/ },
];

/**
 * detectProfile(text)
 * Input:  raw conversation text (current session only)
 * Output: { sector, orgType, country, budget, keywords }
 */
function detectProfile(text) {
  const t = (text || '').toLowerCase();

  const sector  = SECTOR_PATTERNS.find(p => p.regex.test(t))?.sector   || null;
  const orgType = ORG_PATTERNS.find(p => p.regex.test(t))?.orgType     || null;
  const country = COUNTRY_PATTERNS.find(p => p.regex.test(t))?.country || null;
  const budget  = BUDGET_PATTERNS.find(p => p.regex.test(t))?.budget   || null;

  const keywords = t
    .replace(/[^a-zа-ш0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && ![
      'about','where','which','would','could','their','there','what',
      'сакате','дали','имаме','нема','треба','може','дека','нашата'
    ].includes(w))
    .slice(0, 12);

  return { sector, orgType, country, budget, keywords };
}

/**
 * needsSearch(text)
 * Returns true when user is clearly asking for funding matches.
 */
function needsSearch(text) {
  const t = (text || '').toLowerCase();

  const grantKeywords = /grant|fund|financ|subsid|fellowship|scholarship|award|donor|ngo|program|open call|call for proposal|invest|subvencij|finansi|podrsk|stipend|student|youth|erasmus|fulbright|daad|chevening|stud|mlad|грант|фонд|финансир|субвенц|стипенд|студент|млад|грантови|програм/;
  const profileKeywords = /nvo|ngo|здруженије|здружени|organizacij|sektor|budzet|budget|okolina|ekolog|environment|civil|nevladin|opstina|firma|startup|pretprijatie|makedonija|srbija|kosovo|bosna|hrvatska/;
  const hasBudget = /€|\$|eur|usd|mkd|\b\d{4,}\b|budzet|budget|iznos|amount|евра|долари/;
  const searchIntent = /која|кои|најди|покажи|има ли|постои|which|what|find|show|give|look|search|дали|опции|options|можности/;

  return grantKeywords.test(t) ||
         (profileKeywords.test(t) && hasBudget.test(t)) ||
         (searchIntent.test(t) && profileKeywords.test(t));
}

module.exports = { detectProfile, needsSearch };
