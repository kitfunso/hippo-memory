import type { RawProvenance } from '../store/port/reports.js';

export interface ProvenanceCoverage {
  rawTotal: number;
  rawWithEnvelope: number;
  coverage: number;
  gaps: Array<{ id: string; missing: ('owner' | 'artifact_ref')[] }>;
}

/**
 * Provenance coverage gate: every `kind='raw'` row must carry `owner` and `artifact_ref`; derivative or terminal rows
 * are excluded.
 * Coverage 1.0 on a non-empty raw set is the ship gate. */
export function buildProvenanceCoverage(raw: RawProvenance): ProvenanceCoverage {
  const gaps: ProvenanceCoverage['gaps'] = [];
  for (const row of raw.gaps) {
    const missing: ('owner' | 'artifact_ref')[] = [];
    if (!row.owner) missing.push('owner');
    if (!row.artifactRef) missing.push('artifact_ref');
    if (missing.length > 0) gaps.push({ id: row.id, missing });
  }
  const rawWithEnvelope = raw.total - gaps.length;
  const coverage = raw.total === 0 ? 1 : rawWithEnvelope / raw.total;
  return { rawTotal: raw.total, rawWithEnvelope, coverage, gaps };
}
