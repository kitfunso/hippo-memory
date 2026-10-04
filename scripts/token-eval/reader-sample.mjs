// Z0 G5 (prereg 166): the arm-blind reader sample of (diff, verdict) pairs, drawn in rounds, labelled by hand, then scored.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { git } from './exec.mjs';
import { agentGit } from './checks.mjs';
import { readerDiff } from './grading.mjs';
import { lessonIndex } from './lessons.mjs';
import { listGrades, readRows, rowsFile } from './regrade.mjs';
import { FORBIDDEN, HIDDEN_COMMAND, equalShares, fenced, fillStrata, labelsTemplate, leakScan, parseLabels, proportional, redactor, seededOrder } from './g5-draw.mjs';

const VERDICTS = ['pass', 'fail', 'na'];
const sealed = (out, name) => path.join(out, 'g5', 'sealed', name);
const keyFile = (out, k) => sealed(out, `reader-r${k}.key.json`);
const scoreFile = (out, k) => sealed(out, `reader-r${k}.score.json`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
export const fileIds = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(Math.max(2, String(count).length), '0')}`);

/** The task prompts and lesson rules a reader needs, read from the tasks file the run used (validated by the run). */
export function taskText(tasksFile) {
  const spec = readJson(tasksFile);
  const lessons = lessonIndex(spec.families ?? []);
  return {
    prompt: (sequence, taskId) => {
      const t = spec.sequences?.find((s) => s.id === sequence)?.tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`task ${sequence}/${taskId} is not in ${tasksFile}; pass the tasks file the run used`);
      return t.prompt;
    },
    lesson: (id) => {
      const hit = lessons.get(id);
      if (!hit) throw new Error(`lesson ${id} is not in ${tasksFile}; pass the tasks file the run used`);
      return hit.lesson;
    },
  };
}

/** What a blinded file must never hold: memory names and markers, every run name, arm path and seed path in the out dir. */
export function forbiddenFor(grades, extra = FORBIDDEN) {
  const names = new Set(extra);
  for (const g of grades) for (const s of [g.runName, `/${g.arm}/seed`, `seed${g.seed}/work`]) names.add(s);
  return [...names];
}

/** Every spelling of the out dir and each run root becomes `<run>`; run roots first, so no arm path survives. */
export const outRedactor = (out, grades) => redactor([...new Set(grades.map((g) => path.join(out, 'runs', g.runName, g.arm, `seed${g.seed}`))), out]);

/** Lesson ids with any flip in either pass: they are dropped anyway, so they are never sampled. */
export function flippedIn(out) {
  const flipped = new Set();
  for (const pass of ['repro', 'postfix']) for (const row of readRows(rowsFile(out, pass)).rows.values()) for (const c of row.checks) if (c.flip) flipped.add(c.lessonId);
  return flipped;
}

export const readerRounds = (out) => (fs.existsSync(sealed(out, ''))
  ? fs.readdirSync(sealed(out, '')).map((f) => /^reader-r(\d+)\.key\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b) : []);

const diffFile = (e, which) => path.join(path.dirname(e.file), `${e.grade.taskId}.${which}.diff`);

/** Each done teach or apply's main-lesson pairs with the round's verdict (saved in round 1, post-fix later); no diff and no bundle is ineligible. */
export function readerPairs(out, round) {
  const pass = round === 1 ? 'repro' : 'postfix';
  const rows = readRows(rowsFile(out, pass)).rows;
  if (rows.size === 0) throw new Error(`reader round ${round} needs ${pass} rows; run regrade${pass === 'postfix' ? ' --post-fix' : ''} first`);
  const flipped = flippedIn(out);
  const eligible = [];
  let ineligible = 0;
  for (const e of listGrades(out)) {
    const g = e.grade;
    const row = rows.get(e.key);
    if (!['teach', 'apply'].includes(g.kind) || flipped.has(g.lessonId) || row?.status !== 'done') continue;
    for (const which of g.finalChecked ? ['first', 'final'] : ['first']) {
      const verdict = round === 1 ? g.verdicts[which] : row.checks.find((c) => c.which === which && c.lessonId === g.lessonId)?.regraded;
      if (!VERDICTS.includes(verdict)) continue;
      if (fs.existsSync(diffFile(e, which)) || fs.existsSync(e.bundle)) eligible.push({ pairId: `${e.key}:${which}`, key: e.key, which, lessonId: g.lessonId, arm: g.arm, verdict, entry: e });
      else ineligible++;
    }
  }
  return { eligible, ineligible };
}

/** The saved reader diff, or the same diff rebuilt from the stub and the bundle when the file is gone (R25: final is pre..finalCheck). */
export function pairDiff(out, e, which) {
  if (fs.existsSync(diffFile(e, which))) return fs.readFileSync(diffFile(e, which), 'utf8');
  const g = e.grade;
  const dir = path.join(out, 'rg', 'diff', g.runName, g.arm, `seed${g.seed}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['fetch', '-q', '--no-tags', path.join(out, 'repo-cache', g.sequence), `+${g.stubRef}:refs/z0/stub`], dir);
  git(['fetch', '-q', '--no-tags', e.bundle, '+refs/z0/grade/*:refs/z0/grade/*'], dir);
  return agentGit(dir, (rgit) => readerDiff(rgit, dir, g.pre, which === 'first' ? g.first : g.finalCheck));
}

