// `hippo import`: bring memories in from a file, an agent's memory folder or a vault.

import * as fs from 'node:fs';
import { isInitialized } from '../../host/project-identity.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import { embedCoverage, memoryEmbedMissing } from '../../api/embeddings.js';
import { importAtSessionEnd, importForStore } from '../../api/agent-memories.js';
import { currentMachine } from '../../infra/machine.js';
import { detailLines } from '../../base/memory/agent-memory-report.js';
import {
  importChatGPTInto,
  importClaudeInto,
  importCursorInto,
  importGenericFileInto,
} from '../importers/sources.js';
import { importMarkdownInto } from '../importers/markdown.js';
import { importVaultInto } from '../importers/vault.js';
import type { ImportOptions, ImportResult, TargetedImport } from '../importers/core.js';
import {
  cliInitGlobal,
  cliInfra,
  type CliContext,
  type CliCommand,
  type CliScope,
} from './api-context.js';
import { printError } from './output.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { requireInit } from './shared.js';
import {
  type CliFlags,
  type CommandContext,
  boolFlag,
  hasFlag,
  nonEmptyStringFlag,
  stringFlag,
  stringFlagOrExit,
  stringListFlag,
} from './flag-values.js';
import { CONTENT_PREVIEW_CHARS } from '../../base/util/token-text.js';
import { fail } from './exit.js';

const MAX_ENTRIES_SHOWN = 10;

/** The rows are saved either way; a failed backfill only delays vectors, so it warns with how
 * many wait and the command that finishes them. */
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
    errorFields(err),
  );
}

/** Batch-embeds freshly imported rows before the command returns, since the command's store
 * runtime closes then. */
async function backfillVectors(ctx: CliContext, embedCommand: string): Promise<void> {
  try {
    await memoryEmbedMissing(ctx);
  } catch (err) {
    await warnBackfillFailed(ctx, embedCommand, err);
  }
}

function warnRedacted(count: number | undefined): void {
  if (count) {
    const noun = count === 1 ? 'entry' : 'entries';
    printError(
      `Warning: secret-shaped text was redacted from ${count} imported ${noun} before storing`,
    );
  }
}

export async function handleImport(cmd: CommandContext): Promise<void> {
  const { hippoRoot, tenantId, args, flags, cli } = cmd;
  const useGlobal = boolFlag(flags, 'global');
  const dryRun = boolFlag(flags, 'dry-run');
  const extraTags = stringListFlag(flags, 'tag') ?? [];

  const targetRoot = useGlobal ? hippoHomeDir() : hippoRoot;

  if (boolFlag(flags, 'agents')) {
    return await importAgentMemories(cmd, { useGlobal, dryRun });
  }

  if (useGlobal) {
    cliInitGlobal();
  } else {
    requireInit(hippoRoot);
  }
  await importIntoStore({
    cli,
    hippoRoot,
    tenantId,
    targetRoot,
    args,
    flags,
    useGlobal,
    dryRun,
    extraTags,
  });
}

interface ImportRun {
  readonly cli: CliCommand;
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly targetRoot: string;
  readonly args: string[];
  readonly flags: CliFlags;
  readonly useGlobal: boolean;
  readonly dryRun: boolean;
  readonly extraTags: string[];
}

/** A vault folder or one file, written to the store `--global` picked. */
async function importIntoStore(run: ImportRun): Promise<void> {
  const { cli, hippoRoot, tenantId, targetRoot, args, flags, useGlobal, dryRun, extraTags } = run;
  const importOptions: TargetedImport = {
    dryRun,
    global: useGlobal,
    extraTags,
    hippoRoot,
    tenantId,
    target: { root: targetRoot, batch: cli.importBatch(targetRoot), clock: cliInfra().clock },
  };

  // Vault import is a FOLDER importer that dispatches apart from the single-file slot below; it
  // writes through tenant-scoped api calls, so the tenant is resolved and passed through. --global
  // is unsupported (the connector raw-archive path is tenant-local).
  const vault = stringFlagOrExit(flags, 'vault');
  if (vault) {
    return await importVaultFolder({
      cli,
      hippoRoot,
      tenantId,
      folderPath: vault,
      flags,
      importOptions,
      useGlobal,
      dryRun,
    });
  }
  await importFromFile(targetRoot, args, flags, {
    cli,
    importOptions,
    useGlobal,
    dryRun,
    tenantId,
  });
}

type FileImporter = (fp: string, opts: TargetedImport) => ReturnType<typeof importChatGPTInto>;

interface PickedImporter {
  filePath: string | undefined;
  importer: FileImporter | undefined;
  importerName: string;
}

// Determine which importer to use based on flag
function pickImporter(args: string[], flags: CliFlags): PickedImporter {
  if (boolFlag(flags, 'chatgpt')) {
    return {
      filePath: stringFlagOrExit(flags, 'chatgpt'),
      importer: importChatGPTInto,
      importerName: 'ChatGPT',
    };
  }
  if (boolFlag(flags, 'claude')) {
    return {
      filePath: stringFlagOrExit(flags, 'claude'),
      importer: importClaudeInto,
      importerName: 'Claude',
    };
  }
  if (boolFlag(flags, 'cursor')) {
    return {
      filePath: stringFlagOrExit(flags, 'cursor'),
      importer: importCursorInto,
      importerName: 'Cursor',
    };
  }
  if (boolFlag(flags, 'file')) {
    return {
      filePath: stringFlagOrExit(flags, 'file'),
      importer: importGenericFileInto,
      importerName: 'File',
    };
  }
  if (boolFlag(flags, 'markdown')) {
    return {
      filePath: stringFlagOrExit(flags, 'markdown'),
      importer: importMarkdownInto,
      importerName: 'Markdown',
    };
  }
  // Positional: try to auto-detect from extension
  if (args[0]) return { filePath: args[0], importer: importGenericFileInto, importerName: 'File' };
  return { filePath: undefined, importer: undefined, importerName: '' };
}

