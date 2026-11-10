// Round 4 prereg item 6: off-pin voids, and the one path from parsed inputs to filtered records that every reader takes.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { DESIGNS } from '../scripts/token-eval/arms.mjs';
import { FILTER_KEYS, filterOpts, filteredInput, readVoids } from '../scripts/token-eval/z0-filters.mjs';
import { parseZ0Records } from '../scripts/token-eval/z0-records.mjs';
import { GRADING, generate, jsonl, type Generated, type PlanCell, type Z0Record } from './fixtures/z0-gen.js';

const BASE = generate();
const fresh = (): Generated => structuredClone(BASE);
const parse = (recs: readonly Z0Record[]) => parseZ0Records(jsonl(recs), 'runs.jsonl').records;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'z0-r4-filters-'));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
type OffPinVoid = { sequence: string; seed: number; arm: string; position: number; sessionId: string | null; reason: string };
// A void with one field broken, so its values are wider than OffPinVoid's.
type LooseVoid = Record<string, string | number | null | undefined>;
const VOID: OffPinVoid = { sequence: 'rn-repo2', seed: 2, arm: 'A1', position: 9, sessionId: null, reason: 'cut-off attempt' };
const inRun = (r: { sequence: string; seed: number }, sequence: string, seed: number) => r.sequence === sequence && r.seed === seed;

interface RunsEntry { dir: string; file: string; sha256: string }

function offPinFile(dir: string, voids: LooseVoid[], runs: RunsEntry[] = [], schema = 'z0-offpin/1', name = 'off-pin.json'): string {
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ schema, runs, voids }));
  return name;
}

describe('readVoids', () => {
  it('tags each void with its file and index and reads the voids of a file whose runs entry is loaded', () => {
    const dir = tmp();
    const runsText = jsonl(BASE.records);
    const file = offPinFile(dir, [VOID, { ...VOID, seed: 1, position: 3, sessionId: 'cut-off-1' }], [{ dir: 'r1', file: 'runs.jsonl', sha256: sha(runsText) }]);
    const voids = readVoids(file, { cwd: dir, runHashes: [sha(runsText)] });
    expect(voids.map((v: { file: string; index: number }) => [v.file, v.index])).toEqual([[file, 0], [file, 1]]);
    expect(voids[1]).toMatchObject({ sequence: 'rn-repo2', seed: 1, position: 3, sessionId: 'cut-off-1' });
  });

  it('stops on another schema, a file that is no JSON, and a void with a missing or bad field, naming the index', () => {
    const dir = tmp();
    expect(() => readVoids(offPinFile(dir, [VOID], [], 'z0-offpin/2'), { cwd: dir })).toThrow(/off-pin\.json: schema must be "z0-offpin\/1"/);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ nope');
    expect(() => readVoids('bad.json', { cwd: dir })).toThrow(/bad\.json: not JSON/);
    for (const field of ['sequence', 'seed', 'arm', 'position', 'reason']) {
      const void1 = { ...VOID, [field]: undefined };
      expect(() => readVoids(offPinFile(dir, [VOID, void1]), { cwd: dir }), field).toThrow(new RegExp(`off-pin\\.json void 1: ${field} is missing or not valid`));
    }
    expect(() => readVoids(offPinFile(dir, [{ ...VOID, sessionId: 7 }]), { cwd: dir })).toThrow(/void 0: sessionId is missing or not valid/);
  });

  it('stops on a runs entry the read does not load, naming the file and the entry', () => {
    const dir = tmp();
    const leaked = { dir: 'r1', file: 'leaked-runs.jsonl', sha256: sha('leaked') };
    const file = offPinFile(dir, [VOID], [leaked]);
    expect(() => readVoids(file, { cwd: dir, runHashes: [sha('merged')] })).toThrow(/off-pin\.json: runs\[0\] \(leaked-runs\.jsonl, sha256 [0-9a-f]{64}\) is not a runs file this read loads/);
    expect(readVoids(file, { cwd: dir })).toHaveLength(1);
  });
});

