// ═══════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// Верзија: Hybrid v8 — Gemini + Grounding + Serper + TED API + COO AI
// ═══════════════════════════════════════════

const rateLimitStore = {};
const DAILY_LIMIT = 150;

function getRateLimitKey(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
  const today = new Date().toISOString().split('T')[0];
  return ip + '_' + today;
}

function checkRateLimit(req) {
  const key = getRateLimitKey(req);
  const now = Date.now();
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  for (const k in rateLimitStore) {
    if (rateLimitStore[k].resetAt < now) delete rateLimitStore[k];
  }
  if (!rateLimitStore[key]) {
    rateLimitStore[key] = { count: 0, resetAt: end.getTime() };
  }
  rateLimitStore[key].count += 1;
  return { allowed: rateLimitStore[key].count <= DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - rateLimitStore[key].count) };
}

// ═══════════════════════════════════════════
// МОДЕЛ ROUTING
// ═══════════════════════════════════════════
const AVATAR_MODEL_MAP = {
  eva:         { model: 'gemini-2.5-flash', grounding: true,  serper: true  },
  tenderai:    { model: 'gemini-2.5-flash', grounding: true,  serper: true  },
  dropshipper: { model: 'gemini-2.5-flash', grounding: true,  serper: false },
  businessai:  { model: 'gemini-2.5-flash', grounding: true,  serper: false },
  justinian:   { model: 'gemini-2.5-flash', grounding: true,  serper: false },
  leo:         { model: 'gemini-2.5-flash', grounding: false, serper: false },
  liber:       { model: 'gemini-2.5-flash', grounding: false, serper: false },
  creativeai:  { model: 'gemini-2.5-flash', grounding: true,  serper: false },
  cooai:       { model: 'gemini-2.5-flash', grounding: true,  serper: true  },
  default:     { model: 'gemini-2.5-flash', grounding: false, serper: false },
};

function getAvatarConfig(avatar) {
  return AVATAR_MODEL_MAP[avatar] || AVATAR_MODEL_MAP.default;
}

// ═══════════════════════════════════════════
// TED API — EU ТЕНДЕРИ
// ═══════════════════════════════════════════
const TED_COUNTRY_MAP = {
  'македонија': 'MK', 'македон': 'MK', 'north macedonia': 'MK', 'mk': 'MK',
  'србија': 'RS', 'srbija': 'RS', 'serbia': 'RS',
  'хрватска': 'HR', 'hrvatska': 'HR', 'croatia': 'HR',
  'босна': 'BA', 'bosna': 'BA', 'bosnia': 'BA',
  'бугарија': 'BG', 'bulgaria': 'BG',
  'албанија': 'AL', 'albanija': 'AL', 'albania': 'AL',
  'турција': 'TR', 'türkiye': 'TR', 'turkey': 'TR',
  'полска': 'PL', 'polska': 'PL', 'poland': 'PL',
  'германија': 'DE', 'deutschland': 'DE', 'germany': 'DE',
};

const CPV_MAP = {
  'градеж': '45000000', 'фасад': '45000000', 'construction': '45000000', 'fasad': '45000000',
  'it': '72000000', 'software': '72000000',
  'медицин': '33000000', 'health': '33000000',
  'образован': '80000000', 'education': '80000000',
  'транспорт': '60000000', 'transport': '60000000',
};

async function searchTED(userText) {
  try {
    const lower = userText.toLowerCase();
    let country = null;
    for (const [key, code] of Object.entries(TED_COUNTRY_MAP)) {
      if (lower.includes(key)) { country = code; break; }
    }
    let cpv = null;
    for (const [key, code] of Object.entries(CPV_MAP)) {
      if (lower.includes(key)) { cpv = code; break; }
    }
    const today = new Date();
    const fromDate = new Date(today);
    fromDate.setDate(today.getDate() - 30);
    let queryParts = [];
    if (country) queryParts.push(`buyers.country=${country}`);
    if (cpv) queryParts.push(`cpvs.code=${cpv}`);
    queryParts.push(`publicationDate>=${fromDate.toISOString().split('T')[0]}`);
    queryParts.push('query=*');
    const tedUrl = `https://ted.europa.eu/api/v3.0/notices/search?fields=publicationNumber,title,buyers,publicationDate,deadline,estimatedValue,cpvs&pageSize=5&page=1&scope=ACTIVE&${queryParts.join('&')}`;
    const response = await fetch(tedUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Marginova-AI/1.0' }
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.notices || data.notices.length === 0) return null;
    return data.notices.map(n => ({
      title: (n.title?.text) || (typeof n.title === 'string' ? n.title : 'EU Tender'),
      buyer: n.buyers?.[0]?.officialName || 'EU Institution',
      country: n.buyers?.[0]?.country || country || 'EU',
      date: n.publicationDate || '',
      deadline: n.deadline || '',
      value: n.estimatedValue?.value ? `€${Math.round(n.estimatedValue.value).toLocaleString()}` : 'N/A',
      link: `https://ted.europa.eu/udl?uri=TED:NOTICE:${(n.publicationNumber||'').replace('/','-')}:TEXT:EN:HTML`,
    }));
  } catch (e) {
    console.warn('TED error:', e.message);
    return null;
  }
}

function formatTEDResults(results) {
  if (!results || results.length === 0) return '';
  const today = new Date().toLocaleDateString('mk-MK', { day:'2-digit', month:'2-digit', year:'numeric' });
  let ctx = `\n\n═══ РЕАЛНИ EU ТЕНДЕРИ — TED — ${today} ═══\n`;
  ctx += `КРИТИЧНО: Прикажи ги САМО овие реални тендери. НЕ измислувај нови.\n\n`;
  results.forEach((r, i) => {
    ctx += `ТЕНДЕР ${i+1}:\n  Наслов: ${r.title}\n  Купувач: ${r.buyer}\n  Земја: ${r.country}\n`;
    ctx += `  Објавен: ${r.date}\n`;
    if (r.deadline) ctx += `  Рок: ${r.deadline}\n`;
    ctx += `  Вредност: ${r.value}\n  Линк: ${r.link}\n\n`;
  });
  ctx += `═══ КРАЈ НА РЕАЛНИ РЕЗУЛТАТИ ═══\n`;
  ctx += `Прикажи ги горните тендери со нивните ТОЧНИ линкови. НЕ додавај фиктивни линкови.\n`;
  return ctx;
}

