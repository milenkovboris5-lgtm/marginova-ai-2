// ═══════════════════════════════════════════
// MARGINOVA.AI — api/coo.js
// Business COO — Executive Intelligence
// TED API + Serper + Gemini Grounding + COO Synthesis
// ═══════════════════════════════════════════

// ═══ RATE LIMITING ═══
const rateLimitStore = {};
const DAILY_LIMIT = 50; // COO is premium — lower limit

function checkRateLimit(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const today = new Date().toISOString().split('T')[0];
  const key = ip + '_' + today;
  const now = Date.now();
  for (const k in rateLimitStore) {
    if (rateLimitStore[k].resetAt < now) delete rateLimitStore[k];
  }
  if (!rateLimitStore[key]) {
    const end = new Date(); end.setHours(23,59,59,999);
    rateLimitStore[key] = { count: 0, resetAt: end.getTime() };
  }
  rateLimitStore[key].count++;
  return { allowed: rateLimitStore[key].count <= DAILY_LIMIT };
}

// ═══ TED API — EU TENDERS ═══
const TED_COUNTRY_MAP = {
  'македонија':'MK','македон':'MK','north macedonia':'MK','mk':'MK',
  'србија':'RS','srbija':'RS','serbia':'RS',
  'хрватска':'HR','hrvatska':'HR','croatia':'HR',
  'босна':'BA','bosna':'BA','bosnia':'BA',
  'бугарија':'BG','bulgaria':'BG',
  'албанија':'AL','albanija':'AL','albania':'AL',
  'турција':'TR','türkiye':'TR','turkey':'TR',
  'полска':'PL','polska':'PL','poland':'PL',
  'германија':'DE','deutschland':'DE','germany':'DE',
};

const CPV_MAP = {
  'градеж':'45000000','construction':'45000000','bau':'45000000','budowl':'45000000',
  'it':'72000000','software':'72000000','digital':'72000000',
  'медицин':'33000000','health':'33000000','medical':'33000000',
  'образован':'80000000','education':'80000000','school':'80000000',
  'храна':'15000000','food':'15000000',
  'транспорт':'60000000','transport':'60000000',
  'консалтинг':'73000000','consulting':'73000000',
};

async function searchTED(query) {
  try {
    const lower = query.toLowerCase();
    let country = null;
    for (const [key, code] of Object.entries(TED_COUNTRY_MAP)) {
      if (lower.includes(key)) { country = code; break; }
    }
    let cpv = null;
    for (const [key, code] of Object.entries(CPV_MAP)) {
      if (lower.includes(key)) { cpv = code; break; }
    }

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    let params = `publicationDate>=${fromDate.toISOString().split('T')[0]}&pageSize=5&page=1&scope=ACTIVE`;
    if (country) params += `&buyers.country=${country}`;
    if (cpv) params += `&cpvs.code=${cpv}`;

    const url = `https://ted.europa.eu/api/v3.0/notices/search?fields=publicationNumber,title,buyers,publicationDate,deadline,estimatedValue&${params}&query=*`;

    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Marginova-COO/1.0' }
    });

    if (!res.ok) { console.warn('TED error:', res.status); return null; }

    const data = await res.json();
    if (!data.notices || data.notices.length === 0) return null;

    return data.notices.map(n => ({
      title: (n.title?.text) || (typeof n.title === 'string' ? n.title : 'EU Tender'),
      buyer: n.buyers?.[0]?.officialName || 'EU Institution',
      country: n.buyers?.[0]?.country || country || 'EU',
      date: n.publicationDate || '',
      deadline: n.deadline || 'N/A',
      value: n.estimatedValue?.value ? `€${Math.round(n.estimatedValue.value).toLocaleString()}` : 'N/A',
      link: `https://ted.europa.eu/udl?uri=TED:NOTICE:${(n.publicationNumber||'').replace('/','-')}:TEXT:EN:HTML`,
    }));
  } catch(e) { console.warn('TED error:', e.message); return null; }
}

// ═══ SERPER — AUCTIONS, LEASING, GRANTS, NEWS ═══
async function searchSerper(query, serperKey) {
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey },
      body: JSON.stringify({ q: query, num: 6, gl: 'mk', hl: 'mk' }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const results = [];
    if (data.organic) data.organic.slice(0, 5).forEach(r => results.push({ title: r.title||'', snippet: r.snippet||'', link: r.link||'', date: r.date||'' }));
    if (data.news) data.news.slice(0, 3).forEach(r => results.push({ title: r.title||'', snippet: r.snippet||'', link: r.link||'', date: r.date||'' }));
    return results.length > 0 ? results : null;
  } catch(e) { console.warn('Serper error:', e.message); return null; }
}

