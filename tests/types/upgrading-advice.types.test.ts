/** The code UPGRADING-3.0 tells an integrator to write, compiled against the built declarations
 * they import; the last case fails when a row's code is not the code compiled here. */

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { typeOnly } from './_type-only.js';
import type { SleepStore } from '../../dist/index.js';
import { bindSessionOwner, captureSessionTexts, sessionEndHandoffForCaller, type Context } from '../../dist/server.js';
import {
  hasGroup,
  loadConfig,
  requireGroup,
  sqliteStore,
  type HippoStore,
  type StoreGroups,
  type VectorWrites,
} from '../../dist/entry/store-kit.js';
import { graphExpandRecall, hybridSearch } from '../../dist/entry/search.js';
import { goalPush } from '../../dist/entry/eval-scripts.js';
import { transcriptWorkingState } from '../../dist/entry/session-text.js';

type Source = NonNullable<NonNullable<Parameters<typeof hybridSearch>[2]>['source']>;
type GlobalTarget = NonNullable<NonNullable<Context['reach']>['globalTarget']>;
type GlobalInReach = NonNullable<NonNullable<Context['reach']>['global']>;
type GlobalStore = GlobalInReach['store'];

declare const ctx: Context;
declare const sessionId: string;
declare const hippoRoot: string;
declare const transcriptPath: string;
declare const globalRoot: string;
declare const tenantId: string;
declare const query: string;
declare const entries: Parameters<typeof hybridSearch>[1];
declare const results: Parameters<typeof graphExpandRecall>[0];
declare const provider: Source['provider'];
declare const consolidation: SleepStore['consolidation'];
declare const req: Parameters<typeof captureSessionTexts>[1];
declare const end: Omit<Parameters<typeof sessionEndHandoffForCaller>[1], 'sessionId'>;
declare const base: HippoStore;
declare const sessions: StoreGroups['sessions'];

describe('UPGRADING-3.0 advice', () => {
  it('narrows the store and hands the entry a Context built around it (narrowStore, Context.store, session entries)', () => {
    typeOnly(async () => {
      const { store } = ctx;
      if (hasGroup(store, 'sessions')) await bindSessionOwner({ ...ctx, store }, sessionId);
      if (hasGroup(store, 'sessions')) {
        await sessionEndHandoffForCaller({ ...ctx, store }, { ...end, sessionId });
      }
      if (hasGroup(ctx.store, 'sessions')) {
        // @ts-expect-error narrowing ctx.store does not narrow ctx
        await bindSessionOwner(ctx, sessionId);
      }
      // @ts-expect-error a Context whose store names no sessions is refused
      await bindSessionOwner(ctx, sessionId);
      // The spread row 18 warns against compiles; it drops the store's marks at run time.
      expectTypeOf({ ...store, sessions: requireGroup(store, 'sessions') }).toHaveProperty('sessions');
    });
  });

  it('narrows the store for a capture entry (captureSessionTexts)', () => {
    typeOnly(async () => {
      if (hasGroup(ctx.store, 'captures')) await captureSessionTexts({ ...ctx, store: ctx.store }, req);
    });
  });

  it('pushes a goal on a store narrowed to goals (goalPush)', () => {
    typeOnly(async () => {
      const { store } = ctx;
      if (hasGroup(store, 'goals')) await goalPush({ ...ctx, store }, { sessionId, goalName: 'g' });
    });
  });

  it('builds a vector source from any store (VectorSource)', () => {
    typeOnly(async () => {
      const { store } = ctx;
      await hybridSearch(query, entries, {
        source: {
          store,
          vectors: store.vectors,
          graphReads: hasGroup(store, 'graphReads') ? store.graphReads : undefined,
          provider,
        },
      });
      await hybridSearch(query, entries, { store });
    });
  });

  it('expands recall on a store narrowed to graphReads (graphExpandRecall)', () => {
    typeOnly(async () => {
      const { store } = ctx;
      if (hasGroup(store, 'graphReads')) await graphExpandRecall(results, { store, hops: 1, tenantId });
    });
  });

  it('passes the read error fields as an optional second log argument (transcriptWorkingState)', () => {
    typeOnly(() => {
      transcriptWorkingState(transcriptPath, (line) => expectTypeOf(line).toBeString());
      transcriptWorkingState(transcriptPath, (line, { fields } = {}) => expectTypeOf(fields).not.toBeAny());
    });
  });

  it('asks a vector write group for the key of its index (VectorWrites.indexKey)', () => {
    expectTypeOf<VectorWrites['indexKey']>().toEqualTypeOf<() => Promise<string>>();
  });

  it('names the optional groups a store literal sets in its type (HippoStore)', () => {
    typeOnly(() => {
      const store: HippoStore & Pick<StoreGroups, 'sessions'> = { ...base, sessions };
      // @ts-expect-error HippoStore names no optional group, so a literal typed HippoStore may not set one
      const refused: HippoStore = { ...base, sessions };
      expectTypeOf(store).toHaveProperty('sessions');
      expectTypeOf(refused).not.toHaveProperty('sessions');
    });
  });

  it('sleeps only on a store that sets graphReads (SleepStore)', () => {
    typeOnly(() => {
      const sleeper: SleepStore = { ...sqliteStore(hippoRoot), consolidation };
      const twoX: Omit<SleepStore, 'graphReads'> = sleeper;
      // @ts-expect-error the 2.x sleep groups on a 3.0 store, without graphReads
      const refused: SleepStore = twoX;
      expectTypeOf(refused).toEqualTypeOf<SleepStore>();
    });
  });

  it('names the global store a reach reads and the one a share writes to (reach.global, reach.globalTarget)', () => {
    typeOnly(() => {
      const global = (root: string, store: GlobalStore): GlobalInReach => ({ root, store, config: loadConfig(root) });
      const target: GlobalTarget = { store: sqliteStore(globalRoot), config: loadConfig(globalRoot) };
      const shorthand = (store: GlobalTarget['store'], config: GlobalTarget['config']): GlobalTarget => ({
        store,
        config,
      });
      expectTypeOf(shorthand).returns.toEqualTypeOf<GlobalTarget>();
      expectTypeOf(global).returns.toEqualTypeOf<GlobalInReach>();
      expectTypeOf(target).toEqualTypeOf<GlobalTarget>();
    });
  });

  // Nothing below this line counts as compiled code.
  it('compiles every statement and object literal the guide gives, as the guide writes it', () => {
    expect(uncovered()).toEqual([]);
  });
});

