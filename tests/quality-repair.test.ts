import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { repairAutomaticMemories } from '../src/store/quality-repair.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { entryMirrorFiles } from './_helpers/entry-mirror-files.js';
import { DatabaseSync } from '../src/db/sqlite.js';
import { STORE_BUSY_MESSAGE } from '../src/db/busy.js';
import { readDormantSnapshot } from '../src/store/dormant.js';
import { findRejectedValue, rejectionDigest } from '../src/store/rejection.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { Layer, type MemoryEntry } from '../src/core/memory.js';
import { savePrediction } from '../src/store/predictions.js';
import { mergedText } from '../src/util/same-text.js';
import { restoreDormant, type Context } from '../src/api/index.js';
import { importForStore } from '../src/agent-memories/sync.js';
import { closeWorld, note, openWorld, projectNotes } from './_helpers/agent-memories-world.js';

const HIPPO_JS = resolve(__dirname, '..', 'bin', 'hippo.js');
const HEADER = '[Consolidated from 2 related memories, newest first]';
const FRAGMENT = 'if the build fails';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-quality-repair-'));
  initStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seedIn(store: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const entry = { ...createMemory(content, { source: 'capture', confidence: 'observed', layer: Layer.Episodic }), ...extra };
  writeEntry(store, entry);
  return entry;
}
const seed = (content: string, extra: Partial<MemoryEntry> = {}) => seedIn(root, content, extra);
const bundle = (parts: readonly string[], parents: string[]) => seed(mergedText(HEADER, parts), { source: 'consolidation', layer: Layer.Semantic, parents });

function withDb<T>(fn: (db: InstanceType<typeof DatabaseSync>) => T): T {
  const db = new DatabaseSync(join(root, 'hippo.db'));
  try { return fn(db); } finally { db.close(); }
}

const ctx = (): Context => ({ hippoRoot: root, tenantId: 'default', actor: { subject: 'test', role: 'admin' } });
const run = (apply = false) => repairAutomaticMemories(root, { tenantId: 'default', apply });
const dispositionOf = (id: string) => run().issues.find((issue) => issue.id === id)?.disposition;

