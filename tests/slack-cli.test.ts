import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';
import { writeToDlq } from '../src/connectors/slack/dlq.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const CLI = resolve(__dirname, '..', 'bin', 'hippo.js');

function runCli(cwd: string, args: string[]): string {
  if (!existsSync(CLI)) {
    throw new Error(`bin/hippo.js not found at ${CLI} — run \`npm run build\` first`);
  }
  return execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HIPPO_HOME: join(cwd, '.hippo') },
  });
}

describe('hippo slack CLI', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-cli-'));
    initStore(join(root, '.hippo'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('hippo slack dlq list prints DLQ rows', () => {
    const db = openHippoDb(join(root, '.hippo'));
    try {
      writeToDlq(db, { tenantId: 'default', rawPayload: '{"x":1}', error: 'bad event' });
    } finally {
      closeHippoDb(db);
    }
    const out = runCli(root, ['slack', 'dlq', 'list']);
    expect(out).toContain('bad event');
  });

  it('hippo slack backfill --help mentions --channel and --since', () => {
    const out = runCli(root, ['slack', 'backfill', '--help']);
    expect(out).toMatch(/--channel/);
    expect(out).toMatch(/--since/);
  });
});
