// A store other than hippo.db for the Predictions group: its rows and mirrors live in Maps and start empty, so a
// conformance test seeds both sides through the port and shows the port's own words are enough to build on.
import { BadRequestError, ConflictError, NotFoundError, type HippoStore, type MemoryEntry } from '../../src/server.js';
import type { Predictions } from '../../src/store/port.js';
import { predictionBaserateOf, type Prediction } from '../../src/store/predictions.js';
import { inMemoryKeyAuditStore } from './in-memory-key-audit-store.js';
import type { StoreSide } from './store-conformance.js';

export interface InMemoryPredictionsStore extends StoreSide {
  readonly store: HippoStore & { readonly predictions: Predictions };
}

/** Byte order, as hippo.db compares text; JavaScript's own string order differs above the basic plane. */
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

const newestFirst = (a: Prediction, b: Prediction): number => byBytes(b.createdAt, a.createdAt) || b.id - a.id;

export function inMemoryPredictionsStore(hippoRoot: string): InMemoryPredictionsStore {
  const base = inMemoryKeyAuditStore(hippoRoot);
  const rows = new Map<number, Prediction>();
  const mirrors = new Map<string, MemoryEntry>();
  let lastId = 0;
  const owned = (tenantId: string, id: number): Prediction | undefined => {
    const row = rows.get(id);
    return row?.tenantId === tenantId ? row : undefined;
  };

  const predictions: Predictions = {
    async savePrediction(tenantId, input, actor) {
      const { mirror } = input;
      const held = mirrors.get(mirror.id);
      if (held && held.tenantId !== mirror.tenantId) throw new ConflictError(`Memory ${mirror.id} belongs to another tenant`);
      const id = lastId + 1;
      const row: Prediction = {
        id, memoryId: mirror.id, tenantId, classTag: input.classTag, claimText: input.claimText,
        estimateValue: input.estimateValue ?? null, estimateUnit: input.estimateUnit ?? null, targetDate: input.targetDate ?? null,
        actualValue: null, closureState: 'open', closedAt: null, closureNote: null, createdAt: new Date().toISOString(),
      };
      // The rows are kept only once both audit rows are in, as one transaction would have it.
      await base.store.appendAuditEvents([
        {
          tenantId, actor, op: 'predict_create', targetId: String(id),
          metadata: { prediction_id: id, class_tag: input.classTag, has_estimate: input.estimateValue !== undefined, target_date: input.targetDate ?? null },
        },
        { tenantId: mirror.tenantId, actor, op: 'remember', targetId: mirror.id, metadata: { kind: mirror.kind ?? 'distilled', scope: mirror.scope ?? null } },
      ]);
      lastId = id;
      rows.set(id, row);
      mirrors.set(mirror.id, structuredClone(mirror));
      return structuredClone(row);
    },
    async closePrediction(tenantId, id, close, actor) {
      const row = owned(tenantId, id);
      if (!row) throw new NotFoundError(`closePrediction: prediction ${id} not found for tenant ${tenantId}`);
      if (row.closureState !== 'open') {
        throw new BadRequestError(`closePrediction: prediction ${id} is already closed (state='${row.closureState}'); cannot re-close. Open predictions only.`);
      }
      const closed: Prediction = {
        ...row, actualValue: close.actualValue ?? null, closureState: close.closureState, closedAt: new Date().toISOString(), closureNote: close.closureNote ?? null,
      };
      await base.store.appendAuditEvents([{
        tenantId, actor, op: 'predict_close', targetId: String(id),
        metadata: { prediction_id: id, closure_state: close.closureState, has_actual: close.actualValue !== undefined },
      }]);
      rows.set(id, closed);
      return structuredClone(closed);
    },
    async predictionById(tenantId, id) {
      return structuredClone(owned(tenantId, id) ?? null);
    },
    async listPredictions(tenantId, { classTag, closureState, limit, after }) {
      const below = (row: Prediction): boolean => {
        if (!after) return true;
        const byKey = byBytes(row.createdAt, String(after.key));
        return byKey < 0 || (byKey === 0 && row.id < Number(after.id));
      };
      const hits = [...rows.values()].filter((row) => row.tenantId === tenantId && (classTag === undefined || row.classTag === classTag)
        && (closureState === undefined || row.closureState === closureState) && below(row));
      return structuredClone(hits.sort(newestFirst).slice(0, limit));
    },
    async predictionBaserate(tenantId, classTag, actor) {
      const closed = [...rows.values()].sort((a, b) => a.id - b.id).flatMap((row) => (
        row.tenantId === tenantId && row.classTag === classTag && row.closureState === 'closed' && row.estimateValue !== null && row.actualValue !== null
          ? [{ estimate_value: row.estimateValue, actual_value: row.actualValue }]
          : []
      ));
      const baserate = predictionBaserateOf(classTag, closed);
      await base.store.appendAuditEvents([{ tenantId, actor, op: 'predict_baserate', targetId: classTag, metadata: { class_tag: classTag, n_closed: baserate.nClosed } }]);
      return baserate;
    },
  };

  const store: InMemoryPredictionsStore['store'] = {
    ...base.store,
    async entriesByIds(ids, tenantId) {
      const wanted = new Set(ids.slice(0, 500));
      const found = [...mirrors.values()].filter((e) => wanted.has(e.id) && (tenantId === undefined || e.tenantId === tenantId));
      return structuredClone(found.sort((a, b) => byBytes(a.created, b.created) || byBytes(a.content, b.content) || byBytes(a.id, b.id)));
    },
    predictions,
  };
  return { store, auditRows: base.auditRows };
}
