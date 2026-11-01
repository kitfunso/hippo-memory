// Verbs that change one memory's standing: outcome, forget, invalidate.

import { truncateWithEllipsis } from '../../base/util/ellipsize.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { isGitRepo } from '../../base/ports/git.js';
import { processGit } from '../../infra/git-runner.js';
import * as api from '../../api/index.js';
import { archiveRefusal, forgetRefusal, pickWrites } from './memory-writes.js';
import { printError } from './output.js';
import {
  type CommandContext,
  boolFlag,
  flagValueless,
  hasFlag,
  nonEmptyStringFlag,
  stringFlag,
  stringFlagOrExit,
} from './flag-values.js';
import { requireInit, runChurnStaleForRepo } from './shared.js';
import { errorMessage } from '../../base/util/log.js';
import { CONTENT_PREVIEW_CHARS } from '../../base/util/token-text.js';
import { CliExit, fail } from './exit.js';
import { plural } from '../../base/util/format.js';
import type { CliCommand } from './api-context.js';

export async function handleOutcome({
  hippoRoot,
  tenantId,
  flags,
  cli,
}: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  const good = boolFlag(flags, 'good');
  const bad = boolFlag(flags, 'bad');

  if (!good && !bad) {
    fail('Specify --good or --bad');
  }

  // Through api.outcome so every CLI outcome writes one audit_log row per id, as the MCP path does.
  const ctx = cli.apiContext(hippoRoot, tenantId);
  const specificId = stringFlagOrExit(flags, 'id') || null;

  let updated: number;
  if (specificId) {
    updated = (await api.outcome(ctx, [specificId], good)).applied;
  } else {
    const r = await api.outcomeForLastRecall(ctx, good);
    if (r.ids.length === 0) {
      console.log(
        'No recent recall to apply outcome to. Use --id <id> to target a specific memory.',
      );
      return;
    }
    updated = r.applied;
  }

  console.log(
    `Applied ${good ? 'positive' : 'negative'} outcome to ${plural(updated, 'memory', 'memories')}`,
  );
}

const ARCHIVE_REASON_REQUIRED =
  'hippo forget --archive requires --reason "<why>" (recorded on the archive).';

interface PreviewForgetOptions {
  readonly cli: CliCommand;
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly id: string;
  readonly archive: boolean;
}

// Refuses exactly where the real run would, with its words, so "Would forget" is a promise, not
// a guess.
async function previewForget({
  cli,
  hippoRoot,
  tenantId,
  id,
  archive,
}: PreviewForgetOptions): Promise<void> {
  requireInit(hippoRoot);
  const ctx = cli.apiContext(hippoRoot, tenantId);
  let entry: MemoryEntry;
  try {
    entry = await api.removalTarget(ctx, id, archive);
  } catch (err) {
    fail(archive ? archiveRefusal(id, errorMessage(err)) : await forgetRefusal(ctx, id, err));
  }
  const snippet = truncateWithEllipsis(entry.content, CONTENT_PREVIEW_CHARS);
  console.log(
    `Would ${archive ? 'archive' : 'forget'} ${id} (dry run, nothing changed): "${snippet}"`,
  );
}

export async function handleForget(cmd: CommandContext): Promise<void> {
  const { hippoRoot, tenantId, args, flags, cli } = cmd;
  const id = args[0];
  if (!id) {
    fail('Please provide a memory ID.');
  }
  const archive = boolFlag(flags, 'archive');
  const reason = stringFlag(flags, 'reason') ?? '';
  if (archive && !reason) {
    fail(ARCHIVE_REASON_REQUIRED);
  }
  if (boolFlag(flags, 'dry-run')) {
    await previewForget({ cli, hippoRoot, tenantId, id, archive });
    return;
  }
  const writes = await pickWrites(cmd);
  if (archive) {
    await writes.archive(id, reason);
    console.log(`Archived ${id}`);
  } else {
    await writes.forget(id);
    console.log(`Forgot ${id}`);
  }
}

