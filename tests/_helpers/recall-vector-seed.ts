// The golden seed's extra rows plus a vector for every local row and particles for most, so hybrid and physics recall
// rank by more than BM25 when the recall order and surface snapshot tests replay it.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setMeta } from '../../src/db/index.js';
import { resetAllPhysicsState } from '../../src/db/physics-state.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors } from '../../src/db/vector-store.js';
import { embeddingIndexIdentity } from '../../src/base/embeddings/index-identity.js';
import { hashedVector } from './hashed-embedding-server.js';
import { onDb } from './store-worker-server.js';
import { FAKE_NOW, seedPortBranches } from './recall-golden-seed.js';
import { loadEntriesByIds } from './root-forms.js';

const MODEL = 'hashed-16';
// Rows with a vector and no particle rank in physics' classic pool, so both physics pools are pinned.
const NO_PARTICLE = new Set(['mem_p_fill0', 'mem_p_noise']);

/** Vectors for every local row and particles for most, so the vector arm and physics scoring both change the order. */
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
    resetAllPhysicsState(
      db,
      entries.filter((e) => !NO_PARTICLE.has(e.id)),
      index,
      { now: new Date(FAKE_NOW) },
    );
  });
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ embeddings: { provider: 'openai', model: MODEL, apiBaseUrl: url }, physics: { enabled: true } }),
  );
}
