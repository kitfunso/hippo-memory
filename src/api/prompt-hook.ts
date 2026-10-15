// The per-prompt hook's block and ledger rows, rendered here for `hippo context` and for promptHookContext (a remote
// hook route's call). promptHookContext keeps the server-side copy of the CLI's getContext flags (cli/context.ts); the
// CLI parity case in tests/prompt-hook-context.test.ts is all that ties the two.
import { getContext, type Context, type ContextResult, type ContextResultEntry, type ContextWith } from './index.js';
import { BadRequestError } from '../core/api-errors.js';
import { type HippoConfig, isSharedStore, loadConfig } from '../core/config.js';
import {
  contextBlockLines,
  contextCost,
  crossProjectLines,
  handoffSectionText,
  sessionTrailText,
  settleTokens,
  snapshotText,
} from './context-render.js';
import {
  createDeliveryRecorder,
  type DeliveryEventType,
  type DeliveryFault,
  type DeliveryOutcomeInput,
  type DeliveryRecorder,
} from '../store/delivery-recorder.js';
import type { HookRuntime } from '../core/capture-contract.js';
import { realpathOrResolve } from '../util/real-path.js';
import { MAX_ID_LEN } from '../util/limits.js';
import { isJsonString, type JsonValue } from '../util/json.js';
import { bookLedgerTurn, ledgerReachOf, ledgerRoot, ledgerSendWindow, type LedgerReach } from './ledger-db.js';
import { EMPTY_WINDOW, isFresh, memoryKey, refreshTurnsOf, sectionKey, type SendRule } from './send-once.js';
import { ownerOrSubject } from './types.js';
import { noteLedgerRowSkipped } from '../store/ledger-turn.js';
import type { MemoryEntry } from '../core/memory.js';
import { sessionPilotArm } from './pilot-arm.js';
import type { PilotArm } from '../store/pilot-arm.js';
import { assertCallerProject, MAX_PROJECT_ALIASES } from '../core/project-identity.js';
import type { DeliveryWrite } from '../store/ledger-turn.js';
import { writeDeliveryEventAtRoot } from '../store/recall-trace.js';
import type { TokenSurface, TokenUse } from '../store/token-ledger.js';
import { hookPayloadString, isSubagentPayload } from '../util/hook-payload.js';
import { blockHash, estimateTokens } from '../util/token-text.js';
import { errorMessage, log } from '../util/log.js';
import { DEFAULT_CONTEXT_BUDGET } from './context.js';

/** What a hook's delivery row says about the call it records. */
export interface DeliveryStart {
  stdinText: string | undefined;
  runtime: HookRuntime;
  eventType?: DeliveryEventType;
  /** The host's own session id from its environment, used when the payload names none. */
  envSessionId: string | undefined;
  /** Passed through to the recorder; only tests set it. */
  fault?: DeliveryFault;
}

/** A delivery recorder for a hook on `ctx.hippoRoot` when the ledger store enables one, else null; never throws. */
export function startDeliveryRecorder(ctx: Context, start: DeliveryStart): DeliveryRecorder | null {
  try {
    // The same store the token ledger writes to, so its config governs both.
    const root = ledgerRoot(ctx.hippoRoot, ledgerReachOf(ctx));
    if (root === null || !loadConfig(root).deliveryLedger.enabled) return null;
    return createDeliveryRecorder({
      root,
      storeHash: blockHash(realpathOrResolve(root)),
      // ledgerRoot falls back to the global root only when the primary is not initialized.
      writeStore: root !== ctx.hippoRoot || ctx.reach?.isGlobal === true ? 'global' : 'local',
      tenantId: ctx.tenantId,
      stdinText: start.stdinText,
      envSessionId: start.envSessionId,
      runtime: start.runtime === 'copilot' ? 'copilot' : undefined,
      eventType: start.eventType,
      fault: start.fault,
    });
  } catch (error) {
    log.warn(`delivery ledger skipped: ${errorMessage(error)}`);
    return null;
  }
}

/** A recorder for `hippo capture-error`, only when the failure log and the ledger are one store, so `failure_id` never
 * points into another. */
