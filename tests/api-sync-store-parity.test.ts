// Runs each dual-mode api function on hippo.db directly and through sqliteStore, on two copies of one seeded store.
// It carries the twin collapse: the change that removes the last twin deletes the path comparison and keeps only CONTRACT and the importVault test.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import {
  archiveRaw, authCreate, authCreateSelf, authGrant, authList, authListRows, authRevoke, authUngrant, forget, outcome, outcomeForLastRecall, reject,
  remember, supersede, type Actor, type Context,
} from '../src/api.js';
import { grantScope, insertApiKey, revokeApiKey } from '../src/auth.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import type { ImportResult } from '../src/importers/core.js';
import { importVault } from '../src/importers/vault.js';
import { writeRecallTraceAtRoot } from '../src/recall-trace.js';
import { rejectionDigest } from '../src/rejection.js';
import { sqliteStore, type HippoStore, type StoreGroup } from '../src/store-port.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadIndex, saveIndex } from '../src/store/index-and-stats.js';
import { recordStatements, recordStatementsAsync, STORE_OPEN } from './_helpers/count-statements.js';
import { makeRoot } from './_helpers/make-root.js';
import { portOnlyStoreWithoutVectorReads } from './_helpers/port-only-store.js';
import { seeded } from './_helpers/recall-golden-seed.js';

interface Difference {
  readonly fn: string;
  readonly differs: string;
  readonly onHippoDb: string;
  readonly throughStore: string;
  /** The side the collapse keeps, or `open` with what each choice costs. */
  readonly winner: string;
  /** `here`, or the test that already owns the row. */
  readonly pinnedBy: string;
}

const KNOWN_DIFFERENCES = {
  forgetLock: {
    fn: 'forget',
    differs: 'hippo.db checks reach on one handle and deletes on a second; the store checks inside the delete\'s write lock',
    onHippoDb: 'src/api/forget.ts:44-63',
    throughStore: 'src/store/entry-writes-group.ts:52-59',
    winner: 'store: one write scope',
    pinnedBy: 'here',
  },
  archiveLock: {
    fn: 'archiveRaw',
    differs: 'hippo.db checks reach before it takes the write lock; the store checks inside it',
    onHippoDb: 'src/api/promote.ts:214-222',
    throughStore: 'src/store/entry-writes-group.ts:40-51',
    winner: 'store: the group',
    pinnedBy: 'here',
  },
  idCollision: {
    fn: 'remember',
    differs: 'a new id another tenant already holds moves that row to the writer on hippo.db; the store rejects with ConflictError',
    onHippoDb: 'src/api/remember.ts:136',
    throughStore: 'src/store/entry-writes-group.ts:73-90',
    winner: 'store: the group',
    pinnedBy: 'here for hippo.db; tests/entry-writes-conformance.test.ts "refuses an id another tenant holds" for the store',
  },
  outcomeCommit: {
    fn: 'outcome',
    differs: 'hippo.db commits each row and then its audit row; the store commits every row and audit row together',
    onHippoDb: 'src/api/outcome.ts:74-88',
    throughStore: 'src/store/entry-writes-group.ts:93-108',
    winner: 'store: one transaction',
    pinnedBy: 'here',
  },
  outcomeRefusalAudit: {
    fn: 'outcome',
    differs: 'a row the rejection guard refuses leaves a reject_refusal audit row on hippo.db and none through the store',
    onHippoDb: 'src/store/entry-writes.ts:38-40',
    throughStore: 'src/store/entry-writes-group.ts:93-108',
    winner: 'hippo.db: kept behaviour, the collapsed outcome still writes the refusal row',
    pinnedBy: 'here',
  },
  outcomeTraceLink: {
    fn: 'outcome',
    differs: 'hippo.db links the outcome to opts.traceId after the rows commit; the store refuses a traceId',
    onHippoDb: 'src/api/outcome.ts:92-99',
    throughStore: 'src/api/outcome.ts:64',
    winner: 'hippo.db: kept behaviour, the link stays and stays after the commit',
    pinnedBy: 'tests/recall-trace-outcome-linkage.test.ts for the link; tests/entry-writes-store.test.ts for the refusal',
  },
  grants: {
    fn: 'authGrant, authUngrant',
    differs: 'no store path: with ctx.store set they still write hippo.db at ctx.hippoRoot, synchronously, and undo the change when its audit row fails',
    onHippoDb: 'src/store/key-writes.ts:48-67',
    throughStore: 'none',
    winner: 'hippo.db: their published replies are synchronous and only the local CLI calls them, so they stay off the port; the change and its audit row commit together',
    pinnedBy: 'here',
  },
  hippoDbOnlyOptions: {
    fn: 'remember, archiveRaw',
    differs: 'afterWrite, untrusted and afterArchive run on hippo.db and are refused through a store',
    onHippoDb: 'src/api/remember.ts:124-136, src/api/promote.ts:218-222',
    throughStore: 'src/api/remember.ts:112, src/api/promote.ts:200',
    winner: 'open: porting them needs a store hook that runs inside the write; refusing keeps connectors on hippo.db',
    pinnedBy: 'tests/entry-writes-store.test.ts',
  },
  lastRecall: {
    fn: 'outcomeForLastRecall',
    differs: 'no store path, so timing facts 2, 4 and 5 fail: a sqlite store runs the hippo.db code on ctx.hippoRoot, any other kind gets SqliteBlockedError',
    onHippoDb: 'src/api/outcome.ts:147-156',
    throughStore: 'src/api/outcome.ts:142-145',
    winner: 'open: a port read of the last recall is new published surface; without one the function stays hippo.db-only',
    pinnedBy: 'here, in CONTRACT',
  },
  configFolder: {
    fn: 'remember, supersede',
    differs: 'through a store the half-life still comes from config.json in ctx.hippoRoot, so timing fact 5 holds only as "an empty hippoRoot works"',
    onHippoDb: 'src/api/remember.ts:86, src/api/promote.ts:118',
    throughStore: 'src/api/remember.ts:86, src/api/promote.ts:105',
    winner: 'open: reading it from the store needs a port method; leaving it ties a store-served write to the server\'s working folder',
    pinnedBy: 'here',
  },
} satisfies Record<string, Difference>;

