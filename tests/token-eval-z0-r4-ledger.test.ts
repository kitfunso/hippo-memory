// Round 4 prereg item 12: the ledger prices records, attempts and warm-ups on hand-built out folders.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DESIGNS, OPUS_MODEL, SONNET_MODEL } from '../scripts/token-eval/arms.mjs';
import { ledgerTotal, runCli, spendByArm } from '../scripts/token-eval/z0-ledger.mjs';
import { SPEND_BASIS_SCHEMA } from '../scripts/token-eval/z0-records.mjs';
import { PRICES_BY_MODEL } from './fixtures/z0-gen.js';

// 100,000 output tokens: $2.50 at the Opus row and $1.25 at the Sonnet row of PRICES_BY_MODEL.
const [OPUS_100K, SONNET_100K] = [2.5, 1.25];
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'token-eval', 'z0-ledger.mjs');

interface Cell { seq: string; arm: string; seed: number }
interface Line { type: 'assistant'; message: { id: string; model?: string; usage: { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number } } }
interface Attempt { taskId: string; kind: 'session' | 'resume'; attempt: number; sessionId: string; logFile: string; sizesBefore: Record<string, number> | null }
interface Rec { sequence: string; arm: string; seed: number; taskId: string; tool: string; costUsd: number | null; sessionId: string; resumeSessionId: string | null }

const CELL: Cell = { seq: 'q1', arm: 'O1', seed: 1 };
let work: string;
const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const jsonl = <T>(rows: readonly T[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
const say = (id: string, model: string | undefined, out: number): Line => ({
  type: 'assistant', message: { id, model, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: out } },
});
const rel = (id: string) => `projects/-work/${id}.jsonl`;
const bytes = (rows: readonly Line[]) => Buffer.byteLength(jsonl(rows));
const record = (over: Partial<Rec> = {}, cell: Cell = CELL): Rec => ({
  sequence: cell.seq, arm: cell.arm, seed: cell.seed, taskId: 't1', tool: 'claude-code', costUsd: null, sessionId: 'S1', resumeSessionId: null, ...over,
});
const attempt = (over: Partial<Attempt>): Attempt => ({ taskId: 't1', kind: 'session', attempt: 1, sessionId: 'S1', logFile: 'x.requests.jsonl', sizesBefore: null, ...over });

const home = (out: string, cell: Cell = CELL) => path.join(out, 'runs', cell.seq, cell.arm, `seed${cell.seed}`, 'claude-config');
const transcript = (out: string, id: string, rows: readonly Line[], cell: Cell = CELL) => put(path.join(home(out, cell), rel(id)), jsonl(rows));
const subagent = (out: string, id: string, rows: readonly Line[]) => put(path.join(home(out), 'projects', '-work', id, 'subagents', 'agent-a1.jsonl'), jsonl(rows));
const attemptsFile = (out: string, rows: readonly Attempt[], cell: Cell = CELL, tail = '') => put(path.join(out, 'raw', cell.seq, cell.arm, `seed${cell.seed}`, 'attempts.jsonl'), jsonl(rows) + tail);
const runsFile = (out: string, rows: readonly Rec[], tail = '') => put(path.join(out, 'runs.jsonl'), jsonl(rows) + tail);
const cutoff = (out: string, name: string, meta: { taskId: string; attempt: number; sessionId: string; sizesBefore: Record<string, number> } | null, files: Record<string, readonly Line[]>, cell: Cell = CELL) => {
  const dir = path.join(out, 'cutoffs', cell.seq, cell.arm, `seed${cell.seed}`, name);
  if (meta !== null) put(path.join(dir, 'attempt.json'), JSON.stringify(meta));
  for (const [id, rows] of Object.entries(files)) put(path.join(dir, 'claude-config', rel(id)), jsonl(rows));
};
const warmup = (out: string, model: string, rows: readonly Line[], result: { status: number; total_cost_usd: number | null } | null) => {
  put(path.join(out, 'warmups', `${model}.start.json`), JSON.stringify({ model, configDir: path.join(out, 'warmup', model) }));
  put(path.join(out, 'warmup', model, 'projects', '-w', 'w.jsonl'), jsonl(rows));
  if (result !== null) put(path.join(out, 'warmups', `${model}.json`), JSON.stringify({ model, ...result, result: null }));
};
const folder = (name: string) => path.join(work, name);
const pricesPath = () => {
  const file = path.join(work, 'prices.json');
  put(file, JSON.stringify(PRICES_BY_MODEL));
  return file;
};
const cli = (runs: readonly string[], ...extra: string[]) => runCli(['--prices', pricesPath(), '--design', 'r4', ...runs.flatMap((r) => ['--run', r]), ...extra], work);
const lastLine = (r: { stdout: string }) => r.stdout.trimEnd().split('\n').at(-1);

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-r4-ledger-'));
});

