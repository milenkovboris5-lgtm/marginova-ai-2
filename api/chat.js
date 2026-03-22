// // ═══════════════════════════════════════════
// RATE LIMITING — In-memory store
// 50 messages per user per day (resets at midnight)
// ═══════════════════════════════════════════
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
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  return endOfDay.getTime();
}

// ═══════════════════════════════════════════
// SERPER SEARCH — Real-time price search
// ═══════════════════════════════════════════
async function searchPrices(query) {
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) return null;
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': serperKey
      },
      body: JSON.stringify({
        q: query,
        gl: 'mk',
        hl: 'mk',
        num: 5
      })
    });
    const data = await response.json();
    if (!data.organic) return null;
    const results = data.organic.slice(0, 4).map(r => ({
      title: r.title,
      snippet: r.snippet,
      link: r.link
    }));
    return results;
  } catch (e) {
    console.warn('Serper error:', e);
    return null;
  }
}

function isPriceQuery(text) {
  const keywords = [
    'цена', 'цени', 'поевтино', 'најевтино', 'попуст', 'акција', 'акции',
    'маркет', 'продавница', 'купи', 'price', 'cheap', 'cheapest', 'discount',
    'offer', 'sale', 'market', 'store', 'buy', 'cena', 'cene', 'jeftino',
    'najjeftiniji', 'popust', 'akcija', 'prodavnica', 'колку чини',
    'kolko cini', 'koliko kosta', 'koliko košta', 'каде да купам'
  ];
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

// ═══════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  }

  // ── RATE LIMIT CHECK ──
  const limit = checkRateLimit(req);
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

  try {
    const body = req.body;
    const isPrice = body.avatar === 'priceai';
    const lastMsg = body.messages?.[body.messages.length - 1]?.content || '';
    const hasImage = !!body.image;

    // ── SERPER SEARCH for Price AI ──
    let searchContext = '';
    if (isPrice && isPriceQuery(typeof lastMsg === 'string' ? lastMsg : body.imageText || '')) {
      const searchQuery = `${lastMsg} цена Македонија Балкан маркет`;
      const results = await searchPrices(searchQuery);
      if (results && results.length > 0) {
        searchContext = '\n\n[REAL-TIME SEARCH RESULTS]:\n' +
          results.map((r, i) =>
            `${i + 1}. ${r.title}\n${r.snippet}\nLink: ${r.link}`
          ).join('\n\n') +
          '\n\n[IMPORTANT: You MUST use ONLY the prices and stores from the search results above. Do NOT invent any prices, store names, or links. If no specific prices are found in the results, tell the user you could not find exact prices and share the links. Never mention stores like Lidl, MediaMarkt, Vero, KAM unless they appear in the actual search results.]';
      }
    }

    const messages = [];
    if (body.system) {
      messages.push({
        role: 'system',
        content: body.system + searchContext
      });
    }

    // ── HANDLE IMAGE MESSAGE ──
    if (hasImage) {
      // Build vision message with image
      const visionMessages = [...body.messages.slice(0, -1)];
      visionMessages.push({
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${body.imageType};base64,${body.image}`
            }
          },
          {
            type: 'text',
            text: body.imageText || 'Please analyze this image.'
          }
        ]
      });
      messages.push(...visionMessages);

      // Use vision-capable model
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          max_tokens: 500,
          messages: messages
        })
      });

      const data = await response.json();
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }

      const converted = {
        content: [{ type: 'text', text: data.choices[0].message.content }],
        remaining_messages: limit.remaining - 1
      };
      return res.status(200).json(converted);

    } else {
      // ── REGULAR TEXT MESSAGE ──
      messages.push(...body.messages);

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 350,
          messages: messages
        })
      });

      const data = await response.json();
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }

      const converted = {
        content: [{ type: 'text', text: data.choices[0].message.content }],
        remaining_messages: limit.remaining - 1
      };
      return res.status(200).json(converted);
    }

  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
