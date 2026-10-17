// The CLI ranking core writes through the store the context carries, and the port names no SQLite code.

import type { Context } from '../src/api/types.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { queryAuditEvents } from '../src/store/audit.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { loadConfig } from '../src/core/config.js';
import { sqliteStore, type HippoStore, type LastRecallWrites, type RecallWrites } from '../src/store/index.js';
import { loadLastRecall } from '../src/store/index-and-stats.js';
import { outcomeForLastRecall } from '../src/api/index.js';
import { withSqliteAllowed } from '../src/db/index.js';
import { adminActor } from '../src/api/index.js';
import { retrieve } from '../src/api/recall/recall.js';
import type { CliCoreRecall } from '../src/api/recall/types.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { portOnlyStore } from './_helpers/port-only-store.js';
import { apiCtx, type FullContext } from './_helpers/api-ctx.js';

let home: string;
let hippoRoot: string;

function cliCore(): CliCoreRecall {
  const config = loadConfig(hippoRoot);
  return {
    rank: {
      budget: 4000, cost: (r) => r.tokens, window: { limit: 10 }, includeSuperseded: false, explicitScope: null, activeScope: null,
      search: { usePhysics: false, physicsConfig: config.physics, multihop: false, mmr: false, mmrLambda: 0.7, localBump: 1.2, explain: false },
    },
    show: (ranking) => ({ results: ranking.results, audit: [], tokens: 0 }),
  };
}

function recallRowsInHippoDb(): number {
  const db = openHippoDb(hippoRoot);
  try {
    return queryAuditEvents(db, { tenantId: 'default', op: 'recall' }).length;
  } finally {
    closeHippoDb(db);
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hippo-recall-core-store-'));
  hippoRoot = join(home, '.hippo');
  vi.stubEnv('HIPPO_HOME', join(home, 'global'));
  initStore(hippoRoot);
  for (const [i, text] of ['deploy pipeline uses blue green rollout', 'deploy token rotation happens weekly'].entries()) {
    writeEntry(hippoRoot, { ...createMemory(text), id: `mem_core_${i}`, strength: 1 });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('retrieve with the CLI ranking core', () => {
  it('writes the recall through a store that is not hippo.db when the context carries one', async () => {
    const inner = portOnlyStore(hippoRoot);
    const writes: RecallWrites[] = [];
    const lastRecall = sqliteStore(hippoRoot).lastRecall;
    const store: HippoStore = {
      ...inner,
      lastRecall: {
        ...lastRecall,
        finishRecall: async (w: LastRecallWrites, root) => {
          writes.push(w);
          return withSqliteAllowed(() => lastRecall.finishRecall(w, root));
        },
      },
    };
    const ctx: Context = { hippoRoot, tenantId: 'default', actor: adminActor('cli'), store };

    const result = await retrieve(ctx, { query: 'deploy', cliCore: cliCore() });

    expect(store.kind).toBe('port-only');
    expect(result.results.map((r) => r.id).sort()).toEqual(['mem_core_0', 'mem_core_1']);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.audit.map((a) => a.op)).toEqual(['recall']);
    expect([...(writes[0]!.strengthen?.ids ?? [])].sort()).toEqual(['mem_core_0', 'mem_core_1']);
    expect(recallRowsInHippoDb()).toBe(1);
    expect(writes[0]!.trace?.results).toHaveLength(2);
  });

  it('leaves the last-recall marker on the previous recall when a later recall shows nothing', async () => {
    const ctx: FullContext = apiCtx(hippoRoot, 'default', adminActor('cli'));
    await retrieve(ctx, { query: 'deploy', cliCore: cliCore() });
    const marked = loadLastRecall(hippoRoot);
    expect([...marked.last_retrieval_ids].sort()).toEqual(['mem_core_0', 'mem_core_1']);

    const empty = await retrieve(ctx, { query: 'zzqqxx nomatch', cliCore: cliCore() });

    expect(empty.results).toEqual([]);
    const after = loadLastRecall(hippoRoot);
    expect(after.last_retrieval_ids).toEqual(marked.last_retrieval_ids);
    expect(after.last_trace_id).toBe(marked.last_trace_id);
    const outcome = await outcomeForLastRecall(ctx, true);
    expect(outcome.applied).toBe(2);
    expect([...outcome.ids].sort()).toEqual(['mem_core_0', 'mem_core_1']);
  });

  it('writes the second store\'s recall rows through the store named for that root', async () => {
    const secondRoot = join(home, 'second');
    initStore(secondRoot);
    writeEntry(secondRoot, { ...createMemory('deploy notes kept in the second store'), id: 'mem_second_0', strength: 1 });
    const inner = portOnlyStore(secondRoot);
    const writes: RecallWrites[] = [];
    const globalStore: HippoStore = { ...inner, finishRecall: async (w) => { writes.push(w); await inner.finishRecall(w); } };
    const ctx: FullContext = apiCtx(hippoRoot, 'default', adminActor('cli'));

    const result = await retrieve(ctx, { query: 'deploy', cliCore: { ...cliCore(), sources: { globalRoot: secondRoot, globalStore } } });

    expect(result.results.map((r) => r.id)).toContain('mem_second_0');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.audit.map((a) => a.op)).toEqual(['recall']);
    expect([...(writes[0]!.strengthen?.ids ?? [])]).toEqual(['mem_second_0']);
  });
});

describe('the store port', () => {
  it('imports nothing from the SQLite layer, so an add-on can build a store on it alone', () => {
    // A layering rule about imports, which no call can show, so the file text is the contract.
    const source = readFileSync(join(import.meta.dirname, '../src/store/port.ts'), 'utf8');
    expect(source).not.toMatch(/from '\.\.\/db\//);
  });
});