export function startToolFailureRecorder(
  ctx: Context,
  start: Omit<DeliveryStart, 'eventType'>,
): DeliveryRecorder | null {
  try {
    const root = ledgerRoot(ctx.hippoRoot, ledgerReachOf(ctx));
    if (root === null || realpathOrResolve(root) !== realpathOrResolve(ctx.hippoRoot)) return null;
    return startDeliveryRecorder(ctx, { ...start, eventType: 'tool-failure' });
  } catch (error) {
    log.warn(`delivery ledger skipped: ${errorMessage(error)}`);
    return null;
  }
}

/** With `write`, stores on the token ledger's connection (same
 * store); without it, opens its own. A second flush is a no-op. */
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
  /** The caller's Context config, else the folder's config.json is read. */
  readonly config?: HippoConfig;
  readonly tenantId: string;
  readonly ledgerSessionId: string | undefined;
  readonly payloadSessionId: string | undefined;
  readonly pinnedOnly: boolean;
  readonly framing: string;
  readonly rec: DeliveryRecorder | null;
  readonly result: ContextResult;
  /** Where the ledger rows go; a shared store's reach has no global store, see promptHookContext. */
  readonly reach: LedgerReach;
  /** Set only by a remote caller, which prints elsewhere: the hash of the last reply it printed, null for none. Its
   *  marks stay pending until a later call echoes them; the local CLI books its rows once stdout took the text. */
  readonly printedHash?: string | null;
  /** On a shared store, the caller's owner, which every send mark carries. */
  readonly owner?: string;
  /** The reply's JSON wrapper; absent means Claude Code's UserPromptSubmit. */
  readonly envelope?: HookEnvelope;
}

/** `copilot-session-start` is the Copilot harness's top-level reply,
 * `vscode-session-start` the nested one VS Code Local reads. */
export type HookEnvelope = 'user-prompt-submit' | 'copilot-session-start' | 'vscode-session-start';

/** A Copilot sessionStart reply's wrapper, picked by the sender's casing: stdin.ts keeps a camelCase `sessionId`, which
 * only the Copilot harness sends. */
export function sessionStartEnvelope(stdinText: string | undefined): HookEnvelope {
  return hookPayloadString(stdinText, 'sessionId') !== null ? 'copilot-session-start' : 'vscode-session-start';
}

function hookReply(envelope: HookEnvelope, additionalContext: string): string {
  if (envelope === 'copilot-session-start') return JSON.stringify({ additionalContext });
  const hookEventName = envelope === 'vscode-session-start' ? 'SessionStart' : 'UserPromptSubmit';
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } });
}

/** A hook render's stdout, the hash a remote caller echoes once it printed it (null when nothing prints), and the
 * booking of its ledger rows, which the local CLI runs only once stdout took the text. */
export interface RenderedContext {
  readonly stdout: string;
  readonly staticHash: string | null;
  readonly book: () => void;
}

const NOTHING_RENDERED: RenderedContext = Object.freeze({ stdout: '', staticHash: null, book: () => undefined });

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

/** One section or memory of the hook block, with the key its send is marked under. */
interface Keyed<T> {
  readonly key: string;
  readonly pinned: boolean;
  readonly part: T;
}

interface HookParts {
  readonly sections: readonly Keyed<string>[];
  readonly statics: readonly Keyed<ContextResultEntry>[];
  readonly cross: readonly Keyed<ContextResultEntry>[];
  readonly recall: readonly Keyed<ContextResultEntry>[];
}

interface HookText {
  readonly staticText: string;
  readonly recallText: string;
}

function hookParts(view: ContextView): HookParts {
  const { result, owner } = view;
  const section = (kind: 'snapshot' | 'handoff' | 'trail', text: string): Keyed<string> =>
    ({ key: sectionKey(kind, text, owner), pinned: false, part: text });
  const memory = (r: ContextResultEntry): Keyed<ContextResultEntry> =>
    ({ key: memoryKey(r.entry, owner), pinned: r.entry.pinned, part: r });
  const events = result.recentEvents ?? [];
  const handoff = result.sessionHandoff;
  return {
    sections: [
      ...(result.activeSnapshot ? [section('snapshot', snapshotText(result.activeSnapshot))] : []),
      ...(handoff ? [section('handoff', handoffSectionText(handoff, result.handoffMode ?? 'full'))] : []),
      ...(events.length > 0 ? [section('trail', sessionTrailText(events))] : []),
    ],
    statics: result.entries.filter((r) => r.category !== 'cross-project' && !r.promptRecall).map(memory),
    cross: result.entries.filter((r) => r.category === 'cross-project' && !r.promptRecall).map(memory),
    recall: result.entries.filter((r) => r.promptRecall).map(memory),
  };
}

