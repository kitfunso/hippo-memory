// tools/jaccard-overlap.mjs
//
// v1.8.0 — Verify lesson-vocabulary disjointness between v1.7.x existing
// trap categories and v1.8 adversarial categories. Pre-registered Jaccard
// threshold: < 0.30 (TIGHTENED from v1.7.7 prereg's 0.40 per outside voice E1).
//
// Token pipeline:
//   1. lowercase + split on \W+
//   2. drop short tokens (<=2 chars)
//   3. drop stop-words (extended list: function words + modal verbs + common
//      engineering verbs)
//   4. apply minimal Porter-style stem (suffix-strip ies/ing/ed/es/s/tion/ment/ness/ity/sion)
//
// Per `docs/RETRACTION.md`: this script is a workload-validity check on the
// lesson vocabulary. It is NOT a magnitude claim. Output is exit-coded
// (0 = pass, 1 = fail) so the verification commit gates on it.

import { TRAP_CATEGORIES } from '../benchmarks/sequential-learning/traps.mjs';

const STOP_WORDS = new Set([
  // Articles + auxiliaries
  'a', 'the', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'has', 'have', 'had', 'having',
  // Prepositions + conjunctions
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'as',
  'and', 'or', 'but', 'not', 'no',
  // Pronouns + determiners
  'it', 'its', 'this', 'that', 'these', 'those', 'their', 'there',
  // Modal verbs
  'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can',
  'may', 'might', 'must', 'shall', 'ought',
  // Common engineering verbs (extended per outside voice E1)
  'use', 'uses', 'used', 'using', 'make', 'makes', 'made', 'making',
  'get', 'gets', 'got', 'getting', 'set', 'sets', 'setting',
  'run', 'runs', 'ran', 'running', 'find', 'finds', 'found', 'finding',
  'see', 'saw', 'seen', 'seeing', 'give', 'gives', 'gave', 'given',
  'take', 'takes', 'took', 'taken', 'taking',
]);

// Minimal Porter-style stem: strip common verb/noun suffixes.
// Order matters: longer suffixes first to avoid double-strip.
export function stem(word) {
  return word
    .replace(/(?:tion|ment|ness|sion)$/, '')
    .replace(/ity$/, '')
    .replace(/ies$/, 'y')
    .replace(/(?:ing|ed|es)$/, '')
    .replace(/s$/, '');
}

export function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
      .map(stem)
      .filter((w) => w.length > 0),
  );
}

export function jaccard(setA, setB) {
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

const NEW_CATEGORY_IDS = ['timezone_naive', 'idempotency_retry', 'float_accumulation'];
const newCategories = TRAP_CATEGORIES.filter((c) => NEW_CATEGORY_IDS.includes(c.id));
const existingCategories = TRAP_CATEGORIES.filter((c) => !NEW_CATEGORY_IDS.includes(c.id));

const THRESHOLD = 0.30;

// Only run as script when invoked via `node tools/jaccard-overlap.mjs`.
import { pathToFileURL } from 'node:url';
const invokedAsScript = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(argv1).href;
})();

if (invokedAsScript) {
  let maxJaccard = 0;
  let maxPair = '';

  console.log(`v1.8.0 Jaccard verification — threshold < ${THRESHOLD} (Porter-stem + extended stop-words)`);
  console.log('---');

  for (const newCat of newCategories) {
    const newTokens = tokenize(newCat.lesson);
    for (const existing of existingCategories) {
      const existingTokens = tokenize(existing.lesson);
      const j = jaccard(newTokens, existingTokens);
      const intersect = [...newTokens].filter((x) => existingTokens.has(x));
      console.log(
        `${newCat.id} ↔ ${existing.id}: Jaccard = ${j.toFixed(4)} ` +
        `(${[...newTokens].length}/${[...existingTokens].length} stems, ∩ = ${intersect.length}` +
        (intersect.length > 0 ? ` [${intersect.join(',')}]` : '') + ')',
      );
      if (j > maxJaccard) {
        maxJaccard = j;
        maxPair = `${newCat.id} ↔ ${existing.id}`;
      }
    }
  }

  console.log('---');
  console.log(`MAX Jaccard: ${maxJaccard.toFixed(4)} (${maxPair})`);
  console.log(`THRESHOLD: ${THRESHOLD} (TIGHTENED from v1.7.7 prereg's 0.40 per outside voice E1)`);
  console.log(`PASS: ${maxJaccard < THRESHOLD ? 'YES' : 'NO'}`);
  process.exit(maxJaccard < THRESHOLD ? 0 : 1);
}
