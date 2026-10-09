// Text the MCP recall and context tools print, and what each printed piece costs the token budget.

import type { SearchResult } from '../core/search-types.js';
import type { SessionEvent, TaskSnapshot } from '../store/rows.js';
import { confidenceLabel } from '../memory.js';
import type { ContextCost, ContinuityBlock, RecallResult, RecallResultItem } from '../api.js';
import { formatHandoffEvidenceLine, type SessionHandoff } from '../handoff.js';
import { printedTokens } from '../context-render.js';
import { detectAnchoring } from '../recall-history.js';
import { detectAvailabilityBias } from '../availability.js';
import { estimateTokens } from '../util/token-text.js';

// ── Format helpers ──


function handoffLines(h: SessionHandoff): string[] {
  const lines = [`- Summary: ${h.summary}`];
  if (h.nextAction) lines.push(`- Next action: ${h.nextAction}`);
  if ((h.artifacts ?? []).length > 0) lines.push(`- Artifacts: ${(h.artifacts ?? []).join(', ')}`);
  if (h.outcome) lines.push(`- Outcome: ${h.outcome}`);
  if (h.targetRuntime) lines.push(`- Target runtime: ${h.targetRuntime}`);
  if (h.cardId) lines.push(`- Card: ${h.cardId}`);
  if ((h.constraints ?? []).length > 0) lines.push(`- Constraints: ${(h.constraints ?? []).join(', ')}`);
  if (h.evidence) lines.push(`- Evidence: ${formatHandoffEvidenceLine(h.evidence)}`);
  return lines;
}

function trailLines(events: readonly SessionEvent[]): string[] {
  return events.map((e) => {
    const preview = e.content.length > 200 ? e.content.slice(0, 200) + '…' : e.content;
    return `- [${e.event_type}] ${preview}`;
  });
}

export function formatContinuityBlock(block: ContinuityBlock): string {
  const lines: string[] = ['## Continuity'];
  if (block.activeSnapshot) {
    lines.push('');
    lines.push('### Active Task Snapshot');
    lines.push(`- Task: ${block.activeSnapshot.task}`);
    lines.push(`- Summary: ${block.activeSnapshot.summary}`);
    lines.push(`- Next: ${block.activeSnapshot.next_step}`);
  }
  if (block.sessionHandoff) {
    lines.push('');
    lines.push('### Session Handoff');
    lines.push(...handoffLines(block.sessionHandoff));
  }
  if (block.recentSessionEvents.length > 0) {
    lines.push('');
    lines.push('### Recent Session Trail');
    lines.push(...trailLines(block.recentSessionEvents));
  }
  if (lines.length === 1) {
    lines.push('');
    lines.push('(no active task snapshot, handoff, or recent events for this tenant)');
  }
  return lines.join('\n');
}

const NO_MEMORIES = 'No relevant memories found.';

function memoriesHeading(count: number): string {
  return `Found ${count} memories:\n`;
}

function formatMemory(r: Pick<SearchResult, 'entry'>): string {
  const conf = confidenceLabel(r.entry).text;
  const tags = r.entry.tags.length > 0 ? ` tags: ${r.entry.tags.join(', ')}` : '';
  return `[${conf}]${tags} (strength=${r.entry.strength.toFixed(2)})\n${r.entry.content}\n`;
}

export function formatMemories(results: ReadonlyArray<Pick<SearchResult, 'entry'>>): string {
  if (results.length === 0) return NO_MEMORIES;
  return [memoriesHeading(results.length), ...results.map(formatMemory)].join('\n');
}

export interface RenderedRecall {
  anchoring: ReturnType<typeof detectAnchoring>;
  availability: ReturnType<typeof detectAvailabilityBias>;
  text: string;
  list: SearchResult[];
}

// api.retrieve hands the ranking to a callback, so the render it produces comes back through this slot.
export interface RenderSlot {
  rendered?: RenderedRecall;
}

/** What a memory costs the budget: the text formatMemories prints for it. */
export const memoryCost = (r: Pick<SearchResult, 'entry'>): number => printedTokens(formatMemory(r));

// The widest heading or the empty-list line, whichever costs more, so either prints inside the budget.
export function memoriesReserve(budget: number): number {
  return Math.max(printedTokens(memoriesHeading(budget)), estimateTokens(NO_MEMORIES));
}

export function snapshotPiece(s: TaskSnapshot): string {
  return [
    '## Active Task Snapshot',
    `- Task: ${s.task}`,
    `- Status: ${s.status}`,
    `- Updated: ${s.updated_at}`,
    '',
    '### Summary',
    s.summary,
    '',
    '### Next step',
    s.next_step,
    '',
    '',
  ].join('\n');
}

export function handoffPiece(h: SessionHandoff): string {
  return ['## Session Handoff', ...handoffLines(h), '', ''].join('\n');
}

export function trailPiece(events: readonly SessionEvent[]): string {
  return ['## Recent Session Trail', ...trailLines(events), '', ''].join('\n');
}

// Sections print ahead of the memories in hippo_context, so getContext pays for each as printed before any memory.
export const contextCost: ContextCost = {
  entry: memoryCost,
  fixed: (budget) => memoriesReserve(budget),
  snapshot: (s) => estimateTokens(snapshotPiece(s)),
  handoff: (h) => estimateTokens(handoffPiece(h)),
  trail: (events) => estimateTokens(trailPiece(events)),
};

// Rows the ranked list already shows drop out of this section, so pricing every row bounds what it prints.
export function tailSection(rows: RecallResultItem[]): string {
  if (rows.length === 0) return '';
  const lines: string[] = ['', '## Fresh tail / substituted summaries'];
  for (const r of rows) {
    const tag = r.isSummary ? '[summary]' : '[tail]';
    const head = r.content.length > 200 ? r.content.slice(0, 200) + '…' : r.content;
    if (r.isSummary && r.substitutedFor && r.substitutedFor.length > 0) {
      lines.push(`- ${tag} ${r.id} (covers ${r.substitutedFor.length} rows): ${head}`);
    } else {
      lines.push(`- ${tag} ${r.id}: ${head}`);
    }
  }
  return '\n' + lines.join('\n');
}

// The hint depends on the query alone, so api.retrieve's copy is the one shown; JSON.stringify fences the phrase.
export function planningSection(r: RecallResult): string {
  if (r.planningFallacyHint) {
    const h = r.planningFallacyHint;
    return `## Planning fallacy hint\nClass: ${h.classTag}\n${h.baserateSummary}\n(detected: ${JSON.stringify(h.detectedPhrase)})\n\n---\n\n`;
  }
  if (r.planningFallacyWatching) {
    const w = r.planningFallacyWatching;
    return `## Planning fallacy watch\nReason: ${w.reason}\n${w.suggestion}\n(detected: ${JSON.stringify(w.detectedPhrase)})\n\n---\n\n`;
  }
  return '';
}
