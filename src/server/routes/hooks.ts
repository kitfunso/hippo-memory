// POST /v1/hooks/:event: a laptop with no store of its own forwards its Claude Code hook here and prints the stdout it gets back.
import { getContext } from '../../api.js';
import { contextCost } from '../../context-render.js';
import { HttpError, isJsonObjectRecord, MAX_ID_LEN, sendJson } from '../../http-util.js';
import { isJsonString, type JsonValue } from '../../json.js';
import type { PilotArm } from '../../pilot-arm.js';
import { additionalContextOutput, hasContextData, sessionPilotArm } from '../../prompt-hook.js';
import { isSubagentPayload } from '../../token-ledger.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { getString, parseJsonBody } from '../validation.js';

// The flags HIPPO_PINNED_INJECT_COMMAND gives the local hook; the CLI parity test fails if the two drift.
const HOOK_INCLUDE_RECENT = 5;
const HOOK_BUDGET = 1500;
const HOOK_FRAMING = 'observe';
// The core names at most three (project file id, remote id, folder name); the slack covers later sources.
const MAX_ALIASES = 8;

interface PromptHookRequest {
  readonly sessionId: string;
  readonly project: { readonly name: string; readonly legacyName: string; readonly aliases?: readonly string[] };
  readonly prompt: string | undefined;
  readonly subagent: boolean;
}

function requiredId(value: JsonValue | undefined, field: string): string {
  if (!isJsonString(value) || value.trim() === '') throw new HttpError(400, `${field} is required`);
  if (value.length > MAX_ID_LEN) throw new HttpError(400, `${field} exceeds ${MAX_ID_LEN}-character cap`);
  return value;
}

function optionalAliases(value: JsonValue | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, 'project.aliases must be an array of strings');
  if (value.length > MAX_ALIASES) throw new HttpError(400, `project.aliases exceeds ${MAX_ALIASES}-entry cap`);
  return value.map((a) => requiredId(a, 'project.aliases[]'));
}

function parsePromptHookRequest(body: Record<string, JsonValue>): PromptHookRequest {
  const sessionId = requiredId(body.session_id, 'session_id');
  const project = body.project;
  if (!isJsonObjectRecord(project)) throw new HttpError(400, 'project is required');
  const name = requiredId(project.name, 'project.name');
  const legacyName = project.legacy_name === undefined ? name : requiredId(project.legacy_name, 'project.legacy_name');
  const aliases = optionalAliases(project.aliases);
  const payload = body.payload;
  if (payload !== undefined && !isJsonObjectRecord(payload)) throw new HttpError(400, 'payload must be a JSON object');
  return {
    sessionId,
    project: aliases === undefined ? { name, legacyName } : { name, legacyName, aliases },
    prompt: payload === undefined ? undefined : getString(payload, 'prompt'),
    // The test the local hook runs on its stdin, so a sub-agent books no arm and no session rows here either.
    subagent: payload !== undefined && isSubagentPayload(JSON.stringify(payload)),
  };
}

/** The ledger names the treatment arm `hippo`; the response contract says `treatment`. */
function armLabel(arm: PilotArm | null): 'treatment' | 'holdout' | null {
  if (arm === null) return null;
  return arm === 'holdout' ? 'holdout' : 'treatment';
}

export async function handleHookEvent({ req, res, opts }: RouteRequest, params: Record<string, string>): Promise<void> {
  // Auth before the event check, so an anonymous caller learns nothing about which events exist.
  const ctx = await buildContextWithAuth(req, opts);
  if (params.event !== 'prompt') throw new HttpError(404, 'unknown hook event');
  const hook = parsePromptHookRequest(await parseJsonBody(req, ctx));
  const ledgerSessionId = hook.subagent ? undefined : hook.sessionId;
  const arm = sessionPilotArm(ctx.hippoRoot, ctx.tenantId, hook.sessionId, !hook.subagent);
  if (arm === 'holdout') {
    sendJson(res, 200, { arm: armLabel(arm), stdout: '' });
    return;
  }
  const result = await getContext(ctx, {
    budget: HOOK_BUDGET,
    pinnedOnly: true,
    includeRecent: HOOK_INCLUDE_RECENT,
    // The project comes from the laptop, never from where the served store sits or the daemon's cwd.
    currentProject: hook.project,
    currentSessionId: hook.sessionId,
    prompt: hook.prompt,
    cost: contextCost('additional-context', HOOK_FRAMING),
  });
  const stdout = hasContextData(result)
    ? additionalContextOutput({
        hippoRoot: ctx.hippoRoot, tenantId: ctx.tenantId, ledgerSessionId, payloadSessionId: ledgerSessionId,
        pinnedOnly: true, framing: HOOK_FRAMING, rec: null, result,
      })
    : '';
  sendJson(res, 200, { arm: armLabel(arm), stdout });
}
