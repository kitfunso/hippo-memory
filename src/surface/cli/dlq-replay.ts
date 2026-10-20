// The `dlq replay <id> [--force]` verb both connector CLIs share.

import type { ReplayResult } from '../connectors/dlq.js';
import { type CliFlags, flagIsTrue } from './flag-values.js';
import { fail } from './exit.js';

export async function runDlqReplay(
  connector: 'github' | 'slack',
  idArg: string | undefined,
  flags: CliFlags,
  replay: (id: number, force: boolean) => Promise<ReplayResult>,
): Promise<void> {
  if (!idArg) fail(`Usage: hippo ${connector} dlq replay <id> [--force]`);
  const id = Number(idArg);
  if (!Number.isInteger(id) || id < 1) fail(`replay: invalid id ${idArg}`);
  const result = await replay(id, flagIsTrue(flags, 'force'));
  if (!result.ok) {
    const reason = result.reason ? ` reason=${result.reason}` : '';
    fail(`replay failed: status=${result.status} retry_count=${result.retryCount}${reason}`);
  }
  console.log(
    `replay ok: status=${result.status} memory_id=${result.memoryId ?? '(none)'} retry_count=${result.retryCount}`,
  );
}
