// ═══════════════════════════════════════════════════════════
// MARGINOVA.AI — api/_lib/utils.js
// Shared utilities — supabase, fetch, language detection
// ═══════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

// ═══ SUPABASE ═══

function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    console.log('[SUPABASE] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    return null;
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

// Singleton — one client per cold-start
const supabase = createSupabaseClient();

function getTable(name) {
  if (!supabase) throw new Error('Supabase client not initialized');
  return supabase.from(name);
}

// ═══ FETCH WITH TIMEOUT ═══

function ft(url, opts = {}, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

// ═══ LANGUAGE DETECTION ═══
// Fixed: proper Unicode range for Macedonian/Serbian Cyrillic (U+0400–U+04FF)

function detectLang(text) {
  if (!text) return 'en';

  // Macedonian-specific letters (not in standard Cyrillic block)
  if (/[ќѓѕљњџ]/i.test(text)) return 'mk';
  if (/[ћђ]/i.test(text)) return 'sr';

  // Common Macedonian words
  if (/\b(јас|сум|македонија|барам|грант|работам|НВО|фонд|проект|апликација|буџет)\b/i.test(text)) return 'mk';

  // Full Cyrillic Unicode range (covers all Cyrillic alphabets)
  if (/[\u0400-\u04FF]/.test(text)) return 'mk';

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
      console.log('[DB GET ip_limits]', error.message);
      return true; // fail open
    }

    if (!row || row.reset_date !== today) {
      const { error: upsertError } = await getTable('ip_limits').upsert(
        { ip, count: 1, reset_date: today },
        { onConflict: 'ip' }
      );
      if (upsertError) console.log('[IP UPSERT]', upsertError.message);
      return true;
    }

    if ((row.count || 0) >= DAILY_IP_LIMIT) return false;

    const { error: updateError } = await getTable('ip_limits')
      .update({ count: (row.count || 0) + 1 })
      .eq('ip', ip);

    if (updateError) console.log('[IP UPDATE]', updateError.message);

    return true;
  } catch (e) {
    console.log('[IP CHECK]', e.message);
    return true; // fail open
  }
}

// ═══ CORS HELPER ═══

const ALLOWED_ORIGINS = [
  'https://marginova.tech',
  'https://www.marginova.tech',
  'http://localhost:3000'
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader(
    'Access-Control-Allow-Origin',
    ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  );
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

module.exports = { supabase, getTable, ft, detectLang, LANG_NAMES, checkIP, setCors };
