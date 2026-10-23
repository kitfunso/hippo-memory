// The in-memory EntryWrites group: each write runs staged, so a refused or failed one leaves the rows as they were.
import { ConflictError } from '../../base/errors/api-errors.js';
import { RawAppendOnlyError } from '../../base/errors/raw-append-only.js';
import { entryAfterOutcome, type MemoryEntry } from '../../base/memory/memory.js';
import { readerReaches, targetReader } from '../../base/scope/recall-scope.js';
import type { EntryRemoval, EntryWrites, OutcomeWrite, PinWrite, SupersedeWrite } from '../port/entry-writes.js';
import { bumpCounter } from './rows.js';
import { archiveOne, inReach, markParentDirty, put, stage } from './staged.js';
import type { MemoryTables } from './tables.js';

function applyOutcomeIn(t: MemoryTables, outcome: OutcomeWrite): string[] {
  const { tenantId, actor, ids, good } = outcome;
  return stage(t, actor, (tx) => {
    const applied: string[] = [];
    for (const id of ids) {
      const row = tx.rows.get(id);
      if (!row || row.tenantId !== tenantId || !readerReaches(targetReader(outcome), row.scope)) continue;
      put(t, tx, entryAfterOutcome(row, good), actor);
      tx.audit.push({ tenantId, actor, op: 'outcome', targetId: id, metadata: { good } });
      applied.push(id);
    }
    return applied;
  });
}

function pinIn(t: MemoryTables, pin: PinWrite): MemoryEntry {
  return stage(t, pin.actor, (tx) => {
    const pinned = { ...inReach(tx, pin, pin.id), pinned: pin.pinned };
    put(t, tx, pinned, pin.actor);
    const metadata = { pinned: pin.pinned };
    tx.audit.push({ tenantId: pin.tenantId, actor: pin.actor, op: 'pin', targetId: pin.id, metadata });
    return structuredClone(tx.rows.get(pin.id) ?? pinned);
  });
}

function supersedeIn(t: MemoryTables, write: SupersedeWrite): void {
  const { tenantId, actor, oldId, successor } = write;
  stage(t, actor, (tx) => {
    const old = inReach(tx, write, oldId);
    if ((old.supersededBy ?? null) !== null) {
      throw new ConflictError(`Memory ${oldId} already superseded by another writer`);
    }
    tx.rows.set(oldId, { ...old, supersededBy: successor.id });
    if (old.dagParentId) markParentDirty(tx, old.dagParentId, tenantId, actor);
    put(t, tx, successor, actor);
    tx.audit.push({ tenantId, actor, op: 'supersede', targetId: oldId, metadata: { newId: successor.id } });
  });
}

function forgetIn(t: MemoryTables, removal: EntryRemoval): void {
  stage(t, removal.actor, (tx) => {
    const row = inReach(tx, removal, removal.id);
    if (row.kind === 'raw') throw new RawAppendOnlyError();
    tx.rows.delete(removal.id);
    tx.audit.push({ tenantId: row.tenantId, actor: removal.actor, op: 'forget', targetId: removal.id });
    if (row.dagParentId) markParentDirty(tx, row.dagParentId, row.tenantId, removal.actor);
  });
  bumpCounter(t, 'total_forgotten', 1);
}

export function memoryEntryWrites(t: MemoryTables): EntryWrites {
  return {
    writeEntry: async ({ entry, actor }) => stage(t, actor, (tx) => put(t, tx, entry, actor)),
    applyOutcome: async (outcome) => applyOutcomeIn(t, outcome),
    setPinned: async (pin) => pinIn(t, pin),
    supersede: async (write) => supersedeIn(t, write),
    archiveRaw: async (archive) => archiveOne(t, archive, () => undefined),
    forget: async (removal) => forgetIn(t, removal),
  };
}
