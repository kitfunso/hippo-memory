import { importSessionFolder } from '../../../api/agent-memories.js';
import { summaryLine } from '../../../base/memory/agent-memory-report.js';
import { isInitialized } from '../../../host/project-identity.js';
import { currentMachine } from '../../../infra/machine.js';
import { cliSyncOptions } from '../api-context.js';
import { type CommandContext, stringFlag } from '../flag-values.js';
import {
  appendSessionEndCloseLog,
  hookStoreRoot,
  reportSessionEndFailure,
  spawnDetachedWorker,
} from '../hook-runtime.js';

/** What a hook hands the worker: the session's transcript, which names its notes folder. */
export interface NoteImportJob {
  readonly from: 'note-written' | 'post-compact';
  readonly transcriptPath: string;
  readonly cwd: string | null;
  readonly logFile: string | null;
}

/** Starts the import in a detached worker and returns at once; the worker finds its store from
 * the folder it inherits. */
export function startNoteImport({ from, transcriptPath, cwd, logFile }: NoteImportJob): void {
  const args = [process.argv[1], '__note-import-worker', '--transcript', transcriptPath];
  args.push('--from', from);
  if (cwd !== null) args.push('--cwd', cwd);
  if (logFile !== null) args.push('--log-file', logFile);
  spawnDetachedWorker(from, args);
}

/** Never throws: a failed import is a log line, since nothing waits on this process. */
export async function handleNoteImportWorker({
  hippoRoot,
  tenantId,
  flags,
}: CommandContext): Promise<void> {
  const transcript = stringFlag(flags, 'transcript');
  const logFile = stringFlag(flags, 'log-file') ?? null;
  const from = stringFlag(flags, 'from') ?? 'note-written';
  const say = (line: string): void => appendSessionEndCloseLog(logFile, `${from}: ${line}`);
  const store = hookStoreRoot(hippoRoot);
  if (transcript === undefined || !isInitialized(store)) return;
  try {
    const sync = cliSyncOptions(tenantId, currentMachine());
    const report = await importSessionFolder(
      store,
      transcript,
      stringFlag(flags, 'cwd') ?? null,
      sync,
    );
    const summary = summaryLine(report);
    if (summary !== null) say(summary);
    for (const warning of report.warnings) say(`agent memories: ${warning}`);
  } catch (err) {
    reportSessionEndFailure(logFile, `${from}: agent memory import`, err);
  }
}