async function invalidateChurn(cmd: CommandContext): Promise<void> {
  const { args, flags } = cmd;
  if (args[0] || hasFlag(flags, 'id')) {
    printError('Usage: hippo invalidate --churn [--dry-run]');
    fail('--churn takes no pattern or --id.');
  }
  if (!isGitRepo(processGit, process.cwd())) {
    fail('hippo invalidate --churn must run inside a git repository.');
  }
  const churnDryRun = boolFlag(flags, 'dry-run');
  let churnFailed = false;
  for (const { root, result } of await runChurnStaleForRepo(cmd, churnDryRun)) {
    if (result.error) {
      printError(`Churn-staleness check failed for ${root}: ${result.error}`);
      churnFailed = true;
      continue;
    }
    if (result.preview.length === 0) {
      console.log(`No churn-stale candidates in ${root}.`);
    } else if (churnDryRun) {
      console.log(
        `DRY RUN - ${result.marked} memories in ${root} WOULD be tagged churn-stale (${result.alreadyMarked} already tagged):`,
      );
    } else {
      console.log(
        `Tagged ${result.marked} memories churn-stale in ${root} (${result.alreadyMarked} already tagged):`,
      );
    }
    result.preview.forEach((p) =>
      console.log(`   ${p.id}  ${p.evidence}  ${p.already ? '(already) ' : ''}${p.headline}`),
    );
    if (result.skippedPinned.length > 0) {
      console.log(
        `Skipped ${result.skippedPinned.length} pinned: ${result.skippedPinned.join(', ')}`,
      );
    }
  }
  if (churnFailed) throw new CliExit(1);
}

export async function handleInvalidate(cmd: CommandContext): Promise<void> {
  const { hippoRoot, tenantId, args, flags, cli } = cmd;
  requireInit(hippoRoot);
  if (boolFlag(flags, 'churn')) return invalidateChurn(cmd);
  const target = args[0];
  if (flagValueless(flags, 'id')) {
    // Value-less --id must never silently fall through to pattern mode (pattern mode writes
    // broadly; an ignored --id reverses user intent).
    fail('--id requires a memory id');
  }
  const onlyId = stringFlag(flags, 'id');
  const dryRun = boolFlag(flags, 'dry-run');
  if ((target && onlyId) || (!target && !onlyId)) {
    printError('Usage: hippo invalidate "<old pattern>" [--dry-run] [--reason "<why>"]');
    printError('       hippo invalidate --id <memory-id> [--dry-run] [--reason "<why>"]');
    fail(
      'Pass a pattern OR --id, not both. Tag matching is EXACT: the full pattern must equal a tag.',
    );
  }
  const reason = nonEmptyStringFlag(flags, 'reason') ?? null;
  const invTarget: api.InvalidationTarget = {
    from: target ?? `id:${onlyId}`,
    to: reason,
    type: 'migration',
  };
  const result = await api.memoryInvalidate(cli.apiContext(hippoRoot, tenantId), invTarget, {
    dryRun,
    onlyId,
  });
  printInvalidateResult(result, target ? `"${target}"` : `--id ${onlyId}`);
}

function printInvalidateResult(result: api.InvalidationResult, label: string): void {
  if (result.dryRun) {
    if (result.invalidated === 0) {
      console.log(`DRY RUN - no memories would match ${label}.`);
    } else {
      console.log(`DRY RUN - ${result.invalidated} memories WOULD be invalidated:`);
      result.preview.forEach((p) => console.log(`   ${p.id}  ${p.headline}`));
    }
  } else if (result.invalidated === 0) {
    console.log(`No memories matched ${label}.`);
  } else {
    console.log(`Invalidated ${result.invalidated} memories referencing ${label}.`);
    result.targets.forEach((id) => console.log(`   ${id}`));
  }
  if (result.skippedPinned.length > 0) {
    console.log(
      `Skipped ${result.skippedPinned.length} pinned: ${result.skippedPinned.join(', ')}`,
    );
  }
}
