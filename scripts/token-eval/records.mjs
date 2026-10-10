// A Claude Code session read into a run record: the result's usage, the transcript's work counts, and the record shapes.
import * as fs from 'node:fs';
import * as path from 'node:path';

const LIMIT_RE = /usage limit|hit your (usage )?limit|limit reached|rate_limit_error|overloaded_error/i;

/** A plan usage limit or an overload: not a task failure, so the session is rerun. */
export function isUsageLimit(result, output) {
  // The run's own --max-budget-usd or turn cap is a real outcome, never retried.
  if (String(result?.subtype ?? '').startsWith('error_max')) return false;
  return (result === null || Boolean(result.is_error)) && LIMIT_RE.test(output);
}

export function findTranscript(projectsDir, sessionId) {
  if (!sessionId || !fs.existsSync(projectsDir)) return null;
  for (const p of fs.readdirSync(projectsDir)) {
    const f = path.join(projectsDir, p, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** A session's main transcript and its subagent transcripts (`<id>/subagents/*.jsonl`, as claude-usage.mjs reads them). */
export function sessionFiles(projectsDir, sessionId) {
  if (!sessionId || !fs.existsSync(projectsDir)) return [];
  const files = [];
  for (const p of fs.readdirSync(projectsDir)) {
    const main = path.join(projectsDir, p, `${sessionId}.jsonl`);
    if (fs.existsSync(main)) files.push(main);
    const sub = path.join(projectsDir, p, sessionId, 'subagents');
    if (fs.existsSync(sub)) files.push(...fs.readdirSync(sub).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(sub, f)));
  }
  return files;
}

/** Every transcript under projects/, subagent files included. */
export function listTranscripts(projectsDir) {
  if (!fs.existsSync(projectsDir)) return [];
  return fs.readdirSync(projectsDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(e.parentPath, e.name));
}

/** A `{file, fromBytes, toBytes}` segment, one turn's share of a file; a bare path is the whole file. */
export const asSegment = (item) => (item.file === undefined ? { file: item } : item);

export function segmentText(seg) {
  const { file, fromBytes = 0, toBytes } = asSegment(seg);
  const bytes = fs.readFileSync(file);
  return bytes.subarray(fromBytes, toBytes ?? bytes.length).toString('utf8');
}

/** Parsed lines of each segment; a missing file has none. */
function* segmentLines(segments) {
  for (const seg of segments) {
    if (!seg.file || !fs.existsSync(seg.file)) continue;
    for (const line of segmentText(seg).split('\n')) {
      const o = parseLine(line);
      if (o) yield o;
    }
  }
}

/** Usage of a turn with no result: per message id not in skip, the largest value in each bucket (a streamed message repeats its id), summed over ids. */
export function transcriptUsage(segments, skip = new Set()) {
  const byId = new Map();
  let anon = 0;
  for (const o of segmentLines(segments)) {
    const u = o.type === 'assistant' ? o.message?.usage : null;
    if (!u || skip.has(o.message.id)) continue;
    const key = o.message.id ?? `anon-${anon++}`;
    const prev = byId.get(key) ?? [0, 0, 0, 0];
    const cur = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens, u.output_tokens].map((n) => Number(n) || 0);
    byId.set(key, prev.map((p, i) => Math.max(p, cur[i])));
  }
  const total = [0, 0, 0, 0];
  for (const v of byId.values()) v.forEach((n, i) => { total[i] += n; });
  return { inputTokens: total[0], cacheWriteTokens: total[1], cacheReadTokens: total[2], outputTokens: total[3] };
}

/** The distinct assistant message ids in segments. */
export function assistantIds(segments) {
  const ids = new Set();
  for (const o of segmentLines(segments)) if (o.type === 'assistant' && o.message?.id) ids.add(o.message.id);
  return ids;
}

/** Turns of a turn with no result: distinct assistant message ids not in skip, a different unit from the result's num_turns. */
export const assistantTurns = (segments, skip = new Set()) => [...assistantIds(segments)].filter((id) => !skip.has(id)).length;

export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const BASH_READ = /^(?:cat|head|tail|less|more|grep|rg)(?=\s|$)|^sed\s+-n(?=\s|$)/;
// `type` reads a file only in PowerShell; in Git Bash it is a builtin that names a command.
const PS_READ = /^(?:get-content|select-string|type|gc)(?=\s|$)/i;

/** Whether a shell command has a read command word at its start or after `|`, `;`, `&&`, `||` or `(`. */
export function isShellRead(tool, command) {
  return String(command ?? '').split(/\|\||&&|[|;(]/).some((part) => {
    const word = part.trim();
    return BASH_READ.test(word) || (tool === 'PowerShell' && PS_READ.test(word));
  });
}

const uniqueFiles = (files) => [...new Set((files ?? []).filter(Boolean).map((f) => path.resolve(f)))];

function parseLine(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    // A live session can leave its last line half-written; that line holds no finished tool call.
    return null;
  }
}

/** Each path or segment once, its path resolved. */
function uniqueSegments(items) {
  const seen = new Map();
  for (const item of (items ?? []).filter(Boolean)) {
    const seg = asSegment(item);
    const file = path.resolve(seg.file);
    const key = `${file}|${seg.fromBytes ?? 0}|${seg.toBytes ?? ''}`;
    if (!seen.has(key)) seen.set(key, { ...seg, file });
  }
  return [...seen.values()];
}

/** Parsed lines of each transcript file or segment, each once, as `{file, o}`. */
function* fileLines(items) {
  for (const seg of uniqueSegments(items)) {
    for (const line of segmentText(seg).split('\n')) {
      const o = parseLine(line);
      if (o) yield { file: seg.file, o };
    }
  }
}

/** tool_use and tool_result blocks across transcript files as `{file, block}`, each tool_use id once. */
function* fileBlocks(files) {
  const seen = new Set();
  for (const { file, o } of fileLines(files)) {
    const content = Array.isArray(o.message?.content) ? o.message.content : [];
    for (const block of content) {
      if (block.type !== 'tool_use' && block.type !== 'tool_result') continue;
      const id = block.type === 'tool_use' ? block.id : block.tool_use_id;
      const key = id === undefined ? null : `${block.type}:${id}`;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      yield { file, block };
    }
  }
}

function* toolBlocks(files) {
  for (const { block } of fileBlocks(files)) yield block;
}

/** Every tool call as `{file, name, input}`. */
export function toolInputs(files) {
  return [...fileBlocks(files)].filter(({ block }) => block.type === 'tool_use').map(({ file, block }) => ({ file, name: block.name, input: block.input ?? {} }));
}

const blockText = (content) => (Array.isArray(content) ? content.map((c) => c.text ?? '').join('\n') : String(content ?? ''));

/** Every tool result's text as `{file, text}`. */
export function toolResultTexts(files) {
  return [...fileBlocks(files)].filter(({ block }) => block.type === 'tool_result').map(({ file, block }) => ({ file, text: blockText(block.content) }));
}

/** Text a hook added to the context (`hook_additional_context` attachments, as z1-replay.mjs reads them) as `{file, text}`. */
export function hookContexts(files) {
  const text = (c) => (Array.isArray(c) ? c.join('\n') : String(c ?? ''));
  return [...fileLines(files)].filter(({ o }) => o.attachment?.type === 'hook_additional_context').map(({ file, o }) => ({ file, text: text(o.attachment.content) }));
}

/** Tool calls, file reads (Read, Grep and shell reads; `shellReads` is the shell share) and repeated error signatures; all null with no transcript. */
export function transcriptWork(files, seenErrors) {
  if (uniqueFiles(files).length === 0) return { toolCalls: null, fileReads: null, shellReads: null, repeatedErrors: null };
  const work = { toolCalls: 0, fileReads: 0, shellReads: 0, repeatedErrors: 0 };
  for (const block of toolBlocks(files)) {
    if (block.type === 'tool_use') {
      work.toolCalls++;
      if (block.name === 'Read' || block.name === 'Grep') work.fileReads++;
      else if (SHELL_TOOLS.has(block.name) && isShellRead(block.name, block.input?.command)) {
        work.fileReads++;
        work.shellReads++;
      }
    } else if (block.is_error && errorRepeated(blockText(block.content), seenErrors)) work.repeatedErrors++;
  }
  return work;
}

/** Whether an error text repeats a signature seen earlier in the run; a new signature is remembered. */
export function errorRepeated(text, seenErrors) {
  const sig = text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!sig) return false;
  if (seenErrors.has(sig)) return true;
  seenErrors.add(sig);
  return false;
}

