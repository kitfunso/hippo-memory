#!/usr/bin/env node
/** Z0 round 3 hook diet replay: renders hippo's prompt hook block from each A2 pre-session store in three pinnedInject.excludeTags arms and prices the cut.
 * Free and local, no model call. The no-list arm is checked against the block round 3 sent, read from its request logs.
 * Exit 0 on a clean read, 1 on bad input, an unbuilt checkout or any failed render. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { bodyTexts, extractSession, hookBlocksOf, isMainCall, requestLogs, runNames } from './z0-reach.mjs';
import { isString } from './z0-records.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_SCORED = 'C:/z0-runs/scored';
const DEFAULT_PRICES = 'C:/z0-runs/s7/prices.json';
const USAGE = 'usage: z0-hook-diet.mjs [--scored DIR] [--checkout DIR] [--work DIR] [--prices FILE] [--clock session|wall] [--limit N] [--json]';
const ARMS = { none: null, digest: ['session-digest'], list3: ['session-digest', 'claude-code-memory', 'auto-captured'] };
const ARM_NAMES = Object.keys(ARMS);
const CUT_ARMS = ['digest', 'list3'];
const CLOCKS = ['session', 'wall'];
const RULES = 'Rules from the user';
const HEADER = /## (Project Memory|Pinned rules|Prompt-Relevant Memory|Rules from the user)[^\n]*\((\d+) entr[a-z]*, (\d+) tokens\)/g;
const HOOK_ARGS = ['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'];
const KEEP_ENV = ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG'];
const USAGE_FIELDS = ['cache_read_input_tokens', 'cache_creation_input_tokens', 'input_tokens', 'output_tokens'];
const RENDER_TIMEOUT_MS = 120_000;
const VALUE_FLAGS = { '--scored': ['scored', 'directory'], '--checkout': ['checkout', 'directory'], '--work': ['work', 'directory'], '--prices': ['prices', 'file'] };
const CLOCK_NOTE = { session: "each render at its session's first request time", wall: 'each render at the wall clock' };

/** @typedef {[string, number, number]} Section a hook block header as [name, entries, tokens] */

const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => sum(xs) / xs.length;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const cutPct = (base, x) => (100 * (base - x)) / base;
const headerTokens = (sections) => sum(sections.filter((s) => s[0] !== RULES).map((s) => s[2]));
const linesOf = (file) => fs.readFileSync(file, 'utf8').split('\n');

/** One request-log line as an entry, or null for a blank line. */
function parseLine(line) {
  if (line.trim() === '') return null;
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new Error(`a request log line is cut off (${err.message}); rerun the session or drop the run from the read`);
  }
}

/** The additionalContext of the hook's JSON wrapper, or undefined when the output is not that wrapper. */
function wrappedText(stdout) {
  try {
    return JSON.parse(stdout).hookSpecificOutput?.additionalContext;
  } catch {
    // Non-JSON output has no wrapper; blockOf reports it as an error.
    return undefined;
  }
}

/** The block text hippo's hook printed and its section headers; empty output is an empty block, and any other output that is not the
 * hook's JSON wrapper is an `error`. The Rules heading has no token header today, and the sums drop it if it gains one. */
export function blockOf(stdout) {
  if (stdout.trim() === '') return { text: '', sections: [], error: null };
  const text = wrappedText(stdout);
  if (!isString(text)) return { text: '', sections: [], error: `output is not the hook JSON wrapper, it starts ${JSON.stringify(stdout.trim().slice(0, 60))}` };
  return { text, sections: [...text.matchAll(HEADER)].map((m) => [m[1], Number(m[2]), Number(m[3])]), error: null };
}

/** A copy of a store config with pinnedInject.excludeTags set; null leaves the copy as it was. Never touches the input. */
export function stagedConfig(cfg, excludeTags) {
  const copy = structuredClone(cfg);
  if (excludeTags === null) return copy;
  return { ...copy, pinnedInject: { ...copy.pinnedInject, excludeTags: [...excludeTags] } };
}

/** The first PATH folder holding the command, so a render sees node and git and nothing else of the parent PATH. */
function dirHolding(command, parent) {
  const names = process.platform === 'win32' ? [`${command}.exe`, `${command}.cmd`] : [command];
  const dirs = (parent.PATH ?? '').split(path.delimiter);
  return dirs.find((d) => d !== '' && names.some((n) => fs.existsSync(path.join(d, n)))) ?? null;
}

