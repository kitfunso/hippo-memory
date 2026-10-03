#!/usr/bin/env node
// Z7b strict sub-agent lesson eval, prereg docs/evals/2026-10-03-z7b-sidechain-strict-prereg.md. Stdout carries counts only, never transcript, lesson or label text.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as L from './z7-sidechain-lib.mjs';
import * as Z from './z7b-sidechain-lib.mjs';
import * as E from './z7-sidechain-eval.mjs';
import { z7bSelftests } from './z7b-sidechain-selftest.mjs';
import { guardScored, createMarker, appendLine, countResumes, startResume, refuseApiKey } from './z7-sidechain-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(REPO, 'scripts');
const PROMPTS = path.join(SCRIPTS, 'z7b-sidechain-prompts');
const PREREG = path.join(REPO, 'docs', 'evals', '2026-10-03-z7b-sidechain-strict-prereg.md');
const SCRIPT_FILES = ['z7-sidechain-lib.mjs', 'z7-sidechain-eval.mjs', 'z7-sidechain-guard.mjs', 'z7-sidechain-selftest.mjs', 'z7b-sidechain-lib.mjs', 'z7b-sidechain-eval.mjs', 'z7b-sidechain-selftest.mjs'].map((f) => path.join(SCRIPTS, f));
const DEFAULT_ARCHIVE = path.join(os.homedir(), 'hippo-archive', 'z7-sidechain-2026-10-03');
const [SONNET, OPUS] = L.MODELS;
const { out, fmt, byStr, readJson, writeOut, writeIdempotent } = E;
const STAGES = ['judge', 'recheck', 'filter'];

