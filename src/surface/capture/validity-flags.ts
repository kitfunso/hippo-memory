import type { DetectedRule } from '../../api/end-check.js';
import { flaggedRules, type Correction, type ValidityScan } from '../../api/validity.js';
import { detectorOf, flagTag, type Detector } from '../../base/memory/detect-tags.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { duplicateKey } from '../../base/util/same-text.js';
import { scanForValidity } from './end-check-scan.js';
import type { ExtractedItem } from './extract.js';
import type { FollowUpRule } from './follow-up.js';

export interface RuleFlagging {
  rules(): Promise<DetectedRule[]>;
  tag(ids: readonly string[], tag: string): Promise<void>;
}

export interface FlagSession {
  readonly dryRun: boolean;
  readonly global: boolean;
  readonly sessionId?: string;
  readonly transcriptPath?: string;
  readonly scriptedIsHuman?: boolean;
}

export interface PickedRule {
  readonly content: string;
  readonly turn: string;
  readonly turnFromEnd: number;
  readonly detector: Detector | null;
}

export function pickedRules(
  rules: readonly FollowUpRule[],
  followUps: readonly string[],
  stored: readonly ExtractedItem[],
  scrub: (text: string) => string,
): PickedRule[] {
  const detectors = new Map<string, Detector>();
  for (const item of stored) {
    const detector = detectorOf(item.tags);
    if (detector !== null) detectors.set(duplicateKey(item.content), detector);
  }
  return rules.flatMap(({ content, turnFromEnd }) => {
    const turn = followUps.at(-1 - turnFromEnd);
    if (turn === undefined) return [];
    const kept = scrub(content);
    const detector = detectors.get(duplicateKey(kept)) ?? null;
    return [{ content: kept, turn, turnFromEnd, detector }];
  });
}

function correctionsOf(picks: readonly PickedRule[], scan: ValidityScan): Correction[] {
  return picks.flatMap(({ content, turn, turnFromEnd, detector }) => {
    const prompt = scan.prompts.at(-1 - turnFromEnd);
    return prompt === undefined || prompt.text !== turn ? [] : [{ content, prompt, detector }];
  });
}

export async function flagFollowedRules(
  flagging: RuleFlagging | undefined,
  session: FlagSession,
  picks: readonly PickedRule[],
): Promise<void> {
  const { dryRun, global, sessionId, transcriptPath, scriptedIsHuman } = session;
  if (!flagging || dryRun || global || !sessionId || !transcriptPath || picks.length === 0) return;
  try {
    const rules = await flagging.rules();
    if (rules.length === 0) return;
    const scan = scanForValidity(transcriptPath, { scriptedIsHuman });
    const ids = flaggedRules(rules, correctionsOf(picks, scan), scan);
    if (ids.length > 0) await flagging.tag(ids, flagTag(sessionId));
  } catch (err) {
    log.warn(`validity flags skipped: ${errorMessage(err)}`, errorFields(err));
  }
}
