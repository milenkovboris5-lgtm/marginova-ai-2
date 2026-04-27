// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/fundingScorer.js
// v5 — REPLACE THE ENTIRE FILE WITH THIS
// No score. Returns 6 results sorted by deadline.
// matchSignals + riskFactors only. needsSerper() exported.
// ═══════════════════════════════════════════════════════════

const { getTable } = require('./utils');

console.log('[fundingScorer] v5 loaded — no score, 6 results, deadline sort');

const SECTOR_SQL_KEYWORDS = {
  'Environment / Energy':      ['environment','climate','renewable','biodiversity','ecosystem','conservation','clean energy','pollution','nature','wildlife','forest','sustainability','green agenda','pont','gef','geff','wwf','life programme'],
  'Civil Society':             ['civil society','ngo','nonprofit','advocacy','democracy','community','grassroots','rights','governance'],
  'Agriculture':               ['agriculture','farmer','rural','food','farm','ipard','agri'],
  'Education':                 ['education','school','learning','training','youth','student','scholarship','fellowship','erasmus'],
  'IT / Technology':           ['technology','digital','software','ai','innovation','ict','startup','tech'],
  'Health / Social':           ['health','social','welfare','care','women','gender'],
  'Research / Innovation':     ['research','science','innovation','university','academic','phd'],
  'SME / Business':            ['business','enterprise','sme','company','entrepreneur'],
  'Tourism / Culture':         ['tourism','culture','heritage','creative','art'],
  'Student / Youth':           ['student','scholarship','fellowship','youth','erasmus','fulbright','daad','stipend'],
  'Individual / Entrepreneur': ['individual','entrepreneur','founder','creator','freelance','startup'],
};

const ORG_ELIGIBILITY = {
  'NGO / Association':          ['ngo','nonprofit','association','civil society','foundation'],
  'Startup':                    ['startup','early stage','venture','founder'],
  'Agricultural holding':       ['farmer','agricultural','holding','ipard'],
  'SME':                        ['sme','enterprise','company','business'],
  'Municipality / Public body': ['municipality','local government','public body'],
  'University / Research':      ['university','research','academic','institute'],
  'Individual / Entrepreneur':  ['individual','entrepreneur','founder','self-employed','freelance','creator','person','applicant'],
};

const BUDGET_RANGES = {
  'up to €30k':   [0, 30000],
  '€30k–€150k':   [30000, 150000],
  '€150k–€500k':  [150000, 500000],
  'above €500k':  [500000, Infinity],
};

const SELECT_COLS     = 'id,title,organization_name,opportunity_type,funding_range,award_amount,currency,focus_areas,eligibility,application_deadline,country,description,source_url,status';
const DB_FETCH_LIMIT  = 80;
const MIN_RESULTS     = 3;    // below this → Serper fallback
const RESULTS_TO_SHOW = 6;    // user sees this many options

/**
 * searchDB(profile)
 * Runs two parallel Supabase queries (sector + country).
 * Merges, deduplicates, annotates, sorts by deadline, returns up to 6.
 */
async function searchDB(profile) {
  const today     = new Date().toISOString().split('T')[0];
  const sectorKws = SECTOR_SQL_KEYWORDS[profile.sector] || [];
  const queries   = [];

  // Query 1: sector keywords
  if (sectorKws.length > 0) {
    const [k1, k2, k3, k4] = sectorKws;
    const orParts = [
      `focus_areas.ilike.%${k1}%`,
      k2 ? `focus_areas.ilike.%${k2}%` : null,
      k3 ? `focus_areas.ilike.%${k3}%` : null,
      k4 ? `focus_areas.ilike.%${k4}%` : null,
      `description.ilike.%${k1}%`,
    ].filter(Boolean).join(',');

    queries.push(
      getTable('funding_opportunities')
        .select(SELECT_COLS)
        .eq('status', 'Open')
        .or(orParts)
        .gte('application_deadline', today)
        .order('application_deadline', { ascending: true })
        .limit(DB_FETCH_LIMIT)
    );
  }

  // Query 2: country / region
  const countryKw = profile.country || 'Balkans';
  queries.push(
    getTable('funding_opportunities')
      .select(SELECT_COLS)
      .eq('status', 'Open')
      .or(`country.ilike.%${countryKw}%,country.ilike.%global%,country.ilike.%Western Balkans%,country.ilike.%Europe%`)
      .gte('application_deadline', today)
      .order('application_deadline', { ascending: true })
      .limit(DB_FETCH_LIMIT)
  );

  let results;
  try {
    results = await Promise.all(queries);
  } catch (e) {
    console.error('[searchDB] Promise.all error:', e.message);
    return [];
  }

  // Merge + deduplicate
  const seen   = new Set();
  const merged = [];
  for (const { data, error } of results) {
    if (error) { console.warn('[searchDB] query error:', error.message); continue; }
    for (const row of (data || [])) {
      if (!seen.has(row.id) && (!row.application_deadline || row.application_deadline >= today)) {
        seen.add(row.id);
        merged.push(row);
      }
    }
  }

  if (merged.length === 0) {
    console.log('[searchDB] No results from DB');
    return [];
  }

  // Annotate (no scoring)
  const annotated = merged.map(g => annotate(g, profile, sectorKws));

  // Sort: soonest deadline first, _matchCount as tiebreaker
  annotated.sort((a, b) => {
    const da = a.application_deadline || '9999-12-31';
    const db = b.application_deadline || '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    return (b._matchCount || 0) - (a._matchCount || 0);
  });

  const final = annotated.slice(0, RESULTS_TO_SHOW);
  console.log('[searchDB] Returning', final.length, 'results for user to browse');
  return final;
}

