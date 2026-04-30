// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/_lib/rfpParser.js
// PDF RFP анализа преку Gemini native PDF читање
// Без надворешни пакети — Gemini прифаќа base64 PDF директно
// ═══════════════════════════════════════════════════════════

const { ft } = require('./utils');

console.log('[rfpParser] v1 loaded');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const EXTRACT_PROMPT = `You are a grant analyst. Extract structured information from this funding call/RFP document.
Return ONLY valid JSON — no markdown fences, no explanation, no preamble.

{
  "title": "full name of the funding program/call",
  "organization": "name of the donor/funder organization",
  "deadline": "YYYY-MM-DD or null",
  "amount_min": number or null,
  "amount_max": number or null,
  "currency": "EUR" or "USD" or "GBP",
  "eligibility": "who can apply — max 200 chars",
  "focus_areas": "main topics and sectors — max 150 chars",
  "country": "eligible countries or regions",
  "source_url": "official URL if mentioned",
  "key_requirements": ["req 1", "req 2", "req 3"],
  "summary": "2-3 sentence summary"
}

Rules:
- amount_min, amount_max: plain integers, no symbols, no currency signs
- deadline: YYYY-MM-DD format only, use final submission deadline
- key_requirements: exactly 3 most important requirements
- CRITICAL: ALL string values must use plain text only
  NO double quotes inside string values — use parentheses instead
  WRONG: "eligibility": "For \"SMEs\" and companies"
  RIGHT:  "eligibility": "For (SMEs) and companies"
- If a value contains a quote character, replace it with a space or parentheses
- Keep all string values short and clean — no special formatting`;

async function parseRFP(pdfBase64) {
  if (!GEMINI_KEY) throw new Error('Missing GEMINI_API_KEY');
  if (!pdfBase64 || pdfBase64.length < 100) throw new Error('Invalid PDF data');

  console.log('[rfpParser] Processing PDF:', Math.round(pdfBase64.length / 1024), 'KB base64');

  const res = await ft(GEMINI_URL + '?key=' + GEMINI_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
          { text: EXTRACT_PROMPT }
        ]
      }],
      generationConfig: { maxOutputTokens: 2000, temperature: 0.05 }
    })
  }, 30000);

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Gemini PDF error ' + res.status + ': ' + err.slice(0, 200));
  }

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!raw) throw new Error('Gemini returned empty response');

  // Sanitize + Parse JSON
  // Bug #5: Gemini may output unescaped quotes or curly quotes in PDF extraction
  const sanitized = raw
    .replace(/\u201C|\u201D/g, "'")
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u00AB|\u00BB/g, "'");
  const clean = sanitized.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const parsed = JSON.parse(clean);

  // Format amount for display
  const cur = parsed.currency || 'EUR';
  const symbol = cur === 'USD' ? '$' : cur === 'GBP' ? '£' : '€';
  let amtDisplay = null;
  if (parsed.amount_max) {
    amtDisplay = parsed.amount_min && parsed.amount_min !== parsed.amount_max
      ? symbol + parsed.amount_min.toLocaleString() + ' — ' + symbol + parsed.amount_max.toLocaleString()
      : symbol + parsed.amount_max.toLocaleString();
  }

  console.log('[rfpParser] Extracted:', parsed.title, '| Deadline:', parsed.deadline, '| Amount:', amtDisplay);

  return {
    title:            parsed.title            || '',
    organization:     parsed.organization     || '',
    deadline:         parsed.deadline         || '',
    amount:           amtDisplay              || '',
    amount_min:       parsed.amount_min       || null,
    amount_max:       parsed.amount_max       || null,
    currency:         parsed.currency         || 'EUR',
    eligibility:      parsed.eligibility      || '',
    focus_areas:      parsed.focus_areas      || '',
    country:          parsed.country          || '',
    source_url:       parsed.source_url       || '',
    key_requirements: parsed.key_requirements || [],
    summary:          parsed.summary          || '',
  };
}

module.exports = { parseRFP };