/** A pair's file body: prompt, rule, the commands with memory-tool ones dropped silently (R4), and the redacted diff. */
function renderPair(ctx, p) {
  const g = p.entry.grade;
  const commands = (p.which === 'first' ? g.commandsFirst : g.commandsFinal) ?? [];
  const kept = commands.filter((c) => !HIDDEN_COMMAND.test(c));
  const text = [
    '## Task', ctx.text.prompt(g.sequence, g.taskId), '', '## Rule', ctx.text.lesson(g.lessonId).rule, '',
    '## Commands the agent ran', kept.length ? fenced(ctx.redact(kept.join('\n\n')), 'sh') : '(none)', '',
    '## Diff', fenced(ctx.redact(pairDiff(ctx.out, p.entry, p.which)), 'diff'),
    '## Label', 'Does the diff obey the rule? Write pass, fail or na (the rule does not apply) in labels.tsv.', '',
  ].join('\n');
  return { text, dropped: commands.length - kept.length };
}

/** Equal shares per arm, then proportional to the arm's verdict counts (R18), each stratum in seeded order. */
function readerGroups(seed, n, pool, arms) {
  const shares = equalShares(seed, n, arms);
  return seededOrder(seed, arms, (a) => a, 'arm:').map((arm) => {
    const mine = pool.filter((p) => p.arm === arm);
    const counts = new Map(VERDICTS.map((v) => [v, mine.filter((p) => p.verdict === v).length]));
    const quotas = proportional(seed, shares.get(arm), counts, `stratum:${arm}:`);
    const strata = VERDICTS.map((v) => ({ quota: quotas.get(v), items: seededOrder(seed, mine.filter((p) => p.verdict === v), (p) => p.pairId) }));
    return { share: shares.get(arm), strata };
  });
}

function existingDraw(out, round, args) {
  const key = readJson(keyFile(out, round));
  if (key.seed !== args.seed || key.n !== args.n) throw new Error(`reader round ${round} was drawn with --seed ${key.seed} --n ${key.n}; draw a new round instead of redrawing this one`);
  return `reader round ${round}: already drawn, ${key.pairs.length} pairs in ${path.join(out, 'g5', `reader-r${round}`)}\n`;
}