function named(key: keyof typeof KNOWN_DIFFERENCES): string {
  return `${KNOWN_DIFFERENCES[key].fn}: ${KNOWN_DIFFERENCES[key].differs}`;
}

const NOW = '2026-03-01T12:00:00.000Z';
const SEEDED_AT = '2026-02-01T00:00:00.000Z';
const ACME = 'acme';
const GLOBEX = 'globex';

const HOST: Actor = { subject: 'cli', role: 'admin', hostAdmin: true };
const RESOLVER_ADMIN: Actor = { subject: 'sso:dana', role: 'admin', viaAuthResolver: true };
const CAROL: Actor = { subject: 'sso:carol', role: 'member', viaAuthResolver: true, owner: 'carol' };
const MEMBER_KEY: Actor = { subject: 'api_key:hk_seedmember', role: 'member' };
const ALICE: Actor = { subject: 'api_key:hk_seedalice', role: 'member', owner: 'alice' };

const SECOND_CONTENT = 'the billing service freezes deploys on fridays';

const SEED_MEMORIES = [
  seeded('the deploy pipeline uses a blue green rollout', 'mem_seed_plain', SEEDED_AT, {}, { tenantId: ACME, tags: ['deploy'] }),
  seeded(SECOND_CONTENT, 'mem_seed_second', SEEDED_AT, {}, { tenantId: ACME }),
  seeded('raw chat line about the staging cluster move', 'mem_seed_raw', SEEDED_AT, {}, { tenantId: ACME, kind: 'raw' }),
  seeded('the deploy target was the old staging cluster', 'mem_seed_old', SEEDED_AT, { superseded_by: 'mem_seed_new' }, { tenantId: ACME }),
  seeded('the deploy target is the new staging cluster', 'mem_seed_new', SEEDED_AT, {}, { tenantId: ACME }),
  seeded('bob keeps his own rollout notes here', 'mem_seed_bobs', SEEDED_AT, {}, { tenantId: ACME, scope: 'personal:private:bob' }),
  seeded('raw chat line only bob may read', 'mem_seed_bobs_raw', SEEDED_AT, {}, { tenantId: ACME, kind: 'raw', scope: 'personal:private:bob' }),
  seeded('alice keeps her own rollout notes here', 'mem_seed_alices', SEEDED_AT, {}, { tenantId: ACME, scope: 'personal:private:alice' }),
  seeded('globex runs its deploys from another region', 'mem_seed_globex', SEEDED_AT, {}, { tenantId: GLOBEX }),
  seeded('raw chat line from the globex workspace', 'mem_seed_globex_raw', SEEDED_AT, {}, { tenantId: GLOBEX, kind: 'raw' }),
];

const SEED_KEYS = [
  { keyId: 'hk_seedadmin', tenantId: ACME, role: 'admin', ownerSubject: null, createdAt: '2026-02-01T00:00:01.000Z' },
  { keyId: 'hk_seedmember', tenantId: ACME, role: 'member', ownerSubject: null, createdAt: '2026-02-01T00:00:02.000Z' },
  { keyId: 'hk_seedalice', tenantId: ACME, role: 'member', ownerSubject: null, createdAt: '2026-02-01T00:00:03.000Z' },
  { keyId: 'hk_seedrevoked', tenantId: ACME, role: 'member', ownerSubject: null, createdAt: '2026-02-01T00:00:04.000Z' },
  { keyId: 'hk_seedglobex', tenantId: GLOBEX, role: 'admin', ownerSubject: null, createdAt: '2026-02-01T00:00:05.000Z' },
  { keyId: 'hk_seedcarol1', tenantId: ACME, role: 'member', ownerSubject: 'sso:carol', createdAt: '2026-02-01T00:00:06.000Z' },
  { keyId: 'hk_seedcarol2', tenantId: ACME, role: 'member', ownerSubject: 'sso:carol', createdAt: '2026-02-01T00:00:07.000Z' },
] as const;

let parent: string;
let template: string;
let copies = 0;
const openStores: HippoStore[] = [];

