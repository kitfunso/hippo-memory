// Store passes that walk many rows open the store once and read rows in chunked IN lists, so query counts stay flat as rows grow.
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRoot } from './_helpers/make-root.js';
import { recordStatements, recordStatementsAsync, countMatching, STORE_OPEN } from './_helpers/count-statements.js';
import { openStore } from '../src/store/open.js';
import { writeEntryOn, strengthenRetrieved } from '../src/store/entry-writes.js';
import { MEMORY_SELECT_COLUMNS } from '../src/store/rows.js';
import { closeHippoDb } from '../src/db.js';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../src/memory.js';
import { readEntry, loadAllEntries } from '../src/store/entry-reads.js';
import { adminActor, type HippoDbContext } from '../src/api/types.js';
import { learn, CLI_LEARN } from '../src/api/learn.js';
import { cmdRemember } from '../src/cli/remember.js';
import { cmdCapture } from '../src/capture/command.js';
import { outcome } from '../src/api/outcome.js';
import { quarantineList } from '../src/api/quarantine.js';
import { drillDown } from '../src/api/drill-down.js';
import { recordQuarantine, quarantineScopeFor } from '../src/quarantine.js';
import { importEntries } from '../src/importers/core.js';
import { invalidateMatching, detectChurnStale } from '../src/invalidation.js';
import { replaceDetectedConflicts, resolveConflict, listMemoryConflicts } from '../src/store/conflicts.js';
import { deduplicateStore } from '../src/dedupe.js';

const SIZES = [10, 200] as const;
const ROW_READ = MEMORY_SELECT_COLUMNS;
/** loadAllEntries' statement: every full row of one tenant. */
const TENANT_READ = /FROM memories WHERE tenant_id = \? ORDER BY created ASC, id ASC$/;
const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshRoot(label: string): string {
  const root = makeRoot(label);
  roots.push(root);
  return root;
}

function ctxFor(root: string): HippoDbContext {
  return { hippoRoot: root, tenantId: 'default', actor: adminActor('test:query-count') };
}

function memory(content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), ...extra };
}

/** Seeds on one handle so a 200-row fixture stays fast. */
function seed(root: string, entries: readonly MemoryEntry[], after?: (db: ReturnType<typeof openStore>, e: MemoryEntry) => void): void {
  const db = openStore(root);
  try {
    for (const e of entries) {
      writeEntryOn(db, root, e);
      after?.(db, e);
    }
  } finally {
    closeHippoDb(db);
  }
}

function rows(n: number, label: string, extra: Partial<MemoryEntry> = {}): MemoryEntry[] {
  return Array.from({ length: n }, (_, i) => memory(`${label} memory number ${i} about the zephyrine cache`, extra));
}

/** Mirror files rewritten since `ageMirrors`, read from their mtimes. */
function ageMirrors(root: string): () => number {
  const old = new Date('2001-01-01T00:00:00Z');
  const files = Object.values(Layer).flatMap((layer) => {
    const dir = path.join(root, layer);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f)) : [];
  });
  for (const file of files) fs.utimesSync(file, old, old);
  return () => files.filter((file) => fs.existsSync(file) && fs.statSync(file).mtimeMs > old.getTime() + 1000).length;
}

describe('outcome', () => {
  it('opens the store once and reads every id in one query', () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-outcome');
      const entries = rows(n, 'outcome');
      seed(root, entries);
      const { result, statements } = recordStatements(() => outcome(ctxFor(root), entries.map((e) => e.id), true));
      expect(result.applied).toBe(n);
      expect(countMatching(statements, STORE_OPEN)).toBe(1);
      expect(countMatching(statements, ROW_READ)).toBe(1);
    }
  });
});

