#!/usr/bin/env node
// Stand-in for `codex exec --json` in the Z0 set X tests: it reads the prompt from stdin, writes a rollout shaped like
// Codex 0.153.4's under $CODEX_HOME/sessions, prints the JSON events, and logs what it saw. Markers in the prompt pick the behaviour.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const KNOWN = new Set(['--json', '--dangerously-bypass-approvals-and-sandbox', '--strict-config', '--dangerously-bypass-hook-trust']);
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('codex-cli 0.153.4-fake');
  process.exit(0);
}
const opts = { flags: [] };
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--model' || a === '--cd') opts[a.slice(2)] = argv[++i];
  else if (KNOWN.has(a)) opts.flags.push(a);
  else if (a !== '-') {
    console.error(`fake codex: unknown argument ${a}`);
    process.exit(2);
  }
}
if (argv[0] !== 'exec' || !opts.model || !opts.cd || argv.at(-1) !== '-') {
  console.error(`fake codex: expected exec --model M --cd DIR ... -, got ${argv.join(' ')}`);
  process.exit(2);
}

const prompt = fs.readFileSync(0, 'utf8');
process.chdir(opts.cd);
const HOME = process.env.CODEX_HOME;
// codex-home sits at <out>/runs/<seq>/<arm>/seed<n>/codex-home.
const OUT = path.resolve(HOME, '..', '..', '..', '..', '..');
const AUTH = path.join(HOME, 'auth.json');
const has = (m) => new RegExp(`\\b${m}\\b`).test(prompt);
const write = (f, text) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
// HOOKROW, HOOKROW_CHILD and HOOKROW_MEMGEN book one hippo hook injection in the cell's store under that thread's id.
const ledger = /\bHOOKROW/.test(prompt)
  ? { db: await import(new URL('../../dist/db/index.js', import.meta.url)), tokens: await import(new URL('../../dist/store/token-ledger.js', import.meta.url)) } : null;
function hookRow(sessionId) {
  const db = ledger.db.openHippoDb(path.resolve('.hippo'));
  try {
    ledger.tokens.recordTokenUse(db, { tenantId: 'default', sessionId, surface: 'hook', event: 'inject', items: 1, tokens: 10 });
  } finally {
    ledger.db.closeHippoDb(db);
  }
}
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const fill = (s) => s.replaceAll('{OUT}', OUT).replaceAll('{CODEX_HOME}', HOME).replaceAll('{RUN}', path.dirname(HOME));

if (process.env.FAKE_CODEX_LOG) {
  const auth = read(AUTH);
  const seen = {
    argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), home: process.env.HOME, userprofile: process.env.USERPROFILE,
    appdata: process.env.APPDATA, localappdata: process.env.LOCALAPPDATA, codexHome: HOME, config: read(path.join(HOME, 'config.toml')),
    agents: read('AGENTS.md'), authSha: auth === null ? null : createHash('sha256').update(auth).digest('hex'),
  };
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(seen)}\n`);
}

if (has('CRASH')) {
  console.error('fake codex crash before any event');
  process.exit(3);
}

const threadId = randomUUID();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const rolloutPath = (id) => {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return path.join(HOME, 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()), `rollout-${stamp}-${id}.jsonl`);
};
const line = (type, payload) => ({ timestamp: new Date().toISOString(), type, payload });
const meta = (id, extra = {}) => line('session_meta', { id, cwd: process.cwd(), originator: 'codex_exec', cli_version: '0.153.4', source: 'exec', ...extra });
const tokenCount = (input, cached, output) => line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } });
const emit = (event) => console.log(JSON.stringify(event));
const writeRollout = (file, lines) => write(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

let callN = 0;
/** A shell call in the form the prompt picks (SHAPE:fn, SHAPE:legacy, else an exec cell), with its output. */
function shellCall(cmd, output) {
  const id = `call_${++callN}`;
  const callForm = /SHAPE:(fn|legacy)/.exec(prompt)?.[1];
  const workdir = process.cwd();
  let call;
  if (callForm === 'fn') call = { type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd, workdir }) };
  else if (callForm === 'legacy') call = { type: 'function_call', name: 'shell_command', call_id: id, arguments: JSON.stringify({ command: cmd, workdir }) };
  else call = { type: 'custom_tool_call', name: 'exec', call_id: id, input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(cmd)}, workdir: ${JSON.stringify(workdir)} });\ntext(r);` };
  const out = callForm ? { type: 'function_call_output', call_id: id, output } : { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text: output }] };
  emit({ type: 'item.completed', item: { id: `item_${callN}`, type: 'command_execution', command: cmd, aggregated_output: output, exit_code: 0, status: 'completed' } });
  return [line('response_item', call), line('response_item', out)];
}

