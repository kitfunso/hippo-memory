// One task cell (prereg 105-110): stage the workspace, session 1, the lesson check, one resume, the final check, the record.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sh } from './exec.mjs';
import { HIPPO_ARMS, CARRY_ARMS, childEnv } from './arms.mjs';
import { homeFiles, ancestorInstructionFiles } from './homes.mjs';
import { checkoutBase, instructionSnapshot, instructionDelta, applyInstructions, restoreInstructions, writeHiddenTests, goldLines } from './workspace.mjs';
import {
  findTranscript, sessionFiles, listTranscripts, transcriptWork, transcriptUsage, assistantTurns, assistantIds, commandLog, usageFromResult, invalidRecord, validRecord,
  hookContexts, toolResultTexts,
} from './records.mjs';
import { hippoInit, storeLeaks, storeEntries, hippoSentFor, writeRecord, settle, startRun } from './runs.mjs';
import { findLeaks, storedAt, shownAtStart, capturedBy, holds } from './leaks.mjs';
import { runSession, resumeSession } from './turns.mjs';
import { runCheck, stateCommit, holdPre, dropPre, agentGit, CheckerError, WorkspaceGitError, FIRST_REF, STALE_REF, FINAL_CHECK_REF } from './checks.mjs';
import { saveGrading, surfaceText } from './grading.mjs';
import { teachMessage, withTaught, memoryText, wordOverlap } from './lessons.mjs';
import { cellName, snapshotSurfaces, restoreSurfaces, recordInjected } from './surfaces.mjs';
import { deliveryHits, sessionVoid, byPrecedence, foldPath, under } from './readcheck.mjs';
import { followedOf } from './z0-records.mjs';

const NO_CARRY = { carryMerges: 0, carryUnionMerges: 0, carryDeleteKept: 0 };
const NOT_STAGED = { carryMerges: null, carryUnionMerges: null, carryDeleteKept: null, homesAtStart: null };
const ZERO_USAGE = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
// Raw session JSON is evidence and is kept whole; only plain-text logs are tail-cut.
const writeRaw = (run, name, text) => fs.writeFileSync(path.join(run.rawDir, name), text);
const writeLog = (run, name, text) => writeRaw(run, name, text.slice(-20000));

/** fn() with a broken workspace git kept as the cell's fault (null back); anything else still throws. */
function guarded(run, t, stage, fn) {
  try {
    return fn();
  } catch (err) {
    if (!(err instanceof WorkspaceGitError)) throw err;
    if (!stage.fault) writeLog(run, `${t.id}.workspace.txt`, `${err.message}\n${err.stderr}`);
    stage.fault ??= err;
    return null;
  }
}

const projectsOf = (run) => path.join(run.dirs.claudeConfig, 'projects');
const transcriptsOf = (run, sessionIds) => sessionIds.flatMap((id) => sessionFiles(projectsOf(run), id));

/** Session ids of top-level transcripts not in `before`, newest first. */
function newSessionIds(run, before) {
  const projects = projectsOf(run);
  return listTranscripts(projects)
    .filter((f) => !before.has(f) && path.dirname(path.dirname(f)) === projects)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .map((f) => path.basename(f, '.jsonl'));
}

/** The fields every record of the cell carries, valid or not (E7 contract). */
function baseFields(ctx, run, step) {
  const { t, role } = step;
  const base = {
    schema: 'z0-record/1', set: role.set, tool: 'claude-code', repo: run.s.repo, taskId: t.id, cluster: run.s.cluster, sequence: run.s.id,
    position: step.position, order: step.order, arm: run.arm, seed: run.seed, model: ctx.model, claudeVersion: ctx.claudeVersion,
    startedAt: new Date().toISOString(), baseCommit: null, kind: role.kind, familyId: role.familyId, lessonSource: role.lessonSource,
    applyIndex: role.applyIndex, afterReversal: role.afterReversal, tasksSinceTeach: role.tasksSinceTeach,
  };
  if (role.kind !== 'no-lesson') base.lessonId = role.lessonId;
  if (role.kind === 'screen') base.screen = true;
  if (role.kind === 'apply') base.wordOverlap = wordOverlap(t.prompt, ctx.lessons.get(role.lessonId).lesson.rule);
  return base;
}

