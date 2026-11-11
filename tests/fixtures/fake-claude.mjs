#!/usr/bin/env node
// Stand-in for `claude -p --output-format json` in the token-eval runner tests. It reads the prompt from stdin,
// runs the UserPromptSubmit hooks from --settings with a real payload, calls `hippo` through PATH, writes a transcript
// under $CLAUDE_CONFIG_DIR/projects/ and prints a result shaped like Claude Code's, plus what it saw.
// With `--fake-knobs <file>` (z0-fake-knobs/1) it also draws, prices, logs and requests as the round 4 tests need; without it nothing changes.
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execSync, spawn, spawnSync } from 'node:child_process';

const rawArgv = process.argv.slice(2);
const knobsAt = rawArgv.indexOf('--fake-knobs');
// Everything below sees the argv a real call would have had, so a knobs run echoes no knobs pair.
const argv = knobsAt < 0 ? rawArgv : rawArgv.filter((_, i) => i !== knobsAt && i !== knobsAt + 1);
const stop = (code, message) => {
  console.error(`fake-claude: ${message}`);
  process.exit(code);
};
const KNOB_KEYS = ['schema', 'token', 'calls', 'costs', 'prices', 'version', 'usage', 'effortScale', 'outcome', 'leaks', 'offPin', 'fail', 'warmupFail'];

async function readKnobs(file) {
  const { FAKE_KNOBS_SCHEMA } = await import('../../scripts/token-eval/z0-records.mjs');
  let k;
  try {
    k = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    stop(1, `knobs file ${file}: ${err.message}`);
  }
  if (k?.schema !== FAKE_KNOBS_SCHEMA) stop(1, `knobs file ${file}: schema must be "${FAKE_KNOBS_SCHEMA}"`);
  for (const key of Object.keys(k)) if (!KNOB_KEYS.includes(key)) stop(1, `knobs file ${file}: ${key} is not a knob (${KNOB_KEYS.join(', ')})`);
  for (const [arm, rates] of Object.entries(k.outcome ?? {})) {
    for (const [name, rate] of Object.entries(rates)) {
      if (name !== 'lesson' && name !== 'solve') stop(1, `knobs file ${file}: outcome.${arm}.${name} is not a knob (lesson, solve)`);
      if (!(rate > 0 && rate < 1)) stop(1, `knobs file ${file}: outcome.${arm}.${name} must be above 0 and below 1, got ${rate}`);
    }
  }
  return k;
}

const knobs = knobsAt < 0 ? null : await readKnobs(rawArgv[knobsAt + 1]);
const knobsDir = knobs ? path.dirname(path.resolve(rawArgv[knobsAt + 1])) : null;
const { modelRow } = knobs ? await import('../../scripts/token-eval/z0-prices.mjs') : {};
const { priceUsage } = knobs ? await import('../../dist/eval/eval-stats.js') : {};
const TAG = knobs ? randomUUID() : process.pid;
let priced = null;
// One line per knobs call as it exits: the figure it billed (its result's total_cost_usd, written or not), 0 when it wrote no usage.
if (knobs?.costs) process.on('exit', () => fs.appendFileSync(knobs.costs, `${JSON.stringify({ call: TAG, model: priced ? Object.keys(priced.modelUsage)[0] : null, usage: priced?.usage ?? null, totalCostUsd: priced?.total_cost_usd ?? 0 })}\n`));
if (knobs) {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const line = { call: TAG, argv, tokenPrefix: token ? token.slice(0, 9) : null, effort: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null, configDir: process.env.CLAUDE_CONFIG_DIR ?? null, subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null };
  if (knobs.calls) fs.appendFileSync(knobs.calls, `${JSON.stringify(line)}\n`);
  if (knobs.token && token !== knobs.token) stop(1, 'CLAUDE_CODE_OAUTH_TOKEN is not the knobs file\'s token');
}
if (argv.includes('--version')) {
  console.log(`${knobs?.version ?? '0.0.0'} (Claude Code)`);
  process.exit(0);
}
const input = fs.readFileSync(0, 'utf8');
const SEEN_FILES = ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', 'docs/AGENTS.md', 'sub/CLAUDE.md', '.claude/rules/r.md', '.claude/agents/x.md', '.scratch/note.md'];
const files = Object.fromEntries(SEEN_FILES.filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f, 'utf8')]));
const resumeId = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : null;
// Each session's prompt lives outside the transcript dir, so a resume still knows its markers when no transcript was written.
const promptsDir = path.join(path.dirname(process.env.CLAUDE_CONFIG_DIR), 'fake-prompts');
const prompt = resumeId ? fs.readFileSync(path.join(promptsDir, `${resumeId}.prompt`), 'utf8') : input;

