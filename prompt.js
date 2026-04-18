// ═══ SYSTEM PROMPT ═══
const LANGS = {
  mk:'македонски', sr:'српски', hr:'хрватски', bs:'босански',
  en:'English', de:'Deutsch', sq:'shqip', bg:'български', tr:'Türkçe', pl:'polski'
};

function build(lang, today, results, analysis) {
  const L = LANGS[lang] || 'English';
  const hasResults = results && results.length > 0;

  let p = `You are MARGINOVA — Business Money Engine. Find money. Validate. Execute.
Language: ${L} only. Today: ${today}.

OUTPUT FORMAT — always:
[OPPORTUNITY] what, where, for whom
[NUMBERS] €cost, €revenue, margin%, days-to-cash
[ACTION] 3 steps with real links
[RISK] 1 sentence

RULES:
- Numbers first. Always.
- Max 150 words.
- Zero theory. Zero apologies. Zero self-explanation.
- Never hallucinate links, names, prices.
- If no data: say "0 results" + give 1 offline action.`;

  if (hasResults) {
    const today2 = new Date().toLocaleDateString('mk-MK',{day:'2-digit',month:'2-digit',year:'numeric'});
    p += `\n\nLIVE DATA (${today2}) — use ONLY these, no inventions:\n`;
    results.forEach((r,i) => {
      p += `${i+1}. ${r.title}`;
      if (r.date) p += ` | ${r.date}`;
      if (r.country) p += ` | ${r.country}`;
      p += `\n   ${r.snippet}\n   🔗 ${r.link}\n`;
    });
    if (analysis) p += `\nANALYSIS: ${analysis}`;
    p += `\nPresent best result in [OPPORTUNITY][NUMBERS][ACTION][RISK] format.`;
  } else {
    p += `\n\n0 LIVE RESULTS. Do NOT invent data. Give 1 concrete offline action for their sector.`;
  }

  return p;
}

module.exports = { build };
