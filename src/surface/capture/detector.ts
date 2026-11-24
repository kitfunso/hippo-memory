import type { Detector } from '../../base/memory/detect-tags.js';
import type { Llm, LlmUsage } from '../../base/ports/llm.js';
import {
  isJsonNumber,
  isJsonObject,
  isJsonString,
  tryParseJson,
  type JsonValue,
} from '../../base/util/json.js';
import type { LineLog } from '../../base/util/log.js';
import { askModel, MODEL } from './follow-up.js';
import { scrubForSharing } from './share-scrub.js';

const MAX_GLOBS = 5;
const MAX_GROUPS = 4;
const MAX_ALTERNATES = 4;
const MAX_CHARS = 120;
const PROHIBITION_LEAD = /^\W*(?:no:\s*)?(?:never|don['’]t|do not|avoid)\b/i;

export const DETECTOR_PROMPT = [
  'Each rule below was given by a person to a coding agent.',
  'If following a rule means running a command, give the commands a later session must run to follow it.',
  'Return only JSON: [{"i": <rule number>, "applies": [<file globs>], "commands": [[<alternates>], ...]}] ' +
    'for rules that a command shows; leave other rules out.',
  'applies lists globs of edited files that make the rule relevant, like "**/*.py"; ' +
    'use [] when any code change makes it relevant.',
  'Each inner list of commands is one command the agent must run; its items are other common ways ' +
    'to run that same command, like ["npm test", "npm run test"].',
  'Give the shortest stable part of each command, with no quotes and no file arguments.',
  'Leave out rules that a command cannot show: style, naming, prohibitions, doc or changelog edits, ' +
    'and rules with a condition you cannot see in file paths.',
  '',
  '',
].join('\n');

function promptOf(rules: readonly string[]): string {
  const lines = rules.map((rule, i) => `<r i="${i}">${rule.replace(/\s+/g, ' ').trim()}</r>\n`);
  return DETECTOR_PROMPT + lines.join('');
}

function isProhibition(rule: string): boolean {
  return PROHIBITION_LEAD.test(rule);
}

interface Found {
  readonly i: number;
  readonly detector: Detector;
}

function stringsOf(value: JsonValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null;
  const kept: string[] = [];
  for (const entry of value) {
    if (!isJsonString(entry)) return null;
    const text = scrubForSharing(entry.trim()).trim();
    if (text !== '' && text.length <= MAX_CHARS) kept.push(text);
  }
  return kept;
}

function foundOf(item: JsonValue): Found | null {
  if (!isJsonObject(item) || !isJsonNumber(item.i) || !Number.isInteger(item.i)) return null;
  const applies = stringsOf(item.applies);
  const groups = Array.isArray(item.commands) ? item.commands.map(stringsOf) : null;
  if (applies === null || groups === null) return null;
  const commands: string[][] = [];
  for (const group of groups) {
    if (group === null) return null;
    if (group.length > 0) commands.push(group.slice(0, MAX_ALTERNATES));
  }
  if (commands.length === 0) return null;
  return {
    i: item.i,
    detector: { applies: applies.slice(0, MAX_GLOBS), commands: commands.slice(0, MAX_GROUPS) },
  };
}

function readFound(text: string): { found: readonly Found[] } | { problem: string } {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return { problem: 'the reply held no JSON list' };
  const parsed = tryParseJson(text.slice(start, end + 1));
  if (parsed === undefined) return { problem: 'the reply held a JSON list that does not parse' };
  if (!Array.isArray(parsed)) return { problem: 'the reply was not a JSON list' };
  return { found: parsed.flatMap((item) => foundOf(item) ?? []) };
}

function detectorsOf(rules: readonly string[], found: readonly Found[]): (Detector | null)[] {
  const first = new Map<number, Detector>();
  for (const { i, detector } of found) if (!first.has(i)) first.set(i, detector);
  return rules.map((rule, i) => (isProhibition(rule) ? null : (first.get(i) ?? null)));
}

export interface RuleDetectors {
  readonly detectors: (Detector | null)[];
  readonly usage: LlmUsage | undefined;
}

export async function ruleDetectors(
  rules: readonly string[],
  llm: Llm,
  log: LineLog,
): Promise<RuleDetectors> {
  const none = rules.map(() => null);
  if (rules.length === 0) return { detectors: none, usage: undefined };
  const { text, usage } = await askModel(llm, promptOf(rules), log, 'rule detectors');
  if (text === null) return { detectors: none, usage };
  const read = readFound(text);
  if ('problem' in read) {
    log(`rule detectors skipped: ${read.problem}`);
    return { detectors: none, usage };
  }
  return { detectors: detectorsOf(rules, read.found), usage };
}

export function detectorUsageLine(usage: LlmUsage, endpointModel?: string): string {
  const model = endpointModel ?? MODEL;
  return `rule detectors: model=${model} input_tokens=${usage.inputTokens} output_tokens=${usage.outputTokens}`;
}
