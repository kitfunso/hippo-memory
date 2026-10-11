// The blind author launcher (stage 2 plan D3): a fresh config, no hippo env, every request through the log proxy, and a discard on any forbidden term.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_FORBID, leakHits, runAuthor } from '../scripts/token-eval/z0-author.mjs';
import { cleanup, tmp } from './fixtures/z0-harness.js';

// The temp root can itself name hippo (CI's is hippo-test-tmp-*), so the end-to-end runs forbid a sentinel instead.
const SENTINEL = 'SENTINEL-AUTHOR-LEAK';

// Stands in for claude: posts its prompt through ANTHROPIC_BASE_URL, dumps what it was started with, and echoes the prompt on ECHO.
const AUTHOR_BIN = `import * as fs from 'node:fs';
const prompt = fs.readFileSync(0, 'utf8');
await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }) });
const keys = ['HIPPO_HOME', 'HIPPO_AGENT_MEMORY_TOOLS', 'CODEX_HOME', 'EVAL_SEED', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'];
fs.writeFileSync(process.env.AUTHOR_DUMP, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), env: Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null])), hasToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) }));
console.log(JSON.stringify({ type: 'result', result: prompt.includes('ECHO') ? prompt : 'done' }));
`;

/** A local upstream that answers 200 and keeps each body, so no test reaches the real API. */
async function upstream() {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name.
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function author(prompt: string) {
  const root = tmp('author-');
  const bin = join(root, 'author-bin.mjs');
  writeFileSync(bin, AUTHOR_BIN);
  const work = join(root, 'work');
  const out = join(root, 'out');
  const dump = join(root, 'dump.json');
  const up = await upstream();
  try {
    const baseEnv = { ...process.env, HIPPO_HOME: join(root, 'stray-home'), CODEX_HOME: join(root, 'stray-codex'), CLAUDE_CODE_OAUTH_TOKEN: 'x', AUTHOR_DUMP: dump };
    const verdict = await runAuthor({ work, prompt, out, claudeBin: `"${process.execPath}" "${bin}"`, forbid: SENTINEL, baseEnv, upstream: up.url, timeoutMs: 30_000 });
    return { verdict, work, out, dump: JSON.parse(readFileSync(dump, 'utf8')), bodies: up.bodies };
  } finally {
    await up.close();
  }
}

describe('leakHits', () => {
  it('finds hippo and z0 in any case and form, with nearby text, and skips words that only contain them', () => {
    const named = 'Hippo, .hippo/, HIPPO_HOME, hippo-memory, Z0 stage 2, z0-smoke, z0_run, token-eval';
    const hits = leakHits([{ where: 'a', text: named }, { where: 'b', text: 'hippopotamus chippo az0b z01' }], DEFAULT_FORBID);
    expect(hits.map((h) => `${h.where}:${h.match}`)).toEqual(['a:Hippo', 'a:hippo', 'a:HIPPO', 'a:hippo', 'a:Z0', 'a:z0', 'a:z0', 'a:token-eval']);
    expect(hits[2].near).toContain('HIPPO_HOME');
  });
});

describe('runAuthor', () => {
  afterEach(cleanup);

  it('refuses a work path that names a forbidden term before it creates anything', async () => {
    const work = join(tmp('author-'), 'hippo-work');
    await expect(runAuthor({ work, prompt: 'p', out: join(tmp('author-'), 'out') })).rejects.toThrow(/work has "hippo"/);
    expect(existsSync(work)).toBe(false);
  });

  it('refuses an out dir whose Claude config already exists', async () => {
    const out = join(tmp('author-'), 'out');
    mkdirSync(join(out, 'claude-config'), { recursive: true });
    await expect(runAuthor({ work: join(out, 'work'), prompt: 'p', out, forbid: SENTINEL })).rejects.toThrow(/starts from an empty config/);
  });

  it('runs one session in the work dir through the proxy, with a fresh config, the plan login and no hippo or Codex env', async () => {
    const { verdict, work, out, dump, bodies } = await author('pick two repositories');
    expect(verdict).toMatchObject({ status: 0, timedOut: false, requests: 1, discarded: false, hits: [] });
    expect(JSON.parse(readFileSync(join(out, 'verdict.json'), 'utf8'))).toEqual(verdict);
    expect(JSON.parse(readFileSync(join(out, 'session.json'), 'utf8')).result).toBe('done');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('pick two repositories');
    expect(realpathSync(dump.cwd)).toBe(realpathSync(work));
    expect(dump.env).toMatchObject({ HIPPO_HOME: null, HIPPO_AGENT_MEMORY_TOOLS: null, CODEX_HOME: null, EVAL_SEED: null, CLAUDE_CONFIG_DIR: join(out, 'claude-config'), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    expect(dump.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(dump.hasToken).toBe(true);
    const settings = join(out, 'settings.json');
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ autoMemoryEnabled: false });
    expect(dump.argv.join(' ')).toContain(`--setting-sources project --strict-mcp-config --settings ${settings}`);
  }, 30_000);

  it('discards the author when a forbidden term reaches a request or the output', async () => {
    const { verdict } = await author(`ECHO ${SENTINEL}`);
    expect(verdict.discarded).toBe(true);
    expect(verdict.hits.map((h: { where: string }) => h.where).sort()).toEqual(['output', 'request']);
    expect(verdict.hits.every((h: { near: string }) => h.near.includes(SENTINEL))).toBe(true);
  }, 30_000);
});