describe('the pricing half: records, attempts and message ids', () => {
  it('adds a record\'s costUsd and a cut-off session attempt\'s messages once, and nothing for the attempt the record covers', () => {
    const out = folder('a');
    runsFile(out, [record({ costUsd: 4, sessionId: 'S2' })]);
    attemptsFile(out, [attempt({ attempt: 1, sessionId: 'S1' }), attempt({ attempt: 2, sessionId: 'S2' })]);
    // A streamed message repeats its id with a growing count; the largest value is the one paid.
    transcript(out, 'S1', [say('a1', OPUS_MODEL, 50_000), say('a1', OPUS_MODEL, 100_000)]);
    transcript(out, 'S2', [say('b1', OPUS_MODEL, 100_000)]);
    const r = cli([out]);
    expect([r.code, lastLine(r)]).toEqual([0, `LEDGER ${(4 + OPUS_100K).toFixed(2)}`]);
  });

  it('adds the messages of a cut-off resume copy once per id, each at its own model row, and not the head its record covers', () => {
    const out = folder('a');
    const head = [say('h1', OPUS_MODEL, 100_000)];
    const tail = [say('c1', SONNET_MODEL, 100_000), say('c1', SONNET_MODEL, 100_000), say('c2', OPUS_MODEL, 200_000)];
    const sizesBefore = { [rel('S1')]: bytes(head) };
    runsFile(out, [record({ costUsd: 10, resumeSessionId: 'S1' })]);
    attemptsFile(out, [attempt({}), attempt({ kind: 'resume', attempt: 1, sizesBefore }), attempt({ kind: 'resume', attempt: 2, sizesBefore })]);
    transcript(out, 'S1', head);
    cutoff(out, '1-1', { taskId: 't1', attempt: 1, sessionId: 'S1', sizesBefore }, { S1: [...head, ...tail] });
    const r = cli([out]);
    expect(lastLine(r)).toBe(`LEDGER ${(10 + SONNET_100K + 2 * OPUS_100K).toFixed(2)}`);
  });

  it('prices a cut-off copy that has no attempt.json, since a kill can land between the copy and that file', () => {
    const out = folder('a');
    runsFile(out, [record({ costUsd: 4 })]);
    attemptsFile(out, [attempt({})]);
    transcript(out, 'S1', [say('h1', OPUS_MODEL, 100_000)]);
    cutoff(out, '1-1', null, { S1: [say('h1', OPUS_MODEL, 100_000), say('c1', SONNET_MODEL, 100_000)] });
    expect(lastLine(cli([out]))).toBe(`LEDGER ${(4 + SONNET_100K).toFixed(2)}`);
  });

  it('prices a record with a null costUsd from its transcripts at each message\'s own model', () => {
    const out = folder('a');
    runsFile(out, [record()]);
    attemptsFile(out, [attempt({})]);
    transcript(out, 'S1', [say('x1', OPUS_MODEL, 100_000), say('x2', SONNET_MODEL, 100_000)]);
    expect(lastLine(cli([out]))).toBe(`LEDGER ${(OPUS_100K + SONNET_100K).toFixed(2)}`);
  });

  it('stops with exit 3 on a message whose model has no row, naming the transcript file, the id and the model', () => {
    const out = folder('a');
    runsFile(out, [record()]);
    attemptsFile(out, [attempt({})]);
    transcript(out, 'S1', [say('y1', 'claude-haiku-9', 100_000)]);
    const r = cli([out]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(r.stderr).toMatch(/^STOP: .*S1\.jsonl.*y1.*claude-haiku-9.*prices\.json/);
  });

  it('stops with exit 3 on a message with no model, naming the file and the id', () => {
    const out = folder('a');
    runsFile(out, [record()]);
    attemptsFile(out, [attempt({})]);
    transcript(out, 'S1', [say('y2', undefined, 100_000)]);
    const r = cli([out]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^STOP: .*S1\.jsonl.*y2.*no model/);
  });

  it('counts two copies of one message id once, across a main file and a subagent file', () => {
    const out = folder('a');
    runsFile(out, [record()]);
    attemptsFile(out, [attempt({})]);
    transcript(out, 'S1', [say('d1', OPUS_MODEL, 100_000)]);
    subagent(out, 'S1', [say('d1', OPUS_MODEL, 100_000)]);
    expect(lastLine(cli([out]))).toBe(`LEDGER ${OPUS_100K.toFixed(2)}`);
  });

  it('adds a warm-up file\'s total_cost_usd once for each model and out folder, and prices a start file with no result from its transcripts', () => {
    const [a, b] = [folder('a'), folder('b')];
    for (const out of [a, b]) {
      runsFile(out, []);
      put(path.join(out, 'warmups', `${OPUS_MODEL}.start.json`), JSON.stringify({ model: OPUS_MODEL, configDir: path.join(out, 'warmup', OPUS_MODEL) }));
      put(path.join(out, 'warmups', `${OPUS_MODEL}.json`), JSON.stringify({ model: OPUS_MODEL, status: 0, total_cost_usd: 0.5, result: 'ok' }));
      // The result is in, so these messages are never priced.
      put(path.join(out, 'warmup', OPUS_MODEL, 'projects', '-w', 'w.jsonl'), jsonl([say('w-opus', OPUS_MODEL, 100_000)]));
    }
    put(path.join(a, 'warmups', `${SONNET_MODEL}.start.json`), JSON.stringify({ model: SONNET_MODEL, configDir: path.join(a, 'warmup', SONNET_MODEL) }));
    put(path.join(a, 'warmup', SONNET_MODEL, 'projects', '-w', 'w.jsonl'), jsonl([say('w-sonnet', SONNET_MODEL, 100_000)]));
    expect(lastLine(cli([a]))).toBe(`LEDGER ${(0.5 + SONNET_100K).toFixed(2)}`);
    expect(lastLine(cli([a, b]))).toBe(`LEDGER ${(2 * 0.5 + SONNET_100K).toFixed(2)}`);
  });

  it('prices a warm-up from its transcripts when its result file holds no numeric total_cost_usd', () => {
    const out = folder('a');
    runsFile(out, []);
    put(path.join(out, 'warmups', `${OPUS_MODEL}.start.json`), JSON.stringify({ model: OPUS_MODEL, configDir: path.join(out, 'warmup', OPUS_MODEL) }));
    put(path.join(out, 'warmups', `${OPUS_MODEL}.json`), JSON.stringify({ model: OPUS_MODEL, status: 1, total_cost_usd: null, result: null }));
    put(path.join(out, 'warmup', OPUS_MODEL, 'projects', '-w', 'w.jsonl'), jsonl([say('w1', OPUS_MODEL, 100_000)]));
    expect(lastLine(cli([out]))).toBe(`LEDGER ${OPUS_100K.toFixed(2)}`);
  });

  it('prices a task from its transcripts when runs.jsonl ends in half a record line, as with no record', () => {
    const out = folder('a');
    const whole = record({ costUsd: 4 });
    const half = JSON.stringify(record({ taskId: 't2', costUsd: 9, sessionId: 'S2' })).slice(0, 60);
    runsFile(out, [whole], half);
    attemptsFile(out, [attempt({}), attempt({ taskId: 't2', sessionId: 'S2' })]);
    transcript(out, 'S1', [say('a1', OPUS_MODEL, 100_000)]);
    transcript(out, 'S2', [say('b1', OPUS_MODEL, 100_000)]);
    expect(lastLine(cli([out]))).toBe(`LEDGER ${(4 + OPUS_100K).toFixed(2)}`);
  });

  it('skips a torn last line of attempts.jsonl without a stop, and the sweep still prices the session that line names', () => {
    const out = folder('a');
    runsFile(out, [record()]);
    const torn = JSON.stringify(attempt({ taskId: 't2', sessionId: 'S2' })).slice(0, 50);
    attemptsFile(out, [attempt({})], CELL, torn);
    transcript(out, 'S1', [say('a1', OPUS_MODEL, 100_000)]);
    transcript(out, 'S2', [say('b1', OPUS_MODEL, 100_000)]);
    const r = cli([out]);
    expect([r.code, lastLine(r)]).toEqual([0, `LEDGER ${(2 * OPUS_100K).toFixed(2)}`]);
  });

  it('stops with exit 1 on a line that is not JSON and is not the last one', () => {
    const out = folder('a');
    put(path.join(out, 'runs.jsonl'), `${JSON.stringify(record({ costUsd: 1 }))}\nnot json\n${JSON.stringify(record({ costUsd: 2 }))}\n`);
    const r = cli([out]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/runs\.jsonl:2/);
  });

  it('covers a record\'s last resume attempt only when its resumeSessionId is not null', () => {
    const [covered, open] = [folder('covered'), folder('open')];
    const head = [say('h1', OPUS_MODEL, 100_000)];
    const sizesBefore = { [rel('S1')]: bytes(head) };
    for (const [out, resumeSessionId] of [[covered, 'S1'], [open, null]] as const) {
      runsFile(out, [record({ costUsd: 6, resumeSessionId })]);
      attemptsFile(out, [attempt({}), attempt({ kind: 'resume', attempt: 1, sizesBefore })]);
      transcript(out, 'S1', [...head, say('r1', SONNET_MODEL, 100_000)]);
    }
    expect(lastLine(cli([covered]))).toBe('LEDGER 6.00');
    // No resume result, so its messages past sizesBefore are priced.
    expect(lastLine(cli([open]))).toBe(`LEDGER ${(6 + SONNET_100K).toFixed(2)}`);
  });

  it('prices a live forked resume that no record names in full, each id once [S2C-R1 a]', () => {
    const out = folder('a');
    const head = [say('h1', OPUS_MODEL, 100_000)];
    const sizesBefore = { [rel('S1')]: bytes(head) };
    runsFile(out, []);
    attemptsFile(out, [attempt({}), attempt({ kind: 'resume', attempt: 1, sizesBefore })]);
    transcript(out, 'S1', [...head, say('r1', SONNET_MODEL, 100_000)]);
    transcript(out, 'F1', [...head, say('r2', SONNET_MODEL, 100_000)]);
    expect(lastLine(cli([out]))).toBe(`LEDGER ${(OPUS_100K + 2 * SONNET_100K).toFixed(2)}`);
  });

  it('gives a folder with its last record line torn the LEDGER it has whole, with a forked resume [S2C-R1 b]', () => {
    const [whole, torn] = [folder('whole'), folder('torn')];
    const head = [say('h1', OPUS_MODEL, 100_000)];
    const sizesBefore = { [rel('S1')]: bytes(head) };
    const rec = record({ resumeSessionId: 'F1' });
    runsFile(whole, [rec]);
    put(path.join(torn, 'runs.jsonl'), JSON.stringify(rec).slice(0, 60));
    for (const out of [whole, torn]) {
      attemptsFile(out, [attempt({}), attempt({ kind: 'resume', attempt: 1, sizesBefore })]);
      transcript(out, 'S1', [...head, say('r1', SONNET_MODEL, 100_000)]);
      transcript(out, 'F1', [...head, say('r2', SONNET_MODEL, 100_000)]);
    }
    const expected = `LEDGER ${(OPUS_100K + 2 * SONNET_100K).toFixed(2)}`;
    expect([lastLine(cli([whole])), lastLine(cli([torn]))]).toEqual([expected, expected]);
  });

  it('counts a subagent file a resume made next to a covered session, since the session share ends at sizesBefore [S2C-R1 c]', () => {
    const out = folder('a');
    const head = [say('h1', OPUS_MODEL, 100_000)];
    const sizesBefore = { [rel('S1')]: bytes(head) };
    // Not covered: the record has no resumeSessionId, so the resume's work is no part of its figure.
    runsFile(out, [record({ costUsd: 6 })]);
    attemptsFile(out, [attempt({}), attempt({ kind: 'resume', attempt: 1, sizesBefore })]);
    transcript(out, 'S1', [...head, say('r1', SONNET_MODEL, 100_000)]);
    subagent(out, 'S1', [say('sub1', OPUS_MODEL, 100_000)]);
    expect(lastLine(cli([out]))).toBe(`LEDGER ${(6 + SONNET_100K + OPUS_100K).toFixed(2)}`);
  });

  it('keeps the file a covered forked resume wrote out of the sweep: the record that names it pays for it', () => {
    const out = folder('a');
    const head = [say('h1', OPUS_MODEL, 100_000)];
    const sizesBefore = { [rel('S1')]: bytes(head) };
    runsFile(out, [record({ costUsd: 10, resumeSessionId: 'F1' })]);
    attemptsFile(out, [attempt({}), attempt({ kind: 'resume', attempt: 1, sizesBefore })]);
    transcript(out, 'S1', head);
    transcript(out, 'F1', [...head, say('r2', SONNET_MODEL, 100_000)]);
    expect(lastLine(cli([out]))).toBe('LEDGER 10.00');
  });

  it('keeps a covered resume\'s subagent file out of the sweep: the record pays for it', () => {
    const out = folder('a');
    const head = [say('h1', OPUS_MODEL, 100_000)];
    const sizesBefore = { [rel('S1')]: bytes(head) };
    runsFile(out, [record({ costUsd: 6, resumeSessionId: 'S1' })]);
    attemptsFile(out, [attempt({}), attempt({ kind: 'resume', attempt: 1, sizesBefore })]);
    transcript(out, 'S1', [...head, say('r1', SONNET_MODEL, 100_000)]);
    subagent(out, 'S1', [say('sub1', OPUS_MODEL, 100_000)]);
    expect(lastLine(cli([out]))).toBe('LEDGER 6.00');
  });

  it('prices no message whose four usage counts are zero, so a synthetic message needs no row', () => {
    const out = folder('a');
    runsFile(out, [record()]);
    attemptsFile(out, [attempt({})]);
    transcript(out, 'S1', [say('z1', '<synthetic>', 0), say('z2', OPUS_MODEL, 100_000)]);
    const r = cli([out]);
    expect([r.code, lastLine(r)]).toEqual([0, `LEDGER ${OPUS_100K.toFixed(2)}`]);
  });
});

describe('the fork case', () => {
  it('adds only the new ids when a cut-off resume\'s new file repeats session 1\'s ids and the record covers session 1', () => {
    const out = folder('a');
    const session = [say('s1a', OPUS_MODEL, 100_000), say('s1b', OPUS_MODEL, 100_000)];
    const sizesBefore = { [rel('S1')]: bytes(session) };
    runsFile(out, [record({ costUsd: 3 })]);
    attemptsFile(out, [attempt({}), attempt({ kind: 'resume', attempt: 1, sizesBefore })]);
    transcript(out, 'S1', session);
    cutoff(out, '1-1', { taskId: 't1', attempt: 1, sessionId: 'S1', sizesBefore }, { S1: session, F1: [...session, say('n1', OPUS_MODEL, 100_000)] });
    expect(lastLine(cli([out]))).toBe(`LEDGER ${(3 + OPUS_100K).toFixed(2)}`);
  });
});

describe('arms, pilot folders and the spend basis', () => {
  const build = (name: string, rows: readonly Rec[]) => {
    const out = folder(name);
    runsFile(out, rows);
    return out;
  };

  it('adds a --pilot-run folder to LEDGER and not to spendByArm, which runs only over --run folders', () => {
    const run = build('run', [record({ costUsd: 4 })]);
    const pilot = build('pilot', [record({ arm: 'S1', costUsd: 3 }, { ...CELL, arm: 'S1' })]);
    const r = cli([run], '--pilot-run', pilot, '--unblind');
    expect(r.stdout.trimEnd().split('\n')).toEqual(['spend O1 4.00', 'spend S0 0.00', 'spend S1 0.00', 'spend S2 0.00', 'spend S4 0.00', 'spend S5 0.00', 'LEDGER 7.00']);
    const [prices, design] = [PRICES_BY_MODEL, DESIGNS.r4];
    expect(ledgerTotal({ runs: [run], pilotRuns: [pilot], prices, design })).toBe(7);
    expect(spendByArm({ runs: [run], prices, design })).toEqual({ O1: 4, S0: 0, S1: 0, S2: 0, S4: 0, S5: 0 });
  });

  it('prints no arm and writes no file without --unblind, and refuses --spend-basis-out then with exit 1', () => {
    const run = build('run', [record({ costUsd: 4 })]);
    const r = cli([run]);
    expect([r.code, r.stdout, r.stderr]).toEqual([0, 'LEDGER 4.00\n', '']);
    const basis = path.join(work, 'basis.json');
    const refused = cli([run], '--spend-basis-out', basis);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/--spend-basis-out needs --unblind/);
    expect(fs.existsSync(basis)).toBe(false);
  });

  it('spends a cut-off attempt\'s messages under its arm and leaves warm-ups out of spendByArm', () => {
    const out = folder('run');
    runsFile(out, [record({ costUsd: 4 }), record({ taskId: 't2', sessionId: 'S3' })]);
    attemptsFile(out, [attempt({}), attempt({ taskId: 't2', sessionId: 'S3' })]);
    transcript(out, 'S3', [say('p1', OPUS_MODEL, 100_000)]);
    put(path.join(out, 'warmups', `${OPUS_MODEL}.json`), JSON.stringify({ model: OPUS_MODEL, status: 0, total_cost_usd: 0.5, result: 'ok' }));
    const [prices, design] = [PRICES_BY_MODEL, DESIGNS.r4];
    expect(ledgerTotal({ runs: [out], prices, design })).toBeCloseTo(4 + OPUS_100K + 0.5, 9);
    expect(spendByArm({ runs: [out], prices, design }).O1).toBeCloseTo(4 + OPUS_100K, 9);
  });

  it('writes a spend basis whose rows sum to basisByArm, each row holding every arm, with the mean over claude-code records', () => {
    const [q1o, q1s, q2o] = [CELL, { ...CELL, arm: 'S1' }, { ...CELL, seq: 'q2' }];
    const run = build('run', [record({ costUsd: 4 }, q1o), record({ costUsd: 3 }, q1s), record({ costUsd: 2 }, q2o), record({ taskId: 't9', tool: 'codex', costUsd: 100 }, q2o)]);
    const basis = path.join(work, 'basis.json');
    expect(cli([run], '--unblind', '--spend-basis-out', basis).code).toBe(0);
    const body = JSON.parse(fs.readFileSync(basis, 'utf8'));
    expect(body.schema).toBe(SPEND_BASIS_SCHEMA);
    expect(body.basisByArm).toEqual({ O1: 106, S1: 3 });
    expect(body.bySequence).toEqual({ q1: { O1: 4, S1: 3 }, q2: { O1: 102, S1: 0 } });
    for (const arm of Object.keys(body.basisByArm)) {
      expect(Object.values<Record<string, number>>(body.bySequence).reduce((sum, row) => sum + row[arm]!, 0)).toBe(body.basisByArm[arm]);
    }
    expect(body.meanPerRecord).toBe(3);
  });

  it('attributes a swept id to the arm of the cell folder it lives in, under runs/ and under cutoffs/', () => {
    const out = folder('run');
    const [s1, s2] = [{ ...CELL, arm: 'S1' }, { ...CELL, arm: 'S2' }];
    runsFile(out, []);
    transcript(out, 'L1', [say('l1', OPUS_MODEL, 100_000)], s1);
    cutoff(out, '1-1', null, { L2: [say('l2', SONNET_MODEL, 100_000)] }, s2);
    const [prices, design] = [PRICES_BY_MODEL, DESIGNS.r4];
    expect(spendByArm({ runs: [out], prices, design })).toEqual({ O1: 0, S0: 0, S1: OPUS_100K, S2: SONNET_100K, S4: 0, S5: 0 });
  });

  it('prices the warm-ups of a folder with no record, no plan and an ABANDONED marker, as --run and as --pilot-run', () => {
    const [run, killed, marker] = [folder('run'), folder('killed'), folder('marker')];
    runsFile(run, [record({ costUsd: 4 })]);
    warmup(killed, OPUS_MODEL, [say('w1', OPUS_MODEL, 100_000)], null);
    put(path.join(killed, 'ABANDONED'), 'warm-up for claude-opus-5-5 failed (exit 1)\nlast completed: none\n');
    put(path.join(marker, 'ABANDONED'), 'stopped\n');
    expect(lastLine(cli([killed, run]))).toBe(`LEDGER ${(4 + OPUS_100K).toFixed(2)}`);
    expect(lastLine(cli([run], '--pilot-run', killed))).toBe(`LEDGER ${(4 + OPUS_100K).toFixed(2)}`);
    expect(lastLine(cli([run], '--pilot-run', marker))).toBe('LEDGER 4.00');
    expect(spendByArm({ runs: [run, killed], prices: PRICES_BY_MODEL, design: DESIGNS.r4 }).O1).toBe(4);
  });

  it('stops with exit 1 on a record whose arm is no arm of the design', () => {
    const run = build('run', [record({ arm: 'A1', costUsd: 1 })]);
    const r = cli([run], '--unblind');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/arm A1 is not an arm of design r4/);
  });
});

