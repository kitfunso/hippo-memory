// The PreCompact hook: records the compaction and saves a working-state snapshot before the host summarises.
import { flushDeliveryRecorder, startDeliveryRecorder } from '../../../api/prompt-hook.js';
import { preCompactHook } from '../../capture/compact.js';
import { readHookStdin } from '../stdin.js';
import { cliApiContext, cliHookRequest, cliStore } from '../api-context.js';
import { type CommandContext, stringFlag } from '../flag-values.js';
import { hookRuntime, hookStoreRoot, hostSessionId, payloadCwdRoot, resetHookInjection } from '../hook-runtime.js';

export async function handlePreCompact({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  // Bounded wait, not a TTY guard: an idle non-TTY pipe must not hang.
  const { text: stdinText, timedOut: stdinTimedOut } = await readHookStdin();
  const runtime = hookRuntime(flags);
  const root = payloadCwdRoot(hippoRoot, stdinText, runtime);
  const storeRoot = hookStoreRoot(root);
  await cliHookRequest(async () => {
    // Started before any store wait, so two fires of one hook carry timestamps close enough to match as duplicates.
    const rec = await startDeliveryRecorder(cliApiContext(storeRoot, tenantId), {
      stdinText,
      runtime,
      eventType: 'pre-compact',
      envSessionId: hostSessionId(),
    });
    await resetHookInjection(root, tenantId, stdinText, null);
    // Started at the boundary, so the row lands then; awaited after, as the boundary callback cannot wait.
    let flushed: Promise<void> | undefined;
    try {
      await preCompactHook(storeRoot, cliStore(storeRoot), {
        tenantId,
        stdinText,
        stdinTimedOut,
        logFile: stringFlag(flags, 'log-file'),
        runtime,
        onBoundary: (printed) => {
          rec?.delivered(printed === null ? { state: 'empty' } : { state: 'sent', emittedText: printed });
          flushed = flushDeliveryRecorder(rec);
        },
      });
    } finally {
      await flushed;
    }
  });
}
