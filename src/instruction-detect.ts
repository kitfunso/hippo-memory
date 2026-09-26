/** Prompt-injection detection for untrusted memory content (CD5). Same shape as secret-detect.ts; leaf module, no store/api/shared imports. */

export interface InstructionDetection {
  flagged: boolean;
  reason: string | null;
}

const INSTRUCTION_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'override-instructions', re: /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|prior|above)\b[^.\n]{0,40}\binstructions?\b/i },
  { name: 'role-reassignment', re: /\b(?:you are now|act as|pretend to be)\b[^.\n]{0,40}\b(?:an?\s+)?(?:ai|assistant|agent|system)\b/i },
  { name: 'chat-role-markup', re: /<\|im_start\|>|<\|system\|>|\[INST\]|<\/?system>|###\s*system\s*:/i },
  { name: 'system-prompt-reference', re: /\b(?:(?:override|ignore|bypass|replace|reveal)\b[^.\n]{0,40}\b(?:system prompt|developer message)|(?:system prompt|developer message)\b[^.\n]{0,40}\b(?:override|ignore|bypass|replace|reveal))\b/i },
  // "always"/"never" alone (ordinary PR prose) doesn't flag without an agent-facing target nearby too.
  { name: 'standing-order', re: /\b(?:from now on|whenever you|always|never)\b[^.\n]{0,50}\b(?:you must|(?:the ai|the assistant|the agent|claude|copilot)\s+(?:must|should|will)\b)/i },
  { name: 'concealment', re: /\b(?:do not|never|don't)\b[^.\n]{0,40}\b(?:tell|mention|reveal)\b[^.\n]{0,40}\bthe user\b/i },
  { name: 'remote-script-exec', re: /\b(?:curl|wget)\b[^\n|]{0,80}\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b|\biex\s*\(\s*(?:iwr|invoke-webrequest|new-object\s+net\.webclient)/i },
  { name: 'exfiltration', re: /\b(?:send|post|upload|exfiltrate)\b[^.\n]{0,40}\b(?:secrets?|tokens?|api[- ]?keys?|credentials?|env(?:ironment)? variables?)\b/i },
  { name: 'unicode-tag-chars', re: /[\u{E0000}-\u{E007F}]/u },
];

// A stray zero-width char has legitimate uses (ZWJ); only a 3+ cluster reads as smuggling.
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2060-\u2064]/g;

export function detectInstruction(content: string): InstructionDetection {
  for (const { name, re } of INSTRUCTION_PATTERNS) {
    if (re.test(content)) {
      return { flagged: true, reason: `pattern:${name}` };
    }
  }
  const zeroWidthMatches = content.match(ZERO_WIDTH_RE);
  if (zeroWidthMatches && zeroWidthMatches.length >= 3) {
    return { flagged: true, reason: 'pattern:zero-width-smuggling' };
  }
  return { flagged: false, reason: null };
}