describe('off-pin voids in filteredInput', () => {
  const voidsOf = (...extra: LooseVoid[]) => {
    const dir = tmp();
    return readVoids(offPinFile(dir, [VOID, ...extra]), { cwd: dir });
  };

  it('stops on a void at a cell no plan file holds, naming its file and index', () => {
    const { records, plan } = fresh();
    const voids = voidsOf({ ...VOID, position: 99 });
    expect(() => filteredInput(parse(records), plan, { voids }, { dropAbandoned: false })).toThrow(/off-pin\.json void 1: cell .* is not in any plan file/);
  });

  it('voids its position and the rest of its (sequence, seed) in every arm, whatever the session id says', () => {
    const { records, plan } = fresh();
    const scoredWith = (sessionId: string | null) => {
      const dir = tmp();
      const voids = readVoids(offPinFile(dir, [{ ...VOID, sessionId }]), { cwd: dir });
      return filteredInput(parse(records), plan, { voids }, { dropAbandoned: false }).filtered;
    };
    const none = filteredInput(parse(records), plan, {}, { dropAbandoned: false }).filtered;
    const [nullId, unmatched] = [scoredWith(null), scoredWith('cut-off-attempt-on-no-record')];
    expect(unmatched.scored).toEqual(nullId.scored);
    const gone = (r: Z0Record) => inRun(r, 'rn-repo2', 2) && r.position >= 9;
    expect(nullId.scored.some(gone)).toBe(false);
    expect(nullId.scored.filter((r: Z0Record) => inRun(r, 'rn-repo2', 2) && r.position === 8).map((r: Z0Record) => r.arm).sort()).toEqual(['A0', 'A1', 'A2', 'A4', 'A5']);
    expect(none.scored.length - nullId.scored.length).toBe(records.filter(gone).length);
    expect(nullId.offPinVoided).toEqual({ positions: 9, share: 9 / new Set(plan.map((c: PlanCell) => `${c.sequence}|${c.seed}|${c.position}`)).size });
    expect(none.offPinVoided).toEqual({ positions: 0, share: 0 });
  });

  it('counts an abandoned run\'s voided positions in offPinVoided, whether or not the run is left out of the filter', () => {
    const { records, plan } = fresh();
    const cut = records.filter((r) => !(inRun(r, 'rn-repo5', 2) && r.position >= 8));
    const dir = tmp();
    const voids = readVoids(offPinFile(dir, [{ ...VOID, sequence: 'rn-repo5', position: 12 }]), { cwd: dir });
    const [withDrop, noDrop] = [true, false].map((dropAbandoned) => filteredInput(parse(cut), plan, { voids }, { dropAbandoned }));
    expect(noDrop!.filtered.offPinVoided.positions).toBe(6);
    expect(withDrop!.filtered.offPinVoided).toEqual(noDrop!.filtered.offPinVoided);
    expect([...noDrop!.abandoned.values()]).toEqual(['rn-repo5 seed 2']);
    expect([withDrop!.filtered.counts.A1.abandoned, noDrop!.filtered.counts.A1.abandoned]).toEqual([0, 10]);
    expect(withDrop!.filtered.scored.some((r: Z0Record) => inRun(r, 'rn-repo5', 2))).toBe(false);
    // The returned records and plan are whole either way, so a count taken from them does not move.
    expect([withDrop!.records.length, withDrop!.planCells.length]).toEqual([noDrop!.records.length, noDrop!.planCells.length]);
    expect(withDrop!.records).toHaveLength(cut.length);
  });

  it('applies each filter input through the one path: grading, drop list, hook voids, voids and the design', () => {
    expect(FILTER_KEYS).toEqual(['grading', 'dropList', 'voids', 'design']);
    const { records, plan } = fresh();
    const run = (opts: Parameters<typeof filteredInput>[2]) => filteredInput(parse(records), plan, opts, { dropAbandoned: false }).filtered;
    const lesson = 'rn-repo1-f1-L1';
    expect(run({ grading: { ...GRADING, flippedLessons: [lesson] } }).scored.some((r: Z0Record) => r.lessons.some((l) => l.lessonId === lesson))).toBe(false);
    expect(run({ dropList: { droppedLessons: [], droppedFamilies: ['rn-repo1-f1'] } }).scored.some((r: Z0Record) => r.familyId === 'rn-repo1-f1')).toBe(false);
    const hooked = run({ dropList: { droppedLessons: [], droppedFamilies: [], hookVoids: [{ sequence: 'rn-repo1', seed: 1, position: 4 }] } });
    expect(hooked.hookVoided.positions).toBe(1);
    expect(hooked.scored.some((r: Z0Record) => inRun(r, 'rn-repo1', 1) && r.position === 4)).toBe(false);
    expect(run({ voids: voidsOf() }).offPinVoided.positions).toBe(9);
    expect(run({ design: DESIGNS.r3 }).scored).toEqual(run({}).scored);
  });

  it('stops on a record or plan cell the design does not hold, naming the design', () => {
    const { records, plan } = fresh();
    expect(() => filteredInput(parse(records), plan, { design: DESIGNS.r4 }, { dropAbandoned: false })).toThrow(/record arm A0 is not in design r4; pass the design that holds it/);
    const onlyA = records.filter((r) => r.arm.startsWith('A'));
    expect(() => filteredInput(parse(onlyA), plan, { design: DESIGNS['r4-on-r3'] }, { dropAbandoned: false })).toThrow(/plan cell arm X1 is not in design r4-on-r3; pass the design that holds it/);
  });

});

describe('filterOpts', () => {
  it('passes the inputs given and adds the design\'s dropped families once, keeping a drop list\'s own', () => {
    expect(filterOpts({})).toEqual({});
    expect(filterOpts({ grading: null, dropList: undefined, inputs: 1 })).toEqual({ grading: null });
    const r4r3 = { design: DESIGNS['r4-on-r3'], dropList: { droppedLessons: ['L'], droppedFamilies: ['x-f1', 'hu3-f2'] } };
    const once = filterOpts(r4r3);
    expect(once.dropList).toEqual({ droppedLessons: ['L'], droppedFamilies: ['x-f1', 'hu3-f2', 'q133-f2', 'q14-f3', 'q256-f1'] });
    expect(filterOpts(once).dropList).toEqual(once.dropList);
    expect(filterOpts({ design: DESIGNS['r4-on-r3'] }).dropList).toEqual({ droppedLessons: [], droppedFamilies: ['hu3-f2', 'q133-f2', 'q14-f3', 'q256-f1'] });
    expect(filterOpts({ design: DESIGNS.r3 })).toEqual({ design: DESIGNS.r3 });
  });

  it('is the only caller of filterRecords but its own definition', () => {
    const dir = path.resolve(__dirname, '..', 'scripts', 'token-eval');
    const calls = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
      .flatMap((line, i) => (line.includes('filterRecords(') && !line.trim().startsWith('*') ? [`${f}:${i + 1}`] : [])));
    expect(calls.map((c) => c.split(':')[0])).toEqual(['z0-filters.mjs', 'z0-filters.mjs']);
  });
});
