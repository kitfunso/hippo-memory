// Verbs that move memories in and out: watch, learn, import, export, promote, sync, share and peers.

import * as path from 'path';
import * as fs from 'fs';
import { calculateStrength, deriveHalfLife, computeSchemaFit } from '../memory.js';
import { isInitialized, writeEntry, readEntry, loadAllEntries, updateStats } from '../store.js';
import { RejectedValueError } from '../rejection.js';
import { embedAll, embedMemory } from '../embeddings.js';
import { loadConfig } from '../config.js';
import { captureError, runWatched } from '../autolearn.js';
import { currentMachine, importAtSessionEnd, importForStore } from '../agent-memories/sync.js';
import { detailLines } from '../agent-memories/report.js';
import {
  getGlobalRoot,
  initGlobal,
  shareMemory,
  listPeers,
  autoShare,
  transferScore,
  syncGlobalToLocal,
} from '../shared.js';
import {
  importChatGPT,
  importClaude,
  importCursor,
  importGenericFile,
  importMarkdown,
  importVault,
  ImportOptions,
} from '../importers.js';
import * as api from '../api.js';
import * as client from '../client.js';
import { resolveTenantId } from '../tenant.js';
import { printError } from './output.js';
import { requireInit, runViaServerIfAvailable, fmt, type CommandContext, learnFromRepo } from './shared.js';

// ---------------------------------------------------------------------------
// Watch command
// ---------------------------------------------------------------------------