// Knobs mode. A session's cell is read from its config dir (<out>/runs/<seq>/<arm>/seed<n>/claude-config) and its draw u from the cell and the first-session prompt,
// so a rerun in a new --out draws the same; a call with no --settings is a warm-up and has no cell.
const pinned = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : null;
function cellOf() {
  const [sequence, arm, seedDir] = path.resolve(process.env.CLAUDE_CONFIG_DIR).split(path.sep).slice(-4, -1);
  const seed = Number(seedDir.replace('seed', ''));
  const digest = createHash('sha256').update([sequence, String(seed), arm, prompt].join('\0')).digest();
  return { sequence, arm, seed, position: Number(/FAKE_POS (\d+)/.exec(prompt)?.[1] ?? 0), u: Number(digest.readBigUInt64BE(0) >> 11n) / 2 ** 53 };
}
const cell = knobs && argv.includes('--settings') ? cellOf() : null;
const forCell = (e) => e.sequence === cell.sequence && e.seed === cell.seed && e.arm === cell.arm;
// An off-pin cell names its own model once, on the first session whose position it lists; its request, transcript and modelUsage all carry it, as the real CLI's would.
const forced = cell && !resumeId ? knobs.offPin?.find((e) => forCell(e) && e.nth === cell.position) : undefined;
const model = forced?.model ?? pinned;
const WARMUP_TOKENS = { input: 12, output: 8, cacheRead: 0, cacheWrite: 3000 };
const drawTokens = () => {
  if (!cell) return WARMUP_TOKENS;
  const row = knobs.usage?.[cell.arm];
  if (!row) stop(1, `the usage knob has no row for arm ${cell.arm}`);
  const spread = 0.95 + 0.1 * cell.u;
  const scale = knobs.effortScale?.[process.env.CLAUDE_CODE_EFFORT_LEVEL] ?? 1;
  const at = (n, extra = 1) => Math.round(n * spread * extra);
  return { input: at(row.input), output: at(row.output, scale), cacheRead: at(row.cacheRead), cacheWrite: at(row.cacheWrite) };
};
/** The call's tokens, cost and result usage fields, priced at the --model row; drawn once, so the transcript and the result agree. */
function callUsage() {
  if (priced) return priced;
  if (!model) stop(1, 'knobs mode prices a call at its --model row, and this call has none');
  if (!knobs.prices) stop(1, 'knobs mode needs a prices file');
  const row = modelRow(JSON.parse(fs.readFileSync(knobs.prices, 'utf8')), model, knobs.prices);
  if (!row) stop(1, `${knobs.prices} has no price row for ${model}`);
  const t = drawTokens();
  const cost = priceUsage({ inputTokens: t.input, cacheWriteTokens: t.cacheWrite, cacheReadTokens: t.cacheRead, outputTokens: t.output }, row);
  priced = {
    total_cost_usd: cost,
    usage: { input_tokens: t.input, cache_creation_input_tokens: t.cacheWrite, cache_read_input_tokens: t.cacheRead, output_tokens: t.output },
    modelUsage: { [model]: { inputTokens: t.input, outputTokens: t.output, cacheReadInputTokens: t.cacheRead, cacheCreationInputTokens: t.cacheWrite, costUSD: cost } },
  };
  return priced;
}
/** One /v1/messages body, as the API would see it, to ANTHROPIC_BASE_URL when it is set; anything but 127.0.0.1 ends the call, so no fake run reaches a real API. */
async function sendRequest(requestModel) {
  const base = process.env.ANTHROPIC_BASE_URL;
  if (!base) return;
  if (new URL(base).hostname !== '127.0.0.1') stop(9, `ANTHROPIC_BASE_URL ${base} is not on 127.0.0.1`);
  const body = { model: requestModel, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
  if (process.env.CLAUDE_CODE_EFFORT_LEVEL) body.output_config = { effort: process.env.CLAUDE_CODE_EFFORT_LEVEL };
  await new Promise((resolve, reject) => {
    const req = http.request(new URL('/v1/messages', base), { method: 'POST', agent: false, headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
if (knobs) {
  await sendRequest(model);
  if (!cell) warmUp();
}

/** A warm-up call (no --settings): a small transcript and result, so a ledger has a transcript to price; a warmupFail model writes the transcript, then dies with no result. */
function warmUp() {
  const sessionId = randomUUID();
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  const reply = { type: 'assistant', message: { id: `m-${TAG}-w`, model, usage: callUsage().usage, content: [{ type: 'text', text: 'OK' }] } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [{ type: 'user', message: { role: 'user', content: input } }, reply].map((l) => JSON.stringify(l)).join('\n'));
  if (knobs.warmupFail?.includes(model)) stop(1, `warm-up for ${model} fails (warmupFail knob)`);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, num_turns: 1, result: 'OK', ...callUsage() }));
  process.exit(0);
}
const log =(line) => process.env.FAKE_CLAUDE_LOG && fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${line}\n`);
const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'ignore', 'inherit'] });
const write = (f, text) => {
  fs.mkdirSync(path.dirname(f) || '.', { recursive: true });
  fs.writeFileSync(f, text);
};
const LIMIT_TEXT = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1790000000' });
const napFor = (marker) => {
  const ms = new RegExp(`${marker}=(\\d+)`).exec(prompt);
  if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms[1]));
};

// The session's auto-memory file and what it held at start, so a test can see what a retry put back.
const folder = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
const memoryFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', folder, 'memory', 'MEMORY.md');
const gitOut = (...args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trimEnd() : null;
};
const startSeen = {
  memory: fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, 'utf8') : null,
  hippoLimit: fs.existsSync(path.join('.hippo', 'limit.txt')),
  homeLimit: Boolean(process.env.HIPPO_HOME) && fs.existsSync(path.join(process.env.HIPPO_HOME, 'limit.txt')),
};
// SEE_STATUS: the work tree's status and HEAD as the session began, read without rewriting the index.
if (prompt.includes('SEE_STATUS')) {
  startSeen.gitStatus = gitOut('--no-optional-locks', 'status', '--porcelain=v1', '-uall');
  startSeen.gitHead = gitOut('log', '-1', '--format=%H%x09%P%x09%an%x09%at%x09%s');
}
const memWrite = (text) => {
  fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
  fs.appendFileSync(memoryFile, `${text}\n`);
};
// LIMIT_SURFACES: a cut-off attempt writes every memory surface a retry must put back.
const limitSurfaces = () => {
  if (!prompt.includes('LIMIT_SURFACES')) return;
  memWrite('cutoff');
  write(path.join('.hippo', 'limit.txt'), 'cut-off attempt\n');
  if (process.env.HIPPO_HOME) write(path.join(process.env.HIPPO_HOME, 'limit.txt'), 'cut-off attempt\n');
};

const fixedId = argv.includes('--session-id') ? argv[argv.indexOf('--session-id') + 1] : null;
const sessionId = resumeId && !prompt.includes('NEW_ID_ON_RESUME') ? resumeId : (fixedId ?? randomUUID());
const transcript = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', folder, `${sessionId}.jsonl`);
// Knobs mode ends each appended turn with the call's usage on one message of its own, so a transcript prices to what the result says.
const usageLine = () => ({ type: 'assistant', message: { id: `m-${TAG}-u`, model, usage: callUsage().usage, content: [{ type: 'text', text: 'done' }] } });
const appendTurn = (lines) => {
  if (prompt.includes('NOTRANSCRIPT')) return;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const prefix = fs.existsSync(transcript) && fs.statSync(transcript).size > 0 ? '\n' : '';
  const turn = knobs ? [...lines, usageLine()] : lines;
  fs.appendFileSync(transcript, prefix + turn.map((l) => JSON.stringify(l)).join('\n'));
};

if (prompt.includes('CRASH') && !resumeId) {
  console.error('fake crash before any result');
  process.exit(3);
}

// ESCAPE writes CLAUDE.md one dir above the workspace, where Claude Code would load it as an ancestor next session.
if (prompt.includes('ESCAPE')) fs.writeFileSync(path.join('..', 'CLAUDE.md'), 'escaped instructions\n');

// FAKE_CLAUDE_LIMIT_ONCE=<marker file>: the first LIMIT prompt leaves stray edits and hits the plan limit.
// FAKE_CLAUDE_LIMIT_ALWAYS=1: every LIMIT prompt hits it.
const limitMarker = process.env.FAKE_CLAUDE_LIMIT_ONCE;
const limitAlways = Boolean(process.env.FAKE_CLAUDE_LIMIT_ALWAYS);
if (!resumeId && prompt.includes('LIMIT') && (limitAlways || (limitMarker && !fs.existsSync(limitMarker)))) {
  if (limitMarker) fs.writeFileSync(limitMarker, '');
  fs.writeFileSync('stray.txt', 'half-done edit\n');
  if (fs.existsSync('AGENTS.md')) fs.appendFileSync('AGENTS.md', 'limited edit\n');
  // A limited attempt can break the repo too, so the runner's cleanup git fails while the limit error is in flight.
  if (prompt.includes('RM_GIT')) fs.rmSync('.git', { recursive: true, force: true });
  limitSurfaces();
  log('session-limit');
  // A real cut-off first session has billed its turns before the limit; the ledger finds them under its own id (prereg Ledger row).
  if (knobs) appendTurn([{ type: 'user', message: { role: 'user', content: input } }]);
  console.log(LIMIT_TEXT);
  process.exit(1);
}

const settings = JSON.parse(fs.readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'));
let injected = '';
for (const group of settings.hooks?.UserPromptSubmit ?? []) {
  for (const h of group.hooks) {
    const out = execSync(h.command, { input: JSON.stringify({ session_id: sessionId, prompt: input }), encoding: 'utf8' });
    if (out.trim()) injected += JSON.parse(out).hookSpecificOutput.additionalContext;
  }
}

// The agent's own shell: a bare `hippo` resolves however PATH says, or fails with the shell's own message.
const probe = spawnSync('hippo --version', { shell: true, encoding: 'utf8' });
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
const hippoDir = process.env[pathKey].split(path.delimiter).find((d) => d && ['hippo', 'hippo.cmd'].some((n) => fs.existsSync(path.join(d, n)))) ?? null;

let toolN = 0;
const toolUse = (name, toolInput) => {
  const message = { id: `m-${TAG}-${toolN}`, usage: {}, content: [{ type: 'tool_use', id: `tu-${process.pid}-${++toolN}`, name, input: toolInput }] };
  if (knobs) message.model = model;
  return { type: 'assistant', message };
};
// A fail cell dies after its valid request and its transcript, with no result: the request was billed, so the ledger has usage to count.
if (cell && knobs.fail?.some((e) => forCell(e) && e.positions.includes(cell.position))) {
  appendTurn([{ type: 'user', message: { role: 'user', content: input } }]);
  process.exit(1);
}
// Where Claude Code keeps a subagent's own transcript: <session>/subagents/<agent>.jsonl beside the session's file.
const writeSubagent = (name, commands) => write(path.join(path.dirname(transcript), sessionId, 'subagents', `${name}.jsonl`), commands.map((command) => JSON.stringify(toolUse('Bash', { command }))).join('\n'));
// KNOB_LESSON and KNOB_SOLVE: the outcome knobs decide the lesson file and the fix from the cell's draw u (the arm's lesson and solve rates).
const knobLesson = () => Boolean(cell) && prompt.includes('KNOB_LESSON');
const lessonState = () => {
  if (knobLesson()) return cell.u < knobs.outcome?.[cell.arm]?.lesson ? 'ok' : 'bad';
  const seeded = /SEED(\d+)_(OK|BAD)/g;
  for (const m of prompt.matchAll(seeded)) if (m[1] === process.env.EVAL_SEED) return m[2] === 'OK' ? 'ok' : 'bad';
  if (prompt.includes('LESSON_TOLD')) return fs.existsSync('CLAUDE.md') && fs.readFileSync('CLAUDE.md', 'utf8').includes('\n- ') ? 'ok' : 'bad';
  if (prompt.includes('LESSON_OK')) return 'ok';
  return prompt.includes('LESSON_BAD') ? 'bad' : null;
};

// The run's out dir and root: claude-config sits at <out>/runs/<seq>/<arm>/seed<n>/claude-config.
const OUT = path.resolve(process.env.CLAUDE_CONFIG_DIR, '..', '..', '..', '..', '..');
const fill = (text) => text.replaceAll('{OUT}', OUT).replaceAll('{RUN}', path.dirname(process.env.CLAUDE_CONFIG_DIR))
  .replaceAll('{WT}', process.env.FAKE_WT_DIR ?? '').replaceAll('{HOME}', process.env.HOME ?? '')
  // {B64:...} lets a probe emit a canary the prompt, which session 1's transcript holds, never spells out.
  .replace(/\{B64:([^}]+)\}/g, (_, b64) => Buffer.from(b64, 'base64').toString('utf8'));
// What the hooks added, as the attachment line Claude Code writes after the prompt (z1-replay.mjs reads the same shape).
const hookLine = () => (injected ? [{ type: 'attachment', attachment: { type: 'hook_additional_context', content: [injected], hookEvent: 'UserPromptSubmit' } }] : []);
const toolResult = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${process.pid}-${toolN}`, content: text }] } });

