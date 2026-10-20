// `hippo projects` list, merge and repair plan on a store of several projects, imports, sleep-merged rows and dormant
// snapshots: the answers the whole-tenant read gave, from reads that skip the rows each one does not touch.
import { beforeEach, describe, expect, it } from 'vitest';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { insertDormantRow } from '../../src/store/sqlite/dormant-rows.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import type { ProjectTagStore } from '../../src/store/port/project-tags.js';
import { listProjects, mergeProjects, planProjectRepair } from '../../src/domain/sharing/project-merge.js';
import { mergedText } from '../../src/base/util/same-text.js';
import { recordStatements } from '../_helpers/count-statements.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';

const T = 'default';
const HEADER = '[Consolidated from 2 related memories, newest first]';
const DEPLOY = 'the deploy script needs node 22 or newer';
const HOME = 'the home folder note every session can see';
const at = (i: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();

let root: string;
beforeEach(() => {
  root = makeRoot('project-tag-reads');
});

function withDb<R>(fn: (db: DatabaseSyncLike) => R): R {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

const withStore = <R>(fn: (store: ProjectTagStore) => R): R =>
  sqliteSyncStore(root).localFiles.projectTags.on({ tenantId: T, actor: 'test' }, fn);

const memory = (content: string, origin: string | null, i: number, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  ...createMemory(content, { layer: Layer.Semantic }),
  originProject: origin,
  created: at(i),
  ...extra,
});

const note = (content: string, origin: string, i: number, extra: Partial<MemoryEntry> = {}): MemoryEntry =>
  memory(content, origin, i, {
    source: `agent-memory:claude-code:p-0123456789ab/${content.slice(0, 12).replace(/ /g, '-')}.md#abc`,
    tags: ['claude-code-memory'],
    ...extra,
  });

const merged = (i: number, parents: readonly string[], extra: Partial<MemoryEntry> = {}): MemoryEntry =>
  memory(mergedText(HEADER, [`merge ${i} part one`, `merge ${i} part two`]), '', i, {
    source: 'consolidation',
    parents: [...parents],
    ...extra,
  });

/** Rows by their place in store order, and the dormant parent; r[8] shares r[7]'s time, so two projects tie. */
function seed() {
  const faded = memory('a faded worktree lesson about the cache', 'repo-wt-a', 10);
  const r: MemoryEntry[] = [
    note(DEPLOY, 'repo', 0),
    note(DEPLOY, 'repo-wt-a', 1),
    note('the release notes live in changelog.d', 'repo-wt-a', 2),
    memory('the flaky sync test needs a fresh temp dir', 'repo-wt-a', 3),
    note('an old copy of a release note', 'repo-wt-a', 4, { supersededBy: 'mem_newer' }),
    memory('an unrelated project memory', 'elsewhere', 5),
    note(HOME, '', 6),
    note(HOME, 'elsewhere', 7),
    memory('a lesson saved with no project', null, 7),
    memory('another tenant lesson', 'repo-wt-a', 9, { tenantId: 'other' }),
  ];
  r.push(
    merged(11, [r[3].id, r[5].id]),
    merged(12, [r[2].id, faded.id]),
    merged(13, ['mem_gone']),
    merged(14, [faded.id]),
    merged(15, [r[6].id]),
    merged(16, [r[9].id]),
    merged(17, [r[3].id], { supersededBy: 'mem_newer' }),
  );
  withDb((db) => {
    for (const entry of r) writeEntryDbOnly(db, entry);
    insertDormantRow(db, { entry: faded, strength: 0.1, reason: 'decay', dormantAt: at(20) });
    db.prepare(
      `INSERT INTO compactions (tenant_id, id, session_id, origin_project, compact_trigger, cwd, started_at) ` +
        `VALUES (?, 'c1', 's1', 'repo-wt-a', 'auto', '/x', ?)`,
    ).run(T, at(21));
  });
  return { r, faded };
}

/** Rows and snapshots of a project no call below touches, written in one transaction. */
function addBystanders(n: number): void {
  withDb((db) => {
    db.exec('BEGIN');
    for (let k = 0; k < n; k++) {
      writeEntryDbOnly(db, memory(`bystander ${k} about the build cache`, 'elsewhere', 100 + k));
      const snapshot = memory(`bystander snapshot ${k}`, 'elsewhere', 100 + k);
      insertDormantRow(db, { entry: snapshot, strength: 0.1, reason: 'decay', dormantAt: at(100 + k) });
    }
    db.exec('COMMIT');
  });
}

describe('hippo projects reads', () => {
  it('lists live rows, imports and copies per project, newest first, a tie in first-seen order', () => {
    seed();

    expect(withStore(listProjects)).toEqual([
      { origin: '', live: 7, imported: 1, newest: at(16), copiesElsewhere: 1 },
      { origin: 'elsewhere', live: 2, imported: 1, newest: at(7), copiesElsewhere: 1 },
      { origin: null, live: 1, imported: 0, newest: at(7), copiesElsewhere: 0 },
      { origin: 'repo-wt-a', live: 3, imported: 2, newest: at(3), copiesElsewhere: 1 },
      { origin: 'repo', live: 1, imported: 1, newest: at(0), copiesElsewhere: 1 },
    ]);
  });

  it('merges one tenant: sets aside the note the target holds, re-tags the rest, snapshots and compactions', () => {
    const { r, faded } = seed();
    const expected = {
      from: 'repo-wt-a',
      into: 'repo',
      setAside: [r[1].id],
      restamped: [r[2].id, r[3].id, r[4].id],
      dormantRestamped: [faded.id],
      compactions: 1,
    };

    const dry = withStore((store) => mergeProjects(store, { from: 'repo-wt-a', into: 'repo', dryRun: true }));
    expect(dry).toEqual({ ...expected, backup: null });
    const done = withStore((store) => mergeProjects(store, { from: 'repo-wt-a', into: 'repo', dryRun: false }));
    expect(done).toMatchObject(expected);
    expect(withStore(listProjects).find((p) => p.origin === 'repo')).toMatchObject({ live: 3, imported: 2 });
  });

  it('plans the repair from the user-global merges, their parents live or dormant, and copied imports', () => {
    const { r } = seed();

    expect(withStore((store) => planProjectRepair(store, root))).toEqual({
      copies: [r[7].id],
      folds: [],
      collisions: [],
      toProject: [
        { id: r[11].id, origin: 'repo-wt-a' },
        { id: r[13].id, origin: 'repo-wt-a' },
      ],
      setAside: [r[10].id],
      untraced: [r[12].id, r[15].id],
    });
  });

  it('reads no more rows with 300 rows and snapshots of a project none of them touches', () => {
    seed();
    const rowsRead = (): number[] =>
      withStore((store) => [
        recordStatements(() => listProjects(store)).rowsRead,
        recordStatements(() => mergeProjects(store, { from: 'repo-wt-a', into: 'repo', dryRun: true })).rowsRead,
        recordStatements(() => planProjectRepair(store, root)).rowsRead,
      ]);
    const before = rowsRead();

    addBystanders(300);

    expect(rowsRead()).toEqual(before);
  });
});
