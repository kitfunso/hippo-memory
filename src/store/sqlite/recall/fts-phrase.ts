// The one place a search term becomes an FTS5 phrase.

/** `term` as one FTS5 phrase: wrapped in double quotes, each inner quote doubled. */
export function ftsPhrase(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/** A MATCH query that hits a row holding any of `terms` as a phrase. */
export function ftsAnyPhrase(terms: readonly string[]): string {
  return terms.map(ftsPhrase).join(' OR ');
}
