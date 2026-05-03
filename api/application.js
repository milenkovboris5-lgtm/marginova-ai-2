// ═════════════════════════════════════════════════════════════
// MARGINOVA.AI — api/application.js
// v4 — DeepSeek replaces Gemini for application drafting
//
// CHANGE: gemini() → deepseek() for the main generation call.
// DeepSeek-V3 handles long structured documents better.
// Gemini stays for classification/synthesis tasks (chat.js).
// ═════════════════════════════════════════════════════════════

const {
  supabase, getTable, ft, detectLang, LANG_NAMES,
  sanitizeField, checkIP, checkAndDeductQuota, deepseek, setCors
} = require('./_lib/utils');

// ═══ LOADERS ═══

async function loadPromptConfig(configKey = 'premium_application_system') {
  if (!supabase) return null;

  const { data, error } = await getTable('prompt_configs')
    .select('config_key,plan_type,module_name,version,description,system_prompt,application_prompt,lfm_rules,budget_rules')
    .eq('config_key', configKey)
    .maybeSingle();

  if (error) { console.log('[PROMPT CONFIG]', error.message); return null; }
  return data || null;
}

async function loadOpportunity(opportunityId) {
  if (!supabase || !opportunityId) return null;

  const { data, error } = await getTable('funding_opportunities')
    .select('id,title,organization_name,opportunity_type,funding_range,award_amount,currency,focus_areas,eligibility,application_deadline,country,description,source_url,status')
    .eq('id', opportunityId)
    .maybeSingle();

  if (error) { console.log('[OPPORTUNITY]', error.message); return null; }
  return data || null;
}

async function loadUserProfile(userId) {
  if (!supabase || !userId) return null;

  const { data, error } = await getTable('profiles')
    .select('user_id,plan,sector,country,organization_type,goals,detected_sector,detected_org_type,detected_country')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) { console.log('[PROFILE]', error.message); return null; }
  if (!data) return null;

  return {
    ...data,
    sector:            data.sector            || data.detected_sector   || null,
    organization_type: data.organization_type || data.detected_org_type || null,
    country:           data.country           || data.detected_country  || null,
  };
}

// ═══ PROMPT BUILDERS ═══

function buildFallbackPrompt(lang, today, profile, opportunity, input) {
  const L = LANG_NAMES[lang] || 'English';

  return `LANGUAGE: Always respond in ${L}. Match the user's language exactly.

You are Marginova Application Engine.
You do NOT search for grants.
You ONLY transform the selected opportunity data and user project data into a structured application draft.

Today: ${today}

OPPORTUNITY:
Title: ${opportunity?.title || 'Not provided'}
Organization: ${opportunity?.organization_name || 'Not provided'}
Type: ${opportunity?.opportunity_type || 'Not provided'}
Funding: ${opportunity?.award_amount ? `${opportunity.award_amount} ${opportunity.currency || ''}`.trim() : (opportunity?.funding_range || 'Not provided')}
Eligibility: ${opportunity?.eligibility || 'Not provided'}
Deadline: ${opportunity?.application_deadline || 'Not provided'}
Country: ${opportunity?.country || 'Not provided'}
Description: ${opportunity?.description || 'Not provided'}
Source URL: ${opportunity?.source_url || 'Not provided'}

USER PROFILE:
Organization type: ${profile?.organization_type || 'Not specified'}
Sector: ${profile?.sector || 'Not specified'}
Country: ${profile?.country || 'Not specified'}

PROJECT INPUT:
Project title: ${input?.project_title || 'Not provided'}
Project idea: ${input?.project_idea || 'Not provided'}
Target group: ${input?.target_group || 'Not provided'}
Location: ${input?.location || 'Not provided'}
Duration: ${input?.duration_months || 'Not provided'} months
Budget: ${input?.budget_amount || 'Not provided'} ${input?.budget_currency || ''}
Partners: ${input?.partners || 'Not provided'}
Problem statement: ${input?.problem_statement || 'Not provided'}
Expected results: ${input?.expected_results || 'Not provided'}

RULES:
- Never invent donor rules, attachments, co-financing, deadlines, or eligibility.
- If donor-specific information is missing, clearly label uncertain parts as UNIVERSAL DRAFT.
- If critical information is missing, ask exactly ONE targeted question.
- Be practical, structured, and direct.

OUTPUT ORDER:
1. Application readiness
2. Abstract
3. Problem Analysis
4. Overall Goal
5. Specific Objectives
6. Activities and Timeline
7. Logical Framework Matrix
8. Risks and Mitigation
9. Budget Draft
10. Submission Checklist
11. One concrete next step today`;
}

