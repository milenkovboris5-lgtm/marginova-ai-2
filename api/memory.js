// ═══ MEMORY ═══
async function load(userId, supa, gemini) {
  if (!userId || !supa) return { summary: null, recent: [] };
  try {
    const rows = await supa('conversations', { user_id: userId, avatar: 'cooai', limit: 30 });
    if (!rows?.length) return { summary: null, recent: [] };
    const recent = rows.slice(0, 6).reverse().map(r => ({
      role: r.role === 'assistant' ? 'assistant' : 'user',
      content: r.message
    }));
    let summary = null;
    if (rows.length > 6) {
      const text = rows.slice(6).reverse().map(r => `${r.role}: ${r.message}`).join('\n');
      summary = await gemini(`Summarize in 2 sentences. Keep numbers/decisions:\n${text.slice(0,2000)}`, 150);
    }
    return { summary, recent };
  } catch { return { summary: null, recent: [] }; }
}

async function save(userId, role, message, supa) {
  if (!userId || !supa) return;
  try {
    await supa('conversations', {
      user_id: userId, avatar: 'cooai', role,
      message: message.slice(0, 2000),
      created_at: new Date().toISOString()
    }, 'POST');
  } catch {}
}

module.exports = { load, save };
