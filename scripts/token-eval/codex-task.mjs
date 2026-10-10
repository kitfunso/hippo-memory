// The Codex side of a task cell (E6 plan D13, R4, R21, R24): the apply session, its price, read check and record fields, the X4 block, the token sweeps.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HIPPO_ARMS } from './arms.mjs';
import { toolInputs, toolResultTexts, hookContexts, commandLog, transcriptWork } from './records.mjs';
import { runCodexSession, codexEnv } from './codex.mjs';
import { codexAdapter, parseRollouts, streamEvents } from './codex-rollout.mjs';
import { authOut, tokenSweep, closeVault, readIfPresent, errNote } from './codex-auth.mjs';
import { sessionVoid, byPrecedence } from './readcheck.mjs';
import { holds } from './leaks.mjs';
import { memoryText } from './lessons.mjs';
import { hippoSentFor, sleep } from './runs.mjs';

const ZERO_USAGE = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
// Codex's project_doc_max_bytes default; the run's config.toml leaves it unset.
const PROJECT_DOC_CAP = 32 * 1024;
const OPEN = '<!-- z0 taught -->';
const CLOSE = '<!-- /z0 taught -->';
// The first and the closing line of hippo's Codex session-end worker log; each line is `[hippo] <time> <text>`.
const WRAPPER_START = /^\[hippo\] \S+ (?:consolidating memory\.\.\.|skip sleep: |skip: no hippo store )/;
const WRAPPER_END = /^\[hippo\] \S+ (digest: wrote .*|digest: skip: .*|digest failed: .*|skip capture: no Codex transcript for this session|skip: no hippo store for this folder or globally)$/;
const WRAPPER_POLL_MS = 250;

export const CLAUDE_DRIVER = { tool: 'claude-code', adapter: { toolInputs, toolResultTexts, hookContexts, commandLog, transcriptWork } };
export const CODEX_DRIVER = { tool: 'codex', adapter: codexAdapter };
/** Set X applies run in Codex; teaches and every other set stay in Claude Code (prereg 85, E6 plan D18). */
export const driverOf = (role) => (role.set === 'X' && role.kind === 'apply' ? CODEX_DRIVER : CLAUDE_DRIVER);

/** Session 1 of a Codex apply; `result` is its last turn.completed event, and the stage reads the agent rollouts from then on. */
export async function codexSession(ctx, run, t, stage, reset) {
  const session = await runCodexSession(ctx, run, t, reset);
  stage.filesOf = () => session.rollouts.agent;
  const done = streamEvents(session.cc.stdout).filter((e) => e.type === 'turn.completed');
  return { ...session, result: done.at(-1) ?? null, sessionId: session.threadId };
}

/** Usage and turns from the agent rollouts (plan R8); Codex prints no cost, and an apply never resumes, so `extra` is zero. */
export const codexPricing = (session) => ({
  usage: { firstSession: session.usage?.usage ?? null, extra: ZERO_USAGE }, costUsd: null, turns: session.usage?.turns ?? null, turnsSource: 'rollout',
});

/** G1 over the agent and stray rollouts, plus only the reach outside the run for Codex's own memory threads (plan R21). */
export function codexVoid(ctx, run, step, stage, session) {
  const { agent, stray, internal, threadIds } = session.rollouts;
  const how = { ownIds: threadIds, adapter: codexAdapter, env: codexEnv(run) };
  const main = sessionVoid(ctx, run, step, { ...how, files: [...agent, ...stray], delivery: stage.delivery, markScan: !HIPPO_ARMS.has(run.arm) });
  const outside = sessionVoid(ctx, run, step, { ...how, files: internal, delivery: [], outsideOnly: true });
  const hits = byPrecedence([...main.voidHits, ...outside.voidHits]);
  return { void: hits[0]?.reason ?? null, voidHits: hits };
}

/** What the worker's log says (plan R17): done once a start line heads it and an end line follows; captured only when the digest names this thread's rollout. */
export function wrapperVerdict(logText, threadId) {
  const lines = logText.split('\n').map((l) => l.replace(/\r$/, ''));
  // A log with no start line holds an earlier worker's late line, never this session's end.
  const end = WRAPPER_START.test(lines[0]) ? lines.map((l) => WRAPPER_END.exec(l)?.[1]).filter(Boolean).at(-1) : undefined;
  if (end === undefined) return { done: false, captured: false, end: null };
  const rollout = /^digest: wrote .* for (\S+)$/.exec(end)?.[1];
  return { done: true, captured: Boolean(threadId) && Boolean(rollout?.includes(threadId)), end: end.slice(0, 200) };
}

/** Poll the worker's log until its end line, so no snapshot or sweep runs under a live worker; `ms` goes in the record, never in wallMs. */
export async function wrapperWait(ctx, run, cell, threadId) {
  const log = path.join(run.dirs.home, '.hippo', 'logs', 'codex-sleep.log');
  const start = performance.now();
  for (;;) {
    const verdict = wrapperVerdict(readIfPresent(log)?.toString('utf8') ?? '', threadId);
    const ms = Math.round(performance.now() - start);
    if (verdict.done) return { captured: verdict.captured, wait: { ms, timedOut: false, end: verdict.end } };
    if (ms >= ctx.codexWrapperWaitMs) {
      ctx.log(`${run.s.id} ${cell} ${run.arm} seed${run.seed}: hippo's Codex worker wrote no end line within ${ctx.codexWrapperWaitMs} ms, so codexWrapperCaptured is null`);
      return { captured: null, wait: { ms, timedOut: true, end: null } };
    }
    await sleep(WRAPPER_POLL_MS);
  }
}

