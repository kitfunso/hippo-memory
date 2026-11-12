// Round 4 slice R2, the run driver s4-drive.sh, end to end on stubs: the real driver, z0-drive, z0-budget, z0-pins-check and z0-unit-record against a fixture checkout and a dry root.
// The launcher, the runner, the batch, the read and every other CLI are stubs; no session is paid. One case or more for each plan check of slice R (plan :322).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { money } from '../scripts/token-eval/z0-budget.mjs';
import { BATCH1, BATCH2 } from './_helpers/z0-r4-spend.js';
import { DriveCase, POETRY, TAG_1, dropWorld, fwd, isAlive, lines, makeCheckout, makeWorld, put, read, sleep, until, type Knob, type Run, type Started, type World } from './fixtures/z0-drive/harness.js';
import { killOwnTree } from './fixtures/kill-own.js';
import { testGit } from './_helpers/test-git.js';

// A case's afterEach scans for its processes up to 20 times, far past the eval config's 30 s hookTimeout.
vi.setConfig({ hookTimeout: 180_000 });

const REPO = fwd(path.resolve(__dirname, '..'));
const LAUNCH = `${REPO}/scripts/token-eval/r4-launch`;
const ps = (command: string) => (process.platform === 'win32' ? spawnSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }) : null);
const HAVE = ps('$PSVersionTable.PSVersion.Major')?.status === 0 && ['C:/Program Files/Git/bin/bash.exe', `${POETRY}/Scripts/poetry.exe`].every((f) => existsSync(f));

let w: World;
const cases: DriveCase[] = [];
const mk = (name: string, checkout?: string) => {
  const c = new DriveCase(w, name, checkout);
  cases.push(c);
  return c;
};
beforeAll(() => {
  if (HAVE) w = makeWorld('drive');
}, 180_000);
afterEach(async () => {
  const done = await Promise.allSettled(cases.splice(0).map((c) => c.cleanup()));
  const errors = done.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
  if (errors.length > 0) throw new Error(errors.join('; '));
});
afterAll(() => dropWorld(w));

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
/** The exit code and every output line of a run, for one `toEqual`. */
const outcome = (r: Run) => [r.code, ...r.lines];
/** The outcome of a step that reaches the pins check, which prints its own pass line first. */
const outcomeOf = (c: DriveCase, r: Run) => {
  expect(r.lines[0], r.out).toBe(`pins ok: 7 files and folders, hippo build ${c.entry({ step: '1', exit: 0 }).commit}`);
  return [r.code, ...r.lines.slice(1)];
};
const git = (dir: string, ...args: string[]) => testGit(dir, ...args).trim();
const stubArgv = (c: DriveCase, name: string) => c.stubCalls(name).map((x) => x.argv);
/** True when `flag` stands alone in `text`, so `--run` is not found inside `--runs`. */
const hasFlag = (text: string, flag: string) => new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(text);

/** Every command each step prints, in order, for a fresh dry root (plan :431-441 and the brief). */
function expectedPrint(c: DriveCase, plans = false) {
  const [R, K, F] = [c.root, c.checkout, `${c.knobs}/fake.json`];
  const pins = `z0-pins-check.mjs --pins ${R}/pins-r4.json --checkout ${K} --roles ${R}/pin-roles.txt --poetry ${POETRY}`;
  const unit = (batch: string, key: string, arms: string, tc: string, folder: string, extra = '') => `s4-run.ps1 -Checkout ${K} -Root ${R} -Batch ${batch} -Key ${key} -Arms ${arms} -Toolchain ${tc} -Folder ${R}/${folder} -Seeds 1 -Attempt 1${extra} -FakeAgent ${F}`;
  const smoke = unit('smoke', 'effort', 'O1,S0,S1,S2,S4,S5', 'node', 'smoke/w1', ' -MaxPosition 1');
  const pilot = [unit('pilot', 'k1', 'O1,S1,S2', 'python', 'pilot/k1-p1'), unit('pilot', 'k2', 'O1,S1,S2', 'node', 'pilot/k2-p1'),
    unit('effort', 'effort', 'O1,S1', 'node', 'effort/low-p1', ' -MaxPosition 1 -Effort low'), unit('effort', 'effort', 'O1,S1', 'node', 'effort/high-p1', ' -MaxPosition 1 -Effort high')];
  const folders = ['pilot/k1-p1', 'pilot/k2-p1', 'effort/low-p1', 'effort/high-p1'];
  const pinsOf = (f: string) => (f.startsWith('effort') ? `pins-r4-effort-${f.slice(7, -3)}.json` : 'pins-r4.json');
  const tail = (ledger: string, more = '') => `--attempt 1 --approved 2140 --ledger-total ${ledger} --spend-basis ${R}/spend-basis.json --pins ${R}/pins-r4.json --log ${R}/budget-log.jsonl${more}`;
  const units = (b: string, keys: string[], n: number) => keys.map((k) => `--units ${R}/${b}/${k}-w${n}`).join(' ');
  const [wp, b1] = [plans ? ['k1', 'k2'].map((k) => `--whole-plan ${R}/whole-plan/${k}/plan.json`).join(' ') : `--whole-plan ${R}/whole-plan/<k>/plan.json`,`--read-set ${R}/batch1/read-set.txt --prices ${R}/prices.json --grading ${R}/batch1/grading.json --drop-list ${R}/batch1/drop-list.json`];
  const lv = `--levels ${R}/levels/pre-freeze.json --levels ${R}/levels/batch-1.json`;
  const poll = `--poll 1 --fake ${F}`;
  return {
    plans: [`z0-pins-check.mjs --manifest-check ${R}/tasks`, ...['k1', 'k2'].map((k) => `ab-run.mjs --tasks ${R}/tasks/${k}/tasks-run.json --out ${R}/whole-plan/${k} --design r4 --seeds 3 --dry-run`), `z0-pins-check.mjs --manifest ${R}/whole-plan`],
    smoke: [pins, `${smoke} -PlanOnly`, `z0-budget.mjs admit --step smoke --units ${R}/smoke/w1 --plans ${R}/smoke/w1/dry/plan.json ${tail('<L>')}`, smoke,
      `g1-pins.mjs --run ${R}/smoke/w1/run --pins ${R}/pins-r4.json --plan-of ${R}/smoke/w1/run --out ${R}/smoke/w1/off-pin.json --strict`],
    1: [pins, ...pilot.map((l) => `${l} -PlanOnly`),
      `z0-budget.mjs admit --step pilot ${folders.map((f) => `--units ${R}/${f}`).join(' ')} ${folders.map((f) => `--plans ${R}/${f}/dry/plan.json`).join(' ')} --warmups <warmups> ${tail('<L>')}`, ...pilot,
      ...folders.map((f) => `g1-pins.mjs --run ${R}/${f}/run --pins ${R}/${pinsOf(f)} --plan-of ${R}/${f}/run --out ${R}/${f}/off-pin.json`),
      `z0-pilot.mjs --runs ${R}/pilot/k1-p1/run/runs.jsonl --plan ${R}/pilot/k1-p1/run/plan.json --runs ${R}/pilot/k2-p1/run/runs.jsonl --plan ${R}/pilot/k2-p1/run/plan.json `
      + `--effort-run low:${R}/effort/low-p1/run --effort-run high:${R}/effort/high-p1/run ${folders.map((f) => `--off-pin ${R}/${f}/off-pin.json`).join(' ')} --prices ${R}/prices.json `
      + `--spend-basis ${R}/spend-basis.json --pilot-tasks ${R}/pilot-tasks --pins ${R}/pins-r4.json --ledger-total <L> --pilot-spend <P> --attempt 1 --tag <tag> --out ${R}/pilot.json`],
    2: [pins, `z0-size.mjs --design r4-on-r3 --power --cost-ratio <r> --levels ${R}/levels/pre-freeze.json --runs ${R}/r3/runs.jsonl --plan ${R}/r3/plan.json --prices ${R}/r3/prices.json --r3-unblind ${R}/r3/unblind.stdout `
      + `--grading ${R}/r3/grading.json --drop-list ${R}/r3/drop-list.json ${wp}`, `z0-budget.mjs admit --step whole-run ${units('batch1', BATCH1, 1)} ${tail('<L>', ` --pilot ${R}/pilot.json`)}`],
    3: [pins, `z0-budget.mjs admit --step batch-1 ${units('batch1', BATCH1, 1)} ${tail('<L>', ` --pilot ${R}/pilot.json --mark ${R}/batch1/ADMITTED`)}`, `s4-batch.sh 1 ${K} ${R} ${poll}`,
      `z0-size.mjs --design r4 --batch1-block ${b1} ${wp} --key ${R}/blind-key.json --out ${R}/batch1/block.json`],
    4: [pins, `z0-size.mjs --design r4 --level-check ${b1} ${wp} --pre-levels ${R}/levels/pre-freeze.json --out ${R}/levels/batch-1.json`,
      `z0-size.mjs --design r4 --power ${b1} ${wp} ${lv} --cost-ratio <r> --spend-basis ${R}/spend-basis.json --r3-unblind ${R}/r3/unblind.stdout`],
    5: [pins, `z0-size.mjs --design r4 --seed-rule-preview ${b1} ${wp} ${lv} --cost-ratio <r> --spend-basis ${R}/spend-basis.json --out ${R}/seed-preview.json`,
      `z0-budget.mjs admit --step batch-2 ${units('batch2', BATCH2, 1)} --seed-preview ${R}/seed-preview.json ${tail('<L>', ` --pilot ${R}/pilot.json --mark ${R}/batch2/ADMITTED`)}`, `s4-batch.sh 2 ${K} ${R} ${poll}`],
    6: [pins, `z0-read-set.mjs --root ${R} --batches 1,2 --out ${R}/seed/read-set.txt`, `z0-hookhold.mjs --design r4 --runs <runs> --sensitivity ${R}/seed/drop-list.json`,
      `z0-grading-combine.mjs --grading <g5>/run/grading.json --out ${R}/seed/grading.json`,
      `z0-seed-rule.mjs --design r4 --read-set ${R}/seed/read-set.txt --prices ${R}/prices.json --grading ${R}/seed/grading.json --drop-list ${R}/seed/drop-list.json --cost-ratio <r> ${lv} --out ${R}/seed-rule.json`,
      `z0-budget.mjs admit --step seeds ${units('raise', [...BATCH1, ...BATCH2], 2)} --seed-rule ${R}/seed-rule.json --seal ${R}/raise/max-seed.json ${tail('<L>', ` --pilot ${R}/pilot.json --mark ${R}/raise/ADMITTED`)}`,
      `s4-batch.sh raise ${K} ${R} ${poll}`],
    7: [pins, `s4-read.sh ${K} ${R}`, `s4-read.sh ${K} ${R} --unblind`],
    8: [pins, `z0-budget.mjs report --log ${R}/budget-log.jsonl --ledger-total <L> --approved 2140 --pins ${R}/pins-r4.json --pilot ${R}/pilot.json --stopped <id> --step <step>`],
    'stage-checks': [pins, `z0-size.mjs --check-levels ${R}/levels/pre-freeze.json`, `git -C ${K} diff --stat 04835462b HEAD -- src extensions`],
  };
}

