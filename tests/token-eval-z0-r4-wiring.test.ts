// Round 4 slice 2a, through runAll with the fake agent: round 3 argv, the arm wiring, pins by design, the attempts list and the warm-ups.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runAll } from '../scripts/token-eval/ab-run.mjs';
import { ALL_ARMS, ARM_SEEDS, ARM_TABLE, CARRY_ARMS, DESIGNS, HIPPO_ARMS, OPUS_MODEL, SONNET_MODEL, allowlistOf, armEnv, claudeModelOf, envAllowSet } from '../scripts/token-eval/arms.mjs';
import { runDirs } from '../scripts/token-eval/homes.mjs';
import { claudePinned, pinMismatches } from '../scripts/token-eval/pins.mjs';
import { startStubUpstream } from '../scripts/token-eval/proxy.mjs';
import { g1 } from '../scripts/token-eval/z0-gates.mjs';
import { cleanup, tmp, isolate, makeRepo, family, lesson, task, teach, apply, plain, spec, readRecords, rawResult, CLAUDE, FAKE } from './fixtures/z0-harness.js';
import { xIsolate, xRun, xTrio, xLimit } from './fixtures/z0-codex-harness.js';
import { PRICES_BY_MODEL } from './fixtures/z0-gen.js';

const BUILD = { hippoCommit: 'c'.repeat(40), hippoDirty: false, hippoDistHash: 'd'.repeat(64) };
const TOKEN = 'fake-tok-wiring';
const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const R4 = DESIGNS.r4.arms;
beforeEach(() => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
});
afterEach(() => {
  cleanup();
  for (const k of ['FAKE_CLAUDE_LIMIT_ONCE', 'VIRTUAL_ENV', 'PIP_CONSTRAINT']) delete process.env[k];
  if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
});

type Json = string | number | boolean | null | undefined | readonly Json[] | { readonly [key: string]: Json };
type Over = Readonly<Record<string, Json>>;
interface Knobs { file: string; cmd: string; calls: () => Call[] }
interface Call { argv: string[]; tokenPrefix: string | null; effort: string | null; configDir: string }

/** A knobs file for the fake agent: every arm priced from PRICES_BY_MODEL, calls logged beside it. */
function knobs(over: Over = {}, command = ''): Knobs {
  const dir = tmp('r4-wiring-knobs-');
  const prices = join(dir, 'prices.json');
  writeFileSync(prices, JSON.stringify(PRICES_BY_MODEL));
  const usage = { input: 1000, output: 2000, cacheRead: 50_000, cacheWrite: 4000 };
  const file = join(dir, 'knobs.json');
  writeFileSync(file, JSON.stringify({
    schema: 'z0-fake-knobs/1', token: TOKEN, calls: join(dir, 'calls.jsonl'), prices, version: '9.9.9', usage: Object.fromEntries(ALL_ARMS.map((a: string) => [a, usage])),
    effortScale: { low: 0.5, medium: 1, high: 2 }, outcome: Object.fromEntries(ALL_ARMS.map((a: string) => [a, { lesson: 0.5, solve: 0.5 }])), leaks: [], offPin: [], fail: [], warmupFail: [], ...over,
  }));
  const calls = () => jsonl<Call>(join(dir, 'calls.jsonl'));
  return { file, cmd: command || `"${process.execPath}" "${FAKE}" --fake-knobs "${file}"`, calls };
}

