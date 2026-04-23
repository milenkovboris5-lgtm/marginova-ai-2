const { createClient } = require('@supabase/supabase-js');

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const SERPER_KEY = process.env.SERPER_API_KEY;

console.log('SUPA_KEY:', SUPA_KEY ? 'OK' : 'MISSING');
console.log('SERPER_KEY:', SERPER_KEY ? 'OK' : 'MISSING');

const DAILY_LIMIT = 200;
const PLANS = { free: 20, starter: 500, pro: 2000, business: -1 };

const supabase = (SUPA_URL && SUPA_KEY)
  ? createClient(SUPA_URL, SUPA_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

function ft(url, opts = {}, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

function getTable(name) {
  if (!supabase) throw new Error('Supabase client not initialized');
  return supabase.from(name);
}

async function checkIP(req) {
  if (!supabase) return true;

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const today = new Date().toISOString().split('T')[0];

  try {
    const { data: row, error } = await getTable('ip_limits')
      .select('ip,count,reset_date')
      .eq('ip', ip)
      .maybeSingle();

    if (error) {
      console.log('[DB GET ip_limits]', error.message);
      return true;
    }

    if (!row || row.reset_date !== today) {
      const { error: upsertError } = await getTable('ip_limits').upsert(
        { ip, count: 1, reset_date: today },
        { onConflict: 'ip' }
      );

      if (upsertError) console.log('[IP UPSERT]', upsertError.message);
      return true;
    }

    if ((row.count || 0) >= DAILY_LIMIT) return false;

    const { error: updateError } = await getTable('ip_limits')
      .update({ count: (row.count || 0) + 1 })
      .eq('ip', ip);

    if (updateError) console.log('[IP UPDATE]', updateError.message);
    return true;
  } catch (e) {
    console.log('[IP CHECK]', e.message);
    return true;
  }
}

async function checkQuota(userId) {
  if (!userId || !supabase) return true;

  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: p, error } = await getTable('profiles')
      .select('plan,daily_msgs,last_msg_date')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !p) return true;

    const limit = PLANS[p.plan] ?? 20;
    if (limit === -1) return true;

    const used = p.last_msg_date === today ? (p.daily_msgs || 0) : 0;
    return used < limit;
  } catch {
    return true;
  }
}

async function loadProfile(userId) {
  if (!userId || !supabase) return null;

  try {
    const { data: p, error } = await getTable('profiles')
      .select('sector,country,organization_type,goals,plan,detected_sector,detected_org_type,detected_country')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !p) return null;

    return {
      ...p,
      sector: p.sector || p.detected_sector || null,
      organization_type: p.organization_type || p.detected_org_type || null,
      country: p.country || p.detected_country || null,
    };
  } catch {
    return null;
  }
}

function detectLang(text) {
  if (/ќ|ѓ|ѕ|љ|њ|џ/i.test(text)) return 'mk';
  if (/ћ|ђ/i.test(text)) return 'sr';
  if (/јас|сум|македонија|барам|грант|работам|НВО|фонд/i.test(text)) return 'mk';
  if (/[а-шА-Ш]/.test(text)) return 'mk';
  if (/\b(jas|sum|makedonija|zdravo|zemja|proekt|grant|fond)\b/i.test(text)) return 'mk';
  return 'en';
}

const LANG_NAMES = {
  mk: 'Macedonian',
  sr: 'Serbian',
  en: 'English'
};

function needsSearch(text, conversationText) {
  const t = `${text} ${conversationText}`.toLowerCase();
  return /grant|fund|financ|subsid|fellowship|scholarship|award|donor|ngo|program|open call|call for proposal|support|money|euros|invest|tender|startup|funding/i.test(t);
}

