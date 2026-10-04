// Hook commands run on every prompt and tool failure, so each store they read is opened once per process.
// Drives the built CLI; a preload counts the DatabaseSync connections per database file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, type MemoryEntry } from '../src/memory.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');
const FAKE_NOW = '2026-06-01T12:00:00.000Z';

const PRELOAD_SRC = `
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
const seen = new WeakSet();
const opens = {};
for (const method of ['exec', 'prepare']) {
  const original = DatabaseSync.prototype[method];
  DatabaseSync.prototype[method] = function (...args) {
    if (!seen.has(this)) {
      seen.add(this);
      const file = this.location();
      opens[file] = (opens[file] ?? 0) + 1;
    }
    return original.apply(this, args);
  };
}
process.on('exit', () => writeFileSync(process.env.P2_OPEN_LOG, JSON.stringify(opens)));
`;

let tmp: string;
let projectDir: string;
let localRoot: string;
let globalRoot: string;
let preloadPath: string;
let logPath: string;

function seed(root: string, content: string, created: string, extra: Partial<MemoryEntry> = {}): void {
  writeEntry(root, { ...createMemory(content, { baseHalfLifeDays: 30 }), created, last_retrieved: created, ...extra });
}

// Stamped by hand: derived from the temp dir, the origin is whichever project marker sits above it on this machine.
function seedGlobalPin(): void {
  initStore(globalRoot);
  seed(globalRoot, 'PINNED: never force-push the main branch', '2026-04-01T00:00:00.000Z', { pinned: true, origin_project: '' });
}

interface HookRun {
  stdout: string;
  /** Connections opened per database, keyed `local`, `global` or the file path. */
  opens: Record<string, number>;
}

function runHook(args: string[], input: string): HookRun {
  const stdout = execFileSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(preloadPath).href, HIPPO_JS, ...args], {
    // Home is the test dir, so the project walk from cwd stops there instead of finding a marker above the temp root.
    env: { ...process.env, HOME: tmp, USERPROFILE: tmp, HIPPO_HOME: globalRoot, HIPPO_FAKE_NOW: FAKE_NOW, P2_OPEN_LOG: logPath },
    cwd: projectDir,
    input,
    encoding: 'utf8',
  });
  // SAFETY: the preload above writes exactly this file-to-count object.
  const raw = JSON.parse(fs.readFileSync(logPath, 'utf8')) as Record<string, number>;
  const opens: Record<string, number> = {};
  for (const [file, n] of Object.entries(raw)) {
    const root = path.resolve(path.dirname(file));
    const label = root === path.resolve(localRoot) ? 'local' : root === path.resolve(globalRoot) ? 'global' : file;
    opens[label] = n;
  }
  return { stdout, opens };
}

const PROMPT_HOOK = ['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'];
const promptPayload = (sessionId: string): string =>
  JSON.stringify({ session_id: sessionId, prompt: 'postgres migration rollback plan for the deploy' });

beforeEach(() => {
  // Real path: the CLI logs opens by resolved path, and macOS spells the temp root through the /var symlink.
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hook-open-count-')));
  projectDir = path.join(tmp, 'proj');
  localRoot = path.join(projectDir, '.hippo');
  globalRoot = path.join(tmp, 'global');
  fs.mkdirSync(projectDir, { recursive: true });
  initStore(localRoot);
  seed(localRoot, 'PINNED: always check the rollback plan before deploy', '2026-05-01T00:00:00.000Z', { pinned: true });
  seed(localRoot, 'the postgres migration needs a rollback plan and a dry run', '2026-05-20T00:00:00.000Z');
  seed(localRoot, 'deploy windows are Tuesday and Thursday afternoons only', '2026-05-21T00:00:00.000Z');
  seed(localRoot, 'release notes go out after the canary has been green for an hour', '2026-05-22T00:00:00.000Z');
  preloadPath = path.join(tmp, 'open-count-preload.mjs');
  fs.writeFileSync(preloadPath, PRELOAD_SRC);
  logPath = path.join(tmp, 'opens.json');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('per-prompt context hook', () => {
  it('opens the local store once and prints the same block on a new and a repeat turn', () => {
    const first = runHook(PROMPT_HOOK, promptPayload('sess-open-1'));
    expect(first.stdout).toMatchInlineSnapshot(`"{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"## Project Memory (1 entries, 28 tokens)\\n\\n- **[verified] PINNED: always check the rollback plan before deploy**\\n\\n## Prompt-Relevant Memory (1 entries, 32 tokens)\\n\\n- **[verified] the postgres migration needs a rollback plan and a dry run**"}}"`);
    expect(first.opens).toEqual({ local: 1 });

    const repeat = runHook(PROMPT_HOOK, promptPayload('sess-open-1'));
    expect(repeat.stdout).toMatchInlineSnapshot(`"{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"## Prompt-Relevant Memory (1 entries, 32 tokens)\\n\\n- **[verified] the postgres migration needs a rollback plan and a dry run**"}}"`);
    expect(repeat.opens).toEqual({ local: 1 });
  });

  it('opens each of the local and global stores once', () => {
    seedGlobalPin();

    const run = runHook(PROMPT_HOOK, promptPayload('sess-open-2'));
    expect(run.stdout).toMatchInlineSnapshot(`"{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"## Project Memory (2 entries, 45 tokens)\\n\\n- **[verified] PINNED: always check the rollback plan before deploy**\\n- **[verified] [global] PINNED: never force-push the main branch**\\n\\n## Prompt-Relevant Memory (1 entries, 32 tokens)\\n\\n- **[verified] the postgres migration needs a rollback plan and a dry run**"}}"`);
    expect(run.opens).toEqual({ local: 1, global: 1 });
  });

  it('opens the global store once from a directory with no local store', () => {
    fs.rmSync(localRoot, { recursive: true, force: true });
    seedGlobalPin();

    const run = runHook(PROMPT_HOOK, promptPayload('sess-open-3'));
    expect(run.stdout).toMatchInlineSnapshot(`"{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"## Project Memory (1 entries, 27 tokens)\\n\\n- **[verified] [global] PINNED: never force-push the main branch**"}}"`);
    expect(run.opens).toEqual({ global: 1 });
  });
});

describe('session and tool-failure hooks', () => {
  it('compact-resume opens the store once', () => {
    const run = runHook(['compact-resume'], JSON.stringify({ session_id: 'sess-open-4', source: 'compact' }));
    expect(run.stdout).toMatchInlineSnapshot(`""`);
    expect(run.opens).toEqual({ local: 1 });
  });

  it('post-compact opens the store once', () => {
    const payload = { session_id: 'sess-open-6', trigger: 'manual', compact_summary: 'Rolled back the postgres migration and wrote the deploy plan.' };
    const run = runHook(['post-compact', '--log-file', path.join(tmp, 'compact.log')], JSON.stringify(payload));
    expect(run.stdout).toMatchInlineSnapshot(`
      "Hippo kept this compaction's summary; it listed no new memories.
      "
    `);
    expect(run.opens).toEqual({ local: 1 });
  });

  it('capture-error opens the store once', () => {
    const payload = { session_id: 'sess-open-5', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Command failed: npm test exited 1' };
    const run = runHook(['capture-error'], JSON.stringify(payload));
    expect(run.stdout).toBe('');
    expect(run.opens).toEqual({ local: 1 });
  });
});
