// The `hippo context` verb, which the per-prompt hook also runs; main() loads it lazily from the command table.

import * as path from 'path';
import { createDeliveryRecorder, type DeliveryRecorder } from '../delivery-recorder.js';
import { loadConfig } from '../config.js';
import { isSubagentPayload } from '../token-ledger.js';
import { blockHash, estimateTokens } from '../util/token-text.js';
import { isGlobalStoreRoot } from '../project-identity.js';
import { autoDetectContext } from '../context-auto.js';
import { detectScope } from '../scope.js';
import { bookLedgerTurn, ledgerRoot } from '../ledger-db.js';
import { readHookStdin } from '../stdin.js';
import * as api from '../api.js';
import { resolveTenantId } from '../tenant.js';
import { renderAmbientSummary } from '../ambient.js';
import { contextBlockLines, contextCost, crossProjectLines, settleTokens } from '../context-render.js';
import {
  additionalContextOutput,
  type ContextView,
  flushDeliveryRecorder,
  hasContextData,
  sessionStartEnvelope,
  toRenderItems,
} from '../prompt-hook.js';
import { printError } from './output.js';
import {
  type CliFlags,
  parseLimitFlag,
  parseCountFlag,
  parseBudgetFlag,
  requireInit,
  type CommandContext,
  printActiveTaskSnapshot,
  printSessionEvents,
  printHandoff,
  hostSessionId,
  captureConsole,
  hookStoreRoot,
  hookRuntime,
  payloadCwdRoot,
  runHookWithStores,
  inPilotHoldout,
  flagIsTrue,
} from './shared.js';
import { errorMessage } from '../log.js';

export async function cmdContext(
  hippoRoot: string,
  args: string[],
  flags: CliFlags,
  stdinText?: string
): Promise<void> {
  const rec = startDeliveryRecorder(hippoRoot, flags, stdinText);
  // No try/finally: a render throw keeps its own exit code and writes no event.
  await renderContext(hippoRoot, args, flags, stdinText, rec);
  flushDeliveryRecorder(rec);
}

/** A delivery recorder for a pinned-only call when its ledger store enables one, else null; never throws. */
function startDeliveryRecorder(
  hippoRoot: string,
  flags: CliFlags,
  stdinText: string | undefined,
): DeliveryRecorder | null {
  if (flags['pinned-only'] !== true) return null;
  try {
    // The same store withLedgerDb writes the token ledger to, so its config governs both.
    const root = ledgerRoot(hippoRoot);
    if (root === null || !loadConfig(root).deliveryLedger.enabled) return null;
    return createDeliveryRecorder({
      root,
      storeHash: blockHash(path.resolve(root)),
      writeStore: isGlobalStoreRoot(root) ? 'global' : 'local',
      tenantId: resolveTenantId({}),
      stdinText,
      envSessionId: hostSessionId(),
      runtime: hookRuntime(flags) === 'copilot' ? 'copilot' : undefined,
    });
  } catch (error) {
    // The hook's one-line stderr contract pins this exact text, so it bypasses the leveled logger.
    printError(`[hippo] delivery ledger skipped:${errorMessage(error)}`);
    return null;
  }
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
      // SAFETY: both fields are type-checked below before use; `?? {}` covers a JSON null payload.
      const { session_id: sid, prompt: raw } = (JSON.parse(stdinText.trim()) ?? {}) as { session_id?: unknown; prompt?: unknown };
      if (typeof sid === 'string' && sid.trim() !== '') sessionId = sid;
      if (typeof raw === 'string') prompt = raw;
    } catch {
      // Malformed/non-JSON stdin: fall through to the env fallback below.
    }
  }
  return { sessionId, prompt };
}

async function renderContext(
  hippoRoot: string,
  args: string[],
  flags: CliFlags,
  stdinText: string | undefined,
  rec: DeliveryRecorder | null,
): Promise<void> {
  // --pinned-only fires on every prompt, even where no local .hippo exists, so it skips requireInit
  // and api.getContext falls back to global-only.
  const pinnedOnly = flagIsTrue(flags, 'pinned-only');
  if (!pinnedOnly) {
    requireInit(hippoRoot);
  }

  const session = resolveContextSession(stdinText);
  const { currentSessionId, ledgerSessionId, payloadSessionId } = session;

  // The pilot arm is booked at the first hook call whatever the flags, so the holdout sees no budget or content branch.
  const resolvedTenant = resolveTenantId({});
  if (inPilotHoldout(hippoRoot, resolvedTenant, currentSessionId, payloadSessionId !== undefined)) {
    rec?.disabled();
    return;
  }

  const budget = parseBudgetFlag(flags['budget'], 1500);
  if (budget <= 0) {
    rec?.disabled();
    return;
  }

  // --auto shells out to git, so it stays CLI-side; api.getContext stays host-agnostic and falls back to '*'.
  const query = contextQuery(args, flags);

  const ctx: api.Context = { hippoRoot, tenantId: resolvedTenant, actor: api.adminActor('cli') };
  const format = String(flags['format'] ?? 'markdown');
  const framing = String(flags['framing'] ?? 'observe');
  const opts = buildContextOpts(flags, { query, budget, pinnedOnly, format, framing, session, rec });

  const result = await api.getContext(ctx, opts);
  if (!hasContextData(result)) {
    rec?.delivered({ state: 'empty' });
    return;
  }

  const envelope = format === 'copilot' ? sessionStartEnvelope(stdinText) : undefined;
  const view: ContextView = { hippoRoot, tenantId: ctx.tenantId, ledgerSessionId, payloadSessionId, pinnedOnly, framing, rec, result, envelope };
  renderContextView(view, format, query);
}

