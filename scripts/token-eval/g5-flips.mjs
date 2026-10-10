// Z0 G5 (prereg 166): the lessons and cells the regrade drops, shared by grading and the reader draw so both drop the same ones.
import * as fs from 'node:fs';
import { readRows, rowsFile } from './regrade.mjs';

/** Rows of a pass whose cell has no grade.json: refused, since dropping that cell could hide a lesson's flip. */
function assertNoOrphans(rows, entries, pass) {
  const keys = new Set(entries.map((e) => e.key));
  const orphan = [...rows.keys()].find((k) => !keys.has(k));
  if (orphan) throw new Error(`${orphan} has regrade rows but no grade.json (${pass}); restore it from the run before grading`);
}

/** `[lessonId, sha]` of each checker behind the latest done post-fix rows; two versions for one lesson are refused, since no single fix gave those verdicts. */
export function postfixCheckers(rows) {
  const byLesson = new Map();
  for (const row of rows.values()) {
    if (row.status !== 'done') continue;
    for (const c of row.checks) {
      if (!byLesson.has(c.lessonId)) byLesson.set(c.lessonId, new Map());
      const cells = byLesson.get(c.lessonId);
      cells.set(c.checkerSha, (cells.get(c.checkerSha) ?? new Set()).add(row.key));
    }
  }
  for (const [id, cells] of byLesson) {
    if (cells.size === 1) continue;
    const rest = [...cells.values()].sort((a, b) => b.size - a.size).slice(1).flatMap((keys) => [...keys]);
    throw new Error(`the post-fix rows hold ${cells.size} versions of the checker for ${id}: ${rest.length} cells were graded by another version than most (${rest.slice(0, 5).join(', ')}); run regrade --post-fix with no --cell, so one version grades every cell`);
  }
  return [...byLesson].map(([id, cells]) => [id, cells.keys().next().value]);
}

/** Flips from every row each cell ever wrote, so a re-run cannot erase one; errors from the latest row refuse unless --flip-errors drops their lessons. */
export function flipsOf(out, entries, flipErrors) {
  const passes = fs.existsSync(rowsFile(out, 'postfix')) ? ['repro', 'postfix'] : ['repro'];
  const flipped = new Set();
  const accepted = new Set();
  const unrepro = { cells: new Set(), lessons: new Set() };
  const extra = new Set();
  const errors = [];
  for (const pass of passes) {
    const { rows, history } = readRows(rowsFile(out, pass));
    assertNoOrphans(rows, entries, pass);
    if (pass === 'postfix') postfixCheckers(rows);
    for (const e of entries) {
      const row = rows.get(e.key);
      if (!row) throw new Error(`cell ${e.key} has no ${pass} row; run regrade${pass === 'postfix' ? ' --post-fix' : ''} first`);
      for (const old of history.get(e.key)) {
        for (const c of old.checks) if (c.flip) flipped.add(c.lessonId);
        if (old.acceptance?.flip) accepted.add(e.key);
      }
      for (const k of row.extraEnvKeys ?? []) extra.add(k);
      if (row.status !== 'error') continue;
      errors.push(`${e.key} (${pass}, ${row.error.stage})`);
      unrepro.cells.add(e.key);
      for (const id of [row.lessonId, row.staleLessonId].filter(Boolean)) unrepro.lessons.add(id);
    }
  }
  if (errors.length && !flipErrors) throw new Error(`${errors.length} cells have error rows: ${errors.slice(0, 5).join(', ')}; re-run regrade, or pass --flip-errors to drop their lessons`);
  for (const id of unrepro.lessons) flipped.add(id);
  for (const k of unrepro.cells) accepted.add(k);
  return { pass: passes.at(-1), flipped, accepted, unrepro, extra };
}
