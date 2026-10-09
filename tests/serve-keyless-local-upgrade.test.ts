// What a user sees after upgrading: `hippo serve` says the key rule at start, and a routed CLI write with no key fails with the fix in its text.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/store/audit.js';
import { ROUTED_CLI_ENV } from './_helpers/routed-cli-env.js';
import { HIPPO_BIN, hippoOut, hippoRun } from './_helpers/spawn-hippo.js';

const MODE_KEYS = ['HIPPO_ALLOW_KEYLESS_LOCAL', 'HIPPO_REQUIRE_AUTH', 'HIPPO_API_KEY'];
const KEY_REQUIRED_LINE =
  'every request needs an API key: mint one with `hippo auth create` and send it as "Authorization: Bearer <key>" ' +
  '(the hippo CLI reads HIPPO_API_KEY). To let requests from this machine in without a key, start with HIPPO_ALLOW_KEYLESS_LOCAL=1';
const KEYLESS_LINE =
  'requests from this machine need no API key and act as host admin (HIPPO_ALLOW_KEYLESS_LOCAL=1); unset it to require a key on every request';

interface Served {
  readonly stdout: string;
  readonly stop: () => Promise<void>;
}

let workspace: string;
let stops: Array<() => Promise<void>>;

/** The test run's env with the three auth switches removed, so each case states the ones it sets. */
function childEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: join(workspace, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1', ...ROUTED_CLI_ENV };
  for (const key of MODE_KEYS) delete env[key];
  return { ...env, ...extra };
}

function startServe(extra: Readonly<Record<string, string>> = {}): Promise<Served> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HIPPO_BIN, 'serve', '--port', '0'], {
      cwd: workspace, env: childEnv(extra), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    const stop = async (): Promise<void> => {
      child.kill('SIGKILL');
      await exited;
      // A killed server leaves its pidfile, and the next one in the same store must not read it as a live twin.
      rmSync(join(workspace, '.hippo', 'server.pid'), { force: true });
    };
    stops.push(stop);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`no start lines within 30 s. stdout=${stdout} stderr=${stderr}`)), 30_000);
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (!stdout.includes('press Ctrl+C to stop')) return;
      clearTimeout(timer);
      resolve({ stdout, stop });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`hippo serve exited early (code=${code}). stdout=${stdout} stderr=${stderr}`));
    });
  });
}

function rememberActors(): string[] {
  const db = openHippoDb(join(workspace, '.hippo'));
  try {
    return queryAuditEvents(db, { tenantId: 'default', op: 'remember' }).map((event) => event.actor);
  } finally {
    closeHippoDb(db);
  }
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'hippo-keyless-upgrade-'));
  mkdirSync(join(workspace, '.hippo'), { recursive: true });
  initStore(join(workspace, '.hippo'));
  stops = [];
});

afterEach(async () => {
  for (const stop of stops) await stop();
  rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('hippo serve says its key rule at start', () => {
  it.each([
    ['no switch set', {}, KEY_REQUIRED_LINE],
    ['HIPPO_ALLOW_KEYLESS_LOCAL=1', { HIPPO_ALLOW_KEYLESS_LOCAL: '1' }, KEYLESS_LINE],
    ['HIPPO_REQUIRE_AUTH=1', { HIPPO_REQUIRE_AUTH: '1' }, 'every request needs an API key (HIPPO_REQUIRE_AUTH=1)'],
    ['both switches', { HIPPO_REQUIRE_AUTH: '1', HIPPO_ALLOW_KEYLESS_LOCAL: '1' }, 'every request needs an API key (HIPPO_REQUIRE_AUTH=1)'],
  ])('with %s', async (_name, env, line) => {
    const { stdout } = await startServe(env);
    expect(stdout.split(/\r?\n/)).toContain(line);
  }, 60_000);
});

describe('a routed CLI write against a server on the new default', () => {
  it('fails with the fix in its text and stores nothing, then works with a key', async () => {
    await startServe();
    const refused = hippoRun(['remember', 'upgrade-canary-no-key'], { cwd: workspace, env: childEnv() });
    // Not toBe(1): on Windows, Node can abort inside process.exit after a fetch and report its own exit code.
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('Error: auth required: this server takes no request without an API key.');
    expect(refused.stderr).toContain('hippo auth create');
    expect(refused.stderr).toContain('HIPPO_API_KEY');
    expect(refused.stderr).toContain('HIPPO_ALLOW_KEYLESS_LOCAL=1');
    expect(rememberActors()).toEqual([]);

    // The host CLI opens the store itself, so a key can be minted while the server refuses keyless requests.
    // SAFETY: `hippo auth create --json` prints one JSON object whose `plaintext` is the key.
    const minted = JSON.parse(hippoOut(['auth', 'create', '--label', 'upgrade', '--json'], { cwd: workspace, env: childEnv() })) as { plaintext: string };
    const keyed = hippoRun(['remember', 'upgrade-canary-with-key'], { cwd: workspace, env: childEnv({ HIPPO_API_KEY: minted.plaintext }) });
    expect(keyed.stderr).not.toContain('auth required');
    expect(keyed.status).toBe(0);
    expect(rememberActors()).toEqual([expect.stringMatching(/^api_key:/)]);
  }, 90_000);

  it('works with no key once the server is started with HIPPO_ALLOW_KEYLESS_LOCAL=1', async () => {
    await startServe({ HIPPO_ALLOW_KEYLESS_LOCAL: '1' });
    const run = hippoRun(['remember', 'upgrade-canary-opt-in'], { cwd: workspace, env: childEnv() });
    expect(run.stderr).not.toContain('auth required');
    expect(run.status).toBe(0);
    expect(rememberActors()).toEqual(['localhost:cli']);
  }, 60_000);

  it('is untouched when no server runs: the CLI writes to the store itself', () => {
    const run = hippoRun(['remember', 'upgrade-canary-direct'], { cwd: workspace, env: childEnv() });
    expect(run.status).toBe(0);
    expect(rememberActors()).toEqual(['cli']);
  }, 60_000);
});
