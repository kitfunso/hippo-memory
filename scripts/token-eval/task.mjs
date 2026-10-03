// One task cell (prereg 105-110): stage the workspace, session 1, the lesson check, one resume, the final check, the record.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sh } from './exec.mjs';
import { HIPPO_ARMS, CARRY_ARMS, childEnv } from './arms.mjs';
import { homeFiles, ancestorInstructionFiles } from './homes.mjs';
import { checkoutBase, instructionSnapshot, instructionDelta, applyInstructions, restoreInstructions, writeHiddenTests, goldLines } from './workspace.mjs';
import { findTranscript, transcriptWork, commandLog, usageFromResult, invalidRecord, validRecord } from './records.mjs';
import { hippoInit, storeLeaks, hippoSentFor, writeRecord, settle } from './runs.mjs';
import { runSession, resumeSession } from './turns.mjs';
import { runCheck, stateCommit, holdPre, dropPre, CheckerError } from './checks.mjs';
import { teachMessage, withTaught, memoryText, wordOverlap } from './lessons.mjs';

const NO_CARRY = { carryMerges: 0, carryUnionMerges: 0, carryDeleteKept: 0 };
const ZERO_USAGE = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
const cellName = (run, t) => `${run.s.id} ${t.id} ${run.arm} seed${run.seed}`;
const writeRaw = (run, name, text) => fs.writeFileSync(path.join(run.rawDir, name), text.slice(-20000));

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
    const files = sessionIds.map((id) => findTranscript(path.join(run.dirs.claudeConfig, 'projects'), id)).filter(Boolean);
    try {
      return runCheck(lesson, {
        work, env: childEnv(run.env), preCommit: stage.pre, postCommit: stateCommit(work, stage.pre),
        commands: commandLog(files), scratch: path.join(run.dirs.root, 'scratch'),
      });
    } catch (err) {
      if (!(err instanceof CheckerError)) throw err;
      writeRaw(run, `${t.id}.checker.txt`, `${err.message}\n${err.stderr}`);
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
  // A teach whose checker crashed is still taught (reading 9); an apply resumes only on a real fail.
  if (!teach && (first !== 'fail' || c.error)) return { lesson, first, final: first, staleFollow, checkerError: c.error, resume: null, form: null };
  // The resume would load a file session 1 left above work/, so the cell is void already and the resume never spends plan usage.
  if (ancestorHits(ctx, run, t)) {
    stage.ancestors = true;
    return { lesson, first, final: first, staleFollow, checkerError: c.error, resume: null, form: null };
  }
  await settle(ctx, run, t.id, 'pre-resume');
  const resume = await resumeSession(ctx, run, t, sessionIds[0], teachMessage(lesson, form), () => { stage.ancestors ||= ancestorHits(ctx, run, t); });
  writeRaw(run, `${t.id}.resume.json`, resume.cc.stdout || JSON.stringify({ error: resume.cc.stderr.slice(0, 4000), status: resume.cc.status }));
  if (resume.result?.session_id && !sessionIds.includes(resume.result.session_id)) sessionIds.push(resume.result.session_id);
  const final = resume.result && !c.error ? c.check(lesson) : first;
  return { lesson, first, final, staleFollow, checkerError: c.error, resume, form: teach ? form : null };
}

const sum = (a, b) => (a === null || a === undefined ? null : a + (b ?? 0));

