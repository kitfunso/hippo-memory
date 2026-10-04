import type { DatabaseSyncLike } from '../sqlite.js';
import type { Migration } from './types.js';

const ENTITIES_TABLE = `
        CREATE TABLE entities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          entity_type TEXT NOT NULL
            CHECK (entity_type IN ('person', 'project', 'customer', 'system', 'policy', 'decision')),
          name TEXT NOT NULL,
          memory_id TEXT,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('distilled', 'superseded')),
          source_object_type TEXT
            CHECK (source_object_type IS NULL OR source_object_type IN ('decision', 'policy', 'customer', 'project')),
          source_object_id INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
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
          memory_id TEXT,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('distilled', 'superseded')),
          source_object_type TEXT
            CHECK (source_object_type IS NULL OR source_object_type IN ('decision', 'policy', 'customer', 'project')),
          source_object_id INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
          FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
        )
      `;

// entities guard (dual-provenance): at least one valid provenance, no raw.
//  - all-null  -> ABORT.
//  - memory path (memory_id NOT NULL): source_kind == the FK'd memory's kind
//    (raw / lying source_kind ABORT) AND tenant-match.
//  - object path (memory_id NULL): the (type,id) points at an EXISTING same-tenant
//    E2 row whose status is active|superseded (explicit 4-way CASE per table).
const TRG_ENTITIES_CONSOLIDATED_ONLY_INSERT = `
        CREATE TRIGGER IF NOT EXISTS trg_entities_consolidated_only_insert
        BEFORE INSERT ON entities
        BEGIN
          SELECT CASE
            WHEN (NEW.source_object_type IS NULL AND NEW.source_object_id IS NOT NULL)
              OR (NEW.source_object_type IS NOT NULL AND NEW.source_object_id IS NULL)
            THEN RAISE(ABORT, 'source_object_type and source_object_id must be set together (all-or-none)')
            WHEN NEW.memory_id IS NULL AND NEW.source_object_id IS NULL
            THEN RAISE(ABORT, 'graph row needs a memory or a source object')
            WHEN NEW.memory_id IS NOT NULL AND NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'entities.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'entities.tenant_id must match memories.tenant_id for the referenced memory')
            WHEN NEW.source_object_type ='decision'
              AND NOT EXISTS (SELECT 1 FROM decisions WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded decision in the same tenant')
            WHEN NEW.source_object_type ='policy'
              AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded policy in the same tenant')
            WHEN NEW.source_object_type ='customer'
              AND NOT EXISTS (SELECT 1 FROM customer_notes WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded customer_note in the same tenant')
            WHEN NEW.source_object_type ='project'
              AND NOT EXISTS (SELECT 1 FROM project_briefs WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded project_brief in the same tenant')
          END;
        END
      `;

const TRG_ENTITIES_CONSOLIDATED_ONLY_UPDATE = `
        CREATE TRIGGER IF NOT EXISTS trg_entities_consolidated_only_update
        BEFORE UPDATE ON entities
        WHEN NEW.memory_id IS NOT OLD.memory_id
          OR NEW.source_kind IS NOT OLD.source_kind
          OR NEW.tenant_id IS NOT OLD.tenant_id
          OR NEW.source_object_type IS NOT OLD.source_object_type
          OR NEW.source_object_id IS NOT OLD.source_object_id
        BEGIN
          -- NO all-null ABORT on UPDATE: node:sqlite fires this BEFORE UPDATE trigger from
          -- the FK ON DELETE SET NULL action even with recursive_triggers OFF (empirically
          -- verified - the plan's "SET NULL does not fire the guard" premise is false for
          -- this build). A mirror forget on a memory-only entity legitimately produces an
          -- all-null row; aborting here would block the memory delete. The INSERT guard
          -- still forbids CREATING a provenance-less row, and the next graph rebuild clears
          -- any all-null orphan. A raw UPDATE to all-null is harmless (not recall-surfaced).
          -- Object-path STATUS is validated only when the object columns THEMSELVES change
          -- (an explicit re-point), NOT on the FK ON DELETE SET NULL transition (which changes
          -- only memory_id). This threads the needle (codex P1 + P2 round 4): the SET NULL of a
          -- since-closed object's mirror is NOT blocked (object cols unchanged -> object checks
          -- skip), while an explicit raw UPDATE that re-points the row to a bad/closed/cross-
          -- tenant object IS rejected. all-or-none + memory-path (raw/tenant) always apply.
          SELECT CASE
            WHEN (NEW.source_object_type IS NULL AND NEW.source_object_id IS NOT NULL)
              OR (NEW.source_object_type IS NOT NULL AND NEW.source_object_id IS NULL)
            THEN RAISE(ABORT, 'entities.source_object_type and source_object_id must be set together (all-or-none)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'entities.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'entities.tenant_id must match memories.tenant_id for the referenced memory')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='decision'
              AND NOT EXISTS (SELECT 1 FROM decisions WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded decision in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='policy'
              AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded policy in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='customer'
              AND NOT EXISTS (SELECT 1 FROM customer_notes WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded customer_note in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='project'
              AND NOT EXISTS (SELECT 1 FROM project_briefs WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded project_brief in the same tenant')
          END;
        END
      `;