function seedTemplate(): string {
  const root = makeRoot('parity-template');
  for (const entry of SEED_MEMORIES) writeEntry(root, entry);
  const db = openHippoDb(root);
  try {
    for (const key of SEED_KEYS) insertApiKey(db, { ...key, keyHash: `unused-${key.keyId}`, label: key.keyId.slice(7), expiresAt: null });
    revokeApiKey(db, 'hk_seedrevoked', '2026-02-02T00:00:00.000Z');
    grantScope(db, 'hk_seedmember', 'slack:private:C1');
  } finally {
    closeHippoDb(db);
  }
  reject({ hippoRoot: root, tenantId: ACME, actor: HOST }, { value: 'the launch code is tangerine', reason: 'retired secret' });
  const traceId = writeRecallTraceAtRoot(root, {
    tenantId: ACME, pipeline: 'cli', query: 'deploy',
    results: [{ memoryId: 'mem_seed_plain', score: 1 }, { memoryId: 'mem_seed_second', score: 0.5 }],
  });
  const index = loadIndex(root);
  index.last_retrieval_ids = ['mem_seed_plain', 'mem_seed_second', 'mem_seed_globex'];
  index.last_trace_id = traceId === null ? null : String(traceId);
  saveIndex(root, index);
  return root;
}

/** A new folder beside the store copies. */
function siblingFolder(label: string): string {
  copies += 1;
  return join(parent, `${String(copies)}-${label}`);
}

/** A fresh copy of the seeded store; every copy sits in one folder, so both paths stamp the same origin project. */
function copyOfTemplate(label: string): string {
  const root = siblingFolder(label);
  cpSync(template, root, { recursive: true });
  return root;
}

function storeAt(root: string): HippoStore {
  const store = sqliteStore(root);
  openStores.push(store);
  return store;
}

type Row = Record<string, string | number | null>;

function rowsOf(root: string, sql: string): Row[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: every column these queries name is text, a number or null.
    return db.prepare(sql).all() as Row[];
  } finally {
    closeHippoDb(db);
  }
}

function execOn(root: string, sql: string): void {
  const db = openHippoDb(root);
  try {
    db.exec(sql);
  } finally {
    closeHippoDb(db);
  }
}

function breakAuditLog(root: string): void {
  execOn(root, `CREATE TRIGGER audit_broken BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit table unwritable'); END`);
}

interface StoreState {
  tables: Record<string, Row[]>;
  files: Record<string, string>;
}

// updated_at is SQLite's own clock and key_hash is salted, so neither can match across two stores.
const VOLATILE = new Set(['updated_at', 'key_hash']);

function stateOf(root: string): StoreState {
  const tables: Record<string, Row[]> = {};
  const names = rowsOf(root, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' ORDER BY name`);
  for (const { name } of names) {
    const rows = rowsOf(root, `SELECT * FROM "${String(name)}"`);
    tables[String(name)] = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !VOLATILE.has(column))));
  }
  const files: Record<string, string> = {};
  for (const item of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!item.isFile() || item.name.startsWith('hippo.db')) continue;
    const file = join(item.parentPath, item.name);
    files[relative(root, file).replaceAll('\\', '/')] = readFileSync(file, 'utf-8');
  }
  return { tables, files };
}

/** JSON text with the store's path, minted ids and secrets replaced, ids numbered in order of first appearance. */
function normalised(root: string, value: Side): string {
  const text = JSON.stringify(value, null, 1);
  const seen = new Map<string, string>();
  return text
    .replaceAll(JSON.stringify(root).slice(1, -1), '<root>')
    .replaceAll(root.replaceAll('\\', '/'), '<root>')
    .replaceAll(basename(parent), '<parent>')
    .replace(/\b(hk_[a-z2-7]{24})\.[a-z2-7]{32}\b/g, '$1.<secret>')
    .replace(/\b(?:mem_[0-9a-f]{12}|hk_[a-z2-7]{24})\b/g, (id) => {
      const known = seen.get(id);
      if (known) return known;
      const label = `<${id.slice(0, id.indexOf('_'))}#${String(seen.size + 1)}>`;
      seen.set(id, label);
      return label;
    });
}

type Reply = object | Promise<object>;
type Call = (ctx: Context) => Reply;

function errorText(error: Error): string {
  return `${error.constructor.name}: ${error.message}`;
}

interface Settled {
  returned?: object;
  threw?: string;
}