/** Instruction files in the agent-writable dirs between work/ and the out dir, written to the raw dir as `name` when there are any. */
function ancestorFiles(ctx, run, name) {
  // Claude Code loads every ancestor's CLAUDE.md, and preflight checked only the out dir, before any agent ran.
  const hits = ancestorInstructionFiles(path.dirname(run.dirs.work), { stopAt: ctx.outDir });
  if (hits.length) fs.writeFileSync(path.join(run.rawDir, name), `${hits.join('\n')}\n`);
  return hits;
}

const ancestorHits = (ctx, run, t) => ancestorFiles(ctx, run, `${t.id}.ancestor.txt`).length > 0;

/** Every runner write before the session, then Z0_PRE_COMMIT over all of it and the surface snapshot; `failed` when setup failed. */
function stageTask(ctx, run, step) {
  const { t } = step;
  const work = run.dirs.work;
  const prepare = () => ({ commit: checkoutBase(run.cached, work, run.s.id, t, run.arm), setup: t.setup ? sh(t.setup, work, childEnv(run.env)) : null });
  const { commit, setup } = prepare();
  if (setup && setup.status !== 0) return { commit, setup, failed: true };
  // Setup's own writes are part of the baseline, so they are never counted as the agent's and never carried.
  const baseline = instructionSnapshot(work);
  if (run.arm === 'A4' && run.taught.length) fs.appendFileSync(path.join(work, 'CLAUDE.md'), memoryText(run.taught));
  // Init waits for the first step whose setup passed, so a skipped first task cannot leave A2/A5 without hippo.
  if (HIPPO_ARMS.has(run.arm) && !run.initDone) {
    hippoInit(run, ctx.fakeHome);
    run.initDone = true;
  }
  const carry = CARRY_ARMS.has(run.arm) ? applyInstructions(work, run.changes, baseline, path.join(ctx.outDir, 'tmp')) : NO_CARRY;
  const stage = { commit, prepare, baseline, carry, homesAtStart: run.sessionRan ? null : homeFiles(run.dirs), preSession: instructionSnapshot(work) };
  stage.pre = stateCommit(work, commit);
  holdPre(work, stage.pre);
  stage.step = step;
  stage.restores = [];
  stage.snap = snapshotSurfaces(ctx, run, 'pre-session', step);
  // A retry restores every surface to this snapshot, so the delivery verdict holds for the rerun too.
  stage.delivery = deliveryHits(run, stage.snap, stage.preSession);
  stage.transcriptsBefore = new Set(listTranscripts(projectsOf(run)));
  return stage;
}

/** The session-1 usage-limit reset: the checkout, every memory surface and every runner write back, without rerunning init, and a fresh Z0_PRE_COMMIT. */
function resetTask(ctx, run, t, stage) {
  const work = run.dirs.work;
  const again = stage.prepare().setup;
  if (again && again.status !== 0) throw new Error(`${cellName(run, t)}: setup failed on the usage-limit rerun (exit ${again.status})`);
  stage.restores.push(restoreSurfaces(ctx, run, stage.snap, 'retry-restore', stage.step));
  restoreInstructions(work, stage.preSession);
  stage.pre = stateCommit(work, stage.commit);
  holdPre(work, stage.pre);
  // The cut-off attempt's transcript stays (prereg 113), so it must never be taken for the rerun's.
  stage.transcriptsBefore = new Set(listTranscripts(projectsOf(run)));
  stage.ancestors ||= ancestorHits(ctx, run, t);
  ctx.log(`${cellName(run, t)}: Z0_PRE_COMMIT rebuilt after the usage-limit reset`);
}