// relations guard (dual-provenance) + the existing from/to endpoint same-tenant checks.
const TRG_RELATIONS_CONSOLIDATED_ONLY_INSERT = `
        CREATE TRIGGER IF NOT EXISTS trg_relations_consolidated_only_insert
        BEFORE INSERT ON relations
        BEGIN
          SELECT CASE
            WHEN (NEW.source_object_type IS NULL AND NEW.source_object_id IS NOT NULL)
              OR (NEW.source_object_type IS NOT NULL AND NEW.source_object_id IS NULL)
            THEN RAISE(ABORT, 'source_object_type and source_object_id must be set together (all-or-none)')
            WHEN NEW.memory_id IS NULL AND NEW.source_object_id IS NULL
            THEN RAISE(ABORT, 'graph row needs a memory or a source object')
            WHEN NEW.memory_id IS NOT NULL AND NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'relations.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match memories.tenant_id for the referenced memory')
            WHEN NEW.source_object_type ='decision'
              AND NOT EXISTS (SELECT 1 FROM decisions WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded decision in the same tenant')
            WHEN NEW.source_object_type ='policy'
              AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded policy in the same tenant')
            WHEN NEW.source_object_type ='customer'
              AND NOT EXISTS (SELECT 1 FROM customer_notes WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded customer_note in the same tenant')
            WHEN NEW.source_object_type ='project'
              AND NOT EXISTS (SELECT 1 FROM project_briefs WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded project_brief in the same tenant')
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
          OR NEW.source_object_type IS NOT OLD.source_object_type
          OR NEW.source_object_id IS NOT OLD.source_object_id
          OR NEW.from_entity_id IS NOT OLD.from_entity_id
          OR NEW.to_entity_id IS NOT OLD.to_entity_id
        BEGIN
          -- NO all-null ABORT on UPDATE (same reason as the entities UPDATE trigger): the FK
          -- ON DELETE SET NULL fires this trigger in node:sqlite, and a mirror forget on a
          -- memory-only relation legitimately nulls memory_id. The INSERT guard still forbids
          -- creating a provenance-less relation; the rebuild clears any orphan.
          -- Object-path STATUS validated only on an explicit object-column change, NOT on the
          -- FK SET NULL transition (see the entities UPDATE trigger): SET NULL of a since-closed
          -- object's mirror is not blocked (object cols unchanged), while an explicit re-point to
          -- a bad object is rejected. all-or-none + memory-path + endpoint checks always apply.
          SELECT CASE
            WHEN (NEW.source_object_type IS NULL AND NEW.source_object_id IS NOT NULL)
              OR (NEW.source_object_type IS NOT NULL AND NEW.source_object_id IS NULL)
            THEN RAISE(ABORT, 'relations.source_object_type and source_object_id must be set together (all-or-none)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'relations.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match memories.tenant_id for the referenced memory')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='decision'
              AND NOT EXISTS (SELECT 1 FROM decisions WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded decision in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='policy'
              AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded policy in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='customer'
              AND NOT EXISTS (SELECT 1 FROM customer_notes WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded customer_note in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='project'
              AND NOT EXISTS (SELECT 1 FROM project_briefs WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded project_brief in the same tenant')
            WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.from_entity_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match the from_entity tenant (no cross-tenant edges)')
            WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.to_entity_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match the to_entity tenant (no cross-tenant edges)')
          END;
        END
      `;