/** A command that records what it was given (argv, env, the warmups folder as it stood) and then runs the fake agent. */
function probeCommand(out: string, k: Knobs) {
  const dir = tmp('r4-wiring-probe-');
  const log = join(dir, 'probe.jsonl');
  writeFileSync(join(dir, 'probe.mjs'), [
    "import { spawnSync } from 'node:child_process';",
    "import { appendFileSync, existsSync, readdirSync } from 'node:fs';",
    `const warmups = ${JSON.stringify(join(out, 'warmups'))};`,
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), warmups: existsSync(warmups) ? readdirSync(warmups).sort() : null }) + '\\n');`,
    `const r = spawnSync(process.execPath, [${JSON.stringify(FAKE)}, '--fake-knobs', ${JSON.stringify(k.file)}, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });`,
    'process.exit(r.status ?? 1);',
  ].join('\n'));
  return {
    cmd: `"${process.execPath}" "${join(dir, 'probe.mjs')}"`,
    seen: () => jsonl<Seen>(log),
  };
}

interface Seen { argv: string[]; env: Record<string, string>; cwd: string; warmups: string[] | null }
type RunOpts = Over;
/** runAll under r4 with a stub upstream, so a request from the fake never leaves the machine. */
async function r4run(s: ReturnType<typeof spec>, arms: string[], out: string, k: Knobs, extra: RunOpts = {}) {
  mkdirSync(out, { recursive: true });
  const stub = await startStubUpstream(join(out, 'stub.jsonl'));
  try {
    return await runAll({
      spec: s, arms, seeds: 1, outDir: out, model: null, claudeBin: k.cmd, settleMs: 0, warmup: false, log: () => {}, passEnv: [], design: DESIGNS.r4, effort: 'medium', upstream: stub.url, hippoBuild: BUILD, ...extra,
    });
  } finally {
    await stub.close();
  }
}

const two = (r: ReturnType<typeof makeRepo>) => spec(r, [], [task(r, 'p1', 'look around only'), task(r, 'p2', 'look around only')]);
const jsonl = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const filesUnder = (dir: string, name: RegExp): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? filesUnder(p, name) : (name.test(f) ? [p] : []);
}) : []);
const slashes = (p: string) => p.replaceAll('\\', '/');
/** The runner's fields beyond the z0-record/1 type that these tests read. */
interface Wire { arm: string; taskId: string; model: string | null; envKeys: string[] }
const wire = (out: string) => jsonl<Wire>(join(out, 'runs.jsonl'));

describe('claudeModelOf and ARM_SEEDS', () => {
  it('gives the --model flag under r3 and the arm table\'s model under r4', () => {
    expect(claudeModelOf(DESIGNS.r3, 'A1', 'claude-fake')).toBe('claude-fake');
    expect(claudeModelOf(DESIGNS.r3, 'A1', null)).toBeNull();
    expect(R4.map((a: string) => claudeModelOf(DESIGNS.r4, a, null))).toEqual(R4.map((a: string) => ARM_TABLE[a].model));
    expect(claudeModelOf(DESIGNS.r4, 'O1', null)).toBe(OPUS_MODEL);
    expect(claudeModelOf(DESIGNS.r4, 'S1', null)).toBe(SONNET_MODEL);
    expect(() => claudeModelOf(DESIGNS.r4, 'Q9', null)).toThrow(/unknown arm Q9/);
  });

  it('ARM_SEEDS holds every arm of the table, so the seed cap finds the round 4 arms', () => {
    expect(Object.keys(ARM_SEEDS)).toEqual([...ALL_ARMS]);
    expect(R4.map((a: string) => ARM_SEEDS[a])).toEqual(R4.map((a: string) => ARM_TABLE[a].seeds));
  });
});

describe('round 3 argv and files stay as they are (--design r3, the default)', () => {
  it('spawns Claude Code with --model <flag> and records that model, and with no flag adds no --model and records null', async () => {
    const { out } = isolate('r3-model');
    const r = makeRepo();
    await runAll({ spec: two(r), arms: ['A1'], seeds: 1, outDir: out, model: 'claude-fake', claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {}, passEnv: [] });
    const withFlag: string[] = rawResult(out, 'A1', 'p1.json').argv;
    expect(withFlag[withFlag.indexOf('--model') + 1]).toBe('claude-fake');
    expect(wire(out).map((x) => x.model)).toEqual(['claude-fake', 'claude-fake']);
    const out2 = tmp('r4-wiring-nomodel-');
    await runAll({ spec: two(r), arms: ['A1'], seeds: 1, outDir: out2, model: null, claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {}, passEnv: [] });
    expect(rawResult(out2, 'A1', 'p1.json').argv).not.toContain('--model');
    expect(wire(out2).map((x) => x.model)).toEqual([null, null]);
    for (const dir of [out, out2]) expect(filesUnder(dir, /^attempts\.jsonl$/)).toEqual([]);
  }, 120_000);

  it('accepts --pass-env VIRTUAL_ENV and hands it to the agent', async () => {
    const { out } = isolate('r3-venv');
    process.env.VIRTUAL_ENV = join(out, 'some-venv');
    await runAll({ spec: two(makeRepo()), arms: ['A0'], seeds: 1, outDir: out, model: null, claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {}, passEnv: ['VIRTUAL_ENV'] });
    expect(rawResult(out, 'A0', 'p1.json').envKeys).toContain('VIRTUAL_ENV');
    expect(wire(out)[0]!.envKeys).toContain('VIRTUAL_ENV');
  }, 60_000);

  it('a set X run\'s Claude Code teach spawns with --model <flag>', async () => {
    const { out, op } = xIsolate('r4-x');
    await xRun(xTrio(makeRepo(), {}), ['X1'], out, op, { model: 'claude-fake' });
    const teach1: string[] = rawResult(out, 'X1', 't-xa.json').argv;
    expect(teach1[teach1.indexOf('--model') + 1]).toBe('claude-fake');
  }, xLimit());

  it('the warm-up is one call with --model <flag> and the no-memory arm\'s env, and writes no warmups file', async () => {
    const { out } = isolate('r3-warm');
    const k = knobs();
    const probe = probeCommand(out, k);
    // The stub upstream keeps this knobs-mode fake from posting through the log proxy to the real API.
    await r4run(two(makeRepo()), ['A1'], out, k, { claudeBin: probe.cmd, design: DESIGNS.r3, effort: undefined, model: SONNET_MODEL, warmup: true });
    const warm = probe.seen().filter((c) => !c.argv.includes('--settings') && !c.argv.includes('--version'));
    expect(warm).toHaveLength(1);
    expect(warm[0]!.argv).toEqual(['-p', '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config', '--model', SONNET_MODEL]);
    const warmDir = join(out, 'warmup');
    const want = armEnv(DESIGNS.r3.noMemory, { ...runDirs(warmDir, '', '', 0), claudeConfig: join(warmDir, 'claude-config') }, process.env, { passEnv: [] });
    // cmd.exe adds PROMPT to a shell call's env; it is no part of armEnv.
    const { PROMPT: _prompt, ...seen } = warm[0]!.env;
    expect(seen).toEqual(want);
    expect(existsSync(join(out, 'warmups'))).toBe(false);
  }, 120_000);
});

describe('arm wiring under r4', () => {
  it('runs each of the six arms with its env, carry, settings, shim, taught CLAUDE.md and --model, every env name inside the r4 allowlist', async () => {
    const { out } = isolate('r4-wire');
    const r = makeRepo();
    const fam = family('f1', [lesson('f1-l1', 'Leave instruction files alone')]);
    const s = spec(r, [fam], [teach(r, 't1', 'f1-l1', 'FIX add in lib.js\nCARRY'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only')]);
    const k = knobs();
    await r4run(s, [...R4], out, k);
    const records = readRecords(out);
    expect(records).toHaveLength(R4.length * 5);
    const calls = k.calls();
    const allowed = envAllowSet(allowlistOf(DESIGNS.r4));
    for (const arm of R4) {
      const row = ARM_TABLE[arm];
      const mine = calls.filter((c) => slashes(c.configDir).includes(`/runs/seqF/${arm}/seed1/`));
      expect(mine.length, arm).toBeGreaterThanOrEqual(6);
      for (const c of mine) {
        expect(c.argv[c.argv.indexOf('--model') + 1], arm).toBe(row.model);
        expect(c.effort, arm).toBe('medium');
        expect(c.tokenPrefix, arm).toBe('fake-tok-');
      }
      const t1 = rawResult(out, arm, 't1.json');
      expect(t1.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, arm).toBe(row.autoMemory ? '0' : '1');
      expect(t1.envKeys, arm).toEqual(expect.arrayContaining(['CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE']));
      const settings = JSON.parse(readFileSync(join(out, 'settings', `seqF-${arm}-seed1.json`), 'utf8'));
      if (!row.autoMemory) expect(settings, arm).toEqual({ autoMemoryEnabled: false });
      else if (row.shim === 'real') expect(Object.keys(settings.hooks), arm).toContain('SessionEnd');
      else if (row.shim === 'sham') expect(Object.keys(settings.hooks).sort(), arm).toEqual(['SessionStart', 'UserPromptSubmit']);
      else expect(settings, arm).toEqual({});
      // The shim: S2 real, S5 sham, none for the rest.
      expect(t1.hippoProbe.status === 0, arm).toBe(HIPPO_ARMS.has(arm));
      const seen: Readonly<Record<string, string>> = rawResult(out, arm, 'n1.json').files;
      expect('AGENTS.md' in seen, arm).toBe(CARRY_ARMS.has(arm));
      if (CARRY_ARMS.has(arm)) expect(seen['AGENTS.md'], arm).toContain('carried agents note');
      expect(seen['CLAUDE.md'] ?? '', arm).toSatisfy((text: string) => text.includes('- Leave instruction files alone, because the f1-l1 checker reads it.') === (row.taught === 'claude-md'));
    }
    const store = (arm: string) => readFileSync(join(out, 'runs', 'seqF', arm, 'seed1', 'work', '.hippo', 'config.json'), 'utf8');
    expect(JSON.parse(store('S2')).pinnedInject.promptRecall).toBe(true);
    expect(JSON.parse(store('S5')).extraction.enabled).toBe(false);
    for (const x of wire(out)) {
      expect(x.model, `${x.arm} ${x.taskId}`).toBe(ARM_TABLE[x.arm].model);
      for (const name of x.envKeys) expect(allowed.has(name.toUpperCase()), `${x.arm} ${name}`).toBe(true);
    }
    expect(g1(records, {}).pass).toBe(true);
    const modelOf = (arm: string) => wire(out).find((x) => x.arm === arm && x.taskId === 't1')!.model;
    expect(modelOf('S2')).toBe(SONNET_MODEL);
    expect(modelOf('O1')).toBe(OPUS_MODEL);
  }, 600_000);
});

describe('pins under r4', () => {
  const pinsFor = (effort: string, over: Over = {}) => ({
    claudeVersion: '9.9.9', effort, hippoCommit: BUILD.hippoCommit, hippoDistHash: BUILD.hippoDistHash, modelOpus: OPUS_MODEL, modelSonnet: SONNET_MODEL, ...over,
  });
  const ctxOf = (arms: string[], over: Over = {}) => ({ design: DESIGNS.r4, arms, model: null, effort: 'medium', claudeVersion: '2.1.288 (Claude Code)', hippoBuild: BUILD, ...over });

  it('claudePinned names the version, the effort, the build and the model key of each arm of the run, and nothing for a model the run does not use', () => {
    const cases: [string[], string[]][] = [
      [['O1'], ['modelOpus']], [['S1', 'S2'], ['modelSonnet']], [[...R4], ['modelOpus', 'modelSonnet']],
    ];
    for (const [arms, keys] of cases) {
      const got = claudePinned(ctxOf(arms));
      expect(Object.keys(got).sort(), arms.join()).toEqual(['claudeVersion', 'effort', 'hippoCommit', 'hippoDistHash', ...keys].sort());
      expect(got).toMatchObject({ claudeVersion: '2.1.288', effort: 'medium', hippoCommit: BUILD.hippoCommit });
      const pins = pinsFor('medium', { claudeVersion: '2.1.288' });
      expect(pinMismatches(pins, got), arms.join()).toEqual([]);
      const { hippoCommit: _dropped, ...partial } = pins;
      expect(pinMismatches(partial, got), arms.join()).toEqual(['hippoCommit is not pinned']);
    }
    expect(pinMismatches(pinsFor('medium', { claudeVersion: '2.1.288', modelSonnet: 'claude-sonnet-5-4' }), claudePinned(ctxOf(['S1'])))).toEqual([`modelSonnet is pinned claude-sonnet-5-4, this run has ${SONNET_MODEL}`]);
    // Round 3 keeps its keys, and ignores the design fields.
    expect(Object.keys(claudePinned({ claudeVersion: '2.1.288 (Claude Code)', model: 'm', hippoBuild: BUILD }))).toEqual(['claudeVersion', 'model', 'hippoCommit', 'hippoDistHash']);
  });

  it('--effort low with the low pins file passes, and every spawn and each warm-up carries CLAUDE_CODE_EFFORT_LEVEL=low; --effort high with it names effort and starts no session', async () => {
    const { out } = isolate('r4-pins');
    const r = makeRepo();
    const k = knobs();
    await r4run(two(r), ['O1', 'S1'], out, k, { effort: 'low', pins: pinsFor('low'), warmup: true });
    const calls = k.calls();
    expect(calls.length).toBeGreaterThanOrEqual(1 + 2 + 4);
    for (const c of calls) expect(c.effort, c.argv.join(' ')).toBe('low');
    expect(readRecords(out)).toHaveLength(4);
    const high = join(tmp('r4-pins-high-'), 'out');
    const k2 = knobs();
    await expect(r4run(two(r), ['O1', 'S1'], high, k2, { effort: 'high', pins: pinsFor('low'), warmup: true })).rejects.toThrow(/differs from --pins: effort is pinned low, this run has high/);
    expect(k2.calls().every((c) => c.argv.includes('--version'))).toBe(true);
    expect(existsSync(join(high, 'runs.jsonl'))).toBe(false);
    const k3 = knobs();
    await r4run(two(r), ['S1'], join(tmp('r4-pins-high-ok-'), 'out'), k3, { effort: 'high', pins: pinsFor('high'), warmup: true });
    for (const c of k3.calls()) expect(c.effort).toBe('high');
  }, 240_000);

  it('a pins file without hippoCommit, or with another model, stops the run before any session', async () => {
    const { out } = isolate('r4-pins-bad');
    const r = makeRepo();
    const { hippoCommit: _dropped, ...partial } = pinsFor('medium');
    const k = knobs();
    await expect(r4run(two(r), ['S1'], out, k, { pins: partial })).rejects.toThrow(/hippoCommit is not pinned/);
    const k2 = knobs();
    await expect(r4run(two(r), ['S1'], join(tmp('r4-pins-bad2-'), 'out'), k2, { pins: pinsFor('medium', { modelSonnet: OPUS_MODEL }) })).rejects.toThrow(/modelSonnet is pinned claude-opus-5-5, this run has claude-sonnet-5-5/);
    for (const x of [k, k2]) expect(x.calls().every((c) => c.argv.includes('--version'))).toBe(true);
  }, 120_000);
});

interface Attempt { taskId: string; kind: string; attempt: number; sessionId: string; logFile: string; sizesBefore: Readonly<Record<string, number>> | null }
describe('attempts list', () => {
  const attemptsOf = (out: string, arm: string) => jsonl<Attempt>(join(out, 'raw', 'seqF', arm, 'seed1', 'attempts.jsonl'));
  const teachSpec = (r: ReturnType<typeof makeRepo>, prompt: string) => spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [teach(r, 't1', 'f1-l1', prompt), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only')]);

  it('a session at the plan limit once, then passing, writes two session lines with two ids and two log files', async () => {
    const { out } = isolate('r4-limit');
    process.env.FAKE_CLAUDE_LIMIT_ONCE = join(tmp('r4-limit-marker-'), 'once');
    await r4run(teachSpec(makeRepo(), 'LIMIT\nLESSON_BAD'), ['S1'], out, knobs(), { passEnv: ['FAKE_CLAUDE_LIMIT_ONCE'], limitWaitMs: 0 });
    const lines = attemptsOf(out, 'S1');
    const sessions = lines.filter((l) => l.taskId === 't1' && l.kind === 'session');
    expect(sessions.map((l) => l.attempt)).toEqual([1, 2]);
    expect(new Set(sessions.map((l) => l.sessionId)).size).toBe(2);
    expect(sessions.map((l) => l.sizesBefore)).toEqual([null, null]);
    const raw = join(out, 'raw', 'seqF', 'S1', 'seed1');
    expect(sessions.map((l) => slashes(l.logFile))).toEqual([slashes(join(raw, 't1.session1.requests.jsonl')), slashes(join(raw, 't1.session2.requests.jsonl'))]);
    for (const l of sessions) expect(existsSync(l.logFile), l.logFile).toBe(true);
    // The resume names the id the kept attempt ran under and the byte counts of session 1's files.
    const resume = lines.filter((l) => l.taskId === 't1' && l.kind === 'resume');
    expect(resume).toHaveLength(1);
    expect(resume[0]!.sessionId).toBe(sessions[1]!.sessionId);
    expect(readRecords(out).find((x) => x.taskId === 't1')).toMatchObject({ sessionId: sessions[1]!.sessionId, limitRetries: 1 });
    expect(lines.filter((l) => l.taskId === 'n1').map((l) => [l.kind, l.attempt])).toEqual([['session', 1]]);
  }, 180_000);

  it('a resume line holds the resumed id and sizesBefore as forward-slash paths under claude-config; a cut-off resume gives two lines with the same map', async () => {
    const { out } = isolate('r4-resume');
    await r4run(teachSpec(makeRepo(), 'CUT_ON_RESUME\nLESSON_BAD'), ['S1'], out, knobs(), { limitWaitMs: 0 });
    const lines = attemptsOf(out, 'S1');
    const [first] = lines.filter((l) => l.taskId === 't1' && l.kind === 'session');
    const resumes = lines.filter((l) => l.taskId === 't1' && l.kind === 'resume');
    expect(resumes.map((l) => l.attempt)).toEqual([1, 2]);
    for (const l of resumes) expect(l.sessionId).toBe(first!.sessionId);
    const [a, b] = resumes;
    expect(a!.sizesBefore).toEqual(b!.sizesBefore);
    const paths = Object.keys(a!.sizesBefore!);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    const config = join(out, 'runs', 'seqF', 'S1', 'seed1', 'claude-config');
    for (const p of paths) {
      expect(p).toMatch(/^projects\/.+\.jsonl$/);
      expect(p).not.toContain('\\');
      expect(a!.sizesBefore![p]).toBeGreaterThan(0);
      expect(a!.sizesBefore![p]!).toBeLessThanOrEqual(statSync(join(config, ...p.split('/'))).size);
    }
    expect(paths).toContain(`projects/${paths[0]!.split('/')[1]}/${first!.sessionId}.jsonl`);
  }, 180_000);

  it('appends complete lines only, and a torn last line is dropped before the next append', async () => {
    const { out } = isolate('r4-torn');
    const r = makeRepo();
    const raw = join(out, 'raw', 'seqF', 'S1', 'seed1');
    mkdirSync(raw, { recursive: true });
    writeFileSync(join(raw, 'attempts.jsonl'), '{"taskId":"zq-cut"');
    await r4run(two(r), ['S1'], out, knobs());
    const text = readFileSync(join(raw, 'attempts.jsonl'), 'utf8');
    expect(text).not.toContain('zq-cut');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n').map((l) => JSON.parse(l).taskId)).toEqual(['p1', 'p2']);
  }, 120_000);
});

describe('warm-ups under r4', () => {
  it('one per distinct model of the run\'s arms, each with a start file and a result file holding total_cost_usd', async () => {
    const { out } = isolate('r4-warm');
    const k = knobs();
    const probe = probeCommand(out, k);
    await r4run(two(makeRepo()), ['S1', 'O1'].sort((a, b) => R4.indexOf(a) - R4.indexOf(b)), out, k, { claudeBin: probe.cmd, warmup: true });
    const w = (name: string) => JSON.parse(readFileSync(join(out, 'warmups', name), 'utf8'));
    for (const model of [OPUS_MODEL, SONNET_MODEL]) {
      expect(w(`${model}.start.json`)).toEqual({ model, configDir: join(out, 'warmup', model, 'claude-config') });
      const done = w(`${model}.json`);
      expect(done).toMatchObject({ model, status: 0, result: { type: 'result', is_error: false } });
      expect(done.total_cost_usd).toBeGreaterThan(0);
      expect(done.total_cost_usd).toBe(done.result.total_cost_usd);
    }
    // Opus first, as the arms run; each warm-up call has --model, no --settings, the effort and its own config dir.
    const calls = probe.seen().filter((c) => !c.argv.includes('--settings') && !c.argv.includes('--version'));
    expect(calls.map((c) => c.argv.at(-1))).toEqual([OPUS_MODEL, SONNET_MODEL]);
    for (const [i, model] of [OPUS_MODEL, SONNET_MODEL].entries()) {
      expect(calls[i]!.argv).toEqual(['-p', '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config', '--model', model]);
      expect(calls[i]!.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('medium');
      expect(calls[i]!.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe(model);
      expect(calls[i]!.env.CLAUDE_CONFIG_DIR).toBe(join(out, 'warmup', model, 'claude-config'));
      // The start file is on disk before the spawn and the result file is not.
      expect(calls[i]!.warmups).toContain(`${model}.start.json`);
      expect(calls[i]!.warmups).not.toContain(`${model}.json`);
    }
    // The version probe runs in the first model's env.
    const version = probe.seen().find((c) => c.argv.includes('--version'))!;
    expect(version.env.CLAUDE_CONFIG_DIR).toBe(join(out, 'warmup', OPUS_MODEL, 'claude-config'));
  }, 180_000);

  it('a run of Sonnet arms only warms Sonnet up, once', async () => {
    const { out } = isolate('r4-warm-one');
    await r4run(two(makeRepo()), ['S1', 'S2'], out, knobs(), { warmup: true });
    expect(readdirSync(join(out, 'warmups')).sort()).toEqual([`${SONNET_MODEL}.json`, `${SONNET_MODEL}.start.json`]);
  }, 180_000);

  it('a warmupFail model stops the run with its line, after its start file, before any record', async () => {
    const { out } = isolate('r4-warm-fail');
    const k = knobs({ warmupFail: [SONNET_MODEL] });
    await expect(r4run(two(makeRepo()), ['O1', 'S1'], out, k, { warmup: true })).rejects.toThrow(`warm-up for ${SONNET_MODEL} failed (exit 1)`);
    expect(existsSync(join(out, 'warmups', `${OPUS_MODEL}.json`))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, 'warmups', `${SONNET_MODEL}.start.json`), 'utf8'))).toMatchObject({ model: SONNET_MODEL });
    expect(JSON.parse(readFileSync(join(out, 'warmups', `${SONNET_MODEL}.json`), 'utf8'))).toMatchObject({ model: SONNET_MODEL, status: 1, total_cost_usd: null });
    expect(existsSync(join(out, 'runs.jsonl'))).toBe(false);
  }, 120_000);

  it('--no-warmup writes neither file and makes no warm-up call', async () => {
    const { out } = isolate('r4-warm-off');
    const k = knobs();
    await r4run(two(makeRepo()), ['S1'], out, k, { warmup: false });
    expect(existsSync(join(out, 'warmups'))).toBe(false);
    expect(existsSync(join(out, 'warmup', SONNET_MODEL))).toBe(false);
    expect(k.calls().filter((c) => !c.argv.includes('--settings') && !c.argv.includes('--version'))).toEqual([]);
  }, 120_000);
});

describe('the task env follows the design: round 4 sets VIRTUAL_ENV and PIP_CONSTRAINT itself', () => {
  const PIN = 'C:/pins/constraints.txt';
  const LAUNCH_VENV = 'C:/launcher/venv';
  const valueOf = (env: Readonly<Record<string, string | undefined>>, name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] ?? null;
  /** Setup and check commands that log the two names they run with; the check then runs the fixture's own test. */
  function pipProbe() {
    const dir = tmp('r4-pip-probe-');
    const log = join(dir, 'pip.jsonl');
    const script = join(dir, 'pip.mjs');
    writeFileSync(script, [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ step: process.argv[2], pip: process.env.PIP_CONSTRAINT ?? null, venv: process.env.VIRTUAL_ENV ?? null }) + String.fromCharCode(10));`,
    ].join(String.fromCharCode(10)));
    return { at: (step: string) => `"${process.execPath}" "${script}" ${step}`, steps: () => jsonl<{ step: string; pip: string | null; venv: string | null }>(log) };
  }
  async function pipRun(arm: string, extra: RunOpts) {
    const { out } = isolate(`r4-pip-${arm}`);
    const r = makeRepo();
    const pp = pipProbe();
    const k = knobs();
    const probe = probeCommand(out, k);
    const tasks = [1, 2].map((i) => task(r, `p${i}`, 'look around only', { setup: pp.at('setup'), test: `${pp.at('check')} && node test.js` }));
    process.env.PIP_CONSTRAINT = PIN;
    process.env.VIRTUAL_ENV = LAUNCH_VENV;
    await r4run(spec(r, [], tasks), [arm], out, k, { claudeBin: probe.cmd, warmup: true, ...extra });
    return { steps: pp.steps(), calls: probe.seen(), out };
  }

  it('under r4, without --venv, a launcher PIP_CONSTRAINT and VIRTUAL_ENV reach no setup, check, warm-up, version probe or session, and no record\'s envKeys', async () => {
    const { steps, calls, out } = await pipRun('S1', {});
    expect(new Set(steps.map((p) => p.step))).toEqual(new Set(['setup', 'check']));
    for (const p of steps) expect([p.pip, p.venv], p.step).toEqual([null, null]);
    const kind = (c: Seen) => (c.argv.includes('--version') ? 'version' : (c.argv.includes('--settings') ? 'session' : 'warm-up'));
    expect(new Set(calls.map(kind))).toEqual(new Set(['session', 'version', 'warm-up']));
    for (const c of calls) expect([valueOf(c.env, 'PIP_CONSTRAINT'), valueOf(c.env, 'VIRTUAL_ENV')], kind(c)).toEqual([null, null]);
    expect(wire(out)).toHaveLength(2);
    for (const x of wire(out)) {
      expect(x.envKeys.map((name) => name.toUpperCase()), x.taskId).not.toContain('PIP_CONSTRAINT');
      expect(x.envKeys.map((name) => name.toUpperCase()), x.taskId).not.toContain('VIRTUAL_ENV');
    }
  }, 180_000);

  it('under r4 --pass-env of either name stops the run and names it', async () => {
    for (const name of ['VIRTUAL_ENV', 'pip_constraint']) {
      await expect(pipRun('S1', { passEnv: [name] }), name).rejects.toThrow(`--pass-env ${name}: the runner sets ${name.toUpperCase()} itself per task, so it cannot be passed through`);
    }
  }, 180_000);

  it('under r3 PIP_CONSTRAINT is still dropped from every one of them', async () => {
    const { steps, calls } = await pipRun('A1', { design: DESIGNS.r3, effort: undefined, model: SONNET_MODEL });
    expect(new Set(steps.map((p) => p.step))).toEqual(new Set(['setup', 'check']));
    for (const p of steps) expect(p.pip, p.step).toBeNull();
    for (const c of calls) expect(valueOf(c.env, 'PIP_CONSTRAINT'), c.argv.join(' ')).toBeNull();
  }, 180_000);
});

