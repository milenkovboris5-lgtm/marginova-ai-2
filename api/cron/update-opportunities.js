// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/cron/update-opportunities.js
// Weekly cron job: auto-updates deadlines + links via Serper
// Vercel cron: runs every Monday 08:00 UTC
// ═══════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

const SERPER_KEY   = process.env.SERPER_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET; // set in Vercel env vars

const STALE_DAYS   = 7;   // re-check if older than 7 days
const MAX_PER_RUN  = 20;  // max opportunities to update per run (Serper quota)
const SERPER_DELAY = 800; // ms between Serper calls

// ═══ SUPABASE ═══

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing Supabase env vars');
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

// ═══ SERPER SEARCH ═══

async function searchSerper(query) {
  if (!SERPER_KEY) return null;

  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 5, gl: 'us', hl: 'en' }),
      signal: AbortSignal.timeout(8000)
    });

    if (!r.ok) return null;
    const data = await r.json();
    return data.organic || [];
  } catch (e) {
    console.log('[SERPER]', e.message);
    return null;
  }
}

// ═══ DATE EXTRACTOR ═══
// Extracts deadline date from search snippets

function extractDate(text) {
  if (!text) return null;

  const months = {
    january:'01', february:'02', march:'03', april:'04',
    may:'05', june:'06', july:'07', august:'08',
    september:'09', october:'10', november:'11', december:'12'
  };

  const patterns = [
    // 2026-12-31
    /\b(202[5-9])-(\d{2})-(\d{2})\b/,
    // 31 December 2026
    /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(202[5-9])\b/i,
    // December 31, 2026
    /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(202[5-9])/i,
    // 31.12.2026 or 31/12/2026
    /\b(\d{1,2})[./](\d{1,2})[./](202[5-9])\b/
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (!m) continue;

    try {
      if (pattern === patterns[0]) {
        // ISO format
        return `${m[1]}-${m[2]}-${m[3]}`;
      } else if (pattern === patterns[1]) {
        // 31 December 2026
        return `${m[3]}-${months[m[2].toLowerCase()]}-${m[1].padStart(2,'0')}`;
      } else if (pattern === patterns[2]) {
        // December 31, 2026
        return `${m[3]}-${months[m[1].toLowerCase()]}-${m[2].padStart(2,'0')}`;
      } else {
        // DD.MM.YYYY
        return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
      }
    } catch(e) { continue; }
  }

  return null;
}

// ═══ EXTRACT FROM RESULTS ═══

function extractFromResults(results, currentUrl) {
  let deadline = null;
  let link     = currentUrl || null;

  for (const result of (results || [])) {
    const text = `${result.title || ''} ${result.snippet || ''}`;

    // Try to extract date
    if (!deadline) {
      deadline = extractDate(text);
    }

    // Use first result URL if we don't have a good one
    if (!link && result.link && !result.link.includes('google.com')) {
      link = result.link;
    }

    if (deadline && link) break;
  }

  return { deadline, link };
}

// ═══ SLEEP ═══

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══ MAIN HANDLER ═══

module.exports = async function handler(req, res) {

  // Security: only allow Vercel cron or requests with secret
  const authHeader = req.headers['authorization'] || '';
  const cronHeader = req.headers['x-vercel-cron'] || '';

  if (!cronHeader && authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();
  const results   = { checked: 0, updated: 0, skipped: 0, errors: 0 };

  try {
    const db   = getSupabase();
    const today = new Date().toISOString().split('T')[0];
    const staleDate = new Date(Date.now() - STALE_DAYS * 86400000).toISOString().split('T')[0];

    // Fetch opportunities that need updating:
    // 1. deadline is NULL
    // 2. last_checked is NULL or older than STALE_DAYS
    // Only Open status
    const { data: opportunities, error } = await db
      .from('funding_opportunities')
      .select('id,title,organization_name,source_url,application_deadline,last_checked')
      .eq('status', 'Open')
      .or(`application_deadline.is.null,last_checked.is.null,last_checked.lt.${staleDate}`)
      .limit(MAX_PER_RUN);

    if (error) throw new Error(`DB fetch: ${error.message}`);
    if (!opportunities?.length) {
      return res.status(200).json({ message: 'Nothing to update', ...results });
    }

    console.log(`[CRON] ${opportunities.length} opportunities to check`);

    for (const opp of opportunities) {
      results.checked++;

      try {
        // Build search query
        const query = `"${opp.title}" ${opp.organization_name} deadline apply 2026`;
        console.log(`[CRON] Searching: ${opp.title.slice(0, 50)}`);

        const searchResults = await searchSerper(query);
        await sleep(SERPER_DELAY);

        if (!searchResults) {
          results.skipped++;
          // Still update last_checked so we don't hammer it next run
          await db.from('funding_opportunities')
            .update({ last_checked: today })
            .eq('id', opp.id);
          continue;
        }

        const { deadline, link } = extractFromResults(searchResults, opp.source_url);

        // Build update payload
        const update = { last_checked: today };

        if (deadline && deadline !== opp.application_deadline) {
          update.application_deadline = deadline;
          console.log(`[CRON] ✓ Deadline updated: ${opp.title.slice(0,30)} → ${deadline}`);
        }

        if (link && link !== opp.source_url) {
          update.source_url = link;
          console.log(`[CRON] ✓ URL updated: ${link.slice(0,60)}`);
        }

        const { error: updateError } = await db
          .from('funding_opportunities')
          .update(update)
          .eq('id', opp.id);

        if (updateError) {
          console.log(`[CRON] Update error for ${opp.id}:`, updateError.message);
          results.errors++;
        } else {
          if (deadline || link !== opp.source_url) results.updated++;
          else results.skipped++;
        }

      } catch(e) {
        console.log(`[CRON] Error for ${opp.id}:`, e.message);
        results.errors++;
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[CRON] Done in ${duration}s:`, results);

    return res.status(200).json({
      success: true,
      duration: `${duration}s`,
      ...results
    });

  } catch(e) {
    console.error('[CRON ERROR]', e.message);
    return res.status(500).json({ error: e.message, ...results });
  }
};