describe('quarantineList', () => {
  it('reads every listed memory in one query', () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-quarantine');
      const entries = rows(n, 'held', { scope: quarantineScopeFor(null) });
      seed(root, entries, (db, e) => recordQuarantine(db, { tenantId: 'default', memoryId: e.id, originalScope: null, reason: 'test', actor: 'test' }));
      const { result, statements } = recordStatements(() => quarantineList(ctxFor(root), { limit: 500 }));
      expect(result).toHaveLength(n);
      expect(result.every((item) => item.contentPreview.includes('zephyrine'))).toBe(true);
      expect(countMatching(statements, STORE_OPEN)).toBe(1);
      expect(countMatching(statements, ROW_READ)).toBe(1);
    }
  });
});

describe('drillDown', () => {
  it('reads one query per DAG level, not one per parent', () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-drill');
      const summary = memory('summary of the zephyrine cache work', { dag_level: 2, layer: Layer.Semantic });
      const mids = rows(n, 'mid', { dag_level: 1, dag_parent_id: summary.id });
      const leaves = mids.map((m, i) => memory(`leaf ${i} under the zephyrine cache`, { dag_level: 0, dag_parent_id: m.id }));
      seed(root, [summary, ...mids, ...leaves]);
      const { result, statements } = recordStatements(() => drillDown(ctxFor(root), summary.id, { depth: 2, limit: 1000 }));
      expect('failure' in result ? result.failure : result.totalChildren).toBe(2 * n);
      expect(countMatching(statements, STORE_OPEN)).toBe(1);
      expect(countMatching(statements, ROW_READ)).toBe(3);
    }
  });
});

describe('importEntries', () => {
  it('opens the target store a fixed number of times however many chunks land', () => {
    const opens = SIZES.map((n) => {
      const root = freshRoot('qc-import');
      const chunks = Array.from({ length: n }, (_, i) => `imported chunk ${i} about the zephyrine cache`);
      const { result, statements } = recordStatements(() => importEntries(chunks, 'import:test', ['imported'], { hippoRoot: root, tenantId: 'default' }));
      expect(result.imported).toBe(n);
      return countMatching(statements, STORE_OPEN);
    });
    expect(opens[1]).toBe(opens[0]);
  });
});

describe('invalidateMatching', () => {
  it('weakens every match on one store handle', () => {
    const opens = SIZES.map((n) => {
      const root = freshRoot('qc-invalidate');
      seed(root, rows(n, 'invalidate', { tags: ['oldlib'] }));
      const target = { from: 'oldlib', to: null, type: 'removal' as const };
      const { result, statements } = recordStatements(() => invalidateMatching(root, target, 'default'));
      expect(result.invalidated).toBe(n);
      return countMatching(statements, STORE_OPEN);
    });
    expect(opens[1]).toBe(opens[0]);
  });
});

describe('detectChurnStale', () => {
  it('tags every stale memory with one batched read on one handle', () => {
    const repo = freshRoot('qc-churn-repo');
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, stdio: 'ignore' });
    };
    const commitAt = (iso: string): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-am', 'c', '--allow-empty'], {
        cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
      });
    };
    git('init');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'v1');
    git('add', 'a.ts');
    commitAt('2025-12-20T00:00:00.000Z');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'v2');
    commitAt('2026-01-10T00:00:00.000Z');

    const counts = SIZES.map((n) => {
      const root = freshRoot('qc-churn');
      seed(root, rows(n, 'see a.ts for the setup', { created: '2026-01-01T00:00:00.000Z', origin_project: 'qcproj' }));
      const { result, statements } = recordStatements(() => detectChurnStale(root, repo, { tenantId: 'default', projectName: 'qcproj' }));
      expect(result.marked).toBe(n);
      return { opens: countMatching(statements, STORE_OPEN), reads: countMatching(statements, ROW_READ) };
    });
    expect(counts[1]).toEqual(counts[0]);
  });
});

