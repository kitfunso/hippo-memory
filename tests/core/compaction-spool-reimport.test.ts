import * as fs from 'node:fs';
import nodeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replayCompactions } from '../../src/surface/capture/compaction-record.js';
import type { SpooledSummary } from '../../src/base/ports/store/capture.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { MAX_ID_LEN } from '../../src/base/util/limits.js';
import {
  compactionMemories,
  compactionRows,
  removeScratch,
  scratch,
  type CompactionRow,
  type Scratch,
} from '../_helpers/compaction-hooks.js';
import { compactionFolder, hookStore } from '../_helpers/cli-stores.js';
import { initTestStore } from '../_helpers/store-template.js';

const MINUTE = 60_000;
const ITEMS = [
  'The billing service uses pnpm, so npm install is never run there.',
  'The search service cache must be flushed after every deploy.',
];
// A real stem is `<13 digit ms>-<8 hex>`; each test gets its own.
const BUSY_STEM = '1760000000000-0a1b2c3d';
const DIED_BEFORE_ITEMS_STEM = '1760000000001-1b2c3d4e';
const DIED_AFTER_ITEMS_STEM = '1760000000002-2c3d4e5f';
const AFTER_UNKEYED_STEM = '1760000000003-3d4e5f60';
const STARTED_STEM = '1760000000004-4e5f6071';
const FIRST_STEM = '1760000000005-5f607182';
const SECOND_STEM = '1760000000006-60718293';
const TENANT_STEM = '1760000000007-718293a4';
const CALLER_STEM = '1760000000008-8293a4b5';
const SAME_ROW_STEM = '1760000000009-93a4b5c6';

let s: Scratch;
let logs: string[];

beforeEach(() => {
  s = scratch();
  logs = [];
  initTestStore(s.hippoRoot);
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  removeScratch(s);
});

const log = (message: string): void => {
  logs.push(message);
};
const spoolDir = (): string => path.join(s.hippoRoot, 'compactions-spool');
// The lock file stays between replays and is reused, so a listing of spooled records leaves it out.
const spoolFiles = (): string[] => fs.readdirSync(spoolDir()).filter((n) => n !== 'replay.lock.db');
const claimStamp = (ms: number): string => String(Math.trunc(ms)).padStart(13, '0');

type Row = CompactionRow & { tenant_id: string; request_id: string | null };
// SAFETY: compactionRows runs SELECT *, so tenant_id and request_id are there though its row type omits them.
const rowsOf = (root: string): Row[] => compactionRows(root) as Row[];

// No key is the port call an older binary made.
function spooled(importKey?: string, at: Date = new Date(Date.now() - 30 * MINUTE)): SpooledSummary {
  const base = {
    tenantId: 'default',
    payload: { sessionId: 's1', trigger: 'auto', cwd: s.proj, transcriptPath: null },
    text: { summary: 'the summary', items: ITEMS },
    at,
  };
  return importKey === undefined ? base : { ...base, importKey };
}

function writeWaiting(name: string, over: { tenantId?: string; at?: Date } = {}): void {
  const { payload, text, at } = spooled(undefined, over.at);
  fs.mkdirSync(spoolDir(), { recursive: true });
  fs.writeFileSync(
    path.join(spoolDir(), name),
    JSON.stringify({
      tenantId: over.tenantId ?? 'default',
      ...payload,
      at: at.toISOString(),
      summary: text.summary,
      items: ITEMS,
    }),
  );
}

function expectOneFinishedRecord(): void {
  expect(compactionRows(s.hippoRoot)).toMatchObject([{ session_id: 's1', status: 'done', items_written: 2 }]);
  expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
  expect(spoolFiles()).toEqual([]);
}

