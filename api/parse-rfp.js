// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/rfpParser.js  v2
//
// CHANGES over v1:
// 1. PDF truncated to first 60KB (≈1-2 pages) — title/donor/amount always there
// 2. Only 5 critical fields extracted (was 10) — smaller JSON = 0 truncation
// 3. Prompt rewritten: explicit no-quotes rule + plain text only
// 4. sanitizeGeminiJSON added before JSON.parse
//
// Philosophy: Extract MINIMUM needed for generate-application.js
// title + donor + amount = enough to generate a full application
// ═══════════════════════════════════════════════════════════

const { ft } = require('./utils');

console.log('[rfpParser] v2 loaded — first-pages only, 5 fields, clean JSON');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// Only process first ~2 pages of PDF — title/donor/amount always on page 1-2
// 60KB base64 ≈ 45KB binary ≈ 1.5 pages
const FIRST_PAGES_LIMIT = 60 * 1024;

// Minimal prompt — only 5 fields, strict no-quotes rule
const EXTRACT_PROMPT = `You are extracting data from a funding call/RFP document.
Return ONLY a valid JSON object. No markdown. No explanation. No preamble.

Extract exactly these 5 fields:
{
  "title": "full name of the funding program or call",
  "organization": "name of the donor or funder",
  "deadline": "YYYY-MM-DD or null",
  "amount": "MAXIMUM grant amount only as plain number + currency, e.g. 150000 EUR. If range given (15000-150000), return only the maximum: 150000 EUR",
  "country": "eligible countries or regions, short"
}

STRICT RULES:
- Use plain text only in all string values
- NO double quote characters inside any string value
- Use parentheses for abbreviations: write (SME) not "SME", write (EU) not "EU"
- deadline must be YYYY-MM-DD format or null
- amount: plain number + currency, no symbols, e.g. 150000 EUR not EUR 150,000
- If a field is not clearly stated, use null
- Keep all values SHORT — under 100 characters each`;

function sanitize(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  return raw
    .replace(/\u201C|\u201D/g, "'")
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u00AB|\u00BB/g, "'");
}

async function parseRFP(pdfBase64) {
  if (!GEMINI_KEY) throw new Error('Missing GEMINI_API_KEY');
  if (!pdfBase64 || pdfBase64.length < 100) throw new Error('Invalid PDF data');

  // Truncate to first pages only — reduces tokens, reduces JSON size, reduces errors
  const truncated = pdfBase64.length > FIRST_PAGES_LIMIT
    ? pdfBase64.slice(0, FIRST_PAGES_LIMIT)
    : pdfBase64;

  console.log('[rfpParser] PDF:', Math.round(pdfBase64.length / 1024), 'KB →',
    Math.round(truncated.length / 1024), 'KB (first ~2 pages)');

  const res = await ft(GEMINI_URL + '?key=' + GEMINI_KEY, {
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
      generationConfig: {
        maxOutputTokens: 300,  // 5 short fields = max 300 tokens
        temperature: 0.0       // deterministic = follows rules strictly
      }
    })
  }, 20000);

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Gemini error ' + res.status + ': ' + err.slice(0, 200));
  }

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!raw) throw new Error('Gemini returned empty response');

  // Sanitize curly quotes before parsing
  const clean = sanitize(raw)
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const parsed = JSON.parse(clean);

  // Parse amount — extract MAXIMUM when range (e.g. "15000 — 150000 EUR")
  const amtStr = parsed.amount ? String(parsed.amount) : '';
  const currency = /USD|\$/.test(amtStr) ? 'USD' : /GBP|£/.test(amtStr) ? 'GBP' : 'EUR';
  const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '€';
  // Extract MAX amount (handles ranges like "15,000 — 150,000 EUR")
  let amtCleaned = amtStr.replace(/(\d)[,.](\d{3})(?=[,\.\d]|\b)/g, '$1$2');
  amtCleaned = amtCleaned.replace(/(\d)[,.](\d{3})(?=[,\.\d]|\b)/g, '$1$2');
  const allNums = (amtCleaned.match(/[0-9]+/g) || []).map(Number).filter(n => n > 999 && n <= 10000000);
  const amtNum = allNums.length > 0 ? Math.max(...allNums) : NaN;
  const amtDisplay = !isNaN(amtNum) && amtNum > 0
    ? symbol + Math.round(amtNum).toLocaleString()
    : (parsed.amount || '');

  console.log('[rfpParser] Extracted:', parsed.title, '| Amount:', amtDisplay, '| Deadline:', parsed.deadline);

  return {
    title:        parsed.title        || '',
    organization: parsed.organization || '',
    deadline:     parsed.deadline     || '',
    amount:       amtDisplay,
    country:      parsed.country      || '',
    // Extras for display only (not used by generate-application)
    eligibility:      '',
    focus_areas:      '',
    source_url:       '',
    key_requirements: [],
    summary:          '',
  };
}

module.exports = { parseRFP };
