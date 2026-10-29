// bin/hippo.js drops Node's SQLite ExperimentalWarning so an agent does not read it on each call, and drops no other warning.
// Spawned without --no-warnings, since that flag would hide the warning this file looks for.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hippoRun } from './_helpers/spawn-hippo.js';

const DIST_CLI = resolve(__dirname, '..', 'dist', 'cli.js');
const SQLITE_WARNING = /ExperimentalWarning: SQLite/;
// The CLI rejects text under 3 characters before it opens the store.
const REMEMBER = ['remember', 'sqlite warning probe', '--error'];
// Fires in a microtask right after the bin assigns process.emitWarning; a timer would not run before the CLI exits.
const PROBE = `let current = process.emitWarning;
Object.defineProperty(process, 'emitWarning', {
  configurable: true,
  enumerable: true,
  get: () => current,
  set: (fn) => {
    current = fn;
    queueMicrotask(() => fn('probe-warning', 'ExperimentalWarning'));
  },
});
`;

const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'NODE_NO_WARNINGS']) delete env[key];
  return env;
};

// A Node that no longer warns about node:sqlite has nothing for the filter to drop.
const nodeWarnsOnSqlite = SQLITE_WARNING.test(
  spawnSync(process.execPath, ['-e', "require('node:sqlite')"], { encoding: 'utf8', env: cleanEnv() }).stderr,
);

let root: string;
let proj: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-bin-warning-'));
  proj = join(root, 'proj');
  mkdirSync(proj);
  env = { ...cleanEnv(), HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), HIPPO_HOME: join(root, 'global'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
  // The CLI exits before it loads node:sqlite when no store exists, so the cases below would prove nothing.
  const init = hippoRun(['init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: proj, env });
  expect(init.status, init.stderr).toBe(0);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!nodeWarnsOnSqlite)('bin/hippo.js and the node:sqlite warning', () => {
  it('prints no SQLite ExperimentalWarning for a command that opens the store', () => {
    const res = hippoRun(REMEMBER, { cwd: proj, env });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).not.toMatch(SQLITE_WARNING);
  });

  it('control: node dist/cli.js, with no filter, prints the warning for the same command', () => {
    const res = spawnSync(process.execPath, [DIST_CLI, ...REMEMBER], { cwd: proj, env, encoding: 'utf8' });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toMatch(SQLITE_WARNING);
  });

  it('still prints a warning that is not the SQLite one, including another ExperimentalWarning', () => {
    const probe = join(root, 'probe.mjs');
    writeFileSync(probe, PROBE);
    const res = hippoRun(REMEMBER, { cwd: proj, env: { ...env, NODE_OPTIONS: `--import=${pathToFileURL(probe).href}` } });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain('probe-warning');
    expect(res.stderr).not.toMatch(SQLITE_WARNING);
  });
});