const readCall = (p) => shellCall(`cat ${JSON.stringify(p)}`, read(p) ?? `cat: ${p}: No such file or directory\nProcess exited with code 1`);

/** A second thread's rollout: CHILD (parent set), MEMGEN (internal source), STRAY (source exec, no parent). */
function sideRollout(kind) {
  const id = randomUUID();
  const past = path.join(HOME, 'sessions', 'past-rollout.jsonl');
  const extra = kind === 'child' ? { parent_thread_id: threadId, source: { subagent: { thread_spawn: {} } }, thread_source: 'subagent' }
    : kind === 'memgen' ? { source: process.env.FAKE_CODEX_INTERNAL_SOURCE || 'z0-memgen' } : { source: 'exec' };
  const lines = [meta(id, extra), ...readCall(past)];
  if (kind === 'memgen') lines.push(line('response_item', { type: 'function_call_output', call_id: 'memgen-q', output: JSON.stringify(meta('old-thread')) }));
  const canary = kind === 'memgen' ? /MEMGEN_CANARY:(\S+)/.exec(prompt)?.[1] : null;
  if (canary) lines.push(...readCall(fill(canary)));
  lines.push(tokenCount(300, 100, 30));
  writeRollout(rolloutPath(id), lines);
  if (has(`HOOKROW_${kind.toUpperCase()}`)) hookRow(id);
}

/** LIMIT once per $FAKE_CODEX_STATE: a cut-off rollout and memory write, then the limit error. */
function limitOnce() {
  const state = process.env.FAKE_CODEX_STATE;
  if (!has('LIMIT') || !state || fs.existsSync(state)) return;
  fs.writeFileSync(state, '');
  emit({ type: 'thread.started', thread_id: threadId });
  writeRollout(rolloutPath(threadId), [meta(threadId), tokenCount(400, 100, 10)]);
  write(path.join(HOME, 'memories', 'cutoff.md'), 'cut-off attempt\n');
  write(path.join(HOME, 'state.json'), '{"cutoff":true}\n');
  if (has('PRINT_AUTH')) console.error(`auth: ${read(AUTH)}`);
  emit({ type: 'error', message: "You've hit your usage limit. Try again later." });
  emit({ type: 'turn.failed', error: { message: "You've hit your usage limit." } });
  process.exit(1);
}

