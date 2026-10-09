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
import { readEntry, loadAllEntries, heldIdLookup, loadEntriesByIds } from '../src/store/entry-reads.js';
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
import { buildDag } from '../src/dag.js';
import { buildMemoryDetail } from '../src/dashboard/dashboard-queries.js';
import { createSnapshotService } from '../src/dashboard/dashboard-snapshot.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { writeSessionDigest } from '../src/session-digest.js';

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
  it('reads every listed memory in one query', async () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-quarantine');
      const entries = rows(n, 'held', { scope: quarantineScopeFor(null) });
      seed(root, entries, (db, e) => recordQuarantine(db, { tenantId: 'default', memoryId: e.id, originalScope: null, reason: 'test', actor: 'test' }));
      const { result, statements } = await recordStatementsAsync(() => quarantineList(ctxFor(root), { limit: 500 }));
      expect(result).toHaveLength(n);
      expect(result.every((item) => item.contentPreview.includes('zephyrine'))).toBe(true);
      expect(countMatching(statements, STORE_OPEN)).toBe(1);
      expect(countMatching(statements, ROW_READ)).toBe(1);
    }
  });
});

describe('drillDown', () => {
  it('reads one query per DAG level, not one per parent', async () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-drill');
      const summary = memory('summary of the zephyrine cache work', { dag_level: 2, layer: Layer.Semantic });
      const mids = rows(n, 'mid', { dag_level: 1, dag_parent_id: summary.id });
      const leaves = mids.map((m, i) => memory(`leaf ${i} under the zephyrine cache`, { dag_level: 0, dag_parent_id: m.id }));
      seed(root, [summary, ...mids, ...leaves]);
      const { result, statements } = await recordStatementsAsync(() => drillDown(ctxFor(root), summary.id, { depth: 2, limit: 1000 }));
      expect('failure' in result ? result.failure : result.totalChildren).toBe(2 * n);
      expect(countMatching(statements, STORE_OPEN)).toBe(1);
      expect(countMatching(statements, ROW_READ)).toBe(3);
    }
  });

  it('reads whole rows for the page only, however many children the summary has', async () => {
    const read: number[] = [];
    for (const n of SIZES) {
      const root = freshRoot('qc-drill-page');
      const summary = memory('summary of the zephyrine cache work', { dag_level: 2, layer: Layer.Semantic });
      // Newest first on disk, so the page is the oldest five only if the read sorts by created.
      const children = Array.from({ length: n }, (_, i) => memory(`child ${i} of the zephyrine cache`, {
        dag_level: 1, dag_parent_id: summary.id, created: new Date(Date.UTC(2026, 0, 1, 0, 0, n - i)).toISOString(),
      }));
      seed(root, [summary, ...children]);
      const { result, rowsRead } = await recordStatementsAsync(() => drillDown(ctxFor(root), summary.id, { limit: 5 }));
      if ('failure' in result) throw new Error(result.failure);
      expect(result.children.map((c) => c.id)).toEqual(children.slice(-5).reverse().map((c) => c.id));
      expect({ total: result.totalChildren, truncated: result.truncated }).toEqual({ total: n, truncated: true });
      read.push(rowsRead);
    }
    expect(read[1]).toBe(read[0]);
  });

  it('finds children through the parent index, with a page and without one', async () => {
    const root = freshRoot('qc-drill-plan');
    const summary = memory('summary of the zephyrine cache work', { dag_level: 2, layer: Layer.Semantic });
    const mids = rows(3, 'mid', { dag_level: 1, dag_parent_id: summary.id });
    seed(root, [summary, ...mids, ...mids.map((m, i) => memory(`leaf ${i}`, { dag_level: 0, dag_parent_id: m.id }))]);
    const { statements } = await recordStatementsAsync(async () => {
      await drillDown(ctxFor(root), summary.id, { depth: 2, limit: 4 });
      await drillDown(ctxFor(root), summary.id, { depth: 2, limit: Number.POSITIVE_INFINITY });
    });
    const childReads = [...new Set(statements.filter((sql) => sql.includes('WHERE dag_parent_id IN (')))];
    expect(childReads.length).toBeGreaterThanOrEqual(5);
    const db = openStore(root);
    try {
      for (const sql of childReads) {
        // SAFETY: EXPLAIN QUERY PLAN answers one row per step, its text in `detail`.
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((step) => step.detail);
        expect(plan[0], sql).toBe('SEARCH memories USING INDEX idx_memories_dag_parent (dag_parent_id=?)');
      }
    } finally {
      closeHippoDb(db);
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
    const stamp = `t <t@example.com> ${Math.floor(Date.now() / 1000)} +0000`;
    const commits = Array.from({ length: lessons }, (_, i) => {
      const message = `fix: replace quuxlib client with fetch wrapper ${i} in src/api${i}.ts`;
      return `commit refs/heads/main\ncommitter ${stamp}\ndata ${Buffer.byteLength(message)}\n${message}\n`;
    });
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: repo, stdio: 'ignore' });
    // One fast-import writes every commit, where a `git commit` each costs a process spawn.
    execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: commits.join('\n'), stdio: ['pipe', 'ignore', 'ignore'] });
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

