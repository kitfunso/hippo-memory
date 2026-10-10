// Verbs that move memories in and out: watch, learn, import, export, promote, sync, share and peers.

import * as path from 'path';
import * as fs from 'fs';
import { isInitialized } from '../store/open.js';
import { loadAllEntries } from '../store/entry-reads.js';
import { RejectedValueError } from '../store/rejection.js';
import { embedAll } from '../store/embeddings/index.js';
import { loadEmbeddingIndex } from '../store/vector-index.js';
import { captureError, runWatched } from '../learn/autolearn.js';
import { currentMachine, importAtSessionEnd, importForStore } from '../agent-memories/sync.js';
import { detailLines } from '../agent-memories/report.js';
import { getGlobalRoot, initGlobal } from '../sharing/global-store.js';
import { shareMemory, listPeers, autoShare, transferScore } from '../sharing/share.js';
import { syncGlobalToLocal } from '../sharing/global-sync.js';
import {
  importChatGPT,
  importClaude,
  importCursor,
  importGenericFile,
} from '../importers/sources.js';
import { importMarkdown } from '../importers/markdown.js';
import { importVault } from '../importers/vault.js';
import { ImportOptions, type ImportResult } from '../importers/core.js';
import * as api from '../api/index.js';
import { getMemory } from '../api/memories.js';
import * as client from './client.js';
import { cliApiContext } from './api-context.js';
import { printError } from './output.js';
import { errorMessage, log } from '../util/log.js';
import { requireInit, runViaServerIfAvailable, learnFromRepo } from './shared.js';
import { fmt } from './print.js';
import { type CliFlags, type CommandContext, boolFlag, flagIsTrue, nonEmptyStringFlag } from './flag-values.js';
import { CONTENT_PREVIEW_CHARS, DATE_PREFIX_CHARS } from '../util/token-text.js';

const STDERR_PREVIEW_CHARS = 80;
const MAX_ENTRIES_SHOWN = 10;

// ---------------------------------------------------------------------------
// Watch command
// ---------------------------------------------------------------------------