/** HANG: the rollout first, no thread.started, a ticking grandchild, then no exit for 120 s. */
function hang(lines) {
  writeRollout(rolloutPath(threadId), [...lines, tokenCount(700, 200, 40)]);
  const tick = `const fs=require('fs');const end=Date.now()+600000;setInterval(()=>{fs.appendFileSync(${JSON.stringify(path.join(OUT, 'tick.txt'))},'.');if(Date.now()>end)process.exit(0);},100);`;
  const child = spawn(process.execPath, ['-e', tick], { stdio: 'inherit' });
  fs.writeFileSync(path.join(OUT, 'grandchild.pid'), String(child.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
  process.exit(0);
}

/** The work the prompt asks for, as rollout lines; files are changed for real. */
function work() {
  const lines = [];
  for (const m of prompt.matchAll(/^AGENTS:(.+)$/gm)) fs.appendFileSync('AGENTS.md', `${m[1]}\n`);
  if (has('FIX')) fs.writeFileSync('lib.js', 'module.exports.add = (a, b) => a + b;\n');
  const lesson = has('LESSON_OK') ? 'ok' : has('LESSON_BAD') ? 'bad' : null;
  if (lesson) fs.writeFileSync('lesson.txt', `${lesson}\n`);
  for (const m of prompt.matchAll(/^READ:(.+)$/gm)) lines.push(...readCall(fill(m[1].trim())));
  // {B64:...} lets a hook context hold a key phrase the apply prompt may not spell out.
  const unb64 = (text) => text.replace(/\{B64:([^}]+)\}/g, (_, b64) => Buffer.from(b64, 'base64').toString('utf8'));
  for (const m of prompt.matchAll(/^HOOKCTX:(.+)$/gm)) lines.push(line('response_item', { type: 'message', role: 'developer', z0_fake_hook: true, content: [{ type: 'input_text', text: unb64(m[1]) }] }));
  if (has('MCP_TOOL')) lines.push(line('response_item', { type: 'function_call', name: 'mcp__codex_app__list_threads', call_id: 'mcp-1', arguments: '{}' }));
  if (has('PRINT_AUTH')) {
    const auth = read(AUTH) ?? '';
    lines.push(...shellCall(`cat ${JSON.stringify(AUTH)}`, auth));
    console.error(`auth: ${auth}`);
    write(path.join(HOME, 'memories', 'auth-note.md'), `login file: ${auth}\n`);
  }
  if (has('REFRESH')) {
    const auth = JSON.parse(read(AUTH));
    auth.tokens = { ...auth.tokens, access_token: `refreshed-access-${randomUUID()}`, refresh_token: `refreshed-refresh-${randomUUID()}` };
    fs.writeFileSync(AUTH, JSON.stringify(auth, null, 2));
  }
  if (has('LOG_AUTH')) write(path.join(HOME, 'logs_2.sqlite'), `SQLite format 3\0${read(AUTH)}`);
  // Outside every per-cell sweep root, so only runAll's final sweep can find it.
  if (has('LEAK_OUT')) write(path.join(OUT, 'leak-out.txt'), read(AUTH) ?? '');
  return lines;
}

/** The UserPromptSubmit hooks in hooks.json, run as Codex runs them: only under the trust flag, or trust text in config.toml naming this file. */
function hookLines() {
  const file = path.join(HOME, 'hooks.json');
  const trusted = opts.flags.includes('--dangerously-bypass-hook-trust') || (read(path.join(HOME, 'config.toml')) ?? '').includes(`[hooks.state.'${file}:`);
  if (!trusted || !fs.existsSync(file)) return [];
  const payload = JSON.stringify({ session_id: threadId, hook_event_name: 'UserPromptSubmit', cwd: process.cwd(), prompt });
  const hooks = (JSON.parse(read(file)).hooks?.UserPromptSubmit ?? []).flatMap((group) => group.hooks ?? []);
  return hooks.flatMap((h) => {
    const r = spawnSync((process.platform === 'win32' && h.commandWindows) || h.command, { shell: true, input: payload, encoding: 'utf8' });
    // A hook with nothing to add prints nothing; any other output must parse, so a broken hook fails the session.
    const said = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.additionalContext : null;
    return said ? [line('response_item', { type: 'message', role: 'developer', z0_fake_hook: true, content: [{ type: 'input_text', text: said }] })] : [];
  });
}

/** MEMWRITE:<ms>[x<n>]: a detached child appends to the v1 memory summary n times (default 1), ms apart, from after the session has ended. */
function memWrite() {
  const m = /MEMWRITE:(\d+)(?:x(\d+))?/.exec(prompt);
  if (!m) return;
  const file = path.join(HOME, 'memories', 'memory_summary.md');
  const code = `const fs=require('fs');let n=${Number(m[2] ?? 1)};const t=setInterval(()=>{fs.mkdirSync(${JSON.stringify(path.dirname(file))},{recursive:true});fs.appendFileSync(${JSON.stringify(file)},'summary\\n');if(--n<=0)clearInterval(t);},${Number(m[1])});`;
  spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' }).unref();
}

limitOnce();
const head = [meta(threadId), line('turn_context', { cwd: process.cwd(), model: opts.model }), line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] })];
if (has('HANG')) hang([...head, ...work()]);
emit({ type: 'thread.started', thread_id: threadId });
emit({ type: 'turn.started' });
if (has('NOISE')) console.log('hippo: last sleep hit a usage limit earlier today\nnot json { either');
if (has('AUTH_FAIL')) {
  writeRollout(rolloutPath(threadId), head);
  emit({ type: 'error', message: '401 Unauthorized: your refresh token was revoked; log in again' });
  emit({ type: 'turn.failed', error: { message: '401 Unauthorized' } });
  process.exit(1);
}
const body = [...hookLines(), ...work()];
// FINALMSG: a closing reply for hippo's digest; the sentence lives here because the digest drops one that repeats the prompt.
if (has('FINALMSG')) body.push(line('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Fixture reply for the wrapper digest check.' }] }));
writeRollout(rolloutPath(threadId), [...head, tokenCount(1000, 600, 50), ...body, tokenCount(2000, 1500, 120)]);
if (has('HOOKROW')) hookRow(threadId);
if (has('CHILD')) sideRollout('child');
if (has('MEMGEN')) sideRollout('memgen');
if (has('STRAY')) sideRollout('stray');
memWrite();
fs.appendFileSync(path.join(HOME, 'history.jsonl'), `${JSON.stringify({ session_id: threadId, ts: Math.floor(Date.now() / 1000), text: prompt })}\n`);
emit({ type: 'item.completed', item: { id: 'item_last', type: 'agent_message', text: 'done' } });
emit({ type: 'turn.completed', usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 120 } });
