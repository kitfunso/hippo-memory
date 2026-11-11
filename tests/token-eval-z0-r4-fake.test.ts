// Round 4 slice 2a, the fake agent (Fake agent contract): its knobs spawned as the runner spawns it, then through runAll and the ab-run CLI.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runAll } from '../scripts/token-eval/ab-run.mjs';
import { ALL_ARMS, DESIGNS, OPUS_MODEL, SONNET_MODEL } from '../scripts/token-eval/arms.mjs';
import { ancestorInstructionFiles } from '../scripts/token-eval/homes.mjs';
import { startLogProxy, startStubUpstream } from '../scripts/token-eval/proxy.mjs';
import { priceUsage } from '../dist/eval/eval-stats.js';
import { usageRatio } from '../scripts/token-eval/z0-cost-solved.mjs';
import { g1 } from '../scripts/token-eval/z0-gates.mjs';
import { cleanup, tmp, isolate, makeRepo, family, lesson, task, teach, apply, plain, spec, readRecords, FAKE } from './fixtures/z0-harness.js';
import { PRICES_BY_MODEL } from './fixtures/z0-gen.js';

const BUILD = { hippoCommit: 'c'.repeat(40), hippoDirty: false, hippoDistHash: 'd'.repeat(64) };
const TOKEN = 'fake-tok-fake1';
const AB_RUN = join(__dirname, '..', 'scripts', 'token-eval', 'ab-run.mjs');
const USAGE = { input: 1000, output: 2000, cacheRead: 50_000, cacheWrite: 4000 };
const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const extraDirs: string[] = [];
beforeEach(() => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
});
afterEach(() => {
  cleanup();
  while (extraDirs.length) rmSync(extraDirs.pop()!, { recursive: true, force: true, maxRetries: 5 });
  if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
});

type Json = string | number | boolean | null | undefined | readonly Json[] | { readonly [key: string]: Json };
type Over = Readonly<Record<string, Json>>;
interface Call { call: string; argv: string[]; tokenPrefix: string | null; effort: string | null; subagentModel: string | null; configDir: string }
interface Knobs { dir: string; file: string; cmd: string; calls: () => Call[] }
const jsonl = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
/** The runner's fields beyond the z0-record/1 type that these tests read. */
interface Wire { arm: string; taskId: string; kind: string; claudeVersion: string; envKeys: string[]; lessons: { first: string; final: string }[]; invalid: string | null; resolved: boolean }
const wire = (out: string) => jsonl<Wire>(join(out, 'runs.jsonl'));
interface ModelTokens { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }
interface Cost { call: string; model: string | null; usage: CallResult['usage'] | null; totalCostUsd: number }
interface CallResult {
  type: string; is_error: boolean; total_cost_usd: number; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
  modelUsage: Readonly<Record<string, ModelTokens>>;
}

function knobs(over: Over = {}): Knobs {
  const dir = tmp('r4-fake-knobs-');
  const prices = join(dir, 'prices.json');
  writeFileSync(prices, JSON.stringify(PRICES_BY_MODEL));
  const file = join(dir, 'knobs.json');
  writeFileSync(file, JSON.stringify({
    schema: 'z0-fake-knobs/1', token: TOKEN, calls: join(dir, 'calls.jsonl'), prices, version: '9.9.9', usage: Object.fromEntries(ALL_ARMS.map((a: string) => [a, USAGE])),
    effortScale: { low: 0.5, medium: 1, high: 2 }, outcome: Object.fromEntries(ALL_ARMS.map((a: string) => [a, { lesson: 0.5, solve: 0.5 }])), leaks: [], offPin: [], fail: [], warmupFail: [], ...over,
  }));
  return { dir, file, cmd: `"${process.execPath}" "${FAKE}" --fake-knobs "${file}"`, calls: () => jsonl<Call>(join(dir, 'calls.jsonl')) };
}

interface Spawned { status: number | null; stdout: string; stderr: string; result: CallResult | null; out: string; cwd: string; configDir: string }
interface CallOpts {
  arm?: string; seq?: string; seed?: number; prompt?: string; model?: string | null; effort?: string | null; subagentModel?: string; settings?: boolean; baseUrl?: string; token?: string | null; out?: string; knobsArg?: boolean;
}

const envWithout = (names: string[], add: Readonly<Record<string, string | undefined>> = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !names.includes(name))), ...add });