interface ImportFromFileOptions {
  readonly cli: CliCommand;
  readonly importOptions: TargetedImport;
  readonly useGlobal: boolean;
  readonly dryRun: boolean;
  readonly tenantId: string;
}

async function importFromFile(
  targetRoot: string,
  args: string[],
  flags: CliFlags,
  options: ImportFromFileOptions,
): Promise<void> {
  const { cli, importOptions, useGlobal, dryRun, tenantId } = options;
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
  const storeLabel = useGlobal ? `global (${hippoHomeDir()})` : targetRoot;
  printFileImportSummary(result, { importerName, filePath, storeLabel, dryRun });

  // The importers' writeEntry sites don't embed, so the new rows are embedded here in one pass.
  if (!dryRun && result.imported >= 1) {
    await backfillVectors(
      cli.apiContext(targetRoot, tenantId),
      useGlobal ? 'hippo embed --global' : 'hippo embed',
    );
  }
}

interface FileImportSummary {
  readonly importerName: string;
  readonly filePath: string;
  readonly storeLabel: string;
  readonly dryRun: boolean;
}

function printFileImportSummary(
  result: ImportResult,
  { importerName, filePath, storeLabel, dryRun }: FileImportSummary,
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
  { cli, hippoRoot, tenantId }: CliScope,
  { useGlobal, dryRun }: { useGlobal: boolean; dryRun: boolean },
): Promise<void> {
  const opts = cli.syncOptions(tenantId, currentMachine(), { dryRun });
  // A folder without a store of its own imports as session end would there, so its notes are not
  // hidden.
  const report =
    useGlobal || isInitialized(hippoRoot)
      ? await importForStore(useGlobal ? hippoHomeDir() : hippoRoot, opts)
      : await importAtSessionEnd(process.cwd(), undefined, opts);
  for (const line of detailLines(report, dryRun)) console.log(line);
  for (const warning of report.warnings) printError(`hippo: agent memories: ${warning}`);
}

interface VaultFolderOptions {
  cli: CliCommand;
  hippoRoot: string;
  tenantId: string;
  folderPath: string;
  flags: CliFlags;
  importOptions: ImportOptions;
  useGlobal: boolean;
  dryRun: boolean;
}

async function importVaultFolder(options: VaultFolderOptions): Promise<void> {
  const { cli, hippoRoot, tenantId, folderPath, flags, importOptions, useGlobal, dryRun } = options;
  checkVaultArgs(folderPath, flags, useGlobal);
  const vaultOptions: ImportOptions = {
    ...importOptions,
    name: nonEmptyStringFlag(flags, 'name'),
    scope: nonEmptyStringFlag(flags, 'scope'),
  };
  const vaultResult = await importVaultInto(folderPath, vaultOptions, {
    store: cli.store(hippoRoot),
    batch: cli.storeBatch(hippoRoot),
    infra: cliInfra(),
  });
  const ctx = cli.apiContext(hippoRoot, tenantId);
  printVaultSummary(vaultResult, folderPath, ctx, dryRun);
  // Vault rows write through api.remember, which never embeds, so backfill them as the single-file
  // import does.
  if (!dryRun && vaultResult.imported >= 1) await backfillVectors(ctx, 'hippo embed');
}

function checkVaultArgs(folderPath: string, flags: CliFlags, useGlobal: boolean): void {
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    fail(`Vault folder not found (or not a directory): ${folderPath}`);
  }
  if (useGlobal) {
    fail('hippo import --vault does not support --global (raw rows are tenant-local).');
  }
  if (!stringFlag(flags, 'name')?.trim()) {
    // --name keys the destructive source-deletion sync; a folder-basename default lets
    // same-basename vaults clobber each other, and a valueless `--name` (boolean true) would
    // silently import under vault:true:*.
    fail(
      'hippo import --vault requires --name <vault> (a non-empty identity key for source-deletion sync).',
    );
  }
  if (hasFlag(flags, 'scope') && !stringFlag(flags, 'scope')?.trim()) {
    // Same valueless-flag trap: a bare `--scope` must not become scope "true". The example uses the
    // source-prefixed private form, since a bare `private` scope is not treated as private by
    // recall and importVault rejects it.
    fail('hippo import --vault: --scope requires a value (e.g. --scope vault:private:notes).');
  }
}

function printVaultSummary(
  vaultResult: ImportResult,
  folderPath: string,
  ctx: CliContext,
  dryRun: boolean,
): void {
  console.log(`\nImport Vault: ${folderPath}${dryRun ? ' (dry run - no writes)' : ''}`);
  console.log(`  Notes found:           ${vaultResult.total}`);
  console.log(
    `  ${dryRun ? 'Would import:         ' : 'Imported:             '}${vaultResult.imported}`,
  );
  console.log(`  Skipped (unchanged):   ${vaultResult.skipped}`);
  if ((vaultResult.rejected ?? 0) > 0) {
    console.log(`  Rejected (tombstoned): ${vaultResult.rejected}`);
  }
  warnRedacted(vaultResult.redacted);
  console.log(
    `  ${dryRun ? 'Would archive:        ' : 'Archived (removed):   '}${vaultResult.archived ?? 0}`,
  );
  console.log(`  Store:                 ${ctx.hippoRoot}`);
}
