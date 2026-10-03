// One task cell (prereg 105-110): stage the workspace, session 1, the lesson check, one resume, the final check, the record.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sh } from './exec.mjs';
import { HIPPO_ARMS, CARRY_ARMS, childEnv } from './arms.mjs';
import { homeFiles, ancestorInstructionFiles } from './homes.mjs';
import { checkoutBase, instructionSnapshot, instructionDelta, applyInstructions, restoreInstructions, writeHiddenTests, goldLines } from './workspace.mjs';
import { findTranscript, sessionFiles, transcriptWork, commandLog, usageFromResult, invalidRecord, validRecord } from './records.mjs';
import { hippoInit, storeLeaks, hippoSentFor, writeRecord, settle, startRun } from './runs.mjs';
import { runSession, resumeSession } from './turns.mjs';
import { runCheck, stateCommit, holdPre, dropPre, CheckerError, WorkspaceGitError } from './checks.mjs';
import { teachMessage, withTaught, memoryText, wordOverlap } from './lessons.mjs';

const NO_CARRY = { carryMerges: 0, carryUnionMerges: 0, carryDeleteKept: 0 };
const ZERO_USAGE = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
const cellName = (run, t) => `${run.s.id} ${t.id} ${run.arm} seed${run.seed}`;
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

const transcriptsOf = (run, sessionIds) => sessionIds.flatMap((id) => sessionFiles(path.join(run.dirs.claudeConfig, 'projects'), id));

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

/** Instruction files in the agent-writable dirs between work/ and the out dir, written to the raw dir when there are any. */
function ancestorHits(ctx, run, t) {
  // Claude Code loads every ancestor's CLAUDE.md, and preflight checked only the out dir, before any agent ran.
  const hits = ancestorInstructionFiles(path.dirname(run.dirs.work), { stopAt: ctx.outDir });
  if (hits.length) fs.writeFileSync(path.join(run.rawDir, `${t.id}.ancestor.txt`), `${hits.join('\n')}\n`);
  return hits.length > 0;
}

/** Every runner write before the session, then Z0_PRE_COMMIT over all of it; `failed` when setup failed. */
function stageTask(ctx, run, t) {
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
  return stage;
}

/** The session-1 usage-limit reset: the checkout and every runner write back, without rerunning init, and a fresh Z0_PRE_COMMIT. */
function resetTask(ctx, run, t, stage) {
  const work = run.dirs.work;
  // SHORTCUT: restores instruction files only; store and auto memory wait for the E3 surface restore, so the analyzer voids that position and the rest of its (sequence, seed) in A1/A2/A5
  const again = stage.prepare().setup;
  if (again && again.status !== 0) throw new Error(`${cellName(run, t)}: setup failed on the usage-limit rerun (exit ${again.status})`);
  restoreInstructions(work, stage.preSession);
  stage.pre = stateCommit(work, stage.commit);
  holdPre(work, stage.pre);
  stage.ancestors ||= ancestorHits(ctx, run, t);
  ctx.log(`${cellName(run, t)}: Z0_PRE_COMMIT rebuilt after the usage-limit reset`);
}

