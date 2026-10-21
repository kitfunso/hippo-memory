// The in-memory Compactions group: a caller's items go through the shared item rules and the write gate in one staged
// write over the memories.
import { ConflictError } from '../../base/errors/api-errors.js';
import {
  COMPACTION_MEMORY_TAG,
  COMPACTION_SOURCE_PREFIX,
  createMemory,
  generateId,
  Layer,
  markRetrieved,
  type MemoryEntry,
} from '../../base/memory/memory.js';
import { isContentWorthStoring } from '../../base/memory/memory-quality.js';
import { rejectionDigest } from '../../base/records/rejection-digest.js';
import { RECALL_DEFAULT_DENY_SCOPES } from '../../base/scope/recall-scope.js';
import { REPLAY_AFTER_MS } from '../../base/session/compaction-timing.js';
import { itemWords, restates, writableItemRows } from '../../base/util/compaction-items.js';
import { detectSecret } from '../../base/util/secret-detect.js';
import type { CallerItems, CallerItemsSaved, CompactionStart, Compactions } from '../port/compactions.js';
import { tenantKey } from './rows.js';
import { stage, type Tx } from './staged.js';
import type { CompactionRecord, MemoryTables } from './tables.js';
import { newestFirst } from '../rules/order.js';

interface Held {
  readonly id: string | null;
  readonly sessionId: string | null;
  readonly words: string[];
}

interface Tally {
  written: number;
  repeats: number;
  refused: number;
  readonly restated: Set<string>;
}

/** One batch's staged rows, the rows it may restate and its counts. */
interface Batch {
  readonly t: MemoryTables;
  readonly tx: Tx;
  readonly held: Held[];
  readonly tally: Tally;
}

const deny: readonly string[] = RECALL_DEFAULT_DENY_SCOPES;
const admitted = (scope: string | null | undefined): boolean =>
  scope == null || (!deny.includes(scope) && !/:private:/i.test(scope));

function newRecord(tenantId: string, sessionId: string, originProject: string, status: string): CompactionRecord {
  const record = { tenantId, id: generateId('cmp'), sessionId, originProject, startedAt: new Date().toISOString() };
  return { ...record, snapshotSaved: false, status, items: [], itemsWritten: 0, requestId: null };
}

/** The caller's record: the session's `started` one from the last REPLAY_AFTER_MS, else a new `summarised` one. */
function summarize(t: MemoryTables, tenantId: string, req: CallerItems): CompactionRecord {
  const now = new Date().toISOString();
  const floor = new Date(Date.now() - REPLAY_AFTER_MS).toISOString();
  const started = t.compactions
    .filter(
      (r) =>
        r.tenantId === tenantId &&
        r.sessionId === req.sessionId &&
        r.status === 'started' &&
        r.startedAt <= now &&
        r.startedAt >= floor,
    )
    .sort(newestFirst({ key: (r) => r.startedAt, textId: (r) => r.id }))[0];
  const record = started ?? newRecord(tenantId, req.sessionId, req.project, 'summarised');
  if (started === undefined) t.compactions.push(record);
  Object.assign(record, { status: 'summarised', items: [...req.items], requestId: req.requestId });
  return record;
}

/** One item through the restatement match and the write gate, as hippo.db runs it inside its transaction. */
function writeItem({ t, tx, held, tally }: Batch, entry: MemoryEntry, actor: string): void {
  const words = itemWords(entry.content);
  const match = held.find((h) => restates(words, h.words));
  if (match) {
    tally.repeats++;
    if (match.id !== null && match.sessionId !== entry.sourceSessionId) tally.restated.add(match.id);
    return;
  }
  const digest = rejectionDigest(entry.content);
  const tombstone = t.rejected.get(tenantKey(entry.tenantId, digest));
  if (!isContentWorthStoring(entry.content) || detectSecret(entry).flagged) {
    tally.refused++;
  } else if (tombstone) {
    tally.refused++;
    const metadata = { digest, reason: tombstone.reason };
    tx.audit.push({ tenantId: entry.tenantId, actor, op: 'reject_refusal', targetId: entry.id, metadata });
  } else {
    tx.rows.set(entry.id, { ...structuredClone(entry), summaryDirty: false });
    const metadata = { kind: 'distilled', scope: null };
    tx.audit.push({ tenantId: entry.tenantId, actor, op: 'remember', targetId: entry.id, metadata });
    tally.written++;
    held.push({ id: null, sessionId: entry.sourceSessionId ?? null, words });
  }
}

