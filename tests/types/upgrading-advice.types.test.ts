/** The advice of each UPGRADING-3.0 store-group row, compiled against the built declarations an
 * integrator imports, so a row whose code does not compile fails here. */

import { describe, expectTypeOf, it } from 'vitest';
import { typeOnly } from './_type-only.js';
import { bindSessionOwner, sessionEndHandoffForCaller, type Context } from '../../dist/server.js';
import { hasGroup, physicsSearch, requireGroup, type VectorWrites } from '../../dist/entry/store-kit.js';
import { hybridSearch } from '../../dist/entry/search.js';
import { goalPush } from '../../dist/entry/eval-scripts.js';

type Source = NonNullable<NonNullable<Parameters<typeof hybridSearch>[2]>['source']>;

declare const ctx: Context;
declare const embedder: Source['provider'];
declare const end: Omit<Parameters<typeof sessionEndHandoffForCaller>[1], 'sessionId'>;

describe('UPGRADING-3.0 store-group advice', () => {
  it('narrows the store and hands the entry a Context built around it (narrowStore, Context.store, session entries)', () => {
    typeOnly(async () => {
      const { store } = ctx;
      if (hasGroup(store, 'sessions')) {
        await bindSessionOwner({ ...ctx, store }, 'sess');
        await sessionEndHandoffForCaller({ ...ctx, store }, { ...end, sessionId: 'sess' });
      }
      if (hasGroup(ctx.store, 'sessions')) {
        // @ts-expect-error narrowing ctx.store does not narrow ctx
        await bindSessionOwner(ctx, 'sess');
      }
      // @ts-expect-error a Context whose store names no sessions is refused
      await bindSessionOwner(ctx, 'sess');
      requireGroup(store, 'sessions');
    });
  });

  it('pushes a goal on a store narrowed to goals (goalPush)', () => {
    typeOnly(async () => {
      const { store } = ctx;
      if (hasGroup(store, 'goals')) await goalPush({ ...ctx, store }, { sessionId: 's', goalName: 'g' });
    });
  });

  it('builds a vector source from a store that keeps vectors (VectorSource)', () => {
    typeOnly(async () => {
      const { store } = ctx;
      if (hasGroup(store, 'vectors')) {
        const graphReads = hasGroup(store, 'graphReads') ? store.graphReads : undefined;
        const source: Source = { store, vectors: store.vectors, graphReads, provider: embedder };
        await hybridSearch('q', [], { source });
        await hybridSearch('q', [], { store });
        await physicsSearch('q', [], { store });
      }
    });
  });

  it('asks a vector write group for the key of its index (VectorWrites.indexKey)', () => {
    expectTypeOf<VectorWrites['indexKey']>().toEqualTypeOf<() => Promise<string>>();
  });
});
