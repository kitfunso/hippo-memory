#!/usr/bin/env node
// Z0 lesson sources (stage 2 plan D4, prereg 50-52, 64): the one transform from a maintainer's line to a rule, the fixed reasons, the template list.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The one published transform: drop a leading list marker and ** emphasis, collapse whitespace, drop one trailing period. Wording, case and code spans stay. */
export function ruleFromSource(text) {
  // __ is left alone: Python names such as __init__ carry it.
  return text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replaceAll('**', '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
}

export const REASONS = Object.freeze({
  maintainer: "the project's maintainers require it",
  maintainerReversal: "the project's maintainers changed this rule",
});

// Prereg 52's four examples, each with the reversal a template family uses when no real rule change exists (D4).
export const TEMPLATES = Object.freeze({
  'test-flag': {
    rule: 'Run the tests with `{command}`, not the bare `{bare}`', reason: 'the bare command leaves out part of the test setup',
    reversal: 'Run the tests with `{newCommand}`; `{command}` is no longer the test command', reversalReason: 'the project changed this setup',
  },
  generated: {
    rule: 'Never edit `{path}` by hand; regenerate it with `{command}`', reason: 'the file is generated, so hand edits are lost at the next regeneration',
    reversal: 'Edit `{path}` by hand; it is no longer generated', reversalReason: 'the project changed this setup',
  },
  'changelog-fragment': {
    rule: 'Put each changelog entry in a new file under `{dir}`, never in `{file}`', reason: 'the release script builds the changelog from those files',
    reversal: 'Add changelog entries to `{file}` directly; `{dir}` is no longer used', reversalReason: 'the project changed this setup',
  },
  logger: {
    rule: 'Log through `{logger}`, never `{console}`', reason: 'the project logger keeps output consistent and filterable',
    reversal: 'Log through `{newLogger}`; `{logger}` is no longer used', reversalReason: 'the project changed this setup',
  },
});

/** A template's text with every {slot} filled; a missing or empty slot throws. */
export function fillTemplate(text, slots) {
  return text.replace(/\{(\w+)\}/g, (_, k) => {
    if (!slots || !Object.hasOwn(slots, k) || !slots[k]) throw new Error(`template slot ${k} is missing`);
    return String(slots[k]);
  });
}

/** Throw unless the lesson's rule and reason are what its source or template gives, word for word. */
export function checkLessonSource(lesson, lessonSource) {
  const reversal = Boolean(lesson.supersedes);
  if (lesson.source) {
    if (lessonSource !== 'maintainer' && !reversal) throw new Error(`lesson ${lesson.id}: a sourced root lesson belongs to a maintainer family`);
    for (const f of ['repo', 'commit', 'file', 'line', 'text']) if (!lesson.source[f]) throw new Error(`lesson ${lesson.id}: source needs ${f}`);
    const want = ruleFromSource(lesson.source.text);
    if (lesson.rule !== want) throw new Error(`lesson ${lesson.id}: rule must be its source line under the transform: "${want}"`);
    const reason = reversal ? REASONS.maintainerReversal : REASONS.maintainer;
    if (lesson.reason !== reason) throw new Error(`lesson ${lesson.id}: reason must be "${reason}"`);
    return;
  }
  if (!lesson.template) throw new Error(`lesson ${lesson.id} needs a source or a template`);
  if (lessonSource !== 'template' && !reversal) throw new Error(`lesson ${lesson.id}: a template root lesson belongs to a template family`);
  if (!Object.hasOwn(TEMPLATES, lesson.template.id)) throw new Error(`lesson ${lesson.id}: unknown template ${lesson.template.id}`);
  const t = TEMPLATES[lesson.template.id];
  const rule = fillTemplate(reversal ? t.reversal : t.rule, lesson.template.slots);
  if (lesson.rule !== rule) throw new Error(`lesson ${lesson.id}: rule must be the template filled: "${rule}"`);
  const reason = reversal ? t.reversalReason : t.reason;
  if (lesson.reason !== reason) throw new Error(`lesson ${lesson.id}: reason must be "${reason}"`);
}

/** Throw unless `source.text` is lines line..endLine of `source.file` at `source.commit` in a full clone of the repository. */
export function verifySourceLine(source, originDir) {
  const body = execFileSync('git', ['show', `${source.commit}:${source.file}`], { cwd: originDir, encoding: 'utf8', maxBuffer: 1 << 26 });
  const lines = body.split(/\r?\n/).slice(source.line - 1, source.endLine ?? source.line);
  if (lines.join('\n') !== source.text) throw new Error(`${source.repo} ${source.file}:${source.line} at ${source.commit.slice(0, 12)} does not hold the recorded text`);
}

/** Check every lesson of a tasks file; `origins` maps each source repo to a full clone. Returns the family counts by source. */
export function checkTasksSources(spec, origins) {
  const families = spec.families ?? [];
  for (const f of families) {
    for (const l of f.lessons ?? []) {
      checkLessonSource(l, f.lessonSource);
      if (!l.source) continue;
      if (!origins[l.source.repo]) throw new Error(`lesson ${l.id}: no origin clone given for ${l.source.repo}`);
      verifySourceLine(l.source, origins[l.source.repo]);
    }
  }
  const maintainer = families.filter((f) => f.lessonSource === 'maintainer').length;
  return { families: families.length, maintainer, template: families.length - maintainer };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const flag = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
  try {
    const tasks = flag('--tasks'), origins = flag('--origins');
    if (!tasks || !origins) throw new Error('usage: node scripts/token-eval/lesson-sources.mjs --tasks FILE --origins FILE (JSON: {"owner/name": "path to a full clone"})');
    console.log(JSON.stringify(checkTasksSources(JSON.parse(fs.readFileSync(tasks, 'utf8')), JSON.parse(fs.readFileSync(origins, 'utf8')))));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
