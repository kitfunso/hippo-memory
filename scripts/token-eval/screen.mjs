// Z0 family screen (prereg 66-68): A0 runs each family's teach and screen tasks, A4 the screen task with the rule written in.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openContext } from './runs.mjs';
import { runSteps } from './task.mjs';

const SCREEN_SEEDS = [1, 2];
const A0_OF = 4;
const A4_OF = 2;

/** Each screened family with its root lesson (the one nothing supersedes), sequence and root teach task. */
function screenFamilies(spec) {
  return (spec.families ?? []).filter((f) => f.screen).map((family) => {
    const root = family.lessons.find((l) => !l.supersedes);
    const sequence = spec.sequences.find((s) => s.id === family.sequence);
    const teach = sequence.tasks.find((t) => t.kind === 'teach' && t.lessonId === root.id);
    if (!teach) throw new Error(`family ${family.id}: no teach task for its root lesson ${root.id} in sequence ${sequence.id}`);
    return { family, root, sequence, teach };
  });
}

/** Per family and seed: A0 teach then screen in one run, A4 the screen task alone; every session graded by the root lesson. */
export function planScreen(spec) {
  const steps = [];
  for (const { family, root, sequence, teach } of screenFamilies(spec)) {
    const role = {
      kind: 'screen', familyId: family.id, lessonId: root.id, lessonSource: family.lessonSource,
      applyIndex: null, afterReversal: null, tasksSinceTeach: null, set: null,
    };
    const screenTask = { ...family.screen, kind: 'screen', familyId: family.id, lessonId: root.id };
    const cell = { sequence, role, runName: `screen-${family.id}` };
    for (const seed of SCREEN_SEEDS) {
      steps.push({ ...cell, seed, arm: 'A0', position: 0, taskId: teach.id, t: teach });
      steps.push({ ...cell, seed, arm: 'A0', position: 1, taskId: screenTask.id, t: screenTask });
      steps.push({ ...cell, seed, arm: 'A4', position: 0, taskId: screenTask.id, t: screenTask, taught: [root] });
    }
  }
  return steps;
}

/** Keep a family when A0 breaks its rule at least twice of 4 and A4 follows it 2 of 2; `na` counts as neither. */
export function screenVerdicts(records, spec) {
  const rows = screenFamilies(spec).map(({ family }) => {
    const mine = records.filter((r) => r.familyId === family.id);
    const count = (arm, verdict) => mine.filter((r) => r.arm === arm && r.lessons[0]?.first === verdict).length;
    const row = { familyId: family.id, a0Breaks: count('A0', 'fail'), a0Of: A0_OF, a4Follows: count('A4', 'pass'), a4Of: A4_OF };
    const bad = mine.find((r) => r.invalid);
    // An invalid or missing screen session leaves the family undecided, never kept by default.
    if (bad) return { ...row, verdict: 'undecided', reason: `${bad.taskId} ${bad.arm} seed${bad.seed}: invalid ${bad.invalid}` };
    if (mine.length !== A0_OF + A4_OF) return { ...row, verdict: 'undecided', reason: `${mine.length} of ${A0_OF + A4_OF} screen sessions recorded` };
    return { ...row, verdict: row.a0Breaks >= 2 && row.a4Follows === A4_OF ? 'kept' : 'dropped' };
  });
  const by = (v) => rows.filter((r) => r.verdict === v);
  return { families: rows, kept: by('kept').map((r) => r.familyId), dropped: by('dropped'), undecided: by('undecided') };
}

/** The screen plan as the dry run prints it, plus the families a dev file skipped. */
export function screenLines(spec, steps) {
  const lines = steps.map((st, i) => `  ${i} ${st.runName} seed${st.seed} ${st.arm} ${st.sequence.id}/${st.taskId}`);
  for (const f of spec.families ?? []) if (!f.screen) lines.push(`  skipped ${f.id}: ${f.screenNote}`);
  return lines;
}

/** Run the screen; records go to screen.jsonl and the keep and drop lists to screen.json. */
export async function runScreen(opts) {
  const ctx = await openContext({ ...opts, recordsFile: 'screen.jsonl', screen: true });
  const records = await runSteps(ctx, planScreen(opts.spec));
  const verdicts = screenVerdicts(records, opts.spec);
  fs.writeFileSync(path.join(opts.outDir, 'screen.json'), `${JSON.stringify(verdicts, null, 2)}\n`);
  return verdicts;
}
