// A Claude Code style transcript built from the hook's real stdout, plus the fixture drivers the Z10 exit tests share.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import { expect } from 'vitest';
import type { JsonValue } from '../../src/util/json.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { blockHash } from '../../src/util/token-text.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../../src/core/memory.js';
import { reconstruct } from '../../scripts/z10-reconstruct.mjs';
import { hippo, promptPayload, PROMPT_HOOK, type Project, type RunOpts } from './delivery-boundary.js';

interface Json { [key: string]: JsonValue }

/** What the exit tests hand the reader beyond the store, session and memory. */
export interface ReadOpts {
  transcript?: string;
  labels?: Json[];
  global?: string | false;
}

export interface TurnVerdict {
  event_id: number | null;
  turn_seq: number | null;
  event_type: string | null;
  block_state: string | null;
  outcome: string | null;
  stage: string | null;
  cand_reason: string | null;
  pool: string | null;
  source_store: string | null;
  via_event_id: number | null;
  paired_by: string | null;
  duplicates: number[];
  stage_reached: string | null;
  range: string[] | null;
  why: string | null;
  delivery: string;
}

export interface Verdict {
  class: string;
  reason: string | null;
  store_hash: string;
  tenant_id: string;
  session_id: string;
  memory_id: string | null;
  memory_store: string | null;
  turn: { event_id: number; turn_seq: number | null } | null;
  stage: string | null;
  cand_reason: string | null;
  turns: TurnVerdict[];
  label: Json | null;
  notes: string[];
}

/** What a case's construction and raw rows say the verdict must be, field for field. */
export interface Oracle {
  class: string;
  reason: string | null;
  turn: { event_id: number; turn_seq: number | null } | null;
  stage: string | null;
}

/** The eight registered fields in one comparison, so no case can score fewer. */
export function expectVerdict(v: Verdict, want: Oracle & { store: string; session: string; memory: string | null; tenant?: string }): void {
  expect({
    class: v.class, reason: v.reason, store_hash: v.store_hash, tenant_id: v.tenant_id,
    session_id: v.session_id, turn: v.turn, stage: v.stage, memory_id: v.memory_id,
  }).toEqual({
    class: want.class, reason: want.reason, store_hash: blockHash(path.resolve(want.store)), tenant_id: want.tenant ?? 'default',
    session_id: want.session, turn: want.turn, stage: want.stage, memory_id: want.memory,
  });
}

export interface VerdictOpts extends ReadOpts {
  store: string;
  session: string;
  memory?: string;
  key?: string;
}

/** The reader's verdict, typed here because the script is plain JavaScript. */
export function verdictOf(opts: VerdictOpts): Verdict {
  // SAFETY: reconstruct returns exactly the verdict shape the script documents.
  return reconstruct({ global: false, ...opts }) as Verdict;
}

export interface TurnSpec {
  /** The text on the transcript's user line. */
  prompt: string;
  /** The hook's stdout; its additionalContext becomes the hippo attachment. */
  stdout?: string;
  /** Replaces the hippo attachment text; null withholds it. */
  attach?: string | null;
  /** False leaves the prompt without any attachment, as a hook that did not run. */
  fired?: boolean;
  /** Adds an image block, so the user content is an array. */
  image?: boolean;
  /** A compact_boundary line right before the prompt. */
  compactBefore?: boolean;
  /** Written as a queued_command attachment under tool results, the way a prompt sent mid-task is. */
  queued?: boolean;
}

export interface TranscriptOpts {
  name?: string;
  /** The per-file command, shell and notification lines, before the first prompt. Default true. */
  noise?: boolean;
}

const line = (value: Json): string => JSON.stringify(value);
const user = (content: string | Json[], extra: Json = {}): string => line({ type: 'user', message: { role: 'user', content }, ...extra });
const hookLine = (text: string, hookName = 'UserPromptSubmit'): string => line({
  type: 'attachment',
  attachment: { type: 'hook_additional_context', content: [text], hookName, toolUseID: `toolu_${hookName}`, hookEvent: 'UserPromptSubmit' },
});

export const additionalContextOf = (stdout: string): string => JSON.parse(stdout).hookSpecificOutput.additionalContext;

const toolResult = (id: string): string => user([{ type: 'tool_result', tool_use_id: id, content: 'out' }]);

/** A prompt sent while the agent was busy: Claude Code writes it as an attachment after the tool results, never as a user line. */
const queuedLines = (prompt: string): string[] => [
  line({ type: 'queue-operation', operation: 'enqueue', content: prompt }),
  toolResult('t1'),
  line({ type: 'queue-operation', operation: 'remove', content: prompt }),
  line({ type: 'attachment', attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true } }),
];

function turnLines(turn: TurnSpec): string[] {
  const content: string | Json[] = turn.image
    ? [{ type: 'text', text: turn.prompt }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]
    : turn.prompt;
  const out = [...(turn.compactBefore ? [line({ type: 'system', subtype: 'compact_boundary' })] : []), ...(turn.queued ? queuedLines(turn.prompt) : [user(content)])];
  if (turn.fired === false) return out;
  out.push(hookLine('decoy: another hook wrote this', 'DecoyHook'));
  const attach = turn.attach !== undefined ? turn.attach : turn.stdout ? additionalContextOf(turn.stdout) : null;
  if (attach !== null) out.push(hookLine(attach));
  out.push(user('<meta>caveat for the model</meta>', { isMeta: true }));
  return out;
}

const NOISE = [
  user('<command-name>/clear</command-name>'),
  user('<local-command-stdout>cleared</local-command-stdout>'),
  user('<bash-input>ls</bash-input>'),
  user('<bash-stdout>a b</bash-stdout>'),
  user('<task-notification>background task done</task-notification>'),
];

/** Writes the transcript under the project's scratch folder and returns its path. */
export function writeHostTranscript(p: Project, turns: TurnSpec[], opts: TranscriptOpts = {}): string {
  const file = path.join(p.dir, `${opts.name ?? 'host'}.jsonl`);
  const lines = [...(opts.noise === false ? [] : NOISE), ...turns.flatMap(turnLines)];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

export interface Config {
  promptRecall?: boolean;
  promptRecallThreshold?: number;
  promptRecallMinShared?: number;
  promptRecallMaxItems?: number;
  holdout?: boolean;
}

/** Rewrites the project's config, the way the hook tests do, with the ledger on. */
export function configure(p: Project, cfg: Config = {}): void {
  const { holdout, ...inject } = cfg;
  const config: Json = {
    deliveryLedger: { enabled: true },
    pinnedInject: { promptRecall: false, promptRecallThreshold: 0.1, promptRecallMinShared: 1, ...inject },
  };
  if (holdout) config.pilot = { holdoutRateBp: 10_000 };
  fs.writeFileSync(path.join(p.hippoRoot, 'config.json'), JSON.stringify(config));
}

/** One memory written in-process; pass `created` where row order matters, since same-millisecond rows fall back to random ids. */
export function seed(root: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const entry = { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), ...extra };
  writeEntry(root, entry);
  return entry;
}

/** One per-prompt hook call; the run must exit 0. */
export function fire(p: Project, sessionId: string, prompt: string, opts: RunOpts & { args?: string[] } = {}): SpawnSyncReturns<string> {
  const { args = PROMPT_HOOK, ...run } = opts;
  const r = hippo(p, args, { ...run, input: promptPayload(sessionId, prompt) });
  expect(r.status).toBe(0);
  return r;
}
