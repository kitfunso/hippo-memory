import { DAG_LEVEL, Layer, type MemoryEntry } from '../../base/memory/memory.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { keptAsWritten, type SleepRun } from './run.js';
import { READ_PAGE_ROWS } from '../../base/util/pages.js';
import type { EntryCursor } from '../../store/port/types.js';
import { isReusable } from '../../base/memory/memory-quality.js';
import { isPermanentFailure, llmFailureFields, type Llm, type LlmFailure } from '../../base/ports/llm.js';

// Bounds the LLM calls one sleep spends on extraction.
const EXTRACTION_BATCH_LIMIT = 20;
// The ceiling keeps a misconfigured env from burning unbounded LLM cost.
const MAX_DAG_REBUILD_CAP = 1000;
const DEFAULT_DAG_REBUILD_CAP = 20;

/** The model, its options and the once-per-line error reporter every LLM phase shares. */
interface SleepLlm {
  readonly llmError: (phase: string) => (msg: string, failure?: LlmFailure) => void;
  readonly llmOpts: { readonly llm: Llm; readonly model?: string };
}

/** Null when no phase may call a model: none was handed in, or extraction.enabled=false opts every LLM phase out. */
function sleepLlm(run: SleepRun, llm: Llm | undefined): SleepLlm | null {
  const { config, result } = run;
  if (llm === undefined || config.extraction.enabled === false) return null;
  const llmErrorsSeen = new Set<string>();
  const llmError =
    (phase: string) =>
    (msg: string, failure?: LlmFailure): void => {
      const line = `  ⚠️ ${phase}: ${msg}`;
      if (llmErrorsSeen.has(line)) return;
      llmErrorsSeen.add(line);
      result.details.push(line);
      log.warn(`consolidate ${phase}: ${msg}`, failure && llmFailureFields(failure));
    };
  return { llmError, llmOpts: { llm, model: config.extraction.model } };
}

/** Counts the survivors extraction could read and returns the first `limit` of them, holding no others. */
async function extractionBatch(run: SleepRun, limit: number): Promise<MemoryEntry[]> {
  const extractedFromIds = new Set<string>();
  for await (const e of run.survivors.rows()) if (e.extractedFrom) extractedFromIds.add(e.extractedFrom);
  const batch: MemoryEntry[] = [];
  let candidates = 0;
  for await (const e of run.survivors.rows()) {
    const candidate =
      e.layer === Layer.Episodic &&
      !e.supersededBy &&
      !extractedFromIds.has(e.id) &&
      !keptAsWritten(e) &&
      e.traceOutcome === null &&
      e.source !== 'auto-promote' &&
      isReusable(e);
    if (!candidate) continue;
    if (candidates++ < limit) batch.push(e);
  }
  run.result.extractionCandidates = candidates;
  return batch;
}

export async function llmPasses(run: SleepRun, model: Llm | undefined): Promise<void> {
  const llm = sleepLlm(run, model);
  // 1.6. Batch extraction: extract facts from episodic memories missing them
  const batch = await extractionBatch(run, llm && !run.dryRun ? EXTRACTION_BATCH_LIMIT : 0);
  // Every sleep counts the candidates; only one that may call a model goes on.
  if (llm === null || run.dryRun) return;
  if (batch.length > 0) {
    const stopped = await extractionPass(run, llm, batch);
    // The DAG passes call the same API with the same key and model, so they would fail the same way.
    if (stopped) return;
  }

  await dagBuildPass(run, llm);
  await dagRebuildPass(run, llm);
  await entityProfilePass(run, llm);
}

/**
 * Extracts facts from each candidate; true when it stopped on a failure every later call would repeat (bad key, no
 * credit, unknown model).
 */
async function extractionPass(run: SleepRun, llm: SleepLlm, batch: readonly MemoryEntry[]): Promise<boolean> {
  const { extractFacts, storeExtractedFacts } = await import('../learn/extract.js');
  const report = llm.llmError('extraction');
  let extractedCount = 0;
  let stopped = false;
  const onError = (msg: string, failure?: LlmFailure): void => {
    report(msg, failure);
    if (failure && isPermanentFailure(failure)) stopped = true;
  };
  for (const [index, candidate] of batch.entries()) {
    try {
      const facts = await extractFacts(candidate.content, { ...llm.llmOpts, onError });
      if (facts.length > 0) {
        const stored = await storeExtractedFacts(run.store, candidate, facts, run.config.defaultHalfLifeDays);
        extractedCount += stored.length;
      }
    } catch (err) {
      report(errorMessage(err));
      log.warn('consolidate extraction threw', errorFields(err));
    }
    if (stopped) {
      const skipped = batch.length - index - 1;
      report(
        `stopped after a failure that will not clear on retry; ${skipped} of ${batch.length} candidates skipped, and ` +
          `the DAG passes with them`,
      );
      break;
    }
  }
  run.result.extracted = extractedCount;
  return stopped;
}