// Recreated VERBATIM from v37 (logic unchanged): an entity that is a relation
// endpoint cannot be moved cross-tenant while referenced. trg_memories_graph_referenced_guard
// (on memories) and trg_graph_queue_* (on graph_extraction_queue) are NOT recreated
// here: those tables are not dropped by v38, so the triggers survive.
const TRG_ENTITIES_NO_TENANT_MOVE_WHEN_REFERENCED = `
        CREATE TRIGGER IF NOT EXISTS trg_entities_no_tenant_move_when_referenced
        BEFORE UPDATE ON entities
        WHEN NEW.tenant_id IS NOT OLD.tenant_id
          AND EXISTS (SELECT 1 FROM relations WHERE from_entity_id = OLD.id OR to_entity_id = OLD.id)
        BEGIN
          SELECT RAISE(ABORT, 'cannot move an entity cross-tenant while a relation references it as an endpoint (E3.3 graph-on-consolidated guard); rebuild/remove the relations first');
        END
      `;

export const v38: Migration = {
    version: 38,
    up: (db) => {
      // E2-provenance: anchor graph entity/relation provenance to the authoritative E2
      // object (decision/policy/customer-note/project-brief) instead of the decaying
      // memory mirror (docs/plans/2026-06-03-graph-e2-provenance.md). An in-force E2
      // object must STAY in the graph after its mirror memory is forgotten or
      // consolidation-pruned. The graph is a PURE DERIVED CACHE (clearGraph + rebuild on
      // every `graph extract` / `sleep`), so v38 DROPs+recreates entities/relations (no
      // data copy) and the next extract repopulates. graph_extraction_queue is untouched.
      //
      // Two provenance paths, "at least one, no raw":
      //  - memory path (memory_id NOT NULL): source_kind must equal the FK'd memory's live
      //    kind and that kind is distilled|superseded (raw still ABORTs) + tenant-match.
      //  - object path (memory_id NULL): source_object_type/id must reference an EXISTING
      //    same-tenant E2 row whose status is active|superseded (not closed). E2 objects
      //    are consolidated BY CONSTRUCTION, so the no-raw invariant still holds.
      //  - all-null is rejected.
      //
      // memory_id is now NULLABLE with ON DELETE SET NULL (was NOT NULL / CASCADE), so a
      // mirror forget/consolidate nulls the recall pointer without dropping the row. NOTE
      // (empirically verified, contradicts the SQLite docs): node:sqlite DOES fire the
      // BEFORE UPDATE guard from the FK SET NULL action even with recursive_triggers OFF.
      // So the *_consolidated_only_UPDATE triggers deliberately OMIT the all-null ABORT
      // (kept on INSERT) - otherwise a mirror delete of a memory-only row would be blocked.
      // See the per-trigger comments below. A SET NULL leaves source_kind at its old value
      // by design (the object path is distilled-by-construction; source_kind is only
      // re-checked when memory_id NOT NULL).
      // source_object_id is a SOFT (type,id) pointer (no hard FK) the rebuild re-validates,
      // so a legitimate E2 hard-delete is never blocked; a `closed` E2 row drops at next
      // extract. SQLite cannot parametrize a table name in a trigger, so the object-path
      // validation is an explicit 4-way CASE (one arm per E2 table).
      recreateGraphTables(db);
      createGraphGuards(db);
    },
};

function recreateGraphTables(db: DatabaseSyncLike): void {
  // Drop child (relations FK entities) first, then parent.
  db.exec('DROP TABLE IF EXISTS relations');
  db.exec('DROP TABLE IF EXISTS entities');

  db.exec(ENTITIES_TABLE);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_tenant ON entities(tenant_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_memory ON entities(memory_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_source_object ON entities(source_object_type, source_object_id) WHERE source_object_id IS NOT NULL`);

  db.exec(RELATIONS_TABLE);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_tenant ON relations(tenant_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_memory ON relations(memory_id)`);
  // Mirrors idx_entities_source_object: removeGraphEntitiesForObject (close-time cleanup)
  // deletes relations by (source_object_type, source_object_id), so index that pair.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_source_object ON relations(source_object_type, source_object_id) WHERE source_object_id IS NOT NULL`);
}

function createGraphGuards(db: DatabaseSyncLike): void {
  db.exec(TRG_ENTITIES_CONSOLIDATED_ONLY_INSERT);
  db.exec(TRG_ENTITIES_CONSOLIDATED_ONLY_UPDATE);

  db.exec(TRG_RELATIONS_CONSOLIDATED_ONLY_INSERT);
  db.exec(TRG_RELATIONS_CONSOLIDATED_ONLY_UPDATE);

  db.exec(TRG_ENTITIES_NO_TENANT_MOVE_WHEN_REFERENCED);
}
