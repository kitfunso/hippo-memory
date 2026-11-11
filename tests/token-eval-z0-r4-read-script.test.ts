// Round 4 slice R1: s4-read.sh on slice 6's corpus laid out as a root with a results repository (plan: Slice R, Failure model, Record model).
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitBash } from '../scripts/token-eval/homes.mjs';
import { cleanUpRoots, readRoot } from './fixtures/z0-read-root.js';

afterAll(cleanUpRoots);

// The script needs Git Bash, cygpath and drive-letter roots, which the other CI jobs lack; the launcher tests skip the same way.
const win = process.platform === 'win32';

const MS = 120_000;
const CHECKOUT = path.resolve(__dirname, '..').replace(/\\/g, '/');
const SCRIPT = `${CHECKOUT}/scripts/token-eval/r4-launch/s4-read.sh`;
const USAGE = 'usage: s4-read.sh <checkout> <root> [--unblind]';
const COMMIT = 'z0 r4: grading and drop list for the read';

interface Run { readonly code: number | null; readonly out: string; readonly last: string }
interface Hash { readonly role: string; readonly file: string }
interface Report { readonly status: string; readonly hashes: readonly Hash[] }
interface Listed { readonly file: string }
interface Grading { readonly g5: { readonly folders: readonly Listed[] } }
interface DropList { readonly runs: readonly Listed[] }

/** One bash call of s4-read.sh (or the copy `script`) with these arguments, both streams in `out`. */
function exec(args: readonly string[], cwd: string = os.tmpdir(), script: string = SCRIPT): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBash(process.env, []), [script, ...args], { cwd, windowsHide: true, timeout: 110_000 });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, last: out.trimEnd().split('\n').at(-1) ?? '' }));
  });
}
const call = (root: string, ...extra: string[]): Promise<Run> => exec([CHECKOUT, root, ...extra], path.dirname(root));

const read = (file: string): string => fs.readFileSync(file, 'utf8');
const put = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const report = (file: string): Report => JSON.parse(read(file));
const posix = (p: string): string => p.replace(/\\/g, '/');
const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', `${root}/results`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const roleCounts = (r: Report) => {
  const counts = new Map<string, number>();
  for (const h of r.hashes) if (h.role !== 'source') counts.set(h.role, (counts.get(h.role) ?? 0) + 1);
  return Object.fromEntries(counts);
};

