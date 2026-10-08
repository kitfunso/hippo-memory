// A write that dies halfway (full disk, killed process) must leave the user's file as it was, never half of the new text.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureInstructionsBlock } from '../src/hooks/copilot.js';
import { installOpencodePlugin } from '../src/hooks/opencode.js';
import { registerWorkspace, workspaceRegistryPath } from '../src/scheduler.js';
import { withFakeHome, type FakeHomeHandle } from './_helpers/with-fake-home.js';

let env: FakeHomeHandle;
beforeEach(() => {
  env = withFakeHome('hippo-write-interrupted-');
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  env.cleanup();
});

/** Every write lands its first half and then fails the way a full disk does. Stubbed because no real fault stops a write midway on demand. */
function failWritesHalfway(): void {
  const write = fs.writeFileSync.bind(fs);
  vi.spyOn(fs, 'writeFileSync').mockImplementation((dest, data, options) => {
    const text = String(data);
    write(dest, text.slice(0, Math.ceil(text.length / 2)), options);
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  });
  syncBuiltinESMExports();
}

function seed(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

describe('a config write that fails halfway', () => {
  it('leaves opencode.json as it was when the legacy-hook cleanup cannot finish', () => {
    const file = path.join(env.home, '.config', 'opencode', 'opencode.json');
    const before = JSON.stringify({
      theme: 'dark',
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'hippo session-end --log-file foo', timeout: 5 }] }] },
    }, null, 2);
    seed(file, before);
    failWritesHalfway();

    expect(() => installOpencodePlugin()).toThrow(/ENOSPC/);

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['opencode.json']);
  });

  it('leaves the workspace registry readable, with the workspaces it already had', () => {
    const globalRoot = path.join(env.home, '.hippo');
    registerWorkspace(globalRoot, path.join(env.home, 'repo-a'));
    const file = workspaceRegistryPath(globalRoot);
    const before = fs.readFileSync(file, 'utf8');
    failWritesHalfway();

    expect(() => registerWorkspace(globalRoot, path.join(env.home, 'repo-b'))).toThrow(/ENOSPC/);

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(JSON.parse(before).workspaces).toHaveLength(1);
    expect(fs.readdirSync(globalRoot).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('leaves the user text in copilot-instructions.md untouched', () => {
    const file = path.join(env.home, 'repo', '.github', 'copilot-instructions.md');
    const before = '# House rules\n\nAlways run the linter before a commit.\n';
    seed(file, before);
    failWritesHalfway();

    expect(() => ensureInstructionsBlock(file)).toThrow(/ENOSPC/);

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['copilot-instructions.md']);
  });
});

describe('a config write that succeeds', () => {
  it('replaces the workspace registry and leaves no temp file beside it', () => {
    const globalRoot = path.join(env.home, '.hippo');
    registerWorkspace(globalRoot, path.join(env.home, 'repo-a'));
    registerWorkspace(globalRoot, path.join(env.home, 'repo-b'));

    expect(JSON.parse(fs.readFileSync(workspaceRegistryPath(globalRoot), 'utf8')).workspaces).toHaveLength(2);
    expect(fs.readdirSync(globalRoot).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});
