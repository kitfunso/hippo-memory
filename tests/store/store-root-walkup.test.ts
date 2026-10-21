// Ancestor walk-up store discovery (episode 01M1S8SZH6KZA9FPC9KY92XX5Y). Real filesystem in a
// mkdtemp sandbox; the walk stops at the temp root, so stores above it cannot leak into these cases.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { queryAuditEvents } from '../../src/store/sqlite/audit.js';
import { adminActor, retrieve } from '../../src/api/index.js';
import { findHippoStoreDir, getHippoRoot, isInitialized } from '../../src/base/scope/project-identity.js';
import { findHippoRoot } from '../../src/surface/mcp/server.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { runCliAs, runCliOut } from '../_helpers/run-cli-as.js';
import {
  loadLastRecall,
  writeEntry,
  readEntry,
  appendSessionEvent,
  saveActiveTaskSnapshot,
  saveSessionHandoff,
} from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

afterEach(() => {
  vi.unstubAllEnvs();
});

let tmpRoot: string;
let home: string;

function mkdirs(...segments: string[]): string {
  const p = path.join(tmpRoot, ...segments);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

beforeEach(() => {
  tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-walkup-')));
  home = mkdirs('home');
  fs.mkdirSync(path.join(home, '.hippo'));
});

afterEach(() => {
  removeAfterRequest(tmpRoot);
});

describe('getHippoRoot ancestor walk', () => {
  it('resolves a nested subdirectory to the nearest ancestor .hippo directory', () => {
    const proj = mkdirs('home', 'proj');
    fs.mkdirSync(path.join(proj, '.hippo'));
    const deep = mkdirs('home', 'proj', 'src', 'deep');
    expect(getHippoRoot(deep, { homeDir: home })).toBe(path.join(proj, '.hippo'));
  });

  it('does not look above stopDir and falls back to <cwd>/.hippo', () => {
    const outer = mkdirs('home', 'outer');
    fs.mkdirSync(path.join(outer, '.hippo'));
    const stop = mkdirs('home', 'outer', 'inner');
    const leaf = mkdirs('home', 'outer', 'inner', 'leaf');
    expect(getHippoRoot(leaf, { homeDir: home, stopDir: stop })).toBe(path.join(leaf, '.hippo'));
  });

  it('never returns the store inside the home directory itself', () => {
    const work = mkdirs('home', 'work', 'sub');
    expect(getHippoRoot(work, { homeDir: home })).toBe(path.join(work, '.hippo'));
  });

  it('ignores a stray FILE named .hippo on an ancestor', () => {
    const proj = mkdirs('home', 'proj');
    fs.writeFileSync(path.join(proj, '.hippo'), 'not a store');
    const leaf = mkdirs('home', 'proj', 'src');
    expect(findHippoStoreDir(leaf, { homeDir: home })).toBeNull();
    expect(getHippoRoot(leaf, { homeDir: home })).toBe(path.join(leaf, '.hippo'));
  });

  it('returns <cwd>/.hippo when no marker exists anywhere up to the bound', () => {
    const lone = mkdirs('elsewhere', 'a', 'b');
    expect(getHippoRoot(lone, { homeDir: home, stopDir: tmpRoot })).toBe(path.join(lone, '.hippo'));
  });

  it('spells a symlinked project the same way before and after init, so the workspace registry sees one entry', () => {
    const real = mkdirs('real-proj');
    const link = path.join(tmpRoot, 'link-proj');
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    const before = getHippoRoot(link, { homeDir: home, stopDir: tmpRoot });
    fs.mkdirSync(path.join(real, '.hippo'));
    expect(getHippoRoot(link, { homeDir: home, stopDir: tmpRoot })).toBe(before);
    expect(before).toBe(path.join(real, '.hippo'));
  });

  it('ends the walk at the temp root unchecked, so a sandbox under it never resolves upward', () => {
    const tmp = mkdirs('scratch', 'tmp');
    fs.mkdirSync(path.join(tmpRoot, 'scratch', '.hippo'));
    const work = mkdirs('scratch', 'tmp', 'work');
    expect(findHippoStoreDir(work, { homeDir: home })).toBe(path.join(tmpRoot, 'scratch', '.hippo'));
    vi.stubEnv('TMPDIR', tmp);
    vi.stubEnv('TEMP', tmp);
    vi.stubEnv('TMP', tmp);
    expect(samePath(fs.realpathSync.native(os.tmpdir()), fs.realpathSync.native(tmp))).toBe(true);
    expect(findHippoStoreDir(work, { homeDir: home })).toBeNull();
    expect(getHippoRoot(work, { homeDir: home })).toBe(path.join(work, '.hippo'));
  });

  it('returns a bare ancestor .hippo directory, which isInitialized then rejects', () => {
    const proj = mkdirs('home', 'proj');
    fs.mkdirSync(path.join(proj, '.hippo'));
    const src = mkdirs('home', 'proj', 'src');
    const root = getHippoRoot(src, { homeDir: home });
    expect(root).toBe(path.join(proj, '.hippo'));
    expect(isInitialized(root)).toBe(false);
  });
});

describe('CLI end to end', () => {
  it('uses one initialized global store for projectless recall and context', async () => {
    const globalStore = mkdirs('global-store');
    const work = mkdirs('home', 'projectless');
    initTestStore(globalStore);
    const entry = createMemory('projectless-orbit release staging flag', { pinned: true });
    entry.originProject = '';
    writeEntry(globalStore, entry);
    const foreignFolder = mkdirs('other-project');
    saveActiveTaskSnapshot(globalStore, 'default', {
      task: 'Foreign global active task',
      summary: 'Foreign global snapshot summary',
      next_step: 'Resume unrelated global action',
      session_id: 'other-project-session',
      source: 'test',
    });
    saveSessionHandoff(globalStore, 'default', {
      version: 1,
      sessionId: 'other-project-session',
      repoRoot: foreignFolder,
      summary: 'Foreign global handoff summary',
      nextAction: 'Resume unrelated global action',
      artifacts: [],
    });
    appendSessionEvent(globalStore, 'default', {
      session_id: 'other-project-session',
      event_type: 'note',
      content: 'Foreign global event trail',
      source: 'test',
    });
    const opts = { cwd: work, env: { ...process.env, HIPPO_HOME: globalStore } };

    const recall = JSON.parse(await runCliOut(['recall', 'projectless-orbit', '--json'], opts));
    expect(recall.results.map((r: { id: string }) => r.id)).toContain(entry.id);
    expect(recall.suppressionSummary.totalCandidates).toBe(1);
    for (const query of ['projectless-orbit', 'absentxylophonezzq']) {
      const packet = JSON.parse(await runCliOut(['recall', query, '--continuity', '--json'], opts));
      expect(packet.continuity).toEqual({ activeSnapshot: null, sessionHandoff: null, recentSessionEvents: [] });
      expect(packet.results.map((r: { id: string }) => r.id)).toEqual(query === 'projectless-orbit' ? [entry.id] : []);
    }
    const autoContext = await runCliOut(['context', '--auto'], opts);
    expect(autoContext).toContain(entry.content);
    expect(autoContext).not.toContain('Foreign global handoff summary');
    expect(autoContext).not.toContain('Foreign global snapshot summary');
    expect(autoContext).not.toContain('Foreign global event trail');
    expect(autoContext).not.toContain('Resume unrelated global action');

    const before = readEntry(globalStore, entry.id)!.retrievalCount;
    const beforeDb = openHippoDb(globalStore);
    const priorTraces = beforeDb.prepare("SELECT id FROM recall_traces WHERE pipeline = 'context'").all().length;
    closeHippoDb(beforeDb);
    const queriedContext = await runCliOut(['context', 'projectless-orbit'], opts);
    expect(queriedContext).toContain(entry.content);
    expect(queriedContext).not.toContain('Foreign global handoff summary');
    expect(queriedContext).not.toContain('Foreign global snapshot summary');
    expect(queriedContext).not.toContain('Foreign global event trail');
    expect(queriedContext).not.toContain('Resume unrelated global action');
    expect(readEntry(globalStore, entry.id)!.retrievalCount).toBe(before + 1);
    const db = openHippoDb(globalStore);
    try {
      const contextAudits = queryAuditEvents(db, { tenantId: 'default', op: 'recall' }).filter(
        (e) => e.metadata?.mode === 'context',
      );
      expect(contextAudits).toHaveLength(1);
      const traces = db.prepare("SELECT id FROM recall_traces WHERE pipeline = 'context'").all();
      expect(traces).toHaveLength(priorTraces + 1);
      // SAFETY: the query selects only the numeric id column.
      expect(loadLastRecall(globalStore).last_trace_id).toBe(String((traces.at(-1) as { id: number }).id));
    } finally {
      closeHippoDb(db);
    }
    expect(await runCliOut(['context', 'absentxylophonezzq'], opts)).toBe('');
    const missedDb = openHippoDb(globalStore);
    try {
      const audits = queryAuditEvents(missedDb, { tenantId: 'default', op: 'recall' }).filter(
        (e) => e.metadata?.mode === 'context',
      );
      expect(audits).toHaveLength(2);
      // SAFETY: the SELECT names exactly one integer column.
      const traces = missedDb
        .prepare("SELECT result_count FROM recall_traces WHERE pipeline = 'context' ORDER BY id")
        .all() as Array<{ result_count: number }>;
      expect(traces).toHaveLength(priorTraces + 2);
      expect(traces.at(-1)?.result_count).toBe(0);
    } finally {
      closeHippoDb(missedDb);
    }
    expect(readEntry(globalStore, entry.id)!.retrievalCount).toBe(before + 1);
    expect(fs.existsSync(path.join(work, '.hippo'))).toBe(false);
    const contextJson = JSON.parse(await runCliOut(['context', 'projectless-orbit', '--format', 'json'], opts));
    expect(contextJson.memories[0].global).toBe(true);
    const why = JSON.parse(await runCliOut(['recall', 'projectless-orbit', '--why', '--json'], opts));
    expect(why.results[0].source).toBe('global');
    vi.stubEnv('HIPPO_HOME', globalStore);
    const direct = await retrieve(apiCtx(globalStore, 'default', adminActor('test')), {
      query: 'projectless-orbit',
      window: { includeContinuity: true },
    });
    expect(direct.continuity?.activeSnapshot?.task).toBe('Foreign global active task');
    expect(direct.continuity?.sessionHandoff?.summary).toBe('Foreign global handoff summary');
    expect(direct.continuity?.recentSessionEvents[0].content).toBe('Foreign global event trail');
    expect(direct.results.map((r) => r.id)).toContain(entry.id);
  });

  it('recall from <proj>/src finds the project store and creates no nested one', async () => {
    const globalStore = mkdirs('global-store');
    const env = { ...process.env, HIPPO_HOME: globalStore };
    const proj = mkdirs('home', 'proj');
    const src = mkdirs('home', 'proj', 'src');
    await runCliOut(['init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: proj, env });
    await runCliOut(['remember', 'walkup-target zeta fact'], { cwd: proj, env });
    const out = await runCliOut(['recall', 'walkup-target'], { cwd: src, env });
    expect(out).toContain('walkup-target');
    expect(fs.existsSync(path.join(src, '.hippo'))).toBe(false);

    const again = await runCliOut(['init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: src, env });
    expect(again).toContain('Already initialized at');
    expect(fs.existsSync(path.join(src, '.hippo'))).toBe(false);
  });

  it('a directory with no store anywhere up to home still fails, naming both paths', async () => {
    const globalStore = mkdirs('global-store');
    const lone = mkdirs('lone');
    const res = await runCliAs(['recall', 'anything'], { cwd: lone, env: { ...process.env, HIPPO_HOME: globalStore } });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('No hippo store at');
    expect(res.stderr).toContain(path.join(lone, '.hippo'));
    expect(res.stderr).toContain('up to your home directory');
    expect(fs.existsSync(path.join(lone, '.hippo'))).toBe(false);
    for (const args of [
      ['context', '--auto'],
      ['context', 'anything'],
    ]) {
      const context = await runCliAs(args, { cwd: lone, env: { ...process.env, HIPPO_HOME: globalStore } });
      expect(context.status).not.toBe(0);
      expect(context.stderr).toContain('No hippo store at');
    }
  });
});

describe('MCP findHippoRoot', () => {
  it('HIPPO_HOME wins over home/.hippo when cwd is under home with no marker', () => {
    const globalStore = mkdirs('global-store');
    vi.stubEnv('HIPPO_HOME', globalStore);
    const work = mkdirs('home', 'work');
    expect(findHippoRoot(work, { homeDir: home })).toBe(globalStore);
  });

  it('returns null when no ancestor store exists and the global root is missing', () => {
    vi.stubEnv('HIPPO_HOME', path.join(tmpRoot, 'missing-global'));
    const work = mkdirs('home', 'work');
    expect(findHippoRoot(work, { homeDir: home })).toBeNull();
  });

  it('prefers the nearest ancestor store over the global root', () => {
    const globalStore = mkdirs('global-store');
    vi.stubEnv('HIPPO_HOME', globalStore);
    const proj = mkdirs('home', 'proj');
    fs.mkdirSync(path.join(proj, '.hippo'));
    const src = mkdirs('home', 'proj', 'src');
    expect(findHippoRoot(src, { homeDir: home })).toBe(path.join(proj, '.hippo'));
  });
});