function buildConfigDrivenPrompt(lang, today, profile, opportunity, input, config) {
  const L = LANG_NAMES[lang] || 'English';

  return `LANGUAGE: Always respond in ${L}. Match the user's language exactly.

MODULE: ${config.module_name || 'Application Engine'}
VERSION: ${config.version || 'v3'}
DESCRIPTION: ${config.description || ''}
TODAY: ${today}

SYSTEM PROMPT:
${config.system_prompt || ''}

APPLICATION PROMPT:
${config.application_prompt || ''}

LFM RULES:
${config.lfm_rules || ''}

BUDGET RULES:
${config.budget_rules || ''}

SELECTED OPPORTUNITY:
Title: ${opportunity?.title || 'Not provided'}
Organization: ${opportunity?.organization_name || 'Not provided'}
Type: ${opportunity?.opportunity_type || 'Not provided'}
Funding: ${opportunity?.award_amount ? `${opportunity.award_amount} ${opportunity.currency || ''}`.trim() : (opportunity?.funding_range || 'Not provided')}
Eligibility: ${opportunity?.eligibility || 'Not provided'}
Deadline: ${opportunity?.application_deadline || 'Not provided'}
Country: ${opportunity?.country || 'Not provided'}
Description: ${opportunity?.description || 'Not provided'}
Source URL: ${opportunity?.source_url || 'Not provided'}

USER PROFILE:
Organization type: ${profile?.organization_type || 'Not specified'}
Sector: ${profile?.sector || 'Not specified'}
Country: ${profile?.country || 'Not specified'}

PROJECT DATA:
Project title: ${input?.project_title || 'Not provided'}
Project idea: ${input?.project_idea || 'Not provided'}
Target group: ${input?.target_group || 'Not provided'}
Location: ${input?.location || 'Not provided'}
Duration: ${input?.duration_months || 'Not provided'} months
Budget: ${input?.budget_amount || 'Not provided'} ${input?.budget_currency || ''}
Partners: ${input?.partners || 'Not provided'}
Problem statement: ${input?.problem_statement || 'Not provided'}
Expected results: ${input?.expected_results || 'Not provided'}`;
}

// ═══ SAVE SESSION ═══

async function saveApplicationSession(payload) {
  if (!supabase) return null;

  const { data, error } = await getTable('application_sessions')
    .insert(payload)
    .select('id,status,updated_at')
    .maybeSingle();

  if (error) { console.log('[APPLICATION SAVE]', error.message); return null; }
  return data || null;
}

// ═══ MAIN HANDLER ═══

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: { message: 'Method Not Allowed' } });
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: { message: 'Missing DEEPSEEK_API_KEY.' } });
  if (!supabase)               return res.status(500).json({ error: { message: 'Supabase is not configured.' } });

  if (!(await checkIP(req))) {
    return res.status(429).json({ error: { message: 'Daily limit reached. Try again tomorrow.' } });
  }

  try {
    const body      = req.body || {};
    const userId    = body.userId || null;
    const configKey = body.configKey || 'premium_application_system';

    // FIX: Validate opportunityId as positive integer
    const rawOppId  = body.opportunityId;
    const opportunityId = rawOppId ? parseInt(rawOppId, 10) : null;
    if (!opportunityId || opportunityId <= 0 || !Number.isFinite(opportunityId)) {
      return res.status(400).json({ error: { message: 'Missing or invalid opportunityId.' } });
    }

    const quotaResult = await checkAndDeductQuota(userId);
    if (!quotaResult.allowed) {
      return res.status(429).json({
        error: { message: 'Message limit reached. Please upgrade your plan.' },
        quota_exceeded: true,
        plan: quotaResult.plan
      });
    }

    // Sanitize all inputs (shared sanitizeField from utils)
    const input = {
      project_title:     sanitizeField(body.project_title),
      project_idea:      sanitizeField(body.project_idea, 800),
      target_group:      sanitizeField(body.target_group),
      location:          sanitizeField(body.location, 200),
      duration_months:   body.duration_months || null,
      budget_amount:     body.budget_amount   || null,
      budget_currency:   sanitizeField(body.budget_currency || 'EUR', 10),
      partners:          sanitizeField(body.partners),
      problem_statement: sanitizeField(body.problem_statement, 800),
      expected_results:  sanitizeField(body.expected_results, 800),
      notes:             sanitizeField(body.notes, 400)
    };

    const lang = body.lang || detectLang([
      input.project_title, input.project_idea,
      input.problem_statement, input.expected_results, input.notes
    ].join(' '));

    const today = new Date().toLocaleDateString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });

    const [profile, opportunity, config] = await Promise.all([
      loadUserProfile(userId),
      loadOpportunity(opportunityId),
      loadPromptConfig(configKey)
    ]);

    if (!opportunity) {
      return res.status(404).json({ error: { message: 'Selected funding opportunity was not found.' } });
    }

    const systemPrompt = config
      ? buildConfigDrivenPrompt(lang, today, profile, opportunity, input, config)
      : buildFallbackPrompt(lang, today, profile, opportunity, input);

    const userMessage = [
      'Build a premium application draft for the selected funding opportunity.',
      input.notes ? `Additional notes: ${input.notes}` : ''
    ].filter(Boolean).join('\n');

    // DeepSeek handles long structured application drafts
    const text = await deepseek(systemPrompt, userMessage, { maxTokens: 4096, temperature: 0.35 });

    const saved = await saveApplicationSession({
      user_id:           userId,
      opportunity_id:    opportunityId,
      config_key:        configKey,
      project_title:     input.project_title     || null,
      project_idea:      input.project_idea       || null,
      target_group:      input.target_group       || null,
      location:          input.location           || null,
      duration_months:   input.duration_months,
      budget_amount:     input.budget_amount,
      budget_currency:   input.budget_currency,
      partners:          input.partners           || null,
      problem_statement: input.problem_statement  || null,
      expected_results:  input.expected_results   || null,
      notes:             input.notes              || null,
      output_text:       text,
      status:            'draft',
      updated_at:        new Date().toISOString()
    });

    return res.status(200).json({
      content: [{ type: 'text', text }],
      mode: 'application',
      config_key: configKey,
      opportunity: {
        id:                opportunity.id,
        title:             opportunity.title,
        organization_name: opportunity.organization_name,
        deadline:          opportunity.application_deadline,
        source_url:        opportunity.source_url
      },
      saved_session: saved || null
    });

  } catch (err) {
    console.error('[APPLICATION ERROR]', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
};
