import { QUARANTINE_SCOPE_PREFIX } from '../base/scope/recall-scope.js';

// The only place a `superseded_by` predicate is spelled: `IS NULL` is the text three partial indexes
// repeat, and a blank link counts as superseded, as isSuperseded reads it.

/** "Not superseded" for a column written in full; the text partial indexes match. */
export const notSupersededAt = (col: string): string => `${col} IS NULL`;

/** "Superseded" for a column written in full: any link, a blank one included. */
export const supersededAt = (col: string): string => `${col} IS NOT NULL`;

/** "Not superseded" for `superseded_by` under table prefix `t` (`'m.'`, or none). */
export const notSupersededIn = (t = ''): string => notSupersededAt(`${t}superseded_by`);

/** "Superseded" for `superseded_by` under table prefix `t` (`'old.'`, or none). */
export const supersededIn = (t = ''): string => supersededAt(`${t}superseded_by`);

/** SQL twin of isQuarantineScope for `scope` under prefix `t`; substr compares bytes, as
 * startsWith does, where LIKE would fold case. */
export const quarantinedIn = (t: string): string =>
  `(${t}scope IS NOT NULL AND substr(${t}scope, 1, ${QUARANTINE_SCOPE_PREFIX.length}) = ` +
  `'${QUARANTINE_SCOPE_PREFIX}')`;

/** The kind of a row under prefix `t`; a row with no kind reads as distilled. */
export const kindIn = (t: string): string => `COALESCE(${t}kind, 'distilled')`;

/** SQL twin of isLiveMemory for a row under prefix `t`. */
export const liveIn = (t: string): string =>
  `${notSupersededIn(t)} AND ${kindIn(t)} IN ('raw', 'distilled') AND NOT ${quarantinedIn(t)}`;

// `hippo remember --kind superseded` saves this kind with no successor, so the field alone misses it.
/** A row whose kind says superseded. */
export const supersededKindIn = (t: string): string => `${kindIn(t)} = 'superseded'`;

/** The WHERE of idx_memories_duplicate_hash (migration v61). Changing it changes the index new stores
 * build, so it needs a migration. */
export const DUPLICATE_HASH_INDEX_WHERE =
  "COALESCE(kind, 'distilled') = 'distilled' AND COALESCE(superseded_by, '') = ''";

/** The rows the duplicate read groups: current distilled ones, plus the term that keeps the index. */
export const CURRENT_DISTILLED = `${DUPLICATE_HASH_INDEX_WHERE} AND ${notSupersededIn()}`;

// A tag list with a `\`, a digit, an object or a nested list may not hold its tags' text as
// written: an escape, or a value String() writes another way.
export const TAGS_NOT_AS_WRITTEN = `instr(tags_json, '\\') > 0 OR tags_json GLOB '*[0-9{]*' \
OR instr(substr(tags_json, 2), '[') > 0`;

/** The rows whose text a trigram lookup may miss where JavaScript's lower-casing finds it: tags
 * not as written, and a dotted capital I, which FTS5 does not fold to `i`. Migration v61 indexes
 * them, so a text filter reads them by index. */
export const TEXT_OUTSIDE_TRIGRAMS = `${TAGS_NOT_AS_WRITTEN} OR instr(content, char(304)) > 0 \
OR instr(tags_json, char(304)) > 0`;
