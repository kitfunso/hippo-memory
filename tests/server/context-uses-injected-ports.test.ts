// A per-request Context takes its embedder from the infra ports the server was built with, for the
// global write target as for the local store.
import { describe, expect, it } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { buildContextWithAuth } from '../../src/surface/server/auth.js';
import { issueLocalKey, readLocalKey } from '../../src/surface/server/local-key.js';
import { KeyVerifier } from '../../src/surface/server/api-key.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { DEFAULT_CONFIG } from '../../src/base/config/config.js';
import type { EmbedderFor } from '../../src/base/ports/embedder.js';
import { makeRoot } from '../_helpers/make-root.js';
import { testInfra } from '../_helpers/infra.js';

describe('the per-request Context', () => {
  it('embeds a global-store write with the embedder the infra ports carry', async () => {
    const root = makeRoot('ctx-ports');
    const globalRoot = makeRoot('ctx-ports-global');
    const store = sqliteStore(root);
    const swapped: EmbedderFor = () => {
      throw new Error('swapped embedder');
    };
    const infra = { ...testInfra(), embedderFor: swapped };
    const localKey = issueLocalKey(root);
    const req = new IncomingMessage(new Socket());
    req.headers['authorization'] = `Bearer ${tokenOf(root)}`;
    const ctx = await buildContextWithAuth(req, {
      hippoRoot: root,
      store,
      localKey,
      keyVerifier: new KeyVerifier(),
      reachOf: (shared) => ({
        hasLocal: true,
        isGlobal: false,
        shared,
        globalTarget: { root: globalRoot, store: sqliteStore(globalRoot) },
      }),
      configAt: () => DEFAULT_CONFIG,
      onHippoDb: true,
      infra: () => infra,
    });
    expect(ctx.reach?.globalTarget?.embedderFor).toBe(swapped);
  });
});

function tokenOf(root: string): string {
  const token = readLocalKey(root);
  if (token === undefined) throw new Error('no local key was written');
  return token;
}
