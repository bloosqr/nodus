/**
 * Reaction schemes, figures and tables in a PDF's text layer: short small-type fragments
 * ("CH", "2", "1) LDA, THF", "vernolepin") spread around a drawing. Extracted in reading
 * order they land in the middle of the prose. This finds them from the page layout, so the
 * passages built from the text can leave them out without the text itself changing.
 *
 * A line (items sharing a baseline) is a scheme line when every item is set smaller than the
 * body type and it has at most three words or a wide gap between fragments. Footnotes are
 * small too but read as references. Margin items (running heads, chapter tabs) are reported
 * apart. Measured on a 1,345-page synthesis textbook: 10% of the characters, no prose lines.
 */

export interface LayoutItem {
  str: string;
  transform: number[];
  width: number;
  height?: number;
}

export interface PageSchemeLayout {
  /** Body type size in points: the size carrying most characters. */
  body: number;
  /** Per input item: part of a scheme line. */
  scheme: boolean[];
  /** Per input item: outside the text column (running head, tab, page number). */
  margin: boolean[];
}

const WORD = /[A-Za-z][a-z]{2,}/g;
const FOOTNOTE_START = /^\d{1,4}\s+\S/;
const REFERENCE = /[A-Z]\.\s|\(\d{4}\)|\bsee\b/;
const VOLUME_YEAR = /\b\d{1,4}\s*\(\d{4}\)/;

function size(item: LayoutItem): number {
  return Math.round(Math.abs(Number(item.transform[3])) || Number(item.height) || 0);
}

/** Characters per type size on a page; summed over sample pages it gives a book's body size. */
export function typeSizeWeights(items: LayoutItem[], into = new Map<number, number>()): Map<number, number> {
  for (const item of items) if (item.str.trim()) into.set(size(item), (into.get(size(item)) ?? 0) + item.str.length);
  return into;
}

export function bodySizeOf(weights: Map<number, number>): number {
  return [...weights].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
}

/** `bodyHint` is the book's body size: a page that is mostly a table or a scheme has more small
 *  type than body type, and judged alone would call its schemes body text. */
export function pageSchemeLayout(items: LayoutItem[], bodyHint?: number): PageSchemeLayout {
  const scheme = items.map(() => false);
  const margin = items.map(() => false);
  const text = items.map((item, index) => ({ item, index })).filter(({ item }) => item.str.trim());
  if (!text.length) return { body: 0, scheme, margin };
  const body = bodyHint || bodySizeOf(typeSizeWeights(text.map(({ item }) => item))) || 10;

  // The column: where body-size lines start (at least three of them) and how far they reach.
  const starts = new Map<number, number>();
  for (const { item } of text) if (size(item) === body) starts.set(Math.round(item.transform[4]), (starts.get(Math.round(item.transform[4])) ?? 0) + 1);
  const left = Math.min(...[...starts].filter(([, count]) => count >= 3).map(([x]) => x));
  const right = Math.max(...text.filter(({ item }) => size(item) === body && item.transform[4] >= left - 2).map(({ item }) => item.transform[4] + item.width));
  const column = Number.isFinite(left) && Number.isFinite(right);
  const inColumn = text.filter(({ item, index }) => {
    const outside = column && (item.transform[4] + item.width < left - 8 || item.transform[4] > right + 8);
    margin[index] = outside;
    return !outside;
  });

  type Line = { y: number; members: typeof text; small: boolean; scheme: boolean };
  const lines: Line[] = [];
  const sorted = [...inColumn].sort((a, b) => b.item.transform[5] - a.item.transform[5] || a.item.transform[4] - b.item.transform[4]);
  for (const entry of sorted) {
    const y = entry.item.transform[5];
    const line = lines.find((candidate) => Math.abs(candidate.y - y) <= body * 0.4);
    if (line) line.members.push(entry); else lines.push({ y, members: [entry], small: false, scheme: false });
  }
  lines.sort((a, b) => b.y - a.y);
  for (const line of lines) {
    line.members.sort((a, b) => a.item.transform[4] - b.item.transform[4]);
    const str = line.members.map(({ item }) => item.str).join(' ').replace(/\s+/g, ' ').trim();
    const words = (str.match(WORD) ?? []).length;
    let maxGap = 0;
    for (let k = 1; k < line.members.length; k++) {
      const previous = line.members[k - 1].item;
      maxGap = Math.max(maxGap, line.members[k].item.transform[4] - (previous.transform[4] + previous.width));
    }
    const footnote = (FOOTNOTE_START.test(str) && REFERENCE.test(str)) || VOLUME_YEAR.test(str);
    line.small = line.members.every(({ item }) => size(item) < body * 0.92);
    line.scheme = line.small && !footnote && (words <= 3 || maxGap > body * 3);
  }
  // A small row between two scheme rows (subscripts) is part of the scheme.
  for (let k = 1; k < lines.length - 1; k++) {
    if (!lines[k].scheme && lines[k].small && lines[k - 1].scheme && lines[k + 1].scheme) lines[k].scheme = true;
  }
  // A lone one- or two-fragment small row among prose is a superscript (a citation number,
  // a charge), not a scheme.
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].scheme && !lines[k - 1]?.scheme && !lines[k + 1]?.scheme && lines[k].members.length <= 2) lines[k].scheme = false;
  }
  for (const line of lines) if (line.scheme) for (const { index } of line.members) scheme[index] = true;
  return { body, scheme, margin };
}
