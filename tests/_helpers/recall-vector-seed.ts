// The golden seed's extra rows plus a vector for every local row, so hybrid recall ranks by more than BM25 when the
// recall order and surface snapshot tests replay it.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setMeta } from '../../src/db/index.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors } from '../../src/db/vector-store.js';
import { embeddingIndexIdentity } from '../../src/base/embeddings/index-identity.js';
import { hashedVector } from './hashed-embedding-server.js';
import { onDb } from './store-worker-server.js';
import { seedPortBranches } from './recall-golden-seed.js';
import { loadEntriesByIds } from './root-forms.js';

const MODEL = 'hashed-16';

/** Vectors for every local row, so the vector arm changes the order. */
export async function seedVectors(root: string, url: string): Promise<void> {
  await seedPortBranches(root);
  // SAFETY: the SELECT names one column, id, so each row has it.
  const ids = onDb(root, (db) =>
    db
      .prepare('SELECT id FROM memories ORDER BY id')
      .all()
      .map((r) => String((r as { id: unknown }).id)),
  );
  const entries = loadEntriesByIds(root, ids);
  const index = Object.fromEntries(entries.map((e): [string, number[]] => [e.id, hashedVector(e.content)]));
  const identity = embeddingIndexIdentity(`openai:${MODEL}`);
  onDb(root, (db) => {
    upsertVectors(db, Object.entries(index), identity);
    setMeta(db, EMBEDDING_MODEL_META_KEY, identity);
  });
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ embeddings: { provider: 'openai', model: MODEL, apiBaseUrl: url } }),
  );
}
