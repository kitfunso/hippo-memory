import { DAG_LEVEL, EXTRACTED_TAG, Layer, type MemoryEntry } from '../../base/memory/entry.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { keptAsWritten, type SleepRun } from './run.js';
import { buildDag, buildEntityProfiles, rebuildDirtySummaries } from './dag.js';
import { emptyMarkStands } from './retry-holds.js';
import { extractFactsOutcome, storeExtractedFacts, type ExtractedFact } from '../learn/extract.js';
import { READ_PAGE_ROWS, readAll } from '../../base/util/pages.js';
import { blockHash } from '../../base/util/token-text.js';
import type { EntryCursor } from '../../base/ports/store/types.js';
import { certainDefect, isReusable } from '../../base/memory/memory-quality.js';
import {
  isPermanentFailure,
  llmFailureFields,
  type Llm,
  type LlmFailure,
} from '../../base/ports/llm.js';
import { isSuperseded } from '../../base/memory/liveness.js';

const EXTRACTION_BATCH_LIMIT = 20;
const MAX_DAG_REBUILD_CAP = 1000;
const DEFAULT_DAG_REBUILD_CAP = 20;

interface SleepLlm {
  readonly llmError: (phase: string) => (msg: string, failure?: LlmFailure) => void;
  readonly llmOpts: { readonly llm: Llm; readonly model?: string };
}

function sleepLlm(run: SleepRun, llm: Llm | undefined): SleepLlm | null {
  const { config, result } = run;
  if (llm === undefined || config.extraction.enabled === false) return null;
  const llmErrorsSeen = new Set<string>();
  const llmError =
    (phase: string) =>
    (msg: string, failure?: LlmFailure): void => {
      const seen = `${phase}: ${msg}`;
      if (llmErrorsSeen.has(seen)) return;
      llmErrorsSeen.add(seen);
      result.events.push({ kind: 'passFailed', phase, message: msg });
      log.warn(`consolidate ${phase}: ${msg}`, failure && llmFailureFields(failure));
    };
  return { llmError, llmOpts: { llm, model: config.extraction.model } };
}

interface EmptyMark {
  readonly digest: string;
  readonly at: string;
}

async function readEmptyMarks({ store }: SleepRun): Promise<Map<string, EmptyMark>> {
  const read = store.consolidation.emptyExtractions?.bind(store.consolidation);
  const marks = new Map<string, EmptyMark>();
  if (read === undefined) return marks;
  try {
    const pages = await readAll(async (after: string | undefined) => {
      const page = await read({ limit: READ_PAGE_ROWS, after });
      return { entries: page.marks, next: page.next };
    });
    for (const { id, digest, at } of pages) marks.set(id, { digest, at });
  } catch (err) {
    log.warn('consolidate extraction could not read empty marks', errorFields(err));
    marks.clear();
  }
  return marks;
}

function extractable(e: MemoryEntry, extractedFromIds: ReadonlySet<string>): boolean {
  return (
    e.layer === Layer.Episodic &&
    !isSuperseded(e) &&
    !extractedFromIds.has(e.id) &&
    !keptAsWritten(e) &&
    e.traceOutcome === null &&
    e.source !== 'auto-promote' &&
    isReusable(e)
  );
}

async function extractionBatch(run: SleepRun, limit: number): Promise<MemoryEntry[]> {
  const extractedFromIds = new Set<string>();
  for await (const e of run.survivors.rows()) {
    if (e.extractedFrom) extractedFromIds.add(e.extractedFrom);
  }
  const marks = limit > 0 ? await readEmptyMarks(run) : new Map<string, EmptyMark>();
  const batch: MemoryEntry[] = [];
  let candidates = 0;
  let held = 0;
  for await (const e of run.survivors.rows()) {
    if (!extractable(e, extractedFromIds)) continue;
    if (emptyMarkStands(marks.get(e.id), e.content, run.now)) {
      held++;
      continue;
    }
    if (candidates++ < limit) batch.push(e);
  }
  run.result.extractionCandidates = candidates;
  run.result.extractionHeld = held;
  return batch;
}

export async function llmPasses(run: SleepRun, model: Llm | undefined): Promise<void> {
  const llm = sleepLlm(run, model);
  const batch = await extractionBatch(run, llm && !run.dryRun ? EXTRACTION_BATCH_LIMIT : 0);
  if (llm === null || run.dryRun) return;
  if (batch.length > 0) {
    const stopped = await extractionPass(run, llm, batch);
    if (stopped) return;
  }

  await dagBuildPass(run, llm);
  await dagRebuildPass(run, llm);
  await entityProfilePass(run, llm);
}

