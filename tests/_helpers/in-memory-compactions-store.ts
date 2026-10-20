// A store other than hippo.db for the Compactions group, built on the in-memory entry-writes store: it copies the
// compaction records out of hippo.db once and runs a caller's items through the shared item rules from memory.
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { ConflictError } from '../../src/server.js';
import {
  RECALL_DEFAULT_DENY_SCOPES,
  rejectionDigest,
  type CallerItems,
  type CompactionStart,
  type Compactions,
  type HippoStore,
  type MemoryEntry,
} from '../../src/entry/store-kit.js';
import {
  COMPACTION_MEMORY_TAG,
  COMPACTION_SOURCE_PREFIX,
  createMemory,
  generateId,
  Layer,
  markRetrieved,
} from '../../src/base/memory/memory.js';
import { isContentWorthStoring } from '../../src/base/memory/memory-quality.js';
import { REPLAY_AFTER_MS } from '../../src/base/session/compaction-timing.js';
import { itemWords, restates, writableItemRows } from '../../src/base/util/compaction-items.js';
import { detectSecret } from '../../src/base/util/secret-detect.js';
import {
  inMemoryEntryWritesStore,
  tombstoneKey,
  type InMemoryEntryWritesStore,
  type Tombstone,
  type Tx,
} from './in-memory-entry-writes-store.js';
import type { StoreSide } from './store-conformance.js';

export interface InMemoryCompactionsStore extends StoreSide {
  readonly store: HippoStore;
}

interface Rec {
  readonly tenantId: string;
  readonly id: string;
  readonly sessionId: string;
  readonly originProject: string;
  readonly startedAt: string;
  snapshotSaved: boolean;
  status: string;
  items: string[];
  itemsWritten: number;
  requestId: string | null;
}

interface Held {
  readonly id: string | null;
  readonly sessionId: string | null;
  readonly words: string[];
}

const deny: readonly string[] = RECALL_DEFAULT_DENY_SCOPES;
const admitted = (scope: string | null | undefined): boolean =>
  scope == null || (!deny.includes(scope) && !/:private:/i.test(scope));

function copyRecords(hippoRoot: string): Rec[] {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: the SELECT aliases each column to a Rec field; items_json is parsed below.
    const rows = db
      .prepare(`SELECT tenant_id AS tenantId, id, session_id AS sessionId, origin_project AS originProject,
      started_at AS startedAt, snapshot_saved AS saved, status, items_json AS itemsJson, items_written AS itemsWritten,
      request_id AS requestId FROM compactions ORDER BY started_at, id`)
      .all() as Array<Omit<Rec, 'snapshotSaved' | 'items'> & { saved: number; itemsJson: string | null }>;
    return rows.map(({ saved, itemsJson, ...r }) => ({
      ...r,
      snapshotSaved: saved === 1,
      items: itemsJson === null ? [] : JSON.parse(itemsJson),
    }));
  } finally {
    closeHippoDb(db);
  }
}

/** The caller's record: the session's `started` one from the last REPLAY_AFTER_MS, else a new `summarised` one. */
function summarize(records: Rec[], tenantId: string, req: CallerItems): Rec {
  const now = new Date().toISOString();
  const floor = new Date(Date.now() - REPLAY_AFTER_MS).toISOString();
  const started = records
    .filter(
      (r) =>
        r.tenantId === tenantId &&
        r.sessionId === req.sessionId &&
        r.status === 'started' &&
        r.startedAt <= now &&
        r.startedAt >= floor,
    )
    .sort((a, b) => (a.startedAt === b.startedAt ? (a.id < b.id ? 1 : -1) : a.startedAt < b.startedAt ? 1 : -1))[0];
  const record: Rec = started ?? {
    tenantId,
    id: generateId('cmp'),
    sessionId: req.sessionId,
    originProject: req.project,
    startedAt: now,
    snapshotSaved: false,
    status: 'summarised',
    items: [],
    itemsWritten: 0,
    requestId: null,
  };
  if (started === undefined) records.push(record);
  Object.assign(record, { status: 'summarised', items: [...req.items], requestId: req.requestId });
  return record;
}

interface Tally {
  written: number;
  repeats: number;
  refused: number;
  readonly restated: Set<string>;
}

/** One batch's staged rows, the rows it may restate, its counts, and the tombstones the gate refuses. */
interface Batch {
  readonly tx: Tx;
  readonly held: Held[];
  readonly tally: Tally;
  readonly tombstones: ReadonlyMap<string, Tombstone>;
}

