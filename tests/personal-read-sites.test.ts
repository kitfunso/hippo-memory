// E10 lane A: every SQL read site admits the caller's own personal row only when handed its owner, and deny-only sites admit none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { adminActor, CLI_LEARN, learn, MCP_LEARN, type LearnProfile } from '../src/api/index.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type CreateMemoryOptions, type MemoryEntry } from '../src/core/memory.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { batchWriteAndDelete } from '../src/store/delete-and-batch.js';
import { saveEmbeddingIndex } from '../src/store/vector-index.js';
import { loadRecallSearchEntries, loadVectorCandidateEntries, recallScopeFilter } from '../src/store/search-rows.js';
import { loadAmbientCandidates, loadContextCandidates, loadTextsHoldingWords } from '../src/store/candidates.js';
import { loadAmbientTallies } from '../src/store/ambient.js';
import { countSessionRawMemories, loadAllEntries, loadContentsWithTag } from '../src/store/entry-reads.js';
import { canReadScope, personalScopeOf, type ScopeActor } from '../src/core/recall-scope.js';
import { touchableScopeSql } from '../src/store/rule-sql.js';
import { loadLatestHandoff, saveSessionHandoff } from '../src/store/handoffs.js';
import { assembleBriefFromReceipts } from '../src/objects/project-briefs.js';
import { saveItems, type ItemContext } from '../src/store/compactions-record.js';
import { _resetSharedStoreCacheForTests } from '../src/core/config.js';
import { clearProjectIdentityCache } from '../src/core/project-identity.js';

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

  it('additive recall: a personal scope adds only the caller\'s own row, a connector scope adds its rows', () => {
    const load = (scope: string, own?: string): string[] => keysOf(loadRecallSearchEntries(root, 'zebrafish', 50, T, scope, 'additive', false, undefined, own));
    expect(load(OWN_A)).toEqual(['team']);
    expect(load(OWN_A, OWN_A)).toEqual(['a', 'team']);
    expect(load(OWN_B, OWN_A)).toEqual(['a', 'team']);
    expect(load(SCOPES.slack)).toEqual(['slack', 'team']);
  });

  it('vector recall: A sees its row, B and no-owner do not', async () => {
    const load = async (own?: string): Promise<string[]> =>
      keysOf(await loadVectorCandidateEntries(root, QUERY, { tenantId: T, scope: recallScopeFilter(undefined, 'exact', own), includeSuperseded: false }));
    expect(await load(OWN_A)).toEqual(['a', 'team']);
    expect(await load(OWN_B)).toEqual(['b', 'team']);
    expect(await load()).toEqual(['team']);
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

  it('failure dedup: only the team row carries the tag', () => {
    expect(loadContentsWithTag(root, T, 'path:hippo')).toEqual(['zebrafish note team keeps the build cache warm']);
  });
});

describe('admin read sites', () => {
  it('touchableScopeSql admits what canReadScope admits for an admin, owned or not, case variants included', () => {
    const scopes = [null, SCOPES.slack, SCOPES.legacy, OWN_A, OWN_B, 'PERSONAL:PRIVATE:alice', 'Personal:Private:bob', 'personal:privatex'];
    scopes.forEach((scope, i) => writeEntry(root, mem(`gannet row ${i}`, { scope })));
    const actors: ScopeActor[] = [{ role: 'admin', owner: 'alice' }, { role: 'admin' }];
    for (const actor of actors) {
      const rows = loadTextsHoldingWords(root, T, ['gannet'], undefined, touchableScopeSql('', personalScopeOf(actor)));
      const viaSql = rows.map((r) => scopes[Number(r.content.split(' ')[2])]);
      const viaJs = scopes.filter((s) => s === null || canReadScope(actor, s));
      expect(new Set(viaSql), actor.owner).toEqual(new Set(viaJs));
    }
  });

  it.each<[string, LearnProfile]>([['MCP', MCP_LEARN], ['CLI', CLI_LEARN]])(
    '%s learn: another person\'s personal row never answers duplicate; a legacy row and the caller\'s own do',
    (_, profile) => {
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { enabled: false } }));
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(repo);
      const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }); };
      git('init');
      git('config', 'user.name', 'Test User');
      git('config', 'user.email', 'test@example.com');
      fs.writeFileSync(path.join(repo, 'db.ts'), 'export const timeout = 30;\n');
      git('add', '.');
      git('commit', '-m', 'fix: pool timeout bumped to 30s in src/db/index.ts');
      const ctx = { hippoRoot: root, tenantId: T, actor: { ...adminActor('learn-test'), owner: 'alice' } };
      const run = () => learn(ctx, { repoPath: repo, days: 7, profile });
      const move = (from: string | null, to: string): void => {
        const row = loadAllEntries(root, T).find((e) => e.source === profile.source && (e.scope ?? null) === from)!;
        writeEntry(root, { ...row, scope: to });
      };
      expect(run()).toMatchObject({ added: 1, skipped: 0 });
      move(null, OWN_B);
      expect(run()).toMatchObject({ added: 1, skipped: 0 });
      move(null, SCOPES.legacy);
      expect(run()).toMatchObject({ added: 0, skipped: 1 });
      move(SCOPES.legacy, OWN_A);
      expect(run()).toMatchObject({ added: 0, skipped: 1 });
    },
  );
});