function detectProfile(text, supaProfile) {
  const t = text.toLowerCase();

  const sector =
    /\bit\b|tech|software|digital|technology|ai/.test(t) ? 'IT / Technology' :
    /agri|farm|rural|crop|livestock|ipard/.test(t) ? 'Agriculture' :
    /educat|school|youth|training|learning/.test(t) ? 'Education' :
    /environment|climate|green|energy|renewable|solar/.test(t) ? 'Environment / Energy' :
    /civil|ngo|nonprofit|association|society/.test(t) ? 'Civil Society' :
    /tourism|culture|heritage|creative|art/.test(t) ? 'Tourism / Culture' :
    /health|medical|social|welfare/.test(t) ? 'Health / Social' :
    /research|science|innovation|university|academic/.test(t) ? 'Research / Innovation' :
    /sme|small business|company|enterprise|startup/.test(t) ? 'SME / Business' :
    supaProfile?.sector || null;

  const orgType =
    /startup/.test(t) ? 'Startup' :
    /\bngo\b|nonprofit|association|foundation|civil society/.test(t) ? 'NGO / Association' :
    /farmer|farm|agricultural|holding|ipard/.test(t) ? 'Agricultural holding' :
    /individual|freelance|self-employed|self.employed|poedinec|creator/.test(t) ? 'Individual / Entrepreneur' :
    /\bsme\b|\bltd\b|\bdoo\b|small business/.test(t) ? 'SME' :
    /municipality|local government|public body/.test(t) ? 'Municipality / Public body' :
    /university|research institute|academic/.test(t) ? 'University / Research' :
    supaProfile?.organization_type || null;

  const country =
    /macedon|makedon|north macedon|mkd/.test(t) ? 'North Macedonia' :
    /\bserbia\b|srbija/.test(t) ? 'Serbia' :
    /croatia|hrvatska/.test(t) ? 'Croatia' :
    /\bbosnia\b/.test(t) ? 'Bosnia' :
    /bulgaria|bulgar/.test(t) ? 'Bulgaria' :
    /\balbania\b/.test(t) ? 'Albania' :
    /\bkosovo\b/.test(t) ? 'Kosovo' :
    supaProfile?.country || null;

  const budget =
    /1[\s,.]?000[\s,.]?000|1\s*million/.test(t) ? 'above €500k' :
    /500[\s,.]?000|500k/.test(t) ? '€150k–€500k' :
    /100[\s,.]?000|100k/.test(t) ? '€30k–€150k' :
    /[5-9]\d[\s,.]?000/.test(t) ? '€30k–€150k' :
    /[1-4]\d[\s,.]?000/.test(t) ? 'up to €30k' :
    supaProfile?.goals || null;

  return { sector, orgType, country, budget };
}

async function searchFundingDB(profile) {
  if (!supabase) return [];

  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: allRows, error } = await getTable('funding_opportunities')
      .select('title,organization_name,opportunity_type,funding_range,award_amount,currency,focus_areas,eligibility,application_deadline,country,description,source_url,status')
      .eq('status', 'Open')
      .limit(100);

    if (error) {
      console.log('[DB SEARCH] error:', error.message);
      return [];
    }

    if (!allRows || allRows.length === 0) return [];

    const rows = allRows.filter(g => !g.application_deadline || g.application_deadline >= today);

    const scored = rows.map(g => {
      let score = 0;

      const focus = String(g.focus_areas || '').toLowerCase();
      const desc = String(g.description || '').toLowerCase();
      const elig = String(g.eligibility || '').toLowerCase();
      const type = String(g.opportunity_type || '').toLowerCase();
      const country = String(g.country || '').toLowerCase();

      if (profile.sector) {
        const sectorMap = {
          'IT / Technology': ['ai', 'technology', 'digital', 'software', 'startup', 'innovation', 'ict', 'tech'],
          'Agriculture': ['agriculture', 'farmer', 'rural', 'food', 'farm', 'ipard'],
          'Education': ['education', 'school', 'learning', 'training', 'youth'],
          'Environment / Energy': ['climate', 'environment', 'green', 'energy', 'renewable'],
          'Civil Society': ['ngo', 'civil society', 'community', 'rights', 'nonprofit'],
          'Health / Social': ['health', 'social', 'welfare', 'care'],
          'Research / Innovation': ['research', 'science', 'innovation', 'academic', 'university'],
          'SME / Business': ['business', 'enterprise', 'sme', 'company', 'entrepreneur'],
          'Tourism / Culture': ['tourism', 'culture', 'heritage', 'creative', 'art']
        };

        const kws = sectorMap[profile.sector] || [];
        const hay = `${focus} ${desc}`;
        const hits = kws.filter(k => hay.includes(k)).length;
        if (hits > 0) score += Math.min(35, hits * 12);
      }

      if (profile.country) {
        const pc = profile.country.toLowerCase();
        if (
          !country ||
          country.includes('global') ||
          country.includes('europe') ||
          country.includes(pc) ||
          (pc.includes('north macedonia') && country.includes('western balkans'))
        ) {
          score += 25;
        }
      }

      if (profile.orgType) {
        const orgMap = {
          'NGO / Association': ['ngo', 'nonprofit', 'association', 'civil society', 'foundation'],
          'Startup': ['startup', 'early stage', 'venture', 'founder'],
          'Agricultural holding': ['farmer', 'agricultural', 'holding', 'ipard'],
          'SME': ['sme', 'enterprise', 'company', 'business'],
          'Municipality / Public body': ['municipality', 'local government', 'public body', 'public institution'],
          'University / Research': ['university', 'research', 'academic', 'institute'],
          'Individual / Entrepreneur': ['individual', 'entrepreneur', 'founder', 'self-employed', 'freelance']
        };

        const kws = orgMap[profile.orgType] || [];
        const hay = `${elig} ${desc} ${type}`;
        const hits = kws.filter(k => hay.includes(k)).length;
        if (hits > 0) score += Math.min(20, hits * 10);
      }

      if (profile.budget && g.award_amount != null) {
        const amt = Number(g.award_amount);
        const budgetRanges = {
          'up to €30k': [0, 30000],
          '€30k–€150k': [30000, 150000],
          '€150k–€500k': [150000, 500000],
          'above €500k': [500000, Infinity]
        };
        const [minB, maxB] = budgetRanges[profile.budget] || [0, Infinity];
        if (amt >= minB && amt <= maxB) score += 15;
      }

      if (g.application_deadline) score += 5;

      return {
        ...g,
        score: Math.max(0, Math.min(100, score)),
        source: 'db',
        title: g.title,
        snippet: [
          g.organization_name,
          g.award_amount ? `${g.award_amount} ${g.currency || ''}`.trim() : g.funding_range,
          g.eligibility,
          g.application_deadline ? `Deadline: ${g.application_deadline}` : null
        ].filter(Boolean).join(' | '),
        link: g.source_url || ''
      };
    });

    return scored
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  } catch (e) {
    console.log('[DB SEARCH] error:', e.message);
    return [];
  }
}

