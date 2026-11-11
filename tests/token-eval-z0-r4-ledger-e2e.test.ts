// Round 4 slice 2c end to end: z0-ledger over a fake r4 run (two models, a cut-off first session, a cut-off resume, a pilot folder), against the fake's own per-call figures and rates worked by hand.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { runAll } from '../scripts/token-eval/ab-run.mjs';
import { ALL_ARMS, DESIGNS, OPUS_MODEL, SONNET_MODEL } from '../scripts/token-eval/arms.mjs';
import { startStubUpstream } from '../scripts/token-eval/proxy.mjs';
import { ledgerTotal, runCli, spendByArm } from '../scripts/token-eval/z0-ledger.mjs';
import { cleanup, tmp, isolate, makeRepo, oneLesson, spec, task, readRecords, FAKE } from './fixtures/z0-harness.js';

const BUILD = { hippoCommit: 'c'.repeat(40), hippoDirty: false, hippoDistHash: 'd'.repeat(64) };
const TOKEN = 'fake-tok-ledger-e2e';
const USAGE = { input: 1000, output: 2000, cacheRead: 50_000, cacheWrite: 4000 };
const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

interface Rates { inputPerMTok: number; cacheWritePerMTok: number; cacheReadPerMTok: number; outputPerMTok: number }
interface PriceFile { models: Readonly<Record<string, Rates>> }
interface Dollars { readonly [model: string]: number }
interface Usage { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number }
interface Call { call: string; argv: string[]; configDir: string | null }
interface Cost { call: string; model: string | null; usage: Usage | null; totalCostUsd: number }
interface Attempt { taskId: string; kind: string; attempt: number; sessionId: string }
interface Warmup { total_cost_usd: number }
interface Knobs { file: string; cmd: string; calls: () => Call[]; costs: () => Cost[] }

// Written out here and not imported from z0-gen.ts, so one fixture edit cannot move both sides of a comparison.
const RATES: PriceFile = {
  models: {
    [OPUS_MODEL]: { inputPerMTok: 5, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5, outputPerMTok: 25 },
    [SONNET_MODEL]: { inputPerMTok: 2.5, cacheWritePerMTok: 3.125, cacheReadPerMTok: 0.25, outputPerMTok: 12.5 },
  },
};
// The fake's WARMUP_TOKENS by hand: Opus (12 x 5 + 3000 x 6.25 + 0 x 0.5 + 8 x 25) / 1e6 = 19010 / 1e6; Sonnet (12 x 2.5 + 3000 x 3.125 + 0 x 0.25 + 8 x 12.5) / 1e6 = 9505 / 1e6.
const WARMUP_USD: Dollars = { [OPUS_MODEL]: 0.01901, [SONNET_MODEL]: 0.009505 };

/** Dollars for one usage at the test's own rates; it calls neither priceUsage nor modelRow, which the fake and the ledger share. */
function handUsd(model: string, u: Usage): number {
  const r = RATES.models[model];
  if (r === undefined) throw new Error(`RATES has no row for ${model}`);
  return (u.input_tokens * r.inputPerMTok + u.cache_creation_input_tokens * r.cacheWritePerMTok + u.cache_read_input_tokens * r.cacheReadPerMTok + u.output_tokens * r.outputPerMTok) / 1_000_000;
}

const jsonl = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function knobs(prices: string): Knobs {
  const dir = tmp('ledger-e2e-knobs-');
  const [file, calls, costs] = [join(dir, 'knobs.json'), join(dir, 'calls.jsonl'), join(dir, 'costs.jsonl')];
  writeFileSync(file, JSON.stringify({
    schema: 'z0-fake-knobs/1', token: TOKEN, calls, costs, prices, version: '9.9.9', usage: Object.fromEntries(ALL_ARMS.map((a: string) => [a, USAGE])),
    effortScale: { low: 0.5, medium: 1, high: 2 }, outcome: Object.fromEntries(ALL_ARMS.map((a: string) => [a, { lesson: 0.5, solve: 0.5 }])), leaks: [], offPin: [], fail: [], warmupFail: [],
  }));
  return { file, cmd: `"${process.execPath}" "${FAKE}" --fake-knobs "${file}"`, calls: () => jsonl<Call>(calls), costs: () => jsonl<Cost>(costs) };
}

/** runAll under r4 with both warm-ups, a stub upstream, and the limit marker passed through. */
async function r4run(s: ReturnType<typeof spec>, arms: string[], out: string, k: Knobs) {
  mkdirSync(out, { recursive: true });
  const stub = await startStubUpstream(join(out, 'stub.jsonl'));
  try {
    return await runAll({
      spec: s, arms, seeds: 1, outDir: out, model: null, claudeBin: k.cmd, settleMs: 0, warmup: true, log: () => {}, passEnv: ['FAKE_CLAUDE_LIMIT_ONCE'], limitWaitMs: 0,
      design: DESIGNS.r4, effort: 'medium', upstream: stub.url, hippoBuild: BUILD,
    });
  } finally {
    await stub.close();
  }
}