// ═══════════════════════════════════════════
// SERPER
// ═══════════════════════════════════════════
const TENDER_KEYWORDS = [
  'тендер','тендери','набавка','набавки','јавна набавка','конкурс','оглас',
  'пребарај тендер','најди тендер','активни тендери',
  'tender','tenderi','nabavka','nabavki','javna nabavka','konkurs','oglas',
  'pronajdi tender','aktivni tenderi','najdi tender','prebaraj tender',
  'procurement','bid','rfp','rfq','ausschreibung','ihale','przetarg',
  'fasadni radovi','fasadni raboti','gradezni raboti','gradezni radovi',
  'izvedba na','izvedba fasada','izgradnja','rekonstrukcija','sanacija',
  'fasada tender','gradez tender','construction tender','javna nabavka',
];

const PRIVATE_KEYWORDS = [
  'приватна понуда','приватни понуди','бизнис понуда','деловна понуда',
  'подизведувач','соработка','партнерство','договор за изведба',
  'баратели','барат фирма','барат компанија','потребна фирма',
  'privatna ponuda','privatne ponude','biznis ponuda','poslovna ponuda',
  'podizvođač','podizvođac','saradnja','partnerstvo','ugovor za izvedbu',
  'traže firmu','traže kompaniju','potrebna firma','potreban izvodjac',
  'b2b','subcontracting','private offer','business offer','partnership offer',
  'outsourcing','freelance','podugovaranje','suradnja',
];

const AUCTION_KEYWORDS = [
  'лицитација','аукција','судска продажба','licitacija','aukcija','auction',
  'licytacja','търг','судска лицитација','javna licitacija','bankrot','stecaj','stečaj',
];
const LEASING_KEYWORDS = ['лизинг','lizing','leasing','lease','лизинг откуп','lizing otkup'];
const EVA_KEYWORDS = [
  'грант','грантови','фонд','eu фонд','ipard','ipa','grant','grantovi',
  'fond','fondovi','grants','funds','subsidy','förderung','hibe','dotacja',
];

function detectIntent(userText) {
  const lower = userText.toLowerCase();
  if (AUCTION_KEYWORDS.some(k => lower.includes(k))) return 'auction';
  if (LEASING_KEYWORDS.some(k => lower.includes(k))) return 'leasing';
  if (EVA_KEYWORDS.some(k => lower.includes(k))) return 'grants';
  if (PRIVATE_KEYWORDS.some(k => lower.includes(k))) return 'private';
  if (TENDER_KEYWORDS.some(k => lower.includes(k))) return 'tender';
  if (lower.match(/pronajdi|najdi|prebaraj|find|search|potrazi|pobari/)) return 'tender';
  return null;
}