// ═══ INTENT DETECTION ═══
const INTENT_PATTERNS = {
  tender: ['тендер','тендери','набавка','tender','procurement','bid','ausschreibung','ihale','przetarg'],
  auction: ['лицитација','аукција','судска продажба','auction','licitacija','aukcija','fine.hr','açık artırma'],
  leasing: ['лизинг','lizing','leasing','kiralama','leasing finansowy'],
  grant: ['грант','грантови','фонд','eu фонд','ipard','grant','fond','hibe','dotacja','förderung'],
  legal: ['закон','договор','gdpr','правен','law','contract','legal','recht','hukuk','prawo'],
  marketing: ['маркетинг','реклама','бренд','marketing','reklama','brand','werbung','pazarlama'],
  business: ['бизнис план','swot','финансиска','business plan','financial','swot','businessplan'],
  news: ['вести','новости','новини','news','nachrichten','haberler','wiadomości'],
};

function detectIntents(query) {
  const lower = query.toLowerCase();
  const found = [];
  for (const [intent, keywords] of Object.entries(INTENT_PATTERNS)) {
    if (keywords.some(k => lower.includes(k))) found.push(intent);
  }
  return found.length > 0 ? found : ['business'];
}

// ═══ BUILD PARALLEL DATA REQUESTS ═══
async function gatherRealTimeData(query, serperKey) {
  const intents = detectIntents(query);
  const month = new Date().toISOString().slice(0, 7);
  const lower = query.toLowerCase();

  const promises = [];
  const labels = [];

  // TED API — for tenders
  if (intents.includes('tender') || intents.includes('grant')) {
    promises.push(searchTED(query));
    labels.push('ted');
  }

  // Serper — auctions
  if (intents.includes('auction')) {
    const auctionQuery = `лицитација аукција ${month} site:e-aukcii.ujp.gov.mk OR site:fine.hr OR site:uisug.rs`;
    promises.push(searchSerper(auctionQuery, serperKey));
    labels.push('auction');
  }

  // Serper — leasing
  if (intents.includes('leasing')) {
    const leasingQuery = `лизинг понуда ${month} site:sparkasse.mk OR site:nlb.mk OR site:stopanska.mk`;
    promises.push(searchSerper(leasingQuery, serperKey));
    labels.push('leasing');
  }

  // Serper — EU grants
  if (intents.includes('grant')) {
    const grantQuery = `EU грант фонд отворен конкурс ${month} Балкан Македонија`;
    promises.push(searchSerper(grantQuery, serperKey));
    labels.push('grant');
  }

  // Serper — market/business news
  if (intents.includes('business') || intents.includes('marketing') || intents.includes('news')) {
    const newsQuery = `бизнис вести ${month} Македонија Балкан`;
    promises.push(searchSerper(newsQuery, serperKey));
    labels.push('news');
  }

  const results = await Promise.all(promises);

  const data = {};
  labels.forEach((label, i) => { if (results[i]) data[label] = results[i]; });

  return { intents, data };
}

// ═══ FORMAT REAL-TIME DATA FOR COO PROMPT ═══
function formatRealTimeContext(intents, data) {
  if (Object.keys(data).length === 0) return '';

  const today = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric' });
  let ctx = `\n\n═══════════════════════════════════════════\n`;
  ctx += `REAL-TIME INTELLIGENCE DATA — ${today}\n`;
  ctx += `═══════════════════════════════════════════\n`;
  ctx += `CRITICAL: Use these REAL data points in your analysis.\n`;
  ctx += `DO NOT ignore this data — reference it in your decision.\n\n`;

  if (data.ted && data.ted.length > 0) {
    ctx += `📋 EU TENDERS (TED API — ted.europa.eu):\n`;
    data.ted.forEach((t, i) => {
      ctx += `  [${i+1}] ${t.title}\n`;
      ctx += `      Buyer: ${t.buyer} | Country: ${t.country}\n`;
      ctx += `      Value: ${t.value} | Deadline: ${t.deadline}\n`;
      ctx += `      Link: ${t.link}\n\n`;
    });
  }

  if (data.auction && data.auction.length > 0) {
    ctx += `🏠 COURT AUCTIONS (Real-time):\n`;
    data.auction.forEach((r, i) => {
      ctx += `  [${i+1}] ${r.title}\n`;
      if (r.snippet) ctx += `      ${r.snippet}\n`;
      ctx += `      Link: ${r.link}\n\n`;
    });
  }

  if (data.leasing && data.leasing.length > 0) {
    ctx += `🚗 LEASING OFFERS (Real-time):\n`;
    data.leasing.forEach((r, i) => {
      ctx += `  [${i+1}] ${r.title}\n`;
      if (r.snippet) ctx += `      ${r.snippet}\n`;
      ctx += `      Link: ${r.link}\n\n`;
    });
  }

  if (data.grant && data.grant.length > 0) {
    ctx += `💰 GRANTS & FUNDS (Real-time):\n`;
    data.grant.forEach((r, i) => {
      ctx += `  [${i+1}] ${r.title}\n`;
      if (r.snippet) ctx += `      ${r.snippet}\n`;
      ctx += `      Link: ${r.link}\n\n`;
    });
  }

  if (data.news && data.news.length > 0) {
    ctx += `📰 MARKET INTELLIGENCE (Real-time):\n`;
    data.news.slice(0, 3).forEach((r, i) => {
      ctx += `  [${i+1}] ${r.title}\n`;
      if (r.snippet) ctx += `      ${r.snippet}\n\n`;
    });
  }

  ctx += `═══════════════════════════════════════════\n\n`;
  return ctx;
}