async function cmdWatch(command: string, hippoRoot: string): Promise<void> {
  if (!command) {
    printError('Usage: hippo watch "<command>"');
    process.exit(1);
  }

  const { exitCode, stderr } = await runWatched(command);

  if (exitCode === 0) {
    // Success: no noise
    return;
  }

  // Only create memory if hippo is initialized
  if (!isInitialized(hippoRoot)) {
    printError('Command failed but .hippo not initialized. Run `hippo init` to enable auto-learn.');
    process.exit(exitCode);
  }

  const entry = captureError(exitCode, stderr, command, resolveTenantId({}));
  // Compute schema fit against existing memories
  const existingWatch = loadAllEntries(hippoRoot, entry.tenantId);
  const watchFit = computeSchemaFit(entry.content, entry.tags, existingWatch);
  entry.schema_fit = watchFit;
  entry.half_life_days = deriveHalfLife(loadConfig(hippoRoot).defaultHalfLifeDays, entry);
  entry.strength = calculateStrength(entry);
  // AT1 (plan §3 containment): mechanical content from a failed command — a
  // rejection-guard refusal here must not crash the watcher. Skip silently
  // (loud enough via the message below) and still exit with the wrapped
  // command's real exit code.
  try {
    writeEntry(hippoRoot, entry);
    updateStats(hippoRoot, { remembered: 1 });
    void embedMemory(hippoRoot, entry);

    const preview = stderr.trim().slice(0, 80);
    printError(`\nHippo learned from failure: "${preview}"`);
  } catch (err) {
    if (err instanceof RejectedValueError) {
      printError(`\nHippo: this failure matches a rejected value (${err.reason ?? 'no reason given'}); not stored.`);
    } else {
      throw err;
    }
  }

  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Learn command
// ---------------------------------------------------------------------------

export function cmdLearn(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  if (!flags['git']) {
    printError('Usage: hippo learn --git [--days <n>] [--repos <paths>]');
    process.exit(1);
  }

  const days = parseInt(String(flags['days'] ?? '7'), 10);

  console.log(`Scanning git log for the last ${days} days...`);

  const reposFlag = flags['repos'];
  if (reposFlag && typeof reposFlag === 'string') {
    const repos = reposFlag.split(',').map((r) => r.trim()).filter(Boolean);
    let totalAdded = 0;
    let totalSkipped = 0;

    for (const repo of repos) {
      const label = path.basename(repo);
      const { added, skipped } = learnFromRepo(hippoRoot, repo, days, label);
      totalAdded += added;
      totalSkipped += skipped;
    }

    console.log(`Git learn complete: ${totalAdded} new lessons added, ${totalSkipped} duplicates skipped across ${repos.length} repos.`);
  } else {
    const { added, skipped } = learnFromRepo(hippoRoot, process.cwd(), days);
    console.log(`Git learn complete: ${added} new lessons added, ${skipped} duplicates skipped.`);
  }
}

// ---------------------------------------------------------------------------
// Import command
// ---------------------------------------------------------------------------

function warnRedacted(count: number | undefined): void {
  if (count) printError(`Warning: secret-shaped text was redacted from ${count} imported ${count === 1 ? 'entry' : 'entries'} before storing`);
}

export function cmdImport(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  const useGlobal = Boolean(flags['global']);
  const dryRun = Boolean(flags['dry-run']);
  const extraTags: string[] = Array.isArray(flags['tag'])
    ? (flags['tag'] as string[])
    : flags['tag']
      ? [String(flags['tag'])]
      : [];

  const targetRoot = useGlobal ? getGlobalRoot() : hippoRoot;

  if (flags['agents']) {
    const opts = { machine: currentMachine(), dryRun };
    // A folder without a store of its own imports as session end would there, so its notes are not hidden.
    const report = useGlobal || isInitialized(hippoRoot)
      ? importForStore(useGlobal ? getGlobalRoot() : hippoRoot, opts)
      : importAtSessionEnd(process.cwd(), undefined, opts);
    for (const line of detailLines(report, dryRun)) console.log(line);
    for (const warning of report.warnings) printError(`hippo: agent memories: ${warning}`);
    return;
  }

  if (useGlobal) {
    initGlobal();
  } else {
    requireInit(hippoRoot);
  }

  const importOptions: ImportOptions = {
    dryRun,
    global: useGlobal,
    extraTags,
    hippoRoot,
  };

  // K1 vault import: a FOLDER importer that mirrors the connector pattern
  // (kind='raw' + tag provenance + archiveRaw deletions), so it dispatches
  // separately from the single-file `importer` function-pointer slot below.
  // It writes through api.remember/archiveRaw which are tenant-scoped, so we
  // resolve the tenant and pass it through. --global is not supported for
  // vault import (the connector raw-archive path is tenant-local).
  if (flags['vault']) {
    const folderPath = String(flags['vault']);
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      printError(`Vault folder not found (or not a directory): ${folderPath}`);
      process.exit(1);
    }
    if (useGlobal) {
      printError('hippo import --vault does not support --global (raw rows are tenant-local).');
      process.exit(1);
    }
    if (typeof flags['name'] !== 'string' || !flags['name'].trim()) {
      // --name is the vault identity key for the destructive source-deletion sync;
      // inferring it from the folder basename let same-basename vaults collide and
      // clobber each other (codex R10 P2). A valueless `--name` parses as boolean
      // true, and String(true) === "true" would silently import under vault:true:*
      // - reject a non-string so it fails fast instead (codex R11 P2).
      printError('hippo import --vault requires --name <vault> (a non-empty identity key for source-deletion sync).');
      process.exit(1);
    }
    if (flags['scope'] !== undefined && (typeof flags['scope'] !== 'string' || !flags['scope'].trim())) {
      // Same valueless-flag trap: a bare `--scope` must not become scope "true".
      // Example uses the source-prefixed private form, since a bare `private` scope
      // is NOT treated as private by recall and importVault rejects it (R13 P2).
      printError('hippo import --vault: --scope requires a value (e.g. --scope vault:private:notes).');
      process.exit(1);
    }
    const tenantId = resolveTenantId({});
    const vaultOptions: ImportOptions = {
      ...importOptions,
      tenantId,
      name: flags['name'] ? String(flags['name']) : undefined,
      scope: flags['scope'] ? String(flags['scope']) : undefined,
    };
    const vaultResult = importVault(folderPath, vaultOptions);
    console.log(`\nImport Vault: ${folderPath}${dryRun ? ' (dry run - no writes)' : ''}`);
    console.log(`  Notes found:           ${vaultResult.total}`);
    console.log(`  ${dryRun ? 'Would import:         ' : 'Imported:             '}${vaultResult.imported}`);
    console.log(`  Skipped (unchanged):   ${vaultResult.skipped}`);
    if ((vaultResult.rejected ?? 0) > 0) {
      console.log(`  Rejected (tombstoned): ${vaultResult.rejected}`);
    }
    warnRedacted(vaultResult.redacted);
    console.log(`  ${dryRun ? 'Would archive:        ' : 'Archived (removed):   '}${vaultResult.archived ?? 0}`);
    console.log(`  Store:                 ${hippoRoot}`);
    // Batch producer, same contract as the single-file import below: vault rows
    // write through api.remember (which never embeds), so backfill them here.
    // Floating promise is deliberate; see the comment at the single-file site.
    if (!dryRun && vaultResult.imported >= 1) {
      void embedAll(hippoRoot).catch(() => {});
    }
    return;
  }

  // Determine which importer to use based on flag
  let filePath: string | undefined;
  let importer: ((fp: string, opts: ImportOptions) => ReturnType<typeof importChatGPT>) | undefined;
  let importerName = '';

  if (flags['chatgpt']) {
    filePath = String(flags['chatgpt']);
    importer = importChatGPT;
    importerName = 'ChatGPT';
  } else if (flags['claude']) {
    filePath = String(flags['claude']);
    importer = importClaude;
    importerName = 'Claude';
  } else if (flags['cursor']) {
    filePath = String(flags['cursor']);
    importer = importCursor;
    importerName = 'Cursor';
  } else if (flags['file']) {
    filePath = String(flags['file']);
    importer = importGenericFile;
    importerName = 'File';
  } else if (flags['markdown']) {
    filePath = String(flags['markdown']);
    importer = importMarkdown;
    importerName = 'Markdown';
  } else if (args[0]) {
    // Positional: try to auto-detect from extension
    filePath = args[0];
    importer = importGenericFile;
    importerName = 'File';
  }

  if (!filePath || !importer) {
    printError('Usage: hippo import <--chatgpt|--claude|--cursor|--file|--markdown|--vault> <path>, or hippo import --agents [--dry-run]');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    printError(`File not found: ${filePath}`);
    process.exit(1);
  }

  const result = importer(filePath, importOptions);

  // Batch producer: embed newly-imported rows on targetRoot in one pass
  // rather than per-row (importers.ts writeEntry sites don't embed). The
  // floating promise is deliberate: libuv keeps the process alive until it
  // settles, so it is not dropped on process exit; `hippo embed --global` (or
  // a local `hippo embed`) is the backstop if it does get interrupted. Do not
  // "fix" this by awaiting it, that would block the CLI on model load/backfill.
  if (!dryRun && result.imported >= 1) {
    void embedAll(targetRoot).catch(() => {});
  }

  const storeLabel = useGlobal ? `global (${getGlobalRoot()})` : targetRoot;

  console.log(`\nImport ${importerName}: ${filePath}`);
  console.log(`  Source entries found:  ${result.total}`);
  console.log(`  Imported:              ${result.imported}`);
  console.log(`  Skipped (dedup/noise): ${result.skipped}`);
  if ((result.rejected ?? 0) > 0) {
    console.log(`  Rejected (tombstoned): ${result.rejected}`);
  }
  warnRedacted(result.redacted);
  if (dryRun) {
    console.log('\n  (dry run - nothing written)');
    if (result.entries.length > 0) {
      console.log('\n  Would import:');
      for (const e of result.entries.slice(0, 10)) {
        console.log(`    - ${e.content.slice(0, 80)}`);
      }
      if (result.entries.length > 10) {
        console.log(`    ... and ${result.entries.length - 10} more`);
      }
    }
  } else {
    console.log(`  Store:                 ${storeLabel}`);
  }
}

