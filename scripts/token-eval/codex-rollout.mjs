// Codex rollouts (CODEX_HOME/sessions/**/rollout-*.jsonl) read into the shapes the Claude parsers give (E6 plan D6, R2, R3, R8, R20, R21).
// Field names follow Codex 0.153.4; the smoke stage pins them against the version each run records.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isShellRead, errorRepeated } from './records.mjs';

/** session_meta sources of Codex's own memory threads; smoke fills it (plan R21), so until then every outside rollout is a stray. */
export const CODEX_INTERNAL_SOURCES = [];
// Calls that touch no file; a spawned thread is covered by the rollout set instead.
const NO_FS_CALLS = new Set(['wait', 'sleep', 'send_message', 'followup_task', 'spawn_agent', 'request_user_input_async', 'initial_instructions']);
const CELL_CALLS = new Set(['exec', 'js']);
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
const FAILED = /exited with code [1-9]/i;

const isObject = (v) => v !== null && v !== undefined && v.constructor === Object;
const isString = (v) => v !== null && v !== undefined && v.constructor === String;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // A live session can leave its last line half-written; that line holds no finished item.
    return null;
  }
}

/** Every rollout file under the Codex home, in name order (the name starts with its time). */
export function listRollouts(codexHome) {
  const dir = path.join(codexHome, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /^rollout-.*\.jsonl$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

export const rolloutLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').map(parseJson).filter(isObject) : []);
const metaOf = (file) => rolloutLines(file).find((o) => o.type === 'session_meta')?.payload ?? {};
const sourceOf = (meta) => (isObject(meta.source) ? meta.source.subagent : meta.source);

/** The JSON events `codex exec --json` printed; other stdout lines (a wrapper's log text) are skipped. */
export const streamEvents = (stdout) => String(stdout ?? '').split('\n').filter((l) => l.trim().startsWith('{')).map(parseJson).filter((e) => isObject(e) && e.type);
export const threadIdFrom = (stdout) => streamEvents(stdout).find((e) => e.type === 'thread.started')?.thread_id ?? null;

/** The text a limit or login failure is read from: error and turn.failed events, else stderr on a failed exit; never plain stdout. */
export function failureText(cc) {
  const said = streamEvents(cc.stdout).filter((e) => e.type === 'error' || e.type === 'turn.failed').map((e) => String(e.message ?? e.error?.message ?? ''));
  if (said.length) return said.join('\n');
  return cc.status !== 0 ? String(cc.stderr ?? '') : '';
}

/** The session's new rollouts by class: `agent` (the main thread and its spawned children), `internal` and `stray` (plan R3, R21). */
export function sessionRollouts(codexHome, before, threadId, internalSources = CODEX_INTERNAL_SOURCES) {
  const fresh = listRollouts(codexHome).filter((f) => !before.has(f)).map((file) => ({ file, meta: metaOf(file) }));
  const internal = (r) => [sourceOf(r.meta), r.meta.thread_source].some((v) => internalSources.includes(v));
  const roots = threadId
    ? fresh.filter((r) => r.meta.id === threadId || path.basename(r.file).endsWith(`-${threadId}.jsonl`))
    : fresh.filter((r) => !r.meta.parent_thread_id && !internal(r));
  // A kill before thread.started with two candidate mains is no transcript, never a guess.
  const main = roots.length === 1 ? roots[0] : null;
  const agent = main ? [main] : [];
  const ids = new Set(main ? [main.meta.id] : []);
  for (let grew = Boolean(main); grew;) {
    const joined = fresh.filter((r) => !agent.includes(r) && ids.has(r.meta.parent_thread_id));
    for (const r of joined) ids.add(r.meta.id);
    agent.push(...joined);
    grew = joined.length > 0;
  }
  const rest = fresh.filter((r) => !agent.includes(r));
  return {
    agent: agent.map((r) => r.file), threadIds: [...ids].filter(Boolean), ambiguous: roots.length > 1,
    internal: rest.filter(internal).map((r) => r.file), internalIds: rest.filter(internal).map((r) => r.meta.id).filter(Boolean), stray: rest.filter((r) => !internal(r)).map((r) => r.file),
  };
}

/** Usage summed over rollouts, each file's last token_count total (plan R8); null when no file has one. */
export function rolloutUsage(files) {
  const raw = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 };
  let turns = 0;
  let found = false;
  const usageRecords = [];
  for (const file of files) {
    const lines = rolloutLines(file);
    usageRecords.push(...lines.filter((o) => o.payload?.type === 'token_usage_record').map((o) => o.payload));
    const totals = lines.filter((o) => o.type === 'event_msg' && o.payload?.type === 'token_count' && o.payload.info?.total_token_usage).map((o) => o.payload.info.total_token_usage);
    turns += totals.length;
    if (!totals.length) continue;
    found = true;
    for (const k of Object.keys(raw)) raw[k] += Number(totals.at(-1)[k]) || 0;
  }
  if (!found) return null;
  const cacheReadTokens = raw.cached_input_tokens;
  const cacheWriteTokens = raw.cache_write_input_tokens;
  const inputTokens = raw.input_tokens - cacheReadTokens - cacheWriteTokens;
  return { usage: { inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens: raw.output_tokens }, raw, turns, odd: inputTokens < 0, usageRecords };
}

/** A JS string literal starting at s[i], decoded; null when none starts there or a template holds `${`. */
function literalAt(s, i) {
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  let out = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === q) return out;
    if (q === '`' && c === '$' && s[j + 1] === '{') return null;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = s[++j];
    if (e === 'u' && /^[0-9a-f]{4}$/i.test(s.slice(j + 1, j + 5))) {
      out += String.fromCharCode(parseInt(s.slice(j + 1, j + 5), 16));
      j += 4;
    } else out += ESCAPES[e] ?? e;
  }
  return null;
}

