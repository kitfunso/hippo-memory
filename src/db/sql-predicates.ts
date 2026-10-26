/** The rows the duplicate read groups: current distilled ones. */
export const CURRENT_DISTILLED = "COALESCE(kind, 'distilled') = 'distilled' AND COALESCE(superseded_by, '') = ''";

// A tag list with a `\`, a digit, an object or a nested list may not hold its tags' text as written: an escape, or a
// value String() writes another way.
export const TAGS_NOT_AS_WRITTEN = `instr(tags_json, '\\') > 0 OR tags_json GLOB '*[0-9{]*' \
OR instr(substr(tags_json, 2), '[') > 0`;

/** The rows whose text a trigram lookup may miss where JavaScript's lower-casing finds it: tags not as written, and a
 * dotted capital I, which FTS5 does not fold to `i`. Migration v64 indexes them, so a text filter reads them by
 * index. */
export const TEXT_OUTSIDE_TRIGRAMS = `${TAGS_NOT_AS_WRITTEN} OR instr(content, char(304)) > 0 \
OR instr(tags_json, char(304)) > 0`;
