// Follow-up rules: a model picks which sentences of the person's later turns state a lasting rule,
// by number only, so capture stores the person's own words.
import {
  describeLlmFailure,
  llmFailureFields,
  type Llm,
  type LlmReply,
} from '../../base/ports/llm.js';
import { isJsonObject, tryParseJson, type JsonValue } from '../../base/util/json.js';
import { errorFields, errorMessage, type LineLog } from '../../base/util/log.js';
import { duplicateKey } from '../../base/util/same-text.js';
import { pickedText, proseOnly, type ExtractedItem } from './extract.js';
import { scrubForSharing } from './share-scrub.js';
import { detectInstruction } from '../../api/instruction-detect.js';

const FOLLOW_UP_TURNS = 20;
const TURN_CHARS = 1000;
// The prompt was measured on this model; the adapter's default picked task orders as rules (gate 2).
const MODEL = 'claude-sonnet-5-5';
// Adaptive thinking spends from the same cap as the reply.
const MAX_TOKENS = 4096;
// One attempt: the session-end cursor moves only when capture returns, so a hung call must not hold it.
const CALL_MS = 20_000;

// The prompt the held-out study measured, word for word.
const FROZEN_PROMPT = [
  'Each message below was typed by a person to a coding agent, after the first message of a session.',
  'Mark a message lasting if any part of it states something the agent must still follow in a LATER session:',
  'a way to work, something to always or never do, or a standing fact or requirement about the project ' +
    'or its output.',
  'A rule counts even when it sits inside a complaint, a correction or a task request.',
  'Mark it not lasting when it only asks for, checks on, approves or questions the current task.',
  'Each message is split into numbered sentences. Return only JSON: ' +
    '[{"i": <message number>, "s": [<numbers of the sentences that state the lasting rule>]}] ' +
    'for messages with a lasting rule; leave other messages out.',
  '',
  '',
].join('\n');

