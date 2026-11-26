import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parkInDlq } from '../../src/surface/connectors/dlq.js';
import { slackDlq } from '../../src/surface/connectors/slack/dlq.js';
import { runCliOut } from '../_helpers/run-cli-as.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadConfig } from '../../src/host/config-file.js';
import { runConnectorCommand } from '../../src/server.js';
import { createCallerState } from '../../src/api/callers.js';
import { readPackageVersion } from '../../src/host/package-version.js';
import { StoreNotPortedError } from '../../src/base/util/store-blocked.js';
import { makeRoot, makeStore } from '../_helpers/make-root.js';
import { testInfra } from '../_helpers/infra.js';

const CLI = resolve(__dirname, '..', '..', 'bin', 'hippo.js');

async function runCli(cwd: string, args: string[]): Promise<string> {
  if (!existsSync(CLI)) {
    throw new Error(`bin/hippo.js not found at ${CLI} — run \`npm run build\` first`);
  }
  return await runCliOut(args, { cwd, env: { ...process.env, HIPPO_HOME: join(cwd, '.hippo') } });
}

describe('hippo slack CLI', () => {
  let root: string;

  beforeEach(() => {
    root = makeStore('slack-cli').base;
  });

  it('hippo slack dlq list prints DLQ rows', async () => {
    await parkInDlq(slackDlq, sqliteStore(join(root, '.hippo')), {
      tenantId: 'default',
      rawPayload: '{"x":1}',
      error: 'bad event',
    });
    const out = await runCli(root, ['slack', 'dlq', 'list']);
    expect(out).toContain('bad event');
  });

  it('hippo slack backfill --help mentions --channel and --since', async () => {
    const out = await runCli(root, ['slack', 'backfill', '--help']);
    expect(out).toMatch(/--channel/);
    expect(out).toMatch(/--since/);
  });
});

