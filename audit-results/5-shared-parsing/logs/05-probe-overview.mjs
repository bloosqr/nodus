const m = await import('./mi.mjs');
const answer = `**Route overview**

Step 1: oxidation of ethanol to ethanal.
Step 2: aldol addition.

## Step 1 — Oxidation of ethanol

Ethanol is oxidised with PCC [Clayden, p. 120](nodus://passage/p-clayden-120).

Reactants: ethanol; pyridinium chlorochromate
Products: ethanal
Byproducts: water
Agents: dichloromethane

## Step 2 — Aldol addition

Two ethanal condense [March, p. 1220](nodus://passage/p-march-1220).

Reactants: ethanal
Products: 3-hydroxybutanal
Byproducts: none
Agents: sodium hydroxide
`;
const n = m.countRouteSteps(answer);
console.log('steps', n);
console.log('prose', m.findStepProse(answer, n));
const ev = m.collectStepEvidence(answer, n, null, []);
console.log(JSON.stringify(ev, null, 1));
console.log(m.formatEvidenceSources(ev));
