// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/utils.js
// v10 — FIXED: DeepSeek default max_tokens 8000 → 4000,
//        Gemini timeout 30s → 45s
// ═══════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('[SUPABASE] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    return null;
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

const supabase = createSupabaseClient();
if (supabase) console.log('[SUPABASE] Connected');

function getTable(name) {
  if (!supabase) throw new Error('Supabase client not initialized');
  return supabase.from(name);
}

async function ft(url, opts = {}, ms = 12000, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      const res = await fetch(url, { ...opts, signal: c.signal });
      clearTimeout(t);
      return res;
    } catch (e) {
      clearTimeout(t);
      if (i === retries) throw e;
      console.log(`[FT] retry ${i + 1} for ${url.slice(0, 60)}`);
    }
  }
}

// ─── LANGUAGE DETECTION ───────────────────────────────────
const EXPLICIT_LANG = [
  { lang: 'mk', re: /на македонски|makedonski|in macedonian|по македонски/i },
  { lang: 'sr', re: /на српском|na srpskom|in serbian|srpski/i },
  { lang: 'hr', re: /на хрватском|na hrvatskom|in croatian|hrvatski/i },
  { lang: 'en', re: /in english|по английски|na engleskom|на англиски/i },
  { lang: 'de', re: /auf deutsch|in german|auf Deutsch|na nemackom/i },
  { lang: 'fr', re: /en français|in french|en francais/i },
  { lang: 'es', re: /en español|in spanish|en castellano/i },
  { lang: 'tr', re: /türkçe|in turkish|türkçe olarak/i },
  { lang: 'bg', re: /на български|na balgarski|in bulgarian/i },
  { lang: 'zh', re: /用中文|in chinese|用普通话/i },
];

const SCRIPT_LANG = [
  { lang: 'mk', re: /[ќѓѕљњџ]/i },
  { lang: 'sr', re: /[ћђ]/i },
  { lang: 'ar', re: /[؀-ۿ]/ },
  { lang: 'el', re: /[Ͱ-Ͽ]/ },
  { lang: 'zh', re: /[一-鿿]/ },
  { lang: 'ja', re: /[぀-ヿ]/ },
  { lang: 'ko', re: /[가-힯]/ },
];

const WORD_LANG = [
  { lang: 'mk', re: /јас|сум|македонија|барам|грант|работам|НВО|фонд|проект|буџет/i },
  { lang: 'sr', re: /srpski|srbija/i },
  { lang: 'bg', re: /българия/i },
  { lang: 'tr', re: /türkiye|türkçe/i },
  { lang: 'de', re: /Deutschland|deutsch|ich bin|und wir/i },
  { lang: 'fr', re: /France|français|nous sommes/i },
  { lang: 'es', re: /España|español|somos/i },
  { lang: 'en', re: /[A-Za-z]{4,}/ },
];

const LANG_NAMES = {
  mk: 'Macedonian', sr: 'Serbian', hr: 'Croatian', bs: 'Bosnian',
  sq: 'Albanian', bg: 'Bulgarian', ro: 'Romanian', sl: 'Slovenian',
  en: 'English', de: 'German', fr: 'French', es: 'Spanish',
  it: 'Italian', pl: 'Polish', tr: 'Turkish', nl: 'Dutch',
  pt: 'Portuguese', cs: 'Czech', hu: 'Hungarian', el: 'Greek',
  ru: 'Russian', uk: 'Ukrainian', ar: 'Arabic', ko: 'Korean',
  ja: 'Japanese', zh: 'Chinese',
};

function detectLang(text) {
  if (!text) return 'en';
  const t = text.trim();
  for (const { lang, re } of EXPLICIT_LANG) if (re.test(t)) return lang;
  for (const { lang, re } of SCRIPT_LANG) if (re.test(t)) return lang;
  for (const { lang, re } of WORD_LANG) if (re.test(t)) return lang;
  if (/[А-я]/.test(t)) return 'ru';
  return 'en';
}

