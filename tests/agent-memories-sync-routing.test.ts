// Design 2 and 9: which store each pass writes to, the handover, and what may leave a store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import childProcess, { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { restoreDormant } from '../src/api/index.js';
import { gitLayout } from '../src/agent-memories/git.js';
import { containerId, containerPrefix } from '../src/agent-memories/source.js';
import { importAtSessionEnd, importForStore, importProjectMemories, importSessionFolder } from '../src/agent-memories/sync.js';
import { repairProjectNames } from '../src/api/projects.js';
import { cliApiContext } from '../src/cli/api-context.js';
import type { ImportReport } from '../src/agent-memories/report.js';
import { createMemory, type MemoryEntry } from '../src/core/memory.js';
import { deriveOriginProject } from '../src/core/project-identity.js';
import { autoShare } from '../src/sharing/share.js';
import { syncGlobalToLocal } from '../src/sharing/global-sync.js';
import { initStore, isInitialized } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import {
  agentRows, closeWorld, codexSummary, ctxFor, dormantRows, expectedContainer, liveRows, liveTexts, note, openWorld, projectNotes, toolTally,
  userNotes, withDb, writeConfig, type World,
} from './_helpers/agent-memories-world.js';

const DEPLOY = 'Run the schema check before this service deploys.';
const USER_NOTE = 'Prefers short replies with the command first.';
const CONTROL = 'The shared runbook lives in the ops wiki under Deploys.';

let w: World;
beforeEach(() => {
  w = openWorld();
});
afterEach(() => {
  vi.unstubAllEnvs();
  closeWorld(w);
});

const claude = (report: ImportReport) => toolTally(report, 'claude-code');
const opts = () => ({ machine: w.machine });

function plainRow(root: string, content: string, origin: string): MemoryEntry {
  const entry = { ...createMemory(content, { tenantId: 'default', baseHalfLifeDays: 30 }), origin_project: origin };
  writeEntry(root, entry);
  return entry;
}

interface Spawned<T> {
  readonly result: T;
  readonly spawns: number;
}

