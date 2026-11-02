// `hippo session-rules`: the SessionStart hook that sends the rules the person taught, and nothing else.
import { estimateTokens } from '../util/token-text.js';
import { userRulesGet } from '../api/index.js';
import { userRuleLines } from '../api/context-render.js';
import { bookTokenUse } from '../api/ledger-db.js';
import { resolveProjectIdentity } from '../core/project-identity.js';
import { cliApiContext } from './api-context.js';
import { resolveContextSession } from './context.js';
import type { CommandContext } from './flag-values.js';
import { hookStoreRoot, inPilotHoldout, runHookWithStores } from './hook-runtime.js';
import { readHookStdin } from './stdin.js';

async function printSessionRules(hippoRoot: string, tenantId: string, stdinText: string | undefined): Promise<void> {
  const { currentSessionId, ledgerSessionId, payloadSessionId } = resolveContextSession(stdinText);
  // Booked at the first hook call, as the prompt hook books it, so the holdout sees no rules.
  if (inPilotHoldout(hippoRoot, tenantId, currentSessionId, payloadSessionId !== undefined)) return;

  const rules = await userRulesGet(cliApiContext(hippoRoot, tenantId), {
    currentProject: resolveProjectIdentity(process.cwd()),
    currentSessionId,
  });
  const text = userRuleLines(rules).join('\n').trim();
  if (text === '') return;

  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
  bookTokenUse(hippoRoot, {
    tenantId,
    sessionId: ledgerSessionId,
    surface: 'session_start',
    event: 'inject',
    items: rules.length,
    tokens: estimateTokens(text),
  });
}

export async function handleSessionRules({ hippoRoot, tenantId }: CommandContext): Promise<void> {
  const { text: stdinText } = await readHookStdin();
  // Fires in every folder, so it never requires init: a folder with no store reads the global one.
  await runHookWithStores(() => printSessionRules(hookStoreRoot(hippoRoot), tenantId, stdinText));
}