const squash = (text: string): string => text.replace(/\s+/g, '').replace(/,(?=[)}\]])/g, '');
const STATEMENT = /^(const |if \(|await )/;
const FIELDS = 'names the fields of a type the port declares, which tsc checks there';
const JSON_BODY = 'an HTTP body, not TypeScript';

/** The code this file compiles: no comment, no line a `@ts-expect-error` holds, nothing after the check. */
function compiledText(): string {
  const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  const end = lines.findIndex((line) => line.includes('Nothing below this line counts as compiled code.'));
  const kept: string[] = [];
  let expectingError = false;
  for (const line of lines.slice(0, end)) {
    if (/^\s*\/\/\s*@ts-expect-error/.test(line)) expectingError = true;
    else if (expectingError) expectingError = !/[;}]\s*$/.test(line);
    else if (!/^\s*(\/\/|\/?\*)/.test(line)) kept.push(line);
  }
  return squash(kept.join('\n'));
}

/** Each statement or object span in the guide's advice column that this file does not compile and
 * UNCOMPILED_SPANS does not name, as `row: span`; a UNCOMPILED_SPANS entry the guide no longer holds is listed too. */
function uncovered(): string[] {
  const compiled = compiledText();
  const guide = readFileSync(new URL('../../docs/UPGRADING-3.0.md', import.meta.url), 'utf8');
  const misses: string[] = [];
  const seen = new Set<string>();
  for (const line of guide.split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| ---')) continue;
    const [first = '', ...advice] = line.slice(2).split(' | ');
    const row = /`([^`\n]+)`/.exec(first)?.[1] ?? first;
    for (const [, span = ''] of advice.join(' | ').matchAll(/`([^`\n]+)`/g)) {
      if (!STATEMENT.test(span) && !span.startsWith('{ ')) continue;
      if (compiled.includes(squash(span))) continue;
      const skipped = UNCOMPILED_SPANS.some((s) => s.row === row && s.spans.includes(span));
      if (skipped && !STATEMENT.test(span)) seen.add(`${row}: ${span}`);
      else misses.push(`${row}: ${span}`);
    }
  }
  const stale = UNCOMPILED_SPANS.flatMap((s) => s.spans.map((span) => `${s.row}: ${span}`)).filter((k) => !seen.has(k));
  return [...misses, ...stale.map((k) => `stale ${k}`)];
}

