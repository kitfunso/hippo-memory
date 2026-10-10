// Z0 G5 (prereg 166): the arm-blind reader sample of (diff, verdict) pairs, drawn in rounds, labelled by hand, then scored.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { git } from './exec.mjs';
import { agentGit } from './checks.mjs';
import { readerDiff } from './grading.mjs';
import { lessonIndex } from './lessons.mjs';
import { listGrades, readRows, rowsFile } from './regrade.mjs';
import { flipsOf, postfixCheckers } from './g5-flips.mjs';
import { FORBIDDEN, isHiddenCommand, blindLeaks, equalShares, fenced, fillStrata, labelsTemplate, parseLabels, proportional, redactor, seededOrder } from './g5-draw.mjs';

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

/** What a blinded file must never hold: memory names and markers, every run-name, arm and seed path segment in the out dir. */
export function forbiddenFor(grades, extra = FORBIDDEN) {
  const names = new Set(extra);
  // Every arm shares the run name, so only its path form is forbidden; a bare one would reject pairs that name the repo.
  for (const g of grades) for (const s of [`/${g.runName}/`, `/${g.arm}/seed`, `seed${g.seed}/work`]) names.add(s);
  return [...names];
}

/** Every spelling of each out dir name (the real one and the one given) and of each run root under it becomes `<run>`. */
export const outRedactor = (outs, grades) => redactor([...new Set(outs.flatMap((out) => [out, ...grades.map((g) => path.join(out, 'runs', g.runName, g.arm, `seed${g.seed}`))]))]);

export const readerRounds = (out) => (fs.existsSync(sealed(out, ''))
  ? fs.readdirSync(sealed(out, '')).map((f) => /^reader-r(\d+)\.key\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b) : []);

const diffFile = (e, which) => path.join(path.dirname(e.file), `${e.grade.taskId}.${which}.diff`);

