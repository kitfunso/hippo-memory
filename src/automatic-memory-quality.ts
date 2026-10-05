export const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'it',
  'this', 'that', 'and', 'or', 'but', 'not', 'no', 'so', 'if', 'do',
  'did', 'does', 'has', 'had', 'have', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'shall', 'we', 'i', 'you', 'they', 'he', 'she',
  'my', 'our', 'your', 'its', 'his', 'her', 'their', 'up', 'out', 'just',
  'also', 'then', 'than', 'some', 'all', 'any', 'each', 'very', 'too',
]);

export type AutomaticMemoryRejectionReason =
  | 'too-short' | 'release-activity' | 'sentence-fragment' | 'subjectless-outcome'
  | 'raw-output' | 'too-vague' | 'no-specificity';

export interface AutomaticMemoryAssessment {
  readonly accepted: boolean;
  readonly reason: AutomaticMemoryRejectionReason | null;
}

const CJK_LETTERS = /(?=\p{L})(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana})/gu;
const CHAT_ACRONYMS = /^(?:TODO|FYI|LGTM|IIRC|IMO|IMHO|FWIW|TBD|BTW|ASAP|AFAIK|WIP|NB|PS)$/;

/** Counts spaced words plus CJK letters without lowering mixed-script counts. */
export function substantiveWordCount(text: string): number {
  const cjkLetterCount = (text.match(CJK_LETTERS) ?? []).length;
  const spacedCount = text.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w)).length;
  return spacedCount + Math.floor(cjkLetterCount / 2);
}

/** Preserves the auditor's existing destructive release-noise classification. */
export function isReleaseCommitNoise(text: string): boolean {
  return /^(?:bump|release|prep|tag)\s+(?:to\s+)?v?\d+\.\d+/i.test(text)
    || /^v?\d+\.\d+\.\d+\s*$/i.test(text)
    || /^chore(?:\([^)]+\))?:\s*(?:release|bump|version|tag|prep)\b/i.test(text)
    || /^(?:Merge branch|Merge pull request)\b/i.test(text)
    || /^WIP\b/i.test(text);
}

/** Short preferences carry a useful relationship even without a path or number. */
export function hasNoSpecificity(text: string): boolean {
  const domainAcronyms = (text.match(/\b[A-Z]{2,6}\b/g) ?? []).filter(a => !CHAT_ACRONYMS.test(a));
  if (/\d|[A-Z][a-z]{2,}|[/\\.]|[`_{}()\[\]]/.test(text)) return false;
  if (domainAcronyms.length > 0 && /[a-z]/.test(text)) return false;
  if (/^(?:prefer|use|avoid|never use|don't use)\s+\S+/i.test(text)) return false;
  return text.split(/\s+/).length < 8 && /^[\w\s,.'"-]+$/.test(text);
}

function isRoutineReleaseActivity(text: string): boolean {
  if (isReleaseCommitNoise(text)) return true;
  const subject = text.replace(/^(?:chore|ci|build)(?:\([^)]*\))?:\s*/i, '');
  if (/^(?:bump|increment|increase|update|set)\s+(?:(?:ios|android|app)\s+)?(?:build(?:\s+number)?|version|release)\s+(?:to\s+)?(?:v?\d|#\d)/i.test(subject)) return true;
  return /^(?:deploy(?:ed|ing)?|ship(?:ped|ping)?|release(?:d|ing)?)\s+(?:the\s+)?(?:build|release|version|v?\d)\s*(?:v?\d|#\d|\.\d)/i.test(subject)
    || /^(?:deployment|release|build)\s+(?:succeeded|completed|finished)\b/i.test(subject);
}

const RELATION_WORD = /\b(?:when|if|unless|because|since|after|before|until|while|so|instead)\b/i;

function isDanglingAssertion(text: string): boolean {
  const bare = text.replace(/[.!?,;:\s]+$/, '');
  if (/^(?:to|and)\s/i.test(bare) && bare.length < 50) return true;
  if (/\b(?:to be|has been|will be|needs to|instead of|rather than|such as|depends on|because|if|unless|when|while|until|with|without|into|than|and|or|but|requires|must|should|could|would|might|is|are|was|were|the|a|an|to|for|of|by)\s*$/i.test(bare)) return true;
  // Only a short leading condition is a bare clause; "When CI is red rerun the jobs" carries its consequent unpunctuated.
  return /^(?:if|unless|when|while|until)\b/i.test(bare) && !/[,;]|\bthen\b/i.test(bare) && bare.split(/\s+/).length <= 6;
}

function isSubjectlessOutcome(text: string): boolean {
  return /^(?:succeeds?|succeeded|fails?|failed|passes|passed|completed|done|successful|success|returned|returns|inserted|updated|deleted)\b/i.test(text)
    && !RELATION_WORD.test(text);
}

function isRawOutput(text: string): boolean {
  return /^(?:\$\s|>\s|(?:stdout|stderr|exit code):|Command\s+['"].*\s+failed\b|Traceback\b|npm\s+(?:ERR|WARN)\b|error\s+TS\d+\b)/i.test(text)
    || /^(?:[\w.$]+Error|[\w.$]+Exception):\s/.test(text)
    || /^at\s+\S+.*:\d+(?::\d+)?\)?$/.test(text)
    || /^\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-][\d:]+)?\s+(?:\[?\w+\]?\s+)?/.test(text)
    || /^\[(?:info|warn|error|debug)\]/i.test(text)
    || /^\{\s*["']?[\w$-]+["']?\s*:/.test(text)
    || /^\[\s*[{["\d]/.test(text);
}

/** Rejects named automatic-capture defects without inventing missing context. */
export function assessAutomaticMemory(content: string): AutomaticMemoryAssessment {
  const text = content.trim();
  let reason: AutomaticMemoryRejectionReason | null = null;
  if (text.length < 10) reason = 'too-short';
  else if (isRoutineReleaseActivity(text)) reason = 'release-activity';
  else if (isRawOutput(text)) reason = 'raw-output';
  else if (isDanglingAssertion(text)) reason = 'sentence-fragment';
  else if (isSubjectlessOutcome(text)) reason = 'subjectless-outcome';
  else if (substantiveWordCount(text) < 2) reason = 'too-vague';
  else if (text.length < 40 && hasNoSpecificity(text)) reason = 'no-specificity';
  return { accepted: reason === null, reason };
}

/** Reasons the heuristics can get wrong: repair only flags them for review and derivation still admits them. */
export const UNCERTAIN_REASONS: ReadonlySet<AutomaticMemoryRejectionReason> = new Set(['too-short', 'too-vague', 'no-specificity']);

/** The bar for sleep's derived memories and for repair: a defect the checks are sure of, else null. */
export function certainDefect(content: string): AutomaticMemoryRejectionReason | null {
  const { reason } = assessAutomaticMemory(content);
  return reason !== null && !UNCERTAIN_REASONS.has(reason) ? reason : null;
}
