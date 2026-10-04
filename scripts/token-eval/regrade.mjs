// Z0 G5 (prereg 166): every saved lesson check and acceptance test runs again on the saved commits, in a scratch checkout outside the run.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { git, sh } from './exec.mjs';
import { armEnv, childEnv } from './arms.mjs';
import { checkoutBase, writeHiddenTests } from './workspace.mjs';
import { runCheck, stateCommit, agentGit, CheckerError, WorkspaceGitError } from './checks.mjs';
import { lessonIndex } from './lessons.mjs';
import { cellKey, followedOf, isBool, resolvedOf, parseZ0Records } from './z0-records.mjs';

export const ROW_SCHEMA = 'z0-regrade/1';
const NEW_FIELDS = ['finalChecked', 'finalCheck', 'stale', 'commandsStale'];
const VERDICTS = ['pass', 'fail', 'na'];
const win = process.platform === 'win32';
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const posix = (p) => p.split(path.sep).join('/');
const byKey = (a, b) => a.localeCompare(b, 'en', { numeric: true });
/** The same-file test every path check uses: realpath (8.3 names and junctions expanded), case-folded on win32. */
export const realKey = (p) => {
  const r = fs.realpathSync.native(p);
  return win ? r.toLowerCase() : r;
};

/** A harness fault: an `error` row, retried on the next run, never a flip (reading 5, R6). */
class HarnessFault extends Error {
  constructor(stage, message) {
    super(message);
    this.stage = stage;
  }
}
const fault = (stage, message) => {
  throw new HarnessFault(stage, message);
};

export const rowsFile = (out, pass) => path.join(out, 'g5', pass === 'postfix' ? 'regrade.postfix.jsonl' : 'regrade.jsonl');
const subdirs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));

/** One grade.json, refused when its folder is not its own runName/arm/seed or it predates the held-commit fields (R24). */
function readGrade(out, file) {
  const grade = JSON.parse(fs.readFileSync(file, 'utf8'));
  const missing = NEW_FIELDS.filter((f) => !(f in grade));
  if (missing.length) throw new Error(`${file} lacks ${missing.join(', ')}; it was saved by a runner older than the regrade, so it cannot be regraded`);
  const own = path.join(out, 'grading', grade.runName, grade.arm, `seed${grade.seed}`);
  const same = fs.existsSync(own) && realKey(own) === realKey(path.dirname(file));
  if (!same || path.basename(file) !== `${grade.taskId}.grade.json`) throw new Error(`${file} says ${grade.runName}/${grade.arm}/seed${grade.seed}/${grade.taskId}, which is not the folder it sits in`);
  return { grade, file, key: cellKey(grade), rel: posix(path.relative(out, file)), bundle: path.join(path.dirname(file), `${grade.taskId}.bundle`) };
}

/** Every saved cell under `<out>/grading/<runName>/<arm>/seed<n>/`, in cell-key order. */
export function listGrades(out) {
  const root = path.join(out, 'grading');
  if (!fs.existsSync(root)) return [];
  const dirs = subdirs(root).flatMap(subdirs).flatMap(subdirs);
  const files = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.grade.json')).map((f) => path.join(d, f)));
  return files.map((f) => readGrade(out, f)).sort((a, b) => byKey(a.key, b.key));
}

/** What a done row was computed from: a change to any of it re-runs the cell. */
export function inputsHash(entry, t, checkers, pass) {
  const bundle = fs.existsSync(entry.bundle) ? fs.readFileSync(entry.bundle) : null;
  const parts = [fs.readFileSync(entry.file, 'utf8'), bundle ? [bundle.length, sha256(bundle)] : 'absent', checkers, t.setup ?? null, t.test, t.fixRef ?? null, t.testFiles ?? null, pass];
  return sha256(JSON.stringify(parts));
}

/** The last row per cell key, every row per key in file order, and whether the file ends in a torn line (a write cut off mid-line). */
export function readRows(file) {
  if (!fs.existsSync(file)) return { rows: new Map(), history: new Map(), torn: false, whole: 0 };
  const text = fs.readFileSync(file, 'utf8');
  const end = text.lastIndexOf('\n') + 1;
  const rows = new Map();
  const history = new Map();
  text.slice(0, end).split('\n').forEach((line, i) => {
    if (!line) return;
    try {
      const row = JSON.parse(line);
      rows.set(row.key, row);
      history.set(row.key, [...(history.get(row.key) ?? []), row]);
    } catch (err) {
      throw new Error(`${file} line ${i + 1}: ${err.message}`);
    }
  });
  return { rows, history, torn: end < text.length, whole: Buffer.byteLength(text.slice(0, end)) };
}

