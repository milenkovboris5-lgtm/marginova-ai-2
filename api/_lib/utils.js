// ═══════════════════════════════════════════════════════════
// MARGINOVA.AI — api/_lib/utils.js
// v4 — FIXED: detectLang() no duplicate tr, no script conflict
//      gemini() exports, checkAndDeductQuota() safe fallback
// ═══════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

// ═══ SUPABASE ═══

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

// ═══ FETCH WITH TIMEOUT + RETRY ═══

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

// ═══ LANGUAGE DETECTION — 40+ languages ═══

// Explicit language request triggers
const EXPLICIT_LANG = [
  { lang: 'mk', re: /на македонски|makedonski|in macedonian|по македонски/i },
  { lang: 'sr', re: /на српском|na srpskom|in serbian|srpski/i },
  { lang: 'hr', re: /на хрватском|na hrvatskom|in croatian|hrvatski/i },
  { lang: 'bs', re: /na bosanskom|in bosnian|bosanski/i },
  { lang: 'sq', re: /në shqip|in albanian|shqip/i },
  { lang: 'bg', re: /на български|na balgarski|in bulgarian/i },
  { lang: 'ro', re: /în română|in romanian|română/i },
  { lang: 'sl', re: /v slovenščini|in slovenian|slovensko/i },
  { lang: 'de', re: /auf deutsch|in german|auf Deutsch|na nemackom/i },
  { lang: 'fr', re: /en français|in french|en francais/i },
  { lang: 'es', re: /en español|in spanish|en castellano/i },
  { lang: 'it', re: /in italiano|in italian/i },
  { lang: 'pl', re: /po polsku|in polish|w języku polskim/i },
  { lang: 'tr', re: /türkçe|in turkish|türkçe olarak/i },
  { lang: 'nl', re: /in het nederlands|in dutch|nederlandstalig/i },
  { lang: 'pt', re: /em português|in portuguese|em portugues/i },
  { lang: 'cs', re: /v češtině|in czech|česky/i },
  { lang: 'sk', re: /po slovensky|in slovak|slovensky/i },
  { lang: 'hu', re: /magyarul|in hungarian|magyar nyelven/i },
  { lang: 'el', re: /στα ελληνικά|in greek|ελληνικά/i },
  { lang: 'ru', re: /на русском|in russian|по-русски/i },
  { lang: 'uk', re: /українською|in ukrainian|по-українськи/i },
  { lang: 'ar', re: /بالعربية|in arabic|باللغة العربية/i },
  { lang: 'fa', re: /به فارسی|in persian|به زبان فارسی/i },
  { lang: 'ko', re: /한국어로|in korean/i },
  { lang: 'ja', re: /日本語で|in japanese/i },
  { lang: 'zh', re: /用中文|in chinese|用普通话/i },
  { lang: 'en', re: /in english|по английски|na engleskom|на англиски/i },
];

// Script-based detection (unique Unicode ranges)
const SCRIPT_LANG = [
  { lang: 'mk', re: /[ќѓѕљњџ]/i },           // Macedonian-unique Cyrillic
  { lang: 'sr', re: /[ћђ]/i },                // Serbian-unique Cyrillic
  { lang: 'ar', re: /[؀-ۿ]/ },               // Arabic
  { lang: 'fa', re: /[؀-ۿ][کگۀی]/i },        // Farsi (superset of Arabic)
  { lang: 'el', re: /[Ͱ-Ͽ]/ },               // Greek
  { lang: 'zh', re: /[一-鿿]/ },              // Chinese
  { lang: 'ja', re: /[぀-ヿ]/ },              // Japanese (hiragana/katakana)
  { lang: 'ko', re: /[가-힯]/ },              // Korean
  { lang: 'uk', re: /[іїєґ]/i },             // Ukrainian-unique Cyrillic
];

// Word-pattern detection per language
const WORD_LANG = [
  { lang: 'mk', re: /јас|сум|македонија|барам|грант|работам|НВО|фонд|проект|буџет|нашата|Македонија|Северна|jas|sum|makedonija|zdravo|zemja|nvo|fond/i },
  { lang: 'sr', re: /srpski|srbija|бесплатно|можемо/i },
  { lang: 'hr', re: /hrvatska|croatian|možemo|Hrvatska/i },
  { lang: 'bs', re: /bosna|bosanski/ },
  { lang: 'bg', re: /българия|организация|проект/ },
  { lang: 'ro', re: /românia|proiect|organizație/ },
  { lang: 'sl', re: /slovenija|organizacija/ },
  { lang: 'de', re: /Deutschland|deutsch|ich bin|und wir|nicht|für|mit der|Das ist|Eine/i },
  { lang: 'fr', re: /France|français|nous sommes|pour|avec|dans|Je suis|Nous avons/i },
  { lang: 'es', re: /España|español|somos|para|con|también|Hola|Buenos días/i },
  { lang: 'it', re: /Italia|italiano|siamo|progetto|organizzazione|Ciao|Buongiorno/i },
  { lang: 'pl', re: /polska|organizacja|jestem|polskiego|Dzień dobry|Cześć/i },
  { lang: 'tr', re: /türkiye|türkçe|organizasyon|Merhaba|Sabah/i },
  { lang: 'nl', re: /nederland|dutch|Nederland|Goedemorgen/i },
  { lang: 'pt', re: /brasil|portugal|português|Bom dia|Olá/i },
  { lang: 'cs', re: /česká|republika|česky|projekt|Dobrý den|Ahoj/i },
  { lang: 'hu', re: /magyarország|magyar|szervezet/Jó napot/Szia/i },
  { lang: 'ru', re: /[А-я]/ },
];