describe('recoverable automatic memory quality repair', () => {
  it('previews without writes, then preserves full history, audits each move, and leaves a restored row alone', () => {
    const bad = seed('Found local migration files to be', { retrieval_count: 7, tags: ['error', 'captured'] });
    const good = seed('Keep test schema setup outside production migrations because production applies every sorted migration.');
    const before = readFileSync(join(root, 'hippo.db'));
    expect(run()).toMatchObject({ supported: true, appliedIds: [], backup: null });
    expect(readFileSync(join(root, 'hippo.db'))).toEqual(before);
    expect(existsSync(join(root, 'backups'))).toBe(false);
    expect(entryMirrorFiles(root, bad.id)).not.toEqual([]);

    const applied = run(true);
    expect(applied.appliedIds).toEqual([bad.id]);
    expect(existsSync(applied.backup!)).toBe(true);
    expect(entryMirrorFiles(root, bad.id)).toEqual([]);
    expect(loadAllEntries(root).map((entry) => entry.id)).toEqual([good.id]);
    const snapshot = withDb((db) => readDormantSnapshot(db, 'default', bad.id));
    expect(snapshot?.entry).toMatchObject({ content: bad.content, retrieval_count: 7, tags: bad.tags, source: bad.source });
    expect(withDb((db) => db.prepare("SELECT target_id, metadata_json FROM audit_log WHERE op = 'quality_repair'").all())).toEqual([
      { target_id: bad.id, metadata_json: JSON.stringify({ reason: 'sentence-fragment', backup: applied.backup }) },
    ]);
    expect(withDb((db) => findRejectedValue(db, 'default', rejectionDigest(bad.content)))).toBeNull();
    expect(run(true)).toMatchObject({ appliedIds: [], backup: null });

    expect(restoreDormant(ctx(), bad.id)).toMatchObject({ id: bad.id, content: bad.content, retrieval_count: 7, confidence: 'verified' });
    expect(run(true)).toMatchObject({ appliedIds: [], backup: null, issues: [] });
    const typed = createMemory(bad.content, { source: 'cli' });
    writeEntry(root, typed);
    expect(loadAllEntries(root).map((entry) => entry.id)).toContain(typed.id);
  });

  it('keeps pinned, raw, imported, kept-for-good and object-backed memories with their links', () => {
    const content = 'bump build 78 for testflight deploy';
    const pinned = seed(content, { pinned: true });
    const raw = seed(content, { kind: 'raw' });
    const imported = seed(content, { tags: ['claude-code-memory'], source: 'agent-memory:claude-code:p-001/note.md#abc' });
    const kept = seed(content, { tags: ['claude-code-memory', 'captured'], source: 'agent-memory:claude-code:p-001/kept.md#def' });
    const backing = seed(content);
    const prediction = savePrediction(root, 'default', { classTag: 'delivery', claimText: content });
    withDb((db) => db.prepare('UPDATE predictions SET memory_id = ? WHERE id = ?').run(backing.id, prediction.id));
    const result = run(true);
    expect(result.appliedIds).toEqual([]);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pinned.id, protection: 'pinned' }),
      expect.objectContaining({ id: raw.id, protection: 'raw receipt' }),
      expect.objectContaining({ id: backing.id, protection: 'backs an object' }),
    ]));
    // An agent's note is never judged, even when it carries a hippo writer's tag.
    for (const row of [imported, kept]) expect(result.issues.map((issue) => issue.id)).not.toContain(row.id);
    expect(loadAllEntries(root)).toHaveLength(6);
    expect(withDb((db) => db.prepare('SELECT memory_id FROM predictions WHERE id = ?').get(prediction.id))).toEqual({ memory_id: backing.id });
  });

  it('never judges hand-written memories, only rows hippo wrote itself', () => {
    const manual = ['Returns 404 when the API key is missing from the header', 'If the build fails', FRAGMENT, 'more detail soon']
      .map((content) => seed(content, { source: 'cli' }));
    const vouched = seed(FRAGMENT, { confidence: 'verified' });
    const invalidated = seed(FRAGMENT, { confidence: 'stale' });
    const watch = seed("Command 'npm test' failed (exit 1)", { source: 'autolearn' });
    const toolFailure = seed("Command 'npm test' failed (exit 1)", { source: 'tool-failure' });
    const sound = seed('Production migrations must exclude test setup because sorted filenames control application order.', { source: 'consolidation' });
    const automatic = [
      seed(FRAGMENT, { source: 'compaction:s-1' }),
      seed(FRAGMENT, { source: 'cli', extracted_from: manual[0].id }),
      seed(FRAGMENT, { source: 'cli', dag_level: 1 }),
      seed(FRAGMENT, { source: 'git-learn' }),
      seed(FRAGMENT, { source: 'git' }),
      seed(FRAGMENT, { source: 'promoted:/work/app/.hippo', tags: ['captured'] }),
      seed(FRAGMENT, { source: 'consolidation', layer: Layer.Semantic }),
    ];
    const issues = run().issues;
    const ids = issues.map((issue) => issue.id);
    for (const row of [...manual, vouched, invalidated, watch, toolFailure, sound]) expect(ids).not.toContain(row.id);
    for (const row of automatic) {
      expect(issues.find((issue) => issue.id === row.id), row.source).toMatchObject({ reason: 'sentence-fragment', disposition: 'set-aside' });
    }
  });

  it('lists a possible fragment for review and moves nothing', () => {
    const possible = seed('Always check which branch the PR merges into');
    const condition = seed('When CI fails we retry once');
    const result = run(true);
    expect(result.appliedIds).toEqual([]);
    expect(result.issues).toHaveLength(2);
    expect(result.issues).toEqual(expect.arrayContaining([
      { id: possible.id, reason: 'possible-fragment', disposition: 'review' },
      { id: condition.id, reason: 'possible-fragment', disposition: 'review' },
    ]));
  });

  it('flags ambiguity and mixed bundles while preserving complete parts and structured records', () => {
    const mixed = bundle(['Found local migration files to be', 'Production migrations must exclude test setup because sorted filenames control application order.'], []);
    const unparsed = seed(`${HEADER}\n\nFound local migration files to be`, { source: 'consolidation', layer: Layer.Semantic });
    const weak = seed('more detail soon');
    const trace = seed('succeeds (inserts or updates)', { trace_outcome: 'success', layer: Layer.Trace });
    const promoted = seed('succeeds (inserts or updates)', { source: 'auto-promote', tags: ['captured'] });
    const digest = seed('succeeds (inserts or updates)', { tags: ['session-digest'] });
    const result = run(true);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: mixed.id, disposition: 'review' }),
      { id: unparsed.id, reason: 'derived bundle has no safely parsed constituents', disposition: 'review' },
      expect.objectContaining({ id: weak.id, disposition: 'review' }),
    ]));
    for (const row of [trace, promoted, digest]) expect(result.issues.map((issue) => issue.id)).not.toContain(row.id);
    expect(result.appliedIds).toEqual([]);
    expect(loadAllEntries(root)).toHaveLength(6);
  });

  it('sets a bundle aside only when every part is a certain defect and every parent is automatic', () => {
    const parts = ['bump build 78 for testflight deploy', 'bump build 79 for testflight deploy'];
    const fromCapture = bundle(parts, parts.map((content) => seed(content).id));
    const fromPerson = bundle(parts, parts.map((content) => seed(content, { source: 'cli', confidence: 'verified' }).id));
    const mixedParents = bundle(parts, [seed(parts[0]).id, seed(parts[1], { source: 'cli' }).id]);
    const orphan = bundle(parts, ['mem_gone_1', 'mem_gone_2']);
    const unlinked = bundle(parts, []);
    expect(dispositionOf(fromCapture.id)).toBe('set-aside');
    for (const row of [fromPerson, mixedParents, orphan, unlinked]) expect(dispositionOf(row.id)).toBe('review');
  });

  it('finds a parent that repair already moved to dormant storage', () => {
    const parents = ['bump build 78 for testflight deploy', 'bump build 79 for testflight deploy'].map((content) => seed(content));
    expect([...run(true).appliedIds].sort()).toEqual(parents.map((row) => row.id).sort());
    const merged = bundle(parents.map((row) => row.content), parents.map((row) => row.id));
    expect(run(true).appliedIds).toEqual([merged.id]);
    expect(withDb((db) => readDormantSnapshot(db, 'default', merged.id))?.entry.content).toBe(merged.content);
  });

  it('leaves superseded and archived rows to their own lifecycle', () => {
    const next = seed('Keep test schema setup outside production migrations because production applies every sorted migration.');
    seed('Found local migration files to be', { superseded_by: next.id });
    seed('Found local migration files to be', { kind: 'archived' });
    expect(run(true)).toMatchObject({ total: 1, issues: [], appliedIds: [] });
  });

  it('rolls back snapshots and removal, and removes its backup, when audit fails', () => {
    const bad = seed('succeeds (inserts or updates)');
    withDb((db) => db.exec("CREATE TRIGGER refuse_repair_audit BEFORE INSERT ON audit_log WHEN NEW.op = 'quality_repair' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END"));
    expect(() => run(true)).toThrow(/audit unavailable/);
    expect(loadAllEntries(root).map((entry) => entry.id)).toContain(bad.id);
    expect(withDb((db) => readDormantSnapshot(db, 'default', bad.id))).toBeNull();
    expect(readdirSync(join(root, 'backups'))).toEqual([]);
  });

  it('aborts before mutation if the consistent backup cannot be created', () => {
    const bad = seed('succeeds (inserts or updates)');
    writeFileSync(join(root, 'backups'), 'blocks the backup directory');
    expect(() => run(true)).toThrow();
    expect(loadAllEntries(root).map((entry) => entry.id)).toContain(bad.id);
    expect(withDb((db) => readDormantSnapshot(db, 'default', bad.id))).toBeNull();
  });

  it('repairs compatible historical tables without upgrading schema version', () => {
    const bad = seed('Found local migration files to be');
    withDb((db) => {
      db.exec('PRAGMA user_version = 48');
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('48', 'schema_version');
    });
    expect(run(true).appliedIds).toEqual([bad.id]);
    expect(withDb((db) => db.prepare('PRAGMA user_version').get())).toEqual({ user_version: 48 });
  });

  it('blocks a historical store missing a deletion guard dependency before any backup or migration', () => {
    const bad = seed('Found local migration files to be');
    seed(bad.content, { source: 'cli', confidence: 'verified' });
    withDb((db) => {
      db.exec('DROP TABLE customer_notes');
      db.exec('PRAGMA user_version = 43');
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('43', 'schema_version');
    });
    const before = readFileSync(join(root, 'hippo.db'));
    const result = run(true);
    expect(result).toMatchObject({ supported: false, appliedIds: [], backup: null });
    expect(result.blockers).toContain('missing table: customer_notes');
    expect(result.issues).toEqual([{ id: bad.id, reason: 'sentence-fragment', disposition: 'review', protection: 'unsupported schema; no changes permitted' }]);
    expect(readFileSync(join(root, 'hippo.db'))).toEqual(before);
    expect(existsSync(join(root, 'backups'))).toBe(false);
    expect(withDb((db) => db.prepare('PRAGMA user_version').get())).toEqual({ user_version: 43 });
  });

  it('does not disclose the source text in its report and scopes repair to one tenant', () => {
    const mine = seed('succeeds (inserts or updates)');
    const other = seed(mine.content, { tenantId: 'other' });
    const result = run(true);
    expect(result.appliedIds).toEqual([mine.id]);
    expect(JSON.stringify(result)).not.toContain(mine.content);
    expect(loadAllEntries(root).map((entry) => entry.id)).toContain(other.id);
  });

  it('still imports a note a person wrote after a captured copy was repaired', () => {
    const world = openWorld();
    try {
      const bad = createMemory('succeeds (inserts or updates)', { source: 'capture', confidence: 'observed' });
      writeEntry(world.local, bad);
      expect(repairAutomaticMemories(world.local, { tenantId: 'default', apply: true }).appliedIds).toEqual([bad.id]);
      note(projectNotes(world), 'result.md', bad.content);
      importForStore(world.local, { machine: world.machine });
      expect(loadAllEntries(world.local).map((entry) => entry.content)).toEqual([bad.content]);
    } finally { closeWorld(world); }
  });
});

