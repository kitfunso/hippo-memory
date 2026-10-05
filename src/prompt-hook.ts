// The per-prompt hook's block and ledger rows, rendered here for `hippo context` and for promptHookContext (a remote hook route's call).
// promptHookContext keeps the server-side copy of the CLI's getContext flags (cli/context.ts); the CLI parity case in tests/prompt-hook-context.test.ts is all that ties the two.
import { getContext, type Context, type ContextResult, type ContextResultEntry } from './api.js';
import { loadConfig } from './config.js';
import { contextBlockLines, contextCost, crossProjectLines, handoffText, sessionTrailText, settleTokens, snapshotText } from './context-render.js';
import { closeHippoDb, isSqliteBusy, noteStoreBusy, openHippoDb } from './db.js';
import type { DeliveryRecorder } from './delivery-recorder.js';
import { isJsonString, type JsonValue } from './json.js';
import type { MemoryEntry } from './memory.js';
import { ensurePilotArm, hashArm, readPilotArm, type PilotArm } from './pilot-arm.js';
import { writeDeliveryEventAtRoot, writeDeliveryEventOnHandle } from './recall-trace.js';
import { getGlobalRoot } from './shared.js';
import { isInitialized } from './store/open.js';
import { blockHash, estimateTokens, isSubagentPayload, lastSentState, recordTokenUse, shouldSkipUnchanged, type TokenSurface } from './token-ledger.js';

/** Runs `fn` on the local store, else the global one, since the prompt hook fires where no local store exists.
 *  Best-effort: undefined on any failure, because a ledger failure must not break context or recall. */
export function withLedgerDb<T>(hippoRoot: string, fn: (db: ReturnType<typeof openHippoDb>) => T): T | undefined {
  let root: string | null = null;
  try {
    if (isInitialized(hippoRoot)) root = hippoRoot;
    else if (isInitialized(getGlobalRoot())) root = getGlobalRoot();
  } catch {
    // An unreadable store root means no ledger write; the ledger must never break context or recall.
    return undefined;
  }
  if (root === null) return undefined;
  let db: ReturnType<typeof openHippoDb> | undefined;
  try {
    db = openHippoDb(root);
    return fn(db);
  } catch (error) {
    // Best effort, but a busy store is the one failure an operator can act on, so it warns once.
    if (isSqliteBusy(error)) noteStoreBusy('token ledger row skipped');
    return undefined;
  } finally {
    if (db) closeHippoDb(db);
  }
}

/** The session's pilot arm (src/pilot-arm.ts), or null at rate 0, with no session id, or with no store.
 *  `write` books the arm row; a read-only caller (env-only id, sub-agent) follows the stored arm, else the hash. */
export function sessionPilotArm(hippoRoot: string, tenantId: string, sessionId: string | undefined, write: boolean): PilotArm | null {
  if (sessionId === undefined || sessionId.trim() === '') return null;
  const root = isInitialized(hippoRoot) ? hippoRoot : isInitialized(getGlobalRoot()) ? getGlobalRoot() : null;
  if (root === null) return null;
  const rate = loadConfig(root).pilot.holdoutRateBp;
  if (rate <= 0) return null;
  const arm = withLedgerDb(hippoRoot, (db) =>
    write ? ensurePilotArm(db, tenantId, sessionId, rate) : readPilotArm(db, sessionId) ?? hashArm(sessionId, rate));
  return arm ?? hashArm(sessionId, rate);
}

/** With `db`, writes on the token ledger's handle (same store); without it, opens its own. A second flush is a no-op. */
export function flushDeliveryRecorder(rec: DeliveryRecorder | null, db?: ReturnType<typeof openHippoDb>): void {
  if (rec === null) return;
  try {
    rec.flush((input) => (db ? writeDeliveryEventOnHandle(db, input) : writeDeliveryEventAtRoot(rec.root, input)));
  } catch (error) {
    // The hook's one-line stderr contract pins this exact text, so it bypasses the leveled logger.
    console.error(`[hippo] delivery ledger write failed:${error instanceof Error ? error.message : String(error)}`);
  }
}

/** What one render needs once api.getContext has answered. */
export interface ContextView {
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly ledgerSessionId: string | undefined;
  readonly payloadSessionId: string | undefined;
  readonly pinnedOnly: boolean;
  readonly framing: string;
  readonly rec: DeliveryRecorder | null;
  readonly result: ContextResult;
}

