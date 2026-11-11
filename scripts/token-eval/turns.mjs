// Claude Code turns for one task: session 1 and the teach or correction resume, each inside the usage-limit loop.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnTree } from './exec.mjs';
import { startLogProxy } from './proxy.mjs';
import { isUsageLimit, lastJson, sessionFiles, findTranscript, listTranscripts } from './records.mjs';
import { sleep } from './runs.mjs';
import { agentGit } from './checks.mjs';
import { instructionSnapshot, restoreInstructions } from './workspace.mjs';
import { DESIGNS, TOKEN_KEY, claudeModelOf } from './arms.mjs';
import { appendJsonLine } from './atomic-write.mjs';
import { execFileSync } from 'node:child_process';

/** A Windows user env var's value from the registry, so a token set with setx after the run started is seen; null when unset. */
export function userEnvVar(name) {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(\S+)\s*$/m);
    return m ? m[1] : null;
  } catch (err) {
    // reg exits 1 when the value does not exist; the caller logs the var name as unset. Any other failure stands.
    if (err.status === 1) return null;
    throw err;
  }
}

/** After a plan limit, the newest due line of --token-schedule (`<epoch seconds> <user env var>`) names the token later attempts use (Amendment 8). */
export function moveToken(ctx, now = Date.now() / 1000, read = ctx.readToken ?? userEnvVar) {
  if (!ctx.tokenSchedule) return;
  const due = fs.readFileSync(ctx.tokenSchedule, 'utf8').split(/\r?\n/).map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length === 2 && /^\d+$/.test(f[0]) && Number(f[0]) <= now);
  const name = due.at(-1)?.[1];
  if (!name || name === ctx.tokenVar) return;
  const value = read(name);
  if (!value) {
    ctx.log(`token schedule names ${name}, which is not set; keeping ${ctx.tokenVar ?? 'the start token'}`);
    return;
  }
  ctx.token = value;
  ctx.log(`token moved from ${ctx.tokenVar ?? 'the start token'} to ${name} after a plan limit`);
  ctx.tokenVar = name;
}

function claudeArgs(ctx, run) {
  const args = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--settings', JSON.stringify(run.settingsFile), '--strict-mcp-config', '--permission-mode', ctx.permissionMode];
  const model = claudeModelOf(ctx.design, run.arm, ctx.model);
  if (model) args.push('--model', model);
  if (ctx.maxBudgetUsd) args.push('--max-budget-usd', String(ctx.maxBudgetUsd));
  return args;
}

const claudeLimit = (cc, result) => isUsageLimit(result, `${cc.stdout}\n${cc.stderr}`);

/** The request log of one Claude Code attempt: `kind` is session or resume (prereg G1 reads what the model received). */
export const requestLogFile = (run, taskId, kind, attempt) => path.join(run.rawDir, `${taskId}.${kind}${attempt}.requests.jsonl`);

/** Every attempt's request log of one kind, cut-off attempts included: a canary anywhere counts (prereg 161). */
export function requestLogs(run, taskId, kind) {
  const own = new RegExp(`^${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${kind}\\d+\\.requests\\.jsonl$`);
  return fs.existsSync(run.rawDir) ? fs.readdirSync(run.rawDir).filter((f) => own.test(f)).sort().map((f) => path.join(run.rawDir, f)) : [];
}

/** fn(env) with the attempt's API traffic routed through a request-log proxy; no log file runs it unproxied.
 * The upstream is the run's own (a fake agent's stub), else a base URL passed with --pass-env, so the log sits in front of the operator's own route. */
async function withRequestLog(ctx, logFile, env, fn) {
  if (!logFile) return fn(env);
  const proxy = await startLogProxy(logFile, { upstream: ctx.upstream ?? env.ANTHROPIC_BASE_URL });
  try {
    return await fn({ ...env, ANTHROPIC_BASE_URL: proxy.url });
  } finally {
    await proxy.close();
  }
}

/** Run a session until it is not at the plan limit, calling `reset` before each rerun (a truthy reset skips it: `stopped`); `command()` or `args()` is called once per attempt.
 * Codex passes its own command, env, limit test and redaction, so both tools share one limit loop; only Claude Code passes `logKind`.
 * Round 4 writes each attempt to attempts.jsonl before it spawns: `attemptId()` is read after `command()`, which is what fixes it. */
export async function untilNotLimited(ctx, run, t, {
  args, input, rawName, reset, command = () => `${ctx.claude} ${args().join(' ')}`, env = run.env, isLimit = claudeLimit, redact = (text) => text, logKind = null, attemptId = () => null, sizesBefore = null,
}) {
  // Every cut-off attempt, its wait and its reset: none of it is the kept attempt's work, so wallMs leaves it out.
  let cutOffMs = 0;
  // SHORTCUT: 15-minute polls up to 8 days, so a weekly limit's reset is waited out; parse the reset time if polling costs too much.
  for (let attempt = 1; ; attempt++) {
    const start = performance.now();
    const logFile = logKind ? requestLogFile(run, t.id, logKind, attempt) : null;
    const tokenEnv = ctx.token && env[TOKEN_KEY] ? { ...env, [TOKEN_KEY]: ctx.token } : env;
    const line = command();
    if (logFile && ctx.design === DESIGNS.r4) appendJsonLine(path.join(run.rawDir, 'attempts.jsonl'), { taskId: t.id, kind: logKind, attempt, sessionId: attemptId(), logFile, sizesBefore });
    const cc = await withRequestLog(ctx, logFile, tokenEnv, (e) => spawnTree(line, run.dirs.work, e, ctx.sessionTimeoutMs, input));
    const result = lastJson(cc.stdout);
    // A hung session can print overloaded_error before it hangs; a timeout is a graded result, never a limit wait (prereg 165).
    if (cc.timedOut || !isLimit(cc, result)) return { cc, result, limitRetries: attempt - 1, cutOffMs };
    fs.writeFileSync(path.join(run.rawDir, `${t.id}.${rawName}${attempt}.txt`), redact(`${cc.stdout}\n${cc.stderr}`).slice(-20000));
    // Prereg: a run that stops partway is abandoned and never analysed, so a limit that outlasts every wait ends the run.
    if (attempt > ctx.limitMaxWaits) throw new Error(`${run.s.id} ${t.id} ${run.arm} seed${run.seed}: still at the plan limit after ${ctx.limitMaxWaits} waits`);
    ctx.log(`${run.s.id} ${t.id} ${run.arm} seed${run.seed}: plan limit hit, waiting ${Math.round(ctx.limitWaitMs / 60_000)} min (attempt ${attempt})`);
    await sleep(ctx.limitWaitMs);
    moveToken(ctx);
    const stop = reset();
    cutOffMs += performance.now() - start;
    if (stop) return { cc, result: null, limitRetries: attempt, cutOffMs, stopped: true };
  }
}

