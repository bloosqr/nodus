const A = await import(process.argv[2]), B = await import(process.argv[3]);
const step = (n, h) => `${h(n)}\n\nThe alcohol is oxidised [Ref ${n}](nodus://passage/p${n}).\n\nReactants: ethanol\nProducts: ethanal\nByproducts: water\nAgents: none\n`;
const styles = {
  'hash heading': (n) => `## Step ${n} — Oxidation`,
  'bold heading': (n) => `**Step ${n} — Oxidation**`,
  'bold lead-in': (n) => `**Step ${n}: oxidation.** Treat the alcohol.`,
  'plain line': (n) => `Step ${n}. Oxidation`,
  'numbered list': (n) => `${n}. **Oxidation.** Treat the alcohol.`,
};
for (const [name, h] of Object.entries(styles)) {
  for (const extra of ['', '\n\n## Notes\n\nSee [Other](nodus://passage/q).', '\n\n### Route check (RDKit)\n\n- Step 1 OK']) {
    const text = [1, 2, 3].map((n) => step(n, h)).join('\n') + extra;
    const n = B.countRouteSteps(text);
    const a = JSON.stringify(A.collectStepEvidence(text, n, null, []));
    const b = JSON.stringify(B.collectStepEvidence(text, n, null, []));
    console.log(`${name.padEnd(14)} ${JSON.stringify(extra.slice(2, 16)).padEnd(18)} steps=${n} ${a === b ? 'same' : 'DIFF'}`);
    if (a !== b) { console.log('  old', a); console.log('  new', b); }
  }
}