function contextQuery(args: string[], flags: CliFlags): string {
  const query = args.join(' ').trim();
  return !query && flags['auto'] ? autoDetectContext() : query;
}

function renderContextView(view: ContextView, format: string, query: string): void {
  if (format === 'json') {
    renderContextJson(view, query);
  } else if (format === 'additional-context' || format === 'copilot') {
    const stdout = additionalContextOutput(view);
    if (stdout) process.stdout.write(stdout);
  } else {
    renderContextMarkdown(view);
  }
}

interface ContextSession {
  readonly currentSessionId: string | undefined;
  readonly ledgerSessionId: string | undefined;
  readonly payloadSessionId: string | undefined;
  readonly prompt: string | undefined;
}

function resolveContextSession(stdinText: string | undefined): ContextSession {
  // The session id bounds the active-task-snapshot read: the stdin hook payload wins, then hostSessionId();
  // absent both, api.getContext applies the pure freshness bound.
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

function buildContextOpts(flags: CliFlags, input: ContextOptsInput): api.ContextOpts {
  // Scope detection uses cwd, so it is resolved here and passed in via opts.scope.
  const ctxExplicitScope = flags['scope'] !== undefined ? String(flags['scope']).trim() : null;
  const ctxActiveScope = ctxExplicitScope || detectScope();
  // --cross-project re-includes other-project memories, rendered under their own section.
  const crossProject = flagIsTrue(flags, 'cross-project');
  return {
    q: input.query,
    budget: input.budget,
    limit: parseLimitFlag(flags['limit']),
    pinnedOnly: input.pinnedOnly,
    scope: ctxActiveScope ?? undefined,
    includeRecent: parseCountFlag(flags['include-recent']),
    crossProject,
    currentSessionId: input.session.currentSessionId,
    prompt: input.session.prompt,
    // JSON is budgeted as the markdown it stands for, so one budget picks the same memories in every format.
    cost: contextCost(input.format === 'additional-context' || input.format === 'copilot' ? 'additional-context' : 'markdown', input.framing),
    deliveryObserver: input.rec ?? undefined,
  };
}

function renderContextJson(view: ContextView, query: string): void {
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
    query: query || '*',
    activeSnapshot: result.activeSnapshot ?? null,
    sessionHandoff: result.sessionHandoff ?? null,
    recentSessionEvents: result.recentEvents ?? [],
    memories: output,
    tokens: result.tokens,
  });
  console.log(jsonText);
  rec?.delivered({ state: 'sent', emittedText: `${jsonText}\n` });
  bookLedgerTurn(view.hippoRoot, {
    uses: [{
      tenantId: view.tenantId, sessionId: view.ledgerSessionId, surface: view.pinnedOnly ? 'hook' : 'context',
      event: 'inject', items: output.length, tokens: estimateTokens(jsonText),
    }],
    delivery: (write) => flushDeliveryRecorder(rec, write),
  });
}

/** The default format; the header figure counts the whole block, sections included, as the ledger does. */
function renderContextMarkdown(view: ContextView): void {
  const { result, rec, framing } = view;
  // Cross-project inclusions get their own section so they never masquerade as project memory.
  const renderItems = toRenderItems(result.entries.filter((r) => r.category !== 'cross-project'));
  const crossEntries = result.entries.filter((r) => r.category === 'cross-project');
  const text = settleTokens((t) => captureConsole(() => {
    if (result.activeSnapshot) {
      printActiveTaskSnapshot(result.activeSnapshot);
    }
    if (result.sessionHandoff) {
      printHandoff(result.sessionHandoff);
    }
    if (result.recentEvents && result.recentEvents.length > 0) {
      printSessionEvents(result.recentEvents);
    }
    if (renderItems.length > 0) for (const line of contextBlockLines(renderItems, t, framing)) console.log(line);
    printCrossProjectSection(crossEntries);
    if (result.ambientState) {
      console.log(`\n${renderAmbientSummary(result.ambientState)}`);
    }
  }));
  if (text.length > 0) console.log(text);
  rec?.delivered(text.length > 0 ? { state: 'sent', emittedText: `${text}\n` } : { state: 'empty' });
  bookLedgerTurn(view.hippoRoot, {
    uses: [{
      tenantId: view.tenantId, sessionId: view.ledgerSessionId, surface: view.pinnedOnly ? 'hook' : 'context',
      event: 'inject', items: renderItems.length, tokens: estimateTokens(text),
    }],
    delivery: (write) => flushDeliveryRecorder(rec, write),
  });
}

function printCrossProjectSection(items: api.ContextResultEntry[]): void {
  for (const line of crossProjectLines(items)) console.log(line);
}

export async function handleContext({ hippoRoot, args, flags }: CommandContext): Promise<void> {
  // Bounded, not a TTY guard: the hot stdin path and a manual run share this one command.
  const { text: stdinText } = await readHookStdin();
  const root = payloadCwdRoot(hippoRoot, stdinText, hookRuntime(flags));
  await runHookWithStores(() => cmdContext(hookStoreRoot(root), args, flags, stdinText));
}
