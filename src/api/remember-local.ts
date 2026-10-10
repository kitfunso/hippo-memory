// The local remember pipeline for a caller in this process (`hippo remember`, `hippo watch`): schema fit, the salience gate, the
// write, the read-back, the `remembered` counter and the embedding kick-off, in that order. Fact extraction is a second step,
// which the caller runs after it has reported the write. Nothing here prints; the caller reports from what comes back.

import { loadConfig } from '../core/config.js';
import type { ConfidenceLevel, Layer, MemoryEntry, MemoryKind } from '../core/memory.js';
import { computeSalience, type SalienceResult } from '../core/salience.js';
import { loadNewestEntries, schemaFitInStore } from '../store/candidates.js';
import { embedMemory } from '../store/embeddings/index.js';
import { loadAllEntries, readEntry } from '../store/entry-reads.js';
import { updateStats } from '../store/index-and-stats.js';
import { errorMessage } from '../util/log.js';
import { remember } from './remember.js';
import type { HippoDbContext } from './types.js';

const WEAK_HALF_LIFE_FACTOR = 0.5;

/** One write by a caller in this process, every field already parsed and checked by it. */
export interface LocalRememberInput {
  readonly content: string;
  /** Every tag the row stores; the salience gate reads these. */
  readonly tags: readonly string[];
  /** The tags schema fit is scored on, for a caller that added path and scope tags of its own to `tags`; without it, `tags`. */
  readonly fitTags?: readonly string[];
  readonly kind?: MemoryKind;
  readonly scope?: string;
  readonly owner?: string;
  readonly artifactRef?: string;
  readonly layer?: Layer;
  readonly pinned?: boolean;
  readonly confidence?: ConfidenceLevel;
  readonly source?: string;
  /** Store it whatever the salience gate would say, as `hippo remember --force` asks and `hippo watch` always does. */
  readonly force?: boolean;
}

/** The gate's start-weak verdict as the stored row carries it. */
export interface StartedWeak {
  readonly reason: string;
  readonly strength: number;
}

/** `stored` carries the row as the store holds it after the write; `skipped` is the gate dropping the write, with nothing stored or counted. */
export type LocalRememberOutcome =
  | { readonly status: 'stored'; readonly entry: MemoryEntry; readonly startedWeak?: StartedWeak }
  | { readonly status: 'skipped'; readonly reason: string; readonly score: number };

/** The gate's verdict on one write, or null where it does not judge: the store has it off, or the write is pinned or forced. */
function salienceVerdict(ctx: HippoDbContext, input: LocalRememberInput): SalienceResult | null {
  const { salience } = loadConfig(ctx.hippoRoot);
  if (!salience.enabled || input.pinned || input.force) return null;
  // computeSalience compares against the last `recentWindow` rows only; below 1 its slice takes every row, so that case still loads them all.
  const window = Math.trunc(salience.recentWindow);
  const recent = Number.isSafeInteger(window) && window >= 1
    ? loadNewestEntries(ctx.hippoRoot, ctx.tenantId, window)
    : loadAllEntries(ctx.hippoRoot, ctx.tenantId);
  return computeSalience(input.content, [...input.tags], recent, {
    recentWindow: salience.recentWindow,
    overlapThreshold: salience.overlapThreshold,
    minContentLength: salience.minContentLength,
    maxRepeatErrors: salience.maxRepeatErrors,
  });
}

/** The row `remember` just wrote, as the store holds it: the report, the embedding and the extraction all work on that. */
function storedEntry(ctx: HippoDbContext, id: string): MemoryEntry {
  const entry = readEntry(ctx.hippoRoot, id, ctx.tenantId);
  if (!entry) throw new Error(`memory ${id} was written but cannot be read back`);
  return entry;
}

/** One local write on hippo.db: gate, write, read-back, counter, then the embedding, started and never awaited. A refused value throws as `remember` does. */
export function rememberLocally(ctx: HippoDbContext, input: LocalRememberInput): LocalRememberOutcome {
  const schemaFit = schemaFitInStore(ctx.hippoRoot, ctx.tenantId, input.content, input.fitTags ?? input.tags);
  const verdict = salienceVerdict(ctx, input);
  if (verdict?.decision === 'skip') return { status: 'skipped', reason: verdict.reason, score: verdict.score };
  const startedWeak = verdict?.decision === 'start_weak' ? { reason: verdict.reason, strength: verdict.score } : undefined;
  const { id } = remember(ctx, {
    content: input.content,
    kind: input.kind,
    scope: input.scope,
    owner: input.owner,
    artifactRef: input.artifactRef,
    tags: [...input.tags],
    local: {
      layer: input.layer,
      pinned: input.pinned,
      source: input.source,
      confidence: input.confidence,
      schemaFit,
      weaken: startedWeak && { strength: startedWeak.strength, halfLifeFactor: WEAK_HALF_LIFE_FACTOR },
    },
  });
  const entry = storedEntry(ctx, id);
  updateStats(ctx.hippoRoot, { remembered: 1 });
  // Best-effort and slow (a model load or a network call), so the caller is not held for it.
  void embedMemory(ctx.hippoRoot, entry);
  return startedWeak ? { status: 'stored', entry, startedWeak } : { status: 'stored', entry };
}

/** What a caller asks of fact extraction. The key comes from the caller, which read it from its own environment. */
export interface FactExtractionRequest {
  /** The caller asked for extraction (`--extract`); the store's config can turn it on without that. */
  readonly requested: boolean;
  readonly apiKey?: string;
  readonly fetcher?: typeof fetch;
}

/** `off`: nobody asked. `no_key`: asked, with no key to call the model. `ran`: the facts the model gave and each reason it gave fewer. */
export type FactExtraction =
  | { readonly status: 'off' }
  | { readonly status: 'no_key' }
  | { readonly status: 'ran'; readonly facts: number; readonly failures: readonly string[] };

/** Extracts facts from a row just stored and stores them beside it. Best-effort: a failure is named in the result, never thrown. */
export async function extractRememberedFacts(ctx: HippoDbContext, entry: MemoryEntry, request: FactExtractionRequest): Promise<FactExtraction> {
  const { extraction } = loadConfig(ctx.hippoRoot);
  if (!request.requested && extraction.enabled !== true) return { status: 'off' };
  const { apiKey, fetcher } = request;
  if (!apiKey) return { status: 'no_key' };
  const failures: string[] = [];
  let facts = 0;
  try {
    // Loaded on demand, so a write that extracts nothing does not pay for the module.
    const { extractFacts, storeExtractedFacts } = await import('../learn/extract.js');
    const found = await extractFacts(entry.content, { apiKey, model: extraction.model, fetcher, onError: (msg) => { failures.push(msg); } });
    if (found.length > 0) {
      storeExtractedFacts(ctx.hippoRoot, entry, found);
      facts = found.length;
    }
  } catch (cause) {
    failures.push(errorMessage(cause));
  }
  return { status: 'ran', facts, failures };
}