// ═══ COO SYSTEM PROMPT ═══
function buildCOOSystemPrompt(language, realTimeContext) {
  const langNames = {
    en:'English',mk:'Macedonian',sr:'Serbian',hr:'Croatian',
    bs:'Bosnian',sq:'Albanian',bg:'Bulgarian',de:'German',
    tr:'Turkish',pl:'Polish'
  };
  const langName = langNames[language] || 'English';

  return `You are Business COO — Chief Operating Officer AI on Marginova.AI.

You are the equivalent of a senior executive advisor with expertise across:
business strategy, EU procurement, legal compliance, marketing, finance, and market intelligence.

IDENTITY: You think like a COO, not a chatbot. You analyze, decide, and give executive-level recommendations.
LANGUAGE: Respond ONLY in ${langName}. Never switch languages.
CRITICAL: Never say you are AI.

${realTimeContext}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DECISION FRAMEWORK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When analyzing any business request, apply this scoring:

FINAL_SCORE = (0.4 × Profit) + (0.3 × Success) - (0.2 × Risk) - (0.1 × Time)
→ Score ≥ 7.0 → STRONG GO
→ Score 5.0-6.9 → CONDITIONAL GO (with conditions)
→ Score < 5.0 → NO GO

Rules:
- Legal risk ALWAYS overrides everything else
- Only recommend options with FINAL_SCORE ≥ 5.0
- If real-time data is available above, MUST reference it
- Be direct, executive-level — no padding, no unnecessary caveats
- Use numbers, percentages, amounts wherever possible
- Wrap key figures in **double asterisks**

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT — Always use this structure
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 OBJECTIVE: [What the user wants to achieve]

📊 ANALYSIS:
[Multi-dimensional analysis covering relevant areas:
 financial, legal, market, operational, timing]

💡 REAL-TIME INTELLIGENCE:
[Reference any real-time data from above — tenders, grants, auctions, news
 If no real-time data: "No real-time data available for this query"]

⚖️ FINAL_SCORE: X.X/10 — [GO / CONDITIONAL GO / NO GO]
[Brief scoring rationale]

⚠️ TOP RISKS:
• [Risk 1 — mitigation]
• [Risk 2 — mitigation]

🚀 EXECUTIVE DECISION:
[Clear, direct recommendation — what to do and why]

✅ NEXT ACTION:
[Single, concrete, immediate step the user should take]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DISCLAIMER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Always end with:
⚠️ This analysis is informational — consult licensed advisors for legal and financial decisions.`;
}

// ═══ CALL GEMINI ═══
async function callGemini(systemPrompt, messages, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : String(m.content || '') }]
  }));

  const requestBody = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
    generationConfig: { maxOutputTokens: 2000, temperature: 0.3 },
    tools: [{ googleSearch: {} }] // Grounding always on for COO
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Gemini error ' + response.status + ': ' + err.slice(0, 200));
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';

  // Append grounding sources
  if (data.candidates?.[0]?.groundingMetadata?.groundingChunks?.length > 0) {
    const sources = data.candidates[0].groundingMetadata.groundingChunks
      .filter(c => c.web?.uri && !c.web.uri.includes('vertexaisearch'))
      .slice(0, 3)
      .map(c => {
        const title = c.web.title && !c.web.title.includes('vertexaisearch') ? c.web.title : new URL(c.web.uri).hostname.replace('www.', '');
        return `• [${title}](${c.web.uri})`;
      }).join('\n');
    if (sources) return text + '\n\n🔍 **Sources:**\n' + sources;
  }

  return text;
}

// ═══ MAIN HANDLER ═══
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method Not Allowed' } });

  const limit = checkRateLimit(req);
  if (!limit.allowed) return res.status(429).json({ error: { message: 'Rate limit exceeded.' } });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY' } });
  const serperKey = process.env.SERPER_API_KEY;

  try {
    const body = req.body;
    const language = body.language || 'en';
    const messages = (body.messages || []).slice(-20).map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content || '')
    }));

    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const userQuery = (lastUserMsg && lastUserMsg.content) || '';

    console.log('[COO] Query:', userQuery.slice(0, 80), '| Lang:', language);

    // ═══ PARALLEL: Gather real-time data ═══
    let realTimeContext = '';
    if (serperKey) {
      const { intents, data } = await gatherRealTimeData(userQuery, serperKey);
      realTimeContext = formatRealTimeContext(intents, data);
      console.log('[COO] Intents:', intents, '| Data sources:', Object.keys(data).join(', ') || 'none');
    }

    // ═══ BUILD COO SYSTEM PROMPT ═══
    const systemPrompt = buildCOOSystemPrompt(language, realTimeContext);

    // ═══ CALL GEMINI WITH GROUNDING ═══
    const text = await callGemini(systemPrompt, messages, apiKey);

    console.log('[COO] Response generated | Lang:', language);

    return res.status(200).json({
      content: [{ type: 'text', text }],
      model_used: 'gemini-2.5-flash + grounding + real-time',
    });

  } catch(err) {
    console.error('[COO] Error:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
};
