// ═══ SEARCH — Serper + TED ═══
const TIMEOUT = 8000;

function ft(url, opts = {}, ms = TIMEOUT) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

// Земја од текст
function country(text) {
  const t = text.toLowerCase();
  if (/македон|makedon/.test(t)) return 'mk';
  if (/србиј|srbij/.test(t)) return 'rs';
  if (/хрват|hrvat/.test(t)) return 'hr';
  if (/босн|bosn/.test(t)) return 'ba';
  if (/бугар|bulgar/.test(t)) return 'bg';
  if (/романиј|roman/.test(t)) return 'ro';
  if (/грциј|greec/.test(t)) return 'gr';
  if (/турциј|turk/.test(t)) return 'tr';
  if (/германиј|german|deutsch/.test(t)) return 'de';
  if (/франциј|franc/.test(t)) return 'fr';
  if (/шпаниј|spain/.test(t)) return 'es';
  if (/\beu\b|европ|europ/.test(t)) return 'eu';
  return 'mk';
}

// Клучни зборови
function keywords(text) {
  const stop = new Set(['и','или','на','во','за','од','со','да','се','ми','си','ги','го','сакам','барам','имам','можеш','треба',
    'the','and','or','for','in','of','to','a','an','is','i','ili','za','od','sa','da','je','su','na','u','mozes','imam','treba']);
  return text.toLowerCase().replace(/[^\w\s\u0400-\u04FF]/g,' ')
    .split(/\s+/).filter(w => w.length > 2 && !stop.has(w)).slice(0,4).join(' ');
}

// Сајтови по земја
const TENDER_SITES = {
  mk: 'site:e-nabavki.gov.mk OR site:pazar3.mk',
  rs: 'site:portal.ujn.gov.rs OR site:halo.rs',
  hr: 'site:eojn.nn.hr', ba: 'site:ejn.ba',
  bg: 'site:app.eop.bg', ro: 'site:e-licitatie.ro',
  gr: 'site:promitheus.gov.gr', tr: 'site:ekap.kik.gov.tr',
  de: 'site:ted.europa.eu', fr: 'site:ted.europa.eu OR site:boamp.fr',
  es: 'site:contrataciondelestado.es', eu: 'site:ted.europa.eu',
};
const GRANT_SITES = {
  mk: 'site:fitr.mk OR site:ipard.gov.mk OR site:mk.undp.org OR site:westernbalkansfund.org',
  rs: 'site:inovacionifond.rs OR site:apr.gov.rs',
  de: 'site:foerderdatenbank.de OR site:bmbf.de',
  fr: 'site:bpifrance.fr', eu: 'site:ec.europa.eu OR site:interreg.eu',
};

async function serper(query, key, gl = 'mk') {
  if (!query || !key) return [];
  try {
    const r = await ft('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
      body: JSON.stringify({ q: query, num: 5, gl })
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.organic || []).slice(0,3).map(x => ({
      title: x.title || '', snippet: (x.snippet || '').slice(0,150),
      link: x.link || '', date: x.date || ''
    }));
  } catch { return []; }
}

async function ted(query) {
  try {
    const url = `https://ted.europa.eu/api/v3.0/notices/search?fields=ND,TI,DT,CY&q=${encodeURIComponent(query)}&limit=3`;
    const r = await ft(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.notices || d.results || []).slice(0,3).map(n => ({
      title: n.TI?.text || 'EU Tender',
      snippet: n.TD?.text || '',
      link: `https://ted.europa.eu/udl?uri=TED:NOTICE:${n.ND}:TEXT:EN:HTML`,
      date: n.DT || '', country: n.CY?.text || 'EU'
    }));
  } catch { return []; }
}

async function scan(userText, intent, serperKey) {
  const c = country(userText);
  const kw = keywords(userText);
  const results = [];

  // Sector за грантови
  const lower = userText.toLowerCase();
  const sector = /it|tech|software|дигитал/.test(lower) ? 'IT' :
    /gradez|construction|градеж/.test(lower) ? 'construction' :
    /zemjodelst|agri|земјоделст/.test(lower) ? 'agriculture' :
    /startup|стартап/.test(lower) ? 'startup' :
    /turiz|tourism/.test(lower) ? 'tourism' : kw.split(' ')[0];

  const promises = [];

  if (intent === 'tender') {
    const site = TENDER_SITES[c] || TENDER_SITES.mk;
    promises.push(serper(`${kw} tender nabavka ${site}`, serperKey, c));
    if (['eu','de','fr','hr','bg','ro'].includes(c)) promises.push(ted(kw));
  }

  if (intent === 'grant') {
    const site = GRANT_SITES[c] || GRANT_SITES.mk;
    promises.push(serper(`${sector} grant funding 2025 ${site}`, serperKey, c === 'eu' ? 'en' : c));
    if (['eu','de','fr'].includes(c)) promises.push(ted(`${sector} grant`));
  }

  if (intent === 'business') {
    const site = TENDER_SITES[c] || TENDER_SITES.mk;
    promises.push(serper(`${kw} ${site}`, serperKey, c));
  }

  const arrays = await Promise.all(promises);
  const seen = new Set();
  arrays.flat().forEach(r => {
    if (r.link && !seen.has(r.link)) { seen.add(r.link); results.push(r); }
  });

  console.log(`[SCAN] intent:${intent} country:${c} kw:"${kw}" results:${results.length}`);
  return results.slice(0,5);
}

module.exports = { scan, country, keywords };
