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
  physicsSearch,
  requireGroup,
  sqliteStore,
  type VectorWrites,
} from '../../dist/entry/store-kit.js';
import { graphExpandRecall, hybridSearch } from '../../dist/entry/search.js';
import { goalPush } from '../../dist/entry/eval-scripts.js';

type Source = NonNullable<NonNullable<Parameters<typeof hybridSearch>[2]>['source']>;
type GlobalTarget = NonNullable<NonNullable<Context['reach']>['globalTarget']>;
type GlobalInReach = NonNullable<NonNullable<Context['reach']>['global']>;
type GlobalStore = GlobalInReach['store'];

declare const ctx: Context;
declare const sessionId: string;
declare const hippoRoot: string;
declare const globalRoot: string;
declare const tenantId: string;
declare const query: string;
declare const entries: Parameters<typeof hybridSearch>[1];
declare const results: Parameters<typeof graphExpandRecall>[0];
declare const provider: Source['provider'];
declare const consolidation: SleepStore['consolidation'];
declare const req: Parameters<typeof captureSessionTexts>[1];
declare const end: Omit<Parameters<typeof sessionEndHandoffForCaller>[1], 'sessionId'>;

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

  it('builds a vector source from a store that keeps vectors (VectorSource)', () => {
    typeOnly(async () => {
      const { store } = ctx;
      if (hasGroup(store, 'vectors')) {
        await hybridSearch(query, entries, {
          source: {
            store,
            vectors: store.vectors,
            graphReads: hasGroup(store, 'graphReads') ? store.graphReads : undefined,
            provider,
          },
        });
      }
      await hybridSearch(query, entries, { store });
      await physicsSearch(query, entries, { store });
    });
  });

  it('expands recall on a store narrowed to graphReads (graphExpandRecall)', () => {
    typeOnly(async () => {
      const { store } = ctx;
      if (hasGroup(store, 'graphReads')) await graphExpandRecall(results, { store, hops: 1, tenantId });
    });
  });

  it('asks a vector write group for the key of its index (VectorWrites.indexKey)', () => {
    expectTypeOf<VectorWrites['indexKey']>().toEqualTypeOf<() => Promise<string>>();
  });

  it('sleeps only on a store that sets vectors and graphReads (SleepStore)', () => {
    typeOnly(() => {
      const sleeper: SleepStore = { ...sqliteStore(hippoRoot), consolidation };
      const twoX: Omit<SleepStore, 'vectors' | 'graphReads'> = sleeper;
      // @ts-expect-error the 2.x sleep groups on a 3.0 store, without vectors and graphReads
      const refused: SleepStore = twoX;
      expectTypeOf(refused).toEqualTypeOf<SleepStore>();
    });
  });

  it('names the global store a reach reads and the one a share writes to (reach.global, reach.globalTarget)', () => {
    typeOnly(() => {
      const global = (root: string, store: GlobalStore): GlobalInReach => ({ root, store, config: loadConfig(root) });
      const target: GlobalTarget = { store: sqliteStore(globalRoot), config: loadConfig(globalRoot) };
      expectTypeOf(global).returns.toEqualTypeOf<GlobalInReach>();
      expectTypeOf(target).toEqualTypeOf<GlobalTarget>();
    });
  });

  it('compiles every statement and object literal the guide gives, as the guide writes it', () => {
    const squash = (text: string): string => text.replace(/\s+/g, '').replace(/,(?=[)}\]])/g, '');
    const guide = readFileSync(new URL('../../docs/UPGRADING-3.0.md', import.meta.url), 'utf8');
    const compiled = squash(
      readFileSync(new URL(import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
        .join('\n'),
    );
    const code = [...guide.matchAll(/`([^`\n]+)`/g)]
      .map(([, span]) => span)
      .filter((span) => /^(const |if \(|await )/.test(span) || /^\{ .*(\.\.\.|\(|\w\.\w)/.test(span));

    expect(code.length).toBeGreaterThan(8);
    expect(code.filter((span) => !compiled.includes(squash(span)))).toEqual([]);
  });
});