/** One call of the fake as the runner makes it: its own cwd and config dir under <out>/runs/<seq>/<arm>/seed<n>/. */
async function callFake(k: Knobs, c: CallOpts = {}): Promise<Spawned> {
  const [arm, seq, seed] = [c.arm ?? 'S1', c.seq ?? 'seqA', c.seed ?? 1];
  const out = c.out ?? tmp('r4-fake-out-');
  const seedDir = join(out, 'runs', seq, arm, `seed${seed}`);
  const [configDir, cwd] = [join(seedDir, 'claude-config'), join(seedDir, 'work')];
  mkdirSync(configDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const settingsFile = join(out, 'settings.json');
  writeFileSync(settingsFile, '{}');
  const model = c.model === undefined ? SONNET_MODEL : c.model;
  const args = [FAKE, ...(c.knobsArg === false ? [] : ['--fake-knobs', k.file]), '-p', '--output-format', 'json', '--setting-sources', 'project'];
  if (c.settings !== false) args.push('--settings', settingsFile);
  args.push('--strict-mcp-config');
  if (model) args.push('--model', model);
  const env = envWithout(['CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_BASE_URL'], { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: c.token === undefined ? TOKEN : (c.token ?? undefined) });
  if (c.effort) env.CLAUDE_CODE_EFFORT_LEVEL = c.effort;
  if (c.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = c.subagentModel;
  if (c.baseUrl) env.ANTHROPIC_BASE_URL = c.baseUrl;
  const child = spawn(process.execPath, args, { cwd, env });
  let [stdout, stderr] = ['', ''];
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(c.prompt ?? 'look around only\nFAKE_POS 1');
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
  const last = stdout.trim().split('\n').filter(Boolean).at(-1);
  const result: CallResult | null = last ? JSON.parse(last) : null;
  return { status, stdout, stderr, result, out, cwd, configDir };
}

const tokensOf = (r: CallResult) => ({ input: r.usage.input_tokens, cacheWrite: r.usage.cache_creation_input_tokens, cacheRead: r.usage.cache_read_input_tokens, output: r.usage.output_tokens });

/** The fake's own request as an API would see it: the runner's log proxy in front of its stub upstream. */
async function listener() {
  const dir = tmp('r4-fake-listener-');
  const log = join(dir, 'proxy.jsonl');
  const stub = await startStubUpstream(join(dir, 'stub.jsonl'));
  const proxy = await startLogProxy(log, { upstream: stub.url });
  const bodies = () => jsonl<{ url: string; body?: string }>(log).filter((l) => l.body !== undefined).map((l) => ({ url: l.url, body: JSON.parse(l.body ?? 'null') }));
  return { url: proxy.url, bodies, close: async () => { await proxy.close(); await stub.close(); } };
}

describe('the fake agent without --fake-knobs', () => {
  it('prints 0.0.0 for --version and needs --settings, as it always did', () => {
    const v = spawnSync(process.execPath, [FAKE, '--version'], { encoding: 'utf8' });
    expect(v.stdout).toBe('0.0.0 (Claude Code)\n');
  });
});

describe('the knobs file', () => {
  it('--version prints the version knob, default 0.0.0', async () => {
    const k = knobs();
    const v = spawnSync(process.execPath, [FAKE, '--fake-knobs', k.file, '--version'], { encoding: 'utf8' });
    expect(v.status).toBe(0);
    expect(v.stdout).toBe('9.9.9 (Claude Code)\n');
    const dflt = knobs({ version: undefined });
    expect(spawnSync(process.execPath, [FAKE, '--fake-knobs', dflt.file, '--version'], { encoding: 'utf8' }).stdout).toBe('0.0.0 (Claude Code)\n');
  });

  it('exits 1 on a key the contract lacks, a wrong schema, a bad outcome or a file that is not JSON, and says which', () => {
    const run = (k: Knobs) => spawnSync(process.execPath, [FAKE, '--fake-knobs', k.file, '--version'], { encoding: 'utf8' });
    const outcome = (v: Record<string, number>) => ({ outcome: { S1: v } });
    const cases: [string, Over, RegExp][] = [
      ['an unknown key', { bogus: 1 }, /bogus/], ['a wrong schema', { schema: 'z0-fake-knobs/9' }, /schema/],
      ['lesson 0', outcome({ lesson: 0, solve: 0.5 }), /lesson/], ['lesson 1', outcome({ lesson: 1, solve: 0.5 }), /lesson/],
      ['solve 0', outcome({ lesson: 0.5, solve: 0 }), /solve/], ['solve 1', outcome({ lesson: 0.5, solve: 1 }), /solve/],
      ['an outcome key outside the contract', { outcome: { S1: { lesson: 0.5, solve: 0.5, win: 0.5 } } }, /win/],
    ];
    for (const [what, over, message] of cases) {
      const res = run(knobs(over));
      expect(res.status, what).toBe(1);
      expect(res.stderr, what).toMatch(message);
    }
    const junk = knobs();
    writeFileSync(junk.file, 'not json');
    expect(run(junk).status).toBe(1);
  });

  it('logs every call as { call, argv, tokenPrefix, effort, subagentModel, configDir }, without its own --fake-knobs pair', async () => {
    const k = knobs();
    const res = await callFake(k, { effort: 'low' });
    expect(res.status, res.stderr).toBe(0);
    const [line] = k.calls();
    expect(Object.keys(line!).sort()).toEqual(['argv', 'call', 'configDir', 'effort', 'subagentModel', 'tokenPrefix']);
    expect(line).toMatchObject({ tokenPrefix: 'fake-tok-', effort: 'low', subagentModel: null, configDir: res.configDir });
    expect(line!.argv).toEqual(['-p', '--output-format', 'json', '--setting-sources', 'project', '--settings', join(res.out, 'settings.json'), '--strict-mcp-config', '--model', SONNET_MODEL]);
    const noEffort = await callFake(k);
    expect(k.calls().at(-1)!.effort).toBeNull();
    expect(noEffort.status).toBe(0);
    await callFake(k, { subagentModel: OPUS_MODEL });
    expect(k.calls().at(-1)!.subagentModel).toBe(OPUS_MODEL);
    spawnSync(process.execPath, [FAKE, '--fake-knobs', k.file, '--version'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });
    expect(k.calls().at(-1)!.argv).toEqual(['--version']);
  });

  it('refuses a call whose token is not the knobs\' token', async () => {
    const k = knobs();
    const res = await callFake(k, { token: 'fake-tok-other' });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/token/);
    expect(res.stdout).toBe('');
  });
});

describe('usage, cost and the draw', () => {
  it('prices total_cost_usd at the --model row, with the same tokens in usage and modelUsage', async () => {
    const k = knobs();
    for (const model of [SONNET_MODEL, OPUS_MODEL]) {
      const res = await callFake(k, { model });
      const t = tokensOf(res.result!);
      const row = Object.entries(PRICES_BY_MODEL.models).find(([id]) => id === model)![1];
      expect(res.result!.total_cost_usd).toBeCloseTo(priceUsage({ inputTokens: t.input, cacheWriteTokens: t.cacheWrite, cacheReadTokens: t.cacheRead, outputTokens: t.output }, row), 10);
      expect(res.result!.modelUsage[model]).toMatchObject({ inputTokens: t.input, outputTokens: t.output, cacheReadInputTokens: t.cacheRead, cacheCreationInputTokens: t.cacheWrite });
      expect(Object.keys(res.result!.modelUsage)).toEqual([model]);
    }
    const noModel = await callFake(k, { model: null });
    expect(noModel.status).toBe(1);
    expect(noModel.stderr).toMatch(/--model/);
  });

  it('draws each token count within 5 percent of the knob, the same for one (sequence, seed, arm, prompt) in any out folder, and differently for another', async () => {
    const k = knobs();
    const a = await callFake(k);
    const b = await callFake(k);
    expect(tokensOf(a.result!)).toEqual(tokensOf(b.result!));
    const t = tokensOf(a.result!);
    expect(t.input).toBeGreaterThanOrEqual(USAGE.input * 0.95);
    expect(t.input).toBeLessThanOrEqual(USAGE.input * 1.05);
    expect(t.cacheRead).toBeGreaterThanOrEqual(USAGE.cacheRead * 0.95);
    expect(t.cacheRead).toBeLessThanOrEqual(USAGE.cacheRead * 1.05);
    for (const other of [{ arm: 'S2' }, { seed: 2 }, { seq: 'seqB' }, { prompt: 'look around only\nFAKE_POS 2' }]) {
      expect(tokensOf((await callFake(k, other)).result!), JSON.stringify(other)).not.toEqual(t);
    }
  });

  it('multiplies output by effortScale at CLAUDE_CODE_EFFORT_LEVEL: low < medium < high', async () => {
    const k = knobs();
    const out: Record<string, ReturnType<typeof tokensOf>> = {};
    for (const effort of ['low', 'medium', 'high']) out[effort] = tokensOf((await callFake(k, { effort })).result!);
    expect(out.low!.output).toBeLessThan(out.medium!.output);
    expect(out.medium!.output).toBeLessThan(out.high!.output);
    expect(out.low!.input).toBe(out.high!.input);
    expect(out.high!.output / out.low!.output).toBeCloseTo(4, 1);
  });

  it('gives every assistant message in the transcript its model and an id no other attempt shares', async () => {
    const k = knobs();
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const res = await callFake(k, { effort: 'medium' });
      const dir = join(res.configDir, 'projects');
      const file = readdirSync(dir).flatMap((f) => readdirSync(join(dir, f)).filter((n) => n.endsWith('.jsonl')).map((n) => join(dir, f, n)))[0]!;
      const assistants = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.type === 'assistant');
      expect(assistants.length).toBeGreaterThanOrEqual(2);
      for (const m of assistants) {
        expect(m.message.model).toBe(SONNET_MODEL);
        expect(ids.has(m.message.id), m.message.id).toBe(false);
      }
      // The attempt's usage sits on its last message, so a transcript prices to the same figure as the result.
      const last = assistants.at(-1)!.message.usage;
      expect(last.output_tokens).toBe(res.result!.usage.output_tokens);
      for (const m of assistants) ids.add(m.message.id);
    }
  });
});

