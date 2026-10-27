// A supersede that runs api.supersede's read and write to its commit before it returns, for a race test's other writer.
import type { Context } from '../../src/api/types.js';

/** A caller's Context with the folder its store sits in, which supersedeNow reopens. */
type RootedContext = Pick<Context, 'tenantId' | 'actor'> & { readonly hippoRoot: string };
import { loadConfig } from '../../src/host/config-file.js';
import { createSuccessor } from '../../src/base/memory/entry.js';
import { scopeReaderOf } from '../../src/base/scope/recall-scope.js';
import { sqliteStore } from './test-session.js';
import { loadEntriesByIds } from './root-forms.js';

/** api.supersede's read and write on hippo.db, run to its commit before it returns; answers the successor's id. */
export async function supersedeNow(ctx: RootedContext, oldId: string, newContent: string): Promise<string> {
  const [old] = loadEntriesByIds(ctx.hippoRoot, [oldId], ctx.tenantId);
  if (!old) throw new Error(`no row ${oldId} in tenant ${ctx.tenantId} to supersede`);
  const successor = createSuccessor(
    old,
    newContent,
    {
      tenantId: ctx.tenantId,
      baseHalfLifeDays: loadConfig(ctx.hippoRoot).defaultHalfLifeDays,
    },
    new Date(),
  );
  const write = {
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    ...scopeReaderOf(ctx.actor),
    oldId,
    successor,
  };
  await sqliteStore(ctx.hippoRoot).entryWrites.supersede(write);
  return successor.id;
}