/** The folders a render's PATH holds: node's, then git's. */
const pathDirs = (parent) => [...new Set([path.dirname(process.execPath), dirHolding('git', parent)])].filter(Boolean);

/** hippo rewrites any codex launcher it finds on PATH, so a render refuses a PATH folder that holds one, as hippo-iso.sh does.
 * @param {NodeJS.ProcessEnv} [parent] */
export function checkPathDirs(parent = process.env) {
  for (const dir of pathDirs(parent)) {
    const launcher = fs.readdirSync(dir).find((n) => fold(n).startsWith('codex'));
    if (launcher) throw new Error(`a codex launcher ${path.join(dir, launcher)} sits in a folder the render puts on PATH; move it, or run node and git from another folder`);
  }
}

/** The env of one render, as hippo-iso.sh builds it: an allowlist, so keys, tenant and agent-home vars never reach the CLI.
 * @param {string} dir @param {string | null} fakeNow @param {NodeJS.ProcessEnv} [parent] */
export function renderEnv(dir, fakeNow, parent = process.env) {
  const user = path.join(dir, 'user');
  const env = Object.fromEntries(KEEP_ENV.filter((k) => parent[k]).map((k) => [k, parent[k]]));
  Object.assign(env, {
    PATH: pathDirs(parent).join(path.delimiter),
    HOME: user,
    USERPROFILE: user,
    APPDATA: path.join(user, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(user, 'AppData', 'Local'),
    HIPPO_HOME: path.join(dir, 'home'),
    HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
    HIPPO_SKIP_SCHEDULE: '1',
    HIPPO_SKIP_POSTINSTALL: '1',
  });
  if (isString(fakeNow)) env.HIPPO_FAKE_NOW = fakeNow;
  return env;
}

/** Whether a replayed block is the recorded one: same headers, entry counts and token counts, in order. Rules lines never count.
 * @param {Section[]} recorded @param {Section[]} replayed */
export function sameBlock(recorded, replayed) {
  const kept = replayed.filter((s) => s[0] !== RULES);
  return recorded.length === kept.length && recorded.every((s, i) => s.every((v, j) => v === kept[i][j]));
}

/** The first user text of the first request that carries messages, unless it is a system reminder; null when none.
 * @param {string[]} lines */
export function userPrompt(lines) {
  for (const line of lines) {
    const e = parseLine(line);
    if (!e || e.method !== 'POST' || !isString(e.body) || !e.body.startsWith('{')) continue;
    const first = JSON.parse(e.body).messages?.[0];
    if (!first) continue;
    for (const c of isString(first.content) ? [{ text: first.content }] : first.content) {
      const text = c.text ?? '';
      if (text !== '' && !text.trimStart().startsWith('<system-reminder>')) return text;
    }
    return null;
  }
  return null;
}

/** Main-agent calls whose messages hold a hippo prompt block; the block is re-read from cache on each one after the first.
 * @param {string[]} lines */
export function mainCallsWithBlock(lines) {
  let calls = 0;
  for (const line of lines) {
    const e = parseLine(line);
    if (!e || e.method !== 'POST' || !isString(e.body) || !e.body.includes(' tokens)')) continue;
    const request = JSON.parse(e.body);
    if (isMainCall(e, request) && bodyTexts(request.messages ?? []).some((t) => hookBlocksOf(t).length > 0)) calls++;
  }
  return calls;
}

/** The last A2 step of this sequence and seed in plan order, or null; a run that stopped early may never have run it, so its log can be missing. */
export function lastA2Task(plan, sequence, seed) {
  return plan.filter((s) => s.arm === 'A2' && s.seed === seed && s.sequence === sequence).map((s) => s.taskId).at(-1) ?? null;
}

/** The run folder must sit under the temp root with no `.hippo` on the way up, or hippo would walk up to a real store.
 * @param {string} work @returns {string} the resolved folder */
export function checkWorkDir(work) {
  let existing = path.resolve(work);
  const rest = [];
  while (!fs.existsSync(existing)) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const tmp = fs.realpathSync.native(os.tmpdir());
  const run = path.join(fs.realpathSync.native(existing), ...rest);
  const rel = path.relative(fold(tmp), fold(run));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`--work ${run} is not under the temp root ${tmp}; pass a folder under it, so hippo cannot walk up to a real store`);
  }
  for (let d = run; fold(d) !== fold(tmp) && path.dirname(d) !== d; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.hippo'))) throw new Error(`stray store ${path.join(d, '.hippo')} would capture the render; move it or pass another --work`);
  }
  return run;
}

