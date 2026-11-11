// Z0 round 4 Record model: sample keys, scores and grading.json are written whole, and a sealed key or score that does not parse is never rebuilt.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup } from './fixtures/z0-harness.js';
import { PHRASE, SEQ, cli, gradeDir, readJson, runRoot, storedRecord, synthOut, type Cell } from './fixtures/z0-g5.js';

const SEALED_LINE = 'sealed file does not parse; the harness never rebuilds it';
const cells = (n: number): Cell[] => Array.from({ length: n }, (_, i) => ({ arm: 'A0', position: i, first: i % 2 ? 'fail' : 'pass' }));
const tempsIn = (dir: string) => readdirSync(dir).filter((n) => n.includes('.tmp-'));
const plant = (file: string) => writeFileSync(`${file}.tmp-999999`, '{"half": ');

/** A reader sample drawn and scored, so each file is there to corrupt. */
function readerOut() {
  const s = synthOut(cells(8));
  const draw = ['reader', '--out', s.out, '--tasks', s.tasks, '--seed', '7', '--n', '6'];
  const sealed = join(s.out, 'g5', 'sealed');
  const labels = join(s.out, 'labels.tsv');
  const score = ['reader', '--out', s.out, '--labels', labels];
  return { ...s, draw, score, sealed, labels, key: join(sealed, 'reader-r1.key.json'), scoreFile: join(sealed, 'reader-r1.score.json') };
}

const writeLabels = (out: string, key: { pairs: { file: string; verdict: string }[] }) =>
  writeFileSync(join(out, 'labels.tsv'), key.pairs.map((p) => `${p.file}\t${p.verdict}\t\n`).join(''));

describe('whole writes of the sample files and grading.json', () => {
  afterEach(cleanup);

  it('writes a reader draw key and score whole when a killed write left a temp file and no target', () => {
    const r = readerOut();
    mkdirSync(r.sealed, { recursive: true });
    plant(r.key);
    expect(cli(r.draw)).toMatchObject({ code: 0 });
    expect(readJson(r.key).pairs.length).toBeGreaterThan(0);
    expect(tempsIn(r.sealed)).toEqual([]);
    writeLabels(r.out, readJson(r.key));
    plant(r.scoreFile);
    expect(cli(r.score)).toMatchObject({ code: 0 });
    expect(readJson(r.scoreFile)).toMatchObject({ round: 1 });
    expect(tempsIn(r.sealed)).toEqual([]);
  });

  it('writes grading.json whole when a killed write left a temp file and no target', () => {
    const r = readerOut();
    expect(cli(r.draw)).toMatchObject({ code: 0 });
    writeLabels(r.out, readJson(r.key));
    expect(cli(r.score)).toMatchObject({ code: 0 });
    plant(join(r.out, 'grading.json'));
    expect(cli(['grading', '--out', r.out])).toMatchObject({ code: 0 });
    expect(readJson(join(r.out, 'grading.json')).readerSample.n).toBeGreaterThan(0);
    expect(tempsIn(r.out)).toEqual([]);
  });

  it('keeps the bytes a sealed write had: two-space JSON and one final newline', () => {
    const r = readerOut();
    expect(cli(r.draw)).toMatchObject({ code: 0 });
    const text = readFileSync(r.key, 'utf8');
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  });
});