/** An earlier session's transcript in this config, since the read check skips a path that names nothing. */
function pastTranscript() {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', folder);
  const past = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith('.jsonl') && f !== `${sessionId}.jsonl`) : undefined;
  return path.join(dir, past ?? `${randomUUID()}.jsonl`);
}

/** Read probes, emitted as tool calls and never run: READ:<p>, READ_PAST, GREP:<p>, BASH:<cmd> (a literal \n is a newline), ECHO:<t>, ECHO_TRANSCRIPT(_PRETTY). */
function probes(text = prompt) {
  const lines = [];
  // Claude Code records its shell's cwd on each line; CWD:<dir> moves it for the probes after it, as an earlier call's `cd` would.
  let cwd = process.cwd();
  for (const m of text.matchAll(/^(CWD:\S+|READ:\S+|READ_PAST|GREP:\S+|BASH:.+|ECHO:\S+|ECHO_TRANSCRIPT(?:_PRETTY)?)$/gm)) {
    const [kind, ...rest] = m[1].split(':');
    const arg = fill(rest.join(':'));
    const from = lines.length;
    if (kind === 'CWD') cwd = path.resolve(cwd, arg);
    else if (kind === 'READ') lines.push(toolUse('Read', { file_path: arg }));
    else if (kind === 'READ_PAST') lines.push(toolUse('Read', { file_path: pastTranscript() }));
    else if (kind === 'GREP') lines.push(toolUse('Grep', { pattern: 'x', path: arg }));
    else if (kind === 'BASH') lines.push(toolUse('Bash', { command: arg.replaceAll('\\n', '\n') }));
    else if (kind === 'ECHO') lines.push(toolUse('Bash', { command: 'echo' }), toolResult(arg));
    else {
      const old = { type: 'user', uuid: randomUUID(), sessionId: randomUUID(), message: { content: 'old' } };
      // The pretty form is what `jq .` prints: no single line holds type, uuid and sessionId together.
      lines.push(toolUse('Bash', { command: 'sh x.sh' }), toolResult(`${kind === 'ECHO_TRANSCRIPT_PRETTY' ? JSON.stringify(old, null, 2) : JSON.stringify(old)}\n`));
    }
    for (const line of lines.slice(from)) line.cwd = cwd;
  }
  return lines;
}

