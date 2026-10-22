// The detached session-end worker (`__session-end-worker`): sleep, capture, digest and the handoff, each step logged.
import { readSessionScan, recordSessionDigest, type SessionScan } from '../../capture/session-digest.js';
import type { ProjectRef } from '../../../base/scope/project-identity.js';
import { runCapture } from '../../capture/command.js';
import { transcriptWorkingState } from '../../capture/working-state.js';
import { collectHandoffEvidence } from '../../capture/handoff-evidence.js';
import type { SessionTurn } from '../../capture/transcript.js';
import {
  loadTurnPosition,
  runSessionWorker,
  saveTurnPosition,
  turnsAfter,
  type WorkerMode,
} from '../../capture/session-worker.js';
import { infraOf } from '../../../api/infra.js';
import { sessionEndWork as runSessionEnd } from '../../../api/session-end.js';
import { cliApiContext } from '../api-context.js';
import { type CliFlags, type CommandContext, boolFlag, stringFlag } from '../flag-values.js';
import {
  appendSessionEndCloseLog,
  captureTarget,
  logSessionEndImport,
  reportSessionEndFailure,
} from '../hook-runtime.js';

export async function handleSessionEndWorker({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  await runSessionWorker(stringFlag(flags, 'session-id') ?? null, boolFlag(flags, 'turn') ? 'turn' : 'full', (mode) =>
    sessionEndWork(hippoRoot, tenantId, flags, mode),
  );
}

function sessionEndWork(hippoRoot: string, tenantId: string, flags: CliFlags, mode: WorkerMode): Promise<void> {
  const transcriptPath = stringFlag(flags, 'transcript');
  const logFile = stringFlag(flags, 'log-file') ?? null;
  const sessionId = stringFlag(flags, 'session-id') ?? null;
  const logLine = (line: string): void => appendSessionEndCloseLog(logFile, line);
  const ctx = cliApiContext(hippoRoot, tenantId);
  return runSessionEnd<SessionTurn, SessionScan>(ctx, {
    mode,
    sessionId,
    transcriptPath,
    log: (line, opts) => appendSessionEndCloseLog(logFile, line, opts),
    sleep: () => sleepFolderStore(hippoRoot, tenantId, flags, logFile),
    importAgentNotes: () => logSessionEndImport(logFile, tenantId, transcriptPath),
    readScan: (log) => (transcriptPath ? readSessionScan(transcriptPath, log) : null),
    cursor: {
      after: (id, file, turns) => turnsAfter(turns, loadTurnPosition(id, file)),
      save: (id, file, turns) => saveTurnPosition(id, file, turns, logLine),
    },
    currentProject: () => infraOf(ctx).machine.projectIdentity(process.cwd()),
    // The run writes to this folder's own store, else to the global one in its reach.
    capture: async (into, turns, originProject) => {
      const root = into === ctx ? hippoRoot : ctx.reach?.global?.root;
      if (root === undefined) return false;
      return captureEndedSession(root, { tenantId, flags, transcriptPath, turns, originProject });
    },
    digest: (scan, key, log) =>
      recordSessionDigest(hippoRoot, ctx.store, scan, { key, tenantId, log, config: ctx.config }),
    workingState: (log) => (transcriptPath ? transcriptWorkingState(transcriptPath, log) : null),
    evidence: () => collectHandoffEvidence(process.cwd(), 'unknown'),
  });
}

/** Sleeps the folder's own store; a failure goes to the session log, and capture runs regardless. */
async function sleepFolderStore(
  hippoRoot: string,
  tenantId: string,
  flags: CliFlags,
  closeLogFile: string | null,
): Promise<void> {
  try {
    await (await import('../sleep.js')).handleSleep({ hippoRoot, tenantId, args: [], flags });
  } catch (err) {
    // handleSleep writes its own failure line only once its log tee is open.
    reportSessionEndFailure(closeLogFile, 'session-end: sleep', err);
  }
}

interface EndedCapture {
  readonly tenantId: string;
  readonly flags: CliFlags;
  readonly transcriptPath: string | undefined;
  readonly turns: readonly SessionTurn[] | undefined;
  readonly originProject: ProjectRef | undefined;
}

/** True when capture ran to the end, so a turn close may move its cursor past these turns. */
async function captureEndedSession(
  store: string,
  { tenantId, flags, transcriptPath, turns, originProject }: EndedCapture,
): Promise<boolean> {
  const logFile = stringFlag(flags, 'log-file') ?? null;
  try {
    await runCapture(captureTarget(store), {
      source: 'last-session',
      transcriptPath,
      logFile,
      dryRun: false,
      global: false,
      tenantId,
      originProject,
      sessionTurns: turns,
    });
    return true;
  } catch (err) {
    reportSessionEndFailure(logFile, 'session-end: capture', err);
    return false;
  }
}
