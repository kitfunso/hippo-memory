import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryAuditEvents } from '../src/store/audit.js';
import { extractFromText } from '../src/capture/extract.js';
import { loadConfig } from '../src/core/config.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../src/db/index.js';
import { gatedWrite } from '../src/store/gated-write.js';
import { createMemory, Layer, type MemoryEntry } from '../src/core/memory.js';
import { insertRejectedValue, normalizeValueForRejection, rejectionDigest } from '../src/store/rejection.js';
import { openStore, initStore } from '../src/store/open.js';
import { loadAllEntries, readEntry } from '../src/store/entry-reads.js';
import { initProject, removeScratch, runHippo, scratch, type Scratch } from './_helpers/compaction-hooks.js';

let s: Scratch;

beforeEach(() => {
  s = scratch();
});
afterEach(() => removeScratch(s));

function entryFor(text: string, tags: string[] = ['captured']): MemoryEntry {
  return createMemory(text, { layer: Layer.Episodic, tags, source: 'test', baseHalfLifeDays: loadConfig(s.hippoRoot).defaultHalfLifeDays });
}

function reject(text: string): void {
  const db = openHippoDb(s.hippoRoot);
  try {
    insertRejectedValue(db, {
      tenantId: 'default',
      digest: rejectionDigest(text),
      reason: 'test',
      rejectedBy: 'cli',
      rejectedAt: new Date().toISOString(),
      normalizedChars: normalizeValueForRejection(text).length,
    });
  } finally {
    closeHippoDb(db);
  }
}

describe('the shared gated write', () => {
  let db: DatabaseSyncLike;
  beforeEach(() => {
    initStore(s.hippoRoot);
    db = openStore(s.hippoRoot);
  });
  afterEach(() => closeHippoDb(db));

  it('writes a worthwhile row on the caller handle, stamped with the store origin, and audits it', () => {
    const entry = entryFor('The billing service uses pnpm, so npm install is never run there.');
    expect(gatedWrite(db, s.hippoRoot, entry)).toBe('written');
    expect(readEntry(s.hippoRoot, entry.id)).toMatchObject({ content: entry.content, origin_project: 'proj' });
    expect(queryAuditEvents(db, { tenantId: 'default', op: 'remember' }).map((e) => e.targetId)).toContain(entry.id);
  });

  it('keeps an origin the caller already set', () => {
    const entry = { ...entryFor('The billing service uses pnpm, so npm install is never run there.'), origin_project: 'elsewhere' };
    expect(gatedWrite(db, s.hippoRoot, entry)).toBe('written');
    expect(readEntry(s.hippoRoot, entry.id)?.origin_project).toBe('elsewhere');
  });

  it('skips text that is not worth storing', () => {
    const entry = entryFor('fix stuff');
    expect(gatedWrite(db, s.hippoRoot, entry)).toBe('skipped:not-worth-storing');
    expect(readEntry(s.hippoRoot, entry.id)).toBeNull();
  });

  it('skips a row that holds a secret', () => {
    const token = 'ghp_' + 'd'.repeat(36);
    const entry = entryFor(`The release bot deploys with the token ${token} so rotate it monthly.`);
    expect(gatedWrite(db, s.hippoRoot, entry)).toBe('skipped:secret');
    expect(readEntry(s.hippoRoot, entry.id)).toBeNull();
  });

  it('skips a rejected value and audits the refusal on the same handle', () => {
    const text = 'The old staging password rotation runs every Friday at noon by hand.';
    reject(text);
    const entry = entryFor(text);
    expect(gatedWrite(db, s.hippoRoot, entry, { actor: 'post-compact' })).toBe('skipped:rejected');
    expect(readEntry(s.hippoRoot, entry.id)).toBeNull();
    const refusals = queryAuditEvents(db, { tenantId: 'default', op: 'reject_refusal' });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.targetId).toBe(entry.id);
    expect(refusals[0]!.actor).toBe('post-compact');
  });

  it('nests in the caller transaction: a rollback removes the row, a commit keeps it', () => {
    const undone = entryFor('The billing service uses pnpm, so npm install is never run there.');
    const kept = entryFor('The search service cache must be flushed after every deploy.');
    db.exec('BEGIN IMMEDIATE');
    expect(gatedWrite(db, s.hippoRoot, undone)).toBe('written');
    db.exec('ROLLBACK');
    db.exec('BEGIN IMMEDIATE');
    expect(gatedWrite(db, s.hippoRoot, kept)).toBe('written');
    db.exec('COMMIT');
    expect(readEntry(s.hippoRoot, undone.id)).toBeNull();
    expect(readEntry(s.hippoRoot, kept.id)).not.toBeNull();
  });

  it('carries on after a rejected row inside one transaction', () => {
    reject('The old staging password rotation runs every Friday at noon by hand.');
    db.exec('BEGIN IMMEDIATE');
    expect(gatedWrite(db, s.hippoRoot, entryFor('The old staging password rotation runs every Friday at noon by hand.'))).toBe('skipped:rejected');
    expect(gatedWrite(db, s.hippoRoot, entryFor('The search service cache must be flushed after every deploy.'))).toBe('written');
    db.exec('COMMIT');
    expect(loadAllEntries(s.hippoRoot, 'default')).toHaveLength(1);
  });
});

describe('capture on the shared gated write', () => {
  const text = [
    'We decided to use pnpm for the billing service because the lockfile is pnpm-lock.yaml.',
    'Never run database migrations on a Friday afternoon because the on-call team is small.',
    'Gotcha: the staging cache must be flushed after every deploy of the search service.',
  ].join('\n');

  function capture(input: string) {
    const file = path.join(s.dir, 'input.txt');
    fs.writeFileSync(file, input);
    return runHippo(['capture', '--file', file], s.proj, s.env);
  }

  it('writes every extracted item, mirrors each one, and stamps the store origin', () => {
    initProject(s);
    const result = capture(text);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Captured 3 items (0 skipped as duplicates)');
    const rows = loadAllEntries(s.hippoRoot, 'default');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.origin_project === 'proj' && r.tags.includes('captured'))).toBe(true);
    expect(fs.readdirSync(path.join(s.hippoRoot, 'episodic')).sort()).toEqual(rows.map((r) => `${r.id}.md`).sort());
  });

  it('counts a rejected item, still writes the rest, and skips a repeat on the next run', () => {
    initProject(s);
    const items = extractFromText(text);
    expect(items).toHaveLength(3);
    reject(items[1]!.content);

    const first = capture(text);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('Captured 2 items (0 skipped as duplicates, 1 rejected)');
    const contents = loadAllEntries(s.hippoRoot, 'default').map((r) => r.content).sort();
    expect(contents).toEqual([items[0]!.content, items[2]!.content].sort());
    expect(fs.readdirSync(path.join(s.hippoRoot, 'episodic'))).toHaveLength(2);

    const second = capture(text);
    expect(second.stdout).toContain('Captured 0 items (2 skipped as duplicates, 1 rejected)');
    expect(loadAllEntries(s.hippoRoot, 'default')).toHaveLength(2);
  });
});
