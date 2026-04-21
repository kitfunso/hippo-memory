/**
 * Trace-layer helpers.
 *
 * A trace is a `MemoryEntry` with `layer === 'trace'` that captures an ordered
 * sequence of agent actions and their final outcome. v1 stores steps as
 * markdown in `content`; `renderTraceContent` is the canonical formatter.
 */

export interface TraceStep {
  action: string;
  observation: string;
  timestamp?: string;
}

export interface TraceRecord {
  task: string;
  steps: TraceStep[];
  outcome: 'success' | 'failure' | 'partial';
}

/**
 * Render a trace record as agent-readable markdown.
 *
 * Format:
 *   Task: <task>
 *   Outcome: <outcome>
 *   Steps:
 *     1. <action>
 *        → <observation>   (omitted if observation is empty)
 *     2. ...
 */
export function renderTraceContent(rec: TraceRecord): string {
  const lines: string[] = [];
  lines.push(`Task: ${rec.task}`);
  lines.push(`Outcome: ${rec.outcome}`);
  lines.push('Steps:');
  rec.steps.forEach((s, i) => {
    lines.push(`  ${i + 1}. ${s.action}`);
    if (s.observation) {
      lines.push(`     \u2192 ${s.observation}`);
    }
  });
  return lines.join('\n');
}

/**
 * Parse a JSON string into an array of TraceStep. Throws on invalid shape.
 */
export function parseSteps(json: string): TraceStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Invalid trace steps JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('trace steps must be an array');
  }
  return parsed.map((s, i) => {
    if (typeof s !== 'object' || s === null) {
      throw new Error(`trace step ${i}: not an object`);
    }
    const rec = s as Record<string, unknown>;
    if (typeof rec['action'] !== 'string') {
      throw new Error(`trace step ${i}: missing action`);
    }
    const step: TraceStep = {
      action: rec['action'] as string,
      observation: typeof rec['observation'] === 'string' ? (rec['observation'] as string) : '',
    };
    if (typeof rec['timestamp'] === 'string') {
      step.timestamp = rec['timestamp'] as string;
    }
    return step;
  });
}