/** Why the cell is invalid, in precedence order, or null. */
function invalidReason(stage, session, turns, transcriptsFound) {
  // The environment void comes first: it taints the session whatever the session itself did.
  if (stage.ancestors) return 'ancestor-instructions';
  if (session.result === null) return 'no-result';
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
  const files = sessionIds.map((id) => findTranscript(projects, id));
  const resume = turns?.resume ?? null;
  const shared = {
    timedOut: session.cc.timedOut || Boolean(resume?.cc.timedOut), limitRetries: session.limitRetries + (resume?.limitRetries ?? 0),
    sessionId: session.result?.session_id ?? null, resumeSessionId: resume?.result?.session_id ?? null, agentError: agentError(session, turns),
    ...stage.carry, homesAtStart: stage.homesAtStart, envKeys: Object.keys(run.env).sort(), passEnv: ctx.passEnv,
  };
  const reason = invalidReason(stage, session, turns, files.every(Boolean));
  if (reason) return invalidRecord(parts.base, reason, shared);
  const r = session.result;
  return validRecord(parts.base, {
    lessons: turns ? [{ lessonId: turns.lesson.id, first: turns.first, final: turns.final, staleFollow: turns.staleFollow }] : [],
    acceptancePassed, usage: { firstSession: usageFromResult(r), extra: resume ? usageFromResult(resume.result) : ZERO_USAGE },
    costUsd: sum(r.total_cost_usd ?? null, resume?.result.total_cost_usd), turns: (r.num_turns ?? 0) + (resume?.result.num_turns ?? 0),
    ...transcriptWork(files, run.seenErrors), transcriptFound: true, wallMs,
    teachTurns: step.role.kind === 'teach' ? 1 : 0, correctionTurns: step.role.kind === 'apply' && resume ? 1 : 0, teachForm: turns?.form ?? null,
    hippo: HIPPO_ARMS.has(run.arm) ? hippoSentFor(path.join(run.dirs.work, '.hippo'), r.session_id) : null, ...shared,
  });
}

/** Session 1, checks and resume, the end-of-task steps once after the last turn, then the hidden tests. */
async function runTurns(ctx, run, step, stage, base) {
  const { t } = step;
  const work = run.dirs.work;
  const started = Date.now();
  const session = await runSession(ctx, run, t, () => resetTask(ctx, run, t, stage));
  run.sessionRan = true;
  writeRaw(run, `${t.id}.json`, session.cc.stdout || JSON.stringify({ error: session.cc.stderr.slice(0, 4000), status: session.cc.status }));
  const sessionIds = session.result?.session_id ? [session.result.session_id] : [];
  const turns = session.result ? await lessonTurns(ctx, run, step, stage, sessionIds) : null;
  const wallMs = Date.now() - started - session.waitedMs - (turns?.resume?.waitedMs ?? 0);
  await settle(ctx, run, t.id, 'end');
  if (CARRY_ARMS.has(run.arm)) run.changes = instructionDelta(stage.baseline, instructionSnapshot(work));
  // Reading 8: A4 holds a lesson only once its teach resume delivered it.
  if (step.role.kind === 'teach' && turns?.resume?.result) run.taught = withTaught(run.taught, turns.lesson);
  writeHiddenTests(run.cached, work, t);
  const test = sh(t.test, work, childEnv(run.env));
  writeRaw(run, `${t.id}.test.txt`, `${test.stdout}\n${test.stderr}`);
  return sessionRecord(ctx, run, step, { base, session, turns, sessionIds, acceptancePassed: test.status === 0, wallMs, stage });
}

/** One step: prepare the checkout, skip the session if the step is void before it starts, else run, check, resume and record it. */
export async function runTask(ctx, run, step) {
  const { t } = step;
  const base = baseFields(ctx, run, step);
  const meta = { envKeys: Object.keys(run.env).sort(), passEnv: ctx.passEnv };
  fs.mkdirSync(run.rawDir, { recursive: true });
  const stage = stageTask(ctx, run, t);
  base.baseCommit = stage.commit;
  if (stage.failed) {
    // No claude session, no hidden-test run: a failed setup is not a genuine "not resolved". Carry never ran, so its counts are null.
    writeRaw(run, `${t.id}.setup.txt`, `${stage.setup.stdout}\n${stage.setup.stderr}`);
    const nulls = { carryMerges: null, carryUnionMerges: null, carryDeleteKept: null, homesAtStart: null };
    writeRecord(ctx, invalidRecord(base, 'setup', { agentError: `setup failed (exit ${stage.setup.status})`, ...nulls, ...meta }));
    return;
  }
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
  } finally {
    // The runner's ref never outlives its task, an abandoned run's included.
    dropPre(run.dirs.work);
  }
}