describe('a spool file imported again after its first import saved the record', () => {
  it('a busy claim unlink: the put-back file adds no second record', async () => {
    writeWaiting(`${BUSY_STEM}.a0.json`);
    const real = nodeFs.unlinkSync;
    // SAFETY: the stub forwards every call but a claim file's to unlinkSync; a spy cannot spell its overloads.
    const stub = ((file: fs.PathLike) => {
      if (String(file).includes('.claim-')) throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' });
      return real(file);
    }) as typeof nodeFs.unlinkSync;
    vi.spyOn(nodeFs, 'unlinkSync').mockImplementation(stub);
    syncBuiltinESMExports();
    try {
      expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
      const claims = spoolFiles().filter((n) => n.includes('.claim-'));
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatch(new RegExp(`^${BUSY_STEM}[.]a0[.]claim-[0-9]{13}$`));
      expect(compactionRows(s.hippoRoot)).toHaveLength(1);
      fs.renameSync(
        path.join(spoolDir(), claims[0]),
        path.join(spoolDir(), `${BUSY_STEM}.a0.claim-${claimStamp(Date.now() - 20 * MINUTE)}`),
      );
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expectOneFinishedRecord();
  });

  it('a death between the save and the unlink: the file imports once more and writes the items once', async () => {
    const hooks = compactionFolder(s.hippoRoot).store.compactionHooks;
    await hooks.recordSpooled(spooled(DIED_BEFORE_ITEMS_STEM), {});
    expect(compactionMemories(s.hippoRoot)).toEqual([]);
    writeWaiting(`${DIED_BEFORE_ITEMS_STEM}.a1.json`);
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expectOneFinishedRecord();
  });

  it('a death after the items: the file imports once more, with no extra record or memory', async () => {
    const hooks = compactionFolder(s.hippoRoot).store.compactionHooks;
    const record = await hooks.recordSpooled(spooled(DIED_AFTER_ITEMS_STEM), {});
    await hooks.saveRecordItems('default', record, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
    writeWaiting(`${DIED_AFTER_ITEMS_STEM}.a1.json`);
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expectOneFinishedRecord();
    expect(logs.join('\n')).toContain('was already finished by another process');
    expect(logs.join('\n')).not.toMatch(/failed to import|set aside as \.bad/);
  });
});

describe('a store an older binary wrote, whose rows carry no request id', () => {
  it('leaves the older row unkeyed and gives the one new row its spool request id', async () => {
    const older = await compactionFolder(s.hippoRoot).store.compactionHooks.recordSpooled(spooled(), {});
    writeWaiting(`${AFTER_UNKEYED_STEM}.a0.json`);
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    const stored = rowsOf(s.hippoRoot);
    expect(stored).toHaveLength(2);
    expect(stored.find((r) => r.id === older.id)?.request_id).toBeNull();
    expect(stored.filter((r) => r.id !== older.id).map((r) => r.request_id)).toEqual([`spool:${AFTER_UNKEYED_STEM}`]);
  });

  it('a legacy stem becomes a request id as it is', async () => {
    writeWaiting('s1-1.json');
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expect(rowsOf(s.hippoRoot).map((r) => r.request_id)).toEqual(['spool:s1-1']);
  });

  it('a started record from pre-compact takes the summary and the spool request id, with no second row', async () => {
    const startedId = await compactionFolder(s.hippoRoot).store.compactionHooks.start('default', {
      sessionId: 's1',
      trigger: 'auto',
      cwd: s.proj,
      transcriptPath: null,
    });
    // The start is stamped now, so the file's time sits just after it, inside REPLAY_AFTER_MS.
    writeWaiting(`${STARTED_STEM}.a0.json`, { at: new Date(Date.now() + 2 * MINUTE) });
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expect(rowsOf(s.hippoRoot)).toMatchObject([{ id: startedId, status: 'done', request_id: `spool:${STARTED_STEM}` }]);
  });
});

describe('a spool key too long for a request id', () => {
  const hexId = /^spool:[0-9a-f]{64}$/;

  it('is hashed to a fixed length, and a second import of it finds the first record', async () => {
    const hooks = compactionFolder(s.hippoRoot).store.compactionHooks;
    const first = await hooks.recordSpooled(spooled('k'.repeat(300)), {});
    const second = await hooks.recordSpooled(spooled('k'.repeat(300)), {});
    expect(second.id).toBe(first.id);
    const stored = rowsOf(s.hippoRoot);
    expect(stored).toHaveLength(1);
    const requestId = stored[0]?.request_id ?? '';
    expect(requestId).toMatch(hexId);
    expect(requestId).toHaveLength(70);
    expect(requestId.length).toBeLessThanOrEqual(MAX_ID_LEN);
  });

  it('a short key is the request id after the prefix, as it is', async () => {
    await compactionFolder(s.hippoRoot).store.compactionHooks.recordSpooled(spooled('short-key'), {});
    expect(rowsOf(s.hippoRoot).map((r) => r.request_id)).toEqual(['spool:short-key']);
  });

  it('two keys that differ only after their first 280 characters stay two records', async () => {
    const hooks = compactionFolder(s.hippoRoot).store.compactionHooks;
    const shared = 'k'.repeat(280);
    await hooks.recordSpooled(spooled(`${shared}${'a'.repeat(20)}`), {});
    await hooks.recordSpooled(spooled(`${shared}${'b'.repeat(20)}`), {});
    const ids = rowsOf(s.hippoRoot).map((r) => r.request_id ?? '');
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(hexId);
  });
});

describe('two spool files that differ in stem or in tenant are never merged', () => {
  it('different stems of one session and summary make two records', async () => {
    writeWaiting(`${FIRST_STEM}.a0.json`);
    writeWaiting(`${SECOND_STEM}.a0.json`);
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(2);
    expect(rowsOf(s.hippoRoot)).toMatchObject([
      { session_id: 's1', status: 'done' },
      { session_id: 's1', status: 'done' },
    ]);
    expect(spoolFiles()).toEqual([]);
  });

  it('one stem in two tenants makes one record in each, replayed in one run', async () => {
    writeWaiting(`${TENANT_STEM}.a0.json`);
    writeWaiting(`${TENANT_STEM}.a1.json`, { tenantId: 'acme' });
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(2);
    expect(
      rowsOf(s.hippoRoot)
        .map((r) => [r.tenant_id, r.request_id])
        .sort(),
    ).toEqual([
      ['acme', `spool:${TENANT_STEM}`],
      ['default', `spool:${TENANT_STEM}`],
    ]);
    expect(spoolFiles()).toEqual([]);
  });
});

describe('a caller request id that equals a spool stem', () => {
  it('never meets the spool import of that stem: two records, no error', async () => {
    await hookStore(s.hippoRoot).compactions.saveCallerItems('default', {
      sessionId: 's1',
      trigger: 'auto',
      requestId: CALLER_STEM,
      project: 'acme/app',
      items: ITEMS,
      owner: 'bob@acme',
      origins: ['acme/app'],
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });
    writeWaiting(`${CALLER_STEM}.a0.json`);
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expect(
      rowsOf(s.hippoRoot)
        .map((r) => r.request_id)
        .sort(),
    ).toEqual([CALLER_STEM, `spool:${CALLER_STEM}`]);
    expect(logs.join('\n')).not.toMatch(/failed to import|set aside as \.bad/);
    expect(spoolFiles()).toEqual([]);
  });
});

describe('a spool import that carries a key', () => {
  it('writes the row an import without one wrote, in every column but id, request id and summary time', async () => {
    const at = new Date(Date.now() - 30 * MINUTE);
    const other = scratch();
    try {
      initTestStore(other.hippoRoot);
      await compactionFolder(s.hippoRoot).store.compactionHooks.recordSpooled(spooled(SAME_ROW_STEM, at), {});
      await compactionFolder(other.hippoRoot).store.compactionHooks.recordSpooled(spooled(undefined, at), {});
      const [keyed, plain] = [rowsOf(s.hippoRoot), rowsOf(other.hippoRoot)];
      expect(keyed).toHaveLength(1);
      expect(plain).toHaveLength(1);
      expect(keyed[0]?.request_id).toBe(`spool:${SAME_ROW_STEM}`);
      expect(plain[0]?.request_id).toBeNull();
      const columns = (row: Row | undefined): Record<string, unknown> =>
        Object.fromEntries(
          Object.entries(row ?? {}).filter(([k]) => !['id', 'request_id', 'summarised_at'].includes(k)),
        );
      expect(columns(keyed[0])).toHaveProperty('origin_project');
      expect(columns(keyed[0])).toEqual(columns(plain[0]));
    } finally {
      removeScratch(other);
    }
  });
});
