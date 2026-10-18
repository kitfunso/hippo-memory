// Compactions answers alike on hippo.db and on a store held in memory: a caller's record, its snapshot mark, and items
// that restate held rows, meet a tombstone or fail the gate, over two tenants.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { CallerItems, CallerItemsSaved, MemoryEntry } from '../../src/entry/store-kit.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { insertRejectedValue } from '../../src/store/sqlite/rejection.js';
import { normalizeValueForRejection, rejectionDigest } from '../../src/core/rejection-digest.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { inMemoryCompactionsStore } from '../_helpers/in-memory-compactions-store.js';
import {
  onBothStores,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type TwoTenantFixture,
} from '../_helpers/store-conformance.js';
import { writeEntry } from '../_helpers/root-forms.js';

const SEEDED = '2026-03-01T11:58:00.000Z';
const NOW = '2026-03-01T12:00:00.000Z';
const HELD = 'The release script must run from the repo root because it reads the env file by a relative path.';
const PRIVATE = 'Integration tests need the local Postgres container started before the suite or every case times out.';
const FRESH = 'Run the schema migration on staging before production, never the other way round.';
const REJECTED = 'The staging database password rotates every Monday at nine in the morning.';
const FROZEN = 'Deploys freeze on Fridays after noon so the on-call team can watch the weekend traffic.';

type Value = string | void | CallerItemsSaved | Array<Pick<MemoryEntry, 'retrievalCount' | 'lastRetrieved'>>;

let fixture: TwoTenantFixture;
let heldId = '';

const request = (over: Partial<CallerItems> = {}): CallerItems => ({
  sessionId: 'sA',
  trigger: 'auto',
  requestId: 'req-1',
  project: 'acme/app',
  owner: 'alice',
  origins: ['acme/app'],
  baseHalfLifeDays: 30,
  items: [],
  ...over,
});

function seed(dir: string): void {
  const row = (content: string, over: Parameters<typeof createMemory>[1], origin: string): string => {
    const entry = {
      ...createMemory(content, { tenantId: TENANT_A, sourceSessionId: 'sOld', ...over }),
      originProject: origin,
    };
    writeEntry(dir, entry, { actor: 'cli' });
    return entry.id;
  };
  heldId = row(HELD, {}, 'acme/app');
  row(PRIVATE, { scope: 'team:Private:ops' }, 'acme/app');
  row(FRESH, {}, 'acme/web');
  const db = openHippoDb(dir);
  try {
    const at = new Date().toISOString();
    insertRejectedValue(db, {
      tenantId: TENANT_A,
      digest: rejectionDigest(REJECTED),
      reason: 'wrong',
      rejectedBy: 'cli',
      rejectedAt: at,
      normalizedChars: normalizeValueForRejection(REJECTED).length,
    });
  } finally {
    closeHippoDb(db);
  }
  const { compactions } = sqliteSyncStore(dir);
  compactions.start(TENANT_A, {
    sessionId: 'sA',
    originProject: 'acme/app',
    trigger: 'auto',
    cwd: null,
    transcriptPath: null,
  });
  compactions.saveCallerItems(TENANT_A, request({ sessionId: 'sD', requestId: 'req-done', items: [FROZEN] }));
  compactions.saveCallerItems(TENANT_B, request({ sessionId: 'sB', requestId: 'req-b', items: [HELD] }));
}

/** Each side's ids, renamed in the order they first appear, since both stores mint their own. */
function sameIds<T>(side: T): T {
  const seen = new Map<string, string>();
  const text = JSON.stringify(side).replace(/\b(mem|cmp)_[0-9a-f]{6,}\b/g, (id) => {
    if (!seen.has(id)) seen.set(id, `${id.slice(0, 3)}#${seen.size}`);
    return seen.get(id) ?? id;
  });
  return JSON.parse(text);
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(SEEDED));
  fixture = seedTwoTenants();
  seed(fixture.dir);
  vi.useRealTimers();
});

afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => vi.useRealTimers());

describe('Compactions', () => {
  it('starts and marks a record, saves items once per request, and refuses another session the request id', async () => {
    let started = '';
    const items = [
      'The release script must run from the repo root because it reads the env file by a relative path',
      FRESH,
      `${FRESH}!`,
      PRIVATE,
      REJECTED,
      'ok',
      'the token is [REDACTED] for now',
      'x'.repeat(501),
    ];
    const sides = await onBothStores<'compactions', Value>(fixture, 'compactions', inMemoryCompactionsStore, [
      async (g) => {
        started = await g.start(TENANT_A, {
          sessionId: 'sP',
          originProject: 'acme/app',
          trigger: null,
          cwd: null,
          transcriptPath: null,
        });
        return started;
      },
      (g) => g.markSnapshotSaved(TENANT_A, started),
      (g) => g.markSnapshotSaved(TENANT_B, started),
      (g) => g.saveCallerItems(TENANT_A, request({ items })),
      (g) => g.saveCallerItems(TENANT_A, request({ items: [FRESH] })),
      (g) => g.saveCallerItems(TENANT_A, request({ sessionId: 'sX' })),
      (g) => g.saveCallerItems(TENANT_A, request({ sessionId: 'sD', requestId: 'req-done' })),
      (g) => g.saveCallerItems(TENANT_A, request({ sessionId: 'sB2', requestId: 'req-b', items: [HELD] })),
      async (_g, store) =>
        (await store.entriesByIds([heldId], TENANT_A)).map(({ retrievalCount, lastRetrieved }) => ({
          retrievalCount,
          lastRetrieved,
        })),
    ]);
    expect(sameIds(sides.other)).toEqual(sameIds(sides.sqlite));
    const outcomes = sides.sqlite.outcomes;
    expect(outcomes[3]).toEqual({
      value: {
        written: 2,
        notes: [
          'skipped 1 item(s) as secret',
          'item too long: 1 kept in the record only',
          'skipped 2 item(s) the store already holds',
          'skipped 2 item(s) the write gate refused',
        ],
      },
    });
    expect(outcomes[4]).toEqual({ value: { written: 2, notes: [] } });
    expect(outcomes[5]).toEqual({ error: 'ConflictError: request id belongs to another session' });
    expect(outcomes[6]).toEqual({ value: { written: 1, notes: [] } });
    expect(outcomes[7]).toEqual({ value: { written: 0, notes: ['skipped 1 item(s) the store already holds'] } });
    // Restated twice, by sA and by sB2, each a session other than the row's own.
    expect(outcomes[8]).toEqual({ value: [{ retrievalCount: 2, lastRetrieved: NOW }] });
    expect(sides.sqlite.audit.slice(-3).map((r) => r.op)).toEqual(['remember', 'remember', 'reject_refusal']);
  });
});
