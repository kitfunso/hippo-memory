// Stub of z0-regrade.mjs for the s4-batch.sh tests: the listing counts it by its file name and `--out <folder>/run`.
// Knobs come from `$Z0_STUB_KNOBS/<folder name>.json` (else default.json), keyed by call: { durationS, release, lock, errorRows, hangOnce, keyNoLine, exit, real }.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hangBounded, holdUntil, knobsOf } from './ab-run.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const [mode] = argv;
const out = flag('--out');
const folder = path.dirname(out);
const labels = argv.includes('--labels');
const call = mode === 'reader' || mode === 'stored' ? `${mode}-${labels ? 'score' : 'draw'}` : mode;
const knob = (knobsOf(path.basename(folder))[call]) ?? {};
const g5 = path.join(out, 'g5');
const lock = path.join(g5, 'regrade.lock');
const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LABELS = (ids) => `# id\tlabel (stub)\tnote\n${ids.map((id) => `${id}\t\t\n`).join('')}`;
const rowsOf = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));

if (knob.real) {
  const r = spawnSync(process.execPath, [path.join(process.env.Z0_REAL_CHECKOUT, 'scripts', 'token-eval', 'z0-regrade.mjs'), ...argv], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const seen = { call, start: Date.now(), lockSeen: fs.existsSync(lock) };
put(path.join(folder, `g5-${call}.stub.json`), JSON.stringify(seen));
if (seen.lockSeen) {
  process.stderr.write(`${lock} is held\n`);
  process.exit(1);
}
const hangFile = path.join(folder, `${call}.hang-done`);
if (knob.lock || knob.hangOnce) put(lock, `${process.pid}`);
if (knob.hangOnce && !fs.existsSync(hangFile)) {
  put(hangFile, '');
  hangBounded(`regrade ${call} hang`);
  await new Promise(() => {});
}
if (knob.release) await holdUntil(knob.release, `regrade ${call} release`);
await sleep((knob.durationS ?? 0) * 1000);
if (knob.exit) {
  process.stderr.write(`stub ${call} failed on purpose\n`);
  process.exit(knob.exit);
}

const finish = (line) => {
  fs.rmSync(lock, { force: true });
  put(path.join(folder, `g5-${call}.stub.json`), JSON.stringify({ ...seen, end: Date.now() }));
  process.stdout.write(`${line}\n`);
};
if (call === 'regrade') {
  const countFile = path.join(folder, 'regrade-errcount');
  const done = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
  const errors = done < (knob.errorRows?.times ?? 0) ? knob.errorRows.rows : 0;
  put(countFile, String(done + 1));
  finish(`repro: regraded 3 cells (${errors} with errors), skipped 0 done ones; wrote 3`);
} else if (call === 'reader-draw') {
  put(path.join(g5, 'reader-r1', 'labels.tsv'), LABELS(['p1', 'p2']));
  put(path.join(g5, 'sealed', 'reader-r1.key.json'), JSON.stringify({ pairs: [{ file: 'p1', which: 'first', verdict: 'pass' }, { file: 'p2', which: 'final', verdict: 'fail' }] }));
  if (knob.keyNoLine) process.exit(1);
  finish('reader round 1: drew 2 pairs');
} else if (call === 'stored-draw') {
  put(path.join(g5, 'stored', 'labels.tsv'), LABELS(['u1', 'u2']));
  put(path.join(g5, 'sealed', 'stored.key.json'), JSON.stringify({ units: ['u1', 'u2'] }));
  finish('stored sample: drew 2 units');
} else if (call === 'reader-score') {
  put(path.join(g5, 'sealed', 'reader-r1.score.json'), JSON.stringify({ labels: Object.fromEntries(rowsOf(flag('--labels')).map(([id, label]) => [id, label])) }));
  finish('reader round 1: 0 of 2 labels disagree');
} else if (call === 'stored-score') {
  put(path.join(g5, 'sealed', 'stored.score.json'), JSON.stringify({ labels: Object.fromEntries(rowsOf(flag('--labels')).map(([id, label]) => [id, label])) }));
  finish('stored sample: 2 of 2 labels agree with the key-phrase judgement');
} else {
  fs.rmSync(path.join(out, 'grading.json'), { force: true });
  put(path.join(out, 'grading.json'), `${JSON.stringify({ g5: { readerRound: 1 }, readerSample: { n: 2, disagreements: 0 }, flippedLessons: [], acceptanceFlips: 0 })}\n`);
  finish(`wrote ${path.join(out, 'grading.json')}: 0 flipped lessons, 0 acceptance flips`);
}