function renderParts(parts: HookParts, framing: string): HookText {
  const staticItems = toRenderItems(parts.statics.map((k) => k.part));
  const staticText = settleTokens((t) =>
    [
      ...parts.sections.map((k) => k.part),
      // No live strength percentage, so an unchanged set of memories renders byte-identically turn after turn.
      ...(staticItems.length > 0 ? contextBlockLines(staticItems, t, framing, { showStrength: false }) : []),
      ...crossProjectLines(parts.cross.map((k) => k.part)),
    ].join('\n'),
  );
  return { staticText, recallText: renderRecallBlock(toRenderItems(parts.recall.map((k) => k.part)), framing) };
}

function renderRecallBlock(recallItems: RenderItem[], framing: ContextView['framing']): string {
  if (recallItems.length === 0) return '';
  return settleTokens((t) =>
    contextBlockLines(recallItems, t, framing, { showStrength: false, heading: 'Prompt-Relevant Memory' }).join('\n'),
  );
}

function filterParts(parts: HookParts, rule: SendRule): HookParts {
  const keep = <T>(list: readonly Keyed<T>[]): Keyed<T>[] => list.filter((k) => isFresh(rule, k.key, k.pinned));
  return {
    sections: keep(parts.sections), statics: keep(parts.statics), cross: keep(parts.cross), recall: keep(parts.recall),
  };
}

const memoriesOf = (parts: HookParts): Keyed<ContextResultEntry>[] =>
  [...parts.statics, ...parts.cross, ...parts.recall];
const tokensOf = (text: HookText): number => estimateTokens(text.staticText) + estimateTokens(text.recallText);

function joinBlocks({ staticText, recallText }: HookText): string {
  const joined = staticText && recallText ? `${staticText}\n\n${recallText}` : staticText || recallText;
  return joined.trim() ? joined : '';
}

/** The hook format's render: a static block (snapshot, handoff, trail, pins, recent-N) and a prompt-recall block, each
 * part left out while the session's context window still holds it. */
export function renderHookContext(view: ContextView): RenderedContext {
  const parts = hookParts(view);
  const full = renderParts(parts, view.framing);
  if (!full.staticText.trim() && !full.recallText.trim()) {
    view.rec?.delivered({ state: 'empty' });
    return NOTHING_RENDERED;
  }
  const rule = sendRule(view);
  const shown = rule ? filterParts(parts, rule) : parts;
  const printed = rule ? renderParts(shown, view.framing) : full;
  const text = joinBlocks(printed);
  const shownIds = new Set(memoriesOf(shown).map((k) => k.part.entry.id));
  const reusedIds = memoriesOf(parts).map((k) => k.part.entry.id).filter((id) => !shownIds.has(id));
  view.rec?.delivered(deliveryOutcome(full, printed, text, reusedIds));
  const hash = text ? blockHash(text) : null;
  const uses = rule ? windowUses(view, { parts, shown, full, printed, hash }) : bypassUses(view, parts, printed);
  return {
    stdout: text ? hookReply(view.envelope ?? 'user-prompt-submit', text) : '',
    staticHash: hash,
    book: () => bookHookRows(view, uses),
  };
}

function deliveryOutcome(full: HookText, printed: HookText, text: string, reusedIds: string[]): DeliveryOutcomeInput {
  const staticHeld = full.staticText.trim() !== '' && printed.staticText.trim() === '';
  const shownStatic = printed.staticText.trim() ? printed.staticText : full.staticText;
  return {
    state: !text ? 'reused' : staticHeld ? 'reused-recall-sent' : 'sent',
    staticHash: shownStatic.trim() ? blockHash(shownStatic) : null,
    recallHash: printed.recallText ? blockHash(printed.recallText) : null,
    emittedText: text || undefined,
    reusedIds,
  };
}

