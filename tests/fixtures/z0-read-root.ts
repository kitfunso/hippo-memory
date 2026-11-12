/** A round 4 `<root>` for s4-read.sh: slice 6's corpus in the Run layout, one merged key, one rerun, one failed attempt, G5 files and a results repository. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ARM_TABLE } from '../../scripts/token-eval/arms.mjs';
import { runDirs } from '../../scripts/token-eval/homes.mjs';
import { runCli as leaks } from '../../scripts/token-eval/z0-leaks.mjs';
import { runCli as merge } from '../../scripts/token-eval/z0-merge.mjs';
import { jsonl, planOf, type Generated, type Z0Record } from './z0-gen.js';
import { r4Corpus } from './z0-r4-corpus.js';
import { testGit } from './test-git.js';
import { KEYS, PINS, PRICES4, R4, drift, levelsFile, loose, raise, seedRule } from './z0-r4-read.js';

/** `pairs` is the reader pairs of each G5 folder (8 gives 40 or more in all, which G5 passes); `raiseTo` lays out a raise to that seed; `abandoned` cuts rn-repo2's first run short of its plan;
 * `hookCancels` gives that many S2 positions of seed 1 a cancelled prompt hook, which the drop list voids and the blind read, taking no drop list, does not see. */
export interface ReadRootOpts { readonly pairs?: number; readonly raiseTo?: number; readonly abandoned?: boolean; readonly hookCancels?: number }

const roots: string[] = [];
export const cleanUpRoots = (): void => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
};

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json | undefined };
const posix = (p: string): string => p.replace(/\\/g, '/');
const put = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const putJson = (file: string, body: Json): void => put(file, `${JSON.stringify(body)}\n`);
const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mark = (batch: string, name: string, folder: string): void => put(`${batch}/done/${name}`, `${folder}\n`);

/** One transcript message, so the ledger prices a cell at its arm's model; each id is its own, since the ledger prices an id once per folder. */
const transcript = (model: string, id: string): string => `${JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 } } })}\n`;

/** `<dir>/run/` with the records and their plan (`planned` when the records stop short of it), `<dir>/off-pin.json` and `<dir>/leaks.json` (the real z0-leaks) beside it. */
function unit(dir: string, records: readonly Z0Record[], planned: readonly Z0Record[] = records): void {
  const [runs, plan] = [`${dir}/run/runs.jsonl`, `${dir}/run/plan.json`];
  put(runs, `${jsonl(records)}\n`);
  put(plan, JSON.stringify(planOf(planned)));
  putJson(`${dir}/off-pin.json`, { schema: 'z0-offpin/1', runs: [{ dir: `${dir}/run`, file: 'runs.jsonl', sha256: sha(runs) }], voids: [] });
  const listed = leaks(['--runs', runs, '--plan', plan, '--out', `${dir}/leaks.json`, '--design', 'r4']);
  if (listed.code !== 0) throw new Error(`z0-leaks on ${dir}: ${listed.stderr}`);
}

/** The folder's sealed reader round and grading file, in the shape `g5Done` of tests/fixtures/z0-batch/harness.ts leaves: `pairs` pairs, none disagreeing. */
function g5(dir: string, pairs: number): void {
  const files = Array.from({ length: pairs }, (_, i) => `p${i}`);
  putJson(`${dir}/run/g5/sealed/reader-r1.key.json`, { pairs: files.map((file, i) => ({ file, which: i % 2 === 0 ? 'first' : 'final', verdict: 'pass' })) });
  putJson(`${dir}/run/g5/sealed/reader-r1.score.json`, { labels: Object.fromEntries(files.map((file) => [file, 'pass'])) });
  putJson(`${dir}/run/grading.json`, { g5: { readerRound: 1 }, readerSample: { n: pairs, disagreements: 0 }, flippedLessons: [], acceptanceFlips: 0 });
}

function resultsRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]): void => void testGit(dir, ...args);
  git('init', '-q', '-b', 'z0/r4-results');
  git('config', 'user.name', 'z0 test');
  git('config', 'user.email', 'z0@example.invalid');
  git('config', 'core.hooksPath', '.no-hooks');
  git('config', 'commit.gpgsign', 'false');
  put(`${dir}/.gitkeep`, '');
  git('add', '.gitkeep');
  git('commit', '-qm', 'init');
}

