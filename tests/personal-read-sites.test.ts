// E10 lane A: every SQL read site admits the caller's own personal row only when handed its owner, and deny-only sites admit none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type CreateMemoryOptions, type MemoryEntry } from '../src/memory.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { batchWriteAndDelete } from '../src/store/delete-and-batch.js';
import { saveEmbeddingIndex } from '../src/embeddings.js';
import { loadRecallSearchEntries, loadVectorCandidateEntries, recallScopeFilter } from '../src/store/search-rows.js';
import { loadAmbientCandidates, loadContextCandidates, loadTextsHoldingWords } from '../src/store/candidates.js';
import { loadAmbientTallies } from '../src/ambient-store.js';
import { countSessionRawMemories } from '../src/store/entry-reads.js';
import { loadLatestHandoff, saveSessionHandoff } from '../src/store/handoffs.js';
import { assembleBriefFromReceipts } from '../src/project-briefs.js';
import { saveItems, type ItemContext } from '../src/compaction-record.js';
import { _resetSharedStoreCacheForTests } from '../src/config.js';
import { clearProjectIdentityCache } from '../src/project-identity.js';

const T = 'default';
const OWN_A = 'personal:private:alice';
const OWN_B = 'personal:private:bob';
const SCOPES = { a: OWN_A, b: OWN_B, team: null, slack: 'slack:private:C1', legacy: 'unknown:legacy' } as const;
const QUERY = [1, 0, 0];
const now = new Date();

let dir: string;
let root: string;

function mem(content: string, opts: Partial<CreateMemoryOptions>): MemoryEntry {
  return createMemory(content, { tenantId: T, baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...opts });
}

// Five rows that every site could match on "zebrafish", one per scope, plus raw rows for the session count.
function seed(): void {
  const rows = Object.entries(SCOPES).map(([k, scope]) => mem(`zebrafish note ${k} keeps the build cache warm`, { scope, tags: [`who:${k}`, 'path:hippo'] }));
  batchWriteAndDelete(root, rows, []);
  saveEmbeddingIndex(root, Object.fromEntries(rows.map((e) => [e.id, QUERY])));
  for (const k of ['a', 'b', 'team'] as const) writeEntry(root, mem(`raw transcript line from ${k}`, { scope: SCOPES[k], kind: 'raw', source_session_id: 'sess-1' }));
}

const keysOf = (entries: readonly MemoryEntry[]): string[] =>
  entries.flatMap((e) => e.tags.filter((t) => t.startsWith('who:')).map((t) => t.slice(4))).sort();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-personal-sites-'));
  for (const name of ['HOME', 'USERPROFILE', 'HIPPO_HOME']) vi.stubEnv(name, dir);
  clearProjectIdentityCache();
  _resetSharedStoreCacheForTests();
  root = path.join(dir, 'server', '.hippo');
  fs.mkdirSync(root, { recursive: true });
  initStore(root);
  seed();
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetSharedStoreCacheForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('owner-taking read sites', () => {
  it('lexical recall: A sees its row, B and no-owner do not', () => {
    const load = (own?: string): string[] => keysOf(loadRecallSearchEntries(root, 'zebrafish', 50, T, undefined, 'exact', false, undefined, own));
    expect(load(OWN_A)).toEqual(['a', 'team']);
    expect(load(OWN_B)).toEqual(['b', 'team']);
    expect(load()).toEqual(['team']);
  });

  it('vector recall: A sees its row, B and no-owner do not', () => {
    const load = (own?: string): string[] =>
      keysOf(loadVectorCandidateEntries(root, QUERY, { tenantId: T, scope: recallScopeFilter(undefined, 'exact', own), includeSuperseded: false }));
    expect(load(OWN_A)).toEqual(['a', 'team']);
    expect(load(OWN_B)).toEqual(['b', 'team']);
    expect(load()).toEqual(['team']);
  });

  it('context candidates: A sees its row, B and no-owner do not', () => {
    const load = (ownScope?: string): string[] => keysOf(loadContextCandidates(root, T, { ownScope, cap: 100, now }));
    expect(load(OWN_A)).toEqual(['a', 'team']);
    expect(load(OWN_B)).toEqual(['b', 'team']);
    expect(load()).toEqual(['team']);
  });

  it('ambient prompt recall: A sees its row, B and no-owner do not', () => {
    const load = (ownScope?: string): string[] =>
      keysOf(loadAmbientCandidates(root, T, 0, () => true, { terms: ['zebrafish'], limit: 50, ownScope }).recall ?? []);
    expect(load(OWN_A)).toEqual(['a', 'team']);
    expect(load(OWN_B)).toEqual(['b', 'team']);
    expect(load()).toEqual(['team']);
  });

  it('ambient tallies: A counts its row, B and no-owner do not', () => {
    const tags = (ownScope?: string): string[] =>
      [...loadAmbientTallies(root, T, { ownScope, currentProject: [], now }).tagCounts.keys()].filter((t) => t.startsWith('who:')).sort();
    expect(tags(OWN_A)).toEqual(['who:a', 'who:team']);
    expect(tags(OWN_B)).toEqual(['who:b', 'who:team']);
    expect(tags()).toEqual(['who:team']);
  });

  it('session raw count: A counts its row, B and no-owner do not', () => {
    expect(countSessionRawMemories(root, 'sess-1', T, undefined, OWN_A)).toBe(2);
    expect(countSessionRawMemories(root, 'sess-1', T, undefined)).toBe(1);
    expect(countSessionRawMemories(root, 'sess-1', T, OWN_A)).toBe(1);
  });
});

