// The strings a context block prints. The budget prices these same strings, so selection and print cannot drift.
import { calculateStrength, confidenceFacets, confidenceLabel, type MemoryEntry } from './memory.js';
import { evalNow } from './ablation.js';
import { estimateTokens } from './token-ledger.js';
import { renderAmbientSummary, type AmbientState } from './ambient.js';
import { formatHandoffEvidenceLine, type SessionHandoff } from './handoff.js';
import type { SessionEvent, TaskSnapshot } from './store.js';
import type {
  AssembleCost, AssembleResult, AssembledContextItem, ContextCost, ContextResultEntry, DrillDownChild, DrillDownCost,
  DrillDownResult, DrillDownSummary,
} from './api.js';

export function snapshotText(s: TaskSnapshot): string {
  return [
    '## Active Task Snapshot\n',
    `- Task: ${s.task}`,
    `- Status: ${s.status}`,
    `- Updated: ${s.updated_at}`,
    `- Source: ${s.source}`,
    ...(s.session_id ? [`- Session: ${s.session_id}`] : []),
    '', '### Summary', s.summary, '', '### Next step', s.next_step, '',
  ].join('\n');
}

export function handoffText(h: SessionHandoff): string {
  const lines = ['## Session Handoff\n', `- Session: ${h.sessionId}`, `- Updated: ${h.updatedAt}`];
  if (h.taskId) lines.push(`- Task: ${h.taskId}`);
  if (h.repoRoot) lines.push(`- Repo: ${h.repoRoot}`);
  if (h.outcome) lines.push(`- Outcome: ${h.outcome}`);
  if (h.targetRuntime) lines.push(`- Target runtime: ${h.targetRuntime}`);
  if (h.cardId) lines.push(`- Card: ${h.cardId}`);
  lines.push('', '### Summary', h.summary);
  if (h.nextAction) lines.push('', '### Next action', h.nextAction);
  if (h.artifacts && h.artifacts.length > 0) lines.push('', '### Artifacts', ...h.artifacts.map((a) => `- ${a}`));
  if (h.constraints && h.constraints.length > 0) lines.push('', '### Constraints', ...h.constraints.map((c) => `- ${c}`));
  if (h.evidence) lines.push('', '### Evidence', formatHandoffEvidenceLine(h.evidence));
  lines.push('');
  return lines.join('\n');
}

/** Needs at least one event; the header reads the latest. */
export function sessionTrailText(events: SessionEvent[]): string {
  const latest = events[events.length - 1]!;
  return [
    '## Recent Session Trail\n',
    `- Session: ${latest.session_id}`,
    `- Task: ${latest.task ?? 'n/a'}`,
    `- Updated: ${latest.created_at}`,
    '',
    ...events.map((e) => `- [${e.created_at}] (${e.event_type}) ${e.content}`),
    '',
  ].join('\n');
}

export function contextHeading(heading: string, entries: number, tokens: number): string {
  return `## ${heading} (${entries} entries, ${tokens} tokens)\n`;
}

export function contextLine(
  item: { entry: MemoryEntry; isGlobal: boolean },
  framing: string,
  showStrength: boolean,
  now: Date,
  strengthPct: number = Math.round(calculateStrength(item.entry) * 100),
): string {
  const e = item.entry;
  const tagStr = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : '';
  const strengthStr = showStrength ? ` (${strengthPct}%)` : '';
  const globalPrefix = item.isGlobal ? '[global] ' : '';
  const label = confidenceLabel(e, now);
  const confTag = `[${label.text}]${label.warn ? ' ⚠️' : ''}`;
  if (framing === 'observe') {
    const dateStr = new Date(e.created).toISOString().slice(0, 10);
    // Verified rules print without the date prefix.
    if (confidenceFacets(e, now).tier === 'verified') return `- **${confTag} ${globalPrefix}${e.content}**${tagStr}${strengthStr}`;
    return `- **${confTag} Previously observed (${dateStr}): ${globalPrefix}${e.content}**${tagStr}${strengthStr}`;
  }
  if (framing === 'suggest') return `- **${confTag} Consider checking: ${globalPrefix}${e.content}**${tagStr}${strengthStr}`;
  return `- **${confTag} ${globalPrefix}${e.content}**${tagStr}${strengthStr}`;
}

export function crossProjectHeading(entries: number): string {
  return `\n## Other-project memory (explicitly requested, ${entries} entries)\n`;
}

export function crossProjectLine(item: Pick<ContextResultEntry, 'entry' | 'origin'>): string {
  const originLabel = item.origin === null || item.origin === '' ? 'unknown-origin' : item.origin;
  const tagStr = item.entry.tags.length > 0 ? ` [${item.entry.tags.join(', ')}]` : '';
  return `- **[${originLabel}]** ${item.entry.content}${tagStr}`;
}

