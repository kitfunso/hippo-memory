// The stores the CLI root hands its capture, digest and doctor code, for tests that call that code directly.
import type { CaptureTarget } from '../../src/capture/command.js';
import { cliLocalFiles, cliSyncStore } from '../../src/cli/api-context.js';
import type { Diagnostics } from '../../src/store/port/diagnostics.js';

export function captureTarget(root: string): CaptureTarget {
  return { root, store: cliSyncStore(root) };
}

export function diagnosticsAt(root: string): Diagnostics {
  return cliLocalFiles(root).diagnostics;
}

export { cliSyncStore as syncStore };
