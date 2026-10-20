// The `hippo context` verb, which the per-prompt hook also runs; main() loads it lazily from the command table.

import { envActiveScope } from '../../base/util/env.js';
import type { DeliveryRecorder } from '../../api/delivery-recorder.js';
import { isSubagentPayload } from '../../base/util/hook-payload.js';
import { estimateTokens } from '../../base/util/token-text.js';
import { autoDetectContext } from '../../api/context-auto.js';
import { processGit } from '../../base/util/git-runner.js';
import { resolveProjectIdentity } from '../../base/scope/project-identity.js';
import { bookLedgerTurn, ledgerReachOf } from '../../api/ledger-db.js';
import { readHookStdin } from './stdin.js';
import { isJsonObject, isJsonString, type JsonValue } from '../../base/util/json.js';
import * as api from '../../api/index.js';
import { DEFAULT_CONTEXT_BUDGET, NO_QUERY } from '../../api/context.js';
import { cliApiContext, cliHookRequest } from './api-context.js';
import { renderAmbientSummary } from '../../base/memory/ambient.js';
import { strengthOptionsOf } from '../../base/memory/memory.js';
import { contextBlockLines, contextCost, crossProjectLines, settleTokens } from '../../api/context-render.js';
import {
  additionalContextOutput,
  type ContextView,
  flushDeliveryRecorder,
  hasContextData,
  startDeliveryRecorder,
  takeDelivery,
  sessionStartEnvelope,
  toRenderItems,
} from '../../api/prompt-hook.js';
import {
  type CliFlags,
  parseLimitFlag,
  parseCountFlag,
  parseBudgetFlag,
  type CommandContext,
  flagIsTrue,
  stringFlagOrExit,
  boolFlag,
} from './flag-values.js';
import { requireInit } from './shared.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { continuityTexts } from './print.js';
import { hostSessionId, hookStoreRoot, hookRuntime, payloadCwdRoot, inPilotHoldout } from './hook-runtime.js';

async function printContext(
  hippoRoot: string,
  tenantId: string,
  args: string[],
  flags: CliFlags,
  stdinText?: string,
): Promise<void> {
  const rec = await startDeliveryRecorder(cliApiContext(hippoRoot, tenantId), {
    stdinText,
    runtime: hookRuntime(flags),
    eventType: flagIsTrue(flags, 'pinned-only') ? undefined : 'context',
    envSessionId: hostSessionId(),
  });
  // No try/finally: a render throw keeps its own exit code and writes no event.
  await renderContext({ hippoRoot, tenantId, args, flags, stdinText, rec });
  await flushDeliveryRecorder(rec);
}

interface HookPayload {
  readonly sessionId?: string;
  readonly prompt?: string;
}

/** The hook payload's session id and raw prompt; a malformed or empty payload yields neither. */
function readHookPayload(stdinText: string | undefined): HookPayload {
  let sessionId: string | undefined;
  let prompt: string | undefined;
  if (stdinText && stdinText.trim() !== '') {
    try {
      const payload: JsonValue = JSON.parse(stdinText.trim());
      const sid = isJsonObject(payload) ? payload['session_id'] : undefined;
      const raw = isJsonObject(payload) ? payload['prompt'] : undefined;
      if (isJsonString(sid) && sid.trim() !== '') sessionId = sid;
      if (isJsonString(raw)) prompt = raw;
    } catch (err) {
      // Malformed/non-JSON stdin: fall through to the env fallback below.
      log.debug(`context: hook payload is not JSON: ${errorMessage(err)}`, errorFields(err));
    }
  }
  return { sessionId, prompt };
}

interface ContextGate {
  readonly pinnedOnly: boolean;
  readonly session: ContextSession;
  readonly budget: number;
}