function sanitizeField(str, maxLen = 500) {
  if (!str) return '';
  return String(str).trim().slice(0, maxLen)
    .replace(/<\/?(system|prompt|instruction)[^>]*>/gi, '')
    .replace(/```/g, '');
}

// ─── IP RATE LIMIT ────────────────────────────────────────
const DAILY_IP_LIMIT = 200;

async function checkIP(req) {
  if (!supabase) return true;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const today = new Date().toISOString().split('T')[0];
  try {
    const { data, error } = await supabase.rpc('check_and_increment_ip', {
      p_ip: ip, p_date: today, p_limit: DAILY_IP_LIMIT
    });
    if (error) return checkIPFallback(ip, today);
    return data === true;
  } catch (e) { return true; }
}

async function checkIPFallback(ip, today) {
  try {
    const { data: row, error } = await getTable('ip_limits')
      .select('ip,count,reset_date').eq('ip', ip).maybeSingle();
    if (error) return true;
    const rowDate = row?.reset_date ? String(row.reset_date).slice(0, 10) : null;
    if (!row || rowDate !== today) {
      await getTable('ip_limits').upsert({ ip, count: 1, reset_date: today }, { onConflict: 'ip' });
      return true;
    }
    if ((row.count || 0) >= DAILY_IP_LIMIT) return false;
    await getTable('ip_limits').upsert({ ip, count: (row.count || 0) + 1, reset_date: today }, { onConflict: 'ip' });
    return true;
  } catch (e) { return true; }
}

// ─── QUOTA (без auth) ─────────────────────────────────────
async function checkAndDeductQuota(userId) {
  return { allowed: true };
}

// ─── DEEPSEEK ─────────────────────────────────────────────
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

async function deepseekCall(systemPrompt, userPrompt, opts = {}) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('Missing DEEPSEEK_API_KEY');
  const r = await ft(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      max_tokens:  opts.maxTokens   ?? 4000,   // default 4000
      temperature: opts.temperature ?? 0.35,
      stream: false,
    }),
  }, opts.timeout ?? 120000);
  if (!r.ok) throw new Error(`DeepSeek ${r.status}: ${(await r.text()).slice(0, 240)}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const text = d.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('DeepSeek returned empty response');
  return text;
}

async function deepseek(systemPrompt, userPrompt, opts = {}) {
  try {
    return await deepseekCall(systemPrompt, userPrompt, opts);
  } catch (e) {
    console.log('[DEEPSEEK RETRY]', e.message);
    await new Promise(r => setTimeout(r, 2000));
    return await deepseekCall(systemPrompt, userPrompt, opts);
  }
}

// ─── GEMINI ───────────────────────────────────────────────
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

async function geminiCall(systemPrompt, contents, opts = {}) {
  if (!GEMINI_KEY) throw new Error('Missing GEMINI_API_KEY');
  const url = `${GEMINI_URL}?key=${GEMINI_KEY}`;
  const safeContents = Array.isArray(contents) ? contents : [contents];
  const r = await ft(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: safeContents,
      generationConfig: {
        maxOutputTokens: opts.maxTokens ?? 3200,   // FIXED: 4096 → 3200
        temperature: opts.temperature ?? 0.35
      }
    })
  }, opts.timeout ?? 45000);  // FIXED: 30s → 45s

  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 240)}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

async function gemini(systemPrompt, contents, opts = {}) {
  try {
    return await geminiCall(systemPrompt, contents, opts);
  } catch (e) {
    console.log('[GEMINI RETRY]', e.message);
    await new Promise(r => setTimeout(r, 1500));
    return await geminiCall(systemPrompt, contents, opts);
  }
}

// ─── CORS ─────────────────────────────────────────────────
const ALLOWED_ORIGINS = process.env.NODE_ENV === 'production'
  ? ['https://marginova.tech', 'https://www.marginova.tech']
  : ['https://marginova.tech', 'https://www.marginova.tech', 'http://localhost:3000'];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
}

module.exports = {
  supabase, getTable, ft, detectLang, LANG_NAMES,
  sanitizeField, checkIP, checkAndDeductQuota, gemini, deepseek, setCors
};
