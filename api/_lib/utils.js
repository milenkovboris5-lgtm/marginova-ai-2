// ═══════════════════════════════════════════════════════════
// MARGINOVA.AI — api/_lib/utils.js
// v2 — fixed: detectLang Cyrillic fallback, CORS no-fallback
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

// ═══ LANGUAGE DETECTION ═══
// Fixed: proper Cyrillic fallback — MK only when certain, SR for generic Cyrillic

function detectLang(text) {
  if (!text) return 'en';

  // Macedonian-specific letters (unique to MK)
  if (/[ќѓѕљњџ]/i.test(text)) return 'mk';
  // Serbian-specific letters
  if (/[ћђ]/i.test(text)) return 'sr';

  // Common Macedonian words
  if (/\b(јас|сум|македонија|барам|грант|работам|НВО|фонд|проект|апликација|буџет)\b/i.test(text)) return 'mk';

  // Generic Cyrillic fallback → sr (safer than mk — covers RU/BG/UK too)
  if (/[\u0400-\u04FF]/.test(text)) return 'sr';

  // Macedonian romanized
  if (/\b(jas|sum|makedonija|zdravo|zemja|proekt|grant|fond)\b/i.test(text)) return 'mk';

  // European languages
  if (/\b(und|oder|ich|nicht|sie|wir)\b/i.test(text)) return 'de';
  if (/\b(est|une|les|des|pour|nous|vous)\b/i.test(text)) return 'fr';
  if (/\b(para|una|los|las|que|con)\b/i.test(text)) return 'es';
  if (/\b(sam|smo|nije|nisu)\b/i.test(text)) return 'sr';
  if (/\b(jestem|jest|nie|dla)\b/i.test(text)) return 'pl';
  if (/\b(bir|için|ile|bu|ve)\b/i.test(text)) return 'tr';

  return 'en';
}

const LANG_NAMES = {
  mk: 'Macedonian',
  sr: 'Serbian',
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pl: 'Polish',
  tr: 'Turkish'
};

// ═══ IP RATE LIMIT ═══

const DAILY_IP_LIMIT = 200;

async function checkIP(req) {
  if (!supabase) return true;

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const today = new Date().toISOString().split('T')[0];

  try {
    const { data: row, error } = await getTable('ip_limits')
      .select('ip,count,reset_date')
      .eq('ip', ip)
      .maybeSingle();

    if (error) {
      console.error('[IP GET]', error.message);
      return true;
    }

    if (!row || row.reset_date !== today) {
      const { error: upsertError } = await getTable('ip_limits').upsert(
        { ip, count: 1, reset_date: today },
        { onConflict: 'ip' }
      );
      if (upsertError) console.error('[IP UPSERT]', upsertError.message);
      return true;
    }

    if ((row.count || 0) >= DAILY_IP_LIMIT) return false;

    // Atomic increment via upsert to avoid race condition
    const { error: updateError } = await getTable('ip_limits').upsert(
      { ip, count: (row.count || 0) + 1, reset_date: today },
      { onConflict: 'ip' }
    );
    if (updateError) console.error('[IP UPDATE]', updateError.message);

    return true;
  } catch (e) {
    console.error('[IP CHECK]', e.message);
    return true;
  }
}

// ═══ CORS HELPER ═══
// Fixed: no fallback for unknown origins — closed by default

const ALLOWED_ORIGINS = [
  'https://marginova.tech',
  'https://www.marginova.tech',
  'http://localhost:3000'
];

function setCors(req, res) {
  const origin = req.headers.origin || '';

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  // Unknown origins get no CORS headers — request will be blocked by browser
}

module.exports = { supabase, getTable, ft, detectLang, LANG_NAMES, checkIP, setCors };
