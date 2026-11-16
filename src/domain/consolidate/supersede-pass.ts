// Links an old memory to the newer one that changes one span of its words. A newer text that says
// it is an update hides the old row; any other only marks it stale. Precision first: a pair that
// is in doubt is left alone.
import {
  CONFIDENCE_LEVELS,
  DAG_LEVEL,
  ERROR_TAG,
  Layer,
  type ConfidenceLevel,
  type MemoryEntry,
} from '../../base/memory/entry.js';
import { isKeptForGood } from '../../base/memory/keep-rules.js';
import { isSuperseded } from '../../base/memory/liveness.js';
import {
  isReplacedBy,
  KEPT_CURRENT_PREFIX,
  markStale,
  REPLACED_BY_PREFIX,
} from '../../base/memory/stale-mark.js';
import { netWrong } from '../../base/memory/strength.js';
import type { SupersedeLink } from '../../base/ports/store/consolidation.js';
import { derivationPartitionKey } from '../../base/scope/recall-scope.js';
import { jaccardMinShared, overlapPartners } from './overlap-index.js';
import { keptAsWritten, recordPhaseFailure, type SleepRun } from './run.js';

// "now" and its kin mark an update, not content, so they stay out of the word comparison.
const UPDATE_CUES = new Set(['now', 'again', 'actually', 'instead']);

const MIN_SHARED_PREFIX_WORDS = 2;
const MIN_CHANGED_WORDS = 1;
const MAX_CHANGED_WORDS = 4;
const MIN_SHARED_FRACTION = 0.6;
const MAX_TEXT_WORDS = 20;

// Rows a person wrote; every other source is a tool's output or a derived row.
const PERSON_SOURCES: ReadonlySet<string> = new Set(['cli', 'cli-global', 'capture']);
const PERSON_SOURCE_PREFIX = 'claude-memory:';

const SAYS_UPDATE =
  /\b(?:now|instead|again|actually|anymore|no\s+longer|moved\s+to|switched\s+to|changed\s+to|back\s+to)\b/i;