/** Run every lesson check through one door, so a broken checker is kept once and never read as a verdict. */
function checker(ctx, run, t, stage, sessionIds) {
  const state = { error: null, calls: [] };
  state.check = (lesson, hold = state.calls.length ? null : FIRST_REF) => {
    const work = run.dirs.work;
    const postCommit = stage.fault ? null : guarded(run, t, stage, () => stateCommit(work, stage.pre));
    if (!postCommit) return null;
    if (hold) guarded(run, t, stage, () => holdPre(work, postCommit, hold));
    if (stage.fault) return null;
    const commands = commandLog(transcriptsOf(run, sessionIds));
    state.calls.push({ lessonId: lesson.id, post: postCommit, commands });
    try {
      return guarded(run, t, stage, () => runCheck(lesson, { work, env: childEnv(run.env), preCommit: stage.pre, postCommit, commands, scratch: path.join(run.dirs.root, 'scratch') }));
    } catch (err) {
      if (!(err instanceof CheckerError)) throw err;
      writeLog(run, `${t.id}.checker.txt`, `${err.message}\n${err.stderr}`);
      state.error ??= err;
      return null;
    }
  };
  return state;
}

/** Checks and the one resume of a teach or apply task (prereg 105-110); null for a no-lesson task. */
async function lessonTurns(ctx, run, step, stage, sessionIds) {
  const { t, role } = step;
  if (role.kind === 'no-lesson') return null;
  const { lesson } = ctx.lessons.get(role.lessonId);
  const c = checker(ctx, run, t, stage, sessionIds);
  const first = c.check(lesson);
  const old = role.afterReversal ? ctx.lessons.get(lesson.supersedes).lesson : null;
  const staleFollow = old ? c.check(old, STALE_REF) === 'pass' : null;
  const teach = role.kind === 'teach';
  const form = teach ? (first === 'fail' ? 'correction' : 'confirmation') : 'correction';
  // What the grading save keeps (166): each check's post commit and the commands each verdict saw.
  const saved = () => {
    const own = c.calls.filter((x) => x.lessonId === lesson.id);
    const stale = old ? c.calls.find((x) => x.lessonId === old.id) : undefined;
    return {
      staleLesson: old, firstPost: own[0]?.post ?? null, commandsFirst: own[0]?.commands ?? null, commandsFinal: own.at(-1)?.commands ?? null,
      finalChecked: own.length > 1, finalCheckPost: own.at(-1)?.post ?? null, stalePost: stale?.post ?? null, commandsStale: stale?.commands ?? null,
    };
  };
  // A teach whose checker crashed is still taught (reading 9); an apply resumes only on a real fail; a screen session never (reading 4).
  const noResume = { lesson, first, final: first, staleFollow, checkerError: c.error, resume: null, form: null, ...saved() };
  // Rechecked after grading on every graded cell, so a file a checker left voids the cell whatever its verdict.
  if ((stage.ancestors ||= ancestorHits(ctx, run, t))) return noResume;
  // A broken workspace git voids the cell, so a teach is not resumed and A4 is never taught from it.
  if (role.kind === 'screen' || stage.fault || (!teach && (first !== 'fail' || c.error))) return noResume;
  let resumeAncestorHits;
  // Only a failing apply resumes, so its resume-time file is kept, never invalidating it; every teach resumes, so its file voids it (reading 13).
  const resumeAncestors = () => {
    if (teach) return (stage.ancestors ||= ancestorHits(ctx, run, t));
    const hits = ancestorFiles(ctx, run, `${t.id}.resume-ancestor.txt`);
    if (hits.length) resumeAncestorHits = hits.map((h) => path.relative(ctx.outDir, h).split(path.sep).join('/'));
    return hits.length > 0;
  };
  await settle(ctx, run, t.id, 'pre-resume');
  // Again after the hooks settle, since one could write above work/ before the resume reads it; the resume would load it, so it is skipped.
  if (resumeAncestors()) return { ...noResume, resumeAncestorHits };
  const preResume = snapshotSurfaces(ctx, run, 'pre-resume', step);
  // Memory session 1 wrote reaches the resume; a rerun restores to this snapshot, so the verdict holds for it too.
  stage.resumeDelivery = newHits(deliveryHits(run, preResume, instructionSnapshot(run.dirs.work)), stage.delivery);
  // A file a cut-off attempt left above work/ stops the rerun, so it never spends plan usage and A4 is never taught from it.
  const afterReset = () => {
    stage.restores.push(restoreSurfaces(ctx, run, preResume, 'resume-restore', step));
    return resumeAncestors();
  };
  const resume = await resumeSession(ctx, run, t, sessionIds[0], teachMessage(lesson, form), afterReset).catch((err) => guarded(run, t, stage, () => { throw err; }));
  if (!resume) return noResume;
  // The reset put the transcripts back, so no resume ran; only its retries and wait are kept.
  if (resume.stopped) return { ...noResume, resumeAncestorHits, cutOffResume: resume };
  writeRaw(run, `${t.id}.resume.json`, resume.cc.stdout || JSON.stringify({ error: resume.cc.stderr.slice(0, 4000), status: resume.cc.status }));
  const timedOut = !resume.result && resume.cc.timedOut;
  // A resume killed before its result names no id; one that forked a new id left a new top-level file.
  const fresh = timedOut ? newSessionIds(run, resume.filesBefore)[0] : null;
  const resumeId = resume.result?.session_id ?? fresh;
  if (resumeId && !sessionIds.includes(resumeId)) sessionIds.push(resumeId);
  // Prereg 165: a timed-out resume is graded on the state at the kill.
  const final = (resume.result || timedOut) && !c.error ? c.check(lesson, FINAL_CHECK_REF) : first;
  const main = findTranscript(projectsOf(run), sessionIds[0]);
  const grew = Boolean(fresh) || (main !== null && fs.statSync(main).size > resume.bytesBefore);
  // Decision 7: a timed-out teach resume delivered the lesson once its transcript grew past the teach message.
  const delivered = Boolean(resume.result) || (timedOut && grew);
  return { lesson, first, final, staleFollow, checkerError: c.error, resume, delivered, form: teach ? form : null, ...saved() };
}

