import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Layer } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { runCli } from '../../src/cli.js';
import { withHookStdin } from '../_helpers/hook-stdin.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

let tmpDir: string;
let hippoDir: string;

beforeEach(() => {
  tmpDir = makeRoot('pinned', { init: false });
  hippoDir = path.join(tmpDir, '.hippo');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** `hippo <args>` run in this process from `cwd` with an empty hook stdin, the call bin/hippo.js makes; a non-zero exit fails the test. */
async function hippoIn(cwd: string, globalDir: string, args: string[]): Promise<string> {
  vi.stubEnv('HIPPO_HOME', globalDir);
  const saved = process.cwd();
  process.chdir(cwd);
  try {
    const r = await runInProcess(() => withHookStdin(undefined, () => runCli(['node', 'hippo', ...args])));
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.chdir(saved);
  }
}

function runHippo(args: string[]): Promise<string> {
  // Point HIPPO_HOME at a separate dir so the global store doesn't leak into
  // the test (printContext merges local + global). The local store lives at
  // `${tmpDir}/.hippo` (resolved via getHippoRoot(cwd)).
  return hippoIn(tmpDir, path.join(tmpDir, 'global'), args);
}

describe('hippo context --pinned-only', () => {
  it('returns only pinned entries in plain text', async () => {
    initTestStore(hippoDir);
    const pinned = createMemory('NEVER skip the pre-commit hook because it caused three incidents', {
      pinned: true,
      layer: Layer.Episodic,
    });
    const unpinned = createMemory('random note not pinned nor critical to this test', {
      pinned: false,
      layer: Layer.Episodic,
    });
    writeEntry(hippoDir, pinned);
    writeEntry(hippoDir, unpinned);

    const out = await runHippo(['context', '--pinned-only', '--budget', '500']);
    expect(out).toContain('NEVER skip the pre-commit hook');
    expect(out).not.toContain('random note not pinned');
  });

  it('emits empty string when no pinned entries', async () => {
    initTestStore(hippoDir);
    const unpinned = createMemory('only unpinned entries here should produce empty output', { pinned: false });
    writeEntry(hippoDir, unpinned);

    const out = await runHippo(['context', '--pinned-only', '--budget', '500']);
    expect(out.trim()).toBe('');
  });

  it('--format additional-context emits Claude Code hookSpecificOutput JSON', async () => {
    initTestStore(hippoDir);
    const pinned = createMemory('NEVER use --no-verify because it bypasses signing', { pinned: true });
    writeEntry(hippoDir, pinned);

    const out = await runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toBeTypeOf('string');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('NEVER use --no-verify');
  });

  it('--format additional-context with no pinned entries emits empty output (no crash)', async () => {
    initTestStore(hippoDir);
    const out = await runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);
    // Empty stdout signals "no injection needed". Claude Code treats empty
    // output as pass-through.
    expect(out.trim()).toBe('');
  });

  it('--include-recent surfaces fresh unpinned entries alongside pinned-only context', async () => {
    initTestStore(hippoDir);
    const oldPinned = createMemory('PINNED RULE: always verify the hook output', { pinned: true });
    const oldUnpinned = createMemory('old unpinned note should not appear just because it exists', { pinned: false });
    const recentA = createMemory('fresh same-session correction should appear on the next prompt', { pinned: false });
    const recentB = createMemory('fresh same-session follow-up should also appear', { pinned: false });
    oldPinned.created = '2026-05-08T10:00:00.000Z';
    oldUnpinned.created = '2026-05-08T10:01:00.000Z';
    recentA.created = '2026-05-08T10:02:00.000Z';
    recentB.created = '2026-05-08T10:03:00.000Z';
    writeEntry(hippoDir, oldPinned);
    writeEntry(hippoDir, oldUnpinned);
    writeEntry(hippoDir, recentA);
    writeEntry(hippoDir, recentB);

    const raw = await runHippo([
      'context',
      '--pinned-only',
      '--include-recent',
      '2',
      '--format',
      'additional-context',
      '--budget',
      '500',
    ]);
    const parsed = JSON.parse(raw);
    const context = parsed.hookSpecificOutput.additionalContext;
    expect(context).toContain('PINNED RULE: always verify the hook output');
    expect(context).toContain('fresh same-session correction should appear');
    expect(context).toContain('fresh same-session follow-up should also appear');
    expect(context).not.toContain('old unpinned note should not appear');
  });

  it('--include-recent works even when no memories are pinned', async () => {
    initTestStore(hippoDir);
    const recent = createMemory('fresh unpinned lesson must not be invisible until next session', { pinned: false });
    writeEntry(hippoDir, recent);

    const raw = await runHippo([
      'context',
      '--pinned-only',
      '--include-recent',
      '1',
      '--format',
      'additional-context',
      '--budget',
      '500',
    ]);
    const parsed = JSON.parse(raw);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('fresh unpinned lesson must not be invisible');
  });

  it('is read-only — does NOT bump retrieval_count on pinned memories', async () => {
    // Hook fires every turn; if each call inflated retrieval_count the
    // under-rehearsal score for pinned memories would skew over time.
    initTestStore(hippoDir);
    const pinned = createMemory('read-only test memory that should not be mutated by a context call', { pinned: true });
    writeEntry(hippoDir, pinned);

    await runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);
    await runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);
    await runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);

    // Reload from disk and verify retrieval_count is still 0
    const { loadAllEntries } = await import('../_helpers/root-forms.js');
    const reloaded = loadAllEntries(hippoDir, 'default');
    const target = reloaded.find((e) => e.id === pinned.id);
    expect(target?.retrievalCount).toBe(0);
    expect(target!.lastRetrieved).toBe(pinned.lastRetrieved);
  });

  it('emits multiple pinned memories in one injection payload', async () => {
    // End-to-end sanity: Claude Code's UserPromptSubmit response must be a
    // single string containing all rehearsed rules, not an array of blocks.
    initTestStore(hippoDir);
    const a = createMemory('never commit secrets to git rotate immediately if leaked', { pinned: true });
    const b = createMemory('use safe_sync.py not sync_to_supabase.py directly ever', { pinned: true });
    const c = createMemory('unpinned note that absolutely must not appear in the output', { pinned: false });
    writeEntry(hippoDir, a);
    writeEntry(hippoDir, b);
    writeEntry(hippoDir, c);

    const raw = await runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);
    const parsed = JSON.parse(raw);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toBeTypeOf('string');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('never commit secrets');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('use safe_sync.py');
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('unpinned note that absolutely must not appear');
  });

  it('does NOT fail when local .hippo is missing (regression: UserPromptSubmit hook error)', async () => {
    // Regression for v0.29.2: the UserPromptSubmit hook fires in EVERY Claude
    // Code session, including directories without a .hippo/ store. Before the
    // fix, `hippo context --pinned-only` called requireInit() first and the
    // hook would error with "No .hippo directory found."
    //
    // Expected behaviour: when the cwd has no local store, fall back to
    // global-only. If global also has no pinned memories, exit cleanly with
    // empty stdout (hook no-ops).
    //
    // We stand up a tmp GLOBAL with a pinned memory, point cwd at a fresh
    // tmpdir that has NO local .hippo/, and expect the global memory to show
    // up in the additional-context payload.
    const globalDir = makeRoot('global');
    const freshCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-fresh-cwd-'));
    try {
      const pinned = createMemory('REGRESSION GUARD: no local hippo should still deliver pinned content', {
        pinned: true,
      });
      writeEntry(globalDir, pinned);

      const out = await hippoIn(freshCwd, globalDir, [
        'context',
        '--pinned-only',
        '--format',
        'additional-context',
        '--budget',
        '500',
      ]);

      // Must NOT throw, must NOT print to stderr, must contain the pinned memory.
      expect(out.trim()).not.toBe('');
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.additionalContext).toContain('REGRESSION GUARD');

      // And must NOT have auto-created .hippo in freshCwd (would pollute user's dirs).
      expect(fs.existsSync(path.join(freshCwd, '.hippo'))).toBe(false);
    } finally {
      fs.rmSync(freshCwd, { recursive: true, force: true });
    }
  });

  it('exits cleanly when both local AND global are empty (pinned-only, fresh cwd)', async () => {
    // Variant of the regression test: no local, no global pinned memories,
    // hook must produce empty stdout (not an error).
    const globalDir = makeRoot('empty', { init: false });
    const freshCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cwd-'));
    try {
      // Do NOT init globalDir — it's just an empty path.
      const out = await hippoIn(freshCwd, globalDir, [
        'context',
        '--pinned-only',
        '--format',
        'additional-context',
        '--budget',
        '500',
      ]);
      expect(out.trim()).toBe('');
      expect(fs.existsSync(path.join(freshCwd, '.hippo'))).toBe(false);
    } finally {
      fs.rmSync(freshCwd, { recursive: true, force: true });
    }
  });

  it('respects config.pinnedInject.enabled=false (empty output)', async () => {
    initTestStore(hippoDir);
    const pinned = createMemory('pinned rule that should NOT appear when disabled by config', { pinned: true });
    writeEntry(hippoDir, pinned);
    fs.writeFileSync(path.join(hippoDir, 'config.json'), JSON.stringify({ pinnedInject: { enabled: false } }));

    const out = await runHippo(['context', '--pinned-only', '--format', 'additional-context']);
    expect(out.trim()).toBe('');
  });
});
