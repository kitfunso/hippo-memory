// One container's sync: its rows read, every write planned as data, then one store call applies the
// plan in one transaction; a plan whose rows changed before it landed is read and planned once
// more.
import type { MemoryEntry } from '../../base/memory/entry.js';
import { redactSecretsStrict } from '../../base/util/secret-detect.js';
import { duplicateKey, heldTextKeys } from '../../base/util/same-text.js';
import { AGENT_MEMORY_SOURCE_PREFIX } from '../../base/memory/agent-memory-tools.js';
import type { ContainerApply, MirrorFailure } from '../../base/ports/store/agent-import.js';
import type { DormantSnapshot } from '../../base/ports/store/types.js';
import { addOutcomes, planSteps } from './container-steps.js';
import {
  readContainer,
  type ContainerView,
  type ContainerWork,
  type StoreSession,
} from './container-view.js';
import { itemHash } from './keys.js';
import {
  planContainer,
  type ContainerPlan,
  type DormantRow,
  type LiveRow,
  type PlanInput,
  type PlanItem,
} from './plan.js';
import { emptyTally, type Tally } from '../../base/memory/agent-memory-report.js';
import { MIN_ITEM_CHARS, splitSource, storedText } from './source.js';
import type { MemoryItem } from './types.js';

export interface ContainerOutcome {
  readonly tally: Tally;
  /** Mirrors of set-aside rows the commit could not remove. */
  readonly unpurged: readonly MirrorFailure[];
}

type Refusal = 'short' | 'secret' | 'rejected';

interface PlannedContainer {
  readonly apply: ContainerApply;
  /** What the plan counts before any step runs. */
  readonly tally: Tally;
}

/** Null when the rows changed under both plans; throws a busy error when another writer held the
 * store too long. */
export async function syncContainer(
  s: StoreSession,
  work: ContainerWork,
): Promise<ContainerOutcome | null> {
  for (let round = 0; round < 2; round++) {
    const planned = await planWrites(s, work);
    const applied = await s.store.hippoDb.agentImport.applyContainer(planned.apply);
    if (applied.kind === 'applied') {
      addOutcomes(planned.tally, planned.apply.steps, applied.outcomes);
      return { tally: planned.tally, unpurged: applied.unpurged };
    }
  }
  return null;
}

async function planWrites(s: StoreSession, w: ContainerWork): Promise<PlannedContainer> {
  const view = await readContainer(s, w);
  const refusals = await refusalsOf(s, w.container.items);
  const live = view.live.map((row): LiveRow => liveRow(row, w));
  const dormant = await dormantSnapshots(s, w, view, {
    liveKeys: new Set(live.map((r) => r.key)),
    refusals,
  });
  const plan = await planWithDuplicates(s, w, {
    textKeyed: w.container.textKeyed,
    items: w.container.items.map((item) => ({
      key: item.key,
      hash: itemHash(item.text),
      refused: refusals.has(item.key),
    })),
    skipped: w.container.skipped,
    live,
    dormant: dormant.map((snap) => dormantRow(snap, w)),
    legacy: new Map([...w.replace].map(([key, rows]) => [key, rows.map((r) => r.id)])),
  });
  const tally = planTally(refusals, w, plan);
  const rows = {
    live: new Map(view.live.map((r) => [r.id, r])),
    dormant: new Map(dormant.map((d) => [d.entry.id, d])),
  };
  const steps = [...view.steps, ...planSteps(s, w, plan, rows)];
  return {
    apply: {
      tenantId: s.tenantId,
      dryRun: s.dryRun,
      tag: w.tool.tag,
      prefixes: [w.prefix, ...w.legacyPrefixes],
      rows: view.read,
      steps,
    },
    tally,
  };
}

function liveRow(row: MemoryEntry, w: ContainerWork): LiveRow {
  return {
    id: row.id,
    ...splitSource(row.source, w.prefix),
    tagged: row.tags.includes(w.tool.tag),
    created: row.created,
  };
}