describe('hippo audit repair', () => {
  let dir: string;
  let local: string;
  let global: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hippo-repair-cli-'));
    local = join(dir, '.hippo');
    global = join(dir, 'global');
    initStore(local);
    initStore(global);
    env = { ...process.env, HIPPO_HOME: global, HOME: dir, USERPROFILE: dir };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (...args: string[]) => spawnSync(process.execPath, [HIPPO_JS, 'audit', 'repair', ...args], { cwd: dir, env, encoding: 'utf8' });

  it('previews as JSON, lets --dry-run win over --apply, and names --global in the recovery line', () => {
    const bad = seedIn(local, 'Found local migration files to be');
    const globalBad = seedIn(global, 'Found local migration files to be');
    expect(JSON.parse(cli('--json').stdout)).toMatchObject({ appliedIds: [], issues: [{ id: bad.id, disposition: 'set-aside' }] });
    expect(JSON.parse(cli('--apply', '--dry-run', '--json').stdout)).toMatchObject({ appliedIds: [], backup: null });
    expect(loadAllEntries(local).map((entry) => entry.id)).toEqual([bad.id]);
    const applied = cli('--apply', '--global');
    expect(applied.stdout).toContain(`Moved 1 memories to dormant storage. Recovery: hippo dormant restore <id> --global.`);
    expect(loadAllEntries(global).map((entry) => entry.id)).not.toContain(globalBad.id);
    expect(loadAllEntries(local).map((entry) => entry.id)).toEqual([bad.id]);
  });

  it('reports a busy store plainly and removes the backup a failed apply wrote', () => {
    const bad = seedIn(local, 'Found local migration files to be');
    const holder = new DatabaseSync(join(local, 'hippo.db'));
    holder.exec('BEGIN IMMEDIATE');
    const result = (() => {
      try { return cli('--apply'); } finally { holder.exec('ROLLBACK'); holder.close(); }
    })();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(STORE_BUSY_MESSAGE);
    expect(readdirSync(join(local, 'backups'))).toEqual([]);
    expect(loadAllEntries(local).map((entry) => entry.id)).toEqual([bad.id]);
  }, 30000);
});
