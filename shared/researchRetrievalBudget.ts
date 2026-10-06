import { validateRetrievalSettings, type RetrievalSettings } from './researchCorpus';
import { documentedMaxOutput } from './providerContextWindows';

/** A run-owned budget, passed to every probe and section, never reset per query.
 * UTF-8 bytes conservatively bound tokenizer output without guessing a language's
 * characters/token ratio. The presets are initial operating limits, not calibrated. */
/** The least evidence allowance a turn keeps, matching the floors its callers already apply when
 *  they size a budget. Small enough to fit any window that can hold a prompt at all. */
export const MIN_EVIDENCE_TOKENS = 256;

export class ResearchRetrievalBudget {
  readonly settings: RetrievalSettings;
  usedEvidenceTokens = 0;
  rounds = 0;
  decisionTokens = 0;
  candidates = 0;
  partial = false;
  readonly visited = new Set<string>();
  /** Supervisor decisions are separate provider calls: they have their own allowance, of
   * the same size as the evidence one, instead of taking evidence the answer needs. */
  constructor(settings: RetrievalSettings, public evidenceTokenLimit = settings.evidenceTokens, public decisionTokenLimit = settings.evidenceTokens) {
    this.settings = validateRetrievalSettings(settings);
  }
  /** Fit the evidence allowance into what the window leaves.
   *
   *  Everything this class counts is UTF-8 bytes, as a conservative bound on tokens (see above),
   *  so the window has to be converted to the same unit before subtracting: comparing a byte
   *  count against a token window overstated the prompt by roughly the bytes-per-token ratio,
   *  and on a large system prompt the reservation came out bigger than the whole window. The
   *  allowance was then 0, `nextRound` compared 0 >= 0, and no retrieval round could ever start,
   *  so the turn answered with no corpus evidence and reported only that it had found none.
   *
   *  `charsPerToken` is the caller's own estimate, so one ratio is used for the whole turn. A
   *  tight-but-real window keeps the floor and degrades; a prompt that genuinely does not fit
   *  gets nothing, which is what the caller's own overflow check will report. */
  constrainToWindow(windowTokens: number, reservedBytes: number, charsPerToken: number): void {
    const windowBytes = Math.floor(windowTokens * charsPerToken);
    const room = windowBytes - reservedBytes;
    const limit = room > 0 ? Math.max(MIN_EVIDENCE_TOKENS, room) : 0;
    if (limit < this.evidenceTokenLimit) { this.evidenceTokenLimit = limit; this.partial = true; }
  }
  reserveDecision(system: string, user: string, output: number): boolean {
    const bound = new TextEncoder().encode(system + user).length + output + 1024;
    if (this.decisionTokens + bound > this.decisionTokenLimit) { this.partial = true; return false; }
    this.decisionTokens += bound;
    return true;
  }
  nextRound(explicit = false): boolean {
    const allowed = explicit || this.settings.autoExpand ? this.settings.rounds : 1;
    if (this.rounds >= allowed || this.usedEvidenceTokens >= this.evidenceTokenLimit) { this.partial = true; return false; }
    this.rounds++;
    return true;
  }
  accept(id: string, text: string): boolean {
    if (this.visited.has(id)) return false;
    const tokens = new TextEncoder().encode(text).length;
    if (this.usedEvidenceTokens + tokens > this.evidenceTokenLimit) { this.partial = true; return false; }
    this.visited.add(id);
    this.usedEvidenceTokens += tokens;
    return true;
  }
}

/** Output tokens for one Research Chat answer. A turn with skills writes artefacts (an SVG, a
 * figure brief) on top of its prose and gets the larger allowance.
 *
 * The budget is the larger of a flat figure and a share of the window, clamped by what fits
 * beside the prompt and by the model's own documented output ceiling (`documentedMaxOutput`).
 * It used to be the flat figure alone, which does not scale with the answer: a long synthesis
 * route written as many short steps was cut off at 10,000 tokens, and the run could go no
 * further. An unknown ceiling keeps the flat figure, because a max_tokens above what a model
 * will emit is rejected by the provider rather than trimmed. Prose got 6,000 until the chat's
 * agent began reading several sources a turn: each citation link is about 170 characters, and a
 * definition drawn from seven works was cut at 16,000 characters and lost whole. */
export function researchAnswerTokens(window: number | null | undefined, withSkills: boolean, maxOutput?: number | null): number {
  // The floor is what every turn used to get: a flat figure, which is fine for prose and wrong
  // for a long answer. A route written as many short steps needs output in proportion to the
  // number of steps, and a 10,000-token answer cut one off mid-route — so the budget is now a
  // share of the window as well, and the larger of the two wins.
  const flat = withSkills ? 10_000 : 8000;
  const share = withSkills ? 0.08 : 0.06;
  if (window == null) return maxOutput != null ? Math.max(flat, Math.min(maxOutput, flat * 4)) : flat;
  const margin = Math.max(96, Math.round(window * 0.05));
  // What fits beside the prompt, and what the model will actually emit. A max_tokens above the
  // model's own ceiling is rejected by the provider, so an unknown ceiling keeps the flat figure
  // rather than guessing upward.
  const room = Math.max(320, Math.floor((window - margin) * 0.3));
  const ceiling = Math.min(maxOutput ?? flat, room);
  return Math.max(320, Math.min(ceiling, Math.max(flat, Math.floor(window * share))));
}

/** The answer budget plus its thinking reserve, held under what the model will actually emit.
 *
 *  The reserve is added on top of the answer budget, so the two together can exceed the model's
 *  own output ceiling — and a max_tokens above that ceiling is rejected outright, not trimmed. At
 *  `high` the reserve is 65,536 tokens and at `max` it is 131,072, so the sum could already pass
 *  a 128,000-token ceiling before the answer budget was allowed to scale with the window.
 *
 *  Trimming the sum takes it out of the reserve first, which is the right order: the reserve is
 *  room the model MAY use for thinking, while the answer budget is what the turn needs to say. A
 *  model whose ceiling is not documented is left alone rather than guessed at. */
export function withinModelOutput(total: number, provider: string, model: string): number {
  const ceiling = documentedMaxOutput(provider, model);
  return ceiling == null ? total : Math.min(total, ceiling);
}
