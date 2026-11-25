import type { Detector } from '../base/memory/detect-tags.js';
import { duplicateKey } from '../base/util/same-text.js';

export const END_CHECK_MAX_RULES = 3;
export const END_CHECK_LEAD =
  'Before you finish: the person gave these rules in this project, and this session shows no sign of them.';

export interface EndCheckScan {
  readonly editsSincePrompt: readonly string[];
  readonly editedSincePrompt: boolean;
  readonly commands: readonly string[];
  readonly earlierChecks: string;
}

export interface DetectedRule {
  readonly id: string;
  readonly content: string;
  readonly created: string;
  readonly detector: Detector;
  readonly flags: number;
}

export interface CorrectionText {
  readonly content: string;
  readonly detector: Detector | null;
}

const RUNNERS =
  'sudo|time|env|npx|bunx|yarn|uv run|poetry run|pipenv run|pnpm exec|pnpm dlx|python3? -m|py -m';
const RUNNER_PREFIX = new RegExp(`^(?:\\w+=\\S*\\s+|(?:${RUNNERS})\\s+)`);
const SEGMENT_SPLIT = /&&|\|\||;|\||\n/;
const GROUPING = /[(){}]/g;
const PATH_WORD = /^[\w.@~/\\:-]*\w\.[a-z0-9]{1,8}$/i;
const BASH_WRITE =
  /(?:^|[\s;&|])(?:sed\s+-i|tee|mv|cp|rm|touch|patch|git\s+apply)\b|(?:^|[^\d&>])>>?\s*(?!\/dev\/null\b|&)[^\s|&;]+/;
const CURLY_QUOTES = /[\u2018\u2019\u201c\u201d]/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

export function commandKey(command: string): string {
  return command.replace(/['"`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isBashWrite(command: string): boolean {
  return BASH_WRITE.test(command);
}

export function bashWritePaths(command: string): string[] {
  return command
    .split(SEGMENT_SPLIT)
    .filter(isBashWrite)
    .flatMap((segment) => segment.split(/[\s'"`<>]+/).filter((word) => PATH_WORD.test(word)));
}

function wordsOf(text: string): string[] {
  const key = commandKey(text.replace(GROUPING, ' '));
  return key === '' ? [] : key.split(' ');
}

function runnerForms(segment: string): string[][] {
  const forms: string[][] = [];
  let rest = wordsOf(segment).join(' ');
  for (;;) {
    if (rest !== '') forms.push(rest.split(' '));
    const next = rest.replace(RUNNER_PREFIX, '');
    if (next === rest) return forms;
    rest = next;
  }
}

function sameWord(ran: string, wanted: string): boolean {
  return ran === wanted || ran.startsWith(`${wanted}=`);
}

function hasInOrder(ran: readonly string[], wanted: readonly string[]): boolean {
  if (ran.length === 0 || !sameWord(ran[0], wanted[0])) return false;
  let found = 1;
  for (const word of ran.slice(1)) {
    if (found < wanted.length && sameWord(word, wanted[found])) found += 1;
  }
  return found === wanted.length;
}

export function ranCommand(ran: string, command: string): boolean {
  const wanted = wordsOf(command);
  if (wanted.length === 0) return false;
  return ran
    .split(SEGMENT_SPLIT)
    .some((segment) => runnerForms(segment).some((form) => hasInOrder(form, wanted)));
}

export function ranProgram(ran: string, command: string): boolean {
  const program = runnerForms(command).at(-1)?.[0];
  if (program === undefined) return false;
  return ran
    .split(SEGMENT_SPLIT)
    .some((segment) => runnerForms(segment).some((form) => sameWord(form[0], program)));
}

function proseWords(text: string): string[] {
  return wordsOf(text.replace(CURLY_QUOTES, ''))
    .map((word) => word.replace(TRAILING_PUNCTUATION, ''))
    .filter((word) => word !== '');
}

export function mentionsCommand(text: string, command: string): boolean {
  const said = proseWords(text);
  const wanted = proseWords(command);
  if (wanted.length === 0) return false;
  return said.some((_, i) => hasInOrder(said.slice(i), wanted));
}

export function corrects(correction: CorrectionText, rule: DetectedRule): boolean {
  if (duplicateKey(correction.content) === duplicateKey(rule.content)) return true;
  const own = correction.detector?.commands.flat() ?? [];
  return rule.detector.commands
    .flat()
    .some(
      (command) =>
        mentionsCommand(correction.content, command) || own.some((ran) => ranCommand(ran, command)),
    );
}

function globPattern(glob: string): RegExp {
  const body = glob
    .toLowerCase()
    .replace(/^\/+/, '')
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`(?:^|/)${body}$`);
}

export function globMatch(glob: string, filePath: string): boolean {
  return globPattern(glob).test(filePath);
}

function globHits(rule: DetectedRule, scan: EndCheckScan): number {
  return scan.editsSincePrompt.filter((p) => rule.detector.applies.some((g) => globMatch(g, p)))
    .length;
}

export function applies(detector: Detector, scan: EndCheckScan): boolean {
  if (!scan.editedSincePrompt) return false;
  if (detector.applies.length === 0) return true;
  return detector.applies.some((glob) => scan.editsSincePrompt.some((p) => globMatch(glob, p)));
}

export function done(detector: Detector, scan: EndCheckScan): boolean {
  return detector.commands.every((group) =>
    group.some((command) => scan.commands.some((ran) => ranCommand(ran, command))),
  );
}

export function openRules(
  rules: readonly DetectedRule[],
  scan: EndCheckScan,
  max: number,
): DetectedRule[] {
  return rules
    .filter((rule) => !scan.earlierChecks.includes(rule.content))
    .filter((rule) => applies(rule.detector, scan) && !done(rule.detector, scan))
    .sort((a, b) => globHits(b, scan) - globHits(a, scan) || b.created.localeCompare(a.created))
    .slice(0, max);
}

export function endCheckText(open: readonly DetectedRule[]): string {
  const lines = open.map((rule, i) => `${i + 1}. ${rule.content}`);
  return [END_CHECK_LEAD, 'Do each one that applies to your change.', '', ...lines].join('\n');
}

export function stopContext(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text } });
}
