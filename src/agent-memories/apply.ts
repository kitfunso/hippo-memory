// One container's sync in one transaction on the target store: lookup, plan, then every write (plan designs 6 to 8).
import { strengthAblation } from '../core/ablation.js';
import { Layer, calculateStrength, createMemory, type MemoryEntry } from '../core/memory.js';
import { redactSecretsStrict } from '../util/secret-detect.js';
import type { ContainerTx, ImportTarget } from '../store/port/agent-import.js';
import { itemHash } from './keys.js';
import { planContainer, type ContainerPlan, type DormantRow, type LiveRow, type PlannedWrite } from './plan.js';
import { emptyTally, type Tally } from './report.js';
import { MIN_ITEM_CHARS, itemSource, splitSource, storedText } from './source.js';
import { SYNC_ACTOR, type AgentMemoryTool } from '../core/agent-memory-tools.js';
import type { Container, MemoryItem } from './types.js';

export interface StoreSession {
  readonly target: ImportTarget;
  readonly tenantId: string;
  readonly baseHalfLifeDays: number;
  /** Stamped on written rows; undefined lets the store stamp its own project. */
  readonly originProject: string | undefined;
  /** Whether the text is already stored live by another path, as seen where the new row goes. */
  readonly isDuplicate: (text: string) => boolean;
  readonly dryRun: boolean;
}

export interface ContainerWork {
  readonly tool: AgentMemoryTool;
  readonly container: Container;
  /** `containerPrefix(tool, containerId)`: every row of the container has a source starting with it. */
  readonly prefix: string;
  /** Legacy rows that take an item's key as they are, by key (plan design 10, first round). */
  readonly adopt: ReadonlyMap<string, readonly MemoryEntry[]>;
  /** Legacy rows a new row of the key supersedes, by key (second round). */
  readonly replace: ReadonlyMap<string, readonly MemoryEntry[]>;
  /**
   * This container's prefixes under the project's earlier names; their rows move here, so a new id imports nothing
   * twice.
   */
  readonly legacyPrefixes: readonly string[];
}

export interface ContainerOutcome {
  readonly tally: Tally;
  /** Rows to mirror after commit, as they now stand. */
  readonly mirror: readonly MemoryEntry[];
  /** Rows set aside, whose mirrors are purged after commit. */
  readonly purge: readonly string[];
}

/** Throws SQLITE_BUSY when another writer holds the store past its busy timeout; nothing is written then. */
export function syncContainer(s: StoreSession, work: ContainerWork): ContainerOutcome {
  return s.target.inContainer('sync_container', s.dryRun, (tx) => new ContainerRun(s, tx, work).run());
}

type Refusal = 'short' | 'secret' | 'rejected';

class ContainerRun {
  private readonly tally = emptyTally();
  private readonly mirror: MemoryEntry[] = [];
  private readonly purge: string[] = [];
  private readonly rows = new Map<string, MemoryEntry>();
  private readonly items = new Map<string, MemoryItem>();
  private readonly tag: string;

  constructor(private readonly s: StoreSession, private readonly tx: ContainerTx, private readonly w: ContainerWork) {
    this.tag = w.tool.tag;
    for (const item of w.container.items) this.items.set(item.key, item);
  }

  run(): ContainerOutcome {
    this.adoptLegacy();
    for (const old of this.w.legacyPrefixes) this.adoptPrefix(old);
    const live = this.tx.liveBySourcePrefix(this.s.tenantId, this.w.prefix);
    for (const row of [...live, ...[...this.w.replace.values()].flat()]) this.rows.set(row.id, row);
    const refusals = this.refusals();
    const liveRows = live.map((row) => this.liveRow(row));
    const plan = planContainer({
      textKeyed: this.w.container.textKeyed,
      items: this.w.container.items.map((item) => ({
        key: item.key,
        hash: itemHash(item.text),
        refused: refusals.has(item.key),
      })),
      skipped: this.w.container.skipped,
      live: liveRows,
      dormant: this.dormantRows(new Set(liveRows.map((r) => r.key)), refusals),
      legacy: new Map([...this.w.replace].map(([key, rows]) => [key, rows.map((r) => r.id)])),
      isDuplicate: (item) => this.s.isDuplicate(storedText(this.item(item.key).text)),
    });
    for (const reason of refusals.values()) this.tally[reason]++;
    this.tally.unread += this.w.container.skipped.length;
    this.apply(plan);
    return { tally: this.tally, mirror: this.mirror, purge: this.purge };
  }

