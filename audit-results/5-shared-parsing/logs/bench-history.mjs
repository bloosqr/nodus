const [oldPath, newPath] = process.argv.slice(2);
const A = await import(oldPath), B = await import(newPath);
const step = (n) => `## Step ${n} — Oxidation\n\nThe alcohol is oxidised.\n\nReactants: ethanol; oxygen\nProducts: ethanal\nByproducts: water\nAgents: none\n\n`;
const fence = (kb) => '```nodus-view\n{"capabilityId":"nodus:chemistry","view":{"svg":"<svg>' + 'M 1 2 L 3 4 '.repeat(Math.round(kb * 1024 / 12)) + '</svg>"}}\n```';
const passed = (steps, kb) => Array.from({ length: steps }, (_, i) => step(i + 1)).join('') + '### Final report\n\n' + Array.from({ length: steps }, (_, i) => `**Step ${i + 1}** — summary\n\n${fence(kb)}\n`).join('\n');
const t = (fn) => { const s = performance.now(); fn(); return performance.now() - s; };
console.log('follow-up turn after a route that passed on its first answer: the three calls answerResearchChatTurn and skillExecution make before the model is asked');
for (const [steps, kb] of [[8, 20], [29, 20]]) {
  const turns = [{ role: 'user', content: 'Propose a synthesis of acetic acid (SMILES: CC(=O)O).' }, { role: 'assistant', content: passed(steps, kb) }, { role: 'user', content: 'Why is step 2 needed?' }];
  const run = (M) => t(() => { M.routeConversationState(turns); M.asksForRoute(turns); M.asksForRoute(turns); });
  console.log(`${steps} steps x ${kb} KB drawings: base ${run(A).toFixed(0)} ms, patched ${run(B).toFixed(1)} ms`);
}