function buildSerperQuery(userText, profile) {
  const parts = [
    userText,
    profile.sector || '',
    profile.orgType || '',
    profile.country || '',
    'grants funding programs open call'
  ].filter(Boolean);

  return parts.join(' ');
}

async function searchWebSerper(userText, profile) {
  if (!SERPER_KEY) return [];

  const q = buildSerperQuery(userText, profile);

  try {
    const r = await ft('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q, num: 6 })
    }, 10000);

    if (!r.ok) {
      console.log('[SERPER] status:', r.status);
      return [];
    }

    const data = await r.json();
    const organic = Array.isArray(data.organic) ? data.organic : [];

    return organic.slice(0, 6).map(item => ({
      source: 'web',
      title: item.title || '',
      link: item.link || '',
      snippet: item.snippet || '',
      score: 0
    }));
  } catch (e) {
    console.log('[SERPER] error:', e.message);
    return [];
  }
}

function buildSystemPrompt(lang, today, profile, dbResults, webResults) {
  const L = LANG_NAMES[lang] || 'English';

  const profileText = profile.sector || profile.orgType || profile.country
    ? `\nOrganization type: ${profile.orgType || 'not specified'}
Sector: ${profile.sector || 'not specified'}
Country: ${profile.country || 'not specified'}
Budget range: ${profile.budget || 'not specified'}`
    : '\nProfile not yet collected — ask one targeted question.';

  const dbText = dbResults.length
    ? '\n\nDATABASE RESULTS:\n' + dbResults.map((r, i) =>
        `[${i + 1}] Match:${r.score ?? 0}% | ${r.title}\n${r.snippet}\nURL: ${r.link || 'N/A'}`
      ).join('\n\n')
    : '\n\nDATABASE RESULTS:\nNone';

  const webText = webResults.length
    ? '\n\nWEB RESULTS:\n' + webResults.map((r, i) =>
        `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.link || 'N/A'}`
      ).join('\n\n')
    : '\n\nWEB RESULTS:\nNone';

  return `LANGUAGE: Always respond in ${L}. Match the user's language exactly.

You are MARGINOVA — a funding intelligence engine.

Today: ${today}
USER PROFILE:${profileText}

RULES:
- Prioritize database results first
- If database results exist, show them first
- If web results exist, show them in a separate external section
- Do not say you cannot search the web if WEB RESULTS are provided
- Do not ask follow-up questions if database or web opportunities are already available
- If database results are weak, combine database + web in a practical way
- Never claim web results are internal database results
- Be direct, practical, and concise

OUTPUT STRUCTURE:
1. Brief conclusion
2. Database matches
3. External matches
4. One concrete next action

FORMAT FOR DATABASE RESULTS:
📋 [Program name]
🏷️ Извор: База на податоци
🎯 Совпаѓање: [X]%
💰 [Amount / range if available]
✅ Зошто се квалификувате
⚠️ Главен ризик
🔗 [URL]

FORMAT FOR EXTERNAL RESULTS:
📋 [Program name]
🏷️ Извор: Web / External
🎯 Проценет fit: [Low / Medium / Strong]
💰 [Amount / range if known]
✅ Зошто може да одговара
⚠️ Што мора да се провери
🔗 [URL or "Провери официјален извор"]

If database matches are limited or weak, explicitly say so, then show external options.${dbText}${webText}`;
}

