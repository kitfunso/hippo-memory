// The active task snapshot rows and the continuity key that scopes them, for the Sessions group and the handoffs.
import { isSharedStore } from '../../core/config.js';
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { raiseMinBinary } from '../../db/meta.js';
import { originInSql } from '../../core/project-identity.js';
import { assertTenantId } from '../../core/tenant-id.js';
import { redactSecretsStrict } from '../../util/secret-detect.js';
import { TASK_OWNER_MIN_BINARY } from '../../util/version.js';
import { TASK_SNAPSHOT_COLUMNS, type TaskSnapshotRow, rowToTaskSnapshot } from './rows.js';
import type { TaskSnapshot, SnapshotInput } from '../port/sessions.js';
import { writeActiveTaskMirror, removeActiveTaskMirror } from './mirrors.js';
import type { StoreFiles } from './open.js';
import type { ContinuityKey } from '../port/types.js';

interface ContinuityFilter {
  readonly sql: string;
  readonly params: readonly string[];
}

interface ContinuityStamp {
  readonly owner: string;
  readonly origin: string;
}

/** All or nothing: a key missing its owner or every project name matches no row, never the tenant's newest. */
export function continuityWhere(key: ContinuityKey): ContinuityFilter {
  const names = key.project.filter((n) => n !== '');
  if (key.owner === '' || names.length === 0) return { sql: '0', params: [] };
  return { sql: `owner_subject = ? AND ${originInSql(names)}`, params: [key.owner, ...names] };
}

/** The columns a keyed write stamps; a partial key throws, since a row it wrote would match no reader. */
export function continuityStamp(key: ContinuityKey): ContinuityStamp {
  const origin = key.project.find((n) => n !== '');
  if (key.owner === '' || origin === undefined) throw new Error('continuity key needs an owner and a project');
  return { owner: key.owner, origin };
}

// An unkeyed write acts on the tenant's newest or every active row, which on a shared store belong to other owners.
export function assertKeyedOnSharedStore(fn: string, hippoRoot: string, key: ContinuityKey | null | undefined): void {
  if (!key && isSharedStore(hippoRoot)) {
    throw new Error(
      `${fn}: a shared store keeps one task snapshot per owner and project, so this write needs their continuity key`,
    );
  }
}

function insertSnapshot(
  db: DatabaseSyncLike,
  tenantId: string,
  snapshot: SnapshotInput,
  now: string,
  stamp: ContinuityStamp | null,
): number {
  const result = db
    .prepare(
      `
    INSERT INTO task_snapshots(task, summary, next_step, status, source, session_id, scope, tenant_id, created_at,
    updated_at, owner_subject, origin_project)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      redactSecretsStrict(snapshot.task),
      redactSecretsStrict(snapshot.summary),
      redactSecretsStrict(snapshot.next_step),
      snapshot.source ?? 'cli',
      snapshot.session_id ?? null,
      snapshot.scope ?? null,
      tenantId,
      now,
      now,
      stamp?.owner ?? null,
      stamp?.origin ?? null,
    );
  return Number(result.lastInsertRowid ?? 0);
}

export function saveActiveTaskSnapshotAt(
  db: DatabaseSyncLike,
  { hippoRoot }: StoreFiles,
  tenantId: string,
  snapshot: SnapshotInput,
  key?: ContinuityKey | null,
): TaskSnapshot {
  assertTenantId('saveActiveTaskSnapshot', tenantId);
  assertKeyedOnSharedStore('saveActiveTaskSnapshot', hippoRoot, key);
  const stamp = key ? continuityStamp(key) : null;
  const owned = key ? continuityWhere(key) : null;
  const now = new Date().toISOString();
  const id = withWriteScope(db, 'save_active_task', () => {
    db.prepare(
      `UPDATE task_snapshots SET status = 'superseded', updated_at = ? WHERE status = 'active' AND tenant_id = ` +
        `?${owned ? ` AND ${owned.sql}` : ''}`,
    ).run(now, tenantId, ...(owned?.params ?? []));
    const inserted = insertSnapshot(db, tenantId, snapshot, now, stamp);
    // An older binary's tenant-wide supersede would close other owners' rows, so the first owner row shuts it out.
    if (stamp) raiseMinBinary(db, TASK_OWNER_MIN_BINARY);
    return inserted;
  });

  const row = db
    .prepare(`
    SELECT ${TASK_SNAPSHOT_COLUMNS}
    FROM task_snapshots
    WHERE id = ?
  `)
    .get(id) as TaskSnapshotRow | undefined;

  if (!row) {
    throw new Error('Failed to reload saved active task snapshot');
  }

  const loaded = rowToTaskSnapshot(row);
  // The mirror is one file per store, so only the local, unkeyed path writes it.
  if (!key) writeActiveTaskMirror(hippoRoot, tenantId, loaded);
  return loaded;
}

export function loadActiveTaskSnapshotAt(
  db: DatabaseSyncLike,
  { hippoRoot }: StoreFiles,
  tenantId: string,
  key?: ContinuityKey | null,
): TaskSnapshot | null {
  assertTenantId('loadActiveTaskSnapshot', tenantId);
  const owned = key ? continuityWhere(key) : null;
  const row = db
    .prepare(`
    SELECT ${TASK_SNAPSHOT_COLUMNS}
    FROM task_snapshots
    WHERE status = 'active' AND tenant_id = ?${owned ? ` AND ${owned.sql}` : ''}
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `)
    .get(tenantId, ...(owned?.params ?? [])) as TaskSnapshotRow | undefined;

  if (!row) {
    if (!key) removeActiveTaskMirror(hippoRoot, tenantId);
    return null;
  }

  const loaded = rowToTaskSnapshot(row);
  if (!key) writeActiveTaskMirror(hippoRoot, tenantId, loaded);
  return loaded;
}