function itemEntry(text: string, tenantId: string, req: CallerItems, origin: string): MemoryEntry {
  const entry = createMemory(text, {
    layer: Layer.Episodic,
    tags: [COMPACTION_MEMORY_TAG],
    source: `${COMPACTION_SOURCE_PREFIX}${req.sessionId}`,
    confidence: 'observed',
    kind: 'distilled',
    sourceSessionId: req.sessionId,
    tenantId,
    baseHalfLifeDays: req.baseHalfLifeDays,
  });
  return { ...entry, originProject: origin };
}

/** The rows a new item may restate: the tenant's live, team-visible, non-raw rows in the caller's projects. */
function heldRows(tx: Tx, tenantId: string, origins: readonly string[]): Held[] {
  return [...tx.rows.values()]
    .filter(
      (e) =>
        e.tenantId === tenantId &&
        e.originProject != null &&
        origins.includes(e.originProject) &&
        (e.supersededBy ?? null) === null &&
        e.kind !== 'raw' &&
        admitted(e.scope),
    )
    .map((e) => ({ id: e.id, sessionId: e.sourceSessionId ?? null, words: itemWords(e.content) }));
}

function writeItems(t: MemoryTables, tenantId: string, req: CallerItems, record: CompactionRecord, rows: string[]) {
  const tally: Tally = { written: 0, repeats: 0, refused: 0, restated: new Set() };
  stage(t, req.owner, (tx) => {
    const batch: Batch = { t, tx, held: heldRows(tx, tenantId, req.origins), tally };
    for (const text of rows) {
      if (text.trim().length < 3) tally.refused++;
      else writeItem(batch, itemEntry(text, tenantId, req, record.originProject), req.owner);
    }
    for (const id of tally.restated) {
      const row = tx.rows.get(id);
      const [marked] = row?.tenantId === tenantId ? markRetrieved([row]) : [];
      if (marked) tx.rows.set(id, marked);
    }
  });
  return tally;
}

function saveCallerItemsIn(t: MemoryTables, tenantId: string, req: CallerItems): CallerItemsSaved {
  const notes: string[] = [];
  const earlier = t.compactions.find((r) => r.tenantId === tenantId && r.requestId === req.requestId);
  if (earlier && earlier.sessionId !== req.sessionId) throw new ConflictError('request id belongs to another session');
  if (earlier && earlier.status !== 'summarised') return { written: earlier.itemsWritten, notes };
  const record = earlier ?? summarize(t, tenantId, req);
  const tally = writeItems(
    t,
    tenantId,
    req,
    record,
    writableItemRows(record.items, (m) => notes.push(m)),
  );
  Object.assign(record, { status: 'done', itemsWritten: tally.written });
  if (tally.repeats > 0) notes.push(`skipped ${tally.repeats} item(s) the store already holds`);
  if (tally.refused > 0) notes.push(`skipped ${tally.refused} item(s) the write gate refused`);
  return { written: tally.written, notes };
}

export function memoryCompactions(t: MemoryTables): Compactions {
  return {
    start: async (tenantId, start: CompactionStart) => {
      const record = newRecord(tenantId, start.sessionId, start.originProject, 'started');
      t.compactions.push(record);
      return record.id;
    },
    markSnapshotSaved: async (tenantId, recordId) => {
      const record = t.compactions.find((r) => r.tenantId === tenantId && r.id === recordId);
      if (record) record.snapshotSaved = true;
    },
    saveCallerItems: async (tenantId, req) => saveCallerItemsIn(t, tenantId, req),
  };
}