describe('buildDag', () => {
  it('re-links a cluster in one transaction on one handle, each member keeping its audit row and mirror', async () => {
    const work: number[][] = [];
    for (const n of SIZES) {
      const root = freshRoot('qc-dag-link');
      const facts = rows(n, 'fact', { tags: ['extracted', 'speaker:alice'], dag_level: 1 });
      seed(root, facts);
      const mirrorsRewritten = ageMirrors(root);
      const fetcher: typeof fetch = async () => new Response(JSON.stringify({ content: [{ text: 'alice keeps the zephyrine cache warm across every deploy' }] }), { status: 200 });
      const { result, statements } = await recordStatementsAsync(() => buildDag(root, facts, { apiKey: 'test-key', fetcher }));
      expect(result).toMatchObject({ summariesCreated: 1, factsLinked: n });
      const stored = loadAllEntries(root);
      const parentId = stored.find((e) => e.dag_level === 2)?.id;
      expect(stored.filter((e) => e.dag_parent_id === parentId)).toHaveLength(n);
      expect(mirrorsRewritten()).toBe(n);
      const db = openStore(root);
      try {
        // SAFETY: one row with the single aliased count column.
        const audited = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE op = 'remember' AND target_id IN (SELECT id FROM memories WHERE dag_parent_id = ?)`).get(String(parentId)) as { n: number };
        expect(audited.n).toBe(2 * n);
      } finally {
        closeHippoDb(db);
      }
      work.push([countMatching(statements, STORE_OPEN), countMatching(statements, 'BEGIN IMMEDIATE')]);
    }
    expect(work[1]).toEqual(work[0]);
  });
});

describe('buildMemoryDetail', () => {
  it('reads the conflicts naming a memory and their other sides in a fixed number of queries', () => {
    const work = SIZES.map((n) => {
      const root = freshRoot('qc-detail');
      const [subject, ...others] = rows(n + 1, 'detail');
      seed(root, [subject, ...others]);
      replaceDetectedConflicts(root, [
        ...others.map((e) => ({ memory_a_id: subject.id, memory_b_id: e.id, reason: 'names the subject', score: 0.9 })),
        { memory_a_id: others[0].id, memory_b_id: others[1].id, reason: 'between two others', score: 0.8 },
      ]);
      const { result, statements } = recordStatements(() => buildMemoryDetail(root, 'default', subject, { snapshotId: 1, nowMs: Date.now(), embedded: false }));
      expect(result.conflicts.map((c) => c.other.id).sort()).toEqual(others.map((e) => e.id).sort());
      expect(result.conflicts.every((c) => c.reason === 'names the subject')).toBe(true);
      return [countMatching(statements, STORE_OPEN), countMatching(statements, ROW_READ)];
    });
    expect(work[1]).toEqual(work[0]);
  });
});

describe('the dashboard snapshot build', () => {
  it('reads no whole row, and no row at all for a memory it leaves out', () => {
    const read: number[] = [];
    for (const n of SIZES) {
      const root = freshRoot('qc-dash-build');
      seed(root, [...rows(4, 'live'), ...rows(n, 'archived', { kind: 'archived' }), ...rows(n, 'replaced', { kind: 'superseded' })]);
      const service = createSnapshotService(root, () => Date.now());
      try {
        const { result, statements, rowsRead } = recordStatements(() => service.get('default'));
        expect(result.facts).toHaveLength(4);
        expect(result.excluded).toEqual({ superseded: n, archived: n, quarantined: 0 });
        expect(countMatching(statements, ROW_READ)).toBe(0);
        read.push(rowsRead);
      } finally {
        service.close();
      }
    }
    expect(read[1]).toBe(read[0]);
  });
});

describe('hippo_status', () => {
  it('tallies in SQL, so rows read stay flat, and counts only its tenant\'s open conflicts', async () => {
    const read: number[] = [];
    for (const n of SIZES) {
      const root = freshRoot('qc-status');
      const own = [
        ...rows(n - 3, 'status'),
        memory('status row long faded', { last_retrieved: '2020-01-01T00:00:00.000Z', half_life_days: 1 }),
        memory('status row pinned', { pinned: true, tags: ['errors-seen'] }),
        memory('status row tagged as an error', { tags: ['deploy', 'error'] }),
      ];
      const elsewhere = rows(2, 'elsewhere', { tenantId: 'other' });
      seed(root, [...own, ...elsewhere]);
      replaceDetectedConflicts(root, [
        { memory_a_id: own[0].id, memory_b_id: own[1].id, reason: 'own pair', score: 0.9 },
        { memory_a_id: elsewhere[0].id, memory_b_id: elsewhere[1].id, reason: 'other tenant pair', score: 0.9 },
      ]);
      const { result, rowsRead } = await recordStatementsAsync(() => handleMcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_status', arguments: {} } },
        { hippoRoot: root, tenantId: 'default', actor: 'tester', clientKey: 'client-1' },
      ));
      const reply = JSON.stringify(result);
      expect(reply).toContain(`Memories: ${n} (1 pinned, 1 errors)`);
      expect(reply).toContain('At risk (<0.1): 1\\n');
      expect(reply).toContain('Open conflicts: 1\\n');
      read.push(rowsRead);
    }
    expect(read[1]).toBe(read[0]);
  });
});

describe('writeSessionDigest', () => {
  it('reads no full row to find the text hippo could have injected', () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-digest');
      seed(root, rows(n, 'digest'));
      const scan = {
        turns: [{ role: 'user' as const, text: 'the upload keeps failing overnight' }],
        finalText: 'Retry `upload()` with backoff because the storage token expires mid-transfer.',
        cwd: path.dirname(root),
        edits: [],
      };
      const { result, statements } = recordStatements(() => writeSessionDigest(root, scan, { key: 's1', tenantId: 'default' }));
      expect(result.written).toBe(true);
      expect(countMatching(statements, TENANT_READ)).toBe(0);
    }
  });
});

describe('an id-list read of one tenant', () => {
  it('seeks each id on the primary key, never walking every row of the tenant', () => {
    const root = freshRoot('qc-id-plan');
    const entries = rows(10, 'plan');
    seed(root, entries);
    const ids = entries.map((e) => e.id);
    const { result, statements } = recordStatements(() => {
      outcome(ctxFor(root), ids, true);
      return { held: heldIdLookup(root, 'default', ids)(ids[0]), listed: loadEntriesByIds(root, ids, 'default').length };
    });
    expect(result).toEqual({ held: true, listed: 10 });

    const idReads = [...new Set(statements.filter((sql) => sql.includes('FROM memories WHERE id IN (')))];
    expect(idReads).toHaveLength(3);
    const db = openStore(root);
    try {
      for (const sql of idReads) {
        // SAFETY: EXPLAIN QUERY PLAN answers one row per step, its text in `detail`.
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((step) => step.detail);
        expect(plan[0], sql).toBe('SEARCH memories USING INDEX sqlite_autoindex_memories_1 (id=?)');
      }
    } finally {
      closeHippoDb(db);
    }
  });
});
