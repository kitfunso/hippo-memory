// Per-row query counts of the maintenance passes: import, invalidate, churn, conflicts, dedupe, learn and the summary DAG.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { recordStatements, recordStatementsAsync, countMatching, STORE_OPEN } from '../_helpers/count-statements.js';
import { closeHippoDb } from '../../src/db/index.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { cliRequest } from '../../src/surface/cli/api-context.js';
import { learn, CLI_LEARN } from '../../src/api/sleep/learn.js';
import { importEntries, importVault } from '../../src/entry/importers.js';
import { invalidateMatching, detectChurnStale } from '../../src/domain/learn/invalidation.js';
import { deduplicateStore } from '../../src/domain/consolidate/dedupe.js';
import { buildDag } from '../../src/domain/consolidate/dag.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import {
  listMemoryConflicts,
  replaceDetectedConflicts,
  resolveConflictKeeping,
  loadAllEntries,
} from '../_helpers/root-forms.js';
import { openStore } from '../../src/store/sqlite/handles.js';
import {
  ROW_READ,
  SIZES,
  TENANT_READ,
  ageMirrors,
  ctxFor,
  freshRoot,
  memory,
  rows,
  seed,
  useQueryCountRoots,
} from '../_helpers/query-count-seeds.js';
import { processGit } from '../../src/base/util/git-runner.js';

useQueryCountRoots();

describe('importEntries', () => {
  it('opens the target store a fixed number of times however many chunks land', () => {
    const opens = SIZES.map((n) => {
      const root = freshRoot('qc-import');
      const chunks = Array.from({ length: n }, (_, i) => `imported chunk ${i} about the zephyrine cache`);
      const { result, statements } = recordStatements(() =>
        importEntries(chunks, 'import:test', ['imported'], { hippoRoot: root, tenantId: 'default' }),
      );
      expect(result.imported).toBe(n);
      return countMatching(statements, STORE_OPEN);
    });
    expect(opens[1]).toBe(opens[0]);
  });

  it('probes a dry run on a fixed number of opens too', () => {
    const opens = SIZES.map((n) => {
      const root = freshRoot('qc-import-dry');
      const chunks = Array.from({ length: n }, (_, i) => `previewed chunk ${i} about the zephyrine cache`);
      const { result, statements } = recordStatements(() =>
        importEntries(chunks, 'import:test', ['imported'], { hippoRoot: root, tenantId: 'default', dryRun: true }),
      );
      expect(result.imported).toBe(n);
      return countMatching(statements, STORE_OPEN);
    });
    expect(opens[1]).toBe(opens[0]);
  });
});

describe('importVault', () => {
  it('probes a dry run on a fixed number of opens however many notes changed', async () => {
    const opens: number[] = [];
    for (const n of SIZES) {
      const root = freshRoot('qc-vault-dry');
      const vault = path.join(freshRoot('qc-vault-notes'), 'notes');
      fs.mkdirSync(vault);
      for (let i = 0; i < n; i++) {
        fs.writeFileSync(path.join(vault, `note-${i}.md`), `vault note ${i} about the zephyrine cache`);
      }
      const { result, statements } = await recordStatementsAsync(() =>
        importVault(vault, { hippoRoot: root, tenantId: 'default', name: 'notes', dryRun: true }),
      );
      expect(result.imported).toBe(n);
      opens.push(countMatching(statements, STORE_OPEN));
    }
    expect(opens[1]).toBe(opens[0]);
  });
});

describe('invalidateMatching', () => {
  it('weakens every match on one store handle', async () => {
    const opens: number[] = [];
    for (const n of SIZES) {
      const root = freshRoot('qc-invalidate');
      seed(ctxFor(root), rows(n, 'invalidate', { tags: ['oldlib'] }));
      const target = { from: 'oldlib', to: null, type: 'removal' as const };
      const { result, statements } = await recordStatementsAsync(() =>
        invalidateMatching(sqliteStore(root), target, 'default'),
      );
      expect(result.invalidated).toBe(n);
      opens.push(countMatching(statements, STORE_OPEN));
    }
    expect(opens[1]).toBe(opens[0]);
  });
});

