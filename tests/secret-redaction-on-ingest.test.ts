// Text no person typed into hippo (connector events, imported files, tool failures, git log lessons) loses its secret shapes before it is stored.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHmac } from 'node:crypto';
import { initStore, loadAllEntries } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';
import {
  importChatGPT,
  importClaude,
  importCursor,
  importGenericFile,
  importMarkdown,
  importVault,
  type ImportOptions,
  type ImportResult,
} from '../src/importers.js';
import { captureToolFailure } from '../src/capture-error.js';
import { captureError, partitionLessons } from '../src/autolearn.js';

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
