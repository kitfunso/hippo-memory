/** `hippo projects merge` and `repair`: fold an old worktree name into its repo, and re-tag sleep's user-global merges, reversibly. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { Layer, type MemoryEntry } from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { listDormantSnapshots } from '../src/dormant.js';
import { listProjects, mergeProjects, repairUserGlobalMerges } from '../src/project-merge.js';

let home: string;
let db: DatabaseSyncLike;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hippo-project-merge-'));
  initStore(home);
});
afterEach(() => {
  closeHippoDb(db);
  rmSync(home, { recursive: true, force: true });
});

const T = 'default';
const row = (text: string, origin: string | null, extra: Partial<MemoryEntry> = {}): MemoryEntry => {
  const entry = { ...createMemory(text, { layer: Layer.Semantic }), origin_project: origin, ...extra };
  writeEntry(home, entry);
  return entry;
};
const note = (text: string, origin: string, extra: Partial<MemoryEntry> = {}): MemoryEntry =>
  row(text, origin, { source: `agent-memory:claude-code:p-0123456789ab/${text.slice(0, 8)}.md#abc`, tags: ['claude-code-memory'], ...extra });
const byId = () => new Map(loadAllEntries(home).map((e) => [e.id, e]));
const open = () => (db = openHippoDb(home));
function mirror(id: string): string | null {
  const walk = (dir: string): string | null => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { const hit = walk(p); if (hit) return hit; } else if (name === `${id}.md`) return readFileSync(p, 'utf8');
    }
    return null;
  };
  return walk(home);
}

describe('hippo projects merge', () => {
  it('sets imported copies aside, re-tags everything else, and a dry run writes nothing', () => {
    const copy = note('the deploy script needs node 22 or newer', 'repo-wt-a');
    const pinned = note('never force-push the release branch', 'repo-wt-a', { pinned: true });
    const lesson = row('the flaky sync test needs a fresh temp dir', 'repo-wt-a');
    const other = row('an unrelated project memory', 'elsewhere');
    open();

    const dry = mergeProjects(db, home, { tenantId: T, from: 'repo-wt-a', into: 'repo', dryRun: true });
    expect(dry.setAside).toEqual([copy.id]);
    expect(byId().get(lesson.id)!.origin_project).toBe('repo-wt-a');
    expect(dry.backup).toBeNull();

    const r = mergeProjects(db, home, { tenantId: T, from: 'repo-wt-a', into: 'repo', dryRun: false });
    const rows = byId();
    expect(rows.has(copy.id)).toBe(false);
    expect(listDormantSnapshots(db, T).find((s) => s.entry.id === copy.id)!.entry.origin_project).toBe('repo');
    expect(rows.get(pinned.id)!.origin_project).toBe('repo');
    expect(rows.get(pinned.id)!.tags).not.toContain('claude-code-memory');
    expect(rows.get(lesson.id)!.origin_project).toBe('repo');
    expect(rows.get(other.id)!.origin_project).toBe('elsewhere');
    expect(mirror(lesson.id)).toContain('origin_project: repo');
    expect(mirror(copy.id)).toBeNull();
    expect(existsSync(r.backup!)).toBe(true);
    // SAFETY: the SELECT names the one column of the row type.
    const audit = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'project_merge'`).all() as Array<{ metadata_json: string }>;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].metadata_json).restamped).toEqual(expect.arrayContaining([lesson.id, pinned.id]));
  });

  it('refuses user-global and unknown as either side', () => {
    open();
    expect(() => mergeProjects(db, home, { tenantId: T, from: '', into: 'repo', dryRun: true })).toThrow(/user-global/);
    expect(() => mergeProjects(db, home, { tenantId: T, from: 'repo-wt-a', into: ' ', dryRun: true })).toThrow(/user-global/);
  });

  it('re-tags dormant rows and compaction records too, so a restore does not come back hidden', () => {
    open();
    const faded = createMemory('a faded worktree lesson about the cache', { layer: Layer.Semantic });
    db.prepare(`INSERT INTO dormant_memories (tenant_id, id, content, entry_json, reason, strength, dormant_at) VALUES (?, ?, ?, ?, 'decay', 0.01, ?)`)
      .run(T, faded.id, faded.content, JSON.stringify({ ...faded, origin_project: 'repo-wt-a' }), new Date().toISOString());
    db.prepare(`INSERT INTO compactions (tenant_id, id, session_id, origin_project, compact_trigger, cwd, started_at) VALUES (?, 'c1', 's1', 'repo-wt-a', 'auto', '/x', ?)`)
      .run(T, new Date().toISOString());

    const r = mergeProjects(db, home, { tenantId: T, from: 'repo-wt-a', into: 'repo', dryRun: false });

    expect(r.dormantRestamped).toEqual([faded.id]);
    expect(r.compactions).toBe(1);
    expect(listDormantSnapshots(db, T)[0].entry.origin_project).toBe('repo');
  });
});

describe('hippo projects repair', () => {
  it('re-tags by parents: one project, two projects; leaves an untraceable or truly user-global merge alone', () => {
    const b1 = row('proj-b parent one', 'proj-b');
    const b2 = row('proj-b parent two', 'proj-b');
    const c1 = row('proj-c parent', 'proj-c');
    const g1 = row('user-global parent', '');
    const merged = (parents: string[]) => row(`merged from ${parents.join(' ')}`, '', { source: 'consolidation', parents });
    const one = merged([b1.id, b2.id]);
    const two = merged([b1.id, c1.id]);
    const none = merged(['mem_gone']);
    const global = merged([g1.id]);
    open();

    expect(repairUserGlobalMerges(db, home, { tenantId: T, dryRun: true }).toProject).toEqual([{ id: one.id, origin: 'proj-b' }]);
    expect(byId().get(one.id)!.origin_project).toBe('');

    const r = repairUserGlobalMerges(db, home, { tenantId: T, dryRun: false });
    const rows = byId();
    expect(rows.get(one.id)!.origin_project).toBe('proj-b');
    expect(rows.has(two.id)).toBe(false);
    expect(r.setAside).toEqual([two.id]);
    expect(r.untraced).toEqual([none.id]);
    expect(rows.get(none.id)!.origin_project).toBe('');
    expect(rows.get(global.id)!.origin_project).toBe('');
    expect(mirror(one.id)).toContain('origin_project: proj-b');
    expect(mirror(two.id)).toBeNull();
  });
});

describe('hippo projects list', () => {
  it('counts live rows per project and the imported notes that are copies held under another name', () => {
    note('shared note one about the build', '');
    note('shared note one about the build', 'repo-wt-a');
    note('a note only this worktree imported', 'repo-wt-a');
    row('a saved lesson', 'repo-wt-a');
    open();

    expect(listProjects(db, T).find((p) => p.origin === 'repo-wt-a')).toMatchObject({ live: 3, imported: 2, copiesElsewhere: 1 });
  });
});
