// The PostCompact hook: saves the compaction summary and its memories, then prints one plain line, because Claude Code
// shows this hook's stdout as-is.
import { importSessionFolder } from '../../../domain/agent-memories/sync.js';
import { summaryLine } from '../../../domain/agent-memories/report.js';
import { COMPACTION_DB_WAIT_MS } from '../../../base/session/compaction-timing.js';
import { currentMachine } from '../../../infra/machine.js';
import { postCompactHook } from '../../capture/compact.js';
import { readHookStdin } from '../stdin.js';
import { cliHookRequest, cliStore, cliSyncOptions } from '../api-context.js';
import { type CommandContext, stringFlag } from '../flag-values.js';
import { hookStoreRoot } from '../hook-runtime.js';

/** Always exits 0. */
export async function handlePostCompact({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  const { text, timedOut } = await readHookStdin();
  const store = hookStoreRoot(hippoRoot);
  const line = await cliHookRequest(() =>
    postCompactHook(store, cliStore(store), {
      tenantId,
      stdinText: text,
      stdinTimedOut: timedOut,
      logFile: stringFlag(flags, 'log-file'),
      // Passed in, since src/surface/capture/ importing the sync would close an import cycle.
      afterSave: async (transcriptPath, cwd, log) => {
        const sync = cliSyncOptions(tenantId, currentMachine(), { busyWaitMs: COMPACTION_DB_WAIT_MS });
        const report = await importSessionFolder(store, transcriptPath, cwd, sync);
        const summary = summaryLine(report);
        if (summary !== null) log(summary);
        for (const warning of report.warnings) log(`agent memories: ${warning}`);
      },
    }),
  );
  if (line !== null && line !== undefined) console.log(line);
}