  private apply(plan: ContainerPlan): void {
    this.tally.unchanged += plan.unchanged;
    this.tally.duplicate += plan.duplicates;
    for (const id of plan.retag) this.retag(this.row(id));
    for (const { id, by } of plan.collapse) if (this.supersede(this.row(id), by)) this.tally.collapsed++;
    for (const write of plan.writes) this.write(write);
    for (const { key, dormantId } of plan.restores) this.restore(key, dormantId);
    for (const id of plan.setAside) this.setAside(this.row(id));
  }

  /** Same text as a current note: the legacy row takes the note's key, keeping its id, recall count and outcomes. */
  private adoptLegacy(): void {
    for (const [key, rows] of this.w.adopt) {
      const item = this.items.get(key);
      if (item === undefined) continue;
      const source = itemSource(this.w.prefix, key, item.text);
      for (const row of rows) {
        if (this.tx.renameSource(row.tenant_id, row.id, row.source, source) === 0) continue;
        this.tally.adopted++;
        this.mirror.push({ ...row, source });
      }
    }
  }

  /**
   * Rows filed under an earlier project name keep their id and history; dormant ones move too, scanned only until this
   * prefix holds live rows.
   */
  private adoptPrefix(old: string): void {
    const origin = this.s.originProject ?? null;
    let moved = 0;
    for (const row of this.tx.liveBySourcePrefix(this.s.tenantId, old)) {
      const source = this.w.prefix + row.source.slice(old.length);
      if (
        this.tx.renameSourceAndOrigin(row.tenant_id, row.id, { from: row.source, to: source, origin }) === 0
      ) {
        continue;
      }
      moved++;
      this.mirror.push({ ...row, source, origin_project: origin ?? row.origin_project });
    }
    this.tally.renamed += moved;
    if (
      moved === 0 &&
      (this.w.container.items.length === 0 ||
        this.tx.liveBySourcePrefix(this.s.tenantId, this.w.prefix).length > 0)
    ) {
      return;
    }
    for (const snap of this.tx.dormantBySourcePrefix(this.s.tenantId, old)) {
      const source = this.w.prefix + snap.entry.source.slice(old.length);
      this.tx.replaceDormant(this.s.tenantId, snap.entry.id, {
        ...snap.entry,
        source,
        origin_project: origin ?? snap.entry.origin_project,
      });
    }
  }

  private refusals(): Map<string, Refusal> {
    const out = new Map<string, Refusal>();
    for (const item of this.w.container.items) {
      const reason = this.refusal(item);
      if (reason !== null) out.set(item.key, reason);
    }
    return out;
  }

  // The rejection lookup reads the capped text, as the write would store it, so a rejected note writes no audit row.
  private refusal(item: MemoryItem): Refusal | null {
    if (item.text.trim().length < MIN_ITEM_CHARS) return 'short';
    // Imported rows reach prompts, so the bar is text leaving the machine: Bearer headers and JWTs count too.
    if (redactSecretsStrict(item.text) !== item.text) return 'secret';
    if (this.tx.isRejected(this.s.tenantId, storedText(item.text))) {
      return 'rejected';
    }
    return null;
  }

  private liveRow(row: MemoryEntry): LiveRow {
    return {
      id: row.id,
      ...splitSource(row.source, this.w.prefix),
      tagged: row.tags.includes(this.tag),
      created: row.created,
    };
  }

  /** Read only when a present key has no live row, which after the first import is rare. */
  private dormantRows(liveKeys: ReadonlySet<string>, refusals: ReadonlyMap<string, Refusal>): DormantRow[] {
    const needed = this.w.container.items.some((item) => !refusals.has(item.key) && !liveKeys.has(item.key));
    if (!needed) return [];
    return this.tx.dormantBySourcePrefix(this.s.tenantId, this.w.prefix)
      .filter((snap) => !snap.entry.superseded_by)
      .map((snap) => ({
        id: snap.entry.id,
        ...splitSource(snap.entry.source, this.w.prefix),
        dormantAt: snap.dormantAt,
      }));
  }

  private retag(row: MemoryEntry): void {
    const tagged: MemoryEntry = { ...row, tags: [...row.tags, this.tag] };
    this.tx.setTags(tagged);
    this.tally.retagged++;
    this.mirror.push(tagged);
  }

