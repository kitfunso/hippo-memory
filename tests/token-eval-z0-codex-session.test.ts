// Z0 set X session driver: codex args and preflight, the rollout parser on fake-codex sessions, the wait, auth and launcher rules.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { finishCodex } from '../scripts/token-eval/codex-task.mjs';
import { createHash } from 'node:crypto';
import { codexArgs, resolveCodex, runCodexSession } from '../scripts/token-eval/codex.mjs';
import { codexAdapter, parseRollouts } from '../scripts/token-eval/codex-rollout.mjs';
import { tokenSweep, closeVault } from '../scripts/token-eval/codex-auth.mjs';
import { codexPreflight } from '../scripts/token-eval/ab-run.mjs';
import { cleanup, tmp, isolate } from './fixtures/z0-harness.js';
import { operator, wrapOperator, codexCtx, codexRun, xTask, fakeSeen, filesHolding } from './fixtures/z0-codex-harness.js';
import type { CodexCtx, CodexOpts } from './fixtures/z0-codex-harness.js';

afterEach(cleanup);

const opened: CodexCtx[] = [];
afterEach(() => {
  while (opened.length) closeVault(opened.pop()!.codexVault);
});
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

const LOCK_CODE = process.platform === 'win32' ? 'EBUSY' : 'EACCES';

/** Runs `fn` while `file` cannot be read or deleted (a sharing lock held by a child on Windows, mode 0 in a read-only dir on POSIX); null when root makes that impossible. */
async function withUnreadable<T>(file: string, fn: () => T): Promise<T | null> {
  if (process.platform === 'win32') {
    const ready = `${file}.held`;
    const script = `$h = [IO.File]::Open('${file}', 'Open', 'ReadWrite', 'None'); Set-Content '${ready}' x; Start-Sleep 300`;
    const child = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 300 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(ready)).toBe(true);
      return fn();
    } finally {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill();
      await gone;
    }
  }
  if (process.getuid?.() === 0) return null;
  const dir = dirname(file);
  chmodSync(file, 0o000);
  chmodSync(dir, 0o555);
  try {
    return fn();
  } finally {
    chmodSync(dir, 0o755);
    chmodSync(file, 0o644);
  }
}

/** An isolated operator, ctx and X1 run; `out` is the run's out dir. */
function setup(name: string, opts: CodexOpts = {}, extra: { sessionTimeoutMs?: number } = {}) {
  const { out, log } = isolate(name);
  process.env.FAKE_CODEX_LOG = log;
  const op = operator(name);
  const ctx = codexCtx(op, opts, extra);
  opened.push(ctx);
  return { out, log, op, ctx, run: codexRun(ctx, out) };
}

describe('codex exec args and the real-run preflight (tests 4, 23)', () => {
  it('gives the exact argv, with the trust flag only in flag mode', () => {
    const { ctx, run } = setup('args');
    const base = ['exec', '--json', '--model', 'gpt-fake', '--cd', run.dirs.work, '--dangerously-bypass-approvals-and-sandbox', '--strict-config'];
    expect(codexArgs(ctx, run)).toEqual([...base, '-']);
    expect(codexArgs({ ...ctx, codexHookTrust: { kind: 'flag' } }, run)).toEqual([...base, '--dangerously-bypass-hook-trust', '-']);
    expect(() => codexArgs({ ...ctx, codexModel: null }, run)).toThrow(/--codex-model/);
  });

  it('refuses a real X run with no model, and a real X2 with no hook trust, before any session', () => {
    expect(() => codexPreflight(['X1'], 'real', {})).toThrow(/--codex-model/);
    expect(() => codexPreflight(['X1', 'X2'], 'real', { codexModel: 'm' })).toThrow(/X2.*--codex-hook-trust none/);
    expect(() => codexPreflight(['X1', 'X2'], 'real', { codexModel: 'm', codexHookTrust: 'flag' })).not.toThrow();
    expect(() => codexPreflight(['X1'], 'real', { codexModel: 'm' })).not.toThrow();
    expect(() => codexPreflight(['X2'], 'dry', {})).not.toThrow();
    expect(() => codexPreflight(['A1'], 'real', {})).not.toThrow();
  });
});

