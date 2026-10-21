// Verbs that move memories in and out: watch, learn, import, export, promote, sync, share and peers.

import * as path from 'path';
import * as fs from 'fs';
import { isInitialized, resolveGlobalRootDir } from '../../base/scope/project-identity.js';
import { toWire } from '../../base/memory/memory-wire.js';
import { RejectedValueError } from '../../base/errors/api-errors.js';
import { embedCoverage, memoryEmbedMissing } from '../../api/embeddings.js';
import { captureError } from '../../api/repo-learning.js';
import { DEFAULT_LEARN_DAYS } from '../../base/util/limits.js';
import { runWatched } from './run-watched.js';
import { importAtSessionEnd, importForStore } from '../../api/agent-memories.js';
import { currentMachine } from '../../infra/machine.js';
import { detailLines } from '../../api/agent-memory-report.js';
import { importChatGPT, importClaude, importCursor, importGenericFile } from '../importers/sources.js';
import { importMarkdown } from '../importers/markdown.js';
import { importVault } from '../importers/vault.js';
import type { ImportOptions, ImportResult, TargetedImport } from '../importers/core.js';
import * as api from '../../api/index.js';
import { memoryGet, memoryList } from '../../api/memories/memories.js';
import * as client from './client.js';
import {
  cliApiContext,
  cliBatch,
  cliImportFiles,
  cliInitGlobal,
  cliRequest,
  cliStore,
  cliSyncOptions,
  type CliContext,
} from './api-context.js';
import { printError } from './output.js';
import { errorMessage, log } from '../../base/util/log.js';
import { requireInit, runViaServerIfAvailable, learnFromRepo } from './shared.js';
import { fmt } from './print.js';
import {
  type CliFlags,
  type CommandContext,
  boolFlag,
  hasFlag,
  nonEmptyStringFlag,
  numberFlag,
  stringFlag,
  stringFlagOrExit,
  stringListFlag,
} from './flag-values.js';
import { CONTENT_PREVIEW_CHARS, DATE_PREFIX_CHARS } from '../../base/util/token-text.js';
import { CliExit, fail } from './exit.js';
import { plural } from '../../base/util/format.js';

const STDERR_PREVIEW_CHARS = 80;
const MAX_ENTRIES_SHOWN = 10;

const WATCH_USAGE = 'Usage: hippo watch -- <command> [args...]';

/** The argv to run, which no shell parses. */
function watchedCommand(args: readonly string[]): string[] {
  if (args.length === 0) {
    fail(WATCH_USAGE);
  }
  // A quoted 1.x command line would now run as one program name, so it is refused rather than guessed at.
  if (args.length === 1 && /\s/.test(args[0]!)) {
    fail(`hippo watch: "${args[0]}" is one argument with spaces. Use \`hippo watch -- cmd args\`.`);
  }
  return [...args];
}

