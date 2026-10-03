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

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const BASH_READ = /^(?:cat|head|tail|less|more|grep|rg)(?=\s|$)|^sed\s+-n(?=\s|$)/;
// `type` reads a file only in PowerShell; in Git Bash it is a builtin that names a command.
const PS_READ = /^(?:get-content|select-string|type|gc)(?=\s|$)/i;

/** Whether a shell command has a read command word at its start or after `|`, `;`, `&&`, `||` or `(`. */
function isShellRead(tool, command) {
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

/** tool_use and tool_result blocks across transcript files, each file once and each tool_use id once. */
function* toolBlocks(files) {
  const seen = new Set();
  for (const file of uniqueFiles(files)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const o = parseLine(line);
      const content = Array.isArray(o?.message?.content) ? o.message.content : [];
      for (const block of content) {
        if (block.type !== 'tool_use' && block.type !== 'tool_result') continue;
        const id = block.type === 'tool_use' ? block.id : block.tool_use_id;
        const key = id === undefined ? null : `${block.type}:${id}`;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        yield block;
      }
    }
  }
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
    } else if (block.is_error) {
      const text = Array.isArray(block.content) ? block.content.map((c) => c.text ?? '').join(' ') : String(block.content ?? '');
      const sig = text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!sig) continue;
      if (seenErrors.has(sig)) work.repeatedErrors++;
      else seenErrors.add(sig);
    }
  }
  return work;
}

/** Every Bash and PowerShell command in the transcripts, in order: what a checker reads through Z0_COMMANDS. */
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
  return { ...base, ...fields, resolved, void: null, leak: false, invalid: null };
}
