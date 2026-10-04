// What the installed hooks put into the model's context: no consolidation log, one copy of each memory.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { Layer, type MemoryEntry} from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { estimateTokens } from '../src/token-ledger.js';
import type { SearchResult } from '../src/search/types.js';
import { insertEntity, insertRelation } from '../src/graph.js';
import { graphExpandRecall } from '../src/graph-recall.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

let home: string;
let project: string;
let env: NodeJS.ProcessEnv;

function hippo(args: string[], input?: string): SpawnSyncReturns<string> {
  const r = spawnSync(process.execPath, [HIPPO_JS, ...args], { cwd: project, env, input, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-lean-'));
  project = path.join(home, 'project');
  fs.mkdirSync(project);
  env = {
    ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, HIPPO_HOME: path.join(home, 'global'),
    HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
  };
  hippo(['init', '--no-hooks', '--no-schedule', '--no-learn']);
  hippo(['hook', 'install', 'claude-code']);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** The commands `hippo hook install claude-code` wrote for one event. */
function installedCommands(event: string): string[] {
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  return settings.hooks[event].flatMap((entry: { hooks: Array<{ command: string }> }) => entry.hooks.map((h) => h.command));
}

interface HookPayload {
  session_id: string;
  hook_event_name: 'SessionStart' | 'UserPromptSubmit';
  source?: string;
  prompt?: string;
}

/** Runs an installed `hippo ...` command line against the built CLI, as Claude Code would. */
function runHook(command: string, payload: HookPayload): SpawnSyncReturns<string> {
  const [bin, ...args] = (command.match(/"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^"(.*)"$/, '$1'));
  expect(bin).toBe('hippo');
  return hippo(args, JSON.stringify(payload));
}

/** What Claude Code adds to the model's context from a UserPromptSubmit hook's stdout. */
function additionalContext(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

function remember(text: string, ...flags: string[]): string {
  const id = /Remembered \[([^\]]+)\]/.exec(hippo(['remember', text, ...flags]).stdout)?.[1];
  expect(id).toBeTruthy();
  return id ?? '';
}

function promptContext(prompt: string): string {
  const [command] = installedCommands('UserPromptSubmit').filter((c) => c.includes('hippo context --pinned-only'));
  return additionalContext(runHook(command, { session_id: 'lean-session', hook_event_name: 'UserPromptSubmit', prompt }).stdout);
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** Z1: the per-prompt hook recalls memories that match the prompt instead of the newest ones. */
function enablePromptRecall(): void {
  const file = path.join(project, '.hippo', 'config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  config.pinnedInject = { ...config.pinnedInject, promptRecall: true, promptRecallThreshold: 0.1, promptRecallMinShared: 1 };
  fs.writeFileSync(file, JSON.stringify(config));
}

describe('SessionStart hooks', () => {
  it('keep the consolidation log out of the stdout Claude Code adds to the model context', () => {
    const commands = installedCommands('SessionStart');
    const logFile = /--path "([^"]+)"/.exec(commands.find((c) => c.startsWith('hippo last-sleep')) ?? '')?.[1] ?? '';
    expect(logFile).not.toBe('');
    // The SessionEnd worker leaves the output of a real sleep run in this log.
    remember('the release script needs the staging flag or it publishes to production');
    hippo(['sleep', '--log-file', logFile]);
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const runs = commands.map((c) => runHook(c, { session_id: 'lean-session', hook_event_name: 'SessionStart', source: 'startup' }));
    const stdout = runs.map((r) => r.stdout).join('');
    const stderr = runs.map((r) => r.stderr).join('');

    expect(stdout).not.toContain('Previous session hippo consolidation');
    for (const line of lines) expect(stdout).not.toContain(line);
    for (const line of lines) expect(stderr).toContain(line);
    expect(fs.existsSync(logFile)).toBe(false);
  });
});

describe('a memory with a copy in the global store', () => {
  const rule = 'never force-push the release branch, other people build from it';
  const older = 'the staging database resets every night at two in the morning UTC';
  const newest = 'run the migration check before tagging a release, it catches missing indexes';

  it('reaches the prompt hook once, and the freed recent slot goes to the next memory', () => {
    // The freed slot is a newest-5 backfill, so pin the pre-1.55.0 default.
    fs.writeFileSync(path.join(project, '.hippo', 'config.json'), JSON.stringify({ pinnedInject: { promptRecall: false } }));
    hippo(['promote', remember(rule, '--pin')]);
    remember(older);
    hippo(['share', remember(newest), '--force']);

    const context = promptContext('what should I check before the release?');
    expect(count(context, rule)).toBe(1);
    expect(count(context, newest)).toBe(1);
    expect(count(context, older)).toBe(1);
    expect(context).not.toContain('[global]');

    // Two recent slots: the copy of the newest memory used to take the second one.
    const narrow = additionalContext(
      hippo(['context', '--pinned-only', '--include-recent', '2', '--format', 'additional-context']).stdout,
    );
    expect(count(narrow, newest)).toBe(1);
    expect(count(narrow, older)).toBe(1);
  });

  it('keeps the pinned copy when only the global one is pinned', () => {
    remember(rule);
    remember(rule, '--pin', '--global');

    const context = promptContext('what should I check before the release?');
    expect(count(context, rule)).toBe(1);
    expect(context).toContain(`[global] ${rule}`);
  });

  it('reaches the session-start context once', () => {
    hippo(['promote', remember(rule, '--pin')]);
    hippo(['share', remember(newest), '--force']);

    const out = hippo(['context', '--budget', '1500']).stdout;
    expect(count(out, rule)).toBe(1);
    expect(count(out, newest)).toBe(1);
  });

  it('is recalled once when the prompt hook recalls by the prompt', () => {
    enablePromptRecall();
    hippo(['share', remember(older), '--force']);

    const context = promptContext('when does the staging database reset?');
    expect(count(context, older)).toBe(1);
    expect(context).not.toContain('[global]');
  });

  it('is not recalled by the prompt hook when a pinned copy is already injected', () => {
    enablePromptRecall();
    remember(older, '--pin');
    remember(older, '--global');

    const context = promptContext('when does the staging database reset?');
    expect(count(context, older)).toBe(1);
    expect(context).not.toContain('[global]');
  });

  it('comes back once from `hippo recall --multihop`', () => {
    hippo(['share', remember(older), '--force']);

    const out = JSON.parse(hippo(['recall', 'when does the staging database reset', '--multihop', '--json']).stdout);
    expect(out.results.filter((r: { content: string }) => r.content === older)).toHaveLength(1);
  });

  it('is not copied back into the project by `hippo sync`', () => {
    hippo(['promote', remember(older)]);

    expect(hippo(['sync']).stdout).toContain('Synced 0 global memories');
    expect(loadAllEntries(path.join(project, '.hippo')).filter((e) => e.content === older)).toHaveLength(1);
  });

  it('lands once in another project when `hippo sync` finds two global copies', () => {
    const id = remember(older);
    hippo(['promote', id]);
    hippo(['promote', id]);
    project = path.join(home, 'other');
    fs.mkdirSync(project);
    hippo(['init', '--no-hooks', '--no-schedule', '--no-learn']);

    hippo(['sync', '--cross-project']);
    expect(loadAllEntries(path.join(project, '.hippo')).filter((e) => e.content === older)).toHaveLength(1);
  });

  it('is reached once by graph expansion, and a copy of a base result is not reached at all', () => {
    const T = 'default';
    const store = (name: string): string => {
      const root = path.join(home, name);
      fs.mkdirSync(root);
      initStore(root);
      return root;
    };
    const mem = (root: string, text: string): MemoryEntry => {
      const m = createMemory(text, { tags: [], layer: Layer.Semantic, confidence: 'verified', source: 'test', tenantId: T, scope: null });
      writeEntry(root, m, { actor: 'test' });
      return m;
    };
    const entity = (root: string, m: MemoryEntry): number =>
      insertEntity(root, T, { entityType: 'decision', name: m.id, memoryId: m.id }).id;
    const sr = (entry: MemoryEntry, score: number): SearchResult =>
      ({ entry, score, bm25: score, cosine: 0, tokens: estimateTokens(entry.content) });

    const local = store('graph-local');
    const global = store('graph-global');
    const seed = mem(local, rule);
    const linked = mem(local, older);
    insertRelation(local, T, { fromEntityId: entity(local, seed), toEntityId: entity(local, linked), relType: 'references', memoryId: seed.id });
    // The global graph holds a third memory that links to shared copies of both local ones.
    const other = mem(global, newest);
    const linkedCopy = mem(global, older);
    const seedCopy = mem(global, rule);
    const eOther = entity(global, other);
    for (const copy of [linkedCopy, seedCopy]) {
      insertRelation(global, T, { fromEntityId: eOther, toEntityId: entity(global, copy), relType: 'references', memoryId: other.id });
    }

    const out = graphExpandRecall([sr(seed, 1), sr(other, 0.9)], { hops: 1, hippoRoot: local, globalRoot: global, tenantId: T, budget: 4000 });
    const ids = out.map((r) => r.entry.id);
    for (const text of [rule, older, newest]) expect(out.filter((r) => r.entry.content === text)).toHaveLength(1);
    expect(ids).toContain(linked.id);
    expect(ids).not.toContain(linkedCopy.id);
    expect(ids).not.toContain(seedCopy.id);
  });
});
