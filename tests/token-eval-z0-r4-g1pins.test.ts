// Round 4 prereg item 6: g1-pins reads every request log of every Claude Code attempt and lists the attempts off the pinned model or effort.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { DESIGNS } from '../scripts/token-eval/arms.mjs';
import { logVerdict, runCli } from '../scripts/token-eval/g1-pins.mjs';
import { loadInputs } from '../scripts/token-eval/z0-analyze.mjs';
import { filteredInput, offPinReach } from '../scripts/token-eval/z0-filters.mjs';
import { computeGates, g1, g3 } from '../scripts/token-eval/z0-gates.mjs';
import { parsePlan, parseZ0Records } from '../scripts/token-eval/z0-records.mjs';
import { cleanup, tmp } from './fixtures/z0-harness.js';
import { GRADING, generate, jsonl } from './fixtures/z0-gen.js';

const PINS = { modelOpus: 'claude-opus-5-5', modelSonnet: 'claude-sonnet-5-5', effort: 'medium' };
const SONNET = PINS.modelSonnet;
type Entry = Record<string, string | number | null>;
const line = (x: Entry) => `${JSON.stringify(x)}\n`;
// JSON.stringify leaves out an undefined output_config, which is how a body with no effort looks.
const body = (model: string, effort?: string) => JSON.stringify({ model, output_config: effort === undefined ? undefined : { effort }, messages: [] });
const request = (url: string, text: string, method = 'POST') => ({ at: 't', method, url, body: text });
const GOOD = request('/v1/messages', body(SONNET, 'medium'));
const text = (...entries: Entry[]) => entries.map(line).join('');

describe('the verdict of one request log (prereg item 6)', () => {
  const verdict = (log: string | null) => logVerdict(log, { model: SONNET, effort: 'medium' });

  it('passes a log of request, response and error entries, a count_tokens request, a HEAD line and /v1/messages with and without a query', () => {
    expect(verdict(text(
      GOOD, { url: '/v1/messages', status: 200 }, { url: '/v1/messages', error: 'socket hang up' },
      request('/v1/messages?beta=true', body(SONNET, 'medium')),
      request('/v1/messages/count_tokens', body(SONNET)), request('/api/hello', '', 'HEAD'),
    ))).toBeNull();
  });

  it('names a missing log, a log with no /v1/messages POST, a bad body and an unknown endpoint with a body', () => {
    expect(verdict(null)).toBe('no log');
    expect(verdict('')).toBe('no /v1/messages POST');
    expect(verdict(text(request('/v1/messages/count_tokens', body(SONNET)), request('/api/hello', '', 'HEAD')))).toBe('no /v1/messages POST');
    expect(verdict(text(request('/v1/messages', 'not json')))).toBe('body does not parse');
    expect(verdict(`${text(GOOD)}{"at": "torn`)).toBe('body does not parse');
    expect(verdict(text(GOOD, request('/v1/other?x=1', body(SONNET))))).toBe('unknown endpoint /v1/other');
    expect(verdict(text(GOOD, request('/v1/messages', body(SONNET, 'medium'), 'GET')))).toBeNull();
  });

  it('names a model or an effort off the pins, on any request with a body', () => {
    expect(verdict(text(request('/v1/messages', body('claude-haiku-4', 'medium'))))).toBe(`model claude-haiku-4, pinned ${SONNET}`);
    expect(verdict(text(GOOD, request('/v1/messages/count_tokens', body('claude-haiku-4'))))).toBe(`model claude-haiku-4, pinned ${SONNET}`);
    expect(verdict(text(request('/v1/messages', body(SONNET, 'high'))))).toBe('effort high, pinned medium');
    expect(verdict(text(request('/v1/messages', body(SONNET))))).toBe('effort none, pinned medium');
  });

  it('gives the first failing rule in the order no log, no POST, body, endpoint, model, effort', () => {
    const both = text(request('/v1/messages', body(SONNET, 'high')), request('/v1/other', body('claude-haiku-4')));
    expect(verdict(both)).toBe('unknown endpoint /v1/other');
    expect(verdict(text(request('/v1/messages', body('claude-haiku-4', 'high'))))).toBe(`model claude-haiku-4, pinned ${SONNET}`);
    expect(verdict(text(request('/v1/messages', 'nope'), request('/v1/other', body(SONNET))))).toBe('body does not parse');
  });
});

