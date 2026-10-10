// Text printers for recall results, agent imports, task snapshots, session trails and handoffs.

import { confidenceLabel } from '../core/memory.js';
import type { TaskSnapshot, SessionEvent } from '../store/rows.js';
import type { SessionHandoff } from '../core/handoff.js';
import type { SearchResult } from '../core/search-types.js';
import { explainMatch } from '../search/explain.js';
import { type ImportReport, summaryLine } from '../agent-memories/report.js';
import { snapshotText, sessionTrailText, handoffText } from '../api/context-render.js';
import { printError } from './output.js';

export function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

// What `hippo recall` prints for one result; the budget prices this same text.
export function recallEntryText(r: SearchResult, query: string, showWhy: boolean, isGlobal: boolean): string {
  const e = r.entry;
  const label = confidenceLabel(e);
  const confLabel = label.warn ? `[${label.text}] ⚠️` : `[${label.text}]`;
  const bars = Math.round(e.strength * 10);
  const graphMark = r.graphVia ? ` [graph: ${r.graphVia.hops}hop ${r.graphVia.relType}]` : '';
  const lines = [
    `--- ${e.id} [${e.layer}] ${confLabel}${isGlobal ? ' [global]' : ''}${e.superseded_by ? ' [superseded]' : ''}${graphMark} score=${fmt(r.score, 3)} strength=${fmt(e.strength)}`,
    `    [${'█'.repeat(bars)}${'░'.repeat(10 - bars)}] tags: ${e.tags.join(', ') || 'none'} | retrieved: ${e.retrieval_count}x`,
  ];
  if (showWhy) {
    const explanation = explainMatch(query, r);
    lines.push(`    source:${isGlobal ? ' [global]' : ' [local]'} | layer: [${e.layer}] | confidence: [${label.text}]`, `    reason: ${explanation.reason}`);
    const env = explanation.envelope;
    if (env) {
      lines.push(`    kind: ${env.kind}`);
      if (env.scope) lines.push(`    scope: ${env.scope}`);
      if (env.owner) lines.push(`    owner: ${env.owner}`);
      if (env.artifact_ref) lines.push(`    artifact_ref: ${env.artifact_ref}`);
      if (env.session_id) lines.push(`    session_id: ${env.session_id}`);
      lines.push(`    confidence: ${env.confidence}`);
    }
    // The recall trace, e.g. "ranking: base 0.420 -> interference x0.30 -> 0.126 -> goal-boost x1.50 -> 0.189".
    if (r.rerankTrace && r.rerankTrace.length > 0) {
      const parts = [`base ${fmt(r.rerankTrace[0].scoreBefore, 3)}`];
      for (const step of r.rerankTrace) {
        parts.push(`${step.stage}${step.multiplier !== undefined ? ` x${fmt(step.multiplier, 2)}` : ''}`, fmt(step.scoreAfter, 3));
      }
      lines.push(`    ranking: ${parts.join(' -> ')}`);
    }
  }
  lines.push('', e.content, '');
  return lines.join('\n');
}

export function recallHeading(entries: number, tokens: number, query: string): string {
  return `Found ${entries} memories (${tokens} tokens) for: "${query}"\n`;
}

/** One line when an agent memory import moved anything; its warnings go to stderr. */
export function printAgentImport(report: ImportReport, indent = '   '): void {
  const line = summaryLine(report);
  if (line !== null) console.log(`${indent}${line}`);
  for (const warning of report.warnings) printError(`hippo: agent memories: ${warning}`);
}

export function printActiveTaskSnapshot(snapshot: TaskSnapshot): void {
  console.log(snapshotText(snapshot));
}

export function printSessionEvents(events: SessionEvent[]): void {
  console.log(events.length === 0 ? 'No session events found.' : sessionTrailText(events));
}

export function printHandoff(handoff: SessionHandoff): void {
  console.log(handoffText(handoff));
}

/**
 * Run `fn` with console.log captured; returns the captured lines joined by
 * newlines (what the same calls would have printed, minus the final newline).
 */
export function captureConsole(fn: () => void): string {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try {
    fn();
  } finally {
    console.log = realLog;
  }
  return lines.join('\n');
}
