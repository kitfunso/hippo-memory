import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';

let tmpDir: string;
let hippoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-pinned-'));
  hippoDir = path.join(tmpDir, '.hippo');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Always run against the local built CLI so we're testing our source, not a
// stale globally-installed version.
const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

function runHippo(args: string[]): string {
  // Point HIPPO_HOME at a separate dir so the global store doesn't leak into
  // the test (cmdContext merges local + global). The local store lives at
  // `${tmpDir}/.hippo` (resolved via getHippoRoot(cwd)).
  const globalDir = path.join(tmpDir, 'global');
  return execFileSync(process.execPath, [HIPPO_JS, ...args], {
    env: { ...process.env, HIPPO_HOME: globalDir },
    cwd: tmpDir,
    encoding: 'utf8',
  });
}

describe('hippo context --pinned-only', () => {
  it('returns only pinned entries in plain text', () => {
    initStore(hippoDir);
    const pinned = createMemory('NEVER skip the pre-commit hook because it caused three incidents', { pinned: true, layer: Layer.Episodic });
    const unpinned = createMemory('random note not pinned nor critical to this test', { pinned: false, layer: Layer.Episodic });
    writeEntry(hippoDir, pinned);
    writeEntry(hippoDir, unpinned);

    const out = runHippo(['context', '--pinned-only', '--budget', '500']);
    expect(out).toContain('NEVER skip the pre-commit hook');
    expect(out).not.toContain('random note not pinned');
  });

  it('emits empty string when no pinned entries', () => {
    initStore(hippoDir);
    const unpinned = createMemory('only unpinned entries here should produce empty output', { pinned: false });
    writeEntry(hippoDir, unpinned);

    const out = runHippo(['context', '--pinned-only', '--budget', '500']);
    expect(out.trim()).toBe('');
  });

  it('--format additional-context emits Claude Code hookSpecificOutput JSON', () => {
    initStore(hippoDir);
    const pinned = createMemory('NEVER use --no-verify because it bypasses signing', { pinned: true });
    writeEntry(hippoDir, pinned);

    const out = runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('NEVER use --no-verify');
  });

  it('--format additional-context with no pinned entries emits empty output (no crash)', () => {
    initStore(hippoDir);
    const out = runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);
    // Empty stdout signals "no injection needed". Claude Code treats empty
    // output as pass-through.
    expect(out.trim()).toBe('');
  });

  it('is read-only — does NOT bump retrieval_count on pinned memories', async () => {
    // Hook fires every turn; if each call inflated retrieval_count the
    // under-rehearsal score for pinned memories would skew over time.
    initStore(hippoDir);
    const pinned = createMemory('read-only test memory that should not be mutated by a context call', { pinned: true });
    writeEntry(hippoDir, pinned);

    runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);
    runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);
    runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);

    // Reload from disk and verify retrieval_count is still 0
    const { loadAllEntries } = await import('../src/store.js');
    const reloaded = loadAllEntries(hippoDir);
    const target = reloaded.find((e) => e.id === pinned.id);
    expect(target).toBeDefined();
    expect(target!.retrieval_count).toBe(0);
    expect(target!.last_retrieved).toBe(pinned.last_retrieved);
  });

  it('emits multiple pinned memories in one injection payload', () => {
    // End-to-end sanity: Claude Code's UserPromptSubmit response must be a
    // single string containing all rehearsed rules, not an array of blocks.
    initStore(hippoDir);
    const a = createMemory('never commit secrets to git rotate immediately if leaked', { pinned: true });
    const b = createMemory('use safe_sync.py not sync_to_supabase.py directly ever', { pinned: true });
    const c = createMemory('unpinned note that absolutely must not appear in the output', { pinned: false });
    writeEntry(hippoDir, a);
    writeEntry(hippoDir, b);
    writeEntry(hippoDir, c);

    const raw = runHippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '500']);
    const parsed = JSON.parse(raw);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('never commit secrets');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('use safe_sync.py');
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('unpinned note that absolutely must not appear');
  });

  it('respects config.pinnedInject.enabled=false (empty output)', () => {
    initStore(hippoDir);
    const pinned = createMemory('pinned rule that should NOT appear when disabled by config', { pinned: true });
    writeEntry(hippoDir, pinned);
    fs.writeFileSync(path.join(hippoDir, 'config.json'), JSON.stringify({ pinnedInject: { enabled: false } }));

    const out = runHippo(['context', '--pinned-only', '--format', 'additional-context']);
    expect(out.trim()).toBe('');
  });
});