function buildSerperQuery(userText, avatar, intent) {
  const lower = userText.toLowerCase();
  const month = new Date().toISOString().slice(0, 7);

  if (intent === 'auction') {
    const auctionSites = {
      'македонија': 'site:e-aukcii.ujp.gov.mk OR site:sud.mk',
      'македон': 'site:e-aukcii.ujp.gov.mk OR site:sud.mk',
      'srbija': 'site:uisug.rs OR site:sud.rs',
      'србија': 'site:uisug.rs OR site:sud.rs',
      'hrvatska': 'site:fine.hr OR site:e-aukcija.hr',
      'хрватска': 'site:fine.hr OR site:e-aukcija.hr',
    };
    let siteFilter = 'site:e-aukcii.ujp.gov.mk OR site:fine.hr OR site:uisug.rs';
    for (const [key, val] of Object.entries(auctionSites)) {
      if (lower.includes(key)) { siteFilter = val; break; }
    }
    let assetType = 'лицитација имот возило опрема';
    if (lower.match(/недвижност|апартман|куќа|имот|nekretnina|stan/)) assetType = 'лицитација недвижност';
    else if (lower.match(/возило|автомобил|камион|vozilo/)) assetType = 'лицитација возила';
    return `${assetType} ${month} ${siteFilter}`;
  }

  if (intent === 'leasing') {
    return `лизинг понуда ${month} site:sparkasse.mk OR site:stopanska.mk OR site:nlb.mk`;
  }

  if (intent === 'grants' || avatar === 'eva') {
    let countryTag = '"Western Balkans" OR Balkans OR Europe';
    let countryPortals = 'site:mk.undp.org OR site:westernbalkansfund.org OR site:efb.org OR site:ipard.gov.mk OR site:usaid.gov OR site:fitr.mk OR site:funding.mk OR site:ec.europa.eu OR site:avrm.gov.mk';

    if (lower.match(/македон|makedon|severna|north mac/)) {
      countryTag = 'North Macedonia Makedonija';
      countryPortals = 'site:fitr.mk OR site:funding.mk OR site:westernbalkansfund.org';
    } else if (lower.match(/srbij|србиј|serbia/)) {
      countryTag = 'Srbija Serbia';
      countryPortals = 'site:privreda.gov.rs OR site:westernbalkansfund.org OR site:rs.undp.org';
    } else if (lower.match(/hrvat|хрват|croatia/)) {
      countryTag = 'Hrvatska Croatia';
      countryPortals = 'site:strukturnifondovi.hr OR site:westernbalkansfund.org OR site:apprrr.hr';
    } else if (lower.match(/bosn|босн|bosnia/)) {
      countryTag = 'Bosna Bosnia';
      countryPortals = 'site:eu.ba OR site:westernbalkansfund.org OR site:ba.undp.org';
    } else if (lower.match(/бугар|bulgar|bugars/)) {
      countryTag = 'Bulgaria Bulgarija';
      countryPortals = 'site:eufunds.bg OR site:bg.undp.org OR site:ec.europa.eu';
    } else if (lower.match(/албан|albania|shqip/)) {
      countryTag = 'Albania Shqiperi';
      countryPortals = 'site:financa.gov.al OR site:westernbalkansfund.org OR site:al.undp.org';
    } else if (lower.match(/türkiy|turkey|turkiye|turska|турциj/)) {
      countryTag = 'Turkiye Turkey';
      countryPortals = 'site:kosgeb.gov.tr OR site:tkdk.gov.tr OR site:tr.undp.org';
    } else if (lower.match(/deutsch|german|almanij/)) {
      countryTag = 'Deutschland Germany';
      countryPortals = 'site:foerderdatenbank.de OR site:kfw.de OR site:bafa.de';
    } else if (lower.match(/polsk|poland|polska/)) {
      countryTag = 'Polska Poland';
      countryPortals = 'site:parp.gov.pl OR site:funduszeeuropejskie.gov.pl OR site:ec.europa.eu';
    } else if (lower.match(/kosovo|косов|kosov/)) {
      countryTag = 'Kosovo Kosove';
      countryPortals = 'site:ks.undp.org OR site:westernbalkansfund.org OR site:pprc.rks-gov.net';
    } else if (lower.match(/slovenij|slovenia|слов/)) {
      countryTag = 'Slovenija Slovenia';
      countryPortals = 'site:eu-skladi.si OR site:spirit.si OR site:ec.europa.eu';
    }

    let sectorTag = 'grant fond otvoreni poziv finansiranje';
    if (lower.match(/it |it\.|дигитал|digital|software|веб|web|app|едукативн|edukativ|online/)) sectorTag = 'IT digital startup grant financiranje';
    else if (lower.match(/ipard|земјоделств|agri|poljopriv|фарм|farm/)) sectorTag = 'IPARD grant zemjodelstvo agri';
    else if (lower.match(/стартап|startup|иновац|inovac|pretpriemac/)) sectorTag = 'startup inovacije grant finansiranje';
    else if (lower.match(/нго|ngo|невладин|civilno|граѓанск/)) sectorTag = 'NVO civilno drustvo grant';
    else if (lower.match(/млад|youth|omladina/)) sectorTag = 'mladi youth grant';
    else if (lower.match(/жен|women|rodova|претприемач.*жен/)) sectorTag = 'zene preduzetnistvo grant';
    else if (lower.match(/градеж|construction|fasad|gradez/)) sectorTag = 'gradjevinarstvo infrastruktura grant';
    else if (lower.match(/земјоделств|agri|poljopriv/)) sectorTag = 'zemjodelstvo ruralni razvoj IPARD';
    else if (lower.match(/туризм|tourism|ugostitel/)) sectorTag = 'turizam ugostitelstvo grant';

    return `${sectorTag} ${countryTag} ${countryPortals}`;
  }

  if (intent === 'private') {
    let sector = 'biznis ponuda oglasi';
    if (lower.match(/градеж|фасад|fasad|gradez|fasada|construction|rekonstrukcija/)) sector = 'fasadni raboti gradezni podizvođač oglasi';
    else if (lower.match(/ит|it |software|digital|програм|web|app/)) sector = 'IT outsourcing softver razvoj ponuda';
    else if (lower.match(/транспорт|transport|превоз|prevoz|kamion|logistics/)) sector = 'transport prevoz logistika ponuda ugovor';
    else if (lower.match(/производств|manufacturing|fabrik|production/)) sector = 'proizvodnja manufacturing ugovor ponuda';
    else if (lower.match(/угостителств|restoran|catering|hotel|hospitality/)) sector = 'ugostiteljstvo catering dostava ponuda';
    else if (lower.match(/земјоделств|agri|poljopriv|farmа/)) sector = 'poljoprivreda otkup produce ugovor ponuda';
    else if (lower.match(/медицин|health|medical|pharma/)) sector = 'medicinа zdravstvo oprema ponuda';
    else if (lower.match(/трговија|retail|veleprodaja|wholesale/)) sector = 'veleprodaja retail ponuda distributor';
    else if (lower.match(/енергетик|energy|solar|renewable/)) sector = 'energia solar obnovljiva ponuda ugovor';

    let countryFilter = '';
    if (lower.match(/македон|makedon/)) countryFilter = 'site:pazar3.mk OR site:biznis.mk OR site:oglasi.mk OR site:facebook.com';
    else if (lower.match(/srbij|србиј/)) countryFilter = 'site:halo.rs OR site:oglasi.rs OR site:facebook.com';
    else if (lower.match(/hrvat|хрват/)) countryFilter = 'site:njuskalo.hr OR site:facebook.com';
    else if (lower.match(/bosn|босн/)) countryFilter = 'site:facebook.com OR site:oglasi.ba';
    else countryFilter = 'site:pazar3.mk OR site:halo.rs OR site:njuskalo.hr OR site:linkedin.com';

    return `${sector} ${month} ${countryFilter}`;
  }

  const countryMap = {
    'македонија': 'site:e-nabavki.gov.mk', 'македон': 'site:e-nabavki.gov.mk',
    'makedonija': 'site:e-nabavki.gov.mk', 'makedon': 'site:e-nabavki.gov.mk',
    'severna': 'site:e-nabavki.gov.mk', 'north mac': 'site:e-nabavki.gov.mk',
    'srbija': 'site:portal.ujn.gov.rs', 'србија': 'site:portal.ujn.gov.rs', 'serbia': 'site:portal.ujn.gov.rs',
    'hrvatska': 'site:eojn.hr', 'хрватска': 'site:eojn.hr', 'croatia': 'site:eojn.hr',
    'bosna': 'site:ejn.ba', 'босна': 'site:ejn.ba', 'bosnia': 'site:ejn.ba',
    'bugarska': 'site:app.eop.bg', 'бугарија': 'site:app.eop.bg', 'bulgaria': 'site:app.eop.bg',
    'albanija': 'site:app.e-albania.al', 'albania': 'site:app.e-albania.al',
    'shqiperi': 'site:app.e-albania.al', 'shqip': 'site:app.e-albania.al',
    'türkiye': 'site:ihale.gov.tr', 'turkey': 'site:ihale.gov.tr', 'turska': 'site:ihale.gov.tr',
    'турција': 'site:ihale.gov.tr',
    'polska': 'site:ezamowienia.gov.pl', 'poland': 'site:ezamowienia.gov.pl',
    'полска': 'site:ezamowienia.gov.pl',
    'deutschland': 'site:ted.europa.eu', 'germany': 'site:ted.europa.eu',
    'германија': 'site:ted.europa.eu',
    'kosovo': 'site:pprc.rks-gov.net', 'косово': 'site:pprc.rks-gov.net',
    'slovenija': 'site:ejn.si', 'slovenia': 'site:ejn.si',
    'eu': 'site:ted.europa.eu', 'europe': 'site:ted.europa.eu',
  };

  const siteFilters = [];
  for (const [key, val] of Object.entries(countryMap)) {
    if (lower.includes(key) && !siteFilters.includes(val)) siteFilters.push(val);
  }
  const siteFilter = siteFilters.length > 0
    ? siteFilters.join(' OR ')
    : 'site:e-nabavki.gov.mk OR site:portal.ujn.gov.rs';

  let sector = 'tender javna nabavka';
  if (lower.match(/градеж|фасад|fasad|gradez|fasada|construction|rekonstrukcija|реконструкц/)) sector = 'fasadni raboti gradezni rekonstrukcija fasada';
  else if (lower.match(/ит|it|software|digital|програм|softver/)) sector = 'IT softver usluge';
  else if (lower.match(/медицин|health|болниц|medical|lekovi/)) sector = 'medicinska oprema zdravstvo';
  else if (lower.match(/транспорт|transport|vozila|vozilo/)) sector = 'transport vozila';
  else if (lower.match(/храна|hrana|food|namirnice/)) sector = 'hrana prehrambeni proizvodi';
  else if (lower.match(/образован|school|училишт|skola|edukacija/)) sector = 'obrazovanje skola';
  else if (lower.match(/опрема|oprema|equipment/)) sector = 'oprema masini';

  return `${sector} ${month} ${siteFilter}`;
}