const newHits = (hits, known) => hits.filter((h) => !known.some((k) => JSON.stringify(k) === JSON.stringify(h)));

const sum = (a, b) => (a === null || a === undefined ? null : a + (b ?? 0));

/** Why the cell is invalid, in precedence order, or null. */
function invalidReason(session, turns, transcriptsFound, stage) {
  // The environment void comes first: it taints the session whatever the session itself did.
  if (stage.ancestors) return 'ancestor-instructions';
  // A timed-out turn has no result but is graded (prereg 165); with no transcript it falls to no-transcript below.
  if (session.result === null && !session.cc.timedOut) return 'no-result';
  if (stage.fault) return 'workspace';
  if (turns?.checkerError) return 'checker';
  if (turns?.resume && turns.resume.result === null && !turns.resume.cc.timedOut) return 'resume';
  return transcriptsFound ? null : 'no-transcript';
}

function agentError(session, turns) {
  const exited = (cc, who) => (cc.timedOut ? `${who}claude timed out` : `${who}claude exited ${cc.status}: ${cc.stderr.slice(0, 300)}`);
  const say = (cc, result, who) => (result === null ? exited(cc, who) : (result.is_error ? result.subtype ?? 'error' : null));
  const resumed = turns?.resume ? say(turns.resume.cc, turns.resume.result, 'resume: ') : null;
  return say(session.cc, session.result, '') ?? resumed;
}

/** Session 1's and the resume's share of the transcripts: each file session 1 wrote, subagents included, splits where session 1 ended. */
function turnSegments(run, sessionIds, resume) {
  const own = transcriptsOf(run, sessionIds.slice(0, 1));
  if (!resume) return { first: own.map((file) => ({ file })), extra: [] };
  const at = (file) => resume.sizesBefore.get(file);
  const first = own.filter((file) => at(file) !== undefined).map((file) => ({ file, toBytes: at(file) }));
  const extra = own.map((file) => (at(file) === undefined ? { file } : { file, fromBytes: at(file) }));
  return { first, extra: [...extra, ...transcriptsOf(run, sessionIds.slice(1)).map((file) => ({ file }))] };
}

const mainsOnly = (segments) => segments.filter((s) => path.basename(path.dirname(s.file)) !== 'subagents');

