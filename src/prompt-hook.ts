// The per-prompt hook's block and ledger rows, rendered here for `hippo context` and for promptHookContext (a remote hook route's call).
// promptHookContext keeps the server-side copy of the CLI's getContext flags (cli/context.ts); the CLI parity case in tests/prompt-hook-context.test.ts is all that ties the two.
import { getContext, type Context, type ContextResult, type ContextResultEntry } from './api.js';
import { BadRequestError } from './api-errors.js';
import { isSharedStore, loadConfig } from './config.js';
import { contextBlockLines, contextCost, crossProjectLines, handoffText, sessionTrailText, settleTokens, snapshotText } from './context-render.js';
import { isSqliteBusy, noteStoreBusy, rethrowIfSqliteBlocked, type openHippoDb } from './db.js';
import type { DeliveryRecorder } from './delivery-recorder.js';
import { MAX_ID_LEN } from './http-util.js';
import { isJsonString, type JsonValue } from './json.js';
import { withLedgerDb } from './ledger-db.js';
import { errorMessage, log } from './log.js';
import type { MemoryEntry } from './memory.js';
import { sessionPilotArm, storePilotArm, type PilotArm } from './pilot-arm.js';
import { assertCallerProject, MAX_PROJECT_ALIASES } from './project-identity.js';
import { writeDeliveryEventAtRoot, writeDeliveryEventOnHandle } from './recall-trace.js';
import { requireGroup, type HippoStore, type HookStore } from './store-port.js';
import {
  blockHash, estimateTokens, hookPayloadString, isSubagentPayload, lastSentState, recordTokenUse, shouldSkipUnchanged,
  type LastSent, type TokenSurface, type TokenUse,
} from './token-ledger.js';

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
  /** Ledger rows stay in `hippoRoot`, never the global store; see promptHookContext. */
  readonly sharedStore?: boolean;
  /** The static block's hash the caller says it printed last. Undefined keeps the ledger-only skip rule;
   *  a string or null also needs that hash to match, because the ledger counts blocks a caller that prints elsewhere may never have shown. */
  readonly printedHash?: string | null;
  /** The reply's JSON wrapper; absent means Claude Code's UserPromptSubmit. */
  readonly envelope?: HookEnvelope;
}

/** `copilot-session-start` is the Copilot harness's top-level reply, `vscode-session-start` the nested one VS Code Local reads. */
export type HookEnvelope = 'user-prompt-submit' | 'copilot-session-start' | 'vscode-session-start';

/** A Copilot sessionStart reply's wrapper, picked by the sender's casing: stdin.ts keeps a camelCase `sessionId`, which only the Copilot harness sends. */
export function sessionStartEnvelope(stdinText: string | undefined): HookEnvelope {
  return hookPayloadString(stdinText, 'sessionId') !== null ? 'copilot-session-start' : 'vscode-session-start';
}

function hookReply(envelope: HookEnvelope, additionalContext: string): string {
  if (envelope === 'copilot-session-start') return JSON.stringify({ additionalContext });
  const hookEventName = envelope === 'vscode-session-start' ? 'SessionStart' : 'UserPromptSubmit';
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } });
}

/** A hook render's stdout and the hash of the static block it carries, null when it carries none. */
interface RenderedContext {
  readonly stdout: string;
  readonly staticHash: string | null;
}

const NOTHING_RENDERED: RenderedContext = Object.freeze({ stdout: '', staticHash: null });

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
  return renderAdditionalContext(view).stdout;
}

interface ComposedBlocks {
  readonly staticBlock: string;
  readonly recallBlock: string;
  readonly staticCount: number;
  readonly recallCount: number;
  readonly surface: TokenSurface;
}

/** The static and recall blocks, or null after recording an empty delivery when both are blank. */
function composeBlocks(view: ContextView): ComposedBlocks | null {
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
    return null;
  }
  const surface: TokenSurface = view.pinnedOnly ? 'hook' : 'context';
  return { staticBlock, recallBlock, staticCount: staticItems.length, recallCount: recallItems.length, surface };
}