async function searchSerper(query, serperKey) {
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey },
      body: JSON.stringify({ q: query, num: 10, gl: 'mk', hl: 'mk' }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const results = [];
    if (data.organic) data.organic.slice(0, 6).forEach(r => results.push({ title: r.title||'', snippet: r.snippet||'', link: r.link||'', date: r.date||'' }));
    if (data.news) data.news.slice(0, 3).forEach(r => results.push({ title: r.title||'', snippet: r.snippet||'', link: r.link||'', date: r.date||'' }));
    return results.length > 0 ? results : null;
  } catch (e) { return null; }
}

function formatSerperContext(results, intent) {
  if (!results || results.length === 0) return '';
  const today = new Date().toLocaleDateString('mk-MK', { day:'2-digit', month:'2-digit', year:'numeric' });
  const label = intent === 'auction' ? 'ЛИЦИТАЦИИ' : intent === 'leasing' ? 'ЛИЗИНГ' : intent === 'grants' ? 'ГРАНТОВИ' : intent === 'private' ? 'ПРИВАТНИ ПОНУДИ' : 'ТЕНДЕРИ';
  let ctx = `\n\n═══ РЕАЛНИ ${label} — ${today} ═══\n`;
  ctx += `КРИТИЧНО: Прикажи САМО овие реални резултати со ТОЧНИТЕ линкови.\n`;
  ctx += `ЗАБРАНЕТО: Не додавај фиктивни линкови, не измислувај тендери, не генерирај примери.\n\n`;
  results.forEach((r, i) => {
    ctx += `РЕЗУЛТАТ ${i+1}:\n  Наслов: ${r.title}\n`;
    if (r.date) ctx += `  Датум: ${r.date}\n`;
    if (r.snippet) ctx += `  Опис: ${r.snippet}\n`;
    ctx += `  Линк: ${r.link}\n\n`;
  });
  ctx += `═══ КРАЈ НА РЕАЛНИ РЕЗУЛТАТИ ═══\n`;
  ctx += `Анализирај ги горните резултати. Ако некој резултат не е директно релевантен, кажи тоа.\n`;
  ctx += `Секогаш завршувај со ⚠️ disclaimer и линк до официјален портал.\n`;
  return ctx;
}

function formatNoResults(intent, lang) {
  const portals = {
    tender: 'e-nabavki.gov.mk · portal.ujn.gov.rs · ted.europa.eu',
    auction: 'e-aukcii.ujp.gov.mk · fine.hr · uisug.rs',
    grants: 'mk.undp.org · ec.europa.eu/info/funding-tenders · ipard.gov.mk',
    leasing: 'sparkasse.mk · stopanska.mk · nlb.mk',
    private: 'pazar3.mk · biznis.mk · halo.rs · njuskalo.hr · linkedin.com',
  };
  const portal = portals[intent] || portals.tender;
  return `\n\n═══ НЕМА РЕАЛНИ РЕЗУЛТАТИ ═══\n` +
    `Пребарувањето не врати активни огласи за ова барање.\n` +
    `ЗАДОЛЖИТЕЛНО: Кажи му на корисникот дека нема реални резултати.\n` +
    `НЕ ИЗМИСЛУВАЈ тендери, линкови или примери!\n` +
    `Препорачај ги следниве официјални портали: ${portal}\n` +
    `═══════════════════════════════════════\n`;
}

// ═══ PREMIUM TRIGGERS ═══
const PREMIUM_TRIGGERS = [
  'најди грант','најди тендер','направи договор','правен совет','аплицирај',
  'nađi grant','nađi tender','napravi ugovor','pravni savet',
  'find grant','find tender','make contract','legal advice',
  'business plan','financial projection','find me a grant','apply for',
];
const PREMIUM_AVATARS = ['eva','tenderai','justinian','businessai','dropshipper','cooai'];

function isPremiumTrigger(message, avatar) {
  const lower = (message || '').toLowerCase();
  if (PREMIUM_AVATARS.includes(avatar)) {
    return PREMIUM_TRIGGERS.some(t => lower.includes(t));
  }
  return false;
}

async function generatePreview(systemPrompt, messages, apiKey, isMK) {
  const previewPrompt = systemPrompt + '\n\nВАЖНО: Дај само КРАТОК почеток (максимум 3 реченици). Не завршувај го одговорот.';
  const preview = await callGemini('gemini-2.5-flash', false, previewPrompt, messages, false, null, null, null, apiKey);
  const locked = isMK
    ? `\n\n---\n🔒 **За целосен одговор потребен е Premium план**\n\n**[⚡ Отклучи Premium →](#upgrade)**`
    : `\n\n---\n🔒 **Full answer requires Premium plan**\n\n**[⚡ Unlock Premium →](#upgrade)**`;
  return preview + locked;
}