/** Draw round K: pair files and labels.tsv for the reader, the key and per-stratum counts under sealed/ (R9). */
export function drawReader(out, { tasksFile, seed, n = 30, round = 1 }) {
  if (fs.existsSync(keyFile(out, round))) return existingDraw(out, round, { seed, n });
  if (round > 1 && !fs.existsSync(keyFile(out, round - 1))) throw new Error(`reader round ${round - 1} is not drawn; draw rounds in order`);
  const earlier = new Set(readerRounds(out).flatMap((k) => readJson(keyFile(out, k)).pairs.map((p) => p.pairId)));
  const { eligible, ineligible } = readerPairs(out, round);
  const pool = eligible.filter((p) => !earlier.has(p.pairId));
  const grades = listGrades(out).map((e) => e.grade);
  const ctx = { out, text: taskText(tasksFile), redact: outRedactor(out, grades) };
  const forbidden = forbiddenFor(grades);
  const bodies = new Map();
  const accept = (p) => {
    const r = renderPair(ctx, p);
    if (leakScan(r.text, forbidden).length) return false;
    bodies.set(p.pairId, r);
    return true;
  };
  const { taken, rejected } = fillStrata(readerGroups(seed, n, pool, [...new Set(grades.map((g) => g.arm))].sort()), n, accept);
  const ordered = seededOrder(seed, taken, (p) => p.pairId, 'order:');
  const ids = fileIds('p', ordered.length);
  const dir = path.join(out, 'g5', `reader-r${round}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  ordered.forEach((p, i) => fs.writeFileSync(path.join(dir, `${ids[i]}.md`), `# Pair ${ids[i]}\n\n${bodies.get(p.pairId).text}`));
  fs.writeFileSync(path.join(dir, 'labels.tsv'), labelsTemplate(ids, VERDICTS));
  const stratum = (p) => `${p.arm}/${p.verdict}`;
  const byStratum = (list) => list.reduce((m, p) => ({ ...m, [stratum(p)]: (m[stratum(p)] ?? 0) + 1 }), {});
  writeJson(keyFile(out, round), {
    round, seed, n, eligible: pool.length, ineligible, unblindable: rejected.length, unblindableByStratum: byStratum(rejected),
    pairs: ordered.map((p, i) => ({ file: ids[i], pairId: p.pairId, key: p.key, which: p.which, lessonId: p.lessonId, arm: p.arm, stratum: stratum(p), verdict: p.verdict, droppedCommands: bodies.get(p.pairId).dropped })),
  });
  return `reader round ${round}: drew ${ordered.length} of ${pool.length} eligible pairs (${ineligible} ineligible, ${rejected.length} unblindable) into ${dir}\n`;
}

/** Score round K: a disagreement is a label that differs from the round's verdict; counts per stratum stay under sealed/. */
export function scoreReader(out, round, labelsFile) {
  if (!fs.existsSync(keyFile(out, round))) throw new Error(`reader round ${round} is not drawn`);
  const key = readJson(keyFile(out, round));
  const labels = parseLabels(fs.readFileSync(labelsFile, 'utf8'), key.pairs.map((p) => p.file), VERDICTS);
  const perStratum = {};
  let disagreements = 0;
  for (const p of key.pairs) {
    const s = (perStratum[p.stratum] ??= { n: 0, disagreements: 0, unblindable: key.unblindableByStratum[p.stratum] ?? 0 });
    s.n++;
    if (labels.get(p.file) !== p.verdict) {
      s.disagreements++;
      disagreements++;
    }
  }
  writeJson(scoreFile(out, round), { round, n: key.pairs.length, disagreements, perStratum, labels: Object.fromEntries(labels) });
  return `reader round ${round}: ${disagreements} of ${key.pairs.length} labels disagree\n`;
}

/** Round 1's labels against the post-fix verdicts, once a post-fix pass exists (reading 13). */
function rescoreRound1(out) {
  const rows = readRows(rowsFile(out, 'postfix')).rows;
  if (rows.size === 0 || !fs.existsSync(scoreFile(out, 1))) return null;
  const labels = readJson(scoreFile(out, 1)).labels;
  let n = 0;
  let disagreements = 0;
  for (const p of readJson(keyFile(out, 1)).pairs) {
    const row = rows.get(p.key);
    const verdict = row?.status === 'done' ? row.checks.find((c) => c.which === p.which && c.lessonId === p.lessonId)?.regraded : null;
    if (!VERDICTS.includes(verdict)) continue;
    n++;
    if (labels[p.file] !== verdict) disagreements++;
  }
  return { n, disagreements };
}

/** grading.json's readerSample and g5 reader fields from the latest round; an unscored latest round is refused. */
export function readerSummary(out) {
  const rounds = readerRounds(out);
  const none = { readerRound: null, readerEligible: null, readerIneligible: null, unblindable: null, readerRound1Rescored: null };
  if (rounds.length === 0) return { readerSample: { n: 0, disagreements: 0 }, g5: none };
  const k = rounds.at(-1);
  if (!fs.existsSync(scoreFile(out, k))) throw new Error(`reader round ${k} is drawn but not scored; run reader --round ${k} --labels FILE first`);
  const key = readJson(keyFile(out, k));
  const score = readJson(scoreFile(out, k));
  return {
    readerSample: { n: score.n, disagreements: score.disagreements },
    g5: { readerRound: k, readerEligible: key.eligible, readerIneligible: key.ineligible, unblindable: key.unblindable, readerRound1Rescored: rescoreRound1(out) },
  };
}