/** Each done teach or apply's main-lesson pairs with the round's verdict (saved in round 1, post-fix later); no diff and no bundle is ineligible. */
export function readerPairs(out, round, flipErrors = false) {
  const pass = round === 1 ? 'repro' : 'postfix';
  const rows = readRows(rowsFile(out, pass)).rows;
  if (rows.size === 0) throw new Error(`reader round ${round} needs ${pass} rows; run regrade${pass === 'postfix' ? ' --post-fix' : ''} first`);
  // The lessons grading drops, by the same function, so the sample never judges a lesson G5 leaves out.
  const flipped = flipsOf(out, listGrades(out), flipErrors).flipped;
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
  // Tested after redaction, so a memory word in the out dir's own path does not hide a plain command.
  const kept = commands.filter((c) => !isHiddenCommand(ctx.redact(c)));
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

/** The `lessonId:sha` of every checker a round's verdicts came from: the run's in round 1, the post-fix rows' after. */
function verdictShas(out, round) {
  const pairs = round === 1 ? listGrades(out).flatMap((e) => Object.entries(e.grade.checkers)) : postfixCheckers(readRows(rowsFile(out, 'postfix')).rows);
  return [...new Set(pairs.map(([id, sha]) => `${id}:${sha}`))].sort();
}

// G5's 10% test from z0-gates.mjs without its size test, so a short round with few disagreements also counts as passed.
const passed = ({ n, disagreements }) => !(disagreements * 10 > n);

/** Prereg 166: round K only once round K-1 was scored with more than 10% disagreeing and a checker changed since its draw. */
function assertNewRound(out, round) {
  const prev = round - 1;
  if (!fs.existsSync(keyFile(out, prev))) throw new Error(`reader round ${prev} is not drawn; draw rounds in order`);
  if (!fs.existsSync(scoreFile(out, prev))) throw new Error(`reader round ${prev} is not scored; score it before drawing round ${round}`);
  const score = readJson(scoreFile(out, prev));
  if (passed(score)) throw new Error(`reader round ${prev} passed (${score.disagreements} of ${score.n} disagree); prereg 166 allows a new round only after more than 10% disagree`);
  const seen = new Set(readJson(keyFile(out, prev)).checkers);
  if (!verdictShas(out, round).some((s) => !seen.has(s))) throw new Error(`no checker changed since reader round ${prev}; fix the checker and run regrade --post-fix before round ${round}`);
}

/** A passing round freezes the checkers (reading 19): a `[lessonId, sha]` its key does not list was never judged, so it is refused. */
export function assertCheckersJudged(out, pairs, whose = 'the current') {
  const k = readerRounds(out).filter((r) => fs.existsSync(scoreFile(out, r))).at(-1);
  if (k === undefined) return;
  const score = readJson(scoreFile(out, k));
  if (!passed(score)) return;
  const judged = new Set(readJson(keyFile(out, k)).checkers);
  const ids = [...new Set(pairs.filter(([id, sha]) => !judged.has(`${id}:${sha}`)).map(([id]) => id))].sort();
  if (ids.length === 0) return;
  throw new Error(`reader round ${k} passed (${score.disagreements} of ${score.n} disagree), and prereg 166 allows a checker fix only after more than 10% disagree, but ${whose} checker for ${ids.join(', ')} is not the one that round judged; restore the judged checker and run regrade --post-fix again`);
}

function existingDraw(out, round, args) {
  const key = readJson(keyFile(out, round));
  if (key.seed !== args.seed || key.n !== args.n) throw new Error(`reader round ${round} was drawn with --seed ${key.seed} --n ${key.n}; draw a new round instead of redrawing this one`);
  return `reader round ${round}: already drawn, ${key.pairs.length} pairs in ${path.join(out, 'g5', `reader-r${round}`)}\n`;
}

/** Draw round K: pair files and labels.tsv for the reader, the key and per-stratum counts under sealed/ (R9). */
export function drawReader(out, { tasksFile, seed, n = 30, round = 1, flipErrors = false, aliases = [] }) {
  if (fs.existsSync(keyFile(out, round))) return existingDraw(out, round, { seed, n });
  if (round > 1) assertNewRound(out, round);
  const earlier = new Set(readerRounds(out).flatMap((k) => readJson(keyFile(out, k)).pairs.map((p) => p.pairId)));
  const { eligible, ineligible } = readerPairs(out, round, flipErrors);
  const pool = eligible.filter((p) => !earlier.has(p.pairId));
  const grades = listGrades(out).map((e) => e.grade);
  const ctx = { out, text: taskText(tasksFile), redact: outRedactor([out, ...aliases], grades) };
  const forbidden = forbiddenFor(grades);
  const bodies = new Map();
  const accept = (p) => {
    const r = renderPair(ctx, p);
    if (blindLeaks(r.text, forbidden).length) return false;
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
    round, seed, n, checkers: verdictShas(out, round), eligible: pool.length, ineligible, unblindable: rejected.length, unblindableByStratum: byStratum(rejected),
    pairs: ordered.map((p, i) => ({ file: ids[i], pairId: p.pairId, key: p.key, which: p.which, lessonId: p.lessonId, arm: p.arm, stratum: stratum(p), verdict: p.verdict, droppedCommands: bodies.get(p.pairId).dropped })),
  });
  return `reader round ${round}: drew ${ordered.length} of ${pool.length} eligible pairs (${ineligible} ineligible, ${rejected.length} unblindable) into ${dir}\n`;
}

/** Score round K: a disagreement is a label that differs from the round's verdict; counts per stratum stay under sealed/. */
export function scoreReader(out, round, labelsFile) {
  if (!fs.existsSync(keyFile(out, round))) throw new Error(`reader round ${round} is not drawn`);
  const key = readJson(keyFile(out, round));
  const labels = parseLabels(fs.readFileSync(labelsFile, 'utf8'), key.pairs.map((p) => p.file), VERDICTS);
  if (fs.existsSync(scoreFile(out, round))) {
    // A scored round is final: new labels after seeing the score would be a reroll of G5.
    const old = readJson(scoreFile(out, round));
    if (key.pairs.some((p) => old.labels[p.file] !== labels.get(p.file))) throw new Error(`reader round ${round} is already scored with other labels; a scored round is final`);
    return `reader round ${round}: ${old.disagreements} of ${old.n} labels disagree\n`;
  }
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
  // The score stands only for the verdicts its round judged, so post-fix rows from another checker cannot borrow it.
  assertCheckersJudged(out, postfixCheckers(readRows(rowsFile(out, 'postfix')).rows), "the post-fix rows'");
  return {
    readerSample: { n: score.n, disagreements: score.disagreements },
    g5: { readerRound: k, readerEligible: key.eligible, readerIneligible: key.ineligible, unblindable: key.unblindable, readerRound1Rescored: rescoreRound1(out) },
  };
}