/** Usage, cost and turns per turn: the result's, or for a turn killed before its result (prereg 165) its share of the transcripts. */
function pricing(run, session, resume, sessionIds) {
  const r = session.result;
  const rr = resume?.result ?? null;
  const { first, extra } = turnSegments(run, sessionIds, resume);
  const priced = Boolean(r) && (!resume || Boolean(rr));
  // A resume forked to a new id can start its file with a copy of session 1's messages, which session 1 already paid for.
  const paid = resume && !rr ? assistantIds(first) : new Set();
  return {
    usage: {
      firstSession: r ? usageFromResult(r) : transcriptUsage(first),
      extra: !resume ? ZERO_USAGE : (rr ? usageFromResult(rr) : transcriptUsage(extra, paid)),
    },
    costUsd: priced ? sum(r.total_cost_usd ?? null, rr?.total_cost_usd) : null,
    // Turns count the main transcripts only; usage takes subagent files too.
    turns: (r ? r.num_turns ?? 0 : assistantTurns(mainsOnly(first))) + (!resume ? 0 : (rr ? rr.num_turns ?? 0 : assistantTurns(mainsOnly(extra), paid))),
    turnsSource: priced ? 'result' : 'transcript',
  };
}

/** G1 over session 1, plus the resume: every teach resumes, so its resume hits void; only a failing apply does, so its are only kept. */
function resumeAwareVoid(ctx, run, step, stage, sessionIds, resume) {
  const { first, extra } = turnSegments(run, sessionIds, resume);
  const g1 = sessionVoid(ctx, run, step, { files: first, ownIds: sessionIds, delivery: stage.delivery });
  if (!resume) return g1;
  const g2 = sessionVoid(ctx, run, step, { files: extra, ownIds: sessionIds, delivery: stage.resumeDelivery ?? [] });
  if (step.role.kind !== 'teach') return { ...g1, resumeVoidHits: g2.voidHits.length ? g2.voidHits : undefined };
  const hits = byPrecedence([...g1.voidHits, ...g2.voidHits]);
  return { void: hits[0]?.reason ?? null, voidHits: hits };
}

/** The record for a cell whose session ran. */
function sessionRecord(ctx, run, step, parts) {
  const { session, turns, sessionIds, acceptancePassed, wallMs, stage } = parts;
  const projects = projectsOf(run);
  // A result without a session id has no transcript to read, so it is no-transcript, never a record with null work counts.
  const found = sessionIds.length > 0 && sessionIds.every((id) => findTranscript(projects, id));
  const resume = turns?.resume ?? null;
  const resumeId = resume?.result?.session_id ?? (resume?.cc.timedOut ? sessionIds.at(-1) : null);
  const g1 = resumeAwareVoid(ctx, run, step, stage, sessionIds, resume);
  const shared = {
    void: g1.void, voidHits: g1.void ? g1.voidHits : undefined, resumeVoidHits: g1.resumeVoidHits, resumeAncestorHits: turns?.resumeAncestorHits,
    timedOut: session.cc.timedOut || Boolean(resume?.cc.timedOut), limitRetries: session.limitRetries + ((resume ?? turns?.cutOffResume)?.limitRetries ?? 0),
    sessionId: session.result?.session_id ?? sessionIds[0] ?? null, resumeSessionId: resumeId ?? null, agentError: agentError(session, turns),
    ...stage.carry, homesAtStart: stage.homesAtStart, envKeys: Object.keys(run.env).sort(), passEnv: ctx.passEnv,
    surfaceRestored: stage.restores.every(Boolean), injectedRows: stage.injected,
  };
  const reason = invalidReason(session, turns, found, stage);
  if (reason) return invalidRecord(parts.base, reason, shared);
  return validRecord(parts.base, {
    lessons: turns ? [{ lessonId: turns.lesson.id, first: turns.first, final: turns.final, staleFollow: turns.staleFollow }] : [],
    acceptancePassed, ...pricing(run, session, resume, sessionIds),
    ...transcriptWork(transcriptsOf(run, sessionIds), run.seenErrors), transcriptFound: true, wallMs,
    teachTurns: step.role.kind === 'teach' ? 1 : 0, correctionTurns: step.role.kind === 'apply' && resume ? 1 : 0, teachForm: turns?.form ?? null,
    hippo: HIPPO_ARMS.has(run.arm) ? hippoSentFor(path.join(run.dirs.work, '.hippo'), sessionIds) : null, ...shared,
    chain: chainOf(run, step, stage, turns),
  });
}

