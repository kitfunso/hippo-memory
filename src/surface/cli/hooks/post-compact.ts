// The PostCompact hook: saves the compaction summary and its memories, then prints one plain line,
// because Claude Code shows this hook's stdout as-is.
import { processHomes } from '../../../host/agent-homes.js';
import { postCompactHook } from '../../capture/compact.js';
import { defaultPreCompactLogPath } from '../../hooks-install/rules/shared.js';
import { readHookStdin } from '../stdin.js';
import { cliHookRequest, cliStore } from '../api-context.js';
import { type CommandContext, stringFlag } from '../flag-values.js';
import { hookStoreRoot } from '../hook-runtime.js';
import { startNoteImport } from './note-import-worker.js';

/** Always exits 0. */
export async function handlePostCompact({
  hippoRoot,
  tenantId,
  flags,
}: CommandContext): Promise<void> {
  const { text, timedOut } = await readHookStdin();
  const store = hookStoreRoot(hippoRoot);
  const logFile = stringFlag(flags, 'log-file') ?? defaultPreCompactLogPath(processHomes());
  const line = await cliHookRequest(() =>
    postCompactHook(store, cliStore(store), {
      tenantId,
      stdinText: text,
      stdinTimedOut: timedOut,
      logFile,
      // A first import is thousands of rows, more than the hook's time limit, so a detached worker runs
      // it; passed in, since src/surface/capture/ importing the worker would close an import cycle.
      afterSave: (transcriptPath, cwd) =>
        startNoteImport({ from: 'post-compact', transcriptPath, cwd, logFile }),
    }),
  );
  if (line !== null && line !== undefined) console.log(line);
}
