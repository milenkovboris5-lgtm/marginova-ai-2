// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/fundingScorer.js
// SQL-first sector-aware funding search.
// Two parallel queries: sector filter + country filter.
// JS scoring only for final ranking of merged results.
// ═══════════════════════════════════════════════════════════

const { getTable } = require('./utils');

// Primary keywords per sector — used in SQL ilike filter
const SECTOR_SQL_KEYWORDS = {
  'Environment / Energy':   ['environment', 'climate', 'renewable', 'biodiversity', 'ecosystem', 'conservation', 'clean energy', 'pollution', 'nature', 'wildlife', 'forest', 'sustainability', 'green agenda', 'pont', 'gef', 'geff', 'wwf', 'life programme'],
  'Civil Society':          ['civil society', 'ngo', 'nonprofit', 'advocacy', 'democracy', 'community', 'grassroots', 'rights', 'governance'],
  'Agriculture':            ['agriculture', 'farmer', 'rural', 'food', 'farm', 'ipard', 'agri'],
  'Education':              ['education', 'school', 'learning', 'training', 'youth', 'student', 'scholarship', 'fellowship', 'erasmus'],
  'IT / Technology':        ['technology', 'digital', 'software', 'ai', 'innovation', 'ict', 'startup', 'tech'],
  'Health / Social':        ['health', 'social', 'welfare', 'care', 'women', 'gender'],
  'Research / Innovation':  ['research', 'science', 'innovation', 'university', 'academic', 'phd'],
  'SME / Business':         ['business', 'enterprise', 'sme', 'company', 'entrepreneur'],
  'Tourism / Culture':      ['tourism', 'culture', 'heritage', 'creative', 'art'],
  'Student / Youth':        ['student', 'scholarship', 'fellowship', 'youth', 'erasmus', 'fulbright', 'daad', 'stipend'],
  'Individual / Entrepreneur': ['individual', 'entrepreneur', 'founder', 'creator', 'freelance', 'startup'],
};

// Org type keywords for eligibility scoring
const ORG_ELIGIBILITY = {
  'NGO / Association':          ['ngo', 'nonprofit', 'association', 'civil society', 'foundation'],
  'Startup':                    ['startup', 'early stage', 'venture', 'founder'],
  'Agricultural holding':       ['farmer', 'agricultural', 'holding', 'ipard'],
  'SME':                        ['sme', 'enterprise', 'company', 'business'],
  'Municipality / Public body': ['municipality', 'local government', 'public body'],
  'University / Research':      ['university', 'research', 'academic', 'institute'],
  'Individual / Entrepreneur':  ['individual', 'entrepreneur', 'founder', 'self-employed', 'freelance', 'creator', 'person', 'applicant'],
};

const BUDGET_RANGES = {
  'up to €30k':   [0, 30000],
  '€30k–€150k':   [30000, 150000],
  '€150k–€500k':  [150000, 500000],
  'above €500k':  [500000, Infinity],
};

const SELECT_COLS = 'id,title,organization_name,opportunity_type,funding_range,award_amount,currency,focus_areas,eligibility,application_deadline,country,description,source_url,status';

/**
 * searchDB(profile)
 * Two parallel SQL queries:
 *   1. Sector-filtered: ilike on focus_areas for top 3 sector keywords
 *   2. Country-filtered: ilike on country for profile country
 * Merges, deduplicates, scores, returns top 6.
 */
