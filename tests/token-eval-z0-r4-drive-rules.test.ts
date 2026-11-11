// The run driver's JSON rules (plan: Run steps after the freeze, Stop ids): the order rule, TERMINAL_STOPS, the founder-go and cause rules, the stop-id table and the drive-log entry.
// z0-drive.mjs runs in process here; tests/token-eval-z0-r4-drive.test.ts runs s4-drive.sh over it.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { FREEZE_1, FREEZE_2, REFUSALS, RESUMES, STOP_TABLE, TERMINAL_STOPS, entryOf, gate, runCli, stopIdOf } from '../scripts/token-eval/z0-drive.mjs';

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-drive-rules-'));
  roots.push(root);
  return root;
}

type Entry = ReturnType<typeof entryOf>;
const E = (over: Partial<Entry> & { step: string; exit: number }): Entry => entryOf({ attempt: 1, tag: FREEZE_1, commit: 'c1', pinsSha256: 'p1', claudeVersion: '2.1.288', ...over });
// attempt 2 is above every failure the cases log at attempt 1, so the attempt rule stays out of the way until a case aims at it.
interface Ctx { tag: string; commit: string | null; pinsSha256: string; claudeVersion: string; attempt: number }
const CTX: Ctx = { tag: FREEZE_1, commit: 'c1', pinsSha256: 'p1', claudeVersion: '2.1.288', attempt: 2 };
const refusal = (entries: Entry[], step: string, over: Partial<typeof CTX> = {}) => gate({ entries, step, ...CTX, ...over });
const OK = { ok: true, line: null };
const no = (line: string) => ({ ok: false, line });

const ALL_STEPS = ['plans', 'smoke', '1', '2', '3', '4', '5', '6', '7', '8', 'founder-go', 'cause', 'stage-checks'];
const REFUSED_AFTER_TERMINAL = ['smoke', '1', '2', '3', '4', '5', '6', '7', 'stage-checks'];

function logFile(root: string, name: string, entries: unknown[], tail = ''): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, entries.map((e) => `${JSON.stringify(e)}\n`).join('') + tail);
  return file;
}
const cli = (argv: string[]) => runCli(argv);