function checkCheckout(checkout) {
  for (const file of ['dist/cli.js', 'bin/hippo.js']) {
    if (!fs.existsSync(path.join(checkout, file))) throw new Error(`${checkout} has no ${file}; run npm run build there, or pass --checkout <built hippo repo>`);
  }
}

function shaOf(checkout) {
  const git = (args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    // The figures belong to the code that rendered them, so an edited tree must not pass as its commit.
    // SHORTCUT: dist/ is gitignored, so a stale build still prints clean; hash dist if a read ever needs that proof.
    const dirty = git(['status', '--porcelain', '--untracked-files=no', '--', 'src', 'bin', 'scripts', 'package.json']) !== '';
    return `${git(['rev-parse', '--short', 'HEAD'])}${dirty ? '-dirty' : ''}`;
  } catch {
    // A checkout with no git history has no sha, and the read still holds.
    return 'unknown';
  }
}

function pricesOf(file) {
  if (!fs.existsSync(file)) throw new Error(`prices file ${file} is missing; pass --prices <file> with a "claude-code" object`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))['claude-code'];
  if (!Number.isFinite(p?.cacheWritePerMTok) || !Number.isFinite(p?.cacheReadPerMTok)) {
    throw new Error(`${file} has no "claude-code" cacheWritePerMTok and cacheReadPerMTok; fix the file or pass another --prices`);
  }
  return p;
}

/** One store per (run, task, seed) of the final-read runs that kept an A2 pre-session snapshot. */
function storesOf(scored) {
  const stores = [];
  for (const run of runNames(scored)) {
    const runDir = path.join(scored, 'r3run', run, 'run');
    const snaps = path.join(runDir, 'snap');
    if (!isDir(snaps)) continue;
    const planFile = path.join(runDir, 'plan.json');
    if (!fs.existsSync(planFile)) throw new Error(`${planFile} is missing; the run has snapshots but no plan, so restore it or drop the run`);
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    for (const task of fs.readdirSync(snaps).sort()) {
      const a2 = path.join(snaps, task, 'A2');
      const seeds = isDir(a2) ? fs.readdirSync(a2).filter((n) => /^seed\d+$/.test(n)) : [];
      for (const name of seeds.sort((x, y) => Number(x.slice(4)) - Number(y.slice(4)))) {
        const snap = path.join(a2, name, 'pre-session');
        if (isDir(snap)) stores.push({ run, runDir, task, seed: Number(name.slice(4)), snap, plan });
      }
    }
  }
  return stores;
}

/** The store's pre-session folders copied under `dir`, with the arm's excludeTags written and the project id round 3 gave it. */
function stageStore(snap, dir, excludeTags) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(snap, 'hippoWork', '.hippo'), path.join(dir, 'cwd', '.hippo'), { recursive: true });
  fs.cpSync(path.join(snap, 'hippoGlobal', 'hippo-home'), path.join(dir, 'home'), { recursive: true });
  const file = path.join(dir, 'cwd', '.hippo', 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.writeFileSync(file, JSON.stringify(stagedConfig(cfg, excludeTags), null, 2));
  // Round 3 named each project after its folder, `work`; without the id the block renders empty.
  fs.writeFileSync(path.join(dir, 'cwd', '.hippo-project.json'), '{"id":"work"}');
  for (const sub of ['Roaming', 'Local']) fs.mkdirSync(path.join(dir, 'user', 'AppData', sub), { recursive: true });
}

/** One hook call through the built CLI; a failed call keeps its exit code and stderr for the row. */
function renderHook(checkout, dir, prompt, session, fakeNow) {
  const input = JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt });
  const options = { cwd: path.join(dir, 'cwd'), env: renderEnv(dir, fakeNow), input, encoding: 'utf8', timeout: RENDER_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'] };
  try {
    return { exit: 0, stdout: execFileSync(process.execPath, [path.join(checkout, 'bin', 'hippo.js'), ...HOOK_ARGS], options), stderr: '' };
  } catch (e) {
    return { exit: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr || e.message };
  }
}