describe('--design r3', () => {
  const r3 = (arm: string, tool: string, costUsd: number | null) => record({ arm, tool, costUsd, taskId: `t-${arm}` }, { ...CELL, arm });

  it('refuses a folder that holds a warmups folder or an attempts.jsonl, as --run or --pilot-run, since round 3 writes neither', () => {
    const [run, warm, attempts] = [folder('run'), folder('warm'), folder('attempts')];
    runsFile(run, [r3('A1', 'claude-code', 1)]);
    warmup(warm, OPUS_MODEL, [say('w1', OPUS_MODEL, 100_000)], null);
    runsFile(attempts, [r3('A1', 'claude-code', 1)]);
    attemptsFile(attempts, [attempt({})], { ...CELL, arm: 'A1' });
    const prices = pricesPath();
    for (const [flag, bad] of [['--run', warm], ['--pilot-run', warm], ['--run', attempts], ['--pilot-run', attempts]]) {
      const argv = flag === '--run' ? ['--prices', prices, '--run', bad] : ['--prices', prices, '--run', run, flag, bad];
      const r = runCli(argv, work);
      expect([r.code, r.stdout], `${flag} ${bad}`).toEqual([1, '']);
      expect(r.stderr).toMatch(/round 3 never writes.*--design r4/);
    }
    expect(runCli(['--prices', prices, '--run', run], work).code).toBe(0);
  });

  it('sums numeric costUsd only: it prices no transcript, so a message with no row is no stop', () => {
    const out = folder('a');
    runsFile(out, [r3('A1', 'claude-code', 1), r3('A2', 'claude-code', 2), r3('X2', 'codex', 4), r3('A0', 'claude-code', null)]);
    transcript(out, 'S1', [say('u1', 'claude-haiku-9', 100_000)], { ...CELL, arm: 'A0' });
    const basis = path.join(work, 'basis.json');
    const r = runCli(['--prices', pricesPath(), '--run', out, '--design', 'r3', '--unblind', '--spend-basis-out', basis], work);
    expect(r.code).toBe(0);
    const spent = new Map([['A1', 1], ['A2', 2], ['X2', 4]]);
    expect(r.stdout.trimEnd().split('\n')).toEqual([...DESIGNS.r3.arms.map((a: string) => `spend ${a} ${(spent.get(a) ?? 0).toFixed(2)}`), 'LEDGER 7.00']);
    const body = JSON.parse(fs.readFileSync(basis, 'utf8'));
    expect(body.basisByArm).toEqual({ A1: 1, A2: 2, X2: 4 });
    expect(body.meanPerRecord).toBe(1.5);
  });
});

