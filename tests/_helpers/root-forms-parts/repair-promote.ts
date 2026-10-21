// Root-keyed repair and promote forms tests call; production code goes through the store port or the At forms.

import { CLI_ACTOR } from '../../../src/base/scope/actor.js';
import type { MemoryEntry } from '../../../src/base/memory/memory.js';
import { promote } from '../../../src/api/memories/promote.js';
import { sqliteSyncStore } from '../../../src/store/sqlite/store.js';
import { handlesOf } from '../../../src/store/sqlite/handles.js';
import { apiCtx } from '../api-ctx.js';
import { type StoreFiles } from '../../../src/store/sqlite/open.js';
import type { RepairProtection } from '../../../src/base/memory/memory-audit.js';
import type { QualityRepairResult } from '../../../src/store/port/audit-maintenance.js';

export async function copyToGlobal(
  hippoRoot: string,
  id: string,
  opts: { tenantId?: string; owner?: string } = {},
): Promise<MemoryEntry> {
  const ctx = apiCtx(hippoRoot, opts.tenantId ?? 'default', {
    subject: CLI_ACTOR,
    role: 'admin',
    owner: opts.owner,
  });
  const { globalId } = await promote(ctx, id);
  const [copy] = (await ctx.reach?.globalTarget?.store.sharing.entriesByIds([globalId])) ?? [];
  if (!copy) throw new Error(`the promoted copy ${globalId} is not in the global store`);
  return copy;
}

export function repairAutomaticMemories(
  files: StoreFiles,
  opts: { tenantId: string; protect: RepairProtection; apply?: boolean },
): QualityRepairResult {
  return sqliteSyncStore(handlesOf(files.hippoRoot)).auditMaintenance.repairQuality(
    opts.tenantId,
    opts.apply ?? false,
    opts.protect,
  );
}

export function repairQualityOnce(
  files: StoreFiles,
  tenantId: string,
  protect: RepairProtection,
): QualityRepairResult | null {
  return sqliteSyncStore(handlesOf(files.hippoRoot)).auditMaintenance.repairQualityOnce(tenantId, protect);
}