/** The session's start as an ISO time, from the first line of its request log. */
function sessionStart(lines, file) {
  const at = parseLine(lines[0])?.at;
  const time = new Date(at);
  if (!isString(at) || Number.isNaN(time.getTime())) throw new Error(`${file} has no usable first-line "at" time; pass --clock wall or restore the log`);
  return time.toISOString();
}

function usageOf(file) {
  if (!fs.existsSync(file)) throw new Error(`${file} is missing for a rendered store; restore the session's usage file or drop the run from the read`);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const u = d.usage;
  if (u?.constructor !== Object) throw new Error(`${file} has no usage object; the session record is cut off, so rerun the session or drop the run from the read`);
  const missing = USAGE_FIELDS.filter((k) => !Number.isFinite(u[k])).concat(['num_turns', 'total_cost_usd'].filter((k) => !Number.isFinite(d[k])));
  if (missing.length > 0) throw new Error(`${file} has no number for ${missing.join(', ')}; the session record is cut off, so rerun the session or drop the run from the read`);
  return { cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, input: u.input_tokens, output: u.output_tokens, turns: d.num_turns, costUsd: d.total_cost_usd };
}

function renderArms(store, i, ctx, prompt, fakeNow) {
  const arms = {};
  for (const [arm, tags] of Object.entries(ARMS)) {
    const dir = path.join(ctx.work, `r${String(i).padStart(3, '0')}-${arm}`);
    stageStore(store.snap, dir, tags);
    const r = renderHook(ctx.checkout, dir, prompt, `replay-${i}-${arm}`, fakeNow);
    fs.rmSync(dir, { recursive: true, force: true });
    const block = blockOf(r.stdout);
    arms[arm] = { exit: r.exit, chars: block.text.length, sections: block.sections };
    const error = r.exit === 0 ? block.error : `exit ${r.exit}: ${r.stderr.split('\n')[0] || 'no stderr'}`;
    if (error) arms[arm].error = error;
  }
  return arms;
}

/** One store: its last A2 session's prompt, the three renders, round 3's recorded block and the session's usage.
 * A store with no session log is `noLog` and keeps the log path it expected; one whose log holds no first prompt is `noPrompt`. */
function readStore(store, i, ctx) {
  const { run, runDir, task, seed } = store;
  const taskId = lastA2Task(store.plan, task, seed);
  const raw = path.join(runDir, 'raw', task, 'A2', `seed${seed}`);
  const log = path.join(raw, `${taskId ?? '(no A2 step in plan.json)'}.session1.requests.jsonl`);
  const row = { run, task, seed, taskId, log, noLog: false, noPrompt: false, arms: null, recorded: [], calls: 0, usage: null };
  if (taskId === null || !fs.existsSync(log)) return { ...row, noLog: true };
  const lines = linesOf(log);
  const prompt = userPrompt(lines);
  if (prompt === null) return { ...row, noPrompt: true };
  const usage = usageOf(path.join(raw, `${taskId}.json`));
  const logs = requestLogs(ctx.scored, { runName: run, sequence: task, arm: 'A2', seed, taskId }).files;
  const fakeNow = ctx.clock === 'session' ? sessionStart(lines, log) : null;
  const recorded = extractSession(logs).hookBlocks.map((b) => [b.header, b.entries, b.tokens]);
  const calls = sum(logs.map((f) => mainCallsWithBlock(linesOf(f))));
  return { ...row, recorded, calls, usage, arms: renderArms(store, i, ctx, prompt, fakeNow) };
}

function armStats(rendered) {
  return Object.fromEntries(
    ARM_NAMES.map((arm) => {
      const tokens = rendered.map((r) => headerTokens(r.arms[arm].sections));
      const chars = rendered.map((r) => r.arms[arm].chars);
      const stats = { meanTokens: mean(tokens), medianTokens: median(tokens), sumTokens: sum(tokens), meanChars: mean(chars), sumChars: sum(chars), empty: chars.filter((c) => c === 0).length };
      return [arm, stats];
    }),
  );
}

/** What one session saves in an arm: the dollars of one cache write and a cache read per later main call, and the tokens re-read. */
function savedBy(cut, calls, prices) {
  const rereads = Math.max(calls - 1, 0);
  return { usd: (cut * (prices.cacheWritePerMTok + rereads * prices.cacheReadPerMTok)) / 1e6, rereadTokens: cut * rereads };
}