const tokens = (t: string): string[] =>
  t.toLowerCase().match(/[\p{L}\p{N}]+(?:[:'.-][\p{L}\p{N}]+)*/gu) ?? [];

const words = (t: string): string[] => tokens(t).filter((w) => !UPDATE_CUES.has(w));

const isChangedSpan = (length: number): boolean =>
  length >= MIN_CHANGED_WORDS && length <= MAX_CHANGED_WORDS;

function replacesWords(a: readonly string[], b: readonly string[]): boolean {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (
    post < a.length - pre &&
    post < b.length - pre &&
    a[a.length - 1 - post] === b[b.length - 1 - post]
  ) {
    post++;
  }
  const spanA = a.length - pre - post;
  const spanB = b.length - pre - post;
  return (
    pre >= MIN_SHARED_PREFIX_WORDS &&
    isChangedSpan(spanA) &&
    isChangedSpan(spanB) &&
    (pre + post) / Math.max(a.length, b.length) >= MIN_SHARED_FRACTION
  );
}

/** Whether `newText` is `oldText` with exactly one span of words changed, update cues aside. */
export function replacesOne(oldText: string, newText: string): boolean {
  return replacesWords(words(oldText), words(newText));
}

/** One survivor the pass may link, with what the pairing reads of it. */
interface Fact {
  readonly id: string;
  readonly tenantId: string;
  readonly created: number;
  /** When the belief became true; the row's creation when no valid time is stored. */
  readonly time: number;
  readonly pinned: boolean;
  readonly wrong: boolean;
  readonly confidence: ConfidenceLevel;
  readonly replaced: boolean;
  readonly keptCurrent: ReadonlySet<string>;
  readonly text: string;
  readonly words: readonly string[];
}

const isPersonSource = (source: string): boolean =>
  PERSON_SOURCES.has(source) || source.startsWith(PERSON_SOURCE_PREFIX);

function isLinkable(run: SleepRun, e: MemoryEntry): boolean {
  return (
    e.kind === 'distilled' &&
    e.layer !== Layer.Semantic &&
    e.layer !== Layer.Trace &&
    e.dagLevel < DAG_LEVEL.extracted &&
    !e.extractedFrom &&
    isPersonSource(e.source) &&
    !e.tags.includes(ERROR_TAG) &&
    !isSuperseded(e) &&
    !keptAsWritten(e) &&
    !run.rows.backsObject(e.id) &&
    !isKeptForGood(e)
  );
}

function factOf(run: SleepRun, e: MemoryEntry): Fact | null {
  const created = Date.parse(e.created);
  if (!Number.isFinite(created)) return null;
  if (tokens(e.content).length > MAX_TEXT_WORDS) return null;
  const ws = words(e.content);
  // A pair needs a shared prefix and one changed word at least.
  if (ws.length <= MIN_SHARED_PREFIX_WORDS) return null;
  const valid = Date.parse(e.validFrom);
  return {
    id: e.id,
    tenantId: e.tenantId,
    created,
    time: Number.isFinite(valid) ? valid : created,
    pinned: e.pinned,
    wrong: netWrong(e, run.strength) > 0,
    confidence: e.confidence,
    replaced: isReplacedBy(e),
    keptCurrent: new Set(
      e.tags.filter((t) => t.startsWith(KEPT_CURRENT_PREFIX)).map((t) => t.slice(KEPT_CURRENT_PREFIX.length)),
    ),
    text: e.content,
    words: ws,
  };
}

/** The linkable survivors grouped by the partition a derived row would land in, so a pair never
 * spans tenants, projects or restricted scopes. */
async function factsByPartition(run: SleepRun): Promise<Map<string, Fact[]>> {
  const buckets = new Map<string, Fact[]>();
  for await (const e of run.survivors.rows()) {
    if (!isLinkable(run, e)) continue;
    const fact = factOf(run, e);
    if (!fact) continue;
    const key = derivationPartitionKey(e.tenantId, e.scope, e.originProject);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(fact);
    else buckets.set(key, [fact]);
  }
  return buckets;
}

// Numbering each repeat makes the token set as large as the word list, so a pair sharing k words
// shares k tokens, the bound the overlap index needs.
function wordTokens(ws: readonly string[]): Set<string> {
  const seen = new Map<string, number>();
  return new Set(
    ws.map((w) => {
      const n = (seen.get(w) ?? 0) + 1;
      seen.set(w, n);
      return `${w}\u0000${n}`;
    }),
  );
}

const byTime = (a: Fact, b: Fact): number =>
  a.time - b.time || a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const rank = (c: ConfidenceLevel): number => CONFIDENCE_LEVELS.indexOf(c);

/** The mode a newer text asks for: an update cue hides the old row, anything else marks it stale. */
const modeFor = (newText: string): SupersedeLink['mode'] =>
  SAYS_UPDATE.test(newText) ? 'hide' : 'soft';

/** Whether `n` may replace `o`: later by both clocks, a clean newer row, and no one-span test left
 * to doubt. */
function mayReplace(o: Fact, n: Fact, mode: SupersedeLink['mode']): boolean {
  return (
    n.created > o.created &&
    n.time > o.time &&
    !n.wrong &&
    n.confidence !== 'stale' &&
    rank(n.confidence) <= rank(o.confidence) &&
    !o.keptCurrent.has(n.id) &&
    // A stale row has nothing left to demote.
    (mode === 'hide' || o.confidence !== 'stale') &&
    replacesOne(o.text, n.text)
  );
}

/** Each old fact, oldest first, with its nearest newer fact that replaces it. */
function linksIn(partition: readonly Fact[]): SupersedeLink[] {
  const facts = [...partition].sort(byTime);
  const partnersOf = overlapPartners(
    facts.map((f) => wordTokens(f.words)),
    jaccardMinShared(MIN_SHARED_FRACTION),
  );
  const links: SupersedeLink[] = [];
  facts.forEach((old, i) => {
    if (old.pinned || old.replaced) return;
    for (const j of partnersOf(i)) {
      const next = facts[j];
      const mode = modeFor(next.text);
      if (!mayReplace(old, next, mode)) continue;
      links.push({ tenantId: old.tenantId, id: old.id, newId: next.id, mode });
      return;
    }
  });
  return links;
}

async function findLinks(run: SleepRun): Promise<SupersedeLink[]> {
  const links: SupersedeLink[] = [];
  for (const partition of (await factsByPartition(run)).values()) links.push(...linksIn(partition));
  return links;
}

/** The row as later passes see it once linked: superseded for a hide, stale for a soft link, so
 * merge folds neither into a summary. */
function linkedRow(row: MemoryEntry, link: SupersedeLink): MemoryEntry {
  return link.mode === 'hide'
    ? { ...row, supersededBy: link.newId }
    : markStale(row, `${REPLACED_BY_PREFIX}${link.newId}`, (days) => days);
}

async function markLinked(run: SleepRun, links: readonly SupersedeLink[]): Promise<void> {
  const rows = new Map((await run.survivors.get(links.map((l) => l.id))).map((r) => [r.id, r]));
  const linked = links.flatMap((l) => {
    const row = rows.get(l.id);
    return row ? [linkedRow(row, l)] : [];
  });
  await run.survivors.set(linked);
  for (const { id, newId, mode } of links) {
    run.result.events.push({ kind: 'superseded', oldId: id, newId, rule: 'one-span', mode });
    if (mode === 'hide') run.result.superseded++;
    else run.result.demoted++;
  }
}

/** Links old facts to the newer ones that replace them; a dry run finds and reports the links
 * without writing. */
export async function supersedeChangedFacts(run: SleepRun): Promise<void> {
  try {
    const links = await findLinks(run);
    if (links.length === 0) return;
    const written = run.dryRun ? null : new Set(await run.store.consolidation.supersedeLinks(links));
    await markLinked(run, written ? links.filter((l) => written.has(l.id)) : links);
  } catch (error) {
    recordPhaseFailure(run.result, 'supersede', error);
  }
}