/** Null when this call sends everything and marks nothing: a non-hook render, no payload session (a sub-agent), a
 * session start, or skipUnchanged off. */
function sendRule(view: ContextView): SendRule | null {
  const { hippoRoot, payloadSessionId } = view;
  if (!view.pinnedOnly || payloadSessionId === undefined) return null;
  // Session start is the only injection Copilot gets, so a resumed session needs the whole block again.
  if (view.envelope === 'copilot-session-start' || view.envelope === 'vscode-session-start') return null;
  const injectCfg = (view.config ?? loadConfig(hippoRoot)).pinnedInject;
  if (injectCfg.skipUnchanged === false) return null;
  const echoed = view.printedHash ?? null;
  const window = ledgerSendWindow(hippoRoot, view.tenantId, payloadSessionId, 'hook', echoed, view.reach);
  return { window: window ?? EMPTY_WINDOW, refreshTurns: refreshTurnsOf(injectCfg.refreshTurns) };
}

interface HookTurn {
  readonly parts: HookParts;
  readonly shown: HookParts;
  readonly full: HookText;
  readonly printed: HookText;
  readonly hash: string | null;
}

/** One `hook` row per call is the window's turn, carrying the printed keys (pending for a remote caller until it echoes
 * the hash); the tokens left out go on a skip row. */
function windowUses(view: ContextView, turn: HookTurn): TokenUse[] {
  const { parts, shown, full, printed, hash } = turn;
  const base = { tenantId: view.tenantId, sessionId: view.ledgerSessionId, surface: 'hook' } as const;
  const avoided = Math.max(0, tokensOf(full) - tokensOf(printed));
  const held = parts.statics.length - shown.statics.length;
  const sentKeys = [...shown.sections, ...memoriesOf(shown)].map((k) => k.key);
  const marks = { hash, sentKeys, pending: view.printedHash !== undefined && sentKeys.length > 0 };
  const sentStatic = printed.staticText !== '';
  const turnRow: TokenUse = sentStatic
    ? { ...base, ...marks, event: 'inject', items: shown.statics.length, tokens: estimateTokens(printed.staticText) }
    : { ...base, ...marks, event: 'skip', items: held, tokens: avoided };
  return [
    turnRow,
    ...(printed.recallText ? [recallUse(view, shown, printed.recallText)] : []),
    ...(sentStatic && avoided > 0 ? [{ ...base, event: 'skip' as const, items: held, tokens: avoided }] : []),
  ];
}

function bypassUses(view: ContextView, parts: HookParts, printed: HookText): TokenUse[] {
  const surface: TokenSurface = view.pinnedOnly ? 'hook' : 'context';
  const { staticText, recallText } = printed;
  const staticUse: TokenUse = {
    tenantId: view.tenantId, sessionId: view.ledgerSessionId, surface, event: 'inject',
    items: parts.statics.length, tokens: estimateTokens(staticText), hash: blockHash(staticText),
  };
  return [...(staticText ? [staticUse] : []), ...(recallText ? [recallUse(view, parts, recallText)] : [])];
}

function recallUse(view: ContextView, parts: HookParts, text: string): TokenUse {
  return {
    tenantId: view.tenantId, sessionId: view.ledgerSessionId, surface: 'hook_recall', event: 'inject',
    items: parts.recall.length, tokens: estimateTokens(text), hash: blockHash(text),
  };
}

/** One connection for every row; a failed row is logged and the rest still land, because a ledger failure must not
 * break the hook. */
function bookHookRows(view: ContextView, uses: readonly TokenUse[]): void {
  bookLedgerTurn(
    view.hippoRoot,
    { uses, onRowError: noteLedgerRowSkipped, delivery: (write) => flushDeliveryRecorder(view.rec, write) },
    view.reach,
  );
}

// The flags HIPPO_PINNED_INJECT_COMMAND gives the local hook; the CLI parity test fails if the two drift.
const HOOK_INCLUDE_RECENT = 5;
const HOOK_BUDGET = DEFAULT_CONTEXT_BUDGET;
const HOOK_FRAMING = 'observe';
const HOOK_HANDOFF_MODE = 'pointer';

