// `hippo session-rules`: the SessionStart hook that sends the rules the person taught, and nothing
// else.
import { estimateTokens } from '../../base/util/token-text.js';
import { userRulesGet } from '../../api/index.js';
import { userRuleLines } from '../../api/context/context-render.js';
import { bookTokenUse } from '../../api/ledger-db.js';
import { cliApiContext, cliHookRequest, cliLedgerReach } from './api-context.js';
import { resolveContextSession } from './context.js';
import type { CommandContext } from './flag-values.js';
import { hookStoreRoot, inPilotHoldout } from './hook-runtime.js';
import { readHookStdin } from './stdin.js';
import { workingFolder } from './shared.js';

async function printSessionRules(
  hippoRoot: string,
  tenantId: string,
  stdinText: string | undefined,
): Promise<void> {
  const { currentSessionId, ledgerSessionId, payloadSessionId } = resolveContextSession(stdinText);
  // Booked at the first hook call, as the prompt hook books it, so the holdout sees no rules.
  const held = await inPilotHoldout(hippoRoot, tenantId, currentSessionId, {
    write: payloadSessionId !== undefined,
  });
  if (held) return;

  const ctx = cliApiContext(hippoRoot, tenantId);
  const rules = await userRulesGet(ctx, {
    currentProject: ctx.infra.machine.projectIdentity(workingFolder(ctx)),
    currentSessionId,
  });
  const text = userRuleLines(rules).join('\n').trim();
  if (text === '') return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    }),
  );
  await bookTokenUse(
    {
      tenantId,
      sessionId: ledgerSessionId,
      surface: 'session_start',
      event: 'inject',
      items: rules.length,
      tokens: estimateTokens(text),
    },
    cliLedgerReach(hippoRoot),
  );
}

export async function handleSessionRules({ hippoRoot, tenantId }: CommandContext): Promise<void> {
  const { text: stdinText } = await readHookStdin();
  // Fires in every folder, so it never requires init: a folder with no store reads the global one.
  await cliHookRequest(() => printSessionRules(hookStoreRoot(hippoRoot), tenantId, stdinText));
}
