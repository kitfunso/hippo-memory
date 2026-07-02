import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/memory.js';
import { initStore, writeEntry } from '../src/store.js';

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');

function recallContents(
  project: string,
  home: string,
  globalRoot: string,
  ...args: string[]
): string[] {
  const stdout = execFileSync(
    process.execPath,
    [CLI_PATH, 'recall', 'canary', '--classic', '--json', ...args],
    {
      cwd: project,
      env: { ...process.env, HOME: home, USERPROFILE: home, HIPPO_HOME: globalRoot },
      encoding: 'utf8',
    },
  );
  return (JSON.parse(stdout) as { results: Array<{ content: string }> })
    .results.map((result) => result.content);
}

describe('CLI recall scope filtering', () => {
  beforeAll(() => {
    if (!existsSync(CLI_PATH) || !statSync(CLI_PATH).isFile()) {
      throw new Error(`dist/cli.js not found at ${CLI_PATH}. Run \`npm run build\` first.`);
    }
  });

  it('default-denies private and legacy rows from local and global stores', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-cli-recall-scope-'));
    const project = join(home, 'project');
    const localRoot = join(project, '.hippo');
    const globalRoot = join(home, '.hippo-global');
    mkdirSync(localRoot, { recursive: true });
    initStore(localRoot);
    initStore(globalRoot);

    writeEntry(localRoot, createMemory('public local canary', { scope: 'github:public:acme/open' }));
    writeEntry(localRoot, createMemory('private local canary', { scope: 'github:private:acme/secret' }));
    writeEntry(globalRoot, createMemory('public global canary', { scope: 'slack:public:Cgeneral' }));
    writeEntry(globalRoot, createMemory('private global canary', { scope: 'slack:private:Csecret' }));
    writeEntry(globalRoot, createMemory('legacy global canary', { scope: 'unknown:legacy' }));

    try {
      const contents = recallContents(project, home, globalRoot);
      expect(contents).toContain('public local canary');
      expect(contents).toContain('public global canary');
      expect(contents).not.toContain('private local canary');
      expect(contents).not.toContain('private global canary');
      expect(contents).not.toContain('legacy global canary');

      const localOnly = recallContents(project, home, join(home, 'missing-global'));
      expect(localOnly).toContain('public local canary');
      expect(localOnly).not.toContain('private local canary');

      const explicitPrivate = recallContents(
        project,
        home,
        globalRoot,
        '--scope',
        'github:private:acme/secret',
      );
      expect(explicitPrivate).toContain('private local canary');

      const valuelessScope = recallContents(project, home, globalRoot, '--scope');
      expect(valuelessScope).not.toContain('private local canary');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});