const own = (dir: string): string => `--runs ${dir}/run/runs.jsonl --plan ${dir}/run/plan.json --off-pin ${dir}/off-pin.json`;
const merged = (root: string): string => {
  const dir = `${root}/merged/batch1/rn-repo1-w1`;
  return `--runs ${dir}/runs.jsonl --plan ${dir}/plan.json --off-pin ${dir}/off-pin.json --merge-manifest ${dir}/merge.json`;
};
/** The parser's own message, which the analyzer quotes and which differs between Node versions. */
const jsonError = (text: string): string => {
  try {
    JSON.parse(text);
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};
const grade = (dir: string): string => `${dir}/run/grading.json`;
const gradedFiles = (root: string): string[] => {
  const grading: Grading = JSON.parse(read(`${root}/read/grading.json`));
  return grading.g5.folders.map((f) => f.file);
};
const droppedRuns = (root: string): string[] => {
  const list: DropList = JSON.parse(read(`${root}/read/drop-list.json`));
  return list.runs.map((f) => posix(f.file));
};
const readSetRuns = (root: string): string[] => [...read(`${root}/read/read-set.txt`).matchAll(/--runs (\S+)/g)].map((m) => m[1]);
const BLIND_ROLES = { runs: 5, plan: 5, 'off-pin': 5, 'merge-manifest': 1, prices: 1, grading: 1, levels: 2, 'seed-rule': 1, 'read-set': 1, pins: 1, 'drift-runs': 1, 'drift-plan': 1 };

describe.skipIf(!win)('s4-read.sh: the blind and the unblinded read of a root with a merged key, a rerun and a failed attempt', () => {
  let root = '';
  let first: Run;
  beforeAll(async () => {
    root = readRoot();
    first = await call(root, '--unblind');
  }, MS);

  it('exits 0 and prints the unblind line alone', () => {
    expect(first).toMatchObject({ code: 0, out: 'READ UNBLIND: valid\n' });
  }, MS);

  it('writes the read set: the seed cap, the merged key, its rerun, then each other key, with no raise line', () => {
    expect(read(`${root}/read/read-set.txt`).split('\n')).toEqual([
      '--max-seed 3', merged(root), own(`${root}/batch1/rn-repo1-e2`), own(`${root}/batch1/rn-repo2-w1`), own(`${root}/batch2/rn-repo3-w1-a2`), own(`${root}/batch2/rn-repo4-w1`), '',
    ]);
  }, MS);

  it('reads blind to a valid report with one hash row per input, and loads the merged folder\'s own off-pin file', () => {
    const blind = report(`${root}/read/blind.json`);
    expect(blind.status).toBe('valid');
    expect(roleCounts(blind)).toEqual(BLIND_ROLES);
    expect(blind.hashes.filter((h) => h.role === 'off-pin' && h.file.endsWith('merged/batch1/rn-repo1-w1/off-pin.json'))).toHaveLength(1);
    expect(read(`${root}/read/blind.stdout`).split('\n').filter((l) => l.startsWith('status: ') || l.startsWith('valid: ') || l.startsWith('invalid: '))).toEqual(['status: valid', 'valid: every gate passes']);
  }, MS);

  it('reads unblinded to a valid report that adds the drop list and the six run folders of batches 1 and 2, with no smoke or pilot folder', () => {
    const unblind = report(`${root}/read/unblind.json`);
    expect(unblind.status).toBe('valid');
    expect(roleCounts(unblind)).toEqual({ ...BLIND_ROLES, 'drop-list': 1, 'ledger-runs': 6 });
    expect(unblind.hashes.filter((h) => h.role === 'ledger-runs').map((h) => h.file).sort()).toEqual([
      `${root}/batch1/rn-repo1-e2/run`, `${root}/batch1/rn-repo1-w1/run`, `${root}/batch1/rn-repo2-w1/run`, `${root}/batch2/rn-repo3-w1-a2/run`, `${root}/batch2/rn-repo3-w1/run`, `${root}/batch2/rn-repo4-w1/run`,
    ]);
  }, MS);

  it('combines G5 over exactly the five folders of the read: each key\'s first run, then its rerun', () => {
    expect(gradedFiles(root)).toEqual([`${root}/batch1/rn-repo1-w1`, `${root}/batch1/rn-repo1-e2`, `${root}/batch1/rn-repo2-w1`, `${root}/batch2/rn-repo3-w1-a2`, `${root}/batch2/rn-repo4-w1`].map(grade));
  }, MS);

  it('lists in the drop list exactly the runs files of the read set', () => {
    expect(readSetRuns(root)).toHaveLength(5);
    expect(droppedRuns(root)).toEqual(readSetRuns(root));
  }, MS);

  it('hashes the committed grading file in both reports, not the copy under read', () => {
    for (const name of ['blind', 'unblind']) {
      expect(report(`${root}/read/${name}.json`).hashes.filter((h) => h.role === 'grading').map((h) => h.file)).toEqual([`${root}/results/docs/evals/z0-r4/grading.json`]);
    }
  }, MS);

  it('commits the grading file and the drop list once, byte for byte, and leaves the results tree clean', () => {
    expect(git(root, 'log', '--format=%s')).toBe(`${COMMIT}\ninit`);
    for (const name of ['grading.json', 'drop-list.json']) {
      expect(fs.readFileSync(`${root}/results/docs/evals/z0-r4/${name}`).equals(fs.readFileSync(`${root}/read/${name}`))).toBe(true);
    }
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, MS);

  it('answers a second call with the same line and makes no second commit', async () => {
    const again = await call(root, '--unblind');
    expect(again).toMatchObject({ code: 0, last: 'READ UNBLIND: valid' });
    expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('2');
  }, MS);
});

describe.skipIf(!win)('s4-read.sh: a failed git call, a raise and a regraded runs file', () => {
  it('exits 1 with git\'s own line for a leftover index.lock, and leaves no read from an earlier call', async () => {
    const root = readRoot();
    const E = `${root}/results/docs/evals/z0-r4`;
    put(`${E}/grading.json`, '{"old":true}\n');
    git(root, 'add', 'docs/evals/z0-r4/grading.json');
    git(root, 'commit', '-qm', 'an earlier grading file');
    put(`${root}/results/.git/index.lock`, '');
    put(`${root}/read/blind.json`, 'stale\n');
    put(`${root}/read/unblind.json`, 'stale\n');
    const run = await call(root, '--unblind');
    expect(run.code).toBe(1);
    expect(run.last).toBe(`READ FAILED: git exit 128: fatal: Unable to create '${root}/results/.git/index.lock': File exists.`);
    expect(fs.existsSync(`${root}/read/blind.json`)).toBe(false);
    expect(fs.existsSync(`${root}/read/unblind.json`)).toBe(false);
  }, MS);

  it('commits nothing and still exits 0 on a rerun when a file of its own folder is changed or untracked', async () => {
    const root = readRoot();
    const E = `${root}/results/docs/evals/z0-r4`;
    put(`${E}/r3-grading.json`, '{"old":true}\n');
    git(root, 'add', 'docs/evals/z0-r4/r3-grading.json');
    git(root, 'commit', '-qm', 'an earlier file');
    expect(await call(root)).toMatchObject({ code: 0, out: 'READ BLIND: valid\n' });
    put(`${E}/r3-grading.json`, '{"old":false}\n');
    put(`${E}/r3-notes.txt`, 'not committed\n');
    const again = await call(root, '--unblind');
    expect(again).toMatchObject({ code: 0, out: 'READ UNBLIND: valid\n' });
    expect(git(root, 'log', '--format=%s')).toBe(`${COMMIT}\nan earlier file\ninit`);
    expect(git(root, 'status', '--porcelain')).toBe(' M docs/evals/z0-r4/r3-grading.json\n?? docs/evals/z0-r4/r3-notes.txt');
  }, MS);

  it('exits 1 naming the analyzer and its line when it fails, and writes no blind report', async () => {
    const root = readRoot();
    put(`${root}/levels/batch-1.json`, '{');
    const run = await call(root);
    expect(run.code).toBe(1);
    expect(run.last).toBe(`READ FAILED: z0-analyze exit 1: ${root}/levels/batch-1.json: not JSON (${jsonError('{')})`);
    expect(fs.existsSync(`${root}/read/blind.json`)).toBe(false);
  }, MS);

  it('reads a raise to seed 4: the seed cap first and the four raise folders last', async () => {
    const root = readRoot({ raiseTo: 4 });
    const run = await call(root);
    expect(run).toMatchObject({ code: 0, out: 'READ BLIND: valid\n' });
    const lines = read(`${root}/read/read-set.txt`).split('\n');
    expect(lines[0]).toBe('--max-seed 4');
    expect(lines.slice(-5)).toEqual([1, 2, 3, 4].map((n) => own(`${root}/raise/rn-repo${n}-w2`)).concat(['']));
    expect(fs.existsSync(`${root}/read/unblind.json`)).toBe(false);
  }, MS);

  it('stops on a runs.regraded.jsonl under a run folder', async () => {
    const root = readRoot();
    put(`${root}/batch1/rn-repo2-w1/run/runs.regraded.jsonl`, '');
    const run = await call(root);
    expect(run.code).toBe(1);
    expect(run.last).toBe(`READ FAILED: z0-read-set exit 3: STOP: ${root}/batch1/rn-repo2-w1/run/runs.regraded.jsonl exists; the round 4 reads never take a regraded runs file`);
    expect(fs.existsSync(`${root}/read/blind.json`)).toBe(false);
  }, MS);
});

describe.skipIf(!win)('s4-read.sh: an invalid blind read', () => {
  it('refuses the unblind with exit 3 and the failed gate, and leaves no unblinded read', async () => {
    const root = readRoot({ pairs: 2 });
    put(`${root}/read/unblind.json`, 'stale\n');
    const run = await call(root, '--unblind');
    expect(run).toMatchObject({ code: 3, last: 'READ INVALID: G5' });
    expect(report(`${root}/read/blind.json`).status).toBe('invalid');
    expect(fs.existsSync(`${root}/read/unblind.json`)).toBe(false);
  }, MS);

  it('exits 3 with the same line for a blind read alone', async () => {
    const root = readRoot({ pairs: 2 });
    expect(await call(root)).toMatchObject({ code: 3, out: 'READ INVALID: G5\n' });
  }, MS);

  it('exits 3 with the status for an abandoned run, which has no gate list', async () => {
    const root = readRoot({ abandoned: true });
    expect(await call(root, '--unblind')).toMatchObject({ code: 3, out: 'READ INVALID: abandoned\n' });
    expect(report(`${root}/read/blind.json`).status).toBe('abandoned');
    expect(fs.existsSync(`${root}/read/unblind.json`)).toBe(false);
  }, MS);
});

describe.skipIf(!win)('s4-read.sh: an unblinded read the drop list turns invalid after a valid blind read', () => {
  it('exits 3 with the analyzer\'s gate list, prints no unblind line and leaves the unblinded report invalid', async () => {
    const root = readRoot({ hookCancels: 20 });
    const run = await call(root, '--unblind');
    expect(run).toMatchObject({ code: 3, out: 'READ INVALID: G4\n' });
    expect(report(`${root}/read/blind.json`).status).toBe('valid');
    expect(report(`${root}/read/unblind.json`).status).toBe('invalid');
  }, MS);
});

describe.skipIf(!win)('s4-read.sh: the unblinded read of a raise to seed 4, with a raise folder that holds no out mark', () => {
  let root = '';
  let run: Run;
  beforeAll(async () => {
    root = readRoot({ raiseTo: 4 });
    put(`${root}/raise/rn-repo9-w2/run/run.log`, 'no out mark here\n');
    run = await call(root, '--unblind');
  }, MS);
  const raise = (): string[] => [1, 2, 3, 4].map((n) => `${root}/raise/rn-repo${n}-w2`);

  it('exits 0 with the unblind line alone', () => {
    expect(run).toMatchObject({ code: 0, out: 'READ UNBLIND: valid\n' });
  }, MS);

  it('combines G5 over the five folders of batches 1 and 2, then the four raise folders', () => {
    expect(gradedFiles(root)).toEqual([`${root}/batch1/rn-repo1-w1`, `${root}/batch1/rn-repo1-e2`, `${root}/batch1/rn-repo2-w1`, `${root}/batch2/rn-repo3-w1-a2`, `${root}/batch2/rn-repo4-w1`, ...raise()].map(grade));
  }, MS);

  it('lists in the drop list the runs files of the read set, the four raise files last', () => {
    expect(droppedRuns(root)).toEqual(readSetRuns(root));
    expect(droppedRuns(root).slice(-4)).toEqual(raise().map((dir) => `${dir}/run/runs.jsonl`));
  }, MS);

  it('prices the four raise run folders and the six of batches 1 and 2, and skips the raise folder with no out mark', () => {
    const rows = report(`${root}/read/unblind.json`).hashes.filter((h) => h.role === 'ledger-runs').map((h) => h.file);
    expect(rows).toEqual([
      `${root}/batch1/rn-repo1-e2/run`, `${root}/batch1/rn-repo1-w1/run`, `${root}/batch1/rn-repo2-w1/run`, `${root}/batch2/rn-repo3-w1-a2/run`, `${root}/batch2/rn-repo3-w1/run`, `${root}/batch2/rn-repo4-w1/run`,
      ...raise().map((dir) => `${dir}/run`),
    ]);
  }, MS);
});

describe.skipIf(!win)('s4-read.sh: a units file that cannot be sourced', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });
  /** A folder holding a copy of the script, and beside it `units` as s4-units.sh when given. */
  const lone = (units?: string): string => {
    const dir = posix(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'z0-read-units-'))));
    dirs.push(dir);
    fs.copyFileSync(SCRIPT, `${dir}/s4-read.sh`);
    if (units !== undefined) put(`${dir}/s4-units.sh`, units);
    return dir;
  };

  it.each([
    ['is missing', undefined, 1],
    ['returns 3', 'return 3\n', 3],
  ])('exits 1 naming the file when it %s', async (_name, units, rc) => {
    const dir = lone(units);
    const run = await exec([CHECKOUT, `${dir}/root`], dir, `${dir}/s4-read.sh`);
    expect(run).toMatchObject({ code: 1, last: `READ FAILED: source exit ${rc}: ${dir}/s4-units.sh` });
  }, MS);
});