describe('replaceDetectedConflicts', () => {
  it('rewrites only the rows and mirrors whose conflict list changed', () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-conflicts');
      const entries = rows(n, 'conflict');
      seed(root, entries);
      const mirrorsRewritten = ageMirrors(root);
      const pair = { memory_a_id: entries[0].id, memory_b_id: entries[1].id, reason: 'test', score: 0.9 };
      const { statements } = recordStatements(() => replaceDetectedConflicts(root, [pair]));
      expect(countMatching(statements, 'UPDATE memories SET conflicts_with_json')).toBe(2);
      expect(mirrorsRewritten()).toBe(2);

      const again = recordStatements(() => replaceDetectedConflicts(root, [pair]));
      expect(countMatching(again.statements, 'UPDATE memories SET conflicts_with_json')).toBe(0);
    }
  });

  it('resolveConflict rewrites only the two members mirrors', () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-resolve');
      const entries = rows(n, 'resolve');
      seed(root, entries);
      replaceDetectedConflicts(root, [{ memory_a_id: entries[0].id, memory_b_id: entries[1].id, reason: 'test', score: 0.9 }]);
      const [conflict] = listMemoryConflicts(root);
      const mirrorsRewritten = ageMirrors(root);
      const resolved = resolveConflict(root, conflict.id, conflict.memory_a_id);
      expect(resolved?.conflict.status).toBe('resolved');
      expect(mirrorsRewritten()).toBe(2);
    }
  });
});

describe('deduplicateStore', () => {
  it('deletes every duplicate on one store handle', () => {
    const opens = SIZES.map((n) => {
      const root = freshRoot('qc-dedupe');
      const originals = rows(n, 'dedupe');
      seed(root, [...originals, ...originals.map((e) => memory(e.content))]);
      const { result, statements } = recordStatements(() => deduplicateStore(root));
      expect(result.removed).toBe(n);
      return countMatching(statements, STORE_OPEN);
    });
    expect(opens[1]).toBe(opens[0]);
  });
});

describe('strengthenRetrieved', () => {
  it('reads every id in one query', () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-strengthen');
      const entries = rows(n, 'strengthen');
      seed(root, entries);
      const { result, statements } = recordStatements(() => strengthenRetrieved(root, entries.map((e) => e.id), { recallBoostAblated: false }));
      expect(result.size).toBe(n);
      expect(countMatching(statements, ROW_READ)).toBe(1);
    }
  });

  it('moves a repeated id once, as one read per id did', () => {
    const root = freshRoot('qc-strengthen-repeat');
    const [entry] = rows(1, 'repeat');
    seed(root, [entry]);
    expect([...strengthenRetrieved(root, [entry.id, entry.id], { recallBoostAblated: false })]).toEqual([entry.id]);
    const after = readEntry(root, entry.id);
    expect(after?.retrieval_count).toBe(entry.retrieval_count + 1);
    expect(after?.half_life_days).toBe(entry.half_life_days + 2);
  });
});

describe('learn', () => {
  /** A repo whose last `lessons` commits each replace the quuxlib client, so each lesson invalidates what mentions it. */
  function repoWith(lessons: number): string {
    const repo = freshRoot('qc-learn-repo');
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore' });
    };
    git('init');
    for (let i = 0; i < lessons; i++) git('commit', '--allow-empty', '-m', `fix: replace quuxlib client with fetch wrapper ${i} in src/api${i}.ts`);
    return repo;
  }

  function learnInto(repo: string, n: number) {
    const root = freshRoot('qc-learn');
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { enabled: false } }));
    seed(root, [...rows(n, 'learn'), memory('the quuxlib client retries twice'), memory('quuxlib client timeouts are 30s')]);
    const { result, statements } = recordStatements(() => learn(ctxFor(root), { repoPath: repo, days: 7, profile: CLI_LEARN }));
    return { root, result, opens: countMatching(statements, STORE_OPEN), tenantReads: countMatching(statements, TENANT_READ) };
  }

  it('opens the store and reads the tenant once per batch, however many lessons or rows', () => {
    const one = repoWith(1);
    const ten = repoWith(10);
    const counts = SIZES.map((n) => {
      const single = learnInto(one, n);
      const batch = learnInto(ten, n);
      expect(single.result.added).toBe(1);
      expect(batch.result.added).toBe(10);
      expect(batch.tenantReads).toBe(1);
      expect(batch.opens).toBe(single.opens);
      return batch.opens;
    });
    expect(counts[1]).toBe(counts[0]);
  });

  it('a later lesson still invalidates a lesson written earlier in the batch', () => {
    const { root, result } = learnInto(repoWith(3), 10);
    // Each lesson names the quuxlib client, so the second and third also weaken the lessons before them.
    expect(result.invalidations.map((i) => i.count)).toEqual([2, 3, 4]);
    const lessons = loadAllEntries(root, 'default').filter((e) => e.source === CLI_LEARN.source);
    const base = lessons.find((e) => !e.tags.includes('invalidated'))?.half_life_days ?? 0;
    expect(lessons.map((e) => e.half_life_days).sort((a, b) => a - b)).toEqual([Math.floor(Math.floor(base / 2) / 2), Math.floor(base / 2), base]);
    expect(lessons.filter((e) => e.confidence === 'stale')).toHaveLength(2);
  });
});