// Pasted text is not the person's own; an unclosed block runs to the end.
const PASTED_BLOCK = /<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content>|$)/g;
const LOG_LEAD =
  /^(?:\d{4}-\d\d-\d\d|\[\d|at [\w$.<>]+ ?\(|(?:[A-Za-z]:)?[^\s:]*[/\\.][^\s:]*:\d+|\$ |> )/;
const SENTENCE_BREAK = /(?<=[.!?])\s+|\n+/;

/** A line of program output, not prose: few letters, or the lead of a log, trace or prompt line. */
function isLogLine(line: string): boolean {
  const marks = line.replace(/\s/g, '');
  const letters = marks.match(/\p{L}/gu)?.length ?? 0;
  return letters < 0.4 * marks.length || LOG_LEAD.test(line.trimStart());
}

/** One turn's numbered sentences, split as the study split them, after the scrub for sharing. */
function sentencesOf(turn: string): string[] {
  // One pass, so a dropped log line also ends the paragraph its indented continuation would join.
  const text = scrubForSharing(proseOnly(turn.replace(PASTED_BLOCK, ' '), isLogLine));
  const sentences = text
    .split(SENTENCE_BREAK)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= 3);
  // Whole sentences only: a sentence the limit cuts could lose its condition and still read as a rule.
  const whole: string[] = [];
  let used = 0;
  for (const sentence of sentences) {
    used += sentence.length + 1;
    if (used > TURN_CHARS + 1) break;
    whole.push(sentence);
  }
  return whole;
}

function promptOf(turns: readonly (readonly string[])[]): string {
  const messages = turns.map((sentences, i) => {
    const numbered = sentences.map((sentence, j) => `<s n="${j}">${sentence}</s>`).join('');
    return `<m i="${i}">${numbered}</m>\n`;
  });
  return FROZEN_PROMPT + messages.join('');
}

interface Pick {
  readonly i: number;
  readonly s: readonly number[];
}

function isPick(value: JsonValue): value is { i: number; s: number[] } {
  return (
    isJsonObject(value) &&
    Number.isInteger(value.i) &&
    Array.isArray(value.s) &&
    value.s.every((n) => Number.isInteger(n))
  );
}

/** The reply's picks, or why it holds none that can be read. */
function readPicks(text: string): { picks: readonly Pick[] } | { problem: string } {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return { problem: 'the reply held no JSON list' };
  const parsed = tryParseJson(text.slice(start, end + 1));
  if (parsed === undefined) return { problem: 'the reply held a JSON list that does not parse' };
  if (!Array.isArray(parsed) || !parsed.every(isPick)) {
    return { problem: 'the reply was not a list of {"i", "s"} picks' };
  }
  return { picks: parsed };
}

/** One rule per turn with picks: its picked sentences in turn order; an id out of range is dropped. */
function rulesOf(turns: readonly (readonly string[])[], picks: readonly Pick[]): ExtractedItem[] {
  const chosen = new Map<number, Set<number>>();
  for (const { i, s } of picks) {
    const sentences = turns[i];
    if (sentences === undefined) continue;
    const ids = chosen.get(i) ?? new Set<number>();
    for (const j of s) if (j >= 0 && j < sentences.length) ids.add(j);
    chosen.set(i, ids);
  }
  return [...chosen.keys()]
    .sort((a, b) => a - b)
    .flatMap((i) => {
      const ids = [...(chosen.get(i) ?? [])].sort((a, b) => a - b);
      const content = pickedText(ids.map((j) => turns[i][j]));
      // It prints as the person's order, so text shaped like an injected instruction never becomes one.
      if (content === null || detectInstruction(content).flagged) return [];
      return [{ content, category: 'rule', tags: ['follow-up', 'from-user'], fromUser: true }];
    });
}

async function ask(llm: Llm, prompt: string, log: LineLog): Promise<string | null> {
  const signal = AbortSignal.timeout(CALL_MS);
  let reply: LlmReply;
  try {
    reply = await llm.send({ model: MODEL, maxTokens: MAX_TOKENS, prompt, signal });
  } catch (err) {
    // The port never throws, but capture must outlive an adapter that does.
    log(`follow-up rules skipped: the model call threw: ${errorMessage(err)}`, {
      fields: errorFields(err),
    });
    return null;
  }
  if (reply.ok) return reply.text;
  const cause = signal.aborted
    ? `the model call passed ${CALL_MS / 1000} s`
    : describeLlmFailure(reply.failure);
  log(`follow-up rules skipped: ${cause}`, { fields: llmFailureFields(reply.failure) });
  return null;
}

/** The rules the model finds in the person's turns after the session's first, the last 20 of
 * them; a failed call or an unreadable reply logs one line and gives none. Never throws. */
export async function followUpRules(
  turns: readonly string[],
  llm: Llm,
  log: LineLog,
): Promise<ExtractedItem[]> {
  const messages = turns.slice(-FOLLOW_UP_TURNS).map(sentencesOf);
  if (messages.every((sentences) => sentences.length === 0)) return [];
  const text = await ask(llm, promptOf(messages), log);
  if (text === null) return [];
  const read = readPicks(text);
  if ('problem' in read) {
    log(`follow-up rules skipped: ${read.problem}`);
    return [];
  }
  return rulesOf(messages, read.picks);
}

/** The pattern items but each one a rule holds, then the rules; both read after `scrub`, so the
 * comparison sees what is stored. */
export function withFollowUpRules(
  items: readonly ExtractedItem[],
  rules: readonly ExtractedItem[],
  scrub: (text: string) => string,
): ExtractedItem[] {
  const held = rules.map((rule) => duplicateKey(scrub(rule.content)));
  const kept = items.filter((item) => {
    const key = duplicateKey(scrub(item.content));
    return !held.some((rule) => rule.includes(key));
  });
  return [...kept, ...rules];
}
