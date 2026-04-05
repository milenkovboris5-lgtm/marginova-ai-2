// ═══════════════════════════════════════════
// MARGINOVA.AI — api/webhook.js
// Polar.sh → Supabase план ажурирање
// ═══════════════════════════════════════════

const crypto = require('crypto');

const WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Polar Product IDs → план
const PRODUCT_PLAN_MAP = {
  '158770b5-6ee1-4eb6-9e57-1125bc05b89b': 'pro',
  'ed8bb2a0-a6cb-40fd-8387-00c7e03fd1fd': 'premium',
  'd60f24af-7577-4deb-aea9-ccde8bf83003': 'ultra'
};

// Верификација на Polar webhook signature
function verifySignature(payload, signature, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const expected = hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

// Ажурирај план во Supabase
async function updateUserPlan(email, plan) {
  const url = SUPABASE_URL + '/rest/v1/profiles';
  const res = await fetch(url + '?email=eq.' + encodeURIComponent(email), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ plan: plan })
  });
  return res.ok;
}

// Земи email од Polar subscription event
function getEmailFromEvent(body) {
  return body?.data?.customer?.email
    || body?.data?.subscription?.customer?.email
    || body?.data?.email
    || null;
}

// Земи product ID од event
function getProductIdFromEvent(body) {
  return body?.data?.product_id
    || body?.data?.subscription?.product_id
    || body?.data?.items?.[0]?.product_id
    || null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    // Земи raw body за signature верификација
    const rawBody = JSON.stringify(req.body);
    const signature = req.headers['x-polar-signature'] || req.headers['webhook-signature'] || '';

    // Верификација
    if (WEBHOOK_SECRET && signature) {
      const isValid = verifySignature(rawBody, signature, WEBHOOK_SECRET);
      if (!isValid) {
        console.error('Invalid webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const event = req.body?.type || req.body?.event;
    const body = req.body;

    console.log('Polar webhook event:', event);

    // Subscription создадена или активна → постави план
    if (event === 'subscription.created' || event === 'subscription.active' || event === 'subscription.updated') {
      const email = getEmailFromEvent(body);
      const productId = getProductIdFromEvent(body);
      const plan = PRODUCT_PLAN_MAP[productId] || 'free';

      if (email) {
        const ok = await updateUserPlan(email, plan);
        console.log('Plan updated:', email, plan, ok ? 'OK' : 'FAIL');
        return res.status(200).json({ success: true, email, plan });
      }
    }

    // Subscription откажана → врати на free
    if (event === 'subscription.canceled' || event === 'subscription.revoked') {
      const email = getEmailFromEvent(body);
      if (email) {
        const ok = await updateUserPlan(email, 'free');
        console.log('Plan reset to free:', email, ok ? 'OK' : 'FAIL');
        return res.status(200).json({ success: true, email, plan: 'free' });
      }
    }

    return res.status(200).json({ received: true, event });

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
};