  /** api.supersede's steps on this transaction; false when another writer superseded the row first. */
  private supersede(old: MemoryEntry, newId: string): boolean {
    if (!this.tx.supersede(old.tenant_id, old.id, newId)) return false;
    if (old.dag_parent_id) this.tx.markSummaryDirty(old.dag_parent_id, old.tenant_id, SYNC_ACTOR);
    this.tx.appendAudit({
      tenantId: old.tenant_id,
      actor: SYNC_ACTOR,
      op: 'supersede',
      targetId: old.id,
      metadata: { newId },
    });
    this.mirror.push({ ...old, superseded_by: newId });
    return true;
  }

  private write(planned: PlannedWrite): void {
    const entry = this.newRow(this.item(planned.key));
    if (!this.gated(entry)) return;
    this.tally[planned.supersedes.length > 0 ? 'replaced' : 'imported']++;
    for (const id of planned.supersedes) this.supersede(this.row(id), entry.id);
  }

  private newRow(item: MemoryItem): MemoryEntry {
    const base = createMemory(storedText(item.text), {
      layer: Layer.Episodic,
      tags: [this.tag],
      source: itemSource(this.w.prefix, item.key, item.text),
      confidence: 'observed',
      kind: 'distilled',
      tenantId: this.s.tenantId,
      baseHalfLifeDays: this.s.baseHalfLifeDays,
    });
    // The note's own time when it is earlier than now; the loader reads any form but toISOString as drift.
    const created = Number.isFinite(item.updatedAt)
      ? new Date(Math.min(item.updatedAt, Date.parse(base.created))).toISOString()
      : base.created;
    const origin = this.s.originProject === undefined ? {} : { origin_project: this.s.originProject };
    return this.tx.stampOrigin({ ...base, created, valid_from: created, ...origin });
  }

  private gated(entry: MemoryEntry): boolean {
    const result = this.tx.gatedWrite(entry, { actor: SYNC_ACTOR, worthCheck: false });
    if (result === 'written') {
      this.mirror.push(entry);
      return true;
    }
    this.tally[result === 'skipped:rejected' ? 'rejected' : 'secret']++;
    return false;
  }

  /** A deleted note came back unchanged: its old row returns with its id and history, under the sync's own audit op. */
  private restore(key: string, dormantId: string): void {
    const snap = this.tx.readDormant(this.s.tenantId, dormantId);
    const taken = this.tx.entryIdTaken(dormantId);
    if (snap === null || taken) {
      this.write({ key, hash: '', supersedes: [] });
      return;
    }
    const now = new Date();
    const tags = Array.isArray(snap.entry.tags) ? snap.entry.tags.filter((t) => t !== this.tag) : [];
    const revived: MemoryEntry = {
      ...createMemory('dormant snapshot defaults', { baseHalfLifeDays: this.s.baseHalfLifeDays }),
      ...snap.entry,
      tags: [...tags, this.tag],
      last_retrieved: now.toISOString(),
    };
    if (
      !this.gated(
        this.tx.stampOrigin({
          ...revived,
          strength: calculateStrength(revived, now, { ablation: strengthAblation() }),
        }),
      )
    ) {
      return;
    }
    this.tx.deleteDormant(this.s.tenantId, dormantId);
    this.tx.appendAudit({
      tenantId: this.s.tenantId,
      actor: SYNC_ACTOR,
      op: 'agent_memory_restore',
      targetId: dormantId,
      metadata: { reason: snap.reason, dormantAt: snap.dormantAt },
    });
    this.tally.restored++;
  }

  private setAside(row: MemoryEntry): void {
    const why = this.items.has(splitSource(row.source, this.w.prefix).key) ? 'note-changed' : 'note-gone';
    const result = this.tx.setAside(this.tag, row, why);
    if (result.kind === 'untagged') {
      this.tally.untagged++;
      this.mirror.push(result.entry);
    } else {
      this.tally.setAside++;
      this.purge.push(result.id);
    }
  }

  private row(id: string): MemoryEntry {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`agent memory sync: planned row ${id} was not in the lookup`);
    return row;
  }

  private item(key: string): MemoryItem {
    const item = this.items.get(key);
    if (item === undefined) throw new Error(`agent memory sync: planned key ${key} was not read`);
    return item;
  }
}