/** Session 1's id: the result's, or for a session killed before its result the id it was started under, else its one new transcript. */
function firstSessionIds(ctx, run, t, session, stage) {
  if (session.result?.session_id) return [session.result.session_id];
  if (!session.cc.timedOut) return [];
  if (findTranscript(projectsOf(run), session.sessionId)) return [session.sessionId];
  const fresh = newSessionIds(run, stage.transcriptsBefore);
  if (fresh.length > 1) ctx.log(`${cellName(run, t)}: ${fresh.length} new transcripts after a timeout; taking the newest, ${fresh[0]}`);
  return fresh.slice(0, 1);
}

/** Worktrees the agent added outside work/, kept with the step that made them: a later session that reads one is void (162). */
function noteWorktrees(ctx, run, step) {
  const work = run.dirs.work;
  const listed = agentGit(work, (rgit) => rgit(['worktree', 'list', '--porcelain'], work));
  // Git prints the long, link-free path while work/ may sit under a short name or an alias, so both sides are folded.
  const home = foldPath(work);
  for (const m of listed.matchAll(/^worktree (.+)$/gm)) {
    const dir = foldPath(m[1].trim());
    if (!under(dir, home) && !ctx.foreignDirs.some((f) => f.path === dir)) ctx.foreignDirs.push({ path: dir, order: step.order });
  }
}

/** Session 1, checks and resume, the end-of-task steps once after the last turn, then the hidden tests. */
async function runTurns(ctx, run, step, stage, base) {
  const { t } = step;
  const work = run.dirs.work;
  // Monotonic, so a wall-clock step (NTP, a WSL resync) cannot make wallMs negative.
  const started = performance.now();
  const session = await runSession(ctx, run, t, () => resetTask(ctx, run, t, stage));
  run.sessionRan = true;
  writeRaw(run, `${t.id}.json`, session.cc.stdout || JSON.stringify({ error: session.cc.stderr.slice(0, 4000), status: session.cc.status }));
  // Reading 13: every cell kind, before any check, so whether a cell is void never depends on its verdict.
  stage.ancestors ||= ancestorHits(ctx, run, t);
  const sessionIds = firstSessionIds(ctx, run, t, session, stage);
  // Before the resume, so its transcript lines are not yet there.
  if (stage.chainPre) stage.chainPre.shown ||= shownInSession(run, stage.chainPre.lesson, sessionIds);
  // A timed-out session is still checked and resumed (prereg 109, 165).
  const turns = sessionIds.length && !stage.ancestors ? await lessonTurns(ctx, run, step, stage, sessionIds) : null;
  const wallMs = Math.round(performance.now() - started - session.cutOffMs - ((turns?.resume ?? turns?.cutOffResume)?.cutOffMs ?? 0));
  // Before the end hooks and the hidden tests, so the final tree is the agent's alone.
  if (!stage.fault) stage.finalPost = guarded(run, t, stage, () => stateCommit(work, stage.pre));
  await settle(ctx, run, t.id, 'end');
  snapshotSurfaces(ctx, run, 'end', step);
  if (HIPPO_ARMS.has(run.arm)) stage.injected = hippoEnd(ctx, run, step, stage, sessionIds);
  guarded(run, t, stage, () => noteWorktrees(ctx, run, step));
  if (CARRY_ARMS.has(run.arm)) run.changes = instructionDelta(stage.baseline, instructionSnapshot(work));
  // Reading 8: A4 holds a lesson only once its teach resume delivered it.
  if (step.role.kind === 'teach' && turns?.delivered) run.taught = withTaught(run.taught, turns.lesson);
  writeHiddenTests(run.cached, work, t);
  const test = sh(t.test, work, childEnv(run.env));
  writeLog(run, `${t.id}.test.txt`, `${test.stdout}\n${test.stderr}`);
  // Dropped here, not in runTask's finally, so a .git the agent broke voids this cell instead of throwing.
  stage.dropped = true;
  guarded(run, t, stage, () => dropPre(work));
  const parts = { base, session, turns, sessionIds, acceptancePassed: test.status === 0, wallMs, stage };
  const record = sessionRecord(ctx, run, step, parts);
  if (record.invalid || step.role.kind === 'screen') return record;
  // A cell whose trees cannot be saved cannot be regraded (166), so it turns invalid like any other workspace fault.
  const saved = guarded(run, t, stage, () => {
    saveGrading(ctx, run, step, stage, turns, record);
    return true;
  });
  return saved ? record : sessionRecord(ctx, run, step, parts);
}

