// The `hippo context` verb, which the per-prompt hook also runs; main() loads it lazily from the command table.

import { evalNow } from '../ablation.js';
import * as path from 'path';
import { MemoryEntry } from '../memory.js';
import { isInitialized } from '../store.js';
import { estimateTokens } from '../search.js';
import { writeDeliveryEventAtRoot, writeDeliveryEventOnHandle } from '../recall-trace.js';
import { createDeliveryRecorder, type DeliveryRecorder } from '../delivery-recorder.js';
import { loadConfig } from '../config.js';
import { openHippoDb, isSqliteBusy, noteStoreBusy } from '../db.js';
import {
  blockHash,
  isSubagentPayload,
  lastSentState,
  recordTokenUse,
  shouldSkipUnchanged,
  type TokenSurface,
} from '../token-ledger.js';
import { isGlobalStoreRoot } from '../project-identity.js';
import { autoDetectContext } from '../context-auto.js';
import { detectScope } from '../scope.js';
import { getGlobalRoot } from '../shared.js';
import { readStdinBounded } from '../stdin.js';
import * as api from '../api.js';
import { resolveTenantId } from '../tenant.js';
import { renderAmbientSummary } from '../ambient.js';
import {
  contextCost,
  contextHeading,
  contextLine,
  crossProjectHeading,
  crossProjectLine,
  settleTokens,
} from '../context-render.js';
import { printError } from './output.js';
import {
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
  withLedgerDb,
  runHookWithStores,
  inPilotHoldout,
} from './shared.js';