describe('the command line', () => {
  it('exits 1 with the usage on an unknown flag, no --run, no --prices, a missing folder and a folder with no run files', () => {
    const [empty, missing] = [folder('empty'), folder('missing')];
    fs.mkdirSync(empty);
    const prices = pricesPath();
    const cases = [['--prices', prices, '--run', empty, '--bogus', 'x'], ['--prices', prices], ['--run', empty], ['--prices', prices, '--run', missing], ['--prices', prices, '--run', empty]];
    for (const argv of cases) {
      const r = runCli(argv, work);
      expect([r.code, r.stdout], argv.join(' ')).toEqual([1, '']);
      expect(r.stderr).toMatch(/usage: z0-ledger\.mjs/);
    }
  });

  it('exits 1 naming a folder given twice, by either flag and however its path is spelled', () => {
    const [a, b] = [folder('a'), folder('b')];
    runsFile(a, [record({ costUsd: 1 })]);
    runsFile(b, [record({ costUsd: 2 })]);
    const prices = pricesPath();
    const again = path.join(a, '..', 'a');
    for (const argv of [['--run', a, '--run', a], ['--run', a, '--pilot-run', again], ['--run', b, a, '--pilot-run', b]]) {
      const r = runCli(['--prices', prices, '--design', 'r4', ...argv], work);
      expect([r.code, r.stdout], argv.join(' ')).toEqual([1, '']);
      expect(r.stderr).toMatch(/is given twice/);
    }
    expect(runCli(['--prices', prices, '--design', 'r4', '--run', a, '--pilot-run', b], work).code).toBe(0);
  });

  it('takes several folders after one --run, and runs as a script that prints LEDGER last and exits 3 on a stop', () => {
    const [a, b] = [folder('a'), folder('b')];
    runsFile(a, [record({ costUsd: 1 })]);
    runsFile(b, [record({ costUsd: 2 })]);
    const run = spawnSync(process.execPath, [SCRIPT, '--prices', pricesPath(), '--design', 'r4', '--run', a, b], { encoding: 'utf8' });
    expect([run.status, run.stdout]).toEqual([0, 'LEDGER 3.00\n']);
    attemptsFile(a, [attempt({ taskId: 't2', sessionId: 'S9' })]);
    transcript(a, 'S9', [say('y1', 'claude-haiku-9', 1)]);
    const stop = spawnSync(process.execPath, [SCRIPT, '--prices', pricesPath(), '--design', 'r4', '--run', a], { encoding: 'utf8' });
    expect(stop.status).toBe(3);
    expect(stop.stderr).toMatch(/^STOP: /);
  });
});