// ═══ GEMINI API ═══
async function callGemini(model, useGrounding, systemPrompt, messages, hasImage, imageData, imageType, imageText, apiKey) {
  const isGemma = model.startsWith('gemma');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : String(m.content || '') }]
  }));

  if (hasImage && imageData) {
    const lastText = imageText || 'Please analyze this image carefully and respond helpfully.';
    const historyWithoutLast = contents.slice(0, -1);
    contents.length = 0;
    contents.push(...historyWithoutLast);
    contents.push({ role: 'user', parts: [{ inline_data: { mime_type: imageType || 'image/jpeg', data: imageData } }, { text: lastText }] });
  }

  const requestBody = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
    generationConfig: { maxOutputTokens: 3000, temperature: 0.3 }
  };

  if (useGrounding && !isGemma) requestBody.tools = [{ googleSearch: {} }];

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text();
    if (isGemma && (response.status === 404 || response.status === 400)) {
      console.warn('Gemma unavailable, fallback to Flash');
      return callGemini('gemini-2.5-flash', false, systemPrompt, messages, hasImage, imageData, imageType, imageText, apiKey);
    }
    throw new Error('API error ' + response.status + ': ' + errText.slice(0, 200));
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Gemini API error');

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';

  if (useGrounding && data.candidates?.[0]?.groundingMetadata?.groundingChunks?.length > 0) {
    const sources = data.candidates[0].groundingMetadata.groundingChunks
      .filter(c => c.web?.uri && !c.web.uri.includes('vertexaisearch'))
      .slice(0, 3)
      .map(c => {
        const title = c.web.title && !c.web.title.includes('vertexaisearch') ? c.web.title : new URL(c.web.uri).hostname.replace('www.', '');
        return '• [' + title + '](' + c.web.uri + ')';
      }).join('\n');
    if (sources) return text + '\n\n🔍 **Извори:**\n' + sources;
  }

  return text;
}

// ═══════════════════════════════════════════
// COO AI — ДЕТЕКЦИЈА НА ЈАЗИК
// ═══════════════════════════════════════════
function detectLang(text) {
  const lower = text.toLowerCase();
  if (/[а-шА-Ш]/.test(text)) {
    // Cyrillic — разликувај МК / SR / BG
    if (/ќ|ѓ|ѕ|љ|њ| џ/i.test(text)) return 'mk';
    if (/ћ|ђ|џ/i.test(text)) return 'sr';
    if (/ъ|ю|я/i.test(text)) return 'bg';
    return 'mk'; // default cyrillic
  }
  if (lower.match(/\b(und|oder|ist|haben|werden|können|ich|sie|wir)\b/)) return 'de';
  if (lower.match(/\b(dhe|është|janë|për|nga|me|të|një)\b/)) return 'sq';
  if (lower.match(/\b(jest|są|się|nie|dla|przez|który|będzie)\b/)) return 'pl';
  if (lower.match(/\b(ve|bir|bu|için|ile|olan|var|da|de)\b/)) return 'tr';
  if (lower.match(/\b(sam|smo|ste|su|ili|kao|što|koji|koja)\b/)) return 'sr';
  if (lower.match(/\b(sem|smo|ste|so|ali|kot|kar|ki)\b/)) return 'sl';
  if (lower.match(/\b(sam|smo|ste|su|ili|kao|što|koji|koja|bosn)\b/)) return 'bs';
  if (lower.match(/\b(sam|smo|ste|su|ili|kao|što|koji|koja|hrvatska)\b/)) return 'hr';
  return 'en';
}