// 1.7. DAG summarization — cluster extracted facts and generate summaries
async function dagBuildPass(run: SleepRun, { llmError, llmOpts }: SleepLlm): Promise<void> {
  // buildDag clusters only unparented facts, so only those are held; the gate counts every fact as it always did.
  const extractedFacts: MemoryEntry[] = [];
  let facts = 0;
  for await (const e of run.survivors.rows()) {
    if (!(e.tags.includes('extracted') && e.dagLevel === DAG_LEVEL.extracted && !e.supersededBy && isReusable(e))) {
      continue;
    }
    facts++;
    if (!e.dagParentId) extractedFacts.push(e);
  }
  if (facts < 3) return;
  try {
    const { buildDag } = await import('./dag.js');
    const dagResult = await buildDag(run.store, extractedFacts, {
      ...llmOpts,
      onError: llmError('dag'),
      baseHalfLifeDays: run.config.defaultHalfLifeDays,
    });
    run.result.dagCandidateClusters = dagResult.candidateClusters;
    run.result.dagSummariesCreated = dagResult.summariesCreated;
    if (dagResult.summariesCreated > 0) {
      run.result.details.push(
        `  🌳 DAG: ${dagResult.summariesCreated} summaries created, ${dagResult.factsLinked} facts linked`,
      );
    }
  } catch (err) {
    llmError('dag')(errorMessage(err));
    log.warn('consolidate dag threw', errorFields(err));
  }
}

// 1.8. DAG summary rebuild: drain the summary_dirty queue set by child-write hooks; same model/dryRun gate as
// buildDag.
// Cap HIPPO_DAG_REBUILD_CAP, as the root read it (default 20, hard ceiling 1000), prevents runaway LLM cost.
async function dagRebuildPass(run: SleepRun, { llmError, llmOpts }: SleepLlm): Promise<void> {
  const { result } = run;
  try {
    const { rebuildDirtySummaries } = await import('./dag.js');
    const rawCap = run.config.runtime?.dagRebuildCap;
    const cap = rawCap !== undefined ? Math.min(rawCap, MAX_DAG_REBUILD_CAP) : DEFAULT_DAG_REBUILD_CAP;
    const rebuildResult = await rebuildDirtySummaries(run.store, {
      ...llmOpts,
      onError: llmError('dag rebuild'),
      cap,
    });
    result.summariesRebuilt = rebuildResult.rebuilt;
    result.summariesRebuildFailed = rebuildResult.failed;
    result.summariesZeroChildSkipped = rebuildResult.zeroChildSkipped;
    result.summariesRebuildRefused = rebuildResult.refused;
    result.summariesRebuildCapped = rebuildResult.capped;
    if (
      rebuildResult.rebuilt > 0 ||
      rebuildResult.zeroChildSkipped > 0 ||
      rebuildResult.failed > 0 ||
      rebuildResult.refused > 0
    ) {
      const parts: string[] = [];
      if (rebuildResult.rebuilt > 0) parts.push(`${rebuildResult.rebuilt} rebuilt`);
      if (rebuildResult.refused > 0) parts.push(`${rebuildResult.refused} refused`);
      if (rebuildResult.zeroChildSkipped > 0) parts.push(`${rebuildResult.zeroChildSkipped} zero-child-skipped`);
      if (rebuildResult.failed > 0) parts.push(`${rebuildResult.failed} failed`);
      if (rebuildResult.capped) parts.push(`CAPPED@${cap}`);
      result.details.push(`  🌳 DAG rebuild: ${parts.join(', ')}`);
    }
  } catch (err) {
    llmError('dag rebuild')(errorMessage(err));
    log.warn('consolidate dag rebuild threw', errorFields(err));
  }
}

/** Every unprofiled L2 summary, one keyset page per store call: clustering needs them all, a statement need not. */
async function allUnprofiledTopicSummaries(store: SleepRun['store']['consolidation']): Promise<MemoryEntry[]> {
  const all: MemoryEntry[] = [];
  for (let after: EntryCursor | undefined; ;) {
    const page = await store.unprofiledTopicSummaries({ limit: READ_PAGE_ROWS, after });
    all.push(...page.entries);
    if (page.next === null) return all;
    after = page.next;
  }
}

// 1.9. DAG entity profiles: cluster L2 summaries into per-entity L3 profiles; runs even when 1.7 was skipped
// (re-clusters existing L2s every sleep).
// Reads the stored L2s, not `survivors`: phase 1.7 wrote new L2s via writeEntry without pushing them into survivors.
async function entityProfilePass(run: SleepRun, { llmError, llmOpts }: SleepLlm): Promise<void> {
  try {
    const { buildEntityProfiles } = await import('./dag.js');
    const l2Summaries = await allUnprofiledTopicSummaries(run.store.consolidation);
    if (l2Summaries.length >= 2) {
      const profileResult = await buildEntityProfiles(run.store, l2Summaries, {
        ...llmOpts,
        onError: llmError('dag profiles'),
        baseHalfLifeDays: run.config.defaultHalfLifeDays,
      });
      run.result.entityProfilesCreated = profileResult.profilesCreated;
      if (profileResult.profilesCreated > 0) {
        run.result.details.push(
          `  🌲 DAG L3: ${profileResult.profilesCreated} entity profiles, ${profileResult.l2sLinked} L2s linked`,
        );
      }
    }
  } catch (err) {
    llmError('dag profiles')(errorMessage(err));
    log.warn('consolidate dag profiles threw', errorFields(err));
  }
}
