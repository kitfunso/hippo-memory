import { MemoryEntry } from '../core/memory.js';

export interface CorrectionPair {
  oldId: string;
  newId: string;
  correctedAt: string;
  observedAt: string;
  latencyMs: number;
  /** 'extraction' = new fact derived from a raw receipt; 'manual' = direct supersede call */
  via: 'extraction' | 'manual';
}

export interface CorrectionLatencyReport {
  count: number;
  manualCount: number;
  extractionCount: number;
  /** Percentiles computed over `extraction` pairs only — manual pairs have no measurable lag */
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  pairs: CorrectionPair[];
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Correction latency = `new.created` minus the observation time (the extracted-from row's `created`, else `new.created`).
 * Manual supersedes have latency 0 and are excluded from percentiles so they do not mask real lag. */
export function buildCorrectionLatency(entries: MemoryEntry[]): CorrectionLatencyReport {
  const byId = new Map<string, MemoryEntry>();
  for (const e of entries) byId.set(e.id, e);

  const pairs: CorrectionPair[] = [];
  for (const oldEntry of entries) {
    if (!oldEntry.superseded_by) continue;
    const newEntry = byId.get(oldEntry.superseded_by);
    if (!newEntry) continue;

    const correctedAt = newEntry.created;
    let observedAt = newEntry.created;
    let via: CorrectionPair['via'] = 'manual';
    if (newEntry.extracted_from) {
      const source = byId.get(newEntry.extracted_from);
      if (source) {
        observedAt = source.created;
        via = 'extraction';
      }
    }
    const correctedMs = new Date(correctedAt).getTime();
    const observedMs = new Date(observedAt).getTime();
    if (!Number.isFinite(correctedMs) || !Number.isFinite(observedMs)) continue;
    const latencyMs = Math.max(0, correctedMs - observedMs);
    pairs.push({
      oldId: oldEntry.id,
      newId: newEntry.id,
      correctedAt,
      observedAt,
      latencyMs,
      via,
    });
  }

  const extractionPairs = pairs.filter((p) => p.via === 'extraction');
  const sorted = extractionPairs.map((p) => p.latencyMs).sort((a, b) => a - b);

  return {
    count: pairs.length,
    manualCount: pairs.filter((p) => p.via === 'manual').length,
    extractionCount: extractionPairs.length,
    p50Ms: sorted.length === 0 ? null : percentile(sorted, 0.5),
    p95Ms: sorted.length === 0 ? null : percentile(sorted, 0.95),
    maxMs: sorted.length === 0 ? null : sorted[sorted.length - 1],
    pairs,
  };
}