function skipString(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === s[i]) return j;
  }
  return s.length;
}

/** The text between a call's `(` at `from` and its matching `)`, strings skipped. */
function argSpan(s, from) {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') i = skipString(s, i);
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth === 0) return s.slice(from, i);
  }
  return s.slice(from);
}

/** `key: <literal>` in a call's arguments: undefined when the key is absent, null when its value is no literal. */
function keyLiteral(args, key) {
  const m = new RegExp(`(?:^|[{,\\s])["']?${key}["']?\\s*:\\s*`).exec(args);
  return m ? literalAt(args, m.index + m[0].length) : undefined;
}

/** Each `tools.<name>(` call in a JS cell, with the literals the adapter maps (plan R20). */
function cellCalls(code) {
  const calls = [];
  for (const m of String(code ?? '').matchAll(/\btools\.(\w+)\s*\(/g)) {
    const args = argSpan(code, m.index + m[0].length);
    const first = literalAt(args.trimStart(), 0);
    calls.push({
      name: m[1], cmd: keyLiteral(args, 'cmd') ?? null, workdir: keyLiteral(args, 'workdir') ?? null, chars: keyLiteral(args, 'chars'),
      sessionId: /session_id\s*:\s*(\d+)/.exec(args)?.[1] ?? null, patch: first ?? keyLiteral(args, 'input') ?? keyLiteral(args, 'patch') ?? null,
    });
  }
  return calls;
}

const joinCmd = (v) => (Array.isArray(v) ? v.join(' ') : v);

/** A function_call's arguments as a cell call; js code goes through cellCalls. */
function fnCalls(name, argText) {
  const a = parseJson(argText ?? '') ?? {};
  if (name === 'js') return cellCalls(a.code);
  const str = (v) => (isString(v) ? v : null);
  return [{ name, cmd: str(joinCmd(a.cmd ?? a.command)), workdir: str(a.workdir), chars: a.chars === undefined ? undefined : str(a.chars), sessionId: a.session_id ?? null, patch: str(a.input ?? a.patch) }];
}

/** The paths an apply_patch names: Add, Update, Delete and Move to lines. */
export const patchPaths = (patch) => [...String(patch).matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((m) => m[1].trim());

const outputText = (output) => (Array.isArray(output) ? output.map((p) => p.text ?? '').join('\n') : String(output ?? ''));
// SHORTCUT: the hook item's shape is the fake's own field; smoke names the real one (plan R16).
const isHookItem = (p) => p.type === 'message' && p.z0_fake_hook === true;
const bump = (counts, name) => { counts[name] = (counts[name] ?? 0) + 1; };

/** One call into the out lists: Bash and Edit shapes for paths, a count by name, an unparsed count when no path can be read. */
function emitCall(call, st, out) {
  // An empty write_stdin only polls a running command.
  if (call.name === 'write_stdin' && call.chars === '') return;
  bump(out.calls, call.name);
  if (call.name.startsWith('mcp__') || call.name.includes('codex_app')) out.mcp.push(call.name);
  if (NO_FS_CALLS.has(call.name)) return;
  const shell = (command, cwd) => out.tools.push({ file: st.file, name: 'Bash', input: { command, cwd }, callId: st.callId });
  if ((call.name === 'exec_command' || call.name === 'shell_command') && call.cmd !== null) {
    st.lastWorkdir = call.workdir ?? st.cwd;
    st.callCwd.set(st.callId, st.lastWorkdir);
    shell(call.cmd, st.lastWorkdir);
  } else if (call.name === 'write_stdin' && isString(call.chars)) {
    shell(call.chars, st.sessions.get(String(call.sessionId)) ?? st.lastWorkdir ?? st.cwd);
  } else if (call.name === 'apply_patch' && call.patch !== null) {
    for (const p of patchPaths(call.patch)) out.tools.push({ file: st.file, name: 'Edit', input: { file_path: p, cwd: call.workdir ?? st.cwd }, callId: st.callId });
  } else bump(out.unparsed, call.name);
}

function readItem(p, st, out) {
  st.callId = p.call_id ?? null;
  if (p.type === 'custom_tool_call') {
    if (p.name === 'exec') {
      bump(out.calls, 'exec');
      for (const c of cellCalls(p.input)) emitCall(c, st, out);
    } else emitCall({ name: p.name, cmd: null, workdir: null, chars: undefined, sessionId: null, patch: p.name === 'apply_patch' ? String(p.input ?? '') : null }, st, out);
  } else if (p.type === 'function_call') {
    if (CELL_CALLS.has(p.name)) bump(out.calls, p.name);
    for (const c of fnCalls(p.name, p.arguments)) emitCall(c, st, out);
  } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
    const text = outputText(p.output);
    out.outputs.push({ file: st.file, text, failed: FAILED.test(text) });
    // An exec that keeps running names a session id; a later write_stdin to it runs in that exec's workdir.
    const opened = /session[ _]?id\D{0,4}(\d+)/i.exec(text)?.[1];
    if (opened && st.callCwd.has(p.call_id)) st.sessions.set(opened, st.callCwd.get(p.call_id));
  } else if (isHookItem(p)) out.hooks.push({ file: st.file, text: outputText(p.content) });
}

/** Every call, output and hook item across the rollouts, in file order. */
export function parseRollouts(files) {
  const out = { tools: [], outputs: [], hooks: [], calls: {}, unparsed: {}, mcp: [] };
  for (const file of files) {
    const lines = rolloutLines(file);
    const st = { file, cwd: lines.find((o) => o.type === 'session_meta')?.payload?.cwd ?? null, lastWorkdir: null, callId: null, sessions: new Map(), callCwd: new Map() };
    for (const o of lines) {
      if (o.type === 'turn_context' && o.payload?.cwd) st.cwd = o.payload.cwd;
      else if (o.type === 'response_item' && isObject(o.payload)) readItem(o.payload, st, out);
    }
  }
  return out;
}

const strip = ({ file, name, input }) => ({ file, name, input });

/** The Claude parsers' shapes over rollouts, so the read check, Z0_COMMANDS and the work counts run unchanged. */
export const codexAdapter = {
  toolInputs: (files) => parseRollouts(files).tools.map(strip),
  toolResultTexts: (files) => parseRollouts(files).outputs.map(({ file, text }) => ({ file, text })),
  hookContexts: (files) => parseRollouts(files).hooks,
  commandLog: (files) => parseRollouts(files).tools.filter((t) => t.name === 'Bash').map((t) => t.input.command),
  transcriptWork(files, seenErrors) {
    if (files.length === 0) return { toolCalls: null, fileReads: null, shellReads: null, repeatedErrors: null };
    const parsed = parseRollouts(files);
    const reads = parsed.tools.filter((t) => t.name === 'Bash' && isShellRead('Bash', t.input.command)).length;
    const toolCalls = Object.entries(parsed.calls).filter(([name]) => !CELL_CALLS.has(name)).reduce((n, [, c]) => n + c, 0);
    const repeatedErrors = parsed.outputs.filter((o) => o.failed && errorRepeated(o.text, seenErrors)).length;
    return { toolCalls, fileReads: reads, shellReads: reads, repeatedErrors };
  },
};