async function settled(call: () => Reply): Promise<Settled> {
  try {
    return { returned: await call() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { threw: errorText(error) };
  }
}

/** How a call ended: `returned` for a plain value, `resolved` or `rejected <error>` for a Promise, `threw <error>` for a synchronous throw. */
async function ending(call: () => Reply): Promise<string> {
  let reply: Reply;
  try {
    reply = call();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return `threw ${errorText(error)}`;
  }
  if (!(reply instanceof Promise)) return 'returned';
  try {
    await reply;
    return 'resolved';
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return `rejected ${errorText(error)}`;
  }
}

interface Side {
  reply: Settled;
  state: StoreState;
}

/** One side's reply and what its store then holds, normalised as one text so an id reads the same in both. */
async function sideOf(root: string, call: () => Reply): Promise<Side> {
  const reply = await settled(call);
  // SAFETY: the text is the JSON of the Side built on this line.
  return JSON.parse(normalised(root, { reply, state: stateOf(root) })) as Side;
}

interface Case {
  readonly actor?: Actor;
  readonly tenantId?: string;
  readonly call: Call;
  /** The error class both paths answer with; without it both return. */
  readonly refused?: string;
  /** Run with an audit log that refuses every insert. */
  readonly auditBroken?: true;
}

async function bothPaths(c: Case): Promise<{ onHippoDb: Side; throughStore: Side }> {
  const dbRoot = copyOfTemplate('db');
  const storeRoot = copyOfTemplate('store');
  if (c.auditBroken) for (const root of [dbRoot, storeRoot]) breakAuditLog(root);
  const base = { tenantId: c.tenantId ?? ACME, actor: c.actor ?? HOST };
  const onHippoDb = await sideOf(dbRoot, () => c.call({ ...base, hippoRoot: dbRoot }));
  const throughStore = await sideOf(storeRoot, () => c.call({ ...base, hippoRoot: storeRoot, store: storeAt(storeRoot) }));
  return { onHippoDb, throughStore };
}

const PARITY = {
  'authCreate: host admin mints an admin key': { call: (ctx) => authCreate(ctx, {}) },
  'authCreate: host admin mints a labelled member key': { call: (ctx) => authCreate(ctx, { role: 'member', label: 'ci' }) },
  'authCreate: resolver admin mints a member key': { actor: RESOLVER_ADMIN, call: (ctx) => authCreate(ctx, { label: 'dana' }) },
  'authCreate: member is refused': { actor: MEMBER_KEY, call: (ctx) => authCreate(ctx, {}), refused: 'ForbiddenError' },
  'authCreate: resolver admin asking for admin is refused': { actor: RESOLVER_ADMIN, call: (ctx) => authCreate(ctx, { role: 'admin' }), refused: 'ForbiddenError' },
  'authCreate: an unwritable audit log refuses the mint and leaves no key': { auditBroken: true, call: (ctx) => authCreate(ctx, {}), refused: 'Error' },
  'authCreateSelf: resolver member mints under the cap': { actor: CAROL, call: (ctx) => authCreateSelf(ctx, { ttlDays: 1, perSubject: 5, label: 'laptop' }) },
  'authCreateSelf: minting at the cap revokes the oldest': { actor: CAROL, call: (ctx) => authCreateSelf(ctx, { ttlDays: 7, perSubject: 2 }) },
  'authCreateSelf: a caller without a resolver is refused': { actor: MEMBER_KEY, call: (ctx) => authCreateSelf(ctx, { ttlDays: 1, perSubject: 5 }), refused: 'ForbiddenError' },
  'authCreateSelf: ttlDays 0 is refused': { actor: CAROL, call: (ctx) => authCreateSelf(ctx, { ttlDays: 0, perSubject: 5 }), refused: 'RangeError' },
  'authCreateSelf: perSubject 0 is refused': { actor: CAROL, call: (ctx) => authCreateSelf(ctx, { ttlDays: 1, perSubject: 0 }), refused: 'RangeError' },
  'authList: admin sees the tenant': { call: (ctx) => authList(ctx, { active: false }) },
  'authList: active only': { call: (ctx) => authList(ctx, { active: true }) },
  'authList: member key sees itself': { actor: MEMBER_KEY, call: (ctx) => authList(ctx, { active: false }) },
  'authList: resolver member sees the keys it minted': { actor: CAROL, call: (ctx) => authList(ctx, { active: true }) },
  'authList: another tenant': { tenantId: GLOBEX, call: (ctx) => authList(ctx, { active: false }) },
  'authListRows: first page': { call: (ctx) => authListRows(ctx, { active: false, limit: 2 }) },
  'authListRows: member key sees itself': { actor: MEMBER_KEY, call: (ctx) => authListRows(ctx, { active: true }) },
  'authRevoke: admin revokes a live key': { call: (ctx) => authRevoke(ctx, 'hk_seedmember') },
  'authRevoke: a revoked key keeps its first time': { call: (ctx) => authRevoke(ctx, 'hk_seedrevoked') },
  'authRevoke: unknown key': { call: (ctx) => authRevoke(ctx, 'hk_missing'), refused: 'NotFoundError' },
  'authRevoke: another tenant\'s key': { call: (ctx) => authRevoke(ctx, 'hk_seedglobex'), refused: 'NotFoundError' },
  'authRevoke: member key revokes itself': { actor: MEMBER_KEY, call: (ctx) => authRevoke(ctx, 'hk_seedmember') },
  'authRevoke: member key revoking another is refused': { actor: MEMBER_KEY, call: (ctx) => authRevoke(ctx, 'hk_seedalice'), refused: 'ForbiddenError' },
  'authRevoke: resolver member revokes a key it minted': { actor: CAROL, call: (ctx) => authRevoke(ctx, 'hk_seedcarol1') },
  'authRevoke: resolver member revoking a key it did not mint is refused': { actor: CAROL, call: (ctx) => authRevoke(ctx, 'hk_seedmember'), refused: 'ForbiddenError' },
  'authRevoke: resolver admin revoking an admin key is refused': { actor: RESOLVER_ADMIN, call: (ctx) => authRevoke(ctx, 'hk_seedadmin'), refused: 'ForbiddenError' },
  'authRevoke: an unwritable audit log refuses the revoke and leaves the key live': { auditBroken: true, call: (ctx) => authRevoke(ctx, 'hk_seedmember'), refused: 'Error' },
  'forget: a row of the tenant': { call: (ctx) => forget(ctx, 'mem_seed_plain') },
  'forget: unknown id': { call: (ctx) => forget(ctx, 'mem_missing'), refused: 'NotFoundError' },
  'forget: another tenant\'s row': { call: (ctx) => forget(ctx, 'mem_seed_globex'), refused: 'NotFoundError' },
  'forget: another person\'s personal row': { actor: ALICE, call: (ctx) => forget(ctx, 'mem_seed_bobs'), refused: 'NotFoundError' },
  'forget: the caller\'s own personal row': { actor: ALICE, call: (ctx) => forget(ctx, 'mem_seed_alices') },
  'forget: a raw row is append-only': { call: (ctx) => forget(ctx, 'mem_seed_raw'), refused: 'Error' },
  'outcome: good on two rows': { call: (ctx) => outcome(ctx, ['mem_seed_plain', 'mem_seed_second'], true) },
  'outcome: bad on one row': { call: (ctx) => outcome(ctx, ['mem_seed_plain'], false) },
  'outcome: a repeated id': { call: (ctx) => outcome(ctx, ['mem_seed_plain', 'mem_seed_plain'], true) },
  'outcome: unknown, foreign and out-of-reach ids are skipped': { actor: ALICE, call: (ctx) => outcome(ctx, ['mem_missing', 'mem_seed_globex', 'mem_seed_bobs', 'mem_seed_alices'], true) },
  'outcome: no ids': { call: (ctx) => outcome(ctx, [], true) },
  'outcomeForLastRecall: good': { call: (ctx) => outcomeForLastRecall(ctx, true) },
  'outcomeForLastRecall: bad': { call: (ctx) => outcomeForLastRecall(ctx, false) },
  'outcomeForLastRecall: a tenant with no recalled rows': { tenantId: 'initech', call: (ctx) => outcomeForLastRecall(ctx, true) },
  'supersede: a row of the tenant': { call: (ctx) => supersede(ctx, 'mem_seed_plain', 'the deploy pipeline now uses a canary rollout') },
  'supersede: unknown id': { call: (ctx) => supersede(ctx, 'mem_missing', 'replacement text for a missing row'), refused: 'NotFoundError' },
  'supersede: another tenant\'s row': { call: (ctx) => supersede(ctx, 'mem_seed_globex', 'replacement text for a foreign row'), refused: 'NotFoundError' },
  'supersede: another person\'s personal row': { actor: ALICE, call: (ctx) => supersede(ctx, 'mem_seed_bobs', 'replacement text for a private row'), refused: 'NotFoundError' },
  'supersede: the caller\'s own personal row': { actor: ALICE, call: (ctx) => supersede(ctx, 'mem_seed_alices', 'alice rewrote her rollout notes') },
  'supersede: an already superseded row': { call: (ctx) => supersede(ctx, 'mem_seed_old', 'replacement text for a stale row'), refused: 'ConflictError' },
  'supersede: content too short': { call: (ctx) => supersede(ctx, 'mem_seed_plain', 'x'), refused: 'BadRequestError' },
  'supersede: rejected content': { call: (ctx) => supersede(ctx, 'mem_seed_plain', 'The launch code is  TANGERINE'), refused: 'RejectedValueError' },
  'archiveRaw: a raw row': { call: (ctx) => archiveRaw(ctx, 'mem_seed_raw', 'user asked') },
  'archiveRaw: a row that is not raw': { call: (ctx) => archiveRaw(ctx, 'mem_seed_plain', 'user asked'), refused: 'BadRequestError' },
  'archiveRaw: unknown id': { call: (ctx) => archiveRaw(ctx, 'mem_missing', 'user asked'), refused: 'NotFoundError' },
  'archiveRaw: another tenant\'s raw row': { call: (ctx) => archiveRaw(ctx, 'mem_seed_globex_raw', 'user asked'), refused: 'NotFoundError' },
  'archiveRaw: another person\'s personal raw row': { actor: ALICE, call: (ctx) => archiveRaw(ctx, 'mem_seed_bobs_raw', 'user asked'), refused: 'NotFoundError' },
  'remember: plain content': { call: (ctx) => remember(ctx, { content: 'the api gateway retries three times' }) },
  'remember: every field': { call: (ctx) => remember(ctx, { content: 'the oncall rota changes on mondays', kind: 'raw', scope: 'team-alpha', owner: 'user:dana', artifactRef: 'doc:rota', tags: ['oncall', 'rota'] }) },
  'remember: a named project': { call: (ctx) => remember(ctx, { content: 'this project ships from the release branch', project: { name: 'atlas', aliases: ['atlas-old'] } }) },
  'remember: personal': { actor: ALICE, call: (ctx) => remember(ctx, { content: 'alice prefers the staging cluster for tests', personal: true }) },
  'remember: personal without an owner is refused': { actor: MEMBER_KEY, call: (ctx) => remember(ctx, { content: 'nobody owns this personal note', personal: true }), refused: 'BadRequestError' },
  'remember: personal with a scope is refused': { actor: ALICE, call: (ctx) => remember(ctx, { content: 'a personal note with a scope too', personal: true, scope: 'team-alpha' }), refused: 'BadRequestError' },
  'remember: a client personal scope is refused': { call: (ctx) => remember(ctx, { content: 'a note sent with a personal scope', scope: 'personal:private:bob' }), refused: 'BadRequestError' },
  'remember: content too short': { call: (ctx) => remember(ctx, { content: 'x' }), refused: 'BadRequestError' },
  'remember: rejected content': { call: (ctx) => remember(ctx, { content: 'the launch code is tangerine' }), refused: 'RejectedValueError' },
  'remember: content holding a secret': { call: (ctx) => remember(ctx, { content: 'the deploy token is AKIAIOSFODNN7EXAMPLE for now' }) },
  'remember: a bad project name is refused': { call: (ctx) => remember(ctx, { content: 'a note with a bad project name', project: { name: '' } }), refused: 'BadRequestError' },
} satisfies Record<string, Case>;

const CASES: readonly (readonly [string, Case])[] = Object.entries(PARITY);

type PortMethod = (...args: never[]) => object;
type PortGroup = Readonly<Record<string, PortMethod>>;
type PortMember = string | PortMethod | PortGroup | undefined;

function isMethod(member: PortMember): member is PortMethod {
  return typeof member === 'function';
}

function isGroup(member: PortMember): member is PortGroup {
  return typeof member === 'object';
}

/** `target` with every method adding `<prefix><name>` to `calls` as it is called, and every group wrapped the same way: call order with no clock. */
function noting<T extends object>(target: T, prefix: string, calls: string[]): T {
  const members = Object.entries(target).map(([name, member]: [string, PortMember]): [string, PortMember] => {
    if (!isMethod(member)) return [name, isGroup(member) ? noting(member, `${name}.`, calls) : member];
    return [name, (...args: never[]) => {
      calls.push(`${prefix}${name}`);
      return member(...args);
    }];
  });
  // SAFETY: every key of T is kept, holding the same value or a method of the same signature.
  return Object.fromEntries(members) as T;
}

interface Watched {
  store: HippoStore;
  calls: string[];
}

function watched(inner: HippoStore): Watched {
  openStores.push(inner);
  const calls: string[] = [];
  return { store: noting(inner, '', calls), calls };
}

interface Spec {
  readonly actor?: Actor;
  readonly ok: Call;
  /** A call the function refuses through a working store, and the error class it rejects with. */
  readonly refused?: readonly [Call, string];
  /** Port calls made by the time the function returns. */
  readonly firstPortCalls: readonly string[];
  /** The group the function needs; null when it never asks for one. */
  readonly group: StoreGroup | null;
  /** How the call ends with `hippoRoot: ''` and a working store, when not `resolved`. */
  readonly withoutRoot?: string;
}

const CONTRACT = {
  authCreate: {
    ok: (ctx) => authCreate(ctx, {}),
    refused: [(ctx) => authCreate({ ...ctx, actor: MEMBER_KEY }, {}), 'ForbiddenError'],
    firstPortCalls: ['keyWrites.createApiKey'], group: 'keyWrites',
  },
  authCreateSelf: {
    actor: CAROL,
    ok: (ctx) => authCreateSelf(ctx, { ttlDays: 1, perSubject: 5 }),
    refused: [(ctx) => authCreateSelf(ctx, { ttlDays: 0, perSubject: 5 }), 'RangeError'],
    firstPortCalls: ['keyWrites.createSelfApiKey'], group: 'keyWrites',
  },
  authList: { ok: (ctx) => authList(ctx, { active: true }), firstPortCalls: ['keyWrites.listApiKeys'], group: 'keyWrites' },
  authListRows: { ok: (ctx) => authListRows(ctx, { active: true }), firstPortCalls: ['keyWrites.listApiKeys'], group: 'keyWrites' },
  authRevoke: {
    ok: (ctx) => authRevoke(ctx, 'hk_seedmember'),
    refused: [(ctx) => authRevoke({ ...ctx, actor: MEMBER_KEY }, 'hk_seedalice'), 'ForbiddenError'],
    firstPortCalls: ['findApiKey'], group: 'keyAudit',
  },
  forget: {
    ok: (ctx) => forget(ctx, 'mem_seed_plain'),
    refused: [(ctx) => forget(ctx, 'mem_missing'), 'NotFoundError'],
    firstPortCalls: ['entryWrites.forget'], group: 'entryWrites',
  },
  outcome: {
    ok: (ctx) => outcome(ctx, ['mem_seed_plain'], true),
    refused: [(ctx) => outcome(ctx, ['mem_seed_plain'], true, { traceId: 1 }), 'Error'],
    firstPortCalls: ['entryWrites.applyOutcome'], group: 'entryWrites',
  },
  outcomeForLastRecall: { ok: (ctx) => outcomeForLastRecall(ctx, true), firstPortCalls: [], group: null, withoutRoot: 'rejected Error: ENOENT' },
  supersede: {
    ok: (ctx) => supersede(ctx, 'mem_seed_plain', 'the deploy pipeline now uses a canary rollout'),
    refused: [(ctx) => supersede(ctx, 'mem_seed_plain', 'x'), 'BadRequestError'],
    firstPortCalls: ['entriesByIds'], group: 'entryWrites',
  },
  archiveRaw: {
    ok: (ctx) => archiveRaw(ctx, 'mem_seed_raw', 'user asked'),
    refused: [(ctx) => archiveRaw(ctx, 'mem_seed_raw', 'user asked', { afterArchive: () => undefined }), 'Error'],
    firstPortCalls: ['entryWrites.archiveRaw'], group: 'entryWrites',
  },
  remember: {
    ok: (ctx) => remember(ctx, { content: 'the api gateway retries three times' }),
    refused: [(ctx) => remember(ctx, { content: 'x' }), 'BadRequestError'],
    firstPortCalls: ['entryWrites.writeEntry'], group: 'entryWrites',
  },
} satisfies Record<string, Spec>;

const SPECS: readonly (readonly [string, Spec])[] = Object.entries(CONTRACT);
const REFUSALS = SPECS.flatMap(([fn, spec]) => (spec.refused ? [[fn, spec, spec.refused] as const] : []));

function ctxOf(spec: Spec, hippoRoot: string, store?: HippoStore): Context {
  const base = { hippoRoot, tenantId: ACME, actor: spec.actor ?? HOST };
  return store ? { ...base, store } : base;
}

const REACH_CHECK = 'SELECT tenant_id, scope FROM memories WHERE id = ?';
const WRITE_LOCK = 'BEGIN IMMEDIATE';

/** Which of the reach check and the write lock ran first, and whether the store was opened again between them. */
function reachAndLock(statements: string[]): string {
  const reach = statements.indexOf(REACH_CHECK);
  const lock = statements.indexOf(WRITE_LOCK);
  if (reach < 0 || lock < 0) throw new Error(`no reach check or no write lock in: ${statements.join(' | ')}`);
  const order = reach < lock ? 'reach check, then write lock' : 'write lock, then reach check';
  const reopened = statements.slice(Math.min(reach, lock), Math.max(reach, lock)).some((sql) => STORE_OPEN.test(sql));
  return reopened ? `${order} on a second handle` : order;
}

interface Interrupted {
  end: string;
  firstRow: Row[];
  audit: Row[];
}

/** outcome on two rows while a trigger, standing in for a second writer, rejects and removes the second row once the first row's outcome is logged. */
async function outcomeRejectedMidway(withStore: boolean): Promise<Interrupted> {
  const root = copyOfTemplate(withStore ? 'store' : 'db');
  execOn(root, `CREATE TRIGGER rejected_midway AFTER INSERT ON audit_log WHEN NEW.op = 'outcome' BEGIN
    INSERT INTO rejected_values (tenant_id, digest, reason, rejected_by, rejected_at) VALUES ('${ACME}', '${rejectionDigest(SECOND_CONTENT)}', 'withdrawn', 'cli', '${NOW}');
    DELETE FROM memories WHERE id = 'mem_seed_second';
  END`);
  const base = { hippoRoot: root, tenantId: ACME, actor: HOST };
  const end = await ending(() => outcome(withStore ? { ...base, store: storeAt(root) } : base, ['mem_seed_plain', 'mem_seed_second'], true));
  return {
    end,
    firstRow: rowsOf(root, `SELECT outcome_positive FROM memories WHERE id = 'mem_seed_plain'`),
    audit: rowsOf(root, `SELECT op, target_id FROM audit_log WHERE op IN ('outcome', 'reject_refusal') ORDER BY id`),
  };
}

beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), 'hippo-parity-'));
  template = seedTemplate();
});

afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
  rmSync(template, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const store of openStores.splice(0)) await store.close();
});

describe('the store path and the hippo.db path agree', () => {
  it.each(CASES)('%s', async (_name, c) => {
    const { onHippoDb, throughStore } = await bothPaths(c);
    expect(onHippoDb.reply.threw?.split(':')[0]).toBe(c.refused);
    expect(throughStore.reply).toEqual(onHippoDb.reply);
    expect(throughStore.state).toEqual(onHippoDb.state);
  });
});

describe('where the two paths differ today', () => {
  it.each([
    [named('forgetLock'), (ctx: Context) => forget(ctx, 'mem_seed_plain'), 'reach check, then write lock on a second handle'],
    [named('archiveLock'), (ctx: Context) => archiveRaw(ctx, 'mem_seed_raw', 'user asked'), 'reach check, then write lock'],
  ])('%s', async (_name, call, onHippoDb) => {
    const dbRoot = copyOfTemplate('db');
    const storeRoot = copyOfTemplate('store');
    const base = { tenantId: ACME, actor: HOST };
    expect(reachAndLock(recordStatements(() => call({ ...base, hippoRoot: dbRoot })).statements)).toBe(onHippoDb);
    const store = storeAt(storeRoot);
    const throughStore = await recordStatementsAsync(async () => call({ ...base, hippoRoot: storeRoot, store }));
    expect(reachAndLock(throughStore.statements)).toBe('write lock, then reach check');
  });

  it(named('idCollision'), () => {
    const spy = vi.spyOn(crypto, 'randomUUID').mockReturnValue('5eed0000-0000-4000-8000-000000000000');
    syncBuiltinESMExports();
    try {
      const root = copyOfTemplate('db');
      const first = remember({ hippoRoot: root, tenantId: GLOBEX, actor: HOST }, { content: 'globex wrote this row first' });
      remember({ hippoRoot: root, tenantId: ACME, actor: HOST }, { content: 'acme wrote over the same id' });
      expect(rowsOf(root, `SELECT tenant_id, content FROM memories WHERE id = '${first.id}'`)).toEqual([{ tenant_id: ACME, content: 'acme wrote over the same id' }]);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it(named('outcomeCommit'), async () => {
    const onHippoDb = await outcomeRejectedMidway(false);
    const throughStore = await outcomeRejectedMidway(true);
    expect(onHippoDb.end).toContain('threw RejectedValueError:');
    expect(onHippoDb.firstRow).toEqual([{ outcome_positive: 1 }]);
    expect(throughStore.end).toContain('rejected RejectedValueError:');
    expect(throughStore.firstRow).toEqual([{ outcome_positive: 0 }]);
  });

  it(named('outcomeRefusalAudit'), async () => {
    expect((await outcomeRejectedMidway(false)).audit).toEqual([{ op: 'outcome', target_id: 'mem_seed_plain' }, { op: 'reject_refusal', target_id: 'mem_seed_second' }]);
    expect((await outcomeRejectedMidway(true)).audit).toEqual([]);
  });

  it(named('grants'), () => {
    const root = copyOfTemplate('store');
    const { store, calls } = watched(sqliteStore(root));
    const ctx = { hippoRoot: root, tenantId: ACME, actor: HOST, store };
    const grants = (): Row[] => rowsOf(root, `SELECT key_id, scope FROM api_key_scope_grants ORDER BY key_id, scope`);
    const seededGrant = { key_id: 'hk_seedmember', scope: 'slack:private:C1' };
    expect(authGrant(ctx, 'hk_seedalice', 'slack:private:C2')).toEqual({ ok: true });
    expect(grants()).toEqual([{ key_id: 'hk_seedalice', scope: 'slack:private:C2' }, seededGrant]);
    expect(authUngrant(ctx, 'hk_seedalice', 'slack:private:C2')).toEqual({ ok: true });
    breakAuditLog(root);
    expect(() => authGrant(ctx, 'hk_seedalice', 'slack:private:C2')).toThrow(/audit table unwritable/);
    expect(() => authUngrant(ctx, 'hk_seedmember', 'slack:private:C1')).toThrow(/audit table unwritable/);
    expect(grants()).toEqual([seededGrant]);
    expect(calls).toEqual([]);
  });

  it(named('configFolder'), async () => {
    const folder = siblingFolder('config-only');
    mkdirSync(folder);
    writeFileSync(join(folder, 'config.json'), JSON.stringify({ defaultHalfLifeDays: 99 }));
    const root = copyOfTemplate('store');
    const ctx = { hippoRoot: folder, tenantId: ACME, actor: HOST, store: storeAt(root) };
    const written = await remember(ctx, { content: 'a note written from another folder' });
    const replaced = await supersede(ctx, 'mem_seed_second', 'the billing service freezes deploys on mondays');
    expect(rowsOf(root, `SELECT half_life_days FROM memories WHERE id IN ('${written.id}', '${replaced.newId}')`)).toEqual([{ half_life_days: 99 }, { half_life_days: 99 }]);
    expect(readdirSync(folder)).toEqual(['config.json']);
  });
});

describe('the five timing facts an add-on relies on', () => {
  it.each(SPECS)('%s with no store returns its result, not a Promise', async (_fn, spec) => {
    expect(await ending(() => spec.ok(ctxOf(spec, copyOfTemplate('db'))))).toBe('returned');
  });

  it.each(SPECS)('%s has made its first port call by the time it returns', async (_fn, spec) => {
    const { store, calls } = watched(sqliteStore(copyOfTemplate('store')));
    const reply = spec.ok(ctxOf(spec, siblingFolder('unused'), store));
    const atReturn = [...calls];
    await settled(() => reply);
    expect(atReturn).toEqual(spec.firstPortCalls);
  });

  it.each(REFUSALS)('%s refuses through a store with a rejected Promise, never a synchronous throw', async (_fn, spec, [call, error]) => {
    const root = copyOfTemplate('store');
    expect(await ending(() => call(ctxOf(spec, root, storeAt(root))))).toContain(`rejected ${error}:`);
  });

  it.each(SPECS)('%s checks for its store group before it looks at the input', async (_fn, spec) => {
    const root = copyOfTemplate('store');
    const { store, calls } = watched(portOnlyStoreWithoutVectorReads(root));
    const end = await ending(() => (spec.refused?.[0] ?? spec.ok)(ctxOf(spec, root, store)));
    expect(end).toContain(spec.group ? `rejected StoreNotPortedError: the 'port-only' store has no '${spec.group}' group` : 'rejected SqliteBlockedError:');
    expect(calls).toEqual([]);
  });

  it.each(SPECS)('%s through a store works with an empty hippoRoot', async (_fn, spec) => {
    const end = await ending(() => spec.ok(ctxOf(spec, '', storeAt(copyOfTemplate('store')))));
    expect(end).toContain(spec.withoutRoot ?? 'resolved');
  });
});

describe('importVault', () => {
  it('stays synchronous and counts a note the rejection guard refuses, instead of throwing', () => {
    const root = copyOfTemplate('db');
    const vault = siblingFolder('vault');
    mkdirSync(vault);
    writeFileSync(join(vault, 'kept.md'), 'deploys go out on tuesdays after the standup');
    writeFileSync(join(vault, 'refused.md'), 'the launch code is tangerine');
    const result: ImportResult = importVault(vault, { hippoRoot: root, tenantId: ACME, name: 'notes' });
    expect(result).toMatchObject({ total: 2, imported: 1, rejected: 1 });
  });
});
