// The local remember pipeline for a caller in this process (`hippo remember`, `hippo watch`): schema fit, the salience
// gate, the write, the read-back, the `remembered` counter and the embedding kick-off, in that order. Fact extraction
// is a second step, which the caller runs after it has reported the write. Nothing here prints; the caller reports from
// what comes back.

import type { ConfidenceLevel, Layer, MemoryEntry, MemoryKind } from '../../base/memory/memory.js';
import { embedMemory, folderIndex, type EmbedOutcome } from '../../domain/search/embed-memories.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { memoryGet } from './memories.js';
import { remember } from './remember.js';
import type { Context, ContextWith } from '../types.js';
import { infraOf } from '../infra.js';

// The tags a caller in this process adds from the folder it runs in.
export { extractPathTags } from '../../domain/search/path-context.js';

/** One write by a caller in this process, every field already parsed and checked by it. */
export interface LocalRememberInput {
  readonly content: string;
  /** Every tag the row stores; the salience gate reads these. */
  readonly tags: readonly string[];
  /** The tags schema fit is scored on, for a caller that added path and scope tags of its own to `tags`; without it,
   * `tags`. */
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

/** `stored` carries the row as the store holds it after the write, and `embedding`, which settles with whether the row
 * reached the vector index (a caller may ignore it; a failure is also logged). `skipped` is the gate dropping the
 * write, with nothing stored or counted. */
export type LocalRememberOutcome =
  | {
      readonly status: 'stored';
      readonly entry: MemoryEntry;
      readonly embedding: Promise<EmbedOutcome>;
      readonly startedWeak?: StartedWeak;
      /** What remember said about secret material it redacted. */
      readonly warnings: readonly string[];
    }
  | { readonly status: 'skipped'; readonly reason: string; readonly score: number };

/**
 * The row `remember` just wrote, as the store holds it: the report, the embedding and the extraction all work on that.
 */
async function storedEntry(ctx: Context, id: string): Promise<MemoryEntry> {
  const entry = await memoryGet(ctx, id);
  if (!entry) throw new Error(`memory ${id} was written but cannot be read back`);
  return entry;
}

/** Best-effort and slow (a model load or a network call), so the caller is not held for it; a row left out of the index
 * is logged. */
function indexInBackground(ctx: Context, entry: MemoryEntry): Promise<EmbedOutcome> {
  const target = folderIndex({ store: ctx.store, config: ctx.config, embedderFor: infraOf(ctx).embedderFor });
  return embedMemory(target, entry).then((outcome) => {
    if (outcome === 'failed') {
      log.warn(
        `memory ${entry.id} is stored but not in the vector index, so recall by meaning will miss it; run 'hippo embed' to index it`,
      );
    }
    return outcome;
  });
}

/** One local write on hippo.db: gate, write, read-back, counter, then the embedding, started and never awaited. A
 * refused value throws as `remember` does. */
export async function rememberLocally(ctx: Context, input: LocalRememberInput): Promise<LocalRememberOutcome> {
  const schemaFit = await ctx.store.contextReads.schemaFit(ctx.tenantId, input.content, input.fitTags ?? input.tags);
  const written = await remember(ctx, {
    content: input.content,
    kind: input.kind,
    scope: input.scope,
    owner: input.owner,
    artifactRef: input.artifactRef,
    tags: [...input.tags],
    salienceGate: input.force !== true,
    local: {
      layer: input.layer,
      pinned: input.pinned,
      source: input.source,
      confidence: input.confidence,
      schemaFit,
    },
  });
  if ('skipped' in written) return { status: 'skipped', ...written.skipped };
  const { id, warnings = [], startedWeak } = written;
  const entry = await storedEntry(ctx, id);
  await ctx.store.lessonWrites.bumpRemembered(1);
  const embedding = indexInBackground(ctx, entry);
  return startedWeak
    ? { status: 'stored', entry, embedding, warnings, startedWeak }
    : { status: 'stored', entry, embedding, warnings };
}

/** What a caller asks of fact extraction; the model is the one its Context carries. */
export interface FactExtractionRequest {
  /** The caller asked for extraction (`--extract`); the store's config can turn it on without that. */
  readonly requested: boolean;
}

/** `off`: nobody asked. `no_key`: asked, with no key to call the model. `ran`: the facts the model gave and each reason
 * it gave fewer. */
export type FactExtraction =
  | { readonly status: 'off' }
  | { readonly status: 'no_key' }
  | { readonly status: 'ran'; readonly facts: number; readonly failures: readonly string[] };

/** Extracts facts from a row just stored and stores them beside it.
 * Best-effort: a failure is named in the result, never thrown. */
export async function extractRememberedFacts(
  ctx: ContextWith<'learning'>,
  entry: MemoryEntry,
  request: FactExtractionRequest,
): Promise<FactExtraction> {
  const { extraction, defaultHalfLifeDays } = ctx.config;
  if (!request.requested && extraction.enabled !== true) return { status: 'off' };
  const { llm } = infraOf(ctx);
  if (!llm) return { status: 'no_key' };
  const failures: string[] = [];
  let facts = 0;
  try {
    // Loaded on demand, so a write that extracts nothing does not pay for the module.
    const { extractFacts, storeExtractedFacts } = await import('../../domain/learn/extract.js');
    const found = await extractFacts(entry.content, {
      llm,
      model: extraction.model,
      onError: (msg) => {
        failures.push(msg);
      },
    });
    if (found.length > 0) {
      await storeExtractedFacts(ctx.store, entry, found, defaultHalfLifeDays);
      facts = found.length;
    }
  } catch (cause) {
    log.debug('remember: a fact step failed', errorFields(cause));
    failures.push(errorMessage(cause));
  }
  return { status: 'ran', facts, failures };
}
