// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/parse-rfp.js  v3 — SELF-CONTAINED
// Сè во еден фајл — нема зависност од _lib/rfpParser.js
// Единствена зависност: ./_lib/utils (setCors, checkIP, ft)
// ═══════════════════════════════════════════════════════════

const { setCors, checkIP, ft } = require('./_lib/utils');

console.log('[parse-rfp] v3 loaded — self-contained, no rfpParser dependency');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// First ~2 pages only — title/donor/amount always on page 1-2
const FIRST_PAGES_LIMIT = 60 * 1024;

const EXTRACT_PROMPT = `You are extracting data from a funding call document.
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
- Keep all values under 120 characters`;

function sanitize(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  return raw
    .replace(/\u201C|\u201D/g, "'")
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u00AB|\u00BB/g, "'");
}

function parseAmount(amtStr) {
  if (!amtStr) return '';
  const s = String(amtStr);
  const currency = /USD|\$/.test(s) ? 'USD' : /GBP|£/.test(s) ? 'GBP' : 'EUR';
  const symbol   = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '€';
  // Remove thousand separators, then extract all numbers
  let c = s.replace(/(\d)[,.](\d{3})(?=[,.\d]|\b)/g, '$1$2');
  c = c.replace(/(\d)[,.](\d{3})(?=[,.\d]|\b)/g, '$1$2');
  const nums = (c.match(/[0-9]+/g) || []).map(Number).filter(n => n > 999 && n <= 10000000);
  if (nums.length === 0) return s;
  return symbol + Math.max(...nums).toLocaleString();
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try { const ok = await checkIP(req); if (!ok) return res.status(429).json({ error: 'Daily limit reached' }); } catch(e) {}

  try {
    const { pdfBase64 } = req.body || {};
    if (!pdfBase64 || pdfBase64.length < 100) return res.status(400).json({ error: 'Missing or invalid PDF data' });

    const truncated = pdfBase64.length > FIRST_PAGES_LIMIT
      ? pdfBase64.slice(0, FIRST_PAGES_LIMIT)
      : pdfBase64;

    console.log('[parse-rfp] PDF:', Math.round(pdfBase64.length/1024), 'KB →', Math.round(truncated.length/1024), 'KB');

    const res2 = await ft(GEMINI_URL + '?key=' + GEMINI_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: 'application/pdf', data: truncated } },
            { text: EXTRACT_PROMPT }
          ]
        }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.0 }
      })
    }, 20000);

    if (!res2.ok) {
      const err = await res2.text();
      throw new Error('Gemini error ' + res2.status + ': ' + err.slice(0, 200));
    }

    const data = await res2.json();
    if (data.error) throw new Error(data.error.message);

    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!raw) throw new Error('Gemini returned empty response');

    const clean = sanitize(raw).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(clean);

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
