// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/me.js
// Supabase proxy — frontend never sees the service key.
// Returns current user profile + quota info.
// Auth: Bearer token from Supabase client (anon key is fine
//       for getUser — it validates the JWT server-side).
// ═══════════════════════════════════════════════════════════

const { setCors, supabase, getTable } = require('./_lib/utils');

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  // Extract Bearer token from Authorization header
  const authHeader = req.headers.authorization || '';
  const token      = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    // Validate JWT server-side — Supabase checks signature + expiry
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Fetch user profile from DB
    const { data: profile, error: profileError } = await getTable('profiles')
      .select('plan,sector,country,organization_type,goals,daily_msgs,last_msg_date,detected_sector,detected_org_type,detected_country')
      .eq('user_id', user.id)
      .maybeSingle();

    if (profileError) {
      console.warn('[/api/me] profile fetch error:', profileError.message);
    }

    const today = new Date().toISOString().split('T')[0];
    const plan  = profile?.plan || 'free';

    // Quota info (no limits in test mode — return generous defaults)
    const LIMITS  = { free: 999, starter: 999, pro: 999, business: 999 };
    const limit   = LIMITS[plan] ?? 999;
    const used    = profile?.last_msg_date === today ? (profile?.daily_msgs || 0) : 0;

    return res.status(200).json({
      user: {
        id:    user.id,
        email: user.email,
      },
      profile: {
        plan,
        sector:            profile?.sector            || profile?.detected_sector   || null,
        country:           profile?.country           || profile?.detected_country  || null,
        organization_type: profile?.organization_type || profile?.detected_org_type || null,
        goals:             profile?.goals             || null,
      },
      quota: {
        plan,
        limit,
        used,
        remaining: Math.max(0, limit - used),
        reset_date: today,
      },
    });

  } catch (err) {
    console.error('[/api/me] error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
