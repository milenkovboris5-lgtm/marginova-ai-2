// ═══════════════════════════════════════════════════════════
// MARGINOVA.AI — api/_lib/utils.js
// v3 — FIXED: atomic IP+quota via RPC, deduped gemini(),
//      deduped checkAndDeductQuota(), CORS env-aware,
//      cache key fixed, sanitizeField exported
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
// Priority order:
//   1. Explicit request ("на македонски", "in english", "auf deutsch"...)
//   2. Unique script characters (Cyrillic, Arabic, Chinese, Japanese...)
//   3. Common word patterns per language
//   4. Default: English

// Explicit language request triggers
const EXPLICIT_LANG = [
  { lang: 'mk', re: /на македонски|makedonski|in macedonian|по македонски/i },
  { lang: 'sr', re: /на српском|na srpskom|in serbian|srpski/i },
  { lang: 'hr', re: /na hrvatskom|in croatian|hrvatski/i },
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
  { lang: 'tr', re: /türkçe olarak|in turkish/i },
  { lang: 'ko', re: /한국어로|in korean/i },
  { lang: 'ja', re: /日本語で|in japanese/i },
  { lang: 'zh', re: /用中文|in chinese|用普通话/i },
  { lang: 'en', re: /in english|по английски|na engleskom|на англиски/i },
];

// Script-based detection (unique Unicode ranges)
const SCRIPT_LANG = [
  { lang: 'mk', re: /[ќѓѕљњџ]/i },           // Macedonian-unique Cyrillic
  { lang: 'sr', re: /[ћђ]/i },                // Serbian-unique Cyrillic
  { lang: 'ar', re: /[؀-ۿ]/ },      // Arabic
  { lang: 'fa', re: /[؀-ۿ][کگۀی]/ }, // Farsi (superset of Arabic)
  { lang: 'el', re: /[Ͱ-Ͽ]/ },      // Greek
  { lang: 'zh', re: /[一-鿿]/ },      // Chinese
  { lang: 'ja', re: /[぀-ヿ]/ },      // Japanese (hiragana/katakana)
  { lang: 'ko', re: /[가-힯]/ },      // Korean
  { lang: 'uk', re: /[іїєґ]/i },             // Ukrainian-unique Cyrillic
  // bg: handled by WORD_LANG with specific Bulgarian words
];

// Word-pattern detection per language
const WORD_LANG = [
  { lang: 'mk', re: /јас|сум|македонија|барам|грант|работам|НВО|фонд|проект|буџет|нашата|Македонија|Северна/i },
  { lang: 'mk', re: /jas |sum |makedonija|zdravo|zemja |nvo |fond /i },
  { lang: 'sr', re: /srpski|srbija|бесплатно|можемо/i },
  { lang: 'hr', re: /hrvatska|croatian|možemo/i },
  { lang: 'bs', re: /bosna|bosanski/i },
  { lang: 'bg', re: /българия|организация|проект/i },
  { lang: 'ro', re: /românia|proiect|organizație/i },
  { lang: 'sl', re: /slovenija|organizacija/i },
  { lang: 'de', re: /Deutschland|deutsch|Deutsch|ich bin|und wir|nicht |für |mit der/i },
  { lang: 'fr', re: /France|français|nous sommes|pour |avec |dans /i },
  { lang: 'es', re: /España|español|somos|para |con |también/i },
  { lang: 'it', re: /Italia|italiano|siamo|progetto|organizzazione/i },
  { lang: 'pl', re: /polska|organizacja|jestem|polskiego|Jestem/i },
  { lang: 'tr', re: /türkiye|türkçe|organizasyon/i },
  { lang: 'nl', re: /nederland|dutch/i },
  { lang: 'pt', re: /brasil|portugal|português/i },
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

  // 2b. Cyrillic language disambiguation (runs after unique char check)
  if (/Македон|Северна|македон|северна|Македонија/i.test(t)) return 'mk';
  if (/јас|сум|македонија|барам|НВО|буџет|нашата|организација/i.test(t)) return 'mk';
  if (/jas |sum |makedonija|nvo |zdravo/i.test(t)) return 'mk';
  if (/srbija|srpski|Srbija/i.test(t)) return 'sr';
  if (/българия|организация|проект/i.test(t)) return 'bg';
  if (/[Ѐ-ӿ]/.test(t)) return 'ru'; // Generic Cyrillic → Russian as safe default
  
  // 3. Word patterns — language-specific first, then generic
  for (const { lang, re } of WORD_LANG) {
    if (re.test(t)) return lang;
  }

  // 4. Common European content words — proper regex objects to avoid  escape issue
  if (/(Ich|bin|eine|und|nicht|für|Deutschland|Deutsch)/i.test(t)) return 'de';
  if (/(Je|suis|une|les|des|pour|avec|nous|vous|dans|France|français)/i.test(t)) return 'fr';
  if (/(Soy|una|los|las|España|español|gracias|también)/i.test(t)) return 'es';
  if (/(Sono|siamo|Italia|italiano|progetto|organizzazione)/i.test(t)) return 'it';
  if (/(Jestem|jest|polska|polskiego)/i.test(t)) return 'pl';
  if (/(türkçe|için|Türkiye|organizasyon)/i.test(t)) return 'tr';
  if (/(Nederland|dutch|nederlandstalig)/i.test(t)) return 'nl';
  if (/(Brasil|Portugal|português|organização)/i.test(t)) return 'pt';
  if (/(Česká|republika|česky|projekt)/i.test(t)) return 'cs';
  if (/(magyarország|magyar|szervezet)/i.test(t)) return 'hu';
  if (/(Slovenija|slovensko|projekt)/i.test(t)) return 'sl';
  if (/(România|română|proiect)/i.test(t)) return 'ro';
  if (/(Albania|shqipëri|organizatë)/i.test(t)) return 'sq';

  // 4. Default
  return 'en';
}

