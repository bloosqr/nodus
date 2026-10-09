const [oldPath, newPath] = process.argv.slice(2);
const A = await import(oldPath), B = await import(newPath);
const step = (n) => `## Step ${n} — Oxidation\n\nThe alcohol is oxidised [Clayden, p. 1](nodus://passage/p1).\n\nReactants: ethanol; oxygen\nProducts: ethanal\nByproducts: water\nAgents: none\n\n`;
const fence = (kb) => '```nodus-view\n{"capabilityId":"nodus:chemistry","view":{"svg":"<svg>' + 'M 1 2 L 3 4 '.repeat(Math.round(kb * 1024 / 12)) + '</svg>"}}\n```';
const routeWithReport = (steps, kb) => Array.from({ length: steps }, (_, i) => step(i + 1)).join('') + '### Final report\n\n' + Array.from({ length: steps }, (_, i) => `**Step ${i + 1}** — summary\n\n${fence(kb)}\n`).join('\n');
const cases = [
  ['target drawing 20 KB + 8 steps', fence(20) + '\n\n' + Array.from({ length: 8 }, (_, i) => step(i + 1)).join('')],
  ['target drawing 40 KB + 8 steps', fence(40) + '\n\n' + Array.from({ length: 8 }, (_, i) => step(i + 1)).join('')],
  ['passed route, 8 steps x 20 KB drawings', routeWithReport(8, 20)],
  ['passed route, 29 steps x 20 KB drawings (~600 KB)', routeWithReport(29, 20)],
];
const t = (fn) => { const s = performance.now(); fn(); return performance.now() - s; };
console.log('case | answer size | countRouteSteps base ms | patched ms | findStepNamedSpecies base ms | patched ms');
for (const [label, text] of cases) {
  const n = B.countRouteSteps(text);
  console.log(`${label} | ${(text.length / 1024).toFixed(0)} KB | ${t(() => A.countRouteSteps(text)).toFixed(0)} | ${t(() => B.countRouteSteps(text)).toFixed(1)} | ${t(() => A.findStepNamedSpecies(text, n)).toFixed(0)} | ${t(() => B.findStepNamedSpecies(text, n)).toFixed(1)}`);
}
