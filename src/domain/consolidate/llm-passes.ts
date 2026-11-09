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

/** Null when no phase may call a model: none was handed in, or extraction.enabled=false opts
 * every LLM phase out. */
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

/** A source's empty extraction mark: the hash of its text the model found nothing in, and when. */
interface EmptyMark {
  readonly digest: string;
  readonly at: string;
}

/** Every empty extraction mark the store holds, by source id; none when the store keeps none or
 * the read fails, since a failed read only costs the sleep the calls the marks would have saved. */
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

/** Whether sleep could extract facts from `e`: a live episodic memory the model has not been asked
 * about and nothing keeps as written. */
function extractable(e: MemoryEntry, extractedFromIds: ReadonlySet<string>): boolean {
  return (
    e.layer === Layer.Episodic &&
    !e.supersededBy &&
    !extractedFromIds.has(e.id) &&
    !keptAsWritten(e) &&
    e.traceOutcome === null &&
    e.source !== 'auto-promote' &&
    isReusable(e)
  );
}

/** Counts the survivors extraction could read and returns the first `limit` of them, holding no
 * others. A source with a standing empty mark is counted in `extractionHeld` instead, and only
 * when a model may run (`limit` above 0), so a sleep with no model reads no marks. */
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
  // 1.6. Batch extraction: extract facts from episodic memories missing them
  const batch = await extractionBatch(run, llm && !run.dryRun ? EXTRACTION_BATCH_LIMIT : 0);
  // Every sleep counts the candidates; only one that may call a model goes on.
  if (llm === null || run.dryRun) return;
  if (batch.length > 0) {
    const stopped = await extractionPass(run, llm, batch);
    // The DAG passes call the same API with the same key and model, so they would fail the same
    // way.
    if (stopped) return;
  }

  await dagBuildPass(run, llm);
  await dagRebuildPass(run, llm);
  await entityProfilePass(run, llm);
}

// A local model serves a few calls at once; more only queues them at the provider.
const EXTRACTION_CONCURRENCY = 4;

interface Extraction {
  facts: ExtractedFact[];
  emptyArray: boolean;
  errors: Array<[string, LlmFailure | undefined]>;
  threw?: unknown;
}

/** Runs `call` for every index with at most `width` in flight, launching nothing once
 * `canLaunch` says no; a result sits at its input index, undefined where nothing launched. */
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

/** Stores one source's extracted facts as semantic memories stamped at the run's instant. */
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

/** What the pass tells the store about its sources: marks to keep and the ids whose mark goes. */
interface EmptyNote {
  mark: Array<{ id: string; digest: string; at: string }>;
  clear: string[];
}

/** Whether nothing was stored only because rejected values refused every fact: none has a quality
 * defect, which would be bad model output worth a retry. */
function refusedByRejectedValue(facts: Extraction['facts']): boolean {
  return facts.length > 0 && facts.every((fact) => certainDefect(fact.content) === null);
}

/** A stored child clears the source's mark. An explicit empty array, or facts that all passed the
 * quality check and were all refused by a rejected value, marks it; any other reply leaves it. */
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

/** Hands the store the pass's marks in one call; a failure is logged and the sources are offered
 * again next sleep. */
async function saveEmptyNote(run: SleepRun, note: EmptyNote): Promise<void> {
  if (note.mark.length === 0 && note.clear.length === 0) return;
  try {
    await run.store.consolidation.noteEmptyExtractions?.(note);
  } catch (err) {
    log.warn('consolidate extraction could not note empty results', errorFields(err));
  }
}

/**
 * Extracts facts from each candidate, up to four model calls at once; every write, count and report
 * then runs in input order. True when it stopped on a failure every later call would repeat (bad
 * key, no credit, unknown model).
 */
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

/** The lowest input index a permanent failure was seen at; infinity while none was. */
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

// 1.7. DAG summarization — cluster extracted facts and generate summaries
async function dagBuildPass(run: SleepRun, { llmError, llmOpts }: SleepLlm): Promise<void> {
  // buildDag clusters only unparented facts, so only those are held; the gate counts every fact as
  // it always did.
  const extractedFacts: MemoryEntry[] = [];
  let facts = 0;
  for await (const e of run.survivors.rows()) {
    if (
      !(
        e.tags.includes(EXTRACTED_TAG) &&
        e.dagLevel === DAG_LEVEL.extracted &&
        !e.supersededBy &&
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

// 1.8. DAG summary rebuild: drain the summary_dirty queue set by child-write hooks; same
// model/dryRun gate as buildDag. Cap HIPPO_DAG_REBUILD_CAP, as the root read it (default 20, hard
// ceiling 1000), prevents runaway LLM cost.
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

/** Every unprofiled L2 summary, one keyset page per store call: clustering needs them all, a
 * statement need not. */
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

// 1.9. DAG entity profiles: cluster L2 summaries into per-entity L3 profiles; runs even when 1.7
// was skipped (re-clusters existing L2s every sleep). Reads the stored L2s, not `survivors`: phase
// 1.7 wrote new L2s via writeEntry without pushing them into survivors.
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
