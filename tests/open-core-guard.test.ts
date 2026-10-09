// scripts/check-open-core.mjs: commercial-only additions under the scoped dirs fail, core ones pass.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'open-core-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    commit('src/index.ts', 'export const x = 1;\n', 'base');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('fails on a commercial path, a commercial identifier and the marker; passes core and docs', () => {
    commit('src/auth/saml.ts', 'export {};\n', 'feat: saml');
    expect(run()).toBe(1);
    commit('src/auth.ts', 'export function ssoLogin() {}\n', 'feat: login');
    expect(run()).toBe(1);
    commit('ui/app.ts', '// commercial\nexport {};\n', 'feat: ui');
    expect(run()).toBe(1);
    commit('src/server/route.ts', "export const path = '/v1/hooks/prompt';\n", 'feat: hook route');
    expect(run()).toBe(1);
    commit('src/processor.ts', 'export const processor = "session";\n', 'feat: core');
    expect(run()).toBe(0);
    commit('docs/sso.md', 'SSO is commercial.\n', 'docs: sso');
    expect(run()).toBe(0);
    commit('src/sso-note.ts', 'export {};\n', 'feat: note\n\nopen-core: reviewed');
    expect(run()).toBe(0);
  });
});
