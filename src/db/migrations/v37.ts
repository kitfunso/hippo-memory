import { tableExists } from '../tables.js';
import type { Migration } from './types.js';

export const v37: Migration = {
    version: 37,
    up: (db) => {
      // E3.3 graph-on-consolidated guard (docs/plans/2026-06-01-e3-graph-guard.md).
      // The graph layer (entities + relations) sits ON TOP OF consolidated state and
      // must NEVER index the raw layer. The substrate: entities + relations +
      // graph_extraction_queue, each FK-ing to memories and guarded so they can only
      // reference CONSOLIDATED memories (kind IN ('distilled','superseded')), never
      // kind='raw'. New tables -> real CHECK constraints (unlike the ALTER'd memories,
      // whose kind CHECK lives in triggers). The kind/source MATCH (source_kind ==
      // the FK'd memory's actual kind) cannot be a CHECK (CHECK can't subquery), so it
      // is a BEFORE INSERT *and* BEFORE UPDATE trigger (the subquery-capable pattern
      // from the v30 decisions / predictions tenant-match triggers). Both INSERT and
      // UPDATE are guarded: an INSERT-only guard is bypassable via a raw SQL UPDATE
      // that moves a row onto a raw memory (plan-eng-critic 2026-06-01). All column
      // names checked vs SQL reserved words (rule 10): rel_type avoids REFERENCES.
      if (!tableExists(db, 'entities')) {
        db.exec(`
          CREATE TABLE entities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL,
            entity_type TEXT NOT NULL
              CHECK (entity_type IN ('person', 'project', 'customer', 'system', 'policy', 'decision')),
            name TEXT NOT NULL,
            memory_id TEXT NOT NULL,
            source_kind TEXT NOT NULL CHECK (source_kind IN ('distilled', 'superseded')),
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
          )
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_tenant ON entities(tenant_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_memory ON entities(memory_id)`);
        db.exec(`
          CREATE TABLE relations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL,
            from_entity_id INTEGER NOT NULL,
            to_entity_id INTEGER NOT NULL,
            rel_type TEXT NOT NULL
              CHECK (rel_type IN ('owns', 'supersedes', 'depends-on', 'blocked-by', 'references')),
            memory_id TEXT NOT NULL,
            source_kind TEXT NOT NULL CHECK (source_kind IN ('distilled', 'superseded')),
            created_at TEXT NOT NULL,
            FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
            FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
          )
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_tenant ON relations(tenant_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_memory ON relations(memory_id)`);
        db.exec(`
          CREATE TABLE graph_extraction_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL,
            memory_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('distilled', 'superseded')),
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'processed', 'skipped')),
            enqueued_at TEXT NOT NULL,
            processed_at TEXT,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
          )
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_queue_status ON graph_extraction_queue(tenant_id, status)`);

        // entities guard: source_kind must equal the FK'd memory's actual kind (so a
        // raw memory or a lying source_kind both ABORT), and tenant must match. Both
        // INSERT and UPDATE (UPDATE fires when memory_id/source_kind/tenant_id change).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_entities_consolidated_only_insert
          BEFORE INSERT ON entities
          BEGIN
            SELECT CASE
              WHEN NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'entities.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'entities.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_entities_consolidated_only_update
          BEFORE UPDATE ON entities
          WHEN NEW.memory_id IS NOT OLD.memory_id
            OR NEW.source_kind IS NOT OLD.source_kind
            OR NEW.tenant_id IS NOT OLD.tenant_id
          BEGIN
            SELECT CASE
              WHEN NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'entities.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'entities.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);

        // relations guard: source_kind must equal the FK'd memory's kind; tenant must
        // match the memory AND both endpoint entities (no cross-tenant edges).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_relations_consolidated_only_insert
          BEFORE INSERT ON relations
          BEGIN
            SELECT CASE
              WHEN NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'relations.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'relations.tenant_id must match memories.tenant_id for the referenced memory')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.from_entity_id)
              THEN RAISE(ABORT, 'relations.tenant_id must match the from_entity tenant (no cross-tenant edges)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.to_entity_id)
              THEN RAISE(ABORT, 'relations.tenant_id must match the to_entity tenant (no cross-tenant edges)')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_relations_consolidated_only_update
          BEFORE UPDATE ON relations
          WHEN NEW.memory_id IS NOT OLD.memory_id
            OR NEW.source_kind IS NOT OLD.source_kind
            OR NEW.tenant_id IS NOT OLD.tenant_id
            OR NEW.from_entity_id IS NOT OLD.from_entity_id
            OR NEW.to_entity_id IS NOT OLD.to_entity_id
          BEGIN
            SELECT CASE
              WHEN NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'relations.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'relations.tenant_id must match memories.tenant_id for the referenced memory')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.from_entity_id)
              THEN RAISE(ABORT, 'relations.tenant_id must match the from_entity tenant (no cross-tenant edges)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.to_entity_id)
              THEN RAISE(ABORT, 'relations.tenant_id must match the to_entity tenant (no cross-tenant edges)')
            END;
          END
        `);

        // graph_extraction_queue guard: kind must equal the FK'd memory's actual kind
        // (so a raw memory ABORTs), and tenant must match. INSERT and UPDATE.
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_graph_queue_consolidated_only_insert
          BEFORE INSERT ON graph_extraction_queue
          BEGIN
            SELECT CASE
              WHEN NEW.kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'graph_extraction_queue.kind must equal the referenced memory kind; only consolidated memories are queued (no raw)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'graph_extraction_queue.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_graph_queue_consolidated_only_update
          BEFORE UPDATE ON graph_extraction_queue
          WHEN NEW.memory_id IS NOT OLD.memory_id
            OR NEW.kind IS NOT OLD.kind
            OR NEW.tenant_id IS NOT OLD.tenant_id
          BEGIN
            SELECT CASE
              WHEN NEW.kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'graph_extraction_queue.kind must equal the referenced memory kind; only consolidated memories are queued (no raw)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'graph_extraction_queue.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);

        // Reverse guard (codex-review-critic 2026-06-01, P1): the graph-table triggers
        // only fire on writes to the GRAPH tables. They do NOT fire when an
        // already-indexed memory is later mutated. So 'UPDATE memories SET kind=raw'
        // (or a tenant change) on a memory the graph references would silently leave
        // entity/relation/queue rows pointing at a raw / cross-tenant memory while
        // their source_kind stays 'distilled' - bypassing the central 'graph never
        // indexes raw' invariant after insertion. This trigger closes that direction:
        // a memory cannot be reclassified to raw, nor moved cross-tenant, WHILE the
        // graph references it (rebuild/remove the graph rows first). Cheap: the EXISTS
        // checks are only evaluated when kind actually becomes raw or tenant changes.
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_memories_graph_referenced_guard
          BEFORE UPDATE ON memories
          WHEN (NEW.kind IS NOT OLD.kind OR NEW.tenant_id IS NOT OLD.tenant_id)
            AND (
              EXISTS (SELECT 1 FROM entities WHERE memory_id = OLD.id)
              OR EXISTS (SELECT 1 FROM relations WHERE memory_id = OLD.id)
              OR EXISTS (SELECT 1 FROM graph_extraction_queue WHERE memory_id = OLD.id)
            )
          BEGIN
            SELECT RAISE(ABORT, 'cannot change the kind or tenant of a memory while the graph references it (E3.3 graph-on-consolidated guard); a graph-referenced memory is immutable in kind/tenant - rebuild/remove the graph rows first, or rebuild them after supersession');
          END
        `);
        // Reverse guard #2 (codex-review-critic 2026-06-01 retry, P2): an entity that is
        // a relation endpoint cannot be moved cross-tenant. The entity UPDATE trigger
        // validates the entity against its source memory, but an existing relation
        // pointing at the entity is NOT re-validated, so a raw 'UPDATE entities SET
        // tenant_id=?, memory_id=?' to another tenant would leave a tenant-A relation
        // pointing at a tenant-B entity. Block the tenant move while the entity is
        // referenced by any relation (rebuild the relations first).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_entities_no_tenant_move_when_referenced
          BEFORE UPDATE ON entities
          WHEN NEW.tenant_id IS NOT OLD.tenant_id
            AND EXISTS (SELECT 1 FROM relations WHERE from_entity_id = OLD.id OR to_entity_id = OLD.id)
          BEGIN
            SELECT RAISE(ABORT, 'cannot move an entity cross-tenant while a relation references it as an endpoint (E3.3 graph-on-consolidated guard); rebuild/remove the relations first');
          END
        `);
      }
    },
};