/** The reply once the skip check has decided, and the inject rows it books. */
function settleRender(view: ContextView, blocks: ComposedBlocks, sendStatic: boolean): { rendered: RenderedContext; rows: TokenUse[] } {
  const { rec } = view;
  const { staticBlock, recallBlock } = blocks;
  const finalStatic = sendStatic ? staticBlock : '';
  const additionalContext = finalStatic && recallBlock
    ? `${finalStatic}\n\n${recallBlock}`
    : finalStatic || recallBlock;
  const staticReused = !sendStatic && staticBlock.trim().length > 0;
  if (!additionalContext.trim()) {
    rec?.delivered({ state: 'reused', staticHash: blockHash(staticBlock), staticReused });
    return { rendered: NOTHING_RENDERED, rows: [] };
  }

  const stdout = hookReply(view.envelope ?? 'user-prompt-submit', additionalContext);
  rec?.delivered({
    state: staticReused ? 'reused-recall-sent' : 'sent',
    staticHash: staticBlock.trim() ? blockHash(staticBlock) : null,
    recallHash: recallBlock ? blockHash(recallBlock) : null,
    emittedText: additionalContext,
    staticReused,
  });
  const inject = (surface: TokenSurface, text: string, items: number): TokenUse => ({
    tenantId: view.tenantId, sessionId: view.ledgerSessionId, surface, event: 'inject', items, tokens: estimateTokens(text), hash: blockHash(text),
  });
  const rows = [
    ...(finalStatic ? [inject(blocks.surface, finalStatic, blocks.staticCount)] : []),
    ...(recallBlock ? [inject('hook_recall', recallBlock, blocks.recallCount)] : []),
  ];
  return { rendered: { stdout, staticHash: finalStatic ? blockHash(finalStatic) : null }, rows };
}

function renderAdditionalContext(view: ContextView): RenderedContext {
  const blocks = composeBlocks(view);
  if (blocks === null) return NOTHING_RENDERED;
  const sendStatic = blocks.staticBlock.trim().length > 0 && !skipUnchangedStatic(view, blocks);
  const { rendered, rows } = settleRender(view, blocks, sendStatic);
  if (rows.length > 0) recordAdditionalContextRows(view, rows);
  return rendered;
}

/** promptHookContext's render on a store: the skip check reads through the hooks group and each row is best effort. A store caller has no delivery recorder. */
async function renderThroughStore(store: HippoStore, hooks: HookStore, view: ContextView): Promise<RenderedContext> {
  const blocks = composeBlocks(view);
  if (blocks === null) return NOTHING_RENDERED;
  const sendStatic = blocks.staticBlock.trim().length > 0 && !(await skipThroughStore(store, hooks, view, blocks));
  const { rendered, rows } = settleRender(view, blocks, sendStatic);
  for (const row of rows) await recordTokensBestEffort(store, row);
  return rendered;
}

interface SkipCandidate { readonly sessionId: string; readonly staticHash: string; readonly refreshTurns: number }

/** What the skip check needs before its ledger read, or null when the static block must go out. */
function skipCandidate(view: ContextView, staticBlock: string): SkipCandidate | null {
  const { payloadSessionId } = view;
  if (!view.pinnedOnly || payloadSessionId === undefined) return null;
  // Session start is the only injection Copilot gets, so a resumed session needs the whole block again.
  if (view.envelope === 'copilot-session-start' || view.envelope === 'vscode-session-start') return null;
  const injectCfg = loadConfig(view.hippoRoot).pinnedInject;
  if (injectCfg.skipUnchanged === false) return null;
  const refreshTurns = Number.isFinite(injectCfg.refreshTurns) && injectCfg.refreshTurns >= 0
    ? injectCfg.refreshTurns
    : 10;
  // Hashed on the static text alone so an unchanged pin set still skips while recall varies.
  const staticHash = blockHash(staticBlock);
  // Before the ledger read, so a caller that did not print this block books no skip row.
  if (view.printedHash !== undefined && view.printedHash !== staticHash) return null;
  return { sessionId: payloadSessionId, staticHash, refreshTurns };
}

