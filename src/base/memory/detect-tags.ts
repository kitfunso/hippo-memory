import { tryParseJson } from '../util/json.js';

export const DETECT_TAG_PREFIX = 'detect:';
const APPLIES_PREFIX = `${DETECT_TAG_PREFIX}applies:`;
const COMMAND_PREFIX = `${DETECT_TAG_PREFIX}cmd:`;

export interface Detector {
  readonly applies: readonly string[];
  readonly commands: readonly (readonly string[])[];
}

export function isDetectTag(tag: string): boolean {
  return tag.startsWith(DETECT_TAG_PREFIX);
}

export function withoutDetectTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => !isDetectTag(tag));
}

export function detectorTags(detector: Detector): string[] {
  const groups = detector.commands.filter((group) => group.length > 0);
  if (groups.length === 0) return [];
  return [
    ...detector.applies.map((glob) => `${APPLIES_PREFIX}${glob}`),
    ...groups.map((group) => `${COMMAND_PREFIX}${JSON.stringify(group)}`),
  ];
}

function commandGroup(text: string): string[] | null {
  const parsed = tryParseJson(text);
  if (!Array.isArray(parsed)) return null;
  const commands = parsed.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
  return commands.length > 0 ? commands : null;
}

export function detectorOf(tags: readonly string[]): Detector | null {
  const commands = tags
    .filter((tag) => tag.startsWith(COMMAND_PREFIX))
    .map((tag) => commandGroup(tag.slice(COMMAND_PREFIX.length)))
    .filter((group): group is string[] => group !== null);
  if (commands.length === 0) return null;
  const applies = tags
    .filter((tag) => tag.startsWith(APPLIES_PREFIX))
    .map((tag) => tag.slice(APPLIES_PREFIX.length))
    .filter((glob) => glob !== '');
  return { applies, commands };
}
