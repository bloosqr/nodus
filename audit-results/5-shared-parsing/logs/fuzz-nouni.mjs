// Differential fuzz: random synthetic route answers through the base and the patched parser.
const [oldPath, newPath, seedArg, nArg, mode] = process.argv.slice(2);
const A = await import(oldPath), B = await import(newPath);
let seed = Number(seedArg ?? 1);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (list) => list[Math.floor(rnd() * list.length)];
const NAMES = ['ethanol', 'oxygen', '4-nitrophenol', '(2R)-butan-2-ol', 'sodium chloride', 'benzene-1,2-diamine', 'ε-caprolactam (azepan-2-one', 'water', 'carbon dioxide', 'none', 'None.', 'n/a', '—', 'see prose', 'the photodimer — `C1=CC2(C=C1)OCCO2`', 'toluene', '110 °C', 'acetic acid (2 equiv)', 'x'.repeat(300), 'sodium salicylate', 'ethanol；oxygen', 'none; the reaction is run neat'];
const LABEL = ['Reactants', 'Products', 'Byproducts', 'Agents', 'Product', 'Reactant', 'By-products', 'reactants'];
const WRAP = [['', ''], ['**', '**'], ['`', '`'], ['__', '__'], ['- ', ''], ['  ', ''], ['* ', '']];
const SEP = ['; ', ';', ' ; ', ', ', '\n', '；', ' and '];
const COLON = [':', '：', ' :', ':  '];
const HEAD = (n) => pick([`## Step ${n} — Oxidation`, `### Step ${n}: aldol`, `**Step ${n} — Reduction**`, `**Step ${n}: hydrolysis.** The ester is hydrolysed.`, `Step ${n}. Bromination`, `${n}. **Esterification.** Heat.`, `## Alternative for Step ${n}`, `**Target structure**`]);
const PROSE = () => pick(['The alcohol is oxidised.', 'This step is racemic.', 'A Wagner-Meerwein shift occurs; the product is a mixture of diastereomers.', 'Reagents and conditions: PCC, CH2Cl2, rt, 2 h; then workup.', 'See [Clayden, p. 1](nodus://passage/p1).', '', '   ', '\t\t', ' '.repeat(Math.floor(rnd() * 400))]);
const BLOCK = () => pick(['```nodus-view\n{"view":"<svg>' + 'y '.repeat(Math.floor(rnd() * 300)) + '</svg>"}\n```', '<svg width="10">' + 'z'.repeat(Math.floor(rnd() * 200)) + '</svg>', '<svg unclosed', '```\ncode Reactants: x\n```', '| a | Reactants: b |']);
function answer() {
  const steps = 1 + Math.floor(rnd() * 6);
  const parts = [];
  if (rnd() < 0.3) parts.push('**Route overview**\n\nStep 1: oxidation.\nStep 2: reduction.\n');
  for (let n = 1; n <= steps; n += 1) {
    if (rnd() < 0.85) parts.push(HEAD(n));
    parts.push(PROSE());
    const lines = [];
    for (const label of ['Reactants', 'Products', 'Byproducts', 'Agents']) {
      if (rnd() < 0.1) continue;
      const shown = rnd() < 0.8 ? label : pick(LABEL);
      const [l, r] = pick(WRAP);
      const count = 1 + Math.floor(rnd() * 3);
      const names = Array.from({ length: count }, () => pick(NAMES)).join(pick(SEP));
      lines.push(`${l}${shown}${pick(COLON)}${r} ${names}${rnd() < 0.1 ? ' (trailing prose here).' : ''}`);
    }
    parts.push(rnd() < 0.1 ? lines.join(' ') : lines.join('\n'));
    if (rnd() < 0.2) parts.push(BLOCK());
  }
  if (rnd() < 0.3) parts.push('### Route check (RDKit)\n\n- Step 1 OK');
  return parts.join(pick(['\n\n', '\n', '\n\n\n']));
}
const project = (M, text) => {
  const n = M.countRouteSteps(text);
  const species = M.findStepNamedSpecies(text, Math.max(n, 1));
  const resolved = species.map((step) => step.map((entry) => ({ ...entry, status: 'resolved', smiles: 'C' })));
  return JSON.stringify({ n, species, prose: M.findStepProse(text, n), cond: M.findStepConditions(text, n), rac: M.stepDeclaresRacemic(text, n), blocks: M.findStepBlocks(text, n), ann: M.annotateSpeciesSmiles(text, resolved) });
};
const total = Number(nArg ?? 5000);
let diffs = 0;
const examples = [];
for (let i = 0; i < total; i += 1) {
  const text = answer();
  const a = project(A, text), b = project(B, text);
  if (a !== b) { diffs += 1; if (examples.length < 3) examples.push({ text, a: JSON.parse(a), b: JSON.parse(b) }); }
}
console.log(`fuzz: ${total} answers, ${diffs} differ`);
if (mode === 'show') for (const e of examples) console.log(JSON.stringify(e, null, 1).slice(0, 4000));