describe('requests', () => {
  it('posts one /v1/messages body with --model and output_config.effort to ANTHROPIC_BASE_URL', async () => {
    const server = await listener();
    try {
      const k = knobs();
      const res = await callFake(k, { baseUrl: server.url, effort: 'high' });
      expect(res.status, res.stderr).toBe(0);
      expect(server.bodies()).toHaveLength(1);
      expect(server.bodies()[0]).toMatchObject({ url: '/v1/messages', body: { model: SONNET_MODEL, output_config: { effort: 'high' } } });
      const none = await callFake(k);
      expect(none.status).toBe(0);
      expect(server.bodies()).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('exits 9 and sends nothing when ANTHROPIC_BASE_URL is not on 127.0.0.1', async () => {
    const k = knobs();
    for (const baseUrl of ['https://api.anthropic.com', 'http://example.com:8080', 'http://localhost:9999']) {
      const res = await callFake(k, { baseUrl });
      expect(res.status, baseUrl).toBe(9);
      expect(res.stdout, baseUrl).toBe('');
    }
  });

  it('an offPin cell\'s nth first session posts with the knob\'s model; every other call posts the pinned one', async () => {
    const server = await listener();
    try {
      const k = knobs({ offPin: [{ sequence: 'seqA', seed: 1, arm: 'S1', nth: 2, model: OPUS_MODEL }] });
      await callFake(k, { baseUrl: server.url, prompt: 'x\nFAKE_POS 1' });
      await callFake(k, { baseUrl: server.url, prompt: 'x\nFAKE_POS 2' });
      await callFake(k, { baseUrl: server.url, prompt: 'x\nFAKE_POS 3' });
      await callFake(k, { baseUrl: server.url, prompt: 'x\nFAKE_POS 2', seed: 2 });
      await callFake(k, { baseUrl: server.url, prompt: 'x\nFAKE_POS 2', arm: 'S2' });
      expect(server.bodies().map((b) => b.body.model)).toEqual([SONNET_MODEL, OPUS_MODEL, SONNET_MODEL, SONNET_MODEL, SONNET_MODEL]);
    } finally {
      await server.close();
    }
  });

  it('a fail cell\'s listed position posts one valid body with the pinned model and effort, then exits 1 with no stdout', async () => {
    const server = await listener();
    try {
      const k = knobs({ fail: [{ sequence: 'seqA', seed: 1, arm: 'S1', positions: [3] }] });
      const ok = await callFake(k, { baseUrl: server.url, effort: 'medium', prompt: 'x\nFAKE_POS 2' });
      expect(ok.status).toBe(0);
      const bad = await callFake(k, { baseUrl: server.url, effort: 'medium', prompt: 'x\nFAKE_POS 3' });
      expect(bad.status).toBe(1);
      expect(bad.stdout).toBe('');
      expect(server.bodies()).toHaveLength(2);
      expect(server.bodies()[1]!.body).toMatchObject({ model: SONNET_MODEL, output_config: { effort: 'medium' } });
    } finally {
      await server.close();
    }
  });

  it('a warm-up (no --settings) reads no settings file, and a warmupFail model exits 1', async () => {
    const k = knobs({ warmupFail: [SONNET_MODEL] });
    const ok = await callFake(k, { settings: false, model: OPUS_MODEL, effort: 'medium' });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.result!.total_cost_usd).toBeGreaterThan(0);
    const bad = await callFake(k, { settings: false, model: SONNET_MODEL });
    expect(bad.status).toBe(1);
    // The same model in a session is untouched.
    expect((await callFake(k, { model: SONNET_MODEL })).status).toBe(0);
  });
});

describe('the fake is no kinder than the real CLI', () => {
  interface Line { type: string; message?: { model?: string; usage?: Readonly<Record<string, number>> } }
  /** Every JSON line of every transcript a call left under its config dir. */
  const transcriptLines = (res: Spawned): Line[] => {
    const root = join(res.configDir, 'projects');
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap((folder) => readdirSync(join(root, folder)).filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => readFileSync(join(root, folder, f), 'utf8').trim().split('\n').map((l): Line => JSON.parse(l))));
  };
  const modelsIn = (res: Spawned) => [...new Set(transcriptLines(res).flatMap((l) => (l.message?.model ? [l.message.model] : [])))];

  it('an off-pin attempt writes its own model in the transcript and in modelUsage, priced at that model', async () => {
    const k = knobs({ offPin: [{ sequence: 'seqA', seed: 1, arm: 'S1', nth: 2, model: OPUS_MODEL }] });
    const forced = await callFake(k, { prompt: 'x\nFAKE_POS 2' });
    expect(forced.status, forced.stderr).toBe(0);
    expect(Object.keys(forced.result!.modelUsage)).toEqual([OPUS_MODEL]);
    const t = tokensOf(forced.result!);
    const row = Object.entries(PRICES_BY_MODEL.models).find(([id]) => id === OPUS_MODEL)![1];
    expect(forced.result!.total_cost_usd).toBeCloseTo(priceUsage({ inputTokens: t.input, cacheWriteTokens: t.cacheWrite, cacheReadTokens: t.cacheRead, outputTokens: t.output }, row), 10);
    expect(modelsIn(forced)).toEqual([OPUS_MODEL]);
    const pinned = await callFake(k, { prompt: 'x\nFAKE_POS 3' });
    expect(Object.keys(pinned.result!.modelUsage)).toEqual([SONNET_MODEL]);
    expect(modelsIn(pinned)).toEqual([SONNET_MODEL]);
  });

  it('a fail cell writes its transcript, with the call\'s usage, before it exits 1 with no result', async () => {
    const k = knobs({ fail: [{ sequence: 'seqA', seed: 1, arm: 'S1', positions: [3] }] });
    const bad = await callFake(k, { prompt: 'x\nFAKE_POS 3' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe('');
    const priced = transcriptLines(bad).filter((l) => l.message?.usage);
    expect(priced).toHaveLength(1);
    expect(priced[0]!.message).toMatchObject({ model: SONNET_MODEL, usage: { output_tokens: expect.any(Number) } });
    expect(priced[0]!.message!.usage!.output_tokens).toBeGreaterThan(0);
  });

  it('a warmupFail model writes its warm-up transcript, with usage, before it exits 1', async () => {
    const k = knobs({ warmupFail: [SONNET_MODEL] });
    const bad = await callFake(k, { settings: false, model: SONNET_MODEL });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe('');
    const priced = transcriptLines(bad).filter((l) => l.message?.usage);
    expect(priced).toHaveLength(1);
    expect(priced[0]!.message).toMatchObject({ model: SONNET_MODEL });
    expect(priced[0]!.message!.usage!.output_tokens).toBeGreaterThan(0);
  });

  it('writes one costs line per call as it exits: the billed figure, 0 for --version and a refused token, and a positive figure for a first session cut at the plan limit', async () => {
    const costs = join(tmp('r4-fake-costs-'), 'costs.jsonl');
    const k = knobs({ costs });
    spawnSync(process.execPath, [FAKE, '--fake-knobs', k.file, '--version'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });
    const refused = await callFake(k, { token: 'fake-tok-other' });
    const plain = await callFake(k);
    process.env.FAKE_CLAUDE_LIMIT_ONCE = join(tmp('r4-fake-limit-'), 'once');
    const cut = await callFake(k, { prompt: 'LIMIT look\nFAKE_POS 1' });
    // The calls ran one after another, so each cost line sits where its call line does, and no id repeats.
    const lines = jsonl<Cost>(costs);
    expect(lines.map((l) => l.call)).toEqual(k.calls().map((c) => c.call));
    expect(new Set(lines.map((l) => l.call)).size).toBe(4);
    const [version, refusedCost, plainCost, cutCost] = lines;
    expect(version).toEqual({ call: version!.call, model: null, usage: null, totalCostUsd: 0 });
    expect(refused.status).toBe(1);
    expect(refusedCost).toEqual({ call: refusedCost!.call, model: null, usage: null, totalCostUsd: 0 });
    expect(plain.status).toBe(0);
    expect(plainCost!.totalCostUsd).toBe(plain.result!.total_cost_usd);
    expect(plainCost!.usage).toEqual(plain.result!.usage);
    expect(plainCost!.model).toBe(SONNET_MODEL);
    expect(cut.status).toBe(1);
    expect(cut.stdout.trim().split('\n')).toHaveLength(1);
    expect(cut.result).toMatchObject({ is_error: true, result: expect.stringMatching(/usage limit reached/) });
    const priced = transcriptLines(cut).filter((l) => l.message?.usage);
    expect(priced).toHaveLength(1);
    expect(priced[0]!.message!.model).toBe(SONNET_MODEL);
    const u = priced[0]!.message!.usage!;
    const row = Object.entries(PRICES_BY_MODEL.models).find(([id]) => id === SONNET_MODEL)![1];
    const expected = priceUsage({ inputTokens: u.input_tokens!, cacheWriteTokens: u.cache_creation_input_tokens!, cacheReadTokens: u.cache_read_input_tokens!, outputTokens: u.output_tokens! }, row);
    expect(cutCost!.totalCostUsd).toBeGreaterThan(0);
    expect(Math.abs(cutCost!.totalCostUsd - expected)).toBeLessThan(1e-12);
  });
});

describe('outcome knobs and leaks', () => {
  const outcome = (lesson: number, solve: number) => ({ outcome: { S1: { lesson, solve } } });

  it('KNOB_LESSON writes lesson.txt ok when u is below lesson, KNOB_SOLVE writes the fix when u is below solve', async () => {
    const prompt = 'KNOB_LESSON\nKNOB_SOLVE\nFAKE_POS 1';
    const high = await callFake(knobs(outcome(0.999, 0.999)), { prompt });
    expect(readFileSync(join(high.cwd, 'lesson.txt'), 'utf8').trim()).toBe('ok');
    expect(readFileSync(join(high.cwd, 'lib.js'), 'utf8')).toContain('a + b');
    const low = await callFake(knobs(outcome(0.001, 0.001)), { prompt });
    expect(readFileSync(join(low.cwd, 'lesson.txt'), 'utf8').trim()).toBe('bad');
    expect(existsSync(join(low.cwd, 'lib.js'))).toBe(false);
    // No marker, no write.
    const plainCall = await callFake(knobs(outcome(0.999, 0.999)));
    expect(existsSync(join(plainCall.cwd, 'lesson.txt'))).toBe(false);
  });

  it('a leaks cell writes its phrase to the auto-memory file; with once it leaks in the first folder only, and the done file sits beside the knobs', async () => {
    const phrase = 'zq-leaked-phrase';
    const cell = { sequence: 'seqA', seed: 1, arm: 'S1', phraseB64: Buffer.from(phrase).toString('base64') };
    const memoryOf = (res: Spawned) => {
      const root = join(res.configDir, 'projects');
      return existsSync(root) ? readdirSync(root).map((f) => join(root, f, 'memory', 'MEMORY.md')).filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf8')).join('') : '';
    };
    const every = knobs({ leaks: [{ ...cell, once: false }] });
    expect(memoryOf(await callFake(every))).toContain(phrase);
    expect(memoryOf(await callFake(every))).toContain(phrase);
    expect(memoryOf(await callFake(every, { seed: 2 }))).not.toContain(phrase);
    const once = knobs({ leaks: [{ ...cell, once: true }] });
    const done = join(once.dir, 'fake-state', 'leak-seqA-1-S1.done');
    expect(existsSync(done)).toBe(false);
    expect(memoryOf(await callFake(once))).toContain(phrase);
    expect(existsSync(done)).toBe(true);
    expect(memoryOf(await callFake(once))).not.toContain(phrase);
  });
});

/** A run of the fake through runAll under r4 with a stub upstream. */
async function r4run(s: ReturnType<typeof spec>, arms: string[], out: string, k: Knobs, extra: Over = {}) {
  mkdirSync(out, { recursive: true });
  const stub = await startStubUpstream(join(out, 'stub.jsonl'));
  try {
    return await runAll({
      spec: s, arms, seeds: 1, outDir: out, model: null, claudeBin: k.cmd, settleMs: 0, warmup: true, log: () => {}, passEnv: [], design: DESIGNS.r4, effort: 'medium', upstream: stub.url, hippoBuild: BUILD, ...extra,
    });
  } finally {
    await stub.close();
  }
}

/** Five tasks: a teach, two plain, two applies, each with the knob markers and a position. */
function knobSpec(r: ReturnType<typeof makeRepo>, marks: Record<string, string> = {}) {
  const at = (id: string, pos: number, more = '') => `${more}FAKE_POS ${pos}${marks[id] ?? ''}`;
  return spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
    teach(r, 't1', 'f1-l1', at('t1', 1, 'KNOB_LESSON\n')), task(r, 'n1', at('n1', 2)), task(r, 'n2', at('n2', 3)),
    apply(r, 'a1', 'f1-l1', at('a1', 4, 'KNOB_LESSON\nKNOB_SOLVE\n')), apply(r, 'a2', 'f1-l1', at('a2', 5, 'KNOB_LESSON\nKNOB_SOLVE\n')),
  ]);
}
interface RequestLine { method?: string; url?: string; body?: string; status?: number }
const requestLines = (out: string) => {
  const dir = join(out, 'raw');
  const files: string[] = [];
  const walk = (d: string) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : (e.name.endsWith('.requests.jsonl') ? files.push(join(d, e.name)) : undefined)));
  if (existsSync(dir)) walk(dir);
  return files.flatMap((f) => jsonl<RequestLine>(f).map((l) => ({ file: f, ...l })));
};
const bodyOf = (l: RequestLine) => JSON.parse(l.body ?? 'null');
const one = (records: Wire[], arm: string, id: string) => records.find((x) => x.arm === arm && x.taskId === id);

