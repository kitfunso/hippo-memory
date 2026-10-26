// What a user sees after upgrading: `hippo serve` says the key rule at start, and a routed CLI write sends the key
// serve wrote, with no switch to set.
import { afterEach, beforeEach, describe, expect, it, onTestFailed } from 'vitest';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { listAuditEvents } from '../../src/store/sqlite/audit.js';
import { mintedKeyId } from '../../src/base/scope/api-key.js';
import { ROUTED_CLI_ENV } from '../_helpers/routed-cli-env.js';
import { HIPPO_BIN } from '../_helpers/hippo-bin.js';
import { hippoOut, hippoRun } from '../_helpers/spawn-hippo.js';
import { makeStore } from '../_helpers/make-root.js';

// The removed keyless switches stay in this list, so a leftover one in the test run's env cannot change a case.
const MODE_KEYS = [
  'HIPPO_ALLOW_KEYLESS_LOCAL',
  'HIPPO_KEYLESS_LOCAL_ROLE',
  'HIPPO_REQUIRE_AUTH',
  'HIPPO_API_KEY',
];
const KEY_RULE =
  'every request needs an API key: the hippo CLI here sends HIPPO_API_KEY, else the member key in ';

interface Served {
  readonly stdout: string;
  readonly stop: () => Promise<void>;
}

let workspace: string;
let stops: Array<() => Promise<void>>;

/** The test run's env with the auth variables removed, so each case states the ones it sets. */
function childEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HIPPO_HOME: join(workspace, 'global-hippo'),
    HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
    ...ROUTED_CLI_ENV,
  };
  for (const key of MODE_KEYS) delete env[key];
  return { ...env, ...extra };
}

function startServe(extra: Readonly<Record<string, string>> = {}): Promise<Served> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HIPPO_BIN, 'serve', '--port', '0'], {
      cwd: workspace,
      env: childEnv(extra),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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
    // A start that never prints its lines fails at the test timeout; this keeps what it did print.
    onTestFailed(() => {
      console.error(`stdout=${stdout} stderr=${stderr}`);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('press Ctrl+C to stop')) resolve({ stdout, stop });
    });
    child.once('exit', (code) => {
      reject(
        new Error(`hippo serve exited early (code=${code}). stdout=${stdout} stderr=${stderr}`),
      );
    });
  });
}

function rememberActors(): string[] {
  const db = openHippoDb(join(workspace, '.hippo'));
  try {
    return listAuditEvents(db, { tenantId: 'default', op: 'remember' }).map((event) => event.actor);
  } finally {
    closeHippoDb(db);
  }
}

beforeEach(() => {
  workspace = makeStore('local-key-cli').base;
  stops = [];
});

afterEach(async () => {
  for (const stop of stops) await stop();
});

describe('hippo serve says its key rule at start', () => {
  it.each([
    ['no variable set', {}],
    [
      'the removed HIPPO_ALLOW_KEYLESS_LOCAL=1, which nothing reads',
      { HIPPO_ALLOW_KEYLESS_LOCAL: '1' },
    ],
    ['the removed HIPPO_REQUIRE_AUTH=1, which nothing reads', { HIPPO_REQUIRE_AUTH: '1' }],
  ])('with %s', async (_name, env) => {
    const { stdout } = await startServe(env);
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith(KEY_RULE));
    expect(line).toMatch(
      /server\.key \(readable by this user only\); mint others with `hippo auth create`$/,
    );
  });
});

describe('a routed CLI write', () => {
  it('sends the key serve wrote when HIPPO_API_KEY is unset', async () => {
    await startServe({ HIPPO_ALLOW_KEYLESS_LOCAL: '1' });
    const run = hippoRun(['remember', 'local-key-canary'], { cwd: workspace, env: childEnv() });
    expect(run.stderr).not.toContain('auth required');
    expect(run.status).toBe(0);
    expect(rememberActors()).toEqual(['localhost:cli']);
  });

  it('sends HIPPO_API_KEY when it is set', async () => {
    await startServe();
    // The host CLI opens the store itself, so a key can be minted while the server runs.
    // SAFETY: `hippo auth create --json` prints one JSON object whose `plaintext` is the key.
    const minted = JSON.parse(
      hippoOut(['auth', 'create', '--label', 'upgrade', '--json'], {
        cwd: workspace,
        env: childEnv(),
      }),
    ) as { plaintext: string };
    const keyed = hippoRun(['remember', 'env-key-canary'], {
      cwd: workspace,
      env: childEnv({ HIPPO_API_KEY: minted.plaintext }),
    });
    expect(keyed.status).toBe(0);
    expect(rememberActors()).toEqual([`api_key:${mintedKeyId(minted.plaintext)}`]);
  });

  it('is untouched when no server runs: the CLI writes to the store itself', () => {
    const run = hippoRun(['remember', 'direct-canary'], { cwd: workspace, env: childEnv() });
    expect(run.status).toBe(0);
    expect(rememberActors()).toEqual(['cli']);
  });
});