describe('the order rule', () => {
  it('lets plans, smoke, founder-go, cause and stage-checks run on an empty log', () => {
    for (const step of ['plans', 'smoke', 'founder-go', 'cause', 'stage-checks']) expect(refusal([], step), step).toEqual(OK);
  });

  it('refuses each numbered step until the step before it exited 0, with the line that names both', () => {
    const before = { 2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6' };
    for (const [step, prev] of Object.entries(before)) {
      expect(refusal([], step), step).toEqual(no(`DRIVE: step ${step} needs step ${prev} at 0`));
      expect(refusal([E({ step: prev, exit: 3, stopId: 'fault' })], step), `${step} after a non-zero`).toEqual(no(`DRIVE: step ${step} needs step ${prev} at 0`));
      expect(refusal([E({ step: prev, exit: 0 })], step), `${step} after 0`).toEqual(OK);
    }
  });

  it('reads the last entry of the step before, so a later non-zero entry takes the pass back and a later 0 restores it', () => {
    expect(refusal([E({ step: '3', exit: 0 }), E({ step: '3', exit: 7, stopId: 'labels' })], '4')).toEqual(no('DRIVE: step 4 needs step 3 at 0'));
    expect(refusal([E({ step: '3', exit: 7, stopId: 'labels' }), E({ step: '3', exit: 0 })], '4')).toEqual(OK);
  });

  it('does not count a tag, pins or order refusal as the outcome of the step before', () => {
    for (const id of REFUSALS) expect(refusal([E({ step: '3', exit: 0 }), E({ step: '3', exit: 3, stopId: id })], '4'), id).toEqual(OK);
  });

  it('lets step 3 follow step 2\'s exit 4 only once a later whole-run go exited 0', () => {
    const two = E({ step: '2', exit: 4, stopId: 'whole-run-r' });
    const go = (over: Partial<Entry> = {}) => E({ step: 'founder-go', exit: 0, question: 'whole-run', stop: false, ...over });
    expect(refusal([two], '3')).toEqual(no('DRIVE: whole-run-r needs a whole-run go'));
    expect(refusal([go(), two], '3'), 'a go logged before the stop').toEqual(no('DRIVE: whole-run-r needs a whole-run go'));
    expect(refusal([two, go({ exit: 1 })], '3'), 'a go that exited 1').toEqual(no('DRIVE: whole-run-r needs a whole-run go'));
    expect(refusal([two, go({ question: 'power' })], '3'), 'another question').toEqual(no('DRIVE: whole-run-r needs a whole-run go'));
    expect(refusal([two, go({ stop: true })], '3'), 'a stop answer').toEqual(no('DRIVE: whole-run-r needs a whole-run go'));
    expect(refusal([two, go()], '3')).toEqual(OK);
    expect(refusal([E({ step: '2', exit: 4, stopId: 'fault' }), go()], '3'), 'an exit 4 that is no whole-run stop still reads as a step 2 exit 4 with a go').toEqual(OK);
    expect(refusal([E({ step: '2', exit: 3, stopId: 'fault' }), go()], '3'), 'an exit 3 never follows').toEqual(no('DRIVE: step 3 needs step 2 at 0'));
  });

  it('lets step 5 follow step 4\'s exit 4 only once a later power go exited 0', () => {
    const four = E({ step: '4', exit: 4, stopId: 'power-go' });
    const go = E({ step: 'founder-go', exit: 0, question: 'power', stop: false });
    expect(refusal([four], '5')).toEqual(no('DRIVE: power-go needs a power go'));
    expect(refusal([go, four], '5')).toEqual(no('DRIVE: power-go needs a power go'));
    expect(refusal([four, go], '5')).toEqual(OK);
    expect(refusal([E({ step: '4', exit: 3, stopId: 'fault' }), go], '5')).toEqual(no('DRIVE: step 5 needs step 4 at 0'));
  });

  it('lets step 7 follow step 6\'s exit 6, and no other non-zero exit', () => {
    expect(refusal([E({ step: '6', exit: 6, stopId: 'cap' })], '7')).toEqual(OK);
    expect(refusal([E({ step: '6', exit: 3, stopId: 'batch-failed' })], '7')).toEqual(no('DRIVE: step 7 needs step 6 at 0'));
    expect(refusal([E({ step: '6', exit: 7, stopId: 'labels' })], '7')).toEqual(no('DRIVE: step 7 needs step 6 at 0'));
  });

  it('lets step 8 follow step 7 at 0 or any terminal entry, else says both', () => {
    const none = no('DRIVE: step 8 needs step 7 at 0 or a terminal stop');
    expect(refusal([], '8')).toEqual(none);
    expect(refusal([E({ step: '7', exit: 3, stopId: 'fault' })], '8')).toEqual(none);
    expect(refusal([E({ step: '7', exit: 0 })], '8')).toEqual(OK);
    expect(refusal([E({ step: '4', exit: 3, stopId: 't1-power' })], '8')).toEqual(OK);
  });
});

describe('step 1\'s smoke rule', () => {
  const smoke = (over: Partial<Entry> = {}) => E({ step: 'smoke', exit: 0, ...over });
  const cause = (over: Partial<Entry> = {}) => E({ step: 'cause', exit: 0, kind: 'version', failedStep: 'smoke', ...over });
  const line = `DRIVE: step 1 needs a smoke at 0 on ${FREEZE_1} with the current pins`;

  it('needs a smoke at 0 on the tag in force with the current pins sha256', () => {
    expect(refusal([], '1')).toEqual(no(line));
    expect(refusal([smoke()], '1')).toEqual(OK);
    expect(refusal([smoke({ tag: FREEZE_2 })], '1'), 'wrong tag').toEqual(no(line));
    expect(refusal([smoke({ pinsSha256: 'p0' })], '1'), 'old pins sha').toEqual(no(line));
    expect(refusal([smoke({ exit: 3, stopId: 'fault' })], '1')).toEqual(no(line));
    expect(refusal([smoke({ exit: 3, stopId: 'smoke-fail' })], '1'), 'an open smoke failure asks for its cause first').toEqual(no('DRIVE: step 1 needs a cause entry after the failure at smoke attempt 1'));
    expect(refusal([smoke()], '1', { tag: FREEZE_2 }), 'the tag in force moved to freeze-2').toEqual(no(`DRIVE: step 1 needs a smoke at 0 on ${FREEZE_2} with the current pins`));
  });

  it('needs the smoke logged after the last cause entry', () => {
    const fail = E({ step: 'smoke', exit: 3, stopId: 'smoke-fail', claudeVersion: '2.1.287' });
    expect(refusal([smoke(), fail, cause()], '1'), 'a smoke at 0 before the last cause').toEqual(no(line));
    expect(refusal([smoke(), fail, cause(), smoke()], '1')).toEqual(OK);
  });
});

describe('TERMINAL_STOPS', () => {
  it('lists the plan\'s eleven ids once each', () => {
    expect(TERMINAL_STOPS).toEqual(['g1-run', 'g2', 'g4', 'off-pin', 'g3', 't1-power', 'broken-design', 'read-invalid', 'no-version', 'second-failure', 'founder-stop']);
  });

  it('refuses smoke, steps 1 to 7 and stage-checks with the stopped line, and passes plans, founder-go, cause and step 8', () => {
    for (const id of TERMINAL_STOPS) {
      const entries = [E({ step: '1', exit: 0 }), E({ step: '3', exit: 3, stopId: id })];
      for (const step of REFUSED_AFTER_TERMINAL) expect(refusal(entries, step), `${id} ${step}`).toEqual(no(`DRIVE: the run stopped at ${id}; no claim`));
      for (const step of ['plans', 'founder-go', 'cause', '8']) expect(refusal(entries, step), `${id} ${step}`).toEqual(OK);
    }
  });

  it('stops the run on a terminal entry anywhere in the log, not only the last, and names the first', () => {
    const entries = [E({ step: '3', exit: 3, stopId: 'g2' }), E({ step: '4', exit: 3, stopId: 't1-power' }), E({ step: '3', exit: 0 })];
    expect(refusal(entries, 'smoke')).toEqual(no('DRIVE: the run stopped at g2; no claim'));
  });

  it('reads the terminal id and its step through the terminal command, a cause entry giving the step it explained', () => {
    const root = makeRoot();
    expect(cli(['terminal', '--root', root])).toEqual({ code: 0, stdout: '', stderr: '' });
    logFile(root, 'drive-log.jsonl', [E({ step: '3', exit: 3, stopId: 'g2' }), E({ step: '4', exit: 3, stopId: 't1-power' })]);
    expect(cli(['terminal', '--root', root])).toEqual({ code: 0, stdout: 'g2 3\n', stderr: '' });
    logFile(root, 'drive-log.jsonl', [E({ step: 'cause', exit: 3, stopId: 'no-version', kind: 'no-version', failedStep: 'smoke' })]);
    expect(cli(['terminal', '--root', root]).stdout).toBe('no-version smoke\n');
    logFile(root, 'drive-log.jsonl', [E({ step: 'founder-go', exit: 0, stopId: 'founder-stop', question: 'figure', stop: true })]);
    expect(cli(['terminal', '--root', root]).stdout).toBe('founder-stop founder-go\n');
  });
});

describe('RESUMES', () => {
  const smoke0 = E({ step: 'smoke', exit: 0 });
  const [one0, two0, four0] = [E({ step: '1', exit: 0 }), E({ step: '2', exit: 0 }), E({ step: '4', exit: 0 })];
  const none: Entry[] = [];
  // `logged` is the step that logs the stop; `at` is the step it refuses. whole-run-r and power-go refuse the step after theirs (the plan's "then step 3", "then step 5").
  const ROWS = [
    { id: 'smoke-fit', question: 'figure', logged: 'smoke', code: 3, at: 'smoke', base: none },
    { id: 'pilot-fit', question: 'figure', logged: '1', code: 3, at: '1', base: [smoke0] },
    { id: 'pilot-40', question: 'pilot', logged: '1', code: 4, at: '1', base: [smoke0] },
    { id: 'whole-run-figure', question: 'figure', logged: '2', code: 4, at: '2', base: [one0] },
    { id: 'whole-run-r', question: 'whole-run', logged: '2', code: 4, at: '3', base: [one0] },
    { id: 'batch1-fit', question: 'figure', logged: '3', code: 3, at: '3', base: [two0] },
    { id: 'power-go', question: 'power', logged: '4', code: 4, at: '5', base: none },
    { id: 'batch2-figure', question: 'figure', logged: '5', code: 5, at: '5', base: [four0] },
  ];

  it('holds the plan\'s eight rows', () => {
    expect(RESUMES).toEqual(Object.fromEntries(ROWS.map((r) => [r.id, r.question])));
  });

  it('refuses the step a resumable stop waits for until a founder go of its question is logged after the stop', () => {
    for (const { id, question, logged, code, at, base } of ROWS) {
      const stop = E({ step: logged, exit: code, stopId: id });
      const go = (over: Partial<Entry> = {}) => E({ step: 'founder-go', exit: 0, question, stop: false, figure: 2600, ...over });
      const wants = no(`DRIVE: ${id} needs a ${question} go`);
      const at_ = (...entries: Entry[]) => gate({ entries: [...base, ...entries], step: at, ...CTX });
      expect(at_(stop), `${id} before its go`).toEqual(wants);
      expect(at_(go(), stop), `${id}: a go logged before the stop does not count`).toEqual(wants);
      expect(at_(stop, go({ exit: 1 })), `${id}: a go that exited 1`).toEqual(wants);
      expect(at_(stop, go({ stop: true })), `${id}: a go that is a stop answer`).toEqual(wants);
      expect(at_(stop, go({ stop: true, stopId: 'founder-stop' })), `${id}: a founder stop ends the run`).toEqual(no('DRIVE: the run stopped at founder-stop; no claim'));
      expect(at_(stop, go({ question: question === 'figure' ? 'power' : 'figure' })), `${id}: a go of another question`).toEqual(wants);
      expect(at_(stop, go()), `${id} after its go`).toEqual(OK);
    }
  });

  it('takes a pilot go for the attempt of the stop only', () => {
    const stop = E({ step: '1', exit: 4, stopId: 'pilot-40', attempt: 2 });
    const go = (attempt: number) => E({ step: 'founder-go', exit: 0, question: 'pilot', stop: false, figure: 41, attempt });
    const entries = (g: Entry) => [E({ step: 'smoke', exit: 0 }), stop, g];
    expect(gate({ entries: entries(go(1)), step: '1', ...CTX })).toEqual(no('DRIVE: pilot-40 needs a pilot go'));
    expect(gate({ entries: entries(go(2)), step: '1', ...CTX })).toEqual(OK);
  });

  it('does not refuse a step for another step\'s stop, nor once a later entry of the step is no stop', () => {
    const stop = E({ step: 'smoke', exit: 3, stopId: 'smoke-fit' });
    expect(refusal([stop, E({ step: '1', exit: 0 })], '2')).toEqual(OK);
    expect(refusal([stop, E({ step: 'smoke', exit: 0 })], 'smoke')).toEqual(OK);
    expect(refusal([E({ step: '1', exit: 0 }), E({ step: '2', exit: 4, stopId: 'whole-run-r' })], '2'), 'step 2 itself is not held by whole-run-r').toEqual(OK);
    expect(refusal([E({ step: '4', exit: 4, stopId: 'power-go' }), E({ step: '1', exit: 0 })], '4'), 'step 4 itself is not held by power-go').toEqual(no('DRIVE: step 4 needs step 3 at 0'));
  });
});

describe('the cause rules for smoke and step 1', () => {
  const fail = (over: Partial<Entry> = {}) => E({ step: 'smoke', exit: 3, stopId: 'smoke-fail', ...over });
  const cause = (kind: string, over: Partial<Entry> = {}) => E({ step: 'cause', exit: 0, kind, failedStep: 'smoke', ...over });
  const stageChecks = (over: Partial<Entry> = {}) => E({ step: 'stage-checks', exit: 0, tag: FREEZE_2, commit: 'c2', ...over });
  const smoke2 = (entries: Entry[], over: Partial<typeof CTX> = {}) => gate({ entries, step: 'smoke', ...CTX, ...over });

  it('refuses a smoke or step 1 after a failure, a pilot failure or a spent retry with no cause entry after it', () => {
    const line = (step: string, failed: string, n: number) => no(`DRIVE: ${step} needs a cause entry after the failure at ${failed} attempt ${n}`);
    expect(smoke2([fail()])).toEqual(line('smoke', 'smoke', 1));
    expect(gate({ entries: [E({ step: 'smoke', exit: 0 }), E({ step: '1', exit: 3, stopId: 'pilot-fail', attempt: 2 })], step: '1', ...CTX })).toEqual(line('step 1', 'step 1', 2));
    expect(smoke2([E({ step: '1', exit: 1, stopId: 'fault', spent: 'pa-p1-a3' })])).toEqual(line('smoke', 'step 1', 1));
    expect(smoke2([fail(), E({ step: 'smoke', exit: 1, stopId: 'fault' })]), 'a later fault is no cause').toEqual(line('smoke', 'smoke', 1));
    expect(smoke2([cause('version'), fail()]), 'a cause logged before the failure').toEqual(line('smoke', 'smoke', 1));
  });

  it('passes a smoke after a version cause only once the pins name a new claudeVersion', () => {
    const entries = [fail(), cause('version')];
    expect(smoke2(entries)).toEqual(no('DRIVE: a version cause needs a new claudeVersion; pins-r4.json still names 2.1.288'));
    expect(smoke2(entries, { claudeVersion: '2.1.289', pinsSha256: 'p2' })).toEqual(OK);
  });

  it('refuses an other cause on freeze-1, and on freeze-2 until a stage-checks entry at 0 for this commit follows the cause', () => {
    const entries = [fail(), cause('other')];
    expect(smoke2(entries)).toEqual(no('DRIVE: an other-cause failure needs z0-r4-freeze-2'));
    expect(smoke2(entries, { tag: FREEZE_2, commit: 'c2' })).toEqual(no('DRIVE: smoke needs stage-checks at 0 on c2'));
    expect(smoke2([...entries, stageChecks({ commit: 'c1' })], { tag: FREEZE_2, commit: 'c2' }), 'a stage-checks entry for another commit').toEqual(no('DRIVE: smoke needs stage-checks at 0 on c2'));
    expect(smoke2([...entries, stageChecks({ exit: 3 })], { tag: FREEZE_2, commit: 'c2' }), 'a stage-checks entry that failed').toEqual(no('DRIVE: smoke needs stage-checks at 0 on c2'));
    expect(smoke2([stageChecks(), ...entries], { tag: FREEZE_2, commit: 'c2' }), 'a stage-checks entry before the cause').toEqual(no('DRIVE: smoke needs stage-checks at 0 on c2'));
    expect(smoke2([...entries, stageChecks()], { tag: FREEZE_2, commit: 'c2' })).toEqual(OK);
    expect(gate({ entries: [...entries, stageChecks()], step: '1', tag: FREEZE_2, commit: 'c2', pinsSha256: 'p1', claudeVersion: '2.1.288', attempt: 2 }), 'step 1 meets the same rule before its smoke rule').toEqual(no(`DRIVE: step 1 needs a smoke at 0 on ${FREEZE_2} with the current pins`));
  });

  it('never lets a null commit meet a stage-checks entry that has no commit', () => {
    const entries = [fail(), cause('other'), stageChecks({ commit: null })];
    expect(smoke2(entries, { tag: FREEZE_2, commit: null })).toEqual(no('DRIVE: smoke needs stage-checks at 0 on none'));
  });

  it('refuses a smoke or step 1 at or below the failed attempt after any cause (W4-48), and passes the next one', () => {
    const wants = (step: string, failed: number) => no(`DRIVE: ${step} needs --attempt ${failed + 1} or above after the cause for attempt ${failed}`);
    const newPins = { claudeVersion: '2.1.289', pinsSha256: 'p2' };
    const entries = [fail({ claudeVersion: '2.1.288' }), cause('version')];
    expect(smoke2(entries, { ...newPins, attempt: 1 }), 'the default attempt').toEqual(wants('smoke', 1));
    expect(smoke2(entries, { ...newPins, attempt: 2 })).toEqual(OK);
    expect(smoke2(entries, { ...newPins, attempt: 5 })).toEqual(OK);
    const second = [...entries, fail({ attempt: 2, claudeVersion: '2.1.289' }), cause('version', { attempt: 2 })];
    const thirdPins = { claudeVersion: '2.1.290', pinsSha256: 'p3' };
    expect(smoke2(second, { ...thirdPins, attempt: 2 }), 'at the failed attempt of the second failure').toEqual(wants('smoke', 2));
    expect(smoke2(second, { ...thirdPins, attempt: 3 })).toEqual(OK);
    const pilot = [E({ step: 'smoke', exit: 0 }), E({ step: '1', exit: 3, stopId: 'pilot-fail', attempt: 2 }), cause('version', { failedStep: '1' }), E({ step: 'smoke', exit: 0, attempt: 3, claudeVersion: '2.1.289', pinsSha256: 'p2' })];
    expect(gate({ entries: pilot, step: '1', ...CTX, ...newPins, attempt: 2 }), 'step 1 after a pilot failure at attempt 2').toEqual(wants('step 1', 2));
    expect(gate({ entries: pilot, step: '1', ...CTX, ...newPins, attempt: 3 })).toEqual(OK);
    const other = [fail(), cause('other'), stageChecks()];
    expect(smoke2(other, { tag: FREEZE_2, commit: 'c2', attempt: 1 }), 'an other cause is held to it too').toEqual(wants('smoke', 1));
    expect(smoke2(other, { tag: FREEZE_2, commit: 'c2', attempt: 2 })).toEqual(OK);
    expect(smoke2([fail()], { attempt: 1 }), 'no cause yet: the cause line comes first').toEqual(no('DRIVE: smoke needs a cause entry after the failure at smoke attempt 1'));
    expect(smoke2([E({ step: 'smoke', exit: 0 })], { attempt: 1 }), 'no failure, no attempt rule').toEqual(OK);
  });

  it('keeps a failure open past a cause entry that failed to log (a fault is no cause)', () => {
    const entries = [fail(), E({ step: 'cause', exit: 1, stopId: 'fault', kind: 'version', failedStep: 'smoke' })];
    expect(smoke2(entries, { claudeVersion: '2.1.289', pinsSha256: 'p2' })).toEqual(no('DRIVE: smoke needs a cause entry after the failure at smoke attempt 1'));
    const root = makeRoot();
    logFile(root, 'drive-log.jsonl', entries);
    expect(cli(['failure', '--root', root]), 'the failure command still reads it open').toEqual({ code: 0, stdout: `smoke 1 ${FREEZE_1}\n`, stderr: '' });
    expect(cli(['cause', '--root', root, '--kind', 'version']), 'and a cause can still be logged for it').toEqual({ code: 0, stdout: 'cause version logged for smoke attempt 1\n', stderr: '' });
  });

  it('takes --attempt on the gate command, refuses a missing or bad one, and reads --commit none as no commit', () => {
    const root = makeRoot();
    logFile(root, 'drive-log.jsonl', [fail(), cause('version')]);
    const gateAt = (...rest: string[]) => cli(['gate', '--root', root, '--step', 'smoke', '--tag', FREEZE_1, '--commit', 'c1', '--pins-sha256', 'p2', '--claude-version', '2.1.289', ...rest]);
    expect(gateAt('--attempt', '1')).toEqual({ code: 3, stdout: '', stderr: 'DRIVE: smoke needs --attempt 2 or above after the cause for attempt 1\n' });
    expect(gateAt('--attempt', '2')).toEqual({ code: 0, stdout: 'ok\n', stderr: '' });
    for (const bad of [[], ['--attempt', '0'], ['--attempt', 'x'], ['--attempt', '']]) expect(gateAt(...bad).code, bad.join(' ')).toBe(1);
    logFile(root, 'drive-log.jsonl', [fail(), cause('other'), stageChecks({ commit: null })]);
    const none = cli(['gate', '--root', root, '--step', 'smoke', '--tag', FREEZE_2, '--commit', 'none', '--pins-sha256', 'p1', '--claude-version', '2.1.288', '--attempt', '2']);
    expect(none, 'a commit of none matches no stage-checks entry').toEqual({ code: 3, stdout: '', stderr: 'DRIVE: smoke needs stage-checks at 0 on none\n' });
  });

  it('decides a cause through the cause command: no failure exits 1, version and other exit 0, no-version and a second other cause exit 3', () => {
    const root = makeRoot();
    const run = (kind: string) => cli(['cause', '--root', root, '--kind', kind]);
    expect(run('version')).toEqual({ code: 1, stdout: '', stderr: expect.stringMatching(/^DRIVE: cause needs a smoke or step 1 failure to explain\n/) });
    logFile(root, 'drive-log.jsonl', [E({ step: 'smoke', exit: 0 })]);
    expect(run('version').code, 'a passing smoke is no failure').toBe(1);
    logFile(root, 'drive-log.jsonl', [fail({ attempt: 2 })]);
    expect(run('version')).toEqual({ code: 0, stdout: 'cause version logged for smoke attempt 2\n', stderr: '' });
    expect(run('other')).toEqual({ code: 0, stdout: 'cause other logged for smoke attempt 2\n', stderr: '' });
    expect(run('no-version')).toEqual({ code: 3, stdout: '', stderr: 'STOP: no Claude Code version passes the pin checks; no claim\n' });
    expect(cli(['failure', '--root', root])).toEqual({ code: 0, stdout: `smoke 2 ${FREEZE_1}\n`, stderr: '' });
    logFile(root, 'drive-log.jsonl', [E({ step: '1', exit: 3, stopId: 'pilot-fail', tag: FREEZE_2, attempt: 1 })]);
    expect(run('other')).toEqual({ code: 3, stdout: '', stderr: 'STOP: the second pilot failed for another cause; no claim\n' });
    expect(run('version')).toEqual({ code: 0, stdout: 'cause version logged for step 1 attempt 1\n', stderr: '' });
    logFile(root, 'drive-log.jsonl', [fail(), cause('version')]);
    expect(run('version').code, 'a failure that already has its cause').toBe(1);
    expect(cli(['failure', '--root', root]).code).toBe(1);
    expect(cli(['cause', '--root', root, '--kind', 'maybe']).code).toBe(1);
  });
});

describe('the stop-id table', () => {
  const id = (step: string, cmd: string, exit: number, extra: Partial<Parameters<typeof stopIdOf>[0]> = {}) => stopIdOf({ step, cmd, exit, ...extra });

  it('maps each (step, command, exit) row of the plan to its id', () => {
    const rows: [string, string, number, string][] = [
      ['smoke', 'admit', 3, 'smoke-fit'], ['smoke', 'g1-pins', 3, 'smoke-fail'],
      ['1', 'admit', 3, 'pilot-fit'], ['1', 'admit', 4, 'pilot-40'], ['1', 'z0-pilot', 3, 'pilot-fail'],
      ['3', 'admit', 3, 'batch1-fit'], ['3', 's4-batch', 3, 'batch-failed'], ['3', 's4-batch', 7, 'labels'],
      ['4', 'level-check', 3, 'broken-design'], ['4', 'power', 3, 't1-power'], ['4', 'power', 4, 'power-go'],
      ['5', 'admit', 5, 'batch2-figure'], ['5', 's4-batch', 3, 'batch-failed'], ['5', 's4-batch', 7, 'labels'],
      ['6', 'admit', 6, 'cap'], ['6', 's4-batch', 3, 'batch-failed'], ['6', 's4-batch', 7, 'labels'],
      ['7', 's4-read', 3, 'read-invalid'],
    ];
    for (const [step, cmd, exit, want] of rows) expect(id(step, cmd, exit), `${step} ${cmd} ${exit}`).toBe(want);
    expect(STOP_TABLE).toHaveLength(rows.length + 3);
  });

  it('gives none for exit 0, whatever the command printed', () => {
    for (const row of STOP_TABLE) expect(id(row.step, row.cmd, 0), `${row.step} ${row.cmd}`).toBeNull();
    expect(id('3', 'admit', 0)).toBeNull();
  });

  it('gives fault for any exit a command has no row for, exit 1 included', () => {
    const rows: [string, string, number][] = [['smoke', 'admit', 1], ['smoke', 'admit', 4], ['smoke', 'g1-pins', 1], ['1', 'z0-pilot', 1], ['3', 's4-batch', 1], ['3', 's4-batch', 6], ['3', 'z0-ledger', 3],
      ['4', 'level-check', 4], ['4', 'power', 1], ['5', 'admit', 3], ['6', 'admit', 5], ['7', 's4-read', 1], ['7', 's4-read', 7], ['2', 'admit', 3], ['2', 'power-r3', 3], ['8', 'report', 1], ['plans', 'ab-run', 3]];
    for (const [step, cmd, exit] of rows) expect(id(step, cmd, exit), `${step} ${cmd} ${exit}`).toBe('fault');
  });

  it('reads step 2\'s exit 4 from the reason of the last whole-run admit entry in the budget log', () => {
    const admit = (reason: string | null, step = 'whole-run') => ({ kind: 'admit', step, reason });
    expect(id('2', 'admit', 4, { budgetLog: [admit('figure')] })).toBe('whole-run-figure');
    expect(id('2', 'admit', 4, { budgetLog: [admit('r')] })).toBe('whole-run-r');
    expect(id('2', 'admit', 4, { budgetLog: [admit('r'), admit('figure')] })).toBe('whole-run-figure');
    expect(id('2', 'admit', 4, { budgetLog: [admit('figure'), admit('r'), admit('cap', 'seeds')] }), 'only whole-run admits count').toBe('whole-run-r');
    expect(id('2', 'admit', 4, { budgetLog: [] })).toBe('fault');
    expect(id('2', 'admit', 4, { budgetLog: [admit('cap')] })).toBe('fault');
    expect(id('2', 'admit', 4, { budgetLog: [{ kind: 'founder-go', question: 'figure', step: 'whole-run' }] }), 'a founder go is no admit').toBe('fault');
  });

  it('reads the batch 1 block\'s exit 3 from the first id of block.json\'s stops, and only a terminal one', () => {
    const block = (...ids: string[]) => ({ schema: 'z0-batch1-block/1', stops: ids.map((i) => ({ id: i, line: `STOP: ${i}` })) });
    for (const stopId of ['g1-run', 'g2', 'g4', 'off-pin', 'g3']) expect(id('3', 'block', 3, { block: block(stopId, 'g3') }), stopId).toBe(stopId);
    expect(id('3', 'block', 3, { block: block() }), 'no stop listed').toBe('fault');
    expect(id('3', 'block', 3, { block: null }), 'no block file').toBe('fault');
    expect(id('3', 'block', 3, { block: block('weird') }), 'an id that is no terminal stop').toBe('fault');
    expect(id('3', 'block', 1, { block: block('g2') })).toBe('fault');
  });

  it('reads a cause step\'s exit 3 from its kind', () => {
    expect(id('cause', 'cause', 3, { kind: 'no-version' })).toBe('no-version');
    expect(id('cause', 'cause', 3, { kind: 'other' })).toBe('second-failure');
    expect(id('cause', 'cause', 3, { kind: 'version' })).toBe('fault');
  });

  it('runs through the stop-id command, which reads the budget log and block.json of the root', () => {
    const root = makeRoot();
    const sid = (step: string, cmd: string, exit: number) => cli(['stop-id', '--root', root, '--step', step, '--cmd', cmd, '--exit', String(exit)]);
    expect(sid('3', 's4-batch', 7)).toEqual({ code: 0, stdout: 'labels\n', stderr: '' });
    expect(sid('3', 'admit', 0).stdout).toBe('none\n');
    expect(sid('2', 'admit', 4).stdout, 'no log').toBe('fault\n');
    logFile(root, 'budget-log.jsonl', [{ kind: 'admit', step: 'whole-run', reason: 'r' }]);
    expect(sid('2', 'admit', 4).stdout).toBe('whole-run-r\n');
    fs.mkdirSync(path.join(root, 'batch1'));
    fs.writeFileSync(path.join(root, 'batch1', 'block.json'), JSON.stringify({ schema: 'z0-batch1-block/1', stops: [{ id: 'g4', line: 'STOP: G4' }, { id: 'g2', line: 'STOP: G2' }] }));
    expect(sid('3', 'block', 3).stdout).toBe('g4\n');
    expect(cli(['stop-id', '--root', root, '--step', '3', '--cmd', 'block', '--exit', 'x']).code).toBe(1);
    expect(cli(['stop-id', '--root', root, '--step', 'cause', '--cmd', 'cause', '--exit', '3', '--kind', 'no-version']).stdout).toBe('no-version\n');
  });
});

describe('torn last lines', () => {
  it('skips a torn last line of the drive log in every reading command', () => {
    const root = makeRoot();
    logFile(root, 'drive-log.jsonl', [E({ step: '3', exit: 3, stopId: 'g2' })], '{"step":"4","exit":3,"stopId":"t1-po');
    expect(cli(['terminal', '--root', root]).stdout).toBe('g2 3\n');
    expect(cli(['gate', '--root', root, '--step', 'smoke', '--tag', FREEZE_1, '--commit', 'c1', '--pins-sha256', 'p1', '--claude-version', '2.1.288', '--attempt', '1']))
      .toEqual({ code: 3, stdout: '', stderr: 'DRIVE: the run stopped at g2; no claim\n' });
    logFile(root, 'drive-log.jsonl', [E({ step: 'smoke', exit: 0 })], '{"step":"smoke","exit":3');
    expect(cli(['last-smoke', '--root', root]).stdout).toBe('1\n');
  });

  it('skips a whole-looking last line that has no line feed, as appendJsonLine does before it appends', () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'drive-log.jsonl'), `${JSON.stringify(E({ step: '3', exit: 3, stopId: 'g2' }))}\n${JSON.stringify(E({ step: '4', exit: 3, stopId: 't1-power' }))}`);
    expect(cli(['terminal', '--root', root]).stdout).toBe('g2 3\n');
  });

  it('skips a torn last line of the budget log, and stops on a bad line that is not the last', () => {
    const root = makeRoot();
    logFile(root, 'budget-log.jsonl', [{ kind: 'admit', step: 'whole-run', reason: 'figure' }], '{"kind":"admit","step":"whole-run","reason":"r"');
    expect(cli(['stop-id', '--root', root, '--step', '2', '--cmd', 'admit', '--exit', '4']).stdout).toBe('whole-run-figure\n');
    fs.writeFileSync(path.join(root, 'budget-log.jsonl'), `not json\n${JSON.stringify({ kind: 'admit' })}\n`);
    const bad = cli(['stop-id', '--root', root, '--step', '2', '--cmd', 'admit', '--exit', '4']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toBe(`${path.join(root, 'budget-log.jsonl')} line 1 is not JSON\n`);
  });
});