describe('through the runner', () => {
  it('every logged request has a 200 line in stub.jsonl, every record\'s envKeys pass G1, and the version knob is the recorded claudeVersion', async () => {
    const { out } = isolate('r4-fake-run');
    const k = knobs();
    await r4run(knobSpec(makeRepo()), ['S1', 'S2'], out, k);
    const records = wire(out);
    expect(records).toHaveLength(10);
    const posts = requestLines(out).filter((l) => l.method === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(10);
    const stub = jsonl<RequestLine>(join(out, 'stub.jsonl'));
    expect(stub).toHaveLength(posts.length);
    for (const line of stub) expect(line).toEqual({ url: '/v1/messages', status: 200 });
    expect(requestLines(out).filter((l) => l.status !== undefined).every((l) => l.status === 200)).toBe(true);
    expect(g1(readRecords(out), {}).pass).toBe(true);
    for (const x of records) {
      expect(x.claudeVersion).toBe('9.9.9 (Claude Code)');
      expect(x.envKeys).not.toContain('ANTHROPIC_BASE_URL');
    }
    for (const c of k.calls()) expect(c.tokenPrefix).toBe('fake-tok-');
    for (const c of k.calls()) expect(c.subagentModel).toBe(SONNET_MODEL);
    // Every body names the arm's pinned model and effort.
    for (const p of posts) expect(bodyOf(p)).toMatchObject({ model: SONNET_MODEL, output_config: { effort: 'medium' } });
  }, 300_000);

  it('outcome.lesson at 0.999 gives every apply ok and at 0.001 gives none', async () => {
    const r = makeRepo();
    const firsts = async (lessonRate: number) => {
      const { out } = isolate(`r4-fake-outcome-${lessonRate}`);
      await r4run(knobSpec(r), ['S1'], out, knobs({ outcome: { S1: { lesson: lessonRate, solve: 0.5 } } }), { warmup: false });
      return wire(out).filter((x) => x.kind === 'apply').map((x) => x.lessons[0]);
    };
    const all = await firsts(0.999);
    expect(all).toHaveLength(2);
    for (const l of all) expect(l).toMatchObject({ first: 'pass', final: 'pass' });
    for (const l of await firsts(0.001)) expect(l).toMatchObject({ first: 'fail', final: 'fail' });
  }, 300_000);

  it('S2 usage at twice S1\'s gives usageRatio 2 within 5 percent, and total_cost_usd is the usage at the model row', async () => {
    const { out } = isolate('r4-fake-ratio');
    const double = { input: USAGE.input * 2, output: USAGE.output * 2, cacheRead: USAGE.cacheRead * 2, cacheWrite: USAGE.cacheWrite * 2 };
    const k = knobs({ usage: { ...Object.fromEntries(ALL_ARMS.map((a: string) => [a, USAGE])), S2: double } });
    await r4run(knobSpec(makeRepo()), ['S1', 'S2'], out, k, { warmup: false });
    const records = readRecords(out);
    const ratio = usageRatio(records, 'S2', 'S1', PRICES_BY_MODEL);
    expect(ratio).toBeGreaterThan(2 * 0.95);
    expect(ratio).toBeLessThan(2 * 1.05);
    for (const x of records.filter((y) => y.arm === 'S1')) {
      const u = x.usage!;
      const sum = { inputTokens: u.firstSession.inputTokens + u.extra.inputTokens, cacheWriteTokens: u.firstSession.cacheWriteTokens + u.extra.cacheWriteTokens, cacheReadTokens: u.firstSession.cacheReadTokens + u.extra.cacheReadTokens, outputTokens: u.firstSession.outputTokens + u.extra.outputTokens };
      expect(x.costUsd).toBeCloseTo(priceUsage(sum, PRICES_BY_MODEL.models[SONNET_MODEL]), 8);
    }
  }, 300_000);

  it('only the offPin cell\'s body names another model, and a fail cell\'s record is invalid no-result', async () => {
    const { out } = isolate('r4-fake-forced');
    const k = knobs({
      offPin: [{ sequence: 'seqF', seed: 1, arm: 'S1', nth: 2, model: OPUS_MODEL }],
      fail: [{ sequence: 'seqF', seed: 1, arm: 'S1', positions: [3] }],
    });
    await r4run(knobSpec(makeRepo()), ['S1'], out, k, { warmup: false });
    expect(one(wire(out), 'S1', 'n2')).toMatchObject({ invalid: 'no-result', resolved: false });
    expect(wire(out).filter((x) => x.invalid)).toHaveLength(1);
    const odd = requestLines(out).filter((l) => l.method === 'POST' && bodyOf(l).model !== SONNET_MODEL);
    expect(odd.map((l) => `${l.file.split(/[\\/]/).at(-1)}`)).toEqual(['n1.session1.requests.jsonl']);
    expect(bodyOf(odd[0]!).model).toBe(OPUS_MODEL);
    // The failed call still posted one valid pinned body.
    const failed = requestLines(out).filter((l) => l.method === 'POST' && l.file.endsWith('n2.session1.requests.jsonl'));
    expect(failed).toHaveLength(1);
    expect(bodyOf(failed[0]!)).toMatchObject({ model: SONNET_MODEL, output_config: { effort: 'medium' } });
  }, 300_000);

  it('version changes the claudeVersion the run records', async () => {
    const { out } = isolate('r4-fake-version');
    await r4run(knobSpec(makeRepo()), ['S1'], out, knobs({ version: '0.0.1' }), { warmup: false });
    for (const x of wire(out)) expect(x.claudeVersion).toBe('0.0.1 (Claude Code)');
  }, 300_000);

  it('a cell\'s rerun in a new --out draws the same usage', async () => {
    const r = makeRepo();
    const usageOf = async (name: string) => {
      const { out } = isolate(name);
      await r4run(knobSpec(r), ['S1'], out, knobs(), { warmup: false });
      return readRecords(out).map((x) => [x.taskId, JSON.stringify(x.usage)]);
    };
    expect(await usageOf('r4-fake-rerun-a')).toEqual(await usageOf('r4-fake-rerun-b'));
  }, 300_000);

  it('a leaks cell with once leaks in its first run and writes its done file outside --out; the rerun in a new folder does not leak', async () => {
    const r = makeRepo();
    const fam = [family('f1', [lesson('f1-l1', 'Write the lesson file')])];
    const leakSpec = () => spec(r, fam, [task(r, 'n0', 'FAKE_POS 0'), teach(r, 't1', 'f1-l1', 'FAKE_POS 1'), task(r, 'n1', 'FAKE_POS 2'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'FAKE_POS 4'), apply(r, 'a2', 'f1-l1', 'FAKE_POS 5')]);
    const k = knobs({ leaks: [{ sequence: 'seqF', seed: 1, arm: 'S1', phraseB64: Buffer.from('note zq-f1-l1').toString('base64'), once: true }] });
    const first = isolate('r4-fake-leak-a');
    await r4run(leakSpec(), ['S1'], first.out, k, { warmup: false });
    expect(one(wire(first.out), 'S1', 't1')).toMatchObject({ invalid: 'leak', leak: true });
    expect(existsSync(join(k.dir, 'fake-state', 'leak-seqF-1-S1.done'))).toBe(true);
    expect(existsSync(join(first.out, 'fake-state'))).toBe(false);
    const second = isolate('r4-fake-leak-b');
    await r4run(leakSpec(), ['S1'], second.out, k, { warmup: false });
    expect(wire(second.out).filter((x) => x.invalid)).toEqual([]);
  }, 300_000);

  it('prints the timing slice D needs: FAKE TASK MS plain <a> hippo <b>, and FAKE WARMUP MS <w>', async () => {
    const r = makeRepo();
    const perTask = async (arm: string) => {
      const { out } = isolate(`r4-fake-time-${arm}`);
      const s = spec(r, [], [task(r, 'p1', 'FAKE_POS 1'), task(r, 'p2', 'FAKE_POS 2'), task(r, 'p3', 'FAKE_POS 3')]);
      const start = performance.now();
      // Settles included: the hippo arm waits the runner's own settle after each task.
      await r4run(s, [arm], out, knobs(), { warmup: false, settleMs: 5000 });
      return (performance.now() - start) / 3;
    };
    const [plainMs, hippoMs] = [await perTask('S1'), await perTask('S2')];
    const k = knobs();
    const start = performance.now();
    const warm = await callFake(k, { settings: false, effort: 'medium' });
    const warmMs = performance.now() - start;
    expect(warm.status).toBe(0);
    console.log(`FAKE TASK MS plain ${Math.round(plainMs)} hippo ${Math.round(hippoMs)}`);
    console.log(`FAKE WARMUP MS ${Math.round(warmMs)}`);
    expect(hippoMs).toBeGreaterThan(plainMs);
  }, 300_000);
});

describe('ab-run --fake-agent', () => {
  /** A tasks file for the CLI, and an out folder with no instruction file above it (a real run refuses one that has). */
  function cliWorld() {
    const r = makeRepo();
    const scratch = tmp('r4-fake-cli-');
    const file = join(scratch, 'tasks.json');
    writeFileSync(file, JSON.stringify({ sequences: [{ id: 'seqA', cluster: 'c', repo: r.repo, fixedOrder: true, tasks: [task(r, 'p1', 'FAKE_POS 1'), task(r, 'p2', 'FAKE_POS 2')] }] }));
    const bare = ancestorInstructionFiles(tmpdir()).length === 0;
    const base = bare ? tmpdir() : parse(tmpdir()).root;
    const out = mkdtempSync(join(base, 'z0-r4-fake-'));
    extraDirs.push(out);
    const k = knobs();
    const cli = (args: string[], env: Record<string, string | undefined> = {}) => {
      const e = envWithout(['Z0_ANCESTOR_STOP'], { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ...env });
      return spawnSync(process.execPath, [AB_RUN, '--tasks', file, '--out', join(out, `run${n++}`), ...args], { encoding: 'utf8', env: e });
    };
    let n = 0;
    return { cli, k, out, scratch };
  }

  it('refuses --claude-bin beside it, and a token that does not start fake-tok-, before any clone', () => {
    const w = cliWorld();
    const both = w.cli(['--fake-agent', w.k.file, '--claude-bin', 'claude', '--dry-run']);
    expect(both.status).toBe(1);
    expect(both.stderr).toContain('--fake-agent runs the fake itself; drop --claude-bin');
    for (const token of ['real-login-token', 'faketoken', 'x']) {
      const res = w.cli(['--fake-agent', w.k.file], { CLAUDE_CODE_OAUTH_TOKEN: token });
      expect(res.status, token).toBe(1);
      expect(res.stderr, token).toContain('CLAUDE_CODE_OAUTH_TOKEN must start fake-tok-');
      expect(res.stderr).not.toContain(token);
    }
    const missing = w.cli(['--fake-agent', join(w.scratch, 'nope.json')]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('nope.json');
    expect(readdirSync(w.out)).toEqual([]);
  }, 60_000);

  it('refuses --token-schedule and --token-var, which would put a real login in the calls log', () => {
    const w = cliWorld();
    for (const flag of ['--token-schedule', '--token-var']) {
      const res = w.cli(['--fake-agent', w.k.file, flag, 'x', '--dry-run']);
      expect(res.status, flag).toBe(1);
      expect(res.stderr, flag).toContain(`drop ${flag}`);
    }
    expect(readdirSync(w.out)).toEqual([]);
  }, 60_000);

  it('runs the fake under r3 with the warm-up on: a stub upstream answers every request, and the run holds no secret', async () => {
    const w = cliWorld();
    const res = w.cli(['--fake-agent', w.k.file, '--model', SONNET_MODEL, '--arms', 'A1', '--seeds', '1', '--settle-ms', '0']);
    expect(res.status, `${res.stderr}\n${res.stdout}`).toBe(0);
    const out = join(w.out, 'run0');
    expect(readRecords(out)).toHaveLength(2);
    const posts = requestLines(out).filter((l) => l.method === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(jsonl<RequestLine>(join(out, 'stub.jsonl'))).toHaveLength(posts.length);
    for (const c of w.k.calls()) expect(c.tokenPrefix).toBe('fake-tok-');
    // The warm-up call and the version probe are in the log too, so no call went without the fake's token.
    expect(w.k.calls().length).toBeGreaterThanOrEqual(2 + 1 + 1);
    expect(readdirSync(out)).not.toContain('ABANDONED');
  }, 240_000);
});