export async function handleWatch({ hippoRoot, tenantId, args }: CommandContext): Promise<void> {
  const argv = watchedCommand(args);
  const command = argv.join(' ');
  const { exitCode, stderr } = await runWatched(argv);

  if (exitCode === 0) {
    // Success: no noise
    return;
  }

  if (!isInitialized(hippoRoot)) {
    printError('Command failed but .hippo not initialized. Run `hippo init` to enable auto-learn.');
    throw new CliExit(exitCode);
  }

  const failure = captureError(exitCode, stderr, command, tenantId);
  // A rejection-guard refusal of a failed command's output must not crash the watcher: skip with the message below and
  // still exit with the wrapped command's real exit code.
  try {
    await api.rememberLocally(cliApiContext(hippoRoot, tenantId), {
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

  throw new CliExit(exitCode);
}

export async function handleLearn({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  if (!boolFlag(flags, 'git')) {
    fail('Usage: hippo learn --git [--days <n>] [--repos <paths>]');
  }

  const days = numberFlag(flags, 'days') ?? DEFAULT_LEARN_DAYS;

  console.log(`Scanning git log for the last ${days} days...`);

  const reposFlag = nonEmptyStringFlag(flags, 'repos');
  if (reposFlag) {
    const repos = reposFlag
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    let totalAdded = 0;
    let totalSkipped = 0;

    for (const repo of repos) {
      const label = path.basename(repo);
      const { added, skipped } = await learnFromRepo(hippoRoot, tenantId, repo, days, label);
      totalAdded += added;
      totalSkipped += skipped;
    }

    console.log(
      `Git learn complete: ${totalAdded} new lessons added, ` +
        `${totalSkipped} duplicates skipped across ${repos.length} repos.`,
    );
  } else {
    const { added, skipped } = await learnFromRepo(hippoRoot, tenantId, process.cwd(), days);
    console.log(`Git learn complete: ${added} new lessons added, ${skipped} duplicates skipped.`);
  }
}

/** The rows are saved either way; a failed backfill only delays vectors, so it warns with how many wait and the command
 * that finishes them. */
async function warnBackfillFailed<E>(ctx: CliContext, embedCommand: string, err: E): Promise<void> {
  let waiting: string;
  try {
    const { memories, embedded } = await embedCoverage(ctx);
    waiting = String(memories - embedded);
  } catch (countErr) {
    waiting = `an unknown number of (count failed: ${errorMessage(countErr)})`;
  }
  log.warn(
    `import: embedding backfill failed (${errorMessage(err)}); ${waiting} rows have no vector; ` +
      `run '${embedCommand}' to backfill`,
  );
}

/** Batch-embed freshly imported rows. The floating promise is deliberate: libuv keeps the process alive until it
 * settles, and awaiting would block the CLI on model load; `hippo embed` is the backstop if interrupted. */
function backfillVectors(ctx: CliContext, embedCommand: string): void {
  void memoryEmbedMissing(ctx).catch((err) => warnBackfillFailed(ctx, embedCommand, err));
}

function warnRedacted(count: number | undefined): void {
  if (count) {
    const noun = count === 1 ? 'entry' : 'entries';
    printError(`Warning: secret-shaped text was redacted from ${count} imported ${noun} before storing`);
  }
}

export async function handleImport({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const useGlobal = boolFlag(flags, 'global');
  const dryRun = boolFlag(flags, 'dry-run');
  const extraTags = stringListFlag(flags, 'tag') ?? [];

  const targetRoot = useGlobal ? resolveGlobalRootDir() : hippoRoot;

  if (boolFlag(flags, 'agents')) return await importAgentMemories(hippoRoot, tenantId, { useGlobal, dryRun });

  if (useGlobal) {
    cliInitGlobal();
  } else {
    requireInit(hippoRoot);
  }

  const importOptions: TargetedImport = {
    dryRun,
    global: useGlobal,
    extraTags,
    hippoRoot,
    tenantId,
    target: { root: targetRoot, files: cliImportFiles(targetRoot), batch: cliBatch },
  };

  // Vault import is a FOLDER importer that dispatches apart from the single-file slot below; it writes through
  // tenant-scoped api calls, so the tenant is resolved and passed through. --global is unsupported (the connector
  // raw-archive path is tenant-local).
  const vault = stringFlagOrExit(flags, 'vault');
  if (vault) {
    return await importVaultFolder({ hippoRoot, tenantId, folderPath: vault, flags, importOptions, useGlobal, dryRun });
  }
  importFromFile(targetRoot, args, flags, { importOptions, useGlobal, dryRun, tenantId });
}

type FileImporter = (fp: string, opts: TargetedImport) => ReturnType<typeof importChatGPT>;

interface PickedImporter {
  filePath: string | undefined;
  importer: FileImporter | undefined;
  importerName: string;
}

// Determine which importer to use based on flag
function pickImporter(args: string[], flags: CliFlags): PickedImporter {
  if (boolFlag(flags, 'chatgpt')) {
    return { filePath: stringFlagOrExit(flags, 'chatgpt'), importer: importChatGPT, importerName: 'ChatGPT' };
  }
  if (boolFlag(flags, 'claude')) {
    return { filePath: stringFlagOrExit(flags, 'claude'), importer: importClaude, importerName: 'Claude' };
  }
  if (boolFlag(flags, 'cursor')) {
    return { filePath: stringFlagOrExit(flags, 'cursor'), importer: importCursor, importerName: 'Cursor' };
  }
  if (boolFlag(flags, 'file')) {
    return { filePath: stringFlagOrExit(flags, 'file'), importer: importGenericFile, importerName: 'File' };
  }
  if (boolFlag(flags, 'markdown')) {
    return { filePath: stringFlagOrExit(flags, 'markdown'), importer: importMarkdown, importerName: 'Markdown' };
  }
  // Positional: try to auto-detect from extension
  if (args[0]) return { filePath: args[0], importer: importGenericFile, importerName: 'File' };
  return { filePath: undefined, importer: undefined, importerName: '' };
}

interface ImportFromFileOptions {
  readonly importOptions: TargetedImport;
  readonly useGlobal: boolean;
  readonly dryRun: boolean;
  readonly tenantId: string;
}

function importFromFile(targetRoot: string, args: string[], flags: CliFlags, options: ImportFromFileOptions): void {
  const { importOptions, useGlobal, dryRun, tenantId } = options;
  const { filePath, importer, importerName } = pickImporter(args, flags);

  if (!filePath || !importer) {
    fail(
      'Usage: hippo import <--chatgpt|--claude|--cursor|--file|--markdown|--vault> <path>, ' +
        'or hippo import --agents [--dry-run]',
    );
  }

  if (!fs.existsSync(filePath)) {
    fail(`File not found: ${filePath}`);
  }

  const result = importer(filePath, importOptions);

  // The importers' writeEntry sites don't embed, so the new rows are embedded here in one pass.
  if (!dryRun && result.imported >= 1) {
    backfillVectors(cliApiContext(targetRoot, tenantId), useGlobal ? 'hippo embed --global' : 'hippo embed');
  }

  const storeLabel = useGlobal ? `global (${resolveGlobalRootDir()})` : targetRoot;
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
      if (result.entries.length > MAX_ENTRIES_SHOWN) {
        console.log(`    ... and ${result.entries.length - MAX_ENTRIES_SHOWN} more`);
      }
    }
  } else {
    console.log(`  Store:                 ${storeLabel}`);
  }
}

async function importAgentMemories(
  hippoRoot: string,
  tenantId: string,
  { useGlobal, dryRun }: { useGlobal: boolean; dryRun: boolean },
): Promise<void> {
  const opts = cliSyncOptions(tenantId, currentMachine(), { dryRun });
  // A folder without a store of its own imports as session end would there, so its notes are not hidden.
  const report =
    useGlobal || isInitialized(hippoRoot)
      ? await importForStore(useGlobal ? resolveGlobalRootDir() : hippoRoot, opts)
      : await importAtSessionEnd(process.cwd(), undefined, opts);
  for (const line of detailLines(report, dryRun)) console.log(line);
  for (const warning of report.warnings) printError(`hippo: agent memories: ${warning}`);
}

interface VaultFolderOptions {
  hippoRoot: string;
  tenantId: string;
  folderPath: string;
  flags: CliFlags;
  importOptions: ImportOptions;
  useGlobal: boolean;
  dryRun: boolean;
}

async function importVaultFolder(options: VaultFolderOptions): Promise<void> {
  const { hippoRoot, tenantId, folderPath, flags, importOptions, useGlobal, dryRun } = options;
  checkVaultArgs(folderPath, flags, useGlobal);
  const vaultOptions: ImportOptions = {
    ...importOptions,
    name: nonEmptyStringFlag(flags, 'name'),
    scope: nonEmptyStringFlag(flags, 'scope'),
  };
  const vaultResult = await importVault(folderPath, vaultOptions, { store: cliStore(hippoRoot), batch: cliRequest });
  printVaultSummary(vaultResult, folderPath, cliApiContext(hippoRoot, tenantId), dryRun);
}

function checkVaultArgs(folderPath: string, flags: CliFlags, useGlobal: boolean): void {
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    fail(`Vault folder not found (or not a directory): ${folderPath}`);
  }
  if (useGlobal) {
    fail('hippo import --vault does not support --global (raw rows are tenant-local).');
  }
  if (!stringFlag(flags, 'name')?.trim()) {
    // --name keys the destructive source-deletion sync; a folder-basename default lets same-basename vaults clobber
    // each other, and a valueless `--name` (boolean true) would silently import under vault:true:*.
    fail('hippo import --vault requires --name <vault> (a non-empty identity key for source-deletion sync).');
  }
  if (hasFlag(flags, 'scope') && !stringFlag(flags, 'scope')?.trim()) {
    // Same valueless-flag trap: a bare `--scope` must not become scope "true". The example uses the source-prefixed
    // private form, since a bare `private` scope is not treated as private by recall and importVault rejects it.
    fail('hippo import --vault: --scope requires a value (e.g. --scope vault:private:notes).');
  }
}

function printVaultSummary(vaultResult: ImportResult, folderPath: string, ctx: CliContext, dryRun: boolean): void {
  console.log(`\nImport Vault: ${folderPath}${dryRun ? ' (dry run - no writes)' : ''}`);
  console.log(`  Notes found:           ${vaultResult.total}`);
  console.log(`  ${dryRun ? 'Would import:         ' : 'Imported:             '}${vaultResult.imported}`);
  console.log(`  Skipped (unchanged):   ${vaultResult.skipped}`);
  if ((vaultResult.rejected ?? 0) > 0) {
    console.log(`  Rejected (tombstoned): ${vaultResult.rejected}`);
  }
  warnRedacted(vaultResult.redacted);
  console.log(`  ${dryRun ? 'Would archive:        ' : 'Archived (removed):   '}${vaultResult.archived ?? 0}`);
  console.log(`  Store:                 ${ctx.hippoRoot}`);
  // Vault rows write through api.remember, which never embeds, so backfill them as the single-file import does.
  if (!dryRun && vaultResult.imported >= 1) backfillVectors(ctx, 'hippo embed');
}

async function promoteMemory(hippoRoot: string, tenantId: string, id: string): Promise<void> {
  requireInit(hippoRoot);

  if (!id) {
    fail('Usage: hippo promote <id>');
  }

  const ctx = cliApiContext(hippoRoot, tenantId);
  try {
    const result = await api.promote(ctx, id);
    console.log(`Promoted ${id} to global store as ${result.globalId}`);
    console.log(`   Global store: ${resolveGlobalRootDir()}`);
  } catch (err) {
    fail(`Failed to promote: ${errorMessage(err)}`);
  }
}

export async function handleSync({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  const globalRoot = resolveGlobalRootDir();
  if (!isInitialized(globalRoot)) {
    console.log('No global store found. Run `hippo init --global` first.');
    return;
  }

  // v39: other-project rows are skipped by default; secrets always are.
  const includeCrossProject = boolFlag(flags, 'cross-project');
  const count = await api.syncFromGlobal(cliApiContext(hippoRoot, tenantId), { includeCrossProject });
  const skipNote = includeCrossProject ? '' : ' (other-project rows skipped; use --cross-project to include them)';
  console.log(`Synced ${count} global memories into local project.${skipNote}`);
}

export async function handlePromote({ hippoRoot, tenantId, args }: CommandContext): Promise<void> {
  const id = args[0];
  if (!id) {
    fail('Please provide a memory ID.');
  }
  const promoted = await runViaServerIfAvailable(hippoRoot, async (info, apiKey) => {
    try {
      const result = await client.promote(info.url, apiKey, id);
      console.log(`Promoted ${id} to global store as ${result.globalId}`);
    } catch (err) {
      fail(`Failed to promote: ${errorMessage(err)}`);
    }
  });
  if (promoted) return;
  await promoteMemory(hippoRoot, tenantId, id);
}

export async function handleShare({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const shareId = args[0];
  if (shareId === '--auto' || boolFlag(flags, 'auto')) {
    requireInit(hippoRoot);
    const minScore = numberFlag(flags, 'min-score') ?? api.AUTO_SHARE_MIN_SCORE;
    const dryRun = boolFlag(flags, 'dry-run');
    const results = await api.autoShareToGlobal(cliApiContext(hippoRoot, tenantId), { minScore, dryRun });
    if (results.length === 0) {
      console.log('No memories meet the sharing threshold.');
    } else if (dryRun) {
      console.log(`Would share ${results.length} memories:\n`);
      for (const e of results) {
        const score = api.transferScore(e);
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
    const ctx = cliApiContext(hippoRoot, tenantId);
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

export async function handlePeers({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  // Tenant-scoped by default; --all-tenants gives the host-wide view for cross-tenant peer discovery.
  const allTenants = boolFlag(flags, 'all-tenants');
  const peers = await api.sharePeers(cliApiContext(hippoRoot, tenantId), { allTenants });
  if (peers.length === 0) {
    console.log('No peers found. Share memories with: hippo share <id>');
  } else {
    const scopeLabel = allTenants ? 'global store (all tenants)' : `global store (tenant "${tenantId}")`;
    console.log(`${plural(peers.length, 'project')} contributing to ${scopeLabel}:\n`);
    for (const p of peers) {
      console.log(
        `  ${p.project.padEnd(25)} ${String(p.count).padStart(4)} memories  ` +
          `(latest: ${p.latest.slice(0, DATE_PREFIX_CHARS)})`,
      );
    }
  }
}

export async function handleExport({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const format = stringFlagOrExit(flags, 'format') || 'json';
  const outputPath = args[0] || null;
  const entries = await memoryList(cliApiContext(hippoRoot, tenantId));

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