function skipRow(view: ContextView, blocks: ComposedBlocks, skip: SkipCandidate): TokenUse {
  return {
    tenantId: view.tenantId, sessionId: skip.sessionId, surface: blocks.surface, event: 'skip',
    items: blocks.staticCount, tokens: estimateTokens(blocks.staticBlock), hash: skip.staticHash,
  };
}

/** True, after booking the skip row, when the hook may omit a static block this session already holds. */
function skipUnchangedStatic(view: ContextView, blocks: ComposedBlocks): boolean {
  const { hippoRoot, rec } = view;
  const skip = skipCandidate(view, blocks.staticBlock);
  if (skip === null) return false;
  const ledgerOpts = { sharedStore: view.sharedStore };
  const last = withLedgerDb(hippoRoot, (db) =>
    lastSentState(db, view.tenantId, skip.sessionId, blocks.surface), ledgerOpts);
  if (!shouldSkipUnchanged(last ?? null, skip.staticHash, skip.refreshTurns)) return false;
  withLedgerDb(hippoRoot, (db) => {
    recordTokenUse(db, skipRow(view, blocks, skip));
    if (blocks.recallBlock.trim()) return;
    rec?.delivered({ state: 'reused', staticHash: skip.staticHash, staticReused: true });
    flushDeliveryRecorder(rec, db);
  }, ledgerOpts);
  return true;
}

/** As skipUnchangedStatic: a failed read sends the block, a failed skip row still skips. */
async function skipThroughStore(store: HippoStore, hooks: HookStore, view: ContextView, blocks: ComposedBlocks): Promise<boolean> {
  const skip = skipCandidate(view, blocks.staticBlock);
  if (skip === null) return false;
  let last: LastSent | null = null;
  try {
    last = await hooks.lastSent(view.tenantId, skip.sessionId, blocks.surface);
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    log.warnThenDebug('prompt-hook-ledger', `token ledger read failed; the block is sent: ${errorMessage(err)}`);
  }
  if (!shouldSkipUnchanged(last, skip.staticHash, skip.refreshTurns)) return false;
  await recordTokensBestEffort(store, skipRow(view, blocks, skip));
  return true;
}

async function recordTokensBestEffort(store: HippoStore, row: TokenUse): Promise<void> {
  try {
    await store.recordTokens(row);
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    log.warnThenDebug('prompt-hook-ledger', `token ledger row skipped; the reply is unaffected: ${errorMessage(err)}`);
  }
}

/** One connection for every row; each insert in its own try so one failing doesn't skip the other. */
function recordAdditionalContextRows(view: ContextView, rows: readonly TokenUse[]): void {
  withLedgerDb(view.hippoRoot, (db) => {
    for (const row of rows) {
      try {
        recordTokenUse(db, row);
      // Best-effort row: only a busy store is actionable, and a ledger failure must not break the hook.
      } catch (error) { if (isSqliteBusy(error)) noteStoreBusy('token ledger row skipped'); }
    }
    flushDeliveryRecorder(view.rec, db);
  }, { sharedStore: view.sharedStore });
}

// The flags HIPPO_PINNED_INJECT_COMMAND gives the local hook; the CLI parity test fails if the two drift.
const HOOK_INCLUDE_RECENT = 5;
const HOOK_BUDGET = 1500;
const HOOK_FRAMING = 'observe';

// blockHash's shape (token-ledger.ts).
const BLOCK_HASH_RE = /^[0-9a-f]{16}$/;

/** The project a hook caller runs in: its id, the folder name its older rows carry, and any other names it resolves to. */
export interface CallerProject {
  readonly name: string;
  readonly legacyName: string;
  readonly aliases?: readonly string[];
}