/** This sequence's lessons whose teach the run has not reached; none in a screen run, which teaches outside the drawn order. */
function openLessons(ctx, run, step) {
  if (step.role.kind === 'screen') return [];
  return [...ctx.lessons.values()].filter(({ lesson, family }) => family.sequence === run.s.id && !run.teachSeen.has(lesson.id)).map(({ lesson }) => lesson);
}

/** Both hippo stores' entries now, each with its surface key and its path under the run root; none in an arm without hippo. */
function hippoStores(run) {
  return [['hippoWork', path.join(run.dirs.work, '.hippo')], ['hippoGlobal', run.dirs.hippoHome]].map(([surface, dir]) => ({
    surface, path: path.relative(run.dirs.root, dir).split(path.sep).join('/'), entries: storeEntries(dir),
  }));
}

/** G3 at pre-session: every open lesson's key phrase in a memory surface, a hippo store, the workspace or the prompt. */
function phraseLeaks(run, step, stage, open) {
  return findLeaks(open, { t: step.t, root: run.dirs.root, work: run.dirs.work, pre: stage.pre, surfaces: stage.snap.surfaces, stores: stage.stores });
}

/** An apply's chain parts that only the pre-session state shows (prereg 179-180). */
function chainAtStart(ctx, run, step, stage) {
  const { lesson } = ctx.lessons.get(step.role.lessonId);
  const at = { root: run.dirs.root, surfaces: stage.snap.surfaces, stores: stage.stores };
  return { lesson, stored: storedAt(lesson, at), shown: shownAtStart(lesson, at) };
}

/** Session 1's share of `shown` (decision 23): the key phrase in a hook's added context or a tool result, main or subagent. */
const shownInSession = (run, lesson, sessionIds) => {
  const files = transcriptsOf(run, sessionIds);
  return [...hookContexts(files), ...toolResultTexts(files)].some(({ text }) => holds(text, lesson.keyPhrase));
};

/** A valid apply's failure chain (prereg 179-182); `captured` is A2's alone, copied from its teach cell. */
function chainOf(run, step, stage, turns) {
  if (step.role.kind !== 'apply') return undefined;
  const { stored, shown } = stage.chainPre;
  const none = { captured: null, capturedAny: null };
  const capture = run.arm === 'A2' ? run.captured.get(step.role.lessonId) ?? { captured: false, capturedAny: false } : none;
  return { stored, shown, followed: followedOf(shown, turns?.first), ...capture };
}

/** End of a hippo cell: the injected rows (prereg 93) over both loads of the stores, and an A2 teach's capture (182). */
function hippoEnd(ctx, run, step, stage, sessionIds) {
  const end = hippoStores(run);
  if (run.arm === 'A2' && step.role.kind === 'teach') run.captured.set(step.role.lessonId, capturedBy(ctx.lessons.get(step.role.lessonId).lesson, end));
  // Both loads, so a row sleep removed during the session still matches.
  const byId = new Map([...stage.stores, ...end].flatMap((s) => s.entries.map((e) => [e.id, { ...e, global: s.surface === 'hippoGlobal' }])));
  const texts = hookContexts(transcriptsOf(run, sessionIds)).map(({ text }) => text);
  return recordInjected(ctx, run, step, texts, [...byId.values()]);
}

/** Every step in order; a step's run is keyed by its dir name, arm and seed, and a screen step may preset what A4 was taught. */
export async function runSteps(ctx, steps) {
  const runs = new Map();
  for (const [order, step] of steps.entries()) {
    // Every session is synchronous; yielding once a step keeps the host's event loop (signals, a test worker's RPC) alive.
    await new Promise((resolve) => setImmediate(resolve));
    const { seed, arm, sequence: s } = step;
    const name = step.runName ?? s.id;
    const key = `${name}|${arm}|${seed}`;
    if (!runs.has(key)) runs.set(key, { ...startRun(ctx, s, arm, seed, name), taught: step.taught ?? [] });
    await runTask(ctx, runs.get(key), { ...step, order });
    ctx.progress.last = `step ${order}: ${name} ${step.taskId} ${arm} seed${seed}`;
  }
  return ctx.records;
}

