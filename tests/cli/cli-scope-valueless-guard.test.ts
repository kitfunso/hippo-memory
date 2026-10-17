// One global guard in CLI dispatch exits 1 on any `--scope` that is not a non-empty string, on every command.
// Before it, a value-less `--scope` became the literal scope 'true' at some sites and was dropped at others.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { runInProcess, type InProcessResult } from '../_helpers/run-in-process.js';
import { makeStore } from '../_helpers/make-root.js';

const USAGE_MSG = '--scope requires a non-empty value (e.g. --scope slack:private:C1).';

const savedCwd = process.cwd();
let home = '';

const hippoRun = (...args: string[]): Promise<InProcessResult> => runInProcess(() => runCli(['node', 'hippo', ...args]));

async function hippo(...args: string[]): Promise<string> {
  const res = await hippoRun(...args);
  expect(res.status, res.stderr).toBe(0);
  return res.stdout;
}

beforeEach(() => {
  home = makeStore('scope-guard').base;
  vi.stubEnv('HIPPO_HOME', join(home, 'global-hippo'));
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  vi.stubEnv('HIPPO_TENANT', '');
  process.chdir(home);
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('global --scope value-less guard: exit-1 cases', () => {
  // The guard fires pre-dispatch, so command-specific argument validity does not matter here.
  it.each([
    { label: 'remember', args: ['remember', 'some memory content', '--scope'] },
    { label: 'recall', args: ['recall', 'some query', '--scope'] },
    { label: 'explain', args: ['explain', 'some query', '--scope'] },
    { label: 'context', args: ['context', 'some query', '--scope'] },
    { label: 'import', args: ['import', 'nonexistent-file.json', '--scope'] },
    { label: 'wm push', args: ['wm', 'push', '--content', 'wm item', '--scope'] },
    { label: 'wm read', args: ['wm', 'read', '--scope'] },
    { label: 'wm clear', args: ['wm', 'clear', '--scope'] },
    { label: 'wm flush', args: ['wm', 'flush', '--scope'] },
    { label: 'assemble', args: ['assemble', '--session', 's1', '--scope'] },
  ])('$label: value-less --scope exits 1 with the usage message', async ({ args }) => {
    const res = await hippoRun(...args);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(USAGE_MSG);
  });

  // '' parses like value-less (falsy, so the boolean branch fires); '   ' is a real string the .trim() branch must catch.
  it.each(['', '   '])('recall: --scope %j exits 1', async (value) => {
    const res = await hippoRun('recall', 'some query', '--scope', value);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(USAGE_MSG);
  });

  // Pins the GLOBAL semantics: handleStatus never reads --scope, yet the guard still exits 1 before dispatch.
  it('status (a command that ignores --scope today): value-less --scope still exits 1 (pins global-guard semantics)', async () => {
    const res = await hippoRun('status', '--scope');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(USAGE_MSG);
  });
});

describe('valued --scope regression coverage', () => {
  it('wm push --scope X then wm read --scope X roundtrip surfaces the item', async () => {
    await hippo('wm', 'push', '--scope', 'projX', '--content', 'wm item one');
    expect(await hippo('wm', 'read', '--scope', 'projX')).toContain('wm item one');

    // Current contract, pinned not desired: a bare `wm read` applies no scope filter (wmRead), so scope-X items show.
    expect(await hippo('wm', 'read')).toContain('wm item one');
  });

  // assemble forwards --scope to api.assemble's exact mode (passesScopeFilterForRecall), unlike recall's additive unlock:
  // only rows whose envelope scope equals it pass, so NULL-scope and other scopes are excluded.
  it('assemble --scope X pins CURRENT exact-narrowing behavior (api.assemble -> passesScopeFilterForRecall)', async () => {
    const hippoDir = join(home, '.hippo');
    const sessionId = 'sess-scope-pin';
    const mkRaw = (text: string, scope: string | null) => createMemory(text, {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      kind: 'raw',
      tenantId: 'default',
      sourceSessionId: sessionId,
      scope,
    });
    writeEntry(hippoDir, mkRaw('null scope row content here', null));
    writeEntry(hippoDir, mkRaw('projx scope row content here', 'projX'));
    writeEntry(hippoDir, mkRaw('projy scope row content here', 'projY'));

    const raw = await hippo('assemble', '--session', sessionId, '--scope', 'projX', '--json');
    // SAFETY: `hippo assemble --json` prints api.assemble()'s AssembleResult; only .items[].content is read.
    const parsed = JSON.parse(raw) as { items: Array<{ content: string }> };
    const contents = parsed.items.map((it) => it.content);
    expect(contents.some((c) => c.includes('projx scope row'))).toBe(true);
    expect(contents.some((c) => c.includes('null scope row'))).toBe(false);
    expect(contents.some((c) => c.includes('projy scope row'))).toBe(false);
  });
});
