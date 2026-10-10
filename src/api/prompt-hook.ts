// The per-prompt hook's block and ledger rows, rendered here for `hippo context` and for promptHookContext (a remote hook route's call).
// promptHookContext keeps the server-side copy of the CLI's getContext flags (cli/context.ts);
// the CLI parity case in tests/prompt-hook-context.test.ts is all that ties the two.
import { getContext, type Context, type ContextResult, type ContextResultEntry } from './index.js';
import { BadRequestError } from '../core/api-errors.js';
import { isSharedStore, loadConfig } from '../core/config.js';
import { contextBlockLines, contextCost, crossProjectLines, handoffText, sessionTrailText, settleTokens, snapshotText } from './context-render.js';
import type { DeliveryRecorder } from '../store/delivery-recorder.js';
import { MAX_ID_LEN } from '../util/http-util.js';
import { isJsonString, type JsonValue } from '../util/json.js';
import { bookLedgerTurn, ledgerLastSent, noteLedgerRowSkipped } from './ledger-db.js';
import type { MemoryEntry } from '../core/memory.js';
import { sessionPilotArm, type PilotArm } from './pilot-arm.js';
import { assertCallerProject, MAX_PROJECT_ALIASES } from '../core/project-identity.js';
import type { DeliveryWrite } from '../store/ledger-turn.js';
import { writeDeliveryEventAtRoot } from '../store/recall-trace.js';
import {
  hookPayloadString,
  isSubagentPayload,
  shouldSkipUnchanged,
  type TokenSurface,
  type TokenUse,
} from '../store/token-ledger.js';
import { blockHash, estimateTokens } from '../util/token-text.js';
import { errorMessage, log } from '../util/log.js';
import { DEFAULT_CONTEXT_BUDGET } from './context.js';

