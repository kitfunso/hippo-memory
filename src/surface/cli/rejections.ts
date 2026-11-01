// `hippo reject`, `hippo rejections` and `hippo unreject`: the rejected-value list and its changes.

import { truncateWithEllipsis } from '../../base/util/ellipsize.js';
import * as api from '../../api/index.js';
import { cliApiContext } from './api-context.js';
import { printError } from './output.js';
import { type CommandContext, boolFlag, stringFlag } from './flag-values.js';
import { resolveAuthRoot } from './shared.js';
import { errorMessage } from '../../base/util/log.js';
import { DIGEST_DISPLAY_CHARS, CONTENT_PREVIEW_CHARS } from '../../base/util/token-text.js';
import { CliExit, fail } from './exit.js';

const REJECTED_DIGEST_LIST_CHARS = 16;

export async function handleReject({
  hippoRoot,
  tenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  // Store resolution mirrors `hippo remember`: --global writes to the global store, otherwise the
  // local store (requireInit'd via resolveAuthRoot).
  const root = resolveAuthRoot(hippoRoot, flags);

  // --reason is REQUIRED: the tombstone stores no content, so reason is its only human-readable
  // identity.
  const reason = (stringFlag(flags, 'reason') ?? '').trim();
  if (!reason) {
    fail(
      'hippo reject requires --reason "<why>" (the tombstone stores no content; reason is its only identity).',
    );
  }

  const valueFlag = stringFlag(flags, 'value');
  const memoryId = args[0];

  if (!memoryId && valueFlag === undefined) {
    printError('Usage: hippo reject <memory-id> --reason "<why>"');
    fail('   or: hippo reject --value "<text>" --reason "<why>"');
  }
  if (memoryId && valueFlag !== undefined) {
    // Ambiguous ask: silently preferring one form would ignore the other without feedback.
    fail('hippo reject takes EITHER a memory id OR --value, not both.');
  }

  try {
    const result = await api.rejectOnHost(cliApiContext(root, tenantId), {
      reason,
      memoryId: valueFlag === undefined ? memoryId : undefined,
      value: valueFlag,
    });
    printRejected(result, reason);
  } catch (err) {
    fail(`Could not reject: ${errorMessage(err)}`);
  }
}

function printRejected(result: Awaited<ReturnType<typeof api.rejectOnHost>>, reason: string): void {
  const digestPrefix = result.digest.slice(0, DIGEST_DISPLAY_CHARS);
  const preview = truncateWithEllipsis(result.content, CONTENT_PREVIEW_CHARS);
  console.log(`Rejected [${digestPrefix}...]: "${preview}"`);
  console.log(`  Reason: ${reason}`);
  if (result.removedIds.length > 0) {
    console.log(
      `  Removed ${result.removedIds.length} matching row(s): ${result.removedIds.join(', ')}`,
    );
    if (result.successorIds.length > 0) {
      console.log(
        `  Merged rows that held it keep their other texts in: ${result.successorIds.join(', ')}`,
      );
    }
    if (result.dormantSuccessorIds.length > 0) {
      console.log(
        `  Dormant merged rows that held it keep their other texts in: ${result.dormantSuccessorIds.join(', ')}`,
      );
    }
  } else {
    console.log('  No live rows matched (pre-emptive tombstone).');
  }
}

export async function handleRejections({
  hippoRoot,
  tenantId,
  flags,
}: CommandContext): Promise<void> {
  const root = resolveAuthRoot(hippoRoot, flags);
  const rows = await api.listRejections(cliApiContext(root, tenantId));

  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify({ rejections: rows }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('No rejected values.');
    return;
  }

  console.log(`${rows.length} rejected value(s):\n`);
  for (const row of rows) {
    console.log(`--- ${row.digest.slice(0, DIGEST_DISPLAY_CHARS)}...`);
    console.log(`    Reason:       ${row.reason ?? 'none given'}`);
    console.log(`    Rejected by:  ${row.rejectedBy ?? 'unknown'}`);
    console.log(`    Rejected at:  ${row.rejectedAt}`);
    if (row.sourceMemoryId) console.log(`    Source id:    ${row.sourceMemoryId}`);
    if (row.normalizedChars !== null) console.log(`    Chars:        ${row.normalizedChars}`);
    console.log('');
  }
}

export async function handleUnreject({
  hippoRoot,
  tenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  const root = resolveAuthRoot(hippoRoot, flags);
  const digestOrPrefix = (args[0] ?? '').trim();
  if (!digestOrPrefix) {
    fail('Usage: hippo unreject <digest-or-prefix>');
  }

  const outcome = await api.liftRejection(cliApiContext(root, tenantId), digestOrPrefix);
  if (outcome.status === 'not_found') {
    fail(
      `No rejected value matches "${digestOrPrefix}". Run \`hippo rejections\` to list tombstones.`,
    );
  }
  if (outcome.status === 'ambiguous') {
    printError(
      `"${digestOrPrefix}" matches ${outcome.candidates.length} tombstones. Use a longer prefix:`,
    );
    for (const c of outcome.candidates) {
      printError(
        `  ${c.digest.slice(0, REJECTED_DIGEST_LIST_CHARS)}...  ${c.reason ?? 'none given'}`,
      );
    }
    throw new CliExit(1);
  }

  console.log(
    `Unrejected [${outcome.digest.slice(0, DIGEST_DISPLAY_CHARS)}...] (was: ${outcome.reason ?? 'none given'})`,
  );
}