/** Every Bash and PowerShell command in the transcripts, file by file in order: what a checker reads through Z0_COMMANDS. */
export function commandLog(files) {
  const commands = [];
  for (const block of toolBlocks(files)) {
    if (block.type === 'tool_use' && SHELL_TOOLS.has(block.name)) commands.push(String(block.input?.command ?? ''));
  }
  return commands;
}

/** Sum Claude Code's per-model usage; the top-level `usage` can read zero when a run stops on its budget cap, so it is only a fallback. */
export function usageFromResult(result) {
  const usage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  const models = result.modelUsage ?? {};
  for (const m of Object.values(models)) {
    usage.inputTokens += Number(m.inputTokens) || 0;
    usage.cacheWriteTokens += Number(m.cacheCreationInputTokens) || 0;
    usage.cacheReadTokens += Number(m.cacheReadInputTokens) || 0;
    usage.outputTokens += Number(m.outputTokens) || 0;
  }
  if (Object.keys(models).length === 0 && result.usage) {
    usage.inputTokens = Number(result.usage.input_tokens) || 0;
    usage.cacheWriteTokens = Number(result.usage.cache_creation_input_tokens) || 0;
    usage.cacheReadTokens = Number(result.usage.cache_read_input_tokens) || 0;
    usage.outputTokens = Number(result.usage.output_tokens) || 0;
  }
  return usage;
}

const INVALID_NULLS = {
  usage: null, costUsd: null, turns: null, toolCalls: null, fileReads: null, shellReads: null, repeatedErrors: null,
  wallMs: null, teachTurns: null, correctionTurns: null, acceptancePassed: null, teachForm: null,
};

/** Every invalid shape (setup, leak, no-result, no-transcript, resume, checker): the full field set, nothing graded. */
export function invalidRecord(base, reason, fields) {
  return {
    ...base, ...INVALID_NULLS, lessons: [], resolved: false, timedOut: false, void: null, leak: false, invalid: reason,
    limitRetries: 0, sessionId: null, resumeSessionId: null, transcriptFound: false, hippo: null, agentError: null, ...fields,
  };
}

/** A graded record; `resolved` is the prereg's literal formula. */
export function validRecord(base, fields) {
  const resolved = fields.acceptancePassed && fields.lessons.every((l) => l.final === 'pass') && !fields.timedOut;
  return { ...base, ...fields, resolved, void: fields.void ?? null, leak: false, invalid: null };
}
