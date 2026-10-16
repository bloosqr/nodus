import type { ResearchContextLayers, ResearchContextSelection } from './types';

/*
 * The context balloon offers layers, not sections. A layer maps onto the sections the
 * retrieval already understands, so every path that reads sections (the vaults without
 * a documentary corpus) keeps working unchanged, while the academic corpus run reads
 * the layers themselves.
 */

/** The layers a selection chooses. One saved before layers existed is read from its
 * sections; in an academic vault its documents were always read, so they stay on.
 * Indexed texts only reads the passages of the documents and nothing of the ideas. */
export function researchContextLayers(selection: ResearchContextSelection, academic = false): ResearchContextLayers {
  if (selection.layers?.indexedOnly) return { ideas: false, documents: true, indexedOnly: true };
  if (selection.layers) return { ideas: !!selection.layers.ideas, documents: !!selection.layers.documents };
  return {
    ideas: selection.ideas || selection.themes || selection.contradictions || selection.gaps || selection.readingPath || selection.authors || selection.graph,
    documents: academic || selection.documents || selection.passages !== false,
  };
}

/** A selection choosing exactly these layers, with its sections set to match. With indexed
 * texts only, the sections are its own (the passages, nothing else) and the layers keep the
 * choice it replaces, so switching it off gives that choice back. */
export function withResearchContextLayers(selection: ResearchContextSelection, layers: ResearchContextLayers): ResearchContextSelection {
  const indexedOnly = !!layers.indexedOnly;
  const ideas = !indexedOnly && !!layers.ideas;
  const documents = !indexedOnly && !!layers.documents;
  return {
    ...selection,
    layers: { ideas: !!layers.ideas, documents: !!layers.documents, ...(indexedOnly ? { indexedOnly } : {}) },
    ideas, themes: ideas, contradictions: ideas, gaps: ideas, readingPath: ideas, authors: ideas, graph: ideas,
    graphParts: { ideaNodes: ideas, themeNodes: ideas, ideaEdges: ideas, authorGraph: ideas },
    documents, passages: indexedOnly || documents,
  };
}

/** Whether a turn may consult nothing of the corpus and no web: it answers from general knowledge. */
export function researchContextIsEmpty(layers: ResearchContextLayers, webEnabled: boolean): boolean {
  return !layers.ideas && !layers.documents && !webEnabled;
}