/** Scratch dirs laid out like runDirs, so childEnv's bin strip still works; never inside the run root (R14). */
function scratchPaths(out, g) {
  const root = path.join(out, 'rg', g.runName, g.arm, `seed${g.seed}`);
  const at = (name) => path.join(root, name);
  return { root, seed: g.seed, work: at('work'), claudeConfig: at('claude-config'), codexHome: at('codex-home'), hippoHome: at('hippo-home'), bin: at('bin') };
}

/** The homes start empty for every cell (R22): checkers, setup and tests have no reason to read them. */
function scratchDirs(out, g) {
  const dirs = scratchPaths(out, g);
  for (const d of [dirs.claudeConfig, dirs.codexHome, dirs.hippoHome, path.join(dirs.root, 'check')]) fs.rmSync(d, { recursive: true, force: true });
  for (const d of [dirs.claudeConfig, dirs.codexHome, dirs.hippoHome, dirs.work]) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

/** Path, size and content hash of every file under the run root, work/ included (R23). */
export function evidenceOf(root) {
  const seen = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = posix(path.relative(root, p));
      if (e.isSymbolicLink()) seen.set(rel, `link:${fs.readlinkSync(p)}`);
      else if (e.isDirectory()) walk(p);
      else seen.set(rel, sha256(fs.readFileSync(p)));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return seen;
}

export const evidenceChanges = (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).sort();

const checkoutTree = (work, sha) => agentGit(work, (rgit) => {
  rgit(['checkout', '-q', '-f', '--detach', sha], work);
  rgit(['clean', '-fdq'], work);
});

/** Each saved tree must rebuild exactly from the scratch checkout, or a verdict on it would grade something else. */
function verifyTree(work, pre, sha, which) {
  checkoutTree(work, sha);
  const rebuilt = agentGit(work, (rgit) => rgit(['rev-parse', `${stateCommit(work, pre)}^{tree}`], work).trim());
  const saved = agentGit(work, (rgit) => rgit(['rev-parse', `${sha}^{tree}`], work).trim());
  if (rebuilt !== saved) fault('tree', `the ${which} tree ${sha} rebuilds as ${rebuilt}, not ${saved}`);
}

/** The bundle checked, then fetched, with every saved sha present under its own ref. */
function fetchBundle(work, entry) {
  const g = entry.grade;
  if (!fs.existsSync(entry.bundle)) fault('bundle', `${entry.bundle} is missing`);
  try {
    git(['bundle', 'verify', '--quiet', entry.bundle], work);
    git(['fetch', '--quiet', '--no-tags', entry.bundle, '+refs/z0/grade/*:refs/z0/grade/*'], work);
    for (const k of ['pre', 'first', 'final', 'finalCheck', 'stale'].filter((x) => g[x] !== null)) {
      const got = git(['rev-parse', `refs/z0/grade/${k}`], work).trim();
      if (got !== g[k]) fault('bundle', `the bundle's ${k} is ${got}, grade.json says ${g[k]}`);
    }
  } catch (err) {
    if (err instanceof HarnessFault) throw err;
    fault('bundle', `${entry.bundle}: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
  }
}

/** R26's gates, in order: checker identity, stub, bundle, setup, every tree. Only then may a checker run. */
function gates(ctx, entry, dirs, env) {
  const g = entry.grade;
  const shas = Object.fromEntries(Object.keys(g.checkers).sort().map((id) => [id, ctx.checkerSha(id)]));
  const changed = Object.keys(shas).filter((id) => shas[id] !== g.checkers[id]);
  if (ctx.pass === 'repro' && changed.length) fault('checker-changed', `the checker for ${changed.join(', ')} changed since the run; a fixed checker is regraded with --post-fix`);
  let stub;
  try {
    stub = checkoutBase(ctx.cachedFor(g.sequence), dirs.work, g.sequence, entry.t, g.arm);
  } catch (err) {
    fault('stub', err.message.split('\n')[0]);
  }
  if (stub !== g.stub) fault('stub', `the tasks file gives stub ${stub}, the run used ${g.stub}`);
  fetchBundle(dirs.work, entry);
  const setup = entry.t.setup ? sh(entry.t.setup, dirs.work, childEnv(env)) : null;
  if (setup && setup.status !== 0) fault('setup', `setup exited ${setup.status}: ${setup.stderr.slice(-300)}`);
  const trees = [['first', g.first], ['finalCheck', g.finalChecked ? g.finalCheck : null], ['stale', g.stale], ['final', g.final]];
  for (const [which, sha] of trees) if (sha !== null) verifyTree(dirs.work, g.pre, sha, which);
  return shas;
}

/** One checker call on a saved tree with the shas and commands it saw in the run; a crash or timeout is the value 'error'. */
function checkOn(ctx, entry, dirs, env, { lesson, sha, commands }) {
  checkoutTree(dirs.work, sha);
  try {
    return runCheck(lesson, { work: dirs.work, env: childEnv(env), preCommit: entry.grade.pre, postCommit: sha, commands, scratch: path.join(dirs.root, 'check') });
  } catch (err) {
    if (!(err instanceof CheckerError)) throw err;
    if (!err.started) fault('checker-start', err.message);
    return 'error';
  }
}

/** The pass's verdicts for one call: once, or twice under --post-fix, where the first run is the new verdict. */
function verdicts(ctx, entry, dirs, env, call) {
  const regraded = checkOn(ctx, entry, dirs, env, call);
  return ctx.pass === 'postfix' ? { regraded, second: checkOn(ctx, entry, dirs, env, call) } : { regraded };
}

/** A flip is a verdict that moved without a fix: two post-fix runs that differ, or an unchanged checker that differs from the saved verdict. */
function flipReason(saved, v, unchanged) {
  if (v.regraded === 'error' || v.second === 'error') return 'checker-error';
  const moved = ('second' in v && v.second !== v.regraded) || (unchanged && v.regraded !== saved);
  return moved ? 'verdict' : null;
}

function checkEntry(lessonId, which, saved, v, checkerSha, unchanged) {
  const reason = flipReason(saved, v, unchanged);
  return { lessonId, which, saved, ...v, flip: reason !== null, reason, checkerSha };
}

/** The main lesson's first and final checks, then the stale one after a reversal (as pass-ness, reading 6), each pushed to `acc` as it ends. */
function lessonChecks(ctx, entry, dirs, env, shas, acc) {
  const g = entry.grade;
  if (g.verdicts.first === null) return;
  const add = (id, which, v) => acc.push(checkEntry(id, which, which === 'stale' ? g.verdicts.staleFollow : g.verdicts[which], v, shas[id], shas[id] === g.checkers[id]));
  const lesson = ctx.lesson(g.lessonId);
  const first = verdicts(ctx, entry, dirs, env, { lesson, sha: g.first, commands: g.commandsFirst });
  add(g.lessonId, 'first', first);
  // Reading 8: the final check is re-run only where the run ran it; otherwise final is first, as in the run.
  add(g.lessonId, 'final', g.finalChecked ? verdicts(ctx, entry, dirs, env, { lesson, sha: g.finalCheck, commands: g.commandsFinal }) : first);
  if (g.staleLessonId === null) return;
  const raw = verdicts(ctx, entry, dirs, env, { lesson: ctx.lesson(g.staleLessonId), sha: g.stale, commands: g.commandsStale });
  add(g.staleLessonId, 'stale', Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v === 'error' ? 'error' : v === 'pass'])));
}

/** The hidden tests on the final tree, run once in either pass; a change from the run's result is counted, never dropped (reading 7). */
function acceptanceOf(ctx, entry, dirs, env) {
  const g = entry.grade;
  checkoutTree(dirs.work, g.final);
  writeHiddenTests(ctx.cachedFor(g.sequence), dirs.work, entry.t);
  const regraded = sh(entry.t.test, dirs.work, childEnv(env)).status === 0;
  const flip = regraded !== g.acceptancePassed;
  return { saved: g.acceptancePassed, regraded, flip, reason: flip ? 'verdict' : null };
}

/** One cell's row: `done` with every check and the acceptance, or `error` naming the harness stage that failed. */
export function regradeCell(ctx, entry, inputs) {
  const g = entry.grade;
  const head = {
    schema: ROW_SCHEMA, pass: ctx.pass, key: entry.key, grade: entry.rel, inputsHash: inputs, sequence: g.sequence, runName: g.runName, arm: g.arm, seed: g.seed,
    position: g.position, taskId: g.taskId, kind: g.kind, lessonId: g.lessonId, staleLessonId: g.staleLessonId, finalChecked: g.finalChecked, extraEnvKeys: ctx.extraEnvKeys,
  };
  const dirs = scratchDirs(ctx.out, g);
  const env = armEnv(g.arm, dirs, ctx.baseEnv, { passEnv: ctx.passEnv });
  // Checks that ended before a later fault stay on the error row, so their flips still count (R7).
  const checks = [];
  try {
    lessonChecks(ctx, entry, dirs, env, gates(ctx, entry, dirs, env), checks);
    return { ...head, status: 'done', error: null, checks, acceptance: acceptanceOf(ctx, entry, dirs, env) };
  } catch (err) {
    const known = err instanceof HarnessFault ? err : err instanceof WorkspaceGitError ? new HarnessFault('git', err.message) : null;
    if (!known) throw err;
    return { ...head, status: 'error', error: { stage: known.stage, message: known.message }, checks, acceptance: null };
  }
}

/** A post-fix record: new lesson verdicts, then resolved and chain.followed recomputed; acceptancePassed stays the run's (R3). */
function regradedRecord(r, row) {
  if (r.lessons.length === 0) return r;
  const of = (which) => row.checks.find((c) => c.which === which);
  // A crashed regrade check drops its lesson anyway, so the record keeps the run's verdict and stays valid.
  const real = (c, saved) => (VERDICTS.includes(c?.regraded) ? c.regraded : saved);
  const l = r.lessons[0];
  const stale = of('stale');
  const lesson = { ...l, first: real(of('first'), l.first), final: real(of('final'), l.final), staleFollow: isBool(stale?.regraded) ? stale.regraded : l.staleFollow };
  const out = { ...r, lessons: [lesson, ...r.lessons.slice(1)] };
  out.resolved = resolvedOf(out);
  if (out.chain) out.chain = { ...out.chain, followed: followedOf(out.chain.shown, lesson.first) };
  return out;
}

/** A record the run had to save a grade.json for: valid and not a screen. */
export const isGraded = (r) => (r.invalid === null || r.invalid === undefined) && r.screen !== true;

/** `runs.regraded.jsonl` beside runs.jsonl; refused while a valid non-screen record has no done post-fix row. */
export function writeRegraded(runsFile, rows) {
  const lines = fs.readFileSync(runsFile, 'utf8').split('\n').filter((l) => l.trim());
  const missing = [];
  const out = lines.map((line) => {
    const r = JSON.parse(line);
    if (!isGraded(r)) return line;
    const row = rows.get(cellKey(r));
    if (row?.status !== 'done') missing.push(cellKey(r));
    return row?.status === 'done' ? JSON.stringify(regradedRecord(r, row)) : line;
  });
  if (missing.length) throw new Error(`runs.regraded.jsonl not written: ${missing.length} valid cells lack a done post-fix row (${missing.slice(0, 5).join(', ')})`);
  const target = path.join(path.dirname(runsFile), 'runs.regraded.jsonl');
  const text = `${out.join('\n')}\n`;
  parseZ0Records(text, target);
  fs.writeFileSync(target, text);
  return target;
}

function taskOf(spec, g) {
  const t = spec.sequences?.find((s) => s.id === g.sequence)?.tasks.find((x) => x.id === g.taskId);
  if (!t) throw new Error(`task ${g.sequence}/${g.taskId} is not in the tasks file; pass the tasks file the run used`);
  return t;
}

const hasKey = (env, name) => Object.keys(env).some((k) => (win ? k.toUpperCase() === name.toUpperCase() : k === name));

/** The run's --pass-env list: one list across every record, and every name set now (values are not compared, reading 16). */
function passEnvOf(records, baseEnv) {
  const lists = new Set(records.filter((r) => Array.isArray(r.passEnv)).map((r) => JSON.stringify(r.passEnv)));
  if (lists.size > 1) throw new Error(`the records name ${lists.size} different --pass-env lists; regrade each run's out dir on its own`);
  const passEnv = lists.size ? JSON.parse([...lists][0]) : [];
  const unset = passEnv.filter((n) => !hasKey(baseEnv, n));
  if (unset.length) throw new Error(`--pass-env ${unset.join(', ')} reached the run's checkers but is not set now; set it before the regrade`);
  return passEnv;
}

/** R27: refuse when the run's arm env had a key this one lacks; keys only this one has are a warning, by name. */
function envKeyCheck(records, entries, out, baseEnv, passEnv) {
  const extra = new Set();
  for (const g of new Map(entries.map((e) => [`${e.grade.runName}|${e.grade.arm}|${e.grade.seed}`, e.grade])).values()) {
    // record.sequence is the sequence id, which a renamed run no longer shares with its runName.
    const rec = records.find((r) => r.sequence === g.sequence && r.arm === g.arm && r.seed === g.seed && r.screen !== true && Array.isArray(r.envKeys));
    if (!rec) throw new Error(`no record of ${g.runName}/${g.arm}/seed${g.seed} names its envKeys; pass the runs file the run wrote`);
    const now = armEnv(g.arm, scratchPaths(out, g), baseEnv, { passEnv });
    const lacking = rec.envKeys.filter((k) => !hasKey(now, k));
    if (lacking.length) throw new Error(`the run's env for ${g.runName}/${g.arm}/seed${g.seed} had ${lacking.join(', ')}, which this env lacks; set them before the regrade`);
    const had = Object.fromEntries(rec.envKeys.map((k) => [k, '']));
    for (const k of Object.keys(now)) if (!hasKey(had, k)) extra.add(k);
  }
  return [...extra].sort();
}

function regradeContext(opts, entries) {
  const { out, spec, records, pass, baseEnv } = opts;
  const lessons = lessonIndex(spec.families ?? []);
  const lesson = (id) => {
    const hit = lessons.get(id);
    if (!hit) throw new Error(`lesson ${id} is not in the tasks file; pass the tasks file the run used`);
    return hit.lesson;
  };
  const passEnv = passEnvOf(records, baseEnv);
  const extraEnvKeys = envKeyCheck(records, entries, out, baseEnv, passEnv);
  return { out, pass, baseEnv, passEnv, extraEnvKeys, lesson, checkerSha: (id) => sha256(fs.readFileSync(lesson(id).checkPath)), cachedFor: (seq) => path.join(out, 'repo-cache', seq) };
}

/** A cell whose regrade wrote under the run root stops the whole regrade: the evidence is no longer the run's (R23). */
function guardedCell(ctx, entry, inputs) {
  // SHORTCUT: guards only this cell's own run root; walk every run root if a checker could reach another cell's.
  const g = entry.grade;
  const root = path.join(ctx.out, 'runs', g.runName, g.arm, `seed${g.seed}`);
  const before = evidenceOf(root);
  const row = regradeCell(ctx, entry, inputs);
  const changed = evidenceChanges(before, evidenceOf(root));
  if (changed.length) throw new Error(`regrading cell ${entry.key} changed the run's evidence under ${root}: ${changed.slice(0, 10).join(', ')}`);
  return row;
}

/** The regrade pass over every saved cell (or the --cell ones): done rows with unchanged inputs are skipped, the rest appended. */
export function runRegrade(opts) {
  const { out, pass, cells = [], log = () => {} } = opts;
  const all = listGrades(out);
  // A missing grade.json refuses rather than counting as unreproducible, so deleting one can never drop a lesson.
  const orphans = [...new Set(opts.records.filter(isGraded).map(cellKey))].filter((k) => !all.some((e) => e.key === k));
  if (orphans.length) throw new Error(`no grade.json for ${orphans.length} valid cells in runs.jsonl: ${orphans.slice(0, 5).join(', ')}`);
  const unknown = cells.filter((k) => !all.some((e) => e.key === k));
  if (unknown.length) throw new Error(`--cell ${unknown.join(', ')}: no such cell under ${path.join(out, 'grading')}`);
  const entries = all.filter((e) => cells.length === 0 || cells.includes(e.key)).map((e) => ({ ...e, t: taskOf(opts.spec, e.grade) }));
  const ctx = regradeContext(opts, entries);
  const file = rowsFile(out, pass);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { rows, torn, whole } = readRows(file);
  if (torn) {
    log(`${file}: dropped a torn last line left by a cut-off regrade`);
    fs.truncateSync(file, whole);
  }
  const tally = { ran: 0, skipped: 0, errors: 0, regraded: null };
  for (const entry of entries) {
    // The whole invocation, args included, since the same script with other args can give another verdict.
    const checkers = Object.fromEntries(Object.keys(entry.grade.checkers).sort().map((id) => [id, [ctx.checkerSha(id), ctx.lesson(id).check]]));
    const inputs = inputsHash(entry, entry.t, checkers, pass);
    const last = rows.get(entry.key);
    if (last?.status === 'done' && last.inputsHash === inputs) {
      tally.skipped++;
      continue;
    }
    const row = guardedCell(ctx, entry, inputs);
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    rows.set(entry.key, row);
    tally.ran++;
    if (row.status === 'error') tally.errors++;
  }
  if (pass === 'postfix' && cells.length === 0) tally.regraded = writeRegraded(opts.runsFile, rows);
  return tally;
}
