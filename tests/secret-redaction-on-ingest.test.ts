// Text no person typed into hippo (connector events, imported files, tool failures, git log lessons) loses its secret shapes before it is stored.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHmac } from 'node:crypto';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { serve, type ServerHandle } from '../src/server.js';
import {
  importChatGPT,
  importClaude,
  importCursor,
  importGenericFile,
} from '../src/importers/sources.js';
import { importMarkdown } from '../src/importers/markdown.js';
import { importVault } from '../src/importers/vault.js';
import { type ImportOptions, type ImportResult } from '../src/importers/core.js';
import { captureToolFailure } from '../src/capture/capture-error.js';
import { captureError, partitionLessons } from '../src/learn/autolearn.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { addWorkspace } from '../src/connectors/slack/workspaces.js';
import { replayDlqEntry } from '../src/connectors/slack/dlq.js';

// Built at runtime so no token-shaped literal lands in the repo.
const GHP = 'ghp_' + 'x1Y2z3W4v5'.repeat(3) + 'Q6r7S8';
const SLACK_TOKEN = 'xoxb-' + '1234567890' + '12-' + 'AbCdEfGhIjKlMnOp';
const SIGNING = 'route-test-signing';

let root: string;
let srcDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-secret-ingest-'));
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-secret-src-'));
  initStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
});

function storedContents(hippoRoot: string = root): string[] {
  return loadAllEntries(hippoRoot).map((e) => e.content);
}

function expectRedacted(contents: string[], token: string, keptPhrase: string): void {
  expect(contents.some((c) => c.includes(token))).toBe(false);
  const row = contents.find((c) => c.includes(keptPhrase));
  expect(row).toBeDefined();
  expect(row).toContain('[REDACTED]');
}

describe('connector webhooks', () => {
  let handle: ServerHandle;

  beforeEach(async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING;
    process.env.GITHUB_WEBHOOK_SECRET = SIGNING;
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    await handle.stop();
  });

  it('a Slack message holding a token is stored without it', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'EvSecret',
      event_time: Math.floor(Date.now() / 1000),
      event: {
        type: 'message',
        channel: 'C1',
        channel_type: 'channel',
        user: 'U1',
        text: `the staging bot token is ${SLACK_TOKEN} until friday`,
        ts: '1700000000.000200',
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac('sha256', SIGNING).update(`v0:${ts}:${body}`).digest('hex')}`;
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig },
      body,
    });
    expect(res.status).toBe(200);
    expectRedacted(storedContents(), SLACK_TOKEN, 'until friday');
  });

  it('a GitHub issue holding a token is stored without it', async () => {
    const body = JSON.stringify({
      action: 'opened',
      issue: {
        number: 42,
        title: 'CI cannot pull the registry',
        body: `I set GH_TOKEN to ${GHP} and the pull still fails`,
        user: { login: 'alice', id: 1 },
      },
      repository: { full_name: 'acme/repo', private: false, owner: { login: 'acme' }, name: 'repo' },
      sender: { login: 'alice', id: 1 },
      installation: { id: 99 },
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/github/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', SIGNING).update(body).digest('hex')}`,
        'x-github-event': 'issues',
        'x-github-delivery': 'd-secret',
      },
      body,
    });
    expect(res.status).toBe(200);
    expectRedacted(storedContents(), GHP, 'the pull still fails');
  });

  const post = (route: string, body: string, headers: Record<string, string>): Promise<Response> =>
    fetch(`http://127.0.0.1:${handle.port}/v1/connectors/${route}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  const slackHeaders = (body: string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', SIGNING).update(`v0:${ts}:${body}`).digest('hex')}` };
  };
  const dlqRows = (table: 'slack_dlq' | 'github_dlq'): Array<{ id: number; raw_payload: string; signature: string | null; error: string }> => {
    const db = openHippoDb(root);
    try {
      // SAFETY: the SELECT names exactly these four columns.
      return db.prepare(`SELECT id, raw_payload, signature, error FROM ${table} ORDER BY id`).all() as Array<{ id: number; raw_payload: string; signature: string | null; error: string }>;
    } finally {
      closeHippoDb(db);
    }
  };

  it('an unroutable Slack message lands in the dead-letter table redacted, and replays once routed', async () => {
    addWorkspace(root, { teamId: 'T_OTHER', tenantId: 'default' });
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'EvDlq',
      event_time: Math.floor(Date.now() / 1000),
      event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: `bot token ${SLACK_TOKEN} expires on friday`, ts: '1700000000.000300' },
    });
    expect((await post('slack', body, slackHeaders(body))).status).toBe(200);

    const [row] = dlqRows('slack_dlq');
    expect(row.raw_payload).not.toContain(SLACK_TOKEN);
    expect(row.raw_payload).toContain('[REDACTED]');
    expect(row.signature).toBeNull();
    expect(JSON.parse(row.raw_payload).event.text).toBe('bot token [REDACTED] expires on friday');

    addWorkspace(root, { teamId: 'T1', tenantId: 'default' });
    expect((await replayDlqEntry({ hippoRoot: root }, row.id, { signingSecret: SIGNING })).status).toBe('sig_missing');
    expect((await replayDlqEntry({ hippoRoot: root }, row.id, { force: true })).ok).toBe(true);
    expectRedacted(storedContents(), SLACK_TOKEN, 'expires on friday');
  });

  it('a Slack body that is not JSON lands in the dead-letter table redacted', async () => {
    const body = `{"team_id":"T1","event":{"text":"token ${SLACK_TOKEN} here"`;
    expect((await post('slack', body, slackHeaders(body))).status).toBe(200);
    const [row] = dlqRows('slack_dlq');
    expect(row.raw_payload).not.toContain(SLACK_TOKEN);
    expect(row.raw_payload).toContain('[REDACTED]');
  });

  it('a GitHub event parked for review lands in the dead-letter table redacted', async () => {
    const body = JSON.stringify({
      action: 'deleted',
      issue: { number: 7, title: 'old', body: `the token ${GHP} was pasted here`, user: { login: 'alice', id: 1 } },
      repository: { full_name: 'acme/repo', private: false, owner: { login: 'acme' }, name: 'repo' },
      sender: { login: 'alice', id: 1 },
      installation: { id: 99 },
    });
    const res = await post('github', body, {
      'x-hub-signature-256': `sha256=${createHmac('sha256', SIGNING).update(body).digest('hex')}`,
      'x-github-event': 'issues',
      'x-github-delivery': 'd-dlq',
    });
    expect(res.status).toBe(200);
    const [row] = dlqRows('github_dlq');
    expect(row.raw_payload).not.toContain(GHP);
    expect(JSON.parse(row.raw_payload).issue.body).toBe('the token [REDACTED] was pasted here');
    expect(row.signature).toBeNull();
  });
});