let printed: Promise<{ c: DriveCase; got: Record<string, Run> }> | undefined;
/** `--print` of every step on one case, run once and shared by the two print cases. */
const printAll = () => (printed ??= (async () => {
  const c = new DriveCase(w, 'print');
  const got: Record<string, Run> = {};
  for (const step of Object.keys(expectedPrint(c))) got[step] = await c.run(step, ['--print']);
  return { c, got };
})());
afterAll(async () => (await printed)?.c.cleanup());

/** A case ready for step 3 or later: the pilot file, the whole-run plans and the entries of the earlier steps. */
const ready = (name: string, ...done: string[]) => {
  const c = mk(name);
  c.pilot();
  c.wholePlans();
  for (const step of done) c.plant({ step, exit: 0 });
  return c;
};
const wait = (what: string, test: () => boolean) => until(what, test, 120_000);
/** A held stub runner gives up by itself after this many seconds, so a test that never releases it cannot hang forever. */
const HELD = { Z0_STUB_HOLD_S: '120' };
/** True once the output of a started call holds a line that matches. */
const sawLine = (s: Started, line: RegExp) => line.test(read(s.outFile).replace(/\r/g, ''));
/** A live bash that the process listing reads as an `s4-drive.sh` or `s4-batch.sh` of the case's root, as `bash <role>.sh 1 <checkout> <root> <stop file>`; returns its Windows pid. */
async function standIn(c: DriveCase, role: 's4-drive' | 's4-batch', tag = '') {
  const file = `${c.dir}/${role}-shaped${tag}/${role}.sh`;
  const pidFile = `${c.dir}/${role}-shaped${tag}/stop.pid`;
  put(file, '#!/usr/bin/env bash\nPATH=/usr/bin:/mingw64/bin:$PATH\ncat /proc/$$/winpid > "$4.pid"\nuntil [ -f "$4" ]; do sleep 0.5; done\n');
  c.orphan(file, ['1', c.checkout, c.root, `${c.dir}/${role}-shaped${tag}/stop`]);
  await wait(`the ${role}-shaped process`, () => existsSync(pidFile) && /^\d+/.test(read(pidFile)));
  return Number(read(pidFile).trim());
}
/** The `<role> <path>` of each listing line, with the pids left out, so a bash wrapper and its forks read as one. */
const rolesOf = (text: string) => new Set(text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '').map((l) => l.trim().split(' ').slice(1).join(' ')));
/** The pid of each listing line. */
const pidsOf = (text: string) => text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '').map((l) => Number(l.trim().split(' ')[0]));
/** The creation time of a live process as UTC ticks, read the way s4-drive.sh reads its own. */
function ticksOf(pid: number) {
  const out = ps(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToUniversalTime().Ticks`)?.stdout.trim() ?? '';
  if (!/^\d+$/.test(out)) throw new Error(`no creation time for pid ${pid}: ${out}`);
  return out;
}
/** A batch-shaped bash whose parent link is dead, as the batch of a driver has (a Git Bash exec leaves a dead process above it). Once told, it sources s4-units.sh as the batch does and prints the listing of the case's root with Z0_DRIVER_WINPID and Z0_DRIVER_STARTED set to `named` and `started`. */
async function batchCaller(c: DriveCase, tag: string) {
  const dir = `${c.dir}/${tag}-caller`;
  const call = `${dir}/call`;
  put(`${dir}/s4-batch.sh`, [
    '#!/usr/bin/env bash', 'PATH=/usr/bin:/mingw64/bin:$PATH', 'export Z0_CHECKOUT=$2', 'touch "$4.up"',
    'until [ -f "$4.go" ]; do sleep 0.2; done', 'named=$(< "$4.named")', 'started=$(< "$4.started")', 'unset Z0_DRIVER_WINPID Z0_DRIVER_STARTED',
    '[ -z "$named" ] || export Z0_DRIVER_WINPID=$named', '[ -z "$started" ] || export Z0_DRIVER_STARTED=$started',
    '. "$5/s4-units.sh"', 'if units_scan; then root_lines "$3" > "$4.part"; else echo "scan failed: $UNITS_ERR" > "$4.part"; fi', 'mv "$4.part" "$4.out"', '',
  ].join('\n'));
  put(`${dir}/start.sh`, '#!/usr/bin/env bash\nbash "$@" < /dev/null > /dev/null 2>&1 &\n');
  c.orphan(`${dir}/start.sh`, [`${dir}/s4-batch.sh`, '1', c.checkout, c.root, call, c.scored]);
  await wait(`the ${tag} caller`, () => existsSync(`${call}.up`));
  return async (named?: number | string, started?: string) => {
    put(`${call}.named`, named === undefined ? '' : String(named));
    put(`${call}.started`, started ?? '');
    put(`${call}.go`, '');
    await wait(`the ${tag} caller's listing`, () => existsSync(`${call}.out`));
    return read(`${call}.out`);
  };
}