// ═══════════════════════════════════════════
// COO AI — ЛОКАЛИЗИРАНИ ТЕКСТОВИ
// ═══════════════════════════════════════════
const COO_LABELS = {
  mk: {
    title: '🎯 ИЗВРШНА АНАЛИЗА — COO AI',
    request: 'Барање',
    date: 'Датум',
    scoreTitle: '📊 ОЦЕНА НА МОЖНОСТА',
    totalScore: 'Вкупна оцена',
    aspects: ['Бизнис потенцијал', 'EU/Финансирање', 'Тендер можности', 'Правна подготвеност'],
    aspect: 'Аспект', score: 'Оцена', comment: 'Коментар',
    oppsTitle: '✅ ТОП МОЖНОСТИ (само активни)',
    riskTitle: '⚠️ РИЗИК ФАКТОРИ',
    risk: 'Ризик', level: 'Ниво', rec: 'Препорака',
    high: '🔴 Висок', medium: '🟡 Среден', low: '🟢 Низок',
    stepsTitle: '🚀 СЛЕДНИ ЧЕКОРИ (приоритетни)',
    urgent: 'Итно (оваа недела)',
    short: 'Краткорочно (овој месец)',
    long: 'Долгорочно',
    langInstruction: 'Одговори САМО на македонски јазик.',
    errorMsg: 'не одговори',
  },
  sr: {
    title: '🎯 IZVRŠNA ANALIZA — COO AI',
    request: 'Zahtev',
    date: 'Datum',
    scoreTitle: '📊 OCENA MOGUĆNOSTI',
    totalScore: 'Ukupna ocena',
    aspects: ['Poslovni potencijal', 'EU/Finansiranje', 'Tender mogućnosti', 'Pravna spremnost'],
    aspect: 'Aspekt', score: 'Ocena', comment: 'Komentar',
    oppsTitle: '✅ TOP MOGUĆNOSTI (samo aktivne)',
    riskTitle: '⚠️ FAKTORI RIZIKA',
    risk: 'Rizik', level: 'Nivo', rec: 'Preporuka',
    high: '🔴 Visok', medium: '🟡 Srednji', low: '🟢 Nizak',
    stepsTitle: '🚀 SLEDEĆI KORACI (prioritetni)',
    urgent: 'Hitno (ove nedelje)',
    short: 'Kratkoročno (ovog meseca)',
    long: 'Dugoročno',
    langInstruction: 'Odgovori SAMO na srpskom jeziku.',
    errorMsg: 'nije odgovorio',
  },
  hr: {
    title: '🎯 IZVRŠNA ANALIZA — COO AI',
    request: 'Zahtjev',
    date: 'Datum',
    scoreTitle: '📊 OCJENA MOGUĆNOSTI',
    totalScore: 'Ukupna ocjena',
    aspects: ['Poslovni potencijal', 'EU/Financiranje', 'Natječajne mogućnosti', 'Pravna spremnost'],
    aspect: 'Aspekt', score: 'Ocjena', comment: 'Komentar',
    oppsTitle: '✅ TOP MOGUĆNOSTI (samo aktivne)',
    riskTitle: '⚠️ ČIMBENICI RIZIKA',
    risk: 'Rizik', level: 'Razina', rec: 'Preporuka',
    high: '🔴 Visok', medium: '🟡 Srednji', low: '🟢 Nizak',
    stepsTitle: '🚀 SLJEDEĆI KORACI (prioritetni)',
    urgent: 'Hitno (ovog tjedna)',
    short: 'Kratkoročno (ovog mjeseca)',
    long: 'Dugoročno',
    langInstruction: 'Odgovori SAMO na hrvatskom jeziku.',
    errorMsg: 'nije odgovorio',
  },
  bs: {
    title: '🎯 IZVRŠNA ANALIZA — COO AI',
    request: 'Zahtjev',
    date: 'Datum',
    scoreTitle: '📊 OCJENA MOGUĆNOSTI',
    totalScore: 'Ukupna ocjena',
    aspects: ['Poslovni potencijal', 'EU/Finansiranje', 'Tender mogućnosti', 'Pravna spremnost'],
    aspect: 'Aspekt', score: 'Ocjena', comment: 'Komentar',
    oppsTitle: '✅ TOP MOGUĆNOSTI (samo aktivne)',
    riskTitle: '⚠️ FAKTORI RIZIKA',
    risk: 'Rizik', level: 'Nivo', rec: 'Preporuka',
    high: '🔴 Visok', medium: '🟡 Srednji', low: '🟢 Nizak',
    stepsTitle: '🚀 SLJEDEĆI KORACI (prioritetni)',
    urgent: 'Hitno (ove sedmice)',
    short: 'Kratkoročno (ovog mjeseca)',
    long: 'Dugoročno',
    langInstruction: 'Odgovori SAMO na bosanskom jeziku.',
    errorMsg: 'nije odgovorio',
  },
  en: {
    title: '🎯 EXECUTIVE ANALYSIS — COO AI',
    request: 'Request',
    date: 'Date',
    scoreTitle: '📊 OPPORTUNITY SCORE',
    totalScore: 'Total Score',
    aspects: ['Business potential', 'EU/Funding', 'Tender opportunities', 'Legal readiness'],
    aspect: 'Aspect', score: 'Score', comment: 'Comment',
    oppsTitle: '✅ TOP OPPORTUNITIES (active only)',
    riskTitle: '⚠️ RISK FACTORS',
    risk: 'Risk', level: 'Level', rec: 'Recommendation',
    high: '🔴 High', medium: '🟡 Medium', low: '🟢 Low',
    stepsTitle: '🚀 NEXT STEPS (priority)',
    urgent: 'Urgent (this week)',
    short: 'Short-term (this month)',
    long: 'Long-term',
    langInstruction: 'Respond ONLY in English.',
    errorMsg: 'did not respond',
  },
  de: {
    title: '🎯 EXEKUTIVANALYSE — COO AI',
    request: 'Anfrage',
    date: 'Datum',
    scoreTitle: '📊 BEWERTUNG DER MÖGLICHKEIT',
    totalScore: 'Gesamtbewertung',
    aspects: ['Geschäftspotenzial', 'EU/Finanzierung', 'Ausschreibungsmöglichkeiten', 'Rechtliche Bereitschaft'],
    aspect: 'Aspekt', score: 'Bewertung', comment: 'Kommentar',
    oppsTitle: '✅ TOP MÖGLICHKEITEN (nur aktive)',
    riskTitle: '⚠️ RISIKOFAKTOREN',
    risk: 'Risiko', level: 'Stufe', rec: 'Empfehlung',
    high: '🔴 Hoch', medium: '🟡 Mittel', low: '🟢 Niedrig',
    stepsTitle: '🚀 NÄCHSTE SCHRITTE (prioritär)',
    urgent: 'Dringend (diese Woche)',
    short: 'Kurzfristig (diesen Monat)',
    long: 'Langfristig',
    langInstruction: 'Antworte NUR auf Deutsch.',
    errorMsg: 'hat nicht geantwortet',
  },
  sq: {
    title: '🎯 ANALIZA EKZEKUTIVE — COO AI',
    request: 'Kërkesa',
    date: 'Data',
    scoreTitle: '📊 VLERËSIMI I MUNDËSISË',
    totalScore: 'Vlerësimi total',
    aspects: ['Potenciali i biznesit', 'BE/Financimi', 'Mundësitë e tenderit', 'Gatishmëria ligjore'],
    aspect: 'Aspekti', score: 'Vlerësimi', comment: 'Koment',
    oppsTitle: '✅ MUNDËSITË KRYESORE (vetëm aktive)',
    riskTitle: '⚠️ FAKTORËT E RREZIKUT',
    risk: 'Rrezik', level: 'Niveli', rec: 'Rekomandim',
    high: '🔴 I lartë', medium: '🟡 Mesatar', low: '🟢 I ulët',
    stepsTitle: '🚀 HAPAT E ARDHSHËM (prioritare)',
    urgent: 'Urgjente (këtë javë)',
    short: 'Afatshkurtër (këtë muaj)',
    long: 'Afatgjatë',
    langInstruction: 'Përgjigju VETËM në gjuhën shqipe.',
    errorMsg: 'nuk u përgjigj',
  },
  bg: {
    title: '🎯 ИЗПЪЛНИТЕЛЕН АНАЛИЗ — COO AI',
    request: 'Запитване',
    date: 'Дата',
    scoreTitle: '📊 ОЦЕНКА НА ВЪЗМОЖНОСТТА',
    totalScore: 'Обща оценка',
    aspects: ['Бизнес потенциал', 'ЕС/Финансиране', 'Тръжни възможности', 'Правна готовност'],
    aspect: 'Аспект', score: 'Оценка', comment: 'Коментар',
    oppsTitle: '✅ ТОП ВЪЗМОЖНОСТИ (само активни)',
    riskTitle: '⚠️ РИСКОВИ ФАКТОРИ',
    risk: 'Риск', level: 'Ниво', rec: 'Препоръка',
    high: '🔴 Висок', medium: '🟡 Среден', low: '🟢 Нисък',
    stepsTitle: '🚀 СЛЕДВАЩИ СТЪПКИ (приоритетни)',
    urgent: 'Спешно (тази седмица)',
    short: 'Краткосрочно (този месец)',
    long: 'Дългосрочно',
    langInstruction: 'Отговаряй САМО на български език.',
    errorMsg: 'не отговори',
  },
  tr: {
    title: '🎯 YÖNETİCİ ANALİZİ — COO AI',
    request: 'Talep',
    date: 'Tarih',
    scoreTitle: '📊 FIRSAT DEĞERLENDİRMESİ',
    totalScore: 'Toplam puan',
    aspects: ['İş potansiyeli', 'AB/Finansman', 'İhale fırsatları', 'Hukuki hazırlık'],
    aspect: 'Konu', score: 'Puan', comment: 'Yorum',
    oppsTitle: '✅ EN İYİ FIRSATLAR (yalnızca aktif)',
    riskTitle: '⚠️ RİSK FAKTÖRLERİ',
    risk: 'Risk', level: 'Seviye', rec: 'Öneri',
    high: '🔴 Yüksek', medium: '🟡 Orta', low: '🟢 Düşük',
    stepsTitle: '🚀 SONRAKİ ADIMLAR (öncelikli)',
    urgent: 'Acil (bu hafta)',
    short: 'Kısa vadeli (bu ay)',
    long: 'Uzun vadeli',
    langInstruction: 'YALNIZCA Türkçe yanıt ver.',
    errorMsg: 'yanıt vermedi',
  },
  pl: {
    title: '🎯 ANALIZA WYKONAWCZA — COO AI',
    request: 'Zapytanie',
    date: 'Data',
    scoreTitle: '📊 OCENA MOŻLIWOŚCI',
    totalScore: 'Ocena ogólna',
    aspects: ['Potencjał biznesowy', 'UE/Finansowanie', 'Możliwości przetargowe', 'Gotowość prawna'],
    aspect: 'Aspekt', score: 'Ocena', comment: 'Komentarz',
    oppsTitle: '✅ NAJLEPSZE MOŻLIWOŚCI (tylko aktywne)',
    riskTitle: '⚠️ CZYNNIKI RYZYKA',
    risk: 'Ryzyko', level: 'Poziom', rec: 'Zalecenie',
    high: '🔴 Wysokie', medium: '🟡 Średnie', low: '🟢 Niskie',
    stepsTitle: '🚀 KOLEJNE KROKI (priorytetowe)',
    urgent: 'Pilne (w tym tygodniu)',
    short: 'Krótkoterminowo (w tym miesiącu)',
    long: 'Długoterminowo',
    langInstruction: 'Odpowiadaj TYLKO po polsku.',
    errorMsg: 'nie odpowiedział',
  },
};