function dormantRow(snap: DormantSnapshot, w: ContainerWork): DormantRow {
  return {
    id: snap.entry.id,
    ...splitSource(snap.entry.source, w.prefix),
    dormantAt: snap.dormantAt,
  };
}

function planTally(refusals: Map<string, Refusal>, w: ContainerWork, plan: ContainerPlan): Tally {
  const tally = emptyTally();
  for (const reason of refusals.values()) tally[reason]++;
  tally.unread += w.container.skipped.length;
  tally.unchanged += plan.unchanged;
  tally.duplicate += plan.duplicates;
  return tally;
}

// The rejection lookup reads the capped text, as the write would store it, so a rejected note
// writes no audit row.
async function refusalsOf(
  s: StoreSession,
  items: readonly MemoryItem[],
): Promise<Map<string, Refusal>> {
  const out = new Map<string, Refusal>();
  const asked: MemoryItem[] = [];
  for (const item of items) {
    if (item.text.trim().length < MIN_ITEM_CHARS) out.set(item.key, 'short');
    // Imported rows reach prompts, so the bar is text leaving the machine: Bearer headers and JWTs count too.
    else if (redactSecretsStrict(item.text) !== item.text) out.set(item.key, 'secret');
    else asked.push(item);
  }
  if (asked.length === 0) return out;
  // A new row's id: no stored row holds the empty id, so the tombstone alone decides.
  const checks = asked.map((item) => ({
    tenantId: s.tenantId,
    entryId: '',
    content: storedText(item.text),
  }));
  const rejected = await s.store.hippoDb.rejections.refusedAmong(checks);
  asked.forEach((item, i) => {
    if (rejected[i]) out.set(item.key, 'rejected');
  });
  return out;
}

/** Read only when a present key has no live row, which after the first import is rare. */
async function dormantSnapshots(
  s: StoreSession,
  w: ContainerWork,
  view: ContainerView,
  {
    liveKeys,
    refusals,
  }: { readonly liveKeys: ReadonlySet<string>; readonly refusals: ReadonlyMap<string, Refusal> },
): Promise<DormantSnapshot[]> {
  const needed = w.container.items.some(
    (item) => !refusals.has(item.key) && !liveKeys.has(item.key),
  );
  if (!needed) return [];
  const under = await s.store.hippoDb.projectTags.dormantWhere({
    tenantId: s.tenantId,
    sourcePrefix: w.prefix,
  });
  return [...under, ...view.movedDormant].filter((snap) => !snap.entry.supersededBy);
}

/** The plan asks which notes another path already stores only for the rows it would write; those
 * texts are read in one call, and the same items are asked again with the answers. */
async function planWithDuplicates(
  s: StoreSession,
  w: ContainerWork,
  input: Omit<PlanInput, 'isDuplicate'>,
): Promise<ContainerPlan> {
  const asked: PlanItem[] = [];
  planContainer({
    ...input,
    isDuplicate: (item) => {
      asked.push(item);
      return false;
    },
  });
  const items = new Map(w.container.items.map((item) => [item.key, item.text]));
  const texts = asked.map((item) => storedText(items.get(item.key) ?? ''));
  const held = await duplicatesAmong(s, texts);
  const duplicate = new Set(asked.filter((_, i) => held[i]).map((item) => item.key));
  return planContainer({ ...input, isDuplicate: (item) => duplicate.has(item.key) });
}

/** Design 6: only text stored by another path counts; the store is asked only for rows holding
 * the text's words. */
async function duplicatesAmong(s: StoreSession, texts: readonly string[]): Promise<boolean[]> {
  if (texts.length === 0) return [];
  const origins = s.visible === null ? undefined : ['', ...s.visible];
  const rows = await s.store.hippoDb.sharing.textKeysHolding(
    { tenantId: s.tenantId, live: true, origins },
    texts,
  );
  const keys = new Set(
    rows
      .filter((r) => !r.source.startsWith(AGENT_MEMORY_SOURCE_PREFIX) && !s.adopted.has(r.id))
      .flatMap((r) => heldTextKeys(r)),
  );
  return texts.map((text) => keys.has(duplicateKey(text)));
}