async function geminiCall(systemPrompt, messages, imageData, imageType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }]
  }));

  if (imageData && imageType && contents.length > 0) {
    contents[contents.length - 1].parts.push({
      inline_data: { mime_type: imageType, data: imageData }
    });
  }

  if (!contents.length) {
    contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  const r = await ft(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 4096, temperature: 0.35 }
    })
  }, 30000);

  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const d = await r.json();
  if (d.error) throw new Error(d.error.message);

  const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

async function gemini(systemPrompt, messages, imageData, imageType) {
  try {
    return await geminiCall(systemPrompt, messages, imageData, imageType);
  } catch (e) {
    console.log('[GEMINI] retry:', e.message);
    await new Promise(r => setTimeout(r, 1500));
    try {
      return await geminiCall(systemPrompt, messages, imageData, imageType);
    } catch {
      throw new Error('Service temporarily unavailable. Please try again in a moment.');
    }
  }
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
  if (!GEMINI_KEY) return res.status(500).json({ error: { message: 'Missing GEMINI_API_KEY.' } });

  if (!(await checkIP(req))) {
    return res.status(429).json({ error: { message: 'Daily limit reached. Try again tomorrow.' } });
  }

  try {
    const body = req.body || {};
    const userId = body.userId || null;
    const userText = body.messages?.[body.messages.length - 1]?.content || '';
    const imageData = body.image || null;
    const imageType = body.imageType || null;

    if (userText.length > 2000) {
      return res.status(400).json({ error: { message: 'Message too long. Max 2000 characters.' } });
    }

    if (userId && !(await checkQuota(userId))) {
      return res.status(429).json({
        error: { message: 'Message limit reached. Please upgrade your plan.' },
        quota_exceeded: true
      });
    }

    const lang = body.lang || detectLang(userText);
    const today = new Date().toLocaleDateString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });

    const conversationText = (body.messages || []).map(m => m.content || '').join(' ');
    const supaProfile = userId ? await loadProfile(userId) : null;
    const profile = detectProfile(conversationText, supaProfile);

    if (userId && (profile.sector || profile.orgType || profile.country) && supabase) {
      getTable('profiles')
        .update({
          detected_sector: profile.sector,
          detected_org_type: profile.orgType,
          detected_country: profile.country
        })
        .eq('user_id', userId)
        .then(({ error }) => {
          if (error) console.log('[PROFILE PATCH]', error.message);
        })
        .catch(() => {});
    }

    const shouldSearch = needsSearch(userText, conversationText) || !!imageData;

    let dbResults = [];
    let webResults = [];

    if (shouldSearch && !imageData) {
      dbResults = await searchFundingDB(profile);
    }

    const bestScore = dbResults[0]?.score || 0;
    const allowExternalFallback =
      shouldSearch &&
      !imageData &&
      (dbResults.length === 0 || bestScore < 85);

    if (allowExternalFallback) {
      webResults = await searchWebSerper(userText, profile);
    }

    const messages = (body.messages || []).slice(-8).map(m => ({
      role: m.role,
      content: String(m.content || '')
    }));

    const systemPrompt = buildSystemPrompt(
      lang,
      today,
      profile,
      dbResults,
      webResults
    );

    const text = await gemini(systemPrompt, messages, imageData, imageType);

    return res.status(200).json({
      content: [{ type: 'text', text }],
      intent: shouldSearch ? 'grant' : 'general',
      db_results: dbResults.length,
      web_results: webResults.length,
      external_fallback_allowed: allowExternalFallback,
      top_matches: dbResults.slice(0, 5).map(r => ({
        title: r.title || '',
        score: Number.isFinite(r.score) ? r.score : 0,
        source: 'db',
        link: r.link || '',
        snippet: r.snippet || ''
      })),
      web_matches: webResults.slice(0, 5),
      debug_results: {
        db: dbResults,
        web: webResults
      }
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
