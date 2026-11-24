import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import { parseJson } from '../../../base/util/json.js';
import { isInitialized } from '../../../host/project-identity.js';
import { flushDeliveryRecorder, startToolFailureRecorder } from '../../../api/ledger-db.js';
import { captureToolFailure } from '../../capture/capture-error.js';
import { detachedEmbedder } from '../../../api/embeddings.js';
import { withDetached } from '../../../api/detached.js';
import { readHookStdin } from '../stdin.js';
import { cliApiContext, cliHookRequest } from '../api-context.js';
import type { CommandContext } from '../flag-values.js';
import { hookRuntime, hookStoreRoot, hostSessionId, payloadCwdRoot } from '../hook-runtime.js';

/** Every path exits 0, and nothing is created when no store exists, since the hook fires in
 * every directory. */
export async function handleCaptureError({
  hippoRoot,
  tenantId,
  flags,
}: CommandContext): Promise<void> {
  const { text } = await readHookStdin();
  try {
    const root = hookStoreRoot(payloadCwdRoot(hippoRoot, text, hookRuntime(flags)));
    const payload = (text ?? '').trim();
    if (isInitialized(root) && payload) {
      const failure = parseJson(payload);
      await cliHookRequest(async () => {
        const ctx = cliApiContext(root, tenantId);
        const rec = await startToolFailureRecorder(ctx, {
          stdinText: text,
          runtime: hookRuntime(flags),
          envSessionId: hostSessionId(),
        });
        const folder = { store: ctx.store, config: ctx.config, embedderFor: ctx.infra.embedderFor };
        try {
          return await withDetached(ctx, (detached) => {
            const embed = detachedEmbedder(folder, ctx.infra, detached);
            return captureToolFailure({ ...ctx, embed }, failure, (id) => rec?.logged(id));
          });
        } finally {
          await flushDeliveryRecorder(rec);
        }
      });
    }
  } catch (err) {
    log.warn(`failure capture skipped: ${errorMessage(err)}`, errorFields(err));
  }
}