/** One out folder: records, plan and the raw folders. `corpus` is slice 1's generator under round 4; the folder holds its seeds. */
function outFolder(opts: { seeds?: number[]; raw?: Record<string, { attempts?: Entry[]; logs?: Record<string, string> }>; envKeys?: Record<string, string[]> } = {}) {
  const out = tmp('z0-g1pins-');
  const all = generate({ design: DESIGNS.r4, repos: 1 });
  const keep = (x: { seed: number }) => (opts.seeds ?? [1, 2, 3]).includes(x.seed);
  const records = all.records.filter(keep).map((r) => ({ ...r, envKeys: opts.envKeys?.[`${r.arm}#${r.seed}#${r.position}`] ?? ['PATH', 'PIP_CONSTRAINT'] }));
  fs.writeFileSync(path.join(out, 'runs.jsonl'), jsonl(records));
  fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(all.plan.filter(keep)));
  for (const [where, folder] of Object.entries(opts.raw ?? {})) {
    const dir = path.join(out, 'raw', ...where.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    if (folder.attempts !== undefined) fs.writeFileSync(path.join(dir, 'attempts.jsonl'), folder.attempts.map(line).join(''));
    for (const [name, log] of Object.entries(folder.logs ?? {})) fs.writeFileSync(path.join(dir, name), log);
  }
  return { out, sequence: 'rn-repo1' };
}

const attempt = (taskId: string, kind: string, n: number, sessionId: string | null) => ({ taskId, kind, attempt: n, sessionId, logFile: `C:\\elsewhere\\raw\\${taskId}.${kind}${n}.requests.jsonl`, sizesBefore: null });
const pinsFile = (extra: { effort?: string } = {}) => {
  const file = path.join(tmp('z0-g1pins-pins-'), 'pins.json');
  fs.writeFileSync(file, JSON.stringify({ ...PINS, ...extra }));
  return file;
};
const run = (out: string, offPin: string, extra: string[] = [], pins = pinsFile()) => runCli(['--run', out, '--pins', pins, '--plan-of', out, '--out', offPin, ...extra]);
const offPinOf = (out: string) => path.join(path.dirname(out), `${path.basename(out)}-off-pin.json`);
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const GOOD_LOG = text(GOOD);

