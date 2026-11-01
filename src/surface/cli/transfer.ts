// Verbs that move memories between stores and people: sync, promote, share, peers and export.

import * as fs from 'node:fs';
import { isInitialized } from '../../host/project-identity.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import { toWire } from '../../base/memory/memory-wire.js';
import * as api from '../../api/index.js';
import { memoryGet, memoryList } from '../../api/memories/memories.js';
import { pickWrites } from './memory-writes.js';
import { requireInit } from './shared.js';
import { fmt } from './print.js';
import { type CommandContext, boolFlag, numberFlag, stringFlagOrExit } from './flag-values.js';
import { CONTENT_PREVIEW_CHARS, DATE_PREFIX_CHARS } from '../../base/util/token-text.js';
import { fail } from './exit.js';
import { plural } from '../../base/util/format.js';

export async function handleSync({
  hippoRoot,
  tenantId,
  flags,
  cli,
}: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  const globalRoot = hippoHomeDir();
  if (!isInitialized(globalRoot)) {
    console.log('No global store found. Run `hippo init --global` first.');
    return;
  }

  // v39: other-project rows are skipped by default; secrets always are.
  const includeCrossProject = boolFlag(flags, 'cross-project');
  const count = await api.syncFromGlobal(cli.apiContext(hippoRoot, tenantId), {
    includeCrossProject,
  });
  const skipNote = includeCrossProject
    ? ''
    : ' (other-project rows skipped; use --cross-project to include them)';
  console.log(`Synced ${count} global memories into local project.${skipNote}`);
}

export async function handlePromote(cmd: CommandContext): Promise<void> {
  const { args } = cmd;
  const id = args[0];
  if (!id) {
    fail('Please provide a memory ID.');
  }
  const { globalId, globalStore } = await (await pickWrites(cmd)).promote(id);
  console.log(`Promoted ${id} to global store as ${globalId}`);
  if (globalStore !== undefined) console.log(`   Global store: ${globalStore}`);
}

export async function handleShare(cmd: CommandContext): Promise<void> {
  const { hippoRoot, tenantId, args, flags, cli } = cmd;
  const shareId = args[0];
  if (shareId === '--auto' || boolFlag(flags, 'auto')) {
    await shareAuto(cmd);
  } else if (shareId) {
    requireInit(hippoRoot);
    const force = boolFlag(flags, 'force');
    const ctx = cli.apiContext(hippoRoot, tenantId);
    const result = await api.shareToGlobal(ctx, shareId, { force });
    if (result) {
      console.log(`Shared [${result.id}] to global store.`);
      console.log(`  Source: ${result.source}`);
    } else {
      const entry = await memoryGet(ctx, shareId);
      if (entry) {
        const score = api.transferScore(entry);
        console.log(`Transfer score too low (${fmt(score)}). This memory looks project-specific.`);
        console.log('Use --force to share anyway.');
      } else {
        fail(`Memory not found: ${shareId}`);
      }
    }
  } else {
    fail('Usage: hippo share <memory_id> [--force] or hippo share --auto [--dry-run]');
  }
}

/** `hippo share --auto`: shares every memory at or above the transfer threshold. */
async function shareAuto({ cli, hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const minScore = numberFlag(flags, 'min-score') ?? api.AUTO_SHARE_MIN_SCORE;
  const dryRun = boolFlag(flags, 'dry-run');
  const results = await api.autoShareToGlobal(cli.apiContext(hippoRoot, tenantId), {
    minScore,
    dryRun,
  });
  if (results.length === 0) {
    console.log('No memories meet the sharing threshold.');
  } else if (dryRun) {
    console.log(`Would share ${results.length} memories:\n`);
    for (const e of results) {
      const score = api.transferScore(e);
      console.log(
        `  ${e.id} (transfer=${fmt(score)}) ${e.content.slice(0, CONTENT_PREVIEW_CHARS)}...`,
      );
    }
  } else {
    console.log(`Shared ${results.length} memories to global store.`);
    for (const e of results) {
      console.log(`  ${e.id} <- ${e.source}`);
    }
  }
}

export async function handlePeers({
  hippoRoot,
  tenantId,
  flags,
  cli,
}: CommandContext): Promise<void> {
  // Tenant-scoped by default; --all-tenants gives the host-wide view for cross-tenant
  // peer discovery.
  const allTenants = boolFlag(flags, 'all-tenants');
  const peers = await api.sharePeers(cli.apiContext(hippoRoot, tenantId), { allTenants });
  if (peers.length === 0) {
    console.log('No peers found. Share memories with: hippo share <id>');
  } else {
    const scopeLabel = allTenants
      ? 'global store (all tenants)'
      : `global store (tenant "${tenantId}")`;
    console.log(`${plural(peers.length, 'project')} contributing to ${scopeLabel}:\n`);
    for (const p of peers) {
      console.log(
        `  ${p.project.padEnd(25)} ${String(p.count).padStart(4)} memories  ` +
          `(latest: ${p.latest.slice(0, DATE_PREFIX_CHARS)})`,
      );
    }
  }
}

export async function handleExport({
  hippoRoot,
  tenantId,
  args,
  flags,
  cli,
}: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const format = stringFlagOrExit(flags, 'format') || 'json';
  const outputPath = args[0] || null;
  const entries = await memoryList(cli.apiContext(hippoRoot, tenantId));

  let output: string;
  if (format === 'markdown' || format === 'md') {
    output = entries
      .map((e) => {
        const meta = [
          `id: ${e.id}`,
          `created: ${e.created}`,
          `tags: ${e.tags.join(', ')}`,
          `confidence: ${e.confidence}`,
          `half_life: ${e.halfLifeDays}d`,
          `strength: ${e.strength.toFixed(2)}`,
        ].join(' | ');
        return `### ${e.id}\n\n${e.content}\n\n_${meta}_`;
      })
      .join('\n\n---\n\n');
  } else {
    output = JSON.stringify(entries.map(toWire), null, 2);
  }

  if (outputPath) {
    fs.writeFileSync(outputPath, output, 'utf8');
    console.log(`Exported ${entries.length} memories to ${outputPath}`);
  } else {
    console.log(output);
  }
}
