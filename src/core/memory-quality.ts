import { COMPACTION_MEMORY_TAG, COMPACTION_SOURCE_PREFIX, type MemoryEntry } from './memory.js';
import { heldTexts } from '../util/same-text.js';

export const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'it',
  'this', 'that', 'and', 'or', 'but', 'not', 'no', 'so', 'if', 'do',
  'did', 'does', 'has', 'had', 'have', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'shall', 'we', 'i', 'you', 'they', 'he', 'she',
  'my', 'our', 'your', 'its', 'his', 'her', 'their', 'up', 'out', 'just',
  'also', 'then', 'than', 'some', 'all', 'any', 'each', 'very', 'too',
]);

export type AutomaticMemoryDefect =
  | 'too-short' | 'release-activity' | 'sentence-fragment' | 'possible-fragment' | 'subjectless-outcome'
  | 'raw-output' | 'too-vague' | 'no-specificity';

/** `reason` names a defect even when `accepted`: a possible fragment is stored and listed for review. */
export interface AutomaticMemoryAssessment {
  readonly accepted: boolean;
  readonly reason: AutomaticMemoryDefect | null;
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

/** Short preferences and rules carry a useful relationship even without a path or number. */
export function hasNoSpecificity(text: string): boolean {
  const domainAcronyms = (text.match(/\b[A-Z]{2,6}\b/g) ?? []).filter(a => !CHAT_ACRONYMS.test(a));
  if (/\d|[A-Z][a-z]{2,}|[/\\.]|[`_{}()\[\]]/.test(text)) return false;
  if (domainAcronyms.length > 0 && /[a-z]/.test(text)) return false;
  if (/^(?:prefer|use|avoid|never use|don't use)\s+(?!(?:the|that|this|it|them|those|these|one|other|something)\b)\S+/i.test(text)) return false;
  if (/\b(?:never|always|must)\s+(?!(?:the|that|this|it|them|those|these|one|other|something)\b)\S+/i.test(text)) return false;
  return text.split(/\s+/).length < 8 && /^[\w\s,.'"-]+$/.test(text);
}

const RELATION_WORD = /\b(?:when|if|unless|because|since|after|before|until|while|so|instead)\b/i;
const RULE_WORD = /\b(?:never|always|must|don't|do not|make sure|ensure|prefer|avoid)\b/i;

function isRoutineReleaseActivity(text: string): boolean {
  if (isReleaseCommitNoise(text)) return true;
  // "Deploy only after the migration has run" is a rule about releases, not a log line.
  if (RELATION_WORD.test(text) || RULE_WORD.test(text)) return false;
  const subject = text.replace(/^(?:chore|ci|build)(?:\([^)]*\))?:\s*/i, '');
  if (/^(?:bump|increment|increase|update|set)\s+(?:(?:ios|android|app)\s+)?(?:build(?:\s+number)?|version|release)\s+(?:to\s+)?(?:v?\d|#\d)/i.test(subject)) return true;
  return /^(?:deploy(?:ed|ing)?|ship(?:ped|ping)?|release(?:d|ing)?)\s+(?:the\s+)?(?:build|release|version|v?\d)\s*(?:v?\d|#\d|\.\d)/i.test(subject)
    || /^(?:deployment|release|build)\s+(?:succeeded|completed|finished)\b/i.test(subject);
}

const bareText = (text: string): string => text.replace(/[.!?,;:\s]+$/, '');
// These endings close whole sentences too ("the branch you push to"), so they are only a possible cut.
const POSSIBLE_CUT_ENDING = /\b(?:needs to|depends on|requires|while|with|without|into|for|of|by|to|is|are|was|were|must|should|could|would|might)$/i;

/** A short leading condition with no rule word, comma or "then": "If the build fails". */
function isBareCondition(bare: string): boolean {
  return !/[,;]|\bthen\b/i.test(bare) && !RULE_WORD.test(bare) && bare.split(/\s+/).length <= 6;
}

function isDanglingAssertion(text: string): boolean {
  const bare = bareText(text);
  // Only a lowercase start is a cut: "To rebuild the index, run ..." opens an instruction.
  if (/^(?:to|and|for)\s/.test(bare) && bare.length < 50) return true;
  // Prepositions, modals and "is" can end a whole sentence ("the branch it merges into"), so only cut-off endings count.
  if (/\b(?:to be|has been|will be|instead of|rather than|such as|than|because|if|unless|when|until|and|or|but)$/i.test(bare) || /\b(?:the|a|an)$/.test(bare)) return true;
  return /^(?:if|unless|when|while|until)\b/.test(bare) && isBareCondition(bare);
}

/** A capitalised short condition may carry its rule with no comma: "When CI fails we retry once". */
function isPossibleFragment(text: string): boolean {
  const bare = bareText(text);
  return POSSIBLE_CUT_ENDING.test(bare) || (/^(?:If|Unless|When|While|Until)\b/.test(bare) && isBareCondition(bare));
}

const OUTCOME_LEAD = /^(?:succeeds?|succeeded|fails?|failed|passes|passed|completed|done|successful|success|returned|returns|inserted|updated|deleted)\b/i;
const OUTCOME_DETAIL = /\b(?:for|on|in|at|to|from|with|without|by|after|before|under|is|are|was|were|be|been|will|can|must|should|never|always)\b/i;

function isSubjectlessOutcome(text: string): boolean {
  const lead = OUTCOME_LEAD.exec(text);
  if (lead === null || RELATION_WORD.test(text)) return false;
  // "Returns 404 for unknown ids" and "Deleted rows must stay deleted" say when or what; "returned 3 matching rows" does not.
  return !OUTCOME_DETAIL.test(text.slice(lead[0].length).replace(/\([^)]*\)/g, ' '));
}

const OUTPUT_LINE = /^(?:\$\s|>\s|(?:stdout|stderr|exit code):|Command\s+['"].*\s+failed\b|Traceback\b|npm\s+(?:ERR|WARN)\b|error\s+TS\d+\b)/i;
const STACK_FRAME = /^at\s+\S.*:\d+(?::\d+)?\)?$/;
const ERROR_LEAD = /^(?:[\w.$]+Error|[\w.$]+Exception):\s/;
// Log lines say "after" and "while" too, so only a rule word frees a timestamp or level lead: a dated freeze saying never merge.
const LOG_LEADS = [
  /^\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-][\d:]+)?\s+(?:\[?\w+\]?\s+)?/,
  /^\[(?:info|warn|error|debug)\]/i,
];
const DATA_LEADS = [/^\{\s*["']?[\w$-]+["']?\s*:/, /^\[\s*(?:[{["]|-?\d[\d.]*\s*[,\]])/];

/** Prose after the last closing bracket: "{ retries: 3 } is the default policy". */
function hasProseAfterData(text: string): boolean {
  const tail = text.slice(Math.max(text.lastIndexOf('}'), text.lastIndexOf(']')) + 1);
  return (tail.match(/\p{L}{2,}/gu) ?? []).length >= 2;
}

function isRawOutput(text: string): boolean {
  if (OUTPUT_LINE.test(text) || STACK_FRAME.test(text)) return true;
  if (ERROR_LEAD.test(text)) return !RELATION_WORD.test(text) && !RULE_WORD.test(text);
  if (LOG_LEADS.some((lead) => lead.test(text))) return !RULE_WORD.test(text);
  return DATA_LEADS.some((lead) => lead.test(text)) && !hasProseAfterData(text);
}

/** Names automatic-capture defects without inventing missing context. */
export function assessAutomaticMemory(content: string): AutomaticMemoryAssessment {
  const text = content.trim();
  let reason: AutomaticMemoryDefect | null = null;
  if (text.length < 10) reason = 'too-short';
  else if (isRoutineReleaseActivity(text)) reason = 'release-activity';
  else if (isRawOutput(text)) reason = 'raw-output';
  else if (isDanglingAssertion(text)) reason = 'sentence-fragment';
  else if (isSubjectlessOutcome(text)) reason = 'subjectless-outcome';
  else if (isPossibleFragment(text)) reason = 'possible-fragment';
  else if (substantiveWordCount(text) < 2) reason = 'too-vague';
  else if (text.length < 40 && hasNoSpecificity(text)) reason = 'no-specificity';
  return { accepted: reason === null || reason === 'possible-fragment', reason };
}

/** Reasons the heuristics can get wrong: repair only lists them for review and derivation still admits them. */
const UNCERTAIN_REASONS: ReadonlySet<AutomaticMemoryDefect> = new Set(['too-short', 'possible-fragment', 'too-vague', 'no-specificity']);

export function isCertainReason(reason: AutomaticMemoryDefect | null): boolean {
  return reason !== null && !UNCERTAIN_REASONS.has(reason);
}

/** The bar for sleep's derived memories and for repair: a defect the checks are sure of, else null. */
export function certainDefect(content: string): AutomaticMemoryDefect | null {
  const { reason } = assessAutomaticMemory(content);
  return isCertainReason(reason) ? reason : null;
}

// Watch failures ('autolearn') and tool failures keep a fixed "Command 'x' failed" format by design, so they are not judged.
const AUTOMATIC_SOURCES = new Set(['capture', 'git-learn', 'git', 'consolidation']);
// Promote and share rewrite the source but keep the tags, so the writer's tag still marks a copy; elsewhere a person may set it.
const AUTOMATIC_TAGS = new Set(['captured', COMPACTION_MEMORY_TAG, 'git-learned']);
const COPY_SOURCE = /^(?:promoted|shared):/;
export const BUNDLE_HEADER = /^\[Consolidated(?: from| pattern from) \d+ related memor(?:y|ies)(?:, newest first)?\]\n\n/;

type Provenance = Pick<MemoryEntry, 'source' | 'confidence' | 'content' | 'extracted_from' | 'dag_level' | 'tags'>;

/** A row hippo wrote that no person vouched for: hippo's writers stamp observed or inferred, a person's edit or restore verified. */
export function isAutomaticEntry(entry: Provenance): boolean {
  if (entry.confidence !== 'observed' && entry.confidence !== 'inferred') return false;
  return AUTOMATIC_SOURCES.has(entry.source) || entry.source.startsWith(COMPACTION_SOURCE_PREFIX)
    || (COPY_SOURCE.test(entry.source) && entry.tags.some((tag) => AUTOMATIC_TAGS.has(tag)))
    || entry.extracted_from !== null || entry.dag_level >= 1 || BUNDLE_HEADER.test(entry.content);
}

/** A bundle's parts are other rows' words, possibly a person's, so a bundle is sure to be junk only when every part is. */
function bundleParts(entry: Pick<MemoryEntry, 'content'>): string[] {
  return BUNDLE_HEADER.test(entry.content) ? heldTexts({ content: entry.content, source: 'consolidation' }) : [];
}

function hasCertainDefect(entry: Pick<MemoryEntry, 'content'>): boolean {
  const parts = bundleParts(entry);
  return (parts.length > 0 ? parts : [entry.content]).every((text) => certainDefect(text) !== null);
}

/** The audit's check: a person's row is never judged, and a bundle is flagged only when every part is, as reuse and recent context judge it. */
export function automaticDefect(entry: Provenance): AutomaticMemoryDefect | null {
  if (!isAutomaticEntry(entry)) return null;
  const parts = bundleParts(entry);
  const reasons = (parts.length > 0 ? parts : [entry.content.trim()]).map((text) => assessAutomaticMemory(text).reason);
  return reasons.every((reason) => reason !== null) ? reasons[0] ?? null : null;
}

/** Whether sleep may derive from a row or share it: a person's text and watch failures always, hippo's own text only without a certain defect. */
export function isReusable(entry: Provenance): boolean {
  return !isAutomaticEntry(entry) || !hasCertainDefect(entry);
}

/** The person floor's fragment test, on trimmed text. */
export function isFragment(text: string): boolean {
  return /^(?:to|for|and) /.test(text) && text.length < 50;
}

/** Admission check for text no person typed: capture and compaction items. */
export function isContentWorthStoring(content: string): boolean {
  return assessAutomaticMemory(content).accepted;
}

/** Recent-context floor: rows hippo wrote meet the automatic check, a person's rows only the older, looser floor. */
export function isWorthSurfacing(entry: MemoryEntry): boolean {
  if (isAutomaticEntry(entry)) return bundleParts(entry).length > 0 ? !hasCertainDefect(entry) : isContentWorthStoring(entry.content);
  const text = entry.content.trim();
  return text.length >= 10 && !isReleaseCommitNoise(text) && !isFragment(text)
    && substantiveWordCount(text) >= 2 && !(text.length < 40 && hasNoSpecificity(text));
}
