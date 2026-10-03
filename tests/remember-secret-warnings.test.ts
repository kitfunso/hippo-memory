// remember tells its caller when the content looks like a secret: HTTP and MCP carry `warnings`, the CLI prints them to stderr.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initStore, loadAllEntries } from '../src/store.js';
import { remember, type Context } from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';
import { handleMcpRequest } from '../src/mcp/server.js';

// Built at runtime so no token-shaped literal lands in the repo.
const GHP = 'ghp_' + 'x1Y2z3W4v5'.repeat(3) + 'Q6r7S8';
const TYPED = `the ci token is ${GHP} for the nightly job`;
const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');

let root: string;
const ctx = (): Context => ({ hippoRoot: root, tenantId: 'default', actor: { subject: 'test', role: 'admin' } });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-remember-warn-'));
  initStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('api.remember', () => {
  it('stores typed text as sent and warns', () => {
    const result = remember(ctx(), { content: TYPED });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain('pattern:github-token');
    expect(loadAllEntries(root)[0].content).toBe(TYPED);
  });

  it('redacts untrusted text and warns', () => {
    const result = remember(ctx(), { content: TYPED, untrusted: true });
    expect(result.warnings).toEqual([expect.stringContaining('redacted')]);
    expect(loadAllEntries(root)[0].content).not.toContain(GHP);
  });

  it('leaves the field off when nothing looks like a secret', () => {
    const result = remember(ctx(), { content: 'the nightly job runs at two' });
    expect('warnings' in result).toBe(false);
  });
});

describe('HTTP POST /v1/memories', () => {
  let handle: ServerHandle;
  beforeEach(async () => { handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 }); });
  afterEach(async () => { await handle.stop(); });

  it('returns warnings beside the usual fields', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: TYPED }),
    });
    expect(res.status).toBe(200);
    // SAFETY: the route sends api.remember's RememberResult; the assertions below check each field read.
    const json = (await res.json()) as { id: string; kind: string; warnings?: string[] };
    expect(json.id).toMatch(/^mem_/);
    expect(json.kind).toBe('distilled');
    expect(json.warnings).toEqual([expect.stringContaining('pattern:github-token')]);
  });
});

describe('MCP hippo_remember', () => {
  it('appends the warning to the tool result', async () => {
    const response = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_remember', arguments: { text: TYPED } } },
      { hippoRoot: root, tenantId: 'default', actor: 'mcp' },
    );
    const text = JSON.stringify(response);
    expect(text).toContain('Remembered [');
    expect(text).toContain('Warning:');
    expect(text).toContain('pattern:github-token');
  });
});

describe('CLI hippo remember', () => {
  it('prints the warning to stderr', () => {
    if (!fs.existsSync(cli)) throw new Error('build first');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-remember-warn-cli-'));
    const env = { ...process.env, HIPPO_HOME: path.join(home, 'global'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    try {
      spawnSync(process.execPath, [cli, 'init', '--no-hooks', '--no-schedule', '--no-learn'], { env, cwd: home });
      const run = spawnSync(process.execPath, [cli, 'remember', TYPED], { env, cwd: home, encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('Remembered [');
      expect(run.stderr).toContain('Warning:');
      expect(run.stderr).toContain('pattern:github-token');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
