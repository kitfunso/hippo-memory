// The strings `hippo assemble` and `hippo drill` print over hippo.db's summary DAG, priced as a
// context block's are, so selection and print cannot drift.
import type { AssembleCost, AssembleResult, AssembledContextItem } from '../assemble.js';
import type {
  DrillDownChild,
  DrillDownCost,
  DrillDownResult,
  DrillDownSummary,
} from '../objects/drill-down.js';
import { printedTokens, settleTokens } from '../context/context-render.js';

export interface AssembleHeadingCounts {
  sessionId: string;
  items: number;
  tokens: number;
  totalRaw: number;
  summarized: number;
  evicted: number;
}

export function assembleHeading(c: AssembleHeadingCounts): string {
  return (
    `Session ${c.sessionId} \u2014 ${c.items} items, ${c.tokens} tokens (raw=${c.totalRaw}, ` +
    `summarized=${c.summarized}, evicted=${c.evicted})`
  );
}

export function assembleLine(it: AssembledContextItem): string {
  const prefix = it.isSummary ? '[summary]' : it.isFreshTail ? '[tail]' : '[older]';
  return `  ${prefix} ${it.createdAt} ${it.id} - ${it.content}`;
}

/** The window in full, as the MCP tool returns it; the header counts the whole block. */
export function assembleText(r: AssembleResult): string {
  return settleTokens((t) =>
    [
      assembleHeading({ ...r, items: r.items.length, tokens: t }),
      ...r.items.map(assembleLine),
    ].join('\n'),
  );
}

// Every format prices the full lines: JSON carries full content, and the CLI's previews are never
// longer.
export function assembleCost(sessionId: string): AssembleCost {
  return {
    item: (it) => printedTokens(assembleLine(it)),
    fixed: (w) =>
      printedTokens(
        assembleHeading({ sessionId, items: w, tokens: w, totalRaw: w, summarized: w, evicted: w }),
      ),
  };
}

function drillHead(s: DrillDownSummary, shown: number, total: number, truncated: boolean): string {
  const span = s.earliestAt ? ` (${s.earliestAt} -> ${s.latestAt})` : '';
  return (
    `Summary ${s.id} \u2014 ${s.descendantCount} descendants${span}\n  ${s.content}\n\nChildren ` +
    `(${shown}/${total}${truncated ? ', truncated' : ''}):`
  );
}

export function drillLine(c: DrillDownChild): string {
  return `  [L${c.dagLevel}] ${c.id} - ${c.content}`;
}

export function drillText(r: DrillDownResult): string {
  return [
    drillHead(r.summary, r.children.length, r.totalChildren, r.truncated),
    ...r.children.map(drillLine),
  ].join('\n');
}

export const drillCost: DrillDownCost = {
  child: (c) => printedTokens(drillLine(c)),
  fixed: (s, w) => printedTokens(drillHead(s, w, w, true)),
};
