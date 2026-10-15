// The api's write functions answer through a Promise on every store kind, and the last-recall writes need the store's lastRecall group.
import type { FullContext } from './_helpers/api-ctx.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archiveRaw, authCreate, authCreateSelf, authListRows, authRevoke, forget, outcome, outcomeForLastRecall, remember, supersede,
  type Actor, type ContextWith,
} from '../src/api/index.js';
import { mapApiError } from '../src/api/error-reply.js';
import { rememberLocally } from '../src/api/remember-local.js';
import { importVault } from '../src/importers/vault.js';
import { sqliteStore, type HippoStore, type StoreGroups } from '../src/store/index.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { workerSqliteStore } from '../src/store/sqlite/worker-store.js';
import { StoreNotPortedError } from '../src/util/sqlite-blocked.js';
import { makeRoot } from './_helpers/make-root.js';
import { inMemoryEntryWritesStore } from './_helpers/in-memory-entry-writes-store.js';
import { seeded } from './_helpers/recall-golden-seed.js';
import { apiCtx } from './_helpers/api-ctx.js';

const ACME = 'acme';
const SEEDED_AT = '2026-02-01T00:00:00.000Z';
const HOST: Actor = { subject: 'cli', role: 'admin', hostAdmin: true };
const CAROL: Actor = { subject: 'sso:carol', role: 'member', viaAuthResolver: true, owner: 'carol' };

const roots: string[] = [];
const stores: HippoStore[] = [];

function seededRoot(): string {
  const root = makeRoot('async-contract');
  roots.push(root);
  writeEntry(root, seeded('the deploy pipeline uses a blue green rollout', 'mem_plain', SEEDED_AT, {}, { tenantId: ACME }));
  writeEntry(root, seeded('the billing service freezes deploys on fridays', 'mem_second', SEEDED_AT, {}, { tenantId: ACME }));
  writeEntry(root, seeded('raw chat line about the staging cluster move', 'mem_raw', SEEDED_AT, {}, { tenantId: ACME, kind: 'raw' }));
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
  archiveRaw: async (ctx) => () => archiveRaw(ctx, 'mem_raw', 'user asked'),
  remember: async (ctx) => () => remember(ctx, { content: 'the api gateway retries three times' }),
  // importVault takes no store and rememberLocally gets the folder's own: both write through its sqliteStore.
  rememberLocally: async (ctx) => () => rememberLocally(apiCtx(ctx.hippoRoot, ctx.tenantId, ctx.actor), { content: 'the cache warms on every deploy', tags: [] }),
  importVault: async (ctx) => () => importVault(vaultFolder(), { hippoRoot: ctx.hippoRoot, tenantId: ctx.tenantId, name: 'notes' }),
} satisfies Record<string, Case>;

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
    it.each(Object.entries(CASES))('%s returns a thenable that resolves', async (_fn, ready) => {
      const root = seededRoot();
      const store = open(root);
      stores.push(store);
      const call = await ready({ hippoRoot: root, tenantId: ACME, actor: HOST, store });
      const reply = call();
      expect(reply).toBeInstanceOf(Promise);
      await expect(reply).resolves.toBeDefined();
    });
  });
});

describe('a store without the lastRecall group', () => {
  // Its entryWrites group answers, so the refusal can only come from the missing lastRecall group.
  function refusal(call: (ctx: ContextWith<'entryWrites'>) => Promise<object>): Promise<Error | null> {
    const root = seededRoot();
    const { store } = inMemoryEntryWritesStore(root);
    return call({ hippoRoot: root, tenantId: ACME, actor: HOST, store }).then(() => null, (err: Error) => err);
  }

  it('outcomeForLastRecall is refused with a 501 that asks for the ids the recall returned', async () => {
    const error = await refusal((ctx) => outcomeForLastRecall(ctx, true));
    expect(mapApiError(error)).toEqual({ status: 501, message: 'this store keeps no last recall: send the ids your recall returned' });
  });

  it('outcome with a traceId is refused as not ported, a 501', async () => {
    const error = await refusal((ctx) => outcome(ctx, ['mem_plain'], true, { traceId: 1 }));
    expect(error).toBeInstanceOf(StoreNotPortedError);
    expect(error).toMatchObject({ group: 'lastRecall' });
    expect(mapApiError(error).status).toBe(501);
  });
});