/** Shape spans the guide shows and this file does not compile, by row, each with its reason. */
const UNCOMPILED_SPANS: readonly {
  readonly row: string;
  readonly spans: readonly string[];
  readonly reason: string;
}[] = [
  { row: 'initStore(hippoRoot, opts?)', spans: ['{ runtime?, session?, busyWaitMs? }'], reason: FIELDS },
  { row: 'cards.list(tenantId, { status })', spans: ['{ cards, next }'], reason: FIELDS },
  { row: 'HippoStore', spans: ['{ written, notes }'], reason: FIELDS },
  {
    row: 'EmbeddingIndex.pruneListPending()',
    spans: ["{ kind: 'pending', page: { limit, afterId } }", '{ ids, next }'],
    reason: FIELDS,
  },
  {
    row: 'Learning.entriesMentioning(tokens, tag, tenantId)',
    spans: ['{ limit, after }', '{ entries, next }'],
    reason: FIELDS,
  },
  { row: 'Conflicts.list(tenantId, status)', spans: ['{ rows, next }'], reason: FIELDS },
  {
    row: 'Conflicts.resolve(tenantId, { conflictId, keepId, forgetLoser }, { rejectLoserValue, rejectedBy, reason })',
    spans: ['{ id, scope }', "{ kind: 'weaken' }", "{ kind: 'remove' }", "{ kind: 'reject', ownScope }"],
    reason: FIELDS,
  },
  {
    row: 'ContextReads.ambientCandidates(tenantId, { recentNeeded, admit, recall?, origins? })',
    spans: ['{ id, reason }'],
    reason: FIELDS,
  },
  { row: 'entryWrites', spans: ['{ pinned }'], reason: FIELDS },
  {
    row: 'AuditMaintenance.repairQuality(tenantId, apply)',
    spans: ['{ pinned, raw, trusted, objectBacked }'],
    reason: FIELDS,
  },
  {
    row: 'hippo dashboard',
    spans: ['{ "error" }', '{ "error": "internal server error", "requestId" }'],
    reason: JSON_BODY,
  },
  { row: 'POST /v1/outcome', spans: ['{ "applied": 0, "ids": [] }'], reason: JSON_BODY },
  { row: 'DormantRestoreRequest.inReach', spans: ['{ halfLifeDays, strength }'], reason: FIELDS },
  {
    row: 'reports.correctionEntries()',
    spans: ['{ oldId, newId, correctedAt, sourceCreated }', '{ id, owner, artifactRef }'],
    reason: FIELDS,
  },
  { row: 'POST /v1/memories', spans: ['{ "skipped": { "reason", "score" } }'], reason: JSON_BODY },
  { row: 'LoserFate', spans: ["{ kind: 'weaken', halfLifeFactor, minHalfLifeDays }"], reason: FIELDS },
  { row: 'embeddingIndex.summary()', spans: ['{ vectors, dims }'], reason: FIELDS },
  { row: 'EntryTarget', spans: ['{ scope, owner }'], reason: FIELDS },
  {
    row: 'consolidation',
    spans: [
      '{ from, outcome, fts, sleepCount, recentRuns, sessions }',
      '{ summaries, more }',
      '{ removedIds, expired }',
    ],
    reason: FIELDS,
  },
  { row: 'reports.entriesPage(tenantId, page)', spans: ['{ limit, after?, newest? }', '{ tenantId }'], reason: FIELDS },
  { row: 'sharing.textKeysHolding(tenantId, texts)', spans: ['{ tenantId }'], reason: FIELDS },
  {
    row: 'contextReads.unfinishedHandoff',
    spans: [
      '{ source, tag, live: true }',
      "{ kinds: ['raw'], artifactRefPrefix }",
      "{ kinds: ['raw'], live: true, sessionId, origins }",
    ],
    reason: FIELDS,
  },
  { row: 'projectTags.entriesFromOrigin', spans: ['{ origin, transcript, cwd }'], reason: FIELDS },
  { row: 'embeddingIndex', spans: ['{ id, key }'], reason: FIELDS },
  {
    row: 'graphReads.entitiesForMemories(tenantId, memoryIds)',
    spans: ["{ by: 'memory', ids }", "{ by: 'entity', ids }", "{ by: 'neighbor', ids, limit }"],
    reason: FIELDS,
  },
  {
    row: 'connectorEvents.deletionTarget',
    spans: [
      '{ artifactRef, tenantId }',
      '{ duplicate, archived }',
      '{ tenantId, actor, artifactRef, reason }',
      '{ tenantId }',
      '{ tenantId: null, routes }',
      '{ id }',
      "{ connector: 'slack', tenantId, channelId }",
      "{ connector: 'github', tenantId, repo, stream }",
    ],
    reason: FIELDS,
  },
];
