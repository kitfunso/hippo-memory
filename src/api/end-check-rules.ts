import { detectorOf, flagCount } from '../base/memory/detect-tags.js';
import { userRulesRead, type UserRulesOptions } from './context/user-rules-get.js';
import type { DetectedRule } from './end-check.js';
import type { Context } from './types.js';

export async function detectedRules(ctx: Context, opts: UserRulesOptions): Promise<DetectedRule[]> {
  const rules: DetectedRule[] = [];
  for (const e of await userRulesRead(ctx, opts)) {
    const detector = detectorOf(e.tags);
    if (detector !== null) {
      rules.push({
        id: e.id,
        content: e.content,
        created: e.created,
        detector,
        flags: flagCount(e.tags),
      });
    }
  }
  return rules;
}
