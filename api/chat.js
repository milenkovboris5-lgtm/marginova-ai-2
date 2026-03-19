// ═══════════════════════════════════════════
// RATE LIMITING — In-memory store
// 50 messages per user per day (resets at midnight)
// ═══════════════════════════════════════════
const rateLimitStore = {};

const DAILY_LIMIT = 50; // messages per user per day

function getRateLimitKey(req) {
  // Use IP address as identifier
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown';
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return `${ip}_${today}`;
}

function checkRateLimit(req) {
  const key = getRateLimitKey(req);
  const now = Date.now();

  if (!rateLimitStore[key]) {
    rateLimitStore[key] = { count: 0, resetAt: getEndOfDay() };
  }

  // Clean up old keys to save memory (older than 2 days)
  for (const k in rateLimitStore) {
    if (rateLimitStore[k].resetAt < now) {
      delete rateLimitStore[k];
    }
  }

  const record = rateLimitStore[key];
  record.count += 1;

  return {
    allowed: record.count <= DAILY_LIMIT,
    count: record.count,
    remaining: Math.max(0, DAILY_LIMIT - record.count),
    resetAt: record.resetAt
  };
}

function getEndOfDay() {
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  return endOfDay.getTime();
}

// ═══════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════
export default async function handler(req, res) {
  // Handle CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  }

  // ── RATE LIMIT CHECK ──
  const limit = checkRateLimit(req);

  // Add rate limit headers so frontend can read them
  res.setHeader('X-RateLimit-Limit', DAILY_LIMIT);
  res.setHeader('X-RateLimit-Remaining', limit.remaining);

  if (!limit.allowed) {
    return res.status(429).json({
      error: {
        message: `Daily limit reached. You have used ${DAILY_LIMIT} messages today. Resets at midnight. ⏳`,
        code: 'RATE_LIMIT_EXCEEDED',
        remaining: 0
      }
    });
  }

  // ── API KEY CHECK ──
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'API key not configured on server.' } });
  }

  // ── CALL GROQ ──
  try {
    const body = req.body;

    const messages = [];
    if (body.system) {
      messages.push({ role: 'system', content: body.system });
    }
    messages.push(...body.messages);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 200,
        messages: messages
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error });
    }

    // Convert Groq response to Anthropic-like format so frontend works unchanged
    const converted = {
      content: [{ type: 'text', text: data.choices[0].message.content }],
      remaining_messages: limit.remaining - 1
    };

    return res.status(200).json(converted);

  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
