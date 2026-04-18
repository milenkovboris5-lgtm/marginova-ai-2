// ═══ SEARCH — Serper + TED ═══
function ft(url, opts = {}, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

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

function keywords(text) {
  const stop = new Set([
    'и','или','на','во','за','од','со','да','се','ми','си','ги','го','сакам','барам','имам','можеш','треба','кои','каде','кога',
    'the','and','or','for','in','of','to','a','an','is','i','ili','za','od','sa','da','je','su','na','u','mozes','imam','treba','kako','sto','koja'
  ]);
  return text.toLowerCase()
    .replace(/[^\w\s\u0400-\u04FF]/g,' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w))
    .slice(0, 4).join(' ');
}

// Serper — еден query, без site: restriction за подобри резултати
async function serperQuery(q, key, gl = 'en') {
  if (!q || !key) return [];
  try {
    const r = await ft('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
      body: JSON.stringify({ q, num: 5, gl })
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.organic || []).slice(0, 4).map(x => ({
      title: x.title || '',
      snippet: (x.snippet || '').slice(0, 200),
      link: x.link || '',
      date: x.date || ''
    }));
  } catch (e) {
    console.warn('[Serper]', e.message);
    return [];
  }
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

function sector(text) {
  const t = text.toLowerCase();
  if (/\bit\b|tech|software|дигитал|информатик/.test(t)) return 'IT технологија';
  if (/gradez|construction|градеж|градба/.test(t)) return 'градежништво';
  if (/zemjodelst|agri|земјоделст|рурал/.test(t)) return 'земјоделство';
  if (/startup|стартап|иновациј/.test(t)) return 'стартап иновации';
  if (/turiz|tourism|туриз/.test(t)) return 'туризам';
  if (/energi|energy|енерги|сончев|обновлив/.test(t)) return 'енергетика';
  if (/jaglen|јаглен|руда|mining/.test(t)) return 'рударство';
  if (/transport|логистик|превоз/.test(t)) return 'транспорт';
  if (/здравств|медицин|health/.test(t)) return 'здравство';
  if (/образов|education|училишт/.test(t)) return 'образование';
  return '';
}

async function scan(userText, intent, serperKey) {
  const c = country(userText);
  const kw = keywords(userText);
  const sec = sector(userText);
  const results = [];
  const seen = new Set();

  const add = (arr) => arr.forEach(r => {
    if (r.link && !seen.has(r.link)) { seen.add(r.link); results.push(r); }
  });

  console.log(`[SCAN] intent:${intent} country:${c} kw:"${kw}" sector:"${sec}"`);

  // Стратегија: повеќе queries, без строги site: ограничувања
  const promises = [];

  if (intent === 'grant') {
    const base = sec || kw;
    // Query 1: македонски јазик, широко
    promises.push(serperQuery(`${base} грант финансирање Македонија 2025`, serperKey, 'mk'));
    // Query 2: англиски, поширок индекс
    promises.push(serperQuery(`${base} grant fund Macedonia 2025`, serperKey, 'en'));
    // Query 3: специфични сајтови — посебни повици
    if (c === 'mk' || c === 'eu') {
      promises.push(serperQuery(`${base} site:fitr.mk OR site:westernbalkansfund.org`, serperKey, 'en'));
      promises.push(serperQuery(`${base} site:ec.europa.eu OR site:interreg.eu`, serperKey, 'en'));
    }
    if (['eu','de','fr','hr'].includes(c)) promises.push(ted(base));
  }

  if (intent === 'tender') {
    promises.push(serperQuery(`${kw} тендер јавна набавка Македонија`, serperKey, 'mk'));
    promises.push(serperQuery(`${kw} tender nabavka site:e-nabavki.gov.mk`, serperKey, 'en'));
    if (['eu','de','fr','hr','bg','ro'].includes(c)) promises.push(ted(kw));
  }

  if (intent === 'business') {
    const topic = sec || kw;
    promises.push(serperQuery(`${topic} оглас понуда Македонија`, serperKey, 'mk'));
    promises.push(serperQuery(`${topic} site:pazar3.mk OR site:oglasi.mk`, serperKey, 'mk'));
  }

  const arrays = await Promise.all(promises);
  arrays.flat().forEach(r => {
    if (r.link && !seen.has(r.link)) { seen.add(r.link); results.push(r); }
  });

  console.log(`[SCAN] total results: ${results.length}`);
  return results.slice(0, 6);
}

module.exports = { scan, country, keywords, sector };
