/**
 * `hippo capture-error`: turn a failed tool call into an error memory. Run by
 * the Claude Code `PostToolUseFailure` hook (both `hippo hook install
 * claude-code` and the plugin), which writes the failure as JSON on stdin.
 *
 * Most failed tool calls are not lessons. An interrupt, a permission the
 * user declined, a search that found nothing or a `grep` that exits 1 is
 * routine, and error memories decay slower than other memories, so storing
 * them would crowd out real lessons. Those are dropped here, repeats of the
 * same failure are stored once, and what is stored is marked `observed`
 * (auto-captured, not verified): outcome feedback, not capture, is what
 * should strengthen it.
 */
import { createMemory, type MemoryEntry } from './memory.js';
import { writeEntry, loadAllEntries } from './store.js';
import { loadConfig } from './config.js';
import type { JsonValue } from './working-memory.js';

/** Why a failure was not stored, or `stored`. */
export type CaptureErrorOutcome = 'stored' | 'duplicate' | 'skipped-interrupt' | 'skipped-routine' | 'skipped-invalid';

/** The PostToolUseFailure payload fields this module reads. */
interface ToolFailurePayload {
  tool_name?: JsonValue;
  error?: JsonValue;
  is_interrupt?: JsonValue;
  tool_input?: JsonValue;
}

const MAX_LEN = 200;

/** Failures that are routine, not lessons. */
const ROUTINE_PATTERNS: RegExp[] = [
  /user (?:doesn't|does not) want|denied by (?:the )?user|user (?:rejected|declined|denied)|permission (?:denied|to use)|was blocked by (?:a )?hook/i,
  /\bno (?:matches|files|results) found\b/i,
];

/** Shell commands whose exit code 1 means "nothing found" or "differs", not an error. */
const QUIET_EXIT_1 = /^\s*(?:grep|rg|egrep|fgrep|find|test|\[|diff|cmp|git diff|git grep)\b/;

function isString(v: JsonValue | undefined): v is string {
  return v !== undefined && v !== null && v.constructor === String;
}

function isObject(v: JsonValue | undefined): v is { [key: string]: JsonValue } {
  return v !== undefined && v !== null && !Array.isArray(v) && v.constructor === Object;
}

/** Normalised form used to spot repeats of the same failure. */
export function failureSignature(text: string): string {
  return text.toLowerCase().replace(/[0-9a-f]{7,}/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * The memory text for a failure payload, or the reason it is not stored.
 * Pure: no store access.
 */
export function lessonFromFailure(payload: JsonValue): { text: string } | { skip: Exclude<CaptureErrorOutcome, 'stored' | 'duplicate'> } {
  if (!isObject(payload)) return { skip: 'skipped-invalid' };
  // SAFETY: isObject narrowed payload to a plain JSON object; the fields read are all optional.
  const p = payload as ToolFailurePayload;
  if (p.is_interrupt === true) return { skip: 'skipped-interrupt' };
  if (!isString(p.error) || p.error.trim().length < 12) return { skip: 'skipped-invalid' };
  const tool = isString(p.tool_name) ? p.tool_name : 'tool';
  const error = p.error.replace(/\s+/g, ' ').trim();
  if (ROUTINE_PATTERNS.some((re) => re.test(error))) return { skip: 'skipped-routine' };
  if (tool === 'Grep' || tool === 'Glob') return { skip: 'skipped-routine' };
  if (tool === 'Bash' && isObject(p.tool_input) && isString(p.tool_input['command'])
    && QUIET_EXIT_1.test(p.tool_input['command']) && /exit code 1\b/i.test(error)) {
    return { skip: 'skipped-routine' };
  }
  return { text: `${tool}: ${error}`.slice(0, MAX_LEN) };
}

/**
 * Store a failure payload as an error memory unless it is routine or a
 * repeat of an auto-captured error already in the store.
 */
export function captureToolFailure(hippoRoot: string, tenantId: string, payload: JsonValue): CaptureErrorOutcome {
  const lesson = lessonFromFailure(payload);
  if ('skip' in lesson) return lesson.skip;
  const sig = failureSignature(lesson.text);
  const repeat = loadAllEntries(hippoRoot, tenantId).some(
    (e: MemoryEntry) => e.tags.includes('auto-captured') && failureSignature(e.content) === sig,
  );
  if (repeat) return 'duplicate';
  const entry = createMemory(lesson.text, {
    tags: ['error', 'auto-captured'],
    source: 'tool-failure',
    confidence: 'observed',
    tenantId,
    baseHalfLifeDays: loadConfig(hippoRoot).defaultHalfLifeDays,
  });
  writeEntry(hippoRoot, entry);
  return 'stored';
}
