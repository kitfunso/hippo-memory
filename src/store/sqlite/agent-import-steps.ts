// One container's planned steps on the caller's write scope: the rows they name are re-read first, and a plan whose
// rows moved on since the sync read them writes nothing.
import { SYNC_ACTOR } from '../../base/memory/agent-memory-tools.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import { chunked } from '../../base/util/chunked.js';
import { READ_PAGE_ROWS, rowsInPages } from '../../base/util/pages.js';
import type { DatabaseSyncLike } from '../../db/index.js';
import { appendAuditEvents } from './audit.js';
import {
  deleteDormantRow,
  dormantSnapshotsBySourcePrefix,
  readDormantSnapshot,
  replaceDormantEntry,
} from './dormant-rows.js';
import { stampOriginProject } from './entry-row.js';
import { entryIdTaken, loadEntriesByIds, selectLiveEntriesBySourcePrefix } from './entry-reads.js';
import { renameEntrySourceAndOrigin, renameEntrySource, setEntryTagsInTx, supersedeEntry } from './entry-writes.js';
import { gatedWrite } from './gated-write.js';
import type { StoreFiles } from './open.js';
import { setAsideRow } from './set-aside.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';
import type {
  AdoptStep,
  ContainerApply,
  GatedWriteResult,
  ImportStep,
  RestoreStep,
  StepOutcome,
} from '../port/agent-import.js';
import type { SetAsideWhy } from '../port/project-tags.js';
import type { EntryCursor } from '../port/types.js';

/** What the steps did, and the rows whose mirror files follow the commit. */
interface StepsRun {
  readonly outcomes: StepOutcome[];
  readonly mirror: MemoryEntry[];
  readonly purge: string[];
}

/** The tenant's live rows under `prefix`, one bounded statement per page. */
export function liveUnder(db: DatabaseSyncLike, tenantId: string, prefix: string): MemoryEntry[] {
  return [
    ...rowsInPages((after?: EntryCursor) =>
      selectLiveEntriesBySourcePrefix(db, tenantId, prefix, { limit: READ_PAGE_ROWS, after }),
    ),
  ];
}

/** Null when the rows the plan read have changed: nothing is written then, and the sync plans again. */
export function runSteps(db: DatabaseSyncLike, files: StoreFiles, plan: ContainerApply): StepsRun | null {
  const rows = standingRows(db, plan);
  return rows === null ? null : new ContainerSteps(db, files, plan, rows).run();
}

/** The rows under the plan's prefixes and those its steps name outside them, by id; null when the prefixes no longer
 * hold exactly the planned rows or an adopted row left its legacy source. */
function standingRows(db: DatabaseSyncLike, plan: ContainerApply): Map<string, MemoryEntry> | null {
  const rows = new Map<string, MemoryEntry>();
  for (const prefix of plan.prefixes) for (const row of liveUnder(db, plan.tenantId, prefix)) rows.set(row.id, row);
  if (rows.size !== plan.rows.length) return null;
  for (const want of plan.rows) {
    const row = rows.get(want.id);
    if (row === undefined || row.source !== want.source || row.tags.includes(plan.tag) !== want.tagged) return null;
  }
  const outside = [...new Set(plan.steps.flatMap(namedIds))].filter((id) => !rows.has(id));
  for (const ids of chunked(outside)) {
    for (const row of loadEntriesByIds(db, ids, plan.tenantId)) rows.set(row.id, row);
  }
  const adoptable = plan.steps.every(
    (step) => step.kind !== 'adopt' || (rows.get(step.id)?.source === step.from && !rows.get(step.id)?.supersededBy),
  );
  return adoptable ? rows : null;
}

function namedIds(step: ImportStep): readonly string[] {
  if (step.kind === 'adopt' || step.kind === 'supersede') return [step.id];
  return step.kind === 'write' ? step.supersedes : [];
}

class ContainerSteps {
  private readonly mirror: MemoryEntry[] = [];
  private readonly purge: string[] = [];

  constructor(
    private readonly db: DatabaseSyncLike,
    private readonly files: StoreFiles,
    private readonly plan: ContainerApply,
    private readonly rows: Map<string, MemoryEntry>,
  ) {}

  run(): StepsRun {
    const outcomes = this.plan.steps.map((step) => this.step(step));
    return { outcomes, mirror: this.mirror, purge: this.purge };
  }