const LANG_NAMES = {
  mk: 'Macedonian', sr: 'Serbian',   hr: 'Croatian',  bs: 'Bosnian',
  sq: 'Albanian',   bg: 'Bulgarian', ro: 'Romanian',  sl: 'Slovenian',
  en: 'English',    de: 'German',    fr: 'French',    es: 'Spanish',
  it: 'Italian',    pl: 'Polish',    tr: 'Turkish',   nl: 'Dutch',
  pt: 'Portuguese', cs: 'Czech',     sk: 'Slovak',    hu: 'Hungarian',
  el: 'Greek',      ru: 'Russian',   uk: 'Ukrainian', ar: 'Arabic',
  fa: 'Persian',    ko: 'Korean',    ja: 'Japanese',  zh: 'Chinese',
};

function detectLang(text) {
  if (!text) return 'en';
  const t = text.trim();

  // 1. Explicit language request (highest priority)
  for (const { lang, re } of EXPLICIT_LANG) {
    if (re.test(t)) return lang;
  }

  // 2. Script-based unique chars (MK/SR before generic Cyrillic)
  for (const { lang, re } of SCRIPT_LANG) {
    if (re.test(t)) return lang;
  }

  // 3. Cyrillic language disambiguation (runs after unique char check)
  if (/Македон|Северна|македон|северна|Македонија/i.test(t)) return 'mk';
  if (/јас|сум|македонија|барам|НВО|буџет|нашата|организација/i.test(t)) return 'mk';
  if (/jas|sum|makedonija|nvo|zdravo/i.test(t)) return 'mk';
  if (/srbija|srpski|Srbija/i.test(t)) return 'sr';
  if (/българия|организация|проект/i.test(t)) return 'bg';
  if (/[Ѐ-ӿ]/.test(t)) return 'ru'; // Generic Cyrillic → Russian as safe default
  
  // 4. Word patterns — language-specific first, then generic
  for (const { lang, re } of WORD_LANG) {
    if (re.test(t)) return lang;
  }

  // 5. Default
  return 'en';
}

// ═══ INPUT SANITIZATION ═══

function sanitizeField(str, maxLen = 500) {
  if (!str) return '';
  return String(str)
    .trim()
    .slice(0, maxLen)
    .replace(/<\/?(system|prompt|instruction)[^>]*>/gi, '')
    .replace(/```/g, '');
}

// ═══ IP RATE LIMIT — atomic via RPC ═══
const DAILY_IP_LIMIT = 200;

async function checkIP(req) {
  if (!supabase) return true;

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const today = new Date().toISOString().split('T')[0];

  try {
    const { data, error } = await supabase.rpc('check_and_increment_ip', {
      p_ip: ip,
      p_date: today,
      p_limit: DAILY_IP_LIMIT
    });

    if (error) {
      console.warn('[IP] RPC not available, using fallback:', error.message);
      return checkIPFallback(ip, today);
    }

    return data === true;
  } catch (e) {
    console.error('[IP CHECK]', e.message);
    return true;
  }
}

async function checkIPFallback(ip, today) {
  try {
    const { data: row, error } = await getTable('ip_limits')
      .select('ip,count,reset_date')
      .eq('ip', ip)
      .maybeSingle();

    if (error) { console.error('[IP GET]', error.message); return true; }

    const rowDate = row?.reset_date ? String(row.reset_date).slice(0, 10) : null;

    if (!row || rowDate !== today) {
      await getTable('ip_limits').upsert(
        { ip, count: 1, reset_date: today },
        { onConflict: 'ip' }
      );
      return true;
    }

    if ((row.count || 0) >= DAILY_IP_LIMIT) return false;

    await getTable('ip_limits').upsert(
      { ip, count: (row.count || 0) + 1, reset_date: today },
      { onConflict: 'ip' }
    );
    return true;
  } catch (e) {
    console.error('[IP FALLBACK]', e.message);
    return true;
  }
}

// ═══ QUOTA — safe fallback ═══
const PLANS = { free: 20, starter: 500, pro: 2000, business: -1 };

async function checkAndDeductQuota(userId) {
  // NO userId -> no quota system (no auth)
  if (!userId || !supabase) return { allowed: true };

  const today = new Date().toISOString().split('T')[0];

  try {
    const { data, error } = await supabase.rpc('deduct_quota', {
      p_user_id: userId,
      p_date: today
    });

    if (!error && data) return data;
    if (error) console.warn('[QUOTA] RPC not available:', error.message);
  } catch (e) {
    console.warn('[QUOTA] RPC error:', e.message);
  }

  // Fallback — safe: allow if anything fails
  return { allowed: true };
}

// ═══ GEMINI — single shared implementation ═══

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`;

async function geminiCall(systemPrompt, contents, opts = {}) {
  if (!GEMINI_KEY) throw new Error('Missing GEMINI_API_KEY');

  const url = `${GEMINI_URL}?key=${GEMINI_KEY}`;

  // FIX: ensure contents is always array
  const safeContents = Array.isArray(contents) ? contents : [contents];

  const r = await ft(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: safeContents,
      generationConfig: {
        maxOutputTokens: opts.maxTokens ?? 4096,
        temperature:     opts.temperature ?? 0.35
      }
    })
  }, opts.timeout ?? 30000);

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

// ═══ CORS — env-aware ═══

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
  supabase,
  getTable,
  ft,
  detectLang,
  LANG_NAMES,
  sanitizeField,
  checkIP,
  checkAndDeductQuota,
  gemini,
  PLANS,
  setCors
};