describe('detectChurnStale', () => {
  it('tags every stale memory with one batched read on one handle', async () => {
    const repo = freshRoot('qc-churn-repo');
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: repo,
        stdio: 'ignore',
      });
    };
    const commitAt = (iso: string): void => {
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-am', 'c', '--allow-empty'],
        {
          cwd: repo,
          stdio: 'ignore',
          env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
        },
      );
    };
    git('init');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'v1');
    git('add', 'a.ts');
    commitAt('2025-12-20T00:00:00.000Z');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'v2');
    commitAt('2026-01-10T00:00:00.000Z');

    const counts: { opens: number; reads: number }[] = [];
    for (const n of SIZES) {
      const root = freshRoot('qc-churn');
      seed(
        ctxFor(root),
        rows(n, 'see a.ts for the setup', { created: '2026-01-01T00:00:00.000Z', originProject: 'qcproj' }),
      );
      const { result, statements } = await recordStatementsAsync(() =>
        detectChurnStale(
          sqliteStore(root),
          { root: repo, git: processGit },
          {
            tenantId: 'default',
            projectName: 'qcproj',
          },
        ),
      );
      expect(result.marked).toBe(n);
      counts.push({ opens: countMatching(statements, STORE_OPEN), reads: countMatching(statements, ROW_READ) });
    }
    expect(counts[1]).toEqual(counts[0]);
  });
});

describe('replaceDetectedConflicts', () => {
  it('rewrites only the rows and mirrors whose conflict list changed', () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-conflicts');
      const entries = rows(n, 'conflict');
      seed(ctxFor(root), entries);
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
      seed(ctxFor(root), entries);
      replaceDetectedConflicts(root, [
        { memory_a_id: entries[0].id, memory_b_id: entries[1].id, reason: 'test', score: 0.9 },
      ]);
      const [conflict] = listMemoryConflicts(root);
      const mirrorsRewritten = ageMirrors(root);
      expect(resolveConflictKeeping(root, 'default', conflict.id, conflict.memory_a_id)).toBe(true);
      expect(mirrorsRewritten()).toBe(2);
    }
  });
});

describe('deduplicateStore', () => {
  it('deletes every duplicate on one store handle', async () => {
    const opens: number[] = [];
    for (const n of SIZES) {
      const root = freshRoot('qc-dedupe');
      const originals = rows(n, 'dedupe');
      seed(ctxFor(root), [...originals, ...originals.map((e) => memory(e.content))]);
      const { result, statements } = await recordStatementsAsync(() => deduplicateStore(sqliteStore(root)));
      expect(result.removed).toBe(n);
      opens.push(countMatching(statements, STORE_OPEN));
    }
    expect(opens[1]).toBe(opens[0]);
  });
});

