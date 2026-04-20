// ═══════════════════════════════════════════
// MARGINOVA.AI — api/chat.js
// Grant Acquisition Engine
// VERSION: FINAL v4 — mk shortcut fix
// ═══════════════════════════════════════════

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const DAILY_LIMIT = 200;
const PLANS = { free: 20, starter: 500, pro: 2000, business: -1 };
const ipStore = {};

function ft(url, opts = {}, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

function checkIP(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const key = ip + '_' + new Date().toISOString().split('T')[0];
  const now = Date.now();
  for (const k in ipStore) if (ipStore[k].t < now) delete ipStore[k];
  if (!ipStore[key]) {
    const e = new Date(); e.setHours(23, 59, 59, 999);
    ipStore[key] = { n: 0, t: e.getTime() };
  }
  ipStore[key].n++;
  return ipStore[key].n <= DAILY_LIMIT;
}

async function dbGet(path) {
  if (!SUPA_URL || !SUPA_KEY) return null;
  try {
    const r = await ft(`${SUPA_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, Prefer: '' }
    }, 6000);
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function dbPatch(path, body) {
  if (!SUPA_URL || !SUPA_KEY) return;
  try {
    await ft(`${SUPA_URL}/rest/v1/${path}`, {
      method: 'PATCH',
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(body)
    }, 5000);
  } catch {}
}

async function checkQuota(userId) {
  if (!userId) return true;
  try {
    const today = new Date().toISOString().split('T')[0];
    const rows = await dbGet(`profiles?user_id=eq.${userId}&select=plan,daily_msgs,last_msg_date`);
    const p = rows?.[0];
    if (!p) return true;
    const limit = PLANS[p.plan] ?? 20;
    if (limit === -1) return true;
    const used = p.last_msg_date === today ? (p.daily_msgs || 0) : 0;
    return used < limit;
  } catch { return true; }
}

async function loadProfile(userId) {
  if (!userId) return null;
  try {
    const rows = await dbGet(`profiles?user_id=eq.${userId}&select=sector,country,organization_type,goals,plan,detected_sector,detected_org_type,detected_country`);
    const p = rows?.[0];
    if (!p) return null;
    return {
      ...p,
      sector: p.sector || p.detected_sector || null,
      organization_type: p.organization_type || p.detected_org_type || null,
      country: p.country || p.detected_country || 'mk',
    };
  } catch { return null; }
}

// ═══ FIT ENGINE ═══
function calcFitScore(grant, profile) {
  if (!profile) return 50;

  // ═══ SHORTCUT: if grant covers mk, always show it ═══
  const hasMk = grant.country?.some(c => c.toLowerCase() === 'mk');
  if (hasMk) return 70;

  let score = 0;

  // SECTOR MATCH (35 points)
  if (grant.sector && profile.sector) {
    const grantSectors = grant.sector.map(s => s.toLowerCase().trim());
    const userSector = profile.sector.toLowerCase().trim();

    const sectorAliases = {
      'it': ['it', 'tech', 'digital', 'software', 'innovation', 'иновации', 'дигитал', 'дигитализација', 'истражување', 'research', 'технологија', 'sme'],
      'agriculture': ['agriculture', 'agri', 'rural', 'рурален развој', 'земјоделство', 'food', 'храна'],
      'education': ['education', 'образование', 'млади', 'youth', 'training', 'обука'],
      'environment': ['environment', 'животна средина', 'green', 'зелена', 'еколог', 'energy', 'енерг', 'енергетика'],
      'civil society': ['civil society', 'граѓанско општество', 'граѓанск', 'ngo', 'нво', 'демократ', 'human rights'],
      'tourism': ['tourism', 'туризам', 'туриз', 'culture', 'култур', 'регионален развој'],
      'energy': ['energy', 'енергетика', 'енерг', 'renewable', 'обновлив', 'животна средина', 'environment'],
      'health': ['health', 'здравство', 'здравств', 'social', 'социјалн'],
      'research': ['research', 'истражување', 'innovation', 'иновации', 'it', 'tech', 'university', 'универзитет'],
      'sme': ['sme', 'it', 'tech', 'иновации', 'дигитализација', 'економски развој', 'претпријатија', 'компании'],
    };

    const aliases = sectorAliases[userSector] || [userSector];
    const matched = grantSectors.some(gs => aliases.some(a => gs.includes(a) || a.includes(gs)));

    if (matched) {
      score += 35;
    } else if (grantSectors.some(s => s.includes('сите') || s.includes('all') || s.includes('general') || s.includes('економски развој'))) {
      score += 20;
    } else {
      score += 5;
    }
  } else {
    score += 20;
  }

  // COUNTRY MATCH (30 points)
  if (grant.country && profile.country) {
    const grantCountries = grant.country.map(c => c.toLowerCase().trim());
    const userCountry = (profile.country || 'mk').toLowerCase().trim();

    if (grantCountries.includes(userCountry)) {
      score += 30;
    } else if (grantCountries.some(c => ['eu', 'balkans', 'europe', 'европ'].includes(c))) {
      score += 22;
    } else if (grantCountries.length > 3) {
      score += 15;
    }
  } else {
    score += 15;
  }

  // ORGANIZATION TYPE MATCH (25 points)
  if (grant.eligibility && profile.organization_type) {
    const eligLower = grant.eligibility.toLowerCase();
    const orgMap = {
      startup:      ['стартап', 'startup', 'претпријатија', 'компании', 'иновативни', 'нови', 'мали и средни'],
      sme:          ['мало', 'средно', 'претпријатија', 'sme', 'компании', 'бизнис', 'мали и средни', 'претпријатие'],
      ngo:          ['нво', 'здружение', 'фондација', 'граѓански', 'ngo', 'организации', 'граѓанск', 'civil'],
      agri:         ['земјоделск', 'рурал', 'agri', 'стопанства', 'физички лица'],
      municipality: ['општини', 'јавни', 'институции', 'municipality', 'локалн'],
      university:   ['универзитет', 'истражувач', 'university', 'research', 'институт'],
      individual:   ['физички', 'лица', 'individual', 'претприемач', 'граѓани']
    };
    const keywords = orgMap[profile.organization_type] || [];
    if (keywords.some(k => eligLower.includes(k))) {
      score += 25;
    } else {
      score += 8;
    }
  } else {
    score += 12;
  }

  // BUDGET MATCH (10 points)
  if (grant.min_amount && grant.max_amount && profile.goals) {
    const budgetMap = { small: 25000, medium: 90000, large: 300000, xlarge: 1000000 };
    const userBudget = budgetMap[profile.goals] || 90000;
    if (userBudget >= grant.min_amount && userBudget <= grant.max_amount) {
      score += 10;
    } else if (userBudget >= grant.min_amount * 0.3) {
      score += 5;
    }
  } else {
    score += 5;
  }

  return Math.min(score, 100);
}

async function loadProcesses(grantId) {
  if (!grantId) return [];
  try {
    const rows = await dbGet(`processes?grant_id=eq.${grantId}&order=step_number.asc&select=*`);
    return rows || [];
  } catch { return []; }
}

function detectLang(text) {
  if (/ќ|ѓ|ѕ|љ|њ|џ/i.test(text)) return 'mk';
  if (/ћ|ђ/i.test(text)) return 'sr';
  if (/јас|сум|македонија|животна средина|барам|грант|работам|организација|сектор|земја|општини|НВО|невладина|претпријатие|иновации|образование/i.test(text)) return 'mk';
  if (/[а-шА-Ш]/.test(text)) return 'mk';
  if (/\b(und|oder|ich|nicht|sie|wir)\b/.test(text)) return 'de';
  if (/\b(jest|się|nie|dla)\b/.test(text)) return 'pl';
  if (/\b(ve|bir|için|ile|bu)\b/.test(text)) return 'tr';
  if (/\b(dhe|është|për|nga)\b/.test(text)) return 'sq';
  if (/\b(sam|smo|nije|nisu|kako ste|brate|bre|jeste|jesam)\b/.test(text)) return 'sr';
  if (/\b(jas|sum|makedonija|macedonija|kako|zdravo|mozes|mozam|sakam|imam|sektor|zemja|organizacija|pretprijatie|proekt|grant|fond|makedonski|na makedonski)\b/.test(text)) return 'mk';
  return 'en';
}

function getIntent(text) {
  const t = text.toLowerCase();
  if (/грант|фонд|grant|fond|финансир|ipard|fitr|субвенц|повик|erasmus|horizon|civica|undp|interreg/.test(t)) return 'grant';
  if (/закон|право|договор|legal|zakon|ugovor|даноц|gdpr/.test(t)) return 'legal';
  if (/анализ|swot|analiz|споредба/.test(t)) return 'analysis';
  return 'business';
}

function detectGrantFocus(text) {
  const t = text.toLowerCase();
  if (/fitr|фитр/.test(t)) return 'FITR';
  if (/ipard|ипард/.test(t)) return 'IPARD';
  if (/erasmus|еразмус/.test(t)) return 'ERASMUS';
  if (/horizon|хоризон/.test(t)) return 'Horizon';
  if (/interreg|интеррег/.test(t)) return 'INTERREG';
  if (/civica|цивика/.test(t)) return 'Civica';
  if (/undp|ундп/.test(t)) return 'UNDP';
  if (/western balkans|западен балкан|wbf/.test(t)) return 'WBF';
  if (/eu4business|еу4бизнис/.test(t)) return 'EU4Business';
  return null;
}

const LANG_NAMES = {
  mk: 'македонски', sr: 'српски', hr: 'хрватски', bs: 'босански',
  en: 'English', de: 'Deutsch', sq: 'shqip', bg: 'български', tr: 'Türkçe', pl: 'polski'
};

function buildPrompt(lang, today, profile, matchedGrants, processes, grantFocus) {
  const L = LANG_NAMES[lang] || 'English';
  const langCode = lang || 'en';

  const profileText = profile ? `
Organization type: ${profile.organization_type || 'not specified'}
Sector: ${profile.sector || 'not specified'}
Country: ${profile.country || 'mk'}
Budget range: ${profile.goals || 'not specified'}` : 'Profile not set — ask user for sector, country, and organization type.';

  let grantsText = '';
  if (matchedGrants.length > 0) {
    grantsText = matchedGrants.map(g => `
---
Grant: ${g.name}
Funder: ${g.funder}
Fit Score: ${g.fitScore}%
Amount: €${g.min_amount?.toLocaleString() || '?'} — €${g.max_amount?.toLocaleString() || '?'}
Co-financing: ${g.co_finance_percent || '?'}%
Sectors: ${g.sector?.join(', ') || 'various'}
Countries: ${g.country?.join(', ') || 'various'}
Eligibility: ${g.eligibility || 'see portal'}
Portal: ${g.portal_url || 'N/A'}
Active: ${g.active ? 'Yes' : 'No'}`).join('\n');
  } else {
    grantsText = 'No grants matched the user profile above 30% fit score.';
  }

  let processText = '';
  if (processes.length > 0) {
    const grant = matchedGrants.find(g => processes[0]?.grant_id === g.id);
    processText = `\n\nAPPLICATION PROCESS${grant ? ` FOR ${grant.name.toUpperCase()}` : ''}:\n` +
      processes.map(p =>
        `Step ${p.step_number}/${processes.length}: ${p.title}
  What to do: ${p.description}
  Documents: ${p.documents?.join(', ') || 'none'}
  Duration: ${p.duration_days ? p.duration_days + ' days' : 'variable'}
  Where: ${p.institution || 'N/A'}
  Link: ${p.url || 'N/A'}`
      ).join('\n\n');
  }

  return `=== MANDATORY LANGUAGE: ${L.toUpperCase()} ===
You MUST ONLY respond in ${L}. This overrides all other instructions.
Detected language code: ${lang}
- mk = македонски (Macedonian) — NOT Serbian, NOT mixed
- sr = српски (Serbian)
- en = English
Current lang code: ${langCode}
If user says "можеш на македонски" or "na makedonski" → switch to македонски IMMEDIATELY.
NEVER say "I can only communicate in Serbian". NEVER refuse to switch language.
=== END LANGUAGE INSTRUCTION ===

You are MARGINOVA — Grant Acquisition Engine for the Balkans and Europe.
You are not an assistant. You are a grant strategist who has helped organizations win millions in funding.
You think like an investor: ruthless about fit, honest about chances, concrete about next steps.

Today: ${today}
${grantFocus ? 'User is asking about: ' + grantFocus : ''}

═══ USER PROFILE ═══${profileText}

CRITICAL: If profile shows "not specified" — do NOT invent or assume a profile. Ask the user ONE specific question to get the missing info. Never hallucinate sector, org type, or country.

═══ MATCHED GRANTS FROM DATABASE ═══${grantsText}
${processText}

═══ YOUR MISSION ═══

ASSESS FIT — For each matched grant, the Fit Score is already calculated above.
Use it to rank and recommend grants.

Fit Score interpretation:
- 90-100%: Perfect match → recommend immediately
- 70-89%: Strong match → recommend with minor notes
- 50-69%: Partial match → recommend with clear conditions
- 30-49%: Possible match → mention with caveats
- Below 30%: Do not recommend

RECOMMEND FORMAT (use for grant recommendations):
📋 [Grant name]
🏆 Fit Score: [X%]
💰 €[min] — €[max] | [co-finance]% co-financing
✅ Why you qualify: [specific reason based on profile]
⚠️ Main risk: [one concrete obstacle]
🔗 [portal_url]

GUIDE FORMAT (use when explaining application steps):
Step [N]/[total]: [title]
→ [what to do concisely]
→ [institution]
→ [duration]
→ Documents: [list]

═══ BEHAVIORAL RULES ═══
- General answers: max 200 words
- Step-by-step guides: as detailed as needed, no word limit
- Never hallucinate amounts, deadlines or links not in the database
- Never say "I cannot help" — always give best available advice
- If profile is incomplete → ask ONE specific question to complete it
- Use informal address (ти/твој in Macedonian/Serbian, tu in others)
- Challenge weak applications directly — protect users from wasting time on low-fit grants
- If no grants match → explain exactly why and what to change to become eligible
- End every response with ONE concrete next action the user can take today`;
}

async function gemini(systemPrompt, messages, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }]
  }));
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Hello' }] });

  const r = await ft(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 4096, temperature: 0.7 }
    })
  }, 30000);

  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 100)}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

module.exports = async function handler(req, res) {
  const ORIGINS = ['https://marginova.tech', 'https://www.marginova.tech', 'http://localhost:3000'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ORIGINS.includes(origin) ? origin : ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method Not Allowed' } });

  if (!checkIP(req)) return res.status(429).json({ error: { message: 'Daily limit reached.' } });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY.' } });

  try {
    const body = req.body;
    const userId = body.userId || null;
    const userText = body.messages?.[body.messages.length - 1]?.content || '';

    if (userText.length > 2000) return res.status(400).json({ error: { message: 'Max 2000 chars.' } });
    if (userId && !(await checkQuota(userId))) {
      return res.status(429).json({ error: { message: 'Limit reached. Upgrade.' }, quota_exceeded: true });
    }

    const lang = body.lang || detectLang(userText);
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const intent = getIntent(userText);
    const grantFocus = detectGrantFocus(userText);

    console.log(`[GAE] lang:${lang} intent:${intent} focus:${grantFocus || 'none'} user:${userId?.slice(0,8) || 'anon'}`);

    const [supaProfile, allGrants] = await Promise.all([
      loadProfile(userId),
      dbGet('grants?active=eq.true&select=*')
    ]);

    const conversationText = (body.messages || []).map(m => m.content || '').join(' ').toLowerCase();
    let profile = supaProfile;

    if (!profile || !profile.sector || !profile.organization_type) {
      const detectedSector =
        /\bit\b|tech|software|дигитал|веб|web|апп|app|платформ|platform|дигитализација/.test(conversationText) ? 'it' :
        /земјоделст|земјоделие|земјоделец|земјоделск|agri|рурал|фарм|farm|сточар|овошт|круш|јаболк|лозар|пченк|житар|нива|хектар|насади|добиток|млеко/.test(conversationText) ? 'agriculture' :
        /образован|education|учење|learning|школ|school|студент/.test(conversationText) ? 'education' :
        /животна средина|environment|зелен|green|еколог|climate/.test(conversationText) ? 'environment' :
        /нво|ngo|здружение|граѓанск|civil society/.test(conversationText) ? 'civil society' :
        /туриз|tourism|хотел|hotel|угостител/.test(conversationText) ? 'tourism' :
        /енерг|energy|сончев|solar|обновлив|renewable|енергетика/.test(conversationText) ? 'energy' :
        null;

      const detectedOrg =
        /стартап|startup|нова компанија|новооснован|spin.?off/.test(conversationText) ? 'startup' :
        /нво|НВО|ngo|NGO|здружение|фондација|граѓанск|невладин/.test(conversationText) ? 'ngo' :
        /земјоделец|земјоделие|фармер|farmer|аграр|стопанство|насади|хектар|круш|јаболк|лозар|нива|добиток/.test(conversationText) ? 'agri' :
        /мало претпријатие|средно претпријатие|sme|фирма|компанија|dooел|ооd|it компанија|it firma|it company|tech компанија|software компанија/.test(conversationText) ? 'sme' :
        /општина|municipality|јавна институција|публичен/.test(conversationText) ? 'municipality' :
        /универзитет|university|институт|истражув/.test(conversationText) ? 'university' :
        null;

      const detectedCountry =
        /македониј|makedon|северна македониј|north macedon/.test(conversationText) ? 'mk' :
        /србиј|srbij/.test(conversationText) ? 'rs' :
        /хрватск|hrvat/.test(conversationText) ? 'hr' :
        /босн|bosn/.test(conversationText) ? 'ba' :
        (supaProfile?.country) || 'mk';

      const detectedGoals =
        /1\.?000\.?000|1 милион|1m\b/.test(conversationText) ? 'xlarge' :
        /500\.?000|500k|петстотини/.test(conversationText) ? 'large' :
        /[2-9]\d{2}\.?000|[2-9]\d\dk/.test(conversationText) ? 'large' :
        /100\.?000|100k|сто илјади|сто хиљада/.test(conversationText) ? 'medium' :
        /[5-9]\d\.?000|[5-9]\dk/.test(conversationText) ? 'medium' :
        /[1-4]\d\.?000|[1-4]\dk/.test(conversationText) ? 'small' :
        null;

      if (detectedSector || detectedOrg || detectedGoals) {
        profile = {
          ...supaProfile,
          sector: detectedSector || supaProfile?.sector || null,
          organization_type: detectedOrg || supaProfile?.organization_type || null,
          country: detectedCountry,
          goals: detectedGoals || supaProfile?.goals || 'medium'
        };
        console.log('[GAE] Detected — sector:' + profile.sector + ' org:' + profile.organization_type + ' country:' + profile.country + ' budget:' + profile.goals);
        if (userId) {
          dbPatch('profiles?user_id=eq.' + userId, {
            detected_sector: profile.sector,
            detected_org_type: profile.organization_type,
            detected_country: profile.country
          }).catch(() => {});
        }
      }
    }

    let matchedGrants = [];
    console.log('[DEBUG] allGrants count:', allGrants ? allGrants.length : 'NULL');
    console.log('[DEBUG] profile:', JSON.stringify(profile));

    if (allGrants && allGrants.length > 0) {
      const scored = allGrants.map(g => {
        const fitScore = calcFitScore(g, profile);
        console.log('[DEBUG] Grant: ' + g.name + ' | Score: ' + fitScore);
        return { ...g, fitScore };
      });
      matchedGrants = scored.filter(g => g.fitScore > 30).sort((a, b) => b.fitScore - a.fitScore).slice(0, 6);
    }

    let processes = [];
    const wantsProcess = grantFocus || /процес|process|чекор|step|апликација|application|водич|guide|kako da|how to/.test(userText.toLowerCase());
    if (wantsProcess) {
      const targetGrant = grantFocus
        ? matchedGrants.find(g => g.name.toLowerCase().includes(grantFocus.toLowerCase()) || g.funder.toLowerCase().includes(grantFocus.toLowerCase()))
        : matchedGrants[0];
      if (targetGrant) {
        processes = await loadProcesses(targetGrant.id);
        console.log(`[GAE] Loaded ${processes.length} process steps for ${targetGrant.name}`);
      }
    }

    console.log(`[GAE] Profile:${profile ? 'yes' : 'no'} | Matched:${matchedGrants.length} | Processes:${processes.length}`);

    const messages = (body.messages || []).slice(-6).map(m => ({
      role: m.role,
      content: String(m.content || '')
    }));

    const systemPrompt = buildPrompt(lang, today, profile, matchedGrants, processes, grantFocus);
    const text = await gemini(systemPrompt, messages, apiKey);

    return res.status(200).json({ content: [{ type: 'text', text }], intent });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