// ---------------------------------------------------------------------------
// Promote command
// ---------------------------------------------------------------------------

function cmdPromote(hippoRoot: string, id: string): void {
  requireInit(hippoRoot);

  if (!id) {
    printError('Usage: hippo promote <id>');
    process.exit(1);
  }

  const ctx: api.Context = {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  try {
    const result = api.promote(ctx, id);
    console.log(`Promoted ${id} to global store as ${result.globalId}`);
    console.log(`   Global store: ${getGlobalRoot()}`);
  } catch (err) {
    printError(`Failed to promote: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Sync command
// ---------------------------------------------------------------------------

export function cmdSync(hippoRoot: string, flags: Record<string, string | boolean | string[]> = {}): void {
  requireInit(hippoRoot);

  const globalRoot = getGlobalRoot();
  if (!isInitialized(globalRoot)) {
    console.log('No global store found. Run `hippo init --global` first.');
    return;
  }

  // v39: other-project rows are skipped by default; secrets always are.
  const includeCrossProject = flags['cross-project'] === true;
  const count = syncGlobalToLocal(hippoRoot, globalRoot, { includeCrossProject });
  console.log(`Synced ${count} global memories into local project.${includeCrossProject ? '' : ' (other-project rows skipped; use --cross-project to include them)'}`);
}

export async function handleWatch({ hippoRoot, args }: CommandContext): Promise<void> {
  const watchCmd = args.join(' ').trim();
  await cmdWatch(watchCmd, hippoRoot);
}

export async function handlePromote({ hippoRoot, args }: CommandContext): Promise<void> {
  const id = args[0];
  if (!id) {
    printError('Please provide a memory ID.');
    process.exit(1);
  }
  const promoted = await runViaServerIfAvailable(hippoRoot, async (info, apiKey) => {
    try {
      const result = await client.promote(info.url, apiKey, id);
      console.log(`Promoted ${id} to global store as ${result.globalId}`);
    } catch (err) {
      printError(`Failed to promote: ${(err as Error).message}`);
      process.exit(1);
    }
  });
  if (promoted) return;
  cmdPromote(hippoRoot, id);
}

export function handleShare({ hippoRoot, args, flags }: CommandContext): void {
  const shareId = args[0];
  if (shareId === '--auto' || flags['auto']) {
    // Auto-share mode
    requireInit(hippoRoot);
    const minScore = parseFloat(String(flags['min-score'] ?? '0.6'));
    const dryRun = Boolean(flags['dry-run']);
    const results = autoShare(hippoRoot, { minScore, dryRun, tenantId: resolveTenantId({}) });
    if (results.length === 0) {
      console.log('No memories meet the sharing threshold.');
    } else if (dryRun) {
      console.log(`Would share ${results.length} memories:\n`);
      for (const e of results) {
        const score = transferScore(e);
        console.log(`  ${e.id} (transfer=${fmt(score)}) ${e.content.slice(0, 80)}...`);
      }
    } else {
      console.log(`Shared ${results.length} memories to global store.`);
      for (const e of results) {
        console.log(`  ${e.id} <- ${e.source}`);
      }
    }
  } else if (shareId) {
    requireInit(hippoRoot);
    const force = Boolean(flags['force']);
    const tenantId = resolveTenantId({});
    const result = shareMemory(hippoRoot, shareId, { force, tenantId });
    if (result) {
      console.log(`Shared [${result.id}] to global store.`);
      console.log(`  Source: ${result.source}`);
    } else {
      const entry = readEntry(hippoRoot, shareId, tenantId);
      if (entry) {
        const score = transferScore(entry);
        console.log(`Transfer score too low (${fmt(score)}). This memory looks project-specific.`);
        console.log('Use --force to share anyway.');
      } else {
        printError(`Memory not found: ${shareId}`);
        process.exit(1);
      }
    }
  } else {
    printError('Usage: hippo share <memory_id> [--force] or hippo share --auto [--dry-run]');
    process.exit(1);
  }
}

export function handlePeers({ flags }: CommandContext): void {
  // D4 v1.12.10: tenant-scoped by default. --all-tenants restores the
  // pre-D4 host-wide view for the rare operator who genuinely wants
  // cross-tenant peer discovery.
  const allTenants = flags['all-tenants'] === true;
  const tenantScope = allTenants ? undefined : resolveTenantId({});
  const peers = listPeers(undefined, tenantScope);
  if (peers.length === 0) {
    console.log('No peers found. Share memories with: hippo share <id>');
  } else {
    const scopeLabel = allTenants ? 'global store (all tenants)' : `global store (tenant "${tenantScope}")`;
    console.log(`${peers.length} project${peers.length === 1 ? '' : 's'} contributing to ${scopeLabel}:\n`);
    for (const p of peers) {
      console.log(`  ${p.project.padEnd(25)} ${String(p.count).padStart(4)} memories  (latest: ${p.latest.slice(0, 10)})`);
    }
  }
}

export function handleExport({ hippoRoot, args, flags }: CommandContext): void {
  requireInit(hippoRoot);
  const format = (flags['format'] as string) || 'json';
  const outputPath = args[0] || null;
  const entries = loadAllEntries(hippoRoot, resolveTenantId({}));

  let output: string;
  if (format === 'markdown' || format === 'md') {
    output = entries.map(e => {
      const meta = [
        `id: ${e.id}`,
        `created: ${e.created}`,
        `tags: ${e.tags.join(', ')}`,
        `confidence: ${e.confidence}`,
        `half_life: ${e.half_life_days}d`,
        `strength: ${e.strength.toFixed(2)}`,
      ].join(' | ');
      return `### ${e.id}\n\n${e.content}\n\n_${meta}_`;
    }).join('\n\n---\n\n');
  } else {
    output = JSON.stringify(entries, null, 2);
  }

  if (outputPath) {
    fs.writeFileSync(outputPath, output, 'utf8');
    console.log(`Exported ${entries.length} memories to ${outputPath}`);
  } else {
    console.log(output);
  }
}