async function cmdWatch(command: string, hippoRoot: string, tenantId: string): Promise<void> {
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

  const failure = captureError(exitCode, stderr, command, tenantId);
  // A rejection-guard refusal of a failed command's output must not crash the watcher:
  // skip with the message below and still exit with the wrapped command's real exit code.
  try {
    api.rememberLocally(cliApiContext(hippoRoot, tenantId), {
      content: failure.content,
      tags: failure.tags,
      layer: failure.layer,
      source: failure.source,
      confidence: failure.confidence,
      // A failure is stored each time it happens: watch has never put it to the salience gate.
      force: true,
    });

    const preview = stderr.trim().slice(0, STDERR_PREVIEW_CHARS);
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

export function handleLearn({ hippoRoot, flags }: CommandContext): void {
  requireInit(hippoRoot);

  if (!flags['git']) {
    printError('Usage: hippo learn --git [--days <n>] [--repos <paths>]');
    process.exit(1);
  }

  const days = parseInt(String(flags['days'] ?? '7'), 10);

  console.log(`Scanning git log for the last ${days} days...`);

  const reposFlag = nonEmptyStringFlag(flags, 'repos');
  if (reposFlag) {
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

/** The rows are saved either way; a failed backfill only delays vectors, so it warns with how many wait and the command that finishes them. */
function warnBackfillFailed<E>(root: string, embedCommand: string, err: E): void {
  let waiting: string;
  try {
    const vectors = loadEmbeddingIndex(root);
    waiting = String(loadAllEntries(root).filter((entry) => !Object.hasOwn(vectors, entry.id)).length);
  } catch (countErr) {
    waiting = `an unknown number of (count failed: ${errorMessage(countErr)})`;
  }
  log.warn(`import: embedding backfill failed (${errorMessage(err)}); ${waiting} rows have no vector; run '${embedCommand}' to backfill`);
}

function warnRedacted(count: number | undefined): void {
  if (count) printError(`Warning: secret-shaped text was redacted from ${count} imported ${count === 1 ? 'entry' : 'entries'} before storing`);
}

export function handleImport({ hippoRoot, tenantId, args, flags }: CommandContext): void {
  const useGlobal = boolFlag(flags, 'global');
  const dryRun = boolFlag(flags, 'dry-run');
  const extraTags: string[] = Array.isArray(flags['tag'])
    ? (flags['tag'] as string[])
    : flags['tag']
      ? [String(flags['tag'])]
      : [];

  const targetRoot = useGlobal ? getGlobalRoot() : hippoRoot;

  if (flags['agents']) return importAgentMemories(hippoRoot, useGlobal, dryRun);

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

  // Vault import: a FOLDER importer that mirrors the connector pattern
  // (kind='raw' + tag provenance + archiveRaw deletions), so it dispatches
  // separately from the single-file `importer` function-pointer slot below.
  // It writes through api.remember/archiveRaw which are tenant-scoped, so we
  // resolve the tenant and pass it through. --global is not supported for
  // vault import (the connector raw-archive path is tenant-local).
  if (flags['vault']) return importVaultFolder(hippoRoot, tenantId, flags, importOptions, useGlobal, dryRun);
  importFromFile(targetRoot, args, flags, { importOptions, useGlobal, dryRun });
}

type FileImporter = (fp: string, opts: ImportOptions) => ReturnType<typeof importChatGPT>;

interface PickedImporter {
  filePath: string | undefined;
  importer: FileImporter | undefined;
  importerName: string;
}

// Determine which importer to use based on flag
function pickImporter(args: string[], flags: CliFlags): PickedImporter {
  if (flags['chatgpt']) return { filePath: String(flags['chatgpt']), importer: importChatGPT, importerName: 'ChatGPT' };
  if (flags['claude']) return { filePath: String(flags['claude']), importer: importClaude, importerName: 'Claude' };
  if (flags['cursor']) return { filePath: String(flags['cursor']), importer: importCursor, importerName: 'Cursor' };
  if (flags['file']) return { filePath: String(flags['file']), importer: importGenericFile, importerName: 'File' };
  if (flags['markdown']) return { filePath: String(flags['markdown']), importer: importMarkdown, importerName: 'Markdown' };
  // Positional: try to auto-detect from extension
  if (args[0]) return { filePath: args[0], importer: importGenericFile, importerName: 'File' };
  return { filePath: undefined, importer: undefined, importerName: '' };
}

interface ImportFromFileOptions {
  readonly importOptions: ImportOptions;
  readonly useGlobal: boolean;
  readonly dryRun: boolean;
}

function importFromFile(targetRoot: string, args: string[], flags: CliFlags, options: ImportFromFileOptions): void {
  const { importOptions, useGlobal, dryRun } = options;
  const { filePath, importer, importerName } = pickImporter(args, flags);

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
    void embedAll(targetRoot).catch((err) => warnBackfillFailed(targetRoot, useGlobal ? 'hippo embed --global' : 'hippo embed', err));
  }

  const storeLabel = useGlobal ? `global (${getGlobalRoot()})` : targetRoot;
  printFileImportSummary(result, importerName, filePath, storeLabel, dryRun);
}

function printFileImportSummary(
  result: ImportResult,
  importerName: string,
  filePath: string,
  storeLabel: string,
  dryRun: boolean,
): void {
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
      for (const e of result.entries.slice(0, MAX_ENTRIES_SHOWN)) {
        console.log(`    - ${e.content.slice(0, CONTENT_PREVIEW_CHARS)}`);
      }
      if (result.entries.length > 10) {
        console.log(`    ... and ${result.entries.length - 10} more`);
      }
    }
  } else {
    console.log(`  Store:                 ${storeLabel}`);
  }
}

function importAgentMemories(hippoRoot: string, useGlobal: boolean, dryRun: boolean): void {
  const opts = { machine: currentMachine(), dryRun };
  // A folder without a store of its own imports as session end would there, so its notes are not hidden.
  const report = useGlobal || isInitialized(hippoRoot)
    ? importForStore(useGlobal ? getGlobalRoot() : hippoRoot, opts)
    : importAtSessionEnd(process.cwd(), undefined, opts);
  for (const line of detailLines(report, dryRun)) console.log(line);
  for (const warning of report.warnings) printError(`hippo: agent memories: ${warning}`);
}

function importVaultFolder(
  hippoRoot: string,
  tenantId: string,
  flags: CliFlags,
  importOptions: ImportOptions,
  useGlobal: boolean,
  dryRun: boolean,
): void {
  const folderPath = String(flags['vault']);
  checkVaultArgs(folderPath, flags, useGlobal);
  const vaultOptions: ImportOptions = {
    ...importOptions,
    tenantId,
    name: flags['name'] ? String(flags['name']) : undefined,
    scope: flags['scope'] ? String(flags['scope']) : undefined,
  };
  const vaultResult = importVault(folderPath, vaultOptions);
  printVaultSummary(vaultResult, folderPath, hippoRoot, dryRun);
}

function checkVaultArgs(folderPath: string, flags: CliFlags, useGlobal: boolean): void {
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    printError(`Vault folder not found (or not a directory): ${folderPath}`);
    process.exit(1);
  }
  if (useGlobal) {
    printError('hippo import --vault does not support --global (raw rows are tenant-local).');
    process.exit(1);
  }
  if (typeof flags['name'] !== 'string' || !flags['name'].trim()) {
    // --name keys the destructive source-deletion sync; a folder-basename default lets same-basename vaults clobber
    // each other, and a valueless `--name` (boolean true) would silently import under vault:true:*.
    printError('hippo import --vault requires --name <vault> (a non-empty identity key for source-deletion sync).');
    process.exit(1);
  }
  if (flags['scope'] !== undefined && (typeof flags['scope'] !== 'string' || !flags['scope'].trim())) {
    // Same valueless-flag trap: a bare `--scope` must not become scope "true".
    // Example uses the source-prefixed private form, since a bare `private` scope
    // is NOT treated as private by recall and importVault rejects it.
    printError('hippo import --vault: --scope requires a value (e.g. --scope vault:private:notes).');
    process.exit(1);
  }
}