function savingsOf(withBlock, prices) {
  const meanCost = mean(withBlock.map((r) => r.usage.costUsd));
  const cacheRead = sum(withBlock.map((r) => r.usage.cacheRead));
  return Object.fromEntries(
    CUT_ARMS.map((arm) => {
      const saved = withBlock.map((r) => savedBy(headerTokens(r.arms.none.sections) - headerTokens(r.arms[arm].sections), r.calls, prices));
      const meanUsd = mean(saved.map((s) => s.usd));
      return [arm, { meanUsd, shareOfMeanCostPct: (100 * meanUsd) / meanCost, rereadSharePct: (100 * sum(saved.map((s) => s.rereadTokens))) / cacheRead }];
    }),
  );
}

/** The report over the rows: block tokens per arm, fidelity against round 3, and the cut priced against each session's real use.
 * Sessions whose round 3 request logs hold no hook block are left out of the saving, the shares and the session means. */
export function summarize(rows, prices) {
  const rendered = rows.filter((r) => r.arms !== null);
  const withBlock = rendered.filter((r) => r.calls > 0);
  const arms = armStats(rendered);
  const recorded = rendered.filter((r) => r.recorded.length > 0);
  return {
    stores: rows.length,
    rendered: rendered.length,
    noLog: rows.filter((r) => r.noLog).length,
    noPrompt: rows.filter((r) => r.noPrompt).length,
    fidelity: { recorded: recorded.length, exact: recorded.filter((r) => sameBlock(r.recorded, r.arms.none.sections)).length },
    arms,
    cut: Object.fromEntries(CUT_ARMS.map((a) => [a, { tokensPct: cutPct(arms.none.sumTokens, arms[a].sumTokens), charsPct: cutPct(arms.none.sumChars, arms[a].sumChars) }])),
    sessions: {
      n: withBlock.length,
      noRecordedBlock: rendered.length - withBlock.length,
      meanCallsWithBlock: mean(withBlock.map((r) => r.calls)),
      meanTurns: mean(withBlock.map((r) => r.usage.turns)),
      meanCacheReadTokens: mean(withBlock.map((r) => r.usage.cacheRead)),
      meanCostUsd: mean(withBlock.map((r) => r.usage.costUsd)),
    },
    saving: savingsOf(withBlock, prices),
  };
}

function failedRenders(rows) {
  return rows.flatMap((r) => (r.arms ? ARM_NAMES.filter((a) => r.arms[a].error).map((a) => ({ r, arm: a })) : []));
}

/** The error for a read that rendered nothing, so a moved raw folder never reports NaN with exit 0. */
function noneRendered(rows) {
  const first = rows.find((r) => r.noLog);
  const missing = first ? `, first missing log ${first.log}` : '';
  return `0 of ${rows.length} stores rendered (noLog ${rows.filter((r) => r.noLog).length}, noPrompt ${rows.filter((r) => r.noPrompt).length})${missing}; check that --scored holds snap/ and raw/ under each r3run/<run>/run, then rerun`;
}

/** The whole read: stage, render and read every store, then fail on any render that exited non-zero or printed no hook JSON.
 * @param {{ scored: string, checkout: string, work: string | null, prices: string, clock: string, limit: number }} args
 * @param {(line: string) => void} progress */
export function readHookDiet(args, progress = () => {}) {
  if (!isDir(path.join(args.scored, 'r3run'))) throw new Error(`no round 3 runs at ${path.join(args.scored, 'r3run')}; pass --scored <dir> with the scored folder that holds r3run/`);
  checkCheckout(args.checkout);
  checkPathDirs();
  const prices = pricesOf(args.prices);
  const own = args.work === null;
  const work = own ? fs.mkdtempSync(path.join(os.tmpdir(), 'z0-hook-diet-')) : path.resolve(args.work);
  try {
    checkWorkDir(work);
    fs.mkdirSync(work, { recursive: true });
    const ctx = { scored: args.scored, checkout: args.checkout, work, clock: args.clock };
    const stores = storesOf(args.scored);
    const picked = args.limit > 0 ? stores.slice(0, args.limit) : stores;
    const rows = picked.map((s, i) => {
      const row = readStore(s, i, ctx);
      const shown = row.arms ? ARM_NAMES.map((a) => `${a} ${headerTokens(row.arms[a].sections)}`).join(' ') : row.noLog ? 'no log' : 'no prompt';
      progress(`[${i + 1}/${picked.length}] ${s.run} ${s.task} seed ${s.seed}: ${shown}\n`);
      return row;
    });
    const failed = failedRenders(rows);
    if (failed.length > 0) {
      const { r, arm } = failed[0];
      throw new Error(`${failed.length} renders failed, first ${r.run} ${r.task} seed ${r.seed} arm ${arm} (${r.arms[arm].error}); check that --checkout is built and prints the hook JSON, then rerun`);
    }
    if (rows.every((r) => r.arms === null)) throw new Error(noneRendered(rows));
    return { build: shaOf(args.checkout), clock: args.clock, ...summarize(rows, prices), rows };
  } finally {
    if (own) fs.rmSync(work, { recursive: true, force: true });
  }
}

