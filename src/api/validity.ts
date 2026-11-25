import { MAX_FLAGS, type Detector } from '../base/memory/detect-tags.js';
import {
  corrects,
  done,
  ranCommand,
  ranProgram,
  type CorrectionText,
  type DetectedRule,
  type EndCheckScan,
} from './end-check.js';

export interface ScanPrompt {
  readonly seq: number;
  readonly at: number;
  readonly text: string;
}

export interface ValidityScan {
  readonly prompts: readonly ScanPrompt[];
  before(prompt: ScanPrompt): EndCheckScan;
}

export interface Correction extends CorrectionText {
  readonly prompt: ScanPrompt;
}

function groupBroken(group: readonly string[], commands: readonly string[]): boolean {
  const does = (ran: string): boolean => group.some((command) => ranCommand(ran, command));
  const first = commands.findIndex(does);
  return (
    first >= 0 &&
    commands
      .slice(first + 1)
      .some((ran) => !does(ran) && group.some((command) => ranProgram(ran, command)))
  );
}

export function brokeAfterDone(detector: Detector, scan: EndCheckScan): boolean {
  return detector.commands.some((group) => groupBroken(group, scan.commands));
}

function flagsRule(rule: DetectedRule, correction: Correction, scan: ValidityScan): boolean {
  if (!(Date.parse(rule.created) < correction.prompt.at) || !corrects(correction, rule)) {
    return false;
  }
  const before = scan.before(correction.prompt);
  return done(rule.detector, before) && brokeAfterDone(rule.detector, before);
}

export function flaggedRules(
  rules: readonly DetectedRule[],
  corrections: readonly Correction[],
  scan: ValidityScan,
): string[] {
  return rules
    .filter((rule) => rule.flags < MAX_FLAGS)
    .filter((rule) => corrections.some((correction) => flagsRule(rule, correction, scan)))
    .map((rule) => rule.id);
}
