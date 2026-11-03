// Follow-up rules: a model picks which sentences of the person's later turns state a lasting rule,
// by number only, so capture stores the person's own words.
import {
  describeLlmFailure,
  llmFailureFields,
  type Llm,
  type LlmReply,
  type LlmUsage,
} from '../../base/ports/llm.js';
import { isJsonObject, tryParseJson, type JsonValue } from '../../base/util/json.js';
import { errorFields, errorMessage, type LineLog } from '../../base/util/log.js';
import { duplicateKey } from '../../base/util/same-text.js';
import { pickedText, statedSentences, statedText, type ExtractedItem } from './extract.js';
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

const LOG_LEAD =
  /^(?:\d{4}-\d\d-\d\d|\[\d|at [\w$.<>]+ ?\(|(?:[A-Za-z]:)?[^\s:]*[/\\.][^\s:]*:\d+|\$ |> )/;

/** A line of program output, not prose: the lead of a log, trace or prompt line, or few letters
 * unless the sentence above is still open, as before a numeric condition. */
function isLogLine(line: string, sentenceOpen: boolean): boolean {
  if (LOG_LEAD.test(line.trimStart())) return true;
  const marks = line.replace(/\s/g, '');
  const letters = marks.match(/\p{L}/gu)?.length ?? 0;
  return !sentenceOpen && letters < 0.4 * marks.length;
}

/** One turn's numbered sentences, as a pattern reads them, scrubbed for sharing. */
function sentencesOf(turn: string): string[] {
  // Scrubbed again after: removing bold can rebuild an address or key the first pass could not see.
  const sentences = statedSentences(scrubForSharing(turn), isLogLine)
    .map(scrubForSharing)
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

/** A rule the model picked, and the whole sentences it came from. */
export interface FollowUpRule extends ExtractedItem {
  readonly sentences: readonly string[];
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
function rulesOf(turns: readonly (readonly string[])[], picks: readonly Pick[]): FollowUpRule[] {
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
      const sentences = ids.map((j) => turns[i][j]);
      const content = pickedText(sentences);
      // It prints as the person's order, so text shaped like an injected instruction never becomes one.
      if (content === null || detectInstruction(content).flagged) return [];
      return [{ content, category: 'rule', tags: ['follow-up'], fromUser: true, sentences }];
    });
}

interface Asked {
  readonly text: string | null;
  readonly usage: LlmUsage | undefined;
}

async function ask(llm: Llm, prompt: string, log: LineLog): Promise<Asked> {
  const signal = AbortSignal.timeout(CALL_MS);
  let reply: LlmReply;
  try {
    reply = await llm.send({ model: MODEL, maxTokens: MAX_TOKENS, prompt, signal });
  } catch (err) {
    // The port never throws, but capture must outlive an adapter that does.
    log(`follow-up rules skipped: the model call threw: ${errorMessage(err)}`, {
      fields: errorFields(err),
    });
    return { text: null, usage: undefined };
  }
  if (reply.ok) return { text: reply.text, usage: reply.usage };
  const cause = signal.aborted
    ? `the model call passed ${CALL_MS / 1000} s`
    : describeLlmFailure(reply.failure);
  log(`follow-up rules skipped: ${cause}`, { fields: llmFailureFields(reply.failure) });
  return { text: null, usage: reply.usage };
}

export interface FollowUpRules {
  readonly rules: FollowUpRule[];
  /** What the model call was billed; undefined when no call ran or the reply named none. */
  readonly usage: LlmUsage | undefined;
}

/** The rules the model finds in the person's turns after the session's first, the last 20 of
 * them; a failed call or an unreadable reply logs one line and gives none. Never throws. */
export async function followUpRules(
  turns: readonly string[],
  llm: Llm,
  log: LineLog,
): Promise<FollowUpRules> {
  const messages = turns.slice(-FOLLOW_UP_TURNS).map(sentencesOf);
  if (messages.every((sentences) => sentences.length === 0)) return { rules: [], usage: undefined };
  const { text, usage } = await ask(llm, promptOf(messages), log);
  if (text === null) return { rules: [], usage };
  const read = readPicks(text);
  if ('problem' in read) {
    log(`follow-up rules skipped: ${read.problem}`);
    return { rules: [], usage };
  }
  return { rules: rulesOf(messages, read.picks), usage };
}

/** One line per model call, in key=value form, so a harness can price it from the capture log. */
export function usageLine(usage: LlmUsage): string {
  return `follow-up rules: model=${MODEL} input_tokens=${usage.inputTokens} output_tokens=${usage.outputTokens}`;
}

/** The pattern items but each one that is a whole sentence of a rule, then the rules; both read
 * after `scrub`, so the comparison sees what is stored. */
export function withFollowUpRules(
  items: readonly ExtractedItem[],
  rules: readonly FollowUpRule[],
  scrub: (text: string) => string,
): ExtractedItem[] {
  const keyOf = (text: string): string => duplicateKey(scrub(text));
  const held = new Set(rules.flatMap((rule) => rule.sentences.map((s) => keyOf(statedText(s)))));
  return [...items.filter((item) => !held.has(keyOf(item.content))), ...rules];
}
