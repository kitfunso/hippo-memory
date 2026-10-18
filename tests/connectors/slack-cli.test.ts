import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parkInDlq } from '../../src/connectors/dlq.js';
import { slackDlq } from '../../src/connectors/slack/dlq.js';
import { hippoOut } from '../_helpers/spawn-hippo.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeStore } from '../_helpers/make-root.js';

const CLI = resolve(__dirname, '..', '..', 'bin', 'hippo.js');

function runCli(cwd: string, args: string[]): string {
  if (!existsSync(CLI)) {
    throw new Error(`bin/hippo.js not found at ${CLI} — run \`npm run build\` first`);
  }
  return hippoOut(args, { cwd, env: { ...process.env, HIPPO_HOME: join(cwd, '.hippo') }, exe: 'node' });
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
    const out = runCli(root, ['slack', 'dlq', 'list']);
    expect(out).toContain('bad event');
  });

  it('hippo slack backfill --help mentions --channel and --since', () => {
    const out = runCli(root, ['slack', 'backfill', '--help']);
    expect(out).toMatch(/--channel/);
    expect(out).toMatch(/--since/);
  });
});