/**
 * annotate(g, profile, sectorKws)
 * Attaches matchSignals[] and riskFactors[] to each opportunity.
 * Does NOT assign a score — the donor decides eligibility, not us.
 */
function annotate(g, profile, sectorKws) {
  const focus   = (g.focus_areas || '').toLowerCase();
  const desc    = (g.description || '').toLowerCase();
  const elig    = (g.eligibility || '').toLowerCase();
  const country = (g.country     || '').toLowerCase();
  const hay     = `${focus} ${desc}`;

  // ── Match signals (informational) ──────────────────────────
  const matchSignals = [];

  const sectorHits = sectorKws.filter(k => hay.includes(k));
  if (sectorHits.length > 0) {
    matchSignals.push(`Sector keywords: ${sectorHits.slice(0, 3).join(', ')}`);
  }

  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (country.includes(pc)) {
      matchSignals.push(`${profile.country} explicitly listed`);
    } else if (/global|europe|western balkans|southeast/.test(country)) {
      matchSignals.push(`Open regionally (${g.country})`);
    }
  }

  if (profile.orgType) {
    const kws  = ORG_ELIGIBILITY[profile.orgType] || [];
    const hits = kws.filter(k => `${elig} ${desc}`.includes(k));
    if (hits.length > 0) matchSignals.push(`Org type signal: ${hits[0]}`);
  }

  if (profile.budget && g.award_amount != null) {
    const [min, max] = BUDGET_RANGES[profile.budget] || [0, Infinity];
    const amt = Number(g.award_amount);
    if (!isNaN(amt) && amt >= min && amt <= max) {
      matchSignals.push(`Amount ${amt.toLocaleString()} ${g.currency || 'EUR'} fits your budget range`);
    }
  }

  if (Array.isArray(profile.keywords) && profile.keywords.length > 0) {
    const kwHits = profile.keywords.filter(k => `${hay} ${elig}`.includes(k));
    if (kwHits.length > 0) matchSignals.push(`Topic overlap: ${kwHits.slice(0, 2).join(', ')}`);
  }

  // ── Risk factors (what to verify) ──────────────────────────
  const riskFactors = [];

  if (profile.orgType && elig.length > 10) {
    const kws  = ORG_ELIGIBILITY[profile.orgType] || [];
    const hits = kws.filter(k => elig.includes(k));
    if (hits.length === 0 && !/all|global|any/.test(elig)) {
      riskFactors.push(`Verify org type — eligibility states: "${elig.slice(0, 80)}"`);
    }
  }

  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (country.length > 0 && !country.includes(pc) && !/global|europe|western balkans/.test(country)) {
      riskFactors.push(`Confirm ${profile.country} is eligible — listed: "${g.country}"`);
    }
  }

  if (profile.budget && g.award_amount != null) {
    const [mn, mx] = BUDGET_RANGES[profile.budget] || [0, Infinity];
    const amt      = Number(g.award_amount);
    if (!isNaN(amt) && (amt < mn * 0.5 || amt > mx * 2)) {
      riskFactors.push(`Budget gap: you need ${profile.budget}, program offers ${Math.round(amt).toLocaleString()} ${g.currency || 'EUR'}`);
    }
  }

  const combined = `${desc} ${focus}`;
  if (/global|international|worldwide/.test(combined)) {
    riskFactors.push('Global competition — large applicant pool expected');
  } else if (/western balkans|regional/.test(combined)) {
    riskFactors.push('Regional competition — moderate applicant pool');
  }

  if (!g.application_deadline) {
    riskFactors.push('Deadline not confirmed — verify on official source');
  } else {
    const days = Math.round((new Date(g.application_deadline) - new Date()) / 86400000);
    if (days < 14) riskFactors.push(`Deadline very soon — ${days} days remaining`);
  }

  if (!riskFactors.length) {
    riskFactors.push('Review full eligibility criteria before applying');
  }

  // Build display amount
  const amtNum = Number(g.award_amount);
  const amtStr = (!isNaN(amtNum) && g.award_amount != null)
    ? `${amtNum.toLocaleString()} ${g.currency || 'EUR'}`.trim()
    : (g.funding_range || '—');

  return {
    ...g,
    _matchCount:  matchSignals.length,   // internal sort only — NOT shown
    matchSignals,
    riskFactors,
    source:       g.source || 'db',
    snippet: [
      g.organization_name,
      amtStr,
      g.eligibility?.slice(0, 80),
      g.application_deadline ? `Deadline: ${g.application_deadline}` : null,
    ].filter(Boolean).join(' | '),
    link: g.source_url || '',
  };
}

/**
 * mergeWithWeb(dbResults, webResults)
 * DB first (verified), web fills gaps. Deduplicates by id.
 */
function mergeWithWeb(dbResults, webResults) {
  const dbIds  = new Set((dbResults || []).map(r => r.id));
  const merged = [
    ...(dbResults || []),
    ...(webResults || []).filter(r => !dbIds.has(r.id)),
  ].slice(0, RESULTS_TO_SHOW);

  console.log(`[mergeWithWeb] db:${dbResults?.length || 0} web:${webResults?.length || 0} final:${merged.length}`);
  return merged;
}

/**
 * needsSerper(dbResults)
 * Returns true only when DB alone is insufficient.
 */
function needsSerper(dbResults) {
  return !Array.isArray(dbResults) || dbResults.length < MIN_RESULTS;
}

module.exports = { searchDB, mergeWithWeb, needsSerper, RESULTS_TO_SHOW };
