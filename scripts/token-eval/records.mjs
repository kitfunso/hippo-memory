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

/** Tool calls, file reads (Read, Grep and shell reads; `shellReads` is the shell share) and repeated error signatures; all null with no transcript. */
export function transcriptWork(file, seenErrors) {
  if (!file) return { toolCalls: null, fileReads: null, shellReads: null, repeatedErrors: null };
  const work = { toolCalls: 0, fileReads: 0, shellReads: 0, repeatedErrors: 0 };
  const seenTools = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const block of content) {
      if (block.type === 'tool_use' && !seenTools.has(block.id)) {
        seenTools.add(block.id);
        work.toolCalls++;
        if (block.name === 'Read' || block.name === 'Grep') work.fileReads++;
        else if (SHELL_TOOLS.has(block.name) && isShellRead(block.name, block.input?.command)) {
          work.fileReads++;
          work.shellReads++;
        }
      } else if (block.type === 'tool_result' && block.is_error) {
        const text = Array.isArray(block.content) ? block.content.map((c) => c.text ?? '').join(' ') : String(block.content ?? '');
        const sig = text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
        if (!sig) continue;
        if (seenErrors.has(sig)) work.repeatedErrors++;
        else seenErrors.add(sig);
      }
    }
  }
  return work;
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

/** A step whose session never ran (a failed setup, or a leak known beforehand): nothing graded, every session metric null. */
export function skippedRecord(base, fields) {
  return {
    ...base, resolved: false, usage: null, costUsd: null, turns: null, ...transcriptWork(null),
    sessionId: null, transcriptFound: false, hippo: null, limitRetries: 0, ...fields,
  };
}