describe.skipIf(!win)('s4-read.sh: inputs and arguments, refused before any command runs', () => {
  const MISSING = ['pins-r4.json', 'prices.json', 'levels/pre-freeze.json', 'levels/batch-1.json', 'seed-rule.json', 'blind-key.json', 'drift-inputs.txt', 'r3drift/dr.jsonl', 'r3drift/dp.json', 'results/.git'];

  it.each(MISSING)('exits 1 naming %s when it is missing, and writes no read', async (name) => {
    const root = readRoot();
    fs.renameSync(`${root}/${name}`, `${root}/${name}.off`);
    const run = await call(root);
    expect(run).toMatchObject({ code: 1, out: `READ: ${root}/${name} is missing\n` });
    expect(fs.existsSync(`${root}/read`)).toBe(false);
  }, MS);

  it.each([
    ['a line of another shape', (line: string) => `${line}\n--runs only\n`, 'READ: drift-inputs.txt line 2 is not "--runs <f> --plan <p>"'],
    ['a blank line', (line: string) => `${line}\n\n`, 'READ: drift-inputs.txt line 2 is not "--runs <f> --plan <p>"'],
    ['a repeated line', (line: string) => `${line}\n${line}\n`, 'READ: drift-inputs.txt line 2 repeats line 1'],
    ['an empty file', () => '', 'READ: drift-inputs.txt holds no line'],
  ])('refuses drift-inputs.txt with %s', async (_name, make, message) => {
    const root = readRoot();
    const file = `${root}/drift-inputs.txt`;
    put(file, make(read(file).trimEnd()));
    expect(await call(root)).toMatchObject({ code: 1, out: `${message}\n` });
    expect(fs.existsSync(`${root}/read`)).toBe(false);
  }, MS);

  it('refuses a root with a trailing slash, with backslashes or relative, naming the form it needs', async () => {
    const root = readRoot();
    const given = [`${root}/`, root.replace(/\//g, '\\'), path.basename(root)];
    for (const arg of given) expect(await exec([CHECKOUT, arg], path.dirname(root))).toMatchObject({ code: 1, out: `READ: root ${arg} must be written as ${root}\n` });
    expect(fs.existsSync(`${root}/read`)).toBe(false);
  }, MS);

  it.each([[[]], [[CHECKOUT]], [[CHECKOUT, 'C:/x', '--blind']], [[CHECKOUT, 'C:/x', '--unblind', 'more']]])('prints the usage and exits 1 for the arguments %j', async (args) => {
    expect(await exec(args)).toMatchObject({ code: 1, out: `${USAGE}\n` });
  }, MS);
});
