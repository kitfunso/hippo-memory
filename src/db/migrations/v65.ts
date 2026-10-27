import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

// Objects only: the sleep fill hashes the rows in short write scopes, never under the migration lock.
const HELD_TEXT_DIGESTS =
  `CREATE TABLE IF NOT EXISTS held_text_digests (tenant_id TEXT NOT NULL, rejection_digest TEXT NOT NULL, ` +
  `in_dormant INTEGER NOT NULL, memory_id TEXT NOT NULL, ` +
  `PRIMARY KEY (tenant_id, rejection_digest, in_dormant, memory_id)) WITHOUT ROWID`;

const INDEXES = [
  // Digest first, so the fill seeks the unfilled rows of every tenant at once.
  'idx_memories_rejection_digest ON memories(rejection_digest, tenant_id)',
  'idx_dormant_memories_rejection_digest ON dormant_memories(rejection_digest, tenant_id)',
  'idx_held_text_digests_memory ON held_text_digests(tenant_id, memory_id, in_dormant)',
  // Raw rows only: a vault page would range this index and sort each page, so it reads the next one.
  `idx_memories_artifact_ref ON memories(tenant_id, artifact_ref) WHERE artifact_ref IS NOT NULL AND kind = 'raw'`,
  'idx_memories_artifact_created ON memories(tenant_id, created, id) WHERE artifact_ref IS NOT NULL',
  'idx_session_owners_created_at ON session_owners(created_at)',
];

const MOVED =
  '(NEW.content IS NOT OLD.content OR NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id)';

function dropKeys(inDormant: 0 | 1): string {
  return (
    `DELETE FROM held_text_digests WHERE tenant_id = OLD.tenant_id AND memory_id = OLD.id ` +
    `AND in_dormant = ${inDormant};`
  );
}

// A 2.x binary writes content without the keys, so an edit that leaves the digest as it was clears
// it and drops the row's keys; the next sleep fill writes both again.
const TRIGGERS = [
  `memories_rejection_digest_stale AFTER UPDATE OF tenant_id, id, content ON memories ` +
    `WHEN ${MOVED} AND NEW.rejection_digest IS OLD.rejection_digest ` +
    `BEGIN UPDATE memories SET rejection_digest = NULL WHERE rowid = NEW.rowid; END`,
  `memories_held_digests_edit AFTER UPDATE OF tenant_id, id, content ON memories WHEN ${MOVED} ` +
    `BEGIN ${dropKeys(0)} END`,
  `memories_held_digests_gone AFTER DELETE ON memories BEGIN ${dropKeys(0)} END`,
  `dormant_memories_rejection_digest_stale AFTER UPDATE OF tenant_id, id, content ON dormant_memories ` +
    `WHEN ${MOVED} AND NEW.rejection_digest IS OLD.rejection_digest ` +
    `BEGIN UPDATE dormant_memories SET rejection_digest = NULL ` +
    `WHERE tenant_id = NEW.tenant_id AND id = NEW.id; END`,
  `dormant_memories_held_digests_edit AFTER UPDATE OF tenant_id, id, content ON dormant_memories ` +
    `WHEN ${MOVED} BEGIN ${dropKeys(1)} END`,
  `dormant_memories_held_digests_gone AFTER DELETE ON dormant_memories BEGIN ${dropKeys(1)} END`,
];

export const v65: Migration = {
  version: 65,
  up: (db) => {
    for (const table of ['memories', 'dormant_memories']) {
      if (!tableHasColumn(db, table, 'rejection_digest')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN rejection_digest TEXT`);
      }
    }
    db.exec(HELD_TEXT_DIGESTS);
    for (const index of INDEXES) db.exec(`CREATE INDEX IF NOT EXISTS ${index}`);
    // idx_memories_layer_created (v01) holds the same keys, and no read's plan names this one.
    db.exec('DROP INDEX IF EXISTS idx_memories_current');
    for (const trigger of TRIGGERS) db.exec(`CREATE TRIGGER IF NOT EXISTS ${trigger}`);
  },
};
