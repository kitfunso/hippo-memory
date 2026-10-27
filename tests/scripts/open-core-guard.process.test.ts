// scripts/check-open-core.mjs: commercial-only additions under the scoped dirs fail, core ones pass.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    commit('src/store/auth.ts', 'export function ssoLogin() {}\n', 'feat: login');
    expect(run()).toBe(1);
    commit('ui/app.ts', '// commercial\nexport {};\n', 'feat: ui');
    expect(run()).toBe(1);
    commit('src/surface/server/route.ts', "export const path = '/v1/hooks/prompt';\n", 'feat: hook route');
    expect(run()).toBe(1);
    commit('src/processor.ts', 'export const processor = "session";\n', 'feat: core');
    expect(run()).toBe(0);
    commit('docs/sso.md', 'SSO is commercial.\n', 'docs: sso');
    expect(run()).toBe(0);
    commit('src/sso-note.ts', 'export {};\n', 'feat: note\n\nopen-core: reviewed');
    expect(run()).toBe(0);
  });

  it('passes copilot-report and fails pilot report in every spelling', () => {
    commit('src/surface/cli/copilot-report.ts', 'export {};\n', 'feat: copilot report');
    expect(run()).toBe(0);
    commit('src/surface/cli/setup.ts', "import './copilot-report.js';\n", 'feat: import');
    expect(run()).toBe(0);
    commit('src/x/pilot-report.ts', 'export {};\n', 'feat: pilot path');
    expect(run()).toBe(1);
    commit('src/x/a.ts', 'export const pilot_report = 1;\n', 'feat: underscore');
    expect(run()).toBe(1);
    commit('src/x/b.ts', "export const t = 'pilot report';\n", 'feat: spaced');
    expect(run()).toBe(1);
  });

  it('fails acronym-led and camelCase identifiers for commercial terms', () => {
    commit('src/x/c.ts', 'export const APIPilotReport = 1;\n', 'feat: acronym pilot');
    expect(run()).toBe(1);
    commit('src/x/d.ts', 'export const SSOLogin = 1;\n', 'feat: acronym sso');
    expect(run()).toBe(1);
    commit('src/x/e.ts', 'export const buildPilotReport = 1;\n', 'feat: camel pilot');
    expect(run()).toBe(1);
  });
});
