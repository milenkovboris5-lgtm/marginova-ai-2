// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/fundingScorer.js
// v9 — Individual/Поединец penalty + MK terms in ORG_ELIGIBILITY
//
// CHANGES over v8:
// 1. ORG_ELIGIBILITY Individual — додадени македонски термини
//    ('трговец поединец','поединец','самовработен','физичко лице')
// 2. annotate() — SME penalty (-6 score) кога корисникот е поединец
//    а програмата бара регистрирана компанија
//    Ова осигурува Eurostars/EIC никогаш не се 🏆 за поединец
// ═══════════════════════════════════════════════════════════

const { getTable } = require('./utils');

console.log('[fundingScorer] v9 loaded — Individual penalty, MK terms');

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
  // v9: Added Macedonian terms for individual/sole trader
  'Individual / Entrepreneur':  [
    'individual','entrepreneur','founder','self-employed','freelance',
    'creator','person','applicant',
    'трговец поединец','поединец','самовработен','физичко лице',
    'sole trader','sole proprietor',
  ],
};

// Keywords that indicate a program requires a registered company (not individual)
const SME_REQUIRED_KEYWORDS = [
  'sme','small and medium','enterprise','company','legal entity',
  'registered company','incorporated','компанија','претпријатие',
  'правно лице','трговско друштво','дооел','ад','акционерско',
  'innovative sme','sme-led','sme partner',
];

const EUROPEAN_REGIONS = [
  'europe','european union','eu','western balkans','balkans',
  'southeast europe','eastern europe','central europe',
  'global','international','worldwide',
];

const SELECT_COLS     = 'id,title,organization_name,opportunity_type,funding_range,award_amount,currency,focus_areas,eligibility,application_deadline,country,description,source_url,status';
const DB_FETCH_LIMIT  = 120;
const MIN_RESULTS     = 3;
const RESULTS_TO_SHOW = 6;

function buildSectorOrParts(keywords) {
  if (!keywords || keywords.length === 0) return null;
  const focusParts = keywords.map(k => `focus_areas.ilike.%${k}%`);
  const descParts  = keywords.slice(0, 6).map(k => `description.ilike.%${k}%`);
  return [...focusParts, ...descParts].join(',');
}

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

async function searchDB(profile) {
  const today     = new Date().toISOString().split('T')[0];
  const sectorKws = SECTOR_SQL_KEYWORDS[profile.sector] || [];
  const queries   = [];

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

  const annotated = merged.map(g => annotate(g, profile, sectorKws));

  annotated.sort((a, b) => {
    const scoreDiff = (b._relevanceScore || 0) - (a._relevanceScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const da = a.application_deadline || '9999-12-31';
    const db = b.application_deadline || '9999-12-31';
    return da < db ? -1 : 1;
  });

  const final = annotated.slice(0, RESULTS_TO_SHOW);
  console.log('[searchDB] Returning', final.length, 'results (sorted by relevance, then deadline)');
  return final;
}

function annotate(g, profile, sectorKws) {
  const focus   = (g.focus_areas || '').toLowerCase();
  const desc    = (g.description || '').toLowerCase();
  const elig    = (g.eligibility || '').toLowerCase();
  const country = (g.country     || '').toLowerCase();
  const hay     = `${focus} ${desc}`;

  let relevanceScore = 0;
  const matchSignals = [];

  // Sector keyword hits
  const focusHits = sectorKws.filter(k => focus.includes(k));
  const descHits  = sectorKws.filter(k => desc.includes(k) && !focus.includes(k));

  if (focusHits.length > 0) {
    relevanceScore += 3;
    relevanceScore += Math.min(focusHits.length - 1, 4);
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
      relevanceScore += 4;
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

  // v9: INDIVIDUAL vs SME PENALTY
  // Ако корисникот е поединец и програмата бара компанија → -6 score
  const isIndividual = profile.orgType && (
    profile.orgType.toLowerCase().includes('individual') ||
    profile.orgType.toLowerCase().includes('entrepreneur') ||
    profile.orgType.toLowerCase().includes('поединец') ||
    profile.orgType.toLowerCase().includes('трговец') ||
    profile.orgType.toLowerCase().includes('самовработен') ||
    profile.orgType.toLowerCase().includes('sole trader') ||
    profile.orgType.toLowerCase().includes('sole proprietor')
  );

  if (isIndividual) {
    const eligAndDesc = `${elig} ${desc}`;
    const requiresCompany = SME_REQUIRED_KEYWORDS.some(k => eligAndDesc.includes(k));
    if (requiresCompany) {
      relevanceScore -= 6;
      console.log(`[annotate] Individual penalty applied to: ${g.title} (score -6)`);
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

  // Global-only penalty
  const isGlobalOnly = /global|international|worldwide/.test(country) &&
                       !/western balkans|europe|balkans/.test(country);
  if (isGlobalOnly && focusHits.length === 0 && descHits.length === 0) {
    relevanceScore -= 2;
  }

  // Risk factors
  const riskFactors = [];

  // v9: Individual ineligibility risk — shown first
  if (isIndividual) {
    const eligAndDesc = `${elig} ${desc}`;
    const requiresCompany = SME_REQUIRED_KEYWORDS.some(k => eligAndDesc.includes(k));
    if (requiresCompany) {
      riskFactors.push('⛔ Поединци/трговци поединци не се подобни — бара регистрирана компанија');
    }
  }

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

  // Display amount
  const amtNum = Number(g.award_amount);
  const amtStr = (!isNaN(amtNum) && g.award_amount != null)
    ? `${amtNum.toLocaleString()} ${g.currency || 'EUR'}`.trim()
    : (g.funding_range || '—');

  return {
    ...g,
    _relevanceScore: relevanceScore,
    _matchCount:     matchSignals.length,
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

function mergeWithWeb(dbResults, webResults) {
  const dbIds  = new Set((dbResults || []).map(r => r.id));
  const merged = [
    ...(dbResults || []),
    ...(webResults || []).filter(r => !dbIds.has(r.id)),
  ].slice(0, RESULTS_TO_SHOW);
  console.log(`[mergeWithWeb] db:${dbResults?.length || 0} web:${webResults?.length || 0} final:${merged.length}`);
  return merged;
}
module.exports = { searchDB, RESULTS_TO_SHOW };