/** With `write`, stores on the token ledger's connection (same store); without it, opens its own. A second flush is a no-op. */
export function flushDeliveryRecorder(rec: DeliveryRecorder | null, write?: DeliveryWrite): void {
  if (rec === null) return;
  try {
    rec.flush(write ?? ((input) => writeDeliveryEventAtRoot(rec.root, input)));
  } catch (error) {
    log.error(`delivery ledger write failed: ${errorMessage(error)}`);
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

function renderAdditionalContext(view: ContextView): RenderedContext {
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
    return NOTHING_RENDERED;
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
    return NOTHING_RENDERED;
  }

  const stdout = hookReply(view.envelope ?? 'user-prompt-submit', additionalContext);
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
  return { stdout, staticHash: finalStatic ? blockHash(finalStatic) : null };
}

/** True, after booking the skip row, when the hook may omit a static block this session already holds. */
function skipUnchangedStatic(view: ContextView, surface: TokenSurface, staticBlock: string, recallBlock: string, staticCount: number): boolean {
  const { hippoRoot, payloadSessionId, rec } = view;
  const ledgerOpts = { sharedStore: view.sharedStore };
  if (!view.pinnedOnly || payloadSessionId === undefined) return false;
  // Session start is the only injection Copilot gets, so a resumed session needs the whole block again.
  if (view.envelope === 'copilot-session-start' || view.envelope === 'vscode-session-start') return false;
  const injectCfg = loadConfig(hippoRoot).pinnedInject;
  if (injectCfg.skipUnchanged === false) return false;
  const refreshTurns = Number.isFinite(injectCfg.refreshTurns) && injectCfg.refreshTurns >= 0
    ? injectCfg.refreshTurns
    : 10;
  // Hashed on the static text alone so an unchanged pin set still skips while recall varies.
  const staticHash = blockHash(staticBlock);
  // Before the ledger read, so a caller that did not print this block books no skip row.
  if (view.printedHash !== undefined && view.printedHash !== staticHash) return false;
  const last = ledgerLastSent(hippoRoot, view.tenantId, payloadSessionId, surface, ledgerOpts);
  if (!shouldSkipUnchanged(last ?? null, staticHash, refreshTurns)) return false;
  bookLedgerTurn(hippoRoot, {
    uses: [{
      tenantId: view.tenantId, sessionId: payloadSessionId, surface, event: 'skip',
      items: staticCount, tokens: estimateTokens(staticBlock), hash: staticHash,
    }],
    delivery: recallBlock.trim() ? undefined : (write) => {
      rec?.delivered({ state: 'reused', staticHash, staticReused: true });
      flushDeliveryRecorder(rec, write);
    },
  }, ledgerOpts);
  return true;
}

interface InjectedBlock { readonly text: string; readonly items: number }

/** One connection for both rows; a failed row is logged and the other still lands, because a ledger failure must not break the hook. */
function recordAdditionalContextRows(view: ContextView, surface: TokenSurface, staticPart: InjectedBlock, recallPart: InjectedBlock): void {
  const row = (part: InjectedBlock, on: TokenSurface): TokenUse => ({
    tenantId: view.tenantId, sessionId: view.ledgerSessionId, surface: on, event: 'inject',
    items: part.items, tokens: estimateTokens(part.text), hash: blockHash(part.text),
  });
  bookLedgerTurn(view.hippoRoot, {
    uses: [...(staticPart.text ? [row(staticPart, surface)] : []), ...(recallPart.text ? [row(recallPart, 'hook_recall')] : [])],
    onRowError: noteLedgerRowSkipped,
    delivery: (write) => flushDeliveryRecorder(view.rec, write),
  }, { sharedStore: view.sharedStore });
}

// The flags HIPPO_PINNED_INJECT_COMMAND gives the local hook; the CLI parity test fails if the two drift.
const HOOK_INCLUDE_RECENT = 5;
const HOOK_BUDGET = DEFAULT_CONTEXT_BUDGET;
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

/** The text `hippo context --pinned-only --include-recent 5 --format additional-context` prints for this session, read
 * on `ctx`'s store for the caller's project, leaving out an unchanged static block only when `printedHash` matches it.
 * `arm` is the raw ledger arm (`hippo` or `holdout`), null at rate 0; a holdout session gets an empty
 * stdout. `staticHash` is the hash to echo back: null with no static block, for a sub-agent or a holdout.
 *  Scope detection (HIPPO_SCOPE and skill env vars) and delivery-ledger events are CLI-only.
 *  Throws BadRequestError past the input caps, and on a shared store for a project assertCallerProject refuses, before any arm is booked. */
export async function promptHookContext(
  ctx: Context, req: PromptHookRequest, opts: PromptHookOpts = {},
): Promise<{ arm: PilotArm | null; stdout: string; staticHash: string | null }> {
  assertPromptHookRequest(req);
  const { sessionId, payload } = req;
  const { sharedStore } = opts;
  if (sharedStore || isSharedStore(ctx.hippoRoot)) assertCallerProject(req.project);
  // The test the local hook runs on its stdin, so a sub-agent books no arm and no session rows here either.
  const subagent = payload !== undefined && isSubagentPayload(JSON.stringify(payload));
  const ledgerSessionId = subagent ? undefined : sessionId;
  const arm = sessionPilotArm(ctx.hippoRoot, ctx.tenantId, sessionId, !subagent, { sharedStore, ownTenantOnly: true });
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
  const rendered = hasContextData(result)
    ? renderAdditionalContext({
        hippoRoot: ctx.hippoRoot, tenantId: ctx.tenantId, ledgerSessionId, payloadSessionId: ledgerSessionId,
        pinnedOnly: true, framing: HOOK_FRAMING, rec: null, result, sharedStore, printedHash: req.printedHash ?? null,
      })
    : NOTHING_RENDERED;
  // A sub-agent's output is not the session's, so its caller must not record it as printed.
  return { arm, stdout: rendered.stdout, staticHash: subagent ? null : rendered.staticHash };
}
