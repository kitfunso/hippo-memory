// The SessionStart(compact) hook: re-prints the task snapshot and session trail that compaction dropped.
import { estimateTokens } from '../../../base/util/token-text.js';
import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import { isInitialized } from '../../../host/project-identity.js';
import { compactResumeBlock } from '../../../api/session-end.js';
import { bookLedgerTurn } from '../../../api/ledger-db.js';
import { flushDeliveryRecorder, startDeliveryRecorder, takeDelivery } from '../../../api/prompt-hook.js';
import type { DeliveryRecorder } from '../../../api/delivery-recorder.js';
import { readHookStdin } from '../stdin.js';
import { readCompactResumePayload } from '../compact-resume-payload.js';
import { cliApiContext, cliHookRequest, cliLedgerReach } from '../api-context.js';
import type { CommandContext } from '../flag-values.js';
import { hookStoreRoot, hostSessionId, inPilotHoldout, resetHookInjection } from '../hook-runtime.js';

export async function handleCompactResume({ hippoRoot, tenantId }: CommandContext): Promise<void> {
  const { text: stdinText, timedOut: stdinTimedOut } = await readHookStdin();
  await cliHookRequest(async () => {
    await resetHookInjection(hippoRoot, tenantId, stdinText, 'compact');
    await resumeAfterCompact(hookStoreRoot(hippoRoot), tenantId, stdinText, stdinTimedOut);
  });
}

/** Prints the snapshot and trail, but no pinned memories (UserPromptSubmit re-injects them). A malformed payload or a
 * store read failure degrades to empty stdout, never a failed SessionStart. */
async function resumeAfterCompact(
  hippoRoot: string,
  tenantId: string,
  stdinText: string | undefined,
  stdinTimedOut: boolean,
): Promise<void> {
  let rec: DeliveryRecorder | null = null;
  try {
    // Gate on the non-exiting isInitialized check first: the store reads below call initStore, which would silently
    // create a store in a project that never ran `hippo init`, and this hook fires globally.
    if (!isInitialized(hippoRoot)) return;

    const payloadState = readCompactResumePayload(stdinText, stdinTimedOut);
    let suppressOutput = payloadState.suppressOutput;
    const payloadSessionId = payloadState.payloadSessionId;

    if (payloadState.boundary) {
      rec = await startDeliveryRecorder(cliApiContext(hippoRoot, tenantId), {
        stdinText,
        runtime: 'claude-code',
        eventType: 'compact-resume',
        envSessionId: hostSessionId(),
      });
    }

    // A compaction follows a prompt or SessionStart that booked the arm, so this only reads it.
    if (
      !suppressOutput &&
      payloadSessionId !== null &&
      (await inPilotHoldout(hippoRoot, tenantId, payloadSessionId, { write: false }))
    ) {
      suppressOutput = true;
      rec?.disabled();
    }

    if (!suppressOutput) await restoreCompactSnapshot(hippoRoot, tenantId, payloadSessionId, rec);
  } catch (err) {
    // Empty stdout on any store error, never a crashed SessionStart; the reason goes to stderr, which the model never
    // sees.
    log.warn(`hippo compact-resume: skipped: ${errorMessage(err)}`, errorFields(err));
  }
  // A no-op when the token ledger's handle already wrote the row.
  await flushDeliveryRecorder(rec);
}

async function restoreCompactSnapshot(
  hippoRoot: string,
  tenantId: string,
  payloadSessionId: string | null,
  rec: DeliveryRecorder | null,
): Promise<void> {
  const text = await compactResumeBlock(cliApiContext(hippoRoot, tenantId), payloadSessionId);
  if (text === null) return;
  // Printed in one write so the ledger books exactly the text the model is handed.
  console.log(text);
  rec?.delivered({ state: 'sent', emittedText: `${text}\n` });
  await bookLedgerTurn(
    {
      uses: [
        {
          tenantId,
          sessionId: payloadSessionId,
          surface: 'compact_resume',
          event: 'inject',
          items: 1,
          tokens: estimateTokens(text),
        },
      ],
      delivery: takeDelivery(rec),
    },
    cliLedgerReach(hippoRoot),
  );
}