describe('deny-only read sites', () => {
  it('handoffs: the default-deny read skips a newer personal handoff', () => {
    saveSessionHandoff(root, T, { version: 1, sessionId: 's-team', summary: 'team handoff', scope: null });
    saveSessionHandoff(root, T, { version: 1, sessionId: 's-a', summary: 'alice handoff', scope: OWN_A });
    expect(loadLatestHandoff(root, T)?.summary).toBe('alice handoff');
    expect(loadLatestHandoff(root, T, undefined, { scopeFilter: 'default-deny' })?.summary).toBe('team handoff');
  });

  it('brief receipts: only the team row counts, though A can read its own', () => {
    expect(keysOf(loadContextCandidates(root, T, { ownScope: OWN_A, cap: 100, now }))).toContain('a');
    const brief = assembleBriefFromReceipts(root, T, 'hippo');
    expect(brief.receiptCount).toBe(1);
    expect(brief.markdown).toContain('zebrafish note team');
    expect(brief.markdown).not.toContain('zebrafish note a ');
  });

  it('compaction held rows: a personal row does not stop the team copy, a team row does', () => {
    const items = [
      'The release script must run from the repo root because it reads the env file by a relative path.',
      'Integration tests need the local Postgres container started before the suite or every case times out.',
    ];
    writeEntry(root, { ...mem(items[0], { scope: OWN_A }), origin_project: 'acme/app' });
    writeEntry(root, { ...mem(items[1], {}), origin_project: 'acme/app' });
    const ctx: ItemContext = { tenantId: T, recordId: null, sessionId: 's1', originProject: 'acme/app', cwd: null, items, caller: { actor: 'alice@acme', origins: ['acme/app'] } };
    const db = openHippoDb(root);
    try {
      expect(saveItems(db, root, ctx, () => {})).toBe(1);
      // SAFETY: the SELECT names only the content column.
      const written = db.prepare(`SELECT content FROM memories WHERE source = 'compaction:s1'`).all() as Array<{ content: string }>;
      expect(written.map((r) => r.content)).toEqual([items[0]]);
    } finally {
      closeHippoDb(db);
    }
  });

  it('capture dedup: only the team row holds the word', () => {
    const db = openHippoDb(root);
    try {
      // SAFETY: one COUNT row.
      expect((db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE content LIKE '%zebrafish%'`).get() as { c: number }).c).toBe(5);
    } finally {
      closeHippoDb(db);
    }
    expect(loadTextsHoldingWords(root, T, ['zebrafish']).map((r) => r.content)).toEqual(['zebrafish note team keeps the build cache warm']);
  });
});