// blockHash's shape (token-ledger.ts).
const BLOCK_HASH_RE = /^[0-9a-f]{16}$/;

/** The project a hook caller runs in: its id, the folder name
 * its older rows carry, and any other names it resolves to. */
export interface CallerProject {
  readonly name: string;
  readonly legacyName: string;
  readonly aliases?: readonly string[];
}

export interface PromptHookRequest {
  readonly sessionId: string;
  readonly project: CallerProject;
  readonly payload?: Readonly<Record<string, JsonValue>>;
  /** The staticHash of the last reply whose stdout the caller printed in this session; absent, no earlier reply counts
   * as printed, so every part is sent. */
  readonly printedHash?: string;
}

export interface PromptHookOpts {
  /** The store serves many people, so the caller is not its owner: no global store, no user-global recent rows,
   *  task state only for the caller's own owner and project, and no ledger rows outside this store. */
  readonly sharedStore?: true;
}

/** The caps on a hook caller's session id and project names, so a caller other than an HTTP route is bounded too. */
export function assertCallerIds(sessionId: string, project: CallerProject): void {
  const { name, legacyName, aliases = [] } = project;
  if (aliases.length > MAX_PROJECT_ALIASES) {
    throw new BadRequestError(`project aliases: at most ${MAX_PROJECT_ALIASES}`);
  }
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

/** What HIPPO_PINNED_INJECT_COMMAND prints for this session; a part an earlier reply carried is left out only once
 * `printedHash` echoes that reply. A holdout gets empty stdout; `staticHash` is the hash to echo, null with no stdout
 * or for a sub-agent. Throws BadRequestError past the input caps or for a project a shared store refuses. */
export async function promptHookContext(
  ctx: ContextWith<'contextReads'>, req: PromptHookRequest, opts: PromptHookOpts = {},
): Promise<{ arm: PilotArm | null; stdout: string; staticHash: string | null }> {
  assertPromptHookRequest(req);
  const { sessionId, payload } = req;
  const { sharedStore } = opts;
  const sharedByReach = ctx.reach ? ctx.reach.shared : isSharedStore(ctx.hippoRoot);
  const shared = sharedStore === true || sharedByReach;
  if (shared) assertCallerProject(req.project);
  // The test the local hook runs on its stdin, so a sub-agent books no arm and no session rows here either.
  const subagent = payload !== undefined && isSubagentPayload(JSON.stringify(payload));
  const ledgerSessionId = subagent ? undefined : sessionId;
  const reach = ledgerReachOf(ctx, sharedStore);
  const arm = sessionPilotArm(ctx.hippoRoot, ctx.tenantId, sessionId, !subagent, { reach, ownTenantOnly: true });
  if (arm === 'holdout') return { arm, stdout: '', staticHash: null };
  const prompt = payload?.prompt;
  const result = await getContext(ctx, {
    budget: HOOK_BUDGET,
    pinnedOnly: true,
    includeRecent: HOOK_INCLUDE_RECENT,
    // The project comes from the caller, never from where the store sits or the daemon's cwd.
    currentProject: req.project,
    currentSessionId: sessionId,
    prompt: isJsonString(prompt) ? prompt : undefined,
    handoffMode: HOOK_HANDOFF_MODE,
    cost: contextCost('additional-context', HOOK_FRAMING),
    sharedStore,
  });
  const rendered = hasContextData(result)
    ? renderHookContext({
        hippoRoot: ctx.hippoRoot, config: ctx.config, tenantId: ctx.tenantId, ledgerSessionId,
        payloadSessionId: ledgerSessionId, pinnedOnly: true, framing: HOOK_FRAMING, rec: null, result, reach,
        printedHash: req.printedHash ?? null, owner: shared ? ownerOrSubject(ctx.actor) : undefined,
      })
    : NOTHING_RENDERED;
  // The rows book now, pending: this caller says it printed the reply only by echoing its hash next time.
  rendered.book();
  // A sub-agent's output is not the session's, so its caller must not record it as printed.
  return { arm, stdout: rendered.stdout, staticHash: subagent ? null : rendered.staticHash };
}
