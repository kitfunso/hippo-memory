/** Han, kana and Hangul, as the body of a `u`-flag character class. */
export const CJK_SCRIPTS = String.raw`\p{sc=Han}\p{sc=Hira}\p{sc=Kana}\p{sc=Hang}`;
/** CJK_SCRIPTS and ー, the prolonged-sound mark, a Common-script letter inside katakana words. */
export const CJK_LETTERS = `${CJK_SCRIPTS}ー`;
const HAS_CJK = new RegExp(`[${CJK_LETTERS}]`, 'u');
// Letters, marks and digits of every script make words, so Cyrillic, Greek or Arabic text is not
// cut into spaces and `café` stays one word.
const NOT_WORD = new RegExp(String.raw`[^\p{L}\p{M}\p{N}_\s${CJK_LETTERS}]`, 'gu');
const CJK_RUN = new RegExp(`[${CJK_LETTERS}]+`, 'gu');
const CJK_RUN_SPLIT = new RegExp(`([${CJK_LETTERS}]+)`, 'u');

/** Whether `text` holds a Chinese, Japanese or Korean letter. */
export function hasCjk(text: string): boolean {
  return HAS_CJK.test(text);
}

/** The overlapping `n`-letter pieces of each CJK run in `text`; a run of `n` or fewer letters is one
 * piece. */
export function cjkGrams(text: string, n: number): string[] {
  return (text.match(CJK_RUN) ?? []).flatMap((run) => {
    const letters = [...run];
    if (letters.length <= n) return [run];
    return letters.slice(n - 1).map((_, i) => letters.slice(i, i + n).join(''));
  });
}

/** Each CJK run's distinct letter trigrams, a shorter run whole: the trigram index's terms. */
export function cjkIndexTerms(text: string): string[] {
  return [...new Set(cjkGrams(text, 3))];
}

/** `terms` split by the index that can find them: the word index holds a whole CJK run as one
 * token, so CJK terms skip it for the substring indexes. */
export function partitionCjkTerms(terms: Iterable<string>) {
  const words: string[] = [];
  const cjk: string[] = [];
  for (const term of terms) (HAS_CJK.test(term) ? cjk : words).push(term);
  return { words, cjk };
}

/** `word` with each CJK run in it replaced by the run's letter bigrams: those scripts put no space
 * between words, and a bigram, unlike a dictionary split, matches the same way in query and text. */
export function splitCjkRuns(word: string): string[] {
  if (!HAS_CJK.test(word)) return [word];
  return word
    .split(CJK_RUN_SPLIT)
    .flatMap((part, i) => (i % 2 === 1 ? cjkGrams(part, 2) : part === '' ? [] : [part]));
}

/** Lower-cased words of `text` (runs of letters, marks, digits and `_`) of 2 or more characters; a
 * CJK run becomes its letter bigrams, a lone CJK letter itself. */
export function tokenize(text: string): string[] {
  return tokenizeMin(text, 2);
}

/** `tokenize` for the text a query is matched against: each letter of a longer CJK run is added,
 * so a one-letter query, which `tokenize` keeps whole, matches inside a run, while a longer query,
 * all bigrams, does not match single letters. */
export function indexTokenize(text: string): string[] {
  const tokens = tokenize(text);
  if (!HAS_CJK.test(text)) return tokens;
  const letters = (text.match(CJK_RUN) ?? []).flatMap((run) => {
    const runLetters = [...run];
    return runLetters.length > 1 ? runLetters : [];
  });
  return [...tokens, ...letters];
}

/** `tokenize` with words shorter than `minLength` dropped; CJK tokens, never longer than 2, are
 * kept. */
export function tokenizeMin(text: string, minLength: number): string[] {
  const words = text.toLowerCase().replace(NOT_WORD, ' ').split(/\s+/);
  return (HAS_CJK.test(text) ? words.flatMap(splitCjkRuns) : words).filter(
    (t) => t.length >= minLength || HAS_CJK.test(t),
  );
}

/** Jaccard overlap of two token sets; two empty sets count as identical. */
export function jaccardSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/** Jaccard overlap of the two texts' token sets. */
export function textOverlap(a: string, b: string): number {
  return jaccardSets(new Set(tokenize(a)), new Set(tokenize(b)));
}
