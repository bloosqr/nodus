const { splitChatVisuals } = await import('./cs.mjs');
const step = (n) => `## Step ${n} — Oxidation\n\nThe alcohol is oxidised [Clayden, p. 1](nodus://passage/p1).\n\n\`\`\`text\nReactants: ethanol\n\`\`\`\n\nReactants: ethanol; oxygen\nProducts: ethanal\nByproducts: water\nAgents: none\n\n`;
for (const steps of [30, 120, 400]) {
  const text = Array.from({ length: steps }, (_, i) => step(i + 1)).join('');
  const reps = 50; const s = performance.now();
  for (let i = 0; i < reps; i++) splitChatVisuals(text);
  console.log(`${(text.length / 1024).toFixed(0)} KB, ${steps} code fences: ${((performance.now() - s) / reps).toFixed(2)} ms per call`);
}