describe.skipIf(!HAVE)('the driver: needs win32, PowerShell 5.1, Git Bash and the round 4 poetry folder', () => {
  it('1. --print gives each step\'s command lines, runs nothing, logs nothing, and runs beside a live driver', async () => {
    const { c, got } = await printAll();
    for (const [step, want] of Object.entries(expectedPrint(c))) {
      expect(got[step]!.code, step).toBe(0);
      expect(got[step]!.lines, step).toEqual(want);
    }
    for (const f of ['drive-log.jsonl', 'drive.log', 'stubs.log', 'budget-log.jsonl', 'smoke', 'pilot', 'effort', 'batch1']) expect(existsSync(`${c.root}/${f}`), f).toBe(false);
    expect(existsSync(`${c.knobs}/calls.jsonl`)).toBe(false);
    const live = ready('print-live', '3');
    live.cliKnob('z0-size', [{ hangMs: 120_000 }]);
    live.start('4');
    await wait('the live driver\'s first CLI call', () => live.stubCalls('z0-size').length > 0);
    const beside = await live.run('3', ['--print']);
    expect(outcome(beside)).toEqual([0, ...expectedPrint(live, true)['3']!]);
  }, 300_000);

  it('2. every --flag the --print lines pass is in that CLI\'s real usage, and every -Param is in the real s4-run.ps1 param block', async () => {
    const { got } = await printAll();
    const usage = new Map<string, string>();
    const params = new Set([...readFileSync(`${LAUNCH}/s4-run.ps1`, 'utf8').match(/^param\(([\s\S]*?)\n\)/m)![1]!.matchAll(/\$(\w+)/g)].map((m) => m[1]!));
    const seen = new Set<string>();
    for (const [step, run] of Object.entries(got)) {
      for (const line of run.lines.filter((l) => !l.startsWith('git '))) {
        const [name, ...args] = line.split(' ');
        const flags = args.filter((a) => /^--[a-z]/.test(a));
        for (const p of args.filter((a) => /^-[A-Z]/.test(a)).map((a) => a.slice(1))) expect(params.has(p), `${step}: -${p} is not in s4-run.ps1's param block`).toBe(true);
        if (name!.endsWith('.sh')) {
          // s4-read.sh belongs to slice R1; its flags are checked once its file is in the tree.
          if (existsSync(`${LAUNCH}/${name}`)) for (const f of flags) expect(hasFlag(readFileSync(`${LAUNCH}/${name}`, 'utf8'), f), `${step}: ${f} for ${name}`).toBe(true);
        } else if (name!.endsWith('.mjs')) {
          if (!usage.has(name!)) {
            const r = spawnSync(process.execPath, [`${REPO}/scripts/token-eval/${name}`], { encoding: 'utf8', cwd: w.base });
            usage.set(name!, `${r.stdout}${r.stderr}`);
          }
          for (const f of flags) expect(hasFlag(usage.get(name!)!, f), `${step}: ${f} for ${name}`).toBe(true);
        }
        seen.add(name!);
      }
    }
    expect([...seen].sort()).toEqual(['ab-run.mjs', 'g1-pins.mjs', 's4-batch.sh', 's4-read.sh', 's4-run.ps1', 'z0-budget.mjs', 'z0-grading-combine.mjs', 'z0-hookhold.mjs', 'z0-pilot.mjs', 'z0-pins-check.mjs',
      'z0-read-set.mjs', 'z0-seed-rule.mjs', 'z0-size.mjs']);
    expect([...params].sort()).toEqual(['Arms', 'Attempt', 'BoxCheck', 'Batch', 'Checkout', 'DryRun', 'Effort', 'FakeAgent', 'Folder', 'Key', 'MaxPosition', 'MaxSeed', 'OnlySeed', 'PlanOnly', 'Retry', 'Root', 'SeedRule',
      'Seeds', 'Toolchain', 'TokenSchedule', 'TokenVar'].sort());
  }, 120_000);

  it('3. one byte added to a pinned script stops smoke, steps 1 to 8 and stage-checks at the pins check, and plans, founder-go, cause and --print still run', async () => {
    const c = mk('pins');
    c.stubPlans();
    c.pilot();
    const before = sha(readFileSync(`${c.scored}/s4-batch.sh`));
    appendFileSync(`${c.scored}/s4-batch.sh`, '\n');
    const line = `PINS: s4-batch is pinned ${before}, this file has ${sha(readFileSync(`${c.scored}/s4-batch.sh`))}`;
    const steps = ['smoke', '1', '2', '3', '4', '5', '6', '7', '8', 'stage-checks'];
    for (const step of steps) expect(outcome(await c.run(step)), step).toEqual([3, line]);
    expect(c.entries()).toEqual(steps.map((step) => c.entry({ step, exit: 3, stopId: 'pins', line })));
    expect((await c.run('plans')).code).toBe(0);
    expect(outcome(await c.run('founder-go', ['--question', 'figure', '--figure', '2600', '--words', 'raise it']))).toEqual([0, 'founder-go figure logged at $2600.00']);
    expect(outcome(await c.run('cause', ['--kind', 'other', '--words', 'nothing to explain']))).toEqual([1, 'DRIVE: cause needs a smoke or step 1 failure to explain']);
    expect((await c.run('smoke', ['--print'])).code).toBe(0);
    expect(c.entries().slice(steps.length).map((e) => e.step)).toEqual(['plans', 'founder-go']);
  }, 400_000);

  it('4. order and terminal wiring: step 4 with no step 3, step 7 after a step 6 at 6, and a planted g2 refusing smoke and step 5 while plans, --print and step 8 run', async () => {
    const c = mk('order');
    c.pilot();
    expect(outcomeOf(c, await c.run('4'))).toEqual([3, 'DRIVE: step 4 needs step 3 at 0']);
    c.plant({ step: '6', exit: 6, stopId: 'cap', line: 'CAP: max-seed 3 of 9' });
    expect((await c.run('7')).code).toBe(0);
    expect(stubArgv(c, 's4-read')).toEqual([[c.checkout, c.root], [c.checkout, c.root, '--unblind']]);
    expect(c.entries()).toEqual([c.entry({ step: '4', exit: 3, stopId: 'order', line: 'DRIVE: step 4 needs step 3 at 0' }), c.entry({ step: '6', exit: 6, stopId: 'cap', line: 'CAP: max-seed 3 of 9' }), c.entry({ step: '7', exit: 0 })]);

    const t = mk('terminal');
    t.stubPlans();
    t.plant({ step: '3', exit: 3, stopId: 'g2', line: 'STOP: G2 failed' });
    t.plant({ step: '4', exit: 0 });
    const stopped = 'DRIVE: the run stopped at g2; no claim';
    expect(outcomeOf(t, await t.run('smoke'))).toEqual([3, stopped]);
    expect(outcomeOf(t, await t.run('5'))).toEqual([3, stopped]);
    expect(t.entries().slice(2)).toEqual([t.entry({ step: 'smoke', exit: 3, stopId: 'order', line: stopped }), t.entry({ step: '5', exit: 3, stopId: 'order', line: stopped })]);
    expect((await t.run('plans')).code).toBe(0);
    expect((await t.run('smoke', ['--print'])).code).toBe(0);
    const eight = await t.run('8');
    expect(outcomeOf(t, eight)).toEqual([0, 'stopped: g2 at step 3', 'pilot: none', 'effort: medium', 'headline: none, the run stopped at g2', 'total: $0.00 against approved $2140.00']);
  }, 300_000);

  it('5. after a planted exit 5, step 5 exits 3 until a real figure go, then runs', async () => {
    const c = ready('figure', '4');
    c.scale();
    c.plant({ step: '5', exit: 5, stopId: 'batch2-figure', line: 'STOP: batch 2 needs $2200.00; approved $2140.00; no claim unless the founder raises the figure' });
    c.cliKnob('z0-size', [{ write: { [`${c.root}/seed-preview.json`]: JSON.stringify({ schema: 'z0-seed-preview/1', countsByArm: { O1: 3, S1: 3, S2: 3, S5: 3 } }) } }]);
    const line = 'DRIVE: batch2-figure needs a figure go';
    expect(outcomeOf(c, await c.run('5', ['--approved', '2600']))).toEqual([3, line]);
    const go = await c.run('founder-go', ['--question', 'figure', '--figure', '2600', '--words', 'the founder raised the figure']);
    expect(outcome(go)).toEqual([0, 'founder-go figure logged at $2600.00']);
    expect(c.budget()).toEqual([{ kind: 'founder-go', question: 'figure', figure: 2600, attempt: null, stop: false, words: 'the founder raised the figure', at: expect.any(String) }]);
    expect(c.entries().slice(-2)).toEqual([c.entry({ step: '5', exit: 3, stopId: 'order', line }), c.entry({ step: 'founder-go', exit: 0, question: 'figure', figure: 2600, stop: false, line: 'founder-go figure logged at $2600.00' })]);
    expect((await c.run('5', ['--approved', '2600'])).code).toBe(0);
    expect(c.admits().map((a) => [a.step, a.approved, a.admitted])).toEqual([['batch-2', 2600, true]]);
    expect(stubArgv(c, 's4-batch')).toEqual([['2', c.checkout, c.root, '--poll', '1', '--fake', `${c.knobs}/fake.json`]]);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: '5', exit: 0 }));

    const s = mk('founder-stop');
    expect(outcome(await s.run('founder-go', ['--question', 'power', '--stop', '--words', 'the founder stops']))).toEqual([0, 'founder-go power logged with stop']);
    expect(s.entries()).toEqual([s.entry({ step: 'founder-go', exit: 0, question: 'power', stop: true, stopId: 'founder-stop', line: 'founder-go power logged with stop' })]);
    expect(outcomeOf(s, await s.run('smoke'))).toEqual([3, 'DRIVE: the run stopped at founder-stop; no claim']);
  }, 300_000);

  it('6. a smoke failure needs a cause: refused until one, a version cause needs a new claudeVersion, step 1 needs a smoke at 0 on the tag with the current pins, other needs freeze-2, no-version ends the run', async () => {
    const c = mk('cause');
    c.plant({ step: 'smoke', exit: 3, stopId: 'smoke-fail', line: 'STOP: smoke failed' });
    const needs = 'DRIVE: smoke needs a cause entry after the failure at smoke attempt 1';
    expect(outcomeOf(c, await c.run('smoke', ['--attempt', '2']))).toEqual([3, needs]);
    expect(outcome(await c.run('cause', ['--kind', 'version', '--words', 'a new version']))).toEqual([0, 'cause version logged for smoke attempt 1']);
    expect(c.log().filter((l) => l.startsWith('cause '))).toEqual(['cause version words: a new version']);
    expect(c.entries().slice(1)).toEqual([c.entry({ step: 'smoke', attempt: 2, exit: 3, stopId: 'order', line: needs }), c.entry({ step: 'cause', exit: 0, kind: 'version', failedStep: 'smoke', line: 'cause version logged for smoke attempt 1' })]);
    const same = 'DRIVE: a version cause needs a new claudeVersion; pins-r4.json still names 9.9.9';
    expect(outcomeOf(c, await c.run('smoke', ['--attempt', '2']))).toEqual([3, same]);
    c.writePins({ claudeVersion: '9.9.10' });
    const noSmoke = 'DRIVE: step 1 needs a smoke at 0 on z0-r4-freeze-1 with the current pins';
    expect(outcomeOf(c, await c.run('1', ['--attempt', '2']))).toEqual([3, noSmoke]);
    const smoke = await c.run('smoke', ['--attempt', '2']);
    expect(smoke.code, smoke.out).toBe(0);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: 'smoke', attempt: 2, exit: 0, claudeVersion: '9.9.10' }));
    const one = await c.run('1', ['--attempt', '2']);
    expect(one.code, one.out).toBe(0);
    expect(c.stubCalls('z0-pilot')).toHaveLength(1);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: '1', attempt: 2, exit: 0, claudeVersion: '9.9.10' }));

    const other = mk('cause-other');
    other.plant({ step: 'smoke', exit: 3, stopId: 'smoke-fail' });
    expect((await other.run('cause', ['--kind', 'other', '--words', 'a different cause'])).lines).toEqual(['cause other logged for smoke attempt 1']);
    expect(outcomeOf(other, await other.run('smoke', ['--attempt', '2']))).toEqual([3, 'DRIVE: an other-cause failure needs z0-r4-freeze-2']);

    const none = mk('cause-none');
    none.plant({ step: 'smoke', exit: 3, stopId: 'smoke-fail' });
    const stop = 'STOP: no Claude Code version passes the pin checks; no claim';
    expect(outcome(await none.run('cause', ['--kind', 'no-version', '--words', 'none left']))).toEqual([3, stop]);
    expect(none.entries().at(-1)).toEqual(none.entry({ step: 'cause', exit: 3, stopId: 'no-version', kind: 'no-version', failedStep: 'smoke', line: stop }));
    expect(outcomeOf(none, await none.run('smoke', ['--attempt', '2']))).toEqual([3, 'DRIVE: the run stopped at no-version; no claim']);
  }, 600_000);

  it('7. step 8 writes report.txt: after no-version with no pilot, after read-invalid with a pilot, and not at all with neither', async () => {
    const a = mk('report-a');
    a.plant({ step: 'cause', exit: 3, stopId: 'no-version', kind: 'no-version', failedStep: 'smoke' });
    put(`${a.root}/report.txt`, 'stale\n');
    const want = ['stopped: no-version at step smoke', 'pilot: none', 'effort: medium', 'headline: none, the run stopped at no-version', 'total: $0.00 against approved $2140.00'];
    expect(outcomeOf(a, await a.run('8'))).toEqual([0, ...want]);
    expect(lines(`${a.root}/report.txt`)).toEqual(want);
    expect(a.entries().at(-1)).toEqual(a.entry({ step: '8', exit: 0, line: want.at(-1)! }));

    const b = mk('report-b');
    b.pilot();
    b.plant({ step: '7', exit: 3, stopId: 'read-invalid' });
    const second = ['stopped: read-invalid at step 7', 'pilot: $3.50 against $40', 'r S1: 1', 'r S2: 1', 'effort: medium', 'headline: none, the run stopped at read-invalid', 'total: $0.00 against approved $2140.00'];
    expect(outcomeOf(b, await b.run('8'))).toEqual([0, ...second]);
    expect(lines(`${b.root}/report.txt`)).toEqual(second);

    const none = mk('report-none');
    expect(outcomeOf(none, await none.run('8'))).toEqual([3, 'DRIVE: step 8 needs step 7 at 0 or a terminal stop']);
    expect(existsSync(`${none.root}/report.txt`)).toBe(false);
  }, 300_000);

  it('8. a stop-like line at exit 0 logs no stop id; a step command at exit 2 logs fault and ends the driver at 1', async () => {
    const c = ready('stoplike', '3');
    c.cliKnob('z0-size', [{ stdout: 'STOP: a stop-like line' }]);
    expect(outcomeOf(c, await c.run('4'))).toEqual([0, 'STOP: a stop-like line', 'STOP: a stop-like line']);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: '4', exit: 0, line: 'STOP: a stop-like line' }));
    const f = ready('fault', '3');
    f.cliKnob('z0-size', [{ exit: 2, stdout: 'boom' }]);
    const line = 'DRIVE: step 4 fault: z0-size exit 2: boom';
    expect(outcomeOf(f, await f.run('4'))).toEqual([1, 'boom', line]);
    expect(f.entries().at(-1)).toEqual(f.entry({ step: '4', exit: 1, stopId: 'fault', line }));
  }, 300_000);

  it('9. --approved 2600 with no figure go stops the smoke at the admit with the budget\'s own line', async () => {
    const c = mk('over');
    const r = await c.run('smoke', ['--approved', '2600']);
    const line = '--approved 2600 is above $2,140.00 and no founder go names it';
    expect(outcome(r).slice(-2)).toEqual([line, `DRIVE: smoke fault: z0-budget exit 1: ${line}`]);
    expect(r.code).toBe(1);
    expect(c.entries()).toEqual([c.entry({ step: 'smoke', exit: 1, stopId: 'fault', line: `DRIVE: smoke fault: z0-budget exit 1: ${line}` })]);
    expect(c.launches()).toEqual([]);
  }, 300_000);

  it('10. input refusals exit 1 and log nothing', async () => {
    const c = mk('inputs');
    const real = c.realRoot();
    const fake = `${c.knobs}/fake.json`;
    const refused = async (step: string, extra: string[], line: string, o: Parameters<DriveCase['run']>[2] = {}) => expect(outcome(await c.run(step, extra, { raw: true, ...o })), `${step} ${extra.join(' ')}`).toEqual([1, line]);
    await refused('smoke', [], `DRIVE: ${c.root} is a DRYRUN root; pass --fake <knobs>`);
    await refused('smoke', ['--fake', fake], `DRIVE: --fake is for a DRYRUN root; ${real} has no DRYRUN file`, { root: real });
    await refused('6', ['--rule', fake], `DRIVE: --rule and --level-sims are for a DRYRUN root; ${real} has no DRYRUN file`, { root: real });
    await refused('4', ['--level-sims', '5'], `DRIVE: --rule and --level-sims are for a DRYRUN root; ${real} has no DRYRUN file`, { root: real });
    await refused('plans', [], `DRIVE: Z0_DRIVE_STUBS is set, but ${real} holds no DRYRUN file; only a dry root may use it`, { root: real });
    await refused('plans', [], `DRIVE: Z0_BOX_CHECK is set, but ${real} holds no DRYRUN file; only a dry root may use it`, { root: real, env: { Z0_DRIVE_STUBS: undefined, Z0_BOX_CHECK: fake } });
    await refused('plans', [], `DRIVE: Z0_BOX_CHECK ${c.dir}/nope.sh is not a file`, { env: { Z0_BOX_CHECK: `${c.dir}/nope.sh` } });
    put(`${c.dir}/box check.sh`, '');
    await refused('plans', [], `DRIVE: Z0_BOX_CHECK ${c.dir}/box check.sh holds a space or a single quote, which the launcher command cannot carry`, { env: { Z0_BOX_CHECK: `${c.dir}/box check.sh` } });
    await refused('plans', [], 'DRIVE: Z0_GRACE_S abc must be a whole number of seconds', { env: { Z0_GRACE_S: 'abc' } });
    await refused('plans', [], `DRIVE: root ${c.dir}/nope is not a folder`, { root: `${c.dir}/nope` });
    const usage = await c.run('smoke', ['--attempt', '0']);
    expect(usage.code).toBe(1);
    expect(usage.lines[0]).toBe('usage: s4-drive.sh <plans|smoke|1|2|3|4|5|6|7|8|founder-go|cause|stage-checks> <checkout> <root> [--approved <usd>] [--fake <knobs>] [--attempt <n>] [--poll <s>] [--level-sims <n>] [--rule <file>] [--print]');
    for (const dir of [c.root, real]) for (const f of ['drive-log.jsonl', 'drive.log', 'budget-log.jsonl']) expect(existsSync(`${dir}/${f}`), `${dir}/${f}`).toBe(false);
  }, 300_000);

  it('11. a checkout that is untagged, has moved off its tag or has changes stops the smoke at the tag rule', async () => {
    const un = mk('untagged', makeCheckout(w.base, 'untagged-co', false));
    const head = un.entry({ step: 'smoke', exit: 3 }).commit!;
    const line = `DRIVE: smoke must run on z0-r4-freeze-1; HEAD is ${head}`;
    expect(outcome(await un.run('smoke'))).toEqual([3, line]);
    expect(un.entries()).toEqual([un.entry({ step: 'smoke', exit: 3, stopId: 'tag', tag: null, line })]);

    const moved = mk('moved', makeCheckout(w.base, 'moved-co'));
    git(moved.checkout, 'commit', '--allow-empty', '-qm', 'moved off the tag');
    const line2 = `DRIVE: smoke must run on z0-r4-freeze-1; HEAD is ${moved.entry({ step: 'smoke', exit: 3 }).commit}`;
    expect(outcome(await moved.run('smoke'))).toEqual([3, line2]);
    expect(moved.entries()).toEqual([moved.entry({ step: 'smoke', exit: 3, stopId: 'tag', line: line2 })]);

    const dirty = mk('dirty');
    put(`${w.checkout}/stray.txt`, 'x');
    try {
      const line3 = `DRIVE: smoke must run on a clean z0-r4-freeze-1; ${w.checkout} has changes`;
      expect(outcome(await dirty.run('smoke'))).toEqual([3, line3]);
      expect(dirty.entries()).toEqual([dirty.entry({ step: 'smoke', exit: 3, stopId: 'tag', line: line3 })]);
    } finally {
      rmSync(`${w.checkout}/stray.txt`, { force: true });
    }
  }, 300_000);

  it('12. steps 3 and 5 log one admit before their batch\'s first unit folder and none after it exists; step 2 then refuses', async () => {
    const c = ready('admit-once', '2');
    const labels = 'BATCH 1 LABELS: fill the labels files';
    c.script('s4-batch', [{ make: [`${c.root}/batch1/q12-w1/run`], exit: 7, stdout: labels }]);
    for (let i = 0; i < 2; i++) expect((await c.run('3')).code).toBe(7);
    expect(c.admits().map((a) => [a.step, a.units, a.admitted, a.reason])).toEqual([['batch-1', BATCH1.map((k) => `${k}-w1`), true, null]]);
    expect(c.entries().slice(1)).toEqual([2, 2].map(() => c.entry({ step: '3', exit: 7, stopId: 'labels', line: labels })));
    expect(stubArgv(c, 's4-batch')).toHaveLength(2);
    const before = c.entries().length;
    expect(outcomeOf(c, await c.run('2'))).toEqual([3, 'DRIVE: step 2 runs before batch 1 starts']);
    expect(c.entries()).toHaveLength(before);

    const five = ready('admit-once-5', '4');
    five.scale();
    five.cliKnob('z0-size', [{ write: { [`${five.root}/seed-preview.json`]: JSON.stringify({ schema: 'z0-seed-preview/1', countsByArm: { O1: 3, S1: 3, S2: 3, S5: 3 } }) } }]);
    five.script('s4-batch', [{ make: [`${five.root}/batch2/qa-w1/run`], exit: 7, stdout: 'BATCH 2 LABELS: fill the labels files' }]);
    for (let i = 0; i < 2; i++) expect((await five.run('5')).code).toBe(7);
    expect(five.admits().map((a) => [a.step, a.units])).toEqual([['batch-2', BATCH2.map((k) => `${k}-w1`)]]);
    expect(five.stubCalls('z0-size')).toHaveLength(1);
    expect(stubArgv(five, 's4-batch')).toHaveLength(2);
  }, 400_000);

  it('13. step 6 seals the raise through the real admit and calls it; with the seal present it runs no seed rule and no admit, and exits from the sealed file', async () => {
    const c = ready('raise', '5');
    c.scale();
    c.g5Done();
    const rule = `${c.dir}/rule.json`;
    put(rule, JSON.stringify({ schema: 'z0-seed-rule/2', seeds: { O1: 9, S1: 9, S2: 9, S5: 9 } }));
    c.cliKnob('z0-read-set', [{ write: { [`${c.root}/seed/read-set.txt`]: `--runs ${c.root}/batch1/q12-w1/run/runs.jsonl --plan ${c.root}/batch1/q12-w1/run/plan.json\n` } }]);
    const cap = 'CAP: max-seed 3 of 9';
    const args = ['--rule', rule, '--approved', '100'];
    // The first call prints the cap twice: the admit's refusal line, then the verdict read from the sealed file.
    const first = await c.run('6', args);
    expect([first.code, ...first.lines.slice(-2)]).toEqual([6, cap, cap]);
    expect(read(`${c.root}/raise/max-seed.json`)).toBe('{"maxSeed":3,"count":9}\n');
    expect(c.entries().at(-1)).toEqual(c.entry({ step: '6', exit: 6, stopId: 'cap', line: cap }));
    expect(c.admits().map((a) => [a.step, a.admitted, a.reason, a.maxSeed])).toEqual([['seeds', false, 'cap', 3]]);
    expect(stubArgv(c, 'z0-hookhold')).toEqual([['--design', 'r4', '--runs', `${c.root}/batch1/q12-w1/run/runs.jsonl`, '--sensitivity', `${c.root}/seed/drop-list.json`]]);
    expect(stubArgv(c, 'z0-grading-combine')).toEqual([[...[...BATCH1.map((k) => `batch1/${k}-w1`), ...BATCH2.map((k) => `batch2/${k}-w1`)].flatMap((f) => ['--grading', `${c.root}/${f}/run/grading.json`]), '--out', `${c.root}/seed/grading.json`]]);
    expect(stubArgv(c, 'z0-seed-rule')).toHaveLength(1);
    expect(stubArgv(c, 's4-batch')).toEqual([['raise', c.checkout, c.root, '--poll', '1', '--fake', `${c.knobs}/fake.json`]]);
    expect(await c.run('6', args)).toMatchObject({ code: 6, last: cap });
    expect(c.admits()).toHaveLength(1);
    for (const name of ['z0-read-set', 'z0-hookhold', 'z0-grading-combine', 'z0-seed-rule']) expect(stubArgv(c, name), name).toHaveLength(1);
    expect(stubArgv(c, 's4-batch')).toHaveLength(2);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: '6', exit: 6, stopId: 'cap', line: cap }));
  }, 400_000);

  it('14. a batch that exits 1 and a read that exits 1 log fault, not batch-failed or read-invalid, and the step runs again', async () => {
    const c = ready('batch-fault', '2');
    const end = 'BATCH 1 END FAILED: z0-ledger exit 1';
    const fault = `DRIVE: step 3 fault: s4-batch exit 1: ${end}`;
    c.script('s4-batch', [{ make: [`${c.root}/batch1/q12-w1/run`], exit: 1, stdout: end }, {}]);
    const first = await c.run('3');
    expect([first.code, ...first.lines.slice(-2)]).toEqual([1, end, fault]);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: '3', exit: 1, stopId: 'fault', line: fault }));
    expect((await c.run('3')).code).toBe(0);
    expect(stubArgv(c, 's4-batch')).toHaveLength(2);
    expect(c.admits()).toHaveLength(1);

    const r = ready('read-fault', '6');
    const miss = `READ: ${r.root}/levels/batch-1.json is missing`;
    r.script('s4-read', [{ exit: 1, stdout: miss }, {}]);
    const a = await r.run('7');
    const line = `DRIVE: step 7 fault: s4-read exit 1: ${miss}`;
    expect(outcomeOf(r, a)).toEqual([1, miss, line]);
    expect(r.entries().at(-1)).toEqual(r.entry({ step: '7', exit: 1, stopId: 'fault', line }));
    expect((await r.run('7')).code).toBe(0);
    expect(stubArgv(r, 's4-read')).toEqual([[r.checkout, r.root], [r.checkout, r.root], [r.checkout, r.root, '--unblind']]);
  }, 300_000);

  it('15. smoke: the plan-only call, one admit, one launch, g1-pins --strict, exit 0; attempt 2 runs a second admit', async () => {
    const c = mk('smoke');
    const unit = `${c.root}/smoke/w1`;
    c.cliKnob('g1-pins', [{ stdout: 'g1-pins ok' }]);
    const r = await c.run('smoke');
    expect(r.code, r.out).toBe(0);
    expect(r.last).toBe('g1-pins ok');
    expect(c.launcherCalls(unit)).toEqual(['plan', 'launch']);
    expect(c.launcherArgs(unit)).toEqual({ Checkout: c.checkout, Root: c.root, Batch: 'smoke', Key: 'effort', Arms: 'O1,S0,S1,S2,S4,S5', Toolchain: 'node', Folder: unit, Seeds: '1', Attempt: '1', MaxPosition: '1', FakeAgent: `${c.knobs}/fake.json` });
    expect(c.launches()).toEqual(['w1']);
    expect(c.admits()).toEqual([{ kind: 'admit', step: 'smoke', attempt: 1, units: ['w1'], pinsSha256: c.pinsSha(), approved: 2140, ledgerBefore: 0, projection: expect.any(Number), ownProjection: expect.any(Number), scale: 1, margin: 1,
      cap: null, capSpend: null, admitted: true, reason: null, maxSeed: null, at: expect.any(String) }]);
    expect(stubArgv(c, 'g1-pins')).toEqual([['--run', `${unit}/run`, '--pins', `${c.root}/pins-r4.json`, '--plan-of', `${unit}/run`, '--out', `${unit}/off-pin.json`, '--strict']]);
    expect(stubArgv(c, 'z0-ledger')).toEqual([]);
    expect(c.stubLog(), 'the driver logs each stub it runs in place of a real CLI').toEqual(['stub g1-pins']);
    expect(c.entries()).toEqual([c.entry({ step: 'smoke', exit: 0, line: 'g1-pins ok' })]);
    expect((await c.run('smoke', ['--attempt', '2'])).code).toBe(0);
    expect(c.admits().map((a) => [a.attempt, a.units, a.ledgerBefore])).toEqual([[1, ['w1'], 0], [2, ['w2'], 1]]);
    expect(stubArgv(c, 'z0-ledger')).toEqual([['--design', 'r4', '--prices', `${c.root}/prices.json`, '--run', `${unit}/run`]]);
  }, 300_000);

  it('16. a smoke whose launcher is killed after run pid while its runner finishes: the driver waits on the scan, then reads the finished folder', async () => {
    const c = mk('launcher-killed');
    const unit = `${c.root}/smoke/w1`;
    // The runner stays up until the test releases it, so a slow box cannot end it before the checks below.
    const release = `${c.root}/release-runner.txt`;
    c.knob('w1', { fixture: w.fx, plan: w.plan, release });
    const s = c.start('smoke', [], { env: HELD });
    await wait('the runner', () => c.runnerPids('smoke').length === 1 && c.log().some((l) => l.startsWith('launch w1 pid ')));
    const [launcher, runner] = [c.launcherPid('w1'), c.runnerPids('smoke')[0]!];
    c.kill(launcher);
    await sleep(2500);
    expect([isAlive(launcher), isAlive(runner), c.stubCalls('g1-pins').length]).toEqual([false, true, 0]);
    put(release, '');
    const r = await s.done;
    expect(r.code, r.out).toBe(0);
    expect([isAlive(runner), existsSync(`${unit}/run/exit.txt`), lines(`${unit}/run.log`).some((l) => l.startsWith('Records: '))]).toEqual([false, false, true]);
    expect(stubArgv(c, 'g1-pins').map((a) => a[1])).toEqual([`${unit}/run`]);
  }, 300_000);

  it('17. a smoke runner that ends with neither a Records: line nor complete records is a fault naming the unit, and the smoke again retries in w1-a2 with no admit', async () => {
    const c = mk('no-records');
    c.knob('w1', { fixture: w.fx, plan: w.plan, records: 1, printRecords: false, exit: 1 });
    const line = 'DRIVE: smoke unit w1 failed, runner exit 1';
    const first = await c.run('smoke');
    expect([first.code, first.last]).toEqual([1, line]);
    expect(c.entries()).toEqual([c.entry({ step: 'smoke', exit: 1, stopId: 'fault', line })]);
    const second = await c.run('smoke');
    expect(second.code, second.out).toBe(0);
    const retry = `${c.root}/smoke/w1-a2`;
    expect(c.launches()).toEqual(['w1', 'w1-a2']);
    expect(c.launcherArgs(retry)).toMatchObject({ Folder: retry, Retry: '2', Attempt: '1', Batch: 'smoke' });
    expect(c.launcherCalls(retry)).toEqual(['launch']);
    expect(c.admits()).toHaveLength(1);
    expect(stubArgv(c, 'g1-pins').map((a) => a[1])).toEqual([`${retry}/run`]);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: 'smoke', exit: 0 }));
  }, 300_000);

  it('18. step 1: one failed unit leaves the other three running; the next call runs one cap-only admit and the retry alone, and z0-pilot names the retry; a retry that does not fit under $40 stops at 4', async () => {
    const c = mk('pilot');
    await c.doneUnit(`${c.root}/smoke/w1`);
    c.plant({ step: 'smoke', exit: 0 });
    c.knob('k2-p1', { fixture: w.fx, plan: w.plan, records: 1, printRecords: false, exit: 1 });
    const failed = 'DRIVE: step 1 unit k2-p1 failed, runner exit 1';
    const first = await c.run('1');
    expect([first.code, first.last]).toEqual([1, failed]);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: '1', exit: 1, stopId: 'fault', line: failed }));
    expect(c.launches()).toEqual(['k1-p1', 'k2-p1', 'low-p1', 'high-p1']);
    expect(c.admits().map((a) => a.units)).toEqual([['k1-p1', 'k2-p1', 'low-p1', 'high-p1']]);
    const second = await c.run('1');
    expect(second.code, second.out).toBe(0);
    const retry = `${c.root}/pilot/k2-p1-a2`;
    expect(c.admits().map((a) => [a.units, a.cap, a.capSpend, a.admitted])).toEqual([[['k1-p1', 'k2-p1', 'low-p1', 'high-p1'], 40, 0, true], [['k2-p1-a2'], 40, 1, true]]);
    expect(c.launches()).toEqual(['k1-p1', 'k2-p1', 'low-p1', 'high-p1', 'k2-p1-a2']);
    expect(c.launcherCalls(retry)).toEqual(['launch']);
    expect(c.launcherArgs(retry)).toMatchObject({ Folder: retry, Retry: '2' });
    const off = ['pilot/k1-p1', 'pilot/k2-p1-a2', 'effort/low-p1', 'effort/high-p1'].flatMap((f) => ['--off-pin', `${c.root}/${f}/off-pin.json`]);
    expect(stubArgv(c, 'z0-pilot')).toEqual([['--runs', `${c.root}/pilot/k1-p1/run/runs.jsonl`, '--plan', `${c.root}/pilot/k1-p1/run/plan.json`, '--runs', `${retry}/run/runs.jsonl`, '--plan', `${retry}/run/plan.json`,
      '--effort-run', `low:${c.root}/effort/low-p1/run`, '--effort-run', `high:${c.root}/effort/high-p1/run`, ...off, '--prices', `${c.root}/prices.json`, '--spend-basis', `${c.root}/spend-basis.json`,
      '--pilot-tasks', `${c.root}/pilot-tasks`, '--pins', `${c.root}/pins-r4.json`, '--ledger-total', '1.00', '--pilot-spend', '1.00', '--attempt', '1', '--tag', TAG_1, '--out', `${c.root}/pilot.json`]]);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: '1', exit: 0 }));

    const f = mk('pilot-fit');
    await f.doneUnit(`${f.root}/smoke/w1`);
    f.plant({ step: 'smoke', exit: 0 });
    f.knob('k2-p1', { fixture: w.fx, plan: w.plan, records: 1, printRecords: false, exit: 1 });
    f.cliKnob('z0-ledger', [{ stdout: 'LEDGER 1.00' }, { stdout: 'LEDGER 1.00' }, { stdout: 'LEDGER 39.99' }]);
    expect((await f.run('1')).code).toBe(1);
    const stop = await f.run('1');
    const refused = f.admits()[1]!;
    const line = `FOUNDER: the pilot projects $${money(39.99 + (refused.projection ?? 0))} at r = 2, above its $40 budget: go on or stop`;
    expect([stop.code, stop.last]).toEqual([4, line]);
    expect(refused).toMatchObject({ units: ['k2-p1-a2'], capSpend: 39.99, admitted: false, reason: 'cap' });
    expect(f.entries().at(-1)).toEqual(f.entry({ step: '1', exit: 4, stopId: 'pilot-40', line }));
    expect(f.launches()).toEqual(['k1-p1', 'k2-p1', 'low-p1', 'high-p1']);
    expect(existsSync(`${f.root}/pilot/k2-p1-a2`)).toBe(false);
  }, 600_000);

  it('19. a driver killed mid-phase, mid-batch or with a finished runner that hangs: the next call waits on the scan, launches nothing twice and runs the step', async () => {
    const pilot = async (name: string, knob: (root: string) => Knob) => {
      const c = mk(name);
      await c.doneUnit(`${c.root}/smoke/w1`);
      c.plant({ step: 'smoke', exit: 0 });
      c.knob('k1-p1', { fixture: w.fx, plan: w.plan, ...knob(c.root) });
      return c;
    };
    // The runner stays up until the test has seen the next driver wait on it, so a slow restart cannot outlast it.
    const live = await pilot('kill-live', (root) => ({ release: `${root}/release-runner.txt` }));
    const first = live.start('1', [], { env: HELD });
    await wait('the pilot runner', () => live.runnerPids('pilot').length === 1);
    const runner = live.runnerPids('pilot')[0]!;
    killOwnTree(first.child);
    await first.done;
    expect(isAlive(runner)).toBe(true);
    const restartedLive = live.start('1');
    await wait('the next driver waiting on the runner', () => sawLine(restartedLive, new RegExp(`^DRIVE: waiting for ${runner} ab-run$`, 'm')));
    put(`${live.root}/release-runner.txt`, '');
    const again = await restartedLive.done;
    expect(again.code, again.out).toBe(0);
    expect(again.lines).toContain(`DRIVE: waiting for ${runner} ab-run`);
    expect(live.launcherCalls(`${live.root}/pilot/k1-p1`)).toEqual(['plan', 'launch']);
    // The three units the dead driver never launched go through the cap-only admit, as every first launch after the first phase does (W4-47).
    expect(live.admits().map((a) => [a.units, a.cap, a.capSpend, a.admitted])).toEqual([[['k1-p1', 'k2-p1', 'low-p1', 'high-p1'], 40, 0, true], [['k2-p1', 'low-p1', 'high-p1'], 40, 1, true]]);

    const batch = ready('kill-batch', '2');
    // The batch holds until the test has seen the next driver wait on it, so a slow restart cannot outlast it.
    const release = `${batch.root}/release-batch.txt`;
    batch.script('s4-batch', [{ make: [`${batch.root}/batch1/q12-w1/run`], holdUntil: release }, {}]);
    const running = batch.start('3');
    await wait('the batch', () => batch.stubCalls('s4-batch').length === 1);
    // The child of start() is Git's bash.exe wrapper; the driver proper is the pid its call line names, and killing only that leaves its fork and the batch alive.
    batch.kill(batch.driverPid());
    await running.done;
    const restarted = batch.start('3');
    await wait('the next driver waiting on the batch', () => sawLine(restarted, /^DRIVE: waiting for \d+ s4-batch$/m));
    put(release, '');
    const next = await restarted.done;
    expect(next.code, next.out).toBe(0);
    expect(next.lines.filter((l) => /^DRIVE: waiting for \d+ s4-batch$/.test(l)).length).toBeGreaterThan(0);
    expect(batch.admits()).toHaveLength(1);
    expect(stubArgv(batch, 's4-batch')).toHaveLength(2);

    const hung = await pilot('kill-hang', () => ({ hang: true }));
    const third = hung.start('1');
    await wait('the Records line', () => lines(`${hung.root}/pilot/k1-p1/run.log`).some((l) => l.startsWith('Records: ')));
    const hang = hung.runnerPids('pilot')[0]!;
    killOwnTree(third.child);
    await third.done;
    const restart = await hung.run('1');
    expect(restart.code, restart.out).toBe(0);
    expect(restart.lines).toContain(`DRIVE: waiting for ${hang} ab-run`);
    expect(hung.log()).toContain(`k1-p1 finished but did not exit, stopping pid ${hang}`);
    expect([isAlive(hang), hung.launcherCalls(`${hung.root}/pilot/k1-p1`)]).toEqual([false, ['plan', 'launch']]);
  }, 600_000);

  it('20. orphans: a second driver on one root exits 1, an orphan batch makes step 4 wait, and plans runs beside a hanging stub CLI', async () => {
    const c = ready('orphans', '3');
    c.stubPlans();
    c.cliKnob('z0-size', [{ hangMs: 120_000 }]);
    const first = c.start('4');
    await wait('the first driver\'s CLI call', () => c.stubCalls('z0-size').length > 0);
    const second = await c.run('4');
    expect(second.code).toBe(1);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]).toMatch(new RegExp(`^DRIVE: driver \\d+ already runs on ${c.root}$`));
    expect(c.entries()).toHaveLength(1);
    killOwnTree(first.child);
    await first.done;

    const o = ready('orphan-batch', '3');
    const free = `${o.root}/release-batch.txt`;
    o.script('s4-batch', [{ holdUntil: free }]);
    o.orphan(`${o.scored}/s4-batch.sh`, ['1', o.checkout, o.root, '--poll', '1']);
    await wait('the orphan batch', () => o.stubCalls('s4-batch').length === 1);
    const waiting = o.start('4');
    await wait('the driver waiting on the orphan batch', () => sawLine(waiting, /^DRIVE: waiting for \d+ s4-batch$/m));
    put(free, '');
    const after = await waiting.done;
    expect(after.code, after.out).toBe(0);
    expect(after.lines.filter((l) => /^DRIVE: waiting for \d+ s4-batch$/.test(l)).length).toBeGreaterThan(0);
    expect(o.entries().at(-1)).toEqual(o.entry({ step: '4', exit: 0 }));

    const p = mk('orphan-cli');
    p.stubPlans();
    p.cliKnob('z0-size', [{ hangMs: 60_000 }]);
    p.orphan(`${p.stubs}/z0-size.mjs`, ['--root', p.root]);
    await wait('the hanging CLI', () => p.stubCalls('z0-size').length === 1);
    const plans = await p.run('plans');
    expect(plans.code, plans.out).toBe(0);
    expect(plans.lines.some((l) => l.includes('waiting'))).toBe(false);
  }, 400_000);

  it('21. a root given as /c/..., with backslashes, a trailing slash, a lower-case drive or as a relative path reaches every command in one form; a space is refused', async () => {
    const c = mk('forms');
    c.stubPlans();
    const want = ['k1', 'k2'].map((k) => ['--tasks', `${c.root}/tasks/${k}/tasks-run.json`, '--out', `${c.root}/whole-plan/${k}`, '--design', 'r4', '--seeds', '3', '--dry-run']);
    const forms = [`/c/${c.root.slice(3)}/`, `${c.root.replace(/\//g, '\\')}\\`, `c${c.root.slice(1)}`];
    for (const [i, root] of forms.entries()) {
      const r = await c.run('plans', [], { root });
      expect(r.code, `${root}: ${r.out}`).toBe(0);
      expect(stubArgv(c, 'ab-run').slice(2 * i), root).toEqual(want);
    }
    expect(outcome(await c.run('plans', [], { root: 'root' }))).toEqual([1, 'DRIVE: root root must be an absolute path such as C:/z0-runs/r4']);
    mkdirSync(`${c.dir}/a b`);
    expect(outcome(await c.run('plans', [], { root: `${c.dir}/a b` }))).toEqual([1, `DRIVE: root ${c.dir}/a b holds a space or a single quote, which the launcher command cannot carry`]);
  }, 300_000);

  it('22. stage-checks needs HEAD at freeze-2, a dry run log whose last line starts DRY RUN PASS <HEAD>:, a passing level check and no change under src or extensions', async () => {
    const c = mk('stage', makeCheckout(w.base, 'stage-co'));
    const head = () => git(c.checkout, 'rev-parse', 'HEAD');
    // Slice D's line goes on after the commit (plan W4-38).
    const pass = (commit: string) => `DRY RUN PASS ${commit}: 10 steps, 34 forced cases, 0 paid sessions`;
    const noTag = `DRIVE: stage-checks needs HEAD at z0-r4-freeze-2; HEAD is ${head()}`;
    expect(outcomeOf(c, await c.run('stage-checks'))).toEqual([3, noTag]);
    expect(c.entries()).toEqual([c.entry({ step: 'stage-checks', exit: 3, stopId: 'tag', line: noTag })]);
    git(c.checkout, 'tag', 'z0-r4-freeze-2');
    const refuse = async (log: string | null) => {
      if (log !== null) put(`${c.root}/dryrun.log`, `${log}\n`);
      const line = `DRIVE: stage-checks needs a last line of ${c.root}/dryrun.log that starts DRY RUN PASS ${head()}:; its last line is ${log?.split('\n').at(-1) ?? 'empty'}`;
      expect(outcomeOf(c, await c.run('stage-checks'))).toEqual([3, line]);
      expect(c.entries().at(-1)).toEqual(c.entry({ step: 'stage-checks', exit: 3, stopId: 'order', tag: 'z0-r4-freeze-2', line }));
    };
    await refuse(null);
    await refuse(`DRY RUN PASS ${head()}`);
    await refuse(pass('0'.repeat(40)));
    await refuse(`${pass(head())}\nDRY RUN FAIL ${head()}: step 3`);
    expect(stubArgv(c, 'z0-size')).toEqual([]);
    put(`${c.root}/dryrun.log`, `DRY RUN FAIL ${head()}: step 3\n${pass(head())}\n`);
    c.cliKnob('z0-size', [{ stdout: 'CHECK LEVELS PASS' }]);
    expect(outcomeOf(c, await c.run('stage-checks'))).toEqual([0, 'CHECK LEVELS PASS']);
    expect(stubArgv(c, 'z0-size')).toEqual([['--check-levels', `${c.root}/levels/pre-freeze.json`]]);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: 'stage-checks', exit: 0, tag: 'z0-r4-freeze-2', line: 'CHECK LEVELS PASS' }));

    put(`${c.checkout}/src/x.ts`, 'export {};\n');
    git(c.checkout, 'add', '-A');
    git(c.checkout, 'commit', '-qm', 'a change under src');
    git(c.checkout, 'tag', '-f', 'z0-r4-freeze-2');
    c.writePins();
    put(`${c.root}/dryrun.log`, `${pass(head())}\n`);
    // git indents each stat line by one space, which the helper's trim takes off the first line.
    const changed = git(c.checkout, 'diff', '--stat', '04835462b', 'HEAD', '--', 'src', 'extensions').split('\n')[0]!;
    const fault = `DRIVE: stage-checks fault: src or extensions differ from 04835462b:  ${changed}`;
    expect(outcomeOf(c, await c.run('stage-checks'))).toEqual([1, 'CHECK LEVELS PASS', fault]);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: 'stage-checks', exit: 1, stopId: 'fault', tag: 'z0-r4-freeze-2', line: fault }));
  }, 300_000);

  it('23. after a pilot failure, a version cause and new pins, a smoke with no --attempt is refused with no launch; --attempt 2 runs, and step 1 at attempt 1 is refused too (W4-48)', async () => {
    const c = mk('fresh-attempt');
    await c.doneUnit(`${c.root}/smoke/w1`);
    c.plant({ step: 'smoke', exit: 0 });
    c.plant({ step: '1', exit: 3, stopId: 'pilot-fail', line: 'STOP: the pilot failed' });
    expect(outcome(await c.run('cause', ['--kind', 'version', '--words', 'a new version']))).toEqual([0, 'cause version logged for step 1 attempt 1']);
    c.writePins({ claudeVersion: '9.9.10' });
    // The done smoke/w1 made before the cause must not stand in for a smoke on the new pins.
    const needs = 'DRIVE: smoke needs --attempt 2 or above after the cause for attempt 1';
    expect(outcomeOf(c, await c.run('smoke'))).toEqual([3, needs]);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: 'smoke', exit: 3, stopId: 'order', claudeVersion: '9.9.10', line: needs }));
    expect([c.launches(), stubArgv(c, 'g1-pins'), existsSync(`${c.root}/smoke/w2`)]).toEqual([[], [], false]);
    const two = await c.run('smoke', ['--attempt', '2']);
    expect(two.code, two.out).toBe(0);
    expect(c.launches()).toEqual(['w2']);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: 'smoke', attempt: 2, exit: 0, claudeVersion: '9.9.10' }));
    const one = 'DRIVE: step 1 needs --attempt 2 or above after the cause for attempt 1';
    expect(outcomeOf(c, await c.run('1'))).toEqual([3, one]);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: '1', exit: 3, stopId: 'order', claudeVersion: '9.9.10', line: one }));
    expect(c.launches()).toEqual(['w2']);
  }, 400_000);

  it('24. step 1 after a launch failure and a runner failure in one phase: the next call\'s cap-only admit covers the retry and the unit that never started (W4-47)', async () => {
    const c = mk('shared-phase');
    await c.doneUnit(`${c.root}/smoke/w1`);
    c.plant({ step: 'smoke', exit: 0 });
    c.knob('k1-p1', { fixture: w.fx, plan: w.plan, records: 1, printRecords: false, exit: 1 });
    c.knob('k2-p1', { fixture: w.fx, plan: w.plan, launchExit: 3 });
    const ran = 'DRIVE: step 1 unit k1-p1 failed, runner exit 1';
    const launch = 'DRIVE: step 1 launch failed: k2-p1 the stub launch failed: exit 3';
    const first = await c.run('1');
    expect([first.code, ...first.lines.slice(-2)]).toEqual([1, ran, launch]);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: '1', exit: 1, stopId: 'fault', line: ran }));
    expect(c.launches()).toEqual(['k1-p1', 'k2-p1', 'low-p1', 'high-p1']);
    expect(existsSync(`${c.root}/pilot/k2-p1/run`)).toBe(false);
    expect(readFileSync(`${c.root}/pilot/k2-p1/launch.txt`, 'utf8')).toContain('the stub launch failed: exit 3');
    c.knob('k2-p1', { fixture: w.fx, plan: w.plan });
    const second = await c.run('1');
    expect(second.code, second.out).toBe(0);
    expect(c.admits().map((a) => [a.units, a.cap, a.capSpend, a.admitted])).toEqual([[['k1-p1', 'k2-p1', 'low-p1', 'high-p1'], 40, 0, true], [['k1-p1-a2', 'k2-p1'], 40, 1, true]]);
    expect(c.launches()).toEqual(['k1-p1', 'k2-p1', 'low-p1', 'high-p1', 'k1-p1-a2', 'k2-p1']);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: '1', exit: 0 }));
  }, 600_000);

  it('25. a unit that fails in w1, w1-a2 and w1-a3 spends its retries: the next call logs spent and launches nothing, and the call after is refused for the cause it needs', async () => {
    const c = mk('spent');
    for (const name of ['w1', 'w1-a2', 'w1-a3']) c.knob(name, { fixture: w.fx, plan: w.plan, records: 1, printRecords: false, exit: 1 });
    for (const name of ['w1', 'w1-a2', 'w1-a3']) {
      const r = await c.run('smoke');
      expect([r.code, r.last], name).toEqual([1, `DRIVE: smoke unit ${name} failed, runner exit 1`]);
    }
    expect(c.launches()).toEqual(['w1', 'w1-a2', 'w1-a3']);
    const spent = 'DRIVE: smoke retries spent: w1-a3';
    const fourth = await c.run('smoke');
    expect([fourth.code, fourth.last]).toEqual([1, spent]);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: 'smoke', exit: 1, stopId: 'fault', line: spent, spent: 'w1-a3' }));
    expect(c.launches()).toHaveLength(3);
    // The spent retries are a failure to explain, so the gate answers the next call before the driver scans again.
    const needs = 'DRIVE: smoke needs a cause entry after the failure at smoke attempt 1';
    expect(outcomeOf(c, await c.run('smoke'))).toEqual([3, needs]);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: 'smoke', exit: 3, stopId: 'order', line: needs }));
    expect(c.launches()).toHaveLength(3);
  }, 600_000);

  it('26. step 6 names the batch and the marker when a leak rerun has no done marker, and reads no grading', async () => {
    const c = ready('g5-marker', '5');
    c.scale();
    c.g5Done();
    const key = BATCH1[0]!;
    put(`${c.root}/batch1/${key}-w1/leaks.json`, JSON.stringify({ leaks: [{ sequence: 1, seed: 2 }] }));
    c.cliKnob('z0-read-set', [{ write: { [`${c.root}/seed/read-set.txt`]: `--runs ${c.root}/batch1/${key}-w1/run/runs.jsonl --plan ${c.root}/batch1/${key}-w1/run/plan.json\n` } }]);
    const line = `DRIVE: step 6: ${c.root}/batch1/done/${key}-e2 is missing; batch 1 did not finish`;
    const r = await c.run('6');
    expect([r.code, r.last]).toEqual([1, line]);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: '6', exit: 1, stopId: 'fault', line }));
    expect([stubArgv(c, 'z0-grading-combine'), c.admits()]).toEqual([[], []]);
  }, 300_000);

  it('27. smoke attempt 2 done, then a pilot failure at attempt 1 and a version cause: smoke --attempt 2 is refused with no launch, attempt 3 runs, and a later call at 3 still works (W4-48)', async () => {
    const c = mk('used-attempt');
    await c.doneUnit(`${c.root}/smoke/w2`);
    c.plant({ step: 'smoke', attempt: 2, exit: 0 });
    c.plant({ step: '1', exit: 3, stopId: 'pilot-fail', line: 'STOP: the pilot failed' });
    expect(outcome(await c.run('cause', ['--kind', 'version', '--words', 'a new version']))).toEqual([0, 'cause version logged for step 1 attempt 1']);
    c.writePins({ claudeVersion: '9.9.10' });
    // smoke/w2 predates the cause: it must not stand in for a smoke on the new pins.
    const used = 'DRIVE: smoke attempt 2 already has folders from before the cause; needs --attempt 3 or above';
    expect(outcomeOf(c, await c.run('smoke', ['--attempt', '2']))).toEqual([3, used]);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: 'smoke', attempt: 2, exit: 3, stopId: 'order', claudeVersion: '9.9.10', line: used }));
    expect([c.launches(), stubArgv(c, 'g1-pins')]).toEqual([[], []]);
    const three = await c.run('smoke', ['--attempt', '3']);
    expect(three.code, three.out).toBe(0);
    expect(c.launches()).toEqual(['w3']);
    expect(c.entries().at(-1)).toEqual(c.entry({ step: 'smoke', attempt: 3, exit: 0, claudeVersion: '9.9.10' }));
    expect((await c.run('smoke', ['--attempt', '3'])).code).toBe(0);
    expect(c.launches()).toEqual(['w3']);
  }, 400_000);

  it('28. a unit folder that holds only run.log counts as started: smoke and step 1 take the retry path and never plan over it, and the batch guards of step 2 and step 3 read it the same way', async () => {
    const s = mk('runlog-smoke');
    put(`${s.root}/smoke/w1/run.log`, 'the launcher crashed\n');
    const smoke = await s.run('smoke');
    expect(smoke.code, smoke.out).toBe(0);
    expect(s.launches()).toEqual(['w1-a2']);
    expect(s.admits()).toEqual([]);
    expect(existsSync(`${s.root}/smoke/w1/launcher-calls.txt`)).toBe(false);
    expect(s.launcherArgs(`${s.root}/smoke/w1-a2`)).toMatchObject({ Folder: `${s.root}/smoke/w1-a2`, Retry: '2', Attempt: '1' });

    const c = mk('runlog-pilot');
    await c.doneUnit(`${c.root}/smoke/w1`);
    c.plant({ step: 'smoke', exit: 0 });
    for (const f of ['pilot/k1-p1', 'pilot/k2-p1', 'effort/low-p1', 'effort/high-p1']) put(`${c.root}/${f}/dry/plan.json`, read(w.plan));
    put(`${c.root}/pilot/k1-p1/run.log`, 'the launcher crashed\n');
    const one = await c.run('1');
    expect(one.code, one.out).toBe(0);
    expect(c.launches()).toEqual(['k1-p1-a2', 'k2-p1', 'low-p1', 'high-p1']);
    expect(c.admits().map((a) => [a.units, a.cap, a.capSpend, a.admitted])).toEqual([[['k1-p1-a2', 'k2-p1', 'low-p1', 'high-p1'], 40, 0, true]]);
    expect(existsSync(`${c.root}/pilot/k1-p1/launcher-calls.txt`)).toBe(false);

    // The batch guards read the same rule as unit_started: a batch folder with only a run.log means batch 1 started.
    const b = ready('runlog-batch', '1');
    put(`${b.root}/batch1/q12-w1/run.log`, 'the launcher crashed\n');
    expect(outcomeOf(b, await b.run('2'))).toEqual([3, 'DRIVE: step 2 runs before batch 1 starts']);
    b.plant({ step: '2', exit: 0 });
    b.script('s4-batch', [{ exit: 7, stdout: 'BATCH 1 LABELS: fill the labels files' }]);
    expect((await b.run('3')).code).toBe(7);
    expect([b.admits(), stubArgv(b, 's4-batch')]).toEqual([[], [expect.any(Array)]]);
  }, 400_000);

  it('29. after a cause, a smoke and a step 1 killed after their folders exist and before their entry resume at the same attempt: admitted, nothing relaunched, outcome logged', async () => {
    const c = mk('start-owns');
    await c.doneUnit(`${c.root}/smoke/w1`);
    c.plant({ step: 'smoke', exit: 0 });
    c.plant({ step: '1', exit: 3, stopId: 'pilot-fail', line: 'STOP: the pilot failed' });
    expect(outcome(await c.run('cause', ['--kind', 'version', '--words', 'a new version']))).toEqual([0, 'cause version logged for step 1 attempt 1']);
    c.writePins({ claudeVersion: '9.9.10' });
    const at2 = (step: string) => c.entries().filter((e) => e.step === step && e.attempt === 2);

    // Each runner stays up until the test has seen the next driver wait on it, so a slow box cannot end it first.
    const smoke = `${c.root}/smoke/w2`;
    const freeSmoke = `${c.root}/release-smoke.txt`;
    c.knob('w2', { fixture: w.fx, plan: w.plan, release: freeSmoke });
    const first = c.start('smoke', ['--attempt', '2'], { env: HELD });
    await wait('the smoke runner', () => c.runnerPids('smoke').length === 1);
    const runner = c.runnerPids('smoke')[0]!;
    killOwnTree(first.child);
    await first.done;
    // The killed call left its folder and its runner, and logged no outcome.
    expect([existsSync(`${smoke}/run`), isAlive(runner), at2('smoke')]).toEqual([true, true, []]);
    const restartedSmoke = c.start('smoke', ['--attempt', '2']);
    await wait('the next smoke waiting on the runner', () => sawLine(restartedSmoke, new RegExp(`^DRIVE: waiting for ${runner} ab-run$`, 'm')));
    put(freeSmoke, '');
    const again = await restartedSmoke.done;
    expect(again.code, again.out).toBe(0);
    expect([c.launches(), c.launcherCalls(smoke), c.admits().map((a) => [a.attempt, a.units])]).toEqual([['w2'], ['plan', 'launch'], [[2, ['w2']]]]);
    expect(at2('smoke')).toEqual([c.entry({ step: 'smoke', attempt: 2, exit: 0, claudeVersion: '9.9.10' })]);
    // Each call logs its own start entry, with the fields finish() gives an outcome.
    const started = c.entry({ step: 'smoke', attempt: 2, exit: 0, stopId: 'start', claudeVersion: '9.9.10' });
    expect(c.starts()).toEqual([started, started]);

    const pilot = `${c.root}/pilot/k1-p2`;
    const freePilot = `${c.root}/release-pilot.txt`;
    c.knob('k1-p2', { fixture: w.fx, plan: w.plan, release: freePilot });
    const second = c.start('1', ['--attempt', '2'], { env: HELD });
    await wait('the pilot runner', () => c.runnerPids('pilot').length === 1);
    const pilotRunner = c.runnerPids('pilot')[0]!;
    killOwnTree(second.child);
    await second.done;
    expect([existsSync(`${pilot}/run`), isAlive(pilotRunner), at2('1')]).toEqual([true, true, []]);
    const restartedPilot = c.start('1', ['--attempt', '2']);
    await wait('the next step 1 waiting on the runner', () => sawLine(restartedPilot, new RegExp(`^DRIVE: waiting for ${pilotRunner} ab-run$`, 'm')));
    put(freePilot, '');
    const resumed = await restartedPilot.done;
    expect(resumed.code, resumed.out).toBe(0);
    expect(c.launcherCalls(pilot)).toEqual(['plan', 'launch']);
    expect(c.launches().filter((l) => l.startsWith('k1-p2'))).toEqual(['k1-p2']);
    expect(c.admits().filter((a) => a.step === 'pilot').map((a) => a.units)).toEqual([['k1-p2', 'k2-p2', 'low-p2', 'high-p2'], ['k2-p2', 'low-p2', 'high-p2']]);
    expect(at2('1')).toEqual([c.entry({ step: '1', attempt: 2, exit: 0, claudeVersion: '9.9.10' })]);
    const startOne = c.entry({ step: '1', attempt: 2, exit: 0, stopId: 'start', claudeVersion: '9.9.10' });
    expect(c.starts().filter((e) => e.step === '1')).toEqual([startOne, startOne]);
  }, 600_000);

  it('30. folders from before a cause stay refused when a fault entry sits at their attempt: a bad pin-roles line logs one before the gate runs, and smoke and step 1 at attempt 2 still launch nothing', async () => {
    const used = (step: string) => `DRIVE: ${step} attempt 2 already has folders from before the cause; needs --attempt 3 or above`;
    const refused = async (c: DriveCase, step: string, label: string) => {
      const roles = `${c.root}/pin-roles.txt`;
      const good = read(roles);
      put(roles, 'not a role line\n');
      const fault = await c.run(step, ['--attempt', '2']);
      expect([fault.code, c.entries().at(-1)], fault.out).toEqual([1, expect.objectContaining({ step, attempt: 2, exit: 1, stopId: 'fault' })]);
      put(roles, good);
      expect(outcomeOf(c, await c.run(step, ['--attempt', '2']))).toEqual([3, used(label)]);
      expect(c.entries().at(-1)).toMatchObject({ step, attempt: 2, exit: 3, stopId: 'order', line: used(label) });
      expect([c.launches(), c.starts(), c.admits(), stubArgv(c, 'g1-pins')]).toEqual([[], [], [], []]);
    };
    const smoke = mk('fault-smoke');
    await smoke.doneUnit(`${smoke.root}/smoke/w2`);
    smoke.plant({ step: 'smoke', attempt: 2, exit: 0 });
    smoke.plant({ step: '1', exit: 3, stopId: 'pilot-fail', line: 'STOP: the pilot failed' });
    expect(outcome(await smoke.run('cause', ['--kind', 'version', '--words', 'a new version']))).toEqual([0, 'cause version logged for step 1 attempt 1']);
    smoke.writePins({ claudeVersion: '9.9.10' });
    await refused(smoke, 'smoke', 'smoke');

    const pilot = mk('fault-pilot');
    await pilot.doneUnit(`${pilot.root}/smoke/w1`);
    pilot.plant({ step: 'smoke', exit: 0 });
    pilot.plant({ step: '1', exit: 3, stopId: 'pilot-fail', line: 'STOP: the pilot failed' });
    expect(outcome(await pilot.run('cause', ['--kind', 'version', '--words', 'a new version']))).toEqual([0, 'cause version logged for step 1 attempt 1']);
    pilot.writePins({ claudeVersion: '9.9.10' });
    pilot.plant({ step: 'smoke', attempt: 2, exit: 0 });
    await pilot.doneUnit(`${pilot.root}/pilot/k1-p2`);
    await refused(pilot, '1', 'step 1');
  }, 600_000);

  it('31. a batch the driver calls lists none of that driver or its forks for its root, and still lists a second driver of the root', async () => {
    const c = ready('list-own', '2');
    c.script('s4-batch', [{ make: [`${c.root}/batch1/q12-w1/run`] }]);
    put(`${c.knobs}/list-root`, '');
    const running = c.start('3');
    await wait('the stub batch\'s first listing', () => existsSync(`${c.knobs}/listed-1.txt`));
    const second = await standIn(c, 's4-drive');
    put(`${c.knobs}/list-again`, '');
    const run = await running.done;
    expect(run.code, run.out).toBe(0);
    expect(read(`${c.knobs}/listed-1.txt`).trim()).toBe('');
    const again = read(`${c.knobs}/listed-2.txt`);
    expect(rolesOf(again)).toEqual(new Set([`s4-drive ${c.root.toLowerCase()}`]));
    expect(pidsOf(again)).toContain(second);
    expect(pidsOf(again)).not.toContain(c.driverPid());
  }, 300_000);

  it('32. a live second driver of the root, one that did not call the scan, still stops the driver', async () => {
    const c = ready('list-second', '2');
    const second = await standIn(c, 's4-drive');
    put(`${c.root}/drive.log`, `01-01 00:00:00 call 3 ${c.checkout} ${c.root} attempt 1 pid ${second}\n`);
    const r = await c.run('3');
    expect([r.code, r.lines]).toEqual([1, [`DRIVE: driver ${second} already runs on ${c.root}`]]);
    expect(c.entries()).toHaveLength(1);
  }, 300_000);

  it('33. Z0_DRIVER_WINPID and Z0_DRIVER_STARTED hide only a live s4-drive.sh bash with that creation time, with its wrapper and forks; another process, a dead pid, a bad value or no creation time hides nothing', async () => {
    const c = mk('list-var');
    const driver = await standIn(c, 's4-drive');
    const batch = await standIn(c, 's4-batch');
    const root = c.root.toLowerCase();
    const driverTicks = ticksOf(driver);
    // Pid and ticks: a dead pid, a bad number, a negative one, none; the batch stand-in and this test's node with their own exact ticks, so only the argv and image rules refuse them; the driver with no usable ticks.
    const bad: [number | string | undefined, string | undefined][] = [
      [undefined, undefined], ['', ''], ['abc', '1'], ['12abc', '1'], ['-1', '1'], ['0', '1'], [2_147_483_646, '1'],
      [batch, ticksOf(batch)], [process.pid, ticksOf(process.pid)], [driver, undefined], [driver, ''], [driver, 'abc'],
    ];
    const callers = await Promise.all(Array.from({ length: bad.length + 1 }, (_, i) => batchCaller(c, `v${i}`)));
    const both = new Set([`s4-drive ${root}`, `s4-batch ${root}`]);
    // The pids are read as well as the roles, because the live callers are batch-shaped too and would keep the batch role listed if the batch stand-in were hidden.
    for (const [i, [pid, started]] of bad.entries()) {
      const label = `Z0_DRIVER_WINPID=${String(pid)} Z0_DRIVER_STARTED=${String(started)}`;
      const text = await callers[i]!(pid, started);
      expect(rolesOf(text), label).toEqual(both);
      expect(pidsOf(text), label).toEqual(expect.arrayContaining([driver, batch]));
    }
    // The driver stand-in with its own creation time is dropped, and the batch stand-in stays.
    const hidden = pidsOf(await callers[bad.length]!(driver, driverTicks));
    expect(hidden).toContain(batch);
    expect(hidden).not.toContain(driver);
  }, 600_000);

  it('35. a live s4-drive.sh bash is never hidden by a creation time that is not its own, as the process that reuses the pid of a dead driver would not be', async () => {
    const c = mk('list-reused');
    const first = await standIn(c, 's4-drive');
    const callers = await Promise.all([0, 1, 2].map((i) => batchCaller(c, `r${i}`)));
    const later = await standIn(c, 's4-drive', '-later');
    const [firstTicks, laterTicks] = [ticksOf(first), ticksOf(later)];
    // The bash made before the callers, named with the ticks of one made after it and of one made before it; the bash made after the callers, named with the ticks of the first.
    const cases: [number, string][] = [[first, laterTicks], [first, ticksOf(process.pid)], [later, firstTicks]];
    for (const [i, [pid, started]] of cases.entries()) expect(pidsOf(await callers[i]!(pid, started)), `pid ${pid} named with ticks ${started}`).toContain(pid);
  }, 600_000);

  it('34. Z0_BOX_CHECK on a dry root reaches every launcher call of smoke and step 1, the plan-only ones included, and is absent without it', async () => {
    const c = mk('box-check');
    const box = `${c.dir}/box-ok.sh`;
    put(box, '#!/usr/bin/env bash\nexit 0\n');
    c.cliKnob('g1-pins', [{ stdout: 'g1-pins ok' }]);
    const env = { Z0_BOX_CHECK: box };
    const [smoke, pilot] = [await c.run('smoke', [], { env }), await c.run('1', [], { env })];
    expect([smoke.code, pilot.code], smoke.out + pilot.out).toEqual([0, 0]);
    const folders = ['smoke/w1', 'pilot/k1-p1', 'pilot/k2-p1', 'effort/low-p1', 'effort/high-p1'].map((f) => `${c.root}/${f}`);
    for (const folder of folders) {
      expect(c.launcherCalls(folder), folder).toEqual(['plan', 'launch']);
      expect(c.launcherArgs(folder).BoxCheck, folder).toBe(box);
    }
    const off = mk('box-check-off');
    expect((await off.run('smoke')).code).toBe(0);
    expect(off.launcherArgs(`${off.root}/smoke/w1`)).not.toHaveProperty('BoxCheck');
  }, 600_000);
});