describe('g1-pins on a run folder', () => {
  afterEach(cleanup);

  it('reads each attempt at <raw folder>/<basename of logFile> and writes one void per failing attempt with the position from the plan', () => {
    const { out, sequence } = outFolder({
      raw: {
        [`rn-repo1/S2/seed1`]: {
          attempts: [attempt('rn-repo1-t4', 'session', 1, 's-4'), attempt('rn-repo1-t5', 'session', 1, 's-5'), attempt('rn-repo1-t5', 'resume', 1, 's-5')],
          logs: {
            'rn-repo1-t4.session1.requests.jsonl': GOOD_LOG,
            'rn-repo1-t5.session1.requests.jsonl': text(request('/v1/messages', body('claude-haiku-4', 'medium'))),
            'rn-repo1-t5.resume1.requests.jsonl': GOOD_LOG,
          },
        },
      },
    });
    const result = run(out, offPinOf(out));
    expect(result).toMatchObject({ code: 0, stdout: 'off-pin 1\nenv-outside 0\n' });
    const file = readJson(offPinOf(out));
    expect(file.schema).toBe('z0-offpin/1');
    expect(file.voids).toEqual([{ sequence, seed: 1, arm: 'S2', position: 5, sessionId: 's-5', reason: `model claude-haiku-4, pinned ${SONNET}` }]);
    expect(file.runs).toHaveLength(1);
    expect(file.runs[0]).toMatchObject({ file: 'runs.jsonl' });
    expect(file.runs[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses the pin of the arm: an Opus arm is held to modelOpus', () => {
    const { out } = outFolder({ raw: { 'rn-repo1/O1/seed1': { attempts: [attempt('rn-repo1-t2', 'session', 1, 's')], logs: { 'rn-repo1-t2.session1.requests.jsonl': GOOD_LOG } } } });
    run(out, offPinOf(out));
    expect(readJson(offPinOf(out)).voids).toEqual([expect.objectContaining({ arm: 'O1', position: 2, reason: `model ${SONNET}, pinned ${PINS.modelOpus}` })]);
  });

  it('lists an attempt with no log, and reads a log no attempt names with a null sessionId', () => {
    const { out } = outFolder({
      raw: { 'rn-repo1/S1/seed2': { attempts: [attempt('rn-repo1-t3', 'session', 1, 's-3')], logs: { 'rn-repo1-t7.session2.requests.jsonl': text(request('/v1/messages', body('claude-haiku-4', 'medium'))) } } },
    });
    run(out, offPinOf(out));
    expect(readJson(offPinOf(out)).voids).toEqual([
      expect.objectContaining({ seed: 2, arm: 'S1', position: 3, sessionId: 's-3', reason: 'no log' }),
      expect.objectContaining({ seed: 2, arm: 'S1', position: 7, sessionId: null, reason: `model claude-haiku-4, pinned ${SONNET}` }),
    ]);
  });

  it('voids positions 5 and up of its (sequence, seed) in every arm once filteredInput reads the file', () => {
    const { out } = outFolder({ raw: { 'rn-repo1/S2/seed1': { attempts: [attempt('rn-repo1-t5', 'session', 1, 's')], logs: { 'rn-repo1-t5.session1.requests.jsonl': text(request('/v1/messages', body(SONNET, 'high'))) } } } });
    run(out, offPinOf(out));
    const args = { runs: [path.join(out, 'runs.jsonl')], plan: [path.join(out, 'plan.json')], offPin: [offPinOf(out)], prices: null, grading: null, dropList: null, out: null, design: 'r4' };
    const inputs = loadInputs(args, process.cwd());
    const { filtered } = filteredInput(inputs.records, inputs.planCells, { voids: inputs.voids, design: inputs.design }, { dropAbandoned: false });
    const hit = (r: { seed: number; position: number }) => r.seed === 1;
    expect(filtered.scored.filter(hit).every((r: { position: number }) => r.position < 5)).toBe(true);
    expect(filtered.scored.filter(hit).length).toBeGreaterThan(0);
    expect(new Set(filtered.scored.filter(hit).map((r: { arm: string }) => r.arm)).size).toBeGreaterThan(1);
    expect(filtered.scored.some((r: { seed: number; position: number }) => r.seed === 2 && r.position >= 5)).toBe(true);
    expect(filtered.offPinVoided.positions).toBe(13);
  });

  it('binds each file to its own runs file: a rerun shares the cells but not the sessions, and the first run\'s file is refused beside it', () => {
    const logFor = (model: string) => text(request('/v1/messages', body(model, 'medium')));
    const raw = (model: string, id: string) => ({ 'rn-repo1/S2/seed2': { attempts: [attempt('rn-repo1-t5', 'session', 1, id)], logs: { 'rn-repo1-t5.session1.requests.jsonl': logFor(model) } } });
    const first = outFolder({ raw: raw('claude-haiku-4', 'first-session') });
    const rerun = outFolder({ seeds: [2], raw: raw(SONNET, 'rerun-session') });
    run(first.out, offPinOf(first.out));
    run(rerun.out, offPinOf(rerun.out));
    expect(readJson(offPinOf(first.out)).voids).toHaveLength(1);
    expect(readJson(offPinOf(rerun.out)).voids).toEqual([]);
    const read = (folder: string, offPin: string) => loadInputs({ runs: [path.join(folder, 'runs.jsonl')], plan: [path.join(folder, 'plan.json')], offPin: [offPin], prices: null, grading: null, dropList: null, out: null, design: 'r4' }, process.cwd());
    expect(read(first.out, offPinOf(first.out)).voids).toHaveLength(1);
    expect(read(rerun.out, offPinOf(rerun.out)).voids).toHaveLength(0);
    expect(() => read(rerun.out, offPinOf(first.out))).toThrow(/is not a runs file this read loads/);
  });

  it('exits 1 with its usage on a pins file with no effort, an unknown plan task and a missing flag', () => {
    const { out } = outFolder({ raw: { 'rn-repo1/S2/seed1': { attempts: [attempt('not-in-plan', 'session', 1, 's')], logs: { 'not-in-plan.session1.requests.jsonl': GOOD_LOG } } } });
    expect(run(out, offPinOf(out), [], pinsFile({ effort: undefined }))).toMatchObject({ code: 1, stderr: expect.stringContaining('effort') });
    expect(run(out, offPinOf(out))).toMatchObject({ code: 1, stderr: expect.stringContaining('not-in-plan') });
    expect(runCli(['--run', out])).toMatchObject({ code: 1, stderr: expect.stringContaining('usage:') });
  });
});

describe('g1-pins env names and --strict (smoke, prereg :115)', () => {
  afterEach(cleanup);
  const dirty = () => outFolder({
    raw: { 'rn-repo1/S2/seed1': { attempts: [attempt('rn-repo1-t5', 'session', 1, 's')], logs: { 'rn-repo1-t5.session1.requests.jsonl': text(request('/v1/messages', body('claude-haiku-4', 'medium'))) } } },
    envKeys: { 'S1#1#3': ['PATH', 'pip_constraint', 'UNLISTED_NAME', 'AWS_REGION'] },
  });

  it('writes both lists and exits 0 without --strict; envOutside names the record and its outside names, and PIP_CONSTRAINT is allowed', () => {
    const { out } = dirty();
    expect(run(out, offPinOf(out))).toMatchObject({ code: 0, stdout: 'off-pin 1\nenv-outside 1\n' });
    expect(readJson(offPinOf(out)).envOutside).toEqual([{ sequence: 'rn-repo1', seed: 1, arm: 'S1', position: 3, names: ['AWS_REGION', 'UNLISTED_NAME'] }]);
  });

  it('exits 3 with --strict after writing the file, for a void and an env name, for an env name alone, and exits 0 on a clean folder', () => {
    const { out } = dirty();
    expect(run(out, offPinOf(out), ['--strict'])).toMatchObject({ code: 3, stderr: 'SMOKE FAIL: 1 off-pin, 1 env-outside\n' });
    expect(fs.existsSync(offPinOf(out))).toBe(true);
    const envOnly = outFolder({ envKeys: { 'S1#1#3': ['UNLISTED_NAME'] } });
    expect(run(envOnly.out, offPinOf(envOnly.out), ['--strict'])).toMatchObject({ code: 3, stderr: 'SMOKE FAIL: 0 off-pin, 1 env-outside\n' });
    const clean = outFolder({ raw: { 'rn-repo1/S2/seed1': { attempts: [attempt('rn-repo1-t5', 'session', 1, 's')], logs: { 'rn-repo1-t5.session1.requests.jsonl': GOOD_LOG } } } });
    expect(run(clean.out, offPinOf(clean.out), ['--strict'])).toMatchObject({ code: 0, stdout: 'off-pin 0\nenv-outside 0\n' });
  });

  it('writes a file readVoids loads as before, with the extra field', () => {
    const { out } = dirty();
    run(out, offPinOf(out));
    const inputs = loadInputs({ runs: [path.join(out, 'runs.jsonl')], plan: [path.join(out, 'plan.json')], offPin: [offPinOf(out)], prices: null, grading: null, dropList: null, out: null, design: 'r4' }, process.cwd());
    expect(inputs.voids).toHaveLength(1);
  });
});

/** The round 3 corpus with one leaked record and one hook-voided position, read through the one filter path. */
function round3() {
  const g = generate();
  g.records[10]!.leak = true;
  const dropList = { droppedLessons: [], droppedFamilies: [], hookVoids: [{ sequence: g.records[3]!.sequence, seed: 1, position: 2 }] };
  const { records } = parseZ0Records(jsonl(g.records), 'runs.jsonl');
  const input = filteredInput(records, parsePlan(JSON.stringify(g.plan), 'plan.json'), { dropList }, { dropAbandoned: false });
  return { ...input, opts: { iterations: 200, seed: 1 } };
}
const R3_ARMS = ['A0', 'A1', 'A2', 'A4', 'A5', 'X1', 'X2', 'X3', 'X4'];
// What g1, g3 and computeGates returned for round3() at afafc5494, before the off-pin bar existed.
const HEAD_G1 = { pass: true, operatorCanaries: 0, envKeysOutside: {}, anthropicApiKeyRecords: 0, perArm: Object.fromEntries(R3_ARMS.map((a) => [a, { voids: 0, share: 0 }])) };
const HEAD_G3 = { pass: true, leaked: 1, plannedRuns: 36, share: 0.027777777777777776 };
const HEAD_G4 = {
  pass: true, gap: 0, armsPass: true, gapPass: true, hookVoided: { positions: 1, share: 0.001736111111111111 }, hookPass: true,
  perArm: Object.fromEntries(R3_ARMS.map((a, i) => [a, { invalid: 0, missing: 0, planned: [216, 324, 324, 216, 324, 252, 252, 252, 168][i], share: 0, pass: true }])),
};
const manifest = (leaked: number, planned: number) => ({ firstRun: { leakedSequenceSeeds: leaked, plannedSequenceSeeds: planned } });
const OFF_PIN_BAR = { offPinVoided: { positions: 0, share: 0 } };

describe('the gates under round 3 with the off-pin bar off (prereg item 6, O4)', () => {
  it('give g1, g3 and computeGates what they gave before the bar, with and without the design and the two options', () => {
    const { filtered, records, opts } = round3();
    expect(g1(records, filtered.counts)).toEqual(HEAD_G1);
    expect(g1(records, filtered.counts, { design: DESIGNS.r3 })).toEqual(HEAD_G1);
    expect(g3(filtered.leaked.length, filtered.plannedRuns)).toEqual(HEAD_G3);
    expect(g3(1, 20)).toEqual({ pass: true, leaked: 1, plannedRuns: 20, share: 0.05 });
    for (const extra of [{}, { design: DESIGNS.r3 }, { design: DESIGNS.r3, offPinGiven: false, mergeManifests: [] }]) {
      const gates = computeGates(records, filtered, GRADING, { ...opts, ...extra });
      expect(Object.keys(gates)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'failed', 'pass']);
      expect([gates.G1, gates.G3, gates.G4, gates.failed, gates.pass]).toEqual([HEAD_G1, HEAD_G3, HEAD_G4, [], true]);
    }
  });

  it('fail a record with PIP_CONSTRAINT in envKeys under round 3 and pass it under round 4, where another unlisted name still fails', () => {
    const records = [{ envKeys: ['PATH', 'PIP_CONSTRAINT'] }];
    expect(g1(records, {})).toMatchObject({ pass: false, envKeysOutside: { PIP_CONSTRAINT: 1 } });
    expect(g1(records, {}, { design: DESIGNS.r3 })).toMatchObject({ pass: false });
    expect(g1(records, {}, { design: DESIGNS.r4, ...OFF_PIN_BAR })).toMatchObject({ pass: true, envKeysOutside: {} });
    expect(g1([{ envKeys: ['PATH', 'UNLISTED'] }], {}, { design: DESIGNS.r4, ...OFF_PIN_BAR })).toMatchObject({ pass: false, envKeysOutside: { UNLISTED: 1 } });
  });
});

describe('the off-pin bar and the first-run count (prereg item 6, R67)', () => {
  /** Twenty planned positions of one run, so each position is exactly 5%. */
  const plan = Array.from({ length: 20 }, (_, position) => ({ sequence: 'q', seed: 1, arm: 'S2', position }));
  const voidAt = (position: number) => [{ sequence: 'q', seed: 1, arm: 'S2', position }];

  it('passes the voided positions, tails included, at exactly 5% of the planned positions and fails one more', () => {
    const [exact, over] = [offPinReach(voidAt(19), plan), offPinReach(voidAt(18), plan)];
    expect(exact).toEqual({ positions: 1, share: 0.05 });
    expect(g1([], {}, { design: DESIGNS.r4, offPinVoided: exact })).toMatchObject({ pass: true, offPinVoided: exact, offPinPass: true });
    expect(g1([], {}, { design: DESIGNS.r4, offPinVoided: over })).toMatchObject({ pass: false, offPinVoided: over, offPinPass: false });
  });

  it('turns on under round 4, with an off-pin file or with a merge manifest, and never otherwise', () => {
    const { filtered, records, opts } = round3();
    const bar = (extra: { offPinGiven?: boolean; mergeManifests?: ReturnType<typeof manifest>[] }) => computeGates(records, filtered, GRADING, { ...opts, ...extra }).G1;
    expect(bar({})).not.toHaveProperty('offPinVoided');
    expect(bar({ offPinGiven: true })).toMatchObject({ offPinVoided: filtered.offPinVoided, offPinPass: true });
    expect(bar({ mergeManifests: [manifest(1, 3)] })).toHaveProperty('offPinPass');
    const r4 = generate({ design: DESIGNS.r4, repos: 1 });
    const input = filteredInput(parseZ0Records(jsonl(r4.records), 'runs.jsonl').records, parsePlan(JSON.stringify(r4.plan), 'plan.json'), { design: DESIGNS.r4 }, { dropAbandoned: false });
    const gates = computeGates(input.records, input.filtered, GRADING, { ...opts, design: DESIGNS.r4 });
    expect(gates.G1).toMatchObject({ offPinVoided: { positions: 0, share: 0 }, offPinPass: true });
    expect(gates.G3).toHaveProperty('firstRun');
  });

  it('fails G1 through computeGates on a round 4 read whose off-pin voids pass 5% of its planned positions', () => {
    const r4 = generate({ design: DESIGNS.r4, repos: 1 });
    const { sequence } = r4.plan[0]!;
    const planned = new Set(r4.plan.map((c) => `${c.sequence}#${c.seed}@${c.position}`)).size;
    const within = Math.floor(planned / 20);
    const tail = [...new Set(r4.plan.filter((c) => c.sequence === sequence && c.seed === 1).map((c) => c.position))].sort((a, b) => a - b);
    expect(within).toBeGreaterThanOrEqual(1);
    expect(tail.length).toBeGreaterThan(within + 1);
    // A void at the k-th position from the end of its run reaches k positions in every arm.
    const reaching = (k: number) => {
      const position = tail[tail.length - k]!;
      const cell = r4.plan.find((c) => c.sequence === sequence && c.seed === 1 && c.position === position)!;
      const voids = [{ sequence, seed: 1, arm: cell.arm, position, sessionId: null, reason: 'no log', file: 'off-pin.json', index: 0 }];
      const input = filteredInput(parseZ0Records(jsonl(r4.records), 'runs.jsonl').records, parsePlan(JSON.stringify(r4.plan), 'plan.json'), { design: DESIGNS.r4, voids }, { dropAbandoned: false });
      return computeGates(input.records, input.filtered, GRADING, { iterations: 100, seed: 1, design: DESIGNS.r4 }).G1;
    };
    expect(reaching(within)).toMatchObject({ pass: true, offPinVoided: { positions: within }, offPinPass: true });
    expect(reaching(within + 1)).toMatchObject({ pass: false, offPinVoided: { positions: within + 1 }, offPinPass: false });
  });

  it('adds firstRun to G3, summed over the merge manifests, and only when the bar is on', () => {
    expect(g3(1, 20)).not.toHaveProperty('firstRun');
    expect(g3(1, 20, { leaked: 2, plannedRuns: 40 })).toMatchObject({ pass: true, leaked: 1, plannedRuns: 20, firstRun: { leaked: 2, plannedRuns: 40 } });
    const { filtered, records, opts } = round3();
    const gates = computeGates(records, filtered, GRADING, { ...opts, offPinGiven: true, mergeManifests: [manifest(1, 3), manifest(2, 6)] });
    expect(gates.G3).toEqual({ ...HEAD_G3, firstRun: { leaked: 3, plannedRuns: 9 } });
    expect(computeGates(records, filtered, GRADING, { ...opts, offPinGiven: true }).G3.firstRun).toEqual({ leaked: 0, plannedRuns: 0 });
  });
});