function parseArgs(argv) {
  const a = { cmd: argv[0], archive: DEFAULT_ARCHIVE, split: null, round: null, resume: false, marks: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--archive') a.archive = argv[++i];
    else if (argv[i] === '--split') a.split = argv[++i];
    else if (argv[i] === '--round') a.round = Number(argv[++i]);
    else if (argv[i] === '--resume') a.resume = true;
    else if (argv[i] === '--marks') a.marks = argv[++i];
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  if (!path.isAbsolute(a.archive)) throw new Error('--archive must be an absolute path');
  if (a.marks !== null && !path.isAbsolute(a.marks)) throw new Error('--marks must be an absolute path');
  if (a.resume && a.cmd !== 'scored') throw new Error('--resume belongs to the scored command only');
  if (a.marks !== null && !['calib-record', 'audit-finalize'].includes(a.cmd)) throw new Error('--marks belongs to calib-record and audit-finalize only');
  return a;
}

// --- shared helpers ---

const newCtx = (dir, extra) => ({ ...E.makeCtx(dir, { promptDir: PROMPTS, seedPrefix: 'z7b' }), ...extra });
const z7bDir = (ar) => path.join(ar.work, 'z7b');
const readDrawZ7b = (ar) => readJson(z7bDir(ar), 'draw.json');
const promptSha = () => Object.fromEntries(Z.PIN_PROMPTS.map((n) => [n, E.hash(fs.readFileSync(path.join(PROMPTS, n)))]));
const writeSidecar = (dir, stage, tag) => writeIdempotent(path.join(dir, `prompts-${stage}-${tag}.json`), promptSha());
const exists = (dir, name) => fs.existsSync(path.join(dir, name));

function z7Draws(ar) {
  const eligible = E.eligibleItems(E.scanArchive(ar));
  const z7Fresh = L.buildDraw(eligible);
  return { z7Fresh, fresh: Z.buildDrawZ7b(eligible, z7Fresh) };
}

function needDev(a, withRound = true) {
  if (a.split !== 'dev') throw new Error('this command takes --split dev; the scored split runs only inside the scored command');
  if (withRound && !(a.round >= 1 && a.round <= 3)) throw new Error('--round must be 1, 2 or 3');
}

// Every dev command goes through here, so none can touch an id on the stored scored list.
function devSetup(a, withRound = true) {
  needDev(a, withRound);
  const ar = E.openArchive(a.archive);
  const draw = readDrawZ7b(ar);
  const { z7Fresh, fresh } = z7Draws(ar);
  const why = Z.checkDevDrawZ7b({ z7Fresh, z7Stored: readJson(ar.work, 'draw.json'), fresh, stored: draw });
  if (why) throw new Error(`draw refused: ${why}`);
  const scored = new Set(draw.scored);
  if (draw.dev.some((id) => scored.has(id))) throw new Error('dev list overlaps the scored list');
  return { ar, draw, dir: path.join(z7bDir(ar), 'dev'), ids: draw.dev };
}

// Reads one round's three files; the filter must have run on exactly this recheck file.
export function loadRound(dir, tag) {
  const recheckFile = `recheck-${tag}.json`;
  const filter = readJson(dir, `filter-${tag}.json`);
  if (filter.recheckSha256 !== E.hash(fs.readFileSync(path.join(dir, recheckFile)))) throw new Error(`filter-${tag}.json was not run on this ${recheckFile}`);
  return { judge: E.loadJudge(dir, tag), recheck: readJson(dir, recheckFile), filter };
}

// fUnf is the Z7 view (before the filter); fFil also counts filter removals as removed lessons.
function twoPass(items, round) {
  const rows = E.asRows(items);
  return { fUnf: L.figures(rows, round.judge, round.recheck), fFil: L.figures(rows, round.judge, Z.mergeRemovals(round.recheck, round.filter)) };
}

function printGates(g, fUnf) {
  out('G1_isolation', g.G1);
  out('G2_parse', JSON.stringify(g.G2));
  out('G3_evidence', JSON.stringify(g.G3));
  out('G4_control', fmt(g.G4 === null ? null : g.G4 ? 1 : 0));
  out('decoy_unplanted_kept', fUnf.unplanted.join('/'));
  out('decoy_planted_kept', fUnf.planted.join('/'));
  out('decoy_planted_count', fUnf.planted[1]);
  out('decoy_skipped', fUnf.decoySkipped);
  out('G5_pass', g.G5);
  out('G6_pass', g.G6);
}

const lessonLines = (r, side) => [`## ${r.id}`, `parent side: ${side}`, ...[[SONNET, r.s1], [OPUS, r.s2]].flatMap(([m, ls]) => ls.flatMap((l) => [`- ${m} [${l.kind}] ${l.text}`, `  evidence: ${l.evidence}`])), ''];

// --- draw and build ---

function cmdDraw(a) {
  const ar = E.openArchive(a.archive);
  const { z7Fresh, fresh } = z7Draws(ar);
  if (z7Fresh.itemListSha256 !== Z.Z7_SCORED_SHA) throw new Error('the recomputed Z7 scored list differs from the pinned Z7 list sha256');
  const why = L.drawMismatch(z7Fresh, readJson(ar.work, 'draw.json'), Z.Z7_SCORED_SHA);
  if (why) throw new Error(`Z7 draw.json refused: ${why}`);
  if (exists(z7bDir(ar), 'draw.json')) {
    const bad = Z.drawMismatchZ7b(fresh, readDrawZ7b(ar), fresh.itemListSha256);
    if (bad) throw new Error(`Z7b draw.json refused: ${bad}`);
  }
  writeIdempotent(path.join(z7bDir(ar), 'draw.json'), fresh);
  out('eligible_subagents', fresh.eligibleSubs);
  out('eligible_sessions', fresh.eligibleSessions);
  out('dev_items', fresh.dev.length);
  out('pool_subagents', fresh.poolSubs);
  out('pool_sessions', fresh.poolSessions);
  out('scored_n', fresh.scored.length);
  out('scored_sessions', fresh.scoredSessions);
  out('scored_item_list_sha256', fresh.itemListSha256);
}

async function cmdBuild(a) {
  if (a.split === 'scored') throw new Error('the scored split builds only inside the scored command');
  const { ar, draw, dir, ids } = devSetup(a, false);
  E.printBuild(await E.buildIds(ar, dir, ids, draw, false, false));
}

// --- dev stages: judge, recheck, filter ---

async function cmdJudge(a) {
  const { dir, ids } = devSetup(a);
  const items = E.loadBuilt(dir, ids);
  const ctx = newCtx(dir, { idem: false });
  writeSidecar(dir, 'judge', `r${a.round}`);
  const iso = await E.isolationBoth(ctx);
  writeOut(dir, `isolation-r${a.round}.json`, iso, false);
  if (Object.values(iso).includes(false)) throw new Error('G1 isolation failed; no labelled call was made');
  const res = await E.judgeStage(ctx, items, `r${a.round}`, false);
  for (const m of L.MODELS) out(`judged_${m}`, Object.keys(res[m]).length);
}

async function cmdRecheck(a) {
  const { dir, ids } = devSetup(a);
  writeSidecar(dir, 'recheck', `r${a.round}`);
  const res = await E.recheckStage(newCtx(dir, { idem: false }), E.loadBuilt(dir, ids), E.loadJudge(dir, `r${a.round}`), `recheck-r${a.round}.json`, null);
  out('rechecked_items', Object.keys(res).length);
}

// One Opus call per item with a recheck-surviving lesson; its removals become extra keys on the judge's own index.
export async function filterStage(ctx, items, judge, recheck, recheckFile, name) {
  const tpl = E.promptText('filter-prompt.txt', ctx.promptDir);
  const res = {};
  await E.runPool(items.map((it) => async () => {
    const cands = Z.candidates(judge, recheck, it.id);
    if (!cands.length) return;
    const lessons = cands.map((c, i) => `${i}. ${c.text}`).join('\n');
    const r = await E.callClaude(ctx, OPUS, E.fill(tpl, { A: it.A, B: it.B, LESSONS: lessons }), (s) => Z.parseFilter(s, cands.length).ok);
    const parsed = Z.parseFilter(r.stdout, cands.length);
    res[it.id] = { ok: parsed.ok, n: cands.length, labels: parsed.labels, removed: Z.removalKeys(cands, parsed) };
  }));
  const filter = { recheckSha256: E.hash(fs.readFileSync(path.join(ctx.dir, recheckFile))), items: Object.fromEntries(items.filter((it) => res[it.id]).map((it) => [it.id, res[it.id]])) };
  writeOut(ctx.dir, name, filter, ctx.idem);
  return filter;
}

async function cmdFilter(a) {
  const { dir, ids } = devSetup(a);
  const judge = E.loadJudge(dir, `r${a.round}`);
  const recheck = readJson(dir, `recheck-r${a.round}.json`);
  writeSidecar(dir, 'filter', `r${a.round}`);
  const filter = await filterStage(newCtx(dir, { idem: false }), E.loadBuilt(dir, ids), judge, recheck, `recheck-r${a.round}.json`, `filter-r${a.round}.json`);
  const st = Z.filterStats(filter);
  out('filtered_items', st.parse[1]);
  out('filter_parse_ok', st.parse[0]);
}

// --- dev reads: score, calib, calib-record, agree ---

function devRound(a) {
  const { dir, ids } = devSetup(a);
  const items = E.loadBuilt(dir, ids);
  const round = loadRound(dir, `r${a.round}`);
  return { dir, items, round, ...twoPass(items, round) };
}

function cmdScore(a) {
  const { dir, round, fUnf, fFil } = devRound(a);
  const iso = exists(dir, `isolation-r${a.round}.json`) ? readJson(dir, `isolation-r${a.round}.json`) : null;
  const st = Z.filterStats(round.filter);
  const g = Z.gatesZ7b(fUnf, iso ? !Object.values(iso).includes(false) : null, null, st.parse);
  out('n', fUnf.n);
  out('before_recheck_both_judges', fUnf.pBefore);
  out('lesson_overturned_by_recheck', fUnf.overturned);
  out('after_recheck_both_judges', fUnf.consensus);
  out('after_recheck_either_judge', fUnf.union);
  out('after_filter_both_judges', fFil.consensus);
  out('after_filter_either_judge', fFil.union);
  out('filter_parse_ok_of_calls', st.parse.join('/'));
  out('filter_labels', JSON.stringify(st.labels));
  printGates(g, fUnf);
}

const readMarks = (dir) => (exists(dir, 'calib-marks.json') ? readJson(dir, 'calib-marks.json') : []);

function cmdCalib(a) {
  const { dir, round, fFil } = devRound(a);
  const records = readMarks(dir);
  if (records.some((r) => r.round === a.round)) throw new Error(`round ${a.round} is already recorded`);
  const current = promptSha();
  const sidecars = STAGES.map((s) => (exists(dir, `prompts-${s}-r${a.round}.json`) ? readJson(dir, `prompts-${s}-r${a.round}.json`) : null));
  if (!Z.promptShaAgree(sidecars, current, Z.PIN_PROMPTS)) throw new Error('the prompt files differ from the ones this round ran (or a stage sidecar is missing); rerun the round');
  const bearing = fFil.rows.filter((r) => r.both);
  const removed = Object.entries(round.filter.items).filter(([, v]) => v.removed.length).map(([id]) => id);
  const prior = records.flatMap((r) => { const c = readJson(dir, `calib-r${r.round}.json`); return [...c.precision, ...c.falsex]; });
  const topUp = fFil.rows.filter((r) => r.either && !r.both).map((r) => r.id);
  const s = Z.calibSamples(a.round, bearing.map((r) => r.id), removed, prior, topUp);
  const side = (id) => path.join(dir, `${id}.parent.txt`);
  const precision = ['# Dev calibration precision sample, round ' + a.round, '', 'Confirm a sub-agent only if a listed lesson is durable, in none of the filter classes, and absent from its parent side file.', ''];
  for (const id of s.precision) precision.push(...lessonLines(fFil.rows.find((r) => r.id === id), side(id)));
  const falsex = ['# Dev calibration false-exclusion sample, round ' + a.round, '', 'Confirm a sub-agent only if a listed lesson is durable, not recoverable and absent from its parent side file.', ''];
  for (const id of s.falsex) {
    const cut = round.filter.items[id].removed;
    const row = { id, s1: [], s2: [] };
    for (const [m, key] of [[SONNET, 's1'], [OPUS, 's2']]) row[key] = round.judge[m][id].verified.filter((_, k) => cut.includes(`${m}:${k}`));
    falsex.push(...lessonLines(row, side(id)));
  }
  writeOut(dir, `calib-r${a.round}.md`, precision.join('\n'), false);
  writeOut(dir, `falsex-r${a.round}.md`, falsex.join('\n'), false);
  writeOut(dir, `calib-r${a.round}.json`, { precision: s.precision, falsex: s.falsex, promptSha: current }, false);
  out('lesson_bearing_dev_items', bearing.length);
  out('filter_removed_dev_items', removed.length);
  out('precision_sample', s.precision.length);
  out('precision_sample_one_judge_topup', s.precision.filter((id) => topUp.includes(id)).length);
  out('falsex_sample', s.falsex.length);
}

function cmdCalibRecord(a) {
  const { dir } = devSetup({ ...a, split: 'dev' });
  if (!a.marks) throw new Error('--marks <file> is required');
  const cal = readJson(dir, `calib-r${a.round}.json`);
  const marks = JSON.parse(fs.readFileSync(a.marks, 'utf8'));
  const bad = Z.checkMarks(marks.precision, cal.precision) ?? Z.checkMarks(marks.falsex, cal.falsex);
  if (bad) throw new Error(`marks refused: ${bad}`);
  const current = promptSha();
  if (Z.PIN_PROMPTS.some((n) => cal.promptSha[n] !== current[n])) throw new Error('the prompt files changed since this round was sampled; rerun the round');
  const records = readMarks(dir);
  if (records.some((r) => r.round === a.round)) throw new Error(`round ${a.round} is already recorded`);
  const precision = Z.summariseMarks(marks.precision), falsex = Z.summariseMarks(marks.falsex);
  const pass = Z.calibPass(marks.precision);
  writeOut(dir, 'calib-marks.json', [...records, { round: a.round, precision, falsex: { n: falsex.n, confirmed: falsex.confirmed }, pass, promptSha: cal.promptSha }], false);
  out('calib_pass', pass);
  out('precision_confirmed_of_n', `${precision.confirmed}/${precision.n}`);
  out('precision_rejected_by_class', JSON.stringify(precision.byClass));
  out('falsex_confirmed_of_n', `${falsex.confirmed}/${falsex.n}`);
}

function cmdAgree(a) {
  const { dir, fUnf, fFil } = devRound(a);
  if (!readMarks(dir).some((r) => r.round === a.round)) throw new Error(`round ${a.round} has no calibration record; kappa and per-judge rates stay hidden until it does`);
  out('kappa_before_recheck', fmt(fUnf.kappa));
  for (const [m, v] of Object.entries(fUnf.perJudge)) out(`p_${m}_after_recheck`, fmt(v / (fUnf.n || 1)));
  for (const [m, v] of Object.entries(fFil.perJudge)) out(`p_${m}_after_filter`, fmt(v / (fFil.n || 1)));
}

// --- scored run ---

const lockConfig = () => ({
  repo: REPO, prereg: PREREG, scriptFiles: SCRIPT_FILES, promptDir: PROMPTS, distDir: path.join(REPO, 'dist'), claudeVersion: E.claudeVersion,
  lockDir: path.join(os.homedir(), '.hippo-eval-locks'), lockName: Z.LOCK_NAME, pinPrompts: Z.PIN_PROMPTS,
});

// Both the Z7 dev set and the Z7b draw are recomputed from the verified archive, so a stale or edited file cannot stand.
function checkDraw(ar, draw, pins) {
  const { z7Fresh, fresh } = z7Draws(ar);
  const why = Z.checkDrawZ7b({ manifestSha: ar.manifestSha, z7Fresh, z7Stored: readJson(ar.work, 'draw.json'), fresh, stored: draw }, pins);
  if (why) throw new Error(`draw refused: ${why}`);
}

// The last calibration round passed, and the prompts it ran are the prompts the prereg pins.
function checkCalibration(ar, pins) {
  const last = readMarks(path.join(z7bDir(ar), 'dev')).at(-1);
  if (!last?.pass) throw new Error('the last calibration record is missing or did not pass');
  if (!Z.pinsMatchPrompts(pins, last.promptSha, Z.PIN_PROMPTS)) throw new Error('the last calibration record ran prompts that differ from the prereg pins');
  return last;
}

const bootstrap = (rows, pick) => L.clusterBootstrap(rows.map((r) => ({ cluster: r.session, hit: pick(r) })), 'z7b-boot');

async function cmdScored(a) {
  const lock = guardScored(lockConfig(), a.resume);
  const ar = E.openArchive(a.archive);
  const draw = readDrawZ7b(ar);
  if (L.sha256(draw.scored.join('\n')) !== draw.itemListSha256) throw new Error('scored list does not match its recorded sha256');
  const calibration = checkCalibration(ar, lock.pins);
  checkDraw(ar, draw, lock.pins);
  const dir = path.join(z7bDir(ar), 'scored');
  if (a.resume) startResume(lock, draw.itemListSha256, dir);
  else createMarker(lock, draw.itemListSha256);
  const ctx = newCtx(dir, { idem: true, strict: true });
  for (const s of STAGES) {
    writeSidecar(dir, s, 'final');
    if (!Z.pinsMatchPrompts(lock.pins, readJson(dir, `prompts-${s}-final.json`), Z.PIN_PROMPTS)) throw new Error(`prompts-${s}-final.json does not match the prompt pins`);
  }
  const iso = await E.isolationBoth(ctx);
  const failedIso = Object.values(iso).includes(false);
  if (!exists(dir, 'isolation.json')) writeOut(dir, 'isolation.json', iso, true);
  if (a.resume) appendLine(path.join(dir, 'isolation-resumes.jsonl'), { iso });
  if (a.resume && failedIso) throw new Error('G1 isolation failed on resume; no labelled call was made');
  if (failedIso) {
    writeOut(dir, 'result.json', { verdict: 'INVALID', failed: 'G1' }, true);
    out('verdict', 'INVALID (G1 isolation)');
    return;
  }
  const items = await E.buildIds(ar, dir, draw.scored, draw, true, false);
  E.printBuild(items);
  const judge = await E.judgeStage(ctx, items, 'final', false);
  const controlIds = L.shuffled([...draw.scored].sort(byStr), L.rngFromString('z7b-control')).slice(0, 30);
  const controlItems = items.filter((it) => controlIds.includes(it.id));
  const control = L.controlFigures(await E.judgeStage(ctx, controlItems, 'control', true), controlItems.map((it) => it.id));
  const recheck = await E.recheckStage(ctx, items, judge, 'recheck-final.json', null);
  const filter = await filterStage(ctx, items, judge, recheck, 'recheck-final.json', 'filter-final.json');
  finishScored(ctx, items, { judge, recheck, filter }, { iso, control, lock, draw, calibration });
}

function finishScored(ctx, items, round, run) {
  const { fUnf, fFil } = twoPass(items, round);
  const ci = bootstrap(fFil.rows, (r) => r.both);
  const unfBothCi = bootstrap(fUnf.rows, (r) => r.both);
  const unfUnionCi = bootstrap(fUnf.rows, (r) => r.either);
  const st = Z.filterStats(round.filter);
  const g = Z.gatesZ7b(fUnf, true, run.control, st.parse);
  const valid = L.gatesValid(g);
  const verdict = Z.verdictZ7b(ci, unfUnionCi, valid);
  const iv = (c) => ({ p: c.p, ci: [c.lo, c.hi] });
  const result = {
    lockCommit: run.lock.lockCommit, itemListSha256: run.draw.itemListSha256, n: fFil.n, sessions: ci.clusters, intervalWidth: ci.width, p: ci.p, ci: [ci.lo, ci.hi],
    unfiltered: { both: iv(unfBothCi), union: iv(unfUnionCi) }, beforeRecheck: fUnf.pBefore, overturnedByRecheck: fUnf.overturned,
    consensusUnfiltered: fUnf.consensus, unionUnfiltered: fUnf.union, consensus: fFil.consensus, unionFiltered: fFil.union, perJudge: fFil.perJudge,
    kappaBeforeRecheck: fUnf.kappa, lessonsPerItem: fFil.lessonsPerItem, kindMix: fFil.kindMix, byClass: fFil.byClass, bearingWithLessonInReport: fFil.inReport, cutShare: fFil.cutShare,
    gates: g, gatesUntested: Z.untestedGates(g), decoy: { unplanted: fUnf.unplanted, planted: fUnf.planted, skipped: fUnf.decoySkipped },
    plantedDecoyCount: fUnf.planted[1], control: run.control, filter: st, calibration: run.calibration, valid, resumes: countResumes(run.lock), verdict, auditRequired: verdict === 'PENDING_AUDIT',
  };
  E.writeOut(ctx.dir, 'result.json', result, true);
  out('n', result.n);
  out('n_sessions', ci.clusters);
  out('before_recheck_both_judges', fUnf.pBefore);
  out('after_recheck_both_judges', fUnf.consensus);
  out('after_recheck_either_judge', fUnf.union);
  out('after_filter_both_judges', fFil.consensus);
  out('lesson_bearing_with_lesson_in_report', fFil.inReport);
  out('p', fmt(ci.p));
  out('p_ci95', `${fmt(ci.lo)} ${fmt(ci.hi)}`);
  out('p_unfiltered_both_ci95', `${fmt(unfBothCi.p)} ${fmt(unfBothCi.lo)} ${fmt(unfBothCi.hi)}`);
  out('p_unfiltered_union_ci95', `${fmt(unfUnionCi.p)} ${fmt(unfUnionCi.lo)} ${fmt(unfUnionCi.hi)}`);
  out('filter_labels', JSON.stringify(st.labels));
  out('control_items_parsed_by_both', `${run.control.parsed}/${run.control.total}`);
  printGates(g, fUnf);
  out('verdict_preliminary', verdict);
}

// --- precision audit ---

function cmdAudit(a) {
  const ar = E.openArchive(a.archive);
  const dir = path.join(z7bDir(ar), 'scored');
  if (!exists(dir, 'result.json')) throw new Error('result.json is missing; run scored first');
  const result = readJson(dir, 'result.json');
  if (result.verdict === 'INVALID' && !exists(dir, `judge-final-${SONNET}.json`)) { out('audit', 'none: the run stopped before any judge call'); return; }
  const draw = readDrawZ7b(ar);
  const items = E.loadBuilt(dir, draw.scored);
  const { fUnf, fFil } = twoPass(items, loadRound(dir, 'final'));
  const bearing = fFil.rows.filter((r) => r.both).map((r) => r.id).sort(byStr);
  const kept = new Set(bearing);
  const dropped = fUnf.rows.filter((r) => r.both && !kept.has(r.id)).map((r) => r.id).sort(byStr);
  const s = Z.auditSample(bearing, dropped);
  writeOut(dir, 'audit.json', { seed: 'z7b-audit', verdict: result.verdict, bearingTotal: bearing.length, droppedTotal: dropped.length, bearing: s.bearing, dropped: s.dropped, ids: s.ids }, true);
  const lines = ['# Precision audit sample', ''];
  for (const id of s.ids) lines.push(...lessonLines((kept.has(id) ? fFil : fUnf).rows.find((r) => r.id === id), path.join(dir, `${id}.parent.txt`)));
  writeOut(dir, 'audit.md', lines.join('\n'), true);
  out('lesson_bearing_scored', bearing.length);
  out('dropped_by_filter', dropped.length);
  out('audit_sample', s.ids.length);
}

// Records the final verdict once, from marks that cover exactly the audit sample.
function cmdAuditFinalize(a) {
  if (!a.marks) throw new Error('--marks <file> is required');
  const dir = path.join(z7bDir(E.openArchive(a.archive)), 'scored');
  if (exists(dir, 'audit-result.json')) throw new Error('audit-result.json exists; the audit is finalised once');
  if (!exists(dir, 'audit.json')) throw new Error('audit.json is missing; run audit first');
  const audit = readJson(dir, 'audit.json');
  const marks = JSON.parse(fs.readFileSync(a.marks, 'utf8'));
  const bad = Z.checkMarks(marks, audit.ids);
  if (bad) throw new Error(`marks refused: ${bad}`);
  const result = readJson(dir, 'result.json');
  const yes = (ids) => ids.filter((id) => marks[id] === 'confirmed').length;
  const rec = { ...Z.finalizeAuditZ7b(result.verdict, { lo: result.ci[0], hi: result.ci[1] }, audit.bearing.length, yes(audit.bearing)), droppedN: audit.dropped.length, droppedConfirmed: yes(audit.dropped) };
  fs.writeFileSync(path.join(dir, 'audit-result.json'), JSON.stringify(rec, null, 1), { flag: 'wx' });
  out('audit_sample', rec.sampleN);
  out('audit_confirmed', rec.confirmed);
  out('audit_share', fmt(rec.share));
  out('adjusted_lo', fmt(rec.adjustedLo));
  out('strong', rec.strong);
  out('filter_removed_confirmed_of_n', `${rec.droppedConfirmed}/${rec.droppedN}`);
  out('verdict_preliminary', rec.preliminary);
  out('verdict_final', rec.final);
}

// --- selftest and entry ---

async function selftest() {
  let n = 0;
  const failed = [];
  const t = (name, ok) => { n++; if (!ok) failed.push(name); };
  await E.runSelftests(t);
  for (const group of z7bSelftests) group(t);
  console.log(`selftest: ${n} cases, ${failed.length} failed`);
  for (const name of failed) console.log(`FAIL: ${name}`);
  process.exit(failed.length ? 1 : 0);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.cmd === 'selftest') return await selftest();
  if (['judge', 'recheck', 'filter', 'scored'].includes(a.cmd)) refuseApiKey(process.env);
  const table = {
    draw: cmdDraw, build: cmdBuild, judge: cmdJudge, recheck: cmdRecheck, filter: cmdFilter, score: cmdScore, calib: cmdCalib,
    'calib-record': cmdCalibRecord, agree: cmdAgree, scored: cmdScored, audit: cmdAudit, 'audit-finalize': cmdAuditFinalize,
  };
  if (!table[a.cmd]) throw new Error(`unknown command ${a.cmd}`);
  return table[a.cmd](a);
}

const samePath = (x, y) => (process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y);
if (samePath(path.resolve(fileURLToPath(import.meta.url)), path.resolve(process.argv[1] ?? ''))) main().catch((e) => { console.error(`z7b: ${e.message}`); process.exit(1); });
