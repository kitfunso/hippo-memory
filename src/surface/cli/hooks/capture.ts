// `hippo capture`: extracts memories from piped text, a file or a session transcript.
import { resolveGlobalRootDir } from '../../../host/project-identity.js';
import { runCapture, type CaptureOptions } from '../../capture/command.js';
import { readHookStdin } from '../stdin.js';
import { type CommandContext, boolFlag, stringFlag, stringFlagOrExit } from '../flag-values.js';
import { captureTarget } from '../hook-runtime.js';
import { fail } from '../exit.js';

export async function handleCapture({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  let captureSource: CaptureOptions['source'] | null = null;
  let captureFile: string | undefined;
  let transcriptPath: string | undefined;

  if (boolFlag(flags, 'stdin')) {
    captureSource = 'stdin';
  } else if (boolFlag(flags, 'file')) {
    captureSource = 'file';
    captureFile = stringFlagOrExit(flags, 'file');
  } else if (boolFlag(flags, 'last-session')) {
    captureSource = 'last-session';
  }

  if (boolFlag(flags, 'transcript')) {
    transcriptPath = stringFlagOrExit(flags, 'transcript');
    if (!captureSource) captureSource = 'last-session';
  }

  if (!captureSource) {
    fail(
      'Usage: hippo capture --stdin|--file <path>|--last-session [--transcript <path>] [--log-file <path>] ' +
        '[--dry-run] [--global]',
    );
  }

  // Bounded, and only when last-session has no explicit path: the --stdin source keeps its own blocking read in
  // src/surface/capture/ by design.
  const bounded =
    captureSource === 'last-session' && !transcriptPath ? await readHookStdin() : { text: undefined, timedOut: false };

  const useGlobal = boolFlag(flags, 'global');
  await runCapture(captureTarget(useGlobal ? resolveGlobalRootDir() : hippoRoot), {
    source: captureSource,
    filePath: captureFile,
    transcriptPath,
    stdinText: bounded.text,
    stdinTimedOut: bounded.timedOut,
    logFile: stringFlag(flags, 'log-file'),
    dryRun: boolFlag(flags, 'dry-run'),
    global: useGlobal,
    tenantId,
  });
}
