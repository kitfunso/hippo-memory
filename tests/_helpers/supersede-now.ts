// Supersede race helpers: a winner that commits in another process, and one that runs to its commit before it returns.
import type { Context } from '../../src/api/types.js';
import { loadConfig } from '../../src/core/config.js';
import { createSuccessor } from '../../src/core/memory.js';
import { personalScopeOf } from '../../src/core/recall-scope.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlText, stageScratchWinner, type StagedWinner } from './race-winner.js';
import { loadEntriesByIds, writeEntry } from './root-forms.js';
import { initTestStore } from './store-template.js';

/** A supersede another process wins: it copies a successor from a scratch store and links `oldId` to it under the write lock. */
export async function stageSupersedeWinner(
  ctx: Context,
  oldId: string,
  newContent: string,
): Promise<StagedWinner & { successorId: string }> {
  const [old] = loadEntriesByIds(ctx.hippoRoot, [oldId], ctx.tenantId);
  if (!old) throw new Error(`no row ${oldId} in tenant ${ctx.tenantId} to supersede`);
  const successor = createSuccessor(old, newContent, {
    tenantId: ctx.tenantId,
    baseHalfLifeDays: loadConfig(ctx.hippoRoot).defaultHalfLifeDays,
  });
  const scratch = mkdtempSync(join(tmpdir(), 'hippo-race-winner-'));
  initTestStore(scratch);
  writeEntry(scratch, successor);
  const audit = JSON.stringify({ newId: successor.id });
  const winner = await stageScratchWinner(
    ctx.hippoRoot,
    scratch,
    ['memories'],
    [
      `UPDATE memories SET superseded_by = ${sqlText(successor.id)} WHERE id = ${sqlText(oldId)} AND tenant_id = ${sqlText(ctx.tenantId)}`,
      `INSERT INTO audit_log (ts, tenant_id, actor, op, target_id, metadata_json) VALUES (${sqlText(new Date().toISOString())}, ` +
        `${sqlText(ctx.tenantId)}, ${sqlText(ctx.actor.subject)}, 'supersede', ${sqlText(oldId)}, ${sqlText(audit)})`,
    ],
  );
  const committed = winner.committed.finally(() => rmSync(scratch, { recursive: true, force: true }));
  return { committed, successorId: successor.id };
}

/** api.supersede's read and write on hippo.db, run to its commit before it returns; answers the successor's id. */
export function supersedeNow(ctx: Context, oldId: string, newContent: string): string {
  const [old] = loadEntriesByIds(ctx.hippoRoot, [oldId], ctx.tenantId);
  if (!old) throw new Error(`no row ${oldId} in tenant ${ctx.tenantId} to supersede`);
  const successor = createSuccessor(old, newContent, {
    tenantId: ctx.tenantId,
    baseHalfLifeDays: loadConfig(ctx.hippoRoot).defaultHalfLifeDays,
  });
  const write = {
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    ownScope: personalScopeOf(ctx.actor),
    oldId,
    successor,
  };
  sqliteSyncStore(ctx.hippoRoot).entryWrites.supersede(write);
  return successor.id;
}