/** Null when this call renders nothing: the pilot holdout arm, or a budget of zero. */
async function contextGate(
  hippoRoot: string,
  resolvedTenant: string,
  flags: CliFlags,
  stdinText: string | undefined,
  rec: DeliveryRecorder | null,
): Promise<ContextGate | null> {
  // --pinned-only fires on every prompt, even where no local .hippo exists, so it skips requireInit and api.contextGet
  // falls back to global-only.
  const pinnedOnly = flagIsTrue(flags, 'pinned-only');
  if (!pinnedOnly) {
    requireInit(hippoRoot);
  }

  const session = resolveContextSession(stdinText);
  const { currentSessionId, payloadSessionId } = session;

  // The pilot arm is booked at the first hook call whatever the flags, so the holdout sees no budget or content branch.
  if (await inPilotHoldout(hippoRoot, resolvedTenant, currentSessionId, { write: payloadSessionId !== undefined })) {
    rec?.disabled();
    return null;
  }

  const budget = parseBudgetFlag(flags, DEFAULT_CONTEXT_BUDGET);
  if (budget <= 0) {
    rec?.disabled();
    return null;
  }
  return { pinnedOnly, session, budget };
}

interface RenderContextOptions {
  hippoRoot: string;
  tenantId: string;
  args: string[];
  flags: CliFlags;
  stdinText: string | undefined;
  rec: DeliveryRecorder | null;
}

async function renderContext(options: RenderContextOptions): Promise<void> {
  const { hippoRoot, tenantId: resolvedTenant, args, flags, stdinText, rec } = options;
  const gate = await contextGate(hippoRoot, resolvedTenant, flags, stdinText, rec);
  if (gate === null) return;
  const { pinnedOnly, session, budget } = gate;
  const { ledgerSessionId, payloadSessionId } = session;

  // --auto shells out to git, so it stays CLI-side; api.contextGet stays host-agnostic and falls back to '*'.
  const query = contextQuery(args, flags);

  const ctx = cliApiContext(hippoRoot, resolvedTenant);
  const format = stringFlagOrExit(flags, 'format') ?? 'markdown';
  const framing = stringFlagOrExit(flags, 'framing') ?? 'observe';
  const opts = buildContextOpts(flags, { query, budget, pinnedOnly, format, framing, session, rec });

  const result = await api.contextGet(ctx, opts);
  if (!hasContextData(result)) {
    rec?.delivered({ state: 'empty' });
    return;
  }

  const envelope = format === 'copilot' ? sessionStartEnvelope(stdinText) : undefined;
  const view: ContextView = {
    config: ctx.config,
    tenantId: ctx.tenantId,
    ledgerSessionId,
    payloadSessionId,
    pinnedOnly,
    framing,
    rec,
    result,
    reach: ledgerReachOf(ctx),
    envelope,
  };
  await renderContextView(view, format, query);
}

function contextQuery(args: string[], flags: CliFlags): string {
  const query = args.join(' ').trim();
  return !query && boolFlag(flags, 'auto') ? autoDetectContext(processGit) : query;
}

async function renderContextView(view: ContextView, format: string, query: string): Promise<void> {
  if (format === 'json') {
    await renderContextJson(view, query);
  } else if (format === 'additional-context' || format === 'copilot') {
    const stdout = await additionalContextOutput(view);
    if (stdout) process.stdout.write(stdout);
  } else {
    await renderContextMarkdown(view);
  }
}

interface ContextSession {
  readonly currentSessionId: string | undefined;
  readonly ledgerSessionId: string | undefined;
  readonly payloadSessionId: string | undefined;
  readonly prompt: string | undefined;
}

function resolveContextSession(stdinText: string | undefined): ContextSession {
  // The session id bounds the active-task-snapshot read: the stdin hook payload wins, then hostSessionId(); absent
  // both, api.contextGet applies the pure freshness bound.
  const payload = readHookPayload(stdinText);
  let payloadSessionId = payload.sessionId;
  const currentSessionId = payloadSessionId ?? hostSessionId();
  // A sub-agent's payload and env both carry its parent's session id, so it books no session and never skips a block.
  const subagent = isSubagentPayload(stdinText);
  const ledgerSessionId = subagent ? undefined : currentSessionId;
  if (subagent) payloadSessionId = undefined;
  return { currentSessionId, ledgerSessionId, payloadSessionId, prompt: payload.prompt };
}

interface ContextOptsInput {
  readonly query: string;
  readonly budget: number;
  readonly pinnedOnly: boolean;
  readonly format: string;
  readonly framing: string;
  readonly session: ContextSession;
  readonly rec: DeliveryRecorder | null;
}

