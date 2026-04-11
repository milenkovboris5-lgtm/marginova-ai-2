// ═══════════════════════════════════════════
// MARGINOVA.AI — api/tts.js
// Google TTS Proxy — клучот е безбеден на сервер
// ═══════════════════════════════════════════

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const ttsKey = process.env.GOOGLE_TTS_KEY;
  if (!ttsKey) {
    return res.status(500).json({ error: 'TTS not configured' });
  }

  try {
    const { text, languageCode, voiceName, speakingRate, pitch } = req.body;

    if (!text) return res.status(400).json({ error: 'Missing text' });

    // Limit text length to avoid abuse
    const safeText = (text || '').slice(0, 500);

    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${ttsKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text: safeText },
          voice: {
            languageCode: languageCode || 'en-US',
            name: voiceName || 'en-US-Neural2-F'
          },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: speakingRate || 0.95,
            pitch: pitch || 0
          }
        })
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error('TTS API error:', err);
      return res.status(500).json({ error: 'TTS API error' });
    }

    const data = await response.json();
    return res.status(200).json({ audioContent: data.audioContent || null });

  } catch (err) {
    console.error('TTS handler error:', err);
    return res.status(500).json({ error: err.message });
  }
};
