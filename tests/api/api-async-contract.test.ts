// The api's write functions answer through a Promise on every store kind; the HTTP edge refuses a last-recall outcome
// on a store without that group (store-port-capabilities.test.ts).
import type { FullContext } from '../_helpers/api-ctx.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rawArchive,
  authCreate,
  authCreateSelf,
  authListRows,
  authRevoke,
  forget,
  outcome,
  outcomeForLastRecall,
  remember,
  supersede,
  type Actor,
} from '../../src/api/index.js';
import { rememberLocally } from '../../src/api/memories/remember-local.js';
import { importVault } from '../../src/entry/importers.js';
import { sqliteStore, type HippoStore, type StoreGroups } from '../../src/store/index.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { workerSqliteStore } from '../../src/store/sqlite/worker-store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { seeded } from '../_helpers/recall-golden-seed.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { loadConfig } from '../../src/core/config.js';

const ACME = 'acme';
const SEEDED_AT = '2026-02-01T00:00:00.000Z';
const HOST: Actor = { subject: 'cli', role: 'admin', hostAdmin: true };
const CAROL: Actor = { subject: 'sso:carol', role: 'member', viaAuthResolver: true, owner: 'carol' };

const roots: string[] = [];
const stores: HippoStore[] = [];

function seededRoot(): string {
  const root = makeRoot('async-contract');
  roots.push(root);
  writeEntry(
    root,
    seeded('the deploy pipeline uses a blue green rollout', 'mem_plain', SEEDED_AT, {}, { tenantId: ACME }),
  );
  writeEntry(
    root,
    seeded('the billing service freezes deploys on fridays', 'mem_second', SEEDED_AT, {}, { tenantId: ACME }),
  );
  writeEntry(
    root,
    seeded('raw chat line about the staging cluster move', 'mem_raw', SEEDED_AT, {}, { tenantId: ACME, kind: 'raw' }),
  );
  return root;
}

function vaultFolder(): string {
  const vault = mkdtempSync(join(tmpdir(), 'hippo-async-contract-vault-'));
  roots.push(vault);
  writeFileSync(join(vault, 'note.md'), 'deploys go out on tuesdays after the standup');
  return vault;
}

/** Each case readies its rows, then hands back the one call under test. */
type Case = (ctx: FullContext) => Promise<() => PromiseLike<object>>;

const CASES = {
  authCreate: async (ctx) => () => authCreate(ctx, {}),
  authCreateSelf: async (ctx) => () => authCreateSelf({ ...ctx, actor: CAROL }, { ttlDays: 1, perSubject: 5 }),
  authListRows: async (ctx) => () => authListRows(ctx, { active: true }),
  authRevoke: async (ctx) => {
    const { keyId } = await authCreate(ctx, {});
    return () => authRevoke(ctx, keyId);
  },
  forget: async (ctx) => () => forget(ctx, 'mem_plain'),
  outcome: async (ctx) => () => outcome(ctx, ['mem_plain'], true),
  outcomeForLastRecall: async (ctx) => () => outcomeForLastRecall(ctx, true),
  supersede: async (ctx) => () => supersede(ctx, 'mem_second', 'the billing service freezes deploys on mondays'),
  rawArchive: async (ctx) => () => rawArchive(ctx, 'mem_raw', 'user asked'),
  remember: async (ctx) => () => remember(ctx, { content: 'the api gateway retries three times' }),
  // importVault takes no store and rememberLocally gets the folder's own: both write through its sqliteStore.
  rememberLocally: async (ctx) => () =>
    rememberLocally(apiCtx(ctx.hippoRoot, ctx.tenantId, ctx.actor), {
      content: 'the cache warms on every deploy',
      tags: [],
    }),
  importVault: async (ctx) => () =>
    importVault(vaultFolder(), { hippoRoot: ctx.hippoRoot, tenantId: ctx.tenantId, name: 'notes' }),
} satisfies Record<string, Case>;

// The key fields each call answers with, so a resolved value that lost its shape fails here.
const str = expect.any(String);
const REPLIES = {
  authCreate: { keyId: str, plaintext: str, tenantId: ACME, role: 'member', expiresAt: str },
  authCreateSelf: { keyId: str, plaintext: str, tenantId: ACME, role: 'member', expiresAt: str },
  authListRows: expect.any(Array),
  authRevoke: { ok: true, revokedAt: str },
  forget: { ok: true, id: 'mem_plain' },
  outcome: { applied: 1, appliedIds: ['mem_plain'] },
  outcomeForLastRecall: { applied: 0, ids: [] },
  supersede: { ok: true, oldId: 'mem_second', newId: str },
  rawArchive: expect.objectContaining({ ok: true }),
  remember: expect.objectContaining({ id: str, tenantId: ACME, tags: expect.any(Array) }),
  rememberLocally: expect.objectContaining({ status: 'stored' }),
  importVault: expect.objectContaining({ total: 1, imported: 1 }),
};

const STORE_KINDS: ReadonlyArray<readonly [string, (root: string) => HippoStore & StoreGroups]> = [
  ['sqliteStore', sqliteStore],
  ['workerSqliteStore', (root) => workerSqliteStore(root)],
];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('every api write function answers through a Promise', () => {
  it('covers the twelve functions', () => {
    expect(Object.keys(CASES)).toHaveLength(12);
  });

  describe.each(STORE_KINDS)('on %s', (_kind, open) => {
    it.each(Object.entries(CASES))('%s returns a thenable that resolves to its result', async (fn, ready) => {
      const root = seededRoot();
      const store = open(root);
      stores.push(store);
      const call = await ready({ hippoRoot: root, tenantId: ACME, actor: HOST, store, config: loadConfig(root) });
      const reply = call();
      expect(reply).toBeInstanceOf(Promise);
      await expect(reply).resolves.toEqual(new Map(Object.entries(REPLIES)).get(fn));
    });
  });
});