function buildContextOpts(flags: CliFlags, input: ContextOptsInput): api.ContextOptions {
  // Scope detection uses cwd, so it is resolved here and passed in via opts.scope.
  const ctxExplicitScope = stringFlagOrExit(flags, 'scope') ?? null;
  const ctxActiveScope = ctxExplicitScope || envActiveScope();
  // --cross-project re-includes other-project memories, rendered under their own section.
  const crossProject = flagIsTrue(flags, 'cross-project');
  return {
    q: input.query,
    budget: input.budget,
    limit: parseLimitFlag(flags, 'limit'),
    pinnedOnly: input.pinnedOnly,
    scope: ctxActiveScope ?? undefined,
    includeRecent: parseCountFlag(flags, 'include-recent'),
    crossProject,
    currentProject: resolveProjectIdentity(process.cwd()),
    currentSessionId: input.session.currentSessionId,
    prompt: input.session.prompt,
    // JSON is budgeted as the markdown it stands for, so one budget picks the same memories in every format.
    cost: contextCost(
      input.format === 'additional-context' || input.format === 'copilot' ? 'additional-context' : 'markdown',
      input.framing,
    ),
    deliveryObserver: input.rec ?? undefined,
  };
}

async function renderContextJson(view: ContextView, query: string): Promise<void> {
  const { result, rec } = view;
  const output = result.entries.map((r) => ({
    id: r.entry.id,
    score: r.score,
    strength: r.entry.strength,
    tags: r.entry.tags,
    confidence: r.entry.confidence,
    content: r.entry.content,
    global: r.isGlobal ?? false,
    origin: r.origin ?? null,
    category: r.category ?? null,
  }));
  const jsonText = JSON.stringify({
    query: query || NO_QUERY,
    activeSnapshot: result.activeSnapshot ?? null,
    sessionHandoff: result.sessionHandoff ?? null,
    recentSessionEvents: result.recentEvents ?? [],
    memories: output,
    tokens: result.tokens,
  });
  console.log(jsonText);
  rec?.delivered({ state: 'sent', emittedText: `${jsonText}\n` });
  await bookLedgerTurn(
    {
      uses: [
        {
          tenantId: view.tenantId,
          sessionId: view.ledgerSessionId,
          surface: view.pinnedOnly ? 'hook' : 'context',
          event: 'inject',
          items: output.length,
          tokens: estimateTokens(jsonText),
        },
      ],
      delivery: takeDelivery(rec),
    },
    view.reach,
  );
}

/** The default format; the header figure counts the whole block, sections included, as the ledger does. */
async function renderContextMarkdown(view: ContextView): Promise<void> {
  const { result, rec, framing } = view;
  // Cross-project inclusions get their own section so they never masquerade as project memory.
  const renderItems = toRenderItems(result.entries.filter((r) => r.category !== 'cross-project'));
  const crossEntries = result.entries.filter((r) => r.category === 'cross-project');
  const text = settleTokens((t) => {
    const lines = continuityTexts(result.activeSnapshot, result.sessionHandoff, result.recentEvents);
    if (renderItems.length > 0) {
      lines.push(...contextBlockLines(renderItems, t, framing, { strength: strengthOptionsOf(view.config.runtime) }));
    }
    lines.push(...crossProjectLines(crossEntries));
    if (result.ambientState) lines.push(`\n${renderAmbientSummary(result.ambientState)}`);
    return lines.join('\n');
  });
  if (text.length > 0) console.log(text);
  rec?.delivered(text.length > 0 ? { state: 'sent', emittedText: `${text}\n` } : { state: 'empty' });
  await bookLedgerTurn(
    {
      uses: [
        {
          tenantId: view.tenantId,
          sessionId: view.ledgerSessionId,
          surface: view.pinnedOnly ? 'hook' : 'context',
          event: 'inject',
          items: renderItems.length,
          tokens: estimateTokens(text),
        },
      ],
      delivery: takeDelivery(rec),
    },
    view.reach,
  );
}

export async function handleContext({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  // Bounded, not a TTY guard: the hot stdin path and a manual run share this one command.
  const { text: stdinText } = await readHookStdin();
  const root = payloadCwdRoot(hippoRoot, stdinText, hookRuntime(flags));
  await cliHookRequest(() => printContext(hookStoreRoot(root), tenantId, args, flags, stdinText));
}