export async function cmdContext(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>,
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
  flags: Record<string, string | boolean | string[]>,
  stdinText: string | undefined,
): DeliveryRecorder | null {
  if (flags['pinned-only'] !== true) return null;
  try {
    // The same store withLedgerDb writes the token ledger to, so its config governs both.
    const root = isInitialized(hippoRoot) ? hippoRoot : isInitialized(getGlobalRoot()) ? getGlobalRoot() : null;
    if (root === null || !loadConfig(root).deliveryLedger.enabled) return null;
    return createDeliveryRecorder({
      root,
      storeHash: blockHash(path.resolve(root)),
      writeStore: isGlobalStoreRoot(root) ? 'global' : 'local',
      tenantId: resolveTenantId({}),
      stdinText,
      envSessionId: hostSessionId(),
    });
  } catch (error) {
    // The hook's one-line stderr contract pins this exact text, so it bypasses the leveled logger.
    printError(`[hippo] delivery ledger skipped:${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** With `db`, writes on the token ledger's handle (same store); without it, opens its own. A second flush is a no-op. */
function flushDeliveryRecorder(rec: DeliveryRecorder | null, db?: ReturnType<typeof openHippoDb>): void {
  if (rec === null) return;
  try {
    rec.flush((input) => (db ? writeDeliveryEventOnHandle(db, input) : writeDeliveryEventAtRoot(rec.root, input)));
  } catch (error) {
    // Pinned stderr text, as in the recorder build above.
    printError(`[hippo] delivery ledger write failed:${error instanceof Error ? error.message : String(error)}`);
  }
}

/** What one render needs once api.getContext has answered. */
interface ContextView {
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly ledgerSessionId: string | undefined;
  readonly payloadSessionId: string | undefined;
  readonly pinnedOnly: boolean;
  readonly framing: string;
  readonly rec: DeliveryRecorder | null;
  readonly result: api.ContextResult;
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
  flags: Record<string, string | boolean | string[]>,
  stdinText: string | undefined,
  rec: DeliveryRecorder | null,
): Promise<void> {
  // --pinned-only fires on every prompt, even where no local .hippo exists, so it skips requireInit
  // and api.getContext falls back to global-only.
  const pinnedOnly = flags['pinned-only'] === true;
  if (!pinnedOnly) {
    requireInit(hippoRoot);
  }

  // The session id bounds the active-task-snapshot read: the stdin hook payload wins, then hostSessionId();
  // absent both, api.getContext applies the pure freshness bound.
  const payload = readHookPayload(stdinText);
  let payloadSessionId = payload.sessionId;
  const currentSessionId = payloadSessionId ?? hostSessionId();
  // A sub-agent's payload and env both carry its parent's session id, so it books no session and never skips a block.
  const subagent = isSubagentPayload(stdinText);
  const ledgerSessionId = subagent ? undefined : currentSessionId;
  if (subagent) payloadSessionId = undefined;

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
  let query = args.join(' ').trim();
  if (!query && flags['auto']) {
    query = autoDetectContext();
  }

  // Scope detection uses cwd, so it is resolved here and passed in via opts.scope.
  const ctxExplicitScope = flags['scope'] !== undefined ? String(flags['scope']).trim() : null;
  const ctxActiveScope = ctxExplicitScope || detectScope();

  const ctx: api.Context = {
    hippoRoot,
    tenantId: resolvedTenant,
    actor: api.adminActor('cli'),
  };
  // --cross-project re-includes other-project memories, rendered under their own section.
  const crossProject = flags['cross-project'] === true;

  const format = String(flags['format'] ?? 'markdown');
  const framing = String(flags['framing'] ?? 'observe');

  const opts: api.ContextOpts = {
    q: query,
    budget,
    limit: parseLimitFlag(flags['limit']),
    pinnedOnly,
    scope: ctxActiveScope ?? undefined,
    includeRecent: parseCountFlag(flags['include-recent']),
    crossProject,
    currentSessionId,
    prompt: payload.prompt,
    // JSON is budgeted as the markdown it stands for, so one budget picks the same memories in every format.
    cost: contextCost(format === 'additional-context' ? 'additional-context' : 'markdown', framing),
    deliveryObserver: rec ?? undefined,
  };

  const result = await api.getContext(ctx, opts);

  const hasContextData =
    result.entries.length > 0 ||
    result.activeSnapshot ||
    result.sessionHandoff ||
    (result.recentEvents && result.recentEvents.length > 0);
  if (!hasContextData) {
    rec?.delivered({ state: 'empty' });
    return;
  }

  const view: ContextView = { hippoRoot, tenantId: ctx.tenantId, ledgerSessionId, payloadSessionId, pinnedOnly, framing, rec, result };
  if (format === 'json') {
    renderContextJson(view, query);
  } else if (format === 'additional-context') {
    renderAdditionalContext(view);
  } else {
    renderContextMarkdown(view);
  }
}

type RenderItem = { entry: MemoryEntry; score: number; tokens: number; isGlobal: boolean };

function toRenderItems(entries: api.ContextResultEntry[]): RenderItem[] {
  return entries.map((r) => ({ entry: r.entry, score: r.score, tokens: r.tokens, isGlobal: r.isGlobal ?? false }));
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
  withLedgerDb(view.hippoRoot, (db) => {
    recordTokenUse(db, {
      tenantId: view.tenantId, sessionId: view.ledgerSessionId, surface: view.pinnedOnly ? 'hook' : 'context',
      event: 'inject', items: output.length, tokens: estimateTokens(jsonText),
    });
    flushDeliveryRecorder(rec, db);
  });
}

/** The hook format: a skippable static block (snapshot, handoff, events, pins, recent-N) and a never-skipped recall block. */
function renderAdditionalContext(view: ContextView): void {
  const { result, rec, framing } = view;
  const staticEntries = result.entries.filter((r) => r.category !== 'cross-project' && !r.promptRecall);
  const staticCrossEntries = result.entries.filter((r) => r.category === 'cross-project' && !r.promptRecall);
  const staticItems = toRenderItems(staticEntries);
  const recallItems = toRenderItems(result.entries.filter((r) => r.promptRecall));

  const staticBlock = settleTokens((t) => captureConsole(() => {
    if (result.activeSnapshot) printActiveTaskSnapshot(result.activeSnapshot);
    if (result.sessionHandoff) printHandoff(result.sessionHandoff);
    if (result.recentEvents && result.recentEvents.length > 0) {
      printSessionEvents(result.recentEvents);
    }
    // No live strength percentage, so an unchanged set of memories renders byte-identically turn after turn.
    if (staticItems.length > 0) printContextMarkdown(staticItems, t, framing, { showStrength: false });
    printCrossProjectSection(staticCrossEntries);
  }));
  const recallBlock = recallItems.length > 0
    ? settleTokens((t) => captureConsole(() => printContextMarkdown(recallItems, t, framing, { showStrength: false, heading: 'Prompt-Relevant Memory' })))
    : '';
  if (!staticBlock.trim() && !recallBlock.trim()) {
    rec?.delivered({ state: 'empty' });
    return;
  }

  const surface: TokenSurface = view.pinnedOnly ? 'hook' : 'context';
  const sendStatic = staticBlock.trim().length > 0 && !skipUnchangedStatic(view, surface, staticBlock, recallBlock, staticItems.length);

  const finalStatic = sendStatic ? staticBlock : '';
  const additionalContext = finalStatic && recallBlock
    ? `${finalStatic}\n\n${recallBlock}`
    : finalStatic || recallBlock;
  const staticReused = !sendStatic && staticBlock.trim().length > 0;
  if (!additionalContext.trim()) {
    rec?.delivered({ state: 'reused', staticHash: blockHash(staticBlock), staticReused });
    return;
  }

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(payload));
  rec?.delivered({
    state: staticReused ? 'reused-recall-sent' : 'sent',
    staticHash: staticBlock.trim() ? blockHash(staticBlock) : null,
    recallHash: recallBlock ? blockHash(recallBlock) : null,
    emittedText: additionalContext,
    staticReused,
  });
  if (finalStatic || recallBlock) {
    recordAdditionalContextRows(view, surface, { text: finalStatic, items: staticItems.length }, { text: recallBlock, items: recallItems.length });
  }
}

/** True, after booking the skip row, when the hook may omit a static block this session already holds. */
function skipUnchangedStatic(view: ContextView, surface: TokenSurface, staticBlock: string, recallBlock: string, staticCount: number): boolean {
  const { hippoRoot, payloadSessionId, rec } = view;
  if (!view.pinnedOnly || payloadSessionId === undefined) return false;
  const injectCfg = loadConfig(hippoRoot).pinnedInject;
  if (injectCfg.skipUnchanged === false) return false;
  const refreshTurns = Number.isFinite(injectCfg.refreshTurns) && injectCfg.refreshTurns >= 0
    ? injectCfg.refreshTurns
    : 10;
  // Hashed on the static text alone so an unchanged pin set still skips while recall varies.
  const staticHash = blockHash(staticBlock);
  const last = withLedgerDb(hippoRoot, (db) =>
    lastSentState(db, view.tenantId, payloadSessionId, surface));
  if (!shouldSkipUnchanged(last ?? null, staticHash, refreshTurns)) return false;
  withLedgerDb(hippoRoot, (db) => {
    recordTokenUse(db, {
      tenantId: view.tenantId, sessionId: payloadSessionId, surface, event: 'skip',
      items: staticCount, tokens: estimateTokens(staticBlock), hash: staticHash,
    });
    if (recallBlock.trim()) return;
    rec?.delivered({ state: 'reused', staticHash, staticReused: true });
    flushDeliveryRecorder(rec, db);
  });
  return true;
}

interface InjectedBlock { readonly text: string; readonly items: number }

/** One connection for both rows; each insert in its own try so one failing doesn't skip the other. */
function recordAdditionalContextRows(view: ContextView, surface: TokenSurface, staticPart: InjectedBlock, recallPart: InjectedBlock): void {
  withLedgerDb(view.hippoRoot, (db) => {
    if (staticPart.text) {
      try {
        recordTokenUse(db, {
          tenantId: view.tenantId, sessionId: view.ledgerSessionId, surface, event: 'inject',
          items: staticPart.items, tokens: estimateTokens(staticPart.text), hash: blockHash(staticPart.text),
        });
      // Best-effort row: only a busy store is actionable, and a ledger failure must not break the hook.
      } catch (error) { if (isSqliteBusy(error)) noteStoreBusy('token ledger row skipped'); }
    }
    if (recallPart.text) {
      try {
        recordTokenUse(db, {
          tenantId: view.tenantId, sessionId: view.ledgerSessionId, surface: 'hook_recall', event: 'inject',
          items: recallPart.items, tokens: estimateTokens(recallPart.text), hash: blockHash(recallPart.text),
        });
      // Same best-effort rule as the inject row above.
      } catch (error) { if (isSqliteBusy(error)) noteStoreBusy('token ledger row skipped'); }
    }
    flushDeliveryRecorder(view.rec, db);
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
    if (renderItems.length > 0) printContextMarkdown(renderItems, t, framing);
    printCrossProjectSection(crossEntries);
    if (result.ambientState) {
      console.log(`\n${renderAmbientSummary(result.ambientState)}`);
    }
  }));
  if (text.length > 0) console.log(text);
  rec?.delivered(text.length > 0 ? { state: 'sent', emittedText: `${text}\n` } : { state: 'empty' });
  withLedgerDb(view.hippoRoot, (db) => {
    recordTokenUse(db, {
      tenantId: view.tenantId, sessionId: view.ledgerSessionId, surface: view.pinnedOnly ? 'hook' : 'context',
      event: 'inject', items: renderItems.length, tokens: estimateTokens(text),
    });
    flushDeliveryRecorder(rec, db);
  });
}

/** An explicit header lets agents and humans tell borrowed context from project memory. */
function printCrossProjectSection(items: api.ContextResultEntry[]): void {
  if (items.length === 0) return;
  console.log(crossProjectHeading(items.length));
  for (const item of items) console.log(crossProjectLine(item));
}

/** @internal Exported for the render snapshot test; not a stable public API. */
export function printContextMarkdown(
  items: Array<{ entry: MemoryEntry; score: number; tokens: number; isGlobal: boolean }>,
  totalTokens: number,
  framing: string = 'observe',
  opts: { showStrength?: boolean; heading?: string } = {}
): void {
  const now = evalNow();
  const showStrength = opts.showStrength !== false;
  console.log(contextHeading(opts.heading ?? 'Project Memory', items.length, totalTokens));
  for (const item of items) console.log(contextLine(item, framing, showStrength, now));
}

export async function handleContext({ hippoRoot, args, flags }: CommandContext): Promise<void> {
  // Bounded, not a TTY guard: the hot stdin path and a manual run share this one command.
  const { text: stdinText } = await readStdinBounded();
  await runHookWithStores(() => cmdContext(hookStoreRoot(hippoRoot), args, flags, stdinText));
}