describe('runConnectorCommand on a handed store', () => {
  let handed: string;
  let emptyHome: string;
  let emptyCwd: string;
  let savedCwd: string;
  let printed: string[];
  let failed: string[];

  const ctx = () => ({
    tenantId: 'default',
    store: sqliteStore(handed),
    config: loadConfig(handed),
    infra: testInfra(),
  });

  beforeEach(() => {
    handed = makeRoot('slack-runner');
    emptyHome = makeRoot('slack-runner-home', { init: false });
    emptyCwd = makeRoot('slack-runner-cwd', { init: false });
    savedCwd = process.cwd();
    process.chdir(emptyCwd);
    vi.stubEnv('HIPPO_HOME', emptyHome);
    printed = [];
    failed = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void printed.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void failed.push(a.join(' ')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.chdir(savedCwd);
  });

  const withoutConnectorGroups = () => {
    const { connectorWrites: _writes, connectorEvents: _events, ...bare } = sqliteStore(handed);
    return { ...ctx(), store: bare };
  };

  const noHippoDbElsewhere = (): void => {
    expect(existsSync(join(emptyHome, 'hippo.db'))).toBe(false);
    expect(existsSync(join(emptyCwd, '.hippo', 'hippo.db'))).toBe(false);
  };

  it('slack dlq list prints the parked row from the handed store and opens no hippo.db elsewhere', async () => {
    await parkInDlq(slackDlq, sqliteStore(handed), { tenantId: 'default', rawPayload: '{"x":1}', error: 'bad event' });

    const code = await runConnectorCommand(ctx(), ['slack', 'dlq', 'list']);

    expect(code).toBe(0);
    expect(printed.join('\n')).toContain('bad event');
    noHippoDbElsewhere();
  });

  it('slack workspaces add then list works on the handed store', async () => {
    expect(await runConnectorCommand(ctx(), ['slack', 'workspaces', 'add', '--team', 'T1', '--tenant', 'acme'])).toBe(
      0,
    );
    expect(await runConnectorCommand(ctx(), ['slack', 'workspaces', 'list'])).toBe(0);

    expect(printed.join('\n')).toMatch(/added: T1 -> acme/);
    expect(printed.join('\n')).toMatch(/T1\tacme\t/);
    expect(await sqliteStore(handed).connectorEvents.route({ connector: 'slack', teamId: 'T1' })).toEqual({
      tenantId: 'acme',
    });
    noHippoDbElsewhere();
  });

  it('prints the verb usage for --help and returns 0 before the connector groups are checked', async () => {
    expect(await runConnectorCommand(withoutConnectorGroups(), ['slack', 'backfill', '--help'])).toBe(0);
    expect(printed.join('\n')).toMatch(/--channel/);
    expect(await runConnectorCommand(withoutConnectorGroups(), ['slack', '-h'])).toBe(0);
    expect(printed.join('\n')).toMatch(/workspaces <add\|list\|remove>/);
  });

  it('prints the version and returns 0 for --version, before the verb writes anything', async () => {
    const code = await runConnectorCommand(ctx(), [
      'slack',
      'workspaces',
      'add',
      '--team',
      'T1',
      '--tenant',
      't1',
      '--version',
    ]);

    expect(code).toBe(0);
    expect(printed).toEqual([readPackageVersion()]);
    expect(await runConnectorCommand(ctx(), ['slack', 'workspaces', 'list'])).toBe(0);
    expect(printed.join('\n')).not.toContain('T1');
    noHippoDbElsewhere();
  });

  it('returns 1 for a command that is not slack or github and for an unknown slack verb', async () => {
    expect(await runConnectorCommand(ctx(), ['status'])).toBe(1);
    expect(failed.join('\n')).toContain('runs only slack and github, not status');
    expect(await runConnectorCommand(ctx(), ['slack', 'nope'])).toBe(1);
    expect(failed.join('\n')).toContain('Usage: hippo slack');
  });

  it('returns 2 for --dry-run, which the verbs do not honour', async () => {
    expect(await runConnectorCommand(ctx(), ['slack', 'dlq', 'list', '--dry-run'])).toBe(2);
    expect(failed.join('\n')).toContain('has no --dry-run');
  });

  it('returns 1 and names the missing command when argv is empty', async () => {
    expect(await runConnectorCommand(ctx(), [])).toBe(1);
    expect(failed).toEqual(['runConnectorCommand needs a command: slack or github']);
  });

  it('rejects a blank tenant before any store call, and writes nothing', async () => {
    const run = runConnectorCommand({ ...ctx(), tenantId: '' }, [
      'slack',
      'workspaces',
      'add',
      '--team',
      'T1',
      '--tenant',
      't1',
    ]);

    await expect(run).rejects.toThrow('runConnectorCommand: tenantId is required');
    expect(await sqliteStore(handed).connectorEvents.route({ connector: 'slack', teamId: 'T1' })).toEqual({
      tenantId: null,
      routes: 0,
    });
    expect(printed).toEqual([]);
  });

  it('replays a parked event with the host callers and detached, so the write starts the host auto-sleep', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'Ev1',
      event_time: 1,
      event: {
        type: 'message',
        channel: 'C1',
        channel_type: 'channel',
        ts: '1.0',
        user: 'U1',
        text: 'ship on tuesday',
      },
    });
    const id = await parkInDlq(slackDlq, sqliteStore(handed), {
      tenantId: 'default',
      rawPayload: body,
      error: 'unroutable',
      teamId: 'T1',
    });
    const slept: string[] = [];
    const callers = createCallerState({
      run: async () => void slept.push('run'),
      hostTenantId: 'default',
      newSince: async () => 50,
    });
    const kept: Promise<unknown>[] = [];
    const detached = { detach: (work: Promise<unknown>): void => void kept.push(work) };

    const code = await runConnectorCommand({ ...ctx(), callers, detached }, [
      'slack',
      'dlq',
      'replay',
      String(id),
      '--force',
    ]);
    await Promise.all(kept);

    expect(code).toBe(0);
    expect(printed.join('\n')).toContain('replay ok: status=ingested');
    expect(slept).toEqual(['run']);
    expect(kept.length).toBeGreaterThan(0);
    noHippoDbElsewhere();
  });

  it('rejects with StoreNotPortedError naming connectorWrites on a store without the connector groups', async () => {
    const run = runConnectorCommand(withoutConnectorGroups(), ['slack', 'dlq', 'list']);

    await expect(run).rejects.toBeInstanceOf(StoreNotPortedError);
    await expect(run).rejects.toMatchObject({ group: 'connectorWrites' });
  });
});