export function hasContextData(result: ContextResult): boolean {
  return Boolean(
    result.entries.length > 0 ||
    result.activeSnapshot ||
    result.sessionHandoff ||
    (result.recentEvents && result.recentEvents.length > 0),
  );
}

export type RenderItem = { entry: MemoryEntry; score: number; tokens: number; isGlobal: boolean };

export function toRenderItems(entries: ContextResultEntry[]): RenderItem[] {
  return entries.map((r) => ({ entry: r.entry, score: r.score, tokens: r.tokens, isGlobal: r.isGlobal ?? false }));
}

/** The hook format's stdout, '' when nothing is sent: a skippable static block (snapshot, handoff, events, pins, recent-N) and a never-skipped recall block. */
export function additionalContextOutput(view: ContextView): string {
  const { result, rec, framing } = view;
  const staticEntries = result.entries.filter((r) => r.category !== 'cross-project' && !r.promptRecall);
  const staticCrossEntries = result.entries.filter((r) => r.category === 'cross-project' && !r.promptRecall);
  const staticItems = toRenderItems(staticEntries);
  const recallItems = toRenderItems(result.entries.filter((r) => r.promptRecall));

  const staticBlock = settleTokens((t) => [
    ...(result.activeSnapshot ? [snapshotText(result.activeSnapshot)] : []),
    ...(result.sessionHandoff ? [handoffText(result.sessionHandoff)] : []),
    ...(result.recentEvents && result.recentEvents.length > 0 ? [sessionTrailText(result.recentEvents)] : []),
    // No live strength percentage, so an unchanged set of memories renders byte-identically turn after turn.
    ...(staticItems.length > 0 ? contextBlockLines(staticItems, t, framing, { showStrength: false }) : []),
    ...crossProjectLines(staticCrossEntries),
  ].join('\n'));
  const recallBlock = recallItems.length > 0
    ? settleTokens((t) => contextBlockLines(recallItems, t, framing, { showStrength: false, heading: 'Prompt-Relevant Memory' }).join('\n'))
    : '';
  if (!staticBlock.trim() && !recallBlock.trim()) {
    rec?.delivered({ state: 'empty' });
    return '';
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
    return '';
  }

  const stdout = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  });
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
  return stdout;
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

// The flags HIPPO_PINNED_INJECT_COMMAND gives the local hook; the CLI parity test fails if the two drift.
const HOOK_INCLUDE_RECENT = 5;
const HOOK_BUDGET = 1500;
const HOOK_FRAMING = 'observe';

interface PromptHookRequest {
  readonly sessionId: string;
  readonly project: { readonly name: string; readonly legacyName: string; readonly aliases?: readonly string[] };
  readonly payload?: Readonly<Record<string, JsonValue>>;
}

/** The text `hippo context --pinned-only --include-recent 5 --format additional-context` prints for this session, read on `ctx`'s store for the caller's project.
 *  `arm` is the raw ledger arm (`hippo` or `holdout`), null at rate 0; a holdout session gets an empty stdout. */
export async function promptHookContext(ctx: Context, req: PromptHookRequest): Promise<{ arm: PilotArm | null; stdout: string }> {
  const { sessionId, payload } = req;
  // The test the local hook runs on its stdin, so a sub-agent books no arm and no session rows here either.
  const subagent = payload !== undefined && isSubagentPayload(JSON.stringify(payload));
  const ledgerSessionId = subagent ? undefined : sessionId;
  const arm = sessionPilotArm(ctx.hippoRoot, ctx.tenantId, sessionId, !subagent);
  if (arm === 'holdout') return { arm, stdout: '' };
  const prompt = payload?.prompt;
  const result = await getContext(ctx, {
    budget: HOOK_BUDGET,
    pinnedOnly: true,
    includeRecent: HOOK_INCLUDE_RECENT,
    // The project comes from the caller, never from where the store sits or the daemon's cwd.
    currentProject: req.project,
    currentSessionId: sessionId,
    prompt: isJsonString(prompt) ? prompt : undefined,
    cost: contextCost('additional-context', HOOK_FRAMING),
  });
  const stdout = hasContextData(result)
    ? additionalContextOutput({
        hippoRoot: ctx.hippoRoot, tenantId: ctx.tenantId, ledgerSessionId, payloadSessionId: ledgerSessionId,
        pinnedOnly: true, framing: HOOK_FRAMING, rec: null, result,
      })
    : '';
  return { arm, stdout };
}