describe('a sealed reader key or score that does not parse', () => {
  afterEach(cleanup);

  it('stops a second draw with the readSealed line and leaves the key as it was', () => {
    const r = readerOut();
    expect(cli(r.draw)).toMatchObject({ code: 0 });
    writeFileSync(r.key, '{ "round": 1, ');
    const result = cli(r.draw);
    expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining(SEALED_LINE) });
    expect(result.stderr).toContain('reader-r1.key.json');
    expect(readFileSync(r.key, 'utf8')).toBe('{ "round": 1, ');
  });

  it('stops scoring on a malformed key and on a malformed score, and rebuilds neither', () => {
    const r = readerOut();
    expect(cli(r.draw)).toMatchObject({ code: 0 });
    writeLabels(r.out, readJson(r.key));
    expect(cli(r.score)).toMatchObject({ code: 0 });
    writeFileSync(r.scoreFile, '{ "labels": ');
    expect(cli(r.score)).toMatchObject({ code: 1, stderr: expect.stringContaining(`reader-r1.score.json: ${SEALED_LINE}`) });
    expect(readFileSync(r.scoreFile, 'utf8')).toBe('{ "labels": ');
    writeFileSync(r.key, 'not json');
    expect(cli(r.score)).toMatchObject({ code: 1, stderr: expect.stringContaining(`reader-r1.key.json: ${SEALED_LINE}`) });
    expect(readFileSync(r.key, 'utf8')).toBe('not json');
  });
});

describe('the stored sample files', () => {
  afterEach(cleanup);

  /** Four judged units over A0 and A1, enough for a draw of n 4. */
  function storedOut() {
    const s = synthOut([{ arm: 'A0', position: 100 }]);
    const records = [];
    for (let i = 0; i < 4; i++) {
      const [arm, seed] = [i % 2 ? 'A1' : 'A0', 1 + (i % 2)];
      records.push(storedRecord(arm, seed, i, i < 2));
      mkdirSync(gradeDir(s.out, arm, seed), { recursive: true });
      mkdirSync(runRoot(s.out, arm, seed), { recursive: true });
      writeFileSync(join(gradeDir(s.out, arm, seed), `t${i}.surfaces.txt`), `=== CLAUDE.md\nkeeps ${i < 2 ? PHRASE : 'nothing'}\n`);
    }
    writeFileSync(join(s.out, 'runs.jsonl'), records.map((x) => `${JSON.stringify(x)}\n`).join(''));
    writeFileSync(s.tasks, JSON.stringify({ families: [{ id: 'f1', lessons: [{ id: 'f1-l1', rule: 'Write the lesson file', keyPhrase: PHRASE }] }], sequences: [{ id: SEQ, tasks: [] }] }));
    const sealed = join(s.out, 'g5', 'sealed');
    return { ...s, sealed, key: join(sealed, 'stored.key.json'), scoreFile: join(sealed, 'stored.score.json'), draw: ['stored', '--out', s.out, '--tasks', s.tasks, '--seed', '3', '--n', '4'] };
  }

  it('writes the key and the score whole beside a temp file, and refuses a malformed one', () => {
    const s = storedOut();
    mkdirSync(s.sealed, { recursive: true });
    plant(s.key);
    expect(cli(s.draw)).toMatchObject({ code: 0 });
    expect(readJson(s.key).units.length).toBe(4);
    expect(tempsIn(s.sealed)).toEqual([]);
    const labels = join(s.out, 'labels.tsv');
    writeFileSync(labels, readJson(s.key).units.map((u: { file: string; judged: string }) => `${u.file}\t${u.judged}\t\n`).join(''));
    plant(s.scoreFile);
    expect(cli(['stored', '--out', s.out, '--labels', labels])).toMatchObject({ code: 0 });
    expect(existsSync(s.scoreFile)).toBe(true);
    expect(tempsIn(s.sealed)).toEqual([]);
    writeFileSync(s.scoreFile, '{ "n": ');
    expect(cli(['stored', '--out', s.out, '--labels', labels])).toMatchObject({ code: 1, stderr: expect.stringContaining(`stored.score.json: ${SEALED_LINE}`) });
    writeFileSync(s.key, '[');
    expect(cli(s.draw)).toMatchObject({ code: 1, stderr: expect.stringContaining(`stored.key.json: ${SEALED_LINE}`) });
    expect(readFileSync(s.key, 'utf8')).toBe('[');
    expect(readFileSync(s.scoreFile, 'utf8')).toBe('{ "n": ');
  });
});