/** The record fields only a Codex apply has. */
export function codexFields(ctx, run, session) {
  const parsed = parseRollouts(session.rollouts.agent);
  const store = path.join(run.dirs.work, '.hippo');
  return {
    // Hook rows are booked per thread id, so every agent thread counts and Codex's own memory threads are counted apart (plan R26).
    codexHooksFired: hippoSentFor(store, session.rollouts.threadIds),
    codexInternalHooksFired: hippoSentFor(store, session.rollouts.internalIds),
    // Null is a wait that timed out; false is an end line that names no digest for this thread, or an arm with no wrapper.
    codexWrapperCaptured: session.wrapper ? session.wrapper.captured : false, codexWrapperWait: session.wrapper?.wait ?? null,
    codexVersion: ctx.codexVersion, codexMemories: ctx.codexMemories, codexHookTrust: ctx.codexHookTrust.kind, codexAuth: 'copied-file', codexMemoryWait: session.wait,
    codexCalls: parsed.calls, codexUnparsedCalls: parsed.unparsed, codexUsageOdd: session.usage?.odd ?? null, codexUsageRaw: session.usage?.raw ?? null,
    codexInternalUsage: session.internalUsage, codexStrayRollouts: session.rollouts.stray.length,
  };
}

const firstOf = (dir, names) => names.map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));

/** Chain `shown` before a Codex session (prereg 180): the phrase in the project or user AGENTS file Codex loads, or its memory summary. */
export function shownAtStartCodex(lesson, run) {
  const { work, codexHome } = run.dirs;
  const docs = [[work, PROJECT_DOC_CAP], [codexHome, Infinity]].map(([dir, cap]) => {
    const file = firstOf(dir, ['AGENTS.override.md', 'AGENTS.md']);
    return file ? fs.readFileSync(file).subarray(0, cap) : null;
  });
  const summary = path.join(codexHome, 'memories', 'memory_summary.md');
  return [...docs, fs.existsSync(summary) ? fs.readFileSync(summary) : null].some((bytes) => bytes !== null && holds(bytes, lesson.keyPhrase));
}

/** X4 (plan D9): the taught lessons between the markers in work/AGENTS.md; one whole block is replaced, else a new one is appended. */
export function writeX4Block(work, taught) {
  const file = path.join(work, 'AGENTS.md');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = `${OPEN}${memoryText(taught)}${CLOSE}\n`;
  const from = text.indexOf(OPEN);
  const to = from < 0 ? -1 : text.indexOf(CLOSE, from);
  if (to >= 0) {
    fs.writeFileSync(file, `${text.slice(0, from)}${block}${text.slice(to + CLOSE.length).replace(/^\r?\n/, '')}`);
    return 'replaced';
  }
  fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${block}`);
  // A lone marker means an agent edited the block; the new one is added, never merged into it.
  return from >= 0 || text.includes(CLOSE) ? 'appended' : 'written';
}

/** After a Codex cell's grading: delete any file in the cell's dirs that holds a login token, and stop the run (plan R4, R24). */
export function sweepCell(ctx, run) {
  const cell = [run.runName, run.arm, `seed${run.seed}`];
  const roots = [run.dirs.root, path.join(ctx.snapDir, ...cell), run.rawDir, path.join(ctx.outDir, 'grading', ...cell), ctx.ledgerFile];
  const hits = tokenSweep(ctx.codexVault, roots, ctx.outDir);
  if (hits.length) throw new Error(`${run.s.id} ${run.arm} seed${run.seed}: a Codex login token was in ${hits.join(', ')}; files listed without a note are deleted, and the run stops`);
}

/** End of a run with Codex: take back every run login copy, sweep the out dir, then remove the vault; returns the hit paths, a path that could not be handled carrying a note. */
export function finishCodex(ctx) {
  if (!ctx.codexVault) return [];
  try {
    const runs = path.join(ctx.outDir, 'runs');
    const notes = [];
    const rel = (p) => path.relative(ctx.outDir, p).split(path.sep).join('/');
    let homes = [];
    try {
      homes = fs.existsSync(runs) ? codexHomes(runs) : [];
    } catch (err) {
      notes.push(`runs (unreadable: ${errNote(err)})`);
    }
    // authOut folds each copy's tokens into the vault before deleting it, so the sweep below still knows them.
    for (const home of homes) {
      try {
        authOut(ctx.codexVault, home);
      } catch (err) {
        notes.push(`${rel(home)} (login copy not taken back: ${errNote(err)})`);
      }
    }
    return [...new Set([...notes, ...tokenSweep(ctx.codexVault, [ctx.outDir], ctx.outDir)])].sort();
  } finally {
    closeVault(ctx.codexVault);
  }
}

/** Every `runs/<name>/<arm>/<seed>/codex-home` dir. */
function codexHomes(runs) {
  const dirs = (p) => fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(p, e.name));
  return dirs(runs).flatMap(dirs).flatMap(dirs).map((d) => path.join(d, 'codex-home')).filter((d) => fs.existsSync(d));
}