/** One item through the restatement match and the write gate, as saveItems runs it inside its transaction. */
function writeItem(batch: Batch, entry: MemoryEntry, actor: string): void {
  const { tx, held, tally } = batch;
  const words = itemWords(entry.content);
  const match = held.find((h) => restates(words, h.words));
  if (match) {
    tally.repeats++;
    if (match.id !== null && match.sessionId !== entry.sourceSessionId) tally.restated.add(match.id);
    return;
  }
  const digest = rejectionDigest(entry.content);
  const tombstone = batch.tombstones.get(tombstoneKey(entry.tenantId, digest));
  if (!isContentWorthStoring(entry.content) || detectSecret(entry).flagged) {
    tally.refused++;
  } else if (tombstone) {
    tally.refused++;
    tx.audit.push({
      tenantId: entry.tenantId,
      actor,
      op: 'reject_refusal',
      targetId: entry.id,
      metadata: { digest, reason: tombstone.reason },
    });
  } else {
    tx.rows.set(entry.id, { ...structuredClone(entry), summaryDirty: false });
    tx.audit.push({
      tenantId: entry.tenantId,
      actor,
      op: 'remember',
      targetId: entry.id,
      metadata: { kind: 'distilled', scope: null },
    });
    tally.written++;
    held.push({ id: null, sessionId: entry.sourceSessionId ?? null, words });
  }
}

function compactionsOn(base: InMemoryEntryWritesStore, records: Rec[]): Compactions {
  const entryFor = (text: string, tenantId: string, req: CallerItems, origin: string): MemoryEntry => ({
    ...createMemory(text, {
      layer: Layer.Episodic,
      tags: [COMPACTION_MEMORY_TAG],
      source: `${COMPACTION_SOURCE_PREFIX}${req.sessionId}`,
      confidence: 'observed',
      kind: 'distilled',
      sourceSessionId: req.sessionId,
      tenantId,
      baseHalfLifeDays: req.baseHalfLifeDays,
    }),
    originProject: origin,
  });
  return {
    async start(tenantId: string, start: CompactionStart) {
      const id = generateId('cmp');
      records.push({
        tenantId,
        id,
        sessionId: start.sessionId,
        originProject: start.originProject,
        startedAt: new Date().toISOString(),
        snapshotSaved: false,
        status: 'started',
        items: [],
        itemsWritten: 0,
        requestId: null,
      });
      return id;
    },
    async markSnapshotSaved(tenantId, recordId) {
      const record = records.find((r) => r.tenantId === tenantId && r.id === recordId);
      if (record) record.snapshotSaved = true;
    },
    async saveCallerItems(tenantId, req) {
      const notes: string[] = [];
      const earlier = records.find((r) => r.tenantId === tenantId && r.requestId === req.requestId);
      if (earlier && earlier.sessionId !== req.sessionId) {
        throw new ConflictError('request id belongs to another session');
      }
      if (earlier && earlier.status !== 'summarised') return { written: earlier.itemsWritten, notes };
      const record = earlier ?? summarize(records, tenantId, req);
      const rows = writableItemRows(record.items, (m) => notes.push(m));
      const tally: Tally = { written: 0, repeats: 0, refused: 0, restated: new Set() };
      await base.stage(req.owner, (tx) => {
        const held: Held[] = [...tx.rows.values()]
          .filter(
            (e) =>
              e.tenantId === tenantId &&
              e.originProject != null &&
              req.origins.includes(e.originProject) &&
              (e.supersededBy ?? null) === null &&
              e.kind !== 'raw' &&
              admitted(e.scope),
          )
          .map((e) => ({ id: e.id, sessionId: e.sourceSessionId ?? null, words: itemWords(e.content) }));
        const batch: Batch = { tx, held, tally, tombstones: base.tombstones };
        for (const text of rows) {
          if (text.trim().length < 3) tally.refused++;
          else writeItem(batch, entryFor(text, tenantId, req, record.originProject), req.owner);
        }
        for (const id of tally.restated) {
          const row = tx.rows.get(id);
          if (row?.tenantId === tenantId) tx.rows.set(id, markRetrieved([row])[0]!);
        }
      });
      Object.assign(record, { status: 'done', itemsWritten: tally.written });
      if (tally.repeats > 0) notes.push(`skipped ${tally.repeats} item(s) the store already holds`);
      if (tally.refused > 0) notes.push(`skipped ${tally.refused} item(s) the write gate refused`);
      return { written: tally.written, notes };
    },
  };
}

export function inMemoryCompactionsStore(hippoRoot: string): InMemoryCompactionsStore {
  const base = inMemoryEntryWritesStore(hippoRoot);
  return {
    store: { ...base.store, compactions: compactionsOn(base, copyRecords(hippoRoot)) },
    auditRows: base.auditRows,
  };
}