/** A header's token figure is part of the text it counts, so render until the figure matches the text. */
export function settleTokens(render: (tokens: number) => string): string {
  let t = 0;
  let text = render(t);
  // The figure only gains digits, so this settles in a few rounds; the cap guards a render that reads the clock.
  for (let i = 0; i < 8 && estimateTokens(text) !== t; i++) {
    t = estimateTokens(text);
    text = render(t);
  }
  return text;
}

// Every summary slot at its longest wording, so the footer reserve covers whatever the summary says.
const WIDEST_AMBIENT: AmbientState = {
  tagEntropy: 1, avgStrength: 0, recencyFreshness: 1, emotionalSkew: -1, schemaFitRatio: 0, errorDensity: 0,
  consolidationRatio: 1, conflictIntensity: 1, extractionCoverage: 1,
  dagDepth: Number.MAX_SAFE_INTEGER, totalMemories: Number.MAX_SAFE_INTEGER,
};

// Each piece is priced with the newline that follows it, so the pieces' sum bounds the joined block.
export function printedTokens(text: string): number {
  return estimateTokens(text + '\n');
}

export interface AssembleHeadingCounts {
  sessionId: string;
  items: number;
  tokens: number;
  totalRaw: number;
  summarized: number;
  evicted: number;
}

export function assembleHeading(c: AssembleHeadingCounts): string {
  return `Session ${c.sessionId} \u2014 ${c.items} items, ${c.tokens} tokens (raw=${c.totalRaw}, summarized=${c.summarized}, evicted=${c.evicted})`;
}

export function assembleLine(it: AssembledContextItem): string {
  const prefix = it.isSummary ? '[summary]' : it.isFreshTail ? '[tail]' : '[older]';
  return `  ${prefix} ${it.createdAt} ${it.id} - ${it.content}`;
}

/** The window in full, as the MCP tool returns it; the header counts the whole block. */
export function assembleText(r: AssembleResult): string {
  return settleTokens((t) => [assembleHeading({ ...r, items: r.items.length, tokens: t }), ...r.items.map(assembleLine)].join('\n'));
}

// Every format prices the full lines: JSON carries full content, and the CLI's previews are never longer.
export function assembleCost(sessionId: string): AssembleCost {
  return {
    item: (it) => printedTokens(assembleLine(it)),
    fixed: (w) => printedTokens(assembleHeading({ sessionId, items: w, tokens: w, totalRaw: w, summarized: w, evicted: w })),
  };
}

function drillHead(s: DrillDownSummary, shown: number, total: number, truncated: boolean): string {
  const span = s.earliestAt ? ` (${s.earliestAt} -> ${s.latestAt})` : '';
  return `Summary ${s.id} \u2014 ${s.descendantCount} descendants${span}\n  ${s.content}\n\nChildren (${shown}/${total}${truncated ? ', truncated' : ''}):`;
}

export function drillLine(c: DrillDownChild): string {
  return `  [L${c.dagLevel}] ${c.id} - ${c.content}`;
}

export function drillText(r: DrillDownResult): string {
  return [drillHead(r.summary, r.children.length, r.totalChildren, r.truncated), ...r.children.map(drillLine)].join('\n');
}

export const drillCost: DrillDownCost = {
  child: (c) => printedTokens(drillLine(c)),
  fixed: (s, w) => printedTokens(drillHead(s, w, w, true)),
};

// Headers and footer are reserved at their widest (counts at the budget itself, strength at 100%) before any entry.
export function contextCost(format: 'markdown' | 'additional-context', framing: string): ContextCost {
  const hook = format === 'additional-context';
  const price = printedTokens;
  return {
    entry: (item) => price(
      item.category === 'cross-project' && !(hook && item.promptRecall)
        ? crossProjectLine(item)
        : contextLine({ entry: item.entry, isGlobal: item.isGlobal ?? false }, framing, !hook, evalNow(), 100),
    ),
    fixed: (budget, can) =>
      price(contextHeading('Project Memory', budget, budget))
      + (can.cross ? price(crossProjectHeading(budget)) : 0)
      + (hook && can.promptRecall ? price(contextHeading('Prompt-Relevant Memory', budget, budget)) : 0)
      + (!hook && can.ambient ? price(`\n${renderAmbientSummary(WIDEST_AMBIENT)}`) : 0),
    snapshot: (s) => price(snapshotText(s)),
    handoff: (h) => price(handoffText(h)),
    trail: (events) => price(sessionTrailText(events)),
  };
}