/** HANG: two streamed assistant messages (one id repeated, 5 then 40 output tokens), a ticking grandchild, then no exit for 120 s. */
function hang(tag) {
  if (prompt.includes('HANG_STDERR')) fs.writeSync(2, 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}\n');
  const usage = (input, output) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 });
  const said = (id, input, output) => ({ type: 'assistant', message: { id, usage: usage(input, output), content: [{ type: 'text', text: 'working' }] } });
  appendTurn([
    { type: 'user', message: { role: 'user', content: input } },
    said(`m-hang-${tag}-1`, 10, 5), said(`m-hang-${tag}-1`, 10, 40), said(`m-hang-${tag}-2`, 3, 7),
  ]);
  // Outlives any run, so only the runner's tree kill can stop it; a test that finds it alive kills it itself.
  const tick = `const fs=require('fs');const end=Date.now()+600000;setInterval(()=>{fs.appendFileSync(${JSON.stringify(path.join(OUT, 'tick.txt'))},'.');if(Date.now()>end)process.exit(0);},100);`;
  const child = spawn(process.execPath, ['-e', tick], { stdio: 'inherit' });
  fs.writeFileSync(path.join(OUT, 'grandchild.pid'), String(child.pid));
  log(`hang ${tag}`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
  process.exit(0);
}

