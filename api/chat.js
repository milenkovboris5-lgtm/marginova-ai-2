// Rate limiting
const rateLimitStore = {};
const DAILY_LIMIT = 50;

function getRateLimitKey(req) {
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown';
  const today = new Date().toISOString().split('T')[0];
  return `${ip}_${today}`;
}

function checkRateLimit(req) {
  const key = getRateLimitKey(req);
  const now = Date.now();
  if (!rateLimitStore[key]) {
    rateLimitStore[key] = { count: 0, resetAt: getEndOfDay() };
  }
  for (const k in rateLimitStore) {
    if (rateLimitStore[k].resetAt < now) delete rateLimitStore[k];
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
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}

// Main handler
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  }

  // Rate limit
  const limit = checkRateLimit(req);
  res.setHeader('X-RateLimit-Limit', DAILY_LIMIT);
  res.setHeader('X-RateLimit-Remaining', limit.remaining);

  if (!limit.allowed) {
    return res.status(429).json({
      error: {
        message: 'Daily limit reached. Resets at midnight.',
        code: 'RATE_LIMIT_EXCEEDED',
        remaining: 0
      }
    });
  }

  // API Key
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'Gemini API key not configured.' } });
  }

  try {
    const body = req.body;
    const hasImage = !!body.image;
    const systemPrompt = body.system || '';

    // Verbose avatars get more tokens
    const verboseAvatars = ['eva', 'dropshipper', 'businessai', 'creativeai', 'travelai', 'developer'];
    const maxTokens = verboseAvatars.includes(body.avatar) ? 1200 : 700;

    // Build Gemini contents array
    const contents = [];

    // Add conversation history
    const messages = (body.messages || []).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : String(m.content || '') }]
    }));

    if (hasImage) {
      // Replace last message with vision content
      const lastText = body.imageText || 'Please analyze this image carefully and respond helpfully.';
      const historyWithoutLast = messages.slice(0, -1);
      contents.push(...historyWithoutLast);
      contents.push({
        role: 'user',
        parts: [
          {
            inline_data: {
              mime_type: body.imageType || 'image/jpeg',
              data: body.image
            }
          },
          { text: lastText }
        ]
      });
    } else {
      contents.push(...messages);
    }

    // Call Gemini API
    const model = 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`;

    // Add system prompt as first part of first user message
    const contentsWithSystem = contents.length > 0 ? [
      {
        role: 'user',
        parts: [{ text: systemPrompt + '\n\nUser: ' + (contents[0]?.parts?.[0]?.text || '') }]
      },
      ...contents.slice(1)
    ] : [{
      role: 'user',
      parts: [{ text: systemPrompt }]
    }];

    const geminiBody = {
      contents: contentsWithSystem,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.7,
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    });

    const data = await response.json();

    if (data.error) {
      console.error('Gemini error:', data.error);
      return res.status(400).json({ error: { message: data.error.message || 'Gemini API error' } });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';

    return res.status(200).json({
      content: [{ type: 'text', text }],
      remaining_messages: limit.remaining - 1
    });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
};