const sumOf = (k: Knobs) => k.costs().reduce((s, c) => s + c.totalCostUsd, 0);
const slashes = (p: string) => p.split(sep).join('/');
const modelOf = (c: Call) => c.argv[c.argv.indexOf('--model') + 1];
const isVersion = (c: Call) => c.argv.includes('--version');
const isWarmup = (c: Call) => !c.argv.includes('--settings') && !isVersion(c);
const ARM_WORD = new RegExp(`\\b(${ALL_ARMS.join('|')})\\b`);

let [A, B, P] = ['', '', ''];
let kA: Knobs;
let kB: Knobs;
let [sumA, sumB] = [0, 0];
const ledgerA = () => runCli(['--prices', P, '--design', 'r4', '--run', A]);

describe('z0-ledger over a fake r4 run', () => {
  beforeAll(async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
    P = join(tmp('ledger-e2e-prices-'), 'prices.json');
    writeFileSync(P, JSON.stringify(RATES));
    A = isolate('ledger-e2e-run').out;
    process.env.FAKE_CLAUDE_LIMIT_ONCE = join(tmp('ledger-e2e-limit-'), 'once');
    kA = knobs(P);
    await r4run(oneLesson(makeRepo(), { t1: 'CUT_ON_RESUME LESSON_BAD', n1: 'LIMIT look around only' }), ['O1', 'S1'], A, kA);
    B = isolate('ledger-e2e-pilot').out;
    kB = knobs(P);
    const repo = makeRepo();
    await r4run(spec(repo, [], [task(repo, 'p1', 'pilot first task'), task(repo, 'p2', 'pilot second task')]), ['S1'], B, kB);
    [sumA, sumB] = [sumOf(kA), sumOf(kB)];
  }, 600_000);
  afterAll(() => {
    cleanup();
    if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
  });

  it('logs one cost line per call, joined by call id; --version bills 0 and every other call bills a positive figure at its --model row', () => {
    for (const k of [kA, kB]) {
      const [calls, costs] = [k.calls(), k.costs()];
      expect(new Set(calls.map((c) => c.call)).size).toBe(calls.length);
      expect(new Set(costs.map((c) => c.call)).size).toBe(costs.length);
      expect(costs.map((c) => c.call).sort()).toEqual(calls.map((c) => c.call).sort());
      for (const c of calls) {
        const cost = costs.find((x) => x.call === c.call)!;
        expect(Number.isFinite(cost.totalCostUsd), c.call).toBe(true);
        if (isVersion(c)) {
          expect(cost, c.call).toMatchObject({ usage: null, totalCostUsd: 0 });
        } else {
          expect(cost.totalCostUsd, c.call).toBeGreaterThan(0);
          expect(cost.usage, c.call).not.toBeNull();
          expect(cost.model, c.call).toBe(modelOf(c));
        }
      }
    }
    const calls = kA.calls();
    expect(calls.filter(isVersion)).toHaveLength(1);
    expect(calls.filter(isWarmup).map(modelOf).sort()).toEqual([OPUS_MODEL, SONNET_MODEL].sort());
  });

  it('prices every call by hand at the test\'s own rates, and each warm-up at 0.01901 (Opus) and 0.009505 (Sonnet)', () => {
    for (const k of [kA, kB]) {
      for (const c of k.costs()) {
        if (c.usage === null) continue;
        expect(Math.abs(c.totalCostUsd - handUsd(c.model!, c.usage)), c.call).toBeLessThan(1e-12);
      }
    }
    for (const model of [OPUS_MODEL, SONNET_MODEL]) {
      const done: Warmup = JSON.parse(readFileSync(join(A, 'warmups', `${model}.json`), 'utf8'));
      expect(done.total_cost_usd).toBeCloseTo(WARMUP_USD[model]!, 12);
      const call = kA.calls().find((c) => isWarmup(c) && modelOf(c) === model)!;
      expect(kA.costs().find((c) => c.call === call.call)!.totalCostUsd).toBeCloseTo(WARMUP_USD[model]!, 12);
    }
  });

  it('ran one cut-off first session and one cut-off resume per arm, and each billed', () => {
    const [calls, costs] = [kA.calls(), kA.costs()];
    const billed = (c: Call) => costs.find((x) => x.call === c.call)!.totalCostUsd;
    const attemptsOf = (arm: string) => jsonl<Attempt>(join(A, 'raw', 'seqF', arm, 'seed1', 'attempts.jsonl'));
    const sessionsOf = (arm: string, taskId: string) => attemptsOf(arm).filter((a) => a.taskId === taskId && a.kind === 'session');
    expect(['O1', 'S1'].map((arm) => sessionsOf(arm, 'n1').map((a) => a.attempt).join()).sort()).toEqual(['1', '1,2']);
    for (const arm of ['O1', 'S1']) {
      const config = join(A, 'runs', 'seqF', arm, 'seed1', 'claude-config');
      const [first] = sessionsOf(arm, 'n1');
      if (sessionsOf(arm, 'n1').length === 2) {
        const cut = calls.filter((c) => c.argv.includes('--session-id') && c.argv[c.argv.indexOf('--session-id') + 1] === first!.sessionId);
        expect(cut).toHaveLength(1);
        expect(billed(cut[0]!)).toBeGreaterThan(0);
        const files = readdirSync(join(config, 'projects'), { recursive: true, encoding: 'utf8' });
        expect(files.filter((f) => basename(f) === `${first!.sessionId}.jsonl`)).toHaveLength(1);
      }
      const copies = join(A, 'cutoffs', 'seqF', arm, 'seed1');
      const entries = readdirSync(copies);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^\d+-1$/);
      expect(existsSync(join(copies, entries[0]!, 'attempt.json'))).toBe(true);
      const teach = readRecords(A).find((r) => r.taskId === 't1' && r.arm === arm);
      const resumes = calls.filter((c) => c.configDir === config && c.argv.includes('--resume') && c.argv[c.argv.indexOf('--resume') + 1] === teach!.sessionId);
      expect(resumes).toHaveLength(2);
      for (const r of resumes) expect(billed(r), r.call).toBeGreaterThan(0);
    }
    expect(existsSync(join(B, 'cutoffs'))).toBe(false);
  });

  it('LEDGER equals the sum of the fake\'s figures over every call it logged, warm-ups included, to the cent', () => {
    const r = ledgerA();
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(`LEDGER ${sumA.toFixed(2)}\n`);
    expect(Math.abs(ledgerTotal({ runs: [A], prices: RATES, design: DESIGNS.r4 }) - sumA)).toBeLessThan(1e-9);
  });

  it('a --pilot-run folder adds to LEDGER and not to the spend by arm', () => {
    const byArm: Record<string, number> = {};
    const costs = kA.costs();
    for (const c of kA.calls()) {
      const rel = c.configDir === null ? '' : slashes(relative(A, c.configDir));
      const arm = ALL_ARMS.find((a: string) => rel.startsWith(`runs/seqF/${a}/`));
      if (arm !== undefined) byArm[arm] = (byArm[arm] ?? 0) + costs.find((x) => x.call === c.call)!.totalCostUsd;
    }
    const spendLines = DESIGNS.r4.arms.map((a: string) => `spend ${a} ${(byArm[a] ?? 0).toFixed(2)}\n`).join('');
    expect(runCli(['--prices', P, '--design', 'r4', '--run', A, '--unblind']).stdout).toBe(`${spendLines}LEDGER ${sumA.toFixed(2)}\n`);
    expect(runCli(['--prices', P, '--design', 'r4', '--run', A, '--pilot-run', B, '--unblind']).stdout).toBe(`${spendLines}LEDGER ${(sumA + sumB).toFixed(2)}\n`);
    expect(Math.abs(ledgerTotal({ runs: [A], pilotRuns: [B], prices: RATES, design: DESIGNS.r4 }) - (sumA + sumB))).toBeLessThan(1e-9);
    const spent = spendByArm({ runs: [A], prices: RATES, design: DESIGNS.r4 });
    for (const arm of DESIGNS.r4.arms) {
      expect(Math.abs(spent[arm] - (byArm[arm] ?? 0)), arm).toBeLessThan(1e-9);
      if (arm !== 'O1' && arm !== 'S1') expect(spent[arm], arm).toBe(0);
    }
    expect(byArm.O1).toBeGreaterThan(0);
    expect(byArm.S1).toBeGreaterThan(0);
    expect(sumB).toBeGreaterThan(0);
  });

  it('prints no arm without --unblind', () => {
    for (const extra of [[], ['--pilot-run', B]]) {
      const r = runCli(['--prices', P, '--design', 'r4', '--run', A, ...extra]);
      expect(r.stdout).toMatch(/^LEDGER \d+\.\d{2}\n$/);
      expect(r.stderr).toBe('');
      expect(r.stdout).not.toMatch(ARM_WORD);
      expect(r.stderr).not.toMatch(ARM_WORD);
    }
  });

  it('gives the same LEDGER with the last runs.jsonl line cut in half', () => {
    const file = join(A, 'runs.jsonl');
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    const last = lines.pop()!;
    expect(JSON.parse(last).costUsd).toBeGreaterThan(0);
    writeFileSync(file, `${lines.join('\n')}\n${last.slice(0, Math.floor(last.length / 2))}`);
    const r = ledgerA();
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`LEDGER ${sumA.toFixed(2)}\n`);
    expect(Math.abs(ledgerTotal({ runs: [A], prices: RATES, design: DESIGNS.r4 }) - sumA)).toBeLessThan(1e-9);
  });
});
