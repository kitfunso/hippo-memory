import { tableExists } from '../tables.js';
import type { Migration } from './types.js';

const ENTITIES_TABLE = `
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
        `;

const RELATIONS_TABLE = `
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
        `;

const GRAPH_EXTRACTION_QUEUE_TABLE = `
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
        `;

// entities guard: source_kind must equal the FK'd memory's actual kind (raw or a lying source_kind ABORTs) and tenant must match,
// on INSERT and on UPDATE (when memory_id/source_kind/tenant_id change).
const TRG_ENTITIES_CONSOLIDATED_ONLY_INSERT = `
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
        `;

const TRG_ENTITIES_CONSOLIDATED_ONLY_UPDATE = `
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
        `;

// relations guard: source_kind must equal the FK'd memory's kind; tenant must
// match the memory AND both endpoint entities (no cross-tenant edges).
const TRG_RELATIONS_CONSOLIDATED_ONLY_INSERT = `
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
        `;

const TRG_RELATIONS_CONSOLIDATED_ONLY_UPDATE = `
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
        `;

// graph_extraction_queue guard: kind must equal the FK'd memory's actual kind
// (so a raw memory ABORTs), and tenant must match. INSERT and UPDATE.
const TRG_GRAPH_QUEUE_CONSOLIDATED_ONLY_INSERT = `
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
        `;

const TRG_GRAPH_QUEUE_CONSOLIDATED_ONLY_UPDATE = `
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
        `;

// Reverse guard: graph triggers fire only on graph-table writes, so reclassifying an indexed memory to raw (or tenant) would break the no-raw invariant.
// Block both while the graph references the memory; the EXISTS checks run only when kind becomes raw or tenant changes.
const TRG_MEMORIES_GRAPH_REFERENCED_GUARD = `
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
        `;

// Second reverse guard: the entity UPDATE trigger does not re-validate existing relations, so a cross-tenant entity move would leave a tenant-A relation
// pointing at a tenant-B entity. Block the tenant move while any relation references the entity.
const TRG_ENTITIES_NO_TENANT_MOVE_WHEN_REFERENCED = `
          CREATE TRIGGER IF NOT EXISTS trg_entities_no_tenant_move_when_referenced
          BEFORE UPDATE ON entities
          WHEN NEW.tenant_id IS NOT OLD.tenant_id
            AND EXISTS (SELECT 1 FROM relations WHERE from_entity_id = OLD.id OR to_entity_id = OLD.id)
          BEGIN
            SELECT RAISE(ABORT, 'cannot move an entity cross-tenant while a relation references it as an endpoint (E3.3 graph-on-consolidated guard); rebuild/remove the relations first');
          END
        `;

export const v37: Migration = {
    version: 37,
    up: (db) => {
      // Graph-on-consolidated guard: entities, relations and graph_extraction_queue may reference only consolidated memories (distilled|superseded), never raw.
      // The kind match needs a subquery, so it is a BEFORE INSERT and UPDATE trigger (INSERT-only is bypassable). rel_type avoids the reserved word REFERENCES.
      if (!tableExists(db, 'entities')) {
        db.exec(ENTITIES_TABLE);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_tenant ON entities(tenant_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_memory ON entities(memory_id)`);
        db.exec(RELATIONS_TABLE);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_tenant ON relations(tenant_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_memory ON relations(memory_id)`);
        db.exec(GRAPH_EXTRACTION_QUEUE_TABLE);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_queue_status ON graph_extraction_queue(tenant_id, status)`);

        db.exec(TRG_ENTITIES_CONSOLIDATED_ONLY_INSERT);
        db.exec(TRG_ENTITIES_CONSOLIDATED_ONLY_UPDATE);

        db.exec(TRG_RELATIONS_CONSOLIDATED_ONLY_INSERT);
        db.exec(TRG_RELATIONS_CONSOLIDATED_ONLY_UPDATE);

        db.exec(TRG_GRAPH_QUEUE_CONSOLIDATED_ONLY_INSERT);
        db.exec(TRG_GRAPH_QUEUE_CONSOLIDATED_ONLY_UPDATE);

        db.exec(TRG_MEMORIES_GRAPH_REFERENCED_GUARD);
        db.exec(TRG_ENTITIES_NO_TENANT_MOVE_WHEN_REFERENCED);
      }
    },
};