describe('the request log\'s upstream', () => {
  it('an empty ANTHROPIC_BASE_URL passed with --pass-env falls back to the default upstream, as it did before the stub', async () => {
    const saved = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = '';
    try {
      const { out } = isolate('r3-empty-base');
      await runAll({ spec: two(makeRepo()), arms: ['A1'], seeds: 1, outDir: out, model: null, claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {}, passEnv: ['ANTHROPIC_BASE_URL'] });
      expect(readRecords(out)).toHaveLength(2);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved;
    }
  }, 60_000);
});

describe('surfaceRestored on session records', () => {
  interface SurfaceWire { taskId: string; invalid: string | null; sessionId: string | null; surfaceRestored?: boolean }
  it('every record a session wrote carries it, a no-result or no-transcript one with sessionId null included, and a setup failure does not', async () => {
    const { out } = isolate('r3-surface');
    const r = makeRepo();
    const tasks = [
      task(r, 'ok1', 'look around only'), task(r, 'crash', 'CRASH'), task(r, 'nosid', 'NO_SESSION_ID'),
      task(r, 'badsetup', 'look around only', { setup: `"${process.execPath}" -e "process.exit(1)"` }),
    ];
    await runAll({ spec: spec(r, [], tasks), arms: ['A1'], seeds: 1, outDir: out, model: null, claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {}, passEnv: [] });
    const records = jsonl<SurfaceWire>(join(out, 'runs.jsonl'));
    const of = (id: string) => records.find((x) => x.taskId === id)!;
    expect(records.map((x) => x.taskId)).toEqual(['ok1', 'crash', 'nosid', 'badsetup']);
    expect(of('crash')).toMatchObject({ invalid: 'no-result', sessionId: null });
    expect(of('nosid')).toMatchObject({ invalid: 'no-transcript', sessionId: null });
    expect(of('badsetup').invalid).toBe('setup');
    for (const x of records.filter((y) => y.invalid !== 'setup')) expect([true, false], x.taskId).toContain(x.surfaceRestored);
    expect(of('badsetup')).not.toHaveProperty('surfaceRestored');
  }, 120_000);
});