const EXTRACTION_CONCURRENCY = 4;

interface Extraction {
  facts: ExtractedFact[];
  emptyArray: boolean;
  errors: Array<[string, LlmFailure | undefined]>;
  threw?: unknown;
}

async function pooled<T>(
  count: number,
  width: number,
  canLaunch: () => boolean,
  call: (index: number) => Promise<T>,
): Promise<Array<T | undefined>> {
  const results = Array.from<T | undefined>({ length: count });
  let next = 0;
  const lane = async (): Promise<void> => {
    while (canLaunch() && next < count) {
      const index = next++;
      results[index] = await call(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, count) }, lane));
  return results;
}

function keepFacts(
  run: SleepRun,
  source: MemoryEntry,
  facts: Extraction['facts'],
): Promise<MemoryEntry[]> {
  return storeExtractedFacts(run.store, {
    source,
    facts,
    baseHalfLifeDays: run.config.defaultHalfLifeDays,
    now: run.now,
  });
}

interface EmptyNote {
  mark: Array<{ id: string; digest: string; at: string }>;
  clear: string[];
}

function refusedByRejectedValue(facts: Extraction['facts']): boolean {
  return facts.length > 0 && facts.every((fact) => certainDefect(fact.content) === null);
}

function noteOutcome(
  run: SleepRun,
  note: EmptyNote,
  source: MemoryEntry,
  out: Extraction,
  storedCount: number,
): void {
  if (storedCount > 0) {
    note.clear.push(source.id);
  } else if (out.emptyArray || refusedByRejectedValue(out.facts)) {
    note.mark.push({
      id: source.id,
      digest: blockHash(source.content),
      at: run.now.toISOString(),
    });
  }
}

async function saveEmptyNote(run: SleepRun, note: EmptyNote): Promise<void> {
  if (note.mark.length === 0 && note.clear.length === 0) return;
  try {
    await run.store.consolidation.noteEmptyExtractions?.(note);
  } catch (err) {
    log.warn('consolidate extraction could not note empty results', errorFields(err));
  }
}

async function extractionPass(
  run: SleepRun,
  llm: SleepLlm,
  batch: readonly MemoryEntry[],
): Promise<boolean> {
  const report = llm.llmError('extraction');
  const stop: StopIndex = { at: Number.POSITIVE_INFINITY };
  const results = await pooled(
    batch.length,
    EXTRACTION_CONCURRENCY,
    () => stop.at === Number.POSITIVE_INFINITY,
    (index) => extractOne(llm, batch[index].content, index, stop),
  );
  let extractedCount = 0;
  const note: EmptyNote = { mark: [], clear: [] };
  for (const [index, candidate] of batch.entries()) {
    const out = results[index];
    if (out === undefined) break;
    for (const [msg, failure] of out.errors) report(msg, failure);
    try {
      if (out.threw !== undefined) throw out.threw;
      const stored = out.facts.length > 0 ? await keepFacts(run, candidate, out.facts) : [];
      extractedCount += stored.length;
      if (out.errors.length === 0) noteOutcome(run, note, candidate, out, stored.length);
    } catch (err) {
      report(errorMessage(err));
      log.warn('consolidate extraction threw', errorFields(err));
    }
    if (index === stop.at) {
      reportStop(report, index, batch.length);
      break;
    }
  }
  run.result.extracted = extractedCount;
  await saveEmptyNote(run, note);
  return stop.at !== Number.POSITIVE_INFINITY;
}

interface StopIndex {
  at: number;
}

async function extractOne(
  llm: SleepLlm,
  content: string,
  index: number,
  stop: StopIndex,
): Promise<Extraction> {
  const out: Extraction = { facts: [], emptyArray: false, errors: [] };
  const onError = (msg: string, failure?: LlmFailure): void => {
    out.errors.push([msg, failure]);
    if (failure && isPermanentFailure(failure)) stop.at = Math.min(stop.at, index);
  };
  try {
    const outcome = await extractFactsOutcome(content, { ...llm.llmOpts, onError });
    out.facts = outcome.facts;
    out.emptyArray = outcome.emptyArray;
  } catch (err) {
    out.threw = err;
  }
  return out;
}

function reportStop(report: ReturnType<SleepLlm['llmError']>, index: number, total: number): void {
  const skipped = total - index - 1;
  report(
    `stopped after a failure that will not clear on retry; ${skipped} of ${total} candidates skipped, and ` +
      `the DAG passes with them`,
  );
}