describe('cmdRemember', () => {
  async function remember(root: string, text: string) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { statements } = await recordStatementsAsync(() => cmdRemember(root, text, { tag: ['topic:cache'] }));
      return { statements, printed: log.mock.calls.map((call) => String(call[0])) };
    } finally {
      log.mockRestore();
    }
  }

  it('scores schema fit without reading a full row', async () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-remember');
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { enabled: false } }));
      seed(root, rows(n, 'remember', { tags: ['topic:cache'] }));
      const { statements, printed } = await remember(root, 'a new note about the zephyrine cache');
      expect(printed[0]).toMatch(/^Remembered \[/);
      expect(countMatching(statements, ROW_READ)).toBe(0);
      // One open scores the fit; the row and the counter share the other.
      expect(countMatching(statements, STORE_OPEN)).toBe(2);
    }
  });

  it('reads only the salience window when the gate runs, and judges as the whole list did', async () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-remember-salience');
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { enabled: false }, salience: { enabled: true, recentWindow: 3 } }));
      const stored = rows(n, 'salience').map((e, i) => ({ ...e, created: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
      seed(root, stored);

      const inWindow = await remember(root, stored[n - 1].content);
      expect(inWindow.printed[0]).toMatch(/^Skipped \(salience: duplicate/);
      expect(countMatching(inWindow.statements, ROW_READ)).toBe(1);
      expect(countMatching(inWindow.statements, /ORDER BY created DESC, id DESC LIMIT \?$/)).toBe(1);

      const beforeWindow = await remember(root, stored[n - 4].content);
      expect(beforeWindow.printed[0]).toMatch(/^Remembered \[/);
    }
  });
});

describe('cmdCapture', () => {
  it('reads no full row for its copy check and keeps every write on one handle', () => {
    const counts = SIZES.flatMap((n) => [1, 10].map((items) => {
      const root = freshRoot('qc-capture');
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { enabled: false } }));
      const held = 'Never deploy service 0 on Fridays because the on-call rota is thin';
      seed(root, [...rows(n, 'capture'), memory(held)]);
      const sessionTurns = Array.from({ length: items + 1 }, (_, i) => ({ role: 'user' as const, text: `Never deploy service ${i} on Fridays because the on-call rota is thin.` }));
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const { statements } = recordStatements(() => cmdCapture(root, { source: 'last-session', sessionTurns, dryRun: false, global: false, tenantId: 'default' }));
        expect(log.mock.calls.at(-1)?.[0]).toContain(`Captured ${items} items (1 skipped as duplicates)`);
        expect(countMatching(statements, ROW_READ)).toBe(0);
        return countMatching(statements, STORE_OPEN);
      } finally {
        log.mockRestore();
      }
    }));
    expect(new Set(counts).size).toBe(1);
  });
});

describe('outcome with a repeated id', () => {
  it('applies the outcome twice, as one read per id did', () => {
    const root = freshRoot('qc-outcome-repeat');
    const [entry] = rows(1, 'repeat');
    seed(root, [entry]);
    expect(outcome(ctxFor(root), [entry.id, entry.id], false).applied).toBe(2);
    expect(readEntry(root, entry.id)?.outcome_negative).toBe(2);
  });
});
