import { envAnthropicApiKey, envDagRebuildCap } from '../env.js';
import { Layer } from '../memory.js';
import { log } from '../log.js';
import { keptAsWritten, type SleepRun } from './run.js';

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

export async function llmPasses(run: SleepRun, fetcher: typeof fetch | undefined): Promise<void> {
  // -------------------------------------------------------------------------
  // 1.6. Batch extraction — extract facts from episodic memories missing them
  // -------------------------------------------------------------------------
  const extractedFromIds = new Set(
    run.survivors.filter((e) => e.extracted_from).map((e) => e.extracted_from!),
  );
  const extractionCandidates = run.survivors.filter(
    (e) => e.layer === Layer.Episodic && !e.superseded_by && !extractedFromIds.has(e.id) && !keptAsWritten(e),
  );
  run.result.extractionCandidates = extractionCandidates.length;

  const llm = sleepLlm(run, fetcher);
  if (llm.apiKey && extractionCandidates.length > 0 && !run.dryRun) {
    const { extractFacts, storeExtractedFacts } = await import('../extract.js');
    const batchLimit = 20;
    let extractedCount = 0;
    for (const candidate of extractionCandidates.slice(0, batchLimit)) {
      try {
        const facts = await extractFacts(candidate.content, { ...llm.llmOpts, onError: llm.llmError('extraction') });
        if (facts.length > 0) {
          storeExtractedFacts(run.hippoRoot, candidate, facts);
          extractedCount += facts.length;
        }
      } catch (err) {
        llm.llmError('extraction')(String(err));
      }
    }
    run.result.extracted = extractedCount;
  }

  await dagBuildPass(run, llm);
  if (llm.apiKey && !run.dryRun) {
    await dagRebuildPass(run, llm);
    await entityProfilePass(run, llm);
  }
}

// -------------------------------------------------------------------------
// 1.7. DAG summarization — cluster extracted facts and generate summaries
// -------------------------------------------------------------------------
async function dagBuildPass(run: SleepRun, { apiKey, llmError, llmOpts }: SleepLlm): Promise<void> {
  const extractedFacts = run.survivors.filter(
    (e) => e.tags.includes('extracted') && e.dag_level === 1 && !e.superseded_by,
  );
  if (!(apiKey && extractedFacts.length >= 3 && !run.dryRun)) return;
  try {
    const { buildDag } = await import('../dag.js');
    const dagResult = await buildDag(run.hippoRoot, extractedFacts, { ...llmOpts, onError: llmError('dag') });
    run.result.dagCandidateClusters = dagResult.candidateClusters;
    run.result.dagSummariesCreated = dagResult.summariesCreated;
    if (dagResult.summariesCreated > 0) {
      run.result.details.push(`  🌳 DAG: ${dagResult.summariesCreated} summaries created, ${dagResult.factsLinked} facts linked`);
    }
  } catch (err) {
    llmError('dag')(String(err));
  }
}

// -------------------------------------------------------------------------
// 1.8. DAG summary rebuild — drain dirty queue from E2's child-write hooks
// -------------------------------------------------------------------------
// Consumer of E2's summary_dirty flag. Walks dirty L2 summaries, regenerates
// each via generateDagSummary, atomically refreshes content + 6 metadata
// columns + clears summary_dirty (with FTS sync). Same apiKey/dryRun gate
// as buildDag above. Cap HIPPO_DAG_REBUILD_CAP (default 20, hard ceiling
// 1000) prevents runaway LLM cost.
async function dagRebuildPass(run: SleepRun, { llmError, llmOpts }: SleepLlm): Promise<void> {
  const { result } = run;
  try {
    const { rebuildDirtySummaries } = await import('../dag.js');
    const rawCap = envDagRebuildCap();
    // R1 MED must-fix: hard ceiling so misconfigured env can't burn
    // unbounded LLM cost.
    const cap = rawCap !== undefined ? Math.min(rawCap, 1000) : 20;
    const rebuildResult = await rebuildDirtySummaries(run.hippoRoot, { ...llmOpts, onError: llmError('dag rebuild'), cap });
    result.summariesRebuilt = rebuildResult.rebuilt;
    result.summariesRebuildFailed = rebuildResult.failed;
    result.summariesZeroChildSkipped = rebuildResult.zeroChildSkipped;
    result.summariesRebuildRefused = rebuildResult.refused;
    result.summariesRebuildCapped = rebuildResult.capped;
    if (rebuildResult.rebuilt > 0 || rebuildResult.zeroChildSkipped > 0 || rebuildResult.failed > 0 || rebuildResult.refused > 0) {
      const parts: string[] = [];
      if (rebuildResult.rebuilt > 0) parts.push(`${rebuildResult.rebuilt} rebuilt`);
      if (rebuildResult.refused > 0) parts.push(`${rebuildResult.refused} refused`);
      if (rebuildResult.zeroChildSkipped > 0) parts.push(`${rebuildResult.zeroChildSkipped} zero-child-skipped`);
      if (rebuildResult.failed > 0) parts.push(`${rebuildResult.failed} failed`);
      if (rebuildResult.capped) parts.push(`CAPPED@${cap}`);
      result.details.push(`  🌳 DAG rebuild: ${parts.join(', ')}`);
    }
  } catch (err) {
    llmError('dag rebuild')(String(err));
  }
}

// -------------------------------------------------------------------------
// 1.9. DAG entity profiles — cluster L2 topic summaries into L3 profiles
// -------------------------------------------------------------------------
// E5 phase: aggregate per-entity L2 summaries (e.g. all the speaker:Alice
// topic summaries) into a single L3 entity profile. Runs even when phase
// 1.7 buildDag was skipped (re-clusters existing L2s every sleep).
//
// Uses loadAllL2Summaries (not `survivors`) because phase 1.7 wrote new
// L2s directly via writeEntry without pushing back into survivors.
async function entityProfilePass(run: SleepRun, { llmError, llmOpts }: SleepLlm): Promise<void> {
  try {
    const { buildEntityProfiles } = await import('../dag.js');
    const { loadAllL2Summaries } = await import('../store/summaries.js');
    const l2Summaries = loadAllL2Summaries(run.hippoRoot);
    if (l2Summaries.length >= 2) {
      const profileResult = await buildEntityProfiles(run.hippoRoot, l2Summaries, { ...llmOpts, onError: llmError('dag profiles') });
      run.result.entityProfilesCreated = profileResult.profilesCreated;
      if (profileResult.profilesCreated > 0) {
        run.result.details.push(`  🌲 DAG L3: ${profileResult.profilesCreated} entity profiles, ${profileResult.l2sLinked} L2s linked`);
      }
    }
  } catch (err) {
    llmError('dag profiles')(String(err));
  }
}