/** Run every lesson check through one door, so a broken checker is kept once and never read as a verdict. */
function checker(ctx, run, t, stage, sessionIds) {
  const state = { error: null };
  state.check = (lesson) => {
    const work = run.dirs.work;
    const postCommit = stage.fault ? null : guarded(run, t, stage, () => stateCommit(work, stage.pre));
    if (!postCommit) return null;
    try {
      return runCheck(lesson, {
        work, env: childEnv(run.env), preCommit: stage.pre, postCommit,
        commands: commandLog(transcriptsOf(run, sessionIds)), scratch: path.join(run.dirs.root, 'scratch'),
      });
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
  const staleFollow = old ? c.check(old) === 'pass' : null;
  const teach = role.kind === 'teach';
  const form = teach ? (first === 'fail' ? 'correction' : 'confirmation') : 'correction';
  // A teach whose checker crashed is still taught (reading 9); an apply resumes only on a real fail; a screen session never (reading 4).
  const noResume = { lesson, first, final: first, staleFollow, checkerError: c.error, resume: null, form: null };
  // A broken workspace git voids the cell, so a teach is not resumed and A4 is never taught from it.
  if (role.kind === 'screen' || stage.fault || (!teach && (first !== 'fail' || c.error))) return noResume;
  await settle(ctx, run, t.id, 'pre-resume');
  // A file a cut-off attempt left above work/ voids the cell, so the rerun never spends plan usage and A4 is never taught from it.
  const afterReset = () => (stage.ancestors ||= ancestorHits(ctx, run, t));
  const resume = await resumeSession(ctx, run, t, sessionIds[0], teachMessage(lesson, form), afterReset).catch((err) => guarded(run, t, stage, () => { throw err; }));
  if (!resume) return noResume;
  if (resume.stopped) return { ...noResume, resume };
  writeRaw(run, `${t.id}.resume.json`, resume.cc.stdout || JSON.stringify({ error: resume.cc.stderr.slice(0, 4000), status: resume.cc.status }));
  if (resume.result?.session_id && !sessionIds.includes(resume.result.session_id)) sessionIds.push(resume.result.session_id);
  const final = resume.result && !c.error ? c.check(lesson) : first;
  return { lesson, first, final, staleFollow, checkerError: c.error, resume, form: teach ? form : null };
}

const sum = (a, b) => (a === null || a === undefined ? null : a + (b ?? 0));

/** Why the cell is invalid, in precedence order, or null. */
function invalidReason(session, turns, transcriptsFound, stage) {
  // The environment void comes first: it taints the session whatever the session itself did.
  if (stage.ancestors) return 'ancestor-instructions';
  if (session.result === null) return 'no-result';
  if (stage.fault) return 'workspace';
  if (turns?.checkerError) return 'checker';
  if (turns?.resume && turns.resume.result === null) return 'resume';
  return transcriptsFound ? null : 'no-transcript';
}

function agentError(session, turns) {
  const say = (cc, result, who) => (result === null ? `${who}claude exited ${cc.status}: ${cc.stderr.slice(0, 300)}` : (result.is_error ? result.subtype ?? 'error' : null));
  const resumed = turns?.resume ? say(turns.resume.cc, turns.resume.result, 'resume: ') : null;
  return say(session.cc, session.result, '') ?? resumed;
}

/** The record for a cell whose session ran. */
function sessionRecord(ctx, run, step, parts) {
  const { session, turns, sessionIds, acceptancePassed, wallMs, stage } = parts;
  const projects = path.join(run.dirs.claudeConfig, 'projects');
  // A result without a session id has no transcript to read, so it is no-transcript, never a record with null work counts.
  const found = sessionIds.length > 0 && sessionIds.every((id) => findTranscript(projects, id));
  const resume = turns?.resume ?? null;
  const shared = {
    timedOut: session.cc.timedOut || Boolean(resume?.cc.timedOut), limitRetries: session.limitRetries + (resume?.limitRetries ?? 0),
    sessionId: session.result?.session_id ?? null, resumeSessionId: resume?.result?.session_id ?? null, agentError: agentError(session, turns),
    ...stage.carry, homesAtStart: stage.homesAtStart, envKeys: Object.keys(run.env).sort(), passEnv: ctx.passEnv,
  };
  const reason = invalidReason(session, turns, found, stage);
  if (reason) return invalidRecord(parts.base, reason, shared);
  const r = session.result;
  return validRecord(parts.base, {
    lessons: turns ? [{ lessonId: turns.lesson.id, first: turns.first, final: turns.final, staleFollow: turns.staleFollow }] : [],
    acceptancePassed, usage: { firstSession: usageFromResult(r), extra: resume ? usageFromResult(resume.result) : ZERO_USAGE },
    costUsd: sum(r.total_cost_usd ?? null, resume?.result.total_cost_usd), turns: (r.num_turns ?? 0) + (resume?.result.num_turns ?? 0),
    ...transcriptWork(transcriptsOf(run, sessionIds), run.seenErrors), transcriptFound: true, wallMs,
    teachTurns: step.role.kind === 'teach' ? 1 : 0, correctionTurns: step.role.kind === 'apply' && resume ? 1 : 0, teachForm: turns?.form ?? null,
    hippo: HIPPO_ARMS.has(run.arm) ? hippoSentFor(path.join(run.dirs.work, '.hippo'), sessionIds) : null, ...shared,
  });
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
  const sessionIds = session.result?.session_id ? [session.result.session_id] : [];
  const turns = session.result && sessionIds.length && !stage.ancestors ? await lessonTurns(ctx, run, step, stage, sessionIds) : null;
  const wallMs = Math.round(performance.now() - started - session.cutOffMs - (turns?.resume?.cutOffMs ?? 0));
  await settle(ctx, run, t.id, 'end');
  if (CARRY_ARMS.has(run.arm)) run.changes = instructionDelta(stage.baseline, instructionSnapshot(work));
  // Reading 8: A4 holds a lesson only once its teach resume delivered it.
  if (step.role.kind === 'teach' && turns?.resume?.result) run.taught = withTaught(run.taught, turns.lesson);
  writeHiddenTests(run.cached, work, t);
  const test = sh(t.test, work, childEnv(run.env));
  writeLog(run, `${t.id}.test.txt`, `${test.stdout}\n${test.stderr}`);
  // Dropped here, not in runTask's finally, so a .git the agent broke voids this cell instead of throwing.
  stage.dropped = true;
  guarded(run, t, stage, () => dropPre(work));
  return sessionRecord(ctx, run, step, { base, session, turns, sessionIds, acceptancePassed: test.status === 0, wallMs, stage });
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
  fs.mkdirSync(run.rawDir, { recursive: true });
  const stage = stageTask(ctx, run, t);
  base.baseCommit = stage.commit;
  if (stage.failed) {
    // No claude session, no hidden-test run: a failed setup is not a genuine "not resolved". Carry never ran, so its counts are null.
    writeLog(run, `${t.id}.setup.txt`, `${stage.setup.stdout}\n${stage.setup.stderr}`);
    const nulls = { carryMerges: null, carryUnionMerges: null, carryDeleteKept: null, homesAtStart: null };
    writeRecord(ctx, invalidRecord(base, 'setup', { agentError: `setup failed (exit ${stage.setup.status})`, ...nulls, ...meta }));
    return;
  }
  let failing = false;
  try {
    if (HIPPO_ARMS.has(run.arm) && storeLeaks(path.join(run.dirs.work, '.hippo'), goldLines(run.cached, t))) {
      // The leak is known before the session, so a session the analysis voids is never run and costs no plan usage.
      run.changes = instructionDelta(stage.baseline, instructionSnapshot(run.dirs.work));
      writeRecord(ctx, invalidRecord(base, 'leak', { leak: true, ...stage.carry, homesAtStart: stage.homesAtStart, ...meta }));
      return;
    }
    if (ancestorHits(ctx, run, t)) {
      // Like a leak, the void is known before the session, so the session never runs; later cells of this run stay void while the file stays.
      run.changes = instructionDelta(stage.baseline, instructionSnapshot(run.dirs.work));
      writeRecord(ctx, invalidRecord(base, 'ancestor-instructions', { ...stage.carry, homesAtStart: stage.homesAtStart, ...meta }));
      return;
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