interface PromptHookRequest {
  readonly sessionId: string;
  readonly project: CallerProject;
  readonly payload?: Readonly<Record<string, JsonValue>>;
  /** The staticHash of the last reply whose stdout the caller printed in this session; absent, the block is always sent. */
  readonly printedHash?: string;
}

interface PromptHookOpts {
  /** The store serves many people, so the caller is not its owner: no global store, no user-global recent rows,
   *  task state only for the caller's own owner and project, and no ledger rows outside this store. */
  readonly sharedStore?: true;
}

/** The caps on a hook caller's session id and project names, so a caller other than an HTTP route is bounded too. */
export function assertCallerIds(sessionId: string, project: CallerProject): void {
  const { name, legacyName, aliases = [] } = project;
  if (aliases.length > MAX_PROJECT_ALIASES) throw new BadRequestError(`project aliases: at most ${MAX_PROJECT_ALIASES}`);
  if ([sessionId, name, legacyName, ...aliases].some((v) => v.length > MAX_ID_LEN)) {
    throw new BadRequestError(`session id and project names: at most ${MAX_ID_LEN} characters each`);
  }
}

function assertPromptHookRequest(req: PromptHookRequest): void {
  assertCallerIds(req.sessionId, req.project);
  if (req.printedHash !== undefined && !BLOCK_HASH_RE.test(req.printedHash)) {
    throw new BadRequestError('printed hash: 16 lowercase hex characters');
  }
}

/** The text `hippo context --pinned-only --include-recent 5 --format additional-context` prints for this session, read on `ctx`'s store for the caller's project, leaving out an unchanged static block only when `printedHash` matches it.
 *  `arm` is the raw ledger arm (`hippo` or `holdout`), null at rate 0; a holdout session gets an empty stdout. `staticHash` is the hash to echo back: null with no static block, for a sub-agent or a holdout.
 *  Scope detection (HIPPO_SCOPE and skill env vars) and delivery-ledger events are CLI-only.
 *  Throws BadRequestError past the input caps, and on a shared store for a project assertCallerProject refuses, before any arm is booked.
 *  With `ctx.store`, the arm and ledger go through its hooks group and the reads through its contextReads group; the holdout rate stays this root's config. */
export async function promptHookContext(
  ctx: Context, req: PromptHookRequest, opts: PromptHookOpts = {},
): Promise<{ arm: PilotArm | null; stdout: string; staticHash: string | null }> {
  const hooks = ctx.store ? requireGroup(ctx.store, 'hooks') : null;
  assertPromptHookRequest(req);
  const { sessionId, payload } = req;
  const { sharedStore } = opts;
  if (sharedStore || isSharedStore(ctx.hippoRoot)) assertCallerProject(req.project);
  // The test the local hook runs on its stdin, so a sub-agent books no arm and no session rows here either.
  const subagent = payload !== undefined && isSubagentPayload(JSON.stringify(payload));
  const ledgerSessionId = subagent ? undefined : sessionId;
  const arm = hooks
    ? await storePilotArm(ctx.hippoRoot, ctx.tenantId, hooks, sessionId, !subagent)
    : sessionPilotArm(ctx.hippoRoot, ctx.tenantId, sessionId, !subagent, { sharedStore, ownTenantOnly: true });
  if (arm === 'holdout') return { arm, ...NOTHING_RENDERED };
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
    sharedStore,
  });
  const view: ContextView = {
    hippoRoot: ctx.hippoRoot, tenantId: ctx.tenantId, ledgerSessionId, payloadSessionId: ledgerSessionId,
    pinnedOnly: true, framing: HOOK_FRAMING, rec: null, result, sharedStore, printedHash: req.printedHash ?? null,
  };
  let rendered = NOTHING_RENDERED;
  if (hasContextData(result)) rendered = ctx.store && hooks ? await renderThroughStore(ctx.store, hooks, view) : renderAdditionalContext(view);
  // A sub-agent's output is not the session's, so its caller must not record it as printed.
  return { arm, stdout: rendered.stdout, staticHash: subagent ? null : rendered.staticHash };
}
