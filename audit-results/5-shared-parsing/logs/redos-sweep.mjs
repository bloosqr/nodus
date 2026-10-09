const M = await import(process.argv[2]);
const S = await import(process.argv[3]);
const N = 100_000;
const units = {
  spaces: ' ', tabs: '\t', newlines: '\n', blanklines: '\n \n', backticks: '`', backtickPairs: '`a` ', stars: '*', underscores: '_', hashes: '#', parens: '(', closeParens: ')', brackets: '[', dashes: '-', emdash: '—', digits: '1', letters: 'a', words: 'synthesis of ', smilesish: 'C(C)', semicolons: ';', colons: ':', stepWord: 'Step 1 ', labels: 'Reactants: ', labelsNoColon: 'Reactants ', see: 'see ', stereo: 'stereochemistry of the ', racemic: 'not ', svgOpen: '<svg ', fence: '```\n', quotes: '"', braces: '{', links: '[a](nodus://passage/', linkOpen: '[a](', at: '@', mixture: 'mixture of ',
};
const fns = {
  findSmilesCandidates: (t) => M.findSmilesCandidates(t),
  findAnswerSpecies: (t) => M.findAnswerSpecies(t),
  findRequestedTarget: (t) => M.findRequestedTarget(t),
  requestedTargetFor: (t) => M.requestedTargetFor([t]),
  declaresRacemic: (t) => M.declaresRacemic(t),
  stepDeclaresRacemic: (t) => M.stepDeclaresRacemic(t, 3),
  stepDeclaresRearrangement: (t) => M.stepDeclaresRearrangement(t, 3),
  stepDeclaresRadical: (t) => M.stepDeclaresRadical(t, 3),
  routeReportsForHistory: (t) => M.routeReportsForHistory(t, false),
  routeFixPromptForHistory: (t) => M.routeFixPromptForHistory('Correction needed for the synthesis route above.\n' + t),
  stripDrawingRequests: (t) => M.stripDrawingRequests('```chemistry-plan\n' + t),
  findStepConditions: (t) => M.findStepConditions(t, 3),
  findStepProse: (t) => M.findStepProse(t, 3),
  findStepBlocks: (t) => M.findStepBlocks(t, 3),
  countRouteSteps: (t) => M.countRouteSteps(t),
  findStepNamedSpecies: (t) => M.findStepNamedSpecies(t, 3),
  collectStepEvidence: (t) => M.collectStepEvidence(t, 3, null, []),
  parseRouteReview: (t) => M.parseRouteReview(t, 3),
  parseNameFeedback: (t) => M.parseNameFeedback(t),
  isPlaceholderSpecies: (t) => M.isPlaceholderSpecies(t),
  isBareSmilesName: (t) => M.isBareSmilesName(t),
  isConditionPhrase: (t) => M.isConditionPhrase?.(t),
  asksForRoute: (t) => M.asksForRoute([{ role: 'user', content: 'synthesis of x' }, { role: 'assistant', content: t }, { role: 'user', content: 'why?' }]),
  looksLikeSynthesisRequest: (t) => S.looksLikeSynthesisRequest(t),
};
const prefix = '## Step 1 — x\n\nReactants: a\nProducts: b\n';
const rows = [];
for (const [uname, unit] of Object.entries(units)) {
  const body = unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  for (const [fname, fn] of Object.entries(fns)) {
    for (const text of [body, prefix + body + 'x', body + '!']) {
      const s = performance.now();
      try { fn(text); } catch { /* thrown errors are not timing */ }
      const ms = performance.now() - s;
      if (ms > 250) rows.push(`${fname} on 100 KB of ${JSON.stringify(unit)}: ${ms.toFixed(0)} ms`);
    }
  }
}
console.log(rows.length ? rows.join('\n') : 'no call over 250 ms');
