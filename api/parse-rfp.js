// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/parse-rfp.js  v4 — Gemini wrapper + key check
//
// CHANGES over v3:
// 1. Uses gemini() from utils (auto-retry, centralized key/URL)
//    instead of raw ft() — eliminates duplicate GEMINI_URL constant
// 2. GEMINI_API_KEY checked at request time → clear 500 error
// 3. JSON parse wrapped in try/catch with parseJSON repair fallback
// 4. inline_data passed via gemini() contents array (supported)
// ═══════════════════════════════════════════════════════════

const { setCors, checkIP, gemini } = require('./_lib/utils');

console.log('[parse-rfp] v4 loaded — gemini() wrapper, key check, parse repair');

// First ~2 pages only — title/donor/amount always on page 1-2
const FIRST_PAGES_LIMIT = 60 * 1024;

const EXTRACT_SYSTEM = `You are extracting data from a funding call document.
Return ONLY a valid JSON object. No markdown. No explanation.

{
  "title": "full name of the funding program",
  "organization": "name of the donor or funder",
  "deadline": "YYYY-MM-DD or null",
  "amount": "maximum grant amount as plain number + currency, e.g. 150000 EUR",
  "country": "eligible countries, short"
}

RULES:
- Plain text only — NO double quotes inside string values
- Use parentheses: write (SME) not "SME", write (EU) not "EU"
- deadline: YYYY-MM-DD format or null
- amount: if range given (15000-150000), return ONLY the maximum: 150000 EUR
- Keep all values under 120 characters
- Use ONLY data found in the document — do not invent any field`;

function sanitize(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  return raw
    .replace(/"|"/g, "'")
    .replace(/'|'/g, "'")
    .replace(/«|»/g, "'");
}

function parseAmount(amtStr) {
  if (!amtStr) return '';
  const s = String(amtStr);
  const currency = /USD|\$/.test(s) ? 'USD' : /GBP|£/.test(s) ? 'GBP' : 'EUR';
  const symbol   = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '€';
  let c = s.replace(/(\d)[,.](\d{3})(?=[,.\d]|\b)/g, '$1$2');
  c = c.replace(/(\d)[,.](\d{3})(?=[,.\d]|\b)/g, '$1$2');
  const nums = (c.match(/[0-9]+/g) || []).map(Number).filter(n => n > 999 && n <= 50000000);
  if (nums.length === 0) return s;
  return symbol + Math.max(...nums).toLocaleString();
}

function repairJSON(raw) {
  if (!raw) return null;
  const clean = sanitize(raw).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  const candidate = clean.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch (_) {}
  try {
    const repaired = candidate
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')
      .replace(/\/\/[^\n]*/g, '');
    return JSON.parse(repaired);
  } catch (_) { return null; }
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.GEMINI_API_KEY) {
    console.error('[parse-rfp] GEMINI_API_KEY not set');
    return res.status(500).json({ error: 'Server configuration error: missing GEMINI_API_KEY' });
  }

  try { const ok = await checkIP(req); if (!ok) return res.status(429).json({ error: 'Daily limit reached' }); } catch(e) {}

  try {
    const { pdfBase64 } = req.body || {};
    if (!pdfBase64 || pdfBase64.length < 100) return res.status(400).json({ error: 'Missing or invalid PDF data' });

    const truncated = pdfBase64.length > FIRST_PAGES_LIMIT
      ? pdfBase64.slice(0, FIRST_PAGES_LIMIT)
      : pdfBase64;

    console.log('[parse-rfp] PDF:', Math.round(pdfBase64.length/1024), 'KB →', Math.round(truncated.length/1024), 'KB');

    const raw = await gemini(EXTRACT_SYSTEM, [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: 'application/pdf', data: truncated } },
        { text: 'Extract the funding program data from this document.' },
      ],
    }], { maxTokens: 300, temperature: 0.0, topP: 0.9, topK: 20 });

    if (!raw) throw new Error('Gemini returned empty response');

    const parsed = repairJSON(raw);
    if (!parsed) throw new Error('Could not parse Gemini response as JSON');

    const rfp = {
      title:            parsed.title        || '',
      organization:     parsed.organization || '',
      deadline:         parsed.deadline     || '',
      amount:           parseAmount(parsed.amount),
      country:          parsed.country      || '',
      eligibility:      '',
      focus_areas:      '',
      source_url:       '',
      key_requirements: [],
      summary:          '',
    };

    console.log('[parse-rfp] OK:', rfp.title, '|', rfp.amount, '|', rfp.deadline);
    return res.status(200).json({ success: true, rfp });

  } catch(err) {
    console.error('[parse-rfp] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
