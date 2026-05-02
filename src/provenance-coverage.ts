import { MemoryEntry } from './memory.js';

export interface ProvenanceCoverage {
  rawTotal: number;
  rawWithEnvelope: number;
  coverage: number;
  gaps: Array<{ id: string; missing: ('owner' | 'artifact_ref')[] }>;
}

/**
 * Provenance coverage gate: every `kind='raw'` row must carry both `owner`
 * and `artifact_ref`. Distilled / superseded / archived rows are excluded —
 * those are derivative or terminal, not source receipts. Coverage of 1.0 on
 * a non-empty raw set is the ship gate from the Company Brain scorecard.
 */
export function buildProvenanceCoverage(entries: MemoryEntry[]): ProvenanceCoverage {
  const raws = entries.filter((e) => e.kind === 'raw');
  const gaps: ProvenanceCoverage['gaps'] = [];
  for (const e of raws) {
    const missing: ('owner' | 'artifact_ref')[] = [];
    if (!e.owner) missing.push('owner');
    if (!e.artifact_ref) missing.push('artifact_ref');
    if (missing.length > 0) gaps.push({ id: e.id, missing });
  }
  const rawWithEnvelope = raws.length - gaps.length;
  const coverage = raws.length === 0 ? 1 : rawWithEnvelope / raws.length;
  return { rawTotal: raws.length, rawWithEnvelope, coverage, gaps };
}
