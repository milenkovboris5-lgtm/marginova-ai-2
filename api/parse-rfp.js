// ═══════════════════════════════════════════════════════════
// MARGINOVA — api/parse-rfp.js
// Тенок handler — логиката е во api/_lib/rfpParser.js
// ═══════════════════════════════════════════════════════════

const { setCors, checkIP } = require('./_lib/utils');
const { parseRFP }         = require('./_lib/rfpParser');

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const allowed = await checkIP(req);
    if (!allowed) return res.status(429).json({ error: 'Daily limit reached' });
  } catch(e) {}

  try {
    const { pdfBase64 } = req.body || {};
    if (!pdfBase64) return res.status(400).json({ error: 'Missing pdfBase64' });

    const rfp = await parseRFP(pdfBase64);
    return res.status(200).json({ success: true, rfp });

  } catch(err) {
    console.error('[parse-rfp] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