function spawnsDuring<T>(run: () => T): Spawned<T> {
  const spy = vi.spyOn(childProcess, 'spawnSync');
  syncBuiltinESMExports();
  try {
    const result = run();
    return { result, spawns: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
}

describe('agent memory sync: routing and sharing', () => {
  it('the handover sets aside the global p- rows the store-less hook path wrote once the project\'s own store syncs them', () => {
    const hand = join(w.dir, 'hand');
    mkdirSync(join(hand, '.git'), { recursive: true });
    note(projectNotes(w, hand), 'deploy.md', DEPLOY);
    importAtSessionEnd(hand, undefined, opts());
    expect(liveRows(w.global)).toMatchObject([{ content: DEPLOY }]);
    expect(liveRows(w.global)[0].source).toMatch(/^agent-memory:claude-code:p-/);

    initStore(join(hand, '.hippo'));
    expect(claude(importProjectMemories(join(hand, '.hippo'), opts()))).toMatchObject({ imported: 1, handedOver: 1 });
    expect(liveRows(w.global)).toEqual([]);
    expect(dormantRows(w.global).map((d) => d.reason)).toEqual(['source-deleted']);
    expect(liveTexts(join(hand, '.hippo'))).toEqual([DEPLOY]);
  });

  it('a project Y row with the same text does not hide the note from project X in the global store', () => {
    const SHARED = 'Every service logs in UTC with ISO timestamps.';
    initStore(w.global);
    plainRow(w.global, DEPLOY, 'projy');
    plainRow(w.global, SHARED, '');
    const hx = join(w.dir, 'hookx');
    mkdirSync(join(hx, '.git'), { recursive: true });
    note(projectNotes(w, hx), 'deploy.md', DEPLOY);
    note(projectNotes(w, hx), 'utc.md', SHARED);

    expect(claude(importAtSessionEnd(hx, undefined, opts()))).toMatchObject({ imported: 1, duplicate: 1 });
    expect(liveRows(w.global)).toMatchObject([{ content: DEPLOY, origin_project: deriveOriginProject(hx) }]);
  });

  it('post-compact reads the session folder only and runs no git call', () => {
    const Q = 'The session folder note says the queue drains at midnight.';
    note(projectNotes(w, join(w.dir, 'other')), 'p.md', 'A note in another project folder is read by its own sleep, not by this compaction hook.');
    note(userNotes(w), 'u.md', USER_NOTE);
    codexSummary(w, '- The compaction hook must not read this Codex bullet.');
    const transcript = join(dirname(note(projectNotes(w), 'q.md', Q)), '..', 's.jsonl');
    writeFileSync(transcript, '', 'utf8');

    const compaction = spawnsDuring(() => importSessionFolder(w.local, transcript, w.project, opts()));
    expect(compaction.spawns).toBe(0);
    expect(claude(compaction.result).imported).toBe(1);
    expect(liveRows(w.local)).toMatchObject([{ content: Q, origin_project: 'proj' }]);
    expect(isInitialized(w.global)).toBe(false);
    expect(spawnsDuring(() => importProjectMemories(w.local, opts())).spawns).toBeGreaterThan(0);
  });

  it('a session begun above two repos keeps its folder notes user-global, one copy wherever it ends', () => {
    const HOME_NOTE = 'A note the session filed under the folder it began in.';
    const transcript = join(dirname(note(projectNotes(w, w.dir), 'h.md', HOME_NOTE)), '..', 's.jsonl');
    const [a, b] = [join(w.dir, 'repoa'), join(w.dir, 'repob')];
    for (const repo of [a, b]) mkdirSync(join(repo, '.git'), { recursive: true });

    importAtSessionEnd(a, transcript, opts());
    importAtSessionEnd(b, transcript, opts());
    expect(liveRows(w.global)).toMatchObject([{ content: HOME_NOTE, origin_project: '' }]);
    expect(claude(importSessionFolder(w.local, transcript, w.project, opts())).imported).toBe(0);
    expect(liveTexts(w.local)).toEqual([]);
  });

  it('a session begun in one repo and compacted in another files its folder notes under the first, in the global store', () => {
    const x = join(w.dir, 'repox');
    mkdirSync(join(x, '.git'), { recursive: true });
    const transcript = join(dirname(note(projectNotes(w, x), 'x.md', DEPLOY)), '..', 's.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: x })}\n`, 'utf8');

    expect(claude(importSessionFolder(w.local, transcript, w.project, opts())).imported).toBe(1);
    expect(liveRows(w.global)).toMatchObject([{ content: DEPLOY, origin_project: deriveOriginProject(x) }]);
    expect(liveTexts(w.local)).toEqual([]);
  });

  it('a project store that opts out of imports keeps another repo\'s session notes out of the global store too', () => {
    const x = join(w.dir, 'repox');
    mkdirSync(join(x, '.git'), { recursive: true });
    const transcript = join(dirname(note(projectNotes(w, x), 'x.md', DEPLOY)), '..', 's.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ cwd: x })}\n`, 'utf8');
    writeConfig(w.local, []);

    expect(claude(importSessionFolder(w.local, transcript, w.project, opts())).imported).toBe(0);
    expect(isInitialized(w.global)).toBe(false);
  });

  it('repair sets aside a home note filed under a project and edited since, and the next compaction does not bring it back', () => {
    const HOME_NOTE = 'A note the session filed under the folder it began in.';
    const notes = projectNotes(w, w.dir);
    const transcript = join(dirname(note(notes, 'h.md', HOME_NOTE)), '..', 's.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ cwd: w.dir })}\n`, 'utf8');
    initStore(w.global);
    const stray = {
      ...createMemory('An older wording of the home note.', { tenantId: 'default', baseHalfLifeDays: 30 }),
      origin_project: 'repoa',
      source: `${containerPrefix('claude-code', containerId(notes, 'project', process.platform, 'repoa'))}h.md#abc`,
      tags: ['claude-code-memory'],
    };
    writeEntry(w.global, stray);
    withDb(w.global, (db) => db.prepare(`INSERT INTO compactions (tenant_id, id, session_id, origin_project, compact_trigger, cwd, transcript_path, started_at) VALUES ('default', 'c1', 's1', 'repoa', 'auto', ?, ?, ?)`)
      .run(join(w.dir, 'repoa'), transcript, new Date().toISOString()));
    const repair = (dryRun: boolean) => repairProjectNames(cliApiContext(w.global, 'default'), { dryRun });

    expect(repair(true).copies).toEqual([stray.id]);
    expect(liveRows(w.global).map((e) => e.id)).toEqual([stray.id]);
    expect(repair(false).copies).toEqual([stray.id]);
    expect(repair(false).copies).toEqual([]);

    importSessionFolder(w.local, transcript, join(w.dir, 'repoa'), opts());
    expect(liveRows(w.global)).toMatchObject([{ content: HOME_NOTE, origin_project: '' }]);
    expect(dormantRows(w.global).map((d) => d.id)).toEqual([stray.id]);
  });

  it('a global-store sleep runs the user pass only', () => {
    note(projectNotes(w, dirname(w.global)), 'home.md', 'A note in the folder Claude keeps for the global store\'s parent.');
    note(userNotes(w), 'u.md', USER_NOTE);

    const report = importForStore(w.global, opts());
    expect(liveTexts(w.global)).toEqual([USER_NOTE]);
    expect(report.tools.flatMap((t) => t.containers.map((c) => c.scope))).toEqual(['user']);
  });

  it('a user container lands in the global store with origin \'\'', () => {
    const dir = userNotes(w);
    note(dir, 'u.md', USER_NOTE);

    expect(claude(importForStore(w.local, opts())).imported).toBe(1);
    expect(liveRows(w.global)).toMatchObject([{ content: USER_NOTE, origin_project: '' }]);
    expect(liveRows(w.global)[0].source.startsWith(`agent-memory:claude-code:${expectedContainer(dir, 'u')}/u.md#`)).toBe(true);
    expect(agentRows(w.local)).toEqual([]);
  });

  it('hippo sync never copies an agent memory row, tagged or restored, into a project store', () => {
    writeConfig(w.local, null);
    const dir = userNotes(w);
    note(dir, 'u.md', USER_NOTE);
    const gone = note(dir, 'gone.md', 'This user note is deleted, set aside, then restored by hand.');
    importForStore(w.local, opts());
    const goneId = liveRows(w.global).find((e) => e.content.startsWith('This user note'))?.id ?? '';
    unlinkSync(gone);
    importForStore(w.local, opts());
    restoreDormant(ctxFor(w.global), goneId);
    plainRow(w.global, CONTROL, '');

    expect(syncGlobalToLocal(w.local, w.global)).toBe(1);
    expect(agentRows(w.local)).toEqual([]);
    expect(loadAllEntries(w.local).map((e) => e.content)).toEqual([CONTROL]);
  });

  it('an imported row is never auto-shared, restored or not', () => {
    writeConfig(w.local, null);
    const dir = projectNotes(w);
    note(dir, 'deploy.md', DEPLOY);
    const gone = note(dir, 'gone.md', 'This project note is deleted, set aside, then restored by hand.');
    importForStore(w.local, opts());
    const goneId = liveRows(w.local).find((e) => e.content.startsWith('This project note'))?.id ?? '';
    unlinkSync(gone);
    importForStore(w.local, opts());
    restoreDormant(ctxFor(w.local), goneId);
    plainRow(w.local, CONTROL, 'proj');

    const stats = { secretSkipped: 0, neverAutoShareSkipped: 0 };
    const shared = autoShare(w.local, { minScore: 0, stats });
    expect(shared.map((e) => e.content)).toEqual([CONTROL]);
    expect(stats.neverAutoShareSkipped).toBe(2);
  });

  it('a moved project root leaves the old container\'s rows alone', () => {
    note(projectNotes(w), 'deploy.md', DEPLOY);
    importForStore(w.local, opts());
    const [old] = liveRows(w.local);
    const moved = join(w.dir, 'moved');
    renameSync(w.project, moved);
    const store = join(moved, '.hippo');
    const copied = note(projectNotes(w, moved), 'deploy.md', DEPLOY);

    expect(claude(importForStore(store, opts()))).toMatchObject({ imported: 1, setAside: 0 });
    expect(liveRows(store)).toHaveLength(2);
    expect(toolTally(importForStore(store, { ...opts(), dryRun: true }), 'claude-code')).toMatchObject({ unchanged: 1 });
    expect(importForStore(store, { ...opts(), dryRun: true }).tools.find((t) => t.tool === 'claude-code')?.unlisted).toBe(1);

    unlinkSync(copied);
    expect(claude(importForStore(store, opts())).setAside).toBe(1);
    expect(liveRows(store).map((e) => e.id)).toEqual([old.id]);
  });

  it('a git failure sets nothing aside', () => {
    const repo = join(w.dir, 'repo');
    mkdirSync(repo);
    expect(spawnSync('git', ['init', '-q', repo], { encoding: 'utf8', windowsHide: true }).status).toBe(0);
    const store = join(repo, 'sub', '.hippo');
    initStore(store);
    note(projectNotes(w, repo), 'deploy.md', DEPLOY);
    expect(claude(importForStore(store, opts())).imported).toBe(1);

    const noTools = join(w.dir, 'no-tools');
    mkdirSync(noTools);
    vi.stubEnv('PATH', noTools);
    expect(gitLayout(join(repo, 'sub'))).toBeNull();
    expect(claude(importForStore(store, opts()))).toMatchObject({ setAside: 0, imported: 0 });
    expect(liveTexts(store)).toEqual([DEPLOY]);
  });
});
