// A second writer for supersede race tests: the api's supersede awaits between its read and its write, so it cannot win from inside a lock request.
import type { Context } from '../../src/api/types.js';
import { loadConfig } from '../../src/core/config.js';
import { createSuccessor } from '../../src/core/memory.js';
import { personalScopeOf } from '../../src/core/recall-scope.js';
import { loadEntriesByIds } from '../../src/store/entry-reads.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';

/** api.supersede's read and write on hippo.db, run to its commit before it returns; answers the successor's id. */
export function supersedeNow(ctx: Context, oldId: string, newContent: string): string {
  const [old] = loadEntriesByIds(ctx.hippoRoot, [oldId], ctx.tenantId);
  if (!old) throw new Error(`no row ${oldId} in tenant ${ctx.tenantId} to supersede`);
  const successor = createSuccessor(old, newContent, { tenantId: ctx.tenantId, baseHalfLifeDays: loadConfig(ctx.hippoRoot).defaultHalfLifeDays });
  const write = { tenantId: ctx.tenantId, actor: ctx.actor.subject, ownScope: personalScopeOf(ctx.actor), oldId, successor };
  sqliteSyncStore(ctx.hippoRoot).entryWrites.supersede(write);
  return successor.id;
}