describe('importers', () => {
  const opts = (): ImportOptions => ({ hippoRoot: root, dryRun: false });
  const write = (name: string, content: string): string => {
    const p = path.join(srcDir, name);
    fs.writeFileSync(p, content, 'utf8');
    return p;
  };
  const line = `The deploy token for staging is ${GHP} and rotates monthly`;

  const cases: Array<[string, () => ImportResult]> = [
    ['chatgpt', () => importChatGPT(write('chatgpt.json', JSON.stringify([line])), opts())],
    ['claude', () => importClaude(write('claude.md', `# Notes\n\n- ${line}\n`), opts())],
    ['cursor', () => importCursor(write('cursorrules', `- ${line}\n`), opts())],
    ['file', () => importGenericFile(write('notes.txt', `${line}\n\nAnother plain paragraph about builds\n`), opts())],
    ['markdown', () => importMarkdown(write('memory.md', `## Ops\n\n- ${line}\n`), opts())],
  ];

  for (const [name, run] of cases) {
    it(`${name} import stores the line without the token and counts the redaction`, () => {
      const result = run();
      expect(result.imported).toBeGreaterThanOrEqual(1);
      expect(result.redacted).toBe(1);
      expectRedacted(storedContents(), GHP, 'rotates monthly');
    });
  }

  it('vault import stores the note without the token and counts the redaction', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-secret-vault-'));
    try {
      fs.writeFileSync(path.join(vault, 'ops.md'), `${line}\n`, 'utf8');
      const result = importVault(vault, { hippoRoot: root, name: 'notes' });
      expect(result.imported).toBe(1);
      expect(result.redacted).toBe(1);
      expect(result.entries[0].content).not.toContain(GHP);
      expectRedacted(storedContents(), GHP, 'rotates monthly');
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe('machine-captured lessons', () => {
  it('a tool failure that echoes a token is stored without it', () => {
    const outcome = captureToolFailure(root, 'default', {
      tool_name: 'Bash',
      error: `fatal: Authentication failed for https://x-access-token:${GHP}@github.com/acme/repo.git`,
      tool_input: { command: 'git push origin main' },
    });
    expect(outcome).toBe('stored');
    expectRedacted(storedContents(), GHP, 'Authentication failed');
  });

  it('hippo watch drops a token from the failed command and its stderr', () => {
    const entry = captureError(1, `curl: (22) 401 for token ${GHP}`, `curl -H "Authorization: Bearer ${GHP}" https://api.example.com`);
    expect(entry.content).not.toContain(GHP);
    expect(entry.content).toContain('[REDACTED]');
  });

  it('git learn lessons lose a token pasted into a commit subject', () => {
    const { kept } = partitionLessons([`rotate the leaked deploy credential ${GHP} after the outage review`]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).not.toContain(GHP);
    expect(kept[0]).toContain('[REDACTED]');
  });
});
