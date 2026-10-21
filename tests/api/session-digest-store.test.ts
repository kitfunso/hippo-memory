// The digest row in a real store: one per session, echo sources, tombstones, sharing and consolidation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { loadConfig } from '../../src/base/config/config.js';
import { adminActor, reject } from '../../src/api/index.js';
import { consolidate } from '../../src/index.js';
import { storeExtractedFacts } from '../../src/domain/learn/extract.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { autoShare, neverAutoShareTags } from '../../src/domain/sharing/share.js';
import { getGlobalRoot } from '../../src/domain/sharing/global-store.js';
import { listMemoryConflicts, writeEntry, loadAllEntries, saveSessionHandoff } from '../_helpers/root-forms.js';
import { recordSessionDigest, sessionDigestId, type SessionScan } from '../../src/surface/capture/session-digest.js';
import { SESSION_DIGEST_TAG, isSessionDigestRow } from '../../src/base/session/session-digest-row.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

afterEach(() => {
  vi.unstubAllEnvs();
});

const REPLY = 'Retry `upload()` with backoff because the storage token expires mid-transfer.';

let tmp: string;
let repo: string;
let hippoRoot: string;

beforeEach(() => {
  tmp = makeRoot('digest-store', { init: false });
  repo = path.join(tmp, 'repo');
  hippoRoot = path.join(repo, '.hippo');
  initTestStore(hippoRoot);
  vi.stubEnv('HIPPO_HOME', path.join(tmp, 'global'));
});

function scan(finalText: string, over: Partial<SessionScan> = {}): SessionScan {
  return {
    turns: [{ role: 'user', text: 'the upload keeps failing overnight' }],
    finalText,
    cwd: repo,
    edits: [{ filePath: path.join(repo, 'src', 'upload.ts'), base: null }],
    ...over,
  };
}

/** The line recordSessionDigest logs for one run: what it wrote, or why it skipped. */
async function write(key: string, s: SessionScan): Promise<string> {
  const log: string[] = [];
  await recordSessionDigest(hippoRoot, sqliteStore(hippoRoot), s, {
    key,
    tenantId: 'default',
    config: loadConfig(hippoRoot),
    log: (line) => log.push(line),
  });
  return log.join('\n');
}
const WROTE = /^digest: wrote /;
const LEFT_NOTHING = 'digest: skip: nothing left after the filters';
const digests = (): MemoryEntry[] => loadAllEntries(hippoRoot, 'default').filter(isSessionDigestRow);

describe('writing the digest row', () => {
  it('writes one observed Episodic row tagged session-digest, keyed on the session', async () => {
    expect(await write('s1', scan(REPLY))).toBe('digest: wrote 1 sentence(s), 1 file(s) for s1');
    const [row] = digests();
    expect(row).toMatchObject({
      id: sessionDigestId('default', 's1'),
      layer: Layer.Episodic,
      tags: [SESSION_DIGEST_TAG],
      source: SESSION_DIGEST_TAG,
      confidence: 'observed',
      sourceSessionId: 's1',
      content: `${REPLY}\nChanged: src/upload.ts`,
    });
  });

  it('replaces the row on a second run for the same session', async () => {
    await write('s1', scan(REPLY));
    await write('s1', scan('Pinned `retry()` to three attempts because the queue backs up.'));
    expect(digests().map((d) => d.content)).toEqual([
      'Pinned `retry()` to three attempts because the queue backs up.\nChanged: src/upload.ts',
    ]);
    expect(sessionDigestId('default', 's1')).not.toBe(sessionDigestId('other-tenant', 's1'));
  });

  it.each([
    ['no human prompt', () => scan(REPLY, { turns: [] })],
    ['no final message and no edits', () => scan('', { edits: [] })],
    ['the transcript names no working directory', () => scan(REPLY, { cwd: null })],
    ['the session ran outside this repo', () => scan(REPLY, { cwd: tmp })],
    ['nothing left after the filters', () => scan('This fixes it.', { edits: [] })],
  ])('skips with %s', async (reason, make) => {
    expect(await write('s1', make())).toBe(`digest: skip: ${reason}`);
    expect(digests()).toEqual([]);
  });

  it('skips a digest whose text was rejected', async () => {
    await write('s1', scan(REPLY));
    await reject(apiCtx(hippoRoot, 'default', adminActor('test')), {
      memoryId: sessionDigestId('default', 's1'),
      reason: 'not useful',
    });
    expect(await write('s1', scan(REPLY))).toBe('digest: skip: it matches a rejected value');
    expect(digests()).toEqual([]);
  });

  it('a reject blocks that text only, so a re-run with a new reply writes the row again', async () => {
    await write('s1', scan(REPLY));
    await reject(apiCtx(hippoRoot, 'default', adminActor('test')), {
      memoryId: sessionDigestId('default', 's1'),
      reason: 'not useful',
    });
    expect(await write('s1', scan('Pinned `retry()` to three attempts because the queue backs up.'))).toMatch(WROTE);
    expect(digests()).toHaveLength(1);
  });
});

