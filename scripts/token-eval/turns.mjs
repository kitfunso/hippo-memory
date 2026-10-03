// Claude Code turns for one task: session 1 and the teach or correction resume, each inside the usage-limit loop.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sh } from './exec.mjs';
import { isUsageLimit, findTranscript } from './records.mjs';
import { sleep } from './runs.mjs';
import { withScratchGit } from './checks.mjs';
import { instructionSnapshot, restoreInstructions } from './workspace.mjs';

function claudeArgs(ctx, run) {
  const args = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--settings', JSON.stringify(run.settingsFile), '--strict-mcp-config', '--permission-mode', ctx.permissionMode];
  if (ctx.model) args.push('--model', ctx.model);
  if (ctx.maxBudgetUsd) args.push('--max-budget-usd', String(ctx.maxBudgetUsd));
  return args;
}

function lastJson(stdout) {
  try {
    return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '');
  } catch {
    // No JSON line is no result; the record says so instead of guessing one.
    return null;
  }
}

/** Run claude until it is not at the plan limit, calling `reset` before each rerun. */
async function untilNotLimited(ctx, run, t, { args, input, rawName, reset }) {
  let waitedMs = 0;
  // SHORTCUT: 15-minute polls up to 24h; parse the reset time if waits get long.
  for (let attempt = 1; ; attempt++) {
    const cc = sh(`${ctx.claude} ${args.join(' ')}`, run.dirs.work, run.env, 60 * 60_000, input);
    const result = lastJson(cc.stdout);
    if (!isUsageLimit(result, `${cc.stdout}\n${cc.stderr}`)) return { cc, result, limitRetries: attempt - 1, waitedMs };
    fs.writeFileSync(path.join(run.rawDir, `${t.id}.${rawName}${attempt}.txt`), `${cc.stdout}\n${cc.stderr}`.slice(-20000));
    // Prereg: a run that stops partway is abandoned and never analysed, so a limit that outlasts every wait ends the run.
    if (attempt > ctx.limitMaxWaits) throw new Error(`${run.s.id} ${t.id} ${run.arm} seed${run.seed}: still at the plan limit after ${ctx.limitMaxWaits} waits`);
    ctx.log(`${run.s.id} ${t.id} ${run.arm} seed${run.seed}: plan limit hit, waiting ${Math.round(ctx.limitWaitMs / 60_000)} min (attempt ${attempt})`);
    const start = Date.now();
    await sleep(ctx.limitWaitMs);
    waitedMs += Date.now() - start;
    reset();
  }
}

/** Session 1 on the task prompt. */
export async function runSession(ctx, run, t, reset) {
  return untilNotLimited(ctx, run, t, { args: claudeArgs(ctx, run), input: t.prompt, rawName: 'limit', reset });
}

/** One resume of `sessionId` with `message` on stdin; a cut-off attempt is undone exactly before the rerun. */
export async function resumeSession(ctx, run, t, sessionId, message, afterReset = () => {}) {
  const args = [...claudeArgs(ctx, run), '--resume', sessionId];
  const snap = workSnapshot(run, sessionId);
  try {
    const reset = () => {
      restoreWork(run, snap, sessionId);
      afterReset();
    };
    return await untilNotLimited(ctx, run, t, { args, input: message, rawName: 'resume-limit', reset });
  } finally {
    fs.rmSync(snap.dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** fn(rgit, env): the runner's isolated git with a throwaway index. */
const withTempIndex = (fn) => withScratchGit((rgit, scratch) => fn(rgit, { GIT_INDEX_FILE: path.join(scratch, 'index') }));

const transcriptOf = (run, sessionId) => findTranscript(path.join(run.dirs.claudeConfig, 'projects'), sessionId);

/** The post-session-1 state: a copy of .git outside the workspace holding the work tree as a tree, instruction files, transcript bytes. */
function workSnapshot(run, sessionId) {
  const work = run.dirs.work;
  const tree = withTempIndex((rgit, env) => {
    rgit(['read-tree', 'HEAD'], work, env);
    rgit(['add', '-A'], work, env);
    return rgit(['write-tree'], work, env).trim();
  });
  // Outside the workspace, so nothing the cut-off attempt does to .git (gc, refs, config, hooks, even rm) reaches the saved state.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-resume-'));
  fs.cpSync(path.join(work, '.git'), path.join(dir, 'git'), { recursive: true });
  const transcript = transcriptOf(run, sessionId);
  return { dir, tree, instructions: instructionSnapshot(work), transcript, transcriptBytes: transcript ? fs.readFileSync(transcript) : null };
}

/** Undo a cut-off resume: .git comes back byte for byte, then the work tree from the saved tree. */
function restoreWork(run, snap, sessionId) {
  const work = run.dirs.work;
  fs.rmSync(path.join(work, '.git'), { recursive: true, force: true, maxRetries: 3 });
  fs.cpSync(path.join(snap.dir, 'git'), path.join(work, '.git'), { recursive: true });
  // SHORTCUT: git-ignored files the cut-off attempt wrote stay; snapshot them too if an agent ever leans on one.
  withTempIndex((rgit, env) => {
    rgit(['read-tree', snap.tree], work, env);
    rgit(['checkout-index', '-a', '-f'], work, env);
    // -ff also drops a nested repo the cut-off attempt made.
    rgit(['clean', '-ffdq'], work, env);
  });
  restoreInstructions(work, snap.instructions);
  if (snap.transcript) fs.writeFileSync(snap.transcript, snap.transcriptBytes);
  else {
    const made = transcriptOf(run, sessionId);
    if (made) fs.rmSync(made);
  }
}