/** Session 1 on the task prompt, under an id fixed before it starts, so a session killed before its result still names its transcript. */
export async function runSession(ctx, run, t, reset) {
  let sessionId = null;
  const args = () => {
    // Fresh per attempt: a cut-off attempt's transcript keeps its own id.
    sessionId = randomUUID();
    return [...claudeArgs(ctx, run), '--session-id', sessionId];
  };
  const session = await untilNotLimited(ctx, run, t, { args, input: t.prompt, rawName: 'limit', reset, logKind: 'session', attemptId: () => sessionId });
  return { ...session, sessionId };
}

/** One resume of `sessionId` with `message` on stdin; a cut-off attempt is undone exactly before the rerun. */
export async function resumeSession(ctx, run, t, sessionId, message, afterReset = () => {}) {
  const args = [...claudeArgs(ctx, run), '--resume', sessionId];
  let dir = null;
  try {
    // Outside the workspace, so nothing the cut-off attempt does to .git (gc, refs, config, hooks, even rm) reaches the saved state.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-resume-'));
    const snap = workSnapshot(run, sessionId, dir);
    const reset = () => {
      restoreWork(run, snap, sessionId);
      return afterReset();
    };
    const projects = path.join(run.dirs.claudeConfig, 'projects');
    const main = findTranscript(projects, sessionId);
    // Where session 1 ends in every file it wrote, subagents included, since a resume can append to any of them.
    const sizesBefore = new Map([...snap.transcripts].map(([f, bytes]) => [f, bytes.length]));
    const before = { bytesBefore: (main && sizesBefore.get(main)) || 0, sizesBefore, filesBefore: new Set(listTranscripts(projects)) };
    // Relative to claude-config with forward slashes, so the list reads the same on any box.
    const sizes = Object.fromEntries([...sizesBefore].map(([f, bytes]) => [path.relative(run.dirs.claudeConfig, f).split(path.sep).join('/'), bytes]));
    const attempt = { args: () => args, input: message, rawName: 'resume-limit', reset, logKind: 'resume', attemptId: () => sessionId, sizesBefore: sizes };
    return { ...(await untilNotLimited(ctx, run, t, attempt)), ...before };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** fn(rgit, env): the runner's git on the agent's .git with a throwaway index. */
const withTempIndex = (work, fn) => agentGit(work, (rgit, scratch) => fn(rgit, { GIT_INDEX_FILE: path.join(scratch, 'index') }));

const transcriptsOf = (run, sessionId) => sessionFiles(path.join(run.dirs.claudeConfig, 'projects'), sessionId);

/** The post-session-1 state in `dir`: a copy of .git holding the work tree as a tree, instruction files, every transcript's bytes. */
function workSnapshot(run, sessionId, dir) {
  const work = run.dirs.work;
  const tree = withTempIndex(work, (rgit, env) => {
    rgit(['read-tree', 'HEAD'], work, env);
    rgit(['add', '-A'], work, env);
    return rgit(['write-tree'], work, env).trim();
  });
  fs.cpSync(path.join(work, '.git'), path.join(dir, 'git'), { recursive: true });
  const transcripts = new Map(transcriptsOf(run, sessionId).map((f) => [f, fs.readFileSync(f)]));
  return { dir, tree, instructions: instructionSnapshot(work), transcripts };
}

/** Undo a cut-off resume: .git comes back byte for byte, then the work tree from the saved tree. */
function restoreWork(run, snap, sessionId) {
  const work = run.dirs.work;
  fs.rmSync(path.join(work, '.git'), { recursive: true, force: true, maxRetries: 3 });
  fs.cpSync(path.join(snap.dir, 'git'), path.join(work, '.git'), { recursive: true });
  // SHORTCUT: git-ignored files the cut-off attempt wrote stay; snapshot them too if an agent ever leans on one.
  withTempIndex(work, (rgit, env) => {
    rgit(['read-tree', snap.tree], work, env);
    rgit(['checkout-index', '-a', '-f'], work, env);
    // -ff also drops a nested repo the cut-off attempt made.
    rgit(['clean', '-ffdq'], work, env);
  });
  restoreInstructions(work, snap.instructions);
  // Subagent transcripts too, so a cut-off attempt's subagent commands never reach CHECK_COMMANDS.
  for (const f of transcriptsOf(run, sessionId)) if (!snap.transcripts.has(f)) fs.rmSync(f);
  for (const [f, bytes] of snap.transcripts) fs.writeFileSync(f, bytes);
}
