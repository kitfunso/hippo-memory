import { envAnthropicApiKey, envDagRebuildCap } from '../util/env.js';
import { DAG_LEVEL, Layer, type MemoryEntry } from '../core/memory.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { keptAsWritten, type SleepRun } from './run.js';
import { isReusable } from '../core/memory-quality.js';
import { type AnthropicMessageFailure, isPermanentFailure } from '../util/anthropic-messages.js';

// Bounds the LLM calls one sleep spends on extraction.
const EXTRACTION_BATCH_LIMIT = 20;

/** The key, model options and once-per-line error reporter every LLM phase shares. */
function sleepLlm(run: SleepRun, fetcher: typeof fetch | undefined) {
  const { config, result } = run;
  // extraction.enabled=false is the opt-out for every LLM phase below, key or no key.
  const apiKey = config.extraction.enabled !== false ? (envAnthropicApiKey() ?? '') : '';
  const llmErrorsSeen = new Set<string>();
  const llmError = (phase: string) => (msg: string): void => {
    const line = `  ⚠️ ${phase}: ${msg}`;
    if (llmErrorsSeen.has(line)) return;
    llmErrorsSeen.add(line);
    result.details.push(line);
    log.warn(`consolidate ${phase}: ${msg}`);
  };
  const llmOpts = { apiKey, model: config.extraction.model, fetcher };
  return { apiKey, llmError, llmOpts };
}

type SleepLlm = ReturnType<typeof sleepLlm>;

/** Counts the survivors extraction could read and returns the first `limit` of them, holding no others. */
function extractionBatch(run: SleepRun, limit: number): MemoryEntry[] {
  const extractedFromIds = new Set<string>();
  for (const e of run.survivors.rows()) if (e.extracted_from) extractedFromIds.add(e.extracted_from);
  const batch: MemoryEntry[] = [];
  let candidates = 0;
  for (const e of run.survivors.rows()) {
    const candidate = e.layer === Layer.Episodic && !e.superseded_by && !extractedFromIds.has(e.id) && !keptAsWritten(e)
      && e.trace_outcome === null && e.source !== 'auto-promote' && isReusable(e);
    if (!candidate) continue;
    if (candidates++ < limit) batch.push(e);
  }
  run.result.extractionCandidates = candidates;
  return batch;
}

const dagStore = (run: SleepRun) => ({ consolidation: run.store });

export async function llmPasses(run: SleepRun, fetcher: typeof fetch | undefined): Promise<void> {
  const llm = sleepLlm(run, fetcher);
  // 1.6. Batch extraction: extract facts from episodic memories missing them
  const batch = extractionBatch(run, llm.apiKey !== '' && !run.dryRun ? EXTRACTION_BATCH_LIMIT : 0);
  if (batch.length > 0) {
    const stopped = await extractionPass(run, llm, batch);
    // The DAG passes call the same API with the same key and model, so they would fail the same way.
    if (stopped) return;
  }

  await dagBuildPass(run, llm);
  if (llm.apiKey && !run.dryRun) {
    await dagRebuildPass(run, llm);
    await entityProfilePass(run, llm);
  }
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
  const onError = (msg: string, failure?: AnthropicMessageFailure): void => {
    report(msg);
    if (failure && isPermanentFailure(failure)) stopped = true;
  };
  for (const [index, candidate] of batch.entries()) {
    try {
      const facts = await extractFacts(candidate.content, { ...llm.llmOpts, onError });
      if (facts.length > 0) {
        extractedCount += storeExtractedFacts(run.learning, candidate, facts, run.config.defaultHalfLifeDays).length;
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
async function dagBuildPass(run: SleepRun, { apiKey, llmError, llmOpts }: SleepLlm): Promise<void> {
  if (!(apiKey && !run.dryRun)) return;
  // buildDag clusters only unparented facts, so only those are held; the gate counts every fact as it always did.
  const extractedFacts: MemoryEntry[] = [];
  let facts = 0;
  for (const e of run.survivors.rows()) {
    if (!(e.tags.includes('extracted') && e.dag_level === DAG_LEVEL.extracted && !e.superseded_by && isReusable(e))) {
      continue;
    }
    facts++;
    if (!e.dag_parent_id) extractedFacts.push(e);
  }
  if (facts < 3) return;
  try {
    const { buildDag } = await import('./dag.js');
    const dagResult = await buildDag(dagStore(run), extractedFacts, {
      ...llmOpts, onError: llmError('dag'), baseHalfLifeDays: run.config.defaultHalfLifeDays,
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

// 1.8. DAG summary rebuild: drain the summary_dirty queue set by child-write hooks; same apiKey/dryRun gate as
// buildDag.
// Cap HIPPO_DAG_REBUILD_CAP (default 20, hard ceiling 1000) prevents runaway LLM cost.
async function dagRebuildPass(run: SleepRun, { llmError, llmOpts }: SleepLlm): Promise<void> {
  const { result } = run;
  try {
    const { rebuildDirtySummaries } = await import('./dag.js');
    const rawCap = envDagRebuildCap();
    // Hard ceiling so a misconfigured env can't burn unbounded LLM cost.
    const cap = rawCap !== undefined ? Math.min(rawCap, 1000) : 20;
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

// 1.9. DAG entity profiles: cluster L2 summaries into per-entity L3 profiles; runs even when 1.7 was skipped
// (re-clusters existing L2s every sleep).
// Reads the stored L2s, not `survivors`: phase 1.7 wrote new L2s via writeEntry without pushing them into survivors.
async function entityProfilePass(run: SleepRun, { llmError, llmOpts }: SleepLlm): Promise<void> {
  try {
    const { buildEntityProfiles } = await import('./dag.js');
    const l2Summaries = run.store.unprofiledTopicSummaries();
    if (l2Summaries.length >= 2) {
      const profileResult = await buildEntityProfiles(dagStore(run), l2Summaries, {
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
