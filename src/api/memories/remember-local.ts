import type { ConfidenceLevel, Layer, MemoryEntry, MemoryKind } from '../../base/memory/entry.js';
import {
  embedMemoryInto,
  folderEmbedTarget,
  type EmbedOutcome,
} from '../../domain/search/embed-memories.js';
import { captureError, type FailedCommand } from '../../domain/learn/autolearn.js';
import { extractFacts, storeExtractedFacts } from '../../domain/learn/extract.js';
import { isUntrustedSource } from '../../domain/trust/instruction-detect.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { withDetached } from '../detached.js';
import { memoryGet } from './memories.js';
import { remember } from './remember.js';
import type { Context, ContextWith } from '../types.js';

export { extractPathTags } from '../../domain/search/path-context.js';

/** One write by a caller in this process, every field already parsed and checked by it. */
export interface LocalRememberInput {
  readonly content: string;
  readonly tags: readonly string[];
  readonly fitTags?: readonly string[];
  readonly kind?: MemoryKind;
  readonly scope?: string;
  readonly owner?: string;
  readonly artifactRef?: string;
  readonly leadIn?: string;
  readonly layer?: Layer;
  readonly pinned?: boolean;
  readonly confidence?: ConfidenceLevel;
  readonly source?: string;
  readonly force?: boolean;
}

/** The gate's start-weak verdict as the stored row carries it. */
export interface StartedWeak {
  readonly reason: string;
  readonly strength: number;
}

/** `stored` carries the row as the store holds it after the write, and `embedding`, which
 * settles with whether the row reached the vector index (the Context's keeper also holds it, so a
 * caller may drop it; a failure is logged). `skipped` is the gate dropping the write, with nothing
 * stored or counted. */
export type LocalRememberOutcome =
  | {
      readonly status: 'stored';
      readonly entry: MemoryEntry;
      readonly embedding: Promise<EmbedOutcome>;
      readonly startedWeak?: StartedWeak;
      readonly warnings: readonly string[];
    }
  | { readonly status: 'skipped'; readonly reason: string; readonly score: number };

async function storedEntry(ctx: Context, id: string): Promise<MemoryEntry> {
  const entry = await memoryGet(ctx, id);
  if (!entry) throw new Error(`memory ${id} was written but cannot be read back`);
  return entry;
}

function indexInBackground(ctx: Context, entry: MemoryEntry): Promise<EmbedOutcome> {
  const folder = { store: ctx.store, config: ctx.config, embedderFor: ctx.infra.embedderFor };
  const target = folderEmbedTarget(folder, ctx.infra);
  return embedMemoryInto(target, entry).then((outcome) => {
    if (outcome === 'failed') {
      log.warn(
        `memory ${entry.id} is stored but not in the vector index, so recall by meaning will miss it; run 'hippo embed' to index it`,
      );
    }
    return outcome;
  });
}

/** One local write on hippo.db: gate, write, read-back, counter, then the embedding, which the
 * Context's keeper owns; with none, the call waits for it. A refused value throws as `remember` does. */
export async function rememberLocally(
  ctx: Context,
  input: LocalRememberInput,
): Promise<LocalRememberOutcome> {
  const schemaFit = await ctx.store.contextReads.schemaFit(
    ctx.tenantId,
    input.content,
    input.fitTags ?? input.tags,
  );
  const written = await remember(ctx, {
    content: input.content,
    kind: input.kind,
    scope: input.scope,
    owner: input.owner,
    artifactRef: input.artifactRef,
    leadIn: input.leadIn,
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
  await ctx.store.bumpRemembered(1);
  return withDetached(ctx, (detached): LocalRememberOutcome => {
    const embedding = indexInBackground(ctx, entry);
    detached.detach(embedding);
    return startedWeak
      ? { status: 'stored', entry, embedding, warnings, startedWeak }
      : { status: 'stored', entry, embedding, warnings };
  });
}

/** What a caller asks of fact extraction; the model is the one its Context carries. */
export interface FactExtractionRequest {
  readonly requested: boolean;
}

/** `off`: nobody asked. `no_key`: asked, with no key to call the model. `ran`: the facts the
 * model gave and each reason it gave fewer. */
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
  const { llm } = ctx.infra;
  if (!llm) return { status: 'no_key' };
  const failures: string[] = [];
  let facts = 0;
  try {
    const found = await extractFacts(extractionText(entry), {
      llm,
      model: extraction.model,
      signal: ctx.signal,
      onError: (msg) => {
        failures.push(msg);
      },
    });
    if (found.length > 0) {
      await storeExtractedFacts(ctx.store, {
        source: entry,
        facts: found,
        baseHalfLifeDays: defaultHalfLifeDays,
        now: ctx.infra.clock(),
      });
      facts = found.length;
    }
  } catch (cause) {
    log.debug('remember: a fact step failed', errorFields(cause));
    failures.push(errorMessage(cause));
  }
  return { status: 'ran', facts, failures };
}

function extractionText(entry: MemoryEntry): string {
  if (!entry.leadIn || isUntrustedSource(entry.tags)) return entry.content;
  return `Earlier in the conversation (context only):\n${entry.leadIn}\n\nThe memory:\n${entry.content}`;
}

/** What `hippo watch` keeps of a command that failed: its redacted stderr as an episodic row,
 * stored every time, since watch has never put a failure to the salience gate. */
export async function rememberFailedCommand(
  ctx: Context,
  failed: FailedCommand,
): Promise<LocalRememberOutcome> {
  const { content, tags, layer, source, confidence } = captureError(
    failed,
    ctx.tenantId,
    ctx.infra.clock(),
  );
  return rememberLocally(ctx, { content, tags, layer, source, confidence, force: true });
}
