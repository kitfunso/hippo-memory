// The store worker's two readers answer a nearest-row read alike, though only the first holds the vector graph.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { MemoryEntry } from '../../src/core/memory.js';
import type { VectorCandidateSpec } from '../../src/store/port/vector-reads.js';
import { createSqliteExecutor } from '../../src/store/sqlite/executor.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { workerSqliteStore } from '../../src/store/sqlite/worker-store.js';
import { cleanups, newRoot, undoAll } from '../_helpers/store-worker-server.js';
import { clusteredVectors, near, seedVectorRows } from '../_helpers/vector-rows.js';

afterEach(undoAll);

const DIM = 32;
const ROWS = 400;

const ids = (entries: readonly MemoryEntry[]): string[] => entries.map((e) => e.id);

/** Everything written to stderr from now, the store threads' log lines included. */
function stderrText(): () => string {
  const write = vi.spyOn(process.stderr, 'write');
  return () => write.mock.calls.map(([chunk]) => String(chunk)).join('');
}

async function until(done: () => boolean): Promise<void> {
  while (!done()) await delay(20);
}

describe('a nearest-row read on a store over the threshold', () => {
  it('answers the same from the reader with the graph, the reader without it and the store in process', async () => {
    const root = newRoot('vector-graph-lanes');
    const vectors = clusteredVectors(ROWS, DIM, 21);
    seedVectorRows(
      root,
      vectors.map((vector, i) => ({ id: `m-${i}`, tenantId: i % 2 === 0 ? 'even' : 'odd', vector })),
    );
    vi.stubEnv('HIPPO_LOG', 'info');
    const logged = stderrText();
    const executor = createSqliteExecutor(root, { vectorGraphThreshold: 100 });
    const store = workerSqliteStore(root, executor);
    const inProcess = sqliteStore(root);
    cleanups.push(
      () => store.close(),
      () => inProcess.close(),
    );
    const spec = (tenantId: string): VectorCandidateSpec => ({
      tenantId,
      includeSuperseded: false,
      limit: 10,
      scope: { mode: 'default-deny' },
    });

    await store.vectors.nearestEntries(vectors[0], spec('even'));
    await until(() => logged().includes(`the vector graph of ${ROWS} vectors of length ${DIM} is ready`));

    for (const [n, tenant] of ['even', 'odd', 'even', 'odd'].entries()) {
      const q = near(vectors[n * 50], n);
      const call = (mode: 'pinned-read' | 'read') =>
        executor.call<MemoryEntry[]>('vectors.nearestEntries', [q, spec(tenant)], { mode, requestId: undefined });
      // The pinned call holds the first reader, so the plain read goes to the second.
      const [pinned, plain] = await Promise.all([call('pinned-read'), call('read')]);

      expect(ids(pinned)).toHaveLength(10);
      expect(ids(pinned)).toEqual(ids(plain));
      expect(ids(plain)).toEqual(ids(await inProcess.vectors.nearestEntries(q, spec(tenant))));
    }
    expect(logged().match(/the vector graph of \d+ vectors/g)).toHaveLength(1);
  });
});
