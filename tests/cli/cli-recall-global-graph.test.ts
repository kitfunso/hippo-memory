// CLI recall walks the global store's graph, which it reads through the global store's enrichment
// (api/hippo-db-context.ts globalEnrichment), never through the primary store.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { runCli } from '../../src/cli.js';
import { insertEntityAt, insertRelationAt } from '../_helpers/graph-seed.js';
import { makeRoot } from '../_helpers/make-root.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';
import { initTestStore } from '../_helpers/store-template.js';

const { writeEntry } = sessionPerTest();
const T = 'default';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The ids `hippo recall <args> --json` prints, run in this process from `cwd` against `globalRoot`. */
async function recalled(cwd: string, globalRoot: string, ...args: string[]): Promise<string[]> {
  vi.stubEnv('HIPPO_HOME', globalRoot);
  vi.stubEnv('HIPPO_TENANT', T);
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  const saved = process.cwd();
  process.chdir(cwd);
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', 'recall', ...args, '--json']));
    expect(r.status, r.stderr).toBe(0);
    // SAFETY: recall --json prints one object whose rows each carry their memory's id.
    const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as { results: { id: string }[] };
    return out.results.map((row) => row.id);
  } finally {
    process.chdir(saved);
  }
}

function mem(root: string, text: string): MemoryEntry {
  const m = createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    tags: [],
    layer: Layer.Semantic,
    confidence: 'verified',
    source: 'test',
    tenantId: T,
  });
  writeEntry(root, m, { actor: 'test' });
  return m;
}

describe('CLI recall --hops on a global store with a graph', () => {
  it("surfaces a neighbour reached only through the global store's graph", async () => {
    const home = makeRoot('cli-global-graph', { init: false });
    initTestStore(join(home, '.hippo'));
    const globalRoot = join(home, 'global-hippo');
    initTestStore(globalRoot);
    // The seed and its edge live only in the global store; the neighbour shares no word with the query.
    const seed = mem(globalRoot, 'decision quokka about cache invalidation strategy');
    const linked = mem(globalRoot, 'wholly unrelated wording xyzzy plugh frobnicate');
    const from = insertEntityAt(globalRoot, T, { entityType: 'decision', name: 'B', memoryId: linked.id }).id;
    const to = insertEntityAt(globalRoot, T, { entityType: 'decision', name: 'A', memoryId: seed.id }).id;
    insertRelationAt(globalRoot, T, { fromEntityId: from, toEntityId: to, relType: 'supersedes', memoryId: linked.id });

    expect(await recalled(home, globalRoot, 'quokka')).toEqual([seed.id]);
    expect(await recalled(home, globalRoot, 'quokka', '--hops', '1')).toEqual([seed.id, linked.id]);
  });
});
