// scripts/check-open-core.mjs: commercial-only additions under the scoped dirs fail, core ones pass.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

afterEach(() => {
  vi.unstubAllEnvs();
});

const SCRIPT = resolve('scripts/check-open-core.mjs');

describe('check-open-core', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const commit = (path: string, body: string, message: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  const run = () => {
    const env = { ...process.env, GITHUB_EVENT_PATH: '', GITHUB_EVENT_NAME: '' };
    return spawnSync(process.execPath, [SCRIPT, '--base', 'HEAD~1'], { cwd: repo, encoding: 'utf8', env }).status;
  };

  // One repo for the file: each case commits on top, and the check reads only that last commit (HEAD~1..HEAD).
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'open-core-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    commit('src/index.ts', 'export const x = 1;\n', 'base');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  // One case per test, so a test runs two git calls and one check, never a chain of them.
  it.each([
    ['a commercial path', 'src/auth/saml.ts', 'export {};\n', 'feat: saml', 1],
    ['a commercial identifier', 'src/store/auth.ts', 'export function ssoLogin() {}\n', 'feat: login', 1],
    ['the commercial marker', 'ui/app.ts', '// commercial\nexport {};\n', 'feat: ui', 1],
    [
      'a commercial route',
      'src/surface/server/route.ts',
      "export const path = '/v1/hooks/prompt';\n",
      'feat: hook route',
      1,
    ],
    ['a core file', 'src/processor.ts', 'export const processor = "session";\n', 'feat: core', 0],
    ['a doc naming a commercial term', 'docs/sso.md', 'SSO is commercial.\n', 'docs: sso', 0],
    ['a reviewed commit', 'src/sso-note.ts', 'export {};\n', 'feat: note\n\nopen-core: reviewed', 0],
    ['a copilot-report path', 'src/surface/cli/copilot-report.ts', 'export {};\n', 'feat: copilot report', 0],
    ['an import of copilot-report', 'src/surface/cli/setup.ts', "import './copilot-report.js';\n", 'feat: import', 0],
    ['a pilot-report path', 'src/x/pilot-report.ts', 'export {};\n', 'feat: pilot path', 1],
    ['a pilot_report identifier', 'src/x/a.ts', 'export const pilot_report = 1;\n', 'feat: underscore', 1],
    ['a spaced pilot report', 'src/x/b.ts', "export const t = 'pilot report';\n", 'feat: spaced', 1],
    ['an acronym-led pilot report', 'src/x/c.ts', 'export const APIPilotReport = 1;\n', 'feat: acronym pilot', 1],
    ['an acronym-led sso', 'src/x/d.ts', 'export const SSOLogin = 1;\n', 'feat: acronym sso', 1],
    ['a camelCase pilot report', 'src/x/e.ts', 'export const buildPilotReport = 1;\n', 'feat: camel pilot', 1],
  ])('the check on %s', (_name, path, body, message, code) => {
    commit(path, body, message);
    expect(run()).toBe(code);
  });
});
