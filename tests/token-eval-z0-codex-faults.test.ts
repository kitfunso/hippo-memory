// Z0 set X faults through runAll: the limit retry, timeout, memory wait, and the faults that stop the run (E6 plan tests 13-16, 21, 26, 27).
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { listRollouts } from '../scripts/token-eval/codex-rollout.mjs';
import { cleanup, makeRepo, readLedger, find, runRoot } from './fixtures/z0-harness.js';
import { xRun, xTrio, xIsolate, xRecords, xLimit, fakeSeen, filesHolding, vaultsHolding } from './fixtures/z0-codex-harness.js';
import type { Operator } from './fixtures/z0-codex-harness.js';

afterEach(cleanup);

const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
const records = xRecords;

/** No file under out and no vault holds the operator's tokens, and the operator login is the same bytes. */
function noTokenLeft(out: string, op: Operator, before: string) {
  expect(filesHolding(out, op.tokens)).toEqual([]);
  expect(vaultsHolding(op.tokens)).toEqual([]);
  expect(sha(op.authFile)).toBe(before);
}

describe('limit retry in a Codex apply (test 16)', () => {
  it('restores Codex memories and state, keeps the login and the cut-off rollout, and prices only the rerun', async () => {
    const { out, op, codexLog } = xIsolate('limit');
    await xRun(xTrio(makeRepo(), { 'a-xa': 'LIMIT\nNOISE\nFIX' }), ['X1'], out, op, { limitWaitMs: 0 });
    const a = find(records(out), 'X1', 'a-xa');
    expect([a.invalid, a.limitRetries, a.surfaceRestored, a.usage?.firstSession.inputTokens]).toEqual([null, 1, true, 500]);
    // The cut-off rollout holds 400 in, 100 cached and 10 out; none of it may sit in the totals.
    expect(a.usage?.firstSession).toEqual({ inputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 1500, outputTokens: 120 });
    const home = join(runRoot(out, 'X1'), 'codex-home');
    expect([existsSync(join(home, 'memories', 'cutoff.md')), existsSync(join(home, 'state.json'))]).toEqual([false, false]);
    expect(listRollouts(home)).toHaveLength(7);
    const restore = readLedger(out).filter((l) => l.taskId === 'a-xa' && l.when === 'retry-restore');
    expect(restore.map((l) => l.verified)).toEqual([true]);
    const seen = fakeSeen(codexLog);
    expect(seen[1].authSha).not.toBeNull();
    expect(seen[1].authSha).toBe(seen[0].authSha);
  }, xLimit());
});

describe('limit text on stdout in X2 (test 16)', () => {
  it('does not retry when the hippo wrapper prints usage limit text among NOISE lines', async () => {
    const { out, op } = xIsolate('noise');
    await xRun(xTrio(makeRepo(), { 'a-xa': 'NOISE' }), ['X2'], out, op, { limitWaitMs: 0 });
    const a = find(records(out), 'X2', 'a-xa');
    expect([a.invalid, a.limitRetries, a.usage?.firstSession.inputTokens]).toEqual([null, 0, 500]);
  }, xLimit());
});

describe('timeout in a Codex apply (test 21)', () => {
  it('grades a HANG session on its state at the kill and prices it from its rollout', async () => {
    const { out, op } = xIsolate('hang');
    await xRun(xTrio(makeRepo(), { 'a-xa': 'HANG' }), ['X1'], out, op, { sessionTimeoutMs: 10_000 });
    const a = find(records(out), 'X1', 'a-xa');
    expect([a.invalid, a.timedOut]).toEqual([null, true]);
    expect(a.usage?.firstSession).toEqual({ inputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 200, outputTokens: 40 });
  }, xLimit());
});

describe('memory wait and memories switch through the runner (tests 13, 14)', () => {
  it('records the wait, leaves it out of wallMs, and records memories off', async () => {
    const { out, op, codexLog } = xIsolate('wait');
    // Writes for 20 s keep one cell's wait long, so wallMs < wait shows the wait is left out without racing that cell's git checks under load.
    await xRun(xTrio(makeRepo(), { 'a-xa': 'MEMWRITE:500x40' }), ['X1'], out, op, { codexMemoryWait: 'poll:3000:60000', codexMemories: 'off' });
    const a = find(records(out), 'X1', 'a-xa');
    expect(a.codexMemoryWait?.ms).toBeGreaterThanOrEqual(8000);
    expect(a.codexMemoryWait?.timedOut).toBe(false);
    expect(a.wallMs).toBeLessThan(a.codexMemoryWait?.ms ?? 0);
    expect(a.codexMemories).toBe(false);
    expect(fakeSeen(codexLog)[0].config).toContain('memories = false');
  }, xLimit());
});

describe('the login never outlives the run (test 15)', () => {
  it('stops the run at the cell whose agent read the login, and no file or vault keeps a token', async () => {
    const { out, op } = xIsolate('print');
    const before = sha(op.authFile);
    await expect(xRun(xTrio(makeRepo(), { 'a-xa': 'PRINT_AUTH' }), ['X1'], out, op)).rejects.toThrow(/login token/);
    expect(records(out)).toHaveLength(3);
    noTokenLeft(out, op, before);
  }, xLimit());

  it('deletes Codex own token files, and the final sweep finds a token left outside every cell root', async () => {
    const { out, op } = xIsolate('final');
    const before = sha(op.authFile);
    const run = xRun(xTrio(makeRepo(), { 'a-xa': 'LOG_AUTH', 'a-xb': 'LEAK_OUT' }), ['X1'], out, op, { codexTokenFiles: ['logs_*.sqlite'] });
    await expect(run).rejects.toThrow(/leak-out\.txt/);
    expect(records(out)).toHaveLength(9);
    noTokenLeft(out, op, before);
  }, xLimit());
});

describe('setup faults stop the run with no record (tests 26, 27)', () => {
  it('stops on a login failure and removes the vault', async () => {
    const { out, op } = xIsolate('authfail');
    await expect(xRun(xTrio(makeRepo(), { 'a-xa': 'AUTH_FAIL' }), ['X1'], out, op)).rejects.toThrow(/login failed/);
    expect(records(out).map((r) => r.taskId)).toEqual(['t-xa', 't-xb', 't-xc']);
    expect(vaultsHolding(op.tokens)).toEqual([]);
  }, xLimit());

  it('stops when a Codex session called an MCP or app tool', async () => {
    const { out, op } = xIsolate('mcp');
    await expect(xRun(xTrio(makeRepo(), { 'a-xa': 'MCP_TOOL' }), ['X1'], out, op)).rejects.toThrow(/MCP or app tools/);
    expect(records(out).some((r) => r.taskId === 'a-xa')).toBe(false);
    expect(vaultsHolding(op.tokens)).toEqual([]);
  }, xLimit());
});
