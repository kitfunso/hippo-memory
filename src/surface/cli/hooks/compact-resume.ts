// The SessionStart(compact) hook: re-prints the task snapshot and session trail that compaction
// dropped.
import { estimateTokens } from '../../../base/util/token-text.js';
import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import { isInitialized } from '../../../host/project-identity.js';
import { compactResumeBlock } from '../../../api/session-end.js';
import { bookLedgerTurn } from '../../../api/ledger-db.js';
import {
  flushDeliveryRecorder,
  startDeliveryRecorder,
  takeDelivery,
} from '../../../api/ledger-db.js';
import type { DeliveryRecorder } from '../../../api/delivery/delivery-recorder.js';
import { readHookStdin } from '../stdin.js';
import { readCompactResumePayload } from '../compact-resume-payload.js';
import type { CommandContext } from '../flag-values.js';
import {
  hookStoreRoot,
  hostSessionId,
  inPilotHoldout,
  resetHookInjection,
} from '../hook-runtime.js';
import type { CliScope } from '../api-context.js';

export async function handleCompactResume({
  hippoRoot,
  tenantId,
  cli,
}: CommandContext): Promise<void> {
  const { text: stdinText, timedOut: stdinTimedOut } = await readHookStdin();
  await cli.hookRequest(async (hook) => {
    await resetHookInjection({ cli: hook, hippoRoot, tenantId }, stdinText, 'compact');
    await resumeAfterCompact(
      { cli: hook, hippoRoot: hookStoreRoot(hippoRoot), tenantId },
      stdinText,
      stdinTimedOut,
    );
  });
}

/** Prints the snapshot and trail, but no pinned memories (UserPromptSubmit re-injects them). A
 * malformed payload or a store read failure degrades to empty stdout, never a failed
 * SessionStart. */
async function resumeAfterCompact(
  { cli, hippoRoot, tenantId }: CliScope,
  stdinText: string | undefined,
  stdinTimedOut: boolean,
): Promise<void> {
  let rec: DeliveryRecorder | null = null;
  try {
    // Gate on the non-exiting isInitialized check first: the store reads below call initStore,
    // which would silently create a store in a project that never ran `hippo init`, and this hook
    // fires globally.
    if (!isInitialized(hippoRoot)) return;

    const payloadState = readCompactResumePayload(stdinText, stdinTimedOut);
    let suppressOutput = payloadState.suppressOutput;
    const payloadSessionId = payloadState.payloadSessionId;

    if (payloadState.boundary) {
      rec = await startDeliveryRecorder(cli.apiContext(hippoRoot, tenantId), {
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
      (await inPilotHoldout({ cli, hippoRoot, tenantId }, payloadSessionId, { write: false }))
    ) {
      suppressOutput = true;
      rec?.disabled();
    }

    if (!suppressOutput) {
      await restoreCompactSnapshot({ cli, hippoRoot, tenantId }, payloadSessionId, rec);
    }
  } catch (err) {
    // Empty stdout on any store error, never a crashed SessionStart; the reason goes to stderr,
    // which the model never sees.
    log.warn(`hippo compact-resume: skipped: ${errorMessage(err)}`, errorFields(err));
  }
  // A no-op when the token ledger's handle already wrote the row.
  await flushDeliveryRecorder(rec);
}

async function restoreCompactSnapshot(
  { cli, hippoRoot, tenantId }: CliScope,
  payloadSessionId: string | null,
  rec: DeliveryRecorder | null,
): Promise<void> {
  const text = await compactResumeBlock(
    cli.apiContext(hippoRoot, tenantId),
    payloadSessionId,
    null,
  );
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
    cli.ledgerReach(hippoRoot),
  );
}
