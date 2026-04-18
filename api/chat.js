// ═══ MARGINOVA.AI — api/chat.js ═══
const { checkIP, checkUser, increment } = require('./api/quota');
const { load, save } = require('./api/memory');
const { run } = require('./api/brain');

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

function ft(url, opts = {}, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

async function supa(table, params, method = 'GET') {
  const headers = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
  if (method === 'GET') {
    const q = Object.entries(params).filter(([k]) => !['select','limit'].includes(k))
      .map(([k,v]) => `${k}=eq.${v}`).join('&');
    const sel = params.select ? `&select=${params.select}` : '';
    const lim = params.limit ? `&limit=${params.limit}` : '';
    const r = await ft(`${SUPA_URL}/rest/v1/${table}?${q}${sel}${lim}&order=created_at.desc`, { headers: { ...headers, Prefer: '' } });
    return r.ok ? r.json() : [];
  }
  if (method === 'PATCH') {
    const q = `user_id=eq.${params.user_id}`;
    const { user_id, ...body } = params;
    await ft(`${SUPA_URL}/rest/v1/${table}?${q}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
    return;
  }
  await ft(`${SUPA_URL}/rest/v1/${table}`, { method: 'POST', headers, body: JSON.stringify(params) });
}

function detectLang(text) {
  if (/ќ|ѓ|ѕ|љ|њ|џ/i.test(text)) return 'mk';
  if (/ћ|ђ/i.test(text)) return 'sr';
  if (/[а-шА-Ш]/.test(text)) return 'mk';
  if (/\b(und|oder|ich|nicht)\b/.test(text)) return 'de';
  if (/\b(jest|się|nie|dla)\b/.test(text)) return 'pl';
  if (/\b(ve|bir|için|ile)\b/.test(text)) return 'tr';
  if (/\b(dhe|është|për)\b/.test(text)) return 'sq';
  if (/\b(sam|smo|ili)\b/.test(text)) return 'sr';
  return 'en';
}

module.exports = async function handler(req, res) {
  const ORIGINS = ['https://marginova.tech','https://www.marginova.tech','http://localhost:3000'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ORIGINS.includes(origin) ? origin : ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method Not Allowed' } });

  const ip = checkIP(req);
  if (!ip.allowed) return res.status(429).json({ error: { message: 'Daily limit reached.' } });

  const apiKey = process.env.GEMINI_API_KEY;
  const serperKey = process.env.SERPER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'Missing API key.' } });

  try {
    const body = req.body;
    const userId = body.userId || null;
    const rawText = body.messages?.[body.messages.length - 1]?.content || '';
    if (rawText.length > 2000) return res.status(400).json({ error: { message: 'Max 2000 chars.' } });

    if (userId) {
      const q = await checkUser(userId, supa);
      if (!q.allowed) return res.status(429).json({ error: { message: 'Limit reached. Upgrade.' }, quota_exceeded: true });
    }

    const today = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric' });
    const memory = await load(userId, supa, async (prompt, max) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const r = await ft(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ contents:[{role:'user',parts:[{text:prompt}]}], generationConfig:{maxOutputTokens:max||150,temperature:0.1} }) }, 8000);
      if (!r.ok) return null;
      const d = await r.json();
      return d.candidates?.[0]?.content?.parts?.[0]?.text || null;
    });

    const frontendMsgs = (body.messages || []).slice(-4).map(m => ({ role: m.role, content: String(m.content || '') }));
    const memContents = memory.recent.map(m => m.content);
    const messages = [...memory.recent, ...frontendMsgs.filter(m => !memContents.includes(m.content))];

    const userText = messages.filter(m => m.role === 'user').pop()?.content || '';
    const lang = body.lang || detectLang(userText);

    console.log(`[CHAT] lang:${lang} | user:${userId} | text:${userText.slice(0,60)}`);

    const { text, intent } = await run(userText, lang, today, messages, serperKey, apiKey, memory);

    if (userId) {
      await Promise.all([
        save(userId, 'user', userText, supa),
        save(userId, 'assistant', text, supa),
        increment(userId, supa)
      ]);
    }

    return res.status(200).json({ content: [{ type:'text', text }], intent, remaining: ip.remaining });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
