import type { Detector } from '../base/memory/detect-tags.js';

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
}

const RUNNERS = 'sudo|time|env|npx|bunx|yarn|uv run|poetry run|pipenv run|pnpm exec|pnpm dlx|python3? -m|py -m';
const RUNNER_PREFIX = new RegExp(`^(?:\\w+=\\S*\\s+|(?:${RUNNERS})\\s+)`);
const SEGMENT_SPLIT = /&&|\|\||;|\||\n/;
const BASH_WRITE =
  /(?:^|[\s;&|])(?:sed\s+-i|tee|mv|cp|rm|touch|patch|git\s+apply)\b|(?:^|[^\d&>])>>?\s*(?!\/dev\/null\b|&)[^\s|&;]+/;

export function commandKey(command: string): string {
  return command.replace(/['"`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isBashWrite(command: string): boolean {
  return BASH_WRITE.test(command);
}

function withoutRunners(segment: string): string {
  let rest = segment.trim();
  let next = rest.replace(RUNNER_PREFIX, '');
  while (next !== rest) {
    rest = next;
    next = rest.replace(RUNNER_PREFIX, '');
  }
  return rest;
}

export function startsSegment(ran: string, key: string): boolean {
  if (key === '') return false;
  const bare = withoutRunners(key);
  return ran.split(SEGMENT_SPLIT).some((segment) => {
    const head = withoutRunners(segment);
    return head.startsWith(bare) && (head.length === bare.length || head[bare.length] === ' ');
  });
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
  return scan.editsSincePrompt.filter((p) => rule.detector.applies.some((g) => globMatch(g, p))).length;
}

export function applies(detector: Detector, scan: EndCheckScan): boolean {
  if (!scan.editedSincePrompt) return false;
  if (detector.applies.length === 0) return true;
  return detector.applies.some((glob) => scan.editsSincePrompt.some((p) => globMatch(glob, p)));
}

export function done(detector: Detector, scan: EndCheckScan): boolean {
  return detector.commands.every((group) =>
    group.some((command) => scan.commands.some((ran) => startsSegment(ran, commandKey(command)))),
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