// ═══ INPUT SANITIZATION (shared) ═══

function sanitizeField(str, maxLen = 500) {
  if (!str) return '';
  return String(str)
    .trim()
    .slice(0, maxLen)
    .replace(/<\/?(system|prompt|instruction)[^>]*>/gi, '')
    .replace(/```/g, '');
}

// ═══ IP RATE LIMIT — atomic via RPC ═══
// Requires this SQL function in Supabase:
//
//   CREATE OR REPLACE FUNCTION check_and_increment_ip(
//     p_ip text, p_date text, p_limit int
//   ) RETURNS bool AS $$
//   DECLARE allowed bool;
//   BEGIN
//     INSERT INTO ip_limits(ip, count, reset_date) VALUES (p_ip, 1, p_date)
//     ON CONFLICT (ip) DO UPDATE SET
//       count = CASE
//         WHEN ip_limits.reset_date != p_date THEN 1
//         ELSE ip_limits.count + 1 END,
//       reset_date = p_date;
//     SELECT (count <= p_limit) INTO allowed FROM ip_limits WHERE ip = p_ip;
//     RETURN allowed;
//   END;
//   $$ LANGUAGE plpgsql;

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
      // RPC not yet deployed — fallback to non-atomic (log warning)
      console.warn('[IP] RPC not available, using fallback:', error.message);
      return checkIPFallback(ip, today);
    }

    return data === true;
  } catch (e) {
    console.error('[IP CHECK]', e.message);
    return true;
  }
}

// Fallback until RPC is deployed
// FIX: normalize date - Supabase DATE cols may return '2026-04-26' or ISO string
async function checkIPFallback(ip, today) {
  try {
    const { data: row, error } = await getTable('ip_limits')
      .select('ip,count,reset_date')
      .eq('ip', ip)
      .maybeSingle();

    if (error) { console.error('[IP GET]', error.message); return true; }

    // slice(0,10) handles both '2026-04-26' and '2026-04-26T00:00:00.000Z'
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

// ═══ QUOTA — single source of truth ═══
// Requires this SQL function in Supabase:
//
//   CREATE OR REPLACE FUNCTION deduct_quota(
//     p_user_id uuid, p_date text, p_limit int
//   ) RETURNS jsonb AS $$
//   DECLARE
//     cur_used int; cur_plan text; cur_limit int;
//   BEGIN
//     SELECT plan, daily_msgs, last_msg_date INTO cur_plan, cur_used, cur_limit
//     FROM profiles WHERE user_id = p_user_id;
//     IF NOT FOUND THEN RETURN '{"allowed":true}'::jsonb; END IF;
//     IF cur_limit = -1 THEN RETURN '{"allowed":true}'::jsonb; END IF;
//     cur_used := CASE WHEN cur_limit != p_date THEN 0 ELSE COALESCE(cur_used,0) END;
//     IF cur_used >= p_limit THEN
//       RETURN jsonb_build_object('allowed',false,'used',cur_used,'plan',cur_plan);
//     END IF;
//     UPDATE profiles SET daily_msgs = cur_used + 1, last_msg_date = p_date
//     WHERE user_id = p_user_id;
//     RETURN jsonb_build_object('allowed',true,'used',cur_used+1,'plan',cur_plan);
//   END;
//   $$ LANGUAGE plpgsql;

const PLANS = { free: 20, starter: 500, pro: 2000, business: -1 };

async function checkAndDeductQuota(userId) {
  if (!userId || !supabase) return { allowed: true };

  const today = new Date().toISOString().split('T')[0];

  // Try atomic RPC first
  try {
    const { data, error } = await supabase.rpc('deduct_quota', {
      p_user_id: userId,
      p_date: today
    });

    if (!error && data) return data;
    // RPC not yet deployed — fall through to non-atomic
    if (error) console.warn('[QUOTA] RPC not available, using fallback:', error.message);
  } catch (e) {
    console.warn('[QUOTA] RPC error:', e.message);
  }

  // Fallback — original non-atomic logic
  try {
    const { data: p, error } = await getTable('profiles')
      .select('plan,daily_msgs,last_msg_date')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) { console.log('[QUOTA]', error.message); return { allowed: true }; }
    if (!p) return { allowed: true };

    const limit = PLANS[p.plan] ?? 20;
    if (limit === -1) return { allowed: true };

    // FIX: normalize DATE col same as IP fallback
    const lastDate = p.last_msg_date ? String(p.last_msg_date).slice(0, 10) : null;
    const used = lastDate === today ? (p.daily_msgs || 0) : 0;
    if (used >= limit) return { allowed: false, used, limit, plan: p.plan };

    await getTable('profiles')
      .update({ daily_msgs: used + 1, last_msg_date: today })
      .eq('user_id', userId);

    return { allowed: true, used: used + 1, limit, plan: p.plan };
  } catch (e) {
    console.log('[QUOTA FALLBACK]', e.message);
    return { allowed: true };
  }
}

// ═══ GEMINI — single shared implementation ═══

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`;

async function geminiCall(systemPrompt, contents, opts = {}) {
  if (!GEMINI_KEY) throw new Error('Missing GEMINI_API_KEY');

  const url = `${GEMINI_URL}?key=${GEMINI_KEY}`;

  const r = await ft(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
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
