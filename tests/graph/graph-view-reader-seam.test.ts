// The store port tells admin from member only: graphView folds a viewer into member before the port sees it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { graphView } from '../../src/api/objects/graph.js';
import type { GraphReads, GraphRows, GraphViewQuery } from '../../src/base/ports/store.js';
import type { Role } from '../../src/base/scope/role.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';

let root: string;
beforeAll(() => {
  root = makeRoot('graph-reader-seam');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const EMPTY: GraphRows = { entities: [], relations: [], truncated: false };

async function readerSeenBy(role: Role): Promise<GraphViewQuery['reader']> {
  const seen: GraphViewQuery[] = [];
  const actor = { subject: 'vera', role, scopes: ['team:a'], owner: 'vera' };
  const base = apiCtx(root, 't1', actor);
  const graphReads: GraphReads = {
    ...base.store.graphReads,
    graphRows: async (_tenantId, query) => {
      if ('limit' in query && 'reader' in query) seen.push(query);
      return EMPTY;
    },
  };
  await graphView({ ...base, store: { ...base.store, graphReads } }, { limit: 10 });
  expect(seen).toHaveLength(1);
  return seen[0]?.reader;
}

describe('graphView reader at the store port', () => {
  it('reaches the store as a member for a viewer, with its scopes and owner kept', async () => {
    expect(await readerSeenBy('viewer')).toEqual({ role: 'member', scopes: ['team:a'], owner: 'vera' });
  });

  it.each(['admin', 'member'] as const)('keeps %s as it is', async (role) => {
    expect((await readerSeenBy(role))?.role).toBe(role);
  });
});