function printVaultSummary(vaultResult: ImportResult, folderPath: string, hippoRoot: string, dryRun: boolean): void {
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
  // Batch producer, same contract as the single-file import above: vault rows
  // write through api.remember (which never embeds), so backfill them here.
  // Floating promise is deliberate; see the comment at the single-file site.
  if (!dryRun && vaultResult.imported >= 1) {
    void embedAll(hippoRoot).catch((err) => warnBackfillFailed(hippoRoot, 'hippo embed', err));
  }
}

// ---------------------------------------------------------------------------
// Promote command
// ---------------------------------------------------------------------------

function cmdPromote(hippoRoot: string, tenantId: string, id: string): void {
  requireInit(hippoRoot);

  if (!id) {
    printError('Usage: hippo promote <id>');
    process.exit(1);
  }

  const ctx = cliApiContext(hippoRoot, tenantId);
  try {
    const result = api.promote(ctx, id);
    console.log(`Promoted ${id} to global store as ${result.globalId}`);
    console.log(`   Global store: ${getGlobalRoot()}`);
  } catch (err) {
    printError(`Failed to promote: ${errorMessage(err)}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Sync command
// ---------------------------------------------------------------------------

export function handleSync({ hippoRoot, flags }: CommandContext): void {
  requireInit(hippoRoot);

  const globalRoot = getGlobalRoot();
  if (!isInitialized(globalRoot)) {
    console.log('No global store found. Run `hippo init --global` first.');
    return;
  }

  // v39: other-project rows are skipped by default; secrets always are.
  const includeCrossProject = flagIsTrue(flags, 'cross-project');
  const count = syncGlobalToLocal(hippoRoot, globalRoot, { includeCrossProject });
  console.log(`Synced ${count} global memories into local project.${includeCrossProject ? '' : ' (other-project rows skipped; use --cross-project to include them)'}`);
}

export async function handleWatch({ hippoRoot, tenantId, args }: CommandContext): Promise<void> {
  const watchCmd = args.join(' ').trim();
  await cmdWatch(watchCmd, hippoRoot, tenantId);
}

export async function handlePromote({ hippoRoot, tenantId, args }: CommandContext): Promise<void> {
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
      printError(`Failed to promote: ${errorMessage(err)}`);
      process.exit(1);
    }
  });
  if (promoted) return;
  cmdPromote(hippoRoot, tenantId, id);
}

export async function handleShare({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const shareId = args[0];
  if (shareId === '--auto' || flags['auto']) {
    // Auto-share mode
    requireInit(hippoRoot);
    const minScore = parseFloat(String(flags['min-score'] ?? '0.6'));
    const dryRun = boolFlag(flags, 'dry-run');
    const results = autoShare(hippoRoot, { minScore, dryRun, tenantId });
    if (results.length === 0) {
      console.log('No memories meet the sharing threshold.');
    } else if (dryRun) {
      console.log(`Would share ${results.length} memories:\n`);
      for (const e of results) {
        const score = transferScore(e);
        console.log(`  ${e.id} (transfer=${fmt(score)}) ${e.content.slice(0, CONTENT_PREVIEW_CHARS)}...`);
      }
    } else {
      console.log(`Shared ${results.length} memories to global store.`);
      for (const e of results) {
        console.log(`  ${e.id} <- ${e.source}`);
      }
    }
  } else if (shareId) {
    requireInit(hippoRoot);
    const force = boolFlag(flags, 'force');
    const result = shareMemory(hippoRoot, shareId, { force, tenantId });
    if (result) {
      console.log(`Shared [${result.id}] to global store.`);
      console.log(`  Source: ${result.source}`);
    } else {
      const entry = await getMemory(cliApiContext(hippoRoot, tenantId), shareId);
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

export function handlePeers({ tenantId, flags }: CommandContext): void {
  // Tenant-scoped by default; --all-tenants gives the host-wide view for cross-tenant peer discovery.
  const allTenants = flagIsTrue(flags, 'all-tenants');
  const tenantScope = allTenants ? undefined : tenantId;
  const peers = listPeers(undefined, tenantScope);
  if (peers.length === 0) {
    console.log('No peers found. Share memories with: hippo share <id>');
  } else {
    const scopeLabel = allTenants ? 'global store (all tenants)' : `global store (tenant "${tenantScope}")`;
    console.log(`${peers.length} project${peers.length === 1 ? '' : 's'} contributing to ${scopeLabel}:\n`);
    for (const p of peers) {
      console.log(`  ${p.project.padEnd(25)} ${String(p.count).padStart(4)} memories  (latest: ${p.latest.slice(0, DATE_PREFIX_CHARS)})`);
    }
  }
}

export function handleExport({ hippoRoot, tenantId, args, flags }: CommandContext): void {
  requireInit(hippoRoot);
  const format = (flags['format'] || 'json') as string;
  const outputPath = args[0] || null;
  const entries = loadAllEntries(hippoRoot, tenantId);

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