/** Builds a root under the temp folder, registered for `cleanUpRoots`, and returns its forward-slash path. */
export function readRoot(opts: ReadRootOpts = {}): string {
  const root = posix(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'z0-read-'))));
  roots.push(root);
  const base = r4Corpus();
  let cancels = opts.hookCancels ?? 0;
  const g: Generated = opts.hookCancels === undefined ? base : {
    ...base,
    records: base.records.map((r) => (r.arm === 'S2' && r.seed === 1 ? { ...r, sessionId: `s-${r.sequence}-${r.position}`, hookCancels: cancels-- > 0 ? { UserPromptSubmit: 1 } : {} } : r)),
  };
  const pairs = opts.pairs ?? 8;
  const seedCount = opts.raiseTo ?? 3;
  const of = (key: string, ...seeds: number[]): Z0Record[] => g.records.filter((r) => r.sequence === key && seeds.includes(r.seed));

  putJson(`${root}/pins-r4.json`, PINS);
  putJson(`${root}/prices.json`, PRICES4);
  for (const source of ['pre-freeze', 'batch-1']) putJson(`${root}/levels/${source}.json`, levelsFile(source, 0.999));
  putJson(`${root}/seed-rule.json`, seedRule(seedCount));
  // Batch 1's block writes the key; the read takes it as an input.
  putJson(`${root}/blind-key.json`, { codes: Object.fromEntries(R4.arms.map((arm: string, i: number) => [arm, `K${i + 1}`])) });
  const d = drift();
  put(`${root}/r3drift/dr.jsonl`, `${jsonl(d.records)}\n`);
  put(`${root}/r3drift/dp.json`, JSON.stringify(d.plan));
  put(`${root}/drift-inputs.txt`, `--runs ${root}/r3drift/dr.jsonl --plan ${root}/r3drift/dp.json\n`);
  resultsRepo(`${root}/results`);

  const [b1, b2] = [`${root}/batch1`, `${root}/batch2`];
  const folders: string[] = [];
  const first = (batch: string, key: string, folder: string, records: readonly Z0Record[], planned: readonly Z0Record[] = records): void => {
    unit(`${batch}/${folder}`, records, planned);
    mark(batch, `${key}-w1`, folder);
    mark(batch, key, folder);
    folders.push(`${batch}/${folder}`);
  };
  // rn-repo1 leaked one record of seed 2: the merged folder drops that seed and `rn-repo1-e2` holds it again.
  const leaked = of('rn-repo1', 1, 2, 3).map((r) => (r.seed === 2 && r.arm === 'O1' && r.position === 4 ? { ...r, invalid: 'leak' } : r));
  first(b1, 'rn-repo1', 'rn-repo1-w1', leaked);
  unit(`${b1}/rn-repo1-e2`, of('rn-repo1', 2));
  mark(b1, 'rn-repo1-e2', 'rn-repo1-e2');
  folders.push(`${b1}/rn-repo1-e2`);
  const merged = merge(['--first', `${b1}/rn-repo1-w1/run`, '--leaks', `${b1}/rn-repo1-w1/leaks.json`, '--first-off-pin', `${b1}/rn-repo1-w1/off-pin.json`, '--rerun-of', `${b1}/rn-repo1-e2/run`, '--out', `${root}/merged/batch1/rn-repo1-w1`]);
  if (merged.code !== 0) throw new Error(`z0-merge: ${merged.stderr}`);
  const second = of('rn-repo2', 1, 2, 3);
  first(b1, 'rn-repo2', 'rn-repo2-w1', opts.abandoned === true ? second.slice(0, -5) : second, second);
  // rn-repo3's first attempt was cut short, so both its markers name the second.
  put(`${b2}/rn-repo3-w1/run/runs.jsonl`, `${jsonl(of('rn-repo3', 1).slice(0, 30))}\n`);
  put(`${b2}/rn-repo3-w1/run.log`, 'the run was cut short\n');
  first(b2, 'rn-repo3', 'rn-repo3-w1-a2', of('rn-repo3', 1, 2, 3));
  first(b2, 'rn-repo4', 'rn-repo4-w1', of('rn-repo4', 1, 2, 3));

  for (const arm of R4.arms) {
    put(posix(path.join(runDirs(`${b1}/rn-repo1-w1/run`, 'rn-repo1', arm, 1).claudeConfig, 'projects', 'p', 'one.jsonl')), transcript(loose(ARM_TABLE)[arm].model, `m-rn-repo1-${arm}-seed1`));
  }
  put(`${root}/smoke/w1/run/runs.jsonl`, `${jsonl(g.records.slice(0, 3))}\n`);
  put(`${root}/pilot/rn-repo1-p1/run/runs.jsonl`, `${jsonl(g.records.slice(0, 3))}\n`);

  if (opts.raiseTo === undefined) {
    put(`${root}/raise/NONE`, 'sha\n');
  } else {
    const seeds = raise(g, opts.raiseTo).records.filter((r) => r.seed >= 4);
    for (const key of KEYS) {
      unit(`${root}/raise/${key}-w2`, seeds.filter((r) => r.sequence === key));
      mark(`${root}/raise`, `${key}-w2`, `${key}-w2`);
      mark(`${root}/raise`, key, `${key}-w2`);
      folders.push(`${root}/raise/${key}-w2`);
    }
  }
  putJson(`${root}/raise/max-seed.json`, { maxSeed: seedCount, count: seedCount });
  for (const folder of folders) g5(folder, pairs);
  return root;
}
