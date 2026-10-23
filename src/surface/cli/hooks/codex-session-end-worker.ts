// The Codex wrapper's session-end worker (`__codex-session-end-worker`): sleep, then capture and digest the rollout.
import * as path from 'path';
import { resolveCodexSessionTranscript } from '../../capture/codex-session.js';
import { resolveCodexWrapperPaths } from '../../hooks-install/codex-wrapper.js';
import { readSessionScan, recordSessionDigest } from '../../capture/session-digest.js';
import { runCapture, type CaptureOptions } from '../../capture/command.js';
import { isInitialized, resolveProjectIdentity } from '../../../host/project-identity.js';
import { cliConfig, cliStore } from '../api-context.js';
import { type CliFlags, type CommandContext, parseCountFlag, stringFlag } from '../flag-values.js';
import {
  appendSessionEndCloseLog,
  captureTarget,
  hookStoreRoot,
  logSessionEndImport,
  reportSessionEndFailure,
} from '../hook-runtime.js';

export async function handleCodexSessionEndWorker({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  const logFile = stringFlag(flags, 'log-file') ?? null;
  // Like the other hooks: project store, else global; a folder with neither must not get one made.
  const store = hookStoreRoot(hippoRoot);
  if (!isInitialized(store)) {
    appendSessionEndCloseLog(logFile, 'skip: no hippo store for this folder or globally', { startFresh: true });
    return;
  }

  await sleepCodexProjectStore(hippoRoot, tenantId, logFile);
  await captureCodexTranscript(hippoRoot, tenantId, store, flags, logFile);
}

async function sleepCodexProjectStore(hippoRoot: string, tenantId: string, logFile: string | null): Promise<void> {
  // Sleeping the global store from here would learn this folder's git commits into it; it has its own daily sleep.
  if (isInitialized(hippoRoot)) {
    try {
      await (
        await import('../sleep.js')
      ).handleSleep({
        hippoRoot,
        tenantId,
        args: [],
        flags: logFile ? { 'log-file': logFile } : {},
      });
    } catch (err) {
      reportSessionEndFailure(logFile, 'codex session-end: sleep', err);
    }
  } else {
    appendSessionEndCloseLog(logFile, 'skip sleep: this folder has no store of its own', { startFresh: true });
    await logSessionEndImport(logFile, tenantId, undefined);
  }
}

async function captureCodexTranscript(
  hippoRoot: string,
  tenantId: string,
  store: string,
  flags: CliFlags,
  logFile: string | null,
): Promise<void> {
  try {
    const codexHome = stringFlag(flags, 'codex-home') ?? resolveCodexWrapperPaths().codexHome;
    const historyPath = stringFlag(flags, 'history-path') ?? path.join(codexHome, 'history.jsonl');
    const startOffsetBytes = parseCountFlag(flags, 'start-offset');
    const startedAtMs = parseCountFlag(flags, 'started-at') || Date.now();
    const transcriptPath =
      resolveCodexSessionTranscript({
        codexHome,
        historyPath,
        startOffsetBytes,
        startedAtMs,
      }) ?? undefined;
    // No Codex transcript must not fall through to the scan of Claude Code projects.
    if (!transcriptPath) {
      appendSessionEndCloseLog(logFile, 'skip capture: no Codex transcript for this session');
      return;
    }

    const digestLog = (message: string): void => appendSessionEndCloseLog(logFile, message);
    const scan = readSessionScan(transcriptPath, digestLog);
    const captureOpts: CaptureOptions = {
      source: 'last-session',
      transcriptPath,
      logFile,
      dryRun: false,
      global: false,
      tenantId,
      originProject: store === hippoRoot ? undefined : resolveProjectIdentity(process.cwd()),
      sessionTurns: scan?.turns,
    };
    try {
      await runCapture(captureTarget(store), captureOpts);
    } catch (err) {
      reportSessionEndFailure(logFile, 'codex session-end: capture', err);
    }
    // The Codex wrapper passes no session id, so the rollout file names the session.
    const digestKey = path.basename(transcriptPath, '.jsonl');
    const digestOpts = { key: digestKey, tenantId, log: digestLog, config: cliConfig(hippoRoot) };
    await recordSessionDigest(hippoRoot, cliStore(hippoRoot), scan, digestOpts);
  } catch (err) {
    reportSessionEndFailure(logFile, 'codex session-end: transcript scan or digest', err);
  }
}