  private step(step: ImportStep): StepOutcome {
    switch (step.kind) {
      case 'adopt':
        return this.adopt(step);
      case 'move':
        return this.move(step.id, step.to, step.origin);
      case 'moveDormant':
        return this.moveDormant(step.from, step.to, step.origin);
      case 'retag':
        return this.retag(step.id);
      case 'supersede':
        return this.supersede(step.id, step.by) ? 'done' : 'skipped';
      case 'write':
        return this.write(step.entry, step.supersedes);
      case 'restore':
        return this.restore(step);
      case 'setAside':
        return this.setAside(step.id, step.why);
    }
  }

  private adopt(step: AdoptStep): StepOutcome {
    const row = this.row(step.id);
    renameEntrySource(this.db, row.tenantId, row.id, step.from, step.to);
    return this.moved({ ...row, source: step.to });
  }

  private move(id: string, to: string, origin: string | null): StepOutcome {
    const row = this.row(id);
    renameEntrySourceAndOrigin(this.db, row.tenantId, id, { from: row.source, to, origin });
    return this.moved({ ...row, source: to, originProject: origin ?? row.originProject });
  }

  private retag(id: string): StepOutcome {
    const row = this.row(id);
    const tagged: MemoryEntry = { ...row, tags: [...row.tags, this.plan.tag] };
    setEntryTagsInTx(this.db, tagged);
    return this.moved(tagged);
  }

  /** Later steps see the row as it now stands, and its mirror is rewritten after the commit. */
  private moved(entry: MemoryEntry): StepOutcome {
    this.rows.set(entry.id, entry);
    this.mirror.push(entry);
    return 'done';
  }

  private moveDormant(from: string, to: string, origin: string | null): StepOutcome {
    const tenantId = this.plan.tenantId;
    for (const snap of dormantSnapshotsBySourcePrefix(this.db, tenantId, from)) {
      const source = to + snap.entry.source.slice(from.length);
      const originProject = origin ?? snap.entry.originProject;
      replaceDormantEntry(this.db, tenantId, snap.entry.id, { ...snap.entry, source, originProject });
    }
    return 'done';
  }

  /** api.supersede's steps on this transaction; false when the row is gone or another writer superseded it first. */
  private supersede(id: string, by: string): boolean {
    const old = this.rows.get(id);
    if (old === undefined || !supersedeEntry(this.db, old.tenantId, old.id, by)) return false;
    if (old.dagParentId) markSummaryDirtyInTx(this.db, old.dagParentId, old.tenantId, SYNC_ACTOR);
    appendAuditEvents(this.db, [
      {
        tenantId: old.tenantId,
        actor: SYNC_ACTOR,
        op: 'supersede',
        targetId: old.id,
        metadata: { newId: by },
      },
    ]);
    this.mirror.push({ ...old, supersededBy: by });
    return true;
  }

  private write(entry: MemoryEntry, supersedes: readonly string[]): GatedWriteResult {
    const result = this.gated(entry);
    if (result === 'written') for (const id of supersedes) this.supersede(id, entry.id);
    return result;
  }

  private gated(entry: MemoryEntry): GatedWriteResult {
    const stamped = stampOriginProject(this.files.hippoRoot, entry);
    const result = gatedWrite(this.db, this.files.hippoRoot, stamped, { actor: SYNC_ACTOR, worthCheck: false });
    if (result === 'written') this.mirror.push(stamped);
    return result;
  }

  /** A deleted note came back unchanged: its old row returns with its id and history, under the sync's own audit op. */
  private restore(step: RestoreStep): StepOutcome {
    const tenantId = this.plan.tenantId;
    const snap = readDormantSnapshot(this.db, tenantId, step.dormantId);
    if (snap === null || entryIdTaken(this.db, step.dormantId)) return this.write(step.fresh, []);
    const result = this.gated(step.revived);
    if (result !== 'written') return result;
    deleteDormantRow(this.db, tenantId, step.dormantId);
    appendAuditEvents(this.db, [
      {
        tenantId,
        actor: SYNC_ACTOR,
        op: 'agent_memory_restore',
        targetId: step.dormantId,
        metadata: { reason: snap.reason, dormantAt: snap.dormantAt },
      },
    ]);
    return 'restored';
  }

  private setAside(id: string, why: SetAsideWhy): StepOutcome {
    const result = setAsideRow(this.db, this.plan.tag, this.row(id), why, this.files);
    if (result.kind === 'untagged') this.mirror.push(result.entry);
    else this.purge.push(result.id);
    return result.kind;
  }

  private row(id: string): MemoryEntry {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`agent memory sync: planned row ${id} was not read`);
    return row;
  }
}