// ═══════════════════════════════════════════
// COO AI — SYSTEM PROMPTS ЗА СЕКОЈ СПЕЦИЈАЛИСТ (со јазична инструкција)
// ═══════════════════════════════════════════
function getCOOSpecialistPrompts(langCode) {
  const L = COO_LABELS[langCode] || COO_LABELS.en;
  return {
    businessai: `You are Business AI — top business strategist. Analyze the situation from a business perspective.
Provide: SWOT elements, financial risks, market opportunities, competitive analysis, action recommendations.
Be concrete and brief — maximum 200 words. Focus on the most important factors.
${L.langInstruction}`,

    eva: `You are Eva — EU funds and grants expert. Analyze available financing opportunities.
Provide: relevant grants and funds, deadlines, amounts, eligibility criteria, risks of non-compliance.
If no active calls found, clearly state that. Be concrete — maximum 200 words.
${L.langInstruction}`,

    tenderai: `You are Tender AI — public procurement expert. Analyze tender opportunities.
Provide: active tenders in the sector, deadlines, estimated values, competitiveness, risks.
FILTER expired deadlines — show ONLY active ones. Be concrete — maximum 200 words.
${L.langInstruction}`,

    justinian: `You are Justinian — top legal advisor. Analyze the legal situation.
Provide: legal risks, required permits/licenses, contractual obligations, GDPR/compliance, recommendations.
Be concrete and practical — maximum 200 words. Avoid unnecessary legal jargon.
${L.langInstruction}`,
  };
}

// ═══════════════════════════════════════════
// COO AI — ГЛАВНА ФУНКЦИЈА
// ═══════════════════════════════════════════
async function runCOOAI(userText, messages, serperKey, apiKey, forceLang) {
  const langCode = forceLang || detectLang(userText);
  const L = COO_LABELS[langCode] || COO_LABELS.en;
  const today = new Date().toLocaleDateString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric' });

  console.log('[cooai] Starting multi-agent analysis | lang:', langCode, '| text:', userText.slice(0, 80));

  // ═══ Чекор 1: Паралелни повици до 4 специјалисти ═══
  const specialistMessages = [{ role: 'user', content: userText }];
  const SPECIALIST_PROMPTS = getCOOSpecialistPrompts(langCode);

  const specialistCalls = Object.entries(SPECIALIST_PROMPTS).map(async ([name, prompt]) => {
    try {
      let enrichedPrompt = prompt;

      if (name === 'tenderai' && serperKey) {
        const intent = detectIntent(userText) || 'tender';
        const query = buildSerperQuery(userText, 'tenderai', intent);
        const results = await searchSerper(query, serperKey);
        if (results && results.length > 0) enrichedPrompt += formatSerperContext(results, intent);
      }

      if (name === 'eva' && serperKey) {
        const query = buildSerperQuery(userText, 'eva', 'grants');
        const results = await searchSerper(query, serperKey);
        if (results && results.length > 0) enrichedPrompt += formatSerperContext(results, 'grants');
      }

      const response = await callGemini(
        'gemini-2.5-flash',
        name === 'businessai' || name === 'justinian',
        enrichedPrompt,
        specialistMessages,
        false, null, null, null,
        apiKey
      );

      console.log(`[cooai] ${name} done (${langCode}): ${response.length} chars`);
      return { name, response };
    } catch (e) {
      console.warn(`[cooai] ${name} failed:`, e.message);
      return { name, response: `⚠️ ${name} ${L.errorMsg}.` };
    }
  });

  const results = await Promise.all(specialistCalls);

  // ═══ Чекор 2: Синтеза — COO финален извештај ═══
  const specialistSummary = results.map(r =>
    `═══ ${r.name.toUpperCase()} ═══\n${r.response}`
  ).join('\n\n');

  const cooSynthesisPrompt = `You are COO AI — Chief Operating Officer of Marginova.AI. You received analyses from 4 specialists.

YOUR TASK:
1. Synthesize the 4 analyses into one clean final report
2. EXCLUDE: expired deadlines, irrelevant info, repetitions
3. KEEP: only active opportunities, real facts, concrete actions

MANDATORY REPORT FORMAT (use exactly this structure):

## ${L.title}
**${L.request}:** ${userText}
**${L.date}:** ${today}

---

## ${L.scoreTitle}
**${L.totalScore}: X/10** ⭐

| ${L.aspect} | ${L.score} | ${L.comment} |
|---|---|---|
| ${L.aspects[0]} | X/10 | ... |
| ${L.aspects[1]} | X/10 | ... |
| ${L.aspects[2]} | X/10 | ... |
| ${L.aspects[3]} | X/10 | ... |

---

## ${L.oppsTitle}
1. **[Opportunity 1]** — [details, deadline if exists]
2. **[Opportunity 2]** — [details]
3. **[Opportunity 3]** — [details]

---

## ${L.riskTitle}
| ${L.risk} | ${L.level} | ${L.rec} |
|---|---|---|
| [Risk 1] | ${L.high} / ${L.medium} / ${L.low} | [action] |
| [Risk 2] | ... | ... |

---

## ${L.stepsTitle}
1. **${L.urgent}:** ...
2. **${L.short}:** ...
3. **${L.long}:** ...

---

SPECIALIST ANALYSES:
${specialistSummary}

CRITICAL: ${L.langInstruction} Be concrete and actionable. Do NOT invent links or deadlines.`;

  const finalReport = await callGemini(
    'gemini-2.5-flash',
    false,
    cooSynthesisPrompt,
    [{ role: 'user', content: 'Generate the final COO report now.' }],
    false, null, null, null,
    apiKey
  );

  console.log('[cooai] Final report generated (', langCode, '):', finalReport.length, 'chars');
  return finalReport;
}

