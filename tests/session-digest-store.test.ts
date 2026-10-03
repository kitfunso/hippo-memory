// The digest row in a real store: one per session, echo sources, tombstones, sharing and consolidation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { adminActor, reject } from '../src/api.js';
import { consolidate } from '../src/consolidate.js';
import { storeExtractedFacts } from '../src/extract.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import { autoShare, getGlobalRoot, neverAutoShareTags } from '../src/shared.js';
import { initStore, listMemoryConflicts, loadAllEntries, saveSessionHandoff, writeEntry } from '../src/store.js';
import {
  SESSION_DIGEST_TAG,
  isSessionDigestRow,
  sessionDigestId,
  writeSessionDigest,
  type SessionScan,
} from '../src/session-digest.js';

const REPLY = 'Retry `upload()` with backoff because the storage token expires mid-transfer.';

let tmp: string;
let repo: string;
let hippoRoot: string;
let origHippoHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-digest-store-'));
  repo = path.join(tmp, 'repo');
  hippoRoot = path.join(repo, '.hippo');
  initStore(hippoRoot);
  origHippoHome = process.env.HIPPO_HOME;
  process.env.HIPPO_HOME = path.join(tmp, 'global');
});

afterEach(() => {
  if (origHippoHome !== undefined) process.env.HIPPO_HOME = origHippoHome;
  else delete process.env.HIPPO_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
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

const write = (key: string, s: SessionScan) => writeSessionDigest(hippoRoot, s, { key, tenantId: 'default' });
const digests = (): MemoryEntry[] => loadAllEntries(hippoRoot).filter(isSessionDigestRow);

describe('writing the digest row', () => {
  it('writes one observed Episodic row tagged session-digest, keyed on the session', () => {
    expect(write('s1', scan(REPLY))).toMatchObject({ written: true, sentences: 1, files: 1 });
    const [row] = digests();
    expect(row).toMatchObject({
      id: sessionDigestId('default', 's1'),
      layer: Layer.Episodic,
      tags: [SESSION_DIGEST_TAG],
      source: SESSION_DIGEST_TAG,
      confidence: 'observed',
      source_session_id: 's1',
      content: `${REPLY}\nChanged: src/upload.ts`,
    });
  });

  it('replaces the row on a second run for the same session', () => {
    write('s1', scan(REPLY));
    write('s1', scan('Pinned `retry()` to three attempts because the queue backs up.'));
    expect(digests().map((d) => d.content)).toEqual(['Pinned `retry()` to three attempts because the queue backs up.\nChanged: src/upload.ts']);
    expect(sessionDigestId('default', 's1')).not.toBe(sessionDigestId('other-tenant', 's1'));
  });

  it.each([
    ['no human prompt', () => scan(REPLY, { turns: [] })],
    ['no final message and no edits', () => scan('', { edits: [] })],
    ['the transcript names no working directory', () => scan(REPLY, { cwd: null })],
    ['the session ran outside this repo', () => scan(REPLY, { cwd: tmp })],
    ['nothing left after the filters', () => scan('This fixes it.', { edits: [] })],
  ])('skips with %s', (reason, make) => {
    expect(write('s1', make())).toMatchObject({ written: false, reason });
    expect(digests()).toEqual([]);
  });

  it('skips a digest whose text was rejected', () => {
    write('s1', scan(REPLY));
    reject({ hippoRoot, tenantId: 'default', actor: adminActor('test') }, { memoryId: sessionDigestId('default', 's1'), reason: 'not useful' });
    expect(write('s1', scan(REPLY))).toMatchObject({ written: false, reason: 'it matches a rejected value' });
    expect(digests()).toEqual([]);
  });

  it('a reject blocks that text only, so a re-run with a new reply writes the row again', () => {
    write('s1', scan(REPLY));
    reject({ hippoRoot, tenantId: 'default', actor: adminActor('test') }, { memoryId: sessionDigestId('default', 's1'), reason: 'not useful' });
    expect(write('s1', scan('Pinned `retry()` to three attempts because the queue backs up.')).written).toBe(true);
    expect(digests()).toHaveLength(1);
  });
});

describe('text hippo injected is not stored again', () => {
  it('drops a sentence restating another session digest, but not its own earlier one', () => {
    write('s1', scan(REPLY, { edits: [] }));
    expect(write('s2', scan(`As before, ${REPLY}`, { edits: [] })).reason).toBe('nothing left after the filters');
    expect(write('s1', scan(REPLY, { edits: [] })).written).toBe(true);
  });

  it('drops a restated digest older than the five newest, since prompt recall can inject it', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
      write('old', scan(REPLY, { edits: [] }));
      const later = [
        'Raised the health probe timeout to ninety seconds because cold starts are slow.',
        'Moved invoice rendering into a worker because the request thread blocked.',
        'Switched the font loader to swap because the hero text flashed.',
        'Capped thumbnail width at 640 pixels because mobile memory ran out.',
        'Renamed the billing cron to nightly because two jobs collided.',
      ];
      later.forEach((text, i) => {
        vi.setSystemTime(new Date(Date.UTC(2026, 8, 2 + i)));
        write(`n${i}`, scan(text, { edits: [] }));
      });
      expect(digests()).toHaveLength(6);
      expect(write('s2', scan(`As before, ${REPLY}`, { edits: [] })).reason).toBe('nothing left after the filters');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a sentence restating the ambient handoff of another session, but not its own', () => {
    saveSessionHandoff(hippoRoot, 'default', {
      version: 1, sessionId: 'other', summary: 'Moved the lock into the pool so two writers stop racing on the index.',
    });
    const restated = 'Moved the lock into the pool so two writers stop racing, in `pool.ts`.';
    expect(write('s2', scan(restated, { edits: [] })).reason).toBe('nothing left after the filters');
    expect(write('other', scan(restated, { edits: [] })).written).toBe(true);
  });
});

describe('sharing', () => {
  it('autoShare never copies a digest, even with no score bar', () => {
    write('s1', scan(REPLY));
    writeEntry(hippoRoot, createMemory('gotcha: powershell 5.1 has no pipeline chain operators', { tenantId: 'default' }));
    const stats = { secretSkipped: 0, neverAutoShareSkipped: 0 };
    autoShare(hippoRoot, { minScore: 0, stats });
    expect(loadAllEntries(getGlobalRoot()).map((e) => e.content)).toEqual(['gotcha: powershell 5.1 has no pipeline chain operators']);
    expect(stats.neverAutoShareSkipped).toBe(1);
  });

  it('a fact extracted from a digest inherits the tag but is not itself a digest', () => {
    write('s1', scan(REPLY));
    const [digest] = digests();
    expect(neverAutoShareTags([digest])).toEqual([SESSION_DIGEST_TAG]);
    const [fact] = storeExtractedFacts(hippoRoot, digest, [
      { content: 'The uploader retries with backoff when the storage token expires.', tags: ['topic:upload'], valence: 'neutral' },
    ]);
    expect(fact.tags).toContain(SESSION_DIGEST_TAG);
    expect(isSessionDigestRow(fact)).toBe(false);
    autoShare(hippoRoot, { minScore: 0 });
    expect(loadAllEntries(getGlobalRoot())).toEqual([]);
  });
});

describe('consolidation leaves digests alone', () => {
  const base = 'Fixed the server crash due to memory overflow in the worker process `pool.ts`';
  const row = (content: string, digest: boolean): MemoryEntry =>
    createMemory(content, { layer: Layer.Episodic, tenantId: 'default', tags: digest ? [SESSION_DIGEST_TAG] : [], source: digest ? SESSION_DIGEST_TAG : undefined });

  it.each([true, false])('merge pass, digest rows: %s', async (digest) => {
    const rows = [base, `${base} again today`, `${base} once more`].map((c) => row(c, digest));
    for (const r of rows) writeEntry(hippoRoot, r);
    const result = await consolidate(hippoRoot, { dryRun: false, now: new Date() });
    const semantic = loadAllEntries(hippoRoot).filter((e) => e.layer === Layer.Semantic);
    if (digest) {
      expect(result.merged).toBe(0);
      expect(semantic).toEqual([]);
      expect(loadAllEntries(hippoRoot).filter((e) => e.superseded_by)).toEqual([]);
    } else {
      expect(result.merged).toBeGreaterThan(0);
    }
  });

  it.each([true, false])('conflict pass, digest rows: %s', async (digest) => {
    writeEntry(hippoRoot, row('always use port 3000 for the dev server', digest));
    writeEntry(hippoRoot, row('never use port 3000 for the dev server', digest));
    await consolidate(hippoRoot, { dryRun: false, now: new Date() });
    expect(listMemoryConflicts(hippoRoot).length > 0).toBe(!digest);
  });
});