describe('the rollout parser (test 5)', () => {
  it('reads usage, turns and commands from a session in each call form, past NOISE lines', async () => {
    for (const form of ['', 'SHAPE:fn', 'SHAPE:legacy']) {
      const { run, ctx } = setup(`form${form.slice(6)}`);
      const s = await runCodexSession(ctx, run, xTask(`NOISE\n${form}\nREAD:{RUN}/work/lib.js\nREAD:{OUT}/x.txt`), () => false);
      expect(s.threadId, form).toMatch(/^[0-9a-f-]{36}$/);
      expect(s.rollouts.agent, form).toHaveLength(1);
      expect(s.usage!.usage).toEqual({ inputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 1500, outputTokens: 120 });
      expect(s.usage!.turns).toBe(2);
      const commands = codexAdapter.commandLog(s.rollouts.agent);
      expect(commands.map((c: string) => c.replace(/".*[\\/]/, '"'))).toEqual(['cat "lib.js"', 'cat "x.txt"']);
      const tools = codexAdapter.toolInputs(s.rollouts.agent);
      expect(tools.every((x: { input: { cwd: string } }) => x.input.cwd === run.dirs.work), form).toBe(true);
      expect(codexAdapter.toolResultTexts(s.rollouts.agent).map((o: { text: string }) => o.text)[1]).toMatch(/No such file/);
    }
  });

  it('maps apply_patch, js cells and write_stdin, skips a poll and counts a non-literal cmd as unparsed', () => {
    const dir = tmp('z0-rollout-');
    const work = join(dir, 'work');
    const past = join(dir, 'codex-home', 'sessions', 'rollout-past.jsonl');
    const other = join(dir, 'other-run', 'lib.js');
    const cell = `await tools.apply_patch("*** Begin Patch\\n*** Update File: ${other.replaceAll('\\', '\\\\')}\\n*** End Patch");\nconst r = await tools.exec_command({ cmd: 'ls', workdir: ${JSON.stringify(work)} });`;
    const items = [
      { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: cell },
      { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Process running with session ID 7' }] },
      { type: 'function_call', name: 'js', call_id: 'c2', arguments: JSON.stringify({ code: `await tools.exec_command({ cmd: ${JSON.stringify(`cat ${past}`)} })`, title: 't' }) },
      { type: 'function_call', name: 'write_stdin', call_id: 'c3', arguments: JSON.stringify({ session_id: 7, chars: `cat ${past}\n` }) },
      { type: 'function_call', name: 'write_stdin', call_id: 'c4', arguments: JSON.stringify({ session_id: 7, chars: '' }) },
      { type: 'custom_tool_call', name: 'exec', call_id: 'c5', input: 'const someVar = "ls";\nawait tools.exec_command({ cmd: someVar });' },
      { type: 'function_call', name: 'wait', call_id: 'c6', arguments: '{}' },
    ];
    const lines = [{ type: 'session_meta', payload: { id: 't1', cwd: work } }, ...items.map((payload) => ({ type: 'response_item', payload }))];
    const file = join(dir, 'rollout-a.jsonl');
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"type":"response_item","pay`);
    const tools = codexAdapter.toolInputs([file]).map((x: { name: string; input: Record<string, string> }) => ({ name: x.name, ...x.input }));
    expect(tools).toEqual([
      { name: 'Edit', file_path: other, cwd: work },
      { name: 'Bash', command: 'ls', cwd: work },
      { name: 'Bash', command: `cat ${past}`, cwd: work },
      { name: 'Bash', command: `cat ${past}\n`, cwd: work },
    ]);
    expect(parseRollouts([file]).unparsed).toEqual({ exec_command: 1 });
    const work2 = codexAdapter.transcriptWork([file], new Set<string>());
    expect(work2.shellReads).toBe(2);
    expect(work2.toolCalls).toBe(6);
  });

  it('finds the rollout of a HANG session with no thread id, graded on a timeout and priced from the rollout (test 21)', async () => {
    const { run, ctx } = setup('hang', {}, { sessionTimeoutMs: 4000 });
    const s = await runCodexSession(ctx, run, xTask('HANG'), () => false);
    expect(s.cc.timedOut).toBe(true);
    expect(s.threadId).toBeNull();
    expect(s.rollouts.agent).toHaveLength(1);
    expect(s.usage!.usage).toEqual({ inputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 200, outputTokens: 40 });
  }, 30_000);
});

describe('the memory wait and the memories switch (tests 13, 14)', () => {
  it('waits until memories are stable, waits not at all under none, and says when it timed out', async () => {
    const polled = setup('wait', { codexMemoryWait: 'poll:1500:10000' });
    const s = await runCodexSession(polled.ctx, polled.run, xTask('MEMWRITE:800'), () => false);
    expect(s.wait.timedOut).toBe(false);
    expect(s.wait.ms).toBeGreaterThanOrEqual(1500);
    expect(existsSync(join(polled.run.dirs.codexHome, 'memories', 'memory_summary.md'))).toBe(true);
    const none = setup('nowait');
    const n = await runCodexSession(none.ctx, none.run, xTask('MEMWRITE:800'), () => false);
    expect(n.wait).toEqual({ ms: 0, timedOut: false });
    expect(existsSync(join(none.run.dirs.codexHome, 'memories', 'memory_summary.md'))).toBe(false);
    const short = setup('waitout', { codexMemoryWait: 'poll:5000:600' });
    const t = await runCodexSession(short.ctx, short.run, xTask('plain'), () => false);
    expect(t.wait.timedOut).toBe(true);
    expect(t.wait.ms).toBeLessThan(5000);
  }, 60_000);

  it('writes the memories feature as the flag says, and the session reads that config', async () => {
    for (const [flag, want] of [['off', 'memories = false'], ['on', 'memories = true']]) {
      const { run, ctx, log } = setup(`mem${flag}`, { codexMemories: flag });
      await runCodexSession(ctx, run, xTask('plain'), () => false);
      expect(fakeSeen(log)[0].config).toContain(want);
    }
  }, 30_000);
});

describe('the Codex login (test 15)', () => {
  it('redacts the token from what the runner keeps, and the sweep deletes every file that holds it', async () => {
    const { out, op, ctx, run } = setup('auth');
    const before = sha(op.authFile);
    const s = await runCodexSession(ctx, run, xTask('PRINT_AUTH'), () => false);
    for (const text of [s.cc.stdout, s.cc.stderr]) for (const tok of op.tokens) expect(text).not.toContain(tok);
    expect(s.cc.stdout).toContain('[auth]');
    expect(existsSync(join(run.dirs.codexHome, 'auth.json'))).toBe(false);
    const hits = tokenSweep(ctx.codexVault, [run.dirs.root], out);
    expect(hits.some((h: string) => h.includes('/sessions/'))).toBe(true);
    expect(hits).toContain('runs/seqX/X1/seed1/codex-home/memories/auth-note.md');
    expect(filesHolding(out, op.tokens)).toEqual([]);
    expect(sha(op.authFile)).toBe(before);
  }, 30_000);

  it('keeps a refreshed login for the next session and never writes the operator file', async () => {
    const { log, op, ctx, run } = setup('refresh');
    const before = sha(op.authFile);
    await runCodexSession(ctx, run, xTask('REFRESH'), () => false);
    const vault = readFileSync(ctx.codexVault.file, 'utf8');
    expect(vault).toMatch(/refreshed-access-/);
    await runCodexSession(ctx, run, xTask('plain', 'a2'), () => false);
    expect(fakeSeen(log)[1].authSha).toBe(createHash('sha256').update(vault).digest('hex'));
    expect(sha(op.authFile)).toBe(before);
    expect(tokenSweep(ctx.codexVault, [run.dirs.root], run.dirs.root)).toEqual([]);
    closeVault(ctx.codexVault);
    expect(existsSync(ctx.codexVault.dir)).toBe(false);
  }, 30_000);

  it('deletes Codex own token files by CODEX_TOKEN_FILES before the sweep', async () => {
    const plain = setup('logauth');
    await runCodexSession(plain.ctx, plain.run, xTask('LOG_AUTH'), () => false);
    expect(tokenSweep(plain.ctx.codexVault, [plain.run.dirs.root], plain.out)).toEqual(['runs/seqX/X1/seed1/codex-home/logs_2.sqlite']);
    const listed = setup('logauth2', { codexTokenFiles: ['logs_*.sqlite*'] });
    await runCodexSession(listed.ctx, listed.run, xTask('LOG_AUTH'), () => false);
    expect(readdirSync(listed.run.dirs.codexHome)).not.toContain('logs_2.sqlite');
    expect(tokenSweep(listed.ctx.codexVault, [listed.run.dirs.root], listed.out)).toEqual([]);
  }, 30_000);

  it('keeps sweeping past a file it cannot read, and names it without any token text', async () => {
    const { out, op, ctx } = setup('sweepfault');
    const dir = join(out, 'sweep');
    mkdirSync(dir, { recursive: true });
    const bad = join(dir, 'a-locked.json');
    const good = join(dir, 'b-plain.json');
    writeFileSync(bad, op.tokens[1]);
    writeFileSync(good, op.tokens[2]);
    const hits = await withUnreadable(bad, () => tokenSweep(ctx.codexVault, [dir], out));
    if (hits === null) return;
    expect(existsSync(good)).toBe(false);
    expect(hits).toContain('sweep/b-plain.json');
    expect(hits).toContain(`sweep/a-locked.json (unreadable: ${LOCK_CODE})`);
    for (const h of hits) for (const tok of op.tokens) expect(h).not.toContain(tok);
  });

  it('takes back every other login copy when one home is locked, then still removes the vault', async () => {
    const { out, op, ctx } = setup('finishfault');
    const homes = ['a1', 'a2'].map((n) => join(out, 'runs', n, 'X1', '1', 'codex-home'));
    for (const h of homes) {
      mkdirSync(h, { recursive: true });
      copyFileSync(ctx.codexVault.file, join(h, 'auth.json'));
    }
    const hits = await withUnreadable(join(homes[0], 'auth.json'), () => finishCodex({ ...ctx, outDir: out }));
    if (hits === null) return;
    expect(existsSync(join(homes[1], 'auth.json'))).toBe(false);
    expect(hits.some((h: string) => h.startsWith('runs/a1/X1/1/codex-home') && h.includes('login copy not taken back'))).toBe(true);
    expect(existsSync(ctx.codexVault.dir)).toBe(false);
    for (const h of hits) for (const tok of op.tokens) expect(h).not.toContain(tok);
  });
});

describe('the launcher behind hippo\'s wrapper (test 24)', () => {
  it('follows the wrapper metadata to the real codex, and the session never starts the wrapper', async () => {
    const { out, log } = isolate('wrap');
    process.env.FAKE_CODEX_LOG = log;
    const op = operator('wrap');
    const { real, sentinel } = wrapOperator(op);
    const found = resolveCodex('codex', op.env);
    expect(found.path).toBe(real);
    expect(found.wrapper).toBe(op.launcher);
    const ctx = codexCtx(op, {});
    opened.push(ctx);
    const run = codexRun(ctx, out);
    await runCodexSession(ctx, run, xTask('plain'), () => false);
    expect(existsSync(sentinel)).toBe(false);
    const seen = fakeSeen(log);
    expect(seen).toHaveLength(1);
    expect(seen[0].home).toBe(run.dirs.home);
    expect(seen[0].envKeys).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  }, 30_000);

  it('refuses a wrapper with no metadata, or one whose real codex is a wrapper too', () => {
    const bare = operator('wrapbare');
    wrapOperator(bare, { metadata: false });
    expect(() => resolveCodex('codex', bare.env)).toThrow(/--codex-bin/);
    const twice = operator('wraptwice');
    const { real } = wrapOperator(twice);
    writeFileSync(real, 'REM hippo codex wrapper\r\n');
    expect(() => resolveCodex(twice.launcher, twice.env)).toThrow(/wrapper too.*--codex-bin/);
  });
});

describe('the rollout set of one session (test 25)', () => {
  it('sums a spawned child, keeps an internal memory thread unpriced, and calls any other new rollout a stray', async () => {
    const { run, ctx } = setup('child', { codexInternalSources: ['z0-memgen'] });
    const s = await runCodexSession(ctx, run, xTask('CHILD MEMGEN'), () => false);
    expect(s.rollouts.agent).toHaveLength(2);
    expect(s.rollouts.internal).toHaveLength(1);
    expect(s.rollouts.stray).toEqual([]);
    expect(s.usage!.usage).toEqual({ inputTokens: 700, cacheWriteTokens: 0, cacheReadTokens: 1600, outputTokens: 150 });
    expect(s.usage!.turns).toBe(3);
    expect(s.internalUsage!.usage.outputTokens).toBe(30);
    const dflt = setup('stray');
    const d = await runCodexSession(dflt.ctx, dflt.run, xTask('MEMGEN STRAY'), () => false);
    expect([d.rollouts.agent.length, d.rollouts.internal.length, d.rollouts.stray.length]).toEqual([1, 0, 2]);
  }, 30_000);
});

describe('setup faults stop the run (tests 26, 27)', () => {
  it('throws on a login failure, naming no token, and leaves no login copy', async () => {
    const { run, ctx, op } = setup('authfail');
    const err = await runCodexSession(ctx, run, xTask('AUTH_FAIL'), () => false).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/login failed.*log in to Codex again/);
    for (const tok of op.tokens) expect((err as Error).message).not.toContain(tok);
    expect(existsSync(join(run.dirs.codexHome, 'auth.json'))).toBe(false);
  }, 30_000);

  it('throws when the session called an MCP or app tool', async () => {
    const { run, ctx } = setup('mcp');
    await expect(runCodexSession(ctx, run, xTask('MCP_TOOL'), () => false)).rejects.toThrow(/MCP or app tools \(mcp__codex_app__list_threads\)/);
  }, 30_000);

  it('retries a limit on the error event only, never on NOISE stdout, with the raw limit file redacted', async () => {
    process.env.FAKE_CODEX_STATE = join(tmp('z0-codex-state-'), 'limit-once');
    const { run, ctx, op } = setup('limit');
    const noisy = await runCodexSession(ctx, run, xTask('NOISE'), () => false);
    expect(noisy.limitRetries).toBe(0);
    mkdirSync(run.rawDir, { recursive: true });
    const s = await runCodexSession(ctx, run, xTask('LIMIT PRINT_AUTH', 'a2'), () => false);
    expect(s.limitRetries).toBe(1);
    const raw = readFileSync(join(run.rawDir, 'a2.limit1.txt'), 'utf8');
    expect(raw).toMatch(/usage limit/);
    for (const tok of op.tokens) expect(raw).not.toContain(tok);
  }, 30_000);
});
