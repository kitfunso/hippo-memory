// Store passes that walk many rows open the store once and read rows in chunked IN lists, so query counts stay flat as rows grow.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRoot } from './_helpers/make-root.js';
import { recordStatements, countMatching, STORE_OPEN } from './_helpers/count-statements.js';
import { openStore } from '../src/store/open.js';
import { writeEntryOn } from '../src/store/entry-writes.js';
import { MEMORY_SELECT_COLUMNS } from '../src/store/rows.js';
import { closeHippoDb } from '../src/db.js';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../src/memory.js';
import { readEntry } from '../src/store/entry-reads.js';
import { adminActor, type HippoDbContext } from '../src/api/types.js';
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

describe('outcome with a repeated id', () => {
  it('applies the outcome twice, as one read per id did', () => {
    const root = freshRoot('qc-outcome-repeat');
    const [entry] = rows(1, 'repeat');
    seed(root, [entry]);
    expect(outcome(ctxFor(root), [entry.id, entry.id], false).applied).toBe(2);
    expect(readEntry(root, entry.id)?.outcome_negative).toBe(2);
  });
});