describe('the entry and the append command', () => {
  it('has the fifteen fields of the plan in order, null where unset', () => {
    expect(entryOf({ step: 3, exit: 7 })).toEqual({
      step: '3', attempt: null, exit: 7, stopId: null, line: null, tag: null, commit: null, pinsSha256: null, claudeVersion: null, question: null, figure: null, stop: null, kind: null, failedStep: null, spent: null,
    });
    expect(Object.keys(entryOf({ step: 'smoke', exit: 0 }))).toEqual(['step', 'attempt', 'exit', 'stopId', 'line', 'tag', 'commit', 'pinsSha256', 'claudeVersion', 'question', 'figure', 'stop', 'kind', 'failedStep', 'spent']);
  });

  it('writes every field to drive-log.jsonl, a line that starts with -- included, and adds to a log that already has entries', () => {
    const root = makeRoot();
    const line = '--approved 2600 is above $2,140.00 and no founder go names it';
    const r = cli(['append', '--root', root, '--step', 'founder-go', '--attempt', '2', '--exit', '1', '--stop-id', 'fault', '--line', line, '--tag', FREEZE_2, '--commit', 'abc', '--pins-sha256', 'def', '--claude-version', '2.1.288',
      '--question', 'figure', '--figure', '2600.5', '--stop', 'false', '--kind', 'version', '--failed-step', 'smoke', '--spent', 'w1-a3']);
    expect(r).toEqual({ code: 0, stdout: 'logged founder-go exit 1\n', stderr: '' });
    expect(cli(['append', '--root', root, '--step', 'plans', '--exit', '0']).code).toBe(0);
    const entries = fs.readFileSync(path.join(root, 'drive-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries).toEqual([
      { step: 'founder-go', attempt: 2, exit: 1, stopId: 'fault', line, tag: FREEZE_2, commit: 'abc', pinsSha256: 'def', claudeVersion: '2.1.288', question: 'figure', figure: 2600.5, stop: false, kind: 'version', failedStep: 'smoke', spent: 'w1-a3' },
      entryOf({ step: 'plans', exit: 0 }),
    ]);
  });

  it('drops a torn last line before it appends', () => {
    const root = makeRoot();
    logFile(root, 'drive-log.jsonl', [E({ step: 'plans', exit: 0 })], '{"step":"smo');
    cli(['append', '--root', root, '--step', 'smoke', '--exit', '0']);
    const lines = fs.readFileSync(path.join(root, 'drive-log.jsonl'), 'utf8').split('\n');
    expect(lines.map((l) => (l === '' ? l : JSON.parse(l).step))).toEqual(['plans', 'smoke', '']);
  });

  it('refuses a root that is no folder, and bad numbers, naming the flag', () => {
    const root = makeRoot();
    expect(cli(['append', '--root', path.join(root, 'nope'), '--step', 'plans', '--exit', '0']).code).toBe(1);
    expect(fs.existsSync(path.join(root, 'nope'))).toBe(false);
    for (const bad of [['--exit', 'x'], ['--attempt', '0'], ['--figure', '-1'], ['--stop', 'maybe']]) {
      const r = cli(['append', '--root', root, '--step', 'plans', ...(bad[0] === '--exit' ? [] : ['--exit', '0']), ...bad]);
      expect([r.code, r.stderr.split('\n')[0]], bad.join(' ')).toEqual([1, expect.stringContaining(`${bad[0]} ${bad[1]} is`)]);
    }
    expect(fs.existsSync(path.join(root, 'drive-log.jsonl'))).toBe(false);
  });

  it('records the entry\'s pins fields through gate flags that say none, and refuses an empty flag value', () => {
    const root = makeRoot();
    expect(cli(['gate', '--root', root, '--step', 'smoke', '--tag', 'none', '--commit', 'c1', '--pins-sha256', 'none', '--claude-version', 'none', '--attempt', '1'])).toEqual({ code: 0, stdout: 'ok\n', stderr: '' });
    expect(cli(['gate', '--root', root, '--step', 'smoke', '--tag', '', '--commit', 'c1', '--pins-sha256', 'p', '--claude-version', 'v', '--attempt', '1']).code).toBe(1);
  });
});

