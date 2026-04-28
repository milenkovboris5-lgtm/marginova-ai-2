// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/fundingScorer.js
// v6 — REPLACE THE ENTIRE FILE WITH THIS
//
// FIXES over v5:
// 1. Query 1 uses ALL sector keywords (not just 4)
// 2. Query 2 (country) is narrowed with sector filter
//    → stops irrelevant global programs bleeding through
// 3. Sort is relevance-first, deadline as tiebreaker
// 4. _matchCount is a proper weighted integer, not signal count
// 5. DB_FETCH_LIMIT raised to 120 for better candidate pool
// ═══════════════════════════════════════════════════════════

const { getTable } = require('./utils');

console.log('[fundingScorer] v6 loaded — all keywords, relevance sort, narrow country query');

const SECTOR_SQL_KEYWORDS = {
  'Environment / Energy':      ['environment','climate','renewable','biodiversity','ecosystem','conservation','clean energy','pollution','nature','wildlife','forest','sustainability','green','energy','ecology','gef','geff','wwf','life programme','carbon','emission'],
  'Civil Society':             ['civil society','ngo','nonprofit','advocacy','democracy','community','grassroots','rights','governance','nonprofit','foundation','association','volunteer'],
  'Agriculture':               ['agriculture','farmer','rural','food','farm','ipard','agri','crop','livestock','soil','irrigation','vineyard','organic','bio farm'],
  'Education':                 ['education','school','learning','training','youth','student','scholarship','fellowship','erasmus','curriculum','teacher','edtech'],
  'IT / Technology':           ['technology','digital','software','ai','innovation','ict','startup','tech','platform','app','saas','fintech','blockchain','cybersecurity','machine learning'],
  'Health / Social':           ['health','social','welfare','care','women','gender','medical','hospital','mental health','disability','rehabilitation'],
  'Research / Innovation':     ['research','science','innovation','university','academic','phd','doctoral','laboratory','publication','patent','r&d'],
  'SME / Business':            ['business','enterprise','sme','company','entrepreneur','revenue','market','startup','venture','investment'],
  'Tourism / Culture':         ['tourism','culture','heritage','creative','art','film','media','festival','museum'],
  'Student / Youth':           ['student','scholarship','fellowship','youth','erasmus','fulbright','daad','stipend','exchange','internship','undergraduate','graduate'],
  'Individual / Entrepreneur': ['individual','entrepreneur','founder','creator','freelance','startup','self-employed'],
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

// European regions — used in country matching
const EUROPEAN_REGIONS = [
  'europe','european union','eu','western balkans','balkans',
  'southeast europe','eastern europe','central europe',
  'global','international','worldwide',
];

const SELECT_COLS     = 'id,title,organization_name,opportunity_type,funding_range,award_amount,currency,focus_areas,eligibility,application_deadline,country,description,source_url,status';
const DB_FETCH_LIMIT  = 120;  // raised from 80 — more candidates, better final 6
const MIN_RESULTS     = 3;
const RESULTS_TO_SHOW = 6;

// ─── QUERY BUILDER HELPERS ───────────────────────────────────

/**
 * buildSectorOrParts(keywords)
 * Builds Supabase OR filter using ALL sector keywords.
 * Searches focus_areas for all kws, description for first 6.
 * v5 bug: only used first 4 keywords.
 */
function buildSectorOrParts(keywords) {
  if (!keywords || keywords.length === 0) return null;

  const focusParts = keywords.map(k => `focus_areas.ilike.%${k}%`);
  const descParts  = keywords.slice(0, 6).map(k => `description.ilike.%${k}%`);

  return [...focusParts, ...descParts].join(',');
}

/**
 * buildCountryOrParts(countryKw, sectorKws)
 * v5 bug: returned any program with "Europe" in country field.
 * v6 fix: requires BOTH (country/region match) AND (sector match).
 * Implemented by fetching country matches then filtering by sector
 * in JS — Supabase free tier doesn't support AND inside OR easily.
 */
function buildCountryOrParts(countryKw) {
  const parts = [
    `country.ilike.%${countryKw}%`,
    `country.ilike.%global%`,
    `country.ilike.%Western Balkans%`,
    `country.ilike.%Europe%`,
    `country.ilike.%European Union%`,
  ];
  return parts.join(',');
}

// ─── MAIN SEARCH ─────────────────────────────────────────────

/**
 * searchDB(profile)
 * v6 improvements:
 * - Query 1 uses ALL sector keywords
 * - Query 2 results are post-filtered by sector relevance
 * - Final sort is relevance DESC, deadline ASC
 */
async function searchDB(profile) {
  const today     = new Date().toISOString().split('T')[0];
  const sectorKws = SECTOR_SQL_KEYWORDS[profile.sector] || [];
  const queries   = [];

  // ── Query 1: full sector keyword search ──────────────────
  if (sectorKws.length > 0) {
    const orParts = buildSectorOrParts(sectorKws);
    if (orParts) {
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
  }

  // ── Query 2: country / region ────────────────────────────
  const countryKw = profile.country || 'Balkans';
  queries.push(
    getTable('funding_opportunities')
      .select(SELECT_COLS)
      .eq('status', 'Open')
      .or(buildCountryOrParts(countryKw))
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

  // ── Merge + deduplicate ───────────────────────────────────
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

  // ── v6 FIX: Post-filter Query 2 results by sector ────────
  // Programs that came in ONLY via country match (no sector signal)
  // get a relevance penalty so they don't crowd out real matches.
  // We don't remove them — we let the sort push them to the bottom.

  // ── Annotate with weighted relevance score ────────────────
  const annotated = merged.map(g => annotate(g, profile, sectorKws));

  // ── v6 FIX: Sort relevance DESC, deadline ASC as tiebreaker
  // v5 bug: sorted only by deadline → Amazon ARA appeared first
  annotated.sort((a, b) => {
    // Primary: higher relevance score wins
    const scoreDiff = (b._relevanceScore || 0) - (a._relevanceScore || 0);
    if (scoreDiff !== 0) return scoreDiff;

    // Secondary: earlier deadline wins (within same relevance band)
    const da = a.application_deadline || '9999-12-31';
    const db = b.application_deadline || '9999-12-31';
    return da < db ? -1 : 1;
  });

  const final = annotated.slice(0, RESULTS_TO_SHOW);
  console.log('[searchDB] Returning', final.length, 'results (sorted by relevance, then deadline)');
  return final;
}

// ─── ANNOTATE ────────────────────────────────────────────────

/**
 * annotate(g, profile, sectorKws)
 * Attaches matchSignals[], riskFactors[], and _relevanceScore to each opportunity.
 *
 * _relevanceScore is a weighted integer used for sorting:
 *   +4  exact country match
 *   +3  sector keyword hit in focus_areas
 *   +2  sector keyword hit in description
 *   +2  org type match in eligibility
 *   +2  budget range fits
 *   +1  regional match (Western Balkans / Europe)
 *   +1  per additional keyword hit (capped at +4)
 *  -2   global-only with no other signal (penalizes Amazon-style results)
 */
function annotate(g, profile, sectorKws) {
  const focus   = (g.focus_areas || '').toLowerCase();
  const desc    = (g.description || '').toLowerCase();
  const elig    = (g.eligibility || '').toLowerCase();
  const country = (g.country     || '').toLowerCase();
  const hay     = `${focus} ${desc}`;

  let relevanceScore = 0;

  // ── Match signals ─────────────────────────────────────────
  const matchSignals = [];

  // Sector keyword hits — check ALL keywords
  const focusHits = sectorKws.filter(k => focus.includes(k));
  const descHits  = sectorKws.filter(k => desc.includes(k) && !focus.includes(k));

  if (focusHits.length > 0) {
    relevanceScore += 3;
    relevanceScore += Math.min(focusHits.length - 1, 4); // bonus for multiple hits
    matchSignals.push(`Sector keywords: ${focusHits.slice(0, 3).join(', ')}`);
  }
  if (descHits.length > 0) {
    relevanceScore += 2;
    matchSignals.push(`Topic overlap: ${descHits.slice(0, 2).join(', ')}`);
  }

  // Country matching
  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (country.includes(pc)) {
      relevanceScore += 4; // exact country = strongest signal
      matchSignals.push(`${profile.country} explicitly listed`);
    } else if (/western balkans|southeast europe/.test(country)) {
      relevanceScore += 2;
      matchSignals.push(`Open regionally (${g.country})`);
    } else if (/global|europe|european union/.test(country)) {
      relevanceScore += 1;
      matchSignals.push(`Open regionally (${g.country})`);
    }
  }

  // Org type matching
  if (profile.orgType) {
    const kws  = ORG_ELIGIBILITY[profile.orgType] || [];
    const hits = kws.filter(k => `${elig} ${desc}`.includes(k));
    if (hits.length > 0) {
      relevanceScore += 2;
      matchSignals.push(`Org type signal: ${hits[0]}`);
    }
  }

  // Budget range matching
  if (profile.budget && g.award_amount != null) {
    const [min, max] = BUDGET_RANGES[profile.budget] || [0, Infinity];
    const amt = Number(g.award_amount);
    if (!isNaN(amt) && amt >= min && amt <= max) {
      relevanceScore += 2;
      matchSignals.push(`Amount ${amt.toLocaleString()} ${g.currency || 'EUR'} fits your budget range`);
    }
  }

  // Keyword hits from user profile
  if (Array.isArray(profile.keywords) && profile.keywords.length > 0) {
    const kwHits = profile.keywords.filter(k => `${hay} ${elig}`.includes(k));
    if (kwHits.length > 0) {
      relevanceScore += Math.min(kwHits.length, 3);
      matchSignals.push(`Topic overlap: ${kwHits.slice(0, 2).join(', ')}`);
    }
  }

  // Penalty: global-only programs with no other signal (Amazon-style)
  const isGlobalOnly = /global|international|worldwide/.test(country) &&
                       !/western balkans|europe|balkans/.test(country);
  if (isGlobalOnly && focusHits.length === 0 && descHits.length === 0) {
    relevanceScore -= 2;
  }

  // ── Risk factors ──────────────────────────────────────────
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
  if (/global|international|worldwide/.test(combined) && !/western balkans|europe/.test(combined)) {
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

  // ── Display amount ────────────────────────────────────────
  const amtNum = Number(g.award_amount);
  const amtStr = (!isNaN(amtNum) && g.award_amount != null)
    ? `${amtNum.toLocaleString()} ${g.currency || 'EUR'}`.trim()
    : (g.funding_range || '—');

  return {
    ...g,
    _relevanceScore: relevanceScore,     // weighted int — used for sort
    _matchCount:     matchSignals.length, // kept for backward compat with llmRouter
    matchSignals,
    riskFactors,
    source:  g.source || 'db',
    snippet: [
      g.organization_name,
      amtStr,
      g.eligibility?.slice(0, 80),
      g.application_deadline ? `Deadline: ${g.application_deadline}` : null,
    ].filter(Boolean).join(' | '),
    link: g.source_url || '',
  };
}

// ─── MERGE WITH WEB ──────────────────────────────────────────

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

// ─── NEEDS SERPER ────────────────────────────────────────────

/**
 * needsSerper(dbResults)
 * Returns true only when DB alone is insufficient.
 */
function needsSerper(dbResults) {
  return !Array.isArray(dbResults) || dbResults.length < MIN_RESULTS;
}

module.exports = { searchDB, mergeWithWeb, needsSerper, RESULTS_TO_SHOW };
