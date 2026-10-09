// `hippo capture --last-session` for a caller whose transcript was read on another machine: its project names the rows, never the store's folder.
import { BadRequestError } from '../api-errors.js';
import type { Context, StoreReply } from '../api/types.js';
import { assertCallerIds, type CallerProject } from '../prompt-hook.js';
import { assertCallerProject, projectNames } from '../project-identity.js';
import { longestWord, storedTextKeys } from '../same-text.js';
import { scrubForSharing } from '../share-scrub.js';
import { requireGroup } from '../store-port.js';
import { loadTextsHoldingWords } from '../store/candidates.js';
import type { StoreContext } from './caller-session.js';
import { captureExtractedItems, captureItemsThroughStore, type CaptureTally } from './command.js';
import { extractFromTexts, type ExtractedItem } from './extract.js';

const MAX_TEXTS = 30;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_ITEMS = 50;

export interface SessionCaptureRequest {
  readonly sessionId: string;
  readonly project: CallerProject;
  /** The session's turns, as sessionTail returns them; scrubbed again here, since the caller's scrub is not trusted. */
  readonly texts: readonly string[];
}

export type SessionCaptureResult = Readonly<CaptureTally>;

function assertSessionCapture(req: SessionCaptureRequest): void {
  assertCallerIds(req.sessionId, req.project);
  if (req.sessionId.trim() === '') throw new BadRequestError('session id: required');
  // A '' project would read every project's rows as its own and write user-global rows; a rewritten one would split a project.
  assertCallerProject(req.project);
  if (req.texts.length > MAX_TEXTS) throw new BadRequestError(`texts: at most ${MAX_TEXTS}`);
  const sizes = req.texts.map((t) => Buffer.byteLength(t, 'utf8'));
  if (sizes.some((n) => n > MAX_TEXT_BYTES)) throw new BadRequestError(`each text: at most ${MAX_TEXT_BYTES} bytes`);
  if (sizes.reduce((a, b) => a + b, 0) > MAX_TOTAL_BYTES) throw new BadRequestError(`texts: at most ${MAX_TOTAL_BYTES} bytes in all`);
}

function sessionItems(req: SessionCaptureRequest): { items: ExtractedItem[]; dropped: number } {
  assertSessionCapture(req);
  const extracted = extractFromTexts(req.texts.map(scrubForSharing));
  // The newest items win, since the end of a session states where it landed.
  const items = extracted.slice(-MAX_ITEMS);
  return { items, dropped: extracted.length - items.length };
}

/** Captures the session's statements into `ctx`'s tenant under the caller's project, skipping each text a row the caller can see already holds.
 *  On hippo.db, synchronous from the dedup read to the last write, so no other write lands between them. No console output and no process.exit. */
export function captureSessionTexts<C extends Context>(ctx: C, req: SessionCaptureRequest): StoreReply<C, SessionCaptureResult> {
  const reply = ctx.store ? captureThroughStore({ ...ctx, store: ctx.store }, req) : captureOnHippoDb(ctx, req);
  // SAFETY: a C typed with a store gets the promise its path returns; a wide C is typed as the union, which a caller has to await anyway.
  return reply as StoreReply<C, SessionCaptureResult>;
}

function captureOnHippoDb(ctx: Context, req: SessionCaptureRequest): SessionCaptureResult {
  const { items, dropped } = sessionItems(req);
  if (items.length === 0) return { captured: 0, skipped: 0, rejected: 0 };
  // The project filter is classifyOriginProject's in SQL: the caller's rows and user-global rows block a copy, other projects' rows do not.
  const held = loadTextsHoldingWords(ctx.hippoRoot, ctx.tenantId, items.map((i) => longestWord(i.content)), projectNames(req.project));
  const tally = captureExtractedItems(
    ctx.hippoRoot,
    { dryRun: false, tenantId: ctx.tenantId, originProject: req.project, sessionId: req.sessionId, actor: ctx.actor.subject, lean: true },
    items,
    storedTextKeys(held),
  );
  return { ...tally, skipped: tally.skipped + dropped };
}

async function captureThroughStore(ctx: StoreContext, req: SessionCaptureRequest): Promise<SessionCaptureResult> {
  const hooks = requireGroup(ctx.store, 'hooks');
  const entryWrites = requireGroup(ctx.store, 'entryWrites');
  const { items, dropped } = sessionItems(req);
  if (items.length === 0) return { captured: 0, skipped: 0, rejected: 0 };
  // SHORTCUT: a write can land between the dedup read and the writes, so two racing captures may both store a text; one transaction around both if that shows up.
  const held = await hooks.textsHoldingWords({
    tenantId: ctx.tenantId, words: items.map((i) => longestWord(i.content)), project: projectNames(req.project), reach: { kind: 'team' },
  });
  const options = { tenantId: ctx.tenantId, originProject: req.project, sessionId: req.sessionId, actor: ctx.actor.subject };
  const tally = await captureItemsThroughStore(entryWrites, ctx.hippoRoot, options, items, storedTextKeys(held));
  return { ...tally, skipped: tally.skipped + dropped };
}