describe('the read commands', () => {
  it('prints the pilot\'s rMax, the sealed max seed and count, and the last smoke at 0', () => {
    const root = makeRoot();
    expect(cli(['pilot-r', '--root', root]).code, 'no pilot.json').toBe(1);
    fs.writeFileSync(path.join(root, 'pilot.json'), JSON.stringify({ schema: 'z0-pilot/1', rMax: 1.25 }));
    expect(cli(['pilot-r', '--root', root])).toEqual({ code: 0, stdout: '1.25\n', stderr: '' });
    fs.writeFileSync(path.join(root, 'pilot.json'), JSON.stringify({ schema: 'z0-pilot/1', rMax: null }));
    expect(cli(['pilot-r', '--root', root]).code, 'a null rMax').toBe(1);
    expect(cli(['max-seed', '--root', root]).code, 'no seal').toBe(1);
    fs.mkdirSync(path.join(root, 'raise'));
    fs.writeFileSync(path.join(root, 'raise', 'max-seed.json'), `${JSON.stringify({ maxSeed: 5, count: 6 })}\n`);
    expect(cli(['max-seed', '--root', root])).toEqual({ code: 0, stdout: '5 6\n', stderr: '' });
    fs.writeFileSync(path.join(root, 'raise', 'max-seed.json'), '{"maxSeed": ');
    expect(cli(['max-seed', '--root', root]).stderr).toBe(`${path.join(root, 'raise', 'max-seed.json')}: sealed file does not parse; the harness never rebuilds it\n`);
    expect(cli(['last-smoke', '--root', root]).code, 'no log').toBe(1);
    logFile(root, 'drive-log.jsonl', [E({ step: 'smoke', exit: 0, attempt: 1 }), E({ step: 'smoke', exit: 3, stopId: 'smoke-fail', attempt: 2 }), E({ step: 'smoke', exit: 0, attempt: 3 }), E({ step: 'smoke', exit: 3, stopId: 'tag', attempt: 4 })]);
    expect(cli(['last-smoke', '--root', root]).stdout).toBe('3\n');
  });

  it('prints the pilot keys without effort, sorted, and the pins file\'s sha256 and claudeVersion', () => {
    const root = makeRoot();
    expect(cli(['pilot-keys', '--root', root]).code).toBe(1);
    fs.mkdirSync(path.join(root, 'pilot-tasks'));
    fs.writeFileSync(path.join(root, 'pilot-tasks', 'repos.json'), JSON.stringify({ pb: { toolchain: 'npm' }, effort: { toolchain: 'npm' }, pa: { toolchain: 'python' } }));
    expect(cli(['pilot-keys', '--root', root])).toEqual({ code: 0, stdout: 'pa\npb\n', stderr: '' });
    expect(cli(['pins-info', '--root', root])).toEqual({ code: 0, stdout: 'none none\n', stderr: '' });
    const bytes = JSON.stringify({ effort: 'medium', claudeVersion: '2.1.288' });
    fs.writeFileSync(path.join(root, 'pins-r4.json'), bytes);
    expect(cli(['pins-info', '--root', root]).stdout).toBe(`${createHash('sha256').update(bytes).digest('hex')} 2.1.288\n`);
    fs.writeFileSync(path.join(root, 'pins-r4.json'), '{');
    expect(cli(['pins-info', '--root', root]).code).toBe(1);
  });

  it('refuses an unknown command, a missing --root and an unknown flag with its usage', () => {
    for (const argv of [[], ['nope'], ['gate'], ['pilot-r'], ['pilot-r', '--root', 'x', '--bogus', 'y']]) {
      const r = cli(argv);
      expect([r.code, r.stderr.includes('usage: z0-drive.mjs')], argv.join(' ')).toEqual([1, true]);
    }
  });

  it('lists every step the driver takes, so the gate knows them all', () => {
    for (const step of ALL_STEPS) expect(refusal([], step).ok === true || refusal([], step).line?.startsWith('DRIVE: '), step).toBe(true);
  });
});
