import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import { envCaptureScripted } from '../../../base/util/env.js';
import {
  isJsonObjectLiteral,
  isJsonString,
  tryParseJson,
  type JsonValue,
} from '../../../base/util/json.js';
import { isInitialized } from '../../../host/project-identity.js';
import {
  END_CHECK_MAX_RULES,
  endCheckText,
  openRules,
  stopContext,
  type DetectedRule,
} from '../../../api/end-check.js';
import { detectedRules } from '../../../api/end-check-rules.js';
import { scanForEndCheck } from '../../capture/end-check-scan.js';
import { cliApiContext, cliHookRequest } from '../api-context.js';
import { resolveContextSession } from '../context.js';
import type { CommandContext } from '../flag-values.js';
import { hookStoreRoot, inPilotHoldout } from '../hook-runtime.js';
import { workingFolder } from '../shared.js';
import { readHookStdin } from '../stdin.js';

interface StopInput {
  readonly transcriptPath: string;
  readonly lastAssistantMessage: string | null;
}

function isBusy(value: JsonValue | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}

function stopInput(text: string | undefined): StopInput | null {
  const payload = tryParseJson((text ?? '').trim());
  if (!isJsonObjectLiteral(payload) || payload.stop_hook_active === true) return null;
  if (isBusy(payload.background_tasks) || isBusy(payload.session_crons)) return null;
  const transcriptPath = payload.transcript_path;
  if (!isJsonString(transcriptPath) || transcriptPath.trim() === '') return null;
  const last = payload.last_assistant_message;
  return { transcriptPath, lastAssistantMessage: isJsonString(last) ? last : null };
}

async function rulesFor(
  root: string,
  tenantId: string,
  stdinText: string | undefined,
): Promise<DetectedRule[]> {
  const { currentSessionId } = resolveContextSession(stdinText);
  if (await inPilotHoldout(root, tenantId, currentSessionId, { write: false })) return [];
  const ctx = cliApiContext(root, tenantId);
  return detectedRules(ctx, {
    currentProject: ctx.infra.machine.projectIdentity(workingFolder(ctx)),
    currentSessionId,
  });
}

export async function handleEndCheck({ hippoRoot, tenantId }: CommandContext): Promise<void> {
  const { text } = await readHookStdin();
  try {
    const stop = stopInput(text);
    const root = hookStoreRoot(hippoRoot);
    if (stop === null || !isInitialized(root)) return;
    const rules = (await cliHookRequest(() => rulesFor(root, tenantId, text))) ?? [];
    if (rules.length === 0) return;
    const scan = await scanForEndCheck(stop.transcriptPath, stop.lastAssistantMessage, {
      scriptedIsHuman: envCaptureScripted(),
    });
    if (scan === null) return;
    const open = openRules(rules, scan, END_CHECK_MAX_RULES);
    if (open.length > 0) process.stdout.write(stopContext(endCheckText(open)));
  } catch (err) {
    log.warn(`end-check skipped: ${errorMessage(err)}`, errorFields(err));
  }
}
