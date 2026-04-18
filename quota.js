// ═══ QUOTA & RATE LIMIT ═══
const DAILY_LIMIT = 200;
const store = {};
const PLANS = { free: 20, starter: 500, pro: 2000, business: -1 };

function checkIP(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const key = ip + '_' + new Date().toISOString().split('T')[0];
  const now = Date.now();
  for (const k in store) if (store[k].resetAt < now) delete store[k];
  if (!store[key]) {
    const end = new Date(); end.setHours(23,59,59,999);
    store[key] = { count: 0, resetAt: end.getTime() };
  }
  store[key].count++;
  return { allowed: store[key].count <= DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - store[key].count) };
}

async function checkUser(userId, supa) {
  if (!userId || !supa) return { allowed: true };
  try {
    const today = new Date().toISOString().split('T')[0];
    const rows = await supa('profiles', { user_id: userId, select: 'plan,daily_msgs,last_msg_date' });
    const p = rows?.[0];
    if (!p) return { allowed: true };
    const limit = PLANS[p.plan] ?? 20;
    if (limit === -1) return { allowed: true };
    const used = p.last_msg_date === today ? (p.daily_msgs || 0) : 0;
    return { allowed: used < limit, plan: p.plan };
  } catch { return { allowed: true }; }
}

async function increment(userId, supa) {
  if (!userId || !supa) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    const rows = await supa('profiles', { user_id: userId, select: 'daily_msgs,last_msg_date' });
    const p = rows?.[0];
    const used = p?.last_msg_date === today ? (p?.daily_msgs || 0) : 0;
    await supa('profiles', { user_id: userId, daily_msgs: used + 1, last_msg_date: today }, 'PATCH');
  } catch {}
}

module.exports = { checkIP, checkUser, increment };
