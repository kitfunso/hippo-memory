// G5 (prereg 166): each graded cell's trees, verdicts and reader diffs, saved before the next checkout rebuilds the workspace .git.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { agentGit } from './checks.mjs';
import { isInstructionPath, stubRefOf } from './workspace.mjs';
import { RESTORABLE } from './surfaces.mjs';
import { surfaceBytes } from './leaks.mjs';

const GRADE_REF = 'refs/z0/grade';
const SURFACE_CAP = 64 * 1024;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The memory surfaces' text at an apply's pre-session, for E3b's stored sample (179); instructions first, so the cap never cuts AGENTS.md (E6 plan R10). */
export function surfaceText({ root, surfaces, stores }) {
  const parts = [];
  for (const { e, bytes } of surfaceBytes(root, surfaces, ['instructions', ...RESTORABLE])) if (!bytes.includes(0)) parts.push(`=== ${e.path}\n${bytes.toString('utf8')}`);
  for (const s of stores) for (const e of s.entries) parts.push(`=== ${s.path}#${e.id}\n${e.content}`);
  const text = `${parts.join('\n')}\n`;
  return text.length > SURFACE_CAP ? `${text.slice(0, SURFACE_CAP)}\n[cut at ${SURFACE_CAP} chars]\n` : text;
}

/** A text diff with every instruction file left out, since one could show the reader the arm (decision 24). */
export function readerDiff(rgit, work, from, to) {
  const names = rgit(['diff', '--no-renames', '--name-only', '-z', from, to], work).split('\0').filter(Boolean);
  const hidden = names.filter(isInstructionPath).map((p) => `:(exclude,literal)${p}`);
  return rgit(['diff', '--no-ext-diff', '--no-color', '--no-textconv', '--no-renames', from, to, '--', '.', ...hidden], work);
}

/** Bundle pre, first, final and each held check commit past the stub, write both reader diffs, grade.json and an apply's surface text. */
export function saveGrading(ctx, run, step, stage, turns, record) {
  const { t, role } = step;
  const dir = path.join(ctx.outDir, 'grading', run.runName, run.arm, `seed${run.seed}`);
  fs.mkdirSync(dir, { recursive: true });
  const commits = { pre: stage.pre, first: turns?.firstPost ?? stage.finalPost, final: stage.finalPost };
  // The commits the final and stale checks graded (R2); null when that check never ran, and then not bundled (R24).
  const held = { finalCheck: turns?.finalCheckPost ?? null, stale: turns?.stalePost ?? null };
  const bundled = { ...commits, ...Object.fromEntries(Object.entries(held).filter(([, sha]) => sha !== null)) };
  const finalChecked = turns?.finalChecked ?? false;
  const work = run.dirs.work;
  agentGit(work, (rgit) => {
    const refs = Object.keys(bundled).map((k) => `${GRADE_REF}/${k}`);
    try {
      for (const [k, sha] of Object.entries(bundled)) rgit(['update-ref', '--no-deref', `${GRADE_REF}/${k}`, sha], work);
      rgit(['bundle', 'create', '--quiet', path.join(dir, `${t.id}.bundle`), ...refs, `^${stage.commit}`], work);
      const to = { first: commits.first, final: finalChecked ? held.finalCheck : commits.final };
      for (const k of ['first', 'final']) fs.writeFileSync(path.join(dir, `${t.id}.${k}.diff`), readerDiff(rgit, work, commits.pre, to[k]));
    } finally {
      for (const ref of refs) rgit(['update-ref', '-d', ref], work);
    }
  });
  const lessons = [turns?.lesson, turns?.staleLesson].filter(Boolean);
  fs.writeFileSync(path.join(dir, `${t.id}.grade.json`), `${JSON.stringify({
    sequence: run.s.id, runName: run.runName, arm: run.arm, seed: run.seed, position: step.position, order: step.order, taskId: t.id,
    kind: role.kind, lessonId: role.lessonId ?? null, staleLessonId: turns?.staleLesson?.id ?? null, stubRef: stubRefOf(run.s.id, t, run.arm), stub: stage.commit, ...commits,
    finalChecked, ...held,
    verdicts: { first: turns?.first ?? null, final: turns?.final ?? null, staleFollow: turns?.staleFollow ?? null },
    acceptancePassed: record.acceptancePassed, commandsFirst: turns?.commandsFirst ?? null, commandsFinal: turns?.commandsFinal ?? null, commandsStale: turns?.commandsStale ?? null,
    checkers: Object.fromEntries(lessons.map((l) => [l.id, sha256(fs.readFileSync(l.checkPath))])),
  }, null, 2)}\n`);
  if (stage.surfaceText !== undefined) fs.writeFileSync(path.join(dir, `${t.id}.surfaces.txt`), stage.surfaceText);
}