describe('learn', () => {
  /** A repo whose last `lessons` commits each replace the quuxlib client, so each lesson invalidates what mentions it. */
  function repoWith(lessons: number, subject = 'replace quuxlib client with fetch wrapper'): string {
    const repo = freshRoot('qc-learn-repo');
    const stamp = `t <t@example.com> ${Math.floor(Date.now() / 1000)} +0000`;
    const commits = Array.from({ length: lessons }, (_, i) => {
      const message = `fix: ${subject} ${i} in src/api${i}.ts`;
      return `commit refs/heads/main\ncommitter ${stamp}\ndata ${Buffer.byteLength(message)}\n${message}\n`;
    });
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: repo, stdio: 'ignore' });
    // One fast-import writes every commit, where a `git commit` each costs a process spawn.
    execFileSync('git', ['fast-import', '--quiet'], {
      cwd: repo,
      input: commits.join('\n'),
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    return repo;
  }

  async function learnInto(repo: string, n: number, pageRows?: number) {
    const root = freshRoot('qc-learn');
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { enabled: false } }));
    seed(ctxFor(root), [
      ...rows(n, 'learn'),
      memory('the quuxlib client retries twice'),
      memory('quuxlib client timeouts are 30s'),
    ]);
    const { result, statements } = await recordStatementsAsync(() =>
      cliRequest(() => learn(ctxFor(root), { repoPath: repo, days: 7, profile: CLI_LEARN, pageRows, git: processGit })),
    );
    return {
      root,
      result,
      statements,
      opens: countMatching(statements, STORE_OPEN),
      tenantReads: countMatching(statements, TENANT_READ),
    };
  }

  it('opens the store and reads the tenant once per batch, however many lessons or rows', async () => {
    const one = repoWith(1);
    const ten = repoWith(10);
    const counts: number[] = [];
    for (const n of SIZES) {
      const single = await learnInto(one, n);
      const batch = await learnInto(ten, n);
      expect(single.result.added).toBe(1);
      expect(batch.result.added).toBe(10);
      expect(batch.tenantReads).toBe(1);
      expect(batch.opens).toBe(single.opens);
      counts.push(batch.opens);
    }
    expect(counts[1]).toBe(counts[0]);
  });

  it('reads the tenant in pages and answers as one unpaged read did', async () => {
    const repo = repoWith(3);
    const unpaged = await learnInto(repo, 10);
    const paged = await learnInto(repo, 10, 4);
    // 12 rows at 4 per page is three reads, where the default page holds the tenant in one.
    expect(unpaged.tenantReads).toBe(1);
    expect(paged.tenantReads).toBe(3);
    expect(paged.result).toEqual(unpaged.result);
  });

  it('commits lessons that invalidate nothing in one write transaction, however many there are', async () => {
    const writes = async (lessons: number): Promise<number> => {
      const { result, statements } = await learnInto(repoWith(lessons, 'handle the retry timeout'), 10);
      expect(result.added).toBe(lessons);
      return countMatching(statements, /^BEGIN IMMEDIATE$/);
    };
    const [one, ten] = [await writes(1), await writes(10)];
    expect(ten).toBe(one);
  });

  it('a later lesson still invalidates a lesson written earlier in the batch', async () => {
    const { root, result } = await learnInto(repoWith(3), 10);
    // Each lesson names the quuxlib client, so the second and third also weaken the lessons before them.
    expect(result.invalidations.map((i) => i.count)).toEqual([2, 3, 4]);
    const lessons = loadAllEntries(root, 'default').filter((e) => e.source === CLI_LEARN.source);
    const base = lessons.find((e) => !e.tags.includes('invalidated'))?.halfLifeDays ?? 0;
    expect(lessons.map((e) => e.halfLifeDays).sort((a, b) => a - b)).toEqual([
      Math.floor(Math.floor(base / 2) / 2),
      Math.floor(base / 2),
      base,
    ]);
    expect(lessons.filter((e) => e.confidence === 'stale')).toHaveLength(2);
  });
});

describe('buildDag', () => {
  it('re-links a cluster in one transaction on one handle, each member keeping its audit row and mirror', async () => {
    const work: number[][] = [];
    for (const n of SIZES) {
      const root = freshRoot('qc-dag-link');
      const facts = rows(n, 'fact', { tags: ['extracted', 'speaker:alice'], dagLevel: 1 });
      seed(ctxFor(root), facts);
      const mirrorsRewritten = ageMirrors(root);
      const fetcher: typeof fetch = async () =>
        new Response(
          JSON.stringify({ content: [{ text: 'alice keeps the zephyrine cache warm across every deploy' }] }),
          { status: 200 },
        );
      const { result, statements } = await recordStatementsAsync(() =>
        buildDag(sqliteStore(root), facts, {
          baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
          apiKey: 'test-key',
          fetcher,
        }),
      );
      expect(result).toMatchObject({ summariesCreated: 1, factsLinked: n });
      const stored = loadAllEntries(root, 'default');
      const parentId = stored.find((e) => e.dagLevel === 2)?.id;
      expect(stored.filter((e) => e.dagParentId === parentId)).toHaveLength(n);
      expect(mirrorsRewritten()).toBe(n);
      const db = openStore(root);
      try {
        // SAFETY: one row with the single aliased count column.
        const audited = db
          .prepare(
            `SELECT COUNT(*) AS n FROM audit_log WHERE op = 'remember' AND target_id IN (SELECT id FROM memories WHERE dag_parent_id = ?)`,
          )
          .get(String(parentId)) as { n: number };
        expect(audited.n).toBe(2 * n);
      } finally {
        closeHippoDb(db);
      }
      work.push([countMatching(statements, STORE_OPEN), countMatching(statements, 'BEGIN IMMEDIATE')]);
    }
    expect(work[1]).toEqual(work[0]);
  });
});