describe('text hippo injected is not stored again', () => {
  it('drops a sentence restating another session digest, but not its own earlier one', async () => {
    await write('s1', scan(REPLY, { edits: [] }));
    expect(await write('s2', scan(`As before, ${REPLY}`, { edits: [] }))).toBe(LEFT_NOTHING);
    expect(await write('s1', scan(REPLY, { edits: [] }))).toMatch(WROTE);
  });

  it('drops a restated digest older than the five newest, since prompt recall can inject it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
      await write('old', scan(REPLY, { edits: [] }));
      const later = [
        'Raised the health probe timeout to ninety seconds because cold starts are slow.',
        'Moved invoice rendering into a worker because the request thread blocked.',
        'Switched the font loader to swap because the hero text flashed.',
        'Capped thumbnail width at 640 pixels because mobile memory ran out.',
        'Renamed the billing cron to nightly because two jobs collided.',
      ];
      for (const [i, text] of later.entries()) {
        vi.setSystemTime(new Date(Date.UTC(2026, 8, 2 + i)));
        await write(`n${i}`, scan(text, { edits: [] }));
      }
      expect(digests()).toHaveLength(6);
      expect(await write('s2', scan(`As before, ${REPLY}`, { edits: [] }))).toBe(LEFT_NOTHING);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a sentence restating a digest that has been superseded, since no read injects that row', async () => {
    await write('s1', scan(REPLY, { edits: [] }));
    const [old] = digests();
    writeEntry(hippoRoot, { ...old, supersededBy: 'mem_successor' });
    expect(await write('s2', scan(`As before, ${REPLY}`, { edits: [] }))).toMatch(WROTE);
  });

  it('drops a sentence restating the ambient handoff of another session, but not its own', async () => {
    saveSessionHandoff(hippoRoot, 'default', {
      version: 1,
      sessionId: 'other',
      summary: 'Moved the lock into the pool so two writers stop racing on the index.',
    });
    const restated = 'Moved the lock into the pool so two writers stop racing, in `pool.ts`.';
    expect(await write('s2', scan(restated, { edits: [] }))).toBe(LEFT_NOTHING);
    expect(await write('other', scan(restated, { edits: [] }))).toMatch(WROTE);
  });
});

describe('sharing', () => {
  it('autoShare never copies a digest, even with no score bar', async () => {
    await write('s1', scan(REPLY));
    writeEntry(
      hippoRoot,
      createMemory('gotcha: powershell 5.1 has no pipeline chain operators', { tenantId: 'default' }),
    );
    const stats = { secretSkipped: 0, neverAutoShareSkipped: 0 };
    await autoShare(...sharingStores(hippoRoot), { tenantId: ALL_TENANTS, minScore: 0, stats });
    expect(loadAllEntries(getGlobalRoot(), 'default').map((e) => e.content)).toEqual([
      'gotcha: powershell 5.1 has no pipeline chain operators',
    ]);
    expect(stats.neverAutoShareSkipped).toBe(1);
  });

  it('a fact extracted from a digest inherits the tag but is not itself a digest', async () => {
    await write('s1', scan(REPLY));
    const [digest] = digests();
    expect(neverAutoShareTags([digest])).toEqual([SESSION_DIGEST_TAG]);
    const [fact] = storeExtractedFacts(
      sqliteStore(hippoRoot).localFiles.learning,
      digest,
      [
        {
          content: 'The uploader retries with backoff when the storage token expires.',
          tags: ['topic:upload'],
          valence: 'neutral',
        },
      ],
      DEFAULT_HALF_LIFE_DAYS,
    );
    expect(fact.tags).toContain(SESSION_DIGEST_TAG);
    expect(isSessionDigestRow(fact)).toBe(false);
    await autoShare(...sharingStores(hippoRoot), { tenantId: ALL_TENANTS, minScore: 0 });
    expect(loadAllEntries(getGlobalRoot(), 'default')).toEqual([]);
  });
});

describe('consolidation leaves digests alone', () => {
  const base = 'Fixed the server crash due to memory overflow in the worker process `pool.ts`';
  const row = (content: string, digest: boolean): MemoryEntry =>
    createMemory(content, {
      layer: Layer.Episodic,
      tenantId: 'default',
      tags: digest ? [SESSION_DIGEST_TAG] : [],
      source: digest ? SESSION_DIGEST_TAG : undefined,
    });

  it.each([true, false])('merge pass, digest rows: %s', async (digest) => {
    const rows = [base, `${base} again today`, `${base} once more`].map((c) => row(c, digest));
    for (const r of rows) writeEntry(hippoRoot, r);
    const result = await consolidate(hippoRoot, { dryRun: false, now: new Date() });
    const semantic = loadAllEntries(hippoRoot, 'default').filter((e) => e.layer === Layer.Semantic);
    if (digest) {
      expect(result.merged).toBe(0);
      expect(semantic).toEqual([]);
      expect(loadAllEntries(hippoRoot, 'default').filter((e) => e.supersededBy)).toEqual([]);
    } else {
      expect(result.merged).toBe(3);
    }
  });

  it.each([true, false])('conflict pass, digest rows: %s', async (digest) => {
    writeEntry(hippoRoot, row('always use port 3000 for the dev server', digest));
    writeEntry(hippoRoot, row('never use port 3000 for the dev server', digest));
    await consolidate(hippoRoot, { dryRun: false, now: new Date() });
    expect(listMemoryConflicts(hippoRoot).length > 0).toBe(!digest);
  });
});