// ═══════════════════════════════════════════
// ГЛАВЕН HANDLER
// ═══════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method Not Allowed' } });

  const limit = checkRateLimit(req);
  if (!limit.allowed) return res.status(429).json({ error: { message: 'Дневниот лимит е достигнат. Обидете се утре.' } });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY' } });
  const serperKey = process.env.SERPER_API_KEY;

  try {
    const body = req.body;
    const avatar = body.avatar || 'default';
    const hasImage = !!body.image;
    const systemPrompt = body.system || '';
    const userPlan = body.plan || 'free';

    const avatarConfig = getAvatarConfig(avatar);
    const model = avatarConfig.model;
    const useGrounding = avatarConfig.grounding;
    const useSerper = avatarConfig.serper && !!serperKey;

    const messages = (body.messages || []).slice(-20).map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content :
        Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ') :
        String(m.content)
    }));

    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const userText = (lastUserMsg && lastUserMsg.content) || '';
    const isMK = /[а-шА-Ш]/.test(userText);
    // Lang од frontend (поверлив) — fallback на auto-detect
    const frontendLang = body.lang || null;

    // Premium check
    if (userPlan === 'free' && isPremiumTrigger(userText, avatar)) {
      const previewText = await generatePreview(systemPrompt, messages, apiKey, isMK);
      return res.status(200).json({ content: [{ type: 'text', text: previewText }], premium_required: true, remaining_messages: limit.remaining });
    }

    // ═══ COO AI — MULTI-AGENT ═══
    if (avatar === 'cooai') {
      console.log('[cooai] Activating multi-agent mode | lang:', frontendLang || 'auto');
      // COO AI добива само тековната порака — без претходна историја
      const cooMessages = [{ role: 'user', content: userText }];
      const cooReport = await runCOOAI(userText, cooMessages, serperKey, apiKey, frontendLang);
      return res.status(200).json({
        content: [{ type: 'text', text: cooReport }],
        model_used: 'cooai-multi-agent',
        remaining_messages: limit.remaining
      });
    }

    let enrichedSystemPrompt = systemPrompt;

    // ═══ TENDER AI ═══
    if (useSerper && avatar === 'tenderai') {
      const intent = detectIntent(userText);
      if (intent) {
        let found = false;

        if (intent === 'tender') {
          const tedResults = await searchTED(userText);
          if (tedResults && tedResults.length > 0) {
            enrichedSystemPrompt = systemPrompt + formatTEDResults(tedResults);
            found = true;
            console.log('[tenderai] TED:', tedResults.length, 'results');
          }
        }

        if (!found) {
          const query = buildSerperQuery(userText, avatar, intent);
          console.log('[tenderai] Serper query:', query);
          let serperResults = await searchSerper(query, serperKey);

          if (!serperResults || serperResults.length === 0) {
            const month = new Date().toISOString().slice(0, 7);
            const fallbackQuery = `tender javna nabavka fasada gradez ${month} Macedonia Srbija site:e-nabavki.gov.mk OR site:portal.ujn.gov.rs OR site:ted.europa.eu`;
            console.log('[tenderai] Fallback query:', fallbackQuery);
            serperResults = await searchSerper(fallbackQuery, serperKey);
          }

          if (serperResults && serperResults.length > 0) {
            enrichedSystemPrompt = systemPrompt + formatSerperContext(serperResults, intent);
            found = true;
            console.log('[tenderai] Serper:', serperResults.length, 'results');
          }
        }

        if (!found) {
          enrichedSystemPrompt = systemPrompt + formatNoResults(intent, isMK ? 'mk' : 'en');
          console.log('[tenderai] No results found for intent:', intent);
        }
      }
    }

    // ═══ EVA ═══
    if (useSerper && avatar === 'eva') {
      const intent = detectIntent(userText);
      const evaIntent = intent || 'grants';
      if (true) {
        const query = buildSerperQuery(userText, 'eva', evaIntent === 'grants' || !intent ? 'grants' : evaIntent);
        console.log('[eva] Serper query:', query);
        let serperResults = await searchSerper(query, serperKey);

        if (!serperResults || serperResults.length === 0) {
          const month = new Date().toISOString().slice(0, 7);
          const fallback = `grant fond otvoreni poziv ${month} Makedonija Western Balkans site:mk.undp.org OR site:westernbalkansfund.org OR site:fitr.mk OR site:funding.mk`;
          console.log('[eva] Fallback query:', fallback);
          serperResults = await searchSerper(fallback, serperKey);
        }

        if (serperResults && serperResults.length > 0) {
          enrichedSystemPrompt = systemPrompt + formatSerperContext(serperResults, 'grants');
          console.log('[eva] Serper:', serperResults.length, 'results');
        } else {
          enrichedSystemPrompt = systemPrompt + formatNoResults('grants', isMK ? 'mk' : 'en');
        }
      }
    }

    console.log(`[${avatar} + ${model}${useGrounding ? ' + Grounding' : ''}]`);

    const text = await callGemini(model, useGrounding, enrichedSystemPrompt, messages, hasImage, body.image, body.imageType, body.imageText, apiKey);

    return res.status(200).json({
      content: [{ type: 'text', text }],
      model_used: model,
      remaining_messages: limit.remaining
    });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
};
