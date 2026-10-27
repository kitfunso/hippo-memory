// The active task snapshot rows and the continuity key that scopes them, for the Sessions group and
// the handoffs.
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { raiseMinBinary } from '../../db/meta.js';
import { originInSql } from './rule-sql.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import { redactSecretsStrict } from '../../base/util/secret-detect.js';
import { TASK_OWNER_MIN_BINARY } from '../../base/util/version.js';
import { TASK_SNAPSHOT_COLUMNS, type TaskSnapshotRow, rowToTaskSnapshot } from './rows.js';
import type { TaskSnapshot, SnapshotInput } from '../../base/ports/store/sessions.js';
import { writeActiveTaskMirror, removeActiveTaskMirror } from './session-mirrors.js';
import type { StoreFiles } from './open.js';
import {
  continuityStamp,
  type ContinuityKey,
  type ContinuityStamp,
} from '../../base/ports/store/types.js';
import { cachedStatement } from '../../db/statement-cache.js';
import type { SqlFragment } from '../../db/sql.js';
import { handleStamp } from './handle-clock.js';

// The continuity key's match: all or nothing, so a key missing its owner or every project name
// matches no row, never the tenant's newest.

/** The project names a row's origin must be one of, or null when the key matches no row. */
function keyProjects(key: ContinuityKey): readonly string[] | null {
  const names = key.project.filter((n) => n !== '');
  return key.owner === '' || names.length === 0 ? null : names;
}

export function continuityWhere(key: ContinuityKey): SqlFragment {
  const names = keyProjects(key);
  if (names === null) return { sql: '0', params: [] };
  return { sql: `owner_subject = ? AND ${originInSql(names)}`, params: [key.owner, ...names] };
}

// An unkeyed write acts on the tenant's newest or every active row, which on a shared store belong
// to other owners.
export function assertKeyedOnSharedStore(
  fn: string,
  { host, hippoRoot }: StoreFiles,
  key: ContinuityKey | null | undefined,
): void {
  if (!key && host.isSharedStore(hippoRoot)) {
    throw new Error(
      `${fn}: a shared store keeps one task snapshot per owner and project, so this write needs their continuity key`,
    );
  }
}

interface InsertSnapshotOptions {
  readonly tenantId: string;
  readonly snapshot: SnapshotInput;
  readonly now: string;
  readonly stamp: ContinuityStamp | null;
}

function insertSnapshot(
  db: DatabaseSyncLike,
  { tenantId, snapshot, now, stamp }: InsertSnapshotOptions,
): number {
  const result = cachedStatement(
    db,
    `
    INSERT INTO task_snapshots(task, summary, next_step, status, source, session_id, scope, tenant_id, created_at,
    updated_at, owner_subject, origin_project)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    redactSecretsStrict(snapshot.task),
    redactSecretsStrict(snapshot.summary),
    redactSecretsStrict(snapshot.nextStep),
    snapshot.source ?? 'cli',
    snapshot.sessionId ?? null,
    snapshot.scope ?? null,
    tenantId,
    now,
    now,
    stamp?.owner ?? null,
    stamp?.origin ?? null,
  );
  return Number(result.lastInsertRowid ?? 0);
}

export interface SaveActiveTaskSnapshotOptions {
  readonly files: StoreFiles;
  readonly tenantId: string;
  readonly snapshot: SnapshotInput;
  readonly key?: ContinuityKey | null;
}

export function saveActiveTaskSnapshot(
  db: DatabaseSyncLike,
  { files, tenantId, snapshot, key }: SaveActiveTaskSnapshotOptions,
): TaskSnapshot {
  const { hippoRoot } = files;
  assertTenantId('saveActiveTaskSnapshot', tenantId);
  assertKeyedOnSharedStore('saveActiveTaskSnapshot', files, key);
  const stamp = key ? continuityStamp(key) : null;
  const owned = key ? continuityWhere(key) : null;
  const now = handleStamp(db);
  const id = withWriteScope(db, 'save_active_task', () => {
    cachedStatement(
      db,
      `UPDATE task_snapshots SET status = 'superseded', updated_at = ? WHERE status = 'active' AND tenant_id = ` +
        `?${owned ? ` AND ${owned.sql}` : ''}`,
    ).run(now, tenantId, ...(owned?.params ?? []));
    const inserted = insertSnapshot(db, { tenantId, snapshot, now, stamp });
    // An older binary's tenant-wide supersede would close other owners' rows, so the first owner
    // row shuts it out.
    if (stamp) raiseMinBinary(db, TASK_OWNER_MIN_BINARY);
    return inserted;
  });

  const row = cachedStatement(
    db,
    `
    SELECT ${TASK_SNAPSHOT_COLUMNS}
    FROM task_snapshots
    WHERE id = ?
  `,
  ).get(id) as TaskSnapshotRow | undefined;

  if (!row) {
    throw new Error('Failed to reload saved active task snapshot');
  }

  const loaded = rowToTaskSnapshot(row);
  // The mirror is one file per store, so only the local, unkeyed path writes it.
  if (!key) writeActiveTaskMirror(hippoRoot, tenantId, loaded);
  return loaded;
}

export function readActiveTaskSnapshot(
  db: DatabaseSyncLike,
  { hippoRoot }: StoreFiles,
  tenantId: string,
  key?: ContinuityKey | null,
): TaskSnapshot | null {
  assertTenantId('readActiveTaskSnapshot', tenantId);
  const owned = key ? continuityWhere(key) : null;
  const row = cachedStatement(
    db,
    `
    SELECT ${TASK_SNAPSHOT_COLUMNS}
    FROM task_snapshots
    WHERE status = 'active' AND tenant_id = ?${owned ? ` AND ${owned.sql}` : ''}
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `,
  ).get(tenantId, ...(owned?.params ?? [])) as TaskSnapshotRow | undefined;

  if (!row) {
    if (!key) removeActiveTaskMirror(hippoRoot, tenantId);
    return null;
  }

  const loaded = rowToTaskSnapshot(row);
  if (!key) writeActiveTaskMirror(hippoRoot, tenantId, loaded);
  return loaded;
}
