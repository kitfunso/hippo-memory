import type { MemoryEntry } from '../memory.js';
import { tokenize } from '../tokenize.js';

/** Tokenized BM25 corpus; build it once with `buildCorpus` and reuse it across queries on the same entry set. */
export interface BM25Corpus {
  docs: string[][];        // tokenized documents
  avgLen: number;
  df: Map<string, number>; // document frequency per term
  N: number;               // total documents
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** The text BM25 indexes for an entry: its content followed by its tags. */
export function entryText(entry: MemoryEntry): string {
  return `${entry.content} ${entry.tags.join(' ')}`;
}

export function buildCorpus(texts: string[]): BM25Corpus {
  const docs = texts.map(tokenize);
  const N = docs.length;
  const df = new Map<string, number>();

  let totalLen = 0;
  for (const doc of docs) {
    totalLen += doc.length;
    const seen = new Set<string>();
    for (const term of doc) {
      if (!seen.has(term)) {
        df.set(term, (df.get(term) ?? 0) + 1);
        seen.add(term);
      }
    }
  }

  const avgLen = N > 0 ? totalLen / N : 1;
  return { docs, avgLen, df, N };
}

export function bm25Score(corpus: BM25Corpus, docIdx: number, queryTerms: string[]): number {
  const doc = corpus.docs[docIdx];
  const docLen = doc.length;
  let score = 0;

  const tf = new Map<string, number>();
  for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);

  for (const term of queryTerms) {
    const f = tf.get(term) ?? 0;
    if (f === 0) continue;

    const df = corpus.df.get(term) ?? 0;
    const idf = Math.log((corpus.N - df + 0.5) / (df + 0.5) + 1);
    const numerator = f * (BM25_K1 + 1);
    const denominator = f + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / corpus.avgLen));
    score += idf * (numerator / denominator);
  }

  return score;
}

/** Query terms that appear in the entry's indexed text, in query order. */
export function matchedQueryTerms(queryTerms: Iterable<string>, entry: MemoryEntry): string[] {
  const docTerms = new Set(tokenize(entryText(entry)));
  const matched: string[] = [];
  for (const t of queryTerms) if (docTerms.has(t)) matched.push(t);
  return matched;
}