async function searchDB(profile) {
  const today = new Date().toISOString().split('T')[0];
  const sectorKws = SECTOR_SQL_KEYWORDS[profile.sector] || [];

  // Build parallel queries
  const queries = [];

  // Query 1: sector filter (top 3 keywords with OR)
  if (sectorKws.length > 0) {
    const [k1, k2, k3] = sectorKws;
    const orFilter = [
      `focus_areas.ilike.%${k1}%`,
      k2 ? `focus_areas.ilike.%${k2}%` : null,
      k3 ? `focus_areas.ilike.%${k3}%` : null,
      `description.ilike.%${k1}%`,
    ].filter(Boolean).join(',');

    queries.push(
      getTable('funding_opportunities')
        .select(SELECT_COLS)
        .eq('status', 'Open')
        .or(orFilter)
        .gte('application_deadline', today)
        .limit(60)
    );
  }

  // Query 2: country/regional filter
  const countryKw = profile.country || 'Balkans';
  queries.push(
    getTable('funding_opportunities')
      .select(SELECT_COLS)
      .eq('status', 'Open')
      .or(`country.ilike.%${countryKw}%,country.ilike.%global%,country.ilike.%Western Balkans%,country.ilike.%Europe%`)
      .limit(60)
  );

  const results = await Promise.all(queries);

  // Merge + deduplicate (sector results first = higher priority)
  const seen = new Set();
  const merged = [];
  for (const { data } of results) {
    for (const row of (data || [])) {
      if (!seen.has(row.id) && (!row.application_deadline || row.application_deadline >= today)) {
        seen.add(row.id);
        merged.push(row);
      }
    }
  }

  if (!merged.length) return [];

  // Score merged results
  const scored = merged.map(g => score(g, profile, sectorKws));

  const ranked = scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  if (ranked.length) {
    console.log('[DB] matched:', ranked.length, 'top score:', ranked[0].score);
    console.log('[DB] top 3:', ranked.slice(0, 3).map(r => `${r.title?.slice(0, 28)} (${r.score})`).join(' | '));
  }

  return ranked;
}

/**
 * score(g, profile, sectorKws)
 * Pure function — scores one opportunity against a profile.
 */
function score(g, profile, sectorKws) {
  let s = 0;
  const focus   = (g.focus_areas   || '').toLowerCase();
  const desc    = (g.description   || '').toLowerCase();
  const elig    = (g.eligibility   || '').toLowerCase();
  const country = (g.country       || '').toLowerCase();
  const hay     = `${focus} ${desc}`;

  // Sector score — primary driver (boosted weight)
  if (sectorKws.length) {
    const hits = sectorKws.filter(k => hay.includes(k)).length;
    if (hits > 0) s += Math.min(50, hits * 15);
  }

  // Keyword bonus from conversation
  if (profile.keywords?.length) {
    const hits = profile.keywords.filter(k => `${hay} ${elig}`.includes(k)).length;
    if (hits > 0) s += Math.min(15, hits * 5);
  }

  // Country score
  if (profile.country) {
    const pc = profile.country.toLowerCase();
    if (country.includes(pc))                                                s += 20;
    else if (country.includes('global') || country.includes('europe') ||
             country.includes('western balkans') || country.includes('southeast')) s += 12;
    else                                                                     s -= 5;
  }

  // Budget match
  if (profile.budget && g.award_amount != null) {
    const [min, max] = BUDGET_RANGES[profile.budget] || [0, Infinity];
    if (Number(g.award_amount) >= min && Number(g.award_amount) <= max) s += 15;
  }

  // Org type match
  if (profile.orgType) {
    const kws  = ORG_ELIGIBILITY[profile.orgType] || [];
    const hits = kws.filter(k => `${elig} ${desc}`.includes(k)).length;
    if (hits > 0) s += Math.min(15, hits * 8);
    else          s -= 5;
  }

  // Deadline bonus (has a date = more reliable)
  if (g.application_deadline) s += 5;

  return {
    ...g,
    score:      Math.max(0, Math.min(100, s)),
    score_type: 'match',
    source:     'db',
    snippet:    [
      g.organization_name,
      g.award_amount ? `${g.award_amount} ${g.currency || ''}`.trim() : g.funding_range,
      g.eligibility,
      g.application_deadline ? `Deadline: ${g.application_deadline}` : null,
    ].filter(Boolean).join(' | '),
    link: g.source_url || '',
  };
}

/**
 * mergeWithWeb(dbResults, webResults)
 * DB results first (verified), web fills gaps.
 */
function mergeWithWeb(dbResults, webResults) {
  const dbIds = new Set(dbResults.map(r => r.id));
  return [
    ...dbResults,
    ...webResults.filter(r => !dbIds.has(r.id)),
  ].slice(0, 8);
}

module.exports = { searchDB, mergeWithWeb };