const f1 = (x) => x.toFixed(1);
const tableRow = (cells) => cells.map((c, i) => (i === 0 ? String(c).padEnd(8) : String(c).padStart(11))).join('');

/** The report as plain text. */
export function formatText(rep) {
  const lines = [`build ${rep.build}  clock ${rep.clock}: ${CLOCK_NOTE[rep.clock]}`];
  lines.push(`stores ${rep.stores} in the final-read runs, rendered ${rep.rendered}, noLog ${rep.noLog} (no session log), noPrompt ${rep.noPrompt} (log has no first prompt)`);
  lines.push(`fidelity: recorded block ${rep.fidelity.recorded}, replay (none arm) matches it exactly ${rep.fidelity.exact}`);
  lines.push(tableRow(['arm', 'tok mean', 'tok median', 'tok sum', 'chars mean', 'empty']));
  for (const arm of ARM_NAMES) {
    const a = rep.arms[arm];
    lines.push(tableRow([arm, f1(a.meanTokens), f1(a.medianTokens), a.sumTokens, f1(a.meanChars), a.empty]));
  }
  for (const arm of CUT_ARMS) lines.push(`cut ${arm}: ${f1(rep.cut[arm].tokensPct)}% of block tokens, ${f1(rep.cut[arm].charsPct)}% of chars (chars count the whole block, rules section included)`);
  const s = rep.sessions;
  lines.push(`sessions n ${s.n}, noRecordedBlock ${s.noRecordedBlock} (round 3 sent no block, left out below)`);
  lines.push(`  mean main calls with block ${f1(s.meanCallsWithBlock)}, num_turns ${f1(s.meanTurns)}, cache-read tokens ${Math.round(s.meanCacheReadTokens)}, cost $${s.meanCostUsd.toFixed(4)}`);
  for (const arm of CUT_ARMS) {
    const v = rep.saving[arm];
    lines.push(`${arm} saving: $${v.meanUsd.toFixed(5)} a session = ${v.shareOfMeanCostPct.toFixed(2)}% of mean session cost; re-read tokens ${v.rereadSharePct.toFixed(2)}% of cache-read tokens`);
  }
  return `${lines.join('\n')}\n`;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = { scored: DEFAULT_SCORED, checkout: REPO, work: null, prices: DEFAULT_PRICES, clock: 'session', limit: 0, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { ...args, help: true };
    const value = argv[i + 1];
    const given = isString(value) && !value.startsWith('--');
    if (flag === '--json') args.json = true;
    else if (Object.hasOwn(VALUE_FLAGS, flag)) {
      if (!given) throw new Error(`${flag} needs a ${VALUE_FLAGS[flag][1]}\n${USAGE}`);
      args[VALUE_FLAGS[flag][0]] = argv[++i];
    } else if (flag === '--clock') {
      if (!CLOCKS.includes(value)) throw new Error(`--clock needs session or wall\n${USAGE}`);
      args.clock = argv[++i];
    } else if (flag === '--limit') {
      if (!/^[1-9]\d*$/.test(value ?? '')) throw new Error(`--limit needs a whole number above 0\n${USAGE}`);
      args.limit = Number(argv[++i]);
    } else throw new Error(`unknown flag ${flag}\n${USAGE}`);
  }
  return args;
}

/** @param {string[]} argv @param {(line: string) => void} [progress] */
export function runCli(argv, progress = () => {}) {
  try {
    const args = parseArgs(argv);
    if (args.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
    const rep = readHookDiet(args, progress);
    return { code: 0, stdout: args.json ? `${JSON.stringify(rep, null, 2)}\n` : formatText(rep), stderr: '' };
  } catch (e) {
    return { code: 1, stdout: '', stderr: `z0-hook-diet: ${e.message}\n` };
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2), (line) => process.stderr.write(line));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
