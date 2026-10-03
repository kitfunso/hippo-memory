#!/usr/bin/env node
// Stand-in for `claude -p --output-format json` in the token-eval runner tests. It reads the prompt from stdin,
// runs the UserPromptSubmit hooks from --settings with a real payload, calls `hippo` through PATH, writes a transcript
// under $CLAUDE_CONFIG_DIR/projects/ and prints a result shaped like Claude Code's, plus what it saw.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('0.0.0-fake (Claude Code)');
  process.exit(0);
}
const input = fs.readFileSync(0, 'utf8');
const SEEN_FILES = ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', 'docs/AGENTS.md', 'sub/CLAUDE.md', '.claude/rules/r.md', '.claude/agents/x.md', '.scratch/note.md'];
const files = Object.fromEntries(SEEN_FILES.filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f, 'utf8')]));
const resumeId = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : null;
// Each session's prompt lives outside the transcript dir, so a resume still knows its markers when no transcript was written.
const promptsDir = path.join(path.dirname(process.env.CLAUDE_CONFIG_DIR), 'fake-prompts');
const prompt = resumeId ? fs.readFileSync(path.join(promptsDir, `${resumeId}.prompt`), 'utf8') : input;
const log = (line) => process.env.FAKE_CLAUDE_LOG && fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${line}\n`);
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
  log('session-limit');
  console.log(LIMIT_TEXT);
  process.exit(1);
}

const sessionId = resumeId && !prompt.includes('NEW_ID_ON_RESUME') ? resumeId : randomUUID();
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
const toolUse = (name, toolInput) => ({ type: 'assistant', message: { id: `m-${process.pid}-${toolN}`, usage: {}, content: [{ type: 'tool_use', id: `tu-${process.pid}-${++toolN}`, name, input: toolInput }] } });
const folder = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
const transcript = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', folder, `${sessionId}.jsonl`);
const appendTurn = (lines) => {
  if (prompt.includes('NOTRANSCRIPT')) return;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const prefix = fs.existsSync(transcript) && fs.statSync(transcript).size > 0 ? '\n' : '';
  fs.appendFileSync(transcript, prefix + lines.map((l) => JSON.stringify(l)).join('\n'));
};
// Where Claude Code keeps a subagent's own transcript: <session>/subagents/<agent>.jsonl beside the session's file.
const writeSubagent = (name, commands) => write(path.join(path.dirname(transcript), sessionId, 'subagents', `${name}.jsonl`), commands.map((command) => JSON.stringify(toolUse('Bash', { command }))).join('\n'));
const lessonState = () => {
  const seeded = /SEED(\d+)_(OK|BAD)/g;
  for (const m of prompt.matchAll(seeded)) if (m[1] === process.env.EVAL_SEED) return m[2] === 'OK' ? 'ok' : 'bad';
  if (prompt.includes('LESSON_TOLD')) return fs.existsSync('CLAUDE.md') && fs.readFileSync('CLAUDE.md', 'utf8').includes('\n- ') ? 'ok' : 'bad';
  if (prompt.includes('LESSON_OK')) return 'ok';
  return prompt.includes('LESSON_BAD') ? 'bad' : null;
};

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
  const state = lessonState();
  if (state) fs.writeFileSync('lesson.txt', `${state}\n`);
  for (const m of prompt.matchAll(/NEW_FILE (\S+)/g)) write(m[1], 'new file from the agent\n');
  const staged = /STAGE_EDIT (\S+)/.exec(prompt);
  if (staged) {
    write(staged[1], 'v1\n');
    sh(`git add -- "${staged[1]}"`);
    write(staged[1], 'v2\n');
  }
  const commands = [...prompt.matchAll(/^RUN_CMD (.+)$/gm)].map((m) => m[1]);
  appendTurn([
    { type: 'user', message: { role: 'user', content: input } },
    toolUse('Read', {}),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${process.pid}-1`, is_error: true, content: 'Error: file 12 not found' }] } },
    toolUse('Edit', {}),
    toolUse('Bash', { command: 'git status && cat lib.js' }),
    ...commands.map((command) => toolUse('Bash', { command })),
  ]);
  const delegated = [...prompt.matchAll(/^SUBAGENT_CMD (.+)$/gm)].map((m) => m[1]);
  if (delegated.length) writeSubagent('agent-a1', delegated);
  if (prompt.includes('RM_GIT')) fs.rmSync('.git', { recursive: true, force: true });
}

/** A cut-off resume leaves staged, committed and transcript traces, then hits the plan limit. */
function cutOff() {
  const marker = path.join(promptsDir, `${sessionId}.cut`);
  if (!prompt.includes('CUT_ON_RESUME') || fs.existsSync(marker)) return;
  fs.writeFileSync(marker, '');
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
    // Windows kills only the shell on a timeout, so the orphan lets go of the workspace and the runner's pipes before it hangs.
    process.chdir(os.tmpdir());
    for (const fd of [1, 2]) fs.closeSync(fd);
    napFor('RESUME_HANG_MS');
    process.exit(0);
  }
  log(`transcript-bytes ${fs.existsSync(transcript) ? fs.statSync(transcript).size : 0}`);
  log(`resume-msg ${Buffer.from(input, 'utf8').toString('base64')}`);
  cutOff();
  if (prompt.includes('NO_RESULT_ON_RESUME')) process.exit(0);
  const line = /WRITE_ON_RESUME (.+)$/m.exec(prompt);
  if (line) fs.appendFileSync('CLAUDE.md', `${line[1]}\n`);
  if (lessonState() && input.startsWith('No:')) fs.writeFileSync('lesson.txt', 'ok\n');
  appendTurn([{ type: 'user', message: { role: 'user', content: input } }, toolUse('Bash', { command: `echo resumed ${input.slice(0, 3)}` })]);
}

log(`${resumeId ? 'resume' : 'session'} ${sessionId}`);
if (resumeId) resumeTurn();
else firstSession();

const PLAIN = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HIPPO_HOME', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'HIPPO_AGENT_MEMORY_TOOLS', 'DISABLE_AUTOUPDATER', 'EVAL_SEED', 'ANTHROPIC_BASE_URL'];
const extra = Math.ceil(injected.length / 4);
console.log(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, session_id: prompt.includes('NO_SESSION_ID') ? undefined : sessionId, num_turns: resumeId ? 1 : 3, total_cost_usd: 0.01,
  pad: prompt.includes('BIG_RESULT') ? 'x'.repeat(30_000) : undefined,
  strayFile: fs.existsSync('stray.txt'), argv, files,
  envKeys: Object.keys(process.env).sort(),
  env: { ...Object.fromEntries(PLAIN.map((k) => [k, process.env[k] ?? null])), PATH: process.env[pathKey] },
  hasToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
  hippoProbe: { status: probe.status, stdout: probe.stdout, stderr: probe.stderr }, hippoDir,
  usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
  modelUsage: { 'fake-model': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10000, cacheCreationInputTokens: 2000 + extra, costUSD: 0.01 } },
}));
// RMWORK deletes the workspace last; only POSIX lets a process delete its own cwd.
if (prompt.includes('RMWORK')) fs.rmSync(process.cwd(), { recursive: true, force: true });