async function dagBuildPass(run: SleepRun, { llmError, llmOpts }: SleepLlm): Promise<void> {
  const extractedFacts: MemoryEntry[] = [];
  let facts = 0;
  for await (const e of run.survivors.rows()) {
    if (
      !(
        e.tags.includes(EXTRACTED_TAG) &&
        e.dagLevel === DAG_LEVEL.extracted &&
        !isSuperseded(e) &&
        isReusable(e)
      )
    ) {
      continue;
    }
    facts++;
    if (!e.dagParentId) extractedFacts.push(e);
  }
  if (facts < 3) return;
  try {
    const dagResult = await buildDag(run.store, extractedFacts, {
      ...llmOpts,
      onError: llmError('dag'),
      baseHalfLifeDays: run.config.defaultHalfLifeDays,
      now: run.now,
    });
    run.result.dagCandidateClusters = dagResult.candidateClusters;
    run.result.dagSummariesCreated = dagResult.summariesCreated;
    if (dagResult.summariesCreated > 0) {
      run.result.events.push({
        kind: 'dagSummaries',
        created: dagResult.summariesCreated,
        factsLinked: dagResult.factsLinked,
      });
    }
  } catch (err) {
    llmError('dag')(errorMessage(err));
    log.warn('consolidate dag threw', errorFields(err));
  }
}

async function dagRebuildPass(run: SleepRun, { llmError, llmOpts }: SleepLlm): Promise<void> {
  const { result } = run;
  try {
    const rawCap = run.config.runtime?.dagRebuildCap;
    const cap =
      rawCap !== undefined ? Math.min(rawCap, MAX_DAG_REBUILD_CAP) : DEFAULT_DAG_REBUILD_CAP;
    const rebuildResult = await rebuildDirtySummaries(run.store, {
      ...llmOpts,
      onError: llmError('dag rebuild'),
      cap,
      now: run.now,
    });
    result.summariesRebuilt = rebuildResult.rebuilt;
    result.summariesRebuildFailed = rebuildResult.failed;
    result.summariesZeroChildSkipped = rebuildResult.zeroChildSkipped;
    result.summariesRebuildRefused = rebuildResult.refused;
    result.summariesRebuildCapped = rebuildResult.capped;
    result.summariesRebuildHeld = rebuildResult.held;
    if (
      rebuildResult.rebuilt > 0 ||
      rebuildResult.zeroChildSkipped > 0 ||
      rebuildResult.failed > 0 ||
      rebuildResult.refused > 0 ||
      rebuildResult.held > 0
    ) {
      result.events.push({
        kind: 'dagRebuild',
        rebuilt: rebuildResult.rebuilt,
        refused: rebuildResult.refused,
        zeroChildSkipped: rebuildResult.zeroChildSkipped,
        failed: rebuildResult.failed,
        held: rebuildResult.held,
        cappedAt: rebuildResult.capped ? cap : null,
      });
    }
  } catch (err) {
    llmError('dag rebuild')(errorMessage(err));
    log.warn('consolidate dag rebuild threw', errorFields(err));
  }
}

async function allUnprofiledTopicSummaries(
  store: SleepRun['store']['consolidation'],
): Promise<MemoryEntry[]> {
  const all: MemoryEntry[] = [];
  for (let after: EntryCursor | undefined; ;) {
    const page = await store.unprofiledTopicSummaries({ limit: READ_PAGE_ROWS, after });
    all.push(...page.entries);
    if (page.next === null) return all;
    after = page.next;
  }
}

async function entityProfilePass(run: SleepRun, { llmError, llmOpts }: SleepLlm): Promise<void> {
  try {
    const l2Summaries = await allUnprofiledTopicSummaries(run.store.consolidation);
    if (l2Summaries.length >= 2) {
      const profileResult = await buildEntityProfiles(run.store, l2Summaries, {
        ...llmOpts,
        onError: llmError('dag profiles'),
        baseHalfLifeDays: run.config.defaultHalfLifeDays,
        now: run.now,
      });
      run.result.entityProfilesCreated = profileResult.profilesCreated;
      if (profileResult.profilesCreated > 0) {
        run.result.events.push({
          kind: 'dagProfiles',
          profiles: profileResult.profilesCreated,
          l2sLinked: profileResult.l2sLinked,
        });
      }
    }
  } catch (err) {
    llmError('dag profiles')(errorMessage(err));
    log.warn('consolidate dag profiles threw', errorFields(err));
  }
}