const agentFilter = (lines) => {
  fs.appendFileSync(path.join('.git', 'config'), `[filter "z0agent"]\n\t${lines}\n`);
  fs.appendFileSync('.gitattributes', '* filter=z0agent\n');
};

/** The leaks knob: a listed cell's first session writes its phrase to the auto-memory file; `once` leaves a done file beside the knobs, so a rerun in a new --out stays clean. */
function leaks() {
  for (const e of cell ? knobs.leaks ?? [] : []) {
    if (!forCell(e)) continue;
    const done = path.join(knobsDir, 'fake-state', `leak-${cell.sequence}-${cell.seed}-${cell.arm}.done`);
    if (e.once && fs.existsSync(done)) continue;
    if (e.once) write(done, '');
    memWrite(Buffer.from(e.phraseB64, 'base64').toString('utf8'));
  }
}

function firstSession() {
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(path.join(promptsDir, `${sessionId}.prompt`), prompt);
  if (prompt.includes('ON_BRANCH')) sh('git switch -q -c work');
  if (prompt.includes('ORPHAN')) sh('git checkout -q --orphan scratch');
  if (prompt.includes('FIX')) {
    fs.writeFileSync('lib.js', 'module.exports.add = (a, b) => a + b;\n');
    if (fs.existsSync('.hippo') && !prompt.includes('NOREMEMBER')) {
      // Let a failed remember crash the run: a swallowed error here hid a Windows path bug.
      sh('hippo remember "add() in lib.js had its operator flipped; check operators first"');
    }
  }
  if (cell && prompt.includes('KNOB_SOLVE') && cell.u < knobs.outcome?.[cell.arm]?.solve) fs.writeFileSync('lib.js', 'module.exports.add = (a, b) => a + b;\n');
  leaks();
  // PLANT:<text> saves <text> to the store verbatim, so a test can put a later task's gold line there.
  const plant = /PLANT:([^\n"]+)/.exec(prompt);
  if (plant && fs.existsSync('.hippo')) sh(`hippo remember "${plant[1].trim()}"`);
  if (prompt.includes('CARRY')) {
    fs.appendFileSync('AGENTS.md', 'carried agents note\n');
    fs.appendFileSync('CLAUDE.md', 'carried claude line\n');
    write('.claude/rules/r.md', 'carried rule\n');
    write('sub/CLAUDE.md', 'carried sub\n');
    write('.scratch/note.md', 'ignored note\n');
    write('.claude/agents/x.md', 'not an instruction file\n');
  }
  if (prompt.includes('DELETE')) fs.rmSync('AGENTS.md', { force: true });
  // APPEND:<file>:<text>, both filled after the match, since a filled Windows path holds a colon.
  for (const m of prompt.matchAll(/^APPEND:([^:\n]+):(.+)$/gm)) {
    fs.mkdirSync(path.dirname(path.resolve(fill(m[1]))), { recursive: true });
    fs.appendFileSync(fill(m[1]), `${fill(m[2])}\n`);
  }
  const state = lessonState();
  if (state) fs.writeFileSync('lesson.txt', `${state}\n`);
  for (const m of prompt.matchAll(/NEW_FILE (\S+)/g)) write(m[1], 'new file from the agent\n');
  if (prompt.includes('BINFILE')) fs.writeFileSync('blob.bin', Buffer.from([0, 1, 2, 255]));
  const staged = /STAGE_EDIT (\S+)/.exec(prompt);
  if (staged) {
    write(staged[1], 'v1\n');
    sh(`git add -- "${staged[1]}"`);
    write(staged[1], 'v2\n');
  }
  for (const m of prompt.matchAll(/MEMWRITE:([^\n]+)/g)) memWrite(m[1].trim());
  // Base64, so a prompt can plant a key phrase it may not hold before the teach (the order check refuses it).
  for (const m of prompt.matchAll(/MEMWRITE_B64:(\S+)/g)) memWrite(Buffer.from(m[1], 'base64').toString('utf8'));
  // NOTE:<text> is a frontmatter note beside MEMORY.md, the only kind hippo's importer reads.
  for (const [i, m] of [...prompt.matchAll(/^NOTE:(.+)$/gm)].entries()) write(path.join(path.dirname(memoryFile), `note-${i}.md`), `---\nname: note ${i}\n---\n${m[1].trim()}\n`);
  if (/^IMPORT$/m.test(prompt)) sh('hippo import --agents');
  if (/\bHANG(?:_STDERR)?\b/.test(prompt)) hang('s1');
  for (const m of prompt.matchAll(/^USERMEM:(.+)$/gm)) fs.appendFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE.md'), `${m[1]}\n`);
  if (prompt.includes('WORKTREE')) sh(`git worktree add -q --detach "${process.env.FAKE_WT_DIR}"`);
  const commands = [...prompt.matchAll(/^RUN_CMD (.+)$/gm)].map((m) => m[1]);
  appendTurn([
    { type: 'user', message: { role: 'user', content: input } },
    ...hookLine(),
    toolUse('Read', {}),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${process.pid}-1`, is_error: true, content: 'Error: file 12 not found' }] } },
    toolUse('Edit', {}),
    toolUse('Bash', { command: 'git status && cat lib.js' }),
    ...commands.map((command) => toolUse('Bash', { command })),
    ...(/\bSUBAGENT\b/.test(prompt) ? [] : probes()),
    ...(prompt.includes('S1_USAGE') ? [{ type: 'assistant', message: { id: 'm-s1', usage: { input_tokens: 0, output_tokens: 500 } } }] : []),
  ]);
  const delegated = [...prompt.matchAll(/^SUBAGENT_CMD (.+)$/gm)].map((m) => m[1]);
  if (delegated.length) writeSubagent('agent-a1', delegated);
  if (/\bSUBAGENT\b/.test(prompt)) write(path.join(path.dirname(transcript), sessionId, 'subagents', 'agent-probe.jsonl'), probes().map((l) => JSON.stringify(l)).join('\n'));
  // A filter driver in the agent's own .git/config runs as whoever runs git next, from the work tree root.
  if (prompt.includes('CLEAN_FILTER_PLANT')) agentFilter('clean = "echo escaped by a clean filter > ../CLAUDE.md; cat"\n\trequired = true');
  if (prompt.includes('SMUDGE_FILTER')) agentFilter('smudge = "echo ran >> ../smudge-ran.txt; cat"');
  if (prompt.includes('RM_GIT')) fs.rmSync('.git', { recursive: true, force: true });
}

/** A cut-off resume leaves staged, committed and transcript traces, then hits the plan limit. */
function cutOff() {
  const marker = path.join(promptsDir, `${sessionId}.cut`);
  if (!prompt.includes('CUT_ON_RESUME') || fs.existsSync(marker)) return;
  fs.writeFileSync(marker, '');
  limitSurfaces();
  // Named apart from ESCAPE so session 1 plants nothing and only the cut-off attempt does.
  if (prompt.includes('ANCESTOR_ON_CUT')) fs.writeFileSync(path.join('..', 'CLAUDE.md'), 'escaped on a cut-off resume\n');
  fs.writeFileSync('cutoff.txt', 'cut-off attempt\n');
  sh('git add cutoff.txt');
  const staged = /STAGE_EDIT (\S+)/.exec(prompt);
  if (staged) {
    write(staged[1], 'v3\n');
    sh(`git add -- "${staged[1]}"`);
  }
  if (prompt.includes('COMMIT_ON_RESUME')) {
    sh('git -c user.email=a@b -c user.name=a commit -q --no-gpg-sign -m cutoff');
    log(`cutoff-commit ${execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()}`);
  }
  appendTurn([{ type: 'user', message: { role: 'user', content: input } }, toolUse('Bash', { command: 'echo cut-off turn' })]);
  if (prompt.includes('CUT_SUBAGENT')) writeSubagent('agent-cut', ['echo cut-off subagent']);
  napFor('CUT_SLEEP_MS');
  log('cutoff-written');
  console.log(LIMIT_TEXT);
  process.exit(1);
}

function resumeTurn() {
  if (/RESUME_HANG_MS=/.test(prompt)) {
    // A hang that already let go of the workspace and the runner's pipes: the timeout must still end it.
    process.chdir(os.tmpdir());
    for (const fd of [1, 2]) fs.closeSync(fd);
    napFor('RESUME_HANG_MS');
    process.exit(0);
  }
  log(`transcript-bytes ${fs.existsSync(transcript) ? fs.statSync(transcript).size : 0}`);
  log(`resume-msg ${Buffer.from(input, 'utf8').toString('base64')}`);
  // FORK_COPY: a resume under a new id starts its file with a copy of session 1's lines, usage included.
  if (prompt.includes('FORK_COPY') && sessionId !== resumeId) fs.copyFileSync(path.join(path.dirname(transcript), `${resumeId}.jsonl`), transcript);
  for (const m of prompt.matchAll(/MEMWRITE_ON_RESUME:([^\n]+)/g)) memWrite(m[1].trim());
  cutOff();
  // RESUME_SUBAGENT_USAGE: the resume bills 1000 output tokens into a subagent file session 1 wrote.
  if (prompt.includes('RESUME_SUBAGENT_USAGE')) {
    const usage = { input_tokens: 0, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    fs.appendFileSync(path.join(path.dirname(transcript), sessionId, 'subagents', 'agent-a1.jsonl'), `\n${JSON.stringify({ type: 'assistant', message: { id: 'm-sub-r', usage } })}`);
  }
  if (/\bHANG_ON_RESUME\b/.test(prompt)) hang('r');
  if (prompt.includes('NO_RESULT_ON_RESUME')) process.exit(0);
  const line = /WRITE_ON_RESUME (.+)$/m.exec(prompt);
  if (line) fs.appendFileSync('CLAUDE.md', `${line[1]}\n`);
  if (lessonState() && input.startsWith('No:') && !knobLesson()) fs.writeFileSync('lesson.txt', 'ok\n');
  // GC_ON_RESUME: an agent's gc prunes every commit the runner has not held under a ref.
  if (prompt.includes('GC_ON_RESUME')) sh('git gc -q --prune=now');
  // CAPTURE_TEACH: the agent saves the teach message to hippo itself.
  if (prompt.includes('CAPTURE_TEACH')) sh(`hippo remember "${input.replaceAll('"', '')}"`);
  // RESUME_<probe> lines are probes only the resume makes.
  const later = [...prompt.matchAll(/^RESUME_(\S.*)$/gm)].map((m) => m[1]).join('\n');
  appendTurn([{ type: 'user', message: { role: 'user', content: input } }, ...hookLine(), toolUse('Bash', { command: `echo resumed ${input.slice(0, 3)}` }), ...probes(later)]);
}

log(`${resumeId ? 'resume' : 'session'} ${sessionId}`);
if (resumeId) resumeTurn();
else firstSession();

const PLAIN = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HIPPO_HOME', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'HIPPO_AGENT_MEMORY_TOOLS', 'DISABLE_AUTOUPDATER', 'EVAL_SEED', 'ANTHROPIC_BASE_URL'];
const extra = Math.ceil(injected.length / 4);
const result = {
  type: 'result', subtype: 'success', is_error: false, session_id: prompt.includes('NO_SESSION_ID') ? undefined : sessionId, num_turns: resumeId ? 1 : 3, total_cost_usd: 0.01,
  pad: prompt.includes('BIG_RESULT') ? 'x'.repeat(30_000) : undefined,
  strayFile: fs.existsSync('stray.txt'), argv, files, ...startSeen,
  envKeys: Object.keys(process.env).sort(),
  env: { ...Object.fromEntries(PLAIN.map((k) => [k, process.env[k] ?? null])), PATH: process.env[pathKey] },
  hasToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
  // Only a test's own fake token is echoed, so a real one never lands in a fixture's output.
  fakeToken: (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '').startsWith('fake-tok-') ? process.env.CLAUDE_CODE_OAUTH_TOKEN : null,
  hippoProbe: { status: probe.status, stdout: probe.stdout, stderr: probe.stderr }, hippoDir,
  usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
  modelUsage: { 'fake-model': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10000, cacheCreationInputTokens: 2000 + extra, costUSD: 0.01 } },
};
console.log(JSON.stringify(knobs ? { ...result, ...callUsage() } : result));
// RMWORK deletes the workspace last; only POSIX lets a process delete its own cwd.
if (prompt.includes('RMWORK')) fs.rmSync(process.cwd(), { recursive: true, force: true });