/** One step: prepare the checkout, skip the session if the step is void before it starts, else run, check, resume and record it. */
async function runTask(ctx, run, step) {
  const { t } = step;
  const base = baseFields(ctx, run, step);
  const meta = { envKeys: Object.keys(run.env).sort(), passEnv: ctx.passEnv };
  const open = openLessons(ctx, run, step);
  // Closed on reaching its teach, so a teach whose setup fails cannot leave its lesson open for the rest of the run.
  if (step.role.kind === 'teach') run.teachSeen.add(step.role.lessonId);
  const leakKey = `${run.runName}|${run.seed}`;
  const leakFrom = ctx.leakedRuns.get(leakKey);
  if (leakFrom) {
    // Every later cell of a leaked (sequence, seed) still gets a record, so the run is never read as cut off (164, 114).
    writeRecord(ctx, invalidRecord(base, 'leak', { leak: true, leakFrom, ...NOT_STAGED, ...meta }));
    return;
  }
  fs.mkdirSync(run.rawDir, { recursive: true });
  const stage = stageTask(ctx, run, step);
  base.baseCommit = stage.commit;
  if (stage.failed) {
    // No claude session, no hidden-test run: a failed setup is not a genuine "not resolved". Carry never ran, so its counts are null.
    writeLog(run, `${t.id}.setup.txt`, `${stage.setup.stdout}\n${stage.setup.stderr}`);
    writeRecord(ctx, invalidRecord(base, 'setup', { agentError: `setup failed (exit ${stage.setup.status})`, ...NOT_STAGED, ...meta }));
    return;
  }
  let failing = false;
  try {
    stage.stores = hippoStores(run);
    const leakHits = phraseLeaks(run, step, stage, open);
    if (leakHits.length || (HIPPO_ARMS.has(run.arm) && storeLeaks(path.join(run.dirs.work, '.hippo'), goldLines(run.cached, t)))) {
      // The leak is known before the session, so a session the analysis voids is never run and costs no plan usage.
      run.changes = instructionDelta(stage.baseline, instructionSnapshot(run.dirs.work));
      ctx.leakedRuns.set(leakKey, { arm: run.arm, position: step.position, taskId: t.id });
      const hits = leakHits.length ? { leakHits } : {};
      writeRecord(ctx, invalidRecord(base, 'leak', { leak: true, ...hits, ...stage.carry, homesAtStart: stage.homesAtStart, ...meta }));
      return;
    }
    if (ancestorHits(ctx, run, t)) {
      // Like a leak, the void is known before the session, so the session never runs; later cells of this run stay void while the file stays.
      run.changes = instructionDelta(stage.baseline, instructionSnapshot(run.dirs.work));
      writeRecord(ctx, invalidRecord(base, 'ancestor-instructions', { ...stage.carry, homesAtStart: stage.homesAtStart, ...meta }));
      return;
    }
    if (step.role.kind === 'apply') {
      stage.chainPre = chainAtStart(ctx, run, step, stage);
      stage.surfaceText = surfaceText({ root: run.dirs.root, surfaces: stage.snap.surfaces, stores: stage.stores });
    }
    writeRecord(ctx, await runTurns(ctx, run, step, stage, base));
  } catch (err) {
    failing = true;
    throw err;
  } finally {
    // The runner's ref never outlives its task, an abandoned run's included.
    if (!stage.dropped) dropAfter(ctx, run, t, failing);
  }
}

function dropAfter(ctx, run, t, failing) {
  try {
    dropPre(run.dirs.work);
  } catch (err) {
    // A broken .git must not hide why the run stopped, such as the plan limit, so the error in flight stands.
    if (!failing || !(err instanceof WorkspaceGitError)) throw err;
    ctx.log(`${cellName(run, t)}: ${err.message}; the run's own error stands`);
  }
}
