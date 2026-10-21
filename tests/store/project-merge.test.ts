/** `hippo projects` merge and repair: fold an old worktree name into its repo, set aside copies, re-tag sleep's user-global merges, reversibly. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { toWire } from '../../src/base/memory/memory-wire.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import {
  closeHippoDb,
  currentRequestStores,
  getCurrentSchemaVersion,
  getSchemaVersion,
  openHippoDb,
  openHippoDbReadOnly,
  setMeta,
  type DatabaseSyncLike,
} from '../../src/db/index.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import { listDormantSnapshots } from '../_helpers/dormant-snapshots.js';
import { projectNameList, projectNameMerge, projectNameRepair } from '../../src/api/objects/projects.js';
import { cliApiContext } from '../../src/surface/cli/api-context.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

afterEach(() => {
  vi.unstubAllEnvs();
});

let home: string;
let db: DatabaseSyncLike;
beforeEach(() => {
  home = makeRoot('project-merge', { init: false });
  initTestStore(home);
});
afterEach(() => {
  closeHippoDb(db);
});

const T = 'default';
const row = (text: string, origin: string | null, extra: Partial<MemoryEntry> = {}): MemoryEntry => {
  const entry = { ...createMemory(text, { layer: Layer.Semantic }), originProject: origin, ...extra };
  writeEntry(home, entry);
  return entry;
};
const note = (text: string, origin: string, extra: Partial<MemoryEntry> = {}): MemoryEntry =>
  row(text, origin, {
    source: `agent-memory:claude-code:p-0123456789ab/${text.slice(0, 8)}.md#abc`,
    tags: ['claude-code-memory'],
    ...extra,
  });
const byId = () => new Map(loadAllEntries(home, 'default').map((e) => [e.id, e]));
const open = () => (db = openHippoDb(home));
const ctx = () => cliApiContext(home, T);
function mirror(id: string): string | null {
  const walk = (dir: string): string | null => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        const hit = walk(p);
        if (hit) return hit;
      } else if (name === `${id}.md`) return readFileSync(p, 'utf8');
    }
    return null;
  };
  return walk(home);
}

describe('hippo projects merge', () => {
  it('sets aside only notes the target already holds, re-tags everything else, and a dry run writes nothing', async () => {
    const held = note('the deploy script needs node 22 or newer', 'repo');
    const copy = note('the deploy script needs node 22 or newer', 'repo-wt-a');
    const kept = note('the release notes live in changelog.d', 'repo-wt-a');
    const pinned = note('never force-push the release branch', 'repo-wt-a', { pinned: true });
    const lesson = row('the flaky sync test needs a fresh temp dir', 'repo-wt-a');
    const other = row('an unrelated project memory', 'elsewhere');
    open();

    const dry = await projectNameMerge(ctx(), { from: 'repo-wt-a', into: 'repo', dryRun: true });
    expect(dry.setAside).toEqual([copy.id]);
    expect(byId().get(lesson.id)!.originProject).toBe('repo-wt-a');
    expect(dry.backup).toBeNull();

    const r = await projectNameMerge(ctx(), { from: 'repo-wt-a', into: 'repo', dryRun: false });
    const rows = byId();
    expect(rows.has(copy.id)).toBe(false);
    expect(listDormantSnapshots(db, T).find((s) => s.entry.id === copy.id)!.entry.originProject).toBe('repo');
    expect(rows.get(held.id)!.originProject).toBe('repo');
    // The next sync renames its container prefix, so the import keeps its id, source and tag.
    expect(rows.get(kept.id)).toMatchObject({
      originProject: 'repo',
      source: kept.source,
      tags: ['claude-code-memory'],
    });
    expect(rows.get(pinned.id)!.originProject).toBe('repo');
    expect(rows.get(pinned.id)!.tags).toContain('claude-code-memory');
    expect(rows.get(lesson.id)!.originProject).toBe('repo');
    expect(rows.get(other.id)!.originProject).toBe('elsewhere');
    expect(mirror(lesson.id)).toContain('origin_project: repo');
    expect(mirror(copy.id)).toBeNull();
    expect(existsSync(r.backup!)).toBe(true);
    // SAFETY: the SELECT names the one column of the row type.
    const audit = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'project_merge'`).all() as Array<{
      metadata_json: string;
    }>;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].metadata_json).restamped).toEqual(
      expect.arrayContaining([lesson.id, pinned.id, kept.id]),
    );
  });

  it('refuses user-global and unknown as either side', async () => {
    open();
    await expect(projectNameMerge(ctx(), { from: '', into: 'repo', dryRun: true })).rejects.toThrow(/user-global/);
    await expect(projectNameMerge(ctx(), { from: 'repo-wt-a', into: ' ', dryRun: true })).rejects.toThrow(
      /user-global/,
    );
  });

  it('re-tags dormant rows and compaction records too, so a restore does not come back hidden', async () => {
    open();
    const faded = createMemory('a faded worktree lesson about the cache', { layer: Layer.Semantic });
    db.prepare(
      `INSERT INTO dormant_memories (tenant_id, id, content, entry_json, reason, strength, dormant_at) VALUES (?, ?, ?, ?, 'decay', 0.01, ?)`,
    ).run(
      T,
      faded.id,
      faded.content,
      JSON.stringify({ ...toWire(faded), origin_project: 'repo-wt-a' }),
      new Date().toISOString(),
    );
    db.prepare(
      `INSERT INTO compactions (tenant_id, id, session_id, origin_project, compact_trigger, cwd, started_at) VALUES (?, 'c1', 's1', 'repo-wt-a', 'auto', '/x', ?)`,
    ).run(T, new Date().toISOString());

    const r = await projectNameMerge(ctx(), { from: 'repo-wt-a', into: 'repo', dryRun: false });

    expect(r.dormantRestamped).toEqual([faded.id]);
    expect(r.compactions).toBe(1);
    expect(listDormantSnapshots(db, T)[0].entry.originProject).toBe('repo');
  });
});

describe('hippo projects repair', () => {
  it('re-tags by parents: one project, two projects; leaves an untraceable or truly user-global merge alone', async () => {
    const b1 = row('proj-b parent one', 'proj-b');
    const b2 = row('proj-b parent two', 'proj-b');
    const c1 = row('proj-c parent', 'proj-c');
    const g1 = row('user-global parent', '');
    const merged = (parents: string[]) =>
      row(`merged from ${parents.join(' ')}`, '', { source: 'consolidation', parents });
    const one = merged([b1.id, b2.id]);
    const two = merged([b1.id, c1.id]);
    const none = merged(['mem_gone']);
    const global = merged([g1.id]);
    open();

    expect((await projectNameRepair(ctx(), { dryRun: true })).toProject).toEqual([{ id: one.id, origin: 'proj-b' }]);
    expect(byId().get(one.id)!.originProject).toBe('');

    const r = await projectNameRepair(ctx(), { dryRun: false });
    const rows = byId();
    expect(rows.get(one.id)!.originProject).toBe('proj-b');
    expect(rows.has(two.id)).toBe(false);
    expect(r.setAside).toEqual([two.id]);
    expect(r.untraced).toEqual([none.id]);
    expect(rows.get(none.id)!.originProject).toBe('');
    expect(rows.get(global.id)!.originProject).toBe('');
    expect(mirror(one.id)).toContain('origin_project: proj-b');
    expect(mirror(two.id)).toBeNull();
  });

  it('repairs exactly the two re-tagged and two set-aside rows and leaves the other rows of the store as they were', async () => {
    const b1 = row('proj-b parent one', 'proj-b');
    const b2 = row('proj-b parent two', 'proj-b');
    const c1 = row('proj-c parent', 'proj-c');
    const bystanders = Array.from({ length: 5 }, (_, i) => row(`bystander ${i}`, `proj-x${i}`));
    const merged = (parents: string[]) =>
      row(`merged from ${parents.join(' ')}`, '', { source: 'consolidation', parents });
    const tagged = [merged([b1.id]), merged([b2.id])];
    const aside = [merged([b1.id, c1.id]), merged([b2.id, c1.id])];
    open();

    const r = await projectNameRepair(ctx(), { dryRun: false });
    const rows = byId();
    expect(r.toProject.map((p) => p.id).sort()).toEqual(tagged.map((e) => e.id).sort());
    expect(r.setAside.slice().sort()).toEqual(aside.map((e) => e.id).sort());
    for (const e of tagged) expect(rows.get(e.id)!.originProject).toBe('proj-b');
    for (const e of aside) expect(rows.has(e.id)).toBe(false);
    for (const e of [b1, b2, c1, ...bystanders]) expect(rows.get(e.id)!.originProject).toBe(e.originProject);
    expect(mirror(tagged[0].id)).toContain('origin_project: proj-b');
    expect(mirror(aside[0].id)).toBeNull();
  });

  it('sets aside a project-tagged import whose text, spacing aside, a user-global import holds, and nothing else', async () => {
    note('the home folder note every session can see', '');
    const copy = note('the home folder note every session can see', 'repo-wt-a');
    const own = note('a note only this worktree imported', 'repo-wt-a');
    note('a home note\nreflowed since', '');
    const reflowed = note('a home note reflowed  since', 'repo-wt-a');
    const saved = row('the home folder note every session can see', 'repo-wt-a');
    open();

    const dry = await projectNameRepair(ctx(), { dryRun: true });
    expect([...dry.copies].sort()).toEqual([copy.id, reflowed.id].sort());
    expect(byId().has(copy.id)).toBe(true);

    const r = await projectNameRepair(ctx(), { dryRun: false });
    const rows = byId();
    expect([...r.copies].sort()).toEqual([copy.id, reflowed.id].sort());
    expect([rows.has(copy.id), rows.has(own.id), rows.has(saved.id)]).toEqual([false, true, true]);
    expect(
      listDormantSnapshots(db, T)
        .map((s) => s.entry.id)
        .sort(),
    ).toEqual([copy.id, reflowed.id].sort());
    expect(mirror(copy.id)).toBeNull();
  });

  it('in the global store, folds a name whose every recorded folder still on disk resolves to one other project', async () => {
    vi.stubEnv('HIPPO_HOME', home);
    const repo = join(home, 'work', 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const lesson = row('a lesson saved while the folder had its old name', 'old-name');
    const kept = row('a lesson under a name with no folder left', 'gone-name');
    open();
    const compaction = db.prepare(
      `INSERT INTO compactions (tenant_id, id, session_id, origin_project, compact_trigger, cwd, started_at) VALUES (?, ?, 's1', ?, 'auto', ?, ?)`,
    );
    compaction.run(T, 'c1', 'old-name', repo, new Date().toISOString());
    compaction.run(T, 'c2', 'old-name', join(home, 'removed'), new Date().toISOString());
    compaction.run(T, 'c3', 'gone-name', join(home, 'removed'), new Date().toISOString());
    compaction.run(T, 'c4', 'repo', repo, new Date().toISOString());
    compaction.run(T, 'c5', 'hand-name', repo, new Date().toISOString());
    await projectNameMerge(ctx(), { from: 'repo-wt-b', into: 'hand-name', dryRun: false });

    const r = await projectNameRepair(ctx(), { dryRun: false });
    expect(r.folds).toEqual([{ from: 'old-name', into: 'repo' }]);
    expect(byId().get(lesson.id)!.originProject).toBe('repo');
    expect(byId().get(kept.id)!.originProject).toBe('gone-name');
    expect(mirror(lesson.id)).toContain('origin_project: repo');
  });

  it('skips a fold into a name that itself folds, so the result never depends on run order', async () => {
    vi.stubEnv('HIPPO_HOME', home);
    for (const name of ['b', 'c']) mkdirSync(join(home, 'work', name, '.git'), { recursive: true });
    const lesson = row('a lesson two renames back', 'a');
    open();
    const compaction = db.prepare(
      `INSERT INTO compactions (tenant_id, id, session_id, origin_project, compact_trigger, cwd, started_at) VALUES (?, ?, 's1', ?, 'auto', ?, ?)`,
    );
    compaction.run(T, 'c1', 'a', join(home, 'work', 'b'), new Date().toISOString());
    compaction.run(T, 'c2', 'b', join(home, 'work', 'c'), new Date().toISOString());

    const merged = row('merged from c and a soon-folded b parent', '', {
      source: 'consolidation',
      parents: [row('parent under b', 'b').id, row('parent under c', 'c').id],
    });
    const dry = await projectNameRepair(ctx(), { dryRun: true });
    expect(dry.folds).toEqual([{ from: 'b', into: 'c' }]);
    // Planned against the folded names, as apply sees them: both parents are under c.
    expect([dry.toProject, dry.setAside]).toEqual([[{ id: merged.id, origin: 'c' }], []]);
    expect((await projectNameRepair(ctx(), { dryRun: false })).toProject).toEqual(dry.toProject);
    expect(byId().get(lesson.id)!.originProject).toBe('a');
  });

  it('folds nothing in a project store, whose names never came from a cwd', async () => {
    const repo = join(home, 'work', 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    open();
    db.prepare(
      `INSERT INTO compactions (tenant_id, id, session_id, origin_project, compact_trigger, cwd, started_at) VALUES (?, 'c1', 's1', 'old-name', 'auto', ?, ?)`,
    ).run(T, repo, new Date().toISOString());
    expect((await projectNameRepair(ctx(), { dryRun: true })).folds).toEqual([]);
  });
});

describe('hippo projects list', () => {
  it('counts live rows per project and the imported notes that are copies held under another name', async () => {
    note('shared note one about the build', '');
    note('shared note one about the build', 'repo-wt-a');
    note('a note only this worktree imported', 'repo-wt-a');
    row('a saved lesson', 'repo-wt-a');
    open();

    expect((await projectNameList(ctx())).find((p) => p.origin === 'repo-wt-a')).toMatchObject({
      live: 3,
      imported: 2,
      copiesElsewhere: 1,
    });
  });

  it('migrates a store at an older schema before it reads, as every other command does', async () => {
    row('a saved lesson', 'repo-wt-a');
    const older = getCurrentSchemaVersion() - 1;
    open();
    setMeta(db, 'schema_version', String(older));
    db.exec(`PRAGMA user_version = ${older}`);
    // The command runs as a request of its own, whose first open reads the schema version afresh.
    currentRequestStores()?.close();
    // The rows already have the last migration's shape, so only its run is counted.
    const up = vi.spyOn(MIGRATIONS[MIGRATIONS.length - 1]!, 'up').mockImplementation(() => undefined);
    try {
      expect((await projectNameList(ctx())).map((p) => p.origin)).toContain('repo-wt-a');
      expect(up).toHaveBeenCalledTimes(1);
    } finally {
      up.mockRestore();
    }
    db = openHippoDbReadOnly(home);
    expect(getSchemaVersion(db)).toBe(getCurrentSchemaVersion());
  });
});
