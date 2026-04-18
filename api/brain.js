// ═══ BRAIN — SCAN → ANALYZE → EXECUTE ═══
const { scan } = require('./search');
const { build } = require('./prompt');

const INTENTS = {
  tender: ['тендер','набавка','оглас','конкурс','licitaci','tender','nabavka','oglas','procurement','ausschreibung','ihale'],
  grant:  ['грант','фонд','ipard','ipa','финансирање','финансиска','grant','grand','fond','finansiranje','startup','стартап','повик','fitr','horizon','erasmus','undp'],
  legal:  ['договор','закон','право','gdpr','даноци','ugovor','zakon','pravo','contract','legal','recht','licenca','statut'],
  analysis: ['анализа','swot','извештај','analiza','analysis'],
};

function intent(text) {
  const t = text.toLowerCase();
  for (const [k, words] of Object.entries(INTENTS)) {
    if (words.some(w => t.includes(w))) return k;
  }
  return 'business';
}

function ft(url, opts, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

async function geminiCall(prompt, userMessages, apiKey, maxTokens = 500) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const contents = userMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }]
  }));
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Start.' }] });

  const r = await ft(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: prompt }] },
      contents,
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
    })
  }, 25000);

  if (!r.ok) throw new Error(`Gemini ${r.status}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function analyze(results, userText, apiKey) {
  if (!results.length) return null;
  const list = results.map((r,i) => `${i+1}. ${r.title}\n   ${r.snippet}\n   ${r.link}`).join('\n\n');
  const p = `Analyze these opportunities for: "${userText}"\n\n${list}\n\nKeep only the best 1-2. For each: relevance (1 line), estimated value €, days to first action, main risk. Kill weak ones. Be brutal.`;
  try {
    return await geminiCall(p, [{ role: 'user', content: p }], null, 300);
  } catch { return null; }
}

async function run(userText, lang, today, messages, serperKey, apiKey, memory) {
  const det = intent(userText);
  const needsScan = ['tender','grant','business'].includes(det);

  // SCAN
  let results = [];
  if (needsScan && serperKey) {
    results = await scan(userText, det, serperKey);
  }

  // ANALYZE
  let analysis = null;
  if (results.length > 0 && apiKey) {
    const list = results.map((r,i) => `${i+1}. ${r.title} | ${r.snippet} | ${r.link}`).join('\n');
    const ap = `User needs: "${userText}"\nOpportunities:\n${list}\n\nKeep best 1-2. Give: value €, time days, risk. Kill weak ones.`;
    try {
      const ar = await ft(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: ap }] }],
            generationConfig: { maxOutputTokens: 300, temperature: 0.2 }
          })
        }, 10000
      );
      if (ar.ok) {
        const ad = await ar.json();
        analysis = ad.candidates?.[0]?.content?.parts?.[0]?.text || null;
      }
    } catch {}
    console.log(`[ANALYZE] ${analysis ? 'done' : 'failed'}`);
  }

  // EXECUTE
  let sysPrompt = build(lang, today, results, analysis);
  if (memory?.summary) sysPrompt += `\n\nContext: ${memory.summary}`;

  const text = await geminiCall(sysPrompt, messages, apiKey, 1200);
  return { text, intent: det };
}

module.exports = { run, intent };
